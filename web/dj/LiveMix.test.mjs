// One live link for the whole set.   node web/dj/LiveMix.test.mjs
// The desk signs each version of the set; the page shows only what the desk's key signed, and
// only something newer than what it has. A reload of the desk keeps the link and the songs.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
process.removeAllListeners('warning');

const { parseMixHash, liveUrl, liveTopic, newKeys, signUpdate, readUpdate, liveMix, openLobby, LiveMixHost, validKey, LOBBY_IDLE_MS, STORE_KEY } = await import('./LiveMix.js');
const { encodeMix, decodeMix } = await import('./MixPage.js');

const t0 = Date.UTC(2026, 9, 19, 18, 0, 0);
const song = (id, startTime, durationPlayed = null) => ({ title: `Song ${id}`, artist: 'IMan Afrikah', src: 'audius', sid: id, startTime, durationPlayed });

console.log('LiveMix: the link');
const keys = await newKeys();
check('the key is 43 characters, safe in a link', validKey(keys.pub) && keys.jwk.d);
check('the link is mix.html#live=<key>', liveUrl('https://zaomixz.vercel.app/', keys.pub) === `https://zaomixz.vercel.app/mix.html#live=${keys.pub}`);
const m = encodeMix(liveMix([song('a1', t0, 200)], [], t0));
check('a live link with the set written in reads both', JSON.stringify(parseMixHash(`#live=${keys.pub}&m=${m}`)) === JSON.stringify({ live: keys.pub, m }));
check('an old #m= link still reads', parseMixHash(`#m=${m}`).m === m && parseMixHash(`#m=${m}`).live === '');
check('a key that is not one is ignored', parseMixHash('#live=abc').live === '' && parseMixHash('#live=' + 'x'.repeat(42) + '!').live === '');
const topic = await liveTopic(keys.pub);
check('the relay topic comes from the key and does not show it', /^zaomixz\/live\/[0-9a-f]{32}$/.test(topic) && !topic.includes(keys.pub) && topic === await liveTopic(keys.pub));

console.log('LiveMix: only the desk can change the set');
const payload = await signUpdate(keys.jwk, m, t0 + 1000);
const ok = await readUpdate(keys.pub, payload);
check('a set the desk signed is read back', ok && ok.m === m && ok.ts === t0 + 1000 && ok.mix.t.length === 1);
const forged = JSON.parse(payload); forged.m = encodeMix(liveMix([song('spam', t0, 200)], [], t0));
check('a set changed after signing is refused', (await readUpdate(keys.pub, JSON.stringify(forged))) === null);
const later = JSON.parse(payload); later.ts += 1;
check('a changed time is refused', (await readUpdate(keys.pub, JSON.stringify(later))) === null);
const other = await newKeys();
check('a set signed by another key is refused', (await readUpdate(keys.pub, await signUpdate(other.jwk, m, t0))) === null);
check('junk on the topic is refused', (await readUpdate(keys.pub, 'not json')) === null && (await readUpdate(keys.pub, '')) === null && (await readUpdate(keys.pub, '{"v":1}')) === null);

console.log('LiveMix: one link from the first song to the last');
{
    const store = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } };
    let now = t0;
    const sent = [];
    const fake = () => ({ connected: true, on() {}, publish(topic, p, o) { sent.push({ topic, p, o }); } });
    const history = [];
    const host = new LiveMixHost(() => history, { storage: store, now: () => now, connect: async () => fake() });
    const link = await host.link('https://zaomixz.vercel.app');
    check('the link works before the first song', link.includes('#live=') && sent.length === 2);
    const first = await readUpdate(host.lobby.pub, sent.at(-1).p);
    check('and the relays hold an empty set, retained', first && first.mix.t.length === 0 && sent.every((s) => s.o.retain === true));
    history.push(song('a1', t0 + 1000)); now += 1000; await host.update();
    history[0].durationPlayed = 240; history.push(song('a2', t0 + 241000)); now += 240000; await host.update();
    const mid = await readUpdate(host.lobby.pub, sent.at(-1).p);
    check('each song played reaches the same link', mid.mix.t.map((e) => e[1]).join() === 'a1,a2');
    check('times run from the start of the set', mid.mix.t[0][2] === 1 && mid.mix.t[1][2] === 241);
    const before = sent.length; await host.update();
    check('nothing changed, nothing sent', sent.length === before);
    await host.update(true);
    check('the heartbeat sends it again, newer', sent.length === before + 2 && (await readUpdate(host.lobby.pub, sent.at(-1).p)).ts >= mid.ts);

    // The desk reloads mid-set: a new page, an empty history, the same link
    const history2 = [];
    now += 60000;
    const host2 = new LiveMixHost(() => history2, { storage: store, now: () => now, connect: async () => fake() });
    const link2 = await host2.link('https://zaomixz.vercel.app');
    check('a reload keeps the same link', link2 === link);
    const afterReload = await readUpdate(host2.lobby.pub, sent.at(-1).p);
    check('and does not wipe the songs already played', afterReload.mix.t.map((e) => e[1]).join() === 'a1,a2');
    history2.push(song('a3', now)); await host2.update();
    const end = await readUpdate(host2.lobby.pub, sent.at(-1).p);
    check('songs after the reload carry on the same set, in time order', end.mix.t.map((e) => e[1]).join() === 'a1,a2,a3' && end.mix.t[2][2] > end.mix.t[1][2]);

    // The next day: a new set, a new link
    now += LOBBY_IDLE_MS + 1;
    const host3 = new LiveMixHost(() => [], { storage: store, now: () => now, connect: async () => fake() });
    const link3 = await host3.link('https://zaomixz.vercel.app');
    check('a set quiet for six hours is over: the next one gets a new link', link3 !== link && JSON.parse(store.getItem(STORE_KEY)).t.length === 0);
}

console.log('LiveMix: a relay that will not connect');
{
    const sent = [];
    const host = new LiveMixHost(() => [song('b1', t0)], {
        storage: { getItem: () => null, setItem() {} }, now: () => t0,
        connect: async (url) => { if (url.includes('emqx')) throw new Error('down'); return { on() {}, publish(t, p) { sent.push(p); } }; },
    });
    await host.link('https://x');
    check('the other relay still gets the set', sent.length === 1 && (await readUpdate(host.lobby.pub, sent[0])).mix.t.length === 1);
}

console.log('LiveMix: a lobby is reused only while the set goes on');
{
    const fresh = async () => ({ pub: 'A'.repeat(43), jwk: { d: 'x' } });
    const saved = { pub: 'B'.repeat(43), jwk: { d: 'y' }, start: t0, lastAt: t0, t: [['au', 'x', 0, 1]] };
    check('recent: same lobby', (await openLobby(saved, t0 + 1000, fresh)).lobby === saved);
    check('nothing saved: a new one', (await openLobby(null, t0, fresh)).isNew);
    check('a broken save: a new one', (await openLobby({ pub: 'short' }, t0, fresh)).isNew);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
