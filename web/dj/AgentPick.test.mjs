// An agent's next-track pick (agent gateway, gate 6).   node web/dj/AgentPick.test.mjs
// A pick shows as a Flow Director pick under the agent's name and plays only when the DJ taps
// it. Only songs left in the running set can be picked, 'next' is off until granted, one pick
// every 30 seconds per agent, the reason goes through the chat filter, and every pick and
// outcome leaves a receipt.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };

const { PickBoard, pickList, pickId, PICK_KIND, PICK_RATE_MS, WHY_MAX, PICKS_SHOWN } = await import('./AgentPick.js');
const { ApprovalQueue, EXPIRE_MS } = await import('./AgentQueue.js');
const { AgentHost, cleanAgentMessage, cleanPerms, deskDirector, GRANT_KINDS } = await import('./AgentLink.js');

const store = () => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });
const t0 = Date.UTC(2026, 9, 19, 20, 0, 0);
const song = (id, title, extra = {}) => ({ id, title, artist: 'Artist ' + id, bpm: 120, key: '8A', streamUrl: `https://x.example/${id}.mp3`, dataFile: `data/${id}.json`, ...extra });
const set = [song('s3', 'Third'), song('s4', 'Fourth'), song('s5', 'Fifth')];
const granted = (id = 'a1', name = 'Alpha') => ({ id, name, perms: { [PICK_KIND]: true } });

console.log('The list an agent picks from');
{
    const list = pickList(set);
    check('ids, titles, artists, tempo and key', list[0].id === 's3' && list[0].title === 'Third' && list[0].bpm === 120 && list[0].key === '8A');
    check('never a stream URL or a file path', !JSON.stringify(list).includes('x.example') && !JSON.stringify(list).includes('data/'));
    check('the same id the Flow Director uses', pickId({ title: 'T', artist: 'A' }) === 'T|A' && pickId({ sourceId: 7 }) === '7');
}

console.log('A pick');
{
    let now = t0;
    const q = new ApprovalQueue({ storage: store(), now: () => now });
    const b = new PickBoard(q, { now: () => now });
    const r0 = b.recommend({ id: 'a1', name: 'Alpha', perms: {} }, { track: 's3', why: 'warmer' }, { pickable: set });
    check("refused until the DJ grants 'next'", !r0.ok && r0.reason === 'not granted' && b.picks.length === 0);
    now += PICK_RATE_MS;
    const r1 = b.recommend(granted(), { track: 's4', why: '  keeps   the energy up  ' }, { pickable: set });
    check('granted: it waits, under the desk\'s name for the agent', r1.ok && b.shown()[0].agent === 'Alpha' && b.shown()[0].title === 'Fourth');
    check('the reason is cleaned', r1.item.why === 'keeps the energy up');
    check('it leaves a receipt with the song and the reason', q.receipts.at(-1).outcome === 'waiting' && q.receipts.at(-1).kind === 'next' && q.receipts.at(-1).text === 'Fourth: keeps the energy up');
    now += 1000;
    const r2 = b.recommend(granted(), { track: 's5' }, { pickable: set });
    check('a second try inside 30 seconds is refused', !r2.ok && r2.reason === 'too fast');
    now += PICK_RATE_MS - 500;
    check('and that try counted: still too fast', b.recommend(granted(), { track: 's5' }, { pickable: set }).reason === 'too fast');
    now += PICK_RATE_MS;
    const r3 = b.recommend(granted(), { track: 's5', why: 'a calmer close' }, { pickable: set });
    check('a newer pick replaces the agent\'s last one', r3.ok && b.picks.length === 1 && b.picks[0].id === 's5' && q.receipts.some((x) => x.pid === r1.item.pid && x.outcome === 'replaced'));
    check('another agent keeps its own clock and its own pick', b.recommend(granted('a2', 'Beta'), { track: 's3' }, { pickable: set }).ok && b.picks.length === 2);
    now += PICK_RATE_MS;
    check('a song not left in the set is refused', b.recommend(granted('a3', 'Gamma'), { track: 'elsewhere' }, { pickable: set }).reason === 'not in the set');
    now += PICK_RATE_MS;
    check('with no set running, nothing can be picked', b.recommend(granted('a3', 'Gamma'), { track: 's3' }, { pickable: [] }).reason === 'no set running');
    now += PICK_RATE_MS;
    check('a link in the reason is refused', b.recommend(granted('a3', 'Gamma'), { track: 's3', why: 'more at evil dot com' }, { pickable: set }).reason === 'link');
    now += PICK_RATE_MS;
    check("the DJ's blocked words are refused", b.recommend(granted('a3', 'Gamma'), { track: 's3', why: 'pure fluffernutter' }, { pickable: set, blocked: ['fluffernutter'] }).reason === 'blocked word');
    now += PICK_RATE_MS;
    const long = b.recommend(granted('a3', 'Gamma'), { track: 's3', why: 'x'.repeat(400) }, { pickable: set });
    check(`a reason is cut to ${WHY_MAX} characters`, long.ok && long.item.why.length === WHY_MAX);
    now += PICK_RATE_MS;
    check('muted: refused', b.recommend(granted('a4', 'Delta'), { track: 's3' }, { pickable: set, muted: true }).reason === 'muted');
    check('no track: refused', b.recommend(granted('a5', 'Eps'), { why: 'hi' }, { pickable: set }).reason === 'not a pick');
    check('refusals are counted, not stacked', q.refusals.find((x) => x.agentId === 'a1' && x.reason === 'too fast')?.count === 2);
    check(`the bar shows at most ${PICKS_SHOWN}, newest first`, b.shown().length === PICKS_SHOWN && b.shown()[0].agent === 'Gamma');
    const pid = b.shown()[0].pid;
    check('dismissed: gone, with a receipt', b.dismiss(pid).outcome === 'dismissed' && !b.find(pid));
    check('taken: gone, with a receipt', b.taken(b.picks[0].pid).outcome === 'played next');
    now += EXPIRE_MS;
    check('one left untouched for ten minutes expires', b.expire().length === 1 && b.picks.length === 0 && q.receipts.at(-1).outcome === 'expired');
}

console.log('The agent channel');
{
    check("'tracks' and 'recommend' are the only new messages", cleanAgentMessage({ t: 'tracks', x: 1 }).t === 'tracks' && cleanAgentMessage({ t: 'recommend', track: 's3', why: 'w', agent: 'Zaal', from: 'host' }).agent === undefined);
    check('a pick carries only a track and a reason', JSON.stringify(cleanAgentMessage({ t: 'recommend', track: 's3', why: 'w', url: 'https://evil' })) === '{"t":"recommend","track":"s3","why":"w"}');
    check('no play, load or cue message exists', cleanAgentMessage({ t: 'play' }) === null && cleanAgentMessage({ t: 'load' }) === null);
    check("'next' is a grant like the others, and starts off", GRANT_KINDS.includes('next') && JSON.stringify(cleanPerms({ next: true, play: true })) === '{"next":true}');
}

console.log('Through the desk');
{
    const relays = [];
    class FakeRelay { constructor(o) { Object.assign(this, o); this.sent = []; relays.push(this); } async open() {} send(m) { this.sent.push(m); } close() {} }
    const mixz = { running: true, human: false, index: 0, plan: [song('s1', 'First'), song('s2', 'Second'), ...set].map((track) => ({ track })), swaps: [], busy: false, renders: 0 };
    mixz.swapNext = (t) => { if (mixz.busy) return false; mixz.swaps.push(t.id); return true; };
    mixz._renderBar = () => { mixz.renders++; };
    const dj = { djMixz: mixz };
    let clock = t0;
    const host = new AgentHost({ secrets: () => [], RelayClass: FakeRelay, storage: store(), now: () => (clock += PICK_RATE_MS), director: deskDirector(dj) });
    const a = host.add('Alpha');
    await host.start();
    const r = relays[0];
    r.onMessage({ t: 'hello' });
    r.onMessage({ t: 'tracks' });
    check('before the grant, the set is not shown', r.sent.at(-1).t === 'tracks' && r.sent.at(-1).list.length === 0 && r.sent.at(-1).reason === 'not granted');
    host.grant(a.agent.id, 'next', true);
    r.onMessage({ t: 'tracks' });
    check('granted: the songs after the next one, nothing already playing or locked in', r.sent.at(-1).list.map((x) => x.id).join() === 's3,s4,s5');
    r.onMessage({ t: 'recommend', track: 's2', why: 'w' });
    check('the song already up next cannot be picked', r.sent.at(-1).status === 'refused' && r.sent.at(-1).reason === 'not in the set');
    r.onMessage({ t: 'recommend', track: 's4', why: 'brighter', agent: 'Zaal' });
    check('a pick waits, and nothing played', r.sent.at(-1).status === 'waiting' && mixz.swaps.length === 0 && host.picks.shown()[0].agent === 'Alpha');
    check('the bar is redrawn to show it', mixz.renders === 1);
    const pid = host.picks.shown()[0].pid;
    mixz.busy = true;
    check('a tap during a handover changes nothing, and the pick stays', host.playPick(pid) === false && host.picks.find(pid));
    mixz.busy = false;
    check('a tap plays it next through SWAP', host.playPick(pid) === true && mixz.swaps.join() === 's4' && !host.picks.find(pid) && host.queue.receipts.at(-1).outcome === 'played next');
    r.onMessage({ t: 'recommend', track: 's5' });
    host.setMuted(true);
    check('MUTE ALL AGENTS drops waiting picks, with a receipt', host.picks.picks.length === 0 && host.queue.receipts.at(-1).outcome === 'dropped' && host.queue.receipts.at(-1).reason === 'muted');
    r.onMessage({ t: 'recommend', track: 's5' });
    check('muted: a new pick is refused', r.sent.at(-1).status === 'refused' && r.sent.at(-1).reason === 'muted');
    r.onMessage({ t: 'tracks' });
    check('muted: no set list either', r.sent.at(-1).t === 'muted');
    host.setMuted(false);
    r.onMessage({ t: 'recommend', track: 's5' });
    const p2 = host.picks.shown()[0]?.pid;
    host.muted = true;   // a mute landing between the bar drawing and the DJ's tap
    check('muted: a tap on a pick still on screen plays nothing', !!p2 && host.playPick(p2) === false && mixz.swaps.length === 1 && host.picks.find(p2));
    host.setMuted(false);
    r.onMessage({ t: 'recommend', track: 's5' });
    host.remove(a.agent.id);
    check("removing an agent drops its pick", host.picks.picks.length === 0 && host.queue.receipts.at(-1).reason === 'agent removed');
    mixz.human = true;
    check('when the DJ has the decks, there is nothing to pick from', deskDirector(dj).pickable().length === 0);
    check('without DJ MixZ, nothing either', deskDirector({}).pickable().length === 0 && deskDirector({}).swap(set[0]) === false);
}

console.log('A pick whose song is no longer waiting');
{
    const relays = [];
    class FakeRelay { constructor(o) { Object.assign(this, o); this.sent = []; relays.push(this); } async open() {} send(m) { this.sent.push(m); } close() {} }
    const mixz = { running: true, human: false, index: 0, plan: [song('s1', 'First'), song('s2', 'Second'), ...set].map((track) => ({ track })), swaps: [], renders: 0 };
    mixz.swapNext = (t) => { mixz.swaps.push(t.id); return true; };
    mixz._renderBar = () => { mixz.renders++; };
    let clock = t0;
    const host = new AgentHost({ secrets: () => [], RelayClass: FakeRelay, storage: store(), now: () => clock, director: deskDirector({ djMixz: mixz }) });
    const a = host.add('Alpha');
    host.grant(a.agent.id, 'next', true);
    await host.start();
    const r = relays[0];
    r.onMessage({ t: 'hello' });
    r.onMessage({ t: 'tracks' });
    r.onMessage({ t: 'tracks' });
    check('a second set list inside 5 seconds is refused', r.sent.at(-1).list.length === 0 && r.sent.at(-1).reason === 'too fast');
    clock += 5000;
    r.onMessage({ t: 'tracks' });
    check('after 5 seconds the list comes again', r.sent.at(-1).list.length === 3);
    r.onMessage({ t: 'recommend', track: 's4', why: 'w' });
    const pid = host.picks.shown()[0].pid;
    check('while s4 still waits, the bar shows the pick', host.shownPicks().length === 1);
    mixz.index = 3;   // the set moved on: s4 is playing now
    check('once s4 is playing, the bar no longer shows it', host.shownPicks().length === 0);
    check('a tap on it swaps nothing', host.playPick(pid) === false && mixz.swaps.length === 0);
    check('and it closes with a receipt', !host.picks.find(pid) && host.queue.receipts.at(-1).outcome === 'dropped' && host.queue.receipts.at(-1).reason === 'not in the set');
    mixz.index = 0;
    clock += PICK_RATE_MS;
    r.onMessage({ t: 'recommend', track: 's5', why: 'w' });
    mixz.running = false;   // the set stopped
    const gone = host.closeStalePicks();
    check('when the set stops, waiting picks close by themselves', gone.length === 1 && host.picks.picks.length === 0 && gone[0].reason === 'not in the set');
    host.stop();
}

console.log('The DJ MixZ bar');
{
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'DjMixz.js'), 'utf8');
    const bar = src.slice(src.indexOf('_renderBar() {'), src.indexOf('// ── Panel'));
    check("each pick is labelled with the agent's name", bar.includes('AI PICK FROM ${esc(p.agent)}: ${esc(p.title)}'));
    check('everything an agent wrote is escaped', bar.includes('data-pid="${esc(p.pid)}"') && bar.includes('title="${esc(p.why'));
    check('picks are hidden during a handover', /picks = !busy \?/.test(bar));
    check('the bar shows only picks still waiting in the set', bar.includes('this.dj.agents?.shownPicks?.()') && !bar.includes('picks?.shown?.()'));
    check('a tap goes through the agent host, not straight to the decks', bar.includes("agents?.playPick?.(el.dataset.pid)") && !/agentpick[^\n]*swapNext/.test(bar));
    const sw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'sw.js'), 'utf8');
    check('AgentPick.js is in the offline shell', sw.includes("'/dj/AgentPick.js'"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
