// Now Playing on the lock screen.   node web/dj/MediaSession.test.mjs
// The OS reads navigator.mediaSession; this checks what we hand it and that nothing
// throws where the API is missing.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

const { nowPlaying, playbackState, mediaActions } = await import('./MediaSession.js');

// 1. No API (old browser, server): every call is a quiet no-op.
delete globalThis.navigator;
check('no navigator: nowPlaying returns false, no throw', nowPlaying({ title: 'x' }) === false);
check('no navigator: playbackState returns false', playbackState('playing') === false);
check('no navigator: mediaActions returns 0', mediaActions({ play: () => {} }) === 0);

// 2. Fake API.
const handlers = {};
const session = { metadata: null, playbackState: 'none', setActionHandler: (a, fn) => { if (a === 'seekto') throw new Error('unsupported'); handlers[a] = fn; } };
globalThis.navigator = { mediaSession: session };
globalThis.MediaMetadata = class { constructor(o) { Object.assign(this, o); } };

check('nowPlaying sets title, artist, album', nowPlaying({ title: 'Lighthouse', artist: 'S.R. Chappell', album: 'The mix' }) === true
    && session.metadata.title === 'Lighthouse' && session.metadata.artist === 'S.R. Chappell' && session.metadata.album === 'The mix');
check('https artwork is passed through', (nowPlaying({ title: 'a', art: 'https://x.test/a.jpg' }), session.metadata.artwork.length === 1 && session.metadata.artwork[0].src === 'https://x.test/a.jpg'));
check('non-https artwork is dropped', (nowPlaying({ title: 'a', art: 'blob:abc' }), session.metadata.artwork.length === 0));
check('empty title falls back to ZAO MixZ', (nowPlaying({}), session.metadata.title === 'ZAO MixZ'));
check('long title is cut to 120', (nowPlaying({ title: 'x'.repeat(300) }), session.metadata.title.length === 120));
check('playbackState is set', playbackState('playing') === true && session.playbackState === 'playing');

let played = 0, nexted = 0;
const n = mediaActions({ play: () => { played++; }, next: () => { nexted++; }, pause: undefined });
check('registers only the handlers given (play, next)', n === 2 && 'play' in handlers && 'nexttrack' in handlers && !('pause' in handlers));
handlers.play(); handlers.nexttrack();
check('lock-screen buttons call through', played === 1 && nexted === 1);

// 3. MediaMetadata missing but mediaSession present: no throw.
delete globalThis.MediaMetadata;
check('no MediaMetadata: nowPlaying returns false', nowPlaying({ title: 'x' }) === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
