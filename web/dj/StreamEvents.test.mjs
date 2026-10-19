// Stream events: the on-air song, handovers and stream health (docs/STREAM-EVENTS.md).
//   node web/dj/StreamEvents.test.mjs
// Runs the real StreamBroadcast with a stand-in BroadcastChannel, so the ON AIR gate is
// tested too, and a fake phone relay.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

const posted = [];
globalThis.BroadcastChannel = class { constructor(name) { this.name = name; } postMessage(m) { posted.push(m); } };
globalThis.document = { getElementById: () => null };

const { StreamBroadcast } = await import('./StreamBroadcast.js');
const { StreamEvents, envelope, trackData, EVENT_VERSION, HEALTH_EVERY_MS } = await import('./StreamEvents.js');

const AUDIO = 'https://discoveryprovider.audius.co/v1/tracks/abc/stream?app_name=zaomixz';
const deck = (id, title, extra = {}) => ({
    id, isPlaying: false, getCurrentTime: () => 12,
    metadata: { metadata: { id: `${id}-${title}`, title, artist: 'IMan Afrikah', permalink: '/iman/' + title.toLowerCase() }, audio_files: { mp3: AUDIO }, _source: 'audius' },
    licence: { holder: 'IMan Afrikah, through Audius', uses: { stream: true, dj: true, radio: true, commercial: false } },
    ...extra,
});

function desk() {
    posted.length = 0;
    let t = 1000;
    const relayed = [];
    const dj = {
        decks: { A: deck('A', 'Rude Boy'), B: deck('B', 'Second Song') },
        audioRouter: { _lastCrossfadePosition: 0, ctx: { state: 'running' } },
        deadAir: { on: true, silentSince: 0 },
        flowMode: { _transitioning: false },
        remote: { sendEvent: (env) => relayed.push(env) },
    };
    dj.broadcast = new StreamBroadcast(dj.audioRouter, null);
    const ev = new StreamEvents(dj, { now: () => t, every: 0 });
    return { dj, ev, relayed, advance: (ms) => { t += ms; }, events: () => posted.filter((m) => m.v === EVENT_VERSION), legacy: (type) => posted.filter((m) => m.type === type) };
}

console.log('Stream events: the envelope and what a track event carries');
check('envelope is { v, type, at, seq, data }', JSON.stringify(Object.keys(envelope('track.changed', {}, 1, 5))) === JSON.stringify(['v', 'type', 'at', 'seq', 'data']));
const td = trackData(deck('A', 'IMan Afrikah - Rude Boy'));
check('title is cleaned of the "Artist - " prefix', td.title === 'Rude Boy' && td.artist === 'IMan Afrikah');
check('licence holder and radio say who it belongs to', td.licence.holder === 'IMan Afrikah, through Audius' && td.licence.radio === true);
check('the link is the public song page', td.link === 'https://audius.co/iman/iman afrikah - rude boy');
check('the deck\'s audio URL is never in the event', !JSON.stringify(td).includes('discoveryprovider') && !JSON.stringify(td).includes('app_name'));

console.log('Stream events: nothing goes out while off air');
{
    const { dj, ev, relayed } = desk();
    dj.decks.A.isPlaying = true;
    ev.tick();
    check('off air: nothing posted to overlays, nothing relayed', posted.length === 0 && relayed.length === 0);
    dj.broadcast.isLive = true;
    ev.tick();
    check('a song that started before GO LIVE is announced the moment the desk goes live', posted.some((m) => m.type === 'track.changed' && m.data.title === 'Rude Boy') && relayed.some((e) => e.type === 'track.changed'));
}

console.log('Stream events: the song on air, not the song loading');
{
    const { dj, ev, relayed, events, legacy, advance } = desk();
    dj.decks.A.isPlaying = true;
    dj.broadcast.isLive = true;
    ev.tick();
    const tc = events().filter((e) => e.type === 'track.changed');
    check('on GO LIVE the song on air is announced as track.changed', tc.length === 1 && tc[0].data.deck === 'A' && tc[0].data.title === 'Rude Boy');
    check('the overlays\' "now playing" line gets the on-air title', legacy('now_playing').length === 1 && legacy('now_playing')[0].title === 'Rude Boy');
    check('and their deck card gets it too', legacy('track_update').some((m) => m.deck === 'A' && m.metadata.title === 'Rude Boy'));
    check('stream.health goes out with it', events().some((e) => e.type === 'stream.health' && e.data.live === true && e.data.audio === 'running'));
    check('the same events go off the machine over the relay', relayed.some((e) => e.type === 'track.changed') && relayed.length === events().length);
    const before = events().length;
    ev.tick();
    check('nothing new, nothing sent', events().length === before);
    dj.decks.B.metadata.metadata.title = 'Loading Now';
    ev.tick();
    check('a song loading on the other deck is not announced as on air', events().filter((e) => e.type === 'track.changed').length === 1);
    dj.decks.B.isPlaying = true; dj.audioRouter._lastCrossfadePosition = 1; ev.tick();
    dj.decks.A.isPlaying = false; ev.tick();
    const last = events().filter((e) => e.type === 'track.changed').pop();
    check('when the crossfader hands over, deck B\'s song is announced', last.data.deck === 'B' && last.data.title === 'Loading Now');
    check('seq goes up by one per event', events().every((e, i, all) => i === 0 || e.seq === all[i - 1].seq + 1));
    const healthBefore = events().filter((e) => e.type === 'stream.health').length;
    advance(HEALTH_EVERY_MS); ev.tick();
    check('stream.health repeats every five seconds', events().filter((e) => e.type === 'stream.health').length === healthBefore + 1);
    dj.flowMode._transitioning = true; ev.tick();
    check('and goes out at once when something changes', events().filter((e) => e.type === 'stream.health').pop().data.loading === true);
}

console.log('Stream events: handovers');
{
    const { dj, ev, events, relayed } = desk();
    dj.broadcast.isLive = true;
    ev.handover('started', { from: 'A', to: 'B', type: 'blend', seconds: 8, why: 'same key family, long blend', title: 'Second Song' });
    ev.handover('finished', { outcome: 'mixed', title: 'Second Song', reason: null });
    const types = events().map((e) => e.type);
    check('a handover is transition.started then transition.finished', types.join() === 'transition.started,transition.finished');
    check('with the move and its reason, and the outcome', events()[0].data.why === 'same key family, long blend' && events()[1].data.outcome === 'mixed');
    check('also relayed', relayed.length === 2);
    check('an unknown event type is not sent', ev.emit('deck.load', { anything: 1 }) === null && events().length === 2);
}

console.log('Stream events: advice said off air is sent at GO LIVE');
{
    const { dj, ev, events } = desk();
    ev.emit('director.advice', { next: { title: 'Next Up', why: 'fits' }, alts: [] });
    check('off air the advice goes nowhere', events().length === 0);
    dj.broadcast.isLive = true; ev.tick();
    check('at GO LIVE the latest advice goes out', events().some((e) => e.type === 'director.advice' && e.data.next.title === 'Next Up'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
