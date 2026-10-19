// A new version never reloads the desk by itself.   node web/dj/SwUpdate.test.mjs
// sw.js calls skipWaiting, so every deploy that changes a web file takes over open pages and
// sends SW_UPDATED. index.html used to reload on it, mid-set. Now it shows a prompt: an idle
// page reloads on one tap, a playing page warns on the first tap and never reloads unasked.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swUpdatePrompt, BANNER_ID } from './SwUpdate.js';

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

class El {
    constructor(doc, tag) { this.doc = doc; this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.id = ''; this.className = ''; this.parent = null; this.classes = new Set(); }
    get classList() { return { add: (c) => this.classes.add(c) }; }
    set innerHTML(v) { throw new Error('innerHTML used'); }
    append(...els) { for (const e of els) { e.parent = this; this.children.push(e); } }
    appendChild(e) { this.append(e); return e; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    click() { for (const fn of this.listeners.click || []) fn(); }
}
function fakeDoc() {
    const doc = { createElement: (t) => new El(doc, t) };
    doc.body = new El(doc, 'body');
    doc.getElementById = (id) => {
        const walk = (e) => { if (e.id === id) return e; for (const c of e.children) { const f = walk(c); if (f) return f; } return null; };
        return walk(doc.body);
    };
    return doc;
}
const parts = (b) => ({ text: b.children[0], go: b.children[1], later: b.children[2] });

console.log('An idle page');
{
    const doc = fakeDoc();
    let reloads = 0;
    const b = swUpdatePrompt(doc, { playing: () => false, reload: () => reloads++ });
    const { text, go, later } = parts(b);
    check('shows the prompt and does not reload', reloads === 0 && doc.getElementById(BANNER_ID) === b && b.classes.has('show'));
    check('says a new version is ready', text.textContent === 'New version ready');
    check('has RELOAD and LATER', go.textContent === 'RELOAD' && later.textContent === 'LATER');
    go.click();
    check('one tap on RELOAD reloads', reloads === 1);
}

console.log('A playing page');
{
    const doc = fakeDoc();
    let reloads = 0, isPlaying = true;
    const b = swUpdatePrompt(doc, { playing: () => isPlaying, reload: () => reloads++ });
    const { text, go } = parts(b);
    check('does not reload by itself', reloads === 0);
    check('says to reload after the set', text.textContent === 'New version ready - reload after the set');
    go.click();
    check('the first tap only warns', reloads === 0 && go.textContent === 'RELOAD STOPS THE MUSIC - TAP AGAIN');
    go.click();
    check('the second tap reloads', reloads === 1);

    const doc2 = fakeDoc();
    let r2 = 0, p2 = true;
    const b2 = swUpdatePrompt(doc2, { playing: () => p2, reload: () => r2++ });
    p2 = false;
    parts(b2).go.click();
    check('once the decks stop, one tap reloads', r2 === 1);
}

console.log('The prompt itself');
{
    const doc = fakeDoc();
    let reloads = 0;
    const b1 = swUpdatePrompt(doc, { reload: () => reloads++ });
    const b2 = swUpdatePrompt(doc, { reload: () => reloads++ });
    check('a second update shows the same prompt, not two', b1 === b2 && doc.body.children.length === 1);
    parts(b1).later.click();
    check('LATER closes it without a reload', doc.getElementById(BANNER_ID) === null && reloads === 0);
    check('then a later update can show it again', swUpdatePrompt(doc, { reload: () => {} }) !== b1);
}

console.log('The desk page');
{
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
    const sw = readFileSync(join(here, '..', 'sw.js'), 'utf8');
    const i = html.indexOf("type === 'SW_UPDATED'");
    const handler = html.slice(i, html.indexOf('});', html.indexOf('})).catch', i)));
    check('index.html handles SW_UPDATED', i > 0);
    check('with the prompt', handler.includes("import('/dj/SwUpdate.js')") && handler.includes('swUpdatePrompt(document'));
    check('and no reload of its own', !/^\s*window\.location\.reload\(\);/m.test(handler));
    check('it reads both decks for playing', handler.includes('d?.A?.isPlaying || d?.B?.isPlaying'));
    check('SwUpdate.js is in the offline shell', sw.includes("'/dj/SwUpdate.js'"));
    // sw.js skips waiting on install, so the old waiting-worker banner could only show next to
    // this prompt, and its UPDATE asked for a skip that had already happened.
    check('the old waiting-worker banner is gone', !html.includes("'updatefound'") && !html.includes('sw-update-btn'));
    check('so is the SKIP_WAITING message it sent', !html.includes('SKIP_WAITING') && !sw.includes("'SKIP_WAITING'"));
    check('the worker still skips waiting on install', /self\.skipWaiting\(\);/.test(sw));
    check('index.html builds no update banner of its own',(html.match(/sw-update-banner/g) || []).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
