// The offline cache holds every module the app imports.   node web/dj/ServiceWorker.test.mjs
// sw.js serves the app shell cache first. A module the app imports but the shell list leaves
// out is not cached up front, so the app does not work offline, and a fix that adds a file
// can reach the DJ half-applied. Walks the static imports from every shell module.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(web, 'sw.js'), 'utf8');
const list = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
const shell = new Set(list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);
check('the shell list was read', shell.size > 20 && shell.has('/dj/AutoTransition.js'));

console.log('Every module a shell module imports is in the shell');
const seen = new Set();
const missing = [];
const walk = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    let src;
    try { src = readFileSync(join(web, path), 'utf8'); } catch (e) { return; }
    for (const m of src.matchAll(/^\s*import\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const dep = '/' + normalize(join(dirname(path), m[1])).replace(/^\/+/, '');
        if (!shell.has(dep)) missing.push(`${dep} (imported by ${path})`);
        walk(dep);
    }
};
for (const p of shell) if (p.endsWith('.js')) walk(p);
check(`imports walked: ${seen.size} modules`, seen.size > 20);
for (const m of missing) check(`in APP_SHELL: ${m}`, false);
if (!missing.length) check('no imported module is missing from APP_SHELL', true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
