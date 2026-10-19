// What from stream chat may reach the desk and the stream.   node web/dj/ChatFilter.test.mjs
import { moderate, matchRequest, chatDevice, CHAT_MAX } from './ChatFilter.js';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

console.log('ChatFilter: moderation');
check('a plain line passes, trimmed and tidied', moderate('  great   set!! ').ok && moderate('  great   set!! ').text === 'great set!!');
check('a link never reaches the stream', !moderate('check https://evil.example now').ok && !moderate('go to www.spam.tv').ok && !moderate('cheap stuff at spam.com').ok && moderate('spam.com x').reason === 'link');
check('a blocked word is held, as a whole word only', !moderate('you are a Badword', { blocked: ['badword'] }).ok && moderate('notbadwordy', { blocked: ['badword'] }).ok);
check('hidden characters cannot sneak a link past', !moderate('h​tt​ps://x.com').ok);
check('empty or only hidden characters is dropped', !moderate('   ').ok && !moderate('​​').ok);
check(`a long line is cut to ${CHAT_MAX} characters`, moderate('a'.repeat(500)).text.length === CHAT_MAX);

console.log('ChatFilter: matching a request to one track');
const T = (title, artist) => ({ id: title, title, artist, source: 'audius', streamUrl: 'x' });
const pool = [T('Rude Boy', 'IMan Afrikah'), T('Ego', 'Someone'), T('Lego House', 'Other'), T('Jewellry', 'C3DDC3SSION')];
check('the title finds it', matchRequest('rude boy', pool)?.title === 'Rude Boy');
check('"title - artist" and "artist title" find it', matchRequest('Rude Boy - IMan Afrikah', pool)?.title === 'Rude Boy' && matchRequest('iman afrikah rude boy', pool)?.title === 'Rude Boy');
check('a short title only matches as a whole word ("lego" is not "ego")', matchRequest('lego house please', pool)?.title === 'Lego House' && matchRequest('play ego', pool)?.title === 'Ego');
check('"lego" alone does not find the song "Ego"', matchRequest('lego', pool) === null);
check('nothing close: no track, rather than a wrong one', matchRequest('totally unknown song', pool) === null && matchRequest('ab', pool) === null);
check('one key per chat user, per platform', chatDevice('Twitch', 'Ana') === 'chat:twitch:ana' && chatDevice('youtube', 'Ana') !== chatDevice('twitch', 'Ana'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
