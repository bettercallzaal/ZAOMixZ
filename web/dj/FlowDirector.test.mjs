// The Flow Director: why this song next, and what else would fit.
//   node web/dj/FlowDirector.test.mjs
import { rankNext, reasonsFor, advise, REQUEST_CAP } from './FlowDirector.js';
import { HarmonicMixer } from './HarmonicMixer.js';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
const h = new HarmonicMixer();
const T = (id, bpm, key, genre, artist = 'Artist ' + id) => ({ id, title: 'T' + id, artist, bpm, key, genre, streamUrl: 'x' });

const now = T(1, 124, 'A minor', 'House');
const fits = T(2, 125, 'E minor', 'House');       // keys and tempo sit together, house energy
const clash = T(3, 124, 'F# major', 'House');     // same tempo, clashing key
const slow = T(4, 92, 'A minor', 'Lo-Fi');        // same key, far too quiet for a house slot
const target = 0.72;

console.log('Flow Director: ranking the next slot');
const ranked = rankNext({ current: now, candidates: [clash, slow, fits], target, harmonic: h });
check('the song that fits on energy, key and tempo ranks first', ranked[0].track === fits);
check('a key clash and an energy drop both rank below it', ranked.findIndex((r) => r.track === clash) > 0 && ranked.findIndex((r) => r.track === slow) > 0);
check('the song playing now is never a candidate', !rankNext({ current: now, candidates: [now, fits], target, harmonic: h }).some((r) => r.track === now));

console.log('Flow Director: reasons in plain words');
const why = reasonsFor(now, fits, target, h);
check('it says the energy, key and tempo', why.some((w) => w.startsWith('energy')) && why.some((w) => w.includes('key')) && why.some((w) => w.startsWith('tempo matches')));
check('a clash is called a clash', reasonsFor(now, clash, target, h).includes('keys clash'));
check('a quiet song in a busy slot is called out', reasonsFor(now, slow, target, h).includes('energy much lower than the curve wants'));
check('same artist twice is mentioned', reasonsFor(now, T(9, 124, 'A minor', 'House', now.artist), target, h).includes('same artist as now'));

console.log('Flow Director: listener requests');
const near = T(5, 126, 'A minor', 'House');
const plain = rankNext({ current: now, candidates: [fits, near], target, harmonic: h });
const asked = rankNext({ current: now, candidates: [fits, near], target, harmonic: h, requests: [{ track: plain[1].track, count: 3 }] });
check('three requests lift a close second to first', asked[0].track === plain[1].track && asked[0].requested === 3 && asked[0].reasons.includes('requested by 3 listeners'));
const crowd = rankNext({ current: now, candidates: [fits, clash], target, harmonic: h, requests: [{ track: clash, count: 40 }] });
check(`a crowd cannot out-vote a key clash (bonus capped at ${REQUEST_CAP})`, crowd[0].track === fits);
const extra = T(6, 124, 'A minor', 'House');
check('a requested song that is not in the plan becomes a candidate', rankNext({ current: now, candidates: [fits], target, harmonic: h, requests: [{ track: extra }] }).some((r) => r.track === extra));

console.log('Flow Director: advice and the safe fallback');
const adv = advise({ current: now, planned: slow, target, rest: [fits, clash], harmonic: h });
check('advice says why the planned song is there', adv && adv.planned.track === slow && adv.why.includes('energy much lower'));
check('and offers the better fit as the first alternative, flagged', adv.alts[0].track === fits && adv.alts[0].better === true);
check('at most two alternatives', advise({ current: now, planned: fits, target, rest: [clash, slow, near, extra], harmonic: h }).alts.length === 2);
check('a planned song that already fits best gets no "better fit" flag', advise({ current: now, planned: fits, target, rest: [clash, slow], harmonic: h }).alts.every((a) => !a.better));
const broken = { getCamelot() { throw new Error('bad key table'); }, toCamelot() { throw new Error('bad key table'); }, isCompatible() { throw new Error('bad'); } };
const original = console.warn; console.warn = () => {};
const fallback = advise({ current: now, planned: fits, target, rest: [clash], harmonic: broken });
console.warn = original;
check('if anything throws, there is no advice and the plan plays as built', fallback === null);
check('nothing to advise at the last song', advise({ current: now, planned: null, target, rest: [], harmonic: h }) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
