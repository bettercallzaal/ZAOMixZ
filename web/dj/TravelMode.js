// TravelMode.js — Touch-optimized travel/mobile DJ mode
// Screen wake lock, orientation lock, battery saver, crossfader gestures,
// pinch-to-zoom waveform, offline audio caching UI

import { esc } from './Html.js';
export class TravelMode {
    constructor(djPlayer) {
        this.dj = djPlayer;
        this.enabled = false;
        this.wakeLock = null;
        this.batterySaver = false;
        this._originalVizFPS = 60;
        this._touchState = {};
        this._crossfaderGesture = null;

        this._initTravelButton();
        this._initTouchAudioResume();
        this._initCrossfaderSwipe();
        this._initWaveformPinch();
        this._initPreventAccidentalScroll();
        this._initOfflineAudioUI();
        this._checkURLMode();
    }

    // ============ Toggle travel mode ============

    toggle() {
        this.enabled = !this.enabled;
        document.body.classList.toggle('travel-mode', this.enabled);

        const btn = document.getElementById('travel-mode-btn');
        if (btn) btn.classList.toggle('active', this.enabled);

        if (this.enabled) {
            this._acquireWakeLock();
            this._lockOrientation();
            this._enableBatterySaver();
            // Force simple mode (hide pro controls)
            if (document.body.classList.contains('pro-mode')) {
                document.getElementById('pro-mode-toggle')?.click();
            }
        } else {
            this._releaseWakeLock();
            this._disableBatterySaver();
        }

        // Save preference
        localStorage.setItem('aurdour-travel-mode', this.enabled ? '1' : '0');
    }

    // ============ Wake Lock — prevent screen sleep ============

    async _acquireWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            this.wakeLock.addEventListener('release', () => {
                console.log('[TravelMode] Wake lock released');
                // Re-acquire if still in travel mode
                if (this.enabled && document.visibilityState === 'visible') {
                    this._acquireWakeLock();
                }
            });
            console.log('[TravelMode] Wake lock acquired');
        } catch (e) {
            console.warn('[TravelMode] Wake lock failed:', e);
        }
    }

    _releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release();
            this.wakeLock = null;
        }
    }

    // Re-acquire wake lock when page becomes visible again
    _initVisibilityHandler() {
        document.addEventListener('visibilitychange', () => {
            if (this.enabled && document.visibilityState === 'visible') {
                this._acquireWakeLock();
            }
        });
    }

    // ============ Orientation lock ============

    _lockOrientation() {
        try {
            if (screen.orientation?.lock) {
                screen.orientation.lock('landscape').catch(() => {
                    // Silently fail — not all browsers support this
                });
            }
        } catch (e) {
            // Ignore
        }
    }

    // ============ Battery saver mode ============

    _enableBatterySaver() {
        this.batterySaver = true;
        document.body.classList.add('battery-saver');

        // Reduce visualizer FPS
        if (this.dj.visualizer) {
            this._originalVizFPS = this.dj.visualizer.targetFPS || 60;
            this.dj.visualizer.targetFPS = 15;
        }

        // Reduce perf monitor frequency
        if (this.dj.perfMonitor) {
            this.dj.perfMonitor._interval = 5000;
        }

        // Check battery level
        this._monitorBattery();
    }

    _disableBatterySaver() {
        this.batterySaver = false;
        document.body.classList.remove('battery-saver');

        if (this.dj.visualizer) {
            this.dj.visualizer.targetFPS = this._originalVizFPS;
        }
        if (this.dj.perfMonitor) {
            this.dj.perfMonitor._interval = 1000;
        }
    }

    async _monitorBattery() {
        if (!navigator.getBattery) return;
        try {
            const battery = await navigator.getBattery();
            const updateBatteryUI = () => {
                const indicator = document.getElementById('travel-battery');
                if (indicator) {
                    const pct = Math.round(battery.level * 100);
                    indicator.textContent = `${pct}%`;
                    indicator.className = 'travel-battery';
                    if (pct <= 15) indicator.classList.add('battery-critical');
                    else if (pct <= 30) indicator.classList.add('battery-low');
                    indicator.style.display = this.enabled ? '' : 'none';
                }
            };
            battery.addEventListener('levelchange', updateBatteryUI);
            battery.addEventListener('chargingchange', updateBatteryUI);
            updateBatteryUI();
        } catch (e) {
            // Battery API not available
        }
    }

    // ============ Touch-to-resume AudioContext ============

    _initTouchAudioResume() {
        const resumeAudio = () => {
            if (this.dj.audioRouter) {
                this.dj.audioRouter.resume();
            }
        };
        document.addEventListener('touchstart', resumeAudio, { once: false, passive: true });
        document.addEventListener('touchend', resumeAudio, { once: false, passive: true });
    }

    // ============ Crossfader swipe gesture ============

    _initCrossfaderSwipe() {
        const xfSection = document.querySelector('.crossfader-section');
        if (!xfSection) return;

        let startX = 0;
        let startVal = 50;

        xfSection.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            startX = touch.clientX;
            const cf = document.getElementById('crossfader');
            startVal = cf ? parseFloat(cf.value) : 50;
            this._crossfaderGesture = true;
        }, { passive: true });

        xfSection.addEventListener('touchmove', (e) => {
            if (!this._crossfaderGesture) return;
            const touch = e.touches[0];
            const deltaX = touch.clientX - startX;
            const sectionWidth = xfSection.offsetWidth || 200;
            const deltaVal = (deltaX / sectionWidth) * 100;
            const newVal = Math.max(0, Math.min(100, startVal + deltaVal));

            const cf = document.getElementById('crossfader');
            if (cf) {
                cf.value = newVal;
                cf.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, { passive: true });

        xfSection.addEventListener('touchend', () => {
            this._crossfaderGesture = false;
        }, { passive: true });
    }

    // ============ Pinch-to-zoom waveform ============

    _initWaveformPinch() {
        document.querySelectorAll('.waveform-main').forEach(waveform => {
            let initialDistance = 0;
            let initialZoom = 1;

            waveform.addEventListener('touchstart', (e) => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    initialDistance = this._getTouchDistance(e.touches);
                    initialZoom = parseFloat(waveform.dataset.zoom || '1');
                }
            }, { passive: false });

            waveform.addEventListener('touchmove', (e) => {
                if (e.touches.length === 2) {
                    e.preventDefault();
                    const currentDistance = this._getTouchDistance(e.touches);
                    const scale = currentDistance / initialDistance;
                    const newZoom = Math.max(0.5, Math.min(5, initialZoom * scale));
                    waveform.dataset.zoom = newZoom;
                    waveform.style.transform = `scaleX(${newZoom})`;
                    waveform.style.transformOrigin = 'center center';
                }
            }, { passive: false });

            waveform.addEventListener('touchend', (e) => {
                if (e.touches.length < 2) {
                    // Snap back smoothly
                    const currentZoom = parseFloat(waveform.dataset.zoom || '1');
                    if (Math.abs(currentZoom - 1) < 0.15) {
                        waveform.style.transition = 'transform 0.2s ease';
                        waveform.style.transform = 'scaleX(1)';
                        waveform.dataset.zoom = '1';
                        setTimeout(() => { waveform.style.transition = ''; }, 200);
                    }
                }
            }, { passive: true });
        });
    }

    _getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ============ Prevent accidental scroll on DJ controls ============

    _initPreventAccidentalScroll() {
        const controlSelectors = [
            '.transport-controls',
            '.jog-section',
            '.crossfader-section',
            '.mixer',
            '.eq-section',
            '.fx-section',
            '.vol-fader',
            '.pitch-fader',
            '.jog-wheel',
        ];

        controlSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                el.addEventListener('touchmove', (e) => {
                    // Only prevent if it's a single-finger touch on a control
                    if (e.touches.length === 1) {
                        e.preventDefault();
                    }
                }, { passive: false });
            });
        });
    }

    // ============ Touch jog wheel ============

    initTouchJogWheel() {
        document.querySelectorAll('.jog-wheel').forEach(canvas => {
            let lastAngle = null;
            let rotating = false;

            const getAngle = (touch) => {
                const rect = canvas.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                return Math.atan2(touch.clientY - cy, touch.clientX - cx);
            };

            canvas.addEventListener('touchstart', (e) => {
                e.preventDefault();
                rotating = true;
                lastAngle = getAngle(e.touches[0]);
            }, { passive: false });

            canvas.addEventListener('touchmove', (e) => {
                if (!rotating) return;
                e.preventDefault();
                const angle = getAngle(e.touches[0]);
                if (lastAngle !== null) {
                    let delta = angle - lastAngle;
                    // Normalize to -PI..PI
                    if (delta > Math.PI) delta -= 2 * Math.PI;
                    if (delta < -Math.PI) delta += 2 * Math.PI;

                    // Map rotation to seek — positive = forward
                    const deckId = canvas.id.includes('-a') ? 'A' : 'B';
                    const deck = this.dj.decks[deckId];
                    if (deck && deck.isLoaded) {
                        const seekAmount = delta * 0.5; // seconds per radian
                        const newTime = Math.max(0, Math.min(deck.getDuration(), deck.getCurrentTime() + seekAmount));
                        const dur = deck.getDuration();
                        if (dur > 0) deck.wavesurfer.seekTo(newTime / dur);
                    }
                }
                lastAngle = angle;
            }, { passive: false });

            canvas.addEventListener('touchend', () => {
                rotating = false;
                lastAngle = null;
            }, { passive: true });
        });
    }

    // ============ Offline audio caching UI ============

    _initOfflineAudioUI() {
        // Listen for SW messages about cached audio
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.addEventListener('message', (e) => {
                if (e.data.type === 'AUDIO_CACHED') {
                    this._showToast(
                        e.data.success
                            ? `Track saved for offline`
                            : `Failed to cache track: ${e.data.error}`,
                        e.data.success ? 'success' : 'error'
                    );
                }
                if (e.data.type === 'CACHED_AUDIO_LIST') {
                    this._renderOfflineList(e.data.tracks);
                }
            });
        }
    }

    // Save a track for offline playback
    async cacheTrackForOffline(trackUrl, metadata) {
        try {
            const response = await fetch(trackUrl);
            const blob = await response.blob();

            const trackData = {
                id: metadata.id || trackUrl.split('/').pop().replace(/\.[^.]+$/, ''),
                title: metadata.title || 'Unknown',
                artist: metadata.artist || '',
                duration: metadata.duration || 0,
                mimeType: blob.type || 'audio/mpeg',
                audioBlob: blob,
            };

            if (navigator.serviceWorker?.controller) {
                navigator.serviceWorker.controller.postMessage({
                    type: 'CACHE_AUDIO',
                    data: trackData,
                });
            }
        } catch (e) {
            console.warn('[TravelMode] Failed to cache audio:', e);
            this._showToast('Failed to download track for offline', 'error');
        }
    }

    // Request list of cached tracks
    listOfflineTracks() {
        if (navigator.serviceWorker?.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'LIST_CACHED_AUDIO' });
        }
    }

    _renderOfflineList(tracks) {
        const container = document.getElementById('travel-offline-list');
        if (!container) return;

        if (tracks.length === 0) {
            container.innerHTML = '<div class="travel-offline-empty">No tracks saved offline yet. Tap the download icon on any track to save it.</div>';
            return;
        }

        container.innerHTML = tracks.map(t => `
            <div class="travel-offline-item" data-id="${esc(t.id)}">
                <div class="travel-offline-info">
                    <span class="travel-offline-title">${esc(t.title)}</span>
                    <span class="travel-offline-artist">${esc(t.artist)}</span>
                </div>
                <span class="travel-offline-size">${(t.size / 1024 / 1024).toFixed(1)} MB</span>
                <button class="btn-mini travel-offline-remove" data-id="${esc(t.id)}" title="Remove from offline">X</button>
            </div>
        `).join('');

        container.querySelectorAll('.travel-offline-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                if (navigator.serviceWorker?.controller) {
                    navigator.serviceWorker.controller.postMessage({
                        type: 'REMOVE_CACHED_AUDIO',
                        data: { trackId: id },
                    });
                    btn.closest('.travel-offline-item')?.remove();
                }
            });
        });
    }

    // ============ Travel mode button in toolbar ============

    _initTravelButton() {
        // The button is added in HTML; wire it up
        const btn = document.getElementById('travel-mode-btn');
        if (btn) {
            btn.addEventListener('click', () => this.toggle());
        }

        // Auto-enable on mobile/tablet
        if (this._isMobileOrTablet()) {
            // Show the travel button prominently
            btn?.classList.add('travel-suggested');
        }

        // Restore saved state
        if (localStorage.getItem('aurdour-travel-mode') === '1') {
            // Delay to let DOM settle
            setTimeout(() => this.toggle(), 500);
        }

        // Init visibility handler for wake lock
        this._initVisibilityHandler();

        // Init touch jog wheels
        setTimeout(() => this.initTouchJogWheel(), 1000);
    }

    _checkURLMode() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('mode') === 'travel' && !this.enabled) {
            setTimeout(() => this.toggle(), 800);
        }
    }

    _isMobileOrTablet() {
        return (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
            (window.innerWidth <= 1024)
        );
    }

    _showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `sync-toast sync-toast-${type} show`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400);
        }, 3000);
    }
}
