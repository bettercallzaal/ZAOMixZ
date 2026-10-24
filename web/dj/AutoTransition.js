// AutoTransition.js — Automated crossfade transitions between decks
// Supports multiple transition types: blend, echo-out, cut, filter-sweep, stem-swap, mashup
// Uses equal-power (cos/sin) crossfade curve for smooth audio transitions
// Includes gradual BPM matching during transitions
// Driven by Clock.every, not requestAnimationFrame: a hidden tab stops animation frames, and a
// mix must keep going while the DJ is in another tab.

import { every } from './Clock.js';
import { airhorn } from './Airhorn.js';

export const TICK_MS = 20;

export class AutoTransition {
    constructor(audioRouter, mixer, decks) {
        this.router = audioRouter;
        this.mixer = mixer;
        this.decks = decks;
        this.running = false;
        this._stopTick = null;
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
        this._tickOff();
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
        // A mashup locked the tempo before the start: home is the rate the deck had before that
        this._originalTargetRate = this._mash ? this._mash.before : targetDeck.currentRate;

        // Initialize transition-type-specific effects
        this._initTransitionEffects();

        const btn = document.getElementById('auto-trans-btn');
        if (btn) { btn.textContent = 'CANCEL'; btn.classList.add('active'); }

        // Notify broadcast about transition start
        if (this.onTransitionStateChange) this.onTransitionStateChange(true, this.direction);

        this._tickOff();
        this._stopTick = every(TICK_MS, () => this._animate());
        this._animate();
    }

    _tickOff() {
        if (this._stopTick) { this._stopTick(); this._stopTick = null; }
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

            case 'mashup':
            case 'stem-swap':
                // EQ stems: the old song keeps its vocal (mids and highs) while its drums and bass
                // go; the new song comes in as drums and bass only, then its vocal takes over.
                this._stemBefore = {};
                for (const id of [sourceDeckId, targetDeckId]) this._stemBefore[id] = { low: this._bandEQ(id, 'low'), mid: this._bandEQ(id, 'mid'), high: this._bandEQ(id, 'high') };
                this.router.setEQ(targetDeckId, 'mid', -26);
                // The mashup holds back the new song's highs too, so only its drums and bass come in
                // under the old vocal: no second voice on top (IMan, 23 Oct).
                if (this.transitionType === 'mashup') this.router.setEQ(targetDeckId, 'high', -24);
                break;

            case 'blend':
            default:
                // The blend swaps the bass (source low cut to -24dB, target low set to 0).
                // Remember what each deck had so _cleanupEffects can put it back.
                this._eqBefore = { A: this._lowEQ('A'), B: this._lowEQ('B') };
                this._eqWrote = { A: null, B: null };
                this._eqHands = { A: false, B: false };
                break;
        }
    }

    _animate() {
        if (!this.running) { this._tickOff(); return; }

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
            case 'stem-swap':
                this._animateStemSwap(progress);
                break;
            case 'mashup':
                this._animateMashup(progress);
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
            this._blendEQ(sourceDeckId, bassKill);
            this._blendEQ(targetDeckId, 0);
        } else {
            // Last 40%: source bass fully cut, target bass normal
            this._blendEQ(sourceDeckId, -24);
            this._blendEQ(targetDeckId, 0);
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

    // Stem swap: 0 to 45%, the new song's drums and bass rise under the old song while the old
    // song's drums and bass drain away, so its vocal rides the new beat. 45 to 70%, the vocals
    // trade places. 70 to 100%, the old song fades out.
    _animateStemSwap(progress) {
        const sourceDeckId = this.direction === 'AtoB' ? 'A' : 'B';
        const targetDeckId = this.direction === 'AtoB' ? 'B' : 'A';
        const p1 = Math.min(1, progress / 0.45);
        const p2 = Math.max(0, Math.min(1, (progress - 0.45) / 0.25));
        const before = this._stemBefore || {};
        const lerp = (a, b, x) => a + (b - a) * x;
        // Old song: lows out by 45%, highs (the hats) half gone, mids (the vocal) out by 70%
        this.router.setEQ(sourceDeckId, 'low', lerp(before[sourceDeckId]?.low ?? 0, -26, p1));
        this.router.setEQ(sourceDeckId, 'high', lerp(before[sourceDeckId]?.high ?? 0, -10, p1));
        this.router.setEQ(sourceDeckId, 'mid', lerp(before[sourceDeckId]?.mid ?? 0, -26, p2));
        // New song: drums and bass from the start, its vocal comes up as the old one goes
        this.router.setEQ(targetDeckId, 'mid', lerp(-26, before[targetDeckId]?.mid ?? 0, p2));

        const sourceGain = progress < 0.7 ? 1 : Math.cos(((progress - 0.7) / 0.3) * Math.PI / 2);
        const targetGain = Math.sin(Math.min(1, progress / 0.35) * Math.PI / 2);
        const position = this.startPos + (this.endPos - this.startPos) * progress;
        const cf = document.getElementById('crossfader');
        if (cf) cf.value = Math.round(position * 100);
        this.router.channels[sourceDeckId].crossfadeGain.gain.value = sourceGain;
        this.router.channels[targetDeckId].crossfadeGain.gain.value = targetGain;
    }

    // Mashup (Dj Afrikah): the new beat comes in under the old song, the old drums and bass go,
    // and the old vocal rides the new beat for most of the move. Then the vocals trade and the
    // old song leaves.  0-8%: new beat up (its vocal held back). 8-16%: old drums and bass out.
    // 16-84%: the ride. 84-92%: vocals trade. 92-100%: the old song goes.
    _animateMashup(progress) {
        const src = this.direction === 'AtoB' ? 'A' : 'B';
        const dst = this.direction === 'AtoB' ? 'B' : 'A';
        const before = this._stemBefore || {};
        const lerp = (a, b, x) => a + (b - a) * Math.max(0, Math.min(1, x));
        const kill = (progress - 0.08) / 0.08;
        this.router.setEQ(src, 'low', lerp(before[src]?.low ?? 0, -30, kill));
        this.router.setEQ(src, 'high', lerp(before[src]?.high ?? 0, -14, kill));
        const trade = (progress - 0.84) / 0.08;
        this.router.setEQ(src, 'mid', lerp(before[src]?.mid ?? 0, -30, trade));
        this.router.setEQ(dst, 'mid', lerp(-26, before[dst]?.mid ?? 0, trade));
        this.router.setEQ(dst, 'high', lerp(-24, before[dst]?.high ?? 0, trade));
        const targetGain = Math.sin(Math.min(1, progress / 0.08) * Math.PI / 2);
        const sourceGain = progress < 0.92 ? 1 : Math.cos(((progress - 0.92) / 0.08) * Math.PI / 2);
        const cf = document.getElementById('crossfader');
        if (cf) cf.value = Math.round((this.startPos + (this.endPos - this.startPos) * Math.min(1, progress / 0.92)) * 100);
        this.router.channels[src].crossfadeGain.gain.value = sourceGain;
        this.router.channels[dst].crossfadeGain.gain.value = targetGain;
    }

    // Lines the new song's beat up with the old song's: finds where the old song is within its
    // beat (from the onsets of the last few seconds) and the new song's first beat after its start
    // point, then moves the new song so both beats land together at the locked tempo.
    _alignBeat(sourceDeck, targetDeck, sourceBPM, targetBPM, rate) {
        // Each side from its decoded audio when there is some, else from the beat measured ahead of
        // time (analysis.json "beat": where the first beat falls).
        const sBuf = sourceDeck.wavesurfer?.getDecodedData?.(), tBuf = targetDeck.wavesurfer?.getDecodedData?.();
        const sBeat = sourceDeck.metadata?.metadata?.beat, tBeat = targetDeck.metadata?.metadata?.beat;
        if ((!sBuf && sBeat == null) || (!tBuf && tBeat == null)) return;
        const t0 = performance.now();
        const HOP = 0.01;
        const onsets = (buf, from, to) => {
            const sr = buf.sampleRate, ch = buf.getChannelData(0), hop = Math.floor(sr * HOP);
            const a = Math.max(0, Math.floor(from * sr)), b = Math.min(ch.length, Math.floor(to * sr));
            const out = []; let prev = 0;
            for (let i = a; i + hop <= b; i += hop) { let e = 0; for (let j = i; j < i + hop; j += 4) e += ch[j] * ch[j]; out.push(Math.max(0, e - prev)); prev = e; }
            return out;
        };
        const at = (env, t) => { const k = Math.round(t / HOP); return k >= 0 && k < env.length ? env[k] : 0; };
        // Old song: seconds since its last beat
        const now = sourceDeck.getCurrentTime(), Ps = 60 / sourceBPM, span = 6;
        let phi = 0, best = -1;
        if (sBuf) {
            const sEnv = onsets(sBuf, now - span, now);
            for (let f = 0; f < Ps; f += 0.005) { let sc = 0; for (let k = 0; f + k * Ps < span; k++) sc += at(sEnv, span - f - k * Ps); if (sc > best) { best = sc; phi = f; } }
        } else phi = (((now - sBeat) % Ps) + Ps) % Ps;
        // New song: its first beat after the point it starts from
        const cue = targetDeck.getCurrentTime() || 0, Pt = 60 / targetBPM;
        let theta = 0; best = -1;
        if (tBuf) {
            const tEnv = onsets(tBuf, cue, cue + 8);
            for (let f = 0; f < Pt; f += 0.005) { let sc = 0; for (let k = 0; f + k * Pt < 8; k++) sc += at(tEnv, f + k * Pt); if (sc > best) { best = sc; theta = f; } }
        } else theta = (((tBeat - cue) % Pt) + Pt) % Pt;
        // The old song has moved on while this ran
        const elapsed = (performance.now() - t0) / 1000;
        const sincePhase = ((phi + elapsed) % Ps) / Ps;          // 0 to 1 through the old song's beat
        const seekTo = cue + theta + sincePhase * Pt;            // the same point in the new song's beat
        if (targetDeck.wavesurfer?.setTime) targetDeck.wavesurfer.setTime(seekTo);
        console.log(`[Mashup] beats lined up: new song from ${seekTo.toFixed(2)}s (old song ${(sincePhase * 100).toFixed(0)}% through its beat, ${rate.toFixed(3)}x)`);
    }

    // A deck's EQ band as the DJ set it (a killed band keeps its setting aside)
    _bandEQ(id, band) {
        const r = this.router;
        if (r._eqKillState?.[id]?.[band]) return r._eqSavedGain?.[id]?.[band] ?? 0;
        const key = `eq${band.charAt(0).toUpperCase() + band.slice(1)}`;
        const v = r.channels?.[id]?.[key]?.gain?.value;
        return Number.isFinite(v) ? v : 0;
    }

    // ===== BPM SYNC =====

    _animateBpmSync(progress) {
        if (this.transitionType === 'mashup') {
            if (!this._mash) return;
            const deck = this.direction === 'AtoB' ? this.decks.B : this.decks.A;
            const x = progress < 0.86 ? 0 : Math.min(1, (progress - 0.86) / 0.14);
            const e = x * x * (3 - 2 * x);
            deck.setPlaybackRate(this._mash.rate + (this._mash.before - this._mash.rate) * e);
            return;
        }
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
        this._tickOff();

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

        if (this._stemBefore) {
            // Both decks get back the EQ they had before the stem swap
            for (const [id, bands] of Object.entries(this._stemBefore)) for (const [band, db] of Object.entries(bands)) this.router.setEQ(id, band, db);
            this._stemBefore = null;
        }

        if (this._keyLockBefore) {
            for (const [id, was] of Object.entries(this._keyLockBefore)) { const m = this.decks[id]?.getMediaElement?.(); if (m) m.preservesPitch = was; }
            this._keyLockBefore = null;
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
            // A deck whose low knob the DJ moved during the blend keeps what the DJ set.
            for (const id of ['A', 'B']) if (!this._eqHands?.[id]) this.router.setEQ(id, 'low', this._eqBefore[id]);
            this._eqBefore = null;
            this._eqWrote = null;
            this._eqHands = null;
        }
    }

    // One step of the blend's bass swap. If the low EQ is no longer what the blend last wrote,
    // the DJ has moved the knob: from then on the blend leaves that deck's low EQ to them.
    _blendEQ(id, db) {
        if (!this._eqWrote) { this.router.setEQ(id, 'low', db); return; }
        if (this._eqHands[id]) return;
        // Compare with what the blend last wrote, or before its first write (the first 40%)
        // with what the deck had when the blend began
        const last = this._eqWrote[id] ?? this._eqBefore?.[id] ?? null;
        if (last !== null && Math.abs(this._lowEQ(id) - last) > 0.01) { this._eqHands[id] = true; return; }
        this.router.setEQ(id, 'low', db);
        this._eqWrote[id] = db;
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

        // Tempo ride: the new song starts at the old song's tempo and eases back to its own
        // (the BPM sync below does the riding). Key lock keeps it from sounding sped up.
        if (options.tempoRide) {
            const m = targetDeck.getMediaElement?.();
            if (m) { this._keyLockBefore = { [targetDeck.id]: m.preservesPitch }; m.preservesPitch = true; }
        }

        // Mashup: the new song runs at the old one's tempo with key lock on, and starts with its
        // beat lined up on the old song's beat, so the old vocal rides the new beat on time.
        this._mash = null;
        if (options.type === 'mashup') {
            const sourceDeck = direction === 'AtoB' ? this.decks.A : this.decks.B;
            const sb = Number(options.sourceBPM) || 0, tb = Number(options.targetBPM) || 0;
            const m = targetDeck.getMediaElement?.();
            if (m && !this._keyLockBefore) { this._keyLockBefore = { [targetDeck.id]: m.preservesPitch }; m.preservesPitch = true; }
            const before = targetDeck.currentRate || 1;
            const lock = sb && tb && sb / tb > 0.84 && sb / tb < 1.19 ? sb / tb : 0;
            if (lock) targetDeck.setPlaybackRate(lock);
            this._mash = { rate: lock || before, before };
            // The new song's audio may still be decoding as it starts: line the beats up as soon as
            // it is there (within 3 seconds, while the new beat is still fading in), else skip it.
            if (sb && tb) {
                let tries = 0;
                const tryAlign = () => {
                    if (!this.running && tries > 0) return;
                    const ready = (d) => d.wavesurfer?.getDecodedData?.() || d.metadata?.metadata?.beat != null;
                    if (ready(sourceDeck) && ready(targetDeck)) {
                        try { this._alignBeat(sourceDeck, targetDeck, sb, tb, lock || 1); } catch (e) { console.warn('[Mashup] beat align skipped:', e.message); }
                    } else if (++tries < 30) setTimeout(tryAlign, 100);
                    else console.warn('[Mashup] beat align skipped: audio not decoded in time');
                };
                setTimeout(tryAlign, 0);
            }
        }

        // Party: the air horn goes off as the new song lands
        if (options.airhorn) {
            const ctx = this.router.getAudioContext?.() || this.router.ctx;
            const style = options.airhorn === 'double' ? 'double' : 'classic';
            const fx = this._getDJPlayer()?.partyFX;
            setTimeout(() => { try { if (fx) fx.horn(style); else airhorn(ctx, this.router.masterGain, { style }); } catch (e) { /* no horn, the mix goes on */ } }, Math.max(0, (duration || this.duration) * 0.35 * 1000));
        }
        if (targetDeck.isLoaded && !targetDeck.isPlaying) {
            this.router.resume();
            targetDeck.play();
        }

        this._startTransition();
    }
}
