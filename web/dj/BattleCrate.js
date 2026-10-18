// BattleCrate.js — the BATTLES tab: every song from a night of WaveWarZ quick battles, playable.
// Zaal, 16 Oct 2026: "I wanna daily do the next days quick battle songs, so I can just have a
// playlist of yesterday's songs". WaveWarZ's public API lists each quick battle with both
// songs' links (all Audius so far); each link resolves to an Audius track the decks can play.
// Quick battles run some nights, not all, so the tab opens on the latest battle night and a
// picker beside it reaches the earlier ones.

import { esc } from './Html.js';
const API = 'https://wavewarz.info/api/public/battles?type=quick&limit=100';
const REFRESH_MS = 30 * 60 * 1000;

// The battle night a battle belongs to, as a US Eastern date (battles run in the ET evening).
// ET is UTC-4 in summer, UTC-5 in winter; a fixed -5 h keeps a late battle on its own night.
export function battleNight(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    return new Date(t - 5 * 3600e3).toISOString().slice(0, 10);
}

// Nights with battles, newest first.
export function nights(battles) {
    return [...new Set((battles || []).map((b) => battleNight(b.createdAt)).filter(Boolean))].sort().reverse();
}

// "srchappell" from https://audius.co/srchappell/algorithm
const handleOf = (link) => { try { return new URL(link).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } };

// The songs of one night, in the order they battled, one entry per song (a song that battled
// twice is listed once, with every result).
export function songsOfNight(battles, night) {
    const out = new Map();
    const ordered = (battles || []).filter((b) => battleNight(b.createdAt) === night)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const b of ordered) {
        for (const side of ['artist1', 'artist2']) {
            const a = b[side];
            if (!a?.musicLink) continue;
            const other = b[side === 'artist1' ? 'artist2' : 'artist1'];
            // Settled on chain first; a battle that ended unsettled falls back to the crowd poll.
            const winner = b.winnerDecided ? b.winnerSide : (!b.live ? b.factors?.pollWinner : null);
            const result = winner ? (winner === side ? 'won' : 'lost') : b.live ? 'live' : 'no result';
            const key = a.musicLink.replace(/[?#].*$/, '').toLowerCase();
            const prev = out.get(key);
            const fight = { result, against: other?.name || '', battleUrl: b.url || '' };
            if (prev) { prev.battles.push(fight); continue; }
            out.set(key, {
                title: a.name || 'Unknown',
                handle: handleOf(a.musicLink),
                musicLink: a.musicLink,
                artwork: a.albumArtUrl || null,
                battles: [fight],
            });
        }
    }
    return [...out.values()];
}

// One line for the library: how the song did that night.
export function resultLine(song) {
    return song.battles.map((f) => `${f.result === 'won' ? 'WON' : f.result} vs ${f.against}`).join(', ');
}

export class BattleCrate {
    constructor(dj) {
        this.dj = dj;
        this.battles = [];
        this.night = '';          // the night on show; '' = latest
        this.tracks = [];
        this._resolved = new Map(); // music link -> Audius track
        this._buildTab();
        if (typeof window !== 'undefined') setInterval(() => this.load(), REFRESH_MS);
        this.load();
    }

    async load() {
        if (this._loading) return;
        this._loading = true;
        try {
            const res = await fetch(API);
            if (!res.ok) throw new Error(`WaveWarZ said ${res.status}`);
            this.battles = (await res.json()).battles || [];
            this._fillNights();
            await this._resolveNight();
        } catch (e) {
            console.warn('[BattleCrate] could not load quick battles:', e.message || e);
        } finally {
            this._loading = false;
        }
    }

    // Each song's Audius link becomes a track the decks can play.
    async _resolveNight() {
        const night = this.night || nights(this.battles)[0] || '';
        const songs = songsOfNight(this.battles, night);
        const audius = this.dj.audius;
        const tracks = [];
        for (const s of songs) {
            let t = this._resolved.get(s.musicLink);
            if (t === undefined && audius?._apiGet) {
                try {
                    const data = await audius._apiGet(`/v1/resolve?url=${encodeURIComponent(s.musicLink)}`);
                    t = data?.data?.id ? audius._normalizeTrack(data.data) : null;
                } catch (e) { t = null; }
                this._resolved.set(s.musicLink, t);
            }
            if (!t) continue; // gone from Audius or not an Audius link
            tracks.push({ ...t, artwork: t.artwork || s.artwork, battleNight: night, battleResult: resultLine(s), genre: resultLine(s) });
        }
        this.shownNight = night;
        this.tracks = tracks;
        if (this.dj.library) this.dj.library.battleTracks = tracks; // DJ MixZ reads this
        const count = document.getElementById('battle-crate-count');
        if (count) count.textContent = tracks.length ? ` ${tracks.length}` : '';
        if (document.getElementById('battle-crate-tab')?.classList.contains('active')) this.show(true);
    }

    _buildTab() {
        if (typeof document === 'undefined') return;
        const tabs = document.querySelector('.library-tabs');
        if (!tabs || document.getElementById('battle-crate-tab')) return;
        const btn = document.createElement('button');
        btn.id = 'battle-crate-tab';
        btn.className = 'library-tab battle-crate-tab';
        btn.title = 'Songs from the latest night of WaveWarZ quick battles (pick earlier nights beside it)';
        btn.innerHTML = 'BATTLES<span id="battle-crate-count"></span>';
        tabs.appendChild(btn);
        btn.addEventListener('click', () => this.show());
        const pick = document.createElement('select');
        pick.id = 'battle-night';
        pick.className = 'battle-night';
        pick.title = 'Which battle night';
        tabs.appendChild(pick);
        pick.addEventListener('change', async () => { this.night = pick.value; await this._resolveNight(); this.show(true); });
    }

    _fillNights() {
        const pick = typeof document !== 'undefined' && document.getElementById('battle-night');
        if (!pick) return;
        const list = nights(this.battles).slice(0, 14);
        const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        pick.innerHTML = list.map((d, i) => `<option value="${i === 0 ? '' : esc(d)}">${i === 0 ? 'Latest: ' : ''}${esc(fmt(d))}</option>`).join('');
        pick.value = this.night;
    }

    show(quiet = false) {
        const lib = this.dj.library;
        if (!lib) return;
        if (!quiet) this.load();
        document.querySelectorAll('.library-tab').forEach((t) => t.classList.remove('active'));
        document.getElementById('battle-crate-tab')?.classList.add('active');
        lib.activeTab = 'audius';
        lib.currentPage = 1;
        lib.viewingPlaylist = null;
        lib.audiusTracks = this.tracks;
        if (!this.tracks.length) { lib._renderError?.('No quick battle songs loaded yet. They come from wavewarz.info; open the tab again in a moment.'); return; }
        lib._renderPaginatedTracks(this.tracks, 'audius');
    }
}
