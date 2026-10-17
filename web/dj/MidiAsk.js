// MidiAsk.js — ask before touching MIDI (Tom Fellenz in ZM, 16 Oct 2026: the browser's MIDI
// prompt on first load explained nothing and had no skip). MixZ no longer asks on load. It
// connects by itself only when this browser already said yes; anyone else connects from the
// CONTROLLER menu, after a short note on what MixZ looks for.

// Connect without asking? Only when the browser already granted MIDI to this site.
export function shouldAutoConnect(permissionState) {
    return permissionState === 'granted';
}

// What the browser says about MIDI for this site: 'granted', 'prompt', 'denied' or 'unknown'.
export async function midiPermission(nav = globalThis.navigator) {
    try {
        if (!nav?.permissions?.query) return 'unknown';
        const p = await nav.permissions.query({ name: 'midi', sysex: false });
        return p?.state || 'unknown';
    } catch (e) {
        return 'unknown';
    }
}

export const NOTE = {
    title: 'Connect a DJ controller?',
    body: 'MixZ looks for MIDI DJ controllers plugged into this computer, like a Pioneer DDJ-SB3, so its knobs, faders and pads move the decks. It does not use your microphone or camera, and nothing leaves this device.',
    later: 'Not now is fine. You can connect any time from the CONTROLLER menu.',
};

// The note, with CONNECT and NOT NOW. Resolves true for connect, false for not now.
export function askToConnect(doc = document) {
    return new Promise((resolve) => {
        doc.getElementById('midi-ask')?.remove();
        const box = doc.createElement('div');
        box.id = 'midi-ask';
        box.className = 'midi-ask';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-labelledby', 'midi-ask-title');
        box.innerHTML = `<div class="midi-ask-card">
            <div class="midi-ask-title" id="midi-ask-title">${NOTE.title}</div>
            <p>${NOTE.body}</p>
            <p class="midi-ask-later">${NOTE.later}</p>
            <div class="midi-ask-row">
                <button class="btn-toolbar" id="midi-ask-no">NOT NOW</button>
                <button class="btn-toolbar midi-ask-yes" id="midi-ask-yes">CONNECT</button>
            </div></div>`;
        doc.body.appendChild(box);
        const done = (yes) => { box.remove(); resolve(yes); };
        box.querySelector('#midi-ask-yes').addEventListener('click', () => done(true));
        box.querySelector('#midi-ask-no').addEventListener('click', () => done(false));
        box.addEventListener('click', (e) => { if (e.target === box) done(false); });
        box.querySelector('#midi-ask-yes').focus();
    });
}

// What the connect found, in words (Tom, 16 Oct: "will there be clear recognition of what
// devices are found and connected?"). known(name) says whether MixZ has a built-in map.
export function describeDevices(names = [], known = () => false) {
    const devices = [...new Set(names.filter(Boolean))].map((name) => known(name)
        ? { name, ready: true, line: `${name}: ready.` }
        : { name, ready: false, line: `${name}: found. MixZ has no built-in map for it yet, so use LEARN: press LEARN, pick what to control, then move the knob or pad.` });
    if (!devices.length) {
        return { devices, title: 'No controller found', lines: [
            'Plug it in by USB, switch it on, then press CONNECT CONTROLLER again.',
            'Most controllers (Pioneer, AKAI, Novation, Numark) need no driver on a computer.',
            'If it still does not show, close other DJ or music apps that may be holding it, or try another USB port.',
        ] };
    }
    return { devices, title: devices.length === 1 ? 'Found 1 controller' : `Found ${devices.length} controllers`, lines: devices.map((d) => d.line) };
}

// Shows the summary with an OK.
export function showFound(summary, doc = document) {
    doc.getElementById('midi-ask')?.remove();
    const box = doc.createElement('div');
    box.id = 'midi-ask';
    box.className = 'midi-ask';
    box.setAttribute('role', 'dialog');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    box.innerHTML = `<div class="midi-ask-card">
        <div class="midi-ask-title">${esc(summary.title)}</div>
        ${summary.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
        <div class="midi-ask-row"><button class="btn-toolbar midi-ask-yes" id="midi-ask-ok">OK</button></div></div>`;
    doc.body.appendChild(box);
    const close = () => box.remove();
    box.querySelector('#midi-ask-ok').addEventListener('click', close);
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
}
