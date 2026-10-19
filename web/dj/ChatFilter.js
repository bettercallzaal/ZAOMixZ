// ChatFilter.js — what from Twitch and YouTube chat may reach the desk and the stream.
//
// Chat is anyone on the internet. A chat line goes out as a stream event (chat.message) only
// if moderate() passes it, and a "!sr song name" request reaches the request line only if it
// passes and matches one playable track well. A chat request then waits for a person to tap
// PLAY NEXT: it never plays by itself (RequestLine.autoPick). docs/STREAM-EVENTS.md.
//
// Pure: see ChatFilter.test.mjs.

export const CHAT_MAX = 200;           // characters of one chat line kept
export const CHAT_MAX_WAITING = 8;     // chat requests on the board at once, so phones always get a turn
export const QUERY_MIN = 3;            // shorter than this matches too much

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|gg|tv|ly|me|co|app|link|site)\b)/i;
// Control characters and the invisible ones used to dodge filters
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

// { ok, text, reason }. `blocked`: words the DJ never wants on the stream.
export function moderate(raw, { blocked = [] } = {}) {
    const text = String(raw ?? '').replace(HIDDEN, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return { ok: false, text: '', reason: 'empty' };
    if (LINK.test(text)) return { ok: false, text, reason: 'link' };
    const lower = text.toLowerCase();
    const hit = blocked.map((w) => String(w).trim().toLowerCase()).filter(Boolean)
        .find((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(lower));
    if (hit) return { ok: false, text, reason: 'blocked word' };
    return { ok: true, text, reason: '' };
}

const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

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
