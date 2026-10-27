// /stream: what the display shows, from the desk state.
import { streamCard, isStreamView, chatChannel, chatLines, DEFAULT_CHAT } from './StreamView.js';

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; console.log('  ok  ', name); } else { failed++; console.log('  FAIL', name); } };
console.log('StreamView');

check('/stream is the stream view', isStreamView({ pathname: '/stream', search: '' }) && isStreamView({ pathname: '/stream/', search: '' }));
check('?view=stream is too, the desk is not', isStreamView({ pathname: '/', search: '?view=stream' }) && !isStreamView({ pathname: '/', search: '' }));

const state = { live_deck: 'B', live: true, A: { loaded: true, title: 'Old', artist: 'X', time: 200, dur: 210 }, B: { loaded: true, title: 'Wild Out', artist: 'IMan Afrikah', time: 60, dur: 240 }, mixz: { running: true, next: { title: 'Topier', artist: 'IMan Afrikah' } } };
const c = streamCard(state, 'https://x/art.jpg');
check('it shows the deck on air, not the other one', c.title === 'Wild Out' && c.artist === 'IMan Afrikah' && c.deck === 'B');
check('progress and time', Math.abs(c.progress - 0.25) < 1e-9 && c.time === '1:00 / 4:00');
check('up next from DJ MixZ', c.next === 'Topier · IMan Afrikah');
check('live flag and cover art', c.live === true && c.art === 'https://x/art.jpg');
check('nothing loaded: a holding card, not a blank', streamCard({ live_deck: null, mixz: {} }).title === 'ZAO MixZ');

// Twitch chat on the display
check('chat channel: the link wins, then the saved one, then Zaal\'s', chatChannel({ search: '?chat=ZAOfestivals' }, 'other') === 'zaofestivals' && chatChannel({ search: '' }, '#Saved_One') === 'saved_one' && chatChannel({ search: '' }, '') === DEFAULT_CHAT);
check('?chat= with nothing turns the chat off', chatChannel({ search: '?chat=' }, 'saved') === '');
check('odd characters never reach the IRC join', chatChannel({ search: '?chat=a b<c>' }, '') === 'abc');
let lines = [];
for (let i = 0; i < 12; i++) lines = chatLines(lines, { user: 'u' + i, text: 'hi' }, 1000 + i);
check('only the newest 8 lines stay', lines.length === 8 && lines[0].user === 'u4' && lines[7].user === 'u11');
check('old lines fade out after 90 s', chatLines(lines, null, 1011 + 90000).length === 0 && chatLines(lines, null, 1006 + 90000).length === 5);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
