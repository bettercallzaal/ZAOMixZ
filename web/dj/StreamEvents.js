// StreamEvents.js — what the desk tells overlays and the world while it plays.
//
// The contract is docs/STREAM-EVENTS.md (version 1). Every event is one envelope,
// { v, type, at, seq, data }. It goes out only while the desk is ON AIR: to overlays in the
// same browser through StreamBroadcast, and off the machine over the phone relay. This file sends the song the room hears (track.changed), each handover
// (transition.started, transition.finished) and how the stream is doing (stream.health).
//
// It also fills the messages the overlay pages already listen for (track_update,
// now_playing, play_state): those were defined in StreamBroadcast but nothing ever sent
// them, so overlays never showed the song title.
//
// Nothing here carries a credential or a deck's audio URL; the song's public page is the
// only link. The builders are pure and run under node: see StreamEvents.test.mjs.

import { cleanTitle, liveDeck, songPage } from './NowPlaying.js';

export const EVENT_VERSION = 1;
export const OUT_TYPES = ['track.changed', 'transition.started', 'transition.finished', 'stream.health', 'request.updated', 'chat.message', 'director.advice'];
export const HEALTH_EVERY_MS = 5000;
// Said once and true until replaced, so sent again at GO LIVE (it may have been said off air)
export const REPLAY = ['director.advice'];

export function envelope(type, data, seq, at = Date.now()) {
    return { v: EVENT_VERSION, type, at, seq, data };
}

// track.changed data for a deck: only what the stream already shows.
export function trackData(deck) {
    const m = deck?.metadata?.metadata || {};
    const meta = { ...m, _source: deck?.metadata?._source };
    const l = deck?.licence;
    return {
        deck: deck?.id || null,
        title: cleanTitle(m.title, m.artist).slice(0, 120),
        artist: String(m.artist || '').slice(0, 80),
        source: meta.source || meta._source || 'local',
        licence: l ? { holder: String(l.holder || l.artist || ''), radio: !!l.uses?.radio } : null,
        link: songPage(meta),
    };
}

// request.updated data: what the request board already shows, never the phone's device id.
export function requestData(r) {
    return {
        rid: r.rid, title: String(r.title || '').slice(0, 120), artist: String(r.artist || '').slice(0, 80),
        name: String(r.name || '').slice(0, 24), also: (r.also || []).length, status: r.status,
    };
}

// director.advice data: the Flow Director's word on the slot coming up (FlowDirector.js).
export function adviceData(adv) {
    if (!adv) return { next: null, alts: [] };
    return {
        next: { title: adv.planned.track.title || '', why: adv.why },
        alts: adv.alts.map((a) => ({ title: a.track.title || '', why: a.reasons.join(', '), better: !!a.better })),
    };
}

// stream.health data from the desk.
export function healthData(dj) {
    const dead = dj.deadAir;
    return {
        live: !!dj.broadcast?.isLive,
        liveSince: dj.broadcast?.liveSince || 0,
        audio: dj.audioRouter?.ctx?.state === 'running' ? 'running' : 'suspended',
        deadAir: { on: !!dead?.on, silentMs: dead?.silentSince ? Math.max(0, Date.now() - dead.silentSince) : 0 },
        loading: !!dj.flowMode?._transitioning,
    };
}

// Health counts as changed when anything but the silence clock moved.
const healthKey = (h) => JSON.stringify({ ...h, deadAir: { on: h.deadAir.on, silent: h.deadAir.silentMs > 0 } });

export class StreamEvents {
    // `now` is injectable for tests; `every` is the tick in ms (0 = no timer, tests tick by hand).
    constructor(dj, { now = () => Date.now(), every = 1000 } = {}) {
        this.dj = dj;
        this.now = now;
        this.seq = 0;
        this._live = null;       // { deck, key } of the song last announced
        this._playing = {};      // play state last sent, by deck
        this._health = null;
        this._healthAt = 0;
        this._latest = {};       // the last word of each kind that stays true until replaced (REPLAY)
        if (every && typeof setInterval !== 'undefined') setInterval(() => this.tick(), every);
    }

    emit(type, data) {
        const b = this.dj.broadcast;
        if (!b || !OUT_TYPES.includes(type)) return null;
        if (REPLAY.includes(type)) this._latest[type] = data;
        const env = envelope(type, data, ++this.seq, this.now());
        b._broadcast(env);                                  // same browser (overlays), only ON AIR
        if (b.isLive) this.dj.remote?.sendEvent?.(env);     // off the machine, over the phone relay
        if (b.isLive) this.dj.agents?.sendEvent?.(env);     // agents on their own channels (AgentLink.js)
        return env;
    }

    // Called by FlowMode at each handover (flow.onHandover).
    handover(phase, data) {
        this.emit(phase === 'started' ? 'transition.started' : 'transition.finished', data);
    }

    tick() {
        const dj = this.dj, b = dj.broadcast;
        if (!b) return;
        const decks = dj.decks || {};
        // Nothing goes out while off air, so on GO LIVE say everything again
        if (b.isLive && !this._wasLive) {
            this._live = null; this._playing = {}; this._health = null;
            this._wasLive = true;
            for (const type of REPLAY) if (this._latest[type]) this.emit(type, this._latest[type]);
        }
        this._wasLive = !!b.isLive;
        // Play state for the overlays' deck cards
        for (const id of ['A', 'B']) {
            const d = decks[id];
            if (!d) continue;
            if (this._playing[id] !== !!d.isPlaying) {
                this._playing[id] = !!d.isPlaying;
                b.updatePlayState(id, !!d.isPlaying, d.getCurrentTime?.() || 0);
            }
        }
        // The song the room hears
        const live = liveDeck(decks, dj.audioRouter?._lastCrossfadePosition ?? 0.5);
        const deck = live ? decks[live] : null;
        const key = deck?.metadata ? `${live}|${deck.metadata.metadata?.id ?? ''}|${deck.metadata.metadata?.title ?? ''}` : '';
        if (key && key !== this._live?.key) {
            this._live = { deck: live, key };
            const data = trackData(deck);
            b.updateTrackInfo(live, deck.metadata);
            b.sendNowPlaying(data.title, data.artist);
            this.emit('track.changed', data);
        }
        // Health: every five seconds, and at once on a change
        const h = healthData(dj);
        const t = this.now();
        if (!this._health || healthKey(h) !== healthKey(this._health) || t - this._healthAt >= HEALTH_EVERY_MS) {
            this._health = h; this._healthAt = t;
            this.emit('stream.health', h);
        }
    }
}
