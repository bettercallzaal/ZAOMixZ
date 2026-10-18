// Text from outside never becomes markup.   node web/dj/Html.test.mjs
// Every place a track title, artist, key or share-link field goes into innerHTML is driven
// here with a hostile value, on a fake page that records each innerHTML write. Each check
// needs the value to have been written at all (escaped), so a sink that is skipped cannot pass.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

const EVIL = '<img src=x onerror="window.__pwned=1">';
const writes = [];
const el = () => {
    const e = {
        children: [], style: {}, dataset: {}, textContent: '', value: '', id: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, setAttribute() {}, remove() {}, prepend() {}, focus() {},
        appendChild(c) { e.children.push(c); return c; }, insertBefore(c) { return c; },
        querySelector: () => el(), querySelectorAll: () => [],
        get innerHTML() { return e._h || ''; }, set innerHTML(v) { e._h = String(v); writes.push(e._h); },
    };
    return e;
};
const byId = {};
globalThis.document = { getElementById: (id) => (byId[id] ||= el()), createElement: el, body: el(), head: el(), querySelector: () => el(), querySelectorAll: () => [], addEventListener() {} };
globalThis.window = { location: { hash: '' }, addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const run = (label, fn) => {
    writes.length = 0;
    try { fn(); } catch (e) { check(`${label} (threw: ${e.message})`, false); return; }
    const all = writes.join('\n');
    const shown = all.includes('&lt;img');
    const raw = /<img/i.test(all);
    const why = raw ? ' (A LIVE TAG REACHED THE PAGE)' : !shown ? ' (NOT RENDERED, check is vacuous)' : '';
    check(`${label}: shown as text, no live tag${why}`, shown && !raw);
};

const evilTrack = { id: EVIL, title: EVIL, artist: EVIL, key: EVIL, bpm: EVIL, genre: EVIL, source: 'audius', streamUrl: 'x' };

console.log('Flow Mode panel (an Audius title)');
const { FlowMode } = await import('./FlowMode.js');
const flow = new FlowMode({ decks: {}, library: { tracks: [] }, harmonic: null });
flow.currentTrack = { ...evilTrack, genre: EVIL };
flow.queue = [evilTrack, evilTrack];
flow.suggestions = [evilTrack];
run('up next', () => flow._renderUpNext());
run('queue', () => flow._renderQueue());
run('suggestions', () => flow._renderSuggestions());

console.log('Setlist (a share link, and the play history)');
const { Setlist } = await import('./Setlist.js');
const set = Object.create(Setlist.prototype);
run('share view from a #setlist= link', () => set._renderShareView({ d: EVIL, t: [{ n: EVIL, a: EVIL, b: EVIL, k: EVIL, ts: EVIL }], s: { tc: EVIL, br: EVIL, mk: EVIL } }));
set.history = [{ title: EVIL, artist: EVIL, bpm: EVIL, key: EVIL, deck: 'A', timestamp: Date.now() }];
set.sessionStart = Date.now();
run('history', () => set._renderHistory());
set.getSessionStats = () => ({ totalTracks: 1, totalDuration: 60, bpmRange: { min: EVIL, max: EVIL }, mostUsedKey: EVIL, avgTrackLength: 0 });
set._statsInterval = 1;
run('session stats', () => set._renderStats());

console.log('Other track lists');
const { SmartRecommend } = await import('./SmartRecommend.js');
const rec = Object.create(SmartRecommend.prototype);
rec.listEl = el();
rec.getRecommendations = () => [{ track: evilTrack, score: 1, reasons: [EVIL], matchLevel: 'good' }];
run('suggest panel', () => rec.renderSuggestions(evilTrack, [evilTrack], () => {}));
const { TravelMode } = await import('./TravelMode.js');
run('travel offline list', () => Object.create(TravelMode.prototype)._renderOfflineList([{ id: EVIL, title: EVIL, artist: EVIL, size: 1024 }]));
const { Recorder } = await import('./Recorder.js');
const recd = Object.create(Recorder.prototype);
recd.cueSheet = [{ time: 5, deckId: EVIL, trackName: EVIL }];
run('recording cue list', () => recd._updateCueSheetUI());
const { Library } = await import('./Library.js');
const lib = Object.create(Library.prototype);
lib.tableBody = el(); lib._renderPagination = () => {};
run('library loading line', () => lib._renderLoading(EVIL));
lib._getSelectedTracks = () => [evilTrack];
lib.playlists = { getPlaylists: () => [{ id: EVIL, name: EVIL, tracks: [] }] };
run('bulk add-to-playlist dialog (a synced playlist name)', () => lib.bulkAddToPlaylist());

console.log('The escaper');
const { esc } = await import('./Html.js');
check('esc covers & < > " \'', esc(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;' && esc(null) === '' && esc(124) === '124');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
