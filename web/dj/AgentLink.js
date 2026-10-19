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
// Nothing in the app makes an agent yet: no outside agent connects until every gate exists
// and Zaal says yes. The top half is pure and runs under node: see AgentLink.test.mjs.

import { newToken, validToken, Relay } from './RemoteLink.js';
import { OUT_TYPES } from './StreamEvents.js';

export const AGENT_KEY_PREFIX = 'mza1.';
export const AGENTS_KEY = 'mixz-agents';
export const MAX_AGENTS = 8;
export const MUTED_KEY = 'mixz-agents-muted';
// What an agent may send in gate 1. Anything else is dropped.
export const AGENT_IN = new Set(['hello', 'ping']);

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
    return { id, name: agentName(name), token, created: now };
}

// A message from an agent, cleaned: only the kinds it may send, with nothing it says about
// who it is. Null drops it.
export function cleanAgentMessage(raw) {
    if (!raw || typeof raw !== 'object' || !AGENT_IN.has(raw.t)) return null;
    if (raw.t === 'ping') return { t: 'ping', n: Number.isInteger(raw.n) ? raw.n : 0 };
    return { t: 'hello' };
}

// The desk's word on who sent something. Any from, agent, role, device or name the sender
// put in is replaced, so an agent cannot pass for a phone, a chat user or another agent.
export function stampAgent(agent, data = {}) {
    const { from, agent: _a, role, device, name, ...rest } = data || {};
    return { ...rest, from: 'agent', agent: agent.name, agentId: agent.id };
}

// Only the published stream events go to agents.
export const forAgents = (env) => !!env && env.v === 1 && OUT_TYPES.includes(env.type);

// ───────── The desk side ─────────

export class AgentHost {
    // RelayClass and storage are injectable for tests.
    constructor({ RelayClass = Relay, storage = globalThis.localStorage, onChange = null } = {}) {
        Object.assign(this, { RelayClass, storage, onChange });
        this.agents = this._load();
        this.links = new Map();   // agent id -> { relay, seen }
        this.pending = [];        // agent proposals waiting for the DJ (the approval queue, gate 3)
        try { this.muted = this.storage?.getItem(MUTED_KEY) === 'on'; } catch (e) { this.muted = false; }
    }

    connectedCount(now = Date.now()) { return this.agents.filter((a) => this.connected(a.id, now)).length; }

    // MUTE ALL AGENTS. Muting drops everything pending and tells every agent.
    setMuted(on) {
        this.muted = !!on;
        try { this.storage?.setItem(MUTED_KEY, this.muted ? 'on' : 'off'); } catch (e) { /* no storage */ }
        if (this.muted) this.pending = [];
        for (const l of this.links.values()) l.relay.send({ t: 'muted', on: this.muted });
        this.onChange?.();
    }

    // Where a proposal enters (gate 3 builds on this). Null while muted: refused.
    accept(item) {
        if (this.muted) return null;
        this.pending.push(item);
        return item;
    }

    _load() {
        try {
            const list = JSON.parse(this.storage?.getItem(AGENTS_KEY) || '[]');
            return Array.isArray(list) ? list.filter((a) => a && validToken(a.token) && typeof a.id === 'string').map((a) => ({ ...a, name: agentName(a.name) })) : [];
        } catch (e) {
            return [];
        }
    }
    _save() { try { this.storage?.setItem(AGENTS_KEY, JSON.stringify(this.agents)); } catch (e) { /* no storage */ } }

    list() { return this.agents.map(({ id, name, created }) => ({ id, name, created, connected: this.connected(id) })); }
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
        this.agents = this.agents.filter((a) => a.id !== id);
        this._save();
        this.onChange?.();
    }

    async start() {
        // The MUTE ALL AGENTS button follows who is connected
        if (!this._muteTimer && typeof setInterval !== 'undefined' && globalThis.document) this._muteTimer = setInterval(() => this.renderMute(), 1000);
        for (const agent of this.agents) {
            if (this.links.has(agent.id)) continue;
            const relay = new this.RelayClass({ token: agent.token, role: 'host', onMessage: (msg) => this._onMessage(agent, msg) });
            this.links.set(agent.id, { relay, seen: 0 });
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
        if (this.muted) { link.relay.send({ t: 'muted', on: true }); this.onChange?.(); return; }
        if (msg.t === 'hello') { link.relay.send({ t: 'welcome', role: 'agent', name: agent.name }); this.onChange?.(); }
        else if (msg.t === 'ping') link.relay.send({ t: 'pong', n: msg.n });
    }

    // A stream event for every connected agent (StreamEvents.emit, only while ON AIR).
    sendEvent(env) {
        if (this.muted || !forAgents(env)) return;
        for (const [id, l] of this.links) if (this.connected(id)) l.relay.send({ t: 'ev', ev: env });
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
    }
}
