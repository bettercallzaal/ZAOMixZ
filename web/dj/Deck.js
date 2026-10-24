// Deck.js — Single deck: WaveSurfer instance, hot cues, loops, transport, stems
import { cleanTitle } from './NowPlaying.js';
import { resolveAudio } from './MusicSource.js';
import { canPlay, licenceLine } from './Licence.js';

export class Deck {
    constructor(id, waveformId, overviewId, options = {}) {
        this.id = id; // 'A' or 'B'
        this.metadata = null;
        this.hotCues = new Array(8).fill(null);
        this.cuePoint = 0;
        this.isPlaying = false;
        this.isLoaded = false;
        this.wavesurfer = null;
        this.onReady = options.onReady || null;
        this.onTimeUpdate = options.onTimeUpdate || null;
        this.onTrackNearEnd = options.onTrackNearEnd || null;
        this.onFinish = options.onFinish || null;
        this._nearEndFired = false;
        this.nearEndThreshold = options.nearEndThreshold || 30; // configurable seconds before end

        // Loop state
        this.loop = { active: false, inPoint: null, outPoint: null, region: null };
        this.autoLoopBeats = null;

        // Slip mode
        this.slipMode = false;
        this.slipPosition = 0;
        this.slipTimer = null;

        // Pitch / key lock
        this.pitchRange = 8; // ±8%
        this.keyLock = true;
        this.currentRate = 1.0;

        // Beatgrid
        this.quantize = false;
        this.beatPositions = [];

        // RGB waveform
        this.rgbMode = false;

        this._initWaveSurfer(waveformId, overviewId);
    }

    _initWaveSurfer(waveformId, overviewId) {
        const colorMap = {
            A: { wave: ['#003388', '#0066ff', '#00d4ff'], progress: ['#004499', '#0088ff', '#44eeff'] },
            B: { wave: ['#882200', '#ff3300', '#ff6b35'], progress: ['#993300', '#ff4400', '#ff8844'] },
            C: { wave: ['#005533', '#00bb55', '#00ff88'], progress: ['#006644', '#00cc66', '#44ffaa'] },
            D: { wave: ['#552288', '#8844cc', '#bb66ff'], progress: ['#663399', '#9955dd', '#cc88ff'] },
        };
        const colors = colorMap[this.id] || colorMap.A;

        const ctx = document.createElement('canvas').getContext('2d');
        const waveGradient = ctx.createLinearGradient(0, 0, 0, 100);
        colors.wave.forEach((c, i) => waveGradient.addColorStop(i / 2, c));

        const progressGradient = ctx.createLinearGradient(0, 0, 0, 100);
        colors.progress.forEach((c, i) => progressGradient.addColorStop(i / 2, c));

        this.waveGradient = waveGradient;
        this.progressGradient = progressGradient;

        this.wavesurfer = WaveSurfer.create({
            container: `#${waveformId}`,
            waveColor: waveGradient,
            progressColor: progressGradient,
            cursorColor: '#ffffff',
            barWidth: 2,
            barGap: 1,
            barRadius: 1,
            height: 100,
            normalize: true,
            interact: true,
        });

        // Minimap overview
        this.wavesurfer.registerPlugin(WaveSurfer.Minimap.create({
            container: `#${overviewId}`,
            height: 40,
            waveColor: waveGradient,
            progressColor: progressGradient,
            cursorColor: '#ffffff',
        }));

        // Timeline
        this.wavesurfer.registerPlugin(WaveSurfer.Timeline.create({
            height: 16,
            timeInterval: 15,
            primaryLabelInterval: 60,
            style: { fontSize: '10px', color: '#6666aa' },
        }));

        // Regions for loops and hot cues
        this.regionsPlugin = this.wavesurfer.registerPlugin(WaveSurfer.Regions.create());

        // A streamed song is ready to mix as soon as it can play and its length is known. The
        // waveform ('ready' below) can take half a minute to download, and a mix waiting for it
        // timed out and let the song play to the end.
        const mediaReady = () => {
            const m = this.getMediaElement();
            if (m && m.src && Number.isFinite(m.duration) && m.duration > 0) this.isLoaded = true;
        };
        this.getMediaElement()?.addEventListener('canplay', mediaReady);
        this.getMediaElement()?.addEventListener('durationchange', () => { if (this.getMediaElement()?.readyState >= 3) mediaReady(); });

        this.wavesurfer.on('ready', () => {
            this.isLoaded = true;
            this._buildBeatGrid();

            // Set key lock
            const media = this.getMediaElement();
            if (media) media.preservesPitch = this.keyLock;

            if (this.onReady) {
                this.onReady(this);
            }
        });

        this.wavesurfer.on('play', () => {
            this.isPlaying = true;
        });

        this.wavesurfer.on('pause', () => {
            this.isPlaying = false;
        });

        this.wavesurfer.on('timeupdate', (time) => {
            // Loop enforcement
            if (this.loop.active && this.loop.outPoint !== null) {
                if (time >= this.loop.outPoint) {
                    const dur = this.wavesurfer.getDuration();
                    if (dur > 0) {
                        this.wavesurfer.seekTo(this.loop.inPoint / dur);
                    }
                }
            }

            // Slip mode: track phantom position
            if (this.slipMode && this.slipTimer) {
                this.slipPosition += 1 / 60 * this.currentRate;
            }

            // Near-end detection for auto-advance (configurable threshold)
            if (!this._nearEndFired && this.onTrackNearEnd) {
                const duration = this.wavesurfer.getDuration();
                const remaining = duration - time;
                // Use configurable threshold; for short tracks, use 25% of duration
                const threshold = duration > 0 && duration < this.nearEndThreshold * 2
                    ? Math.max(5, duration * 0.25)
                    : this.nearEndThreshold;
                if (duration > 0 && remaining <= threshold && remaining > 0) {
                    this._nearEndFired = true;
                    this.onTrackNearEnd(this);
                }
            }

            if (this.onTimeUpdate) {
                this.onTimeUpdate(this, time);
            }
        });

        this.wavesurfer.on('finish', () => {
            this.isPlaying = false;
            if (this.onFinish) this.onFinish(this);
        });
    }

    async loadTrack(jsonPath) {
        try {
            const response = await fetch(jsonPath);
            const json = await response.json();
            // Hosted music plays only with a licence (Zaal, 16 Oct 2026).
            const verdict = canPlay(json);
            if (!verdict.ok) return this._refuse(json?.metadata, verdict.reason);
            this.metadata = json;
            this.licence = verdict.licence;
            const audioFile = resolveAudio(jsonPath, this.metadata.audio_files?.mp3);
            if (!audioFile) throw new Error('No MP3 file in metadata');
            this.metadata.audio_files.mp3 = audioFile;

            this._resetState();
            this.wavesurfer.load(audioFile);
            this._updateDeckUI();
            return true;
        } catch (error) {
            console.error(`Deck ${this.id}: Failed to load track:`, error);
            return false;
        }
    }

    // Load a track directly from a URL + metadata object (e.g. from Audius)
    loadDirect(audioUrl, meta) {
        const verdict = canPlay(meta);
        if (!verdict.ok) return this._refuse(meta, verdict.reason);
        try {
            this.licence = verdict.licence;
            this.metadata = {
                metadata: {
                    title: meta.title || 'Unknown',
                    artist: meta.artist || '',
                    bpm: meta.bpm || null,
                    key: meta.key || null,
                    beat: meta.beat ?? null,
                    genre: meta.genre || null,
                    id: meta.id ?? null,
                    artwork: meta.artwork || null,
                },
                audio_files: { mp3: audioUrl },
                _source: meta.source || 'direct',
                _sourceId: meta.id || null,
            };

            this._resetState();
            // Stream it: point the player at the song itself first, so it can play once the
            // first seconds are in. WaveSurfer then draws the waveform from its own download
            // and keeps this source (same URL), so playback is never cut to swap files.
            const media = this.getMediaElement();
            if (media && /^https?:/i.test(audioUrl)) {
                media.crossOrigin = 'anonymous'; // the decks run through Web Audio
                media.src = audioUrl;
            }
            this.wavesurfer.load(audioUrl);
            this._updateDeckUI();
            return true;
        } catch (error) {
            console.error(`Deck ${this.id}: Failed to load direct track:`, error);
            return false;
        }
    }

    // A track without a licence never reaches the deck. Whatever was loaded stays loaded;
    // the deck says why the new one was refused.
    _refuse(meta, reason) {
        console.warn(`Deck ${this.id}: refused:`, reason);
        const prefix = `deck-${this.id.toLowerCase()}`;
        document.getElementById(prefix)?.classList.remove('loading');
        const el = document.getElementById(`${prefix}-licence`) || document.getElementById(`${prefix}-artist`);
        if (el) {
            const before = el.textContent;
            el.textContent = 'NOT LICENSED';
            el.title = reason;
            el.classList.add('licence-refused');
            setTimeout(() => { el.textContent = el.id.endsWith('-licence') ? licenceLine(this.licence) : before; el.classList.remove('licence-refused'); }, 4000);
        }
        this.onRefused?.(this, reason, meta);
        return false;
    }

    _resetState() {
        this.hotCues = new Array(8).fill(null);
        this.cuePoint = 0;
        this.isLoaded = false;
        this.isPlaying = false;
        this._nearEndFired = false;
        this.loop = { active: false, inPoint: null, outPoint: null, region: null };
        this.autoLoopBeats = null;
        this.currentRate = 1.0;
        this.beatPositions = [];
    }

    getMediaElement() {
        return this.wavesurfer.getMediaElement();
    }

    play() {
        this.wavesurfer.play();
    }

    pause() {
        this.wavesurfer.pause();
    }

    playPause() {
        this.wavesurfer.playPause();
    }

    // Serato-style CUE: playing → pause + return to cue; stopped → set cue
    cue() {
        if (this.isPlaying) {
            this.wavesurfer.pause();
            const dur = this.wavesurfer.getDuration();
            if (dur > 0) {
                this.wavesurfer.seekTo(this.cuePoint / dur);
            }
        } else {
            this.cuePoint = this._quantizeTime(this.wavesurfer.getCurrentTime());
        }
    }

    // ===== HOT CUES =====

    triggerHotCue(padIndex) {
        const padColors = ['#ff0000', '#ff8800', '#ffdd00', '#00ff44', '#00ddff', '#0066ff', '#8800ff', '#ff44aa'];
        const existing = this.hotCues[padIndex];

        if (existing) {
            const dur = this.wavesurfer.getDuration();
            if (dur > 0) {
                this.wavesurfer.seekTo(existing.time / dur);
            }
            if (!this.isPlaying) this.play();
        } else {
            const time = this._quantizeTime(this.wavesurfer.getCurrentTime());
            this.hotCues[padIndex] = {
                time,
                color: padColors[padIndex],
            };
        }

        this._updatePadUI(padIndex);
    }

    clearHotCue(padIndex) {
        this.hotCues[padIndex] = null;
        this._updatePadUI(padIndex);
    }

    // ===== LOOP CONTROLS =====

    setLoopIn() {
        this.loop.inPoint = this._quantizeTime(this.wavesurfer.getCurrentTime());
        if (this.loop.outPoint !== null && this.loop.inPoint < this.loop.outPoint) {
            this._activateLoop();
        }
        this._updateLoopUI();
    }

    setLoopOut() {
        this.loop.outPoint = this._quantizeTime(this.wavesurfer.getCurrentTime());
        if (this.loop.inPoint !== null && this.loop.inPoint < this.loop.outPoint) {
            this._activateLoop();
        }
        this._updateLoopUI();
    }

    toggleLoop() {
        if (this.loop.active) {
            this.loop.active = false;
            if (this.loop.region) {
                this.loop.region.remove();
                this.loop.region = null;
            }
        } else if (this.loop.inPoint !== null && this.loop.outPoint !== null) {
            this._activateLoop();
        }
        this._updateLoopUI();
    }

    // Auto-loop in beats (1, 2, 4, 8, 16)
    autoLoop(beats) {
        const bpm = this.getBPM();
        if (!bpm) return;

        const beatDuration = 60 / bpm;
        const loopDuration = beatDuration * beats;
        const currentTime = this._quantizeTime(this.wavesurfer.getCurrentTime());

        this.loop.inPoint = currentTime;
        this.loop.outPoint = currentTime + loopDuration;
        this.autoLoopBeats = beats;
        this._activateLoop();
        this._updateLoopUI();
    }

    loopHalve() {
        if (!this.loop.active || this.loop.inPoint === null || this.loop.outPoint === null) return;
        const length = (this.loop.outPoint - this.loop.inPoint) / 2;
        if (length < 0.05) return; // minimum loop length
        this.loop.outPoint = this.loop.inPoint + length;
        this._activateLoop();
        this._updateLoopUI();
    }

    loopDouble() {
        if (!this.loop.active || this.loop.inPoint === null || this.loop.outPoint === null) return;
        const duration = this.wavesurfer.getDuration();
        const length = (this.loop.outPoint - this.loop.inPoint) * 2;
        this.loop.outPoint = Math.min(this.loop.inPoint + length, duration);
        this._activateLoop();
        this._updateLoopUI();
    }

    _activateLoop() {
        this.loop.active = true;

        // Visual region on waveform
        if (this.loop.region) {
            this.loop.region.remove();
        }

        const loopColors = { A: 'rgba(0, 212, 255, 0.15)', B: 'rgba(255, 107, 53, 0.15)', C: 'rgba(0, 255, 136, 0.15)', D: 'rgba(187, 102, 255, 0.15)' };
        const color = loopColors[this.id] || loopColors.A;
        this.loop.region = this.regionsPlugin.addRegion({
            start: this.loop.inPoint,
            end: this.loop.outPoint,
            color,
            drag: false,
            resize: false,
        });
    }

    // ===== PITCH / TEMPO =====

    get baseBPM() {
        return this.getBPM();
    }

    setPlaybackRate(rate) {
        this.currentRate = Math.max(0.5, Math.min(2.0, rate));
        this.wavesurfer.setPlaybackRate(this.currentRate);
    }

    setTempo(percent) {
        // percent: -pitchRange to +pitchRange
        const rate = 1 + (percent / 100);
        this.setPlaybackRate(rate);
    }

    setKeyLock(enabled) {
        this.keyLock = enabled;
        const media = this.getMediaElement();
        if (media) media.preservesPitch = enabled;
        this._updateKeyLockUI();
    }

    setPitchRange(range) {
        this.pitchRange = range;
        const ch = this.id.toLowerCase();
        const fader = document.getElementById(`pitch-${ch}`);
        if (fader) {
            fader.min = -range;
            fader.max = range;
        }
    }

    // ===== SLIP MODE =====

    setSlipMode(enabled) {
        this.slipMode = enabled;
        if (enabled) {
            this.slipPosition = this.wavesurfer.getCurrentTime();
        }
        this._updateSlipUI();
    }

    slipReturn() {
        if (!this.slipMode) return;
        const dur = this.wavesurfer.getDuration();
        if (dur > 0 && this.slipPosition < dur) {
            this.wavesurfer.seekTo(this.slipPosition / dur);
        }
    }

    // ===== BEATGRID =====

    _buildBeatGrid() {
        const bpm = this.getBPM();
        if (!bpm) return;

        const duration = this.wavesurfer.getDuration();
        const beatInterval = 60 / bpm;
        this.beatPositions = [];

        for (let t = 0; t < duration; t += beatInterval) {
            this.beatPositions.push(t);
        }
    }

    _quantizeTime(time) {
        if (!this.quantize || this.beatPositions.length === 0) return time;

        // Binary search for nearest beat (O(log n) instead of O(n))
        const beats = this.beatPositions;
        let lo = 0, hi = beats.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (beats[mid] < time) lo = mid + 1;
            else hi = mid;
        }
        // lo is first beat >= time; check it and predecessor
        let closest = beats[lo];
        if (lo > 0 && Math.abs(time - beats[lo - 1]) < Math.abs(time - beats[lo])) {
            closest = beats[lo - 1];
        }
        return closest;
    }

    getNearestBeat(time) {
        return this._quantizeTime(time);
    }

    // ===== RGB WAVEFORM =====

    setRGBMode(enabled) {
        this.rgbMode = enabled;
        // RGB coloring would require custom rendering.
        // For WaveSurfer, we approximate by using a multi-color gradient.
        if (enabled) {
            const ctx = document.createElement('canvas').getContext('2d');
            const rgbGradient = ctx.createLinearGradient(0, 0, 0, 100);
            rgbGradient.addColorStop(0, '#ff2200');   // bass = red (top)
            rgbGradient.addColorStop(0.4, '#00ff44');  // mid = green
            rgbGradient.addColorStop(0.7, '#0088ff');  // hi = blue
            rgbGradient.addColorStop(1, '#0044cc');

            this.wavesurfer.setOptions({
                waveColor: rgbGradient,
                progressColor: rgbGradient,
            });
        } else {
            this.wavesurfer.setOptions({
                waveColor: this.waveGradient,
                progressColor: this.progressGradient,
            });
        }
    }

    // ===== COMMON =====

    getBPM() {
        return this.metadata?.metadata?.bpm || null;
    }

    getKey() {
        return this.metadata?.metadata?.key || null;
    }

    getTrackId() {
        return this.metadata?.metadata?.title?.toLowerCase().replace(/\s+/g, '-') || null;
    }

    syncTo(targetBPM) {
        const myBPM = this.getBPM();
        if (myBPM && targetBPM) {
            const rate = Math.max(0.5, Math.min(2.0, targetBPM / myBPM));
            this.currentRate = rate;
            this.wavesurfer.setPlaybackRate(rate);

            // Update pitch fader UI
            const percent = (rate - 1) * 100;
            const ch = this.id.toLowerCase();
            const fader = document.getElementById(`pitch-${ch}`);
            if (fader) fader.value = percent;
            const display = document.getElementById(`pitch-${ch}-display`);
            if (display) display.textContent = `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
        }
    }

    getCurrentTime() {
        return this.wavesurfer.getCurrentTime();
    }

    getDuration() {
        return this.wavesurfer.getDuration();
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00.0';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
    }

    _updateDeckUI() {
        const prefix = `deck-${this.id.toLowerCase()}`;
        const m = this.metadata?.metadata;
        if (!m) return;

        const titleEl = document.getElementById(`${prefix}-title`);
        const artistEl = document.getElementById(`${prefix}-artist`);
        const bpmEl = document.getElementById(`${prefix}-bpm`);
        const keyEl = document.getElementById(`${prefix}-key`);

        if (titleEl) titleEl.textContent = cleanTitle(m.title, m.artist);
        if (artistEl) artistEl.textContent = m.artist || '';
        if (bpmEl) bpmEl.textContent = m.bpm ? `${m.bpm} BPM` : '--- BPM';
        if (keyEl) keyEl.textContent = m.key || '--';
        if (artistEl) artistEl.title = licenceLine(this.licence);
    }

    _updatePadUI(padIndex) {
        const prefix = `deck-${this.id.toLowerCase()}`;
        const padsContainer = document.getElementById(`${prefix}-pads`);
        if (!padsContainer) return;

        const pad = padsContainer.children[padIndex];
        if (!pad) return;

        const cue = this.hotCues[padIndex];
        if (cue) {
            pad.classList.add('set');
            pad.style.color = cue.color;
            pad.style.borderColor = cue.color;
            pad.style.boxShadow = `inset 0 0 10px ${cue.color}40`;
        } else {
            pad.classList.remove('set');
            pad.style.color = '';
            pad.style.borderColor = '';
            pad.style.boxShadow = '';
        }
    }

    _updateLoopUI() {
        const ch = this.id.toLowerCase();
        const loopBtn = document.getElementById(`loop-${ch}-toggle`);
        if (loopBtn) {
            loopBtn.classList.toggle('active', this.loop.active);
        }
        const inBtn = document.getElementById(`loop-${ch}-in`);
        if (inBtn) inBtn.classList.toggle('set', this.loop.inPoint !== null);
        const outBtn = document.getElementById(`loop-${ch}-out`);
        if (outBtn) outBtn.classList.toggle('set', this.loop.outPoint !== null);
    }

    _updateKeyLockUI() {
        const ch = this.id.toLowerCase();
        const btn = document.getElementById(`keylock-${ch}`);
        if (btn) btn.classList.toggle('active', this.keyLock);
    }

    _updateSlipUI() {
        const ch = this.id.toLowerCase();
        const btn = document.getElementById(`slip-${ch}`);
        if (btn) btn.classList.toggle('active', this.slipMode);
    }
}
