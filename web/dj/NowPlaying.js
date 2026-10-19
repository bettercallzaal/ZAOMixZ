// NowPlaying.js — the song the room is hearing, front and centre
//
// On a stream the title is what people want to read. So: the title on each deck is written
// without the "Artist - " prefix that SongChainn and Audius uploads carry, it may run to two
// lines instead of being cut to "...", and the deck the crossfader is sending out is marked
// ON AIR. Under the top bar a strip shows that one song big, with a link to it and a button
// that copies a link to the whole mix so far.
//
// cleanTitle, liveDeck and songPage are pure and run under node: see NowPlaying.test.mjs.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "IMan Afrikah - Rude Boy" with artist "IMan Afrikah" becomes "Rude Boy". Also drops a
// file ending and underscores from local files. Never returns an empty string.
export function cleanTitle(title, artist = '') {
    let t = String(title || '').trim();
    const a = String(artist || '').trim();
    if (a) t = t.replace(new RegExp(`^${escapeRe(a)}\\s*[-–—:|]\\s*`, 'i'), '');
    t = t.replace(/\.(mp3|wav|m4a|flac|ogg|aac)$/i, '').replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return t || String(title || '').trim() || 'Untitled';
}

// Which deck the room hears: the playing one, or on the crossfader's side when both play.
// Null when nothing plays. xf is 0 (all A) to 1 (all B).
export function liveDeck(decks, xf = 0.5) {
    const a = !!decks?.A?.isPlaying, b = !!decks?.B?.isPlaying;
    if (a && !b) return 'A';
    if (b && !a) return 'B';
    if (a && b) return xf > 0.5 ? 'B' : 'A';
    return null;
}

// Where a track lives on the web, for a link under the title. Null when there is none
// (a local file, or a source without a page).
// An Audius song page from a permalink. Only a path on audius.co: a permalink that would make
// the link point at another host ("@other.site/...", "\\other") gives no link at all.
export function audiusPage(permalink) {
    if (typeof permalink !== 'string' || !permalink.startsWith('/')) return null;
    const link = `https://audius.co${permalink}`;
    try { return new URL(link).host === 'audius.co' ? link : null; } catch (e) { return null; }
}

export function songPage(meta) {
    if (!meta) return null;
    const id = String(meta.id ?? '');
    const src = meta.source || meta._source || (id.startsWith('songchainn:') ? 'songchainn' : '');
    if (src === 'audius') return audiusPage(meta.permalink);
    if (src === 'songchainn') return 'https://songchainn.xyz';
    return null;
}

export class NowPlaying {
    constructor(dj) {
        this.dj = dj;
        this._last = '';
        this._build();
        setInterval(() => this._tick(), 400);
    }

    _build() {
        const row = document.querySelector('.decks-row');
        if (!row || document.getElementById('now-playing')) return;
        const el = document.createElement('div');
        el.id = 'now-playing';
        el.className = 'now-playing hidden';
        el.innerHTML = `
            <div class="np-art" id="np-art"></div>
            <div class="np-text">
                <div class="np-label">NOW PLAYING</div>
                <div class="np-title" id="np-title"></div>
                <div class="np-artist" id="np-artist"></div>
            </div>
            <div class="np-pills"><span class="np-pill" id="np-bpm"></span><span class="np-pill" id="np-key"></span></div>
            <a class="np-link hidden" id="np-link" target="_blank" rel="noopener">OPEN THE SONG</a>
            <button class="np-share" id="np-share" title="Copy a link to today's mix so far">SHARE THE MIX</button>`;
        row.parentNode.insertBefore(el, row);
        el.querySelector('#np-share').addEventListener('click', () => this.dj.setlist?.shareMix?.());
        this.el = el;
    }

    _tick() {
        if (!this.el) return;
        const decks = this.dj.decks || {};
        const xf = this.dj.audioRouter?._lastCrossfadePosition ?? 0.5;
        const live = liveDeck(decks, xf);
        for (const id of ['A', 'B']) document.getElementById(`deck-${id.toLowerCase()}`)?.classList.toggle('on-air', live === id);
        if (!live) { this.el.classList.add('hidden'); this._last = ''; return; }
        const deck = decks[live];
        const m = deck?.metadata?.metadata || {};
        const title = cleanTitle(m.title, m.artist);
        const bpm = deck?.getBPM?.() || m.bpm;
        const sig = `${live}|${title}|${m.artist}|${bpm ? Math.round(bpm) : ''}|${m.key}|${m.artwork}`;
        this.el.classList.remove('hidden');
        if (sig === this._last) return;
        this._last = sig;
        this.el.classList.toggle('deck-b-live', live === 'B');
        document.getElementById('np-title').textContent = title;
        document.getElementById('np-artist').textContent = m.artist || '';
        document.getElementById('np-bpm').textContent = bpm ? `${Math.round(bpm)} BPM` : '';
        document.getElementById('np-key').textContent = m.key || '';
        document.getElementById('np-art').style.backgroundImage = m.artwork ? `url("${String(m.artwork).replace(/"/g, '%22')}")` : '';
        const page = songPage({ ...m, _source: deck?.metadata?._source });
        const link = document.getElementById('np-link');
        link.classList.toggle('hidden', !page);
        if (page) link.href = page;
    }
}
