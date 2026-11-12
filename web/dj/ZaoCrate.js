// ZaoCrate.js — the ZAO crate: music from ZAO artists, pulled from their Audius pages,
// always in the pool the next-track switches pick from, and one click away in the library.
// To add an artist, add their Audius handle to CRATE_HANDLES.

export const CRATE_HANDLES = ['IManAfrikah', 'WaveWarzAfrica'];

// SongChainn artists in the crate. '*' is every artist on SongChainn, so whatever anyone uploads
// there turns up here. To limit it, list names instead: ['IMan Afrikah', 'N3M3SIS'].
export const SONGCHAINN_ARTISTS = '*';

// The WAVEWARZ button plays this Audius playlist instead of the crate (Zaal, 29 Oct 2026).
export const WAVEWARZ_PLAYLIST = 'https://audius.co/CandyToyBoxYT1/playlist/wavewarz-powerhouse';

// The JANGO button plays only Jango's songs, from his Audius page "Jango UU" (Zaal, 5 Nov 2026:
// "i want a jango button", "just go right into it"). Audius tracks play under Audius's terms
// (Licence.js), so these need no signed form. The id saves a lookup; the handle is the fallback.
export const JANGO_AUDIUS = { handle: 'jango.uu', id: 'k2YadvK', name: 'Jango UU' };

// The HOUSE button plays this set, in this order (Zaal, 12 Nov 2026: "add this to zao mixes as a new
// button for auto dj"). Cut from every WaveWarZ battle song on Audius by genre, tempo, wins and
// money behind the song: ZAOresearch 2484, "House mix 01". 112 to 128 BPM, one track per artist.
export const HOUSE_SET = {
    name: 'House mix 01',
    tracks: [
        { id: 'W0V7J0', bpm: 114, title: 'SEVER', artist: 'r3plic4nt' },
        { id: 'AVQjBJq', bpm: 115, title: 'WHO CUT THE LIGHTS', artist: 'BennyJ504' },
        { id: 'Waar7EZ', bpm: 115, title: 'IMAN AFRIKAH - RUDE BOY', artist: 'IMan Afrikah' },
        { id: 'JaloYNZ', bpm: 120, title: 'Is This Real', artist: 'GeEk MyTh' },
        { id: 'Qkw9N9', bpm: 120, title: 'TWICE Demo', artist: 'LUI' },
        { id: '620pWoM', bpm: 120, title: 'So High', artist: 'Stilo World' },
        { id: '5QabGy1', bpm: 120, title: '100z', artist: 'OxQuan' },
        { id: 'r7PmRAG', bpm: 120.5, title: '3.Emotional Waves', artist: 'Kate Murphy' },
        { id: '0MVlwQ9', bpm: 122, title: 'OldWavez *NIGHT* Edition x Hurric4n3Ike', artist: 'Hurric4n3Ike' },
        { id: 'pGm7xKB', bpm: 122, title: 'GodclouD - GOING ROGUE', artist: 'GodclouD' },
        { id: 'KVoP2Mw', bpm: 123, title: 'wondering_demov2', artist: 'XTincT' },
        { id: 'Q4VZBVw', bpm: 125, title: 'WaveWarZ, the electric vibez', artist: 'BetterCallZaal' },
        { id: 'jNMEgWM', bpm: 125, title: 'GODCLOWN', artist: 'KLIPPY' },
        { id: 'p9Xr100', bpm: 126, title: 'Dile Viento (Original Mix)', artist: 'Yoshiro Mare' },
        { id: 'R9AgMXj', bpm: 126, title: 'Delicious Desires', artist: 'Stormbourne' },
        { id: 'o6EJ5Kd', bpm: 127, title: 'Dubbin You Down', artist: 'AporkALYPSE Now' },
    ],
};

// Artists of whom only the songs named here play (Zaal, 29 Oct 2026: no N3M3SIS diss songs, ever;
// IMan: keep her dancehall). Artist and song names squashed, as songKey makes them.
export const ONLY_SONGS = {
    n3m3sis: [],
};
export const notOnlySong = (k) => { const [a, t] = k.split('|'); return a in ONLY_SONGS && !ONLY_SONGS[a].includes(t); };

// How often the crate looks for new uploads while the app is open.
const REFRESH_MS = 5 * 60 * 1000;

// Tempo and key as the artist measured them (IMan Afrikah's song sheet for DJ Zaal, Oct 2026).
// These win over what Audius guesses. Matched on the title with spaces and punctuation removed;
// the longer names come first so "North-East vol 1" is not read as "East vol 1".
export const SHEET = [
    ['northeastvol1', 102, 'F minor'],
    ['northeastvol2', 100, 'F major'],
    ['northeastvol3', 102, 'F minor'],
    ['southeastvol1', 103, 'F major'],
    ['mideastvol1', 99.9, 'D major'],
    ['northvol1', 101.6, 'F major'],
    ['eastvol1', 100, 'F major'],
    ['eastvol2', 101, 'F major'],
    ['eastvol3', 102, 'F minor'],
    ['zaofreestyle', 105.7, 'Eb minor'],
    ['ohnahji', 81, 'C# major'],
    ['cocsong', 160.3, 'A# minor'],
    ['farcastersong', 155, 'A# minor'],
    ['bcz', 155.6, 'C major'],
    ['bettercallzaal', 155.6, 'C major'], // the BCZ song, under its full title on Audius
];

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Kept out of the crate on Zaal's word (15 Oct 2026). NDA put his Vol 1 and 2 out on other
// services too, and a YouTube copyright claim blocked a stream over "Still", so NDA's and
// 7ROO7H's Vol 1 and 2 stay off air, wherever the copy comes from. Keys as songKey makes them:
// artist and song name with spaces and punctuation removed.
export const OFF_AIR = [
    // NDA Vol 1
    ['nda', 'shadowwork'], ['nda', 'ancestralfrequency'], ['nda', 'copperblood'], ['nda', 'serpentfrequency'],
    ['nda', 'theawakening'], ['nda', 'therebirthcode'], ['nda', 'venomvirtue'],
    // NDA Vol 2
    ['nda', 'calm'], ['nda', 'cantmatch'], ['nda', 'comehome'], ['nda', 'fuego'], ['nda', 'money'],
    ['nda', 'preach'], ['nda', 'still'],
    // 7ROO7H Vol 1
    ['7roo7h', 'evesdaughter'], ['7roo7h', 'evesdaughteraltmix'], ['7roo7h', 'ounce'], ['7roo7h', 'me'],
    ['7roo7h', 'alreadylost'], ['7roo7h', '7'], ['7roo7h', 'godssin'],
    // 7ROO7H Vol 2
    ['7roo7h', 'superbased'], ['7roo7h', 'discord'], ['7roo7h', 'drunk'], ['7roo7h', 'itry'],
    ['7roo7h', 'incompatible'], ['7roo7h', 'neveragain'], ['7roo7h', 'onchain'],
].map(([a, t]) => a + '|' + t);

// Whole artists kept out of the crate, squashed. Matched in the artist line and the title, so a
// song posted from another account or a feature stays out too. Geezy2126: IMan's word, 21 Oct 2026.
// Camstar and Krytic: "Flip" (on the WaveWarZ Africa Audius page) is distributed by TuneCore, and
// YouTube claimed it on Zaal's ZAO MixZ stream, 28 Oct 2026.
export const OFF_AIR_ARTISTS = ['geezy2126', 'camstar', 'krytic'];
// Names too short to match inside other words: matched as a whole name only, in the artist line or
// before " - " in the title. NDA: his music goes out through Revelator (Merlin), and YouTube claims
// all of it (B.T.T.B and BOSSED UP, 28 Oct 2026), not only Vol 1 and 2.
export const OFF_AIR_NAMES = ['nda'];
const namesIn = (s) => String(s || '').split(/\s+(?:&|x|ft\.?|feat\.?|and)\s+|,/i).map(squash).filter(Boolean);
const titleArtist = (t) => { const p = String(t.title || '').split(' - '); return p.length > 1 ? p[0] : ''; };
export const artistOffAir = (t) => OFF_AIR_ARTISTS.some((a) => squash(t.artist).includes(a) || squash(t.title).includes(a))
    || [...namesIn(t.artist), ...namesIn(titleArtist(t))].some((n) => OFF_AIR_NAMES.includes(n));

// True when a song must not play anywhere in MixZ: the crate, the WaveWarZ playlist or the mix page.
export const offAirTrack = (t) => { const k = songKey(t); return OFF_AIR.includes(k) || notOnlySong(k) || artistOffAir(t); };

// Jango's songs as Audius lists them, ready to play: streamable, not off air, one copy each.
export function jangoSongs(tracks) {
    const seen = new Set();
    return (tracks || []).filter((t) => {
        if (!t || !t.streamUrl || t.streamable === false || offAirTrack(t)) return false;
        const k = songKey(t);
        if (seen.has('id:' + t.id) || seen.has(k)) return false;
        seen.add('id:' + t.id); seen.add(k);
        return true;
    }).map(applySheet);
}

// The HOUSE set as Audius answered it: the set's own order, streamable, not off air, one copy
// each, and the set's tempo when Audius has none.
export function houseSongs(tracks) {
    const byId = new Map((tracks || []).filter((t) => t && t.id).map((t) => [String(t.id), t]));
    const seen = new Set();
    return HOUSE_SET.tracks.map((s) => {
        const t = byId.get(s.id);
        if (!t || !t.streamUrl || t.streamable === false || offAirTrack(t)) return null;
        const k = songKey(t);
        if (seen.has(k)) return null;
        seen.add(k);
        return applySheet(t.bpm ? t : { ...t, bpm: s.bpm });
    }).filter(Boolean);
}

// Returns the track with the sheet's tempo and key when its title is on the sheet.
export function applySheet(track) {
    const t = squash(track.title);
    const row = SHEET.find(([name]) => t.includes(name));
    if (!row) return track;
    return { ...track, bpm: row[1], key: row[2], fromSheet: true };
}

// One key per song: artist and song name, squashed. An "Artist - Song" title (a song posted from
// another account) counts as that artist's song.
export function songKey(t) {
    const parts = String(t.title || '').split(' - ');
    const artist = parts.length > 1 ? parts[0] : t.artist;
    const title = parts.length > 1 ? parts.slice(1).join(' - ') : t.title;
    return squash(artist) + '|' + squash(title).replace(/tagged$/, '');
}

export class ZaoCrate {
    constructor(dj) {
        this.dj = dj;
        this.tracks = [];
        this._known = null;      // ids seen so far, to spot new uploads
        this._watchCovers();
        if (typeof window !== 'undefined') setInterval(() => this.load(true), REFRESH_MS);
        this._buildTab();
        this.load();
    }

    // Cover art on the deck: the deck's letter badge wears the cover of the track loaded on it,
    // so a song looks in MixZ the way it does on SongChainn or Audius.
    _watchCovers() {
        if (typeof document === 'undefined') return;
        const shown = {};
        setInterval(() => {
            for (const id of ['A', 'B']) {
                const art = this.dj.decks?.[id]?.metadata?.metadata?.artwork || '';
                if (shown[id] === art) continue;
                shown[id] = art;
                const badge = document.querySelector(`#deck-${id.toLowerCase()} .deck-label`);
                if (!badge) continue;
                badge.classList.toggle('has-cover', !!art);
                badge.style.backgroundImage = art ? `url("${String(art).replace(/"/g, '%22')}")` : '';
            }
        }, 700);
    }

    // fresh = true skips the five minute memory and reads SongChainn again.
    async load(fresh = false) {
        if (this._loading) return;
        this._loading = true;
        try { await this._load(fresh); } finally { this._loading = false; }
    }

    async _load(fresh) {
        const audius = this.dj.audius;
        const lib = this.dj.library;
        if (!audius || !audius.getUserTracks || !lib) return;
        const all = [];
        for (const handle of CRATE_HANDLES) {
            try {
                all.push(...(await audius.getUserTracks(handle)));
            } catch (e) {
                console.warn(`[ZaoCrate] could not load ${handle}:`, e.message);
            }
        }
        // SongChainn: the same artists' songs from songchainn.xyz. A song already found on Audius
        // keeps its Audius copy, which comes with a tempo and key.
        try {
            if (this.dj.songchainn) all.push(...(await this.dj.songchainn.byArtists(SONGCHAINN_ARTISTS, fresh)));
        } catch (e) {
            console.warn('[ZaoCrate] could not load SongChainn:', e.message);
        }
        // The same song can be on Audius and on SongChainn, sometimes titled "Artist - Song" and
        // posted from another account. One copy stays: same artist and same song name. A song on
        // OFF_AIR never gets in.
        const offAir = new Set(OFF_AIR);
        const seen = new Set();
        const songs = new Set();
        const next = all.filter((t) => {
            const k = songKey(t);
            if (seen.has(t.id) || songs.has(k) || offAir.has(k) || notOnlySong(k) || artistOffAir(t)) return false;
            seen.add(t.id); songs.add(k);
            return true;
        }).map(applySheet);
        if (!next.length && this.tracks.length) return; // a failed read never empties the crate
        this.tracks = next;
        // New since the last look: say so, and keep the list on screen current
        const ids = new Set(this.tracks.map((t) => t.id));
        const added = this._known ? this.tracks.filter((t) => !this._known.has(t.id)) : [];
        this._known = ids;
        this.newest = added;
        if (added.length && document.getElementById('zao-crate-tab')?.classList.contains('active')) this.show(true);
        lib.zaoTracks = this.tracks; // the switch pad reads this
        this.dj.trackAnalyzer?.refresh?.(); // tempo and key back onto the fresh copies
        const count = document.getElementById('zao-crate-count');
        if (count) count.textContent = this.tracks.length ? ` ${this.tracks.length}` : '';
        // The WaveWarZ playlist, under the same off-air rules.
        try {
            if (audius.getPlaylistTracks) {
                const ww = (await audius.getPlaylistTracks(WAVEWARZ_PLAYLIST)).filter((t) => { const k = songKey(t); return !offAir.has(k) && !notOnlySong(k) && !artistOffAir(t); }).map(applySheet);
                if (ww.length) lib.wavewarzTracks = ww;
            }
        } catch (e) {
            console.warn('[ZaoCrate] could not load the WaveWarZ playlist:', e.message);
        }
        const tab = document.getElementById('zao-crate-tab');
        if (tab) { tab.classList.toggle('has-new', added.length > 0); if (added.length) tab.title = `${added.length} new: ${added.slice(0, 3).map((t) => t.title).join(', ')}`; }
    }

    // Jango UU's songs from Audius into lib.jangoTracks, read once and kept (fresh = true reads
    // again). Returns the list; empty when Audius did not answer. Two calls at once share one read.
    async loadJango(fresh = false) {
        const lib = this.dj.library;
        if (!lib) return [];
        if (!fresh && (lib.jangoTracks || []).length) return lib.jangoTracks;
        if (!this._jango) {
            this._jango = (async () => {
                const audius = this.dj.audius;
                let raw = [];
                try {
                    raw = audius?.getUserIdTracks ? await audius.getUserIdTracks(JANGO_AUDIUS.id) : [];
                } catch (e) {
                    console.warn('[ZaoCrate] could not load Jango UU by id:', e.message);
                }
                try {
                    if (!raw.length && audius?.getUserTracks) raw = await audius.getUserTracks(JANGO_AUDIUS.handle);
                } catch (e) {
                    console.warn('[ZaoCrate] could not load Jango UU from Audius:', e.message);
                }
                const songs = jangoSongs(raw);
                if (songs.length) lib.jangoTracks = songs;
                return lib.jangoTracks || [];
            })().finally(() => { this._jango = null; });
        }
        return this._jango;
    }

    // The HOUSE set from Audius into lib.houseTracks, read once and kept (fresh = true reads again).
    // Returns the list in set order; empty when Audius did not answer. Two calls at once share one read.
    async loadHouse(fresh = false) {
        const lib = this.dj.library;
        if (!lib) return [];
        if (!fresh && (lib.houseTracks || []).length) return lib.houseTracks;
        if (!this._house) {
            this._house = (async () => {
                const audius = this.dj.audius;
                let raw = [];
                try {
                    raw = audius?.getTracksByIds ? await audius.getTracksByIds(HOUSE_SET.tracks.map((t) => t.id)) : [];
                } catch (e) {
                    console.warn('[ZaoCrate] could not load the HOUSE set from Audius:', e.message);
                }
                const songs = houseSongs(raw);
                if (songs.length) lib.houseTracks = songs;
                return lib.houseTracks || [];
            })().finally(() => { this._house = null; });
        }
        return this._house;
    }

    _buildTab() {
        if (typeof document === 'undefined') return;
        const tabs = document.querySelector('.library-tabs');
        if (!tabs || document.getElementById('zao-crate-tab')) return;
        const btn = document.createElement('button');
        btn.id = 'zao-crate-tab';
        btn.className = 'library-tab zao-crate-tab';
        btn.title = 'Music from ZAO artists';
        btn.innerHTML = 'ZAO<span id="zao-crate-count"></span>';
        tabs.appendChild(btn);
        btn.addEventListener('click', () => this.show());
    }

    // Show the crate in the library table. It rides on the Audius view, since that is what the tracks are.
    show(quiet = false) {
        const lib = this.dj.library;
        if (!lib) return;
        if (!quiet) { document.getElementById('zao-crate-tab')?.classList.remove('has-new'); this.load(true); } // opening the tab checks for new uploads
        document.querySelectorAll('.library-tab').forEach((t) => t.classList.remove('active'));
        document.getElementById('zao-crate-tab')?.classList.add('active');
        lib.activeTab = 'audius';
        lib.currentPage = 1;
        lib.viewingPlaylist = null;
        lib.audiusTracks = this.tracks;
        if (!this.tracks.length) { lib._renderError?.('The ZAO crate is empty right now. Check the connection and open it again.'); this.load(); return; }
        lib._renderPaginatedTracks(this.tracks, 'audius');
    }
}
