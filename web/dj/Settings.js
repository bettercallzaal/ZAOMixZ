// Settings.js — Settings panel UI for preferences, output routing, crossfader curve, key shift

import { esc } from './Html.js';

// The DJ's on/off switches, in one place (Zaal, 18 Oct 2026: "a simple settings page").
// Each one already exists somewhere in the app and keeps its own saved value; this list only
// says what it is, what it does and its safe default, and flips it through its own module.
//   key: where the value is saved. read(): the value, with the module's own default when
//   nothing is saved. apply(dj, on): set it the way the module's own button would.
export const DJ_SETTINGS = [
    {
        id: 'auto-requests', key: 'mixz-auto-requests', label: 'Auto-play requests', safe: false,
        hint: 'On: DJ MixZ plays listeners\' phone requests by itself, oldest first. Off: each one waits for you to tap PLAY NEXT. Chat requests always wait.',
        read: (get) => get('mixz-auto-requests') === 'on',
        apply: (dj, on) => dj.remote?.setAutoPlay?.(on),
    },
    {
        id: 'dead-air', key: 'mixz-deadair', label: 'Auto play on silence', safe: false,
        hint: 'On: after 5 seconds of silence the desk hands the decks back to DJ MixZ, skips a dead song, or starts a SongChainn set.',
        read: (get) => get('mixz-deadair') === 'on',
        apply: (dj, on) => dj.deadAir?.set?.(on),
    },
    {
        id: 'lights', key: 'mixz-lights', label: 'Controller lights', safe: true,
        hint: 'On: the buttons on a connected DDJ-SB3 light up to match the decks.',
        read: (get) => get('mixz-lights') !== 'off',
        apply: (dj, on) => dj.lights?.setEnabled?.(on),
    },
    {
        id: 'pro', key: 'aurdour-pro-mode', label: 'PRO view', safe: false,
        hint: 'On: every tool on the decks and mixer. Off: the simple view, with only what is needed to mix.',
        read: (get) => get('aurdour-pro-mode') === '1',
        apply: (dj, on, doc = typeof document !== 'undefined' ? document : null) => {
            if (!doc) return;
            if (doc.body.classList.contains('pro-mode') !== !!on) doc.getElementById('pro-mode-toggle')?.click();
        },
    },
];

const storageGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

// Words never shown from stream chat: a chat line or !sr request with one is held back
// (ChatFilter.moderate, read by player.js _chatBlocked). One per line, or comma separated.
export const CHAT_BLOCK_KEY = 'mixz-chat-block';
export const cleanBlockList = (text) => String(text || '').split(/\n|,/).map((w) => w.trim()).filter(Boolean).slice(0, 200).join('\n');

// The rows for the panel: plain text from the list above only, no outside data.
export function djSettingsHtml(get = storageGet) {
    return `<div class="settings-label">DJ SETTINGS</div>` + DJ_SETTINGS.map((s) => {
        const on = s.read(get);
        return `<label class="dj-setting" data-setting="${s.id}">`
            + `<span class="dj-setting-text"><b>${s.label}</b><small>${s.hint}</small><small class="dj-setting-default">Safe default: ${s.safe ? 'on' : 'off'}</small></span>`
            + `<input type="checkbox" class="dj-setting-switch" data-setting="${s.id}"${on ? ' checked' : ''} aria-label="${s.label}"></label>`;
    }).join('')
        + `<label class="dj-setting dj-setting-words"><span class="dj-setting-text"><b>Words never shown from chat</b>`
        + `<small>A Twitch or YouTube line or song request with one of these is held back. One per line.</small>`
        + `<small class="dj-setting-default">Safe default: empty (links are always held)</small>`
        + `<textarea id="dj-chat-block" rows="3" spellcheck="false" aria-label="Words never shown from chat">${esc(get(CHAT_BLOCK_KEY) || '')}</textarea></span></label>`;
}

export class Settings {
    constructor(djPlayer) {
        this.dj = djPlayer;
        this.panelOpen = false;
        this._undoStack = [];
        this._redoStack = [];

        // Key shift state per deck
        this._keyShift = { A: 0, B: 0 };

        // Note names for key display
        this._noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        this._initUI();
        this._initOutputSelector();
        this._initKeyShiftInline();
    }

    // The DJ switches at the top of the panel, drawn fresh each time it opens, since a switch
    // can also be flipped elsewhere (the AUTO-PLAY button on the request line, PRO, AUTO PLAY).
    renderDjSettings() {
        const box = document.getElementById('dj-settings');
        if (!box) return;
        box.innerHTML = djSettingsHtml();
        if (!box.dataset.wired) {
            box.dataset.wired = '1';
            box.addEventListener('change', (e) => {
                if (e.target?.id === 'dj-chat-block') {
                    try { localStorage.setItem(CHAT_BLOCK_KEY, cleanBlockList(e.target.value)); } catch (err) { /* no storage */ }
                    this.renderDjSettings();
                    return;
                }
                const id = e.target?.dataset?.setting;
                const s = DJ_SETTINGS.find((x) => x.id === id);
                if (s) { s.apply(this.dj, !!e.target.checked); this.renderDjSettings(); }
            });
        }
    }

    _initUI() {
        const settingsBtn = document.getElementById('settings-btn');
        const settingsPanel = document.getElementById('settings-panel');
        const closeBtn = document.getElementById('settings-close');

        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                this.panelOpen = !this.panelOpen;
                settingsPanel?.classList.toggle('hidden', !this.panelOpen);
                if (this.panelOpen) this.renderDjSettings();
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.panelOpen = false;
                settingsPanel?.classList.add('hidden');
            });
        }

        // Crossfader curve
        const cfCurve = document.getElementById('setting-cf-curve');
        if (cfCurve) {
            cfCurve.addEventListener('change', (e) => {
                this.dj.audioRouter.setCrossfaderCurve(e.target.value);
            });
        }

        // Key shift (settings panel sliders, kept for backward compatibility)
        ['a', 'b'].forEach(ch => {
            const keyShift = document.getElementById(`keyshift-${ch}`);
            if (keyShift) {
                keyShift.addEventListener('input', (e) => {
                    const semitones = parseInt(e.target.value);
                    this._setKeyShift(ch.toUpperCase(), semitones);
                });
            }
        });

        // Export/Import settings
        document.getElementById('settings-export')?.addEventListener('click', () => {
            this.dj.storage.exportAll();
        });

        document.getElementById('settings-import')?.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (file) {
                    await this.dj.storage.importAll(file);
                    location.reload();
                }
            });
            input.click();
        });

        // MIDI profile save/load
        document.getElementById('midi-save-profile')?.addEventListener('click', () => {
            const name = prompt('Profile name:');
            if (name && this.dj.midi) {
                const profiles = this.dj.storage.get('midi_profiles', {});
                profiles[name] = { ...this.dj.midi.mappings };
                this.dj.storage.set('midi_profiles', profiles);
                this._renderMidiProfiles();
            }
        });
    }

    // ===== INLINE KEY SHIFT CONTROLS (on deck) =====

    _initKeyShiftInline() {
        ['a', 'b'].forEach(ch => {
            const deckId = ch.toUpperCase();
            const upBtn = document.getElementById(`keyshift-${ch}-up`);
            const downBtn = document.getElementById(`keyshift-${ch}-down`);

            if (upBtn) {
                upBtn.addEventListener('click', () => {
                    const current = this._keyShift[deckId];
                    if (current < 6) {
                        this._setKeyShift(deckId, current + 1);
                    }
                });
            }

            if (downBtn) {
                downBtn.addEventListener('click', () => {
                    const current = this._keyShift[deckId];
                    if (current > -6) {
                        this._setKeyShift(deckId, current - 1);
                    }
                });
            }
        });
    }

    _setKeyShift(deckId, semitones) {
        semitones = Math.max(-6, Math.min(6, semitones));
        this._keyShift[deckId] = semitones;
        const ch = deckId.toLowerCase();

        // Apply the actual audio shift
        this._applyKeyShift(deckId, semitones);

        // Update inline display
        const inlineDisplay = document.getElementById(`keyshift-${ch}-inline-display`);
        if (inlineDisplay) {
            inlineDisplay.textContent = `${semitones >= 0 ? '+' : ''}${semitones}`;
            inlineDisplay.style.color = semitones === 0 ? '' : (semitones > 0 ? '#00ff88' : '#ff4444');
        }

        // Update settings panel slider (if open)
        const settingsSlider = document.getElementById(`keyshift-${ch}`);
        if (settingsSlider) settingsSlider.value = semitones;

        // Update settings panel display
        const settingsDisplay = document.getElementById(`keyshift-${ch}-display`);
        if (settingsDisplay) settingsDisplay.textContent = `${semitones >= 0 ? '+' : ''}${semitones}`;

        // Calculate and display new key after shift
        this._updateShiftedKeyDisplay(deckId, semitones);
    }

    _updateShiftedKeyDisplay(deckId, semitones) {
        const ch = deckId.toLowerCase();
        const keyDisplay = document.getElementById(`keyshift-${ch}-key-display`);
        if (!keyDisplay) return;

        // Get the original detected key from the deck display
        const originalKeyEl = document.getElementById(`deck-${ch}-key`);
        if (!originalKeyEl || !originalKeyEl.textContent || originalKeyEl.textContent === '--') {
            keyDisplay.textContent = '';
            return;
        }

        const originalKey = originalKeyEl.textContent.trim();
        const shiftedKey = this._transposeKey(originalKey, semitones);

        if (semitones === 0) {
            keyDisplay.textContent = '';
        } else {
            keyDisplay.textContent = `> ${shiftedKey}`;
            keyDisplay.style.color = '#ffcc00';
        }
    }

    _transposeKey(keyStr, semitones) {
        if (!keyStr || semitones === 0) return keyStr;

        const isMinor = keyStr.endsWith('m');
        const rootStr = isMinor ? keyStr.slice(0, -1) : keyStr;

        const noteIndex = this._noteNames.indexOf(rootStr);
        if (noteIndex === -1) return keyStr; // can't parse

        const newIndex = ((noteIndex + semitones) % 12 + 12) % 12;
        return this._noteNames[newIndex] + (isMinor ? 'm' : '');
    }

    async _initOutputSelector() {
        const headphoneSelect = document.getElementById('setting-headphone-output');
        if (!headphoneSelect) return;

        try {
            // Need permission first
            await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
            const devices = await this.dj.audioRouter.getOutputDevices();

            headphoneSelect.textContent = '';
            const defaultOpt = document.createElement('option');
            defaultOpt.value = '';
            defaultOpt.textContent = 'Default';
            headphoneSelect.appendChild(defaultOpt);

            devices.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}`;
                headphoneSelect.appendChild(opt);
            });

            headphoneSelect.addEventListener('change', async (e) => {
                if (e.target.value) {
                    await this.dj.audioRouter.setHeadphoneDevice(e.target.value);
                }
            });
        } catch (e) {
            console.log('Could not enumerate audio outputs');
        }
    }

    _applyKeyShift(deckId, semitones) {
        const deck = this.dj.decks[deckId];
        if (!deck || !deck.isLoaded) return;
        // Key shift via detune on the audio element
        // Web Audio doesn't have native pitch shift without tempo change
        // but we can use playbackRate + preservesPitch
        // For true pitch shift, we'd need a PitchShifter node (not available natively)
        // Approximate: adjust playback rate slightly while keylock compensates
        const ratio = Math.pow(2, semitones / 12);
        const media = deck.getMediaElement();
        if (media) {
            media.playbackRate = deck.currentRate * ratio;
            media.preservesPitch = true; // this keeps the pitch, so we invert
            // Actually for key shift: we want to CHANGE pitch without tempo
            // preservesPitch = false + rate change = both pitch and tempo change
            // preservesPitch = true + rate change = tempo change only
            // true key shift requires DSP. For now, toggle preservesPitch off to shift
            media.preservesPitch = false;
        }
    }

    // Get the current key shift value for a deck
    getKeyShift(deckId) {
        return this._keyShift[deckId] || 0;
    }

    _renderMidiProfiles() {
        const listEl = document.getElementById('midi-profiles-list');
        if (!listEl) return;
        const profiles = this.dj.storage.get('midi_profiles', {});
        listEl.textContent = '';

        Object.keys(profiles).forEach(name => {
            const btn = document.createElement('button');
            btn.className = 'btn-toolbar btn-sm';
            btn.textContent = name;
            btn.addEventListener('click', () => {
                if (this.dj.midi) {
                    this.dj.midi.mappings = { ...profiles[name] };
                    this.dj.storage.saveMidiMappings(this.dj.midi.mappings);
                }
            });
            listEl.appendChild(btn);
        });
    }

    // ===== UNDO / REDO =====

    pushUndo(action) {
        this._undoStack.push(action);
        this._redoStack = [];
        if (this._undoStack.length > 50) this._undoStack.shift();
    }

    undo() {
        if (this._undoStack.length === 0) return;
        const action = this._undoStack.pop();
        this._redoStack.push(action);
        if (action.undo) action.undo();
    }

    redo() {
        if (this._redoStack.length === 0) return;
        const action = this._redoStack.pop();
        this._undoStack.push(action);
        if (action.redo) action.redo();
    }
}
