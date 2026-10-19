// ChatFilter.js — what from Twitch and YouTube chat may reach the desk and the stream.
//
// Chat is anyone on the internet. A chat line goes out as a stream event (chat.message) only
// if moderate() passes it, and a "!sr song name" request reaches the request line only if it
// passes and matches one playable track well. A chat request then waits for a person to tap
// PLAY NEXT: it never plays by itself (RequestLine.autoPick). docs/STREAM-EVENTS.md.
//
// The text a line keeps is plain text, never markup: whoever shows a chat.message escapes it.
// Blocked words match whole words after the clean-up; lookalike letters and words spelled
// out with spaces can still slip past, so the list is a first line, not the last.
//
// Pure: see ChatFilter.test.mjs.

export const CHAT_MAX = 200;           // characters of one chat line kept
export const CHAT_MAX_WAITING = 8;     // chat requests on the board at once, so phones always get a turn
export const QUERY_MIN = 3;            // shorter than this matches too much

// A link, in any of the ways chat writes one:
//   a scheme ("https://", or a mangled "hxxp://"), "www.", any name.tld written without
//   spaces ("evil.ai", "evil.dev/x"), and a dot spaced or spelled out before a common
//   ending ("example . com", "example[.]com", "example dot com", "example。com").
// Prose keeps a space after a full stop, so "feat. Drake" and "e.g." pass.
const SCHEME = /\b[a-z][a-z0-9+.-]{1,9}:\/\//i;
const BARE = /(^|[^a-z0-9@-])(www\.|[a-z0-9-]{2,}(\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9]))/i;
const ENDINGS = 'com|net|org|io|ai|dev|live|info|xyz|gg|tv|ly|me|co|app|link|site|online|shop|store|club|top|pro|biz|us|uk|ru|cn|de';
const SPACED = new RegExp(`[a-z0-9-]{2,}\\s*(\\.|\\[\\s*\\.\\s*\\]|\\(\\s*\\.\\s*\\)|\\{\\s*\\.\\s*\\}|\\bdot\\b)\\s*(${ENDINGS})(?![a-z0-9])`, 'i');
const DOTS = /[\u3002\uff0e\uff61\u2024\u2027\u00b7\u2219]/g; // other full stops people use for "."
// A one-letter name counts only before a common ending ("t.me/x"), so "e.g." and "U.S." pass
const SHORT = new RegExp(`(^|[^a-z0-9@-])[a-z0-9]\\.(${ENDINGS})(?![a-z0-9])`, 'i');
const isLink = (t) => { const d = t.replace(DOTS, '.'); return SCHEME.test(d) || BARE.test(d) || SPACED.test(d) || SHORT.test(d); };
// Control characters and the invisible ones used to dodge filters, the soft hyphen, the
// combining grapheme joiner and the Mongolian vowel separator included
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

// { ok, text, reason }. `blocked`: words the DJ never wants on the stream.
export function moderate(raw, { blocked = [] } = {}) {
    // NFKC first: fullwidth and other compatibility letters become plain ones
    const text = String(raw ?? '').normalize('NFKC').replace(HIDDEN, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return { ok: false, text: '', reason: 'empty' };
    if (isLink(text)) return { ok: false, text, reason: 'link' };
    const lower = text.toLowerCase();
    const hit = blocked.map((w) => String(w).trim().toLowerCase()).filter(Boolean)
        .find((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(lower));
    if (hit) return { ok: false, text, reason: 'blocked word' };
    return { ok: true, text, reason: '' };
}

const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// The one track a chat request means, or null when nothing matches well enough to be sure.
// "rude boy", "Rude Boy - IMan Afrikah" and "iman afrikah rude boy" all find Rude Boy.
export function matchRequest(query, tracks = []) {
    const q = fold(query);
    if (q.length < QUERY_MIN) return null;
    let best = null, bestScore = 0;
    for (const t of tracks) {
        const title = fold(t?.title), artist = fold(t?.artist);
        if (!title) continue;
        let score = 0;
        if (q === title) score = 100;
        else if (q === `${title} ${artist}` || q === `${artist} ${title}`) score = 95;
        // Whole words only, so "ego" does not match inside "lego"
        else if (title.length >= QUERY_MIN && ` ${q} `.includes(` ${title} `)) score = 60 + Math.min(30, title.length);
        else if (q.length >= 5 && ` ${title} `.includes(` ${q} `)) score = 40 + Math.min(20, q.length);
        if (score > bestScore) { best = t; bestScore = score; }
    }
    return best;
}

// The request line's key for one chat user, so its limits apply per person.
export const chatDevice = (platform, user) => `chat:${String(platform || 'chat').toLowerCase()}:${String(user || '').toLowerCase().slice(0, 40)}`;
