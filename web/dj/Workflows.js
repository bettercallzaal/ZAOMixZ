// Workflows.js — recipes a person builds, instead of rules the bot DJ keeps to itself.
//
// A workflow is a named list of steps. Each step says how to move into the next song (one of
// the five moves, in bars), what FX go around it (a pad from the FX board, the air horn, a drop),
// and the rule for which song comes next (same key family, tempo up or down by about X percent,
// same artist, more or less energy, or any). A set is workflows chained until the minutes are
// filled: the fill function walks the steps and takes, from the crate, the song that satisfies
// each step's rule and still mixes well out of the one before.
//
// Everything here is pure so it runs under node: see Workflows.test.mjs. Playing rides on the
// same plan shape DJ MixZ already uses ({ track, energy, target, move }), so the engine does
// not change.

import { keyRelation } from './SwitchPad.js';
import { energyOf, tempoGap, joinCost } from './DjMixz.js';

export const MOVES = [
    { id: 'blend', label: 'BLEND', hint: 'long crossfade, bass swaps over' },
    { id: 'filter-sweep', label: 'FILTER SWEEP', hint: 'the old song thins out under a filter' },
    { id: 'echo-out', label: 'ECHO OUT', hint: 'the old song echoes away, the new one drops' },
    { id: 'stem-swap', label: 'STEM SWAP', hint: 'old vocal over the new drums, then trade' },
    { id: 'cut', label: 'CUT', hint: 'clean cut on the one' },
];

export const RULES = [
    { id: 'any', label: 'ANY SONG', hint: 'whatever mixes best' },
    { id: 'same-key', label: 'SAME KEY FAMILY', hint: 'keys sit together' },
    { id: 'tempo-up', label: 'TEMPO UP', hint: 'about X percent faster' },
    { id: 'tempo-down', label: 'TEMPO DOWN', hint: 'about X percent slower' },
    { id: 'same-artist', label: 'SAME ARTIST', hint: 'one more from the same act' },
    { id: 'more-energy', label: 'MORE ENERGY', hint: 'hits harder than the last' },
    { id: 'less-energy', label: 'LESS ENERGY', hint: 'brings it down' },
];

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
const idOf = (t) => String(t.id ?? t.sourceId ?? `${t.title}|${t.artist}`);

// One step with every field filled in. `amount` is the tempo change in percent for the tempo
// rules. `fxIn` fires as the move starts, `fxOut` as the new song lands: an FX board group
// ('horn', 'vocal', 'fx'), a pad id, or null.
export function makeStep(s = {}) {
    const move = MOVES.some((m) => m.id === s.move) ? s.move : 'blend';
    const rule = RULES.some((r) => r.id === s.rule) ? s.rule : 'any';
    const bars = Math.max(1, Math.min(64, Math.round(num(s.bars) || (move === 'cut' ? 1 : move === 'echo-out' ? 4 : move === 'stem-swap' ? 8 : 16))));
    const amount = Math.max(1, Math.min(24, Math.round(num(s.amount) || 6)));
    return { move, bars, rule, amount, fxIn: s.fxIn || null, fxOut: s.fxOut || null, tempoRide: !!s.tempoRide, airhorn: s.airhorn === 'double' ? 'double' : s.airhorn ? 'classic' : null };
}

export function makeWorkflow(name, steps = [], extra = {}) {
    const clean = String(name || '').trim() || 'Untitled workflow';
    return { id: extra.id || slug(clean), name: clean, steps: (steps || []).map(makeStep), hint: extra.hint || '' };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workflow';

const KEY_FITS = new Set(['same', 'up1', 'down1', 'flip']);

// Does `cand` satisfy the step's rule coming out of `from`? Null `from` (the first song) fits
// anything. Songs with no tempo or key on file fit the rules that need them only as a fallback.
export function fits(step, from, cand, harmonic) {
    if (!from) return true;
    const rule = step.rule;
    if (rule === 'any') return true;
    if (rule === 'same-artist') return !!(from.artist && cand.artist && from.artist === cand.artist);
    if (rule === 'same-key') return KEY_FITS.has(keyRelation(harmonic, from.key, cand.key));
    if (rule === 'more-energy') return energyOf(cand) > energyOf(from) + 0.04;
    if (rule === 'less-energy') return energyOf(cand) < energyOf(from) - 0.04;
    const { pct, doubled } = tempoGap(from, cand);
    if (pct === null || doubled) return false;
    const want = rule === 'tempo-up' ? step.amount : -step.amount;
    // Within a third of the asked change, and in the right direction
    return Math.sign(pct) === Math.sign(want) && Math.abs(pct - want) <= Math.max(2, Math.abs(want) / 3);
}

// Lower is better: how well `cand` mixes out of `from` plus how far it is from the rule's ideal.
export function stepCost(step, from, cand, harmonic) {
    if (!from) return 0.5 - energyOf(cand) * 0.2;
    let cost = joinCost(from, cand, harmonic, step.move === 'stem-swap' || step.tempoRide);
    const rule = step.rule;
    if (rule === 'tempo-up' || rule === 'tempo-down') {
        const { pct } = tempoGap(from, cand);
        const want = rule === 'tempo-up' ? step.amount : -step.amount;
        cost = (pct === null ? 1 : Math.abs(pct - want) / 8) + 0.3 * (KEY_FITS.has(keyRelation(harmonic, from.key, cand.key)) ? 0 : 1);
    } else if (rule === 'more-energy') cost += Math.max(0, 0.3 - (energyOf(cand) - energyOf(from)));
    else if (rule === 'less-energy') cost += Math.max(0, 0.3 - (energyOf(from) - energyOf(cand)));
    return cost;
}

// The move DJ MixZ's engine plays for this step out of `from`: same shape planTransition gives.
export function moveFor(step, from, cand, why = '') {
    const bpm = num(from?.bpm) || 120;
    const cap = step.move === 'cut' ? 1.5 : step.move === 'stem-swap' || step.move === 'echo-out' ? 5 : 6;
    const seconds = Math.max(cap, Math.min(40, (step.bars * 4 * 60) / bpm));
    return { type: step.move, bars: step.bars, seconds: Math.round(seconds * 10) / 10, why: why || MOVES.find((m) => m.id === step.move)?.hint || '', tempoRide: step.tempoRide, airhorn: step.airhorn, fxIn: step.fxIn, fxOut: step.fxOut };
}

// Fill one workflow from the crate. `from` is the song on air (null to open with the first
// step's pick). Returns plan slots: { track, energy, target, move, step, why }. A step whose
// rule no song in the crate satisfies falls back to the best-mixing song and says so.
export function fillWorkflow(workflow, pool, from, harmonic, opts = {}) {
    const used = new Set((opts.used || []).map(String));
    if (from) used.add(idOf(from));
    const out = [];
    let prev = from || null;
    for (const raw of workflow.steps || []) {
        const step = makeStep(raw);
        const left = pool.filter((t) => t && !used.has(idOf(t)));
        if (!left.length) break;
        let picks = left.filter((t) => fits(step, prev, t, harmonic));
        let fallback = false;
        if (!picks.length) { picks = left; fallback = true; }
        let best = picks[0], bestCost = Infinity;
        for (const t of picks) { const c = stepCost(step, prev, t, harmonic); if (c < bestCost) { bestCost = c; best = t; } }
        const ruleLabel = RULES.find((r) => r.id === step.rule)?.label.toLowerCase() || step.rule;
        const why = !prev ? 'opens the workflow' : fallback ? `no song in the crate fits "${ruleLabel}", so the best mix instead` : `${ruleLabel}: ${reason(step, prev, best)}`;
        const move = prev ? moveFor(step, prev, best, why) : null;
        out.push({ track: best, energy: energyOf(best), target: energyOf(best), move, step, why, workflow: workflow.id || workflow.name });
        used.add(idOf(best));
        prev = best;
    }
    return out;
}

function reason(step, from, cand) {
    const { pct } = tempoGap(from, cand);
    if (step.rule === 'tempo-up' || step.rule === 'tempo-down') return pct === null ? 'tempo not on file' : `${pct > 0 ? '+' : ''}${Math.round(pct)}% tempo`;
    if (step.rule === 'same-artist') return cand.artist || '';
    if (step.rule === 'same-key') return `${from.key || '?'} into ${cand.key || '?'}`;
    return `energy ${energyOf(from).toFixed(2)} to ${energyOf(cand).toFixed(2)}`;
}

// Chain workflows into a set of about this many songs (tracksForMinutes gives the count):
// workflow 1, then 2, then back to 1, until the count is reached. No song plays twice.
export function buildSet(workflows, pool, count, harmonic, opts = {}) {
    const list = (workflows || []).filter((w) => w && (w.steps || []).length);
    if (!list.length || !pool?.length || count < 1) return [];
    const plan = [];
    const used = new Set();
    let i = 0, guard = 0;
    while (plan.length < count && guard++ < 200) {
        const w = list[i % list.length];
        const prev = plan[plan.length - 1]?.track || opts.from || null;
        const slots = fillWorkflow(w, pool, prev, harmonic, { used: [...used] });
        if (!slots.length) break;
        for (const s of slots) { if (plan.length >= count) break; plan.push(s); used.add(idOf(s.track)); }
        i += 1;
    }
    // Targets along the set, so the DJ MixZ panel can draw the energy line it already draws
    plan.forEach((s, k) => { s.target = s.energy; s.index = k; });
    return plan;
}

// Recipes to start from. Users edit copies; the moods stay as "fill it for me".
export const PRESETS = [
    makeWorkflow('Dancehall ramp', [
        { move: 'echo-out', bars: 4, rule: 'tempo-up', amount: 6, airhorn: 'classic', fxOut: 'vocal' },
        { move: 'stem-swap', bars: 8, rule: 'same-key', tempoRide: true, fxOut: 'fx' },
        { move: 'blend', bars: 16, rule: 'more-energy' },
    ], { id: 'dancehall-ramp', hint: 'horn and echo into a faster one, stems trade, settle with a long blend' }),
    makeWorkflow('Smooth ride', [
        { move: 'blend', bars: 32, rule: 'same-key' },
        { move: 'filter-sweep', bars: 16, rule: 'any' },
    ], { id: 'smooth-ride', hint: 'long blends in key, a sweep when it needs a change' }),
    makeWorkflow('Peak drop', [
        { move: 'cut', bars: 1, rule: 'more-energy', airhorn: 'double', fxIn: 'fx' },
        { move: 'echo-out', bars: 4, rule: 'same-artist', fxOut: 'vocal' },
    ], { id: 'peak-drop', hint: 'hard cut up in energy, then one more from the same act' }),
    makeWorkflow('Wind down', [
        { move: 'blend', bars: 32, rule: 'less-energy' },
        { move: 'filter-sweep', bars: 16, rule: 'tempo-down', amount: 5 },
    ], { id: 'wind-down', hint: 'brings the room down gently' }),
];

// Saved workflows on this device. The page's own storage; nothing leaves the browser.
const KEY = 'mixz-workflows';
export function loadWorkflows(storage = globalThis.localStorage) {
    try { const raw = storage?.getItem(KEY); const list = raw ? JSON.parse(raw) : []; return Array.isArray(list) ? list.map((w) => makeWorkflow(w.name, w.steps, { id: w.id, hint: w.hint })) : []; } catch (e) { return []; }
}
export function saveWorkflows(list, storage = globalThis.localStorage) {
    try { storage?.setItem(KEY, JSON.stringify((list || []).map((w) => makeWorkflow(w.name, w.steps, { id: w.id, hint: w.hint })))); return true; } catch (e) { return false; }
}
