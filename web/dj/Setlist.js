// Setlist.js — Track queue manager, play history, export, share, and session stats
// Supports export to TXT, JSON, M3U, CSV, PNG image, clipboard, and shareable URL

import { buildMix, mixUrl } from './MixPage.js';
import { LiveMixHost } from './LiveMix.js';
import { esc } from './Html.js';

export class Setlist {
    constructor(library, loadTrackCallback) {
        this.queue = []; // { id, title, artist, dataFile }
        this.history = []; // { title, artist, bpm, key, deck, timestamp, startTime, durationPlayed }
        this.loadTrack = loadTrackCallback;
        this.library = library;
        this.dragIndex = null;

        // Session tracking
        this.sessionStart = null;
        this._activeDecks = {}; // deckId -> { title, artist, bpm, key, startTime }

        this._initUI();
        this._checkShareLink();
    }

    _initUI() {
        const exportBtn = document.getElementById('setlist-export');
        const clearBtn = document.getElementById('setlist-clear');
        const copyBtn = document.getElementById('setlist-copy');
        document.getElementById('share-mix-btn')?.addEventListener('click', () => this.shareMix());
        const exportDropdown = document.getElementById('setlist-export-dropdown');

        if (exportBtn) {
            exportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (exportDropdown) {
                    exportDropdown.classList.toggle('hidden');
                }
            });
        }

        // Close dropdown on outside click
        document.addEventListener('click', () => {
            if (exportDropdown) exportDropdown.classList.add('hidden');
        });
        if (exportDropdown) {
            exportDropdown.addEventListener('click', (e) => e.stopPropagation());
        }

        // Export format buttons
        document.getElementById('setlist-export-txt')?.addEventListener('click', () => {
            this._exportTXT();
            exportDropdown?.classList.add('hidden');
        });
        document.getElementById('setlist-export-json')?.addEventListener('click', () => {
            this._exportJSON();
            exportDropdown?.classList.add('hidden');
        });
        document.getElementById('setlist-export-m3u')?.addEventListener('click', () => {
            this._exportM3U();
            exportDropdown?.classList.add('hidden');
        });
        document.getElementById('setlist-export-csv')?.addEventListener('click', () => {
            this._exportCSV();
            exportDropdown?.classList.add('hidden');
        });
        document.getElementById('setlist-export-png')?.addEventListener('click', () => {
            this._exportPNG();
            exportDropdown?.classList.add('hidden');
        });
        document.getElementById('setlist-share')?.addEventListener('click', () => {
            this._generateShareLink();
            exportDropdown?.classList.add('hidden');
        });

        if (copyBtn) {
            copyBtn.addEventListener('click', () => this._copyToClipboard());
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.queue = [];
                this._renderQueue();
            });
        }
    }

    addToQueue(track) {
        this.queue.push({
            id: track.id || Date.now(),
            title: track.title,
            artist: track.artist,
            dataFile: track.dataFile,
        });
        this._renderQueue();
    }

    removeFromQueue(index) {
        this.queue.splice(index, 1);
        this._renderQueue();
    }

    moveInQueue(fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= this.queue.length) return;
        if (toIndex < 0 || toIndex >= this.queue.length) return;
        const [item] = this.queue.splice(fromIndex, 1);
        this.queue.splice(toIndex, 0, item);
        this._renderQueue();
    }

    loadNext(deckId) {
        if (this.queue.length === 0) return;
        const track = this.queue.shift();
        this.loadTrack(deckId, track.dataFile);
        this.logPlay(track.title, track.artist, null, null, deckId);
        this._renderQueue();
    }

    /**
     * Log a track play to session history with full metadata.
     * Called from player.js whenever a track is loaded to a deck.
     */
    logPlay(title, artist, bpm, key, deck, extra = {}) {
        if (!this.sessionStart) {
            this.sessionStart = Date.now();
        }

        const now = Date.now();

        // Finalize duration of previous track on same deck
        if (deck && this._activeDecks[deck]) {
            const prev = this._activeDecks[deck];
            const entry = this.history.find(
                h => h.title === prev.title && h.deck === deck && !h.durationPlayed
            );
            if (entry) {
                entry.durationPlayed = (now - prev.startTime) / 1000;
            }
        }

        const entry = {
            title: title || 'Unknown',
            artist: artist || '',
            bpm: bpm || null,
            key: key || null,
            deck: deck || null,
            timestamp: new Date(now).toISOString(),
            startTime: now,
            durationPlayed: null, // filled when next track loads on same deck
            src: extra.source || 'local',   // where it came from, so the mix page can find it again
            sid: extra.id ?? null,
            art: extra.artwork || null,
            url: extra.streamUrl || null,
        };

        this.history.push(entry);

        // Track active deck state
        if (deck) {
            this._activeDecks[deck] = {
                title: entry.title,
                artist: entry.artist,
                bpm: entry.bpm,
                key: entry.key,
                startTime: now,
            };
        }

        this._renderHistory();
        this._renderStats();
        this.live?.update();   // the live mix link shows the new song
    }

    /**
     * Update metadata for the most recent history entry on a given deck.
     * Called after BPM/key detection completes.
     */
    updateLastEntryMeta(deck, bpm, key) {
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].deck === deck) {
                if (bpm && !this.history[i].bpm) this.history[i].bpm = bpm;
                if (key && !this.history[i].key) this.history[i].key = key;
                break;
            }
        }
        this._renderHistory();
        this._renderStats();
    }

    // ====== SESSION STATS ======

    getSessionStats() {
        const tracks = this.history;
        if (tracks.length === 0) {
            return { totalTracks: 0, totalDuration: 0, bpmRange: null, mostUsedKey: null, avgTrackLength: 0 };
        }

        // Total duration: from session start to now
        const totalDuration = this.sessionStart ? (Date.now() - this.sessionStart) / 1000 : 0;

        // BPM range
        const bpms = tracks.map(t => t.bpm).filter(b => b && b > 0);
        const bpmRange = bpms.length > 0
            ? { min: Math.min(...bpms), max: Math.max(...bpms) }
            : null;

        // Most used key
        const keyCounts = {};
        tracks.forEach(t => {
            if (t.key) {
                keyCounts[t.key] = (keyCounts[t.key] || 0) + 1;
            }
        });
        let mostUsedKey = null;
        let maxKeyCount = 0;
        for (const [k, count] of Object.entries(keyCounts)) {
            if (count > maxKeyCount) {
                mostUsedKey = k;
                maxKeyCount = count;
            }
        }

        // Average track length
        const durations = tracks.map(t => t.durationPlayed).filter(d => d && d > 0);
        const avgTrackLength = durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : 0;

        return {
            totalTracks: tracks.length,
            totalDuration,
            bpmRange,
            mostUsedKey,
            avgTrackLength,
        };
    }

    // ====== EXPORT: TEXT (.txt) ======

    _getFormattedDate() {
        return new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    }

    _getElapsedString(timestamp) {
        if (!this.sessionStart) return '00:00';
        const elapsed = (new Date(timestamp).getTime() - this.sessionStart) / 1000;
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = Math.floor(elapsed % 60);
        if (h > 0) {
            return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    _buildTextSetlist() {
        const date = this._getFormattedDate();
        const lines = [
            `AURDOUR DJ Set — ${date}`,
            '================================',
        ];

        this.history.forEach((entry) => {
            const time = this._getElapsedString(entry.timestamp);
            let meta = '';
            const parts = [];
            if (entry.bpm) parts.push(`${entry.bpm} BPM`);
            if (entry.key) parts.push(entry.key);
            if (parts.length > 0) meta = ` (${parts.join(', ')})`;
            const artist = entry.artist ? ` - ${entry.artist}` : '';
            lines.push(`${time}  ${entry.title}${artist}${meta}`);
        });

        const stats = this.getSessionStats();
        lines.push('');
        lines.push('--------------------------------');
        lines.push(`Total tracks: ${stats.totalTracks}`);
        lines.push(`Session duration: ${this._formatDuration(stats.totalDuration)}`);
        if (stats.bpmRange) {
            lines.push(`BPM range: ${stats.bpmRange.min} - ${stats.bpmRange.max}`);
        }
        if (stats.mostUsedKey) {
            lines.push(`Most used key: ${stats.mostUsedKey}`);
        }
        if (stats.avgTrackLength > 0) {
            lines.push(`Avg track length: ${this._formatDuration(stats.avgTrackLength)}`);
        }

        return lines.join('\n');
    }

    _exportTXT() {
        const text = this._buildTextSetlist();
        this._downloadFile(text, 'text/plain', `aurdour-setlist-${this._fileTimestamp()}.txt`);
    }

    // ====== EXPORT: JSON ======

    _exportJSON() {
        const data = {
            app: 'AURDOUR DJ',
            date: new Date().toISOString(),
            sessionStart: this.sessionStart ? new Date(this.sessionStart).toISOString() : null,
            tracks: this.history.map(entry => ({
                title: entry.title,
                artist: entry.artist,
                bpm: entry.bpm,
                key: entry.key,
                deck: entry.deck,
                timestamp: entry.timestamp,
                durationPlayed: entry.durationPlayed ? Math.round(entry.durationPlayed) : null,
            })),
            stats: this.getSessionStats(),
        };
        const json = JSON.stringify(data, null, 2);
        this._downloadFile(json, 'application/json', `aurdour-setlist-${this._fileTimestamp()}.json`);
    }

    // ====== EXPORT: M3U ======

    _exportM3U() {
        const lines = ['#EXTM3U', `#PLAYLIST:AURDOUR DJ Set — ${this._getFormattedDate()}`];

        this.history.forEach(entry => {
            const duration = entry.durationPlayed ? Math.round(entry.durationPlayed) : -1;
            const artist = entry.artist || 'Unknown Artist';
            lines.push(`#EXTINF:${duration},${artist} - ${entry.title}`);
            // M3U needs a file path; use title as placeholder since these are streaming/local
            lines.push(`${entry.title}.mp3`);
        });

        const text = lines.join('\n');
        this._downloadFile(text, 'audio/x-mpegurl', `aurdour-setlist-${this._fileTimestamp()}.m3u`);
    }

    // ====== EXPORT: CSV ======

    _exportCSV() {
        const headers = ['#', 'Time', 'Title', 'Artist', 'BPM', 'Key', 'Deck', 'Duration (s)'];
        const rows = [headers.join(',')];

        this.history.forEach((entry, i) => {
            const time = this._getElapsedString(entry.timestamp);
            const duration = entry.durationPlayed ? Math.round(entry.durationPlayed) : '';
            const row = [
                i + 1,
                time,
                `"${(entry.title || '').replace(/"/g, '""')}"`,
                `"${(entry.artist || '').replace(/"/g, '""')}"`,
                entry.bpm || '',
                entry.key || '',
                entry.deck || '',
                duration,
            ];
            rows.push(row.join(','));
        });

        const text = rows.join('\n');
        this._downloadFile(text, 'text/csv', `aurdour-setlist-${this._fileTimestamp()}.csv`);
    }

    // ====== EXPORT: PNG (Visual Setlist Card) ======

    _exportPNG() {
        const stats = this.getSessionStats();
        const tracks = this.history;
        const padding = 40;
        const trackLineHeight = 32;
        const headerHeight = 140;
        const statsHeight = 100;
        const canvasWidth = 800;
        const canvasHeight = headerHeight + (tracks.length * trackLineHeight) + statsHeight + padding * 2;

        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');

        // Background gradient
        const bgGrad = ctx.createLinearGradient(0, 0, 0, canvasHeight);
        bgGrad.addColorStop(0, '#08081a');
        bgGrad.addColorStop(1, '#0c0c24');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Accent line at top
        const accentGrad = ctx.createLinearGradient(0, 0, canvasWidth, 0);
        accentGrad.addColorStop(0, '#00d4ff');
        accentGrad.addColorStop(1, '#ff6b35');
        ctx.fillStyle = accentGrad;
        ctx.fillRect(0, 0, canvasWidth, 3);

        // Header
        ctx.fillStyle = '#00d4ff';
        ctx.font = 'bold 14px "JetBrains Mono", monospace';
        ctx.fillText('AURDOUR DJ', padding, padding + 10);

        ctx.fillStyle = '#eaeaf2';
        ctx.font = 'bold 28px "Bricolage Grotesque", "DM Sans", sans-serif';
        ctx.fillText('DJ SET', padding, padding + 48);

        ctx.fillStyle = '#9494b8';
        ctx.font = '14px "DM Sans", sans-serif';
        ctx.fillText(this._getFormattedDate(), padding, padding + 72);

        // Stats chips in header
        const chipY = padding + 95;
        let chipX = padding;
        const chips = [];
        chips.push(`${stats.totalTracks} tracks`);
        chips.push(this._formatDuration(stats.totalDuration));
        if (stats.bpmRange) chips.push(`${stats.bpmRange.min}-${stats.bpmRange.max} BPM`);
        if (stats.mostUsedKey) chips.push(`Key: ${stats.mostUsedKey}`);

        ctx.font = '11px "JetBrains Mono", monospace';
        chips.forEach(chip => {
            const w = ctx.measureText(chip).width + 16;
            // Chip background
            ctx.fillStyle = 'rgba(0, 212, 255, 0.1)';
            ctx.beginPath();
            ctx.roundRect(chipX, chipY - 14, w, 22, 4);
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(chipX, chipY - 14, w, 22, 4);
            ctx.stroke();
            // Chip text
            ctx.fillStyle = '#00d4ff';
            ctx.fillText(chip, chipX + 8, chipY + 1);
            chipX += w + 8;
        });

        // Separator
        const sepY = headerHeight + padding - 10;
        ctx.strokeStyle = 'rgba(60, 60, 120, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padding, sepY);
        ctx.lineTo(canvasWidth - padding, sepY);
        ctx.stroke();

        // Track list
        const listStartY = headerHeight + padding + 10;
        tracks.forEach((entry, i) => {
            const y = listStartY + (i * trackLineHeight);
            const isEven = i % 2 === 0;

            // Alternating row bg
            if (isEven) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
                ctx.fillRect(padding - 8, y - 6, canvasWidth - padding * 2 + 16, trackLineHeight);
            }

            // Track number
            ctx.fillStyle = '#525278';
            ctx.font = '11px "JetBrains Mono", monospace';
            const num = String(i + 1).padStart(2, '0');
            ctx.fillText(num, padding, y + 14);

            // Timestamp
            const time = this._getElapsedString(entry.timestamp);
            ctx.fillStyle = '#00d4ff';
            ctx.font = '11px "JetBrains Mono", monospace';
            ctx.fillText(time, padding + 32, y + 14);

            // Track name
            ctx.fillStyle = '#eaeaf2';
            ctx.font = '14px "DM Sans", sans-serif';
            const trackText = entry.artist
                ? `${entry.title} - ${entry.artist}`
                : entry.title;
            ctx.fillText(trackText, padding + 100, y + 14);

            // BPM & Key on right
            const metaParts = [];
            if (entry.bpm) metaParts.push(`${entry.bpm}`);
            if (entry.key) metaParts.push(entry.key);
            if (metaParts.length > 0) {
                ctx.fillStyle = '#9494b8';
                ctx.font = '11px "JetBrains Mono", monospace';
                const metaText = metaParts.join(' / ');
                const metaWidth = ctx.measureText(metaText).width;
                ctx.fillText(metaText, canvasWidth - padding - metaWidth, y + 14);
            }
        });

        // Footer watermark
        const footerY = canvasHeight - 20;
        ctx.fillStyle = '#525278';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText('Powered by AURDOUR DJ', padding, footerY);

        // Download
        canvas.toBlob(blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aurdour-setlist-${this._fileTimestamp()}.png`;
            a.click();
            URL.revokeObjectURL(url);
        }, 'image/png');
    }

    // ====== COPY TO CLIPBOARD ======

    _copyToClipboard() {
        const text = this._buildTextSetlist();
        if (!text || this.history.length === 0) {
            this._showToast('Nothing to copy — play some tracks first');
            return;
        }

        navigator.clipboard.writeText(text).then(() => {
            this._showToast('Setlist copied to clipboard');
        }).catch(() => {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                this._showToast('Setlist copied to clipboard');
            } catch (e) {
                this._showToast('Failed to copy');
            }
            document.body.removeChild(textarea);
        });
    }

    // ====== SHARE LINK ======

    // "This was the mix today": one link with every song so far, in order. See MixPage.js.
    // The link alone, for the phone and anything else that is not the clipboard.
    mixLink() {
        if (this.history.length === 0) return '';
        let name = '';
        try { name = localStorage.getItem('mixz-mix-name') || ''; } catch (e) { /* no storage */ }
        let dj = '';
        try { dj = localStorage.getItem('mixz-dj-name') || ''; } catch (e) { /* no storage */ }
        return mixUrl(window.location.origin, buildMix(this.history, { name, dj }));
    }

    // The live mix link: one link for the whole set, posted at the start, that shows every song
    // as it plays and then holds the finished mix (LiveMix.js). Made on first use.
    _liveHost() {
        // A lobby is held while a deck plays (LiveMix.js); the desk is window._djPlayer
        this.live ||= new LiveMixHost(() => this.history, {
            isPlaying: () => { const d = globalThis.window?._djPlayer?.decks; return !!(d?.A?.isPlaying || d?.B?.isPlaying); },
            onRoomLost: (r) => this._showToast(`Lobby "${r.name}" passed to another host after 30 silent minutes. Your set stays on your own live link.`),
        });
        return this.live;
    }

    // Host a lobby by name (Settings). { ok, link } or { ok: false, why, minutes, name }.
    async claimLobby(name) {
        try { return await this._liveHost().claimRoom(name); } catch (e) { console.warn('[Setlist] lobby claim failed:', e); return { ok: false, why: 'error' }; }
    }
    releaseLobby() { this.live?.releaseRoom(); }
    // Start a fresh live mix link (Settings), instead of waiting for six quiet hours
    // Refused (false) while a lobby is held: let it go first.
    newMixLink() {
        if (this.live && !this.live.newSet()) return false;
        this.live = null;
        try { localStorage.removeItem('mixz-live-mix'); } catch (e) { /* no storage */ }
        return true;
    }
    lobbyHeld() { const r = this.live?.room; return r && !r.checking ? { room: r.room, name: r.name } : null; }

    async liveLink() {
        try {
            this._liveHost();
            return await this.live.link(window.location.origin);
        } catch (e) {
            console.warn('[Setlist] live mix link unavailable, sharing a snapshot:', e);
            this.live = null;
            return '';
        }
    }

    async shareMix() {
        const room = this.lobbyHeld();
        const live = room ? `${window.location.origin}/mix.html#lobby=${room.room}` : await this.liveLink();
        if (live) {
            const n = this.history.length;
            const said = n ? `${n} ${n === 1 ? 'song' : 'songs'} so far, and every song after this` : 'every song from the first one';
            navigator.clipboard?.writeText(live).then(() => this._showToast(room ? `Lobby "${room.name}" link copied: it shows your set while you hold the lobby.` : `Live mix link copied: it shows ${said}, and keeps the finished mix. Post it now or at the end.`)).catch(() => prompt('Live link to this mix:', live));
            return live;
        }
        if (this.history.length === 0) { this._showToast('Nothing to share yet. Play a track first.'); return null; }
        let name = '';
        try { name = localStorage.getItem('mixz-mix-name') || ''; } catch (e) { /* no storage */ }
        let dj = '';
        try { dj = localStorage.getItem('mixz-dj-name') || ''; } catch (e) { /* no storage */ }
        const url = mixUrl(window.location.origin, buildMix(this.history, { name, dj }));
        try {
            const mixes = JSON.parse(localStorage.getItem('mixz-mixes') || '[]');
            mixes.unshift({ at: Date.now(), n: this.history.length, url });
            localStorage.setItem('mixz-mixes', JSON.stringify(mixes.slice(0, 30)));
        } catch (e) { /* no storage */ }
        navigator.clipboard?.writeText(url).then(() => this._showToast(`Mix link copied: ${this.history.length} ${this.history.length === 1 ? 'song' : 'songs'} so far. Paste it anywhere.`)).catch(() => prompt('Link to this mix:', url));
        return url;
    }

    _generateShareLink() {
        if (this.history.length === 0) {
            this._showToast('Nothing to share — play some tracks first');
            return;
        }

        const shareData = {
            d: this._getFormattedDate(),
            t: this.history.map(entry => ({
                n: entry.title,
                a: entry.artist || '',
                b: entry.bpm || 0,
                k: entry.key || '',
                ts: this._getElapsedString(entry.timestamp),
                du: entry.durationPlayed ? Math.round(entry.durationPlayed) : 0,
            })),
            s: (() => {
                const stats = this.getSessionStats();
                return {
                    tc: stats.totalTracks,
                    td: Math.round(stats.totalDuration),
                    br: stats.bpmRange ? `${stats.bpmRange.min}-${stats.bpmRange.max}` : '',
                    mk: stats.mostUsedKey || '',
                };
            })(),
        };

        try {
            const json = JSON.stringify(shareData);
            const encoded = btoa(unescape(encodeURIComponent(json)));
            const url = `${window.location.origin}${window.location.pathname}#setlist=${encoded}`;

            navigator.clipboard.writeText(url).then(() => {
                this._showToast('Share link copied to clipboard');
            }).catch(() => {
                // Show a prompt fallback
                prompt('Share this setlist link:', url);
            });
        } catch (e) {
            this._showToast('Failed to generate share link');
        }
    }

    _checkShareLink() {
        const hash = window.location.hash;
        if (!hash.startsWith('#setlist=')) return;

        try {
            const encoded = hash.replace('#setlist=', '');
            const json = decodeURIComponent(escape(atob(encoded)));
            const data = JSON.parse(json);

            this._renderShareView(data);
        } catch (e) {
            console.warn('[Setlist] Failed to parse share link:', e);
        }
    }

    _renderShareView(data) {
        // Create a full-page read-only setlist overlay
        const overlay = document.createElement('div');
        overlay.id = 'setlist-share-overlay';
        overlay.className = 'setlist-share-overlay';

        const tracks = data.t || [];
        const stats = data.s || {};

        let trackRows = '';
        tracks.forEach((t, i) => {
            const meta = [];
            if (t.b) meta.push(`${esc(t.b)} BPM`);
            if (t.k) meta.push(esc(t.k));
            const metaStr = meta.length > 0 ? `<span class="share-track-meta">${meta.join(' / ')}</span>` : '';
            const artist = t.a ? ` — ${esc(t.a)}` : '';
            trackRows += `
                <div class="share-track-row">
                    <span class="share-track-num">${String(i + 1).padStart(2, '0')}</span>
                    <span class="share-track-time">${esc(t.ts)}</span>
                    <span class="share-track-name">${esc(t.n)}${artist}</span>
                    ${metaStr}
                </div>
            `;
        });

        let statsHtml = '';
        if (stats.tc) {
            const statChips = [];
            statChips.push(`${esc(stats.tc)} tracks`);
            if (stats.td) statChips.push(esc(this._formatDuration(stats.td)));
            if (stats.br) statChips.push(`${esc(stats.br)} BPM`);
            if (stats.mk) statChips.push(`Key: ${esc(stats.mk)}`);
            statsHtml = `<div class="share-stats">${statChips.map(c => `<span class="share-stat-chip">${c}</span>`).join('')}</div>`;
        }

        overlay.innerHTML = `
            <div class="share-card">
                <div class="share-header">
                    <div class="share-brand">AURDOUR <span class="share-brand-accent">DJ</span></div>
                    <h1 class="share-title">DJ SET</h1>
                    <div class="share-date">${esc(data.d)}</div>
                    ${statsHtml}
                </div>
                <div class="share-tracklist">${trackRows}</div>
                <div class="share-footer">
                    <span>Powered by AURDOUR DJ</span>
                    <button class="btn-toolbar" id="share-close-btn">CLOSE</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('share-close-btn')?.addEventListener('click', () => {
            overlay.remove();
            window.location.hash = '';
        });
    }

    // ====== TOAST NOTIFICATION ======

    _showToast(message) {
        // Remove existing toast
        const existing = document.getElementById('setlist-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'setlist-toast';
        toast.className = 'setlist-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => toast.classList.add('show'));

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }

    // ====== HELPERS ======

    _formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}h ${m}m`;
        }
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    _fileTimestamp() {
        return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    }

    _downloadFile(content, mimeType, filename) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ====== RENDERING ======

    _renderQueue() {
        const list = document.getElementById('setlist-queue');
        if (!list) return;
        list.textContent = '';

        if (this.queue.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'setlist-empty';
            empty.textContent = 'Queue empty — add tracks from library';
            list.appendChild(empty);
            return;
        }

        this.queue.forEach((track, i) => {
            const item = document.createElement('div');
            item.className = 'setlist-item';
            item.draggable = true;
            item.dataset.index = i;

            const num = document.createElement('span');
            num.className = 'setlist-num';
            num.textContent = i + 1;

            const info = document.createElement('span');
            info.className = 'setlist-info';
            info.textContent = `${track.title} — ${track.artist || ''}`;

            const actions = document.createElement('span');
            actions.className = 'setlist-actions';

            const loadA = document.createElement('button');
            loadA.className = 'btn-load btn-load-a btn-xs';
            loadA.textContent = 'A';
            loadA.addEventListener('click', () => {
                this.loadTrack('A', track.dataFile);
                this.logPlay(track.title, track.artist, null, null, 'A');
                this.queue.splice(i, 1);
                this._renderQueue();
            });

            const loadB = document.createElement('button');
            loadB.className = 'btn-load btn-load-b btn-xs';
            loadB.textContent = 'B';
            loadB.addEventListener('click', () => {
                this.loadTrack('B', track.dataFile);
                this.logPlay(track.title, track.artist, null, null, 'B');
                this.queue.splice(i, 1);
                this._renderQueue();
            });

            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn-setlist-remove';
            removeBtn.textContent = '\u00d7';
            removeBtn.addEventListener('click', () => this.removeFromQueue(i));

            actions.appendChild(loadA);
            actions.appendChild(loadB);
            actions.appendChild(removeBtn);
            item.appendChild(num);
            item.appendChild(info);
            item.appendChild(actions);

            // Drag and drop
            item.addEventListener('dragstart', () => {
                this.dragIndex = i;
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                this.dragIndex = null;
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                item.classList.add('drag-over');
            });
            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                if (this.dragIndex !== null && this.dragIndex !== i) {
                    this.moveInQueue(this.dragIndex, i);
                }
            });

            list.appendChild(item);
        });
    }

    _renderHistory() {
        const list = document.getElementById('setlist-history');
        if (!list) return;
        list.textContent = '';

        this.history.slice().reverse().forEach(entry => {
            const item = document.createElement('div');
            item.className = 'history-item';
            const time = this._getElapsedString(entry.timestamp);
            let text = `${time} — ${entry.title}`;
            if (entry.artist) text += ` — ${entry.artist}`;

            const metaParts = [];
            if (entry.bpm) metaParts.push(`${entry.bpm}`);
            if (entry.key) metaParts.push(entry.key);
            if (entry.deck) metaParts.push(`Deck ${entry.deck}`);

            item.innerHTML = `
                <span class="history-time">${esc(time)}</span>
                <span class="history-title">${esc(entry.title)}${entry.artist ? ' — ' + esc(entry.artist) : ''}</span>
                ${metaParts.length > 0 ? `<span class="history-meta">${esc(metaParts.join(' / '))}</span>` : ''}
            `;
            list.appendChild(item);
        });
    }

    _renderStats() {
        const statsEl = document.getElementById('setlist-stats');
        if (!statsEl) return;

        const stats = this.getSessionStats();
        if (stats.totalTracks === 0) {
            statsEl.innerHTML = '<span class="setlist-stats-empty">Play tracks to see session stats</span>';
            return;
        }

        const chips = [];
        chips.push(`<span class="stat-chip">${stats.totalTracks} track${stats.totalTracks !== 1 ? 's' : ''}</span>`);
        chips.push(`<span class="stat-chip">${this._formatDuration(stats.totalDuration)}</span>`);
        if (stats.bpmRange) {
            chips.push(`<span class="stat-chip stat-chip-bpm">${esc(stats.bpmRange.min)}-${esc(stats.bpmRange.max)} BPM</span>`);
        }
        if (stats.mostUsedKey) {
            chips.push(`<span class="stat-chip stat-chip-key">Key: ${esc(stats.mostUsedKey)}</span>`);
        }
        if (stats.avgTrackLength > 0) {
            chips.push(`<span class="stat-chip">Avg: ${this._formatDuration(stats.avgTrackLength)}</span>`);
        }

        statsEl.innerHTML = chips.join('');

        // Update stats periodically (session duration ticks)
        if (!this._statsInterval && this.sessionStart) {
            this._statsInterval = setInterval(() => this._renderStats(), 10000);
        }
    }
}
