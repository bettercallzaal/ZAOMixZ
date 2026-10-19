// AgentSecrets.js - nothing that unlocks anything reaches an agent (agent gateway, gate 7).
//
// docs/STREAM-EVENTS.md, principle 2: no relay token, API key, OAuth token, device id or call
// address goes to an agent. The gates before this one keep them out by building every message
// from named fields. This is the last check, on the way out: AgentHost passes every message for
// an agent through `leak`, and one that holds a secret the desk keeps, or anything shaped like a
// credential, is not sent.
//
// The secrets: the phone link's token, the Spotify tokens and PKCE verifier, every agent's own
// token, and what the desk holds only in memory: the Twitch chat OAuth token and the YouTube
// API key (deskSecrets). The agent host never holds the Twitch chat object itself.
//
// Pure: see AgentSecrets.test.mjs.

export const SECRET_STORE_KEYS = ['mixz-remote-token', 'aurdour_spotify_token', 'aurdour_spotify_refresh'];
export const SECRET_SESSION_KEYS = ['spotify_code_verifier'];
export const MIN_SECRET = 8;   // shorter values are not matched, so a short word never trips it

// Shapes of a credential, whatever its value. The agent key prefix is AgentLink's
// AGENT_KEY_PREFIX (the test checks they match).
export const CREDENTIAL_SHAPES = [
    ['oauth token', /oauth:/i],
    ['agent key', /mza1\./i],
    ['phone link', /remote\.html#/i],
    ['key in a link', /[?&#](?:api_?key|key|access_token|refresh_token|id_token|token|client_secret|client_id|code_verifier)=/i],
    ['bearer token', /\bbearer\s+[\w.~+/-]{20,}/i],
    ['jwt', /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/],
];

const values = (list) => list.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET);

// What the browser keeps: read fresh each time, so a new phone link or Spotify login counts.
export function storedSecrets(storage = globalThis.localStorage, session = globalThis.sessionStorage) {
    const read = (store, keys) => keys.map((k) => { try { return store?.getItem(k); } catch (e) { return null; } });
    return values([...read(storage, SECRET_STORE_KEYS), ...read(session, SECRET_SESSION_KEYS)]);
}

// What the desk holds only in memory. Passed to AgentHost as `secrets: () => deskSecrets(dj)`.
export function deskSecrets(dj) {
    return values([dj?.twitchChat?.oauthToken, dj?.youtubeLive?.apiKey, dj?.spotify?.accessToken, dj?.spotify?.refreshToken]);
}

// Null when `msg` may go to an agent; otherwise why not. Never returns the secret itself.
export function leak(msg, secrets = []) {
    let text;
    try { text = JSON.stringify(msg); } catch (e) { return 'unreadable'; }
    if (typeof text !== 'string') return 'unreadable';
    for (const s of values(secrets)) if (text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1))) return 'secret';
    for (const [why, re] of CREDENTIAL_SHAPES) if (re.test(text)) return why;
    return null;
}
