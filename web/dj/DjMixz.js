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

// Mood = the energy the room should feel, from the first track (x = 0) to the last (x = 1).
export const MOODS = [
    { id: 'warmup',  label: 'WARM UP',   hint: 'opens easy, builds steadily',        curve: (x) => 0.25 + 0.4 * x },
    { id: 'peak',    label: 'PEAK TIME', hint: 'high the whole way, short breathers', curve: (x) => 0.82 + 0.1 * Math.sin(x * Math.PI * 5) },
    { id: 'journey', label: 'JOURNEY',   hint: 'builds to a peak, then lands',        curve: (x) => (x < 0.72 ? 0.3 + 0.62 * (x / 0.72) : 0.92 - 0.45 * ((x - 0.72) / 0.28)) },
    { id: 'sunset',  label: 'SUNSET',    hint: 'starts warm, winds down',             curve: (x) => 0.62 - 0.38 * x },
    { id: 'party',   label: 'PARTY',     hint: 'waves: push, release, push',          curve: (x) => 0.7 + 0.22 * Math.sin(x * Math.PI * 4 - 0.6) },
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

function tempoGap(a, b) {
    const x = num(a.bpm), y = num(b.bpm);
    if (!x || !y) return { pct: null, doubled: false };
    const r = y / x;
    if ((r > 1.9 && r < 2.1) || (r > 0.47 && r < 0.53)) return { pct: 0, doubled: true };
    return { pct: (r - 1) * 100, doubled: false };
}

const KEY_COST = { same: 0, up1: 0, down1: 0.05, flip: 0.05, up2: 0.3, unknown: 0.4, clash: 1 };

// The move from track a to track b. `prevTypes` are the moves already used, newest last.
export function planTransition(a, b, harmonic, prevTypes = []) {
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

// Order a playlist for a mood. Returns [{ track, energy, target, move }] where `move` is how
// to get INTO that track from the one before (null for the first).
export function planSet(tracks, moodId, harmonic, opts = {}) {
    const mood = MOODS.find((m) => m.id === moodId) || MOODS[2];
    const seen = new Set();
    const pool = (tracks || []).filter((t) => t && !seen.has(idOf(t)) && seen.add(idOf(t)));
    const count = Math.min(pool.length, opts.maxTracks || pool.length);
    if (!count) return [];

    const targets = Array.from({ length: count }, (_, i) => mood.curve(count === 1 ? 0 : i / (count - 1)));

    // How well two tracks sit next to each other: keys, tempo, and not the same artist twice.
    const join = (x, y) => {
        if (!x || !y) return 0;
        const g = tempoGap(x, y);
        return KEY_COST[keyRelation(harmonic, x.key, y.key)] + 0.9 * (g.pct === null ? 0.4 : g.doubled ? 0.35 : Math.min(1, Math.abs(g.pct) / 9))
            + (x.artist && x.artist === y.artist ? 0.25 : 0);
    };

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
    seat.forEach((track, i) => {
        const prev = out[out.length - 1]?.track;
        const move = prev ? planTransition(prev, track, harmonic, types) : null;
        if (move) types.push(move.type);
        out.push({ track, energy: energyOf(track), target: targets[i], move });
    });
    return out;
}

// How many tracks fill a session of this many minutes. Uses the tracks' own lengths when the
// library has them; SongChainn does not, so those count as 3.2 minutes on air each.
export function tracksForMinutes(tracks, minutes) {
    if (!minutes) return tracks.length;
    const known = tracks.map((t) => num(t.duration)).filter((d) => d && d > 30);
    const avgMin = known.length >= 3 ? Math.max(1.5, (known.reduce((a, b) => a + b, 0) / known.length / 60) * 0.88) : 3.2;
    return Math.max(2, Math.min(tracks.length, Math.round(minutes / avgMin)));
}

// The tracks a source points at. `artist` narrows the SongChainn one-artist source.
export function tracksFrom(lib, sourceId, artist = '') {
    const sc = (lib.zaoTracks || []).filter((t) => t.source === 'songchainn');
    const pools = {
        view: lib._displayedTracks || [],
        zao: lib.zaoTracks || [],
        battles: lib.battleTracks || [],
        local: lib.tracks || [],
        songchainn: sc,
        'songchainn-artist': sc.filter((t) => artist && String(t.artist).toLowerCase().includes(artist.toLowerCase())),
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
        this.scArtist = '';      // artist for the SongChainn one-artist source
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
        this._buildUI();
    }

    _sources() {
        const lib = this.dj.library || {};
        return [
            { id: 'songchainn', label: 'SongChainn: every artist' },
            { id: 'songchainn-artist', label: 'SongChainn: one artist' },
            { id: 'zao', label: 'ZAO crate: SongChainn and Audius' },
            { id: 'battles', label: 'WaveWarZ quick battles: last battle night' },
            { id: 'view', label: 'What the library is showing' },
            { id: 'local', label: 'LOCAL tab' },
        ];
    }

    build(sourceId, moodId, minutes) {
        // SongChainn stores no tempo, so use the ones the decks measured on earlier plays
        const tracks = tracksFrom(this.dj.library || {}, sourceId, this.scArtist).map((t) => (!t.bpm && this._bpm[t.id] ? { ...t, bpm: this._bpm[t.id] } : t));
        const maxTracks = tracksForMinutes(tracks, minutes);
        this.minutes = minutes;
        this.mood = moodId;
        this._lastBuild = { sourceId, moodId, minutes };
        this.plan = planSet(tracks, moodId, this.dj.harmonic, { maxTracks });
        this.index = 0;
        this._renderPlan();
        return this.plan;
    }

    start() {
        const flow = this.dj.flowMode;
        if (!flow || this.plan.length < 2) { this._say('Add at least two tracks, then build the set.'); return false; }
        if (!flow.enabled) flow.enable();
        this.running = true;
        this.index = 0;

        // DJ MixZ owns the queue while it plays: no auto-suggestions sneaking in.
        if (!this._orig) this._orig = { fill: flow._autoFillQueue.bind(flow), trigger: flow._triggerTransition.bind(flow), done: flow.onTransitionComplete.bind(flow) };
        flow._autoFillQueue = () => {};
        flow._triggerTransition = () => {
            if (this.human) return; // a person has the decks: DJ MixZ keeps its hands off
            const next = this.plan[this.index + 1];
            if (!next) { this._finish(); return; }
            this._applyMove(next.move);
            this._orig.trigger();
        };
        flow.onTransitionComplete = (direction) => {
            this._orig.done(direction);
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
        if (next) next.move = at === 0 ? null : planTransition(this.plan[at - 1].track, next.track, this.dj.harmonic);
        if (at === this.index + 1) this._armNext();
        this._renderPlan();
        this._renderBar();
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
        flow.transitionDuration = move.seconds;
        flow.transitionPointMode = 'fixed';
        // Start early enough that the move finishes a few seconds before the old track runs out.
        flow.transitionPoint = Math.round(move.seconds + (move.type === 'cut' ? 2 : 6));
    }

    stop() {
        const flow = this.dj.flowMode;
        if (flow && this._orig) { flow._autoFillQueue = this._orig.fill; flow._triggerTransition = this._orig.trigger; flow.onTransitionComplete = this._orig.done; flow.onTrackDropped = null; }
        if (this.running && this.battle && (this.score.ai || this.score.human)) {
            const { ai, human } = this.score;
            this._say(ai === human ? `Contest over. It is a draw, ${ai} all.` : `Contest over. ${ai > human ? 'DJ MixZ' : 'The live DJ'} wins, ${Math.max(ai, human)} to ${Math.min(ai, human)}.`);
        }
        this.running = false;
        this.human = false;
        clearInterval(this._turnTimer);
        document.getElementById('djmixz-open')?.classList.remove('live');
        const stopBtn = document.getElementById('djmixz-stop'); if (stopBtn) stopBtn.hidden = true;
        this._renderPlan();
        this._renderBar();
    }

    _finish() {
        if (this.endless && this._lastBuild) {
            const b = this._lastBuild;
            this.stop();
            const plan = this.build(b.sourceId, b.moodId, b.minutes);
            if (plan.length >= 2 && this.start()) { this._say(`End of the set. Endless is on: the next ${plan.length} tracks are rolling.`); return; }
        }
        this._say('That was the set. DJ MixZ is off.');
        this.stop();
    }

    // From the phone, or anywhere that is not the panel: pick the music, mood and length and go.
    async startFrom(sourceId = 'songchainn', moodId = 'journey', minutes = 60, endless = false) {
        this.endless = !!endless;
        if (this.running) this.stop();
        if (sourceId === 'songchainn') return this.mixSongChainn(moodId, minutes);
        this.scArtist = '';
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
    async mixSongChainn(moodId = this.mood, minutes = 60, artist = '') {
        const crate = this.dj.zaoCrate;
        if (crate && !(this.dj.library?.zaoTracks || []).some((t) => t.source === 'songchainn')) { this._say('Fetching SongChainn…'); await crate.load(true); }
        this.scArtist = artist;
        const plan = this.build(artist ? 'songchainn-artist' : 'songchainn', moodId, minutes);
        if (plan.length < 2) { this._say(artist ? `Fewer than two SongChainn songs by "${artist}".` : 'SongChainn did not answer. Check the connection and try again.'); return false; }
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
        if (tail.length) tail[0].move = planTransition(now, tail[0].track, this.dj.harmonic);
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
            bar.addEventListener('click', (e) => { const act = e.target.closest?.('[data-act]')?.dataset.act; if (act === 'take') this.takeOver('button'); if (act === 'back') this.handBack(); if (act === 'vote-ai' || act === 'vote-human') this.vote(act === 'vote-ai' ? 'ai' : 'human'); });
        }
        const next = this.plan[this.index + 1];
        const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const turn = this.b2b ? `<span class="djmixz-bar-turn">${this._turn} of ${this.b2b} this turn</span>` : '';
        const score = this.battle ? `<span class="djmixz-bar-score">ROUND ${this.round} <b>DJ MIXZ ${this.score.ai}</b> : <b>${this.score.human} LIVE DJ</b></span>` : '';
        const votes = this.battle && this._voteOpen ? `<span class="djmixz-bar-vote">Who took round ${this.round}?<button class="djmixz-bar-btn vote" data-act="vote-ai">DJ MIXZ</button><button class="djmixz-bar-btn vote" data-act="vote-human">LIVE DJ</button></span>` : '';
        bar.classList.toggle('human', this.human);
        bar.innerHTML = this.human
            ? `<span class="djmixz-bar-who">YOU HAVE THE DECKS</span><span class="djmixz-bar-next">DJ MixZ is standing by</span>${turn}${score}<button class="djmixz-bar-btn" data-act="back">HAND BACK TO DJ MIXZ</button>`
            : `<span class="djmixz-bar-who">DJ MIXZ IS MIXING</span><span class="djmixz-bar-next">${next ? 'next: ' + esc(next.track.title) + ', ' + esc(next.move?.type.replace('-', ' ')) : 'last track'}</span>${turn}${score}${votes}<button class="djmixz-bar-btn" data-act="take">TAKE OVER</button>`;
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
        open.innerHTML = '<span class="djmixz-dot"></span>DJ MIXZ<span class="djmixz-pro">PRO</span>';
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
            <label class="djmixz-label" for="djmixz-source">Or choose the music</label>
            <select id="djmixz-source" class="toolbar-select djmixz-select">${this._sources().map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select>
            <select id="djmixz-artist" class="toolbar-select djmixz-select" hidden aria-label="SongChainn artist"></select>
            <div class="djmixz-label">Mood</div>
            <div class="djmixz-moods">${MOODS.map((m) => `<button class="djmixz-mood${m.id === this.mood ? ' active' : ''}" data-mood="${m.id}"><b>${m.label}</b><span>${m.hint}</span></button>`).join('')}</div>
            <label class="djmixz-label" for="djmixz-length">Session length</label>
            <select id="djmixz-length" class="toolbar-select djmixz-select"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="90">90 minutes</option><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option><option value="0">Everything it has</option></select>
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
        panel.querySelector('#djmixz-close').addEventListener('click', () => panel.classList.add('hidden'));
        panel.querySelectorAll('.djmixz-mood').forEach((b) => b.addEventListener('click', () => {
            panel.querySelectorAll('.djmixz-mood').forEach((x) => x.classList.remove('active'));
            b.classList.add('active'); this.mood = b.dataset.mood;
        }));
        const artistSel = panel.querySelector('#djmixz-artist');
        const fillArtists = () => {
            const names = [...new Set((this.dj.library?.zaoTracks || []).filter((t) => t.source === 'songchainn').map((t) => t.artist))].sort((a, b) => a.localeCompare(b));
            artistSel.innerHTML = names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}">${n.replace(/</g, '&lt;')}</option>`).join('');
            this.scArtist = artistSel.value || '';
        };
        panel.querySelector('#djmixz-source').addEventListener('change', (e) => { const one = e.target.value === 'songchainn-artist'; artistSel.hidden = !one; if (one) fillArtists(); });
        artistSel.addEventListener('change', () => { this.scArtist = artistSel.value; });
        panel.querySelector('#djmixz-sc').addEventListener('click', async () => {
            panel.querySelector('#djmixz-source').value = 'songchainn'; artistSel.hidden = true;
            readB2b(panel.querySelector('#djmixz-b2b').value);
            if (await this.mixSongChainn(this.mood, Number(panel.querySelector('#djmixz-length').value))) { panel.querySelector('#djmixz-stop').hidden = false; panel.querySelector('#djmixz-start').disabled = false; }
        });
        panel.querySelector('#djmixz-build').addEventListener('click', () => {
            const plan = this.build(panel.querySelector('#djmixz-source').value, this.mood, Number(panel.querySelector('#djmixz-length').value));
            panel.querySelector('#djmixz-start').disabled = plan.length < 2;
            this._say(plan.length < 2 ? 'That playlist has fewer than two playable tracks. Open a fuller tab in the library and build again.' : `Set built: ${plan.length} tracks. Read it through, then press START.`);
        });
        const readB2b = (v) => { this.battle = String(v).startsWith('b'); this.b2b = Number(String(v).replace('b', '')) || 0; };
        panel.querySelector('#djmixz-b2b').addEventListener('change', (e) => { readB2b(e.target.value); this._renderBar(); });
        panel.querySelector('#djmixz-start').addEventListener('click', () => { readB2b(panel.querySelector('#djmixz-b2b').value); if (this.start()) { panel.querySelector('#djmixz-stop').hidden = false; } });
        panel.querySelector('#djmixz-stop').addEventListener('click', () => { this.stop(); this.dj.flowMode?.disable(); panel.querySelector('#djmixz-stop').hidden = true; this._say('Stopped. The decks are yours.'); });
    }

    _say(text) { const el = typeof document !== 'undefined' && document.getElementById('djmixz-say'); if (el) el.textContent = text; }

    _renderPlan() {
        const el = typeof document !== 'undefined' && document.getElementById('djmixz-plan');
        if (!el) return;
        const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        el.innerHTML = this.plan.map((p, i) => {
            const state = this.running && i === this.index ? ' now' : this.running && i < this.index ? ' done' : '';
            const move = p.move ? `<div class="djmixz-move"><b>${p.move.type.replace('-', ' ')}</b>, ${p.move.bars} ${p.move.bars === 1 ? 'bar' : 'bars'}. ${esc(p.move.why)}.</div>` : '<div class="djmixz-move"><b>opens the set</b></div>';
            return `<li class="djmixz-row${state}">${move}<div class="djmixz-track"><span class="djmixz-energy" style="--e:${Math.round(p.energy * 100)}%"></span><span class="djmixz-name">${esc(p.track.title)}</span><span class="djmixz-meta">${esc(p.track.artist)}${p.track.bpm ? ' · ' + Math.round(p.track.bpm) + ' BPM' : ''}</span></div></li>`;
        }).join('');
    }
}
