// AgentQueue.js — the approval queue and receipts (agent gateway, gate 3).
//
// docs/STREAM-EVENTS.md, Phase 5: agents propose, the host publishes. A comment or an audience
// question from an agent arrives here as a draft. Nothing in it reaches the stream, chat or the
// decks by itself: the DJ approves (as written or edited) or declines it, and anything not
// decided in ten minutes expires. Each agent may propose a kind only if the DJ granted it; every
// kind is off for every agent until then.
//
// Receipts: every proposal and every decision is logged with the agent, the time and the
// outcome, so a show can be replayed and audited. They stay in this browser and can be saved
// as a file. Refusals are kept apart, one line per agent and reason with a count, so an agent
// sending junk cannot push the DJ's decisions out of the log. Where an approved item goes (chat, the stream) is a later gate:
// today approving only records it.
//
// Gate 5: a granted agent may send one draft every RATE_MS, and every draft goes through the
// same filter as stream chat (ChatFilter.moderate): no links, none of the DJ's blocked words.
//
// Pure apart from storage, which is injected: see AgentQueue.test.mjs.

import { esc } from './Html.js';
import { moderate } from './ChatFilter.js';

export const PROPOSAL_KINDS = ['comment', 'question'];
export const PROPOSAL_MAX = 280;            // characters of one draft
export const EXPIRE_MS = 10 * 60 * 1000;    // undecided this long: expired
export const PENDING_PER_AGENT = 3;         // drafts one agent may have waiting at once
export const PENDING_MAX = 20;
export const RATE_MS = 20000;               // one draft per agent this often (gate 5)
export const RECEIPTS_KEY = 'mixz-agent-receipts';
export const RECEIPTS_MAX = 1000;           // decisions and drafts
export const REFUSALS_KEY = 'mixz-agent-refusals';
export const REFUSALS_MAX = 200;            // lines of refusals, each counting its repeats

// A draft from an agent: { kind, text } or null. Plain text only, one line of whitespace.
export function cleanProposal(raw) {
    if (!raw || typeof raw !== 'object' || !PROPOSAL_KINDS.includes(raw.kind) || typeof raw.text !== 'string') return null;
    const text = raw.text.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PROPOSAL_MAX);
    return text ? { kind: raw.kind, text } : null;
}

export class ApprovalQueue {
    constructor({ storage = globalThis.localStorage, now = () => Date.now() } = {}) {
        Object.assign(this, { storage, now });
        this.pending = [];   // { pid, agentId, agent, kind, text, at }
        this.receipts = this._load(RECEIPTS_KEY, RECEIPTS_MAX);
        this.refusals = this._load(REFUSALS_KEY, REFUSALS_MAX);   // { agentId, agent, kind, reason, count, first, last }
        this._n = 0;
        this._lastTry = new Map();   // agent id -> when it last sent a granted draft
    }

    _load(key, max) { try { const r = JSON.parse(this.storage?.getItem(key) || '[]'); return Array.isArray(r) ? r.slice(-max) : []; } catch (e) { return []; } }
    _save() { try { this.storage?.setItem(RECEIPTS_KEY, JSON.stringify(this.receipts.slice(-RECEIPTS_MAX))); } catch (e) { /* no storage */ } }
    _saveRefusals() { try { this.storage?.setItem(REFUSALS_KEY, JSON.stringify(this.refusals.slice(-REFUSALS_MAX))); } catch (e) { /* no storage */ } }

    // A refusal: the same agent refused for the same reason again adds to one line's count.
    _refusal(who, kind, reason) {
        const now = this.now();
        let line = this.refusals.find((r) => r.agentId === who.agentId && r.reason === reason && r.kind === (kind || null));
        if (line) { line.count += 1; line.last = now; this.refusals = [...this.refusals.filter((r) => r !== line), line]; }
        else { line = { agentId: who.agentId, agent: who.agent, kind: kind || null, reason, count: 1, first: now, last: now }; this.refusals.push(line); }
        if (this.refusals.length > REFUSALS_MAX) this.refusals = this.refusals.slice(-REFUSALS_MAX);
        this._saveRefusals();
        return line;
    }

    _receipt(item, outcome, extra = {}) {
        const r = { at: this.now(), pid: item.pid || null, agentId: item.agentId, agent: item.agent, kind: item.kind || null, text: item.text || '', outcome, ...extra };
        this.receipts.push(r);
        if (this.receipts.length > RECEIPTS_MAX) this.receipts = this.receipts.slice(-RECEIPTS_MAX);
        this._save();
        return r;
    }

    // A draft from `agent` ({ id, name, perms }, as the desk knows it). Every call leaves a
    // receipt. { ok: true, item } or { ok: false, reason }.
    // `blocked`: the DJ's words never shown from chat (Settings).
    propose(agent, raw, { muted = false, blocked = [] } = {}) {
        const who = { agentId: agent.id, agent: agent.name };
        const p = cleanProposal(raw);
        const kind = PROPOSAL_KINDS.includes(raw?.kind) ? raw.kind : null;
        if (!p) { this._refusal(who, kind, 'not a draft'); return { ok: false, reason: 'not a draft' }; }
        const refuse = (reason) => { this._refusal(who, p.kind, reason); return { ok: false, reason }; };
        if (muted) return refuse('muted');
        if (!agent.perms?.[p.kind]) return refuse('not granted');
        // Rate: every try counts, so an agent that keeps sending stays held back
        const last = this._lastTry.get(agent.id);
        this._lastTry.set(agent.id, this.now());
        if (last != null && this.now() - last < RATE_MS) return refuse('too fast');
        const mod = moderate(p.text, { blocked });
        if (!mod.ok) return refuse(mod.reason === 'link' ? 'link' : mod.reason === 'blocked word' ? 'blocked word' : 'empty');
        p.text = mod.text;
        if (this.pending.filter((x) => x.agentId === agent.id).length >= PENDING_PER_AGENT) return refuse('too many waiting');
        if (this.pending.length >= PENDING_MAX) return refuse('queue full');
        const item = { pid: `${agent.id}-${this.now().toString(36)}-${(this._n++).toString(36)}`, ...who, ...p, at: this.now() };
        this.pending.push(item);
        this._receipt(item, 'waiting');
        return { ok: true, item };
    }

    // The DJ's decision. Approving with changed text is 'edited'. Null if it is not waiting, or
    // if the DJ emptied the text: an empty draft is not approved as the original.
    decide(pid, approve, { text = null } = {}) {
        const i = this.pending.findIndex((x) => x.pid === pid);
        if (i < 0) return null;
        const edited = approve && text != null ? cleanProposal({ kind: this.pending[i].kind, text }) : null;
        if (approve && text != null && !edited) return null;
        const [item] = this.pending.splice(i, 1);
        if (!approve) return this._receipt(item, 'declined');
        if (edited && edited.text !== item.text) return this._receipt(item, 'edited', { published: edited.text });
        return this._receipt(item, 'approved', { published: item.text });
    }

    // Drafts left undecided for EXPIRE_MS. Returns the receipts written.
    expire() {
        const now = this.now();
        const old = this.pending.filter((x) => now - x.at >= EXPIRE_MS);
        this.pending = this.pending.filter((x) => now - x.at < EXPIRE_MS);
        return old.map((x) => this._receipt(x, 'expired'));
    }

    // MUTE ALL AGENTS, or an agent cut off: everything waiting goes, each with a receipt.
    dropAll(reason, agentId = null) {
        const gone = this.pending.filter((x) => !agentId || x.agentId === agentId);
        this.pending = this.pending.filter((x) => agentId && x.agentId !== agentId);
        return gone.map((x) => this._receipt(x, 'dropped', { reason }));
    }

    // The receipts as a file, for replaying or auditing a show.
    exportText() { return JSON.stringify({ v: 1, exported: this.now(), receipts: this.receipts, refusals: this.refusals }, null, 2); }
}

// The DJ's queue panel. Everything an agent wrote is escaped.
export function queueHtml(pending, receipts, now = Date.now(), refusals = []) {
    const mins = (t) => Math.max(0, Math.round((now - t) / 60000));
    const waiting = pending.length
        ? pending.map((x) => `<li class="agent-draft" data-pid="${esc(x.pid)}">`
            + `<div class="agent-draft-head"><b>AI ${esc(x.kind === 'question' ? 'QUESTION' : 'COMMENT')}</b> from <b>${esc(x.agent)}</b> <small>${mins(x.at)} min ago</small></div>`
            + `<textarea class="agent-draft-text" maxlength="${PROPOSAL_MAX}" aria-label="Draft from ${esc(x.agent)}">${esc(x.text)}</textarea>`
            + `<div class="agent-draft-row"><button type="button" data-approve="${esc(x.pid)}">APPROVE</button><button type="button" data-decline="${esc(x.pid)}">DECLINE</button></div></li>`).join('')
        : '<li class="agent-empty">Nothing waiting.</li>';
    const log = receipts.slice(-20).reverse().map((r) => `<li class="agent-receipt"><small>${new Date(r.at).toLocaleTimeString()}</small> <b>${esc(r.agent)}</b> ${esc(r.kind || '')}: ${esc(r.outcome)}${r.reason ? ` (${esc(r.reason)})` : ''}${r.text ? ` <q>${esc(r.text.slice(0, 80))}</q>` : ''}</li>`).join('');
    const refused = refusals.slice(-5).reverse().map((r) => `<li class="agent-receipt"><b>${esc(r.agent)}</b> refused ${r.count} ${r.count === 1 ? 'time' : 'times'}: ${esc(r.reason)}${r.kind ? ` (${esc(r.kind)})` : ''}</li>`).join('');
    return `<div class="agent-queue-title">AGENT DRAFTS: nothing goes out until you approve it</div><ul class="agent-drafts">${waiting}</ul>`
        + `<div class="agent-queue-title">RECEIPTS <button type="button" id="agents-receipts-save">SAVE AS FILE</button></div><ul class="agent-receipts">${log || '<li class="agent-empty">No receipts yet.</li>'}</ul>`
        + (refused ? `<div class="agent-queue-title">REFUSED</div><ul class="agent-receipts">${refused}</ul>` : '');
}
