// Recorder.js — Record master output to downloadable audio file
// Uses MediaRecorder API + MediaStreamDestination from the audio graph
// Supports format selection: webm, ogg, mp4
// Enhanced: track list/cue sheet, recording waveform, split recording

import { esc } from './Html.js';
export class Recorder {
    constructor(audioRouter) {
        this.router = audioRouter;
        this.ctx = audioRouter.getAudioContext();
        this.mediaRecorder = null;
        this.chunks = [];
        this.isRecording = false;
        this.startTime = 0;
        this.timerInterval = null;
        this.preferredFormat = 'webm';

        // Track list / cue sheet
        this.cueSheet = []; // { time: seconds, trackName, artist, deckId }
        this.splitRecording = false;
        this.splitChunks = []; // Array of { chunks, startTime, endTime, trackName }
        this.currentSplitChunks = [];
        this.currentSplitStart = 0;
        this.currentSplitTrack = '';

        // Waveform visualization of recording
        this._waveformCanvas = null;
        this._waveformCtx = null;
        this._waveformData = [];
        this._waveformAnalyser = null;
        this._waveformAnimFrame = null;

        // Create a stream destination tapped from the master
        this.streamDest = this.ctx.createMediaStreamDestination();
        audioRouter.masterAnalyser.connect(this.streamDest);

        // Analyser for recording waveform
        this._waveformAnalyser = this.ctx.createAnalyser();
        this._waveformAnalyser.fftSize = 256;
        this._waveformAnalyser.smoothingTimeConstant = 0.5;
        audioRouter.masterAnalyser.connect(this._waveformAnalyser);

        this._initUI();
    }

    _initUI() {
        const recBtn = document.getElementById('rec-btn');
        const formatSelect = document.getElementById('rec-format');

        if (recBtn) {
            recBtn.addEventListener('click', () => {
                if (this.isRecording) {
                    this.stop();
                } else {
                    this.start();
                }
            });
        }

        if (formatSelect) {
            formatSelect.addEventListener('change', (e) => {
                this.preferredFormat = e.target.value;
            });
        }

        // Split recording toggle
        const splitBtn = document.getElementById('rec-split-toggle');
        if (splitBtn) {
            splitBtn.addEventListener('click', () => {
                this.splitRecording = !this.splitRecording;
                splitBtn.classList.toggle('active', this.splitRecording);
            });
        }

        // Export cue sheet button
        const cueExportBtn = document.getElementById('rec-cue-export');
        if (cueExportBtn) {
            cueExportBtn.addEventListener('click', () => this._exportCueSheet());
        }

        // Waveform canvas
        this._waveformCanvas = document.getElementById('rec-waveform');
        if (this._waveformCanvas) {
            this._waveformCtx = this._waveformCanvas.getContext('2d');
        }
    }

    start() {
        if (this.isRecording) return;

        this.router.resume();
        this.chunks = [];
        this.cueSheet = [];
        this.splitChunks = [];
        this.currentSplitChunks = [];
        this._waveformData = [];

        this.mediaRecorder = new MediaRecorder(this.streamDest.stream, {
            mimeType: this._getMimeType(),
        });

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                this.chunks.push(e.data);
                if (this.splitRecording) {
                    this.currentSplitChunks.push(e.data);
                }
            }
        };

        this.mediaRecorder.onstop = () => {
            // Finalize current split if active
            if (this.splitRecording && this.currentSplitChunks.length > 0) {
                this.splitChunks.push({
                    chunks: [...this.currentSplitChunks],
                    startTime: this.currentSplitStart,
                    endTime: (Date.now() - this.startTime) / 1000,
                    trackName: this.currentSplitTrack || 'Unknown',
                });
            }
            this._saveRecording();
        };

        this.mediaRecorder.start(1000); // collect data every second
        this.isRecording = true;
        this.startTime = Date.now();
        this.currentSplitStart = 0;

        // UI update
        const recBtn = document.getElementById('rec-btn');
        if (recBtn) {
            recBtn.classList.add('recording');
            recBtn.textContent = 'STOP REC';
        }

        // Show recording panel
        const recPanel = document.getElementById('rec-panel');
        if (recPanel) recPanel.classList.remove('hidden');

        // Timer
        this.timerInterval = setInterval(() => this._updateTimer(), 100);

        // Start waveform animation
        this._startWaveformAnimation();
    }

    stop() {
        if (!this.isRecording || !this.mediaRecorder) return;

        this.mediaRecorder.stop();
        this.isRecording = false;

        const recBtn = document.getElementById('rec-btn');
        if (recBtn) {
            recBtn.classList.remove('recording');
            recBtn.textContent = 'REC';
        }

        clearInterval(this.timerInterval);
        this._stopWaveformAnimation();
    }

    // Called externally when a track is loaded on a deck (to log cue sheet entries)
    logTrackChange(deckId, trackName, artist) {
        if (!this.isRecording) return;

        const elapsed = (Date.now() - this.startTime) / 1000;
        this.cueSheet.push({
            time: elapsed,
            trackName: trackName || 'Unknown',
            artist: artist || '',
            deckId,
        });

        this._updateCueSheetUI();

        // Handle split recording: save current chunk and start new one
        if (this.splitRecording && this.currentSplitChunks.length > 0) {
            this.splitChunks.push({
                chunks: [...this.currentSplitChunks],
                startTime: this.currentSplitStart,
                endTime: elapsed,
                trackName: this.currentSplitTrack || 'Unknown',
            });
            this.currentSplitChunks = [];
            this.currentSplitStart = elapsed;
        }
        this.currentSplitTrack = trackName || 'Unknown';
    }

    _saveRecording() {
        const mimeType = this._getMimeType();
        const ext = this._getExtension(mimeType);
        const blob = new Blob(this.chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `aurdour-mix-${timestamp}.${ext}`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();

        URL.revokeObjectURL(url);

        // If split recording, also save individual tracks
        if (this.splitRecording && this.splitChunks.length > 0) {
            this._saveSplitRecordings(timestamp, mimeType, ext);
        }

        // Auto-export cue sheet
        if (this.cueSheet.length > 0) {
            this._exportCueSheet(timestamp);
        }
    }

    _saveSplitRecordings(timestamp, mimeType, ext) {
        this.splitChunks.forEach((split, index) => {
            const blob = new Blob(split.chunks, { type: mimeType });
            const url = URL.createObjectURL(blob);
            const safeName = split.trackName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filename = `aurdour-split-${timestamp}-${String(index + 1).padStart(2, '0')}-${safeName}.${ext}`;

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    _exportCueSheet(timestamp) {
        if (this.cueSheet.length === 0) return;

        const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        // CUE sheet format
        let cueContent = `REM RECORDED BY AURDOUR DJ\n`;
        cueContent += `REM DATE ${new Date().toISOString()}\n`;
        cueContent += `TITLE "AURDOUR Mix ${ts}"\n`;
        cueContent += `FILE "aurdour-mix-${ts}.webm"\n\n`;

        this.cueSheet.forEach((entry, index) => {
            const mins = Math.floor(entry.time / 60);
            const secs = Math.floor(entry.time % 60);
            const frames = Math.floor((entry.time % 1) * 75); // CD frames

            cueContent += `  TRACK ${String(index + 1).padStart(2, '0')} AUDIO\n`;
            cueContent += `    TITLE "${entry.trackName}"\n`;
            if (entry.artist) cueContent += `    PERFORMER "${entry.artist}"\n`;
            cueContent += `    INDEX 01 ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}\n`;
            cueContent += `    REM DECK ${entry.deckId}\n\n`;
        });

        const blob = new Blob([cueContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aurdour-mix-${ts}.cue`;
        a.click();
        URL.revokeObjectURL(url);
    }

    _updateCueSheetUI() {
        const listEl = document.getElementById('rec-cue-list');
        if (!listEl) return;

        listEl.innerHTML = '';
        this.cueSheet.forEach((entry) => {
            const mins = Math.floor(entry.time / 60);
            const secs = Math.floor(entry.time % 60);
            const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;

            const row = document.createElement('div');
            row.className = 'rec-cue-entry';
            row.innerHTML = `
                <span class="rec-cue-time">${timeStr}</span>
                <span class="rec-cue-deck">${esc(entry.deckId)}</span>
                <span class="rec-cue-track">${esc(entry.trackName)}</span>
            `;
            listEl.appendChild(row);
        });

        // Scroll to bottom
        listEl.scrollTop = listEl.scrollHeight;
    }

    _updateTimer() {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const recTime = document.getElementById('rec-time');
        if (recTime) {
            const m = Math.floor(elapsed / 60);
            const s = Math.floor(elapsed % 60);
            recTime.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }
    }

    // ===== RECORDING WAVEFORM =====

    _startWaveformAnimation() {
        const draw = () => {
            if (!this.isRecording) return;
            this._drawRecordingWaveform();
            this._waveformAnimFrame = requestAnimationFrame(draw);
        };
        draw();
    }

    _stopWaveformAnimation() {
        if (this._waveformAnimFrame) {
            cancelAnimationFrame(this._waveformAnimFrame);
            this._waveformAnimFrame = null;
        }
    }

    _drawRecordingWaveform() {
        const canvas = this._waveformCanvas;
        const ctx = this._waveformCtx;
        if (!canvas || !ctx || !this._waveformAnalyser) return;

        const w = canvas.width;
        const h = canvas.height;

        // Get current audio level
        const dataArray = new Uint8Array(this._waveformAnalyser.frequencyBinCount);
        this._waveformAnalyser.getByteTimeDomainData(dataArray);

        // Calculate RMS level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);

        // Store waveform data point
        this._waveformData.push(rms);

        // Keep only enough data points to fill the canvas
        const maxPoints = w;
        if (this._waveformData.length > maxPoints) {
            this._waveformData = this._waveformData.slice(-maxPoints);
        }

        // Draw background
        ctx.fillStyle = '#0a0a14';
        ctx.fillRect(0, 0, w, h);

        // Draw waveform
        const midY = h / 2;
        ctx.beginPath();
        ctx.strokeStyle = '#ff2200';
        ctx.lineWidth = 1;

        for (let i = 0; i < this._waveformData.length; i++) {
            const x = (i / maxPoints) * w;
            const amplitude = this._waveformData[i] * midY * 3; // scale up for visibility
            const y1 = midY - amplitude;
            const y2 = midY + amplitude;

            ctx.moveTo(x, y1);
            ctx.lineTo(x, y2);
        }
        ctx.stroke();

        // Draw center line
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 34, 0, 0.3)';
        ctx.lineWidth = 0.5;
        ctx.moveTo(0, midY);
        ctx.lineTo(w, midY);
        ctx.stroke();

        // Draw recording indicator dot
        const elapsed = (Date.now() - this.startTime) / 1000;
        if (Math.floor(elapsed * 2) % 2 === 0) {
            ctx.beginPath();
            ctx.arc(w - 8, 8, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#ff0000';
            ctx.fill();
        }

        // Draw time marker
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = '#ff4444';
        ctx.textAlign = 'right';
        const m = Math.floor(elapsed / 60);
        const s = Math.floor(elapsed % 60);
        ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, w - 16, 12);

        // Draw cue markers
        if (this.cueSheet.length > 0) {
            const totalElapsed = elapsed;
            const pixelsPerSecond = w / Math.max(totalElapsed, 60);

            this.cueSheet.forEach(entry => {
                const x = entry.time * pixelsPerSecond;
                if (x >= 0 && x <= w) {
                    ctx.beginPath();
                    ctx.strokeStyle = '#ffcc00';
                    ctx.lineWidth = 1;
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, h);
                    ctx.stroke();

                    ctx.fillStyle = '#ffcc00';
                    ctx.textAlign = 'left';
                    ctx.font = '7px JetBrains Mono, monospace';
                    ctx.fillText(entry.trackName.substring(0, 15), x + 2, h - 3);
                }
            });
        }
    }

    _getMimeType() {
        const formatMap = {
            webm: ['audio/webm;codecs=opus', 'audio/webm'],
            ogg: ['audio/ogg;codecs=opus', 'audio/ogg'],
            mp4: ['audio/mp4', 'audio/mpeg'],
        };

        const candidates = formatMap[this.preferredFormat] || formatMap.webm;
        for (const type of candidates) {
            if (MediaRecorder.isTypeSupported(type)) return type;
        }

        // Fallback
        const allTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        for (const type of allTypes) {
            if (MediaRecorder.isTypeSupported(type)) return type;
        }
        return 'audio/webm';
    }

    _getExtension(mimeType) {
        if (mimeType.includes('webm')) return 'webm';
        if (mimeType.includes('ogg')) return 'ogg';
        if (mimeType.includes('mp4') || mimeType.includes('mpeg')) return 'm4a';
        return 'webm';
    }

    // Expose the stream for external use (e.g., WebRTC broadcasting)
    getOutputStream() {
        return this.streamDest.stream;
    }
}
