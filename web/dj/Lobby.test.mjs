// Lobbies: a host claims one and holds it until its decks have been silent 30 minutes.
//   node web/dj/Lobby.test.mjs
// Two desks and a page share a stand-in relay that keeps the last retained message per topic,
// as the real relays do.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
process.removeAllListeners('warning');

const L = await import('./LiveMix.js');
const { roomSlug, roomName, roomUrl, roomTopic, signClaim, readClaim, canClaim, nextHolder, roomHeld, parseMixHash, newKeys, LiveMixHost, LOBBY_HOLD_MS, fromTheFuture } = L;
const { lobbyHtml, lobbyStatus } = await import('./Settings.js');

const MIN = 60000;
const t0 = Date.UTC(2026, 9, 19, 18, 0, 0);

console.log('Lobby names and links');
check('a name becomes a short link name', roomSlug('Main Stage!') === 'main-stage' && roomSlug('  Après  Hours ') === 'apres-hours');
check('a name with nothing usable is refused', roomSlug('!!!') === '' && roomSlug('a') === '' && roomSlug('') === '');
check('at most 32 characters, no trailing dash', roomSlug('x'.repeat(31) + ' y z').length <= 32 && !roomSlug('x'.repeat(31) + ' y z').endsWith('-'));
check('the link is mix.html#lobby=<name>', roomUrl('https://zaomixz.vercel.app/', 'main-stage') === 'https://zaomixz.vercel.app/mix.html#lobby=main-stage');
check('the page reads it, and refuses one that is not a lobby name', parseMixHash('#lobby=main-stage').lobby === 'main-stage' && parseMixHash('#lobby=Main Stage').lobby === '' && parseMixHash('#lobby=-x').lobby === '');
check('the shown name drops markup characters', roomName('<b>Main</b> Stage') === 'bMain/b Stage');
check('each lobby has its own relay topic', /^zaomixz\/lobby\/[0-9a-f]{32}$/.test(await roomTopic('main')) && (await roomTopic('main')) !== (await roomTopic('lounge')));

console.log('A claim is signed by its host');
const A = await newKeys(), B = await newKeys();
const claimA = await signClaim(A.jwk, { room: 'main', name: 'Main', pub: A.pub, ts: t0, playedAt: t0 });
const readA = await readClaim(claimA, 'main');
check('read back with who holds it and when they last played', readA && readA.pub === A.pub && readA.playedAt === t0 && readA.name === 'Main');
check('a claim for another lobby is refused', (await readClaim(claimA, 'lounge')) === null);
const forged = JSON.parse(claimA); forged.pub = B.pub;
check('a claim moved to another host is refused', (await readClaim(JSON.stringify(forged), 'main')) === null);
const older = JSON.parse(claimA); older.playedAt = t0 - 99 * MIN;
check('a changed last-played time is refused', (await readClaim(JSON.stringify(older), 'main')) === null);
check('junk is refused', (await readClaim('nope', 'main')) === null && (await readClaim('{}', 'main')) === null);

console.log('Who holds a lobby');
const NH = (a, b) => nextHolder(a, b, t0 + 120 * MIN);   // the page's clock, after every claim below

const c = (pub, ts, playedAt) => ({ room: 'main', name: 'Main', pub, ts, playedAt });
check('free when nobody claimed it', canClaim(null, B.pub, t0).ok);
check('the holder may claim it again (a reload)', canClaim(c(A.pub, t0, t0), A.pub, t0 + MIN).ok);
const taken = canClaim(c(A.pub, t0 + 5 * MIN, t0 + 5 * MIN), B.pub, t0 + 12 * MIN);
check('held while its host played in the last 30 minutes, with how long ago', !taken.ok && taken.minutes === 7);
check('free once its host has been silent over 30 minutes', canClaim(c(A.pub, t0 + 40 * MIN, t0), B.pub, t0 + 31 * MIN).ok);
check('the desk being open is not playing: the claim time counts, not the heartbeat', !roomHeld(c(A.pub, t0 + 60 * MIN, t0), t0 + 60 * MIN));
const held = c(A.pub, t0 + 10 * MIN, t0 + 10 * MIN);
check('a page ignores another host while the holder is playing', NH(held, c(B.pub, t0 + 20 * MIN, t0 + 20 * MIN)) === held);
const late = c(B.pub, t0 + 41 * MIN, t0 + 41 * MIN);
check('and follows the new host after 30 silent minutes', NH(held, late) === late);
check('then the old host coming back is ignored while the new one plays', NH(late, c(A.pub, t0 + 45 * MIN, t0 + 45 * MIN)) === late);
check('a claim dated more than two minutes ahead is ignored', fromTheFuture(c(B.pub, t0 + 3 * MIN, t0), t0) && !fromTheFuture(c(B.pub, t0 + MIN, t0), t0));
check('the same host\'s newer claim replaces its older one, not the other way', NH(held, c(A.pub, t0 + 11 * MIN, t0 + 11 * MIN)).ts === t0 + 11 * MIN && NH(c(A.pub, t0 + 11 * MIN, t0 + 11 * MIN), held).ts === t0 + 11 * MIN);

check('a claim from the future is never followed, whoever calls nextHolder', nextHolder(held, c(B.pub, t0 + 60 * MIN, t0 + 60 * MIN), t0 + 50 * MIN) === held && nextHolder(null, c(B.pub, Date.now() + 10 * MIN, Date.now())) === null);
console.log('Two desks and one lobby, through the relay');
{
    const retained = new Map();
    const clients = [];
    const deliver = (topic, payload) => { for (const cl of clients) if (cl.subs.has(topic)) for (const f of cl.h.message || []) f(topic, payload); };
    const broker = () => {
        const cl = {
            connected: true, subs: new Set(), h: {},
            on(ev, f) { (this.h[ev] ||= []).push(f); },
            subscribe(topic, _o, cb) { this.subs.add(topic); if (retained.has(topic)) for (const f of this.h.message || []) f(topic, retained.get(topic)); cb?.(null); },
            publish(topic, p, o) { if (o?.retain) retained.set(topic, p); deliver(topic, p); },
            end() {},
        };
        clients.push(cl);
        return cl;
    };
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const store = () => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });
    let now = t0;
    let playingA = true, playingB = true;
    const lost = [];
    // The relays connect once per broker URL: two per desk
    const deskA = new LiveMixHost(() => [], { storage: store(), now: () => now, connect: async () => broker(), isPlaying: () => playingA, wait: settle, onRoomLost: (r) => lost.push(r.room) });
    const deskB = new LiveMixHost(() => [], { storage: store(), now: () => now, connect: async () => broker(), isPlaying: () => playingB, wait: settle });

    const a1 = await deskA.claimRoom('Main Stage');
    check('a host claims a free lobby and gets its link', a1.ok && a1.room === 'main-stage' && a1.link.endsWith('#lobby=main-stage'));
    const topic = await roomTopic('main-stage');
    check('the claim is kept on the relay for pages that open later', (await readClaim(retained.get(topic), 'main-stage'))?.pub === deskA.lobby.pub);

    now += 10 * MIN; await deskA.update(true); await settle();
    const b1 = await deskB.claimRoom('main stage');
    check('a second host is refused while the first is playing', !b1.ok && b1.why === 'taken' && b1.minutes === 0);
    check('and the lobby stays with the first', (await readClaim(retained.get(topic), 'main-stage'))?.pub === deskA.lobby.pub && deskA.room?.room === 'main-stage');

    playingA = false;
    now += 31 * MIN; await deskA.update(true); await settle();   // A's desk is open but silent: it still says it holds the lobby
    check('a silent desk still sends its claim, with the old last-played time', (await readClaim(retained.get(topic), 'main-stage')).playedAt === t0 + 10 * MIN);
    const b2 = await deskB.claimRoom('Main Stage');
    check('after 30 silent minutes another host can claim it', b2.ok);
    await settle();
    check('the first desk hears it and steps back', deskA.room === null && lost.join() === 'main-stage');
    await deskA.update(true); await settle();
    check('and stops sending its claim, so the lobby stays with the new host', (await readClaim(retained.get(topic), 'main-stage'))?.pub === deskB.lobby.pub);

    const c2 = await deskB.claimRoom('Lounge');
    check('a host can move to another lobby', c2.ok && deskB.room.room === 'lounge');

    // A desk whose clock runs 31 minutes fast sees the holder as silent; nobody follows it
    const fast = new LiveMixHost(() => [], { storage: store(), now: () => now + 31 * MIN, connect: async () => broker(), isPlaying: () => true, wait: settle });
    playingB = true; await deskB.update(true); await settle();
    await fast.claimRoom('Lounge');
    await settle();
    check('a desk with a fast clock is not obeyed: the holder keeps the lobby', deskB.room?.room === 'lounge');
}

console.log('A desk that cannot reach the relays does not claim');
{
    const sent = [];
    const offline = () => ({ connected: false, on() {}, subscribe() {}, publish(t, p, o) { sent.push({ t, o }); } });
    const desk = new LiveMixHost(() => [], { storage: { getItem: () => null, setItem() {} }, now: () => t0, connect: async () => offline(), wait: () => new Promise((r) => setTimeout(r, 20)) });
    const r = await desk.claimRoom('Main Stage');
    check('no relay connected: refused as offline, not taken as free', !r.ok && r.why === 'offline' && desk.room === null);
    const lobbyTopic = await roomTopic('main-stage');
    check('and nothing is sent to the lobby', !sent.some((x) => x.t === lobbyTopic));
    let n = 0;
    const mixed = () => (n++ === 0
        ? { connected: true, on() {}, subscribe() { /* never acknowledges */ }, publish() {} }
        : { connected: true, on() {}, subscribe(_t, _o, cb) { cb(null); }, publish() {} });
    const desk2 = new LiveMixHost(() => [], { storage: { getItem: () => null, setItem() {} }, now: () => t0, connect: async () => mixed(), wait: () => new Promise((r) => setTimeout(r, 20)) });
    check('one silent relay is fine while the other confirms', (await desk2.claimRoom('Main Stage')).ok);
    const refusing = () => ({ connected: true, on() {}, subscribe(_t, _o, cb) { cb(null, [{ topic: _t, qos: 128 }]); }, publish() {} });
    const desk3 = new LiveMixHost(() => [], { storage: { getItem: () => null, setItem() {} }, now: () => t0, connect: async () => refusing(), wait: () => new Promise((r) => setTimeout(r, 20)) });
    check('a relay that grants QoS 128 has said no: offline, not free', (await desk3.claimRoom('Main Stage')).why === 'offline');
}

console.log('The desk\'s lobby box');
check('the box asks for a name when no lobby is held', lobbyHtml(null).includes('id="dj-lobby-name"') && lobbyHtml(null).includes('id="dj-lobby-claim"'));
const box = lobbyHtml({ room: 'main', name: '<img src=x onerror=1>' }, 'https://z');
check('when held it shows the link and LET IT GO, the name escaped', box.includes('https://z/mix.html#lobby=main') && box.includes('id="dj-lobby-release"') && !box.includes('<img') && box.includes('&lt;img'));
check('the desk offers a new mix link', lobbyHtml(null).includes('id="dj-newmix"'));
check('offline says why it will not claim', lobbyStatus({ ok: false, why: 'offline' }).includes('not safe to claim'));
check('a taken lobby says how long ago its host played', lobbyStatus({ ok: false, why: 'taken', minutes: 1, name: 'Main' }).includes('1 minute ago') && lobbyStatus({ ok: false, why: 'taken', minutes: 7, name: 'Main' }).includes('7 minutes ago'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
