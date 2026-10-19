// RemoteLink.js — MixZ Remote: run the set from a phone, from anywhere
//
// The desktop app (the host, the one with the decks and the controller) and the phone talk
// through a public relay, sealed end to end, so it works on any network and there is no ZAO
// server to run or pay for. Listening to the mix on the phone uses a direct call on top.
//
// What keeps a stranger out:
//   1. The link holds a 128 bit random token. Nobody can guess it.
//   2. A phone that has never connected before must be allowed at the desk, once.
//   3. Every message from the phone is checked against the list below. Anything else is dropped.
//
// This file is shared by the desktop (RemoteHost below) and the phone page (remote.js).
// The top half is pure and runs under node: see RemoteLink.test.mjs.

import { cleanTitle, liveDeck } from './NowPlaying.js';
import { MOODS, tracksFrom } from './DjMixz.js';
import { RequestQueue, cleanRequest, forCaller, canTape, autoPick } from './RequestLine.js';
import { requestData } from './StreamEvents.js';
import { canPlay } from './Licence.js';
import { moderate, matchRequest, chatDevice, CHAT_MAX_WAITING } from './ChatFilter.js';

export const STATE_HZ = 5;
export const NEXT_MODES = ['smooth', 'up', 'down', 'key', 'mood', 'genre', 'double', 'wild'];
export const TRACK_SOURCES = ['view', 'zao', 'songchainn', 'local'];
export const SET_MINUTES = [0, 15, 30, 60, 90, 120, 180, 240];
const MOOD_IDS = MOODS.map((m) => m.id);

// For the direct sound call: STUN finds a way through most home networks. A relay (TURN)
// carries the call when a network refuses a direct line (mobile data often does). The free
// openrelay.metered.ca relay is gone (17 Oct 2026 its name points at 192.0.2.1, a dead
// address), so there is no relay until MixZ has a TURN account of its own: add it to TURN.
// Without one, a phone that cannot reach the desk directly falls back to PLAY ALONG.
export const TURN = [];
export const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ...TURN,
];

export function newToken() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const validToken = t => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t);
export const remoteUrl = (origin, token) => `${origin.replace(/\/$/, '')}/remote.html#${token}`;

const deckOf = d => (d === 'A' || d === 'B' ? d : null);
const unit = v => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
const pad = n => (Number.isInteger(n) && n >= 0 && n <= 7 ? n : null);

// Everything a phone is allowed to ask for. Returns a clean command, or null to drop it.
export function cleanCommand(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.a !== 'string') return null;
    const d = deckOf(raw.d);
    switch (raw.a) {
        case 'play': case 'cue': case 'sync':
            return d ? { a: raw.a, d } : null;
        case 'hotcue': case 'fxfade': case 'jump':
            return d && pad(raw.n) != null ? { a: raw.a, d, n: raw.n } : null;
        case 'loop':
            return d && [0, 1, 2, 4, 8, 16].includes(raw.beats) ? { a: 'loop', d, beats: raw.beats } : null;
        case 'volume': case 'filter':
            return d && unit(raw.v) != null ? { a: raw.a, d, v: unit(raw.v) } : null;
        case 'crossfader': case 'master':
            return unit(raw.v) != null ? { a: raw.a, v: unit(raw.v) } : null;
        case 'next':
            return NEXT_MODES.includes(raw.mode) ? { a: 'next', mode: raw.mode } : null;
        case 'load':
            return d && typeof raw.track === 'string' && raw.track.length <= 200 ? { a: 'load', d, id: raw.track } : null;   // the song rides as 'track': the link stamps every message with its own id
        case 'tracks':
            return { a: 'tracks', q: typeof raw.q === 'string' ? raw.q.slice(0, 60) : '', src: TRACK_SOURCES.includes(raw.src) ? raw.src : 'view' };
        case 'stream':
            return { a: 'stream', src: TRACK_SOURCES.includes(raw.src) && raw.src !== 'view' ? raw.src : (raw.src === 'view' ? 'view' : 'songchainn'), mood: MOOD_IDS.includes(raw.mood) ? raw.mood : 'journey', minutes: SET_MINUTES.includes(raw.minutes) ? raw.minutes : 60, endless: !!raw.endless };
        case 'skip': case 'share':
            return { a: raw.a };
        case 'endless': case 'live': case 'deadair': case 'agentsmute':
            return { a: raw.a, on: !!raw.on };
        case 'mixz':
            return { a: 'mixz', on: !!raw.on };
        case 'songchainn': case 'takeover': case 'handback':
            return { a: raw.a };
        case 'request': {   // the request line: a listener calls in a song
            const req = cleanRequest(raw);
            return req ? { a: 'request', ...req } : null;
        }
        case 'listen':
            return { a: 'listen', on: !!raw.on };   // the phone's call address rides beside it, checked by the host
        default:
            return null;
    }
}

// Commands that mean a person has their hands on the mix. They take the decks from DJ MixZ,
// the same as touching the real controller does.
export const HANDS_ON = new Set(['play', 'cue', 'crossfader', 'load']);
// What a phone that is only watching may ask for: listen, share, and call in a request.
export const VIEWER_OK = new Set(['listen', 'share', 'tracks', 'request']);

const idOfTrack = t => String(t?.id ?? t?.sourceId ?? t?.dataFile ?? t?.streamUrl ?? t?.title ?? '');

// What the phone needs to draw the set. Small on purpose: it is sent five times a second.
export function snapshot(dj) {
    const deck = (id) => {
        const d = dj.decks?.[id];
        const m = d?.metadata?.metadata || {};
        return {
            loaded: !!d?.isLoaded, playing: !!d?.isPlaying,
            title: cleanTitle(m.title, m.artist).slice(0, 80), artist: String(m.artist || '').slice(0, 60),
            bpm: d?.getBPM?.() || null, rate: d?.currentRate || 1,
            time: Math.round((d?.getCurrentTime?.() || 0) * 10) / 10, dur: Math.round(d?.getDuration?.() || 0),
            cues: (d?.hotCues || []).map(c => !!c), loop: !!d?.loop?.active,
            fading: !!dj.fxFade?.active?.[id],
            url: String(d?.metadata?.audio_files?.mp3 || '').slice(0, 400),   // so the phone can play along
        };
    };
    const m = dj.djMixz || {};
    const next = m.running ? m.plan?.[(m.index || 0) + 1]?.track : null;
    const now = m.running ? m.plan?.[m.index || 0]?.track : null;
    const brief = (t) => (t ? { title: cleanTitle(t.title, t.artist).slice(0, 80), artist: String(t.artist || '').slice(0, 60) } : null);
    const slider = (id, fallback) => { const el = typeof document !== 'undefined' && document.getElementById(id); return el ? Number(el.value) / 100 : fallback; };
    return {
        t: 'state',
        A: deck('A'), B: deck('B'),
        xf: dj.audioRouter?._lastCrossfadePosition ?? 0.5,
        vol: { A: slider('vol-a', 0.8), B: slider('vol-b', 0.8) }, master: slider('master-volume', 0.8),
        live_deck: liveDeck(dj.decks, dj.audioRouter?._lastCrossfadePosition ?? 0.5),
        live: !!dj.broadcast?.isLive, liveSince: dj.broadcast?.liveSince || 0,
        deadair: !!dj.deadAir?.on,
        agents: dj.agents ? { n: dj.agents.connectedCount?.() || 0, muted: !!dj.agents.muted } : null,
        mixz: {
            running: !!m.running, human: !!m.human, endless: !!m.endless, mood: m.mood || 'journey',
            index: m.index || 0, total: m.plan?.length || 0, minutes: m.minutes || 0, source: m._lastBuild?.sourceId || '',
            now: brief(now), next: brief(next),
        },
        req: dj.requestLine?.board?.() || null,
    };
}

// Carry out one clean command on the desktop. Returns a short word for the log.
export function applyCommand(dj, cmd, host = null) {
    const deck = cmd.d ? dj.decks?.[cmd.d] : null;
    const other = cmd.d ? dj.decks?.[cmd.d === 'A' ? 'B' : 'A'] : null;
    const mixz = dj.djMixz;
    if (HANDS_ON.has(cmd.a) && mixz?.running && !mixz.human) mixz.takeOver?.('touch');
    const setSlider = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = Math.round(v * 100);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    switch (cmd.a) {
        case 'play': deck?.playPause(); return 'play';
        case 'cue': deck?.cue(); return 'cue';
        case 'sync': { const bpm = other?.getBPM?.(); if (bpm) deck?.syncTo(bpm * (other.currentRate || 1)); return 'sync'; }
        case 'hotcue': deck?.triggerHotCue(cmd.n); return 'hotcue';
        case 'loop':
            if (cmd.beats > 0) deck?.autoLoop(cmd.beats);
            else if (deck?.loop?.active) deck.toggleLoop();
            return 'loop';
        case 'fxfade': dj.fxFade?.trigger(cmd.d, cmd.n); return 'fxfade';
        case 'jump': dj.padModes?.beatJump(cmd.d, cmd.n); return 'jump';
        case 'volume': setSlider(`vol-${cmd.d.toLowerCase()}`, cmd.v); return 'volume';
        case 'master': setSlider('master-volume', cmd.v); return 'master';
        case 'filter': dj.audioRouter?.setFilter(cmd.d, cmd.v); return 'filter';
        case 'crossfader': {
            dj.audioRouter?.setCrossfade(cmd.v);
            const el = document.getElementById('crossfader');
            if (el) el.value = Math.round(cmd.v * 100);
            return 'crossfader';
        }
        case 'next': dj.switchPad?.trigger(cmd.mode); return 'next';
        case 'load': { const track = host?.trackById(cmd.id); if (track) dj.library?.loadToDeck(track, cmd.d); return track ? 'load' : 'load-miss'; }
        case 'mixz': if (cmd.on) mixz?.start?.(); else mixz?.stop?.(); return 'mixz';
        case 'songchainn': mixz?.mixSongChainn?.(); return 'songchainn';
        case 'takeover': mixz?.takeOver?.('button'); return 'takeover';
        case 'handback': mixz?.handBack?.(); return 'handback';
        case 'stream': mixz?.startFrom?.(cmd.src, cmd.mood, cmd.minutes, cmd.endless); return 'stream';
        case 'skip': dj.flowMode?.skip?.(); return 'skip';
        case 'endless': if (mixz) mixz.endless = cmd.on; return 'endless';
        case 'live': { const b = document.getElementById('live-toggle'); if (b && !!dj.broadcast?.isLive !== cmd.on) b.click(); return 'live'; }
        case 'deadair': dj.deadAir?.set?.(cmd.on); return 'deadair';
        case 'agentsmute': dj.agents?.setMuted?.(cmd.on); dj.agents?.renderMute?.(); return 'agentsmute';
        default: return 'ignored';
    }
}

// The tracks the phone can browse: whatever the library is showing on the desktop, filtered.
export function trackList(tracks, q = '', limit = 60) {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const t of tracks || []) {
        if (!t) continue;
        const title = String(t.title || t.name || ''), artist = String(t.artist || t.user || '');
        if (needle && !(`${title} ${artist}`.toLowerCase().includes(needle))) continue;
        out.push({ id: idOfTrack(t), title: title.slice(0, 80), artist: artist.slice(0, 60), bpm: t.bpm || null, key: t.key || null });
        if (out.length >= limit) break;
    }
    return out;
}


// ───────────────────────── The link itself ─────────────────────────
//
// Controls travel through a relay: both sides hold an outgoing connection to a public
// message broker, so it works on any network, mobile data included. The broker only ever
// sees scrambled bytes. Every message is sealed with a key made from the token (AES-GCM),
// stamped with the time and a one-use id, and the desk drops anything stale or repeated.
// Two brokers are used at once, so one going down does not drop the set.

export const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
export const FRESH_MS = 30000;
const MQTT_SRC = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
const PEER_SRC = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const QR_SRC = 'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js';

const text = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// The key that seals every message, and the channel name. Both come from the token, and
// neither can be turned back into it.
export async function linkKeys(token) {
    const base = await crypto.subtle.importKey('raw', unhex(token), 'HKDF', false, ['deriveKey', 'deriveBits']);
    const salt = text.encode('zaomixz-remote-v1');
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: text.encode('key') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: text.encode('channel') }, base, 128);
    return { key, channel: `zaomixz/${hex(bits)}` };
}

export async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, text.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + body.length);
    out.set(iv); out.set(body, 12);
    return b64(out);
}

// Null for anything that was not sealed with this key, or was changed on the way.
export async function unseal(key, payload) {
    try {
        const bytes = unb64(String(payload));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
        return JSON.parse(new TextDecoder().decode(plain));
    } catch (e) {
        return null;
    }
}

// True the first time a message is seen, if its clock is close to ours. Stops replays, and
// drops the second copy of everything that arrives through both brokers.
export function fresh(msg, seen, now = Date.now()) {
    if (!msg || typeof msg.id !== 'string' || typeof msg.ts !== 'number') return false;
    if (Math.abs(now - msg.ts) > FRESH_MS) return false;
    if (seen.has(msg.id)) return false;
    seen.set(msg.id, now);
    if (seen.size > 2000) for (const [id, at] of seen) { if (now - at > FRESH_MS * 2) seen.delete(id); }
    return true;
}

export function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(s);
    });
}
export const loadPeer = () => loadScript(PEER_SRC);

// One end of the link. role is 'host' (the desk) or 'phone'.
export class Relay {
    constructor({ token, role, onMessage, onStatus }) {
        Object.assign(this, { token, role, onMessage, onStatus });
        this.clients = [];
        this.seen = new Map();
        this.keys = null;
        this.closed = false;
    }

    get online() { return this.clients.some(c => c.connected); }

    async open() {
        await loadScript(MQTT_SRC);
        this.keys = await linkKeys(this.token);
        const listen = `${this.keys.channel}/${this.role === 'host' ? 'up' : 'down'}`;
        for (const url of BROKERS) {
            const client = window.mqtt.connect(url, { clean: true, keepalive: 10, reconnectPeriod: 1000, connectTimeout: 8000, clientId: `mz${hex(crypto.getRandomValues(new Uint8Array(8)))}` });
            client.on('connect', () => { client.subscribe(listen, { qos: 0 }); this.onStatus?.(true); });
            client.on('close', () => this.onStatus?.(this.online));
            client.on('error', () => { /* the other broker carries on */ });
            client.on('message', async (_topic, payload) => {
                const msg = await unseal(this.keys.key, payload.toString());
                if (msg && fresh(msg, this.seen)) this.onMessage?.(msg);
            });
            this.clients.push(client);
        }
    }

    async send(obj) {
        if (!this.keys || this.closed) return;
        const msg = { ...obj, ts: Date.now(), id: hex(crypto.getRandomValues(new Uint8Array(8))) };
        const payload = await seal(this.keys.key, msg);
        const topic = `${this.keys.channel}/${this.role === 'host' ? 'down' : 'up'}`;
        for (const c of this.clients) if (c.connected) c.publish(topic, payload, { qos: 0 });
    }

    close() {
        this.closed = true;
        for (const c of this.clients) { try { c.end(true); } catch (e) { /* gone */ } }
        this.clients = [];
    }
}

// ───────────────────────── Desktop side ─────────────────────────

const PHONE_QUIET_MS = 8000;   // a phone not heard from for this long is treated as gone

export class RemoteHost {
    constructor(djPlayer) {
        this.dj = djPlayer;
        this.relay = null;
        this.peer = null;             // only made if a phone asks to listen
        this.token = localStorage.getItem('mixz-remote-token');
        this.phones = new Map();      // device id -> { name, allowed, seen, askedAt, call }
        this._tracks = new Map();
        this.requests = new RequestQueue();
        this.dj.requestLine = this.requests;   // the board rides in the snapshot
        // Requests wait for PLAY NEXT unless the DJ switches this on (docs/STREAM-EVENTS.md)
        try { this.autoPlay = localStorage.getItem('mixz-auto-requests') === 'on'; } catch (e) { this.autoPlay = false; }
        this._buildUI();
        // Once switched on it stays on across reloads, so the phone can always find the desk.
        if (validToken(this.token) && localStorage.getItem('mixz-remote') === 'on') this.start();
        setInterval(() => this._broadcast(), 1000 / STATE_HZ);
        setInterval(() => this._render(), 2000);
        setInterval(() => this._requestTick(), 1000);
    }

    _allowed() {
        try { return JSON.parse(localStorage.getItem('mixz-remote-allowed') || '[]'); } catch (e) { return []; }
    }
    _live() { const now = Date.now(); return [...this.phones.values()].filter(p => p.allowed && now - p.seen < PHONE_QUIET_MS); }
    trackById(id) { return this._tracks.get(id) || null; }

    async start(fresh = false) {
        if (fresh || !validToken(this.token)) {
            this.token = newToken();
            localStorage.setItem('mixz-remote-token', this.token);
            localStorage.setItem('mixz-remote-allowed', '[]');
        }
        localStorage.setItem('mixz-remote', 'on');
        this.relay?.close();
        this.phones.clear();
        this._status('Starting...');
        this.relay = new Relay({
            token: this.token, role: 'host',
            onMessage: msg => this._onMessage(msg),
            onStatus: up => this._status(up ? 'Ready. Scan the code with your phone' : 'No internet: the phone link needs it'),
        });
        this._render();
        try { await this.relay.open(); } catch (e) { this._status('No internet: the phone link needs it'); }
    }

    stop() {
        localStorage.setItem('mixz-remote', 'off');
        this.phones.forEach(p => { try { p.call?.close(); } catch (e) { /* gone */ } });
        this.phones.clear();
        this.relay?.close();
        this.relay = null;
        this._status('Off');
        this._render();
    }

    _onMessage(msg) {
        const device = typeof msg.device === 'string' && /^[a-f0-9]{24}$/.test(msg.device) ? msg.device : null;
        if (!device) return;
        let phone = this.phones.get(device);
        if (!phone) {
            phone = { device, name: 'Phone', allowed: this._allowed().includes(device), seen: 0, askedAt: 0, call: null };
            this.phones.set(device, phone);
        }
        phone.seen = Date.now();
        if (msg.t === 'hello') {
            if (typeof msg.name === 'string') phone.name = msg.name.slice(0, 40);
            const viewer = msg.role === 'viewer';
            if (viewer !== !!phone.viewer) { phone.viewer = viewer; if (!viewer) phone.allowed = this._allowed().includes(device); }
            if (viewer) { phone.allowed = true; this.relay.send({ t: 'welcome', to: device, role: 'viewer' }); this._render(); return; }
            if (phone.allowed) { this.relay.send({ t: 'welcome', to: device }); this._render(); return; }
            // Not known yet: ask at the desk, and tell the phone it is waiting (not more than
            // once every few seconds, the phone says hello often).
            if (Date.now() - phone.askedAt > 4000) { phone.askedAt = Date.now(); this.relay.send({ t: 'wait', to: device }); }
            this._render();
            this._openPanel();
            return;
        }
        // Round trip check, so the phone can show how quick the link is.
        if (msg.t === 'ping' && phone.allowed) { this.relay.send({ t: 'pong', to: device, n: msg.n }); return; }
        if (msg.t !== 'cmd' || !phone.allowed) return;
        const cmd = cleanCommand(msg);
        if (!cmd) return;
        if (phone.viewer && !VIEWER_OK.has(cmd.a)) return;
        if (cmd.a === 'share') {
            const url = this.dj.setlist?.mixLink?.() || '';
            this.relay.send({ t: 'mix', to: device, url, n: this.dj.setlist?.history?.length || 0 });
            return;
        }
        if (cmd.a === 'tracks') {
            const lib = this.dj.library || {};
            const full = cmd.src === 'view' ? (lib._getCurrentList?.() || []) : tracksFrom(lib, cmd.src);
            if (this._tracks.size > 5000) this._tracks.clear();   // kept between searches: a request names a track from any phone's list
            for (const t of full) this._tracks.set(idOfTrack(t), t);
            this.relay.send({ t: 'tracks', to: device, list: trackList(full, cmd.q) });
            return;
        }
        if (cmd.a === 'listen') { this._listen(phone, cmd.on, msg.peer); return; }
        if (cmd.a === 'request') { this._request(phone, cmd); return; }
        try { applyCommand(this.dj, cmd, this); } catch (e) { console.warn('[Remote] command failed', cmd, e); }
        // Answer straight away instead of at the next tick, so a tap shows on the phone at once.
        clearTimeout(this._echo);
        this._echo = setTimeout(() => this._broadcast(), 60);
    }

    _allow(phone) {
        phone.allowed = true;
        const list = this._allowed();
        if (!list.includes(phone.device)) { list.push(phone.device); localStorage.setItem('mixz-remote-allowed', JSON.stringify(list.slice(-10))); }
        this.relay?.send({ t: 'welcome', to: phone.device });
        this._render();
    }

    _deny(phone) {
        this.relay?.send({ t: 'denied', to: phone.device });
        this.phones.delete(phone.device);
        this._render();
    }

    // ── The request line ──

    _request(phone, cmd) {
        const say = (text) => this.relay?.send({ t: 'req', to: phone.device, say: text, list: forCaller(this.requests, phone.device) });
        const track = this.trackById(cmd.id);
        if (!track) { say('The desk lost that list. Search again and pick the song.'); return; }
        const play = canPlay(track);
        if (!play.ok) { say(play.reason); return; }
        const res = this.requests.add(phone.device, cmd, track);
        if (!res.ok) { say(res.reason); return; }
        if (!res.joined) res.request.tape = canTape(play.licence) || !play.licence;   // no licence = the DJ's own file
        this._announce(res.request);   // a new request, or one more caller on it
        say(res.joined ? 'Someone asked for that one too. You are on it with them.' : 'Got it. Your request is on the board.');
        this._renderRequests();
    }

    // A "!sr song" from Twitch or YouTube chat: moderated, matched to one playable track, and put
    // on the board marked from chat. It waits for PLAY NEXT; it never plays by itself.
    // { ok, reason, request }.
    chatRequest(req, blocked = []) {
        const m = moderate(req?.query, { blocked });
        if (!m.ok) return { ok: false, reason: m.reason };
        const user = moderate(req?.user, { blocked });
        if (!user.ok) return { ok: false, reason: 'name' };
        if (this.requests.waiting().filter((r) => r.from === 'chat').length >= CHAT_MAX_WAITING) return { ok: false, reason: 'chat requests full' };
        const lib = this.dj.library || {};
        const pool = [...tracksFrom(lib, 'zao'), ...tracksFrom(lib, 'local'), ...tracksFrom(lib, 'battles')].filter((t) => canPlay(t).ok);
        const track = matchRequest(m.text, pool);
        if (!track) return { ok: false, reason: 'no match' };
        const platform = req.platform === 'youtube' ? 'YouTube' : req.platform === 'twitch' ? 'Twitch' : 'chat';
        const res = this.requests.add(chatDevice(req.platform, user.text), { id: idOfTrack(track), name: user.text.slice(0, 24), note: `via ${platform}` }, track);
        if (!res.ok) return { ok: false, reason: res.reason };
        if (!res.joined) res.request.from = 'chat';   // set here, from the connection, never from the message
        this._announce(res.request);
        this._renderRequests();
        return { ok: true, request: res.request };
    }

    // Tell the callers on this request, and the stream (request.updated, docs/STREAM-EVENTS.md).
    _tell(r) {
        this._announce(r);
        for (const device of r.devices) this.relay?.send({ t: 'req', to: device, list: forCaller(this.requests, device) });
    }

    _announce(r) {
        try { this.dj.streamEvents?.emit?.('request.updated', requestData(r)); } catch (e) { /* the stream is optional */ }
    }

    // Once a second: is a requested song on now, or over? With AUTO-PLAY REQUESTS on, DJ MixZ
    // slots the oldest request in; otherwise requests wait for PLAY NEXT at the desk.
    _requestTick() {
        if (!this.relay) return;
        const live = liveDeck(this.dj.decks, this.dj.audioRouter?._lastCrossfadePosition ?? 0.5);
        const m = live ? this.dj.decks[live]?.metadata?.metadata || {} : {};
        const changed = this.requests.nowPlaying(live ? m.title : '', m.artist || '');
        const mixz = this.dj.djMixz;
        const r = autoPick(this.requests, { on: this.autoPlay, running: mixz?.running, human: mixz?.human });
        if (r && mixz.playNext?.(r.track)) { this.requests.set(r.rid, 'next'); changed.push(r); }
        changed.forEach((r) => this._tell(r));
        if (changed.length) this._renderRequests();
    }

    // PLAY NEXT at the desk: DJ MixZ takes it as its next song, or it loads on the deck the
    // room is not hearing, ready for the DJ to bring in.
    _playNext(r) {
        const mixz = this.dj.djMixz;
        if (mixz?.running && !mixz.human) {
            if (!mixz.playNext?.(r.track)) return;
        } else {
            const live = liveDeck(this.dj.decks, this.dj.audioRouter?._lastCrossfadePosition ?? 0.5);
            this.dj.library?.loadToDeck(r.track, live === 'A' ? 'B' : 'A');
        }
        this.requests.items.filter((x) => x.status === 'next' && x !== r).forEach((x) => { x.status = 'waiting'; this._tell(x); });
        this.requests.set(r.rid, 'next');
        this._tell(r);
        this._renderRequests();
    }

    setAutoPlay(on) {
        this.autoPlay = !!on;
        try { localStorage.setItem('mixz-auto-requests', this.autoPlay ? 'on' : 'off'); } catch (e) { /* no storage */ }
        const box = document.getElementById('remote-requests'); if (box) box.dataset.sig = '';
        this._renderRequests();
    }

    _pass(r) {
        this.requests.set(r.rid, 'passed');
        this._tell(r);
        this._renderRequests();
    }

    _renderRequests() {
        const box = document.getElementById('remote-requests');
        const open = this.requests.waiting();
        const onair = this.requests.items.find((r) => r.status === 'onair');
        if (this.btn) {
            const base = this.btn.textContent.replace(/ · \d+ REQ$/, '');
            this.btn.textContent = base + (open.length ? ` · ${open.length} REQ` : '');
        }
        if (!box) return;
        const sig = (onair?.rid || '') + '|' + open.map((r) => `${r.rid}:${r.status}:${r.also.length}`).join(',');
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.textContent = '';
        if (!onair && !open.length) return;
        const head = document.createElement('div'); head.className = 'remote-req-head'; head.textContent = 'REQUEST LINE';
        const auto = document.createElement('button'); auto.className = `btn-toolbar btn-sm${this.autoPlay ? ' active' : ''}`;
        auto.textContent = `AUTO-PLAY ${this.autoPlay ? 'ON' : 'OFF'}`;
        auto.title = 'On: DJ MixZ plays listeners\' requests by itself, oldest first. Off: each waits for PLAY NEXT.';
        auto.onclick = () => this.setAutoPlay(!this.autoPlay);
        head.appendChild(auto);
        box.appendChild(head);
        const row = (r) => {
            const el = document.createElement('div'); el.className = `remote-req ${r.status}`;
            const info = document.createElement('div'); info.className = 'remote-req-info';
            const b = document.createElement('b'); b.textContent = `${r.title}${r.artist ? ', ' + r.artist : ''}`;
            const who = document.createElement('small');
            who.textContent = `${r.name}${r.also.length ? ` +${r.also.length}` : ''}${r.note ? `: "${r.note}"` : ''}`;
            info.append(b, who);
            el.appendChild(info);
            if (r.status === 'onair' || r.status === 'next') {
                const s = document.createElement('span'); s.className = 'remote-req-tag'; s.textContent = r.status === 'onair' ? 'ON AIR' : 'NEXT';
                el.appendChild(s);
            } else {
                const go = document.createElement('button'); go.className = 'btn-toolbar btn-sm'; go.textContent = 'PLAY NEXT'; go.onclick = () => this._playNext(r);
                el.appendChild(go);
            }
            if (r.status !== 'onair') { const no = document.createElement('button'); no.className = 'btn-toolbar btn-sm'; no.textContent = 'NOT TONIGHT'; no.onclick = () => this._pass(r); el.appendChild(no); }
            return el;
        };
        if (onair) box.appendChild(row(onair));
        open.forEach((r) => box.appendChild(row(r)));
    }

    // Send the live mix to the phone, so the set can be heard from anywhere. Sound cannot go
    // through the relay, so this part is a direct call and depends on both networks allowing it.
    async _listen(phone, on, peerId) {
        try { phone.call?.close(); } catch (e) { /* gone */ }
        phone.call = null;
        if (!on || typeof peerId !== 'string' || peerId.length > 80) { this._render(); return; }
        try {
            await loadPeer();
            if (!this.peer || this.peer.destroyed) {
                this.peer = new window.Peer({ config: { iceServers: ICE_SERVERS } });
                await new Promise((resolve, reject) => { this.peer.on('open', resolve); this.peer.on('error', reject); });
            }
            const router = this.dj.audioRouter;
            if (!this._monitor) {
                this._monitor = router.getAudioContext().createMediaStreamDestination();
                router._remoteMonitor = this._monitor;   // the router re-attaches it when the limiter is switched
            }
            router.masterAnalyser.connect(this._monitor);
            phone.call = this.peer.call(peerId, this._monitor.stream);
        } catch (e) {
            console.warn('[Remote] could not start the listen call', e);
        }
        this._render();
    }

    _broadcast() {
        if (!this.relay?.online || !this._live().length) return;
        this.relay.send(snapshot(this.dj));
    }

    // A stream event (docs/STREAM-EVENTS.md) for the phones and viewer links on the relay.
    // Sealed like everything else on it, so only someone holding the link can read it.
    sendEvent(env) {
        if (!this.relay?.online || !this._live().length) return;
        this.relay.send({ t: 'ev', ev: env });
    }

    // ── The PHONE panel on the desktop ──

    _buildUI() {
        this.btn = document.getElementById('remote-open');
        this.panel = document.getElementById('remote-panel');
        this.btn?.addEventListener('click', () => { this.panel?.classList.toggle('hidden'); if (!this.panel?.classList.contains('hidden') && !this.relay) this.start(); });
        document.getElementById('remote-close')?.addEventListener('click', () => this.panel?.classList.add('hidden'));
        document.getElementById('remote-off')?.addEventListener('click', () => this.stop());
        document.getElementById('remote-new')?.addEventListener('click', () => this.start(true));
        document.getElementById('remote-copy')?.addEventListener('click', () => {
            if (validToken(this.token)) navigator.clipboard?.writeText(remoteUrl(location.origin, this.token));
        });
    }

    _openPanel() { this.panel?.classList.remove('hidden'); }

    _status(text) {
        const el = document.getElementById('remote-status');
        if (el) el.textContent = text;
    }

    async _render() {
        const on = !!this.relay;
        const live = this._live();
        const now = Date.now();
        const asking = [...this.phones.values()].filter(p => !p.allowed && now - p.seen < PHONE_QUIET_MS);
        this.btn?.classList.toggle('active', live.length > 0);
        if (this.btn) this.btn.textContent = live.length > 0 ? `PHONE ${live.length}` : 'PHONE';
        this._renderRequests();
        const url = on && validToken(this.token) ? remoteUrl(location.origin, this.token) : '';
        const linkEl = document.getElementById('remote-link');
        if (linkEl && linkEl.textContent !== url) linkEl.textContent = url;
        const list = document.getElementById('remote-phones');
        const sig = asking.map(p => 'ask:' + p.device).concat(live.map(p => 'live:' + p.device + (p.call ? ':l' : '') + (p.viewer ? ':v' : ''))).join('|');
        if (list && list.dataset.sig !== sig) {
            list.dataset.sig = sig;
            list.textContent = '';
            for (const p of asking) {
                const row = document.createElement('div');
                row.className = 'remote-ask';
                const label = document.createElement('span');
                label.textContent = `${p.name} wants to control the set`;
                const yes = document.createElement('button'); yes.className = 'btn-toolbar btn-sm'; yes.textContent = 'ALLOW'; yes.onclick = () => this._allow(p);
                const no = document.createElement('button'); no.className = 'btn-toolbar btn-sm'; no.textContent = 'DENY'; no.onclick = () => this._deny(p);
                row.append(label, yes, no);
                list.appendChild(row);
            }
            for (const p of live) {
                const row = document.createElement('div');
                row.className = 'remote-phone';
                row.textContent = `${p.name}: ${p.viewer ? 'watching' : 'connected'}${p.call ? ', listening' : ''}`;
                list.appendChild(row);
            }
        }
        const qr = document.getElementById('remote-qr');
        if (qr && qr.dataset.url !== url) {
            qr.dataset.url = url;
            qr.textContent = '';
            if (url) {
                try {
                    await loadScript(QR_SRC);
                    const code = window.qrcode(0, 'M');
                    code.addData(url);
                    code.make();
                    const n = code.getModuleCount(), cell = Math.floor(220 / n), size = cell * n;
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = size + 16;
                    const g = canvas.getContext('2d');
                    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
                    g.fillStyle = '#000';
                    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (code.isDark(r, c)) g.fillRect(8 + c * cell, 8 + r * cell, cell, cell);
                    qr.appendChild(canvas);
                } catch (e) {
                    qr.textContent = 'Copy the link and open it on your phone';
                }
            }
        }
    }
}
