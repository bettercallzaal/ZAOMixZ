// A mix keeps going in a hidden tab.   node web/dj/Clock.test.mjs
// Chrome stops requestAnimationFrame when the DJ clicks to another tab. Here the "hidden tab"
// is a requestAnimationFrame that never calls back: a mix must still reach its end, with the
// incoming song at full volume, and tell Flow Mode it finished.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.document = { getElementById: () => null };
globalThis.window = {};
let frames = 0;
globalThis.requestAnimationFrame = () => { frames++; return frames; };   // hidden tab: never calls back
globalThis.cancelAnimationFrame = () => {};

const { every } = await import('./Clock.js');

console.log('Clock: the tick comes from a worker');
{
    const made = [];
    class FakeWorker {
        constructor(url) { this.url = url; this.posted = []; this.ended = false; made.push(this); }
        postMessage(m) { this.posted.push(m); }
        terminate() { this.ended = true; }
    }
    const env = {
        Worker: FakeWorker, Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: () => 'blob:clock', revokeObjectURL() {} },
        setInterval: () => { throw new Error('setInterval must not be used when a worker starts'); }, clearInterval() {},
    };
    let ticks = 0;
    const stop = every(20, () => { ticks++; }, env);
    const w = made[0];
    check('one worker, told the interval', made.length === 1 && w.posted[0] === 20);
    w.onmessage({}); w.onmessage({});
    check('each message from the worker is a tick', ticks === 2);
    stop();
    check('stop ends the worker', w.ended && w.posted.at(-1) === 0);
}
{
    let fallback = 0;
    class BadWorker { constructor() { this.posted = []; } postMessage() {} terminate() {} }
    const env = {
        Worker: BadWorker, Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        setInterval: () => { fallback++; return 7; }, clearInterval() {},
    };
    let made = null;
    env.Worker = class extends BadWorker { constructor() { super(); made = this; } };
    every(20, () => {}, env);
    made.onerror();
    check('a worker that fails to run falls back to setInterval', fallback === 1);
}
{
    let used = 0;
    const env = { setInterval: () => { used++; return 1; }, clearInterval() {} };
    every(20, () => {}, env);
    check('no Worker at all: setInterval', used === 1);
}

console.log('A mix in a hidden tab');
const { AutoTransition } = await import('./AutoTransition.js');
const ch = () => ({ crossfadeGain: { gain: { value: 0 } }, eqLow: { gain: { value: 0 } } });
const router = {
    channels: { A: ch(), B: ch() },
    _eqKillState: { A: { low: false }, B: { low: false } }, _eqSavedGain: { A: { low: 0 }, B: { low: 0 } },
    setEQ(id, band, db) { if (band === 'low') this.channels[id].eqLow.gain.value = db; },
    setFilter() {}, setCrossfade() {}, resume() {},
};
const deck = (playing) => ({ isLoaded: true, isPlaying: playing, play() { this.isPlaying = true; }, pause() { this.isPlaying = false; }, setPlaybackRate() {}, currentRate: 1, getBPM: () => 120 });
const decks = { A: deck(true), B: deck(false) };
const at = new AutoTransition(router, null, decks);
let done = null;
at.onComplete = (dir) => { done = dir; };
at.startProgrammatic('AtoB', 0.15, { type: 'blend' });
check('the incoming song starts playing', decks.B.isPlaying);
await wait(500);
check('the mix finished with no animation frame at all', done === 'AtoB' && !at.running);
check('the incoming song is at full volume', Math.abs(router.channels.B.crossfadeGain.gain.value - 1) < 1e-9);
check('the outgoing song is stopped', !decks.A.isPlaying);

console.log('A cancelled mix stops its tick');
{
    const at2 = new AutoTransition(router, null, { A: deck(true), B: deck(false) });
    at2.startProgrammatic('AtoB', 5, { type: 'blend' });
    const stopped = at2._stopTick !== null;
    at2.cancel();
    check('cancel ends the tick', stopped && at2._stopTick === null && !at2.running);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
