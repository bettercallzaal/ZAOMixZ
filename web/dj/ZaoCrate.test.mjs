// Offline check of the off-air list.   node web/dj/ZaoCrate.test.mjs
import { OFF_AIR, songKey, artistOffAir, offAirTrack, ONLY_SONGS, JANGO_AUDIUS, jangoSongs, ZaoCrate, HOUSE_SET, houseSongs } from './ZaoCrate.js';

const off = new Set(OFF_AIR);
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const isOff = (t) => off.has(songKey(t));

check(OFF_AIR.length === 28, `28 songs off air (${OFF_AIR.length})`);
check(isOff({ artist: 'NDA', title: 'STILL' }), 'NDA - Still (the YouTube claim) is off');
check(isOff({ artist: 'NDA', title: "CAN'T MATCH" }), "NDA - Can't Match is off");
check(isOff({ artist: 'NDA', title: 'Shadow Work' }), 'NDA Vol 1 is off');
check(isOff({ artist: '7ROO7H', title: "Eve's Daughter (Alt Mix)" }), '7ROO7H Vol 1 alt mix is off');
check(isOff({ artist: 'WaveWarZ Africa', title: '7ROO7H - DISCORD' }), 'a Vol 2 song posted by WaveWarZ Africa on Audius is off');
check(isOff({ artist: 'WaveWarZ Africa', title: "7ROO7H - Eve's Daughter" }), 'Vol 1 on Audius is off');
check(!isOff({ artist: 'NDA', title: 'STILL WATCHING' }), 'NDA Vol 6 "Still Watching" stays');
check(!isOff({ artist: 'NDA', title: '4.44' }), 'NDA Vol 5 stays');
check(!isOff({ artist: '7ROO7H', title: 'TWEAKING' }), '7ROO7H Vol 3 stays');
check(!isOff({ artist: 'WaveWarZ Africa', title: '7ROO7H - THE SUMO WRESLER' }), 'later 7ROO7H on Audius stays');
check(!isOff({ artist: 'T3RNNN & 7ROO7H', title: 'MuLiLow' }), 'the T3RNNN collab stays');
check(!isOff({ artist: 'IMan Afrikah', title: 'Money' }), 'another artist with the same song name stays');
check(artistOffAir({ artist: 'Geezy2126', title: 'GEEZY2126 & THEE LEASONS Go Getter' }), 'Geezy2126 is off');
check(artistOffAir({ artist: 'WaveWarZ Africa', title: 'Geezy2126 - Anything' }), 'Geezy2126 posted from another account is off');
check(!artistOffAir({ artist: 'IMan Afrikah', title: 'Lusaka Nights' }), 'other artists stay');
check(artistOffAir({ artist: 'NDA', title: 'B.T.T.B' }), 'NDA B.T.T.B (YouTube claim 28 Oct) is off');
check(artistOffAir({ artist: 'NDA', title: 'BOSSED UP' }), 'NDA Bossed Up (YouTube claim 28 Oct) is off');
check(artistOffAir({ artist: 'WaveWarZ Africa', title: 'NDA - PREACH' }), 'NDA posted by WaveWarZ Africa is off');
check(artistOffAir({ artist: 'NDA x Geezy2126', title: 'Anything' }), 'an NDA collab is off');
check(artistOffAir({ artist: 'WaveWarZ Africa', title: 'Camstar & Krytic Ft Dagger - Flip ' }), 'Flip (TuneCore claim 28 Oct) is off');
check(!artistOffAir({ artist: 'Santana', title: 'SUNDAY' }), '"nda" inside another word stays');
check(!artistOffAir({ artist: 'Amanda', title: 'Rwanda - Home' }), 'Amanda and Rwanda stay');

// N3M3SIS: only the songs named in ONLY_SONGS play (Zaal, 29 Oct: no diss songs)
const nemKeep = ONLY_SONGS.n3m3sis;
check(offAirTrack({ artist: 'N3M3SIS', title: 'LUI WHO?' }) === !nemKeep.includes('luiwho'), 'N3M3SIS songs not on her list are off');
check(offAirTrack({ artist: 'WaveWarZ Africa', title: 'N3M3SIS - THE CALL OUT' }) === !nemKeep.includes('thecallout'), 'an N3M3SIS song posted from another account follows the same list');
check(!offAirTrack({ artist: 'IMan Afrikah', title: 'ROYALTY' }), 'IMan songs stay');
check(offAirTrack({ artist: 'NDA', title: 'Still' }), 'offAirTrack covers the NDA rule too');

// JANGO: Jango UU's Audius page, ready to play
const J = (id, title, extra = {}) => ({ id, title, artist: 'Jango UU', source: 'audius', streamUrl: 'https://x/' + id, ...extra });
check(JANGO_AUDIUS.id === 'k2YadvK' && JANGO_AUDIUS.handle === 'jango.uu', 'Jango is Audius user k2YadvK, handle jango.uu');
const js = jangoSongs([J('1', 'NEIL'), J('1', 'NEIL'), J('2', 'Gated', { streamable: false }), J('3', 'No link', { streamUrl: '' }), J('4', 'Neil'), J('5', 'Other'), null]);
check(js.map((t) => t.id).join() === '1,5', 'jangoSongs keeps streamable songs once each (' + js.map((t) => t.id).join() + ')');
check(jangoSongs(undefined).length === 0 && jangoSongs([]).length === 0, 'no answer from Audius gives no songs, not an error');
const fakeLib = {};
let calls = 0;
const fake = { dj: { library: fakeLib, audius: { getUserIdTracks: async (id) => { calls++; return id === 'k2YadvK' ? [J('7', 'A'), J('8', 'B')] : []; } } } };
const [l1, l2] = await Promise.all([ZaoCrate.prototype.loadJango.call(fake), ZaoCrate.prototype.loadJango.call(fake)]);
check(l1.length === 2 && l2.length === 2 && fakeLib.jangoTracks.length === 2 && calls === 1, 'loadJango fills lib.jangoTracks with one read, even when asked twice at once');
await ZaoCrate.prototype.loadJango.call(fake);
check(calls === 1, 'loadJango keeps what it read');
const down = { dj: { library: {}, audius: { getUserIdTracks: async () => { throw new Error('offline'); }, getUserTracks: async () => [] } } };
check((await ZaoCrate.prototype.loadJango.call(down)).length === 0 && !down.dj.library.jangoTracks, 'Audius down: an empty list, nothing cached');

// HOUSE: the WaveWarZ house set (ZAOresearch 2484), in set order
const H = (id, extra = {}) => { const s = HOUSE_SET.tracks.find((t) => t.id === id); return { id, title: s.title, artist: s.artist, source: 'audius', streamUrl: 'https://x/' + id, ...extra }; };
check(HOUSE_SET.tracks.length === 16 && new Set(HOUSE_SET.tracks.map((t) => t.id)).size === 16 && new Set(HOUSE_SET.tracks.map((t) => t.artist)).size === 16, 'the house set is 16 songs, 16 ids, 16 artists');
check(HOUSE_SET.tracks.every((t, i, a) => i === 0 || a[i - 1].bpm <= t.bpm) && HOUSE_SET.tracks[0].bpm >= 112 && HOUSE_SET.tracks[15].bpm <= 128, 'the set runs 112 to 128 BPM in order');
const hsongs = houseSongs([H('o6EJ5Kd'), H('W0V7J0'), H('AVQjBJq', { streamable: false }), H('Waar7EZ', { streamUrl: '' }), { id: 'zzz', title: 'Not in the set', artist: 'X', source: 'audius', streamUrl: 'y' }, null]);
check(hsongs.map((t) => t.id).join() === 'W0V7J0,o6EJ5Kd', 'houseSongs keeps the set order, drops gated, linkless and off-set songs (' + hsongs.map((t) => t.id).join() + ')');
check(hsongs[0].bpm === 114 && houseSongs([H('W0V7J0', { bpm: 113.5 })])[0].bpm === 113.5, 'the set tempo fills in when Audius has none, Audius wins when it does');
check(houseSongs(undefined).length === 0 && houseSongs([]).length === 0, 'no answer from Audius gives no songs, not an error');
const hLib = {};
let hCalls = 0;
const hFake = { dj: { library: hLib, audius: { getTracksByIds: async (ids) => { hCalls++; return ids.length === 16 ? [H('W0V7J0'), H('AVQjBJq')] : []; } } } };
const [h1, h2] = await Promise.all([ZaoCrate.prototype.loadHouse.call(hFake), ZaoCrate.prototype.loadHouse.call(hFake)]);
check(h1.length === 2 && h2.length === 2 && hLib.houseTracks.length === 2 && hCalls === 1, 'loadHouse asks Audius for all 16 ids once and fills lib.houseTracks');
const hDown = { dj: { library: {}, audius: { getTracksByIds: async () => { throw new Error('offline'); } } } };
check((await ZaoCrate.prototype.loadHouse.call(hDown)).length === 0 && !hDown.dj.library.houseTracks, 'Audius down: an empty list, nothing cached');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all passed');
