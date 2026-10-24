// Offline check of workflows: recipes of moves and rules filled from a crate.   node web/dj/Workflows.test.mjs
import { makeStep, makeWorkflow, fits, fillWorkflow, buildSet, PRESETS, loadWorkflows, saveWorkflows, MOVES, RULES } from './Workflows.js';
import { HarmonicMixer } from './HarmonicMixer.js';

const h = new HarmonicMixer();
let fail = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fail += 1; };

const T = (id, bpm, key, genre, artist = 'A' + (id % 5)) => ({ id, title: 'T' + id, artist, bpm, key, genre, streamUrl: 'x' });
const pool = [
    T(1, 92, 'A minor', 'Lo-Fi'), T(2, 98, 'E minor', 'R&B'), T(3, 104, 'A minor', 'Hip-Hop'), T(4, 110, 'C major', 'Pop'),
    T(5, 118, 'G major', 'Disco'), T(6, 122, 'E minor', 'House'), T(7, 124, 'B minor', 'House'), T(8, 126, 'D major', 'Tech House'),
    T(9, 128, 'A major', 'Techno'), T(10, 130, 'F# minor', 'Techno'), T(11, 140, 'F minor', 'Dubstep'), T(12, 172, 'A minor', 'Drum & Bass'),
    T(13, 100, 'F major', 'Tribe Bass'), T(14, 81, 'C# major', 'Hip-Hop'),
];
const ids = (plan) => plan.map((s) => s.track.id);

// Steps and workflows always come out whole
const s = makeStep({ move: 'nope', bars: 999, rule: 'tempo-up', amount: 0 });
ok('a bad step is repaired: unknown move becomes blend, bars capped, amount defaulted', s.move === 'blend' && s.bars === 64 && s.amount === 6);
ok('cut defaults to 1 bar, echo out to 4, stem swap to 8, blend to 16', makeStep({ move: 'cut' }).bars === 1 && makeStep({ move: 'echo-out' }).bars === 4 && makeStep({ move: 'stem-swap' }).bars === 8 && makeStep({}).bars === 16);
const w = makeWorkflow('  My Ramp ', [{ move: 'echo-out', rule: 'tempo-up' }]);
ok('a workflow gets an id from its name and clean steps', w.id === 'my-ramp' && w.name === 'My Ramp' && w.steps[0].move === 'echo-out' && w.steps[0].rule === 'tempo-up');
ok('every move and rule has a label', MOVES.every((m) => m.label) && RULES.every((r) => r.label));

// Rules
const from = pool[5]; // 122 E minor House
ok('tempo up 6% out of 122: 128 and 130 fit, 124 and 140 do not', fits(makeStep({ rule: 'tempo-up', amount: 6 }), from, pool[8], h) && fits(makeStep({ rule: 'tempo-up', amount: 6 }), from, pool[9], h) && !fits(makeStep({ rule: 'tempo-up', amount: 6 }), from, pool[6], h) && !fits(makeStep({ rule: 'tempo-up', amount: 6 }), from, pool[10], h));
ok('same key family out of E minor: G major fits, F minor does not', fits(makeStep({ rule: 'same-key' }), from, pool[4], h) && !fits(makeStep({ rule: 'same-key' }), from, pool[10], h));
ok('same artist: only the same act fits', fits(makeStep({ rule: 'same-artist' }), pool[0], pool[5], h) && !fits(makeStep({ rule: 'same-artist' }), pool[0], pool[1], h));
ok('more energy: drum and bass fits out of lo-fi, not the other way', fits(makeStep({ rule: 'more-energy' }), pool[0], pool[11], h) && !fits(makeStep({ rule: 'more-energy' }), pool[11], pool[0], h));
ok('the first song fits any rule', fits(makeStep({ rule: 'tempo-up' }), null, pool[0], h));

// Filling
const ramp = makeWorkflow('ramp', [{ move: 'echo-out', rule: 'tempo-up', amount: 6, airhorn: 'classic' }, { move: 'stem-swap', rule: 'same-key', tempoRide: true }, { move: 'blend', rule: 'more-energy' }]);
const filled = fillWorkflow(ramp, pool, from, h);
ok('a 3-step workflow out of a playing song gives 3 songs, none repeated, none the one on air', filled.length === 3 && new Set(ids(filled)).size === 3 && !ids(filled).includes(6));
ok('step 1 took a song about 6% faster than 122', filled[0].track.bpm >= 127 && filled[0].track.bpm <= 132);
ok('each slot carries the step move, with the horn and tempo ride from the step', filled[0].move.type === 'echo-out' && filled[0].move.airhorn === 'classic' && filled[1].move.type === 'stem-swap' && filled[1].move.tempoRide === true && filled[2].move.type === 'blend');
ok('move seconds follow the bars at the outgoing tempo', filled[0].move.seconds > 5 && filled[0].move.seconds < 10 && filled[2].move.seconds > 25);
ok('every slot says why in words', filled.every((x) => typeof x.why === 'string' && x.why.length > 8));

const opened = fillWorkflow(ramp, pool, null, h);
ok('with nothing on air the first slot opens with no move', opened.length === 3 && opened[0].move === null && opened[1].move.type === 'stem-swap');

const strict = makeWorkflow('strict', [{ move: 'cut', rule: 'same-artist' }]);
const lonely = fillWorkflow(strict, pool.filter((t) => t.artist !== 'A1'), T(99, 120, 'A minor', 'House', 'A1'), h);
ok('a rule no song can satisfy falls back to the best mix and says so', lonely.length === 1 && /no song in the crate fits/.test(lonely[0].why));

// Sets
const set = buildSet([ramp, PRESETS[1]], pool, 9, h);
ok('a set of 9 chains the workflows and never repeats a song', set.length === 9 && new Set(ids(set)).size === 9);
ok('the set follows ramp (3 steps) then smooth ride (2 steps) then ramp again', set[0].workflow === 'ramp' && set[3].workflow === 'smooth-ride' && set[5].workflow === 'ramp');
ok('every slot after the first has a move the engine can play', set.slice(1).every((x) => x.move && MOVES.some((m) => m.id === x.move.type) && x.move.seconds > 0));
ok('the set runs out gracefully when the crate is small', buildSet([ramp], pool.slice(0, 4), 9, h).length === 4);
ok('no workflows, no set', buildSet([], pool, 5, h).length === 0 && buildSet([makeWorkflow('empty', [])], pool, 5, h).length === 0);

// Presets and storage
ok('presets are whole workflows with ids and hints', PRESETS.length >= 3 && PRESETS.every((p) => p.id && p.steps.length && p.hint));
const mem = new Map();
const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
ok('saved workflows come back the same, repaired', saveWorkflows([ramp, { name: 'x', steps: [{ move: 'zzz' }] }], storage) && loadWorkflows(storage).length === 2 && loadWorkflows(storage)[1].steps[0].move === 'blend');
ok('broken storage returns an empty list, no throw', loadWorkflows({ getItem: () => '{not json' }).length === 0 && loadWorkflows(undefined).length === 0);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
