// Offline check of DJ MixZ's set planning.   node web/dj/DjMixz.test.mjs
import { planSet, planTransition, energyOf, MOODS, tracksFrom, tracksForMinutes, uptempo } from './DjMixz.js';
import { hornPattern } from './Airhorn.js';
import { HarmonicMixer } from './HarmonicMixer.js';

const h = new HarmonicMixer();
let fail = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fail += 1; };

// A 14-track playlist across tempos, keys and genres
const T = (id, bpm, key, genre, artist = 'A' + (id % 5)) => ({ id, title: 'T' + id, artist, bpm, key, genre, streamUrl: 'x' });
const pool = [
    T(1, 92, 'A minor', 'Lo-Fi'), T(2, 98, 'E minor', 'R&B'), T(3, 104, 'A minor', 'Hip-Hop'), T(4, 110, 'C major', 'Pop'),
    T(5, 118, 'G major', 'Disco'), T(6, 122, 'E minor', 'House'), T(7, 124, 'B minor', 'House'), T(8, 126, 'D major', 'Tech House'),
    T(9, 128, 'A major', 'Techno'), T(10, 130, 'F# minor', 'Techno'), T(11, 140, 'F minor', 'Dubstep'), T(12, 172, 'A minor', 'Drum & Bass'),
    T(13, 100, 'F major', 'Tribe Bass'), T(14, 81, 'C# major', 'Hip-Hop'),
];
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const thirds = (plan) => { const n = Math.floor(plan.length / 3); return [avg(plan.slice(0, n).map((p) => p.energy)), avg(plan.slice(n, 2 * n).map((p) => p.energy)), avg(plan.slice(-n).map((p) => p.energy))]; };

ok('energy: drum and bass hits harder than lo-fi; half-time hip-hop is not read as slow', energyOf(pool[11]) > 0.8 && energyOf(pool[0]) < 0.4 && energyOf(pool[13]) > 0.5);

const warm = planSet(pool, 'warmup', h);
const [w1, , w3] = thirds(warm);
ok('warm up: every track once, energy rises from the first third to the last', warm.length === 14 && new Set(warm.map((p) => p.track.id)).size === 14 && w3 > w1 + 0.1);

const sun = planSet(pool, 'sunset', h);
const [s1, , s3] = thirds(sun);
ok('sunset: energy falls', s1 > s3 + 0.1);

const jour = planSet(pool, 'journey', h);
const peakAt = jour.map((p) => p.energy).indexOf(Math.max(...jour.map((p) => p.energy))) / (jour.length - 1);
ok('journey: the peak lands in the back half, not at the very end', peakAt > 0.45 && peakAt < 0.98 && jour[jour.length - 1].energy < Math.max(...jour.map((p) => p.energy)));

ok('set length: maxTracks trims the set', planSet(pool, 'peak', h, { maxTracks: 6 }).length === 6);
ok('first track has no move in; every other track does', warm[0].move === null && warm.slice(1).every((p) => p.move && p.move.seconds > 0 && p.move.why));

const blend = planTransition(T(20, 124, 'A minor', 'House'), T(21, 125, 'E minor', 'House'), h);
ok('keys fit and tempo close: a long blend, in bars, 5 to 10 s', blend.type === 'blend' && blend.bars >= 16 && blend.seconds >= 5 && blend.seconds <= 10);
const clashHi = planTransition(T(22, 128, 'A minor', 'Techno'), T(23, 128, 'F# major', 'Techno'), h);
const clashLo = planTransition(T(24, 96, 'A minor', 'Lo-Fi'), T(25, 96, 'F# major', 'Lo-Fi'), h);
ok('keys clash: a cut when the energy is high, an echo out when it is low', clashHi.type === 'cut' && clashLo.type === 'echo-out');
ok('tempo gap of 5 to 8 percent: filter sweep', planTransition(T(26, 120, 'A minor', 'House'), T(27, 128, 'A minor', 'House'), h).type === 'filter-sweep');
ok('never the same move three times running', planTransition(T(28, 124, 'A minor', 'House'), T(29, 124, 'A minor', 'House'), h, ['blend', 'blend']).type !== 'blend');
const runs = warm.slice(1).map((p) => p.move.type);
ok('a planned set never has three identical moves in a row', !runs.some((t, i) => i >= 2 && runs[i - 1] === t && runs[i - 2] === t));
ok('duplicates in the playlist are played once', planSet([...pool, ...pool], 'party', h).length === 14);
const sc = (id, artist) => ({ id: 'songchainn:' + id, title: 'S' + id, artist, source: 'songchainn', streamUrl: 'x', bpm: null, key: null, duration: 0 });
const lib = { zaoTracks: [sc(1, 'IMan Afrikah'), sc(2, 'N3M3SIS'), sc(3, 'IMAN AFRIKAH ft SANTANA'), { id: 9, title: 'Audius one', artist: 'IMan Afrikah', source: 'audius', streamUrl: 'x' }, { id: 10, title: 'broken', artist: 'X', source: 'songchainn' }], tracks: pool.slice(0, 3), _displayedTracks: pool.slice(0, 2) };
ok('pointed at SongChainn: only SongChainn songs, and only ones that can play', tracksFrom(lib, 'songchainn').length === 3 && tracksFrom(lib, 'songchainn').every((t) => t.source === 'songchainn'));
ok('SongChainn, one artist: features count, other artists do not', tracksFrom(lib, 'songchainn-artist', 'iman afrikah').map((t) => t.id).join() === 'songchainn:1,songchainn:3' && tracksFrom(lib, 'songchainn-artist', '').length === 0);
ok('SongChainn, several artists: songs by any of them, nobody else', tracksFrom(lib, 'songchainn-artist', ['N3M3SIS', 'iman afrikah']).map((t) => t.id).join() === 'songchainn:1,songchainn:2,songchainn:3' && tracksFrom(lib, 'songchainn-artist', []).length === 0 && tracksFrom(lib, 'songchainn-artist', ['N3M3SIS']).length === 1);
ok('the other sources still work', tracksFrom(lib, 'zao').length === 4 && tracksFrom(lib, 'local').length === 3 && tracksFrom(lib, 'view').length === 2);
const jg = (id) => ({ id: 'j' + id, title: 'J' + id, artist: 'Jango UU', source: 'audius', streamUrl: 'x' });
ok('JANGO: only Jango UU songs, and only ones that can play', tracksFrom({ ...lib, jangoTracks: [jg(1), jg(2), { id: 'j3', title: 'no stream', artist: 'Jango UU' }] }, 'jango').map((t) => t.id).join() === 'j1,j2');
ok('JANGO not read yet: an empty pool, never the library view', tracksFrom(lib, 'jango').length === 0);
const hs = (id) => ({ id: 'h' + id, title: 'H' + id, artist: 'A' + id, source: 'audius', streamUrl: 'x' });
ok('HOUSE: the set pool, and only songs that can play', tracksFrom({ ...lib, houseTracks: [hs(1), hs(2), { id: 'h3', title: 'no stream', artist: 'A3' }] }, 'house').map((t) => t.id).join() === 'h1,h2');
ok('HOUSE not read yet: an empty pool, never the library view', tracksFrom(lib, 'house').length === 0);
const many = Array.from({ length: 200 }, (_, i) => sc(100 + i, 'A' + (i % 9)));
ok('session length: 1 hour of SongChainn is about 19 tracks, 4 hours about 75, never more than there are', tracksForMinutes(many, 60) === 19 && tracksForMinutes(many, 240) === 75 && tracksForMinutes(many.slice(0, 10), 240) === 10 && tracksForMinutes(many, 0) === 200);
ok('session length uses real track lengths when the library has them', tracksForMinutes(Array.from({ length: 50 }, (_, i) => ({ id: i, duration: 120 })), 60) === 34);
ok('a SongChainn set with no tempo or key on file still plans, every track once', planSet(many, 'journey', h, { maxTracks: 19 }).length === 19 && new Set(planSet(many, 'journey', h, { maxTracks: 19 }).map((p) => p.track.id)).size === 19);
ok('five moods', MOODS.length === 5);
// Party: tempo rides, stem swaps, echo outs, air horn
const P = (a, b, prev = []) => planTransition(a, b, h, prev, { party: true });
const ride = P(T(40, 120, 'A minor', 'Afro'), T(41, 132, 'A minor', 'Afro'));
ok('party: 10% apart, same key, rides the tempo with a stem swap', ride.type === 'stem-swap' && ride.tempoRide === true);
ok('party: keys clash, echo out with the air horn', P(T(42, 120, 'A minor', 'Afro'), T(43, 121, 'F# major', 'Afro')).type === 'echo-out' && !!P(T(42, 120, 'A minor', 'Afro'), T(43, 121, 'F# major', 'Afro')).airhorn);
ok('party: 25% apart, echo out, no tempo ride', P(T(44, 100, 'A minor', 'Afro'), T(45, 125, 'A minor', 'Afro')).type === 'echo-out' && !P(T(44, 100, 'A minor', 'Afro'), T(45, 125, 'A minor', 'Afro')).tempoRide);
ok('party: no tempo on file, stem swap and blend take turns', P(T(46, null, null, ''), T(47, null, null, '')).type === 'stem-swap' && P(T(46, null, null, ''), T(47, null, null, ''), ['stem-swap']).type === 'blend');
ok('party: moves are short (20 seconds at most)', [ride, P(T(48, 70, 'A minor', 'Reggae'), T(49, 72, 'A minor', 'Reggae'))].every((m) => m.seconds <= 20));
const partySet = planSet(pool, 'party', h);
ok('party set: the air horn goes on about every other move', partySet.filter((p) => p.move?.airhorn).length >= Math.floor((partySet.length - 1) / 2));
ok('party set: never three identical moves in a row', !partySet.slice(1).map((p) => p.move.type).some((t, i, r) => i >= 2 && r[i - 1] === t && r[i - 2] === t));
ok('other moods never use the party moves', planSet(pool, 'journey', h).every((p) => !p.move || (p.move.type !== 'stem-swap' && !p.move.airhorn)));
const mixed = [T(60, 85, 'A minor', 'Reggae'), T(61, 128, 'A minor', 'House'), T(62, 124, 'A minor', 'Afro'), T(63, null, null, ''), T(64, 70, 'A minor', 'Lo-Fi'), T(65, 132, 'A minor', 'House'), T(66, 72, 'A minor', 'Trap')];
const up = uptempo(mixed).map((t) => t.id);
ok('party: slow songs out, half-time trap counts as fast, only known-fast songs when there are enough', !up.includes(60) && !up.includes(64) && [61, 62, 65, 66].every((id) => up.includes(id)) && !up.includes(63));
ok('party: songs not analyzed yet fill in when the known-fast ones are too few for the set', uptempo(mixed, 8).map((t) => t.id).includes(63) && !uptempo(mixed, 8).map((t) => t.id).includes(60));
ok('party: an all-slow list still plays its fastest half', uptempo([T(70, 80, 'A minor', 'Reggae'), T(71, 90, 'A minor', 'Soul'), T(72, 70, 'A minor', 'Lo-Fi'), T(73, 85, 'A minor', 'Jazz')]).length === 2);
ok('party energy never dips below 0.75', Array.from({ length: 21 }, (_, i) => MOODS.find((m) => m.id === 'party').curve(i / 20)).every((e) => e >= 0.75));
ok('the horn: three full blasts in one take, and the old short-short-long is still there as stabs', hornPattern().length === 3 && hornPattern().every((b) => b.len > 0.9) && hornPattern('stabs')[2].len > hornPattern('stabs')[0].len * 3);


console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
