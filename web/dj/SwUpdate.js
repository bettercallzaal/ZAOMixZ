// When a new service worker takes over, the page used to reload itself (SW_UPDATED in
// index.html), which stopped a set mid-song. Now the page offers a reload and never takes one:
// the DJ taps RELOAD when it suits, and while a deck plays the first tap only warns.

export const BANNER_ID = 'sw-ready-banner';

// playing: () => is a deck playing now; reload: () => reload the page.
export function swUpdatePrompt(doc, { playing = () => false, reload } = {}) {
    const old = doc.getElementById(BANNER_ID);
    if (old) return old;
    const banner = doc.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'sw-update-banner';
    const text = doc.createElement('span');
    text.textContent = playing() ? 'New version ready - reload after the set' : 'New version ready';
    const go = doc.createElement('button');
    go.textContent = 'RELOAD';
    const later = doc.createElement('button');
    later.textContent = 'LATER';
    let warned = false;
    go.addEventListener('click', () => {
        if (playing() && !warned) {
            warned = true;
            go.textContent = 'RELOAD STOPS THE MUSIC - TAP AGAIN';
            return;
        }
        reload();
    });
    later.addEventListener('click', () => banner.remove());
    banner.append(text, go, later);
    doc.body.appendChild(banner);
    banner.classList.add('show');
    return banner;
}
