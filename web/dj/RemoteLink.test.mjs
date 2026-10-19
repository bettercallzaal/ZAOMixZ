// node web/dj/RemoteLink.test.mjs
import { newToken, validToken, linkKeys, seal, unseal, fresh, FRESH_MS, BROKERS, remoteUrl, cleanCommand, applyCommand, trackList, snapshot, HANDS_ON, NEXT_MODES, ICE_SERVERS, TRACK_SOURCES, VIEWER_OK, RemoteHost } from './RemoteLink.js';
import { RequestQueue } from './RequestLine.js';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

console.log('RemoteLink');

const t1 = newToken(), t2 = newToken();
check('a token is 32 hex characters (128 bits)', validToken(t1) && t1.length === 32);
check('two tokens are never the same', t1 !== t2);
check('validToken rejects short, long and odd input', !validToken('abc') && !validToken(t1 + 'a') && !validToken(t1.toUpperCase().replace(/[0-9]/g, 'G')) && !validToken(null) && !validToken({}));
check('the link carries the token after the #, so it is never sent to a server', remoteUrl('https://zaomixz.vercel.app/', t1) === `https://zaomixz.vercel.app/remote.html#${t1}`);

// The seal
const k1 = await linkKeys(t1), k2 = await linkKeys(t2), k1b = await linkKeys(t1);
check('the channel name comes from the token and never contains it', k1.channel === k1b.channel && k1.channel !== k2.channel && !k1.channel.includes(t1) && /^zaomixz\/[a-f0-9]{32}$/.test(k1.channel));
const sealed = await seal(k1.key, { t: 'cmd', a: 'play', d: 'A' });
check('a sealed message does not show its contents', typeof sealed === 'string' && !atob(sealed).includes('play'));
check('the same key opens it', (await unseal(k1b.key, sealed))?.a === 'play');
check('another token cannot open it', (await unseal(k2.key, sealed)) === null);
const bent = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21);
check('a message changed on the way is thrown out', (await unseal(k1.key, bent)) === null);
check('rubbish is thrown out', (await unseal(k1.key, 'not a message')) === null && (await unseal(k1.key, '')) === null);
check('sealing the same thing twice never gives the same bytes', (await seal(k1.key, { a: 1 })) !== (await seal(k1.key, { a: 1 })));
const seenIds = new Map();
check('a new message is accepted once', fresh({ id: 'a1', ts: 1000 }, seenIds, 1000) && !fresh({ id: 'a1', ts: 1000 }, seenIds, 1001));
check('an old message is refused, so a recorded tap cannot be played back later', !fresh({ id: 'b2', ts: 1000 }, seenIds, 1000 + FRESH_MS + 1));
check('a message with no id or time is refused', !fresh({ ts: 1000 }, seenIds, 1000) && !fresh({ id: 'c3' }, seenIds, 1000) && !fresh(null, seenIds, 1000));
check('two relays, both over a secure socket', BROKERS.length === 2 && BROKERS.every(u => u.startsWith('wss://')));

// What a phone may ask for
check('play, cue and sync need a real deck', cleanCommand({ a: 'play', d: 'A' })?.d === 'A' && cleanCommand({ a: 'play', d: 'C' }) === null && cleanCommand({ a: 'sync' }) === null);
check('pads are 0 to 7 only', cleanCommand({ a: 'hotcue', d: 'B', n: 7 })?.n === 7 && cleanCommand({ a: 'hotcue', d: 'B', n: 8 }) === null && cleanCommand({ a: 'fxfade', d: 'A', n: -1 }) === null && cleanCommand({ a: 'jump', d: 'A', n: 1.5 }) === null);
check('sliders are clamped to 0..1', cleanCommand({ a: 'crossfader', v: 5 }).v === 1 && cleanCommand({ a: 'master', v: -2 }).v === 0 && cleanCommand({ a: 'volume', d: 'A', v: 0.25 }).v === 0.25);
check('a slider with no number is dropped', cleanCommand({ a: 'crossfader', v: 'full' }) === null && cleanCommand({ a: 'crossfader', v: NaN }) === null);
check('loop takes whole beat counts only', cleanCommand({ a: 'loop', d: 'A', beats: 4 })?.beats === 4 && cleanCommand({ a: 'loop', d: 'A', beats: 0 })?.beats === 0 && cleanCommand({ a: 'loop', d: 'A', beats: 3 }) === null);
check('next track takes the eight known modes only', NEXT_MODES.length === 8 && cleanCommand({ a: 'next', mode: 'wild' })?.mode === 'wild' && cleanCommand({ a: 'next', mode: 'delete' }) === null);
check('unknown commands are dropped', cleanCommand({ a: 'eval', code: 'x' }) === null && cleanCommand({ a: 'settings' }) === null && cleanCommand(null) === null && cleanCommand('play') === null);
check('extra fields never pass through', Object.keys(cleanCommand({ a: 'play', d: 'A', evil: 1, __proto__: { x: 1 } })).sort().join() === 'a,d');
check('a search is capped at 60 characters', cleanCommand({ a: 'tracks', q: 'x'.repeat(500) }).q.length === 60);
check('a load id is capped', cleanCommand({ a: 'load', d: 'A', track: 'x'.repeat(201) }) === null && cleanCommand({ a: 'load', d: 'A', track: 'abc' })?.id === 'abc');
check('the song rides as track, not id: the link stamps its own id on every message', cleanCommand({ a: 'load', d: 'A', id: 'abc' }) === null && cleanCommand({ a: 'request', track: 'abc', id: '0123456789abcdef' })?.id === 'abc');

// Carrying a command out on the desktop
const mkDeck = (o = {}) => ({ calls: [], isLoaded: true, isPlaying: false, currentRate: 1, loop: { active: false }, hotCues: new Array(8).fill(null),
    getBPM: () => 120, playPause() { this.calls.push('playPause'); }, cue() { this.calls.push('cue'); }, syncTo(b) { this.calls.push('syncTo ' + b); },
    triggerHotCue(n) { this.calls.push('hotcue ' + n); }, autoLoop(b) { this.loop.active = true; this.calls.push('autoLoop ' + b); }, toggleLoop() { this.loop.active = false; this.calls.push('toggleLoop'); }, ...o });
const rig = (mixz = { running: false, human: false }) => {
    const log = [];
    const dj = {
        decks: { A: mkDeck(), B: mkDeck({ getBPM: () => 126, currentRate: 1.02 }) },
        audioRouter: { _lastCrossfadePosition: 0.5, setCrossfade: v => log.push('xf ' + v), setFilter: (d, v) => log.push(`filter ${d} ${v}`) },
        fxFade: { trigger: (d, n) => log.push(`fxfade ${d} ${n}`), active: {} }, padModes: { beatJump: (d, n) => log.push(`jump ${d} ${n}`) },
        switchPad: { trigger: m => log.push('next ' + m) }, library: { loadToDeck: (t, d) => log.push(`load ${t.title} ${d}`) },
        djMixz: { ...mixz, takeOver(w) { this.human = true; log.push('takeOver ' + w); }, handBack() { log.push('handBack'); }, stop() { log.push('stop'); }, mixSongChainn() { log.push('songchainn'); } },
    };
    return { dj, log };
};
globalThis.document = { getElementById: () => null };

let r = rig();
applyCommand(r.dj, cleanCommand({ a: 'play', d: 'A' }));
check('play presses play on that deck', r.dj.decks.A.calls.join() === 'playPause' && r.dj.decks.B.calls.length === 0);
applyCommand(r.dj, cleanCommand({ a: 'sync', d: 'A' }));
check('sync matches the other deck at the speed it is really playing', r.dj.decks.A.calls.includes('syncTo ' + 126 * 1.02));
applyCommand(r.dj, cleanCommand({ a: 'loop', d: 'A', beats: 4 }));
applyCommand(r.dj, cleanCommand({ a: 'loop', d: 'A', beats: 0 }));
check('loop on, then loop off', r.dj.decks.A.calls.includes('autoLoop 4') && r.dj.decks.A.calls.includes('toggleLoop') && !r.dj.decks.A.loop.active);
applyCommand(r.dj, cleanCommand({ a: 'crossfader', v: 0.9 }));
applyCommand(r.dj, cleanCommand({ a: 'fxfade', d: 'B', n: 3 }));
applyCommand(r.dj, cleanCommand({ a: 'jump', d: 'A', n: 6 }));
applyCommand(r.dj, cleanCommand({ a: 'next', mode: 'up' }));
check('crossfader, fx fade, beat jump and next track reach the right part of the app', ['xf 0.9', 'fxfade B 3', 'jump A 6', 'next up'].every(x => r.log.includes(x)));
check('a load for a track the desk never listed does nothing', applyCommand(r.dj, cleanCommand({ a: 'load', d: 'A', track: 'nope' }), { trackById: () => null }) === 'load-miss' && !r.log.some(x => x.startsWith('load')));
applyCommand(r.dj, cleanCommand({ a: 'load', d: 'B', track: 'x' }), { trackById: () => ({ title: 'Song' }) });
check('a load for a listed track loads it', r.log.includes('load Song B'));

r = rig({ running: true, human: false });
applyCommand(r.dj, cleanCommand({ a: 'crossfader', v: 0.2 }));
check('a hand on the phone takes the decks from DJ MixZ', r.log[0] === 'takeOver touch');
r = rig({ running: true, human: false });
applyCommand(r.dj, cleanCommand({ a: 'master', v: 0.5 }));
check('master volume does not take the decks from DJ MixZ', !r.log.some(x => x.startsWith('takeOver')) && !HANDS_ON.has('master'));

// Lists and state
const tracks = [{ id: 1, title: 'Alpha', artist: 'One', bpm: 120 }, { sourceId: 'b', title: 'Beta', artist: 'Two' }, null, { title: 'Gamma', user: 'Three' }];
check('track list keeps only what the phone needs', trackList(tracks).length === 3 && Object.keys(trackList(tracks)[0]).sort().join() === 'artist,bpm,id,key,title');
check('track list search matches title or artist', trackList(tracks, 'two').length === 1 && trackList(tracks, 'GAM')[0].title === 'Gamma');
check('track list is capped', trackList(Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'T' + i }))).length === 60);
const snap = snapshot(rig().dj);
check('the state sent to the phone has both decks, the crossfader and DJ MixZ', snap.t === 'state' && snap.A.loaded && snap.B.bpm === 126 && snap.xf === 0.5 && snap.mixz.running === false);
check('the state is small (under 2 KB)', JSON.stringify(snap).length < 2048);
check('the state names the deck the room hears, the live flag and the DJ MixZ plan', snap.live_deck === null && snap.live === false && snap.mixz.total === 0 && snap.mixz.next === null && 'endless' in snap.mixz);

// The STREAM tab
check('a stream order is cleaned to known music, mood and length', JSON.stringify(cleanCommand({ a: 'stream', src: 'zao', mood: 'party', minutes: 90, endless: 1 })) === '{"a":"stream","src":"zao","mood":"party","minutes":90,"endless":true}');
check('a stream order with rubbish falls back to SongChainn, journey, one hour', JSON.stringify(cleanCommand({ a: 'stream', src: 'evil', mood: 'x', minutes: 7 })) === '{"a":"stream","src":"songchainn","mood":"journey","minutes":60,"endless":false}');
check('tracks can be asked by source, unknown sources mean the view', cleanCommand({ a: 'tracks', src: 'songchainn' }).src === 'songchainn' && cleanCommand({ a: 'tracks', src: 'x' }).src === 'view' && TRACK_SOURCES.length === 4);
check('skip, share, endless and live are known', cleanCommand({ a: 'skip' })?.a === 'skip' && cleanCommand({ a: 'share' })?.a === 'share' && cleanCommand({ a: 'endless', on: 1 })?.on === true && cleanCommand({ a: 'live', on: 0 })?.on === false);
r = rig({ running: false, human: false });
r.dj.djMixz.startFrom = (s, m, min, e) => r.log.push(`startFrom ${s} ${m} ${min} ${e}`);
r.dj.flowMode = { skip: () => r.log.push('skip') };
applyCommand(r.dj, cleanCommand({ a: 'stream', src: 'local', mood: 'sunset', minutes: 30, endless: true }));
applyCommand(r.dj, cleanCommand({ a: 'skip' }));
applyCommand(r.dj, cleanCommand({ a: 'endless', on: true }));
check('a stream order starts DJ MixZ from that music, skip moves on, endless sticks', r.log.includes('startFrom local sunset 30 true') && r.log.includes('skip') && r.dj.djMixz.endless === true);
check('auto play on silence can be switched from the phone', cleanCommand({ a: 'deadair', on: 1 })?.on === true && (() => { r.dj.deadAir = { set: (v) => r.log.push('deadair ' + v) }; applyCommand(r.dj, cleanCommand({ a: 'deadair', on: false })); return r.log.includes('deadair false'); })());
check('a viewer may only listen or ask for the mix link', VIEWER_OK.has('listen') && VIEWER_OK.has('share') && !VIEWER_OK.has('play') && !VIEWER_OK.has('stream') && !VIEWER_OK.has('crossfader'));
check('the sound call has STUN, and any relay carries its login', ICE_SERVERS.some(s => String(s.urls).includes('stun:')) && ICE_SERVERS.filter(s => String(s.urls).includes('turn:')).every(s => s.username && s.credential));
check('the dead free relay is gone', !ICE_SERVERS.some(s => String(s.urls).includes('openrelay.metered.ca')));

// The desk's once-a-second request check, on a fake desk: DJ MixZ is mixing, one request waits.
{
    const tickDesk = (autoPlay) => {
        const played = [];
        const host = {
            relay: {}, autoPlay, requests: new RequestQueue(), _tell() {}, _renderRequests() {},
            dj: { decks: { A: { isPlaying: true, metadata: { metadata: { title: 'On Now', artist: 'X' } } }, B: { isPlaying: false } }, audioRouter: { _lastCrossfadePosition: 0 },
                djMixz: { running: true, human: false, playNext: (t) => { played.push(t.title); return true; } } },
        };
        host.requests.add('p1', { name: 'Ana' }, { id: 'r1', title: 'Asked For', artist: 'Y' });
        RemoteHost.prototype._requestTick.call(host);
        return { played, status: host.requests.items[0].status };
    };
    const off = tickDesk(false);
    check('requests: with AUTO-PLAY off, a waiting request is not put on air by itself', off.played.length === 0 && off.status === 'waiting');
    const on = tickDesk(true);
    check('requests: with AUTO-PLAY on, DJ MixZ takes the oldest one next', on.played.join() === 'Asked For' && on.status === 'next');
}

// The phone's request form says what of the caller is shown, right under the name field
{
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../remote.html', import.meta.url), 'utf8');
    const at = html.indexOf('id="req-name"'), notice = html.indexOf('id="req-shown"');
    check('phone: the request form says the name is shown, next to the name field', at > 0 && notice > at && notice - at < 400 && /your name[^<]*show/i.test(html.slice(notice, notice + 200)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
