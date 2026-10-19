// The approval queue and receipts (agent gateway, gate 3).   node web/dj/AgentQueue.test.mjs
// Agents propose, the DJ decides. Nothing is published without a tap, every kind is off for
// every agent until granted, and every proposal and decision leaves a receipt.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };

const { ApprovalQueue, cleanProposal, queueHtml, EXPIRE_MS, PENDING_PER_AGENT, RECEIPTS_KEY, REFUSALS_KEY, PROPOSAL_MAX } = await import('./AgentQueue.js');
const { AgentHost, cleanAgentMessage } = await import('./AgentLink.js');

const store = () => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });
const t0 = Date.UTC(2026, 9, 19, 18, 0, 0);
const bot = { id: 'a1', name: 'Bot', perms: { comment: true } };

console.log('Drafts');
check('a comment or a question is a draft', cleanProposal({ kind: 'comment', text: ' hi  there ' })?.text === 'hi there' && cleanProposal({ kind: 'question', text: 'why?' })?.kind === 'question');
check('anything else is not', cleanProposal({ kind: 'play', text: 'x' }) === null && cleanProposal({ kind: 'comment', text: '   ' }) === null && cleanProposal({ kind: 'comment', text: 5 }) === null && cleanProposal(null) === null);
check(`at most ${PROPOSAL_MAX} characters, control characters gone`, cleanProposal({ kind: 'comment', text: 'x'.repeat(999) }).text.length === PROPOSAL_MAX && cleanProposal({ kind: 'comment', text: 'a\u0000b‮c' }).text === 'a b c');

console.log('Nothing is proposed without a grant, and every try is on record');
{
    let now = t0;
    const st = store();
    const q = new ApprovalQueue({ storage: st, now: () => now });
    const no = q.propose({ id: 'a2', name: 'Other', perms: {} }, { kind: 'comment', text: 'hello' });
    check('a kind the DJ never granted is refused', !no.ok && no.reason === 'not granted' && q.pending.length === 0);
    check('and the refusal is on record', q.refusals.at(-1).reason === 'not granted' && q.refusals.at(-1).agent === 'Other' && q.refusals.at(-1).count === 1);
    check('a granted comment does not stretch to questions', !q.propose(bot, { kind: 'question', text: 'q?' }).ok);
    const ok = q.propose(bot, { kind: 'comment', text: 'great set' });
    check('a granted kind waits for the DJ', ok.ok && q.pending.length === 1 && q.receipts.at(-1).outcome === 'waiting');
    check('muted: refused, on record', !q.propose(bot, { kind: 'comment', text: 'x' }, { muted: true }).ok && q.refusals.at(-1).reason === 'muted');
    for (let i = 0; i < PENDING_PER_AGENT; i++) q.propose(bot, { kind: 'comment', text: `n${i}` });
    check(`at most ${PENDING_PER_AGENT} waiting per agent`, q.pending.filter((x) => x.agentId === 'a1').length === PENDING_PER_AGENT && q.refusals.at(-1).reason === 'too many waiting');

    console.log('The DJ decides');
    const [first, second, third] = q.pending;
    const ap = q.decide(first.pid, true);
    check('approved as written', ap.outcome === 'approved' && ap.published === 'great set' && !q.pending.includes(first));
    const ed = q.decide(second.pid, true, { text: 'n0, edited by the DJ' });
    check('approved with changes is recorded as edited, with both texts', ed.outcome === 'edited' && ed.text === 'n0' && ed.published === 'n0, edited by the DJ');
    const de = q.decide(third.pid, false);
    check('declined', de.outcome === 'declined' && q.pending.length === 0);
    check('deciding twice does nothing', q.decide(first.pid, true) === null);
    const blank = q.propose(bot, { kind: 'comment', text: 'keep me' }).item;
    check('APPROVE with the text emptied does not publish the original: it keeps waiting', q.decide(blank.pid, true, { text: '   ' }) === null && q.pending.includes(blank));
    q.decide(blank.pid, false);

    console.log('Expiry and receipts');
    q.propose(bot, { kind: 'comment', text: 'late' });
    now += EXPIRE_MS - 1; q.expire();
    check('still waiting just before ten minutes', q.pending.length === 1);
    now += 1; const gone = q.expire();
    check('expired at ten minutes, with a receipt', q.pending.length === 0 && gone[0].outcome === 'expired');
    check('receipts survive a reload', new ApprovalQueue({ storage: st }).receipts.length === q.receipts.length && JSON.parse(st.getItem(RECEIPTS_KEY)).some((r) => r.outcome === 'edited'));
    const file = JSON.parse(q.exportText());
    check('and can be saved as a file', file.v === 1 && file.receipts.length === q.receipts.length);
}

console.log('Through the desk');
{
    const relays = [];
    class FakeRelay { constructor(o) { Object.assign(this, o); this.sent = []; relays.push(this); } async open() {} send(m) { this.sent.push(m); } close() {} }
    const host = new AgentHost({ RelayClass: FakeRelay, storage: store() });
    const a = host.add('Alpha');
    await host.start();
    const r = relays[0];
    r.onMessage({ t: 'hello' });
    r.onMessage({ t: 'propose', kind: 'comment', text: 'hi chat', agent: 'Zaal', from: 'host' });
    check('an agent\'s draft is refused until the DJ grants the kind', host.pending.length === 0 && r.sent.at(-1).status === 'refused' && r.sent.at(-1).reason === 'not granted');
    check('every kind starts off', JSON.stringify(host.list()[0].perms) === '{}');
    host.grant(a.agent.id, 'comment', true);
    r.onMessage({ t: 'propose', kind: 'comment', text: 'hi chat', agent: 'Zaal', from: 'host' });
    check('granted: it waits, stamped with the desk\'s name for the agent, not the one it claimed', host.pending.length === 1 && host.pending[0].agent === 'Alpha' && r.sent.at(-1).status === 'waiting');
    check('grants are kept with the agent', JSON.parse(host.storage.getItem('mixz-agents'))[0].perms.comment === true);
    check('a made-up kind cannot be granted', host.grant(a.agent.id, 'play', true) === false);
    host.setMuted(true);
    check('MUTE ALL AGENTS drops what waits, each with a receipt', host.pending.length === 0 && host.queue.receipts.at(-1).outcome === 'dropped' && host.queue.receipts.at(-1).reason === 'muted');
    r.onMessage({ t: 'propose', kind: 'comment', text: 'again' });
    check('muted: a new draft is refused and still recorded', host.pending.length === 0 && host.queue.refusals.at(-1).reason === 'muted' && r.sent.at(-1).status === 'refused');
    host.setMuted(false);
    r.onMessage({ t: 'propose', kind: 'comment', text: 'one more' });
    host.remove(a.agent.id);
    check('cutting off an agent drops its drafts, with a receipt', host.pending.length === 0 && host.queue.receipts.at(-1).reason === 'agent removed');
    check('a propose message keeps only kind and text', JSON.stringify(cleanAgentMessage({ t: 'propose', kind: 'comment', text: 'x', agent: 'Z', publish: true })) === JSON.stringify({ t: 'propose', kind: 'comment', text: 'x' }));
}

console.log('An agent sending junk cannot wipe the record');
{
    const st = store();
    const q = new ApprovalQueue({ storage: st, now: () => t0 });
    const it = q.propose(bot, { kind: 'comment', text: 'a real one' }).item;
    q.decide(it.pid, true);
    const nobody = { id: 'z', name: 'Flooder', perms: {} };
    for (let i = 0; i < 5000; i++) q.propose(nobody, { kind: i % 2 ? 'comment' : 'question', text: `spam ${i}` });
    for (let i = 0; i < 2000; i++) q.propose(nobody, { kind: 'bogus', text: 'x' });
    check('7000 refused tries later the DJ\'s approval is still there', q.receipts.some((r) => r.outcome === 'approved' && r.text === 'a real one'));
    check('the tries are counted on three lines, not 7000', q.refusals.length === 3 && q.refusals.reduce((t, r) => t + r.count, 0) === 7000);
    check('refusals are stored apart from decisions', JSON.parse(st.getItem(REFUSALS_KEY)).length === 3 && !JSON.parse(st.getItem(RECEIPTS_KEY)).some((r) => r.outcome === 'refused'));
    check('the saved file has both', JSON.parse(q.exportText()).refusals.length === 3);
}

console.log('The DJ\'s panel');
{
    const evil = '<img src=x onerror=1>';
    const html = queueHtml([{ pid: 'p"1', agent: evil, kind: 'comment', text: evil, at: t0 }], [{ at: t0, agent: evil, kind: 'comment', outcome: 'declined', text: evil }], t0, [{ agent: evil, reason: evil, kind: 'comment', count: 4 }]);
    check('everything an agent wrote is escaped', !html.includes('<img') && html.includes('&lt;img') && !html.includes('p"1'));
    check('each draft is labelled as AI, with the agent\'s name, and has APPROVE and DECLINE', html.includes('AI COMMENT') && html.includes('APPROVE') && html.includes('DECLINE'));
    check('it says nothing goes out without approval', html.includes('nothing goes out until you approve it'));
    check('refusals show as one line with a count', html.includes('refused 4 times'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
