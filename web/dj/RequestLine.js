// RequestLine.js — the MixZ request line, like calling the radio station
// Zaal, 15 Oct 2026, on a post about phoning the station to request a song and waiting by the
// cassette recorder to tape it: "this is how we need to build the zao mixz".
//
// A listener on the phone page (viewer) picks a song, adds their name and who it is for, and
// calls it in. The desk sees the requests and plays one next, or DJ MixZ slots it in by itself.
// When the song comes on, that listener's phone says so and offers TAPE: it records the song
// off the live mix, onto the phone, the way we taped the radio. Taping only shows when the
// song's licence allows radio play (Licence.js).
//
// The queue below is pure and runs under node: see RequestLine.test.mjs.

import { cleanTitle } from './NowPlaying.js';

export const MAX_WAITING = 20;       // requests on the board at once
export const PER_PHONE = 2;          // songs one phone can have waiting
export const NAME_MAX = 24;
export const NOTE_MAX = 80;
export const STATUS = ['waiting', 'next', 'onair', 'played', 'passed'];

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// The same song on the desk and in a request: compared by cleaned title and artist, because
// the deck keeps its own copy of the track's details.
export const songKey = (title, artist) => `${squash(cleanTitle(title, artist))}|${squash(artist)}`;

const oneLine = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// What a phone sends: { track, name, note }. The song id rides as track because the link
// stamps every message with an id of its own. Returns a clean request or null.
export function cleanRequest(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.track !== 'string' || !raw.track || raw.track.length > 200) return null;
    return { id: raw.track, name: oneLine(raw.name, NAME_MAX) || 'A listener', note: oneLine(raw.note, NOTE_MAX) };
}

export class RequestQueue {
    constructor({ now = () => Date.now() } = {}) {
        this.items = [];
        this._n = 0;
        this._now = now;
    }

    waiting() { return this.items.filter((r) => r.status === 'waiting' || r.status === 'next'); }
    byDevice(device) { return this.items.filter((r) => r.device === device); }
    get(id) { return this.items.find((r) => r.rid === id) || null; }

    // Add a request. Returns { ok, request, reason }.
    add(device, req, track) {
        const title = cleanTitle(track?.title || track?.name, track?.artist || track?.user);
        const artist = String(track?.artist || track?.user || '').slice(0, 60);
        const key = songKey(title, artist);
        const open = this.waiting();
        const mine = open.filter((r) => r.device === device);
        if (mine.some((r) => r.key === key)) return { ok: false, reason: 'You already asked for that one. It is on the board.' };
        if (mine.length >= PER_PHONE) return { ok: false, reason: `You have ${PER_PHONE} songs waiting. Wait for one to play.` };
        if (open.length >= MAX_WAITING) return { ok: false, reason: 'The request line is full right now. Try again in a few songs.' };
        // Someone else asked for it already: count this caller in, it stays one request.
        const same = open.find((r) => r.key === key);
        if (same) {
            if (!same.also.includes(req.name)) same.also.push(req.name);
            if (!same.devices.includes(device)) same.devices.push(device);
            return { ok: true, request: same, joined: true };
        }
        const request = {
            rid: `r${++this._n}`, device, devices: [device], key, id: req.id, track,
            title, artist, name: req.name, note: req.note, also: [], status: 'waiting', at: this._now(),
        };
        this.items.push(request);
        this._trim();
        return { ok: true, request };
    }

    set(rid, status) {
        const r = this.get(rid);
        if (!r || !STATUS.includes(status)) return null;
        r.status = status;
        if (status === 'onair') r.airedAt = this._now();
        return r;
    }

    // The desk tells the queue what the room hears now. Returns the requests that changed,
    // so their callers can be told.
    nowPlaying(title, artist) {
        const key = title ? songKey(title, artist) : '';
        const changed = [];
        for (const r of this.items) {
            if (r.status === 'onair' && r.key !== key) { r.status = 'played'; changed.push(r); }
            else if ((r.status === 'waiting' || r.status === 'next') && key && r.key === key) { r.status = 'onair'; r.airedAt = this._now(); changed.push(r); }
        }
        return changed;
    }

    // The oldest waiting request, for DJ MixZ to slot in.
    first() { return this.items.find((r) => r.status === 'waiting') || null; }

    // The board everyone sees: what is on and what is coming, small.
    board(limit = 5) {
        const onair = this.items.find((r) => r.status === 'onair');
        return {
            onair: onair ? brief(onair) : null,
            up: this.waiting().sort((a, b) => ((b.status === 'next') - (a.status === 'next')) || a.at - b.at).slice(0, limit).map(brief),
            count: this.waiting().length,
        };
    }

    // Finished requests drop off after a while so the list stays short.
    _trim() {
        const done = this.items.filter((r) => r.status === 'played' || r.status === 'passed');
        if (done.length > 30) { const cut = new Set(done.slice(0, done.length - 30)); this.items = this.items.filter((r) => !cut.has(r)); }
    }
}

const brief = (r) => ({ rid: r.rid, title: r.title, artist: r.artist, name: r.name, also: r.also.length, note: r.note, status: r.status });

// May a request go on air by itself? Only when the DJ has switched AUTO-PLAY REQUESTS on,
// DJ MixZ is mixing, nobody has the decks and nothing is already lined up next. A request
// sent by an outside agent (from: 'agent') never plays without a tap, switch or not.
// Otherwise every request waits on the board for PLAY NEXT.
export function autoPick(queue, { on = false, running = false, human = false } = {}) {
    if (!on || !running || human) return null;
    if (queue.items.some((r) => r.status === 'next')) return null;
    return queue.items.find((r) => r.status === 'waiting' && r.from !== 'agent') || null;
}

// What one caller's phone shows about their own requests.
export function forCaller(queue, device) {
    return queue.items.filter((r) => r.devices.includes(device) && r.status !== 'passed').slice(-4).map((r) => ({ ...brief(r), tape: !!r.tape, mine: r.device === device }));
}

// Words for a request's state, on the phone.
export function statusLine(status) {
    return {
        waiting: 'On the board. The DJ has it.',
        next: 'Up next. Get your tape ready.',
        onair: 'Your song is on now.',
        played: 'Played. Thanks for calling in.',
        passed: 'Not tonight.',
    }[status] || '';
}

// Can a listener tape this song off the mix? Only when the licence allows radio play.
export function canTape(licence) {
    return !!licence?.uses?.radio;
}
