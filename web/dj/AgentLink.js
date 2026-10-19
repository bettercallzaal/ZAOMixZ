// AgentLink.js — who an outside agent is, decided by the desk (agent gateway, gate 1).
//
// docs/STREAM-EVENTS.md, Phase 5. An agent never gets the phone link: that token is also the
// key to the whole phone channel, and anyone holding it may ask to run the decks. Each agent
// gets a key of its own instead, on a channel of its own, made at the desk. The desk knows
// which agent a message is from by the channel it arrived on, and stamps every proposal with
// that agent's name and from: 'agent'. Whatever an agent writes about itself is dropped.
//
// What an agent may do in gate 1: say hello, ping, and receive the stream events the desk
// publishes (StreamEvents.OUT_TYPES, while ON AIR). Nothing it sends reaches the decks, the
// request line or the stream. Later gates add the approval queue with receipts, the AI label,
// moderation with a rate limit, and agent.recommendation, each behind its own PR.
//
// Gate 2, MUTE ALL AGENTS: one control on the desk, shown whenever an agent is connected or
// the agents are muted, and on the DJ's phone. Muted, every pending agent proposal is dropped,
// new ones are refused and no events go to agents, until the DJ unmutes. It stays muted
// across a reload.
//
// Gate 6, agent.recommendation (AgentPick.js): an agent granted 'next' may ask for the songs
// left in the running DJ MixZ set ('tracks') and pick one ('recommend'). The pick shows in the
// DJ MixZ bar under the agent's name and plays next only when the DJ taps it.
//
// Gate 7, no credentials (AgentSecrets.js): every message for an agent leaves through one
// place, AgentHost._send, and one that holds a secret the desk keeps (the phone link's token,
// an agent's key, the Spotify or Twitch tokens, the YouTube key) or anything shaped like a
// credential is held back, with a refusal line, instead of sent.
//
// Nothing in the app makes an agent yet: no outside agent connects until every gate exists
// and Zaal says yes. The top half is pure and runs under node: see AgentLink.test.mjs.

import { newToken, validToken, Relay } from './RemoteLink.js';
import { OUT_TYPES } from './StreamEvents.js';
import { ApprovalQueue, PROPOSAL_KINDS, queueHtml } from './AgentQueue.js';
import { agentPostData } from './AgentPost.js';
import { CHAT_BLOCK_KEY } from './Settings.js';
import { PickBoard, PICK_KIND, pickList, pickId } from './AgentPick.js';
import { leak, storedSecrets } from './AgentSecrets.js';

export const AGENT_KEY_PREFIX = 'mza1.';
export const AGENTS_KEY = 'mixz-agents';
export const MAX_AGENTS = 8;
export const MUTED_KEY = 'mixz-agents-muted';
export const TRACKS_RATE_MS = 5000;   // one set list per agent this often
// What an agent may send. Anything else is dropped. 'propose' (gate 3) is a draft for the
// DJ's approval queue (AgentQueue.js), and only of a kind the DJ granted that agent.
// 'tracks' and 'recommend' (gate 6) need the 'next' grant: the set's songs, and a pick of one.
export const AGENT_IN = new Set(['hello', 'ping', 'propose', 'tracks', 'recommend']);
// Every permission the DJ can grant an agent. All start off.
export const GRANT_KINDS = [...PROPOSAL_KINDS, PICK_KIND];

// A name the desk shows: letters, digits, spaces and - _ . only, 1 to 24 characters.
export function agentName(raw) {
    const n = String(raw ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return n || 'Agent';
}

// The one string an agent is given. It holds its own token, never the phone link's.
export const agentKey = (token) => `${AGENT_KEY_PREFIX}${token}`;
export const tokenFromKey = (key) => {
    const t = String(key || '').startsWith(AGENT_KEY_PREFIX) ? String(key).slice(AGENT_KEY_PREFIX.length) : '';
    return validToken(t) ? t : null;
};

export function newAgent(name, { token = newToken(), id = newToken().slice(0, 12), now = Date.now() } = {}) {
    return { id, name: agentName(name), token, created: now, perms: {} };
}

// Only known kinds, true or false. Anything else in a saved list is dropped.
export const cleanPerms = (p) => Object.fromEntries(GRANT_KINDS.filter((k) => p && p[k] === true).map((k) => [k, true]));

// A message from an agent, cleaned: only the kinds it may send, with nothing it says about
// who it is. Null drops it.
export function cleanAgentMessage(raw) {
    if (!raw || typeof raw !== 'object' || !AGENT_IN.has(raw.t)) return null;
    if (raw.t === 'ping') return { t: 'ping', n: Number.isInteger(raw.n) ? raw.n : 0 };
    if (raw.t === 'propose') return { t: 'propose', kind: typeof raw.kind === 'string' ? raw.kind : '', text: typeof raw.text === 'string' ? raw.text : '' };
    if (raw.t === 'recommend') return { t: 'recommend', track: typeof raw.track === 'string' ? raw.track : '', why: typeof raw.why === 'string' ? raw.why : '' };
    if (raw.t === 'tracks') return { t: 'tracks' };
    return { t: 'hello' };
}

// The desk's word on who sent something. Any from, agent, role, device or name the sender
// put in is replaced, so an agent cannot pass for a phone, a chat user or another agent.
export function stampAgent(agent, data = {}) {
    const { from, agent: _a, role, device, name, ...rest } = data || {};
    return { ...rest, from: 'agent', agent: agent.name, agentId: agent.id };
}

// What the desk lends an agent host for picks: the songs left in the running DJ MixZ set after
// the next one, and the same SWAP a person makes (refused during a handover).
export function deskDirector(dj) {
    return {
        pickable: () => { const m = dj?.djMixz; return m?.running && !m.human ? m.plan.slice(m.index + 2).map((p) => p.track) : []; },
        swap: (track) => !!dj?.djMixz?.swapNext?.(track),
        refresh: () => dj?.djMixz?._renderBar?.(),
    };
}

// Only the published stream events go to agents.
export const forAgents = (env) => !!env && env.v === 1 && OUT_TYPES.includes(env.type);

// ───────── The desk side ─────────

export class AgentHost {
    // RelayClass and storage are injectable for tests.
    // publish(type, data): where an approved draft goes out, as a stream event (StreamEvents.emit).
    // director: where picks come from and go (deskDirector). Without one, no set is running.
    // secrets: () => the secrets the desk holds only in memory (AgentSecrets.deskSecrets).
    constructor({ RelayClass = Relay, storage = globalThis.localStorage, session = globalThis.sessionStorage, onChange = null, publish = null, now = () => Date.now(), director = null, secrets = null } = {}) {
        Object.assign(this, { RelayClass, storage, session, onChange, publish, now, director, secrets });
        this.agents = this._load();
        this.links = new Map();   // agent id -> { relay, seen }
        this.queue = new ApprovalQueue({ storage, now });   // drafts waiting for the DJ, and the receipts
        this.picks = new PickBoard(this.queue, { now });    // next-track picks waiting for a tap (gate 6)
        try { this.muted = this.storage?.getItem(MUTED_KEY) === 'on'; } catch (e) { this.muted = false; }
    }

    get pending() { return this.queue.pending; }

    // The DJ's words never shown from chat (Settings) hold agent drafts back too.
    _blocked() { try { return String(this.storage?.getItem(CHAT_BLOCK_KEY) || '').split('\n').map((w) => w.trim()).filter(Boolean); } catch (e) { return []; } }

    connectedCount(now = Date.now()) { return this.agents.filter((a) => this.connected(a.id, now)).length; }

    // MUTE ALL AGENTS. Muting drops everything pending and tells every agent.
    setMuted(on) {
        this.muted = !!on;
        try { this.storage?.setItem(MUTED_KEY, this.muted ? 'on' : 'off'); } catch (e) { /* no storage */ }
        if (this.muted) { this.queue.dropAll('muted'); this.picks.dropAll('muted'); this.director?.refresh?.(); }
        const keep = this._secretsNow();
        for (const id of this.links.keys()) this._send(id, { t: 'muted', on: this.muted }, keep);
        this.onChange?.();
    }

    // Where a proposal enters (gate 3 builds on this). Null while muted: refused.
    accept(item) {
        if (this.muted) return null;
        this.queue.pending.push(item);
        return item;
    }

    _load() {
        try {
            const list = JSON.parse(this.storage?.getItem(AGENTS_KEY) || '[]');
            return Array.isArray(list) ? list.filter((a) => a && validToken(a.token) && typeof a.id === 'string').map((a) => ({ ...a, name: agentName(a.name), perms: cleanPerms(a.perms) })) : [];
        } catch (e) {
            return [];
        }
    }
    _save() { try { this.storage?.setItem(AGENTS_KEY, JSON.stringify(this.agents)); } catch (e) { /* no storage */ } }

    list() { return this.agents.map(({ id, name, created, perms }) => ({ id, name, created, perms: { ...perms }, connected: this.connected(id) })); }

    // Lets one agent propose one kind of draft, or stops it. Every kind starts off.
    grant(id, kind, on) {
        const a = this.agents.find((x) => x.id === id);
        if (!a || !GRANT_KINDS.includes(kind)) return false;
        a.perms = { ...a.perms, [kind]: !!on };
        this._save();
        this.onChange?.();
        return true;
    }
    connected(id, now = Date.now()) { const l = this.links.get(id); return !!l && now - l.seen < 15000; }

    // A new agent and the key to hand it. Null when the desk already has the most it takes.
    add(name) {
        if (this.agents.length >= MAX_AGENTS) return null;
        const agent = newAgent(name);
        this.agents.push(agent);
        this._save();
        return { agent: { id: agent.id, name: agent.name }, key: agentKey(agent.token) };
    }

    // Disconnects one agent and forgets its key for good.
    remove(id) {
        this.links.get(id)?.relay.close();
        this.links.delete(id);
        this.queue.dropAll('agent removed', id);
        this.picks.dropAll('agent removed', id);
        this.director?.refresh?.();
        this.agents = this.agents.filter((a) => a.id !== id);
        this._save();
        this.onChange?.();
    }

    async start() {
        // The MUTE ALL AGENTS button follows who is connected
        if (!this._muteTimer && typeof setInterval !== 'undefined' && globalThis.document) this._muteTimer = setInterval(() => { this.queue.expire(); if (this.picks.expire().length + this.closeStalePicks().length) this.director?.refresh?.(); this.renderMute(); }, 1000);
        for (const agent of this.agents) {
            if (this.links.has(agent.id)) continue;
            const relay = new this.RelayClass({ token: agent.token, role: 'host', onMessage: (msg) => this._onMessage(agent, msg) });
            this.links.set(agent.id, { relay, seen: 0, hello: false });
            try { await relay.open(); } catch (e) { /* tries again on the next start */ }
        }
    }

    stop() {
        for (const l of this.links.values()) { try { l.relay.close(); } catch (e) { /* gone */ } }
        this.links.clear();
    }

    // Who sent it is the channel it came in on; the message itself is only read for its kind.
    _onMessage(agent, raw) {
        const link = this.links.get(agent.id);
        if (!link || !this.agents.some((a) => a.id === agent.id)) return;
        const msg = cleanAgentMessage(raw);
        if (!msg) return;
        link.seen = Date.now();
        if (msg.t === 'propose') {
            // Every draft leaves a receipt, a refused one too (muted, not granted, too many)
            const r = this.queue.propose(agent, msg, { muted: this.muted, blocked: this._blocked() });
            this._send(agent.id, { t: 'proposal', status: r.ok ? 'waiting' : 'refused', reason: r.reason || null, pid: r.item?.pid || null });
            this.onChange?.();
            return;
        }
        if (msg.t === 'recommend') {
            const r = this.picks.recommend(agent, msg, { muted: this.muted, blocked: this._blocked(), pickable: this._pickable() });
            this._send(agent.id, { t: 'pick', status: r.ok ? 'waiting' : 'refused', reason: r.reason || null, pid: r.item?.pid || null });
            if (r.ok) this.director?.refresh?.();
            this.onChange?.();
            return;
        }
        if (this.muted) { this._send(agent.id, { t: 'muted', on: true }); this.onChange?.(); return; }
        if (msg.t === 'tracks') {
            const fresh = this.agents.find((a) => a.id === agent.id);
            if (!fresh?.perms?.[PICK_KIND]) { this._send(agent.id, { t: 'tracks', list: [], reason: 'not granted' }); return; }
            const now = this.now();
            if (link.lastTracks != null && now - link.lastTracks < TRACKS_RATE_MS) { this._send(agent.id, { t: 'tracks', list: [], reason: 'too fast' }); return; }
            link.lastTracks = now;
            this._send(agent.id, { t: 'tracks', list: pickList(this._pickable()) });
            return;
        }
        if (msg.t === 'hello') { link.hello = true; this._send(agent.id, { t: 'welcome', role: 'agent', name: agent.name }); this.onChange?.(); }
        else if (msg.t === 'ping') this._send(agent.id, { t: 'pong', n: msg.n });
    }

    // Every secret the desk holds right now: what the browser keeps, every agent's own token,
    // and what the desk holds in memory. Null when the in-memory list cannot be read.
    _secretsNow() {
        let extra;
        try { extra = this.secrets ? this.secrets() : []; } catch (e) { return null; }
        return [...storedSecrets(this.storage, this.session), ...this.agents.map((a) => a.token), ...(Array.isArray(extra) ? extra : [])];
    }

    // The one way out to an agent (gate 7). A message that holds a secret, or anything shaped
    // like a credential, is held back and counted as a refusal; so is everything while the
    // secrets cannot be read. The refusal says why, never what the secret was.
    _send(id, msg, secrets = this._secretsNow()) {
        const l = this.links.get(id);
        if (!l) return false;
        const why = secrets ? leak(msg, secrets) : 'secrets unreadable';
        if (why) {
            const a = this.agents.find((x) => x.id === id);
            this.queue._refusal({ agentId: id, agent: a?.name || 'Agent' }, 'outbound', `held: ${why}`);
            return false;
        }
        l.relay.send(msg);
        return true;
    }

    _pickable() { try { return this.director?.pickable?.() || []; } catch (e) { return []; } }

    // The DJ tapped an agent's pick: it plays next if the swap goes through (not during a
    // handover, not while muted). The pick stays up when the swap is refused.
    playPick(pid) {
        const p = this.picks.find(pid);
        if (!p || this.muted) return false;
        // A pick waits up to ten minutes: the song may have played, or the set moved on, since
        if (!this._inSet(p)) { this.picks.close(pid, 'not in the set'); this.director?.refresh?.(); this.onChange?.(); return false; }
        if (!this.director?.swap?.(p.track)) return false;
        this.picks.taken(pid);
        this.onChange?.();
        return true;
    }

    _inSet(p, pickable = this._pickable()) { return pickable.some((t) => pickId(t) === p.id); }

    // The picks the bar shows: only ones still waiting in the set.
    shownPicks() { const pickable = this._pickable(); return this.picks.shown().filter((p) => this._inSet(p, pickable)); }

    // Picks whose song is no longer waiting in the set (played, locked in next, or the set
    // stopped) close with a receipt instead of lingering.
    closeStalePicks() { const pickable = this._pickable(); return this.picks.picks.filter((p) => !this._inSet(p, pickable)).map((p) => this.picks.close(p.pid, 'not in the set')); }

    dismissPick(pid) { const r = this.picks.dismiss(pid); if (r) this.onChange?.(); return !!r; }

    // A stream event for every connected agent (StreamEvents.emit, only while ON AIR).
    sendEvent(env) {
        if (this.muted || !forAgents(env)) return;
        // Only to an agent that said hello on this connection, not one that only pings
        const keep = this._secretsNow();
        for (const [id, l] of this.links) if (l.hello && this.connected(id)) this._send(id, { t: 'ev', ev: env }, keep);
    }

    // The desk's MUTE ALL AGENTS button: always there while an agent is connected or the agents
    // are muted, so the DJ never has to look for it.
    renderMute(doc = globalThis.document) {
        const btn = doc?.getElementById?.('agents-mute');
        if (!btn) return;
        const n = this.connectedCount();
        btn.style.display = n || this.muted ? '' : 'none';
        btn.textContent = this.muted ? 'AGENTS MUTED: UNMUTE' : `MUTE ALL AGENTS (${n})`;
        btn.classList?.toggle?.('muted', this.muted);
        if (!btn.dataset.wired) { btn.dataset.wired = '1'; btn.addEventListener('click', () => { this.setMuted(!this.muted); this.renderMute(doc); }); }
        this.renderQueue(doc);
    }

    // The DJ's decision on a draft. An approval goes out as agent.post (gate 4): the overlay
    // shows it under its own AI label. Nothing goes out while the agents are muted.
    decide(pid, approve, opts = {}) {
        const r = this.queue.decide(pid, approve, opts);
        const post = agentPostData(r);
        if (post && !this.muted) this.publish?.('agent.post', post);
        return r;
    }

    // The AGENT DRAFTS button and panel: shown with the mute button, or while drafts wait.
    renderQueue(doc = globalThis.document) {
        const btn = doc?.getElementById?.('agents-queue');
        const panel = doc?.getElementById?.('agents-panel');
        if (!btn || !panel) return;
        const n = this.queue.pending.length;
        btn.style.display = n || this.connectedCount() || this.muted ? '' : 'none';
        btn.textContent = `AGENT DRAFTS (${n})`;
        const sig = `${n}|${this.queue.receipts.length}|${this.queue.refusals.reduce((t, r) => t + r.count, 0)}|${this.queue.pending.map((x) => x.pid).join()}`;
        if (panel.dataset.sig !== sig && !panel.contains?.(doc.activeElement)) { panel.dataset.sig = sig; panel.innerHTML = queueHtml(this.queue.pending, this.queue.receipts, Date.now(), this.queue.refusals); }
        if (!btn.dataset.wired) {
            btn.dataset.wired = '1';
            btn.addEventListener('click', () => panel.classList.toggle('hidden'));
            panel.addEventListener('click', (e) => {
                const a = e.target?.dataset?.approve, d = e.target?.dataset?.decline;
                if (a) { const text = e.target.closest('li')?.querySelector('textarea')?.value; this.decide(a, true, { text }); }
                else if (d) this.decide(d, false);
                else if (e.target?.id === 'agents-receipts-save') this._saveReceipts(doc);
                else return;
                panel.dataset.sig = '';
                this.renderQueue(doc);
            });
        }
    }

    _saveReceipts(doc) {
        try {
            const url = URL.createObjectURL(new Blob([this.queue.exportText()], { type: 'application/json' }));
            const a = doc.createElement('a');
            a.href = url; a.download = `agent-receipts-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) { console.warn('[AgentLink] could not save receipts:', e); }
    }
}
