// Now Playing on the lock screen and in Control Centre (iPhone, Android, desktop).
// Zaal, 12 Nov 2026: the phone showed "ZAO MixZ" with no song. The Media Session API
// is what the OS reads; without metadata it falls back to the page title.
// Used by mix.html (a shared mix playing from Audius or SongChainn) and listen.html
// (the live stream). Every call is a no-op where the API is missing, so nothing here
// can break playback.

const has = () => typeof globalThis.navigator === 'object' && globalThis.navigator && 'mediaSession' in globalThis.navigator;

// What shows: song, artist, album line, artwork (https only, the OS refuses the rest).
export function nowPlaying({ title, artist, album, art } = {}) {
    if (!has() || typeof globalThis.MediaMetadata !== 'function') return false;
    const artwork = typeof art === 'string' && /^https:\/\//.test(art)
        ? [{ src: art.slice(0, 400), sizes: '512x512', type: 'image/jpeg' }]
        : [];
    try {
        globalThis.navigator.mediaSession.metadata = new globalThis.MediaMetadata({
            title: String(title || 'ZAO MixZ').slice(0, 120),
            artist: String(artist || '').slice(0, 120),
            album: String(album || 'ZAO MixZ').slice(0, 120),
            artwork,
        });
        return true;
    } catch (e) {
        return false;
    }
}

// 'playing' | 'paused' | 'none': keeps the lock-screen button in step with the page.
export function playbackState(state) {
    if (!has()) return false;
    try { globalThis.navigator.mediaSession.playbackState = state; return true; } catch (e) { return false; }
}

// Lock-screen buttons. Pass only what the page can do; the rest stay hidden.
export function mediaActions({ play, pause, next, prev } = {}) {
    if (!has() || typeof globalThis.navigator.mediaSession.setActionHandler !== 'function') return 0;
    const map = { play, pause, nexttrack: next, previoustrack: prev };
    let n = 0;
    for (const [action, fn] of Object.entries(map)) {
        if (typeof fn !== 'function') continue;
        try { globalThis.navigator.mediaSession.setActionHandler(action, () => fn()); n++; } catch (e) { /* unsupported action on this browser */ }
    }
    return n;
}
