// Flow Mode's handover from one song to the next, with fake decks and a fake clock.
//   node web/dj/FlowMode.test.mjs
// No audio here: the decks, the mix engine and setTimeout are stand-ins, so every path a
// live set can take (a song that loads, one that is refused, one that never loads, no mix
// engine, a person grabbing the decks mid-mix) runs in a few milliseconds.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

// ── A clock we turn by hand ───────────────────────────────────
let now = 0;
let timers = [];
globalThis.setTimeout = (fn, ms = 0) => { const t = { at: now + ms, fn }; timers.push(t); return t; };
globalThis.clearTimeout = (t) => { timers = timers.filter((x) => x !== t); };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
const tick = (ms) => {
    const end = now + ms;
    for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift(); now = t.at;
        try { t.fn(); } catch (e) { console.log(`  (a timer threw: ${e.message}; a browser logs it and carries on)`); }
    }
    now = end;
};
const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, remove() {}, set innerHTML(v) {} });
const xfader = { value: 0, addEventListener() {} };
globalThis.document = { getElementById: (id) => (id === 'crossfader' ? xfader : null), querySelector: () => null, createElement: el, body: { appendChild() {} } };
globalThis.localStorage = { getItem: () => null, setItem() {} };

const { FlowMode } = await import('./FlowMode.js');
const { DjMixz } = await import('./DjMixz.js');

// ── Fake decks and mix engine ─────────────────────────────────
// A song titled REFUSED is turned away by the deck; NEVER never finishes loading; BROKEN
// fails 300ms in; anything else is ready 300ms after it is loaded.
function fakeDeck(id) {
    const handlers = {};
    const fire = (ev) => { const fns = handlers[ev] || []; handlers[ev] = []; fns.forEach((fn) => fn()); }; // once: each listener runs one time
    const deck = {
        id, isLoaded: false, isPlaying: false, time: 0, duration: 200, title: null, loads: [],
        wavesurfer: { once: (ev, fn) => { (handlers[ev] ||= []).push(fn); }, getDuration: () => deck.duration },
        loadDirect(url, meta) {
            deck.loads.push(meta.title);
            if (meta.title === 'REFUSED') return false;
            deck.isLoaded = false; deck.isPlaying = false; deck.title = meta.title; deck.time = 0;
            deck.metadata = { metadata: { ...meta } };
            if (meta.title === 'BROKEN') setTimeout(() => fire('error'), 300);
            else if (meta.title !== 'NEVER') setTimeout(() => { if (deck.title === meta.title) { deck.isLoaded = true; fire('ready'); } }, 300);
            return true;
        },
        play() { deck.isPlaying = true; }, pause() { deck.isPlaying = false; },
        getCurrentTime: () => deck.time, getDuration: () => deck.duration, getBPM: () => 124,
    };
    return deck;
}
function fakeEngine(decks) {
    const eng = {
        running: false, starts: [], cancels: 0, onComplete: null, onCancel: null,
        startProgrammatic(direction, seconds, opts) {
            if (eng.running) return;
            eng.running = true; eng.starts.push({ direction, seconds, type: opts?.type });
            const target = direction === 'AtoB' ? decks.B : decks.A;
            if (target.isLoaded && !target.isPlaying) target.play();
        },
        finish() { // the mix lands: what AutoTransition._finishTransition does
            if (!eng.running) return;
            eng.running = false;
            const d = eng.starts[eng.starts.length - 1].direction;
            (d === 'AtoB' ? decks.A : decks.B).pause();
            eng.onComplete?.(d);
        },
        cancel() { eng.running = false; eng.cancels += 1; eng.onCancel?.(); },
    };
    return eng;
}
const song = (title) => ({ id: title, title, artist: 'Test Artist', source: 'audius', streamUrl: `https://x/${title}` });

// A desk with two decks, a mix engine wired the way player.js wires it, and a setlist.
function desk({ engine = true } = {}) {
    now = 0; timers = [];
    const decks = { A: fakeDeck('A'), B: fakeDeck('B') };
    const logged = [];
    const dj = {
        decks,
        audioRouter: { setCrossfade(v) { dj.xf = v; }, resume() {} },
        setlist: { logPlay: (title) => logged.push(title) },
        library: { tracks: [] },
        harmonic: null,
    };
    dj.autoTransition = engine ? fakeEngine(decks) : null;
    const flow = new FlowMode(dj);
    dj.flowMode = flow;
    if (dj.autoTransition) {
        dj.autoTransition.onComplete = (d) => { if (flow.enabled) flow.onTransitionComplete(d); };
        dj.autoTransition.onCancel = () => { if (flow.enabled) flow.onTransitionCancelled?.(); };
    }
    flow.enabled = true; // enable() builds UI; the fake DOM has none
    return { dj, flow, decks, eng: dj.autoTransition, logged };
}
// Play the current deck to `remaining` seconds from its end, one timeupdate per call.
const playTo = (flow, deck, remaining) => { deck.time = deck.duration - remaining; flow.onTimeUpdate(deck); };

// ── 1. A clean handover ───────────────────────────────────────
console.log('Flow Mode: a song that loads');
{
    const { flow, decks, eng, logged } = desk();
    flow.queue = [song('two'), song('three')];
    flow.start(song('one'));
    tick(400);
    check('the first song plays on deck A', decks.A.isPlaying && decks.A.title === 'one');
    playTo(flow, decks.A, 25);
    check('near the end the next song loads on deck B', decks.B.title === 'two' && flow._transitioning);
    tick(400);
    check('once it is ready the mix starts, A to B', eng.starts.length === 1 && eng.starts[0].direction === 'AtoB' && decks.B.isPlaying);
    eng.finish();
    check('after the mix B is the live deck and three is up next', flow.currentDeck === 'B' && flow.currentTrack.title === 'two' && flow.queue[0].title === 'three' && !flow._transitioning && !flow._nearEndTriggered);
    check('played and setlist both list one then two', flow.playedInSession.join() === 'one,two' && logged.join() === 'one,two');
}

// ── 1b. A licensed stream keeps its licence on the way to the deck ──
console.log('Flow Mode: a stream with its own licence');
{
    const { canPlay } = await import('./Licence.js');
    const { flow, decks, eng } = desk();
    const plain = decks.B.loadDirect;
    decks.B.loadDirect = (url, meta) => (canPlay(meta).ok ? plain(url, meta) : false); // what the real deck does
    const licensed = { id: 'own', title: 'Own Song', artist: 'Some Artist', source: 'zao-source', streamUrl: 'https://x/own.mp3',
        licence: { artist: 'Some Artist', uses: { stream: true, dj: true, radio: true, commercial: false }, terms: 'https://example.org/grant' } };
    flow.queue = [licensed];
    flow.start(song('one')); tick(400);
    playTo(flow, decks.A, 25); tick(400);
    check('a stream that carries its own licence is not refused at the deck', decks.B.title === 'Own Song' && eng.starts.length === 1);
}

// ── 2. The next song is refused ───────────────────────────────
console.log('Flow Mode: the next song is refused');
{
    const { flow, decks, eng, logged } = desk();
    flow.queue = [song('REFUSED'), song('three')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    check('the refused song leaves the queue and is not marked played', flow.queue[0]?.title === 'three' && !flow.playedInSession.includes('REFUSED'));
    check('the refused song is not in the setlist', !logged.includes('REFUSED'));
    check('the near-end trigger is free again', !flow._nearEndTriggered && !flow._transitioning);
    playTo(flow, decks.A, 24);
    tick(400);
    check('the next timeupdate mixes into the song after it, with no dead air', decks.B.title === 'three' && eng.starts.length === 1 && decks.A.isPlaying);
}

// ── 3. The next song never loads ──────────────────────────────
console.log('Flow Mode: the next song never loads');
{
    const { flow, decks, eng, logged } = desk();
    flow.queue = [song('NEVER'), song('three')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    tick(26000);
    check('after the timeout the stuck song is dropped and not marked played', !flow.playedInSession.includes('NEVER') && !flow.queue.some((t) => t.title === 'NEVER'));
    check('the stuck song is not in the setlist', !logged.includes('NEVER'));
    check('it goes straight on to the song after it', decks.B.title === 'three' && eng.starts.length === 1);
    eng.finish();
    check('and the set carries on from there', flow.currentTrack.title === 'three' && !flow._transitioning);
}
{
    const { flow, decks, eng } = desk();
    flow.queue = [song('NEVER')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    tick(26000);
    check('timeout with nothing after it: no mix pending, near-end free for a song added later', !flow._transitioning && !flow._nearEndTriggered && eng.starts.length === 0);
    // The stuck song finally turns up after Flow Mode gave up on it: it must not start a mix.
    decks.B.isLoaded = true;
    tick(1000);
    check('a song that loads after the timeout does not start a mix', eng.starts.length === 0);
    flow.addToQueue(song('late'));
    playTo(flow, decks.A, 10);
    tick(400);
    check('a song added after the queue ran dry still gets mixed in before the end', decks.B.title === 'late' && eng.starts.length === 1);
}

// ── 4. No mix engine, or one that fails ───────────────────────
console.log('Flow Mode: no mix engine');
{
    const { flow, decks, dj } = desk({ engine: false });
    flow.queue = [song('two'), song('three')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    tick(400);
    check('without AutoTransition the set still moves on, by a cut', decks.B.isPlaying && !decks.A.isPlaying && flow.currentDeck === 'B' && flow.currentTrack.title === 'two');
    check('the crossfader lands on the new deck and nothing is left pending', dj.xf === 1 && !flow._transitioning && !flow._nearEndTriggered);
}
{
    const { flow, decks, eng } = desk();
    eng.startProgrammatic = () => { eng.running = true; throw new Error('router gone'); };
    flow.queue = [song('two')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    tick(400);
    check('a mix engine that throws falls back to a cut', decks.B.isPlaying && flow.currentDeck === 'B' && !flow._transitioning);
    check('and the engine is not left marked as running', eng.running === false);
}
{
    const { flow, decks, eng } = desk();
    flow.queue = [song('two'), song('three')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    tick(400);
    eng.cancel(); // somebody pressed CANCEL on the AUTO button mid-mix
    check('a cancelled mix does not leave Flow Mode stuck mid-transition', !flow._transitioning);
}

// ── 5. The first song fails, and a mix is cancelled part way ──
console.log('Flow Mode: the first song fails to load');
{
    const { flow, decks, logged } = desk();
    flow.queue = [song('two'), song('three')];
    flow.start(song('BROKEN'));
    tick(400);
    tick(400);
    check('the set opens with the next song instead', decks.A.isPlaying && decks.A.title === 'two');
    check('the song that failed is not in the setlist or the played list', !logged.includes('BROKEN') && !flow.playedInSession.includes('BROKEN') && logged.join() === 'two');
}
{
    const { flow, decks } = desk();
    flow.queue = [song('two'), song('BROKEN'), song('four')];
    flow.start(song('one'));
    tick(400);
    flow.currentDeck = 'B'; // the set has moved on and deck A is the idle deck again
    decks.A.loadDirect('x', song('BROKEN')); // a later song fails to load on deck A
    tick(400);
    check('a load error on deck A later in the set does not restart the set', flow.currentTrack.title === 'one' && flow.queue[0]?.title === 'two');
}
console.log('Flow Mode: CANCEL part way through a mix');
{
    const { flow, decks, eng, logged } = desk();
    flow.queue = [song('two'), song('three')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    tick(400);
    xfader.value = 70; // the mix was most of the way into deck B
    eng.cancel();
    check('past halfway, the incoming song becomes the current song', flow.currentDeck === 'B' && flow.currentTrack.title === 'two' && flow.queue[0]?.title === 'three');
    check('and the near-end trigger is free for the next mix', !flow._nearEndTriggered && !flow._transitioning);
    playTo(flow, decks.B, 25);
    tick(400);
    check('the next mix goes from B into three', decks.A.title === 'three' && eng.starts.length === 2 && eng.starts[1].direction === 'BtoA');
    check('every song is in the setlist once', logged.join() === 'one,two,three');
}
{
    const { flow, decks, eng, logged } = desk();
    flow.queue = [song('two'), song('three')];
    flow.start(song('one'));
    tick(400);
    playTo(flow, decks.A, 25);
    tick(400);
    xfader.value = 20; // cancelled early: the room still mostly hears deck A
    eng.cancel();
    check('before halfway, the current song stays and the incoming one is still next', flow.currentDeck === 'A' && flow.queue[0]?.title === 'two');
    check('the mix is not restarted at once over the cancel', (playTo(flow, decks.A, 20), eng.starts.length === 1));
    decks.A.time = decks.A.duration; flow.onTrackNearEnd(decks.A); // the outgoing song runs out
    tick(400);
    check('at the end it mixes in from the deck already holding it, no reload', eng.starts.length === 2 && decks.B.loads.filter((t) => t === 'two').length === 1);
    eng.finish();
    check('and the cancelled song is in the setlist once', logged.join() === 'one,two' && flow.currentTrack.title === 'two');
}

// ── 6. A person takes the decks mid-handover (DJ MixZ) ────────
console.log('DJ MixZ: takeover and dropped songs');
const plan = (titles) => titles.map((t, i) => ({ track: song(t), energy: 0.5, target: 0.5, move: i ? { type: 'blend', bars: 16, seconds: 8, why: 'test' } : null }));
{
    const { dj, flow, decks, eng } = desk();
    const mixz = new DjMixz(dj);
    mixz.plan = plan(['one', 'two', 'three']);
    mixz.start();
    tick(400);
    playTo(flow, decks.A, 10);
    check('DJ MixZ starts loading the next song', decks.B.title === 'two' && flow._transitioning);
    mixz.takeOver('button');
    tick(1000);
    check('after takeover the song that finishes loading does not start a mix', eng.starts.length === 0);
    check('and nothing is left pending', !flow._transitioning);
}
{
    const { dj, flow, decks, eng } = desk();
    const mixz = new DjMixz(dj);
    mixz.plan = plan(['one', 'REFUSED', 'three', 'four']);
    mixz.start();
    tick(400);
    playTo(flow, decks.A, 10);
    playTo(flow, decks.A, 9);
    tick(400);
    check('a refused song comes out of the plan as well as the queue', !mixz.plan.some((p) => p.track.title === 'REFUSED'));
    check('the plan\'s next song is the one actually mixing in', mixz.plan[mixz.index + 1]?.track.title === 'three' && decks.B.title === 'three' && eng.starts.length === 1);
    eng.finish();
    check('after the mix plan and Flow Mode agree on what is playing', flow.currentTrack.title === 'three' && mixz.plan[mixz.index].track.title === 'three');
    playTo(flow, decks.B, 10);
    tick(400);
    eng.finish();
    check('the last song mixes in', flow.currentTrack.title === 'four');
    playTo(flow, decks.A, 10);
    check('and at the end of the plan DJ MixZ finishes the set', mixz.running === false);
}
{
    const { dj, flow, decks } = desk();
    const mixz = new DjMixz(dj);
    mixz.plan = plan(['one', 'NEVER', 'three']);
    mixz.start();
    tick(400);
    playTo(flow, decks.A, 10);
    tick(26000);
    check('a song that never loads comes out of the plan too', !mixz.plan.some((p) => p.track.title === 'NEVER') && mixz.plan[mixz.index + 1]?.track.title === 'three');
}

// ── 7. The Flow Director: advice, approval, override ──────────
console.log('DJ MixZ: the Flow Director');
const tp = (title, bpm, key, genre) => ({ ...song(title), bpm, key, genre });
const dplan = (tracks, targets) => tracks.map((t, i) => ({ track: t, energy: 0.5, target: targets[i], move: i ? { type: 'blend', bars: 16, seconds: 8, why: 'test' } : null }));
const { HarmonicMixer } = await import('./HarmonicMixer.js');
{
    const { dj, flow, decks, eng } = desk();
    dj.harmonic = new HarmonicMixer();
    const mixz = new DjMixz(dj);
    const quiet = tp('quiet', 92, 'A minor', 'Lo-Fi'), fit = tp('fit', 125, 'E minor', 'House'), other = tp('other', 124, 'F# major', 'House');
    mixz.plan = dplan([tp('one', 124, 'A minor', 'House'), quiet, other, fit], [0.7, 0.72, 0.72, 0.72]);
    mixz.start();
    tick(400);
    const adv = mixz._advise();
    check('the director says why the planned next song is there', adv?.planned.track === quiet && /energy much lower/.test(adv.why));
    check('and offers the better fit first', adv.alts[0].track === fit && adv.alts[0].better);
    check('nothing changes until a person approves', mixz.plan[1].track === quiet && flow.queue[0] === quiet);
    check('SWAP puts the pick next, in the plan and in the queue', mixz.swapNext(fit) && mixz.plan[1].track === fit && flow.queue[0] === fit);
    check('the song it replaced stays in the set, one slot later', mixz.plan[2].track === quiet && flow.queue[1] === quiet && mixz.plan.length === 4);
    check('the move into the pick is planned afresh', mixz.plan[1].move.why !== 'test');
    playTo(flow, decks.A, 10);
    check('during a handover a swap is refused', mixz.swapNext(other) === false && flow.queue[0] === fit);
    tick(400);
    check('and the mix that runs is into the pick', decks.B.title === 'fit' && eng.starts.length === 1);
    eng.finish();
    mixz.takeOver('button');
    check('while a person has the decks there is no advice', mixz._advise() === null);
    const before = flow.queue[0];
    check('and a swap is refused, the queue untouched', mixz.swapNext(other) === false && flow.queue[0] === before);
    mixz.handBack();
    mixz.director = 'off';
    check('with the director off there is no advice', mixz._advise() === null);
}
{
    const { dj, flow } = desk();
    dj.harmonic = new HarmonicMixer();
    const wanted = tp('wanted', 124, 'A minor', 'House');
    dj.requestLine = { waiting: () => [{ track: wanted, devices: ['p1', 'p2'] }] };
    const mixz = new DjMixz(dj);
    mixz.plan = dplan([tp('one', 124, 'A minor', 'House'), tp('next', 124, 'A minor', 'House'), tp('later', 124, 'A minor', 'House')], [0.7, 0.72, 0.72]);
    mixz.start();
    tick(400);
    const alt = mixz._advise()?.alts.find((a) => a.track === wanted);
    check('a waiting request shows up as a pick, with who asked', alt && alt.reasons.includes('requested by 2 listeners'));
    check('approving it plays it next', mixz.swapNext(wanted) && flow.queue[0] === wanted);
    dj.requestLine = { waiting: () => { throw new Error('board gone'); } };
    const warn = console.warn; console.warn = () => {};
    let adv2, threw = false;
    try { adv2 = mixz._advise(); } catch (e) { threw = true; }
    console.warn = warn;
    check('a request line that throws does not break the advice', !threw && adv2 && adv2.planned);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
