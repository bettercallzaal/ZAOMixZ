// MixPage.js — "this was the mix today": one link that holds the whole set
//
// SHARE THE MIX turns the setlist so far into a link to mix.html. The link carries the set
// itself after the #, small: for a SongChainn or Audius song only its id and when it played;
// a local file keeps its title and artist. The page then looks each song up (title, artist,
// cover, stream) from the source, lists them with the times, and plays them again in order.
// No server, nothing to pay for, and the link keeps working as long as the songs exist.
//
// Everything above the page itself is pure and runs under node: see MixPage.test.mjs.

import { cleanTitle, audiusPage } from './NowPlaying.js';
import { ENDPOINT as SONGCHAINN_ENDPOINT, ANON_KEY as SONGCHAINN_KEY } from './SongChainn.js';
import { resolveAudio } from './MusicSource.js';

export const MIX_VERSION = 1;
export const AUDIUS_APP = 'ZAOMixZ';
const AUDIUS_FALLBACK = 'https://discoveryprovider.audius.co';

// What a setlist entry becomes in the link. Tuples, not objects, to keep the link short:
//   ['sc', <uuid without dashes>, startSeconds, playedSeconds]
//   ['au', <audius id>, startSeconds, playedSeconds]
//   ['lo', title, artist, startSeconds, playedSeconds, file]   file: the track's data/*.json on
//   the site when it is one of the files the app ships with (so the page can play it), else ''
const siteFile = (sid) => (/^data\/[\w.-]+\.json$/.test(String(sid || '')) ? String(sid) : '');
export function mixEntry(h, sessionStart) {
    const at = Math.max(0, Math.round(((h.startTime || 0) - (sessionStart || h.startTime || 0)) / 1000));
    const du = h.durationPlayed ? Math.round(h.durationPlayed) : 0;
    const sid = String(h.sid ?? '');
    if (h.src === 'songchainn' && sid) return ['sc', sid.replace(/^songchainn:/, '').replace(/-/g, ''), at, du];
    if (h.src === 'audius' && sid) return ['au', sid, at, du];
    return ['lo', cleanTitle(h.title, h.artist).slice(0, 60), String(h.artist || '').slice(0, 40), at, du, siteFile(sid)];
}

// A song played for under 20 seconds was skipped or only loaded: it is not part of the mix.
// The last one stays, since it may still be playing.
export const SKIPPED_UNDER = 20;
export function buildMix(history, { name = '', dj = '', date = new Date() } = {}) {
    const all = (history || []).filter((h) => h && h.title);
    const list = all.filter((h, i) => i === all.length - 1 || (h.durationPlayed || 0) >= SKIPPED_UNDER);
    const start = list.length ? Math.min(...list.map((h) => h.startTime || Infinity)) : date.getTime();
    return {
        v: MIX_VERSION,
        n: String(name || '').slice(0, 80),
        dj: String(dj || '').slice(0, 40),
        d: new Date(Number.isFinite(start) ? start : date.getTime()).toISOString().slice(0, 16),
        t: list.map((h) => mixEntry(h, start)),
    };
}

// The link text. Not JSON: a 30 song night has to fit in one Telegram message, so it is
//   1;<name>;<dj>;<date>;<entry>;<entry>...
// with an entry  s<id>,<at>,<du>   a<id>,<at>,<du>   l<title>,<artist>,<at>,<du>
// A SongChainn id (32 hex) is packed to 22 characters. Text is percent-encoded, so it can
// never contain the ; and , that hold the link together.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function packHex(hex) {
    if (!/^[a-f0-9]{32}$/i.test(hex)) return 'S' + encodeURIComponent(hex);
    const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
    let out = '';
    for (let i = 0; i < 16; i += 3) {
        const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
        const n = (a << 16) | (b << 8) | c;
        out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < 16 ? B64[(n >> 6) & 63] : '') + (i + 2 < 16 ? B64[n & 63] : '');
    }
    return out;
}
export function unpackHex(s) {
    if (s.startsWith('S')) return decodeURIComponent(s.slice(1));
    if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return s;
    const bytes = [];
    for (let i = 0; i < 22; i += 4) {
        const v = [0, 1, 2, 3].map((k) => (i + k < 22 ? B64.indexOf(s[i + k]) : 0));
        const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
        bytes.push(n >> 16, (n >> 8) & 255, n & 255);
    }
    return bytes.slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const txt = (s) => encodeURIComponent(String(s ?? ''));
const untxt = (s) => { try { return decodeURIComponent(s); } catch (e) { return ''; } };
const int = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) && n >= 0 ? n : 0; };

// Version 2 of the link, the one SHARE THE MIX makes now. Zaal: "clean up the hash".
//   2.<yyMMddHHmm>[.N<name>][.D<dj>].<entry>.<entry>...
// with an entry  s<id>~<played>[~<gap>]   a<id>~<played>[~<gap>]   l<title>~<artist>~<played>[~<gap>[~<file>]]
// Numbers are base 36. When a song started is not written out: it is the end of the one
// before plus <gap> (left out when 0, negative when the two overlapped in a blend).
// No ; , : or % for a date, so the link reads clean and stays short.
const txt2 = (s) => txt(s).replace(/\./g, '%2E').replace(/~/g, '%7E');
const b36 = (n) => (n < 0 ? '-' + (-n).toString(36) : n.toString(36));
const un36 = (s) => { const n = parseInt(s, 36); return Number.isFinite(n) ? n : 0; };
const compactDate = (d) => (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(d || '') ? d.slice(2).replace(/[-T:]/g, '') : '');
const fullDate = (c) => (/^\d{10}$/.test(c) ? `20${c.slice(0, 2)}-${c.slice(2, 4)}-${c.slice(4, 6)}T${c.slice(6, 8)}:${c.slice(8, 10)}` : '');

export function encodeMix(obj) {
    let end = 0;
    const entries = (obj.t || []).map((e) => {
        const lo = e[0] === 'lo';
        const at = int(lo ? e[3] : e[2]), du = int(lo ? e[4] : e[3]);
        const gap = at - end;
        end = at + du;
        const tail = `~${b36(du)}${gap || (lo && e[5]) ? '~' + b36(gap) : ''}`;
        if (e[0] === 'sc') return `s${packHex(String(e[1]))}${tail}`;
        if (e[0] === 'au') return `a${txt2(e[1])}${tail}`;
        return `l${txt2(e[1])}~${txt2(e[2])}${tail}${e[5] ? '~' + txt2(e[5]) : ''}`;
    });
    const head = ['2', compactDate(obj.d)];
    if (obj.n) head.push('N' + txt2(obj.n));
    if (obj.dj) head.push('D' + txt2(obj.dj));
    return [...head, ...entries].join('.');
}

function decodeMix2(str) {
    const parts = str.split('.');
    const out = { v: MIX_VERSION, n: '', dj: '', d: fullDate(parts[1] || ''), t: [] };
    let end = 0;
    for (const raw of parts.slice(2, 202)) {
        const kind = raw[0], f = raw.slice(1).split('~');
        if (kind === 'N') { out.n = untxt(raw.slice(1)); continue; }
        if (kind === 'D') { out.dj = untxt(raw.slice(1)); continue; }
        const timed = (du, gap) => { const at = Math.max(0, end + un36(gap || '0')); const d = Math.max(0, un36(du)); end = at + d; return [at, d]; };
        if ((kind === 's' || kind === 'a') && (f.length === 2 || f.length === 3) && f[0]) {
            const [at, du] = timed(f[1], f[2]);
            out.t.push(kind === 's' ? ['sc', unpackHex(f[0]), at, du] : ['au', untxt(f[0]), at, du]);
        } else if (kind === 'l' && f.length >= 3 && f.length <= 5) {
            const [at, du] = timed(f[2], f[3]);
            out.t.push(['lo', untxt(f[0]), untxt(f[1]), at, du, siteFile(untxt(f[4] || ''))]);
        }
    }
    return out;
}

// Reads both the new links and the version 1 ones already out in chats.
export function decodeMix(str) {
    try {
        if (/^2\.\d{0,10}(\.|$)/.test(String(str || ''))) return decodeMix2(String(str));
        const parts = String(str || '').split(';');
        if (parts.length < 4 || Number(parts[0]) !== MIX_VERSION) return null;
        const t = [];
        for (const raw of parts.slice(4, 204)) {
            const kind = raw[0], f = raw.slice(1).split(',');
            if (kind === 's' && f.length === 3) t.push(['sc', unpackHex(f[0]), int(f[1]), int(f[2])]);
            else if (kind === 'a' && f.length === 3) t.push(['au', untxt(f[0]), int(f[1]), int(f[2])]);
            else if (kind === 'l' && (f.length === 4 || f.length === 5)) t.push(['lo', untxt(f[0]), untxt(f[1]), int(f[2]), int(f[3]), siteFile(untxt(f[4] || ''))]);
        }
        return { v: MIX_VERSION, n: untxt(parts[1]), dj: untxt(parts[2]), d: untxt(parts[3]), t };
    } catch (e) {
        return null;
    }
}
export const mixUrl = (origin, obj) => `${origin.replace(/\/$/, '')}/mix.html#m=${encodeMix(obj)}`;
export const mixFromHash = (hash) => (String(hash || '').startsWith('#m=') ? decodeMix(hash.slice(3)) : null);

// The SongChainn id back in its own form.
export const scId = (compact) => (/^[a-f0-9]{32}$/i.test(compact) ? compact.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : compact);

export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export function mixLength(mix) {
    const t = mix?.t || [];
    if (!t.length) return 0;
    const last = t[t.length - 1];
    const at = last[0] === 'lo' ? last[3] : last[2], du = last[0] === 'lo' ? last[4] : last[3];
    return at + (du || 180);
}

// ───────── Looking the songs up again (browser only) ─────────

export async function resolveTracks(mix, fetchFn = fetch, siteBase = '/') {
    const out = mix.t.map((e, i) => (e[0] === 'lo'
        ? { n: i, src: 'local', title: e[1] || 'Untitled', artist: e[2] || '', at: e[3] || 0, du: e[4] || 0, file: e[5] || '', art: null, stream: null, page: null }
        : { n: i, src: e[0] === 'sc' ? 'songchainn' : 'audius', id: e[1], title: '', artist: '', at: e[2] || 0, du: e[3] || 0, art: null, stream: null, page: null }));
    // Files the app ships with live on the site itself: read the track's json for its mp3.
    await Promise.all(out.filter((t) => t.src === 'local' && t.file).map(async (t) => {
        try {
            const jsonUrl = /^https?:/.test(t.file) ? t.file : `${siteBase}${t.file}`;
            const resp = await fetchFn(jsonUrl);
            const j = resp.ok ? await resp.json() : null;
            const mp3 = resolveAudio(jsonUrl, j?.audio_files?.mp3);
            if (mp3) { t.stream = /^https?:/.test(mp3) ? mp3 : `${siteBase}${mp3.replace(/^\.?\//, '')}`; t.art = j.metadata?.artwork || null; }
        } catch (e) { /* stays unplayable */ }
    }));
    const sc = out.filter((t) => t.src === 'songchainn');
    if (sc.length) {
        try {
            const ids = [...new Set(sc.map((t) => scId(t.id)))];
            const resp = await fetchFn(`${SONGCHAINN_ENDPOINT}?select=id,title,artist_name,cover_art_url,audio_url&id=in.(${ids.join(',')})&apikey=${SONGCHAINN_KEY}`);
            const rows = resp.ok ? await resp.json() : [];
            const byId = new Map(rows.map((r) => [r.id, r]));
            for (const t of sc) {
                const r = byId.get(scId(t.id));
                if (!r) { t.title = 'A SongChainn song that is no longer public'; continue; }
                t.title = cleanTitle(r.title, r.artist_name); t.artist = r.artist_name || ''; t.art = r.cover_art_url || null; t.stream = r.audio_url || null; t.page = 'https://songchainn.xyz';
            }
        } catch (e) { for (const t of sc) t.title = t.title || 'SongChainn song (could not be read right now)'; }
    }
    const au = out.filter((t) => t.src === 'audius');
    if (au.length) {
        let host = AUDIUS_FALLBACK;
        try { const hosts = (await (await fetchFn('https://api.audius.co')).json()).data; if (hosts?.length) host = hosts[0]; } catch (e) { /* fallback host */ }
        await Promise.all(au.map(async (t) => {
            try {
                const d = (await (await fetchFn(`${host}/v1/tracks/${encodeURIComponent(t.id)}?app_name=${AUDIUS_APP}`)).json()).data;
                if (!d) { t.title = 'An Audius track that is no longer there'; return; }
                t.title = cleanTitle(d.title, d.user?.name); t.artist = d.user?.name || ''; t.art = d.artwork?.['150x150'] || null;
                t.stream = `${host}/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=${AUDIUS_APP}`; t.page = audiusPage(d.permalink);
            } catch (e) { t.title = t.title || 'Audius track (could not be read right now)'; }
        }));
    }
    return out;
}
