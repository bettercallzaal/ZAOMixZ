// MUTE ALL AGENTS (gateway gate 2).   node web/dj/AgentMute.test.mjs
// One control on the desk, always there while an agent is connected, and on the DJ's phone.
// Muted: every pending agent proposal is dropped, new ones are refused, no events go out.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };

const { AgentHost, MUTED_KEY } = await import('./AgentLink.js');
const { cleanCommand, applyCommand, snapshot, VIEWER_OK } = await import('./RemoteLink.js');
const { envelope } = await import('./StreamEvents.js');

const store = () => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });
const relays = [];
class FakeRelay {
    constructor(o) { Object.assign(this, o); this.sent = []; relays.push(this); }
    async open() {}
    send(m) { this.sent.push(m); }
    close() {}
}
const ev = () => envelope('track.changed', { title: 'Song' }, 1);

console.log('Muting');
const st = store();
const host = new AgentHost({ RelayClass: FakeRelay, storage: st });
host.add('Alpha');
await host.start();
const r = relays[0];
r.onMessage({ t: 'hello' });
host.accept({ kind: 'recommendation', track: 't1' });
host.accept({ kind: 'comment', text: 'hi' });
check('before: proposals wait and events go out', host.pending.length === 2 && (host.sendEvent(ev()), r.sent.some((m) => m.t === 'ev')));
host.setMuted(true);
check('muting drops every pending proposal', host.pending.length === 0);
check('and tells every agent it is muted', r.sent.at(-1).t === 'muted' && r.sent.at(-1).on === true);
check('a new proposal is refused', host.accept({ kind: 'recommendation', track: 't2' }) === null && host.pending.length === 0);
const before = r.sent.filter((m) => m.t === 'ev').length;
host.sendEvent(ev());
check('no events go to agents', r.sent.filter((m) => m.t === 'ev').length === before);
r.onMessage({ t: 'hello' });
check('an agent saying hello is told it is muted, not welcomed', r.sent.at(-1).t === 'muted' && !r.sent.slice(-1).some((m) => m.t === 'welcome'));
check('muted stays muted across a reload', st.getItem(MUTED_KEY) === 'on' && new AgentHost({ RelayClass: FakeRelay, storage: st }).muted === true);
host.setMuted(false);
host.sendEvent(ev());
check('unmuting lets events and proposals through again', r.sent.at(-1).t === 'ev' && host.accept({ kind: 'recommendation', track: 't3' }) !== null);

console.log('The desk button');
{
    const btn = { style: {}, dataset: {}, textContent: '', classList: { toggle() {} }, handlers: [], addEventListener(_e, f) { this.handlers.push(f); } };
    const doc = { getElementById: (id) => (id === 'agents-mute' ? btn : null) };
    const h = new AgentHost({ RelayClass: FakeRelay, storage: store() });
    h.renderMute(doc);
    check('hidden with no agent connected and not muted', btn.style.display === 'none');
    h.add('Beta'); relays.length = 0; await h.start(); relays[0].onMessage({ t: 'hello' });
    h.renderMute(doc);
    check('shown the moment an agent is connected, with how many', btn.style.display === '' && btn.textContent === 'MUTE ALL AGENTS (1)');
    btn.handlers[0]();
    check('one tap mutes them all', h.muted && btn.textContent === 'AGENTS MUTED: UNMUTE');
    h.links.clear();
    h.renderMute(doc);
    check('still shown while muted, even with nobody connected, so it can be undone', btn.style.display === '');
    h.renderMute(doc);
    check('wired once, not once per refresh', btn.handlers.length === 1);
}

console.log('The DJ\'s phone');
{
    const h = new AgentHost({ RelayClass: FakeRelay, storage: store() });
    const dj = { agents: h, decks: {}, audioRouter: {} };
    const cmd = cleanCommand({ a: 'agentsmute', on: 1 });
    check('the phone may send MUTE AGENTS', cmd?.a === 'agentsmute' && cmd.on === true);
    check('a viewer link may not', !VIEWER_OK.has('agentsmute'));
    applyCommand(dj, cmd);
    check('it mutes the desk\'s agents', h.muted === true);
    check('the phone sees how many agents and whether they are muted', JSON.stringify(snapshot(dj).agents) === JSON.stringify({ n: 0, muted: true }));
    applyCommand(dj, cleanCommand({ a: 'agentsmute', on: 0 }));
    check('and can unmute', h.muted === false);
    check('with no agents at the desk the phone gets no agents line', snapshot({ decks: {}, audioRouter: {} }).agents === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
