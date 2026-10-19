// An approved agent draft is labelled as AI where the audience sees it (gateway gate 4).
//   node web/dj/AgentPost.test.mjs

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };

const { AI_LABEL, agentPostData, showAgentPost } = await import('./AgentPost.js');
const { AgentHost } = await import('./AgentLink.js');
const { OUT_TYPES } = await import('./StreamEvents.js');

const store = () => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });

console.log('What goes out');
const approved = agentPostData({ outcome: 'approved', agent: 'Hype Bot', kind: 'comment', text: 'great', published: 'great' });
check('an approval becomes a post marked as AI', approved?.text === 'great' && approved.ai === true && approved.agent === 'Hype Bot' && approved.edited === false);
const edited = agentPostData({ outcome: 'edited', agent: 'Hype Bot', kind: 'question', text: 'original', published: 'as the DJ wrote it' });
check('an edited approval publishes the DJ\'s text, not the agent\'s', edited.text === 'as the DJ wrote it' && edited.edited === true && edited.kind === 'question');
check('nothing else is published: declined, expired, dropped, refused', ['declined', 'expired', 'dropped', 'refused', 'waiting'].every((o) => agentPostData({ outcome: o, published: 'x', text: 'x' }) === null));
check('agent.post is a published stream event', OUT_TYPES.includes('agent.post'));

console.log('Only the DJ\'s approval publishes');
{
    const posts = [];
    const relays = [];
    class FakeRelay { constructor(o) { Object.assign(this, o); this.sent = []; relays.push(this); } async open() {} send(m) { this.sent.push(m); } close() {} }
    let clock = Date.UTC(2026, 9, 19);
    const host = new AgentHost({ RelayClass: FakeRelay, storage: store(), publish: (type, data) => posts.push({ type, data }), now: () => (clock += 21000) });
    const a = host.add('Hype Bot');
    host.grant(a.agent.id, 'comment', true);
    await host.start();
    const r = relays[0];
    r.onMessage({ t: 'hello' });
    for (const text of ['one', 'two', 'three']) r.onMessage({ t: 'propose', kind: 'comment', text });
    check('three drafts waiting publish nothing', host.pending.length === 3 && posts.length === 0);
    const [p1, p2, p3] = host.pending.map((x) => x.pid);
    host.decide(p1, true);
    check('approving publishes one agent.post', posts.length === 1 && posts[0].type === 'agent.post' && posts[0].data.text === 'one' && posts[0].data.ai === true);
    host.decide(p2, false);
    check('declining publishes nothing', posts.length === 1);
    // A mute that lands between the panel drawing and the DJ's tap: the draft is still there
    host.muted = true;
    host.decide(p3, true);
    check('approving while muted publishes nothing', posts.length === 1);
    host.muted = false;
    r.onMessage({ t: 'propose', kind: 'comment', text: 'four' });
    const p4 = host.pending.at(-1).pid;
    host.setMuted(true);
    check('muting drops the rest, so nothing is left to publish', host.pending.length === 0 && host.decide(p4, true) === null && posts.length === 1);
}

console.log('The overlay card');
{
    const made = [];
    const el = (tag) => { const e = { tag, children: [], className: '', id: '', _text: '', classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); } }, appendChild(c) { this.children.push(c); return c; }, set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text; }, set innerHTML(v) { throw new Error('innerHTML used'); } }; made.push(e); return e; };
    const body = el('body');
    const byId = {};
    const doc = { body, createElement: el, getElementById: (id) => byId[id] || null };
    body.appendChild = (c) => { byId[c.id] = c; body.children.push(c); return c; };
    let timer = null;
    const evil = '<img src=x onerror=1>';
    const card = showAgentPost(doc, { agent: evil, kind: 'comment', text: evil, label: 'not AI at all' }, { setTimer: (f) => { timer = f; } });
    const [label, who, text] = card.children;
    check('the card always says it is an AI suggestion approved by the host', label.textContent === AI_LABEL);
    check('a label in the event is ignored: the overlay\'s own text is shown', !made.some((e) => e.textContent.includes('not AI at all')));
    check('the agent\'s name and the text are plain text, never markup', text.textContent === evil && who.textContent.includes(evil) && card.classList.s.has('visible'));
    timer();
    check('it hides itself after a while', !card.classList.s.has('visible'));
    check('an empty post shows nothing', showAgentPost(doc, { text: '' }) === null && showAgentPost(doc, null) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
