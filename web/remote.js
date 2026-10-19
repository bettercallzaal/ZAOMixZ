// remote.js — the phone side of MixZ Remote
// Opens from the link or QR code shown by PHONE on the desktop. Connects straight to that
// desktop, draws the set five times a second, and sends taps and slides back. The STREAM tab
// runs DJ MixZ on the desk from here, and LISTEN brings the sound to the phone.

import { validToken, Relay, loadPeer, ICE_SERVERS } from './dj/RemoteLink.js';
import { PlayAlong } from './dj/PlayAlong.js';
import { Install } from './dj/Install.js';

const $ = id => document.getElementById(id);
// The link carries the key after the #. An installed app opens without it, so the last good
// one is kept on this phone and used again.
const fromLink = location.hash.slice(1);
if (validToken(fromLink)) localStorage.setItem('mixz-remote-link', fromLink);
const token = validToken(fromLink) ? fromLink : (localStorage.getItem('mixz-remote-link') || '');
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// This phone's own id, so the desk only has to allow it once.
let device = localStorage.getItem('mixz-remote-device');
if (!/^[a-f0-9]{24}$/.test(device || '')) {
    device = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('mixz-remote-device', device);
}
const phoneName = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
// DJ or viewer. A viewer watches the set and can listen; the desk never asks to allow one.
// Chosen once on this phone, switched any time with the button in the header.
let role = localStorage.getItem('mixz-remote-role') || '';
function setRole(r) {
    role = r;
    localStorage.setItem('mixz-remote-role', r);
    document.body.classList.toggle('viewer', r === 'viewer');
    $('role-btn').textContent = r === 'viewer' ? 'VIEWER' : 'DJ';
    $('role-btn').classList.toggle('viewer', r === 'viewer');
    if (r === 'viewer') { showTab('stream'); } else if (ready) { showTab(localStorage.getItem('mixz-remote-tab') || 'mix'); }
}
function askRole() {
    gate('How are you here?', 'The DJ runs the decks from this phone. A viewer watches the set and can listen.');
    const box = document.createElement('div'); box.className = 'roles';
    const dj = document.createElement('button'); dj.className = 'go'; dj.innerHTML = 'I AM THE DJ<small>Decks, pads, tracks and the stream. The desk allows this phone once.</small>';
    const vw = document.createElement('button'); vw.innerHTML = 'JUST WATCHING<small>See what plays and listen in. Nothing to allow.</small>';
    dj.onclick = () => { setRole('dj'); $('gate').innerHTML = ''; status('Connecting'); connect(); };
    vw.onclick = () => { setRole('viewer'); $('gate').innerHTML = ''; status('Connecting'); connect(); };
    box.append(dj, vw); $('gate').appendChild(box);
}

let relay = null, ready = false, state = null, lastState = 0, peer = null, call = null;
let pingN = 0, pingAt = 0, rtt = 0;
const held = {};   // sliders being dragged right now: the desk's value must not fight the thumb
let trackSrc = 'songchainn';

function status(text, live = false) {
    $('status').textContent = text;
    $('dot').classList.toggle('live', live);
}
function gate(title, text) {
    ready = false;
    $('gate').classList.remove('hidden');
    $('gate').innerHTML = '';
    const b = document.createElement('b'); b.textContent = title;
    $('gate').append(b, document.createTextNode(text));
    for (const t of ['mix', 'pads', 'tracks', 'stream']) $(`tab-${t}`).classList.add('hidden');
    $('nav').classList.add('hidden');
    $('listen').classList.add('hidden');
}
// No decks to reach? The phone can still DJ by itself, in the touch layout of the full app.
function offerPhoneMix() {
    if ($('phone-mix')) return;
    const b = document.createElement('button');
    b.id = 'phone-mix'; b.className = 'big go'; b.textContent = 'MIX ON THIS PHONE';
    b.style.marginTop = '14px';
    b.onclick = () => { location.href = '/?mode=travel'; };
    $('gate').appendChild(b);
}

function enter() {
    if (ready) return;
    ready = true;
    $('gate').classList.add('hidden');
    $('nav').classList.remove('hidden');
    $('listen').classList.remove('hidden');
    $('role-btn').classList.remove('hidden');
    showTab(role === 'viewer' ? 'stream' : (localStorage.getItem('mixz-remote-tab') || 'mix'));
    keepAwake();
}
const VIEWER_OK = new Set(['listen', 'share', 'tracks', 'request']);
function send(a, extra = {}) {
    if (role === 'viewer' && !VIEWER_OK.has(a)) return;
    if (ready) relay?.send({ t: 'cmd', device, a, ...extra });
    if (navigator.vibrate) navigator.vibrate(8);
}

async function connect() {
    if (!validToken(token)) { gate('This link is not complete', 'Open PHONE on the computer and scan the code again.'); status('No link'); return; }
    if (!window.isSecureContext || !crypto.subtle) { gate('Open this over https', 'The link is sealed, and the browser only allows that on a secure page.'); status('Not secure'); return; }
    status('Connecting');
    relay = new Relay({ token, role: 'phone', onMessage: onData, onStatus: up => { if (!up) status('No internet'); else if (!ready) status('Looking for the desk'); } });
    try { await relay.open(); } catch (e) { gate('No internet', 'This page keeps trying.'); setTimeout(connect, 4000); return; }
    // Say hello now and every two seconds: that is also how the desk knows this phone is still here.
    const hello = () => relay.send({ t: 'hello', device, name: phoneName, role: role === 'viewer' ? 'viewer' : 'dj' });
    hello();
    setInterval(hello, 2000);
    setInterval(watch, 1000);
    setInterval(() => { if (ready) { pingN++; pingAt = Date.now(); relay.send({ t: 'ping', device, n: pingN }); } }, 3000);
}
// The desk sends the set five times a second. Silence means it is closed or offline.
let askedSince = Date.now();
function watch() {
    if (ready && Date.now() - lastState > 5000) {
        gate('Lost the decks', 'Is ZAO MixZ still open on the computer? This page keeps trying.');
        status('Reconnecting');
        askedSince = Date.now();
    } else if (!ready && relay?.online && $('status').textContent === 'Looking for the desk' && Date.now() - askedSince > 8000) {
        gate('Your decks are not online', 'Open ZAO MixZ on the computer and switch PHONE on. This page keeps trying. Or mix right here on the phone:');
        offerPhoneMix();
    }
}

function onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.to && msg.to !== device) return;
    if (msg.t === 'wait') { if (!ready) { gate('Almost there', 'Tap ALLOW on the computer. You only do this once for this phone.'); status('Waiting for the desk'); } }
    else if (msg.t === 'denied') { gate('The desk said no', 'Ask whoever is at the computer to allow this phone.'); status('Not allowed'); }
    else if (msg.t === 'welcome') { lastState = Date.now(); enter(); status('Live', true); }
    else if (msg.t === 'state') { if (!ready) return; state = msg; lastState = Date.now(); if (!rtt) status('Live', true); draw(); listenTick(); }
    else if (msg.t === 'tracks') { if (tracksFor === 'req') drawReqTracks(msg.list || []); else drawTracks(msg.list || []); }
    else if (msg.t === 'req') drawMine(msg);
    else if (msg.t === 'mix') showMixLink(msg);
    else if (msg.t === 'pong' && msg.n === pingN) { rtt = Date.now() - pingAt; if (ready) status(`Live  ${rtt} ms`, true); }
}

// ── Drawing ──

function buildDeck(el) {
    const d = el.dataset.deck;
    el.innerHTML = `
        <div class="who"><span class="tag">${d}</span><span class="title" data-f="title">No track</span><span class="bpm" data-f="bpm"></span></div>
        <div class="artist" data-f="artist"></div>
        <div class="bar"><i data-f="bar"></i></div>
        <div class="time"><span data-f="time">0:00</span><span data-f="left">-0:00</span></div>
        <div class="row t">
            <button class="b-cue" data-cmd="cue" data-d="${d}">CUE</button>
            <button class="b-play" data-cmd="play" data-d="${d}" data-f="play">PLAY</button>
            <button class="b-sync" data-cmd="sync" data-d="${d}">SYNC</button>
        </div>
        <div class="row x">
            <button data-loop="${d}" data-f="loop">LOOP 4</button>
            <button data-cmd="fxfade" data-d="${d}" data-n="0" data-f="fade">FADE OUT</button>
            <button data-cmd="fxfade" data-d="${d}" data-n="3">SPIN DOWN</button>
        </div>`;
}
const MOOD_NAMES = { warmup: 'WARM UP', peak: 'PEAK TIME', journey: 'JOURNEY', sunset: 'SUNSET', party: 'PARTY' };
function draw() {
    if (!state) return;
    for (const d of ['A', 'B']) {
        const s = state[d], el = document.querySelector(`.deck.${d}`);
        const f = k => el.querySelector(`[data-f="${k}"]`);
        f('title').textContent = s.loaded ? (s.title || 'Untitled') : 'No track';
        f('artist').textContent = s.loaded ? s.artist : '';
        f('bpm').textContent = s.bpm ? `${(s.bpm * (s.rate || 1)).toFixed(1)} BPM` : '';
        f('bar').style.width = s.dur ? `${Math.min(100, s.time / s.dur * 100)}%` : '0';
        f('time').textContent = fmt(s.time);
        f('left').textContent = `-${fmt(Math.max(0, s.dur - s.time))}`;
        f('play').textContent = s.playing ? 'PAUSE' : 'PLAY';
        f('loop').classList.toggle('on', s.loop);
        f('loop').textContent = s.loop ? 'LOOP OFF' : 'LOOP 4';
        f('fade').classList.toggle('on', s.fading);
        el.classList.toggle('live', s.playing);
        document.querySelectorAll(`[data-cues="${d}"] button`).forEach((b, i) => b.classList.toggle('set', !!s.cues?.[i]));
    }
    if (!held.xf) $('xf').value = Math.round(state.xf * 1000);
    if (!held.master) $('master').value = Math.round(state.master * 1000);
    for (const d of ['A', 'B']) if (!held[`vol-${d}`]) $(`vol-${d}`).value = Math.round(state.vol[d] * 1000);

    // STREAM tab: what the room hears, and DJ MixZ
    const m = state.mixz || {};
    const liveDeck = state.live_deck;
    const s = liveDeck ? state[liveDeck] : null;
    if (s?.loaded) { $('np-title').textContent = s.title || 'Untitled'; $('np-artist').textContent = s.artist; }
    else if (m.running && m.now?.title) { $('np-title').textContent = `Loading: ${m.now.title}`; $('np-artist').textContent = m.now.artist || ''; }
    else { $('np-title').textContent = 'Nothing playing'; $('np-artist').textContent = ''; }
    $('np-prog').style.width = s?.dur ? `${Math.min(100, s.time / s.dur * 100)}%` : '0';
    $('np-next').innerHTML = '';
    if (m.running && m.next?.title) { const em = document.createElement('em'); em.textContent = m.next.title + (m.next.artist ? ', ' + m.next.artist : ''); $('np-next').append(`Next: `, em, ` (${m.index + 1} of ${m.total})`); }
    else if (m.running) $('np-next').textContent = `Last track of the set (${m.index + 1} of ${m.total})`;
    $('air-pill').textContent = state.live ? 'ON AIR' : 'OFF AIR';
    $('air-pill').classList.toggle('on', !!state.live);
    $('live-btn').textContent = state.live ? 'END LIVE' : 'GO LIVE';
    // MUTE ALL AGENTS: shown while an agent is connected or the agents are muted
    const ag = state.agents;
    $('agents-btn').style.display = ag && (ag.n || ag.muted) ? '' : 'none';
    $('agents-btn').textContent = ag?.muted ? 'UNMUTE AGENTS' : `MUTE AGENTS (${ag?.n || 0})`;
    $('nav-stream').classList.toggle('air', !!state.live);
    $('mixz-pill').textContent = !m.running ? 'DJ MIXZ OFF' : m.human ? 'YOU HAVE THE DECKS' : `DJ MIXZ ${MOOD_NAMES[m.mood] || ''}${m.endless ? ' · ENDLESS' : ''}`;
    $('st-stop').classList.toggle('hidden', !m.running);
    $('st-skip').classList.toggle('hidden', !m.running);
    $('st-start').textContent = m.running ? 'RESTART WITH THESE SETTINGS' : 'START THE STREAM';
    if (!$('st-endless').dataset.touched) setEndless(!!m.endless, false);
    $('st-deadair').classList.toggle('on', !!state.deadair);
    $('st-deadair').querySelector('b').textContent = state.deadair ? 'ON' : 'OFF';
    $('mixz-say').textContent = !m.running ? 'DJ MixZ is off. Pick the music and a mood, then START: it builds the set and plays it on the desk while you are away.'
        : m.human ? 'You have the decks. DJ MixZ is watching and takes over again on HAND BACK.'
            : `DJ MixZ is mixing ${m.total} tracks${m.minutes ? ` for about ${m.minutes} minutes` : ''}. ${m.endless ? 'When the set ends it builds the next one by itself.' : 'When the set ends it stops.'}`;
    drawBoard(state.req);
}
function drawTracks(list) {
    const box = $('tracks');
    box.textContent = '';
    if (!list.length) { box.textContent = trackSrc === 'songchainn' ? 'SongChainn has not been read on the desk yet. Open the ZAO tab there once, or start DJ MixZ from the STREAM tab.' : 'Nothing here.'; return; }
    for (const t of list) {
        const row = document.createElement('div'); row.className = 'track';
        const info = document.createElement('div');
        const b = document.createElement('b'); b.textContent = t.title || 'Untitled';
        const small = document.createElement('small'); small.textContent = [t.artist, t.bpm ? `${Math.round(t.bpm)} BPM` : '', t.key || ''].filter(Boolean).join('  ·  ');
        info.append(b, small);
        const la = document.createElement('button'); la.className = 'la'; la.textContent = 'A'; la.onclick = () => send('load', { d: 'A', track: t.id });
        const lb = document.createElement('button'); lb.className = 'lb'; lb.textContent = 'B'; lb.onclick = () => send('load', { d: 'B', track: t.id });
        row.append(info, la, lb);
        box.appendChild(row);
    }
}
function showTab(name) {
    if (!['mix', 'pads', 'tracks', 'stream'].includes(name)) name = 'mix';
    for (const t of ['mix', 'pads', 'tracks', 'stream']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    localStorage.setItem('mixz-remote-tab', name);
    if (name === 'tracks') askTracks();
}
$('role-btn').onclick = () => { const next = role === 'viewer' ? 'dj' : 'viewer'; setRole(next); relay?.send({ t: 'hello', device, name: phoneName, role: next }); if (next === 'dj') status('Switching to DJ: the desk may ask to allow this phone'); };
let tracksFor = 'tracks';
function askTracks() { tracksFor = 'tracks'; send('tracks', { q: $('search').value, src: trackSrc }); }
function showMixLink(msg) {
    const box = $('st-sharebox');
    box.classList.remove('hidden');
    box.textContent = '';
    if (!msg.url) { box.textContent = 'Nothing to share yet: no track has played on the desk.'; return; }
    const a = document.createElement('a'); a.href = msg.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `The mix so far: ${msg.n} ${msg.n === 1 ? 'song' : 'songs'}. Open it`;
    box.append(a, document.createTextNode('  '));
    const copy = document.createElement('button'); copy.textContent = 'COPY'; copy.style.cssText = 'min-height:36px;padding:0 12px;font-size:.7rem;margin-left:8px';
    copy.onclick = () => { navigator.clipboard?.writeText(msg.url).then(() => { copy.textContent = 'COPIED'; }).catch(() => {}); };
    box.append(copy);
    if (navigator.share) { const sh = document.createElement('button'); sh.textContent = 'SEND'; sh.style.cssText = 'min-height:36px;padding:0 12px;font-size:.7rem;margin-left:8px'; sh.onclick = () => navigator.share({ title: 'The mix on ZAO MixZ', url: msg.url }).catch(() => {}); box.append(sh); }
}

// ── Wiring ──

document.querySelectorAll('.deck').forEach(buildDeck);
document.querySelectorAll('[data-cues]').forEach(grid => {
    for (let i = 0; i < 8; i++) {
        const b = document.createElement('button');
        b.textContent = i + 1;
        b.onclick = () => send('hotcue', { d: grid.dataset.cues, n: i });
        grid.appendChild(b);
    }
});
document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cmd === 'play' && state?.[b.dataset.d]?.loaded) b.textContent = state[b.dataset.d].playing ? 'PLAY' : 'PAUSE';
    if (b.dataset.cmd) send(b.dataset.cmd, { d: b.dataset.d, ...(b.dataset.n != null ? { n: Number(b.dataset.n) } : {}) });
    else if (b.dataset.loop) send('loop', { d: b.dataset.loop, beats: state?.[b.dataset.loop]?.loop ? 0 : 4 });
    else if (b.dataset.next) send('next', { mode: b.dataset.next });
    else if (b.dataset.tab) showTab(b.dataset.tab);
    else if (b.dataset.src) { trackSrc = b.dataset.src; document.querySelectorAll('#sources button').forEach(x => x.classList.toggle('on', x === b)); askTracks(); }
    else if (b.dataset.mood) { document.querySelectorAll('#st-moods button').forEach(x => x.classList.toggle('on', x === b)); }
});
// Sliders send while they move, at most 25 times a second.
function slider(id, make) {
    const el = $(id);
    let last = 0, pending = null;
    const push = () => { last = Date.now(); pending = null; const c = make(Number(el.value) / 1000); send(c.a, c); };
    el.addEventListener('input', () => {
        held[id] = true;
        if (Date.now() - last > 40) push();
        else if (!pending) pending = setTimeout(push, 40);
    });
    const release = () => setTimeout(() => { held[id] = false; }, 400);
    el.addEventListener('change', release);
    el.addEventListener('touchend', release);
}
slider('xf', v => ({ a: 'crossfader', v }));
slider('master', v => ({ a: 'master', v }));
slider('vol-A', v => ({ a: 'volume', d: 'A', v }));
slider('vol-B', v => ({ a: 'volume', d: 'B', v }));

// STREAM tab
function setEndless(on, touched = true) {
    $('st-endless').classList.toggle('on', on);
    $('st-endless').querySelector('b').textContent = on ? 'ENDLESS ON' : 'ENDLESS OFF';
    $('st-endless').dataset.on = on ? '1' : '';
    if (touched) $('st-endless').dataset.touched = '1';
}
$('st-endless').onclick = () => { const on = !$('st-endless').dataset.on; setEndless(on); if (state?.mixz?.running) send('endless', { on }); };
$('st-start').onclick = () => {
    const mood = document.querySelector('#st-moods button.on')?.dataset.mood || 'journey';
    send('stream', { src: $('st-source').value, mood, minutes: Number($('st-length').value), endless: !!$('st-endless').dataset.on });
    $('mixz-say').textContent = 'Asking the desk to build the set';
};
$('st-deadair').onclick = () => send('deadair', { on: !state?.deadair });
$('st-stop').onclick = () => send('mixz', { on: false });
$('st-skip').onclick = () => send('skip');
$('mixz-take').onclick = () => send('takeover');
$('mixz-back').onclick = () => send('handback');
$('live-btn').onclick = () => send('live', { on: !state?.live });
$('agents-btn').onclick = () => send('agentsmute', { on: !state?.agents?.muted });
$('st-share').onclick = () => { $('st-sharebox').classList.remove('hidden'); $('st-sharebox').textContent = 'Asking the desk'; send('share'); };
let searchTimer = null;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(askTracks, 300); });

// ── REQUEST LINE: call in a song, and tape it when it comes on ──
// Like phoning the radio station and waiting by the cassette recorder. The desk keeps the
// board (RequestLine.js); this phone shows its own requests and records its song off the mix.
const REQ_WORDS = { waiting: 'On the board. The DJ has it.', next: 'Up next. Get your tape ready.', onair: 'Your song is on now.', played: 'Played. Thanks for calling in.', passed: 'Not tonight.' };
$('req-name').value = localStorage.getItem('mixz-req-name') || '';
$('req-name').addEventListener('change', () => localStorage.setItem('mixz-req-name', $('req-name').value.trim()));
let reqSrc = 'zao', reqTimer = null, mine = [];
// The ZAO crate first. If the desk has nothing there yet, this one search uses its library view.
function askReqTracks(src = 'zao') { tracksFor = 'req'; reqSrc = src; send('tracks', { q: $('req-search').value, src }); }
$('req-search').addEventListener('focus', () => { if (!$('req-list').childElementCount) askReqTracks(); });
$('req-search').addEventListener('input', () => { clearTimeout(reqTimer); reqTimer = setTimeout(() => askReqTracks(), 300); });
function drawReqTracks(list) {
    const box = $('req-list');
    box.textContent = '';
    // The desk has not opened the ZAO crate yet: use whatever its library shows.
    if (!list.length && reqSrc === 'zao') { askReqTracks('view'); return; }
    if (!list.length) { box.textContent = $('req-search').value ? 'No song by that name on the desk.' : 'The desk is still loading its music. Try again in a moment.'; return; }
    for (const t of list.slice(0, 12)) {
        const row = document.createElement('div'); row.className = 'track'; row.dataset.id = t.id;
        const info = document.createElement('div');
        const b = document.createElement('b'); b.textContent = t.title || 'Untitled';
        const small = document.createElement('small'); small.textContent = t.artist || '';
        info.append(b, small);
        const go = document.createElement('button'); go.textContent = 'REQUEST';
        go.onclick = () => {
            const name = $('req-name').value.trim();
            localStorage.setItem('mixz-req-name', name);
            send('request', { track: t.id, name, note: $('req-note').value.trim() });
            $('req-say').textContent = 'Calling it in';
            box.textContent = ''; $('req-search').value = '';
        };
        row.append(info, go);
        box.appendChild(row);
    }
}
function drawMine(msg) {
    if (msg.say) $('req-say').textContent = msg.say;
    mine = msg.list || [];
    const box = $('req-mine');
    box.textContent = '';
    for (const r of mine) {
        const el = document.createElement('div'); el.className = `req-mine ${r.status}`;
        const b = document.createElement('b'); b.textContent = `${r.title}${r.artist ? ', ' + r.artist : ''}`;
        const small = document.createElement('small'); small.textContent = REQ_WORDS[r.status] || '';
        el.append(b, small);
        if (r.status === 'onair' || r.status === 'next') {
            const tape = document.createElement('button');
            tape.className = 'tape';
            if (!r.tape) { tape.disabled = true; tape.textContent = 'NO TAPING ON THIS ONE'; }
            else if (taping && taping.rid === r.rid) { tape.classList.add('rec'); tape.textContent = 'STOP TAPE'; tape.onclick = () => stopTape(); }
            else if (r.status === 'onair') { tape.textContent = 'TAPE IT'; tape.onclick = () => startTape(r); }
            else { tape.disabled = true; tape.textContent = 'TAPE READY WHEN IT COMES ON'; }
            el.appendChild(tape);
        }
        box.appendChild(el);
    }
    // The song ended while taping: stop and save, like lifting the finger off REC.
    if (taping && !mine.some((r) => r.rid === taping.rid && r.status === 'onair')) stopTape();
}
function drawBoard(req) {
    const box = $('req-board');
    if (!req || (!req.onair && !req.up?.length)) { box.textContent = ''; return; }
    const line = (lead, r) => {
        const d = document.createElement('div');
        const em = document.createElement('em'); em.textContent = r.title;
        d.append(`${lead} `, em, ` for ${r.name}${r.also ? ` +${r.also}` : ''}${r.note ? `: "${r.note}"` : ''}`);
        return d;
    };
    const sig = JSON.stringify(req);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (req.onair) box.appendChild(line('On air:', req.onair));
    for (const r of req.up || []) box.appendChild(line(r.status === 'next' ? 'Next:' : 'Waiting:', r));
}

// TAPE: record the song off the mix this phone hears. Needs LISTEN on.
let taping = null;
function tapeStream() {
    if (direct && $('monitor').srcObject) return $('monitor').srcObject;
    const deck = state?.live_deck;
    const el = deck && along.on ? $(`pa-${deck}`) : null;
    return el?.captureStream?.() || el?.mozCaptureStream?.() || null;
}
function startTape(r) {
    if (!listening) { $('req-say').textContent = 'Press LISTEN at the top first, then TAPE IT.'; return; }
    const stream = tapeStream();
    if (!stream || !window.MediaRecorder) { $('req-say').textContent = 'This phone cannot tape the mix. Try Chrome on Android, or a computer.'; return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => {
        const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
        if (!blob.size) { $('req-say').textContent = 'The tape came out empty. Is the sound on?'; return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `MixZ tape - ${r.title.replace(/[\\/:*?"<>|]/g, '')}.${(rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm'}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        $('req-say').textContent = 'Taped. It is saved on this phone.';
    };
    rec.start(1000);
    taping = { rid: r.rid, rec };
    $('req-say').textContent = 'Taping. It stops by itself when the song ends.';
    drawMine({ list: mine });
}
function stopTape() {
    const t = taping;
    taping = null;
    if (t?.rec.state === 'recording') t.rec.stop();
    drawMine({ list: mine });
}

// ── LISTEN: the mix on this phone ──
// First a direct call from the desk (the real mix). If no sound arrives in a few seconds,
// the phone plays along: the same songs, at the desk's position, mixed with its faders.
let listening = false, direct = false;
const along = new PlayAlong({ elements: { A: $('pa-A'), B: $('pa-B') }, origin: location.origin });
let fallbackTimer = null;
function listenSay(text, warn = false) { $('listen').textContent = text; $('listen').classList.toggle('warn', warn); }
function startPlayAlong() {
    direct = false;
    try { call?.close(); } catch (e) { /* gone */ }
    $('monitor').srcObject = null;
    send('listen', { on: false });
    along.start();
    listenSay('LISTENING · PLAY ALONG');
}
function listenTick() {
    if (!listening || direct || !along.on) return;
    along.update(state, rtt);
    if (along.say) listenSay(`PLAY ALONG · ${along.say.toUpperCase()}`, true);
    else listenSay('LISTENING · PLAY ALONG');
}
$('listen').onclick = async () => {
    listening = !listening;
    $('listen').classList.toggle('on', listening);
    clearTimeout(fallbackTimer);
    if (!listening) {
        listenSay('LISTEN');
        try { call?.close(); } catch (e) { /* gone */ }
        $('monitor').srcObject = null;
        along.stop();
        direct = false;
        send('listen', { on: false });
        return;
    }
    listenSay('CALLING THE DESK');
    $('monitor').play().catch(() => {});   // this tap is what lets the phone play sound
    along.start(); along.stop();            // same tap unlocks the play-along players
    try {
        await loadPeer();
        if (!peer || peer.destroyed) {
            peer = new window.Peer({ config: { iceServers: ICE_SERVERS } });
            peer.on('call', incoming => {
                call = incoming;
                incoming.answer();
                incoming.on('stream', stream => { if (!listening) return; direct = true; clearTimeout(fallbackTimer); along.stop(); $('monitor').srcObject = stream; $('monitor').play().catch(() => {}); listenSay('LISTENING · LIVE MIX'); });
                incoming.on('close', () => { if (listening && direct) { direct = false; startPlayAlong(); } });
            });
            await new Promise((resolve, reject) => { peer.on('open', resolve); peer.on('error', reject); });
        }
        send('listen', { on: true, peer: peer.id });
        fallbackTimer = setTimeout(() => { if (listening && !direct) startPlayAlong(); }, 9000);
    } catch (e) {
        if (listening) startPlayAlong();
    }
};

// Keep the screen on while the set is in hand, and come back when the phone wakes.
let wake = null;
async function keepAwake() { try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { /* not allowed */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ready) keepAwake(); });

new Install({ button: $('install-btn'), sheet: $('install-sheet'), appName: 'ZAO MixZ Remote' });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (role === 'dj' || role === 'viewer') { setRole(role); connect(); } else if (validToken(token)) askRole(); else connect();
