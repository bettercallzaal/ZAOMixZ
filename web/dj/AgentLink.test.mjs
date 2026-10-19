// Who an agent is, decided by the desk (gateway gate 1).   node web/dj/AgentLink.test.mjs
// An agent gets a key of its own, never the phone link's. The desk knows it by the channel a
// message arrives on, stamps it, and drops anything it says about itself or may not send.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };

const { agentName, agentKey, tokenFromKey, newAgent, cleanAgentMessage, stampAgent, forAgents, AgentHost, AGENTS_KEY, MAX_AGENTS } = await import('./AgentLink.js');
const { validToken } = await import('./RemoteLink.js');
const { autoPick, RequestQueue } = await import('./RequestLine.js');
const { envelope } = await import('./StreamEvents.js');

const store = () => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });
const relays = [];
class FakeRelay {
    constructor(o) { Object.assign(this, o); this.sent = []; this.closed = false; relays.push(this); }
    async open() {}
    send(m) { this.sent.push(m); }
    close() { this.closed = true; }
}

console.log('AgentLink: an agent has a key of its own');
{
    const st = store();
    st.setItem('mixz-remote-token', 'f'.repeat(32));
    const host = new AgentHost({ RelayClass: FakeRelay, storage: st });
    const made = host.add('Next-Track Bot');
    const token = tokenFromKey(made.key);
    check('the key holds a fresh token of its own', validToken(token) && made.key.startsWith('mza1.'));
    check('never the phone link token', token !== st.getItem('mixz-remote-token') && !made.key.includes('f'.repeat(32)));
    const two = host.add('Other');
    check('two agents never share a key', tokenFromKey(two.key) !== token);
    check('the list the desk shows has no keys in it', !JSON.stringify(host.list()).includes(token) && host.list().length === 2);
    check('a key that is not one is refused', tokenFromKey('mza1.nothex') === null && tokenFromKey('f'.repeat(32)) === null);
}

console.log('AgentLink: names are the desk\'s');
check('a name keeps only plain characters', agentName('<img src=x>Bot') === 'img srcxBot' && agentName('  DJ   Helper ') === 'DJ Helper');
check('an empty name is Agent', agentName('') === 'Agent' && agentName('<>') === 'Agent');
check('at most 24 characters', agentName('x'.repeat(60)).length === 24);

console.log('AgentLink: what an agent says about itself is dropped');
const bot = newAgent('Bot');
const stamped = stampAgent(bot, { track: 't1', from: 'phone', agent: 'Zaal', role: 'host', device: 'abc', name: 'Zaal' });
check('every proposal is stamped from: agent, with the desk\'s name for it', stamped.from === 'agent' && stamped.agent === 'Bot' && stamped.agentId === bot.id);
check('a claimed role, device or name is gone', !('role' in stamped) && !('device' in stamped) && !('name' in stamped) && stamped.track === 't1');
check('in gate 1 an agent may only say hello and ping', cleanAgentMessage({ t: 'hello', role: 'host' })?.role === undefined && cleanAgentMessage({ t: 'ping', n: 3 })?.n === 3);
for (const t of ['cmd', 'req', 'agent.recommendation', 'request.new', 'welcome', 'share']) check(`"${t}" from an agent is dropped`, cleanAgentMessage({ t, a: 'play', d: 'A' }) === null);

console.log('AgentLink: a request from an agent never plays by itself');
{
    const q = new RequestQueue();
    q.items.push({ rid: 'r1', status: 'waiting', ...stampAgent(bot, { title: 'x' }) });
    check('AUTO-PLAY REQUESTS on, decks running, nobody at them: still waits', autoPick(q, { on: true, running: true, human: false }) === null);
}

console.log('AgentLink: the desk side');
{
    relays.length = 0;
    const st = store();
    const host = new AgentHost({ RelayClass: FakeRelay, storage: st });
    const a = host.add('Alpha'), b = host.add('Beta');
    await host.start();
    check('one channel per agent, each on its own token', relays.length === 2 && relays[0].token === tokenFromKey(a.key) && relays[1].token === tokenFromKey(b.key) && relays.every((r) => r.role === 'host'));
    relays[0].onMessage({ t: 'hello', name: 'Beta' });
    check('hello is answered with the desk\'s name for it, not the one it claimed', relays[0].sent.at(-1).name === 'Alpha' && relays[0].sent.at(-1).role === 'agent');
    relays[0].onMessage({ t: 'cmd', a: 'play', d: 'A' });
    check('a deck command is not answered or acted on', relays[0].sent.length === 1);
    const ev = envelope('track.changed', { title: 'Song' }, 1);
    host.sendEvent(ev);
    check('stream events go to a connected agent, not to one that never said hello', relays[0].sent.at(-1).ev === ev && relays[1].sent.length === 0);
    host.sendEvent({ v: 1, type: 'deck.load', data: {} });
    host.sendEvent({ t: 'state', decks: {} });
    check('only the published event types reach agents', relays[0].sent.filter((m) => m.t === 'ev').length === 1 && !forAgents({ v: 1, type: 'deck.load' }));
    host.remove(a.agent.id);
    check('one agent can be cut off: its channel closes and its key is forgotten', relays[0].closed && !JSON.parse(st.getItem(AGENTS_KEY)).some((x) => x.id === a.agent.id));
    relays[0].onMessage({ t: 'hello' });
    check('and it gets no answer after', relays[0].sent.filter((m) => m.t === 'welcome').length === 1);
    while (host.agents.length < MAX_AGENTS) host.add('more');
    check(`at most ${MAX_AGENTS} agents`, host.add('one too many') === null);
}

console.log('AgentLink: events reach agents only on air');
{
    const posted = [];
    globalThis.BroadcastChannel = class { postMessage(m) { posted.push(m); } };
    const { StreamBroadcast } = await import('./StreamBroadcast.js');
    const { StreamEvents } = await import('./StreamEvents.js');
    const got = [];
    const dj = { decks: {}, audioRouter: { ctx: { state: 'running' } }, agents: { sendEvent: (e) => got.push(e) } };
    dj.broadcast = new StreamBroadcast(dj.audioRouter, null);
    const se = new StreamEvents(dj, { every: 0 });
    se.emit('chat.message', { text: 'hi' });
    check('off air: nothing to agents', got.length === 0);
    dj.broadcast.isLive = true;
    se.emit('chat.message', { text: 'hi' });
    check('on air: the event goes to agents too', got.length === 1 && got[0].type === 'chat.message');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
