// StreamView.js — zaomixz.vercel.app/stream: the desk as a pure display for the stream
//
// Zaal, 25 Oct: "one page streaming but a bunch of sub pages for all these other fun things. So
// stream page is just display." The music still plays in this tab (so a tab share to Restream
// carries the sound), but every control is covered by a full-screen show: the song on air, the
// artist, the cover, progress, what is next, and bars that move with the master output.
// Control it from /admin (the phone remote, opened on any screen). Press A here to show the
// admin link and code; press A again to hide it. Nothing on the stream ever asks to be clicked.

import { snapshot } from './RemoteLink.js';
import { liveDeck } from './NowPlaying.js';

export const isStreamView = (loc = typeof location !== 'undefined' ? location : null) =>
    !!loc && (/^\/stream\/?$/.test(loc.pathname) || new URLSearchParams(loc.search).get('view') === 'stream');

const fmt = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;

// What the stream shows, from the desk state: the deck on air, its song, the next one.
export function streamCard(state, art = null) {
    const live = state.live_deck;
    const d = live ? state[live] : null;
    const m = state.mixz || {};
    if (!d?.loaded) return { on: false, title: 'ZAO MixZ', artist: 'Back in a moment', progress: 0, time: '', next: '' };
    const next = m.running && m.next?.title ? `${m.next.title}${m.next.artist ? ' · ' + m.next.artist : ''}` : '';
    return {
        on: true, deck: live, title: d.title || 'Untitled', artist: d.artist || '', art,
        progress: d.dur ? Math.min(1, d.time / d.dur) : 0, time: d.dur ? `${fmt(d.time)} / ${fmt(d.dur)}` : '',
        next, live: !!state.live,
    };
}

// Twitch chat on the display (Zaal, 27 Oct: "upgrade the twitch part ... so we can see the twitch
// chat in the display"). The channel: ?chat=name in the link, else the one last joined on the desk,
// else Zaal's. Read-only and anonymous, so the stream tab never needs a Twitch login.
export const CHAT_KEY = 'mixz-twitch-channel';
export const DEFAULT_CHAT = 'bettercallzaal';
export function chatChannel(loc, saved) {
    const clean = (s) => String(s || '').trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
    const fromLink = loc ? new URLSearchParams(loc.search || '').get('chat') : null;
    if (fromLink !== null) return clean(fromLink);          // ?chat= (empty) turns the chat off
    return clean(saved) || DEFAULT_CHAT;
}

// The chat column keeps the newest lines only; each line leaves after a while so old talk fades out.
export const CHAT_MAX = 8;
export const CHAT_TTL = 90000;
export function chatLines(lines, msg, now = Date.now(), max = CHAT_MAX, ttl = CHAT_TTL) {
    const kept = lines.filter((l) => now - l.at < ttl);
    if (msg) kept.push({ user: msg.user, text: msg.text, color: msg.color || '', at: now });
    return kept.slice(-max);
}

export class StreamView {
    constructor(dj) {
        this.dj = dj;
        if (!isStreamView()) { moreMenu(); return; }
        document.body.classList.add('stream-view');
        document.title = 'ZAO MixZ · Live';
        this._build();
        this._tick = this._tick.bind(this);
        setInterval(() => this._card(), 500);
        requestAnimationFrame(this._tick);
        // /admin talks to this tab through the phone link: keep it on without anyone clicking PHONE
        setTimeout(() => { try { if (!this.dj.remote?.relay) this.dj.remote?.start?.(); } catch (e) { /* admin can still pair by code */ } }, 1500);
        this._startChat();
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'a' && e.key !== 'A') return;
            if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
            const on = document.body.classList.toggle('stream-admin');
            document.getElementById('remote-panel')?.classList.toggle('hidden', !on);
        });
    }

    _build() {
        const el = document.createElement('div');
        el.id = 'stream-view';
        el.innerHTML = `
            <div class="sv-bg" id="sv-bg"></div>
            <div class="sv-top"><span class="sv-logo">ZAO <b>MIXZ</b></span><span class="sv-live" id="sv-live">LIVE</span></div>
            <div class="sv-main">
                <div class="sv-art" id="sv-art"></div>
                <div class="sv-text">
                    <div class="sv-label">NOW PLAYING</div>
                    <div class="sv-title" id="sv-title">ZAO MixZ</div>
                    <div class="sv-artist" id="sv-artist"></div>
                    <div class="sv-bar"><div class="sv-fill" id="sv-fill"></div></div>
                    <div class="sv-time" id="sv-time"></div>
                    <div class="sv-next" id="sv-next"></div>
                </div>
            </div>
            <div class="sv-chat hidden" id="sv-chat">
                <div class="sv-chat-head">CHAT <span id="sv-chat-where"></span></div>
                <div class="sv-chat-list" id="sv-chat-list"></div>
            </div>
            <canvas class="sv-viz" id="sv-viz"></canvas>`;
        document.body.appendChild(el);
        this.canvas = el.querySelector('#sv-viz');
    }

    // Join the Twitch chat read-only once the desk is up, unless someone already joined on the desk.
    _startChat() {
        let saved = '';
        try { saved = localStorage.getItem(CHAT_KEY) || ''; } catch (e) { /* private window: use the default */ }
        this.chatChannel = chatChannel(typeof location !== 'undefined' ? location : null, saved);
        this.chat = [];
        if (!this.chatChannel) return;
        const where = document.getElementById('sv-chat-where');
        if (where) where.textContent = `twitch.tv/${this.chatChannel}`;
        document.getElementById('sv-chat')?.classList.remove('hidden');
        document.getElementById('stream-view')?.classList.add('has-chat');
        setTimeout(() => {
            const tc = this.dj.twitchChat;
            try { if (tc && !tc.isConnected) tc.connectAnonymous(this.chatChannel); } catch (e) { console.warn('stream chat:', e); }
        }, 2000);
        setInterval(() => this._paintChat(), 5000);
    }

    // Called by the desk for each chat line that passed the filter (player._onStreamChatMessage).
    addChat(msg) {
        if (!this.chat) return;
        this.chat = chatLines(this.chat, msg);
        this._paintChat();
    }

    _paintChat() {
        const list = document.getElementById('sv-chat-list');
        if (!list || !this.chat) return;
        this.chat = chatLines(this.chat, null);
        list.replaceChildren(...this.chat.map((l) => {
            const row = document.createElement('div');
            row.className = 'sv-chat-line';
            const who = document.createElement('b');
            who.textContent = l.user;
            if (/^#[0-9a-f]{3,8}$/i.test(l.color)) who.style.color = l.color;
            row.append(who, document.createTextNode(' ' + l.text));
            return row;
        }));
    }

    _card() {
        let state;
        try { state = snapshot(this.dj); } catch (e) { return; }
        state.live_deck = state.live_deck || liveDeck(this.dj.decks || {}, this.dj.audioRouter?._lastCrossfadePosition ?? 0.5);
        const art = state.live_deck ? this.dj.decks?.[state.live_deck]?.metadata?.metadata?.artwork || null : null;
        const c = streamCard(state, art);
        const set = (id, v) => { const e = document.getElementById(id); if (e && e.textContent !== v) e.textContent = v; };
        set('sv-title', c.title); set('sv-artist', c.artist); set('sv-time', c.time);
        set('sv-next', c.next ? `Up next: ${c.next}` : '');
        document.getElementById('sv-fill').style.width = `${(c.progress * 100).toFixed(1)}%`;
        document.getElementById('sv-live').classList.toggle('on', !!c.live);
        document.getElementById('stream-view').classList.toggle('deck-b', c.deck === 'B');
        const artUrl = c.art ? `url("${String(c.art).replace(/"/g, '%22')}")` : '';
        for (const id of ['sv-art', 'sv-bg']) { const e = document.getElementById(id); if (e.dataset.art !== artUrl) { e.dataset.art = artUrl; e.style.backgroundImage = artUrl; } }
    }

    // Bars from the master output, so the stream moves with the music.
    _tick() {
        requestAnimationFrame(this._tick);
        const an = this.dj.audioRouter?.masterAnalyser, cv = this.canvas;
        if (!an || !cv) return;
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== w) cv.width = w;
        if (cv.height !== h) cv.height = h;
        const data = this._data || (this._data = new Uint8Array(an.frequencyBinCount));
        an.getByteFrequencyData(data);
        const g = cv.getContext('2d'), n = 64, bw = w / n;
        g.clearRect(0, 0, w, h);
        const b = document.getElementById('stream-view').classList.contains('deck-b');
        for (let i = 0; i < n; i++) {
            const v = data[Math.floor((i / n) ** 1.6 * data.length * 0.7)] / 255;
            const bh = Math.max(2, v * h);
            g.fillStyle = b ? `rgba(255, ${107 + v * 80}, 53, ${0.35 + v * 0.6})` : `rgba(0, ${180 + v * 60}, 255, ${0.35 + v * 0.6})`;
            g.fillRect(i * bw + 2, h - bh, bw - 4, bh);
        }
    }
}

// Fewer buttons on the desk (Zaal, 25 Oct: "can we make less buttons"): in SIMPLE view, the extras
// (TRAVEL, FEEDBACK, the shortcuts ?) move into one MORE menu at the end of the top bar.
export const MORE_IDS = ['travel-mode-btn', 'feedback-btn', 'shortcuts-btn'];
export function moreMenu(doc = typeof document !== 'undefined' ? document : null) {
    if (!doc || doc.getElementById('more-menu')) return null;
    const settings = doc.getElementById('settings-btn');
    const items = MORE_IDS.map((id) => doc.getElementById(id)).filter(Boolean);
    if (!settings || !items.length) return null;
    const wrap = doc.createElement('div');
    wrap.id = 'more-menu';
    wrap.className = 'toolbar-group more-menu';
    wrap.innerHTML = '<button class="btn-toolbar btn-sm" id="more-btn" aria-haspopup="true" aria-expanded="false" title="Travel mode, feedback, shortcuts">MORE</button><div class="more-panel hidden" id="more-panel" role="menu"></div>';
    settings.insertAdjacentElement('beforebegin', wrap);
    const panel = wrap.querySelector('#more-panel'), btn = wrap.querySelector('#more-btn');
    for (const el of items) { (el.closest('.toolbar-group') && el.closest('.toolbar-group').children.length === 1 ? el.closest('.toolbar-group') : el).classList.add('in-more'); panel.appendChild(el); }
    const open = (on) => { panel.classList.toggle('hidden', !on); btn.setAttribute('aria-expanded', String(on)); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); open(panel.classList.contains('hidden')); });
    doc.addEventListener('click', (e) => { if (!wrap.contains(e.target)) open(false); });
    panel.addEventListener('click', () => setTimeout(() => open(false), 0));
    return wrap;
}
