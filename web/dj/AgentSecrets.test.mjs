// No credentials reach an agent (agent gateway, gate 7).   node web/dj/AgentSecrets.test.mjs
// Every message for an agent leaves through AgentHost._send. With every secret the desk holds
// planted (the phone link's token, the Spotify tokens and verifier, each agent's own token, the
// Twitch chat OAuth token, the YouTube key), every kind of message an agent can be sent is
// driven, and none of them carries one. A message that would is held back, with a refusal that
// says why and never what.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
globalThis.document = { getElementById: () => null };

const { leak, storedSecrets, deskSecrets, CREDENTIAL_SHAPES, SECRET_STORE_KEYS, SECRET_SESSION_KEYS, MIN_SECRET } = await import('./AgentSecrets.js');
const { AgentHost, deskDirector, agentKey, AGENT_KEY_PREFIX } = await import('./AgentLink.js');
const { PICK_KIND } = await import('./AgentPick.js');
const { envelope, OUT_TYPES } = await import('./StreamEvents.js');
const { remoteUrl } = await import('./RemoteLink.js');
const { REFUSALS_KEY, RECEIPTS_KEY } = await import('./AgentQueue.js');

const here = dirname(fileURLToPath(import.meta.url));
const store = (data = {}) => ({ data: { ...data }, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });
const hex = (c) => c.repeat(32);

// Every secret the desk can hold, each a distinct value
const PHONE = hex('a');
const SPOTIFY = 'BQD' + 'x'.repeat(40), SPOTIFY_REFRESH = 'AQC' + 'y'.repeat(40), VERIFIER = 'v'.repeat(43);
const TWITCH = 'twitchoauthvalue0123456789abcd';
const YOUTUBE = 'AIzaSy' + 'Z'.repeat(33);
const planted = () => store({ 'mixz-remote-token': PHONE, aurdour_spotify_token: SPOTIFY, aurdour_spotify_refresh: SPOTIFY_REFRESH });
const session = () => store({ spotify_code_verifier: VERIFIER });
const dj = (mixz) => ({ djMixz: mixz, twitchChat: { oauthToken: TWITCH, isAuthenticated: true }, youtubeLive: { apiKey: YOUTUBE }, spotify: { accessToken: SPOTIFY, refreshToken: SPOTIFY_REFRESH } });

console.log('What counts as a secret');
{
    check('the browser keeps three, the session one', SECRET_STORE_KEYS.length === 3 && SECRET_SESSION_KEYS.length === 1);
    const s = storedSecrets(planted(), session());
    check('the phone token, both Spotify tokens and the verifier are read', [PHONE, SPOTIFY, SPOTIFY_REFRESH, VERIFIER].every((v) => s.includes(v)));
    check('storage that throws gives nothing, not an error', storedSecrets({ getItem() { throw new Error('blocked'); } }, null).length === 0);
    const d = deskSecrets(dj());
    check('in memory: the Twitch OAuth token, the YouTube key, the Spotify tokens', [TWITCH, YOUTUBE, SPOTIFY, SPOTIFY_REFRESH].every((v) => d.includes(v)));
    check('a desk without them gives nothing', deskSecrets({}).length === 0 && deskSecrets(null).length === 0);
    check('the agent key shape is the real prefix', AGENT_KEY_PREFIX === 'mza1.' && leak({ k: agentKey(hex('b')) }) === 'agent key');
}

console.log('leak');
{
    check('a plain event passes', leak(envelope('track.changed', { title: 'Rude Boy', artist: 'IMan Afrikah', link: 'https://audius.co/x/rude-boy' }, 1)) === null);
    check('a known secret anywhere in it is caught', leak({ ev: { data: { title: `x ${TWITCH} y` } } }, [TWITCH]) === 'secret');
    check('even written with JSON escapes', leak({ t: 'x"y\\z' }, ['x"y\\z12345']) === null && leak({ t: 'ab"cd\\efgh' }, ['ab"cd\\efgh']) === 'secret');
    check(`values under ${MIN_SECRET} characters are not matched`, leak({ t: 'the' }, ['the']) === null);
    check('an OAuth token', leak({ t: 'oauth:abc' }) === 'oauth token');
    check('the phone link', leak({ t: remoteUrl('https://zaomixz.vercel.app', hex('c')) }) === 'phone link');
    check('a key in a link', leak({ u: 'https://www.googleapis.com/youtube/v3/videos?id=1&key=abc' }) === 'key in a link' && leak({ u: 'https://x.example/?apikey=1' }) === 'key in a link' && leak({ u: '/cb#access_token=1' }) === 'key in a link');
    check('a bearer token', leak({ h: 'Bearer ' + 'k'.repeat(24) }) === 'bearer token');
    check('a JWT, such as the SongChainn key', leak({ k: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlc2ln' }) === 'jwt');
    check('song titles with those words still pass', leak({ list: [{ title: 'Bearer of Bad News' }, { title: 'Token Love' }, { title: 'OAuth Blues' }, { title: 'Key Change' }] }) === null);
    const loop = {}; loop.self = loop;
    check('a message that cannot be read is held', leak(loop) === 'unreadable');
    check('every shape has a name', CREDENTIAL_SHAPES.every(([n, re]) => typeof n === 'string' && re instanceof RegExp));
}

// A desk with every secret planted, two agents, a running set and everything an agent can be sent
async function desk({ secrets, mixzSet } = {}) {
    const relays = [];
    class FakeRelay { constructor(o) { Object.assign(this, o); this.sent = []; relays.push(this); } async open() {} send(m) { this.sent.push(m); } close() {} }
    const song = (id, title) => ({ id, title, artist: 'Artist ' + id, bpm: 120, key: '8A' });
    const mixz = { running: true, human: false, index: 0, plan: (mixzSet || [song('s1', 'First'), song('s2', 'Second'), song('s3', 'Third'), song('s4', 'Fourth')]).map((track) => ({ track })), swapNext: () => true, _renderBar() {} };
    const d = dj(mixz);
    const storage = planted();
    let clock = Date.UTC(2026, 9, 19, 20, 0, 0);
    const host = new AgentHost({ RelayClass: FakeRelay, storage, session: session(), now: () => (clock += 60000), director: deskDirector(d), secrets: secrets || (() => deskSecrets(d)) });
    const a = host.add('Alpha'), b = host.add('Beta');
    for (const x of [a, b]) for (const k of ['comment', 'question', PICK_KIND]) host.grant(x.agent.id, k, true);
    await host.start();
    for (const r of relays) r.onMessage({ t: 'hello' });
    return { host, relays, storage, keys: [a.key, b.key], tokens: host.agents.map((x) => x.token) };
}
const sentText = (relays) => relays.map((r) => JSON.stringify(r.sent)).join('\n');

console.log('Every kind of message, every secret planted');
{
    const { host, relays, storage, keys, tokens } = await desk();
    const [r] = relays;
    r.onMessage({ t: 'ping', n: 3 });
    r.onMessage({ t: 'tracks' });
    r.onMessage({ t: 'recommend', track: 's3', why: 'warmer' });
    r.onMessage({ t: 'propose', kind: 'comment', text: 'what a blend' });
    r.onMessage({ t: 'propose', kind: 'nope', text: 'x' });
    const pid = host.pending[0]?.pid;
    for (const type of OUT_TYPES) host.sendEvent(envelope(type, { title: 'Rude Boy', artist: 'IMan Afrikah', note: type }, 1));
    host.setMuted(true);
    r.onMessage({ t: 'ping', n: 4 });
    host.setMuted(false);
    if (pid) host.decide(pid, true);
    const kinds = new Set(relays.flatMap((x) => x.sent.map((m) => m.t)));
    const all = sentText(relays);
    const n = relays.reduce((t, x) => t + x.sent.length, 0);
    check(`messages went out: ${n}, of kinds ${[...kinds].sort().join(' ')}`, n >= 20 && ['welcome', 'pong', 'tracks', 'pick', 'proposal', 'ev', 'muted'].every((k) => kinds.has(k)));
    check('every published event type reached both agents', OUT_TYPES.every((type) => relays.every((x) => x.sent.some((m) => m.t === 'ev' && m.ev.type === type))));
    check('the phone link token is in none of them', !all.includes(PHONE));
    check('nor the Twitch OAuth token', !all.includes(TWITCH));
    check('nor the YouTube key', !all.includes(YOUTUBE));
    check('nor either Spotify token, nor the verifier', !all.includes(SPOTIFY) && !all.includes(SPOTIFY_REFRESH) && !all.includes(VERIFIER));
    check("nor any agent's token or key, its own included", tokens.every((t) => !all.includes(t)) && keys.every((k) => !all.includes(k)) && !all.includes(AGENT_KEY_PREFIX));
    check('so nothing was held back', !host.queue.refusals.some((x) => x.kind === 'outbound'));
    check('and the secrets are really planted', storage.getItem('mixz-remote-token') === PHONE && host._secretsNow().length >= 9);
}

console.log('A message that would carry a secret is held back');
{
    const { host, relays } = await desk({ mixzSet: ['s1', 's2', 's3'].map((id) => ({ id, title: id === 's3' ? `My mix ${TWITCH}` : 'Song ' + id, artist: 'A' })) });
    const [r, r2] = relays;
    const before = r.sent.length;
    r.onMessage({ t: 'tracks' });
    check('a set list with the Twitch token in a title is not sent', r.sent.length === before);
    const line = host.queue.refusals.find((x) => x.kind === 'outbound');
    check('it leaves a refusal saying why', line?.reason === 'held: secret' && line.agent === 'Alpha' && line.count === 1);
    check('which does not hold the token', !JSON.stringify(host.queue.refusals).includes(TWITCH));
    const n2 = r2.sent.length;
    host.sendEvent(envelope('chat.message', { name: 'viewer', text: `here: ${remoteUrl('https://zaomixz.vercel.app', PHONE)}` }, 2));
    check('an event with the phone link goes to no agent', r.sent.length === before && r2.sent.length === n2);
    host.sendEvent(envelope('chat.message', { name: 'viewer', text: `try ${agentKey(host.agents[1].token)}` }, 3));
    check("nor one with another agent's key", r.sent.length === before && r2.sent.length === n2);
    host.sendEvent(envelope('agent.post', { agent: 'Beta', kind: 'comment', text: 'pass is oauth:abcdef', ai: true }, 4));
    check('nor one shaped like an OAuth token', r.sent.length === before && r2.sent.length === n2);
    host.sendEvent(envelope('track.changed', { title: 'T', link: `https://x.example/?key=${YOUTUBE}` }, 5));
    check('nor a link carrying the YouTube key', r.sent.length === before && r2.sent.length === n2);
    host.sendEvent(envelope('track.changed', { title: 'Clean', artist: 'A' }, 6));
    check('a clean event after them still goes out', r.sent.at(-1)?.ev?.data?.title === 'Clean' && r2.sent.at(-1)?.ev?.data?.title === 'Clean');
    const kept = JSON.stringify([host.storage.getItem(REFUSALS_KEY), host.storage.getItem(RECEIPTS_KEY)]);
    check('the saved refusals and receipts hold none of the secrets', ![PHONE, TWITCH, YOUTUBE, ...host.agents.map((a) => a.token)].some((v) => kept.includes(v)));
    check('each held message is counted', host.queue.refusals.filter((x) => x.kind === 'outbound').reduce((t, x) => t + x.count, 0) === 1 + 2 * 4);
}

console.log('When the secrets cannot be read, nothing goes out');
{
    const { host, relays } = await desk({ secrets: () => { throw new Error('desk not ready'); } });
    const n = relays.reduce((t, x) => t + x.sent.length, 0);
    relays[0].onMessage({ t: 'ping', n: 1 });
    host.sendEvent(envelope('track.changed', { title: 'Clean' }, 1));
    check('no message is sent, not even a pong or a welcome', n === 0 && relays.every((x) => x.sent.length === 0));
    check('each is counted as held', host.queue.refusals.some((x) => x.kind === 'outbound' && x.reason === 'held: secrets unreadable'));
}

console.log('A host built without the secrets option sends nothing');
{
    const relays = [];
    class FakeRelay { constructor(o) { Object.assign(this, o); this.sent = []; relays.push(this); } async open() {} send(m) { this.sent.push(m); } close() {} }
    const host = new AgentHost({ RelayClass: FakeRelay, storage: planted(), session: session() });
    host.add('Alpha');
    await host.start();
    relays[0].onMessage({ t: 'hello' });
    relays[0].onMessage({ t: 'ping', n: 1 });
    host.sendEvent(envelope('track.changed', { title: 'Clean' }, 1));
    check('no welcome, pong or event goes out', relays.length === 1 && relays[0].sent.length === 0);
    check('each is counted as held', host.queue.refusals.find((x) => x.kind === 'outbound')?.reason === 'held: secrets unreadable');
}

console.log('In the source');
{
    const src = readFileSync(join(here, 'AgentLink.js'), 'utf8');
    check('AgentLink sends to a relay in one place only, _send', (src.match(/\.relay\.send\(/g) || []).length === 1 && /_send\(id, msg, secrets = this\._secretsNow\(\)\) \{[\s\S]*?l\.relay\.send\(msg\);/.test(src));
    check('and that place checks leak first', /const why = secrets \? leak\(msg, secrets\)/.test(src));
    check('the agent host never holds the Twitch chat object', !/twitchChat/.test(src));
    const sw = readFileSync(join(here, '..', 'sw.js'), 'utf8');
    check('AgentSecrets.js is in the offline shell', sw.includes("'/dj/AgentSecrets.js'"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
