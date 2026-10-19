// A blend's bass swap is undone afterwards.   node web/dj/AutoTransitionEq.test.mjs
// During a blend the outgoing deck's low EQ is cut to -24dB and the incoming one's set to 0.
// When the blend ends, or is cancelled, both decks must get back the low setting they had.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };
globalThis.window = {};
globalThis.cancelAnimationFrame = () => {};

const { AutoTransition } = await import('./AutoTransition.js');

const ch = () => ({ crossfadeGain: { gain: { value: 0 } }, eqLow: { gain: { value: 0 } } });
function rig(lowA, lowB, killB = false) {
    const router = {
        channels: { A: ch(), B: ch() },
        _eqKillState: { A: { low: false }, B: { low: killB } }, _eqSavedGain: { A: { low: 0 }, B: { low: lowB } },
        setEQ(id, band, db) { if (band !== 'low') return; if (this._eqKillState[id].low) this._eqSavedGain[id].low = db; else this.channels[id].eqLow.gain.value = db; },
        setFilter() {}, setCrossfade() {}, resume() {},
    };
    router.channels.A.eqLow.gain.value = lowA;
    if (!killB) router.channels.B.eqLow.gain.value = lowB;
    const deck = () => ({ isPlaying: true, pause() { this.isPlaying = false; }, setPlaybackRate() {}, currentRate: 1 });
    const at = new AutoTransition(router, null, { A: deck(), B: deck() });
    at.direction = 'AtoB'; at.startPos = 0; at.endPos = 1; at.transitionType = 'blend';
    at._initTransitionEffects();
    at._animateBlend(1);
    return { at, router, low: (id) => router.channels[id].eqLow.gain.value };
}

console.log('AutoTransition: the blend\'s bass swap');
{
    const { at, low } = rig(3, -2);
    check('during the blend the outgoing deck\'s bass is cut and the incoming one\'s set to 0', low('A') === -24 && low('B') === 0);
    at._finishTransition();
    check('when it lands, both decks get their own low setting back', low('A') === 3 && low('B') === -2);
}
{
    const { at, low } = rig(1.5, 4);
    at.cancel();
    check('a cancelled blend puts them back too', low('A') === 1.5 && low('B') === 4);
}
{
    const { at, router } = rig(0, 6, true);
    at._finishTransition();
    check('a killed low band keeps its kill and gets its setting back for when it is un-killed', router._eqKillState.B.low === true && router._eqSavedGain.B.low === 6);
}
{
    const { at, low } = rig(2, 2);
    at._finishTransition();
    at.transitionType = 'echo-out'; at._initTransitionEffects(); at._cleanupEffects();
    check('a later mix that is not a blend leaves the EQ alone', low('A') === 2 && low('B') === 2);
}

{
    // The DJ turns deck B's low knob to +5 during the blend
    const { at, router, low } = (() => {
        const r = rig(3, -2);
        return r;
    })();
    router.setEQ('B', 'low', 5);
    at._animateBlend(1);
    check('a low knob the DJ moves mid-blend is not overwritten by the next step', low('B') === 5);
    at._finishTransition();
    check('nor by the clean-up, while the deck the DJ left alone is restored', low('B') === 5 && low('A') === 3);
}

{
    // The DJ turns deck B's low knob in the first 40%, before the swap has written anything
    const router = { channels: { A: { crossfadeGain: { gain: { value: 0 } }, eqLow: { gain: { value: 3 } } }, B: { crossfadeGain: { gain: { value: 0 } }, eqLow: { gain: { value: -2 } } } },
        _eqKillState: { A: { low: false }, B: { low: false } }, _eqSavedGain: { A: { low: 0 }, B: { low: 0 } },
        setEQ(id, band, db) { if (band === 'low') this.channels[id].eqLow.gain.value = db; }, setFilter() {}, setCrossfade() {}, resume() {} };
    const deck = () => ({ isPlaying: true, pause() { this.isPlaying = false; }, setPlaybackRate() {}, currentRate: 1 });
    const at = new AutoTransition(router, null, { A: deck(), B: deck() });
    at.direction = 'AtoB'; at.startPos = 0; at.endPos = 1; at.transitionType = 'blend';
    at._initTransitionEffects();
    at._animateBlend(0.2);
    router.setEQ('B', 'low', 5);
    at._animateBlend(0.7); at._animateBlend(1);
    check('a low knob moved in the first 40% is not overwritten when the swap starts', router.channels.B.eqLow.gain.value === 5);
    at._finishTransition();
    check('nor at the clean-up; the other deck is still restored', router.channels.B.eqLow.gain.value === 5 && router.channels.A.eqLow.gain.value === 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
