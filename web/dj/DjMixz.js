// DjMixz.js — DJ MixZ, the bot DJ.
// Give it a playlist and a mood. It plans the whole set (which track when, so the energy
// follows the mood and the keys and tempos sit together), then plays it: it chooses how to
// move between every pair of tracks the way a working DJ would (long blend when they fit,
// filter sweep to cover a tempo gap, echo out or a hard cut when the keys clash) and times
// each move in bars, not seconds. It never uses the same move three times running.
//
// The planning is pure functions (planSet, planTransition) so it can be tested without audio.
// Playing rides on the app's FlowMode and AutoTransition.

import { keyRelation } from './SwitchPad.js';
import { advise } from './FlowDirector.js';
import { adviceData } from './StreamEvents.js';
import { esc } from './Html.js';
import { PRESETS, loadWorkflows, saveWorkflows, makeWorkflow, makeStep, buildSet, MOVES, RULES } from './Workflows.js';

// Mood = the energy the room should feel, from the first track (x = 0) to the last (x = 1).
export const MOODS = [
    { id: 'warmup',  label: 'WARM UP',   hint: 'opens easy, builds steadily',        curve: (x) => 0.25 + 0.4 * x },
    { id: 'peak',    label: 'PEAK TIME', hint: 'high the whole way, short breathers', curve: (x) => 0.82 + 0.1 * Math.sin(x * Math.PI * 5) },
    { id: 'journey', label: 'JOURNEY',   hint: 'builds to a peak, then lands',        curve: (x) => (x < 0.72 ? 0.3 + 0.62 * (x / 0.72) : 0.92 - 0.45 * ((x - 0.72) / 0.28)) },
    { id: 'sunset',  label: 'SUNSET',    hint: 'starts warm, winds down',             curve: (x) => 0.62 - 0.38 * x },
    { id: 'party',   label: 'PARTY',     hint: 'uptempo all the way, short songs',  curve: (x) => 0.86 + 0.08 * Math.sin(x * Math.PI * 4 - 0.6) },
];

const GENRE_ENERGY = [
    [/drum\s*&?\s*bass|dnb|jungle|hardstyle|hardcore/i, 0.95],
    [/techno|trance|dubstep|trap|drill/i, 0.85],
    [/house|electro|dance|edm|afro|amapiano|dancehall|soca/i, 0.72],
    [/hip.?hop|rap|reggaeton|pop|tribe|bass/i, 0.6],
    [/r&b|rnb|soul|funk|disco|reggae/i, 0.48],
    [/lo.?fi|chill|ambient|downtempo|acoustic|jazz|classical/i, 0.25],
];
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
const idOf = (t) => String(t.id ?? t.sourceId ?? `${t.title}|${t.artist}`);
const clamp01 = (n) => Math.max(0, Math.min(1, n));

// How hard a track hits, 0 to 1. Uses the track's own energy when it has one; otherwise
// tempo and genre. Half-time tracks (hip-hop at 80) are read at double tempo.
export function energyOf(t) {
    if (typeof t.energy === 'number') return clamp01(t.energy);
    let bpm = num(t.bpm);
    // Rap and trap written at 70 to 95 are felt at about one and a half times that
    if (bpm && bpm < 95 && /hip.?hop|rap|trap|drill|dancehall|reggaeton/i.test(t.genre || '')) bpm *= 1.5;
    const tempo = bpm ? clamp01((bpm - 80) / 70) : 0.5;
    const g = GENRE_ENERGY.find(([re]) => re.test(t.genre || ''));
    return clamp01(g ? tempo * 0.55 + g[1] * 0.45 : tempo);
}

export function tempoGap(a, b) {
    const x = num(a.bpm), y = num(b.bpm);
    if (!x || !y) return { pct: null, doubled: false };
    const r = y / x;
    if ((r > 1.9 && r < 2.1) || (r > 0.47 && r < 0.53)) return { pct: 0, doubled: true };
    return { pct: (r - 1) * 100, doubled: false };
}

const KEY_COST = { same: 0, up1: 0, down1: 0.05, flip: 0.05, up2: 0.3, unknown: 0.4, clash: 1 };

// How well two tracks sit next to each other: keys, tempo, and not the same artist twice.
// Lower is better. The set planner and the Flow Director (FlowDirector.js) both use it.
// With `party`, a tempo gap of up to 16% costs little when the keys fit: DJ MixZ rides the tempo.
export function joinCost(x, y, harmonic, party = false) {
    if (!x || !y) return 0;
    const g = tempoGap(x, y);
    const rel = keyRelation(harmonic, x.key, y.key);
    const ride = party && (rel === 'same' || rel === 'up1' || rel === 'down1' || rel === 'flip');
    return KEY_COST[rel] + 0.9 * (g.pct === null ? 0.4 : g.doubled ? 0.35 : Math.min(1, Math.abs(g.pct) / (ride ? 24 : 9)))
        + (x.artist && x.artist === y.artist ? 0.25 : 0);
}

// The move from track a to track b. `prevTypes` are the moves already used, newest last.
// `opts.party` plays it like a sound-system DJ: short moves, tempo rides, stem swaps, echo outs
// and the air horn.
export function planTransition(a, b, harmonic, prevTypes = [], opts = {}) {
    if (opts.party) return planPartyTransition(a, b, harmonic, prevTypes);
    const rel = keyRelation(harmonic, a.key, b.key);
    const { pct, doubled } = tempoGap(a, b);
    const gap = pct === null ? null : Math.abs(pct);
    const energy = (energyOf(a) + energyOf(b)) / 2;
    const fits = rel === 'same' || rel === 'up1' || rel === 'down1' || rel === 'flip';
    let type, bars, why;

    if (rel === 'clash' || (gap !== null && gap > 8 && !doubled)) {
        if (energy > 0.68) { type = 'cut'; bars = 1; why = rel === 'clash' ? 'keys clash, so a clean cut on the one' : 'tempo jump, so a clean cut on the one'; }
        else { type = 'echo-out'; bars = 4; why = rel === 'clash' ? 'keys clash, so the old track echoes away first' : 'tempo jump, so the old track echoes away first'; }
    } else if (doubled) {
        type = 'echo-out'; bars = 4; why = 'half or double time, echo out and drop in';
    } else if (gap !== null && gap > 4) {
        type = 'filter-sweep'; bars = energy > 0.65 ? 8 : 16; why = 'tempo shifts under a filter sweep';
    } else if (fits) {
        type = 'blend'; bars = energy < 0.45 ? 32 : 16; why = rel === 'up1' ? 'keys step up, long blend' : rel === 'flip' ? 'same notes, new mood, long blend' : 'same key family, long blend';
    } else {
        type = 'filter-sweep'; bars = 8; why = 'no key on file, sweep keeps it safe';
    }

    // A DJ does not do the same move three times in a row.
    const last2 = prevTypes.slice(-2);
    if (last2.length === 2 && last2[0] === type && last2[1] === type) {
        if (type === 'blend') { type = 'filter-sweep'; bars = 16; why += ', swept for variety'; }
        else if (type === 'filter-sweep') { type = fits ? 'blend' : 'echo-out'; bars = fits ? 16 : 4; why += ', changed up for variety'; }
        else if (type === 'cut') { type = 'echo-out'; bars = 4; why += ', echo this time'; }
        else { type = energy > 0.6 ? 'cut' : 'filter-sweep'; bars = type === 'cut' ? 1 : 8; why += ', changed up for variety'; }
    }

    const bpm = num(a.bpm) || 120;
    const seconds = Math.max(type === 'cut' ? 1.5 : 6, Math.min(40, (bars * 4 * 60) / bpm));
    return { type, bars, seconds: Math.round(seconds * 10) / 10, why };
}

// Party moves. Tempos up to 16% apart still mix when the keys fit or the vibe matches (same
// genre or close energy): the new song is pitched to the old one's tempo, key lock on, and eases
// back to its own (tempoRide). Mixes are short: 4 to 8 bars. A clash or a big jump echoes out.
// Every other move, and every echo out, the air horn goes.
export function planPartyTransition(a, b, harmonic, prevTypes = []) {
    const rel = keyRelation(harmonic, a.key, b.key);
    const { pct, doubled } = tempoGap(a, b);
    const gap = pct === null ? null : Math.abs(pct);
    const fits = rel === 'same' || rel === 'up1' || rel === 'down1' || rel === 'flip';
    const vibe = (a.genre && a.genre === b.genre) || Math.abs(energyOf(a) - energyOf(b)) < 0.15;
    const last = prevTypes[prevTypes.length - 1];
    let type, bars, why, tempoRide = false;

    if (rel === 'clash' || (gap !== null && gap > 16 && !doubled) || (gap !== null && gap > 4 && !fits && !vibe)) {
        type = 'echo-out'; bars = 4; why = rel === 'clash' ? 'keys clash: echo out and drop the next one' : 'tempo too far apart: echo out and drop the next one';
    } else if (doubled) {
        type = 'echo-out'; bars = 4; why = 'half or double time: echo out, drop in';
    } else if (gap !== null && gap > 4) {
        type = 'stem-swap'; bars = 8; tempoRide = true;
        why = `${Math.round(gap)}% apart but the ${fits ? 'keys fit' : 'vibe matches'}: tempo rides over, old vocal on the new drums`;
    } else {
        // Close tempo or none on file: trade between the stem swap and a quick blend
        type = last === 'stem-swap' ? 'blend' : 'stem-swap'; bars = type === 'blend' ? 8 : 8;
        why = type === 'stem-swap' ? 'old vocal over the new drums, then the vocals trade' : 'quick bass-swap blend';
    }

    // A DJ does not do the same move three times in a row
    const last2 = prevTypes.slice(-2);
    if (last2.length === 2 && last2[0] === type && last2[1] === type) {
        if (type === 'echo-out') { type = 'cut'; bars = 1; why += ', a hard cut this time'; }
        else { type = 'echo-out'; bars = 4; why += ', echo out for variety'; tempoRide = false; }
    }

    const airhorn = type === 'echo-out' || type === 'cut' || prevTypes.length % 2 === 0 ? (prevTypes.length % 4 === 1 ? 'double' : 'classic') : null;
    const bpm = num(a.bpm) || 120;
    const seconds = Math.max(type === 'cut' ? 1.5 : 5, Math.min(20, (bars * 4 * 60) / bpm));
    return { type, bars, seconds: Math.round(seconds * 10) / 10, why: airhorn ? why + ', air horn' : why, tempoRide, airhorn };
}

// Order a playlist for a mood. Returns [{ track, energy, target, move }] where `move` is how
// to get INTO that track from the one before (null for the first).
// `opts.shuffle` (0 to 1) makes a fresh order out of the same songs: the pool is dealt out at
// random and every energy reads a little off, so the same crate comes around in a new order
// (the 24-hour loop uses it). `opts.avoid` lists ids that must not open the set (the last songs
// of the round before): they are kept out of the first half.
const baseEnergy = energyOf;
const RECENT_KEY = 'mixz-recent-openers';
export function planSet(tracks, moodId, harmonic, opts = {}) {
    const mood = MOODS.find((m) => m.id === moodId) || MOODS[2];
    const seen = new Set();
    const pool = (tracks || []).filter((t) => t && !seen.has(idOf(t)) && seen.add(idOf(t)));
    const count = Math.min(pool.length, opts.maxTracks || pool.length);
    if (!count) return [];
    const rnd = opts.random || Math.random;
    const jitter = Math.max(0, Math.min(1, Number(opts.shuffle) || 0));
    if (jitter) for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const off = new Map(pool.map((t) => [idOf(t), jitter ? (rnd() - 0.5) * 0.3 * jitter : 0]));
    const energyOf = (t) => clamp01(baseEnergy(t) + (off.get(idOf(t)) || 0));

    const targets = Array.from({ length: count }, (_, i) => mood.curve(count === 1 ? 0 : i / (count - 1)));

    const party = moodId === 'party';
    const join = (x, y) => joinCost(x, y, harmonic, party);

    const seat = new Array(count);
    if (pool.length >= count * 1.5) {
        // Plenty to choose from: walk the set in order and take the track that is right for the
        // slot's energy AND mixes well out of the one before. This is where the long blends come from.
        const left = pool.slice();
        for (let i = 0; i < count; i++) {
            let best = 0, bestCost = Infinity;
            for (let j = 0; j < left.length; j++) {
                const cost = 2.4 * Math.abs(energyOf(left[j]) - targets[i]) + (i ? join(seat[i - 1], left[j]) : 0);
                if (cost < bestCost) { bestCost = cost; best = j; }
            }
            seat[i] = left.splice(best, 1)[0];
        }
    } else {
        // The playlist IS the set: seat by rank, so it has the mood's shape whatever it holds.
        // The quietest track goes in the quietest slot, the hardest in the hardest.
        const slots = targets.map((t, i) => i).sort((x, y) => targets[x] - targets[y]);
        const byEnergy = pool.slice().sort((x, y) => energyOf(x) - energyOf(y));
        slots.forEach((slot, rank) => { seat[slot] = byEnergy[rank]; });
    }

    // Smooth the joins: swap neighbours when it makes the keys and tempos sit better and the
    // two tracks are close enough in energy that the shape does not change.
    const around = (i) => join(seat[i - 1], seat[i]) + join(seat[i], seat[i + 1]) + join(seat[i + 1], seat[i + 2]);
    for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < count - 1; i++) {
            if (Math.abs(energyOf(seat[i]) - energyOf(seat[i + 1])) > 0.14) continue;
            const before = around(i);
            [seat[i], seat[i + 1]] = [seat[i + 1], seat[i]];
            if (around(i) >= before - 0.001) [seat[i], seat[i + 1]] = [seat[i + 1], seat[i]];
        }
    }

    const out = [];
    const types = [];
    // The songs that closed the round before do not open this one
    const avoid = new Set(opts.avoid || []);
    if (avoid.size && count > 3) {
        const half = Math.floor(count / 2);
        for (let i = 0; i < half; i++) {
            if (!avoid.has(idOf(seat[i]))) continue;
            let best = -1, bestGap = Infinity;
            for (let j = half; j < count; j++) {
                if (avoid.has(idOf(seat[j]))) continue;
                const gap = Math.abs(energyOf(seat[j]) - energyOf(seat[i]));
                if (gap < bestGap) { bestGap = gap; best = j; }
            }
            if (best >= 0) [seat[i], seat[best]] = [seat[best], seat[i]];
        }
    }

    seat.forEach((track, i) => {
        const prev = out[out.length - 1]?.track;
        const move = prev ? planTransition(prev, track, harmonic, types, { party }) : null;
        if (move) types.push(move.type);
        out.push({ track, energy: baseEnergy(track), target: targets[i], move });
    });
    return out;
}

// How many tracks fill a session of this many minutes. Uses the tracks' own lengths when the
// library has them; SongChainn does not, so those count as 3.2 minutes on air each.
// `capMin` is the longest a song stays on air (party: 2), so a party hour holds more songs.
export function tracksForMinutes(tracks, minutes, capMin = 0) {
    if (!minutes) return tracks.length;
    const known = tracks.map((t) => num(t.duration)).filter((d) => d && d > 30);
    let avgMin = known.length >= 3 ? Math.max(1.5, (known.reduce((a, b) => a + b, 0) / known.length / 60) * 0.88) : 3.2;
    if (capMin > 0) avgMin = Math.min(avgMin, capMin);
    return Math.max(2, Math.min(tracks.length, Math.round(minutes / avgMin)));
}

// No limit on how many SongChainn artists one mix is built from (Infinity: pick as many as you like).
export const MAX_ARTISTS = Infinity;

// Moods that keep every song short: the longest one is on air, mix included, in seconds.
export const MAX_PLAY = { party: 120 };

// Party stays uptempo. A song whose tempo is on file and reads slow (under 100 BPM as felt; rap,
// trap and dancehall half-time count at the speed they are felt) is out. When enough songs have a
// fast tempo on file to fill the set (`need`), only those play; songs not analyzed yet fill in only
// when there are not enough. The track analyzer (TrackAnalyzer.js) finds the tempos.
export function uptempo(tracks, need = 0) {
    const slow = (t) => num(t.bpm) && energyOf({ ...t, energy: undefined }) < energyOf({ bpm: 100, genre: t.genre });
    const knownFast = tracks.filter((t) => num(t.bpm) && !slow(t));
    if (knownFast.length >= Math.max(4, need)) return knownFast;
    const fast = tracks.filter((t) => !slow(t));
    if (fast.length >= 4 || fast.length === tracks.length) return fast;
    return tracks.slice().sort((a, b) => energyOf(b) - energyOf(a)).slice(0, Math.max(2, Math.ceil(tracks.length / 2)));
}

// The tracks a source points at. `artist` narrows the SongChainn artists source: one name, or a list of names.
export function tracksFrom(lib, sourceId, artist = '') {
    const sc = (lib.zaoTracks || []).filter((t) => t.source === 'songchainn');
    const names = (Array.isArray(artist) ? artist : [artist]).map((a) => String(a || '').trim().toLowerCase()).filter(Boolean).slice(0, MAX_ARTISTS);
    const pools = {
        view: lib._displayedTracks || [],
        zao: lib.zaoTracks || [],
        battles: lib.battleTracks || [],
        local: lib.tracks || [],
        songchainn: sc,
        'songchainn-artist': sc.filter((t) => names.some((n) => String(t.artist).toLowerCase().includes(n))),
    };
    return (pools[sourceId] || pools.view).filter((t) => t && (t.streamUrl || t.dataFile));
}

export class DjMixz {
    constructor(dj) {
        this.dj = dj;
        this.plan = [];
        this.index = 0;
        this.running = false;
        this.mood = 'journey';
        this.scArtist = [];      // artists for the SongChainn artists source, as many as the DJ picks
        this._bpm = {};          // tempos the decks have measured, by track id, kept between visits
        try { this._bpm = JSON.parse(localStorage.getItem('mixz-bpm') || '{}'); } catch (e) { /* no storage */ }
        this._learnTempos();
        this.human = false;      // true while a person has the decks
        this.endless = false;    // when the set ends, build the next one and keep going
        this._lastBuild = null;  // what the last set was built from, for endless and the phone
        this.b2b = 0;            // back to back: tracks per turn, 0 = off
        this._turn = 0;          // handovers done in the current turn
        this.battle = false;     // contest: the room scores each round, DJ MixZ against the live DJ
        this.score = { ai: 0, human: 0 };
        this.round = 1;
        this._voteOpen = false;
        this.director = 'ask';   // 'ask': say why each next song fits and offer swaps; 'off': just play the plan
        this.advice = null;      // the director's last word on the slot coming up
        this._buildUI();
    }

    _sources() {
        const lib = this.dj.library || {};
        return [
            { id: 'songchainn', label: 'SongChainn: every artist' },
            { id: 'songchainn-artist', label: 'SongChainn: pick artists' },
            { id: 'zao', label: 'ZAO crate: SongChainn and Audius' },
            { id: 'battles', label: 'WaveWarZ quick battles: last battle night' },
            { id: 'view', label: 'What the library is showing' },
            { id: 'local', label: 'LOCAL tab' },
        ];
    }

    // `extra.round` > 0 is a later round of the same crate (the 24-hour loop): new order, and
    // `extra.avoid` (ids) keeps the songs that just played away from the top of the set.
    build(sourceId, moodId, minutes, extra = {}) {
        // SongChainn stores no tempo, so use the ones the decks measured on earlier plays
        let tracks = tracksFrom(this.dj.library || {}, sourceId, this.scArtist).map((t) => (!t.bpm && this._bpm[t.id] ? { ...t, bpm: this._bpm[t.id] } : t));
        if (moodId === 'party') { this.dj.trackAnalyzer?.prioritize?.(tracks); tracks = uptempo(tracks, tracksForMinutes(tracks, minutes, 2)); }
        const maxTracks = tracksForMinutes(tracks, minutes, (MAX_PLAY[moodId] || 0) / 60);
        this.minutes = minutes;
        this.mood = moodId;
        this._lastBuild = { sourceId, moodId, minutes };
        this.loop = minutes === 1440; // 24 hours: when the crate runs out it comes back around
        // Recipes picked in the panel (Workflows.js) decide every move; none picked, the mood does.
        const recipe = (this.recipe || []).map((id) => (this.workflows || []).find((w) => w.id === id)).filter(Boolean);
        // Every set is a fresh deal (IMan, 23 Oct: same playlist, same first song is not creative),
        // and the songs that opened the last set stay out of this one's opening.
        let recent = [];
        try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { /* no storage */ }
        extra = { ...extra, round: true, avoid: [...(extra.avoid || []), ...recent] };
        if (recipe.length) {
            let pool = tracks.slice();
            if (extra.round) for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
            const avoid = new Set(extra.avoid || []);
            if (avoid.size) pool = [...pool.filter((t) => !avoid.has(String(t.id ?? t.sourceId))), ...pool.filter((t) => avoid.has(String(t.id ?? t.sourceId)))];
            this.plan = buildSet(recipe, pool, maxTracks, this.dj.harmonic);
        } else this.plan = planSet(tracks, moodId, this.dj.harmonic, { maxTracks, shuffle: extra.round ? 1 : 0, avoid: extra.avoid });
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(this.plan.slice(0, 10).map((x) => String(x.track?.id ?? x.track?.sourceId)))); } catch (e) { /* no storage */ }
        this._preloadFirst();
        this.index = 0;
        this._renderPlan();
        return this.plan;
    }

    start() {
        const flow = this.dj.flowMode;
        if (!flow || this.plan.length < 2) { this._say('Add at least two tracks, then build the set.'); return false; }
        if (!flow.enabled) flow.enable();
        this.running = true;
        if (this.loop && !this._endAt) { this._endAt = Date.now() + 24 * 3600 * 1000; this._round = 0; }
        this._startedAt = Date.now();
        this._startClock();
        this.index = 0;

        // DJ MixZ owns the queue while it plays: no auto-suggestions sneaking in.
        if (!this._orig) this._orig = { fill: flow._autoFillQueue.bind(flow), trigger: flow._triggerTransition.bind(flow), done: flow.onTransitionComplete.bind(flow) };
        flow._autoFillQueue = () => {};
        flow._triggerTransition = () => {
            if (this.human) return; // a person has the decks: DJ MixZ keeps its hands off
            const next = this.plan[this.index + 1];
            if (!next) { this._finish(); return; }
            this._applyMove(next.move);
            // A recipe step says what plays as the move starts; otherwise the mood's own habits.
            // Party: the dub siren (or the DJ's own sweep) rides an echo out; a riser leads a
            // stem swap or a cut in. Other moods: a sweep on an echo out, now and then.
            if (!this._fxOn()) { /* music only: no sounds of its own */ }
            else if (next.workflow) { if (next.move?.fxIn) this._fireFx(next.move.fxIn, 300); }
            else if (this.mood === 'party' && next.move?.type === 'echo-out') setTimeout(() => this.dj.partyFX?.siren(), 400);
            else if (this.mood === 'party' && (next.move?.type === 'stem-swap' || next.move?.type === 'cut') && Math.random() < 0.6) this.dj.partyFX?.sweep?.();
            this._orig.trigger();
        };
        flow.onTransitionComplete = (direction) => {
            this._orig.done(direction);
            this._songStart = Date.now(); this._rewound = false;
            // A recipe step says what plays as the song lands; otherwise the mood's own habits.
            // Party: a hit as the tune lands, then the MC bigs it up, most of the time.
            // Other moods: a drop now and then, so the board gets used without wearing thin.
            const landed = this.plan[this.index + 1];
            if (!this._fxOn()) { /* music only */ }
            else if (landed?.workflow) { if (landed.move?.fxOut) this._fireFx(landed.move.fxOut, 500); }
            else if (this.mood === 'party') {
                if (Math.random() < 0.5) this.dj.partyFX?.hit?.();
                if (Math.random() < 0.65) setTimeout(() => this.dj.partyFX?.hype(), 900);
            } // Other moods: no FX of their own (IMan, 23 Oct: drive time and mornings want the music and the mix)
            this.index += 1;
            this._armNext();
            this._renderPlan();
            this._turn += 1;
            if (this.b2b && this._turn >= this.b2b) this.takeOver('turn');
            else this._renderBar();
        };

        // A song Flow Mode could not load comes out of the plan too, or the plan's "next" and
        // the song actually coming in drift apart and the set never reaches its end.
        flow.onTrackDropped = (track) => this._dropped(track);
        flow.queue = this.plan.slice(1).map((p) => p.track);
        flow.start(this.plan[0].track);
        this._armNext();
        this._renderPlan();
        this._say(`DJ MixZ is on. ${this.plan.length} tracks, ${MOODS.find((m) => m.id === this.mood)?.label} mood.`);
        document.getElementById('djmixz-open')?.classList.add('live');
        const stopBtn = document.getElementById('djmixz-stop'); if (stopBtn) stopBtn.hidden = false;
        this.human = false; this._turn = 0;
        this.score = { ai: 0, human: 0 }; this.round = 1; this._voteOpen = false;
        this._watchHands();
        this._partyOn();
        this._renderBar();
        return true;
    }

    // A listener's request (the request line, RequestLine.js) goes in as the next song. If a
    // move is already under way it goes in right after the song coming in.
    playNext(track) {
        const flow = this.dj.flowMode;
        if (!this.running || !flow || !track) return false;
        const busy = flow._transitioning || flow._nearEndTriggered;
        const at = this.index + (busy ? 2 : 1);
        const id = idOf(track);
        const dup = this.plan.findIndex((p, i) => i >= at && idOf(p.track) === id);
        if (dup >= 0) { this.plan.splice(dup, 1); const q = flow.queue.findIndex((t) => idOf(t) === id); if (q >= 0) flow.queue.splice(q, 1); }
        const move = this.plan[at]?.move || this.plan[this.index]?.move || { type: 'blend', seconds: 16 };
        this.plan.splice(at, 0, { track, energy: energyOf(track), target: energyOf(track), move, request: true });
        flow.queue.splice(busy ? 1 : 0, 0, track);
        if (!busy) this._armNext();
        this._renderPlan();
        this._renderBar();
        return true;
    }

    _dropped(track) {
        const at = this.plan.findIndex((p, i) => i >= this.index && p.track === track);
        if (at < 0) return;
        this.plan.splice(at, 1);
        // The song before it now mixes straight into the one after: plan that move afresh
        const next = this.plan[at];
        if (next) next.move = at === 0 ? null : planTransition(this.plan[at - 1].track, next.track, this.dj.harmonic, [], { party: this.mood === 'party' });
        if (at === this.index + 1) this._armNext();
        this._renderPlan();
        this._renderBar();
    }

    // A handover is under way (or about to start): the next song is locked in.
    _busy() {
        const flow = this.dj.flowMode;
        return !!(flow && (flow._transitioning || flow._nearEndTriggered));
    }

    // The director's view of the slot coming up (FlowDirector.js). Advice only: nothing changes
    // until a person presses SWAP. Waiting requests from the request line count as a signal.
    _advise() {
        const now = this.plan[this.index], next = this.plan[this.index + 1];
        if (!this.running || this.human || this.director === 'off' || !now || !next) { this.advice = null; return null; }
        // A request line that throws costs the requests signal, never the bar or the set
        let requests = [];
        try {
            requests = (this.dj.requestLine?.waiting?.() || [])
                .filter((r) => r.track && (r.track.streamUrl || r.track.dataFile))
                .map((r) => ({ track: r.track, count: r.devices?.length || 1 }));
        } catch (e) { console.warn('[DjMixz] request line unreadable, advising without it:', e); }
        this.advice = advise({
            current: now.track, planned: next.track, target: next.target ?? energyOf(next.track),
            rest: this.plan.slice(this.index + 2).map((p) => p.track), harmonic: this.dj.harmonic,
            requests,
        });
        return this.advice;
    }

    // director.advice for the stream (docs/STREAM-EVENTS.md): only when the advice changes.
    _announceAdvice(adv) {
        if (!this.dj.streamEvents) return;   // nothing to tell yet; the first advice goes out once it is wired
        const data = adviceData(adv);
        const key = JSON.stringify(data);
        if (key === this._adviceKey) return;
        this._adviceKey = key;
        try { this.dj.streamEvents?.emit?.('director.advice', data); } catch (e) { /* the stream is optional */ }
    }

    // A person approved one of the director's other picks: it plays next instead. The song it
    // replaces moves back one slot rather than leaving the set. Refused during a handover.
    swapNext(track) {
        const flow = this.dj.flowMode;
        if (!this.running || this.human || !flow || !track || this._busy()) return false;
        const at = this.plan.findIndex((p, i) => i > this.index + 1 && idOf(p.track) === idOf(track));
        if (at < 0) return this.playNext(track); // a request that is not in the plan yet
        const [picked] = this.plan.splice(at, 1);
        this.plan.splice(this.index + 1, 0, picked);
        // Both joins changed: plan those two moves afresh
        const types = this.plan.slice(1, this.index + 1).map((p) => p.move?.type).filter(Boolean);
        picked.move = planTransition(this.plan[this.index].track, picked.track, this.dj.harmonic, types, { party: this.mood === 'party' });
        const after = this.plan[this.index + 2];
        if (after) after.move = planTransition(picked.track, after.track, this.dj.harmonic, [...types, picked.move.type], { party: this.mood === 'party' });
        flow.queue = this.plan.slice(this.index + 1).map((p) => p.track);
        this._armNext();
        this._say(`Swapped in: ${picked.track.title} plays next.`);
        this._renderPlan();
        this._renderBar();
        return true;
    }

    // Party: the event DJ's tricks. Every fourth song, from the third on, gets the rewind about 40
    // seconds in (pull up, back to the top, reload); never during a mix or while a person has the decks.
    _partyOn() {
        this._partyOff();
        if (this.mood !== 'party' || !this.dj.partyFX || !this._fxOn()) return;
        this.dj.partyFX.preload();
        this._songStart = Date.now(); this._rewound = false;
        setTimeout(() => this.dj.partyFX?.shout('mixz'), 1500);
        this._partyTimer = setInterval(() => {
            const flow = this.dj.flowMode;
            if (!this.running || this.human || this._rewound || !flow || flow._transitioning || flow._nearEndTriggered) return;
            if (this.index < 2 || this.index % 4 !== 2) return;
            const deck = this.dj.decks?.[flow.currentDeck];
            const t = deck?.getCurrentTime?.() || 0;
            if (deck?.isPlaying && t > 38 && t < 48) { this._rewound = true; this.dj.partyFX.rewind(deck); }
        }, 1000);
    }

    _partyOff() { if (this._partyTimer) { clearInterval(this._partyTimer); this._partyTimer = null; } }

    // Load the set's first song on deck A as soon as the set is built, so START plays it at once.
    // Never while a set runs or deck A is on air.
    _preloadFirst() {
        try {
            const first = this.plan[0]?.track;
            const deck = this.dj.decks?.A;
            const flow = this.dj.flowMode;
            if (!first || !deck || !flow || this.running || deck.isPlaying) return;
            if (deck.metadata?._sourceId != null && deck.metadata._sourceId === (first.id ?? null)) return;
            flow._loadTrackToDeck?.(deck, first);
        } catch (e) { console.warn('[DjMixz] could not preload the first song:', e); }
    }

    // Set FlowMode up for the next move: how long before the end to start, and how.
    _armNext() {
        const next = this.plan[this.index + 1];
        if (next) this._applyMove(next.move);
    }

    _applyMove(move) {
        const flow = this.dj.flowMode;
        if (!flow || !move) return;
        flow.transitionType = move.type;
        flow.transitionWhy = move.why || null;
        flow.transitionDuration = move.seconds;
        flow.transitionExtras = { tempoRide: !!move.tempoRide, airhorn: this._fxOn() ? move.airhorn || null : null };
        flow.maxPlaySeconds = MAX_PLAY[this.mood] || 0;
        flow.transitionPointMode = 'fixed';
        // Start early enough that the move finishes a few seconds before the old track runs out.
        flow.transitionPoint = Math.round(move.seconds + (move.type === 'cut' ? 2 : 6));
    }

    stop() {
        const flow = this.dj.flowMode;
        if (flow) { flow.maxPlaySeconds = 0; flow.transitionExtras = null; }
        this._partyOff();
        if (flow && this._orig) { flow._autoFillQueue = this._orig.fill; flow._triggerTransition = this._orig.trigger; flow.onTransitionComplete = this._orig.done; flow.onTrackDropped = null; }
        if (this.running && this.battle && (this.score.ai || this.score.human)) {
            const { ai, human } = this.score;
            this._say(ai === human ? `Contest over. It is a draw, ${ai} all.` : `Contest over. ${ai > human ? 'DJ MixZ' : 'The live DJ'} wins, ${Math.max(ai, human)} to ${Math.min(ai, human)}.`);
        }
        this.running = false;
        this.human = false;
        clearInterval(this._turnTimer);
        this._stopClock();
        document.getElementById('djmixz-open')?.classList.remove('live');
        const stopBtn = document.getElementById('djmixz-stop'); if (stopBtn) stopBtn.hidden = true;
        this._renderPlan();
        this._renderBar();
    }

    // When this session ends: the clock set at start for a timed session or the 24-hour loop,
    // else ("everything it has") an estimate from the songs still to play.
    sessionEndsAt() {
        if (this.loop && this._endAt) return this._endAt;
        if (this.minutes > 0 && this._startedAt) return this._startedAt + this.minutes * 60000;
        const cap = MAX_PLAY[this.mood] || 0;
        let left = 0;
        for (let i = this.index; i < this.plan.length; i++) { const d = num(this.plan[i]?.track?.duration) || 210; left += cap ? Math.min(d, cap) : d; }
        const deck = this.dj.decks?.[this.dj.flowMode?.currentDeck];
        const played = deck?.isLoaded && deck.getCurrentTime ? deck.getCurrentTime() : 0;
        return Date.now() + Math.max(0, left - played) * 1000;
    }

    _startClock() { this._stopClock(); this._tickClock(); this._clockTimer = setInterval(() => this._tickClock(), 1000); }

    _stopClock() {
        if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
        if (typeof document === 'undefined') return;
        for (const id of ['djmixz-open-clock', 'djmixz-clock']) { const el = document.getElementById(id); if (el) { el.hidden = true; el.textContent = ''; } }
    }

    _tickClock() {
        if (typeof document === 'undefined' || !this.running) return;
        const ms = Math.max(0, this.sessionEndsAt() - Date.now());
        const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        const clock = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        const label = (this.minutes > 0 || this.loop ? clock : '~' + clock) + ' left';
        const title = this.loop ? `24-hour session, round ${(this._round || 0) + 1}: when the crate runs out it comes back around in a new order` : this.minutes > 0 ? `${this.minutes}-minute session` : 'Everything it has: a guess from the songs still to play';
        for (const id of ['djmixz-open-clock', 'djmixz-clock']) { const el = document.getElementById(id); if (el) { el.textContent = label; el.title = title; el.hidden = false; } }
    }

    _finish() {
        const timeLeft = this.loop && this._endAt && Date.now() < this._endAt;
        if ((this.endless || timeLeft) && this._lastBuild) {
            const b = this._lastBuild;
            const avoid = this.plan.slice(-12).map((p) => idOf(p.track));
            const round = (this._round || 0) + 1;
            const endAt = this._endAt;
            this.stop();
            this._endAt = endAt; this._round = round;
            const plan = this.build(b.sourceId, b.moodId, b.minutes, { round, avoid });
            if (plan.length >= 2 && this.start()) {
                const left = timeLeft ? Math.round((this._endAt - Date.now()) / 3600000) : 0;
                this._say(timeLeft ? `Round ${round + 1}: same crate, new order, ${plan.length} tracks. About ${left} hours to go.` : `End of the set. Endless is on: the next ${plan.length} tracks are rolling.`);
                return;
            }
        }
        this._endAt = null; this._round = 0;
        this._say('That was the set. DJ MixZ is off.');
        this.stop();
    }

    // From the phone, or anywhere that is not the panel: pick the music, mood and length and go.
    async startFrom(sourceId = 'songchainn', moodId = 'journey', minutes = 60, endless = false) {
        this.endless = !!endless;
        if (this.running) this.stop();
        if (sourceId === 'songchainn') return this.mixSongChainn(moodId, minutes);
        this.scArtist = [];
        const plan = this.build(sourceId, moodId, minutes);
        if (plan.length < 2) { this._say('Fewer than two playable tracks there. Pick another source.'); return false; }
        return this.start();
    }

    // Whenever a deck has measured the tempo of a track that came without one, remember it.
    // The more SongChainn music gets played, the better DJ MixZ plans with it.
    _learnTempos() {
        if (typeof window === 'undefined') return;
        setInterval(() => {
            let changed = false;
            for (const id of ['A', 'B']) {
                const deck = this.dj.decks?.[id]; const m = deck?.metadata?.metadata;
                const key = m?.id ?? deck?.metadata?._sourceId;
                const bpm = deck?.isLoaded && deck.getBPM ? deck.getBPM() : null;
                if (key && bpm && bpm > 50 && bpm < 220 && this._bpm[key] !== Math.round(bpm * 10) / 10) { this._bpm[key] = Math.round(bpm * 10) / 10; changed = true; }
            }
            if (changed) { try { localStorage.setItem('mixz-bpm', JSON.stringify(this._bpm)); } catch (e) { /* no storage */ } }
        }, 3000);
    }

    // Point it at SongChainn and go: builds the set for the chosen mood and session length, and starts.
    // `artist` is one name or a list of names; empty means every artist.
    async mixSongChainn(moodId = this.mood, minutes = 60, artist = []) {
        const crate = this.dj.zaoCrate;
        if (crate && !(this.dj.library?.zaoTracks || []).some((t) => t.source === 'songchainn')) { this._say('Fetching SongChainn…'); await crate.load(true); }
        const artists = (Array.isArray(artist) ? artist : [artist]).filter(Boolean).slice(0, MAX_ARTISTS);
        this.scArtist = artists;
        const plan = this.build(artists.length ? 'songchainn-artist' : 'songchainn', moodId, minutes);
        if (plan.length < 2) { this._say(artists.length ? `Fewer than two SongChainn songs by ${artists.join(', ')}.` : 'SongChainn did not answer. Check the connection and try again.'); return false; }
        return this.start();
    }

    // ── Takeover: a person can grab the decks mid-set, and hand them back ──────────
    // The deck the room is hearing: the playing one on the crossfader's side.
    _liveDeck() {
        const d = this.dj.decks; const xf = parseFloat(document.getElementById('crossfader')?.value ?? '50');
        if (d.A.isPlaying && !d.B.isPlaying) return 'A';
        if (d.B.isPlaying && !d.A.isPlaying) return 'B';
        return xf > 50 ? 'B' : 'A';
    }

    // why: 'button' (pressed TAKE OVER), 'touch' (grabbed a control), 'turn' (back to back)
    takeOver(why = 'button') {
        if (!this.running || this.human) return;
        this.human = true;
        this._turn = 0;
        this._humanFrom = this._liveDeck();
        const flow = this.dj.flowMode;
        try { this.dj.autoTransition?.cancel?.(); } catch (e) { /* nothing running */ }
        // Also stops a handover still waiting on its song: it must not start a mix under the person
        flow?.cancelTransition();
        this._say(why === 'turn' ? 'Your turn. Mix in your next track; DJ MixZ takes it back after.' : why === 'touch' ? 'You grabbed a control, so the decks are yours. DJ MixZ is standing by.' : 'The decks are yours. DJ MixZ is standing by.');
        // In back to back, watch for the person finishing their mixes, then take the decks back.
        clearInterval(this._turnTimer);
        this._turnTimer = setInterval(() => {
            if (!this.running || !this.human) { clearInterval(this._turnTimer); return; }
            const live = this._liveDeck();
            const xf = parseFloat(document.getElementById('crossfader')?.value ?? '50');
            const landed = (live === 'A' && xf <= 8) || (live === 'B' && xf >= 92);
            if (landed && live !== this._humanFrom && this.dj.decks[live].isPlaying) {
                this._humanFrom = live; this._turn += 1; this._renderBar();
                if (this.b2b && this._turn >= this.b2b) this.handBack();
            }
        }, 500);
        this._renderBar();
        this._renderPlan();
    }

    // DJ MixZ picks up from whatever the person left playing and re-plans the rest around it.
    handBack() {
        if (!this.running || !this.human) return;
        const flow = this.dj.flowMode;
        const live = this._liveDeck();
        const deck = this.dj.decks[live];
        const m = deck.metadata?.metadata || {};
        const now = { id: m.id ?? deck.metadata?._sourceId ?? `deck:${m.title}`, title: m.title || 'Unknown', artist: m.artist || '', bpm: m.bpm || (deck.getBPM ? deck.getBPM() : null), key: m.key || null, genre: m.genre || '' };
        const used = new Set(this.plan.slice(0, this.index + 1).map((p) => idOf(p.track)));
        used.add(idOf(now));
        const rest = this.plan.slice(this.index + 1).map((p) => p.track).filter((t) => !used.has(idOf(t)));
        const tail = planSet(rest, this.mood, this.dj.harmonic);
        if (tail.length) tail[0].move = planTransition(now, tail[0].track, this.dj.harmonic, [], { party: this.mood === 'party' });
        this.plan = [{ track: now, energy: energyOf(now), target: energyOf(now), move: null }, ...tail];
        this.index = 0;
        this.human = false;
        this._turn = 0;
        clearInterval(this._turnTimer);
        if (this.battle) this._voteOpen = true; // both have played: the room scores the round
        if (flow) {
            flow.currentDeck = live; flow.currentTrack = now;
            flow._transitioning = false; flow._nearEndTriggered = false;
            flow.queue = tail.map((p) => p.track);
        }
        this._armNext();
        this._say(tail.length ? `DJ MixZ has the decks again. Next: ${tail[0].track.title}.` : 'DJ MixZ has the decks again, and the playlist is finished after this track.');
        this._renderBar();
        this._renderPlan();
    }

    // A real hand on the crossfader, a deck's transport or a load button takes over at once.
    _watchHands() {
        if (this._handsWired || typeof document === 'undefined') return;
        this._handsWired = true;
        const grab = (e) => { if (e.isTrusted && this.running && !this.human) this.takeOver('touch'); };
        document.getElementById('crossfader')?.addEventListener('input', grab);
        ['deck-a-play', 'deck-b-play', 'deck-a-cue', 'deck-b-cue'].forEach((id) => document.getElementById(id)?.addEventListener('click', grab));
        document.getElementById('library')?.addEventListener('click', (e) => { if (e.target.closest?.('.btn-load-a, .btn-load-b')) grab(e); });
    }

    // Contest: one point for whoever took the round.
    vote(who) {
        if (!this.battle || !this._voteOpen) return;
        this.score[who] += 1;
        this.round += 1;
        this._voteOpen = false;
        this._say(`Round to ${who === 'ai' ? 'DJ MixZ' : 'the live DJ'}. DJ MixZ ${this.score.ai}, live DJ ${this.score.human}.`);
        this._renderBar();
    }

    // The strip at the bottom of the screen while a set is running.
    _renderBar() {
        if (typeof document === 'undefined') return;
        let bar = document.getElementById('djmixz-bar');
        if (!this.running) { bar?.remove(); return; }
        if (!bar) {
            bar = document.createElement('div'); bar.id = 'djmixz-bar'; bar.className = 'djmixz-bar';
            document.body.appendChild(bar);
            bar.addEventListener('click', (e) => { const el = e.target.closest?.('[data-act]'); const act = el?.dataset.act; if (act === 'swap') { const alt = this.advice?.alts?.[Number(el.dataset.i)]; if (alt) this.swapNext(alt.track); } if (act === 'agentpick' || act === 'agentdismiss') { const agents = this.dj.agents; if (act === 'agentpick') agents?.playPick?.(el.dataset.pid); else agents?.dismissPick?.(el.dataset.pid); this._renderBar(); } if (act === 'take') this.takeOver('button'); if (act === 'back') this.handBack(); if (act === 'vote-ai' || act === 'vote-human') this.vote(act === 'vote-ai' ? 'ai' : 'human'); });
        }
        const next = this.plan[this.index + 1];
        const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const turn = this.b2b ? `<span class="djmixz-bar-turn">${this._turn} of ${this.b2b} this turn</span>` : '';
        const score = this.battle ? `<span class="djmixz-bar-score">ROUND ${this.round} <b>DJ MIXZ ${this.score.ai}</b> : <b>${this.score.human} LIVE DJ</b></span>` : '';
        const votes = this.battle && this._voteOpen ? `<span class="djmixz-bar-vote">Who took round ${this.round}?<button class="djmixz-bar-btn vote" data-act="vote-ai">DJ MIXZ</button><button class="djmixz-bar-btn vote" data-act="vote-human">LIVE DJ</button></span>` : '';
        const adv = this._advise();
        this._announceAdvice(adv);
        const busy = this._busy();
        const why = adv ? `<span class="djmixz-bar-why">why: ${esc(adv.why)}</span>` : '';
        // Agents' picks (AgentPick.js): each labelled with the agent's name, played only on a tap
        let picks = '';
        try {
            picks = !busy ? (this.dj.agents?.shownPicks?.() || []).map((p) => `<button class="djmixz-bar-btn swap agentpick" data-act="agentpick" data-pid="${esc(p.pid)}" title="${esc(p.why || 'no reason given')}">AI PICK FROM ${esc(p.agent)}: ${esc(p.title)}</button><button class="djmixz-bar-btn agentdismiss" data-act="agentdismiss" data-pid="${esc(p.pid)}" aria-label="Dismiss ${esc(p.agent)}'s pick">X</button>`).join('') : '';
        } catch (e) { picks = ''; }
        const swaps = adv && !busy ? adv.alts.map((a, i) => `<button class="djmixz-bar-btn swap${a.better ? ' better' : ''}" data-act="swap" data-i="${i}" title="${esc(a.reasons.join(', '))}">${a.better ? 'BETTER FIT: ' : 'OR: '}${esc(a.track.title)}</button>`).join('') : '';
        bar.classList.toggle('human', this.human);
        bar.innerHTML = this.human
            ? `<span class="djmixz-bar-who">YOU HAVE THE DECKS</span><span class="djmixz-bar-next">DJ MixZ is standing by</span>${turn}${score}<button class="djmixz-bar-btn" data-act="back">HAND BACK TO DJ MIXZ</button>`
            : `<span class="djmixz-bar-who">DJ MIXZ IS MIXING</span><span class="djmixz-bar-clock" id="djmixz-clock" hidden></span><span class="djmixz-bar-next">${next ? 'next: ' + esc(next.track.title) + ', ' + esc(next.move?.type.replace('-', ' ')) : 'last track'}</span>${why}${swaps}${picks}${turn}${score}${votes}<button class="djmixz-bar-btn" data-act="take">TAKE OVER</button>`;
    }

    // ── Panel ──────────────────────────────────────────────────
    _buildUI() {
        if (typeof document === 'undefined' || document.getElementById('djmixz-panel')) return;
        const bar = document.querySelector('.top-bar');
        if (!bar) return;
        const open = document.createElement('button');
        open.id = 'djmixz-open';
        open.className = 'btn-toolbar djmixz-open';
        open.title = 'DJ MixZ plays your playlist as a full set';
        open.innerHTML = '<span class="djmixz-dot"></span>DJ MIXZ<span class="djmixz-pro">PRO</span><span class="djmixz-clock" id="djmixz-open-clock" hidden></span>';
        const anchor = document.getElementById('flow-toggle-btn');
        if (anchor) anchor.insertAdjacentElement('beforebegin', open); else bar.appendChild(open);

        const panel = document.createElement('div');
        panel.id = 'djmixz-panel';
        panel.className = 'djmixz-panel hidden';
        panel.innerHTML = `
            <div class="djmixz-head">
                <div><div class="djmixz-title">DJ MixZ</div><div class="djmixz-sub">Hand it a playlist and a mood. It plans the set and mixes it.</div></div>
                <button class="btn-mini" id="djmixz-close" aria-label="Close">X</button>
            </div>
            <button class="djmixz-btn djmixz-quick" id="djmixz-sc">MIX SONGCHAINN NOW</button>
            <div class="djmixz-quick-hint">One press: it pulls SongChainn's music, builds a set for the mood and session length below, and plays it.</div>
            <div class="djmixz-label">Party FX</div>
            <div class="djmixz-fx" id="djmixz-fx">
                <button type="button" data-fx="horn">AIR HORN</button><button type="button" data-fx="siren">SIREN</button><button type="button" data-fx="rewind">REWIND</button>
                <button type="button" data-fx="big-tune">BIG TUNE</button><button type="button" data-fx="massive">MASSIVE</button><button type="button" data-fx="reload">RELOAD</button>
                <button type="button" data-fx="wheel-up">WHEEL UP</button><button type="button" data-fx="badman">BAD MAN</button><button type="button" data-fx="hold-tight">HOLD TIGHT</button>
                <button type="button" data-fx="board" class="djmixz-fx-board">FX BOARD: ALL THE SAMPLES</button>
            </div>
            <label class="djmixz-label" for="djmixz-source">Or choose the music</label>
            <select id="djmixz-source" class="toolbar-select djmixz-select">${this._sources().map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select>
            <div id="djmixz-artist" class="djmixz-artists" hidden role="group" aria-label="SongChainn artists"></div>
            <div class="djmixz-label">Mood</div>
            <div class="djmixz-moods">${MOODS.map((m) => `<button class="djmixz-mood${m.id === this.mood ? ' active' : ''}" data-mood="${m.id}"><b>${m.label}</b><span>${m.hint}</span></button>`).join('')}</div>
            <div class="djmixz-label">Workflows: recipes of moves</div>
            <div class="djmixz-wf-hint" id="djmixz-wf-chain">No recipe picked: the mood decides every move.</div>
            <div class="djmixz-wf" id="djmixz-wf" role="group" aria-label="Workflow recipes"></div>
            <div class="djmixz-wf-tools"><button type="button" class="btn-mini" id="djmixz-wf-new">NEW RECIPE</button><button type="button" class="btn-mini" id="djmixz-wf-clear">CLEAR PICKS</button></div>
            <div class="djmixz-wf-builder hidden" id="djmixz-wf-builder"></div>
            <label class="djmixz-label" for="djmixz-length">Session length</label>
            <select id="djmixz-length" class="toolbar-select djmixz-select"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="90">90 minutes</option><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option><option value="1440">24 hours: loops the crate, reshuffled every round</option><option value="0">Everything it has</option></select>
            <label class="djmixz-label" for="djmixz-b2b">Back to back with a live DJ</label>
            <select id="djmixz-b2b" class="toolbar-select djmixz-select"><option value="0" selected>Off. DJ MixZ plays the whole set</option><option value="1">Trade every track: one each</option><option value="2">Trade every 2 tracks</option><option value="3">Trade every 3 tracks</option><option value="b1">Contest: one track each, the room scores every round</option><option value="b2">Contest: two tracks each, the room scores every round</option></select>
            <div class="djmixz-actions">
                <button class="djmixz-btn" id="djmixz-build">BUILD THE SET</button>
                <button class="djmixz-btn djmixz-go" id="djmixz-start" disabled>START</button>
                <button class="djmixz-btn" id="djmixz-stop" hidden>STOP</button>
            </div>
            <div class="djmixz-say" id="djmixz-say" aria-live="polite">Pick a playlist and a mood, then build the set.</div>
            <ol class="djmixz-plan" id="djmixz-plan"></ol>`;
        document.body.appendChild(panel);

        open.addEventListener('click', () => panel.classList.toggle('hidden'));
        panel.querySelector('#djmixz-fx')?.addEventListener('click', (e) => {
            const fx = e.target.closest('[data-fx]')?.dataset.fx; const p = this.dj.partyFX;
            if (!fx || !p) return;
            this.dj.audioRouter?.resume?.();
            if (fx === 'board') { document.getElementById('fxboard')?.classList.toggle('hidden'); return; }
            if (fx === 'horn') p.horn();
            else if (fx === 'siren') p.siren();
            else if (fx === 'rewind') { const d = this.dj.decks?.[this.dj.flowMode?.currentDeck || 'A']; const live = d?.isPlaying ? d : ['A', 'B'].map((id) => this.dj.decks?.[id]).find((x) => x?.isPlaying); if (live) p.rewind(live); else this._say('Nothing is playing to rewind.'); }
            else p.shout(fx);
        });
        panel.querySelector('#djmixz-close').addEventListener('click', () => panel.classList.add('hidden'));
        panel.querySelectorAll('.djmixz-moods .djmixz-mood').forEach((b) => b.addEventListener('click', () => {
            panel.querySelectorAll('.djmixz-moods .djmixz-mood').forEach((x) => x.classList.remove('active'));
            b.classList.add('active'); this.mood = b.dataset.mood;
        }));
        // Workflows: recipes of moves and next-song rules (Workflows.js). Presets first, then the
        // ones saved on this device. Tap chips in the order they should chain; none picked means
        // the mood decides every move, as before. NEW RECIPE opens the builder.
        this.workflows = [...PRESETS, ...loadWorkflows().filter((w) => !PRESETS.some((p) => p.id === w.id))];
        this.recipe = [];
        let draft = null;
        const isPreset = (id) => PRESETS.some((p) => p.id === id);
        const wfEl = panel.querySelector('#djmixz-wf'), builder = panel.querySelector('#djmixz-wf-builder');
        const padOptions = () => [['', 'nothing'], ['horn', 'air horn'], ['vocal', 'a drop (MC)'], ['fx', 'an FX pad'], ...(this.dj.soundBoard?.pads || []).map((p) => [p.id, p.label.toLowerCase()])];
        const renderWf = () => {
            wfEl.innerHTML = this.workflows.map((w) => {
                const at = this.recipe.indexOf(w.id);
                const steps = w.steps.map((s) => s.move.replace('-', ' ')).join(', ');
                return `<button type="button" class="djmixz-mood djmixz-wf-chip${at >= 0 ? ' active' : ''}" data-wf="${esc(w.id)}" aria-pressed="${at >= 0}"><b>${at >= 0 ? (at + 1) + '. ' : ''}${esc(w.name)}</b><span>${esc(w.hint || steps)}</span><span class="djmixz-wf-edit" data-edit="${esc(w.id)}">${isPreset(w.id) ? 'copy' : 'edit'}</span></button>`;
            }).join('');
            const chain = this.recipe.map((id) => this.workflows.find((w) => w.id === id)?.name).filter(Boolean);
            panel.querySelector('#djmixz-wf-chain').textContent = chain.length ? 'Chained: ' + chain.join(' > ') + '. Repeats until the time is filled.' : 'No recipe picked: the mood decides every move.';
        };
        const sel = (name, i, options, value) => `<select data-step="${i}" data-field="${name}" class="toolbar-select djmixz-select">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        const renderBuilder = () => {
            if (!draft) { builder.classList.add('hidden'); builder.innerHTML = ''; return; }
            builder.classList.remove('hidden');
            const pads = padOptions();
            builder.innerHTML = `
                <div class="djmixz-wf-head"><input type="text" id="djmixz-wf-name" class="djmixz-wf-name" placeholder="Name this recipe" value="${esc(draft.name)}" maxlength="40">
                <select id="djmixz-wf-from" class="toolbar-select djmixz-select" aria-label="Start from a recipe"><option value="">start from…</option>${this.workflows.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></div>
                <ol class="djmixz-wf-steps">${draft.steps.map((s, i) => `<li class="djmixz-wf-step">
                    <div class="djmixz-wf-row"><label>move ${sel('move', i, MOVES.map((m) => [m.id, m.label.toLowerCase()]), s.move)}</label><label>bars <input type="number" min="1" max="64" value="${s.bars}" data-step="${i}" data-field="bars" class="djmixz-wf-num"></label><label>next song ${sel('rule', i, RULES.map((r) => [r.id, r.label.toLowerCase()]), s.rule)}</label><label${s.rule.startsWith('tempo') ? '' : ' hidden'}>by % <input type="number" min="1" max="24" value="${s.amount}" data-step="${i}" data-field="amount" class="djmixz-wf-num"></label></div>
                    <div class="djmixz-wf-row"><label>as it starts ${sel('fxIn', i, pads, s.fxIn || '')}</label><label>as it lands ${sel('fxOut', i, pads, s.fxOut || '')}</label><label>horn ${sel('airhorn', i, [['', 'no'], ['classic', 'yes'], ['double', 'double']], s.airhorn || '')}</label><label class="djmixz-wf-check"><input type="checkbox" data-step="${i}" data-field="tempoRide"${s.tempoRide ? ' checked' : ''}> tempo ride</label><button type="button" class="btn-mini" data-del="${i}" aria-label="Remove step ${i + 1}">X</button></div>
                </li>`).join('')}</ol>
                <div class="djmixz-wf-tools"><button type="button" class="btn-mini" id="djmixz-wf-add">ADD STEP</button><button type="button" class="djmixz-btn djmixz-wf-save" id="djmixz-wf-save">SAVE RECIPE</button>${draft.id && !isPreset(draft.id) ? '<button type="button" class="btn-mini" id="djmixz-wf-delete">DELETE</button>' : ''}<button type="button" class="btn-mini" id="djmixz-wf-cancel">CANCEL</button></div>`;
        };
        const openDraft = (from) => {
            draft = from ? { id: isPreset(from.id) ? null : from.id, name: isPreset(from.id) ? from.name + ' (mine)' : from.name, steps: from.steps.map((s) => ({ ...s })) } : { id: null, name: '', steps: [makeStep({})] };
            renderBuilder();
            builder.querySelector('#djmixz-wf-name')?.focus();
        };
        wfEl.addEventListener('click', (e) => {
            const edit = e.target.closest('[data-edit]')?.dataset.edit;
            if (edit) { openDraft(this.workflows.find((w) => w.id === edit)); e.stopPropagation(); return; }
            const id = e.target.closest('[data-wf]')?.dataset.wf;
            if (!id) return;
            this.recipe = this.recipe.includes(id) ? this.recipe.filter((x) => x !== id) : [...this.recipe, id];
            renderWf();
        });
        panel.querySelector('#djmixz-wf-new').addEventListener('click', () => openDraft(null));
        panel.querySelector('#djmixz-wf-clear').addEventListener('click', () => { this.recipe = []; renderWf(); });
        builder.addEventListener('input', (e) => {
            const el = e.target, i = Number(el.dataset.step), f = el.dataset.field;
            if (el.id === 'djmixz-wf-name') { draft.name = el.value; return; }
            if (!f || !draft?.steps[i]) return;
            draft.steps[i][f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
            if (f === 'rule') renderBuilder();
        });
        builder.addEventListener('change', (e) => {
            if (e.target.id !== 'djmixz-wf-from') return;
            const from = this.workflows.find((w) => w.id === e.target.value);
            if (from) { draft.steps = from.steps.map((s) => ({ ...s })); if (!draft.name.trim()) draft.name = from.name + ' (mine)'; renderBuilder(); }
        });
        builder.addEventListener('click', (e) => {
            const del = e.target.closest('[data-del]')?.dataset.del;
            if (del !== undefined) { draft.steps.splice(Number(del), 1); if (!draft.steps.length) draft.steps.push(makeStep({})); renderBuilder(); return; }
            const id = e.target.closest('button')?.id;
            if (id === 'djmixz-wf-add') { draft.steps.push(makeStep({})); renderBuilder(); }
            else if (id === 'djmixz-wf-cancel') { draft = null; renderBuilder(); }
            else if (id === 'djmixz-wf-delete') { this.workflows = this.workflows.filter((w) => w.id !== draft.id); this.recipe = this.recipe.filter((x) => x !== draft.id); saveWorkflows(this.workflows.filter((w) => !isPreset(w.id))); draft = null; renderWf(); renderBuilder(); this._say('Recipe deleted.'); }
            else if (id === 'djmixz-wf-save') {
                if (!draft.name.trim()) { this._say('Give the recipe a name first.'); builder.querySelector('#djmixz-wf-name')?.focus(); return; }
                let w = makeWorkflow(draft.name, draft.steps, { id: draft.id });
                if (isPreset(w.id) || (!draft.id && this.workflows.some((x) => x.id === w.id))) w = makeWorkflow(draft.name, draft.steps, { id: w.id + '-' + Date.now().toString(36).slice(-4) });
                this.workflows = draft.id ? this.workflows.map((x) => (x.id === w.id ? w : x)) : [...this.workflows, w];
                saveWorkflows(this.workflows.filter((x) => !isPreset(x.id)));
                if (!this.recipe.includes(w.id)) this.recipe = [...this.recipe, w.id];
                draft = null; renderWf(); renderBuilder();
                this._say(`Recipe "${w.name}" saved and picked: ${w.steps.length} ${w.steps.length === 1 ? 'step' : 'steps'}. Build the set to hear it.`);
            }
        });
        renderWf();

        const artistSel = panel.querySelector('#djmixz-artist');
        // Tap as many artist chips as you like. ALL and CLEAR in the header pick or drop everyone.
        // Picked artists sit on top as chips with an x; a search box narrows the long list.
        const scNames = () => [...new Set((this.dj.library?.zaoTracks || []).filter((t) => t.source === 'songchainn').map((t) => t.artist))].sort((a, b) => a.localeCompare(b));
        const songCount = (n) => (this.dj.library?.zaoTracks || []).filter((t) => t.source === 'songchainn' && t.artist === n).length;
        let artistQuery = '';
        let artistsLoading = false;
        const renderArtists = () => {
            const picked = this.scArtist;
            const full = picked.length >= MAX_ARTISTS;
            const names = scNames();
            const q = artistQuery.trim().toLowerCase();
            const shown = names.filter((n) => !q || n.toLowerCase().includes(q));
            const chip = (n) => {
                const on = picked.includes(n);
                return `<button type="button" class="djmixz-chip${on ? ' on' : ''}" data-artist="${esc(n)}" aria-pressed="${on}"${full && !on ? ' disabled' : ''}><span class="djmixz-chip-name">${esc(n)}</span><span class="djmixz-chip-n">${songCount(n)}</span></button>`;
            };
            artistSel.querySelector('.djmixz-artists-count').textContent = `${picked.length} of ${names.length} picked`;
            artistSel.querySelector('.djmixz-artists-picked').innerHTML = picked.length
                ? picked.map((n) => `<button type="button" class="djmixz-pick" data-artist="${esc(n)}" aria-label="Remove ${esc(n)}">${esc(n)} <b>x</b></button>`).join('')
                : '<span class="djmixz-artists-hint">Tap the artists you want in the mix, as many as you like</span>';
            artistSel.querySelector('.djmixz-artists-grid').innerHTML = artistsLoading && !names.length
                ? '<div class="djmixz-artists-empty">Loading SongChainn artists…</div>'
                : !names.length ? '<div class="djmixz-artists-empty">No SongChainn artists yet. Check the connection and pick this again.</div>'
                : shown.length ? shown.map(chip).join('') : `<div class="djmixz-artists-empty">No artist matches "${esc(artistQuery)}".</div>`;
        };
        const toggleArtist = (n) => {
            const at = this.scArtist.indexOf(n);
            if (at >= 0) this.scArtist = this.scArtist.filter((x) => x !== n);
            else if (this.scArtist.length < MAX_ARTISTS) this.scArtist = [...this.scArtist, n];
            renderArtists();
            this.dj.trackAnalyzer?.prioritize?.(tracksFrom(this.dj.library || {}, 'songchainn-artist', this.scArtist));
        };
        artistSel.innerHTML = `
            <div class="djmixz-artists-head"><span>Pick artists</span><span class="djmixz-artists-count"></span><span class="djmixz-artists-tools"><button type="button" data-pick="all">ALL</button><button type="button" data-pick="none">CLEAR</button></span></div>
            <div class="djmixz-artists-picked"></div>
            <input type="search" class="djmixz-artists-search" placeholder="Search artists" aria-label="Search artists">
            <div class="djmixz-artists-grid"></div>`;
        artistSel.querySelector('.djmixz-artists-search').addEventListener('input', (e) => { artistQuery = e.target.value; renderArtists(); });
        artistSel.addEventListener('click', (e) => {
            const tool = e.target.closest('[data-pick]')?.dataset.pick;
            if (tool) { this.scArtist = tool === 'all' ? scNames() : []; renderArtists(); return; }
            const b = e.target.closest('[data-artist]');
            if (b && !b.disabled) toggleArtist(b.dataset.artist);
        });
        panel.querySelector('#djmixz-source').addEventListener('change', async (e) => {
            const pick = e.target.value === 'songchainn-artist'; artistSel.hidden = !pick;
            if (!pick) return;
            const crate = this.dj.zaoCrate;
            const missing = crate && !(this.dj.library?.zaoTracks || []).some((t) => t.source === 'songchainn');
            artistsLoading = !!missing;
            renderArtists();
            if (missing) {
                this._say('Fetching SongChainn…');
                try { await crate.load(true); } catch (err) { /* the empty list says so */ }
                // A load already under way (the app's own, at start-up) returns before the songs
                // are in: keep looking for up to 30 seconds, filling the list as they arrive.
                for (let i = 0; i < 60 && !scNames().length && !artistSel.hidden; i++) await new Promise((r) => setTimeout(r, 500));
                artistsLoading = false;
                renderArtists();
            }
            this._say('Pick your artists, a mood, then build the set.');
        });
        panel.querySelector('#djmixz-sc').addEventListener('click', async () => {
            panel.querySelector('#djmixz-source').value = 'songchainn'; artistSel.hidden = true;
            readB2b(panel.querySelector('#djmixz-b2b').value);
            if (await this.mixSongChainn(this.mood, Number(panel.querySelector('#djmixz-length').value))) { panel.querySelector('#djmixz-stop').hidden = false; panel.querySelector('#djmixz-start').disabled = false; }
        });
        panel.querySelector('#djmixz-build').addEventListener('click', () => {
            const plan = this.build(panel.querySelector('#djmixz-source').value, this.mood, Number(panel.querySelector('#djmixz-length').value));
            panel.querySelector('#djmixz-start').disabled = plan.length < 2;
            const recipes = (this.recipe || []).length;
            this._say(plan.length < 2 ? 'That playlist has fewer than two playable tracks. Open a fuller tab in the library and build again.' : recipes ? `Set built from ${recipes} ${recipes === 1 ? 'recipe' : 'recipes'}: ${plan.length} tracks. Read it through, then press START.` : `Set built: ${plan.length} tracks. Read it through, then press START.`);
        });
        const readB2b = (v) => { this.battle = String(v).startsWith('b'); this.b2b = Number(String(v).replace('b', '')) || 0; };
        panel.querySelector('#djmixz-b2b').addEventListener('change', (e) => { readB2b(e.target.value); this._renderBar(); });
        panel.querySelector('#djmixz-start').addEventListener('click', () => { readB2b(panel.querySelector('#djmixz-b2b').value); if (this.start()) { panel.querySelector('#djmixz-stop').hidden = false; } });
        panel.querySelector('#djmixz-stop').addEventListener('click', () => { this.stop(); this.dj.flowMode?.disable(); panel.querySelector('#djmixz-stop').hidden = true; this._say('Stopped. The decks are yours.'); });
    }

    // DJ MixZ adds sounds of its own (horn, siren, sweeps, drops, rewind) only where the DJ keeps
    // a local board (board.local.json). Zaal's and the public app play music only (Zaal, 22 Oct).
    _fxOn() { return !!this.dj.soundBoard?.local; }

    // One sound from the FX board for a recipe step: a pad id, or a group (horn, vocal, fx).
    _fireFx(what, delay = 0) {
        const board = this.dj.soundBoard;
        if (!board || !what) return;
        setTimeout(() => {
            try {
                if (board.pads.some((p) => p.id === what)) board.play(what, { echo: /^neily|vocal/.test(what) });
                else board.fire(what, { echo: what === 'vocal' });
            } catch (e) { /* no FX, the mix goes on */ }
        }, delay);
    }

    _say(text) { const el = typeof document !== 'undefined' && document.getElementById('djmixz-say'); if (el) el.textContent = text; }

    _renderPlan() {
        const el = typeof document !== 'undefined' && document.getElementById('djmixz-plan');
        if (!el) return;
        const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        el.innerHTML = this.plan.map((p, i) => {
            const state = this.running && i === this.index ? ' now' : this.running && i < this.index ? ' done' : '';
            const tag = p.workflow ? `<i class="djmixz-wf-tag">${esc((this.workflows || []).find((w) => w.id === p.workflow)?.name || p.workflow)}</i> ` : '';
            const move = p.move ? `<div class="djmixz-move">${tag}<b>${p.move.type.replace('-', ' ')}</b>, ${p.move.bars} ${p.move.bars === 1 ? 'bar' : 'bars'}. ${esc(p.move.why)}.</div>` : '<div class="djmixz-move"><b>opens the set</b></div>';
            return `<li class="djmixz-row${state}">${move}<div class="djmixz-track"><span class="djmixz-energy" style="--e:${Math.round(p.energy * 100)}%"></span><span class="djmixz-name">${esc(p.track.title)}</span><span class="djmixz-meta">${esc(p.track.artist)}${p.track.bpm ? ' · ' + Math.round(p.track.bpm) + ' BPM' : ''}</span></div></li>`;
        }).join('');
    }
}
