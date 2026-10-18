// When Flow Mode starts the handover: at its own trigger point, not at the deck's fixed 30s.
//   node web/dj/FlowTrigger.test.mjs
// DJ MixZ arms a trigger point per move (a 4 second cut starts 6 seconds from the end). The
// deck also calls onTrackNearEnd at its own fixed 30 seconds, and that call used to start the
// handover right there, whatever the plan said.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };
globalThis.setTimeout = () => 0;

const { FlowMode } = await import('./FlowMode.js');

function desk(transitionPoint) {
    const deck = (id) => ({ id, isLoaded: true, isPlaying: id === 'A', time: 0, duration: 200, getCurrentTime() { return this.time; }, getDuration() { return this.duration; } });
    const dj = { decks: { A: deck('A'), B: deck('B') } };
    const flow = new FlowMode(dj);
    flow.enabled = true;
    flow.transitionPoint = transitionPoint;
    flow.queue = [{ title: 'next' }];
    const at = []; // remaining seconds at each handover start
    flow._triggerTransition = () => { at.push(dj.decks.A.duration - dj.decks.A.time); flow._transitioning = true; };
    return { flow, A: dj.decks.A, triggers: () => at.length, at };
}

console.log('Flow Mode: the deck\'s fixed 30s near-end');
{
    const { flow, A, triggers, at } = desk(6);
    A.time = 170; flow.onTrackNearEnd(A); // the deck's 30s call
    check('with a 6s trigger point, the deck\'s 30s call does not start the handover', triggers() === 0);
    A.time = 194.5; flow.onTimeUpdate(A);
    check('Flow Mode starts it at its own trigger point, 5.5s from the end', at.length === 1 && at[0] === 5.5);
}
{
    const { flow, A, triggers } = desk(40);
    A.time = 170; flow.onTrackNearEnd(A);
    check('with a trigger point past 30s, a missed timeupdate is still caught by the deck\'s call', triggers() === 1);
}
{
    const { flow, A, triggers } = desk(6);
    A.time = 200; flow._nearEndTriggered = true; flow.onTrackNearEnd(A); // onFinish: the track ran out
    check('at the end of the track the call always starts the handover (the onFinish fallback)', triggers() === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
