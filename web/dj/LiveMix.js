// LiveMix.js — one link for the whole set, from the first song to the last.
//
// Zaal: post the link at the start, and the same link shows every song as it plays, half way
// through or at the end, then holds the finished mix. A mix.html#m= link (MixPage.js) is a
// snapshot: it only knows the songs played before it was copied.
//
// The link is mix.html#live=<key>, where <key> is the desk's public signing key (Ed25519).
// The desk keeps the latest set on the same public relays the phone remote uses, as a
// retained message, so a page opened later still gets it: { v, ts, m, sig }, where m is the
// set in MixPage's link form and sig signs ts and m. A page shows only what that key signed,
// and only something newer than what it has, so holding the link is not enough to change the
// set. Anyone can still overwrite the retained message with junk: the desk puts its own back
// within a minute while it is open, and the page writes the set into its own address bar
// (#live=...&m=...) so a copy of that link keeps the mix whatever the relay does. The free
// relays promise nothing about how long they keep a message; a permanent store is a later step.
//
// One link per set: a new one is made when the last update is older than LOBBY_IDLE_MS. A
// reload of the desk mid-set keeps the link and the songs already played.
//
// The top half is pure and runs under node: see LiveMix.test.mjs.

import { buildMix, encodeMix, decodeMix } from './MixPage.js';
import { BROKERS, MQTT_SRC, loadScript } from './RemoteLink.js';

export const LIVE_VERSION = 1;
export const LOBBY_IDLE_MS = 6 * 60 * 60 * 1000;   // a set quiet for six hours is over
export const HEARTBEAT_MS = 30000;                 // the desk says it again this often
export const LIVE_FOR_MS = 90000;                  // heard from this recently: LIVE NOW
export const STORE_KEY = 'mixz-live-mix';
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const signed = (ts, m) => new TextEncoder().encode(`zaomixz-live-${LIVE_VERSION}\n${ts}\n${m}`);

export const validKey = (k) => typeof k === 'string' && KEY_RE.test(k);
export const liveUrl = (origin, pub) => `${origin.replace(/\/$/, '')}/mix.html#live=${pub}`;

// What a mix.html address holds: { live, m } (either may be '').
export function parseMixHash(hash) {
    const out = { live: '', m: '' };
    for (const part of String(hash || '').replace(/^#/, '').split('&')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i), v = part.slice(i + 1);
        if (k === 'live' && validKey(v)) out.live = v;
        if (k === 'm' && v) out.m = v;
    }
    return out;
}

// The relay topic for a key. Anyone with the link can work it out; only the desk can sign.
export async function liveTopic(pub, subtle = crypto.subtle) {
    const h = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`zaomixz-live:${pub}`)));
    return `zaomixz/live/${[...h.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export async function newKeys(subtle = crypto.subtle) {
    const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return { pub: b64u(await subtle.exportKey('raw', pair.publicKey)), jwk: await subtle.exportKey('jwk', pair.privateKey) };
}

export async function signUpdate(jwk, m, ts, subtle = crypto.subtle) {
    const key = await subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
    const sig = b64u(await subtle.sign({ name: 'Ed25519' }, key, signed(ts, m)));
    return JSON.stringify({ v: LIVE_VERSION, ts, m, sig });
}

// { ts, m, mix } when `payload` was signed by `pub` and holds a set, else null.
export async function readUpdate(pub, payload, subtle = crypto.subtle) {
    try {
        if (!validKey(pub)) return null;
        const u = JSON.parse(String(payload));
        if (!u || u.v !== LIVE_VERSION || typeof u.m !== 'string' || typeof u.sig !== 'string' || !Number.isFinite(u.ts)) return null;
        const key = await subtle.importKey('raw', unb64u(pub), { name: 'Ed25519' }, false, ['verify']);
        if (!(await subtle.verify({ name: 'Ed25519' }, key, unb64u(u.sig), signed(u.ts, u.m)))) return null;
        const mix = decodeMix(u.m);
        return mix ? { ts: u.ts, m: u.m, mix } : null;
    } catch (e) {
        return null;
    }
}

// The whole set so far: the songs from earlier loads of the desk (`before`, already timed
// from `start`), then this load's history timed from the same start.
export function liveMix(history, before, start, { name = '', dj = '' } = {}) {
    const now = buildMix(history, { name, dj, start });
    return { ...now, t: [...(before || []), ...now.t] };
}

// The saved lobby, or a fresh one when there is none or the last set went quiet long ago.
// `fresh()` makes new keys. Returns { lobby, isNew }.
export async function openLobby(saved, now, fresh) {
    if (saved && validKey(saved.pub) && saved.jwk && Number.isFinite(saved.start) && now - (saved.lastAt || saved.start) < LOBBY_IDLE_MS) {
        return { lobby: saved, isNew: false };
    }
    const keys = await fresh();
    return { lobby: { pub: keys.pub, jwk: keys.jwk, start: now, lastAt: now, t: [] }, isNew: true };
}

// ───────── The desk: keeps the latest set on the relays (browser only) ─────────

export class LiveMixHost {
    // getHistory: () => Setlist history. Injectable parts are for tests.
    constructor(getHistory, { storage = globalThis.localStorage, now = () => Date.now(), connect = null } = {}) {
        Object.assign(this, { getHistory, storage, now, connect });
        this.lobby = null;
        this.before = [];       // the songs from earlier loads of the desk, this set
        this.clients = [];
        this.topic = '';
        this._last = '';
        this._beat = null;
    }

    _load() { try { return JSON.parse(this.storage?.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } }
    _save() { try { this.storage?.setItem(STORE_KEY, JSON.stringify(this.lobby)); } catch (e) { /* no storage */ } }

    // The link, made on first use. Starts sending.
    async link(origin) {
        await this.start();
        return liveUrl(origin, this.lobby.pub);
    }

    async start() {
        if (this.lobby) return;
        const { lobby, isNew } = await openLobby(this._load(), this.now(), () => newKeys());
        this.lobby = lobby;
        this.before = isNew ? [] : (lobby.t || []);
        this._save();
        this.topic = await liveTopic(lobby.pub);
        await this._open();
        await this.update(true);
        if (typeof setInterval !== 'undefined') this._beat = setInterval(() => this.update(true), HEARTBEAT_MS);
    }

    async _open() {
        const connect = this.connect || (async (url) => { await loadScript(MQTT_SRC); return window.mqtt.connect(url, { clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 8000 }); });
        for (const url of BROKERS) {
            try {
                const c = await connect(url);
                c.on?.('error', () => { /* the other relay carries on */ });
                c.on?.('connect', () => { if (this._payload) c.publish(this.topic, this._payload, { qos: 1, retain: true }); });
                this.clients.push(c);
            } catch (e) { /* the other relay carries on */ }
        }
    }

    // Called when the setlist changes; `beat` re-sends the same set so the page knows the
    // desk is still on, and puts it back if someone overwrote it.
    async update(beat = false) {
        if (!this.lobby) return;
        try {
            let name = '', dj = '';
            try { name = this.storage?.getItem('mixz-mix-name') || ''; dj = this.storage?.getItem('mixz-dj-name') || ''; } catch (e) { /* no storage */ }
            const mix = liveMix(this.getHistory() || [], this.before, this.lobby.start, { name, dj });
            const m = encodeMix(mix);
            if (m === this._last && !beat) return;
            this._last = m;
            const ts = this.now();
            this._payload = await signUpdate(this.lobby.jwk, m, ts);
            this.lobby.t = mix.t; this.lobby.lastAt = ts;
            this._save();
            for (const c of this.clients) if (c.connected !== false) c.publish(this.topic, this._payload, { qos: 1, retain: true });
        } catch (e) {
            console.warn('[LiveMix] could not send the set:', e);
        }
    }
}

// ───────── The page: follows the set (browser only) ─────────

// Calls onUpdate({ ts, m, mix }) for each newer set the desk signed. Returns stop().
export async function watchLive(pub, onUpdate, { connect = null } = {}) {
    const topic = await liveTopic(pub);
    let latest = 0;
    const clients = [];
    const open = connect || (async (url) => { await loadScript(MQTT_SRC); return window.mqtt.connect(url, { clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 8000 }); });
    for (const url of BROKERS) {
        try {
            const c = await open(url);
            c.on('connect', () => c.subscribe(topic, { qos: 1 }));
            c.on('error', () => { /* the other relay carries on */ });
            c.on('message', async (_t, payload) => {
                const u = await readUpdate(pub, payload.toString());
                if (u && u.ts > latest) { latest = u.ts; onUpdate(u); }
            });
            clients.push(c);
        } catch (e) { /* the other relay carries on */ }
    }
    return () => { for (const c of clients) { try { c.end(true); } catch (e) { /* gone */ } } };
}
