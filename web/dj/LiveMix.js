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
// Lobbies (Zaal: "people can join different lobbies, and when a host joins one it claims that
// seat until it has been silent for over 30 minutes"). Any host can name one. Its link is
// mix.html#lobby=<name>, and it shows the set of whoever holds it. The desk keeps a signed
// claim on the relays, saying who holds the lobby and when its decks last played; in code a
// lobby is a "room", since `lobby` below already names the desk's saved key. The desk will
// not claim a room someone else played in within LOBBY_HOLD_MS, a page follows the holder and
// ignores anyone else until then, and a desk that sees its room taken after that steps back.
// Without a server this holds for the app as written, not against a modified copy.
//
// The top half is pure and runs under node: see LiveMix.test.mjs and Lobby.test.mjs.

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

// ───────── Lobbies (rooms): pure ─────────

export const LOBBY_HOLD_MS = 30 * 60 * 1000;   // a room is free once its host has been silent this long
const ROOM_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const validRoom = (r) => typeof r === 'string' && r.length >= 2 && ROOM_RE.test(r);

// "Main Stage!" -> "main-stage". '' when nothing usable is left.
export function roomSlug(name) {
    const s = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
    return validRoom(s) ? s : '';
}
export const roomName = (name) => String(name ?? '').normalize('NFKC').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
export const roomUrl = (origin, room) => `${origin.replace(/\/$/, '')}/mix.html#lobby=${room}`;

export async function roomTopic(room, subtle = crypto.subtle) {
    const h = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`zaomixz-lobby:${room}`)));
    return `zaomixz/lobby/${[...h.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const claimBytes = (c) => new TextEncoder().encode(`zaomixz-lobby-${LIVE_VERSION}\n${c.room}\n${c.pub}\n${c.ts}\n${c.playedAt}\n${c.name}`);

// A claim says: <pub> holds <room>; its decks last played at <playedAt>. Signed by <pub>.
export async function signClaim(jwk, { room, name, pub, ts, playedAt }, subtle = crypto.subtle) {
    const c = { v: LIVE_VERSION, room, name: roomName(name), pub, ts, playedAt: Math.min(playedAt, ts) };
    const key = await subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
    return JSON.stringify({ ...c, sig: b64u(await subtle.sign({ name: 'Ed25519' }, key, claimBytes(c))) });
}

export async function readClaim(payload, room, subtle = crypto.subtle) {
    try {
        const c = JSON.parse(String(payload));
        if (!c || c.v !== LIVE_VERSION || c.room !== room || !validKey(c.pub) || typeof c.name !== 'string' || typeof c.sig !== 'string') return null;
        if (!Number.isFinite(c.ts) || !Number.isFinite(c.playedAt) || c.playedAt > c.ts) return null;
        const key = await subtle.importKey('raw', unb64u(c.pub), { name: 'Ed25519' }, false, ['verify']);
        if (!(await subtle.verify({ name: 'Ed25519' }, key, unb64u(c.sig), claimBytes(c)))) return null;
        return { room: c.room, name: roomName(c.name), pub: c.pub, ts: c.ts, playedAt: c.playedAt };
    } catch (e) {
        return null;
    }
}

// Still held at `now`: its host played within the last 30 minutes.
export const roomHeld = (c, now) => !!c && now - c.playedAt < LOBBY_HOLD_MS;

// A claim dated more than two minutes ahead of this clock is ignored: a desk whose clock runs
// fast would otherwise look 30 minutes ahead of a holder that is still playing.
export const CLOCK_SLACK_MS = 2 * 60 * 1000;
export const fromTheFuture = (c, now) => !!c && c.ts > now + CLOCK_SLACK_MS;

// May the desk with key `pub` claim a room whose latest claim is `existing`?
export function canClaim(existing, pub, now) {
    if (!existing || existing.pub === pub || !roomHeld(existing, now)) return { ok: true };
    return { ok: false, minutes: Math.max(0, Math.floor((now - existing.playedAt) / 60000)), name: existing.name };
}

// Who a page follows, given the holder so far and a claim that just arrived. The same host's
// newer claim replaces its old one; another host's counts only once the holder had been silent
// for 30 minutes when that claim was made. A claim dated in the future (by this clock, `now`) is
// never followed, whoever calls this.
export function nextHolder(current, incoming, now = Date.now()) {
    if (!incoming || fromTheFuture(incoming, now)) return current;
    if (!current) return incoming;
    if (incoming.pub === current.pub) return incoming.ts > current.ts ? incoming : current;
    return incoming.ts - current.playedAt >= LOBBY_HOLD_MS ? incoming : current;
}

export const validKey = (k) => typeof k === 'string' && KEY_RE.test(k);
// LIVE NOW comes from when the desk signed the set, not from when this page heard it: an old
// signed set replayed on the relay does not look live.
export const isLiveNow = (signedAt, now = Date.now()) => Number.isFinite(signedAt) && now - signedAt < LIVE_FOR_MS && signedAt - now < CLOCK_SLACK_MS;
export const liveUrl = (origin, pub) => `${origin.replace(/\/$/, '')}/mix.html#live=${pub}`;

// What a mix.html address holds: { live, m, lobby } (any may be '').
export function parseMixHash(hash) {
    const out = { live: '', m: '', lobby: '' };
    for (const part of String(hash || '').replace(/^#/, '').split('&')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i), v = part.slice(i + 1);
        if (k === 'live' && validKey(v)) out.live = v;
        if (k === 'm' && v) out.m = v;
        if (k === 'lobby' && validRoom(v)) out.lobby = v;
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
    // isPlaying: () => is a deck playing now; a lobby is held while the decks play.
    constructor(getHistory, { storage = globalThis.localStorage, now = () => Date.now(), connect = null, isPlaying = () => false, wait = (ms) => new Promise((r) => setTimeout(r, ms)), onRoomLost = null } = {}) {
        Object.assign(this, { getHistory, storage, now, connect, isPlaying, wait, onRoomLost });
        this.room = null;          // { room, name, topic } while this desk holds a lobby
        this.playedAt = 0;
        this._claims = new Map();  // topic -> the latest claim heard on it
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
                c.on?.('connect', () => { if (this._payload) c.publish(this.topic, this._payload, { qos: 1, retain: true }); if (this.room) c.subscribe?.(this.room.topic, { qos: 1 }); });
                c.on?.('message', (topic, payload) => this._heard(topic, String(payload)));
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
            if (this.isPlaying()) this.playedAt = ts;
            this._save();
            for (const c of this.clients) if (c.connected !== false) c.publish(this.topic, this._payload, { qos: 1, retain: true });
            await this._sayRoom(ts);
        } catch (e) {
            console.warn('[LiveMix] could not send the set:', e);
        }
    }

    // A new mix link now, instead of waiting for six quiet hours. The old link keeps the set it
    // had; nothing more is sent to it.
    newSet() {
        if (this._beat) clearInterval(this._beat);
        this._beat = null;
        this.room = null;
        this.lobby = null;
        this.before = [];
        this._last = '';
        this._payload = null;
        for (const c of this.clients) { try { c.end?.(true); } catch (e) { /* gone */ } }
        this.clients = [];
        try { this.storage?.removeItem?.(STORE_KEY); } catch (e) { /* no storage */ }
    }

    // ── Lobbies ──

    async _heard(topic, payload) {
        if (!this.room || topic !== this.room.topic) return;
        const c = await readClaim(payload, this.room.room);
        if (!c || fromTheFuture(c, this.now())) return;
        this._claims.set(topic, nextHolder(this._claims.get(topic), c, this.now()));
        if (!this.room || this.room.topic !== topic) return;   // let go or moved on while the claim was checked
        // Someone else claimed it after this desk had been silent 30 minutes: step back
        const mine = { pub: this.lobby.pub, ts: this.now(), playedAt: this.playedAt };
        if (!this.room.checking && c.pub !== this.lobby.pub && nextHolder(mine, c, this.now()) === c) {
            const lost = this.room;
            this.room = null;
            this.onRoomLost?.(lost);
        }
    }

    // True once relay `c` is connected and has acknowledged the subscription (8 s at most).
    async _subscribed(c, topic) {
        const ready = new Promise((resolve) => {
            // A grant of QoS 128 is the relay saying no
            const sub = () => { try { c.subscribe(topic, { qos: 1 }, (err, granted) => resolve(!err && !(granted || []).some((g) => g?.qos === 128))); } catch (e) { resolve(false); } };
            if (!c?.subscribe) return resolve(false);
            if (c.connected) sub(); else c.on?.('connect', sub);
        });
        return Promise.race([ready, this.wait(8000).then(() => false)]);
    }

    // Claim a lobby by name. { ok, link } or { ok: false, why, minutes, name }.
    async claimRoom(name) {
        const room = roomSlug(name);
        if (!room) return { ok: false, why: 'name' };
        await this.start();
        const topic = await roomTopic(room);
        const prev = this.room;
        this.room = { room, name: roomName(name) || room, topic, checking: true };
        // An empty room counts as free only if a relay actually took the subscription: hearing
        // nothing because nothing is connected is not the same as nobody holding it.
        const acked = await Promise.all(this.clients.map((c) => this._subscribed(c, topic)));
        if (!acked.some(Boolean)) { if (this.room?.topic === topic) this.room = prev; return { ok: false, why: 'offline' }; }
        await this.wait(3000);   // the relays hand over the room's last claim right after
        if (this.room?.topic !== topic) return { ok: false, why: 'changed' };   // another claim started meanwhile
        const existing = this._claims.get(topic);
        const ok = canClaim(existing && existing.pub !== this.lobby.pub ? existing : null, this.lobby.pub, this.now());
        if (!ok.ok) { this.room = prev; return { ok: false, why: 'taken', minutes: ok.minutes, name: ok.name }; }
        this.room.checking = false;
        this.playedAt = this.now();   // claiming counts as the start of the 30 minutes
        await this._sayRoom(this.now());
        return { ok: true, room, link: roomUrl(globalThis.location?.origin || '', room) };
    }

    // Stop holding the lobby. Its claim stays on the relays and runs out by itself.
    releaseRoom() { this.room = null; }

    async _sayRoom(ts) {
        if (!this.room || this.room.checking) return;
        const payload = await signClaim(this.lobby.jwk, { room: this.room.room, name: this.room.name, pub: this.lobby.pub, ts, playedAt: this.playedAt || ts });
        for (const c of this.clients) if (c.connected !== false) c.publish(this.room.topic, payload, { qos: 1, retain: true });
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

// Calls onHolder(claim) whenever the room's holder changes or says it is still there. Returns stop().
export async function watchRoom(room, onHolder, { connect = null } = {}) {
    const topic = await roomTopic(room);
    let holder = null;
    const clients = [];
    const open = connect || (async (url) => { await loadScript(MQTT_SRC); return window.mqtt.connect(url, { clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 8000 }); });
    for (const url of BROKERS) {
        try {
            const c = await open(url);
            c.on('connect', () => c.subscribe(topic, { qos: 1 }));
            c.on('error', () => { /* the other relay carries on */ });
            c.on('message', async (_t, payload) => {
                const read = await readClaim(payload.toString(), room);
                const next = nextHolder(holder, read, Date.now());
                if (next && next !== holder) { holder = next; onHolder(holder); }
            });
            clients.push(c);
        } catch (e) { /* the other relay carries on */ }
    }
    return () => { for (const c of clients) { try { c.end(true); } catch (e) { /* gone */ } } };
}
