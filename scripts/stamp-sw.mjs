// Stamps web/sw.js with a hash of everything under web/ at deploy (vercel.json buildCommand).
// The service worker serves the app shell cache first, so a deploy that changes a web file must
// also change CACHE_VERSION or visitors keep the old files. PRs used to bump the number by hand,
// and parallel PRs collided on that line. Now the source says 'dev' and the deploy writes a hash
// that changes only when a web file does: a docs-only deploy keeps the version, so open pages
// are not offered a reload for nothing (index.html shows the reload prompt on SW_UPDATED).
//
// It writes only at deploy (VERCEL is set) or with --write. Run by hand without either, it
// prints the version it would write and leaves sw.js alone, so a stamp never lands in a commit.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = "const CACHE_VERSION = 'dev';";

export function listFiles(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) out.push(p);
        }
    };
    walk(dir);
    return out.sort();
}

// Path and content of every file, sw.js included as committed (still 'dev'), in sorted order.
export function hashTree(dir) {
    const h = createHash('sha256');
    for (const p of listFiles(dir)) {
        h.update(relative(dir, p).split(sep).join('/'));
        h.update('\0');
        h.update(readFileSync(p));
        h.update('\0');
    }
    return h.digest('hex').slice(0, 12);
}

// Throws unless the marker line appears exactly once, so a deploy can never ship 'dev'.
export function stampSource(src, version) {
    if (!/^[0-9a-f]{12}$/.test(version)) throw new Error(`bad version ${version}`);
    const n = src.split(MARKER).length - 1;
    if (n !== 1) throw new Error(`expected the line ${MARKER} once in sw.js, found ${n}`);
    return src.replace(MARKER, `const CACHE_VERSION = '${version}';`);
}

export const USAGE = `node scripts/stamp-sw.mjs [--write]

Prints the CACHE_VERSION a deploy would write into web/sw.js (a hash of web/).
--write, or VERCEL set in the environment (the deploy), writes it into web/sw.js.
Run --write by hand only on a copy you will not commit: the repo keeps 'dev'.`;

// The command line, apart so the tests can run it on a scratch folder.
// Returns the exit code; print() gets every line of output.
export function run(argv, env, web, print = console.log) {
    if (argv.includes('--help') || argv.includes('-h')) { print(USAGE); return 0; }
    const unknown = argv.filter((a) => a !== '--write');
    if (unknown.length) { print(`unknown option ${unknown[0]}\n\n${USAGE}`); return 2; }
    const file = join(web, 'sw.js');
    const version = hashTree(web);
    const out = stampSource(readFileSync(file, 'utf8'), version);
    if (!argv.includes('--write') && !env.VERCEL) {
        print(`sw.js CACHE_VERSION would be ${version}; not written (pass --write, or run at deploy)`);
        return 0;
    }
    writeFileSync(file, out);
    print(`sw.js CACHE_VERSION ${version}`);
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = run(process.argv.slice(2), process.env, join(fileURLToPath(new URL('..', import.meta.url)), 'web'));
}
