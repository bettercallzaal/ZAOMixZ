// The DJ switches on the settings panel.   node web/dj/Settings.test.mjs
// Each switch must say the same default its own module uses, flip it through that module,
// and show on the panel with a plain label, a one-line hint and its safe default.

let failed = 0, passed = 0;
const check = (label, cond) => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [], style: {}, dataset: {}, set innerHTML(v) {} });
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: el, body: el(), head: el(), addEventListener() {} };
globalThis.window = { addEventListener() {} };
globalThis.setInterval = () => 0;
globalThis.performance = { now: () => 0 };

const { readFileSync } = await import('node:fs');
const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const { DJ_SETTINGS, djSettingsHtml } = await import('./Settings.js');
const byId = Object.fromEntries(DJ_SETTINGS.map((s) => [s.id, s]));
const empty = () => null;

console.log('Settings: the switches on the panel');
check('the four real switches, auto-play requests first', DJ_SETTINGS.map((s) => s.id).join() === 'auto-requests,dead-air,lights,pro');
for (const s of DJ_SETTINGS) check(`${s.label}: with nothing saved it reads its safe default (${s.safe ? 'on' : 'off'})`, s.read(empty) === s.safe);

console.log('Settings: each default is the one its own module uses');
store.clear();
const { DeadAir } = await import('./DeadAir.js');
check('auto play on silence: DeadAir starts off, as the list says', new DeadAir({ audioRouter: {} }).on === byId['dead-air'].safe);
const { ControllerLights } = await import('./ControllerLights.js');
check('controller lights: ControllerLights starts on, as the list says', new ControllerLights({}).enabled === byId.lights.safe);
const { RemoteHost } = await import('./RemoteLink.js');
check('auto-play requests: the desk starts with it off, as the list says', new RemoteHost({ decks: {}, library: {} }).autoPlay === byId['auto-requests'].safe);
check('PRO view: the page turns PRO on only when "1" is saved, as the list says', src('../index.html').includes("if (savedPro === '1') setProMode(true") && byId.pro.read((k) => (k === 'aurdour-pro-mode' ? '1' : null)) === true);
for (const [id, file] of [['auto-requests', './RemoteLink.js'], ['dead-air', './DeadAir.js'], ['lights', './ControllerLights.js'], ['pro', '../index.html']]) {
    check(`${byId[id].label}: its key "${byId[id].key}" is the one ${file.replace(/^\.+\//, '')} saves`, src(file).includes(byId[id].key));
}
check('(control: a key nobody saves is not found)', !src('./DeadAir.js').includes('mixz-not-a-real-key'));

console.log('Settings: flipping a switch goes through its own module');
const calls = [];
const dj = { remote: { setAutoPlay: (on) => calls.push(`auto:${on}`) }, deadAir: { set: (on) => calls.push(`dead:${on}`) }, lights: { setEnabled: (on) => calls.push(`lights:${on}`) } };
byId['auto-requests'].apply(dj, true); byId['dead-air'].apply(dj, true); byId.lights.apply(dj, false);
check('auto-play requests, auto play on silence and lights each call their module', calls.join() === 'auto:true,dead:true,lights:false');
let clicks = 0;
const doc = (pro) => ({ body: { classList: { contains: () => pro } }, getElementById: () => ({ click: () => clicks++ }) });
byId.pro.apply(dj, true, doc(false)); byId.pro.apply(dj, true, doc(true));
check('PRO view presses the PRO toggle only when it is not already in that state', clicks === 1);

console.log('Settings: what the panel shows');
const html = djSettingsHtml((k) => (k === 'mixz-lights' ? 'off' : k === 'mixz-auto-requests' ? 'on' : null));
check('every switch has its label and its one-line hint', DJ_SETTINGS.every((s) => html.includes(`<b>${s.label}</b>`) && html.includes(s.hint)));
check('and its safe default', (html.match(/Safe default: off/g) || []).length === 3 && (html.match(/Safe default: on/g) || []).length === 1);
check('each box shows the saved value (auto-play on, lights off)', /data-setting="auto-requests" checked/.test(html) && !/data-setting="lights" checked/.test(html));

console.log('Settings: reachable in the simple view');
const page = src('../index.html');
const btn = page.indexOf('id="settings-btn"');
const groupStart = page.lastIndexOf('<div class="toolbar-group', btn);
check('the SETTINGS button is not inside a PRO-only group', btn > 0 && !page.slice(groupStart, btn).includes('pro-only'));
check('the DJ switches come first on the panel; the PRO tools there stay PRO-only', page.indexOf('id="dj-settings"') < page.indexOf('Crossfader Curve') && /settings-group pro-only">\s*<label class="settings-label">Crossfader Curve/.test(page));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
