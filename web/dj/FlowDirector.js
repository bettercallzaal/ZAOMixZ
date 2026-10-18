// FlowDirector.js — why this song next, and what else would fit.
//
// DJ MixZ plans the whole set up front (planSet). The director looks at the slot coming up
// while the set plays: it ranks the songs left in the plan, plus anything listeners have
// asked for, against the energy the mood wants at that point, how the keys and tempos join,
// and how many people requested each one. Every pick comes with its reasons in plain words.
//
// It only advises. Nothing changes until a person approves a swap, it never runs inside a
// handover, and it is plain arithmetic (no model, no network), so it cannot hold up playback.
// If it fails for any reason the set plays as planned (advise returns null).
//
// Pure: see FlowDirector.test.mjs.

import { energyOf, joinCost, tempoGap } from './DjMixz.js';
import { keyRelation } from './SwitchPad.js';

const idOf = (t) => String(t.id ?? t.sourceId ?? `${t.title}|${t.artist}`);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };

export const ENERGY_WEIGHT = 2.4;    // the same weight planSet gives the mood's curve
export const REQUEST_BONUS = 0.25;   // per listener who asked for it
export const REQUEST_CAP = 0.6;      // so a crowd cannot out-vote a key clash
export const BETTER_BY = 0.2;        // an alternative is "a better fit" when it beats the plan by this much

const KEY_WORDS = {
    same: 'same key', up1: 'key steps up one', down1: 'key steps down one', flip: 'relative key, same notes',
    up2: 'key jumps two steps', unknown: 'no key on file', clash: 'keys clash',
};

// Plain-word reasons for following `current` with `track`, in the order a DJ would say them.
export function reasonsFor(current, track, target, harmonic, requested = 0) {
    const out = [];
    const diff = energyOf(track) - target;
    const dir = diff > 0 ? 'higher' : 'lower';
    if (Math.abs(diff) < 0.08) out.push('energy right on the mood curve');
    else if (Math.abs(diff) < 0.2) out.push(`energy a little ${dir} than the curve wants`);
    else out.push(`energy much ${dir} than the curve wants`);
    out.push(KEY_WORDS[keyRelation(harmonic, current.key, track.key)]);
    const g = tempoGap(current, track);
    if (g.doubled) out.push('half or double time');
    else if (g.pct === null) out.push('no tempo on file');
    else if (Math.abs(g.pct) <= 2) out.push(`tempo matches (${Math.round(num(current.bpm))} to ${Math.round(num(track.bpm))} BPM)`);
    else out.push(`tempo ${Math.round(Math.abs(g.pct))}% ${g.pct > 0 ? 'faster' : 'slower'}`);
    if (current.artist && current.artist === track.artist) out.push('same artist as now');
    if (requested) out.push(`requested by ${requested} ${requested === 1 ? 'listener' : 'listeners'}`);
    return out;
}

// Rank `candidates` to follow `current` in a slot whose mood energy is `target`.
// `requests`: [{ track, count }] from the request line. Lower cost is a better fit.
export function rankNext({ current, candidates = [], target = 0.5, harmonic = null, requests = [] }) {
    const asked = new Map();
    for (const r of requests) if (r?.track) asked.set(idOf(r.track), (asked.get(idOf(r.track)) || 0) + (r.count || 1));
    const seen = new Set([idOf(current)]);
    const pool = [...candidates, ...requests.map((r) => r?.track)].filter((t) => t && !seen.has(idOf(t)) && seen.add(idOf(t)));
    return pool.map((track) => {
        const requested = asked.get(idOf(track)) || 0;
        const cost = ENERGY_WEIGHT * Math.abs(energyOf(track) - target) + joinCost(current, track, harmonic)
            - Math.min(REQUEST_CAP, REQUEST_BONUS * requested);
        return { track, cost: Math.round(cost * 1000) / 1000, requested, reasons: reasonsFor(current, track, target, harmonic, requested) };
    }).sort((a, b) => a.cost - b.cost);
}

// What to show for the slot coming up: why the planned song fits, and up to `limit` other
// songs ranked against it. Returns null when there is nothing to advise or anything fails.
export function advise({ current, planned, target, rest = [], harmonic = null, requests = [], limit = 2 }) {
    try {
        if (!current || !planned) return null;
        const ranked = rankNext({ current, candidates: [planned, ...rest], target, harmonic, requests });
        const mine = ranked.find((r) => idOf(r.track) === idOf(planned));
        if (!mine) return null;
        const alts = ranked.filter((r) => r !== mine).slice(0, limit).map((r) => ({ ...r, better: r.cost < mine.cost - BETTER_BY }));
        return { planned: mine, why: mine.reasons.join(', '), alts };
    } catch (e) {
        console.warn('[FlowDirector] no advice this time, the set plays as planned:', e);
        return null;
    }
}
