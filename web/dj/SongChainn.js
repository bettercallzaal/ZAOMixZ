// SongChainn.js — songs from songchainn.xyz, through its public read-only song list.
// The key below is SongChainn's public "anon" key, the same one its own website ships to every
// visitor. It can only read the public song list.
//
// Note: the audio sits on Cloudflare R2. The DJ decks decode audio in the browser, so those
// buckets must allow cross-origin reads (a CORS rule allowing GET), or a track will not load.

export const ENDPOINT = 'https://wsjhbfmzbonxmxaaassu.supabase.co/rest/v1/songchainn_public_songs';
export const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzamhiZm16Ym9ueG14YWFhc3N1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyMTAyNDgsImV4cCI6MjA4Mjc4NjI0OH0.AlniOnpK7BGYaYBIJvuGj4FrDdX-0OZfV8LYUNzq-fs';

export class SongChainn {
    constructor() {
        this._all = null;
        this._at = 0;
    }

    // Every public song, newest first. Kept for five minutes, then read again, so a song an
    // artist has just uploaded shows up without anyone reloading the app. Pass true to read now.
    async all(fresh = false) {
        if (this._all && !fresh && Date.now() - this._at < 5 * 60 * 1000) return this._all;
        const resp = await fetch(`${ENDPOINT}?select=id,title,artist_name,cover_art_url,audio_url,created_at&order=created_at.desc&limit=1000&apikey=${ANON_KEY}`);
        if (!resp.ok) throw new Error(`SongChainn error: ${resp.status}`);
        this._all = (await resp.json()).filter((r) => r.audio_url).map((r) => this._normalizeTrack(r));
        this._at = Date.now();
        await this._useLocalCopies(this._all);
        await this._useAnalysis(this._all);
        return this._all;
    }

    // Tempo and key for the catalog, measured once offline (MixZ-Local/analyze-local.mjs) and
    // shipped as data/analysis.json, so DJ MixZ can keep a party set uptempo and mix in key
    // without downloading a song to measure it. A song a deck has measured itself keeps its own.
    async _useAnalysis(tracks) {
        try {
            if (!this._analysis) {
                const r = await fetch('data/analysis.json', { cache: 'no-store' });
                this._analysis = r.ok ? (await r.json()).songs || {} : {};
            }
            let n = 0;
            for (const t of tracks) {
                const a = this._analysis[t.id.replace(/^songchainn:/, '')];
                if (!a) continue;
                if (a.bpm && !t.bpm) t.bpm = a.bpm;
                if (a.key && !t.key) t.key = a.key;
                if (a.beat != null) t.beat = a.beat; // where the first beat falls, for mashups
                if (a.bad) t.bad = a.bad; // a broken file (too short, will not decode): the auto DJ skips it
                n++;
            }
            if (n) console.log(`[SongChainn] tempo and key on file for ${n} songs`);
        } catch (e) { /* no analysis file: the decks measure as they play */ }
    }

    // On a DJ's own PC, the local server can hold a copy of the catalog on disk (map.json from
    // MixZ-Local/local-songchainn.mjs). Those songs then play from disk, no streaming. The live
    // site has no such map (404), so everyone else keeps streaming as before.
    async _useLocalCopies(tracks) {
        const h = typeof location !== 'undefined' ? location.hostname : '';
        if (h !== '127.0.0.1' && h !== 'localhost') return;
        try {
            if (!this._local) {
                const r = await fetch('/local-songchainn/map.json', { cache: 'no-store' });
                this._local = r.ok ? (await r.json()).map || {} : {};
            }
            let n = 0;
            for (const t of tracks) {
                const rel = this._local[t.id.replace(/^songchainn:/, '')];
                if (rel) { t.streamUrl = `${location.origin}/local-songchainn/${rel}`; t.local = true; n++; }
            }
            if (n) console.log(`[SongChainn] ${n} songs playing from this PC's disk`);
        } catch (e) { /* no local copies: stream */ }
    }

    // Songs by the artists named (matched anywhere in the artist line, so features count).
    // '*' means everyone.
    async byArtists(names, fresh = false) {
        if (names === '*' || names.includes?.('*')) return this.all(fresh);
        const want = names.map((n) => n.toLowerCase());
        return (await this.all(fresh)).filter((t) => want.some((n) => t.artist.toLowerCase().includes(n)));
    }

    _normalizeTrack(raw) {
        return {
            id: `songchainn:${raw.id}`,
            title: raw.title || 'Unknown',
            artist: raw.artist_name || 'Unknown Artist',
            duration: 0,
            bpm: null,
            key: null,
            genre: '',
            artwork: raw.cover_art_url || null,
            source: 'songchainn',
            streamUrl: raw.audio_url,
        };
    }
}
