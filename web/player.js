// player.js — DJPlayer orchestrator
// Wires together all DJ modules for a full streaming DJ platform

import { Deck } from './dj/Deck.js';
import { AudioRouter } from './dj/AudioRouter.js';
import { Mixer } from './dj/Mixer.js';
import { Meters } from './dj/Meters.js';
import { Library } from './dj/Library.js';
import { Sampler } from './dj/Sampler.js';
import { Recorder } from './dj/Recorder.js';
import { Visualizer } from './dj/Visualizer.js';
import { MidiController } from './dj/MidiController.js';
import { ControllerLights } from './dj/ControllerLights.js';
import { FxFade } from './dj/FxFade.js';
import { PadModes } from './dj/PadModes.js';
import { Moves } from './dj/Moves.js';
import { ProLayout } from './dj/ProLayout.js';
import { RemoteHost } from './dj/RemoteLink.js';
import { Install } from './dj/Install.js';
import { BpmTap } from './dj/BpmTap.js';
import { StreamBroadcast } from './dj/StreamBroadcast.js';
import { FX } from './dj/FX.js';
import { AutoTransition } from './dj/AutoTransition.js';
import { Setlist } from './dj/Setlist.js';
import { HarmonicMixer } from './dj/HarmonicMixer.js';
import { StemSeparator } from './dj/StemSeparator.js';
import { Storage } from './dj/Storage.js';
import { BpmDetector } from './dj/BpmDetector.js';
import { TrackAnalyzer } from './dj/TrackAnalyzer.js';
import { PartyFX } from './dj/PartyFX.js';
import { SoundBoard } from './dj/SoundBoard.js';
import { JogWheel } from './dj/JogWheel.js';
import { DragDrop } from './dj/DragDrop.js';
import { CrashRecovery } from './dj/CrashRecovery.js';
import { NowPlaying } from './dj/NowPlaying.js';
import { LibrarySheet } from './dj/LibrarySheet.js';
import { TestList } from './dj/TestList.js';
import { DeadAir } from './dj/DeadAir.js';
import { WaveformCache } from './dj/WaveformCache.js';
import { Playlists } from './dj/Playlists.js';
import { PerfMonitor } from './dj/PerfMonitor.js';
import { Settings } from './dj/Settings.js';
import { FlowMode } from './dj/FlowMode.js';
import { Audius } from './dj/Audius.js';
import { SoundCloud } from './dj/SoundCloud.js';
import { Spotify } from './dj/Spotify.js';
import { TwitchChat } from './dj/TwitchChat.js';
import { YouTubeLive } from './dj/YouTubeLive.js';
import { SmartRecommend } from './dj/SmartRecommend.js';
import { StreamEvents } from './dj/StreamEvents.js';
import { moderate } from './dj/ChatFilter.js';
import { SwitchPad } from './dj/SwitchPad.js';
import { ZaoCrate } from './dj/ZaoCrate.js';
import { BattleCrate } from './dj/BattleCrate.js';
import { Feedback } from './dj/Feedback.js';
import { SongChainn } from './dj/SongChainn.js';
import { DjMixz } from './dj/DjMixz.js';
import { CloudSync } from './dj/CloudSync.js';
import { PluginManager } from './dj/PluginManager.js';
import { TravelMode } from './dj/TravelMode.js';
import { BeatGridOverlay } from './dj/BeatGridOverlay.js';
import { Archive } from './dj/Archive.js';
import { ArtistTab } from './dj/ArtistTab.js';
import { StreamView, CHAT_KEY } from './dj/StreamView.js';

class DJPlayer {
    constructor() {
        this.audioRouter = new AudioRouter();
        this.decks = {};
        this._audioConnected = { A: false, B: false };
        this.fourDeckMode = false;
        this.storage = new Storage();

        // Core
        this._initDecks();
        this.mixer = new Mixer(this.audioRouter);
        this.meters = new Meters(this.audioRouter);
        this.sampler = new Sampler(this.audioRouter);
        this.library = new Library((deckId, dataFile) => this._onLoadTrack(deckId, dataFile));

        // Safe init helper — one module failure shouldn't block the rest
        const safeInit = (name, fn) => {
            try { return fn(); } catch (e) { console.warn(`${name} init failed:`, e); return null; }
        };

        // Effects
        this.fx = safeInit('FX', () => new FX(this.audioRouter));
        this.stems = safeInit('StemSeparator', () => new StemSeparator(this.audioRouter));

        // Streaming & recording
        this.recorder = safeInit('Recorder', () => new Recorder(this.audioRouter));
        this.visualizer = safeInit('Visualizer', () => new Visualizer(this.audioRouter));
        this.broadcast = safeInit('StreamBroadcast', () => new StreamBroadcast(this.audioRouter, this.recorder));

        // Pro tools
        this.bpmTap = safeInit('BpmTap', () => new BpmTap());
        this.midi = safeInit('MidiController', () => new MidiController(this));
        this.lights = safeInit('ControllerLights', () => new ControllerLights(this));
        this.fxFade = safeInit('FxFade', () => new FxFade(this));
        this.padModes = safeInit('PadModes', () => new PadModes(this));
        this.proLayout = safeInit('ProLayout', () => new ProLayout());
        this.moves = safeInit('Moves', () => new Moves(this));
        this.remote = safeInit('RemoteHost', () => new RemoteHost(this));
        this.nowPlaying = safeInit('NowPlaying', () => new NowPlaying(this));
        this.librarySheet = safeInit('LibrarySheet', () => new LibrarySheet(this));
        this.testList = safeInit('TestList', () => new TestList(this));
        this.install = safeInit('Install', () => new Install({ button: document.getElementById('install-btn'), sheet: document.getElementById('install-sheet') }));
        this.harmonic = safeInit('HarmonicMixer', () => new HarmonicMixer());
        this.autoTransition = safeInit('AutoTransition', () => new AutoTransition(this.audioRouter, this.mixer, this.decks));
        this.setlist = safeInit('Setlist', () => new Setlist(this.library, (deckId, dataFile) => this._onLoadTrack(deckId, dataFile)));

        // New production modules
        this.bpmDetector = safeInit('BpmDetector', () => new BpmDetector(this.audioRouter));
        this.jogWheel = safeInit('JogWheel', () => new JogWheel(this.decks));
        this.dragDrop = safeInit('DragDrop', () => new DragDrop(this.decks, this.audioRouter));
        this.waveformCache = safeInit('WaveformCache', () => new WaveformCache());
        this.playlists = safeInit('Playlists', () => new Playlists(this.storage));
        this.perfMonitor = safeInit('PerfMonitor', () => new PerfMonitor(this.audioRouter));
        this.settings = safeInit('Settings', () => new Settings(this));
        this.crashRecovery = safeInit('CrashRecovery', () => new CrashRecovery());

        // Flow Mode — auto-DJ for non-DJs
        this.flowMode = safeInit('FlowMode', () => new FlowMode(this));

        // Audius integration
        this.audius = safeInit('Audius', () => new Audius());
        if (this.audius) {
            this.library.audius = this.audius;
            this.library.onLoadDirect = (deckId, streamUrl, meta) => this._onLoadDirect(deckId, streamUrl, meta);
        }

        // SoundCloud integration
        this.soundcloud = safeInit('SoundCloud', () => new SoundCloud());
        if (this.soundcloud) {
            this.library.soundcloud = this.soundcloud;
            if (!this.library.onLoadDirect) {
                this.library.onLoadDirect = (deckId, streamUrl, meta) => this._onLoadDirect(deckId, streamUrl, meta);
            }
        }

        // Spotify integration
        this.spotify = safeInit('Spotify', () => new Spotify());
        if (this.spotify) {
            this.library.spotify = this.spotify;
            if (!this.library.onLoadDirect) {
                this.library.onLoadDirect = (deckId, streamUrl, meta) => this._onLoadDirect(deckId, streamUrl, meta);
            }
        }

        // Twitch & YouTube Live chat
        this.twitchChat = safeInit('TwitchChat', () => new TwitchChat(
            (msg) => this._onStreamChatMessage(msg),
            (req) => this._onStreamSongRequest(req),
            (cmd) => console.log('Stream command:', cmd)
        ));
        this.youtubeLive = safeInit('YouTubeLive', () => new YouTubeLive(
            (msg) => this._onStreamChatMessage(msg),
            (req) => this._onStreamSongRequest(req),
            (cmd) => console.log('Stream command:', cmd)
        ));

        // AI Recommendations
        this.smartRecommend = safeInit('SmartRecommend', () => new SmartRecommend(this.harmonic));

        // One-tap next-track switches (buttons under the crossfader, and the controller pads)
        this.switchPad = safeInit('SwitchPad', () => new SwitchPad(this));

        // ZAO crate: ZAO artists' music from Audius, in the library and in the switch pad's pool
        this.songchainn = safeInit('SongChainn', () => new SongChainn());
        this.zaoCrate = safeInit('ZaoCrate', () => new ZaoCrate(this));
        this.battleCrate = safeInit('BattleCrate', () => new BattleCrate(this));
        this.feedback = safeInit('Feedback', () => new Feedback(this));

        // DJ MixZ: the bot DJ. Plans a set from a playlist and a mood, then mixes it.
        this.djMixz = safeInit('DjMixz', () => new DjMixz(this));
        // Tempo and key for every crate song, found once in the background and kept
        this.trackAnalyzer = safeInit('TrackAnalyzer', () => new TrackAnalyzer(this));
        // Shouts, siren, horn and the rewind for DJ MixZ's party sets and the FX pad
        this.partyFX = safeInit('PartyFX', () => new PartyFX(this));
        this.soundBoard = safeInit('SoundBoard', () => new SoundBoard(this));
        this.deadAir = safeInit('DeadAir', () => new DeadAir(this));
        // Stream events: the on-air song, each handover and stream health (docs/STREAM-EVENTS.md)
        this.streamEvents = safeInit('StreamEvents', () => new StreamEvents(this));
        if (this.flowMode && this.streamEvents) this.flowMode.onHandover = (phase, data) => this.streamEvents.handover(phase, data);

        // Cloud Sync
        this.cloudSync = safeInit('CloudSync', () => new CloudSync(this.storage));

        // Plugin Manager
        this.pluginManager = safeInit('PluginManager', () => new PluginManager(this));

        // Travel Mode — touch-optimized mobile/tablet DJ mode
        this.travelMode = safeInit('TravelMode', () => new TravelMode(this));

        // Beat Grid Overlay — visual beat markers, hot cue markers, loop highlights, phase meter
        this.beatGridOverlay = safeInit('BeatGridOverlay', () => new BeatGridOverlay(this.decks.A, this.decks.B));

        // Archive: the extras Zaal asked to hide until each one is tested (ARCHIVE.md)
        this.archive = safeInit('Archive', () => new Archive(this));
        // Artist pages in the library: JANGO first (Zaal, 18 Oct)
        this.artistTab = safeInit('ArtistTab', () => new ArtistTab(this));
        // /stream: the same desk as a display-only page for the stream (Zaal, 25 Oct)
        this.streamView = safeInit('StreamView', () => new StreamView(this));

        // Wire mixer crossfader to stream broadcast
        if (this.broadcast && this.mixer) {
            this.mixer.onCrossfaderChange = (position) => {
                this.broadcast.updateCrossfaderPosition(position);
            };
        }

        // Wire auto-transition state to stream broadcast
        if (this.broadcast && this.autoTransition) {
            this.autoTransition.onTransitionStateChange = (active, direction) => {
                this.broadcast.updateTransitionState(active, direction);
            };
        }

        // Wire library queue button to setlist
        if (this.setlist) {
            this.library.onAddToQueue = (track) => this.setlist.addToQueue(track);
        }

        // Wire playlists to library filter and liked tracks
        if (this.playlists) {
            this.playlists.onFilterChange = () => this._applyPlaylistFilter();
            this.library.playlists = this.playlists;
        }

        // Wire bulk action buttons
        this._initLibraryBulkActions();

        // Wire select-all checkbox
        this._initLibrarySelectAll();

        // Stream chat panel toggle
        this._initStreamPanel();

        // OBS overlay setup popup
        this._initOBSSetup();

        // AI Suggestions toggle
        this._initSuggestPanel();

        // Audio output device selector
        this._initAudioOutput();
        this._initControllerButtons();

        // UI bindings
        this._initTransportButtons();
        this._initHotCuePads();
        this._initLoopControls();
        this._initPitchControls();
        this._initPFLControls();
        this._initHeadphoneControls();
        this._initMicControls();
        this._initSystemAudioControls();
        this._initGlobalToggles();
        this._initKeyboardShortcuts();
        this._initAudioContextResume();
        this._initTravelControls();
        this._loadSettings();

        // Load library first — this is the most important thing to show
        this.library.loadManifest();
        this.meters.start();
        if (this.perfMonitor) this.perfMonitor.start();

        // Crash recovery
        this._initCrashRecovery();

        // Tape stop effect listener
        this._initTapeStopListener();
    }

    _initDecks() {
        const onReady = (deck) => {
            this._connectDeckAudio(deck);
            this.broadcast?.updateTrackInfo(deck.id, deck.metadata);
            this._updateHarmonicDisplay();

            // Visual polish: remove loading shimmer, activate BPM pulse
            const deckPrefix = deck.id.toLowerCase();
            const deckEl = document.getElementById(`deck-${deckPrefix}`);
            if (deckEl) {
                deckEl.classList.remove('loading', 'analyzing');
            }

            // BPM pulse dot activation
            const bpm = deck.getBPM();
            const pulseEl = document.getElementById(`deck-${deckPrefix}-bpm-pulse`);
            if (pulseEl && bpm) {
                const interval = 60 / bpm; // seconds per beat
                pulseEl.style.setProperty('--bpm-interval', `${interval}s`);
                pulseEl.classList.add('active');
            } else if (pulseEl) {
                pulseEl.classList.remove('active');
            }

            // Restore saved cue points
            const trackId = deck.getTrackId();
            if (trackId) {
                const cues = this.storage.loadCuePoints(trackId);
                if (cues) {
                    deck.hotCues = cues.map(c => c ? { time: c.time, color: c.color } : null);
                    for (let i = 0; i < 8; i++) deck._updatePadUI(i);
                }
            }

            // Auto BPM/key detection if metadata is missing
            this._autoDetectBpmKey(deck);

            // Auto-gain: analyze loudness and normalize on load
            this._autoGainAnalyze(deck);

            // Track play count
            if (trackId && this.playlists) this.playlists.incrementPlayCount(trackId);
        };

        const onTimeUpdate = (deck, time) => {
            this._updateTimeDisplay(deck, time);
            // Feed time updates to FlowMode for smart near-end detection
            if (this.flowMode?.enabled) {
                this.flowMode.onTimeUpdate(deck);
            }
            // Update phase sync label
            this._updatePhaseSyncLabel();
        };

        const onTrackNearEnd = (deck) => {
            if (this.flowMode?.enabled) {
                this.flowMode.onTrackNearEnd(deck);
            }
        };

        const onFinish = (deck) => {
            if (this.flowMode?.enabled) {
                this.flowMode.onTrackNearEnd(deck);
            }
        };

        this.decks.A = new Deck('A', 'deck-a-waveform', 'deck-a-overview', { onReady, onTimeUpdate, onTrackNearEnd, onFinish });
        this.decks.B = new Deck('B', 'deck-b-waveform', 'deck-b-overview', { onReady, onTimeUpdate, onTrackNearEnd, onFinish });
    }

    async _autoDetectBpmKey(deck) {
        if (!this.bpmDetector) return;
        if (!deck.metadata) return;
        const meta = deck.metadata.metadata || {};
        const audioUrl = deck.metadata.audio_files?.mp3;
        const trackId = deck.getTrackId();
        if (!audioUrl || !trackId) return;

        // Only detect if BPM or key is missing
        if (meta.bpm && meta.key) return;

        // Visual polish: show analyzing shimmer
        const deckEl = document.getElementById(`deck-${deck.id.toLowerCase()}`);
        if (deckEl) deckEl.classList.add('analyzing');

        try {
            const result = await this.bpmDetector.analyze(audioUrl, trackId);
            if (result.bpm && !meta.bpm) {
                meta.bpm = result.bpm;
                const prefix = `deck-${deck.id.toLowerCase()}`;
                const bpmEl = document.getElementById(`${prefix}-bpm`);
                if (bpmEl) bpmEl.textContent = `${result.bpm} BPM`;
                deck._buildBeatGrid();

                // Visual polish: activate BPM pulse after detection
                const pulseEl = document.getElementById(`${prefix}-bpm-pulse`);
                if (pulseEl) {
                    const interval = 60 / result.bpm;
                    pulseEl.style.setProperty('--bpm-interval', `${interval}s`);
                    pulseEl.classList.add('active');
                }
            }
            if (result.key && !meta.key) {
                meta.key = result.key;
                const prefix = `deck-${deck.id.toLowerCase()}`;
                const keyEl = document.getElementById(`${prefix}-key`);
                if (keyEl) keyEl.textContent = result.key;
                this._updateHarmonicDisplay();
            }
            // Update setlist entry with newly detected BPM/key
            if (this.setlist && (result.bpm || result.key)) {
                this.setlist.updateLastEntryMeta(deck.id, result.bpm || null, result.key || null);
            }
        } catch (e) {
            console.warn('Auto BPM/key detection failed:', e);
        } finally {
            // Visual polish: remove analyzing shimmer
            if (deckEl) deckEl.classList.remove('analyzing');
        }
    }

    async _autoGainAnalyze(deck) {
        if (!this.audioRouter.autoGainEnabled) return;
        const mediaEl = deck.getMediaElement();
        if (!mediaEl) return;

        try {
            await this.audioRouter.analyzeAndNormalize(deck.id, mediaEl);
        } catch (e) {
            console.warn(`[AUTOGAIN] Analysis failed for Deck ${deck.id}:`, e.message);
        }
    }

    _connectDeckAudio(deck) {
        const mediaEl = deck.getMediaElement();
        if (!mediaEl) return;

        // WaveSurfer 7 creates a NEW <audio> element on each load().
        // We must detect this and reconnect the MediaElementSourceNode.
        const prevEl = this._connectedMediaElements?.[deck.id];
        if (prevEl && prevEl === mediaEl && this._audioConnected[deck.id]) {
            // Same element, already connected — skip
            return;
        }

        // Track which element we connected
        if (!this._connectedMediaElements) this._connectedMediaElements = {};
        this._connectedMediaElements[deck.id] = mediaEl;

        try {
            this.audioRouter.connectDeckSource(deck.id, mediaEl);
            this._audioConnected[deck.id] = true;
        } catch (e) {
            if (e.message?.includes('already been created')) {
                this._audioConnected[deck.id] = true;
            } else {
                console.warn(`Deck ${deck.id} audio routing issue:`, e.message);
            }
        }
    }

    _updateTimeDisplay(deck, currentTime) {
        const prefix = `deck-${deck.id.toLowerCase()}`;
        const duration = deck.getDuration();
        const remaining = duration - currentTime;

        const elapsedEl = document.getElementById(`${prefix}-elapsed`);
        const remainingEl = document.getElementById(`${prefix}-remaining`);

        if (elapsedEl) elapsedEl.textContent = deck.formatTime(currentTime);
        if (remainingEl) remainingEl.textContent = `-${deck.formatTime(remaining)}`;

        const playBtn = document.getElementById(`${prefix}-play`);
        if (playBtn) {
            playBtn.classList.toggle('playing', deck.isPlaying);
            const playIcon = playBtn.querySelector('.icon-play');
            const pauseIcon = playBtn.querySelector('.icon-pause');
            if (playIcon && pauseIcon) {
                playIcon.classList.toggle('hidden', deck.isPlaying);
                pauseIcon.classList.toggle('hidden', !deck.isPlaying);
            }
        }

        // Visual polish: toggle .playing class on deck container
        const deckEl = document.getElementById(`deck-${deck.id.toLowerCase()}`);
        if (deckEl) {
            deckEl.classList.toggle('playing', deck.isPlaying);
        }

        this.broadcast?.updatePlayState(deck.id, deck.isPlaying, currentTime);

        // Update travel mode display
        this._updateTravelDisplay(deck);
    }

    _updatePhaseSyncLabel() {
        const label = document.getElementById('phase-sync-label');
        if (!label) return;

        const deckA = this.decks.A;
        const deckB = this.decks.B;
        if (!deckA.isLoaded || !deckB.isLoaded) {
            label.textContent = '--';
            label.style.color = '';
            return;
        }

        const bpmA = deckA.getBPM();
        const bpmB = deckB.getBPM();
        if (!bpmA || !bpmB) {
            label.textContent = '--';
            label.style.color = '';
            return;
        }

        const timeA = deckA.getCurrentTime();
        const timeB = deckB.getCurrentTime();
        const beatIntervalA = 60 / (bpmA * (deckA.currentRate || 1));
        const beatIntervalB = 60 / (bpmB * (deckB.currentRate || 1));
        const phaseA = (timeA % beatIntervalA) / beatIntervalA;
        const phaseB = (timeB % beatIntervalB) / beatIntervalB;

        let phaseDiff = phaseA - phaseB;
        if (phaseDiff > 0.5) phaseDiff -= 1;
        if (phaseDiff < -0.5) phaseDiff += 1;

        const absDiff = Math.abs(phaseDiff);
        if (absDiff < 0.05) {
            label.textContent = 'SYNC';
            label.style.color = '#00ff88';
        } else if (absDiff < 0.15) {
            label.textContent = 'CLOSE';
            label.style.color = '#ffcc00';
        } else {
            label.textContent = 'DRIFT';
            label.style.color = '#ff4444';
        }
    }

    _updateHarmonicDisplay() {
        if (!this.harmonic) return;
        const keyA = this.decks.A.getKey();
        const keyB = this.decks.B.getKey();
        this.harmonic.updateDeckDisplay('A', keyA, keyB);
        this.harmonic.updateDeckDisplay('B', keyB, keyA);
    }

    _initTransportButtons() {
        ['a', 'b'].forEach(ch => {
            const deckId = ch.toUpperCase();
            const deck = this.decks[deckId];

            document.getElementById(`deck-${ch}-play`)?.addEventListener('click', () => {
                this.audioRouter.resume();
                deck.playPause();
            });

            document.getElementById(`deck-${ch}-cue`)?.addEventListener('click', () => {
                deck.cue();
            });

            document.getElementById(`deck-${ch}-sync`)?.addEventListener('click', () => {
                const otherDeck = deckId === 'A' ? this.decks.B : this.decks.A;
                let targetBPM = otherDeck.getBPM();
                if (!targetBPM && this.bpmTap?.getBPM()) {
                    targetBPM = this.bpmTap.getBPM();
                }
                if (targetBPM) {
                    deck.syncTo(targetBPM);
                    const btn = document.getElementById(`deck-${ch}-sync`);
                    btn?.classList.add('active');
                    setTimeout(() => btn?.classList.remove('active'), 1000);
                }
            });
        });
    }

    _initHotCuePads() {
        ['a', 'b'].forEach(ch => {
            const deckId = ch.toUpperCase();
            const deck = this.decks[deckId];
            const padsContainer = document.getElementById(`deck-${ch}-pads`);
            if (!padsContainer) return;

            padsContainer.querySelectorAll('.cue-pad').forEach(pad => {
                const index = parseInt(pad.dataset.pad);
                pad.addEventListener('click', (e) => {
                    this.audioRouter.resume();
                    if (e.shiftKey) {
                        deck.clearHotCue(index);
                    } else {
                        deck.triggerHotCue(index);
                    }
                    // Save cue points
                    const trackId = deck.getTrackId();
                    if (trackId) this.storage.saveCuePoints(trackId, deck.hotCues);
                });
            });
        });
    }

    _initLoopControls() {
        ['a', 'b'].forEach(ch => {
            const deckId = ch.toUpperCase();
            const deck = this.decks[deckId];

            document.getElementById(`loop-${ch}-in`)?.addEventListener('click', () => deck.setLoopIn());
            document.getElementById(`loop-${ch}-out`)?.addEventListener('click', () => deck.setLoopOut());
            document.getElementById(`loop-${ch}-toggle`)?.addEventListener('click', () => deck.toggleLoop());
            document.getElementById(`loop-${ch}-halve`)?.addEventListener('click', () => deck.loopHalve());
            document.getElementById(`loop-${ch}-double`)?.addEventListener('click', () => deck.loopDouble());

            // Auto-loop buttons
            const deckSection = document.getElementById(`deck-${ch}`);
            if (deckSection) {
                deckSection.querySelectorAll('.auto-loop').forEach(btn => {
                    btn.addEventListener('click', () => {
                        deck.autoLoop(parseInt(btn.dataset.beats));
                    });
                });
            }
        });
    }

    _initPitchControls() {
        ['a', 'b'].forEach(ch => {
            const deckId = ch.toUpperCase();
            const deck = this.decks[deckId];

            const pitchFader = document.getElementById(`pitch-${ch}`);
            const pitchDisplay = document.getElementById(`pitch-${ch}-display`);

            if (pitchFader) {
                pitchFader.addEventListener('input', (e) => {
                    const val = parseFloat(e.target.value);
                    deck.setTempo(val);
                    if (pitchDisplay) pitchDisplay.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
                });

                pitchFader.addEventListener('dblclick', () => {
                    pitchFader.value = 0;
                    deck.setTempo(0);
                    if (pitchDisplay) pitchDisplay.textContent = '0.0%';
                });
            }

            // Key lock
            document.getElementById(`keylock-${ch}`)?.addEventListener('click', () => {
                deck.setKeyLock(!deck.keyLock);
            });

            // Slip mode
            document.getElementById(`slip-${ch}`)?.addEventListener('click', () => {
                deck.setSlipMode(!deck.slipMode);
            });

            // Pitch range
            const pitchRange = document.getElementById(`pitch-range-${ch}`);
            if (pitchRange) {
                pitchRange.addEventListener('change', (e) => {
                    deck.setPitchRange(parseInt(e.target.value));
                });
            }
        });
    }

    _initPFLControls() {
        ['a', 'b'].forEach(ch => {
            const deckId = ch.toUpperCase();
            const pflBtn = document.getElementById(`pfl-${ch}`);
            if (!pflBtn) return;

            pflBtn.addEventListener('click', () => {
                const enabled = !this.audioRouter.channels[deckId].pfl;
                this.audioRouter.setPFL(deckId, enabled);
                pflBtn.classList.toggle('active', enabled);
            });
        });
    }

    _initHeadphoneControls() {
        const cueMix = document.getElementById('cue-mix');
        if (cueMix) {
            cueMix.addEventListener('input', (e) => {
                this.audioRouter.setCueMix(e.target.value / 100);
            });
        }

        const cueVol = document.getElementById('cue-volume');
        if (cueVol) {
            cueVol.addEventListener('input', (e) => {
                this.audioRouter.setCueVolume(e.target.value / 100);
            });
        }

        const splitCue = document.getElementById('split-cue');
        if (splitCue) {
            splitCue.addEventListener('click', () => {
                const enabled = !this.audioRouter.splitCue;
                this.audioRouter.setSplitCue(enabled);
                splitCue.classList.toggle('active', enabled);
            });
        }

        const boothVol = document.getElementById('booth-volume');
        if (boothVol) {
            boothVol.addEventListener('input', (e) => {
                this.audioRouter.setBoothVolume(e.target.value / 100);
            });
        }
    }

    _initMicControls() {
        const micToggle = document.getElementById('mic-toggle');
        const micMute = document.getElementById('mic-mute');
        const micVolume = document.getElementById('mic-volume');
        const micStatus = document.getElementById('mic-status');

        if (micToggle) {
            micToggle.addEventListener('click', async () => {
                if (this.audioRouter.mic.stream) {
                    this.audioRouter.disconnectMic();
                    micToggle.classList.remove('active');
                    micToggle.textContent = 'CONNECT';
                    if (micStatus) micStatus.textContent = 'Off';
                    if (micMute) micMute.classList.remove('active');
                } else {
                    const ok = await this.audioRouter.connectMic();
                    if (ok) {
                        micToggle.classList.add('active');
                        micToggle.textContent = 'DISCONNECT';
                        if (micStatus) micStatus.textContent = 'Connected';
                    } else {
                        if (micStatus) micStatus.textContent = 'Denied';
                    }
                }
            });
        }

        if (micMute) {
            micMute.addEventListener('click', () => {
                if (!this.audioRouter.mic.stream) return;
                const isMuted = this.audioRouter.mic.muted;
                this.audioRouter.setMicMute(!isMuted);
                micMute.classList.toggle('active', !isMuted);
                micMute.textContent = isMuted ? 'UNMUTE' : 'MUTE';
            });
        }

        if (micVolume) {
            micVolume.addEventListener('input', (e) => {
                this.audioRouter.setMicVolume(e.target.value / 100);
            });
        }

        ['high', 'mid', 'low'].forEach(band => {
            const knob = document.getElementById(`eq-mic-${band}`);
            if (knob) {
                knob.addEventListener('input', (e) => {
                    this.audioRouter.setMicEQ(band, parseFloat(e.target.value));
                });
                knob.addEventListener('dblclick', () => {
                    knob.value = 0;
                    this.audioRouter.setMicEQ(band, 0);
                });
            }
        });
    }

    _initSystemAudioControls() {
        const sysToggle = document.getElementById('system-toggle');
        const sysVolume = document.getElementById('system-volume');
        const sysStatus = document.getElementById('system-status');

        if (sysToggle) {
            sysToggle.addEventListener('click', async () => {
                if (this.audioRouter.system.active) {
                    this.audioRouter.disconnectSystemAudio();
                    sysToggle.classList.remove('active');
                    sysToggle.textContent = 'CAPTURE';
                    if (sysStatus) sysStatus.textContent = 'Off';
                } else {
                    const ok = await this.audioRouter.connectSystemAudio();
                    if (ok) {
                        sysToggle.classList.add('active');
                        sysToggle.textContent = 'STOP';
                        if (sysStatus) sysStatus.textContent = 'Active';
                    } else {
                        if (sysStatus) sysStatus.textContent = 'Failed';
                    }
                }
            });
        }

        if (sysVolume) {
            sysVolume.addEventListener('input', (e) => {
                this.audioRouter.setSystemVolume(e.target.value / 100);
            });
        }
    }

    _initGlobalToggles() {
        // RGB waveform toggle
        const rgbBtn = document.getElementById('rgb-toggle');
        if (rgbBtn) {
            rgbBtn.addEventListener('click', () => {
                const enabled = !this.decks.A.rgbMode;
                this.decks.A.setRGBMode(enabled);
                this.decks.B.setRGBMode(enabled);
                rgbBtn.classList.toggle('active', enabled);
            });
        }

        // Quantize toggle
        const qtzBtn = document.getElementById('quantize-toggle');
        if (qtzBtn) {
            qtzBtn.addEventListener('click', () => {
                const enabled = !this.decks.A.quantize;
                this.decks.A.quantize = enabled;
                this.decks.B.quantize = enabled;
                qtzBtn.classList.toggle('active', enabled);
            });
        }

        // Beat Grid overlay toggle buttons
        ['a', 'b'].forEach(ch => {
            const deckId = ch.toUpperCase();
            const gridBtn = document.getElementById(`grid-${ch}`);
            if (gridBtn && this.beatGridOverlay) {
                gridBtn.addEventListener('click', () => {
                    const visible = this.beatGridOverlay.toggleGrid(deckId);
                    gridBtn.classList.toggle('active', visible);
                });
            }
        });

        // 4-Deck mode toggle
        const fourDeckBtn = document.getElementById('four-deck-toggle');
        if (fourDeckBtn) {
            fourDeckBtn.addEventListener('click', () => {
                this._toggleFourDeckMode();
            });
        }

        // Chat close
        document.getElementById('chat-close')?.addEventListener('click', () => {
            document.getElementById('chat-panel')?.classList.add('hidden');
        });

        // Flow Mode toggle
        document.getElementById('flow-toggle-btn')?.addEventListener('click', () => {
            if (this.flowMode) this.flowMode.toggle();
        });

        // Crossfader curve select in toolbar
        const cfCurveSelect = document.getElementById('auto-trans-curve');
        if (cfCurveSelect) {
            cfCurveSelect.addEventListener('change', (e) => {
                this.audioRouter.setCrossfaderCurve(e.target.value);
            });
        }

        // Wire AutoTransition completion to FlowMode
        if (this.autoTransition) {
            this.autoTransition.onComplete = (direction) => {
                if (this.flowMode?.enabled) {
                    this.flowMode.onTransitionComplete(direction);
                }
            };
            this.autoTransition.onCancel = () => {
                if (this.flowMode?.enabled) this.flowMode.onTransitionCancelled();
            };
        }
    }

    _initKeyboardShortcuts() {
        // --- Shortcuts overlay toggle ---
        const shortcutsOverlay = document.getElementById('shortcuts-overlay');
        const shortcutsBtn = document.getElementById('shortcuts-btn');
        const shortcutsClose = document.getElementById('shortcuts-close');
        const shortcutsBackdrop = document.getElementById('shortcuts-backdrop');

        const toggleShortcutsOverlay = () => {
            if (shortcutsOverlay) shortcutsOverlay.classList.toggle('hidden');
        };
        const closeShortcutsOverlay = () => {
            if (shortcutsOverlay) shortcutsOverlay.classList.add('hidden');
        };

        if (shortcutsBtn) shortcutsBtn.addEventListener('click', toggleShortcutsOverlay);
        if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcutsOverlay);
        if (shortcutsBackdrop) shortcutsBackdrop.addEventListener('click', closeShortcutsOverlay);

        // --- Visual key-press feedback helper ---
        const flashButton = (elementId) => {
            const el = document.getElementById(elementId);
            if (!el) return;
            el.classList.remove('key-pressed');
            // Force reflow so re-adding the class restarts the animation
            void el.offsetWidth;
            el.classList.add('key-pressed');
            el.addEventListener('animationend', () => el.classList.remove('key-pressed'), { once: true });
        };

        // --- Main keyboard handler ---
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

            this.audioRouter.resume();

            // "?" key (Shift + Slash on US keyboards) or "H" key toggle shortcuts overlay
            if ((e.key === '?' || e.key === '/') && e.shiftKey) {
                e.preventDefault();
                toggleShortcutsOverlay();
                flashButton('shortcuts-btn');
                return;
            }

            switch (e.code) {
                // --- Transport ---
                case 'Space':
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.decks.B.playPause();
                        flashButton('deck-b-play');
                    } else {
                        this.decks.A.playPause();
                        flashButton('deck-a-play');
                    }
                    break;
                case 'KeyQ':
                    this.decks.A.playPause();
                    flashButton('deck-a-play');
                    break;
                case 'KeyW':
                    this.decks.B.playPause();
                    flashButton('deck-b-play');
                    break;
                case 'KeyA':
                    this.decks.A.cue();
                    flashButton('deck-a-cue');
                    break;
                case 'KeyS':
                    this.decks.B.cue();
                    flashButton('deck-b-cue');
                    break;
                case 'KeyZ':
                    if (e.ctrlKey || e.metaKey) {
                        // Ctrl+Z = undo, Ctrl+Shift+Z = redo
                        if (this.settings) {
                            e.preventDefault();
                            if (e.shiftKey) this.settings.redo();
                            else this.settings.undo();
                        }
                    } else {
                        // Z alone = sync Deck A to Deck B's BPM
                        const bpmB = this.decks.B.getBPM();
                        if (bpmB) this.decks.A.syncTo(bpmB);
                        flashButton('deck-a-sync');
                    }
                    break;
                case 'KeyX': {
                    // X = sync Deck B to Deck A's BPM
                    const bpmA = this.decks.A.getBPM();
                    if (bpmA) this.decks.B.syncTo(bpmA);
                    flashButton('deck-b-sync');
                    break;
                }

                // --- Mixing: crossfader & volume ---
                case 'ArrowLeft':
                    e.preventDefault();
                    this.mixer.nudgeCrossfader(-5);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.mixer.nudgeCrossfader(5);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.mixer.nudgeVolume(e.shiftKey ? 'B' : 'A', 5);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.mixer.nudgeVolume(e.shiftKey ? 'B' : 'A', -5);
                    break;

                // --- Tempo adjust (+/- keys) ---
                case 'Equal': // "+" / "=" key
                case 'NumpadAdd': {
                    e.preventDefault();
                    const deck = e.shiftKey ? this.decks.B : this.decks.A;
                    const ch = e.shiftKey ? 'b' : 'a';
                    const pitchFader = document.getElementById(`pitch-${ch}`);
                    const pitchDisplay = document.getElementById(`pitch-${ch}-display`);
                    if (pitchFader) {
                        const newVal = Math.min(parseFloat(pitchFader.max), parseFloat(pitchFader.value) + 0.5);
                        pitchFader.value = newVal;
                        deck.setTempo(newVal);
                        if (pitchDisplay) pitchDisplay.textContent = `${newVal >= 0 ? '+' : ''}${newVal.toFixed(1)}%`;
                    }
                    break;
                }
                case 'Minus': // "-" key
                case 'NumpadSubtract': {
                    e.preventDefault();
                    const deck = e.shiftKey ? this.decks.B : this.decks.A;
                    const ch = e.shiftKey ? 'b' : 'a';
                    const pitchFader = document.getElementById(`pitch-${ch}`);
                    const pitchDisplay = document.getElementById(`pitch-${ch}-display`);
                    if (pitchFader) {
                        const newVal = Math.max(parseFloat(pitchFader.min), parseFloat(pitchFader.value) - 0.5);
                        pitchFader.value = newVal;
                        deck.setTempo(newVal);
                        if (pitchDisplay) pitchDisplay.textContent = `${newVal >= 0 ? '+' : ''}${newVal.toFixed(1)}%`;
                    }
                    break;
                }

                // --- Hot Cues (1-8) ---
                case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
                case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8': {
                    const i = parseInt(e.code.replace('Digit', '')) - 1;
                    const deckId = (e.ctrlKey || e.metaKey || e.shiftKey) ? 'B' : 'A';
                    this.decks[deckId].triggerHotCue(i);
                    // Flash the corresponding pad button
                    const padContainer = document.getElementById(`deck-${deckId.toLowerCase()}-pads`);
                    if (padContainer) {
                        const pad = padContainer.querySelector(`[data-pad="${i}"]`);
                        if (pad) {
                            pad.classList.remove('key-pressed');
                            void pad.offsetWidth;
                            pad.classList.add('key-pressed');
                            pad.addEventListener('animationend', () => pad.classList.remove('key-pressed'), { once: true });
                        }
                    }
                    break;
                }

                // --- Loops ---
                case 'KeyL':
                    if (e.shiftKey) {
                        this.decks.B.toggleLoop();
                        flashButton('loop-b-toggle');
                    } else {
                        this.decks.A.toggleLoop();
                        flashButton('loop-a-toggle');
                    }
                    break;
                case 'BracketLeft':
                    if (e.shiftKey) {
                        this.decks.B.setLoopIn();
                        flashButton('loop-b-in');
                    } else {
                        this.decks.A.setLoopIn();
                        flashButton('loop-a-in');
                    }
                    break;
                case 'BracketRight':
                    if (e.shiftKey) {
                        this.decks.B.setLoopOut();
                        flashButton('loop-b-out');
                    } else {
                        this.decks.A.setLoopOut();
                        flashButton('loop-a-out');
                    }
                    break;

                // --- Effects & Recording ---
                case 'KeyM':
                    if (this.audioRouter.mic.stream) {
                        const muted = this.audioRouter.mic.muted;
                        this.audioRouter.setMicMute(!muted);
                        const micMute = document.getElementById('mic-mute');
                        if (micMute) { micMute.classList.toggle('active', !muted); micMute.textContent = muted ? 'UNMUTE' : 'MUTE'; }
                        flashButton('mic-mute');
                    }
                    break;
                case 'KeyR':
                    if (e.ctrlKey || e.metaKey) return;
                    if (this.recorder) {
                        if (this.recorder.isRecording) this.recorder.stop();
                        else this.recorder.start();
                        flashButton('rec-btn');
                    }
                    break;
                case 'KeyV':
                    if (this.visualizer) {
                        if (this.visualizer.running) this.visualizer.stop();
                        else this.visualizer.start();
                        flashButton('viz-toggle');
                    }
                    break;

                // --- Navigation ---
                case 'KeyF':
                    if (e.ctrlKey || e.metaKey) return; // don't block browser find
                    if (this.flowMode) this.flowMode.toggle();
                    flashButton('flow-toggle-btn');
                    break;
                case 'KeyG':
                    // Toggle beat grid overlay
                    if (this.beatGridOverlay) {
                        if (e.shiftKey) {
                            const vis = this.beatGridOverlay.toggleGrid('B');
                            const btn = document.getElementById('grid-b');
                            if (btn) btn.classList.toggle('active', vis);
                            flashButton('grid-b');
                        } else {
                            const vis = this.beatGridOverlay.toggleGrid('A');
                            const btn = document.getElementById('grid-a');
                            if (btn) btn.classList.toggle('active', vis);
                            flashButton('grid-a');
                        }
                    }
                    break;
                case 'KeyH':
                    toggleShortcutsOverlay();
                    flashButton('shortcuts-btn');
                    break;
                case 'Escape':
                    // Close any open panel/overlay
                    closeShortcutsOverlay();
                    document.getElementById('settings-panel')?.classList.add('hidden');
                    document.getElementById('stream-panel')?.classList.add('hidden');
                    document.getElementById('suggest-panel')?.classList.add('hidden');
                    document.getElementById('plugins-panel')?.classList.add('hidden');
                    document.getElementById('chat-panel')?.classList.add('hidden');
                    break;

                // --- Undo/Redo (Ctrl+Z already handled above in KeyZ) ---
            }
        });
    }

    _initStreamPanel() {
        const panel = document.getElementById('stream-panel');
        const toggleBtn = document.getElementById('stream-chat-toggle');
        const closeBtn = document.getElementById('stream-panel-close');

        if (toggleBtn && panel) toggleBtn.addEventListener('click', () => panel.classList.toggle('hidden'));
        if (closeBtn && panel) closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

        // Twitch connect
        const twitchBtn = document.getElementById('twitch-connect-btn');
        if (twitchBtn && this.twitchChat) {
            twitchBtn.addEventListener('click', () => {
                if (this.twitchChat.isConnected) {
                    this.twitchChat.disconnect();
                    twitchBtn.textContent = 'JOIN';
                } else {
                    const channel = document.getElementById('twitch-channel-input')?.value?.trim();
                    if (channel) {
                        this.twitchChat.connectAnonymous(channel);
                        try { localStorage.setItem(CHAT_KEY, channel); } catch (e) { /* /stream falls back to the default */ }
                    }
                }
            });
            this.twitchChat.onConnectionChange = (connected, channel) => {
                const status = document.getElementById('twitch-status');
                if (status) { status.textContent = connected ? 'Live: ' + channel : 'Offline'; status.classList.toggle('connected', connected); }
                twitchBtn.textContent = connected ? 'LEAVE' : 'JOIN';
            };
        }

        // YouTube connect
        const ytBtn = document.getElementById('yt-connect-btn');
        if (ytBtn && this.youtubeLive) {
            ytBtn.addEventListener('click', () => {
                if (this.youtubeLive.isConnected) {
                    this.youtubeLive.disconnect();
                    ytBtn.textContent = 'JOIN';
                } else {
                    const videoId = document.getElementById('yt-video-input')?.value?.trim();
                    const apiKey = document.getElementById('yt-api-key-input')?.value?.trim();
                    if (videoId && apiKey) this.youtubeLive.connect(videoId, apiKey);
                }
            });
            this.youtubeLive.onConnectionChange = (connected) => {
                const status = document.getElementById('yt-status');
                if (status) { status.textContent = connected ? 'Live' : 'Offline'; status.classList.toggle('connected', connected); }
                ytBtn.textContent = connected ? 'LEAVE' : 'JOIN';
            };
        }
    }

    _initOBSSetup() {
        const popup = document.getElementById('obs-setup-popup');
        const openBtn = document.getElementById('obs-setup-btn');
        const closeBtn = document.getElementById('obs-setup-close');
        const urlInput = document.getElementById('obs-overlay-url');
        const copyBtn = document.getElementById('obs-copy-url');
        const previewBtn = document.getElementById('obs-preview-btn');

        if (!popup || !openBtn) return;

        let selectedTheme = 'full';

        const getOverlayUrl = () => {
            const base = window.location.href.replace(/\/[^/]*$/, '/obs-overlay.html');
            return selectedTheme === 'full' ? base : `${base}?theme=${selectedTheme}`;
        };

        const updateUrl = () => {
            if (urlInput) urlInput.value = getOverlayUrl();
        };

        openBtn.addEventListener('click', () => {
            updateUrl();
            popup.classList.remove('hidden');
        });

        if (closeBtn) closeBtn.addEventListener('click', () => popup.classList.add('hidden'));

        // Close on backdrop click
        popup.addEventListener('click', (e) => {
            if (e.target === popup) popup.classList.add('hidden');
        });

        // Theme buttons
        popup.querySelectorAll('.obs-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                popup.querySelectorAll('.obs-theme-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedTheme = btn.dataset.theme;
                updateUrl();
            });
        });

        // Copy URL
        if (copyBtn && urlInput) {
            copyBtn.addEventListener('click', () => {
                urlInput.select();
                navigator.clipboard.writeText(urlInput.value).then(() => {
                    copyBtn.textContent = 'COPIED';
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        copyBtn.textContent = 'COPY';
                        copyBtn.classList.remove('copied');
                    }, 2000);
                }).catch(() => {
                    // Fallback
                    document.execCommand('copy');
                    copyBtn.textContent = 'COPIED';
                    setTimeout(() => { copyBtn.textContent = 'COPY'; }, 2000);
                });
            });
        }

        // Preview in new tab
        if (previewBtn) {
            previewBtn.addEventListener('click', () => {
                window.open(getOverlayUrl(), '_blank', 'width=1920,height=200');
            });
        }
    }

    _initSuggestPanel() {
        const panel = document.getElementById('suggest-panel');
        const toggleBtn = document.getElementById('suggest-toggle');
        if (toggleBtn && panel) {
            toggleBtn.addEventListener('click', () => {
                panel.classList.toggle('hidden');
                if (!panel.classList.contains('hidden') && this.smartRecommend) {
                    // Render suggestions for current playing deck
                    const deck = this.decks.A.isPlaying ? this.decks.A : (this.decks.B.isPlaying ? this.decks.B : null);
                    if (deck && deck.metadata) {
                        const current = {
                            title: deck.metadata.metadata?.title,
                            artist: deck.metadata.metadata?.artist,
                            bpm: deck.metadata.metadata?.bpm,
                            key: deck.metadata.metadata?.key,
                            genre: deck.metadata.metadata?.genre,
                        };
                        const allTracks = [...this.library.tracks, ...this.library.audiusTracks, ...this.library.soundcloudTracks];
                        this.smartRecommend.renderSuggestions(current, allTracks, (track, deckId) => {
                            this.library.loadToDeck(track, deckId);
                        });
                    }
                }
            });
        }
    }

    // Play the mix through the controller's own outputs (master on 1/2, headphones on 3/4).
    // The DDJ is a sound card too; until the app picks it, the sound stays on the laptop.
    // Returns 'four', 'stereo', 'hidden', 'not-found', 'blocked' or 'unsupported'.
    async routeAudioToController(fromClick = false) {
        const md = navigator.mediaDevices;
        const ctx = this.audioRouter.getAudioContext();
        if (!md?.enumerateDevices || !ctx.setSinkId) return 'unsupported';
        const list = async () => (await md.enumerateDevices()).filter(d => d.kind === 'audiooutput');
        let outs = await list();
        if (fromClick && outs.every(d => !d.label)) {
            // The browser hides device names until the page has been allowed audio input once.
            try {
                const s = await md.getUserMedia({ audio: true });
                s.getTracks().forEach(t => t.stop());
                outs = await list();
            } catch (e) {
                return 'blocked';
            }
        }
        const dev = outs.find(d => /ddj|pioneer/i.test(d.label));
        if (!dev) return outs.some(d => d.label) ? 'not-found' : 'hidden';
        try {
            await ctx.setSinkId(dev.deviceId);
        } catch (e) {
            console.warn('[AudioOutput] Could not switch to the controller:', e);
            return 'blocked';
        }
        const select = document.getElementById('audio-output-select');
        if (select) select.value = dev.deviceId;
        console.log('[AudioOutput] Playing through the controller:', dev.label);
        return this.audioRouter.enableControllerOutputs() ? 'four' : 'stereo';
    }

    _initControllerButtons() {
        const guide = document.getElementById('guide-overlay');
        const showGuide = (on) => guide?.classList.toggle('hidden', !on);
        document.getElementById('guide-btn')?.addEventListener('click', () => showGuide(true));
        document.getElementById('guide-close')?.addEventListener('click', () => showGuide(false));
        document.getElementById('guide-backdrop')?.addEventListener('click', () => showGuide(false));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') showGuide(false); });

        const lightsBtn = document.getElementById('midi-lights');
        const audioBtn = document.getElementById('midi-audio');
        const paintLights = () => {
            if (!lightsBtn) return;
            const on = !!this.lights?.enabled;
            lightsBtn.textContent = on ? 'LIGHTS ON' : 'LIGHTS OFF';
            lightsBtn.classList.toggle('active', on);
        };
        lightsBtn?.addEventListener('click', () => { this.lights?.setEnabled(!this.lights.enabled); paintLights(); });
        paintLights();
        const said = {
            four: 'DECK AUDIO ON', stereo: 'DECK AUDIO ON', hidden: 'DECK AUDIO', 'not-found': 'NO DECK FOUND',
            blocked: 'AUDIO BLOCKED', unsupported: 'NOT SUPPORTED',
        };
        this._paintDeckAudio = (result) => {
            if (!audioBtn) return;
            audioBtn.textContent = said[result] || 'DECK AUDIO';
            audioBtn.classList.toggle('active', result === 'four' || result === 'stereo');
        };
        audioBtn?.addEventListener('click', async () => {
            if (audioBtn.classList.contains('active')) {
                // Back to the laptop's own output. The four channel wiring only fits the
                // controller, so the page reloads to rebuild a plain stereo path.
                localStorage.setItem('mixz-deck-audio', 'off');
                const ctx = this.audioRouter.getAudioContext();
                try { await ctx.setSinkId(''); } catch (e) { /* already on the default */ }
                if (this.audioRouter._mainOut) { location.reload(); return; }
                this._paintDeckAudio('hidden');
                return;
            }
            localStorage.setItem('mixz-deck-audio', 'on');
            this._paintDeckAudio(await this.routeAudioToController(true));
        });
    }

    _initAudioOutput() {
        const select = document.getElementById('audio-output-select');
        const refreshBtn = document.getElementById('audio-output-refresh');
        const panel = document.getElementById('audio-output-panel');

        if (!select) return;

        const populateDevices = async () => {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const outputs = devices.filter(d => d.kind === 'audiooutput');
                select.innerHTML = '';
                outputs.forEach(device => {
                    const opt = document.createElement('option');
                    opt.value = device.deviceId;
                    opt.textContent = device.label || `Output ${select.options.length + 1}`;
                    select.appendChild(opt);
                });
                if (panel && outputs.length > 1) panel.classList.remove('hidden');
            } catch (e) {
                console.warn('[AudioOutput] Cannot enumerate devices:', e);
            }
        };

        select.addEventListener('change', async () => {
            const deviceId = select.value;
            try {
                // Set output device on all audio elements
                const audioEls = document.querySelectorAll('audio');
                for (const el of audioEls) {
                    if (el.setSinkId) await el.setSinkId(deviceId);
                }
                // Also set on the audio context destination if supported
                const ctx = this.audioRouter.getAudioContext();
                if (ctx.setSinkId) await ctx.setSinkId(deviceId);
                console.log('[AudioOutput] Switched to device:', select.options[select.selectedIndex]?.textContent);
            } catch (e) {
                console.warn('[AudioOutput] Failed to switch device:', e);
            }
        });

        if (refreshBtn) refreshBtn.addEventListener('click', populateDevices);

        // Populate on load
        populateDevices();
        navigator.mediaDevices?.addEventListener('devicechange', populateDevices);
    }

    _initAudioContextResume() {
        const resumeOnce = () => {
            this.audioRouter.resume();
            document.removeEventListener('click', resumeOnce);
            document.removeEventListener('keydown', resumeOnce);
        };
        document.addEventListener('click', resumeOnce);
        document.addEventListener('keydown', resumeOnce);
    }

    _initTravelControls() {
        // Travel mode play buttons
        document.getElementById('travel-play-a')?.addEventListener('click', () => {
            this.audioRouter.resume();
            this.decks.A.playPause();
        });
        document.getElementById('travel-play-b')?.addEventListener('click', () => {
            this.audioRouter.resume();
            this.decks.B.playPause();
        });

        // Travel crossfader — synced with main crossfader
        const travelCF = document.getElementById('travel-crossfader');
        const mainCF = document.getElementById('crossfader');
        if (travelCF && mainCF) {
            travelCF.addEventListener('input', (e) => {
                mainCF.value = e.target.value;
                mainCF.dispatchEvent(new Event('input', { bubbles: true }));
            });
            // Sync main -> travel
            mainCF.addEventListener('input', () => {
                travelCF.value = mainCF.value;
            });
        }

        // Travel auto-mix button
        document.getElementById('travel-automix-btn')?.addEventListener('click', () => {
            this.audioRouter.resume();
            if (this.flowMode) this.flowMode.toggle();
        });

        // Travel offline section
        document.getElementById('travel-offline-close')?.addEventListener('click', () => {
            document.getElementById('travel-offline-section')?.classList.add('hidden');
        });
    }

    _updateTravelDisplay(deck) {
        const id = deck.id.toLowerCase();
        const meta = deck.metadata?.metadata || {};

        const titleEl = document.getElementById(`travel-${id}-title`);
        const bpmEl = document.getElementById(`travel-${id}-bpm`);
        const keyEl = document.getElementById(`travel-${id}-key`);

        if (titleEl) titleEl.textContent = meta.title || deck.metadata?.title || '--';
        if (bpmEl) bpmEl.textContent = meta.bpm ? `${meta.bpm} BPM` : '--- BPM';
        if (keyEl) keyEl.textContent = meta.key || '--';

        // Update play button state
        const playBtn = document.getElementById(`travel-play-${id}`);
        if (playBtn) {
            const playIcon = playBtn.querySelector('.icon-play');
            const pauseIcon = playBtn.querySelector('.icon-pause');
            if (playIcon && pauseIcon) {
                playIcon.classList.toggle('hidden', deck.isPlaying);
                pauseIcon.classList.toggle('hidden', !deck.isPlaying);
            }
        }
    }

    _onLoadTrack(deckId, dataFile) {
        if (!deckId) {
            deckId = !this.decks.A.isLoaded ? 'A' : (!this.decks.B.isLoaded ? 'B' : 'A');
        }
        const deck = this.decks[deckId];
        if (!deck) return;

        // Visual polish: add loading shimmer
        const deckEl = document.getElementById(`deck-${deckId.toLowerCase()}`);
        if (deckEl) deckEl.classList.add('loading');

        this.audioRouter.resume();
        deck.loadTrack(dataFile).then((ok) => { if (ok) this._logLocalLoad(deckId, deck, dataFile); });
    }

    // Logged only once the deck took the track: a refused (unlicensed) track is not in the set.
    _logLocalLoad(deckId, deck, dataFile) {
        const trackName = dataFile.split('/').pop().replace('.json', '');

        // Extract metadata from deck (BPM/key may be populated later by auto-detect)
        const bpm = deck.getBPM();
        const key = deck.getKey();

        // Log to setlist with full metadata
        if (this.setlist) {
            const known = (this.library?.tracks || []).find(t => t.dataFile === dataFile);
            this.setlist.logPlay(known?.title || trackName, known?.artist || '', bpm, key, deckId, { source: 'local', id: dataFile, artwork: known?.artwork || null });
        }

        // Log to recorder cue sheet
        if (this.recorder) {
            this.recorder.logTrackChange(deckId, trackName, '');
        }
    }

    _onLoadDirect(deckId, streamUrl, meta) {
        if (!deckId) {
            deckId = !this.decks.A.isLoaded ? 'A' : (!this.decks.B.isLoaded ? 'B' : 'A');
        }
        const deck = this.decks[deckId];
        if (!deck) return;

        // Visual polish: add loading shimmer
        const deckEl = document.getElementById(`deck-${deckId.toLowerCase()}`);
        if (deckEl) deckEl.classList.add('loading');

        this.audioRouter.resume();
        if (deck.loadDirect(streamUrl, meta) === false) return;

        // Log to setlist with full metadata
        if (this.setlist) {
            this.setlist.logPlay(
                meta.title || 'Unknown',
                meta.artist || '',
                meta.bpm || null,
                meta.key || null,
                deckId,
                { source: meta.source || 'direct', id: meta.id ?? null, artwork: meta.artwork || null, streamUrl }
            );
        }

        // Log to recorder cue sheet
        if (this.recorder) {
            this.recorder.logTrackChange(deckId, meta.title || 'Unknown', meta.artist || '');
        }
    }

    _applyPlaylistFilter() {
        // Re-render library with playlist filter applied
        // The library will check playlists.activePlaylist to filter tracks
    }

    _initLibraryBulkActions() {
        const queueBtn = document.getElementById('lib-bulk-queue');
        const playlistBtn = document.getElementById('lib-bulk-playlist');
        const likeBtn = document.getElementById('lib-bulk-like');
        const clearBtn = document.getElementById('lib-bulk-clear');

        if (queueBtn) {
            queueBtn.addEventListener('click', () => this.library.bulkAddToQueue());
        }
        if (playlistBtn) {
            playlistBtn.addEventListener('click', () => this.library.bulkAddToPlaylist());
        }
        if (likeBtn) {
            likeBtn.addEventListener('click', () => this.library.bulkLike());
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.library.selectedIds.clear();
                this.library._updateBulkBar();
                this.library._renderCurrentPage();
            });
        }
    }

    _initLibrarySelectAll() {
        const selectAllCb = document.getElementById('lib-select-all');
        if (!selectAllCb) return;

        selectAllCb.addEventListener('change', () => {
            const tracks = this.library._displayedTracks;
            const start = (this.library.currentPage - 1) * this.library.pageSize;
            const end = Math.min(start + this.library.pageSize, tracks.length);
            const pageSlice = tracks.slice(start, end);

            if (selectAllCb.checked) {
                pageSlice.forEach(t => {
                    this.library.selectedIds.add(this.library._getTrackKey(t));
                });
            } else {
                pageSlice.forEach(t => {
                    this.library.selectedIds.delete(this.library._getTrackKey(t));
                });
            }
            this.library._updateBulkBar();
            this.library._renderCurrentPage();
        });
    }

    _initCrashRecovery() {
        if (!this.crashRecovery) return;
        if (this.crashRecovery.hasRecoveryData()) {
            const data = this.crashRecovery.getRecoveryData();
            if (data) {
                console.log('Recovery data available from', new Date(data.timestamp).toLocaleString());
                // Restore crossfader position
                if (data.crossfader != null) {
                    const cf = document.getElementById('crossfader');
                    if (cf) {
                        cf.value = data.crossfader;
                        this.audioRouter.setCrossfade(data.crossfader / 100);
                    }
                }
            }
        }

        // Start auto-saving
        this.crashRecovery.startAutoSave(() => {
            return {
                crossfader: parseFloat(document.getElementById('crossfader')?.value || 50),
                volumeA: parseFloat(document.getElementById('vol-a')?.value || 80),
                volumeB: parseFloat(document.getElementById('vol-b')?.value || 80),
                masterVolume: parseFloat(document.getElementById('master-volume')?.value || 80),
            };
        });
    }

    _loadSettings() {
        // Restore MIDI mappings
        const midiMappings = this.storage.loadMidiMappings();
        if (midiMappings && Object.keys(midiMappings).length > 0 && this.midi) {
            this.midi.mappings = midiMappings;
        }

        // Restore preferences
        const prefs = this.storage.loadPreferences();
        if (prefs.quantize) {
            this.decks.A.quantize = true;
            this.decks.B.quantize = true;
            document.getElementById('quantize-toggle')?.classList.add('active');
        }
    }

    // ===== TAPE STOP EFFECT =====

    _initTapeStopListener() {
        document.addEventListener('tapestop', (e) => {
            const { deckId, duration, action } = e.detail;
            const deck = this.decks[deckId];
            if (!deck || !deck.isLoaded || !deck.wavesurfer) return;

            if (action === 'stop') {
                // Gradually slow down playback to simulate tape stopping
                const startRate = deck.currentRate || 1;
                const steps = 30;
                const interval = (duration * 1000) / steps;
                let step = 0;

                const slowDown = setInterval(() => {
                    step++;
                    const progress = step / steps;
                    // Ease-in curve for natural tape stop feel
                    const rate = startRate * (1 - progress * progress);
                    try {
                        deck.wavesurfer.setPlaybackRate(Math.max(0.01, rate));
                    } catch (err) { /* ignore */ }

                    if (step >= steps) {
                        clearInterval(slowDown);
                        try {
                            deck.wavesurfer.pause();
                        } catch (err) { /* ignore */ }
                    }
                }, interval);
            } else if (action === 'resume') {
                // Spin back up
                const targetRate = deck.currentRate || 1;
                try {
                    deck.wavesurfer.play();
                } catch (err) { /* ignore */ }
                const steps = 20;
                const interval = (duration * 1000) / steps;
                let step = 0;

                const speedUp = setInterval(() => {
                    step++;
                    const progress = step / steps;
                    const rate = targetRate * progress;
                    try {
                        deck.wavesurfer.setPlaybackRate(Math.max(0.01, rate));
                    } catch (err) { /* ignore */ }

                    if (step >= steps) {
                        clearInterval(speedUp);
                        try {
                            deck.wavesurfer.setPlaybackRate(targetRate);
                        } catch (err) { /* ignore */ }
                    }
                }, interval);
            }
        });
    }

    // ===== STREAM CHAT =====

    // Words the DJ never wants on the stream, one per line in localStorage 'mixz-chat-block'
    _chatBlocked() {
        try { return String(localStorage.getItem('mixz-chat-block') || '').split(/\n|,/).map((w) => w.trim()).filter(Boolean); } catch (e) { return []; }
    }

    _onStreamChatMessage(msg) {
        // Only a line the filter passes becomes a chat.message stream event (docs/STREAM-EVENTS.md)
        const blocked = this._chatBlocked();
        const line = moderate(msg.message, { blocked }), who = moderate(msg.user, { blocked });
        if (line.ok && who.ok) {
            this.streamEvents?.emit?.('chat.message', { platform: msg.platform === 'youtube' ? 'youtube' : 'twitch', user: who.text.slice(0, 40), text: line.text });
            this.streamView?.addChat?.({ user: who.text.slice(0, 40), text: line.text.slice(0, 200), color: msg.color });
        }
        const list = document.getElementById('chat-messages');
        if (!list) return;

        const el = document.createElement('div');
        el.className = 'chat-msg';
        el.dataset.platform = msg.platform;

        const tag = document.createElement('span');
        tag.className = 'platform-tag ' + (msg.platform === 'twitch' ? 'twitch-tag' : 'yt-tag');
        tag.textContent = msg.platform === 'twitch' ? 'TW' : 'YT';
        el.appendChild(tag);

        const userSpan = document.createElement('span');
        userSpan.className = 'chat-user';
        userSpan.style.color = msg.color || 'var(--accent-a)';
        userSpan.textContent = msg.user;
        el.appendChild(userSpan);

        el.appendChild(document.createTextNode(' ' + msg.message));

        list.appendChild(el);
        list.scrollTop = list.scrollHeight;
        while (list.children.length > 100) list.firstChild.remove();
    }

    _onStreamSongRequest(request) {
        // Onto the request line, moderated and matched to a track; it waits for PLAY NEXT
        try { this.remote?.chatRequest?.(request, this._chatBlocked()); } catch (e) { console.warn('chat request failed:', e); }
        const list = document.getElementById('requests-list');
        if (!list) return;
        const el = document.createElement('div');
        el.className = 'request-item';
        el.textContent = `[${request.platform.toUpperCase()}] ${request.user}: ${request.query}`;
        list.prepend(el);
        while (list.children.length > 20) list.lastChild.remove();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('%c[AURDOUR DJ] Initializing...', 'background:#00d4ff;color:#000;padding:4px 12px;border-radius:4px;font-weight:bold;font-size:14px');
    const player = new DJPlayer();
    window._djPlayer = player; // expose for console debugging

    console.log('%c[AURDOUR DJ] Ready!', 'background:#00ff88;color:#000;padding:4px 12px;border-radius:4px;font-weight:bold;font-size:14px');
    console.log(`[AUDIO:INIT] AudioContext state: ${player.audioRouter.ctx.state}`);
    console.log(`[AUDIO:INIT] Sample rate: ${player.audioRouter.ctx.sampleRate}Hz`);
    console.log(`[AUDIO:INIT] Output: ${player.audioRouter.ctx.destination.channelCount}ch → default device`);
    console.log(`[AUDIO:INIT] Master gain: ${player.audioRouter.masterGain.gain.value}`);
    console.log(`[AUDIO:INIT] Crossfader curve: ${player.audioRouter.crossfaderCurve}`);
    console.log('');
    console.log('%c HOW TO LOAD AUDIO:', 'color:#ffd54f;font-weight:bold;font-size:12px');
    console.log('  1. Click the LOAD button on Deck A or B');
    console.log('  2. Or drag & drop an audio file onto a deck');
    console.log('  3. Or use the library at the bottom (if tracks are in manifest)');
    console.log('  4. For system audio: click CAPTURE in the System Audio section');
    console.log('  5. For mic: click CONNECT in the Mic section');
    console.log('');
    console.log('%c PIONEER DDJ-SB3 MIDI:', 'color:#e040fb;font-weight:bold;font-size:12px');
    console.log('  Controller is MIDI-only (no USB audio routing)');
    console.log('  Audio plays through your Mac default output');
    console.log('  All knobs/faders/buttons/pads control the software');
    console.log('');
    console.log('  Tip: Use window._djPlayer in console to inspect state');
});
