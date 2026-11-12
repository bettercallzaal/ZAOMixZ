// node web/dj/LiveStream.test.mjs — one link per stream: links, the card message, and /api/live.
import { createRequire } from 'module';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { streamIdFrom, lobbyFrom, cardMessage, hearingMix, STREAM_ID } from './LiveStream.js';

const require = createRequire(import.meta.url);
const live = require('../../api/live.js');
let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
console.log('LiveStream');

// Links
check('/stream/<8 digits> is a stream link', streamIdFrom('/stream/73822762') === '73822762' && streamIdFrom('/stream/73822762/') === '73822762');
check('/stream/zaal and /stream are not', streamIdFrom('/stream/zaal') === '' && streamIdFrom('/stream') === '' && streamIdFrom('/stream/123') === '');
check('/lobby/<name> names the lobby', lobbyFrom('/lobby/Zaal') === 'zaal' && lobbyFrom('/lobby/') === '' && lobbyFrom('/lobby/x') === '');
check('new ids are 8 digits and differ', [...Array(50)].map(live.newId).every((id) => STREAM_ID.test(id)) && new Set([...Array(50)].map(live.newId)).size > 45);
check('lobby names are cleaned', live.cleanLobby(' Zaal ') === 'zaal' && live.cleanLobby('<script>') === '' && live.cleanLobby('') === '');

// The route for a stream link: /stream/<8 digits> must open the listen page, not the desk.
// (vercel.json once said `d{8}` with no backslash, so every stream link opened the DJ desk.)
const routes = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).rewrites;
const routeFor = (path) => routes.find((r) => {
    const src = r.source.replace(/:\w+\(([^)]*)\)/g, '($1)').replace(/:\w+/g, '([^/]+)');
    return new RegExp(`^${src}$`).test(path);
})?.destination;
check('route: /stream/<8 digits> opens the listen page', routeFor('/stream/73822762') === '/listen.html');
check('route: /stream/<lobby> and /stream open the desk', routeFor('/stream/zaal') === '/index.html' && routeFor('/stream') === '/index.html');

// The card message stays small and safe
const m = cardMessage({ on: true, title: 'x'.repeat(200), artist: 'IMan', progress: 0.123456, time: '1:00 / 4:00', next: 'Topier', deck: 'B', art: 'javascript:alert(1)' });
check('card: title cut, progress rounded, deck kept', m.title.length === 80 && m.progress === 0.123 && m.deck === 'B' && m.t === 'card');
check('card: only https cover art passes', m.art === '' && cardMessage({ art: 'https://x/a.jpg' }).art === 'https://x/a.jpg');

// After connecting, a listener already hearing the mix stays LIVE
const T = { Kind: { Audio: 'audio' } };
const roomWith = (pubs) => ({ remoteParticipants: new Map([['host', { trackPublications: new Map(pubs.map((p, i) => [String(i), p])) }]]) });
check('mix already playing after connect: LIVE, not OFF AIR', hearingMix(roomWith([{ kind: 'audio', track: {} }]), T) === true);
check('host there but no sound yet: waiting', hearingMix(roomWith([{ kind: 'audio', track: null }]), T) === false && hearingMix({ remoteParticipants: new Map() }, T) === false);

// Tickets are real HS256 JWTs with the right grants
const tok = live.ticket('KEY', 'SECRET', { identity: 'listen-1', ttl: 60, video: { room: '73822762', roomJoin: true, canPublish: false, canSubscribe: true } });
const [h, b, sig] = tok.split('.');
const body = JSON.parse(Buffer.from(b, 'base64url').toString());
check('ticket is signed with the secret', sig === crypto.createHmac('sha256', 'SECRET').update(`${h}.${b}`).digest('base64url'));
check('ticket: issuer, room, listen only, expires', body.iss === 'KEY' && body.video.room === '73822762' && body.video.canPublish === false && body.exp - body.nbf <= 70);

// The handler
const res = () => { const r = { code: 0, json: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (j) => { r.body = j; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
const env = { ...process.env };
delete process.env.LIVEKIT_URL;
let r = res(); await live({ method: 'GET', query: { id: '73822762' } }, r);
check('no keys set: 501, the stream page carries on', r.code === 501);

process.env.LIVEKIT_URL = 'wss://test.livekit.cloud'; process.env.LIVEKIT_API_KEY = 'KEY'; process.env.LIVEKIT_API_SECRET = 'SECRET';
const calls = [];
globalThis.fetch = async (url, opt) => {
    calls.push({ url, body: JSON.parse(opt.body), auth: opt.headers.authorization });
    if (url.endsWith('/ListRooms')) return { ok: true, json: async () => ({ rooms: [
        { name: '11111111', metadata: JSON.stringify({ lobby: 'zaal', host: 'Zaal', started: 1 }), num_publishers: 1 },
        { name: '22222222', metadata: JSON.stringify({ lobby: 'zaal', host: 'Zaal', started: 2 }), num_publishers: 1 },
        { name: '33333333', metadata: JSON.stringify({ lobby: 'zaal', started: 3 }), num_publishers: 0 },
    ] }) };
    return { ok: true, json: async () => ({}) };
};
r = res(); await live({ method: 'POST', body: { lobby: 'Zaal', name: 'Zaal' } }, r);
check('POST into a lobby where someone is live: 409, no second room (specs/stream.qnt rule 2)', r.code === 409 && !r.body.token && !calls.some((c) => c.url.endsWith('/CreateRoom')));
r = res(); await live({ method: 'POST', body: { lobby: 'Fresh', name: 'Zaal' } }, r);
check('POST: a new 8-digit stream, its own link, a host ticket', r.code === 200 && STREAM_ID.test(r.body.id) && r.body.link === `/stream/${r.body.id}` && r.body.lobby === 'fresh');
const created = calls.find((c) => c.url === 'https://test.livekit.cloud/twirp/livekit.RoomService/CreateRoom');
check('POST: the room is made with the lobby in it and closes when empty', created && created.body.name === r.body.id && JSON.parse(created.body.metadata).lobby === 'fresh' && created.body.empty_timeout === 300);
const hostGrant = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url').toString()).video;
check('POST: the host may send, only into its own room', hostGrant.canPublish === true && hostGrant.room === r.body.id);
const hostId = r.body.id, hostToken = r.body.token;

// DELETE: only the host ends a stream, and ending it closes the room for everyone
r = res(); await live({ method: 'DELETE', query: { id: hostId }, headers: { authorization: `Bearer ${hostToken}` } }, r);
const deleted = calls.find((c) => c.url.endsWith('/DeleteRoom'));
check('DELETE with the host ticket: the room is deleted', r.code === 200 && deleted && deleted.body.room === hostId);
const listenTok = live.ticket('KEY', 'SECRET', { identity: 'listen-1', ttl: 60, video: { room: hostId, roomJoin: true } });
const before = calls.length;
r = res(); await live({ method: 'DELETE', query: { id: hostId }, headers: { authorization: `Bearer ${listenTok}` } }, r);
check('DELETE with a listener ticket: 403, nothing deleted', r.code === 403 && calls.length === before);
r = res(); await live({ method: 'DELETE', query: { id: '22222222' }, headers: { authorization: `Bearer ${hostToken}` } }, r);
check('DELETE another stream with your host ticket: 403', r.code === 403);
const forged = hostToken.slice(0, hostToken.lastIndexOf('.') + 1) + 'x'.repeat(43);
r = res(); await live({ method: 'DELETE', query: { id: hostId }, headers: { authorization: `Bearer ${forged}` } }, r);
check('DELETE with a forged signature: 403', r.code === 403);
const old = live.ticket('KEY', 'SECRET', { identity: `host-${hostId}`, ttl: -100, video: { room: hostId, roomJoin: true, canPublish: true } });
check('an expired host ticket is not the host', live.isHostOf(old, hostId, 'SECRET') === false && live.isHostOf(hostToken, hostId, 'SECRET') === true);
r = res(); await live({ method: 'GET', query: { id: '22222222' } }, r);
const listenGrant = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url').toString()).video;
check('GET ?id: a listener may only listen, in a stream that exists', r.code === 200 && listenGrant.canSubscribe === true && listenGrant.canPublish === false && listenGrant.canPublishData === false);
r = res(); await live({ method: 'GET', query: { id: '73822762' } }, r);
check('GET ?id for a stream that ended or never was: 404, no empty room opened', r.code === 404 && !r.body.token);
r = res(); await live({ method: 'GET', query: { id: '33333333' } }, r);
check('GET ?id for a room the DJ has left (old listeners still in it): 404 ended (specs/stream.qnt rule 1)', r.code === 404 && !r.body.token);
r = res(); await live({ method: 'GET', query: { lobby: 'zaal' } }, r);
check('GET ?lobby: the newest stream that is actually sending', r.code === 200 && r.body.id === '22222222' && r.body.link === '/stream/22222222');
r = res(); await live({ method: 'GET', query: { lobby: 'nobody' } }, r);
check('GET ?lobby with nobody live: 404', r.code === 404);
r = res(); await live({ method: 'GET', query: { id: '../../x' } }, r);
check('a bad id gets no ticket', r.code === 400);
globalThis.fetch = async () => ({ ok: false, status: 500 });
r = res(); await live({ method: 'POST', body: {} }, r);
check('stream server down: 502 with a plain message, no secrets', r.code === 502 && !JSON.stringify(r.body).includes('SECRET'));

// Listener: when the mix stops and does not come back (DJ's laptop died, STOP never sent),
// the page says "ended" after the grace time instead of waiting forever (specs/stream.qnt rule 1).
{
    const { listen, useLiveKitForTests } = await import('./LiveStream.js');
    const Ev = { TrackSubscribed: 'sub', TrackUnsubscribed: 'unsub', DataReceived: 'data', Disconnected: 'gone' };
    let fake;
    class Room {
        constructor() { this.h = {}; this.remoteParticipants = new Map(); fake = this; }
        on(e, f) { this.h[e] = f; }
        async connect() { this.pub = { kind: 'audio', track: { kind: 'audio', attach() {}, detach() {} } }; this.remoteParticipants.set('host', { trackPublications: new Map([['m', this.pub]]) }); this.h.sub(this.pub.track); }
        stopMix() { const t = this.pub.track; this.pub.track = null; this.h.unsub(t); }
        startMix() { this.pub.track = { kind: 'audio', attach() {}, detach() {} }; this.h.sub(this.pub.track); }
        disconnect() { this.h.gone(); }
    }
    useLiveKitForTests({ Room, RoomEvent: Ev, Track: { Kind: { Audio: 'audio' } } });
    const ok = async () => ({ ok: true, json: async () => ({ id: '22222222', url: 'wss://x', token: 't' }) });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    let states = [];
    await listen('22222222', { onState: (s) => states.push(s), audioEl: {}, fetchImpl: ok, graceMs: 40 });
    check('listener: mix playing after connect is LIVE', states.at(-1) === 'playing');
    fake.stopMix();
    check('listener: mix stops, page waits', states.at(-1) === 'waiting');
    await wait(80);
    check('listener: mix never comes back, page says ended', states.at(-1) === 'ended');

    states = [];
    await listen('22222222', { onState: (s) => states.push(s), audioEl: {}, fetchImpl: ok, graceMs: 40 });
    fake.stopMix(); await wait(10); fake.startMix(); await wait(80);
    check('listener: a short drop comes back LIVE and never shows ended', states.at(-1) === 'playing' && !states.includes('ended'));
}

Object.assign(process.env, env);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
