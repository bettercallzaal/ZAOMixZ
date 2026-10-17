// MidiController.js — Web MIDI API support for hardware DJ controllers
import { shouldAutoConnect, midiPermission, askToConnect, describeDevices, showFound } from './MidiAsk.js';
import { mapFor, presetAction } from './ControllerMaps.js';
// Built-in Pioneer DDJ Serato mappings + MIDI learn fallback

// ── DEBUG HELPERS ───────────────────────────────────────────────
const DEBUG = false;
const _debugStyles = {
    midi:   'background:#1a1a2e;color:#00ff88;padding:2px 6px;border-radius:3px;font-weight:bold',
    note:   'background:#2d1b69;color:#e040fb;padding:2px 6px;border-radius:3px',
    cc:     'background:#1b3a4b;color:#00bcd4;padding:2px 6px;border-radius:3px',
    action: 'background:#4a1942;color:#ff6f00;padding:2px 6px;border-radius:3px;font-weight:bold',
    jog:    'background:#1b4332;color:#95d5b2;padding:2px 6px;border-radius:3px',
    eq:     'background:#3d2645;color:#ffd54f;padding:2px 6px;border-radius:3px',
    vol:    'background:#1a237e;color:#82b1ff;padding:2px 6px;border-radius:3px',
    error:  'background:#b71c1c;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
    info:   'background:#004d40;color:#a7ffeb;padding:2px 6px;border-radius:3px',
};
function _midiLog(category, ...args) {
    if (!DEBUG) return;
    const style = _debugStyles[category] || _debugStyles.info;
    console.log(`%c[MIDI:${category.toUpperCase()}]`, style, ...args);
}
function _hexByte(b) { return '0x' + (b & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }
function _hexMsg(data) { return Array.from(data).map(b => _hexByte(b)).join(' '); }
function _midiTypeName(type) {
    switch (type) {
        case 0x80: return 'NOTE_OFF';
        case 0x90: return 'NOTE_ON';
        case 0xA0: return 'POLY_AT';
        case 0xB0: return 'CC';
        case 0xC0: return 'PROG_CHG';
        case 0xD0: return 'CHAN_AT';
        case 0xE0: return 'PITCH_BEND';
        default: return `UNKNOWN(${_hexByte(type)})`;
    }
}
// Message rate throttle for high-frequency CCs (jog, faders)
let _msgCount = 0;
let _msgCountInterval = null;

const PIONEER_DDJ = {
    name: 'Pioneer DDJ',
    detect: (deviceName) => /pioneer|ddj|serato/i.test(deviceName),

    // Channel assignments
    CH_DECK1: 0,
    CH_DECK2: 1,
    CH_GLOBAL: 6,
    CH_PADS1: 7,
    CH_PADS2: 9,
    CH_PADS2_ALT: 8, // DDJ-SB3 sends deck 2 pads here (deck 1 on 7, decks 3/4 on 9/10)

    // Note numbers — Transport (channels 0/1)
    NOTE_PLAY: 0x0B,
    NOTE_CUE: 0x0C,
    NOTE_SYNC: 0x58,
    NOTE_PFL: 0x54,
    NOTE_SHIFT: 0x3F,

    // Note numbers — Global (channel 6)
    NOTE_LOAD_DECK1: 0x46,
    NOTE_LOAD_DECK2: 0x47,
    NOTE_BROWSE_PRESS: 0x41,
    NOTE_BACK: 0x42,

    // CC numbers — Per-deck (channels 0/1)
    CC_EQ_HIGH_MSB: 0x07,
    CC_EQ_MID_MSB: 0x0B,
    CC_EQ_LOW_MSB: 0x0F,
    CC_EQ_HIGH_LSB: 0x27,
    CC_EQ_MID_LSB: 0x2B,
    CC_EQ_LOW_LSB: 0x2F,
    CC_VOL_MSB: 0x13,
    CC_VOL_LSB: 0x33,
    CC_TEMPO_MSB: 0x00,
    CC_TEMPO_LSB: 0x20,
    CC_FILTER_MSB: 0x17,
    CC_FILTER_LSB: 0x37,
    CC_JOG_VINYL: 0x22,
    CC_JOG_RING: 0x21,

    // Note numbers — Loop/Performance (channels 0/1)
    NOTE_LOOP_IN: 0x10,
    NOTE_LOOP_OUT: 0x11,
    NOTE_RELOOP: 0x4D,
    NOTE_LOOP_HALVE: 0x12,
    NOTE_LOOP_DOUBLE: 0x13,
    NOTE_AUTO_LOOP: 0x14,   // auto-loop toggle (beat loop)
    NOTE_KEYLOCK: 0x1A,
    NOTE_SLIP: 0x40,

    // Note numbers — FX (channels 0/1)
    NOTE_FX_TOGGLE: 0x47,
    NOTE_FX_SELECT: 0x4A,

    // Note numbers — Pad mode buttons (channels 0/1). The second four are the shifted modes.
    PAD_MODES: { 0x1B: 'hotcue', 0x1E: 'fxfade', 0x20: 'switch', 0x22: 'sampler', 0x69: 'beatjump', 0x6B: 'roll', 0x6D: 'slicer', 0x6E: 'trans' },

    // CC numbers — Global (channel 6)
    CC_CROSSFADER_MSB: 0x1F,
    CC_CROSSFADER_LSB: 0x3F,
    CC_MASTER_VOL_MSB: 0x0D,
    CC_MASTER_VOL_LSB: 0x2D,
    CC_BOOTH_VOL_MSB: 0x11,
    CC_BOOTH_VOL_LSB: 0x31,
    CC_HEADPHONE_MIX_MSB: 0x0E,
    CC_HEADPHONE_MIX_LSB: 0x2E,
    CC_HEADPHONE_VOL_MSB: 0x10,
    CC_HEADPHONE_VOL_LSB: 0x30,
    CC_BROWSE: 0x40,
    CC_SAMPLER_VOL_MSB: 0x15,
    CC_SAMPLER_VOL_LSB: 0x35,

    // Hot cue pad notes (channels 7/9)
    PAD_HOTCUE_BASE: 0x00,  // 0x00–0x07
    PAD_FXFADE_BASE: 0x10,  // 0x10–0x17 (FX FADE mode on the DDJ-SB3)
    PAD_ROLL_BASE: 0x50,    // 0x50–0x57 (beat loop roll mode, shift + FX FADE)
    PAD_SLICER_BASE: 0x20,  // 0x20–0x27 (slicer mode)
    PAD_SAMPLER_BASE: 0x30, // 0x30–0x37 (sampler mode)
    PAD_BEATJUMP_BASE: 0x40, // 0x40–0x47 (beat jump, shift + HOT CUE)
    PAD_SLICE_BASE: 0x60,   // 0x60–0x67 (slicer, shift + PAD SCRATCH)
};

export class MidiController {
    constructor(djPlayer) {
        this.dj = djPlayer;
        this.midiAccess = null;
        this.connected = false;
        this.devices = [];
        this.learning = false;
        this.learnTarget = null;
        this.activeProfile = null;

        // Manual MIDI learn mappings: { 'channel_cc': 'action' }
        this.mappings = {};

        // 14-bit MSB/LSB state per channel
        this._msbState = {};

        // Jog wheel state
        this._jogTouch = { A: false, B: false };

        // Which pad mode each deck is in. The controller starts on hot cues.
        this.padMode = { A: 'hotcue', B: 'hotcue' };

        // Shift key state per deck
        this._shift = { 0: false, 1: false };

        // LED output (if available)
        this._outputs = [];

        this._initUI();
        this._connectIfAllowed();
    }

    // No MIDI prompt on load. Reconnect quietly where the browser already said yes;
    // everyone else connects from CONNECT CONTROLLER, after a short note (MidiAsk.js).
    async _connectIfAllowed() {
        this._updateStatus('Not connected');
        const btn = document.getElementById('midi-connect');
        if (btn) btn.addEventListener('click', () => this.connect());
        if (shouldAutoConnect(await midiPermission())) this._requestMIDI();
    }

    // CONNECT CONTROLLER: explain first, then ask the browser.
    async connect() {
        if (!this.midiAccess) {
            if (!(await askToConnect())) { this._updateStatus('Not connected'); return; }
            await this._requestMIDI();
            if (!this.midiAccess) return; // the browser said no
        } else this._onMIDISuccess();
        // Say what was found, and what to do with a controller MixZ has no map for
        showFound(describeDevices(this.devices, (n) => PIONEER_DDJ.detect(n) || !!mapFor(n)));
    }

    async _requestMIDI() {
        if (!navigator.requestMIDIAccess) {
            _midiLog('error', 'Web MIDI API not supported in this browser!');
            this._updateStatus('Not supported');
            return;
        }

        _midiLog('info', 'Requesting MIDI access (sysex: false)...');

        try {
            this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
            _midiLog('info', 'MIDI access GRANTED');
            _midiLog('info', `Inputs: ${this.midiAccess.inputs.size}, Outputs: ${this.midiAccess.outputs.size}`);
            this._onMIDISuccess();
            const cb = document.getElementById('midi-connect'); if (cb) { cb.textContent = 'CHECK CONTROLLERS'; cb.title = 'See what is connected, or look again after plugging one in'; }
            this.midiAccess.onstatechange = (e) => {
                _midiLog('info', `MIDI state change: port="${e.port.name}" type=${e.port.type} state=${e.port.state} connection=${e.port.connection}`);
                this._onMIDISuccess();
            };

            // Start message rate counter
            _msgCountInterval = setInterval(() => {
                if (_msgCount > 0) {
                    _midiLog('info', `Message rate: ${_msgCount} msgs/sec`);
                    _msgCount = 0;
                }
            }, 1000);
        } catch (err) {
            _midiLog('error', 'MIDI access DENIED:', err.message, err);
            this._updateStatus('Denied');
        }
    }

    _onMIDISuccess() {
        this.devices = [];
        this._outputs = [];

        _midiLog('info', '── Enumerating MIDI ports ──');

        this.midiAccess.inputs.forEach((input, id) => {
            _midiLog('info', `  INPUT: "${input.name}" id=${id} manufacturer="${input.manufacturer}" state=${input.state} connection=${input.connection}`);
            this.devices.push(input.name);
            // Each message says which device sent it, so a DDJ and a nanoKONTROL2 can run side by side
            input.onmidimessage = (msg) => this._onMIDIMessage(msg, input.name);
        });

        this.midiAccess.outputs.forEach((output, id) => {
            _midiLog('info', `  OUTPUT: "${output.name}" id=${id} manufacturer="${output.manufacturer}" state=${output.state}`);
            this._outputs.push(output);
        });

        if (this.devices.length > 0) {
            this.connected = true;
            // The DDJ can be any of the plugged-in devices, not only the first
            const name = this.devices.find((d) => PIONEER_DDJ.detect(d)) || this.devices[0];
            this._updateStatus(name);

            // Auto-detect Pioneer DDJ
            _midiLog('info', `Testing Pioneer DDJ detection for: "${name}"...`);
            if (PIONEER_DDJ.detect(name)) {
                this.activeProfile = 'pioneer-ddj';
                this._updateStatus(`${name} ✓`);
                _midiLog('midi', `Pioneer DDJ DETECTED: "${name}" — using built-in mappings`);
                _midiLog('midi', 'Mapped channels: Deck1=CH0, Deck2=CH1, Global=CH6, Pads1=CH7, Pads2=CH9');
            } else {
                _midiLog('info', `Not a Pioneer DDJ device. Using custom/learn mappings. (Regex: /pioneer|ddj|serato/i)`);
            }
        } else {
            this.connected = false;
            this.activeProfile = null;
            this._updateStatus('No device');
            _midiLog('info', 'No MIDI devices found. Connect a controller and it will auto-detect.');
        }

        this._renderDeviceList();
    }

    _onMIDIMessage(msg, from = '') {
        const [status, data1, data2] = msg.data;
        const channel = status & 0x0F;
        const type = status & 0xF0;
        _msgCount++;

        // Raw message log (throttled for CCs to avoid flood)
        const isHighFreq = (type === 0xB0 && (data1 === PIONEER_DDJ.CC_JOG_VINYL || data1 === PIONEER_DDJ.CC_JOG_RING));
        if (!isHighFreq) {
            _midiLog('midi', `RAW: ${_hexMsg(msg.data)}  |  ${_midiTypeName(type)} ch=${channel} data1=${_hexByte(data1)}(${data1}) data2=${_hexByte(data2)}(${data2})`);
        }

        // MIDI Learn mode — intercept
        if (this.learning && this.learnTarget) {
            const key = `${channel}_${data1}_${type === 0xB0 ? 'cc' : 'note'}`;
            this.mappings[key] = this.learnTarget;
            _midiLog('action', `MIDI LEARN: mapped ${key} → "${this.learnTarget}"`);
            this.learning = false;
            this.learnTarget = null;
            this._updateStatus('Mapped!');
            setTimeout(() => this._updateStatus(this.devices[0] || 'Connected'), 1000);
            return;
        }

        // Ready-made maps for small controllers (ControllerMaps.js)
        const preset = from && !PIONEER_DDJ.detect(from) ? mapFor(from) : null;
        if (preset) {
            const hit = presetAction(preset, type, data1, data2);
            if (hit) { this._executeAction(hit.action, hit.kind, hit.value ?? 0); return; }
        }

        // Pioneer DDJ built-in profile (only for messages from the DDJ when the sender is known)
        if (this.activeProfile === 'pioneer-ddj' && (!from || PIONEER_DDJ.detect(from))) {
            this._handlePioneerDDJ(type, channel, data1, data2);
            return;
        }

        // Fallback: custom mappings
        this._handleCustomMapping(type, channel, data1, data2);
    }

    // ── Pioneer DDJ Handler ─────────────────────────────────────

    _handlePioneerDDJ(type, channel, data1, data2) {
        const P = PIONEER_DDJ;

        // A real hand on the controller takes the decks from DJ MixZ: moving the crossfader,
        // pressing play or cue, or loading a track. A resting fader sends small jitters, so the
        // crossfader has to move by more than 3 steps to count.
        const mixz = this.dj.djMixz;
        if (mixz?.running && !mixz.human) {
            const noteOn = type === 0x90 && data2 > 0;
            let grab = false;
            if (type === 0xB0 && channel === P.CH_GLOBAL && data1 === P.CC_CROSSFADER_MSB) {
                if (this._xfSeen != null && Math.abs(data2 - this._xfSeen) > 3) grab = true;
                this._xfSeen = data2;
            }
            if (noteOn && (channel === P.CH_DECK1 || channel === P.CH_DECK2) && (data1 === P.NOTE_PLAY || data1 === P.NOTE_CUE)) grab = true;
            if (noteOn && channel === P.CH_GLOBAL && (data1 === P.NOTE_LOAD_DECK1 || data1 === P.NOTE_LOAD_DECK2)) grab = true;
            if (grab) mixz.takeOver('touch');
        } else if (type === 0xB0 && channel === P.CH_GLOBAL && data1 === P.CC_CROSSFADER_MSB) {
            this._xfSeen = data2;
        }
        const deckId = channel === P.CH_DECK1 ? 'A' : channel === P.CH_DECK2 ? 'B' : null;

        // Note On
        if (type === 0x90 && data2 > 0) {
            // Transport — Deck channels (0/1)
            if (deckId) {
                switch (data1) {
                    case P.NOTE_PLAY:
                        _midiLog('note', `▶ PLAY/PAUSE pressed — Deck ${deckId}`);
                        this._deckAction(deckId, 'playPause'); return;
                    case P.NOTE_CUE:
                        _midiLog('note', `⏺ CUE pressed — Deck ${deckId}`);
                        this._deckAction(deckId, 'cue'); return;
                    case P.NOTE_SYNC:
                        _midiLog('note', `🔄 SYNC pressed — Deck ${deckId}`);
                        this._deckAction(deckId, 'sync'); return;
                    case P.NOTE_PFL:
                        _midiLog('note', `🎧 PFL pressed — Deck ${deckId}`);
                        this._togglePFL(deckId); return;
                    case P.NOTE_SHIFT:
                        _midiLog('note', `⇧ SHIFT pressed — Deck ${deckId} (ch=${channel})`);
                        this._shift[channel] = true; return;
                    case P.NOTE_LOOP_IN:
                        _midiLog('note', `LOOP IN — Deck ${deckId}`);
                        this._deckAction(deckId, 'loopIn'); return;
                    case P.NOTE_LOOP_OUT:
                        _midiLog('note', `LOOP OUT — Deck ${deckId}`);
                        this._deckAction(deckId, 'loopOut'); return;
                    case P.NOTE_RELOOP:
                        _midiLog('note', `RELOOP — Deck ${deckId}`);
                        this._deckAction(deckId, 'toggleLoop'); return;
                    case P.NOTE_LOOP_HALVE:
                        _midiLog('note', `LOOP /2 — Deck ${deckId}`);
                        this._deckAction(deckId, 'loopHalve'); return;
                    case P.NOTE_LOOP_DOUBLE:
                        _midiLog('note', `LOOP x2 — Deck ${deckId}`);
                        this._deckAction(deckId, 'loopDouble'); return;
                    case P.NOTE_AUTO_LOOP:
                        _midiLog('note', `AUTO LOOP — Deck ${deckId}`);
                        this._deckAction(deckId, 'autoLoop', 4); return;
                    case P.NOTE_KEYLOCK:
                        _midiLog('note', `KEY LOCK — Deck ${deckId}`);
                        this._deckAction(deckId, 'keylock'); return;
                    case P.NOTE_SLIP:
                        _midiLog('note', `SLIP MODE — Deck ${deckId}`);
                        this._deckAction(deckId, 'slip'); return;
                    case P.NOTE_FX_TOGGLE:
                        _midiLog('note', `FX TOGGLE — Deck ${deckId}`);
                        this._toggleFX(deckId); return;
                }
                if (P.PAD_MODES[data1]) {
                    this.padMode[deckId] = P.PAD_MODES[data1];
                    _midiLog('note', `PAD MODE ${this.padMode[deckId]} — Deck ${deckId}`);
                    return;
                }
                _midiLog('note', `UNHANDLED note on Deck ${deckId}: note=${_hexByte(data1)} vel=${data2}`);
            }

            // Hot cue pads — channels 7 (deck1) / 9 (deck2)
            if (channel === P.CH_PADS1 || channel === P.CH_PADS2 || channel === P.CH_PADS2_ALT) {
                const padDeck = channel === P.CH_PADS1 ? 'A' : 'B';
                if (data1 >= P.PAD_HOTCUE_BASE && data1 <= P.PAD_HOTCUE_BASE + 7) {
                    const padIdx = data1 - P.PAD_HOTCUE_BASE;
                    _midiLog('note', `🔲 PAD ${padIdx + 1} pressed — Deck ${padDeck} (ch=${channel})`);
                    this._deckAction(padDeck, 'hotcue', padIdx);
                    return;
                }
                // FX FADE pads (0x10–0x17): take this deck out with an effect and a fade
                if (data1 >= P.PAD_FXFADE_BASE && data1 <= P.PAD_FXFADE_BASE + 7) {
                    const padIdx = data1 - P.PAD_FXFADE_BASE;
                    const result = this.dj.fxFade?.trigger(padDeck, padIdx);
                    _midiLog('note', `FX FADE PAD ${padIdx + 1} — Deck ${padDeck}: ${result}`);
                    return;
                }
                // Beat loop roll pads (0x50–0x57)
                if (data1 >= P.PAD_ROLL_BASE && data1 <= P.PAD_ROLL_BASE + 7) {
                    const padIdx = data1 - P.PAD_ROLL_BASE;
                    const beats = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8][padIdx];
                    _midiLog('note', `🔁 ROLL PAD ${padIdx + 1} (${beats} beats) — Deck ${padDeck}`);
                    this._deckAction(padDeck, 'autoLoop', beats);
                    return;
                }
                // Pad Scratch mode pads (0x20–0x27): the eight next-track switches
                if (data1 >= P.PAD_SLICER_BASE && data1 <= P.PAD_SLICER_BASE + 7) {
                    const padIdx = data1 - P.PAD_SLICER_BASE;
                    _midiLog('note', `SWITCH PAD ${padIdx + 1} (from Deck ${padDeck} pads)`);
                    this.dj.switchPad?.trigger(padIdx);
                    return;
                }
                // Beat jump pads (0x40–0x47)
                if (data1 >= P.PAD_BEATJUMP_BASE && data1 <= P.PAD_BEATJUMP_BASE + 7) {
                    const beats = this.dj.padModes?.beatJump(padDeck, data1 - P.PAD_BEATJUMP_BASE);
                    _midiLog('note', `BEAT JUMP ${beats} — Deck ${padDeck}`);
                    return;
                }
                // Slicer pads (0x60–0x67)
                if (data1 >= P.PAD_SLICE_BASE && data1 <= P.PAD_SLICE_BASE + 7) {
                    const slice = this.dj.padModes?.slice(padDeck, data1 - P.PAD_SLICE_BASE);
                    _midiLog('note', `SLICE ${slice} — Deck ${padDeck}`);
                    return;
                }
                // Sampler pads (0x30–0x37)
                if (data1 >= P.PAD_SAMPLER_BASE && data1 <= P.PAD_SAMPLER_BASE + 7) {
                    const padIdx = data1 - P.PAD_SAMPLER_BASE;
                    _midiLog('note', `🎹 SAMPLER PAD ${padIdx + 1} — Deck ${padDeck}`);
                    this._triggerSampler(padIdx);
                    return;
                }
                _midiLog('note', `UNHANDLED pad note: ch=${channel} note=${_hexByte(data1)} vel=${data2}`);
            }

            // Global channel (6)
            if (channel === P.CH_GLOBAL) {
                switch (data1) {
                    case P.NOTE_LOAD_DECK1:
                        _midiLog('note', `📥 LOAD TO DECK A`);
                        this._loadToDeck('A'); return;
                    case P.NOTE_LOAD_DECK2:
                        _midiLog('note', `📥 LOAD TO DECK B`);
                        this._loadToDeck('B'); return;
                    case P.NOTE_BROWSE_PRESS:
                        _midiLog('note', `🔍 BROWSE PRESS (encoder push) — loading selected track`);
                        this._loadSelectedTrack();
                        return;
                    case P.NOTE_BACK:
                        _midiLog('note', `⬅ BACK button — switching library tab`);
                        this._libraryBack();
                        return;
                }
                _midiLog('note', `UNHANDLED global note: note=${_hexByte(data1)} vel=${data2}`);
            }

            // Completely unhandled note on
            if (!deckId && channel !== P.CH_PADS1 && channel !== P.CH_PADS2 && channel !== P.CH_PADS2_ALT && channel !== P.CH_GLOBAL) {
                _midiLog('note', `??? UNKNOWN NOTE ON: ch=${channel} note=${_hexByte(data1)} vel=${data2}`);
            }
        }

        // Note Off / Note On velocity 0
        if (type === 0x80 || (type === 0x90 && data2 === 0)) {
            if (deckId && data1 === P.NOTE_SHIFT) {
                _midiLog('note', `⇧ SHIFT released — Deck ${deckId}`);
                this._shift[channel] = false;
                return;
            }
            // Don't log every note-off to reduce noise, but log unhandled ones
        }

        // Control Change
        if (type === 0xB0) {
            // Per-deck CCs (channels 0/1)
            if (deckId) {
                this._handleDeckCC(deckId, channel, data1, data2);
                return;
            }

            // Global CCs (channel 6)
            if (channel === P.CH_GLOBAL) {
                this._handleGlobalCC(data1, data2);
                return;
            }

            _midiLog('cc', `??? UNKNOWN CC: ch=${channel} cc=${_hexByte(data1)} val=${data2}`);
        }
    }

    _handleDeckCC(deckId, channel, cc, value) {
        const P = PIONEER_DDJ;
        const router = this.dj.audioRouter;
        if (!router) {
            _midiLog('error', `AudioRouter not available! Deck ${deckId} CC ${_hexByte(cc)} ignored`);
            return;
        }

        switch (cc) {
            // 14-bit EQ High
            case P.CC_EQ_HIGH_MSB:
                _midiLog('eq', `EQ HIGH MSB — Deck ${deckId}: ${value}`);
                this._storeMSB(channel, cc, value); this._apply14bitEQ(deckId, channel, cc, 'high'); return;
            case P.CC_EQ_HIGH_LSB:
                this._apply14bitEQ(deckId, channel, P.CC_EQ_HIGH_MSB, 'high', value); return;

            // 14-bit EQ Mid
            case P.CC_EQ_MID_MSB:
                _midiLog('eq', `EQ MID MSB — Deck ${deckId}: ${value}`);
                this._storeMSB(channel, cc, value); this._apply14bitEQ(deckId, channel, cc, 'mid'); return;
            case P.CC_EQ_MID_LSB:
                this._apply14bitEQ(deckId, channel, P.CC_EQ_MID_MSB, 'mid', value); return;

            // 14-bit EQ Low
            case P.CC_EQ_LOW_MSB:
                _midiLog('eq', `EQ LOW MSB — Deck ${deckId}: ${value}`);
                this._storeMSB(channel, cc, value); this._apply14bitEQ(deckId, channel, cc, 'low'); return;
            case P.CC_EQ_LOW_LSB:
                this._apply14bitEQ(deckId, channel, P.CC_EQ_LOW_MSB, 'low', value); return;

            // 14-bit Volume fader
            case P.CC_VOL_MSB:
                _midiLog('vol', `VOLUME MSB — Deck ${deckId}: ${value}`);
                this._storeMSB(channel, cc, value); this._apply14bitVolume(deckId, channel, cc); return;
            case P.CC_VOL_LSB:
                this._apply14bitVolume(deckId, channel, P.CC_VOL_MSB, value); return;

            // 14-bit Tempo slider
            case P.CC_TEMPO_MSB:
                _midiLog('cc', `TEMPO MSB — Deck ${deckId}: ${value}`);
                this._storeMSB(channel, cc, value); this._apply14bitTempo(deckId, channel, cc); return;
            case P.CC_TEMPO_LSB:
                this._apply14bitTempo(deckId, channel, P.CC_TEMPO_MSB, value); return;

            // Jog wheel — vinyl surface (scratch)
            case P.CC_JOG_VINYL: this._handleJogWheel(deckId, value, true); return;

            // Jog wheel — outer ring (pitch bend)
            case P.CC_JOG_RING: this._handleJogWheel(deckId, value, false); return;

            // 14-bit Filter knob
            case P.CC_FILTER_MSB:
                _midiLog('cc', `FILTER MSB — Deck ${deckId}: ${value}`);
                this._storeMSB(channel, cc, value);
                this._apply14bitFilter(deckId, channel, cc);
                return;
            case P.CC_FILTER_LSB:
                this._apply14bitFilter(deckId, channel, P.CC_FILTER_MSB, value);
                return;
        }

        _midiLog('cc', `UNHANDLED Deck ${deckId} CC: cc=${_hexByte(cc)} val=${value}`);
    }

    _handleGlobalCC(cc, value) {
        const P = PIONEER_DDJ;
        const router = this.dj.audioRouter;
        if (!router) {
            _midiLog('error', `AudioRouter not available! Global CC ${_hexByte(cc)} ignored`);
            return;
        }

        // Filter knobs: the DDJ-SB3 sends these on the mixer channel, 0x17 for deck 1 and 0x18 for deck 2
        if (cc === P.CC_FILTER_MSB || cc === P.CC_FILTER_MSB + 1) {
            this._storeMSB(P.CH_GLOBAL, cc, value);
            this._apply14bitFilter(cc === P.CC_FILTER_MSB ? 'A' : 'B', P.CH_GLOBAL, cc);
            return;
        }
        if (cc === P.CC_FILTER_LSB || cc === P.CC_FILTER_LSB + 1) {
            this._apply14bitFilter(cc === P.CC_FILTER_LSB ? 'A' : 'B', P.CH_GLOBAL, cc - 0x20, value);
            return;
        }

        switch (cc) {
            // 14-bit Crossfader
            case P.CC_CROSSFADER_MSB:
                _midiLog('vol', `CROSSFADER MSB: ${value}`);
                this._storeMSB(P.CH_GLOBAL, cc, value);
                this._apply14bitCrossfader(value);
                return;
            case P.CC_CROSSFADER_LSB:
                this._apply14bitCrossfader(null, value);
                return;

            // 14-bit Master volume
            case P.CC_MASTER_VOL_MSB:
                _midiLog('vol', `MASTER VOL MSB: ${value}`);
                this._storeMSB(P.CH_GLOBAL, cc, value);
                this._apply14bitMaster(value);
                return;
            case P.CC_MASTER_VOL_LSB:
                this._apply14bitMaster(null, value);
                return;

            // 14-bit Headphone mix (cue/master)
            case P.CC_HEADPHONE_MIX_MSB:
                _midiLog('cc', `HEADPHONE MIX MSB: ${value}`);
                this._storeMSB(P.CH_GLOBAL, cc, value);
                this._apply14bitCueMix(value);
                return;
            case P.CC_HEADPHONE_MIX_LSB:
                this._apply14bitCueMix(null, value);
                return;

            // 14-bit Headphone volume
            case P.CC_HEADPHONE_VOL_MSB:
                _midiLog('cc', `HEADPHONE VOL MSB: ${value}`);
                this._storeMSB(P.CH_GLOBAL, cc, value);
                this._apply14bitCueVolume(value);
                return;
            case P.CC_HEADPHONE_VOL_LSB:
                this._apply14bitCueVolume(null, value);
                return;

            // 14-bit Booth volume
            case P.CC_BOOTH_VOL_MSB:
                _midiLog('vol', `BOOTH VOL MSB: ${value}`);
                this._storeMSB(P.CH_GLOBAL, cc, value);
                this._apply14bitBooth(value);
                return;
            case P.CC_BOOTH_VOL_LSB:
                this._apply14bitBooth(null, value);
                return;

            // 14-bit Sampler volume
            case P.CC_SAMPLER_VOL_MSB:
                _midiLog('vol', `SAMPLER VOL MSB: ${value}`);
                this._storeMSB(P.CH_GLOBAL, cc, value);
                return;
            case P.CC_SAMPLER_VOL_LSB:
                return;

            // Browse encoder (relative, centered at 64)
            case P.CC_BROWSE:
                _midiLog('cc', `BROWSE encoder: raw=${value} delta=${value < 64 ? value : value - 128}`);
                this._handleBrowseEncoder(value);
                return;
        }

        _midiLog('cc', `UNHANDLED Global CC: cc=${_hexByte(cc)} val=${value}`);
    }

    // ── 14-bit MSB/LSB Helpers ──────────────────────────────────

    _storeMSB(channel, cc, value) {
        this._msbState[`${channel}_${cc}`] = value;
    }

    _get14bit(channel, msbCC, lsb) {
        const msb = this._msbState[`${channel}_${msbCC}`] || 0;
        const lsbVal = (lsb != null) ? lsb : 0;
        return ((msb << 7) | lsbVal) / 16383; // normalized 0–1
    }

    _apply14bitEQ(deckId, channel, msbCC, band, lsb) {
        const normalized = this._get14bit(channel, msbCC, lsb);
        // Map 0–1 to -24dB to +6dB
        const db = normalized * 30 - 24;
        _midiLog('eq', `EQ ${band.toUpperCase()} Deck ${deckId}: normalized=${normalized.toFixed(3)} → ${db.toFixed(1)}dB`);
        const router = this.dj.audioRouter;
        if (router) router.setEQ(deckId, band, db);

        // Update UI knob
        const knobId = `eq-${deckId.toLowerCase()}-${band}`;
        const knob = document.getElementById(knobId);
        if (knob) knob.value = normalized * 100;
    }

    _apply14bitVolume(deckId, channel, msbCC, lsb) {
        const normalized = this._get14bit(channel, msbCC, lsb);
        _midiLog('vol', `VOLUME Deck ${deckId}: normalized=${normalized.toFixed(3)} (${(normalized * 100).toFixed(1)}%)`);
        const router = this.dj.audioRouter;
        if (router) router.setChannelVolume(deckId, normalized);

        const slider = document.getElementById(`vol-${deckId.toLowerCase()}`);
        if (slider) slider.value = normalized * 100;
    }

    _apply14bitTempo(deckId, channel, msbCC, lsb) {
        const normalized = this._get14bit(channel, msbCC, lsb);
        // Map 0–1 to tempo range: ±8% (typical Serato range)
        // 0.5 = center (no change), 0 = -8%, 1 = +8%
        const tempoAdjust = (normalized - 0.5) * 0.16;
        const deck = this.dj.decks?.[deckId];
        _midiLog('cc', `TEMPO Deck ${deckId}: normalized=${normalized.toFixed(3)} adjust=${(tempoAdjust * 100).toFixed(2)}% rate=${(1 + tempoAdjust).toFixed(4)} baseBPM=${deck?.baseBPM || 'none'}`);
        if (deck && deck.baseBPM) {
            const newRate = 1 + tempoAdjust;
            deck.setPlaybackRate(newRate);
        } else if (deck && !deck.baseBPM) {
            _midiLog('info', `Tempo slider moved but Deck ${deckId} has no baseBPM set (no track loaded?)`);
        }
    }

    _apply14bitCrossfader(msb, lsb) {
        const P = PIONEER_DDJ;
        if (msb != null) this._storeMSB(P.CH_GLOBAL, P.CC_CROSSFADER_MSB, msb);
        const normalized = this._get14bit(P.CH_GLOBAL, P.CC_CROSSFADER_MSB, lsb);
        _midiLog('vol', `CROSSFADER: normalized=${normalized.toFixed(3)} (A◄ ${(normalized * 100).toFixed(1)}% ►B)`);
        const router = this.dj.audioRouter;
        if (router) router.setCrossfade(normalized);

        const slider = document.getElementById('crossfader');
        if (slider) slider.value = normalized * 100;
    }

    _apply14bitMaster(msb, lsb) {
        const P = PIONEER_DDJ;
        if (msb != null) this._storeMSB(P.CH_GLOBAL, P.CC_MASTER_VOL_MSB, msb);
        const normalized = this._get14bit(P.CH_GLOBAL, P.CC_MASTER_VOL_MSB, lsb);
        const router = this.dj.audioRouter;
        if (router) router.setMasterVolume(normalized);

        const slider = document.getElementById('master-volume');
        if (slider) slider.value = normalized * 100;
    }

    _apply14bitCueMix(msb, lsb) {
        const P = PIONEER_DDJ;
        if (msb != null) this._storeMSB(P.CH_GLOBAL, P.CC_HEADPHONE_MIX_MSB, msb);
        const normalized = this._get14bit(P.CH_GLOBAL, P.CC_HEADPHONE_MIX_MSB, lsb);
        const router = this.dj.audioRouter;
        if (router) router.setCueMix(normalized);

        const slider = document.getElementById('cue-mix');
        if (slider) slider.value = normalized * 100;
    }

    _apply14bitFilter(deckId, channel, msbCC, lsb) {
        const normalized = this._get14bit(channel, msbCC, lsb);
        _midiLog('cc', `FILTER Deck ${deckId}: normalized=${normalized.toFixed(3)}`);
        const router = this.dj.audioRouter;
        if (router) router.setFilter(deckId, normalized);

        const knob = document.getElementById(`filter-${deckId.toLowerCase()}`);
        if (knob) knob.value = normalized * 100;
    }

    _apply14bitCueVolume(msb, lsb) {
        const P = PIONEER_DDJ;
        if (msb != null) this._storeMSB(P.CH_GLOBAL, P.CC_HEADPHONE_VOL_MSB, msb);
        const normalized = this._get14bit(P.CH_GLOBAL, P.CC_HEADPHONE_VOL_MSB, lsb);
        _midiLog('vol', `HEADPHONE VOL: normalized=${normalized.toFixed(3)}`);
        const router = this.dj.audioRouter;
        if (router) router.setCueVolume(normalized);

        const slider = document.getElementById('cue-volume');
        if (slider) slider.value = normalized * 100;
    }

    _apply14bitBooth(msb, lsb) {
        const P = PIONEER_DDJ;
        if (msb != null) this._storeMSB(P.CH_GLOBAL, P.CC_BOOTH_VOL_MSB, msb);
        const normalized = this._get14bit(P.CH_GLOBAL, P.CC_BOOTH_VOL_MSB, lsb);
        _midiLog('vol', `BOOTH VOL: normalized=${normalized.toFixed(3)}`);
        const router = this.dj.audioRouter;
        if (router) router.setBoothVolume(normalized);

        const slider = document.getElementById('booth-volume');
        if (slider) slider.value = normalized * 100;
    }

    _loadSelectedTrack() {
        const library = this.dj.library;
        if (!library) return;

        if (library.selectedTrack) {
            // Auto-select idle deck (not playing), prefer A
            const deckA = this.dj.decks?.A;
            const deckB = this.dj.decks?.B;
            let targetDeck = 'A';
            if (deckA?.isPlaying && !deckB?.isPlaying) targetDeck = 'B';
            else if (!deckA?.isLoaded) targetDeck = 'A';
            else if (!deckB?.isLoaded) targetDeck = 'B';

            _midiLog('action', `BROWSE PRESS → loading "${library.selectedTrack?.title || 'track'}" to Deck ${targetDeck}`);
            library.loadToDeck(library.selectedTrack, targetDeck);
        } else {
            _midiLog('info', 'Browse press — no track selected');
        }
    }

    _libraryBack() {
        // Cycle through library tabs: LOCAL → LIKED → AUDIUS
        const tabs = document.querySelectorAll('.library-tab');
        if (!tabs.length) return;
        const activeIdx = Array.from(tabs).findIndex(t => t.classList.contains('active'));
        const prevIdx = activeIdx > 0 ? activeIdx - 1 : tabs.length - 1;
        tabs[prevIdx]?.click();
    }

    _triggerSampler(padIdx) {
        const sampler = this.dj.sampler;
        if (sampler) {
            sampler.triggerPad(padIdx);
            _midiLog('action', `SAMPLER pad ${padIdx + 1} triggered`);
        } else {
            // Fallback: click the sampler pad button in the UI
            const padBtn = document.getElementById(`sampler-pad-${padIdx}`);
            if (padBtn) padBtn.click();
            else _midiLog('info', `Sampler not available and no pad button found for pad ${padIdx + 1}`);
        }
    }

    // ── Deck Actions ────────────────────────────────────────────

    _deckAction(deckId, action, param) {
        const deck = this.dj.decks?.[deckId];
        if (!deck) {
            _midiLog('error', `Deck ${deckId} not found! Action "${action}" ignored. Available decks: ${Object.keys(this.dj.decks || {}).join(', ')}`);
            return;
        }

        _midiLog('action', `DECK ${deckId} → ${action}${param != null ? ` (param=${param})` : ''} | loaded=${deck.isLoaded} playing=${deck.isPlaying}`);

        switch (action) {
            case 'playPause': deck.playPause(); break;
            case 'cue': deck.cue(); break;
            case 'sync': {
                const otherDeck = deckId === 'A' ? 'B' : 'A';
                const bpm = this.dj.decks[otherDeck]?.getBPM();
                _midiLog('action', `SYNC: Deck ${deckId} syncing to Deck ${otherDeck} BPM=${bpm || 'N/A'}`);
                if (bpm) deck.syncTo(bpm);
                else _midiLog('info', `Cannot sync — Deck ${otherDeck} has no BPM`);
                break;
            }
            case 'hotcue':
                _midiLog('action', `HOT CUE ${param + 1} on Deck ${deckId} — cue exists: ${!!deck.hotCues?.[param]}`);
                deck.triggerHotCue(param);
                break;
            case 'loopIn': deck.setLoopIn(); break;
            case 'loopOut': deck.setLoopOut(); break;
            case 'toggleLoop': deck.toggleLoop(); break;
            case 'loopHalve': deck.loopHalve(); break;
            case 'loopDouble': deck.loopDouble(); break;
            case 'autoLoop': deck.autoLoop(param || 4); break;
            case 'keylock':
                deck.keyLock = !deck.keyLock;
                _midiLog('action', `KEY LOCK ${deck.keyLock ? 'ON' : 'OFF'} — Deck ${deckId}`);
                // Update UI toggle if present
                const klBtn = document.getElementById(`keylock-${deckId.toLowerCase()}`);
                if (klBtn) klBtn.classList.toggle('active', deck.keyLock);
                break;
            case 'slip':
                deck.slipMode = !deck.slipMode;
                _midiLog('action', `SLIP MODE ${deck.slipMode ? 'ON' : 'OFF'} — Deck ${deckId}`);
                const slipBtn = document.getElementById(`slip-${deckId.toLowerCase()}`);
                if (slipBtn) slipBtn.classList.toggle('active', deck.slipMode);
                break;
        }
    }

    _togglePFL(deckId) {
        const btn = document.getElementById(`pfl-${deckId.toLowerCase()}`);
        if (btn) btn.click();
    }

    _toggleFX(deckId) {
        const btn = document.getElementById(`fx-${deckId.toLowerCase()}-toggle`);
        if (btn) {
            btn.click();
            _midiLog('action', `FX toggled via UI button — Deck ${deckId}`);
        } else {
            _midiLog('info', `FX toggle button not found for Deck ${deckId}`);
        }
    }

    _loadToDeck(deckId) {
        // Load the currently selected/highlighted track in the library
        const library = this.dj.library;
        if (library && library.selectedTrack) {
            _midiLog('action', `LOAD TO DECK ${deckId}: track="${library.selectedTrack}"`);
            library.loadToDeck(library.selectedTrack, deckId);
        } else {
            _midiLog('info', `Load to Deck ${deckId} — no track selected in library (library=${!!library}, selectedTrack=${library?.selectedTrack})`);
        }
    }

    // ── Jog Wheel ───────────────────────────────────────────────

    _handleJogWheel(deckId, value, isVinyl) {
        // Relative encoding: 64 = stationary, <64 = backward, >64 = forward
        // Values wrap: 1 = slow forward, 127 = slow backward
        let delta;
        if (value >= 64) {
            delta = value - 64;   // forward
        } else {
            delta = value - 64;   // backward (negative)
        }

        if (delta === 0) return;

        _midiLog('jog', `JOG ${isVinyl ? 'VINYL' : 'RING'} Deck ${deckId}: raw=${value} delta=${delta} scaled=${(delta / 64).toFixed(3)}`);

        const jogWheel = this.dj.jogWheel;
        if (jogWheel) {
            // Scale delta for sensitivity
            const scaledDelta = delta / 64; // -1 to +1 range
            if (isVinyl) {
                jogWheel.scratch(deckId, scaledDelta);
            } else {
                jogWheel.nudge(deckId, scaledDelta * 0.02);
            }
        } else {
            _midiLog('info', 'JogWheel module not available, using fallback pitch bend');
            // Fallback: direct pitch bend
            const deck = this.dj.decks?.[deckId];
            if (deck) {
                const nudgeAmount = delta * 0.001;
                const current = deck.wavesurfer?.getPlaybackRate() || 1;
                deck.wavesurfer?.setPlaybackRate(current + nudgeAmount);
                // Reset after brief moment
                clearTimeout(this._jogResetTimer);
                this._jogResetTimer = setTimeout(() => {
                    if (deck.wavesurfer) deck.wavesurfer.setPlaybackRate(deck.currentRate || 1);
                }, 100);
            }
        }
    }

    // ── Browse Encoder ──────────────────────────────────────────

    _handleBrowseEncoder(value) {
        // Relative encoding: 64 = no movement
        const delta = value < 64 ? value : value - 128; // signed
        const library = this.dj.library;
        if (library) {
            if (delta > 0) {
                library.selectNext();
            } else if (delta < 0) {
                library.selectPrev();
            }
        }
    }

    // ── Custom Mapping Fallback ─────────────────────────────────

    _handleCustomMapping(type, channel, data1, data2) {
        const noteKey = `${channel}_${data1}_note`;
        const ccKey = `${channel}_${data1}_cc`;

        if (type === 0x90 && data2 > 0) {
            const action = this.mappings[noteKey];
            if (action) this._executeAction(action, 'press');
        } else if (type === 0x80 || (type === 0x90 && data2 === 0)) {
            const action = this.mappings[noteKey];
            if (action) this._executeAction(action, 'release');
        } else if (type === 0xB0) {
            const action = this.mappings[ccKey];
            if (action) this._executeAction(action, 'cc', data2 / 127);
        }
    }

    _executeAction(action, type, value = 0) {
        const router = this.dj.audioRouter;

        switch (action) {
            case 'deckA.play': if (type === 'press') this.dj.decks?.A?.playPause(); break;
            case 'deckA.cue': if (type === 'press') this.dj.decks?.A?.cue(); break;
            case 'deckA.sync': if (type === 'press') { const bpm = this.dj.decks?.B?.getBPM(); if (bpm) this.dj.decks.A.syncTo(bpm); } break;
            case 'deckA.pad1': case 'deckA.pad2': case 'deckA.pad3': case 'deckA.pad4':
            case 'deckA.pad5': case 'deckA.pad6': case 'deckA.pad7': case 'deckA.pad8':
                if (type === 'press') { const idx = parseInt(action.slice(-1)) - 1; this.dj.decks?.A?.triggerHotCue(idx); }
                break;

            case 'deckB.play': if (type === 'press') this.dj.decks?.B?.playPause(); break;
            case 'deckB.cue': if (type === 'press') this.dj.decks?.B?.cue(); break;
            case 'deckB.sync': if (type === 'press') { const bpm = this.dj.decks?.A?.getBPM(); if (bpm) this.dj.decks.B.syncTo(bpm); } break;
            case 'deckB.pad1': case 'deckB.pad2': case 'deckB.pad3': case 'deckB.pad4':
            case 'deckB.pad5': case 'deckB.pad6': case 'deckB.pad7': case 'deckB.pad8':
                if (type === 'press') { const idx = parseInt(action.slice(-1)) - 1; this.dj.decks?.B?.triggerHotCue(idx); }
                break;

            case 'crossfader': if (type === 'cc' && router) { const cf = document.getElementById('crossfader'); if (cf) { cf.value = value * 100; router.setCrossfade(value); } } break;
            case 'volA': if (type === 'cc' && router) { const va = document.getElementById('vol-a'); if (va) { va.value = value * 100; router.setChannelVolume('A', value); } } break;
            case 'volB': if (type === 'cc' && router) { const vb = document.getElementById('vol-b'); if (vb) { vb.value = value * 100; router.setChannelVolume('B', value); } } break;
            case 'eqA.high': if (type === 'cc' && router) router.setEQ('A', 'high', value * 30 - 24); break;
            case 'eqA.mid': if (type === 'cc' && router) router.setEQ('A', 'mid', value * 30 - 24); break;
            case 'eqA.low': if (type === 'cc' && router) router.setEQ('A', 'low', value * 30 - 24); break;
            case 'eqB.high': if (type === 'cc' && router) router.setEQ('B', 'high', value * 30 - 24); break;
            case 'eqB.mid': if (type === 'cc' && router) router.setEQ('B', 'mid', value * 30 - 24); break;
            case 'eqB.low': if (type === 'cc' && router) router.setEQ('B', 'low', value * 30 - 24); break;
            case 'mic.mute': if (type === 'press' && router) { const m = router.mic?.muted; router.setMicMute(!m); } break;
        }
    }

    // ── MIDI Learn ──────────────────────────────────────────────

    startLearn(target) {
        this.learning = true;
        this.learnTarget = target;
        this._updateStatus('Move a control...');
    }

    // ── LED Feedback ────────────────────────────────────────────

    sendLED(channel, note, velocity) {
        if (this._outputs.length === 0) {
            _midiLog('info', `sendLED: no outputs available (ch=${channel} note=${_hexByte(note)} vel=${velocity})`);
            return;
        }
        const output = this._outputs[0];
        const msg = [0x90 | channel, note, velocity];
        _midiLog('midi', `LED OUT → ${output.name}: ${_hexMsg(msg)}`);
        output.send(msg);
    }

    // ── UI ──────────────────────────────────────────────────────

    _updateStatus(text) {
        const el = document.getElementById('midi-status');
        if (el) el.textContent = text;
    }

    _renderDeviceList() {
        const el = document.getElementById('midi-devices');
        if (!el) return;
        el.textContent = '';
        if (this.devices.length) {
            this.devices.forEach(d => {
                const span = document.createElement('span');
                span.className = 'midi-device';
                span.textContent = d;
                if ((this.activeProfile === 'pioneer-ddj' && PIONEER_DDJ.detect(d)) || mapFor(d)) {
                    span.textContent += ' (ready)';
                    span.style.color = '#00ff88';
                }
                if (!((this.activeProfile === 'pioneer-ddj' && PIONEER_DDJ.detect(d)) || mapFor(d))) span.textContent += ' (use LEARN)';
                el.appendChild(span);
            });
        } else {
            const span = document.createElement('span');
            span.className = 'midi-none';
            span.textContent = 'No MIDI devices';
            el.appendChild(span);
        }
    }

    _initUI() {
        const learnBtn = document.getElementById('midi-learn');
        if (learnBtn) {
            learnBtn.addEventListener('click', () => {
                const targets = [
                    'crossfader', 'volA', 'volB',
                    'deckA.play', 'deckB.play',
                    'deckA.cue', 'deckB.cue',
                    'eqA.high', 'eqA.mid', 'eqA.low',
                    'eqB.high', 'eqB.mid', 'eqB.low',
                ];
                const current = learnBtn.dataset.targetIdx || 0;
                const target = targets[current % targets.length];
                learnBtn.dataset.targetIdx = (parseInt(current) + 1) % targets.length;
                this.startLearn(target);
                learnBtn.textContent = `LEARN: ${target}`;
            });
        }
    }

    // ── Export/Import Mappings ───────────────────────────────────

    exportMappings() {
        return JSON.stringify(this.mappings, null, 2);
    }

    importMappings(json) {
        try {
            this.mappings = JSON.parse(json);
        } catch (e) {
            console.warn('Invalid MIDI mapping JSON:', e);
        }
    }
}

// ── Additional MIDI Controller Profiles ──────────────────────────

const MIDI_PROFILES = {
    'pioneer-ddj': {
        name: 'Pioneer DDJ',
        detect: (name) => /pioneer|ddj|serato/i.test(name),
    },
    'traktor-s2': {
        name: 'Traktor Kontrol S2 MK3',
        detect: (name) => /traktor|kontrol\s*s2/i.test(name),
        noteMap: {
            0: { 0x10: 'play', 0x11: 'cue', 0x12: 'sync', 0x0E: 'shift', 0x14: 'hotcue0', 0x15: 'hotcue1', 0x16: 'hotcue2', 0x17: 'hotcue3', 0x18: 'hotcue4', 0x19: 'hotcue5', 0x1A: 'hotcue6', 0x1B: 'hotcue7', 0x0F: 'pfl' },
            1: { 0x10: 'play', 0x11: 'cue', 0x12: 'sync', 0x0E: 'shift', 0x14: 'hotcue0', 0x15: 'hotcue1', 0x16: 'hotcue2', 0x17: 'hotcue3', 0x18: 'hotcue4', 0x19: 'hotcue5', 0x1A: 'hotcue6', 0x1B: 'hotcue7', 0x0F: 'pfl' },
        },
        ccMap: {
            0: { 0x16: 'eqHigh', 0x17: 'eqMid', 0x18: 'eqLow', 0x19: 'volume', 0x1A: 'tempo', 0x1E: 'jogVinyl', 0x1F: 'jogRing', 0x1B: 'filter' },
            1: { 0x16: 'eqHigh', 0x17: 'eqMid', 0x18: 'eqLow', 0x19: 'volume', 0x1A: 'tempo', 0x1E: 'jogVinyl', 0x1F: 'jogRing', 0x1B: 'filter' },
            2: { 0x08: 'crossfader', 0x0D: 'masterVol', 0x0E: 'cueMix', 0x40: 'browse' },
        },
        deckChannels: { 0: 'A', 1: 'B' },
        globalChannel: 2,
    },
    'numark-mixtrack': {
        name: 'Numark Mixtrack Pro FX',
        detect: (name) => /numark|mixtrack/i.test(name),
        noteMap: {
            0: { 0x00: 'play', 0x01: 'cue', 0x02: 'sync', 0x04: 'pfl', 0x08: 'hotcue0', 0x09: 'hotcue1', 0x0A: 'hotcue2', 0x0B: 'hotcue3', 0x10: 'loopIn', 0x11: 'loopOut', 0x12: 'reloop' },
            1: { 0x00: 'play', 0x01: 'cue', 0x02: 'sync', 0x04: 'pfl', 0x08: 'hotcue0', 0x09: 'hotcue1', 0x0A: 'hotcue2', 0x0B: 'hotcue3', 0x10: 'loopIn', 0x11: 'loopOut', 0x12: 'reloop' },
        },
        ccMap: {
            0: { 0x01: 'eqHigh', 0x02: 'eqMid', 0x03: 'eqLow', 0x04: 'volume', 0x05: 'tempo', 0x06: 'jogVinyl', 0x07: 'jogRing', 0x08: 'filter' },
            1: { 0x01: 'eqHigh', 0x02: 'eqMid', 0x03: 'eqLow', 0x04: 'volume', 0x05: 'tempo', 0x06: 'jogVinyl', 0x07: 'jogRing', 0x08: 'filter' },
            2: { 0x03: 'crossfader', 0x04: 'masterVol', 0x40: 'browse' },
        },
        deckChannels: { 0: 'A', 1: 'B' },
        globalChannel: 2,
    },
    'hercules-inpulse': {
        name: 'Hercules DJControl Inpulse 500',
        detect: (name) => /hercules|inpulse|djcontrol/i.test(name),
        noteMap: {
            0: { 0x11: 'play', 0x12: 'cue', 0x13: 'sync', 0x10: 'pfl', 0x20: 'hotcue0', 0x21: 'hotcue1', 0x22: 'hotcue2', 0x23: 'hotcue3', 0x24: 'hotcue4', 0x25: 'hotcue5', 0x26: 'hotcue6', 0x27: 'hotcue7' },
            1: { 0x11: 'play', 0x12: 'cue', 0x13: 'sync', 0x10: 'pfl', 0x20: 'hotcue0', 0x21: 'hotcue1', 0x22: 'hotcue2', 0x23: 'hotcue3', 0x24: 'hotcue4', 0x25: 'hotcue5', 0x26: 'hotcue6', 0x27: 'hotcue7' },
        },
        ccMap: {
            0: { 0x02: 'eqHigh', 0x03: 'eqMid', 0x04: 'eqLow', 0x00: 'volume', 0x09: 'tempo', 0x30: 'jogVinyl', 0x31: 'jogRing', 0x05: 'filter' },
            1: { 0x02: 'eqHigh', 0x03: 'eqMid', 0x04: 'eqLow', 0x00: 'volume', 0x09: 'tempo', 0x30: 'jogVinyl', 0x31: 'jogRing', 0x05: 'filter' },
            2: { 0x08: 'crossfader', 0x10: 'masterVol', 0x40: 'browse' },
        },
        deckChannels: { 0: 'A', 1: 'B' },
        globalChannel: 2,
    },
    'roland-dj202': {
        name: 'Roland DJ-202',
        detect: (name) => /roland|dj.?202/i.test(name),
        noteMap: {
            0: { 0x0B: 'play', 0x0C: 'cue', 0x58: 'sync', 0x54: 'pfl', 0x00: 'hotcue0', 0x01: 'hotcue1', 0x02: 'hotcue2', 0x03: 'hotcue3', 0x04: 'hotcue4', 0x05: 'hotcue5', 0x06: 'hotcue6', 0x07: 'hotcue7' },
            1: { 0x0B: 'play', 0x0C: 'cue', 0x58: 'sync', 0x54: 'pfl', 0x00: 'hotcue0', 0x01: 'hotcue1', 0x02: 'hotcue2', 0x03: 'hotcue3', 0x04: 'hotcue4', 0x05: 'hotcue5', 0x06: 'hotcue6', 0x07: 'hotcue7' },
        },
        ccMap: {
            0: { 0x07: 'eqHigh', 0x0B: 'eqMid', 0x0F: 'eqLow', 0x13: 'volume', 0x00: 'tempo', 0x22: 'jogVinyl', 0x21: 'jogRing', 0x17: 'filter' },
            1: { 0x07: 'eqHigh', 0x0B: 'eqMid', 0x0F: 'eqLow', 0x13: 'volume', 0x00: 'tempo', 0x22: 'jogVinyl', 0x21: 'jogRing', 0x17: 'filter' },
            6: { 0x1F: 'crossfader', 0x0D: 'masterVol', 0x40: 'browse' },
        },
        deckChannels: { 0: 'A', 1: 'B' },
        globalChannel: 6,
    },
};

// Make profiles accessible for auto-detection
MidiController.PROFILES = MIDI_PROFILES;
