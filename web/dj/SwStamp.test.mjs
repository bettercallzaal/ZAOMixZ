// The deploy stamps sw.js, so no PR bumps CACHE_VERSION.   node web/dj/SwStamp.test.mjs
// scripts/stamp-sw.mjs writes a hash of web/ into sw.js at deploy. The hash must change when
// a web file changes (or visitors keep stale files) and stay put when nothing in web/ did (or
// every open page reloads on SW_UPDATED for nothing), and a deploy must never ship 'dev'.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MARKER, hashTree, stampSource, run, USAGE } from '../../scripts/stamp-sw.mjs';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const sw = readFileSync(join(web, 'sw.js'), 'utf8');
const vercel = JSON.parse(readFileSync(join(web, '..', 'vercel.json'), 'utf8'));

console.log('The repo leaves the version to the deploy');
{
    check("sw.js has the 'dev' line exactly once", sw.split(MARKER).length - 1 === 1);
    check('no hand-set number is left', !/const CACHE_VERSION = \d+/.test(sw));
    check('the deploy runs the stamp, with --write', vercel.buildCommand === 'node scripts/stamp-sw.mjs --write');
    check('and serves web/', vercel.outputDirectory === 'web');
    check('unstamped, the fetch handler steps aside', /if \(CACHE_VERSION === 'dev'\) return;/.test(sw));
}

console.log('Stamping');
{
    const out = stampSource(sw, 'abcdef012345');
    check('the version is written', out.includes("const CACHE_VERSION = 'abcdef012345';"));
    check("and 'dev' is gone", !out.includes(MARKER));
    check('nothing else changes', out.replace("'abcdef012345'", "'dev'") === sw);
    check('a stamped file cannot be stamped again', throws(() => stampSource(out, 'abcdef012345')));
    check('two marker lines are refused', throws(() => stampSource(sw + '\n' + MARKER, 'abcdef012345')));
    check('a version that is not a 12-character hash is refused', throws(() => stampSource(sw, 'dev')));
}

console.log('The hash follows the web files');
{
    const dir = mkdtempSync(join(tmpdir(), 'swstamp-'));
    try {
        mkdirSync(join(dir, 'dj'));
        writeFileSync(join(dir, 'index.html'), '<p>a</p>');
        writeFileSync(join(dir, 'dj', 'A.js'), 'export const a = 1;');
        writeFileSync(join(dir, 'sw.js'), MARKER);
        const h1 = hashTree(dir);
        check('it is 12 hex characters', /^[0-9a-f]{12}$/.test(h1));
        check('same files, same hash', hashTree(dir) === h1);
        writeFileSync(join(dir, 'dj', 'A.js'), 'export const a = 2;');
        const h2 = hashTree(dir);
        check('a changed module changes it', h2 !== h1);
        writeFileSync(join(dir, 'dj', 'B.js'), '');
        const h3 = hashTree(dir);
        check('a new empty file changes it', h3 !== h2);
        rmSync(join(dir, 'dj', 'B.js'));
        writeFileSync(join(dir, 'dj', 'A.js'), 'export const a = 1;');
        check('putting the files back restores it', hashTree(dir) === h1);
        writeFileSync(join(dir, 'sw.js'), MARKER + '\n// a change to the worker itself');
        check('a change to sw.js changes it', hashTree(dir) !== h1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log('Run by hand, it writes nothing');
{
    const dir = mkdtempSync(join(tmpdir(), 'swstamp-run-'));
    try {
        writeFileSync(join(dir, 'index.html'), '<p>a</p>');
        writeFileSync(join(dir, 'sw.js'), MARKER);
        const lines = [];
        const go = (argv, env = {}) => { lines.length = 0; return run(argv, env, dir, (l) => lines.push(l)); };
        const swNow = () => readFileSync(join(dir, 'sw.js'), 'utf8');
        check('no flags: exit 0', go([]) === 0);
        check('and sw.js still says dev', swNow() === MARKER);
        check('it prints the version it would write', /would be [0-9a-f]{12}; not written/.test(lines[0]));
        check('--help prints usage', go(['--help']) === 0 && lines[0] === USAGE && swNow() === MARKER);
        check('-h too', go(['-h']) === 0 && swNow() === MARKER);
        check('an unknown option is refused and writes nothing', go(['--bogus']) === 2 && swNow() === MARKER);
        check('--write with an unknown option writes nothing', go(['--write', '--bogus']) === 2 && swNow() === MARKER);
        const want = hashTree(dir);
        check('--write stamps it', go(['--write']) === 0 && swNow() === `const CACHE_VERSION = '${want}';`);
        writeFileSync(join(dir, 'sw.js'), MARKER);
        check('VERCEL set (the deploy) stamps it too', go([], { VERCEL: '1' }) === 0 && swNow() === `const CACHE_VERSION = '${want}';`);
        check('a second stamp is refused', throws(() => go(['--write'])));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
