// ControllerMaps.js — ready-made maps for small controllers, so they read "ready" instead of
// "use LEARN" (Tom Fellenz in ZM, 16 Oct 2026: LPK25, LPD8, nanoKONTROL2).
// Built from each maker's factory default settings, on any MIDI channel. NOT yet tried on the
// hardware: if a control does nothing, LEARN still works on top.
//
// Keys: '<number>_<cc|note>'. Actions are the ones MidiController._executeAction knows.
// 'btn:' marks a button that sends CC (value 127 pressed, 0 released) instead of a note.

const range = (from, n, f) => Object.fromEntries(Array.from({ length: n }, (_, i) => f(from + i, i)));

export const MAPS = [
    {
        id: 'korg-nanokontrol2',
        name: 'Korg nanoKONTROL2',
        detect: /nano\s*kontrol\s*2/i,
        how: 'Faders 1 and 2: deck A and B volume. Fader 8: crossfader. Knobs 1 to 3: deck A high, mid, low. Knobs 4 to 6: deck B. S, M, R on strip 1: deck A cue, play, sync. Strip 2: deck B.',
        map: {
            '0_cc': 'volA', '1_cc': 'volB', '7_cc': 'crossfader',
            '16_cc': 'eqA.high', '17_cc': 'eqA.mid', '18_cc': 'eqA.low',
            '19_cc': 'eqB.high', '20_cc': 'eqB.mid', '21_cc': 'eqB.low',
            '32_cc': 'btn:deckA.cue', '48_cc': 'btn:deckA.play', '64_cc': 'btn:deckA.sync',
            '33_cc': 'btn:deckB.cue', '49_cc': 'btn:deckB.play', '65_cc': 'btn:deckB.sync',
            '41_cc': 'btn:deckA.play', // transport play
        },
    },
    {
        id: 'akai-lpd8',
        name: 'AKAI LPD8',
        detect: /lpd\s*8/i,
        how: 'Pads 1 to 4: deck A hot cues 1 to 4. Pads 5 to 8: deck B hot cues 1 to 4. Knobs 1 to 3: deck A high, mid, low. Knob 4: deck A volume. Knobs 5 to 7: deck B high, mid, low. Knob 8: deck B volume.',
        map: {
            ...range(36, 4, (n, i) => [`${n}_note`, `deckA.pad${i + 1}`]),
            ...range(40, 4, (n, i) => [`${n}_note`, `deckB.pad${i + 1}`]),
            // LPD8 (first model) knobs send CC 1 to 8; the LPD8 mk2 sends CC 70 to 77
            ...Object.fromEntries([[1, 70], [2, 71], [3, 72], [4, 73], [5, 74], [6, 75], [7, 76], [8, 77]].flatMap(([a, b], i) => {
                const act = ['eqA.high', 'eqA.mid', 'eqA.low', 'volA', 'eqB.high', 'eqB.mid', 'eqB.low', 'volB'][i];
                return [[`${a}_cc`, act], [`${b}_cc`, act]];
            })),
        },
    },
];

// The ready-made map for a device name, or null.
export function mapFor(deviceName) {
    return MAPS.find((m) => m.detect.test(String(deviceName || ''))) || null;
}

// The action a message triggers on a mapped device, and how: { action, kind } or null.
// kind is 'press', 'release' or 'cc' (with value 0..1), as _executeAction expects.
export function presetAction(preset, type, data1, data2) {
    if (!preset) return null;
    const isNoteOn = type === 0x90 && data2 > 0;
    const isNoteOff = type === 0x80 || (type === 0x90 && data2 === 0);
    if (isNoteOn || isNoteOff) {
        const action = preset.map[`${data1}_note`];
        return action ? { action, kind: isNoteOn ? 'press' : 'release' } : null;
    }
    if (type === 0xB0) {
        const action = preset.map[`${data1}_cc`];
        if (!action) return null;
        if (action.startsWith('btn:')) return { action: action.slice(4), kind: data2 >= 64 ? 'press' : 'release' };
        return { action, kind: 'cc', value: data2 / 127 };
    }
    return null;
}
