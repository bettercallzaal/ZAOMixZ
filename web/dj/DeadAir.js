// DeadAir.js — auto play when the room goes quiet
//
// A stream must never sit silent. With AUTO PLAY on, the desk listens to its own master
// output; after five seconds of silence it acts: if a person took the decks from DJ MixZ it
// hands them back, if DJ MixZ is mixing and still nothing plays it skips to the next track,
// and if DJ MixZ is off it starts a set from SongChainn. It never fires while a track is
// loading, while the audio engine is asleep, or more than once every fifteen seconds.
//
// decide() is pure and runs under node: see DeadAir.test.mjs.

import { every } from './Clock.js';

export const SILENT_RMS = 0.0035;      // below this the master is as good as silent
export const SILENT_FOR_MS = 5000;     // Zaal: "if silent for over 5 seconds"
export const COOLDOWN_MS = 15000;      // after acting, give the fix time to make sound

export function decide({ on, silentMs, running, human, loading, awake = true, sinceAct = Infinity }) {
    if (!on || !awake || loading) return 'none';
    if (silentMs < SILENT_FOR_MS) return 'none';
    if (sinceAct < COOLDOWN_MS) return 'none';
    if (running && human) return 'handback';
    if (running) return 'skip';
    return 'start';
}

const KEY = 'mixz-deadair';

export class DeadAir {
    constructor(dj) {
        this.dj = dj;
        this.on = false;
        try { this.on = localStorage.getItem(KEY) === 'on'; } catch (e) { /* no storage */ }
        this.silentSince = 0;
        this.lastAct = 0;
        this.rms = 0;
        this._buf = null;
        this._buildUI();
        // Clock.every, so it still listens while the DJ is in another tab
        every(500, () => this._tick());
    }

    set(on) {
        this.on = !!on;
        try { localStorage.setItem(KEY, this.on ? 'on' : 'off'); } catch (e) { /* no storage */ }
        this.silentSince = 0;
        this._paint();
    }

    _level() {
        const an = this.dj.audioRouter?.masterAnalyser;
        if (!an) return 0;
        if (!this._buf || this._buf.length !== an.fftSize) this._buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(this._buf);
        let s = 0;
        for (const v of this._buf) s += v * v;
        return Math.sqrt(s / this._buf.length);
    }

    _tick() {
        const now = Date.now();
        this.rms = this._level();
        if (this.rms > SILENT_RMS) { this.silentSince = 0; return; }
        if (!this.silentSince) this.silentSince = now;
        const m = this.dj.djMixz || {};
        const what = decide({
            on: this.on, silentMs: now - this.silentSince, running: !!m.running, human: !!m.human,
            loading: !!this.dj.flowMode?._transitioning, awake: this.dj.audioRouter?.ctx?.state === 'running', sinceAct: now - this.lastAct,
        });
        if (what === 'none') return;
        this.lastAct = now;
        this.silentSince = 0;
        if (what === 'handback') { m.handBack?.(); this._say('Quiet for 5 seconds: DJ MixZ took the decks back.'); }
        else if (what === 'skip') { this.dj.flowMode?.skip?.(); this._say('Quiet for 5 seconds: DJ MixZ moved to the next track.'); }
        else { m.startFrom?.(m._lastBuild?.sourceId || 'songchainn', m._lastBuild?.moodId || m.mood || 'journey', m._lastBuild?.minutes ?? 60, true); this._say('Quiet for 5 seconds: DJ MixZ started a set.'); }
    }

    _say(text) { const el = document.getElementById('djmixz-say'); if (el) el.textContent = text; console.log('[DeadAir]', text); }

    _buildUI() {
        const panel = document.getElementById('djmixz-panel');
        if (!panel || document.getElementById('deadair-toggle')) return;
        const hint = panel.querySelector('.djmixz-quick-hint');
        const row = document.createElement('button');
        row.id = 'deadair-toggle';
        row.className = 'deadair-toggle';
        row.type = 'button';
        row.innerHTML = '<span>Auto play if silent for 5 seconds</span><b></b>';
        row.title = 'Nothing coming out of the master for five seconds and DJ MixZ jumps in';
        row.addEventListener('click', () => this.set(!this.on));
        (hint || panel.firstChild).insertAdjacentElement(hint ? 'afterend' : 'afterbegin', row);
        this._paint();
    }

    _paint() {
        const row = document.getElementById('deadair-toggle');
        if (!row) return;
        row.classList.toggle('on', this.on);
        row.querySelector('b').textContent = this.on ? 'ON' : 'OFF';
    }
}
