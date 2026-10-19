// AgentPick.js — an agent's next-track pick as a Flow Director pick (agent gateway, gate 6).
//
// docs/STREAM-EVENTS.md, agent.recommendation: a pick appears among the Flow Director's picks,
// labelled with the agent's name, and nothing plays until a person taps it. An agent may pick
// only a song left in the running DJ MixZ set (it asks the desk for that list), so a pick never
// brings in a file or a link. Tapping it is the same SWAP a person makes, refused during a
// handover. The DJ grants the 'next' permission per agent; it starts off.
//
// Limits: one pick per agent at a time (a newer one replaces it), one try every PICK_RATE_MS
// (every try counts), the reason through the stream-chat filter, and a pick not taken in
// EXPIRE_MS expires. Every pick and outcome goes into the same receipts as drafts.
//
// Pure apart from the queue it writes receipts to: see AgentPick.test.mjs.

import { moderate } from './ChatFilter.js';
import { EXPIRE_MS } from './AgentQueue.js';

export const PICK_KIND = 'next';
export const PICK_RATE_MS = 30000;
export const WHY_MAX = 140;
export const PICKS_SHOWN = 3;      // picks shown in the bar at once, newest first
export const LIST_MAX = 100;       // songs sent in answer to 'tracks'

// The same id the Flow Director uses for a song (FlowDirector.js, DjMixz.js).
export const pickId = (t) => String(t.id ?? t.sourceId ?? `${t.title}|${t.artist}`);

// The songs an agent may pick from, as plain fields: never a file path or a stream URL.
export function pickList(tracks = []) {
    const s = (v, n) => String(v ?? '').slice(0, n);
    return tracks.slice(0, LIST_MAX).map((t) => ({ id: pickId(t), title: s(t.title, 120), artist: s(t.artist, 80), bpm: Number(t.bpm) || null, key: s(t.key, 8) || null }));
}

export class PickBoard {
    // queue: the ApprovalQueue whose receipts and refusals these share.
    constructor(queue, { now = () => Date.now() } = {}) {
        Object.assign(this, { queue, now });
        this.picks = [];              // { pid, agentId, agent, kind, id, track, title, text, at }
        this._lastTry = new Map();    // agent id -> when it last sent a pick
        this._n = 0;
    }

    shown() { return this.picks.slice(-PICKS_SHOWN).reverse(); }

    // A pick from `agent` ({ id, name, perms }). `pickable`: the songs left in the set.
    // { ok: true, item } or { ok: false, reason }. Every call leaves a receipt or a refusal.
    recommend(agent, raw, { muted = false, blocked = [], pickable = [] } = {}) {
        const who = { agentId: agent.id, agent: agent.name };
        const refuse = (reason) => { this.queue._refusal(who, PICK_KIND, reason); return { ok: false, reason }; };
        const id = typeof raw?.track === 'string' ? raw.track.slice(0, 200) : '';
        if (!id) return refuse('not a pick');
        if (muted) return refuse('muted');
        if (!agent.perms?.[PICK_KIND]) return refuse('not granted');
        const last = this._lastTry.get(agent.id);
        this._lastTry.set(agent.id, this.now());
        if (last != null && this.now() - last < PICK_RATE_MS) return refuse('too fast');
        if (!pickable.length) return refuse('no set running');
        const track = pickable.find((t) => pickId(t) === id);
        if (!track) return refuse('not in the set');
        let why = typeof raw.why === 'string' ? raw.why.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
        if (why) {
            const mod = moderate(why, { blocked });
            if (!mod.ok && mod.reason !== 'empty') return refuse(mod.reason === 'link' ? 'link' : mod.reason === 'blocked word' ? 'blocked word' : 'not a pick');
            why = mod.ok ? mod.text : '';
        }
        why = why.slice(0, WHY_MAX);
        for (const old of this.picks.filter((p) => p.agentId === agent.id)) this._close(old, 'replaced');
        const title = String(track.title || id).slice(0, 120);
        const item = { pid: `${agent.id}-p${this.now().toString(36)}-${(this._n++).toString(36)}`, ...who, kind: PICK_KIND, id, track, title, text: why ? `${title}: ${why}` : title, why, at: this.now() };
        this.picks.push(item);
        this.queue._receipt(item, 'waiting');
        return { ok: true, item };
    }

    _close(item, outcome, extra = {}) {
        this.picks = this.picks.filter((p) => p !== item);
        return this.queue._receipt(item, outcome, extra);
    }

    find(pid) { return this.picks.find((p) => p.pid === pid) || null; }

    // The DJ tapped it and the swap went through.
    taken(pid) { const p = this.find(pid); return p ? this._close(p, 'played next') : null; }
    dismiss(pid) { const p = this.find(pid); return p ? this._close(p, 'dismissed') : null; }

    expire() { const now = this.now(); return this.picks.filter((p) => now - p.at >= EXPIRE_MS).map((p) => this._close(p, 'expired')); }

    // MUTE ALL AGENTS, or one agent cut off.
    dropAll(reason, agentId = null) { return this.picks.filter((p) => !agentId || p.agentId === agentId).map((p) => this._close(p, 'dropped', { reason })); }
}
