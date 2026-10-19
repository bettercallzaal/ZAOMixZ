// AutoTransition.js — Automated crossfade transitions between decks
// Supports multiple transition types: blend, echo-out, cut, filter-sweep
// Uses equal-power (cos/sin) crossfade curve for smooth audio transitions
// Includes gradual BPM matching during transitions

export class AutoTransition {
    constructor(audioRouter, mixer, decks) {
        this.router = audioRouter;
        this.mixer = mixer;
        this.decks = decks;
        this.running = false;
        this.animFrame = null;
        this.startTime = 0;
        this.duration = 8; // seconds
        this.direction = 'AtoB'; // AtoB or BtoA
        this.onComplete = null; // callback when transition finishes
        this.onCancel = null; // callback when a transition is cancelled before it finishes

        // Transition type: blend, echo-out, cut, filter-sweep
        this.transitionType = 'blend';

        // BPM sync during transition
        this._bpmSyncEnabled = true;
        this._sourceBPM = null;
        this._targetBPM = null;
        this._originalTargetRate = null;

        // Echo-out state
        this._echoCleanupNeeded = false;

        // Filter-sweep state
        this._filterSweepCleanupNeeded = false;

        // Blend state: the low EQ each deck had before the bass swap, put back afterwards
        this._eqBefore = null;

        this._initUI();
    }

    _initUI() {
        const transBtn = document.getElementById('auto-trans-btn');
        const durSelect = document.getElementById('auto-trans-duration');
        const typeSelect = document.getElementById('auto-trans-type');

        if (transBtn) {
            transBtn.addEventListener('click', () => {
                if (this.running) {
                    this.cancel();
                } else {
                    this.start();
                }
            });
        }

        if (durSelect) {
            durSelect.addEventListener('change', (e) => {
                this.duration = parseFloat(e.target.value);
            });
        }

        if (typeSelect) {
            typeSelect.addEventListener('change', (e) => {
                this.transitionType = e.target.value;
            });
        }
    }

    start() {
        if (this.running) return;

        const cf = document.getElementById('crossfader');
        const currentPos = cf ? parseInt(cf.value) / 100 : 0.5;

        // Determine direction from current position
        this.direction = currentPos <= 0.5 ? 'AtoB' : 'BtoA';
        this.startPos = currentPos;
        this.endPos = this.direction === 'AtoB' ? 1.0 : 0.0;

        // Get BPM info for sync
        const sourceDeck = this.direction === 'AtoB' ? this.decks.A : this.decks.B;
        const targetDeck = this.direction === 'AtoB' ? this.decks.B : this.decks.A;
        this._sourceBPM = sourceDeck.getBPM();
        this._targetBPM = targetDeck.getBPM();

        // Auto-play the target deck if not playing
        if (targetDeck.isLoaded && !targetDeck.isPlaying) {
            this.router.resume();
            targetDeck.play();
        }

        this._startTransition();
    }

    cancel() {
        this.running = false;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        this._cleanupEffects();
        const btn = document.getElementById('auto-trans-btn');
        if (btn) { btn.textContent = 'AUTO'; btn.classList.remove('active'); }
        // Notify broadcast about transition cancel
        if (this.onTransitionStateChange) this.onTransitionStateChange(false, this.direction);
        // FlowMode waits for onComplete; tell it this mix will not finish
        if (this.onCancel) this.onCancel(this.direction);
    }

    _startTransition() {
        this.running = true;
        this.startTime = performance.now();

        // Store original target deck rate for BPM sync restoration
        const targetDeck = this.direction === 'AtoB' ? this.decks.B : this.decks.A;
        this._originalTargetRate = targetDeck.currentRate;

        // Initialize transition-type-specific effects
        this._initTransitionEffects();

        const btn = document.getElementById('auto-trans-btn');
        if (btn) { btn.textContent = 'CANCEL'; btn.classList.add('active'); }

        // Notify broadcast about transition start
        if (this.onTransitionStateChange) this.onTransitionStateChange(true, this.direction);

        this._animate();
    }

    _initTransitionEffects() {
        const sourceDeckId = this.direction === 'AtoB' ? 'A' : 'B';
        const targetDeckId = this.direction === 'AtoB' ? 'B' : 'A';

        switch (this.transitionType) {
            case 'echo-out':
                // Enable echo/delay on source deck's FX send if FX module is available
                this._echoCleanupNeeded = true;
                break;

            case 'filter-sweep':
                // Will sweep source deck's filter from open to closed
                // and target deck's filter from closed to open
                this._filterSweepCleanupNeeded = true;
                // Start target deck with filter closed (low-pass at low freq)
                this.router.setFilter(targetDeckId, 0.0);
                break;

            case 'cut':
                // No init needed — instantaneous switch
                break;

            case 'blend':
            default:
                // The blend swaps the bass (source low cut to -24dB, target low set to 0).
                // Remember what each deck had so _cleanupEffects can put it back.
                this._eqBefore = { A: this._lowEQ('A'), B: this._lowEQ('B') };
                break;
        }
    }

    _animate() {
        if (!this.running) return;

        const elapsed = (performance.now() - this.startTime) / 1000;
        const progress = Math.min(1, elapsed / this.duration);

        // Apply the transition based on type
        switch (this.transitionType) {
            case 'blend':
                this._animateBlend(progress);
                break;
            case 'echo-out':
                this._animateEchoOut(progress);
                break;
            case 'cut':
                this._animateCut(progress);
                break;
            case 'filter-sweep':
                this._animateFilterSweep(progress);
                break;
            default:
                this._animateBlend(progress);
                break;
        }

        // Gradual BPM sync during transition
        if (this._bpmSyncEnabled) {
            this._animateBpmSync(progress);
        }

        if (progress >= 1) {
            this._finishTransition();
            return;
        }

        this.animFrame = requestAnimationFrame(() => this._animate());
    }

    // ===== TRANSITION TYPES =====

    // Blend (crossfade) — equal-power cosine/sine curve
    _animateBlend(progress) {
        // Equal-power crossfade: use cos/sin for smooth volume transition
        // This ensures the total perceived loudness stays constant during the fade
        const angle = progress * Math.PI / 2; // 0 to pi/2
        let fadeOut, fadeIn;

        if (this.direction === 'AtoB') {
            fadeOut = Math.cos(angle); // A fades from 1 to 0
            fadeIn = Math.sin(angle);  // B fades from 0 to 1
        } else {
            fadeIn = Math.sin(angle);  // A fades from 0 to 1
            fadeOut = Math.cos(angle); // B fades from 1 to 0
        }

        // Map to crossfader position (0 = full A, 1 = full B)
        // For equal-power, we directly set the crossfade gains instead of
        // going through setCrossfade (which has its own curve), so we get
        // a true equal-power blend regardless of the global crossfader curve setting
        const position = this.startPos + (this.endPos - this.startPos) * progress;

        // Set crossfader UI position (linear for visual representation)
        const cfValue = Math.round(position * 100);
        const cf = document.getElementById('crossfader');
        if (cf) cf.value = cfValue;

        // Apply equal-power gains directly to crossfade gain nodes
        const sourceDeckId = this.direction === 'AtoB' ? 'A' : 'B';
        const targetDeckId = this.direction === 'AtoB' ? 'B' : 'A';

        if (this.direction === 'AtoB') {
            this.router.channels.A.crossfadeGain.gain.value = fadeOut;
            this.router.channels.B.crossfadeGain.gain.value = fadeIn;
        } else {
            this.router.channels.A.crossfadeGain.gain.value = fadeIn;
            this.router.channels.B.crossfadeGain.gain.value = fadeOut;
        }

        // EQ-swap: Cut bass on source at midpoint, bring in bass on target
        // This prevents the muddy "double bass" problem during beatmatched transitions
        if (progress < 0.4) {
            // First 40%: both tracks play with full bass
        } else if (progress < 0.6) {
            // Middle 20%: swap the bass — cut source lows, keep target lows
            const swapProgress = (progress - 0.4) / 0.2; // 0 to 1 within this window
            const bassKill = -24 * swapProgress; // 0 to -24dB
            this.router.setEQ(sourceDeckId, 'low', bassKill);
            this.router.setEQ(targetDeckId, 'low', 0);
        } else {
            // Last 40%: source bass fully cut, target bass normal
            this.router.setEQ(sourceDeckId, 'low', -24);
            this.router.setEQ(targetDeckId, 'low', 0);
        }
    }

    // Echo-out: Source deck fades out with echo tail, target fades in cleanly
    _animateEchoOut(progress) {
        const angle = progress * Math.PI / 2;
        let sourceGain, targetGain;

        // Equal-power for the target fade-in
        targetGain = Math.sin(angle);

        // Source: faster fade-out (done by 70%), echo tail carries the rest
        if (progress < 0.7) {
            sourceGain = Math.cos((progress / 0.7) * Math.PI / 2);
        } else {
            sourceGain = 0;
        }

        // Apply echo/delay to source deck's channel (increase feedback over time)
        const sourceDeckId = this.direction === 'AtoB' ? 'A' : 'B';
        const targetDeckId = this.direction === 'AtoB' ? 'B' : 'A';

        // Increase echo wet amount as the source fades
        // Access FX module if available through the router's parent player
        const djPlayer = this._getDJPlayer();
        if (djPlayer && djPlayer.fx) {
            const fxDeck = djPlayer.fx.decks?.[sourceDeckId];
            if (fxDeck) {
                // Ramp up the wet/dry mix
                const wetAmount = Math.min(1, progress * 1.5);
                fxDeck.wet.gain.value = wetAmount * 0.8;
                fxDeck.dry.gain.value = 1 - wetAmount * 0.5;

                // Increase echo feedback as we fade
                const activeEffect = fxDeck.effects[fxDeck.activeEffect];
                if (activeEffect && activeEffect.feedback) {
                    activeEffect.feedback.gain.value = Math.min(0.85, 0.4 + progress * 0.45);
                }
            }
        }

        // Update crossfader UI
        const position = this.startPos + (this.endPos - this.startPos) * progress;
        const cfValue = Math.round(position * 100);
        const cf = document.getElementById('crossfader');
        if (cf) cf.value = cfValue;

        // Apply gains
        if (this.direction === 'AtoB') {
            this.router.channels.A.crossfadeGain.gain.value = sourceGain;
            this.router.channels.B.crossfadeGain.gain.value = targetGain;
        } else {
            this.router.channels.A.crossfadeGain.gain.value = targetGain;
            this.router.channels.B.crossfadeGain.gain.value = sourceGain;
        }
    }

    // Cut: instant switch at the specified point
    _animateCut(progress) {
        // Hold source until 95%, then instant switch
        if (progress < 0.95) {
            // Keep source at full, target silent but playing (for sync)
            const position = this.startPos + (this.endPos - this.startPos) * 0.05 * (progress / 0.95);
            const cfValue = Math.round(position * 100);
            const cf = document.getElementById('crossfader');
            if (cf) cf.value = cfValue;

            if (this.direction === 'AtoB') {
                this.router.channels.A.crossfadeGain.gain.value = 1;
                this.router.channels.B.crossfadeGain.gain.value = 0;
            } else {
                this.router.channels.A.crossfadeGain.gain.value = 0;
                this.router.channels.B.crossfadeGain.gain.value = 1;
            }
        } else {
            // Instant switch
            const cf = document.getElementById('crossfader');
            if (cf) cf.value = Math.round(this.endPos * 100);

            if (this.direction === 'AtoB') {
                this.router.channels.A.crossfadeGain.gain.value = 0;
                this.router.channels.B.crossfadeGain.gain.value = 1;
            } else {
                this.router.channels.A.crossfadeGain.gain.value = 1;
                this.router.channels.B.crossfadeGain.gain.value = 0;
            }
        }
    }

    // Filter sweep: source sweeps to low-pass (bass only), target sweeps from low-pass to open
    _animateFilterSweep(progress) {
        const sourceDeckId = this.direction === 'AtoB' ? 'A' : 'B';
        const targetDeckId = this.direction === 'AtoB' ? 'B' : 'A';

        // Source: sweep filter from open (0.5) to full low-pass (0.0)
        // This gradually removes highs from the outgoing track
        const sourceFilterPos = 0.5 * (1 - progress); // 0.5 -> 0.0
        this.router.setFilter(sourceDeckId, sourceFilterPos);

        // Target: sweep filter from full low-pass (0.0) to open (0.5)
        // This gradually brings in highs of the incoming track
        const targetFilterPos = 0.5 * progress; // 0.0 -> 0.5
        this.router.setFilter(targetDeckId, targetFilterPos);

        // Also do an equal-power crossfade underneath the filter sweep
        const angle = progress * Math.PI / 2;
        const fadeOut = Math.cos(angle);
        const fadeIn = Math.sin(angle);

        // Update crossfader UI
        const position = this.startPos + (this.endPos - this.startPos) * progress;
        const cfValue = Math.round(position * 100);
        const cf = document.getElementById('crossfader');
        if (cf) cf.value = cfValue;

        if (this.direction === 'AtoB') {
            this.router.channels.A.crossfadeGain.gain.value = fadeOut;
            this.router.channels.B.crossfadeGain.gain.value = fadeIn;
        } else {
            this.router.channels.A.crossfadeGain.gain.value = fadeIn;
            this.router.channels.B.crossfadeGain.gain.value = fadeOut;
        }
    }

    // ===== BPM SYNC =====

    _animateBpmSync(progress) {
        if (!this._sourceBPM || !this._targetBPM) return;
        if (this._sourceBPM === this._targetBPM) return;

        const targetDeck = this.direction === 'AtoB' ? this.decks.B : this.decks.A;

        // During the first 80% of the transition, gradually adjust the incoming
        // track's playback rate from the source BPM to its natural BPM
        // This creates a smooth tempo transition that listeners perceive as natural
        if (progress < 0.8) {
            const syncProgress = progress / 0.8; // normalize to 0-1 within the sync window

            // Use an ease-in-out curve for smoother tempo change
            const eased = syncProgress * syncProgress * (3 - 2 * syncProgress);

            // Start at source BPM, end at target BPM
            const currentBPM = this._sourceBPM + (this._targetBPM - this._sourceBPM) * eased;
            const rate = currentBPM / this._targetBPM;

            // Only sync if the rate change is within reasonable bounds (50%-200%)
            if (rate >= 0.5 && rate <= 2.0) {
                targetDeck.setPlaybackRate(rate);
            }
        } else {
            // Final 20%: snap to natural BPM
            if (this._originalTargetRate) {
                targetDeck.setPlaybackRate(this._originalTargetRate);
            } else {
                targetDeck.setPlaybackRate(1.0);
            }
        }
    }

    // ===== TRANSITION COMPLETION =====

    _finishTransition() {
        this.running = false;

        // Stop the source deck
        const sourceDeck = this.direction === 'AtoB' ? this.decks.A : this.decks.B;
        if (sourceDeck.isPlaying) sourceDeck.pause();

        // Restore target deck to its natural rate
        const targetDeck = this.direction === 'AtoB' ? this.decks.B : this.decks.A;
        if (this._originalTargetRate) {
            targetDeck.setPlaybackRate(this._originalTargetRate);
        }

        // Cleanup transition-specific effects
        this._cleanupEffects();

        // Ensure final crossfader position is correct
        const cf = document.getElementById('crossfader');
        if (cf) cf.value = Math.round(this.endPos * 100);
        this.router.setCrossfade(this.endPos);

        const btn = document.getElementById('auto-trans-btn');
        if (btn) { btn.textContent = 'AUTO'; btn.classList.remove('active'); }

        // Reset BPM sync state
        this._sourceBPM = null;
        this._targetBPM = null;
        this._originalTargetRate = null;

        // Notify broadcast about transition end
        if (this.onTransitionStateChange) this.onTransitionStateChange(false, this.direction);

        if (this.onComplete) this.onComplete(this.direction);
    }

    _cleanupEffects() {
        if (this._echoCleanupNeeded) {
            // Reset FX wet/dry and feedback to defaults
            const djPlayer = this._getDJPlayer();
            if (djPlayer && djPlayer.fx && djPlayer.fx.decks) {
                Object.values(djPlayer.fx.decks).forEach(fxDeck => {
                    if (fxDeck) {
                        fxDeck.wet.gain.value = 0;
                        fxDeck.dry.gain.value = 1;
                        const activeEffect = fxDeck.effects[fxDeck.activeEffect];
                        if (activeEffect && activeEffect.feedback) {
                            activeEffect.feedback.gain.value = 0.4;
                        }
                    }
                });
            }
            this._echoCleanupNeeded = false;
        }

        if (this._filterSweepCleanupNeeded) {
            // Reset both deck filters to center (bypass)
            this.router.setFilter('A', 0.5);
            this.router.setFilter('B', 0.5);
            this._filterSweepCleanupNeeded = false;
        }

        if (this._eqBefore) {
            // Undo the bass swap: the deck that went out kept a -24dB low cut, and the one
            // coming in lost the DJ's own low setting. Both get back what they had.
            for (const id of ['A', 'B']) this.router.setEQ(id, 'low', this._eqBefore[id]);
            this._eqBefore = null;
        }
    }

    // A deck's low EQ as the DJ set it (a killed band keeps its setting aside)
    _lowEQ(id) {
        const r = this.router;
        if (r._eqKillState?.[id]?.low) return r._eqSavedGain?.[id]?.low ?? 0;
        const v = r.channels?.[id]?.eqLow?.gain?.value;
        return Number.isFinite(v) ? v : 0;
    }

    // Helper to get the DJPlayer instance (parent of router)
    _getDJPlayer() {
        return window._djPlayer || null;
    }

    // Programmatic start (called by FlowMode)
    startProgrammatic(direction, duration, options = {}) {
        if (this.running) return;

        this.direction = direction;
        this.duration = duration || this.duration;
        this.startPos = direction === 'AtoB' ? 0.0 : 1.0;
        this.endPos = direction === 'AtoB' ? 1.0 : 0.0;

        // Accept transition type and BPM info from FlowMode
        if (options.type) {
            this.transitionType = options.type;
        }
        if (options.sourceBPM) this._sourceBPM = options.sourceBPM;
        if (options.targetBPM) this._targetBPM = options.targetBPM;

        // Auto-play the target deck if not playing
        const targetDeck = direction === 'AtoB' ? this.decks.B : this.decks.A;
        if (targetDeck.isLoaded && !targetDeck.isPlaying) {
            this.router.resume();
            targetDeck.play();
        }

        this._startTransition();
    }
}
