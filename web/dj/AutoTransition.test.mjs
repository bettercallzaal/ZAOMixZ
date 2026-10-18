// AutoTransition's crossfade gains, both ways.   node web/dj/AutoTransition.test.mjs
// A mix must start with the outgoing deck at full and the incoming one silent, and end the
// other way round, whichever direction it runs.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };
globalThis.window = {};

const { AutoTransition } = await import('./AutoTransition.js');

const gain = () => ({ gain: { value: NaN } });
const router = { channels: { A: { crossfadeGain: gain() }, B: { crossfadeGain: gain() } }, setEQ() {}, setFilter() {}, setCrossfade() {} };
const at = new AutoTransition(router, null, {});
const g = () => ({ A: router.channels.A.crossfadeGain.gain.value, B: router.channels.B.crossfadeGain.gain.value });
const near = (x, y) => Math.abs(x - y) < 1e-9;

for (const [type, step] of [['blend', '_animateBlend'], ['filter-sweep', '_animateFilterSweep'], ['echo-out', '_animateEchoOut']]) {
    console.log(`AutoTransition: ${type}`);
    for (const [direction, from, to] of [['AtoB', 'A', 'B'], ['BtoA', 'B', 'A']]) {
        at.direction = direction; at.startPos = direction === 'AtoB' ? 0 : 1; at.endPos = 1 - at.startPos;
        at[step](0); const start = g();
        at[step](0.5); const mid = g();
        at[step](1); const end = g();
        check(`${direction}: starts with ${from} at full and ${to} silent`, near(start[from], 1) && near(start[to], 0));
        check(`${direction}: ends with ${to} at full and ${from} silent`, near(end[to], 1) && near(end[from], 0));
        if (type !== 'echo-out') check(`${direction}: equal power through the middle`, near(mid.A * mid.A + mid.B * mid.B, 1));
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
