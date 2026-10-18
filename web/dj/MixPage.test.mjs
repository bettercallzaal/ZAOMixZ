// node web/dj/MixPage.test.mjs
import { buildMix, mixEntry, encodeMix, decodeMix, mixUrl, mixFromHash, scId, mixLength, resolveTracks, packHex, unpackHex, MIX_VERSION } from './MixPage.js';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

console.log('MixPage');
const t0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const history = [
    { title: 'IMan Afrikah - RUDE BOY', artist: 'IMan Afrikah', src: 'songchainn', sid: 'songchainn:94e4377c-bb84-4bea-8b3f-324e1aded3e5', startTime: t0, durationPlayed: 212.4 },
    { title: 'Jewellry', artist: 'C3DDC3SSION', src: 'audius', sid: 'D7KyD', startTime: t0 + 212000, durationPlayed: 180 },
    { title: 'my_demo.mp3', artist: '', src: 'local', sid: 'data/my_demo.json', startTime: t0 + 392000, durationPlayed: null },
];
const mix = buildMix(history, { name: 'Tuesday on the bus', dj: 'Zaal' });
check('a SongChainn song is kept as its id only, dashes dropped', mix.t[0][0] === 'sc' && mix.t[0][1] === '94e4377cbb844bea8b3f324e1aded3e5' && mix.t[0][2] === 0 && mix.t[0][3] === 212);
check('an Audius track is kept as its id and when it played', mix.t[1].join() === 'au,D7KyD,212,180');
check('a local file keeps a clean title and artist', mix.t[2][0] === 'lo' && mix.t[2][1] === 'my demo' && mix.t[2][3] === 392);
check('name, dj and the date of the first track travel with it', mix.n === 'Tuesday on the bus' && mix.dj === 'Zaal' && mix.d === '2026-10-14T12:00' && mix.v === MIX_VERSION);

const enc = encodeMix(mix);
check('the link holds only characters that survive a chat message', /^[A-Za-z0-9_\-.%;,:!~*'()]+$/.test(enc) && !/\s/.test(enc));
check('the link opens back to the same mix', JSON.stringify(decodeMix(enc)) === JSON.stringify(mix));
check('a SongChainn id packs to 22 characters and back', packHex('94e4377cbb844bea8b3f324e1aded3e5').length === 22 && unpackHex(packHex('94e4377cbb844bea8b3f324e1aded3e5')) === '94e4377cbb844bea8b3f324e1aded3e5' && unpackHex(packHex('ffffffffffffffffffffffffffffffff')) === 'ffffffffffffffffffffffffffffffff' && unpackHex(packHex('00000000000000000000000000000000')) === '00000000000000000000000000000000');
check('text with ; , and unicode survives the trip', decodeMix(encodeMix({ v: 1, n: 'Zaal; on the bus, 🚌', dj: 'Zaal', d: '2026-10-14T12:00', t: [['lo', 'A, B; C', 'D;E', 1, 2]] })).t[0].join() === 'lo,A, B; C,D;E,1,2,' && decodeMix(encodeMix({ v: 1, n: 'Zaal; on the bus, 🚌', dj: '', d: '', t: [] })).n === 'Zaal; on the bus, 🚌');
check('a shipped file keeps its data path, anything else is dropped', mix.t[2][5] === 'data/my_demo.json' && mixEntry({ title: 'x', src: 'local', sid: 'C:/Users/me/song.json' })[5] === '' && decodeMix('1;;;;lx,,0,0,..%2F..%2Fetc').t[0][5] === '');
check('the full link is built on mix.html', mixUrl('https://zaomixz.vercel.app/', mix) === `https://zaomixz.vercel.app/mix.html#m=${enc}` && mixFromHash(`#m=${enc}`)?.n === mix.n);
check('a broken or foreign link is refused', decodeMix('not a mix') === null && decodeMix('99;;;') === null && decodeMix('1;a;b') === null && decodeMix('') === null && mixFromHash('#setlist=abc') === null);
check('unknown or short entries are dropped on the way in', decodeMix('1;;;;zq,1;sdeadbeef,0;sdeadbeef,0,0;lonly,one').t.length === 1);

check('the link is version 2: no ; , or : in it', enc.startsWith('2.2610141200.') && !/[;,:]/.test(enc));
const v1 = '1;;;2026-10-18T12%3A13;a2AYk2X0,0,653;amOdAE2,15,466';
check('a version 1 link from before still opens', decodeMix(v1)?.t.length === 2 && decodeMix(v1).t[1].join() === 'au,mOdAE2,15,466');
const skipped = buildMix([
    { title: 'Kept', artist: 'A', src: 'audius', sid: 'x1', startTime: t0, durationPlayed: 300 },
    { title: 'Skipped', artist: 'A', src: 'audius', sid: 'x2', startTime: t0 + 300000, durationPlayed: 3 },
    { title: 'Loaded only', artist: 'A', src: 'audius', sid: 'x3', startTime: t0 + 303000, durationPlayed: 0 },
    { title: 'Playing now', artist: 'A', src: 'audius', sid: 'x4', startTime: t0 + 304000, durationPlayed: 0 },
]);
check('songs skipped in under 20 seconds leave the mix, the one playing stays', skipped.t.map((e) => e[1]).join() === 'x1,x4');
const blend = { v: 1, n: 'a.b~c', dj: '', d: '2026-10-18T12:13', t: [['au', 'p', 0, 100], ['au', 'q', 90, 50], ['au', 'r', 200, 0], ['lo', 'T.x', 'A~y', 200, 5, 'data/t.json']] };
check('overlaps, gaps, dots and tildes all come back exactly', JSON.stringify(decodeMix(encodeMix(blend))) === JSON.stringify(blend));
const zaal = buildMix(Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i, artist: 'A', src: 'audius', sid: 'aB3dE' + i, startTime: t0 + i * 100000, durationPlayed: i % 2 ? 2 : 300 })));
check('a 20 song night with half skipped makes a link under 260 characters', zaal.t.length === 11 && mixUrl('https://zaomixz.vercel.app', zaal).length < 260);

const big = buildMix(Array.from({ length: 30 }, (_, i) => ({ title: 'T' + i, artist: 'A', src: 'songchainn', sid: 'songchainn:94e4377c-bb84-4bea-8b3f-324e1aded3e5', startTime: t0 + i * 200000, durationPlayed: 200 })), { name: 'A long night', dj: 'Zaal' });
check('thirty SongChainn songs fit in a Telegram message (under 2,000 characters)', mixUrl('https://zaomixz.vercel.app', big).length < 2000);

check('the id goes back to its SongChainn form', scId('94e4377cbb844bea8b3f324e1aded3e5') === '94e4377c-bb84-4bea-8b3f-324e1aded3e5' && scId('D7KyD') === 'D7KyD');
check('mix length runs to the end of the last track', mixLength(mix) === 392 + 180 && mixLength({ t: [] }) === 0);
check('an entry with no start time still lands at 0', mixEntry({ title: 'x', src: 'local' }, undefined)[3] === 0);

// Looking the songs up again, with a pretend network
const calls = [];
const fakeFetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.audius.co')) return { ok: true, json: async () => ({ data: ['https://dp.example'] }) };
    if (url.includes('songchainn_public_songs')) return { ok: true, json: async () => [{ id: '94e4377c-bb84-4bea-8b3f-324e1aded3e5', title: 'IMan Afrikah - RUDE BOY', artist_name: 'IMan Afrikah', cover_art_url: 'https://x/c.jpg', audio_url: 'https://x/a.mp3' }] };
    if (url.includes('/v1/tracks/D7KyD?')) return { ok: true, json: async () => ({ data: { title: 'Jewellry', user: { name: 'C3DDC3SSION' }, artwork: { '150x150': 'https://x/j.jpg' }, permalink: '/c3/jewellry' } }) };
    if (url === 'https://zaomixz.vercel.app/data/my_demo.json') return { ok: true, json: async () => ({ metadata: { title: 'My demo' }, audio_files: { mp3: 'music/my_demo.mp3' } }) };
    return { ok: false, json: async () => ({}) };
};
const tracks = await resolveTracks(decodeMix(enc), fakeFetch, 'https://zaomixz.vercel.app/');
check('SongChainn songs come back with title, artist, cover and stream, title cleaned', tracks[0].title === 'RUDE BOY' && tracks[0].artist === 'IMan Afrikah' && tracks[0].art === 'https://x/c.jpg' && tracks[0].stream === 'https://x/a.mp3');
check('Audius tracks come back with their page and stream', tracks[1].title === 'Jewellry' && tracks[1].page === 'https://audius.co/c3/jewellry' && tracks[1].stream === 'https://dp.example/v1/tracks/D7KyD/stream?app_name=ZAOMixZ');
check('a file the app ships with plays from the site itself', tracks[2].title === 'my demo' && tracks[2].stream === 'https://zaomixz.vercel.app/music/my_demo.mp3' && tracks[2].page === null);
const own = await resolveTracks({ v: 1, t: [['lo', 'Private', 'Me', 0, 0, '']] }, fakeFetch);
check('a file only the DJ has is listed with nothing to play', own[0].title === 'Private' && own[0].stream === null);
check('all SongChainn songs are fetched in one request', calls.filter((u) => u.includes('songchainn_public_songs')).length === 1 && calls.some((u) => u.includes('id=in.(94e4377c-bb84-4bea-8b3f-324e1aded3e5)')));
const hostile = await resolveTracks({ v: 1, t: [['au', 'D7KyD', 0, 0]] }, async (url) => (url.startsWith('https://api.audius.co') ? { ok: true, json: async () => ({ data: ['https://dp.example'] }) } : { ok: true, json: async () => ({ data: { title: 'T', user: { name: 'U' }, permalink: '@other.example/x' } }) }));
check('an Audius permalink that points at another host gives no page link', hostile[0].title === 'T' && hostile[0].page === null);
const gone = await resolveTracks({ v: 1, t: [['sc', 'deadbeefdeadbeefdeadbeefdeadbeef', 0, 0]] }, async () => ({ ok: true, json: async () => [] }));
check('a song that is no longer public says so instead of breaking the page', gone[0].title.includes('no longer public'));
const offline = await resolveTracks({ v: 1, t: [['sc', 'deadbeefdeadbeefdeadbeefdeadbeef', 0, 0], ['au', 'x', 0, 0]] }, async () => { throw new Error('offline'); });
check('with no network the page still lists every slot', offline.length === 2 && offline.every((t) => t.title));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
