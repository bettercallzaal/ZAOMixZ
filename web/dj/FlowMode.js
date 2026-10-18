// FlowMode.js — Smart Auto-DJ for non-DJs
// Auto-mixes tracks with smart suggestions, one-button play, clean overlay UI
// Supports both local tracks (dataFile) and streaming tracks (streamUrl)

import { canPlay } from './Licence.js';
import { esc } from './Html.js';

export class FlowMode {
    constructor(djPlayer) {
        this.dj = djPlayer;
        this.enabled = false;
        this.queue = []; // upcoming tracks (local + streaming)
        this.currentDeck = 'A';
        this.currentTrack = null;
        this.transitionPoint = 30; // seconds before end to start transition
        this.transitionPointMode = 'fixed'; // 'fixed' (seconds) or 'percent' (% of track length)
        this.transitionPointPercent = 10; // percentage of track length for transition trigger
        this.transitionDuration = 8; // crossfade length in seconds
        this.transitionType = 'blend'; // blend, echo-out, cut, filter-sweep
        this.playedInSession = []; // track IDs already played
        this.suggestions = [];
        this._transitioning = false;
        this._progressInterval = null;
        this._nearEndTriggered = false; // our own near-end flag (independent of Deck's)
        this._mixToken = 0; // moves on whenever a handover is given up, so its wait for the deck stops
        this.onTrackDropped = null; // told about a song that would not load, so DJ MixZ can take it out of its plan
    }

    enable() {
        this.enabled = true;
        this._buildUI();
        document.getElementById('flow-panel')?.classList.remove('hidden');
        document.getElementById('flow-toggle-btn')?.classList.add('active');

        // Populate initial suggestions from library (including streaming tracks)
        this._populateSuggestions();
    }

    disable() {
        this.enabled = false;
        document.getElementById('flow-panel')?.classList.add('hidden');
        document.getElementById('flow-toggle-btn')?.classList.remove('active');
        this._stopProgressUpdates();
        this.cancelTransition();
    }

    // Stop waiting on a handover that is under way. Whatever is playing keeps playing.
    // DJ MixZ calls this when a person takes the decks; a cancelled mix lands here too.
    cancelTransition() {
        this._mixToken++;
        this._transitioning = false;
    }

    // Called by player.js when AutoTransition is cancelled mid-mix (CANCEL on AUTO, or takeover).
    // The crossfader says where the mix was left: past halfway the incoming song is the one the
    // room hears, so it becomes the current song. Before halfway it stays next; it has already
    // gone in the setlist, so it is not logged again, and its deck is reused when it mixes in.
    onTransitionCancelled() {
        const mix = this._mixing;
        this._mixing = null;
        this.cancelTransition();
        if (!mix) return;
        const xf = parseFloat(document.getElementById('crossfader')?.value);
        const into = Number.isFinite(xf) ? (mix.direction === 'AtoB' ? xf / 100 : 1 - xf / 100) : 0;
        this._aired = mix;
        if (into >= 0.5) this.onTransitionComplete(mix.direction);
    }

    toggle() {
        if (this.enabled) this.disable();
        else this.enable();
    }

    // Load a track to a deck — handles both local (dataFile) and streaming (streamUrl)
    _loadTrackToDeck(deck, track) {
        if (track.streamUrl || track.source === 'audius' || track.source === 'soundcloud' || track.source === 'spotify') {
            // Streaming track — use loadDirect
            const streamUrl = track.streamUrl;
            if (!streamUrl) {
                console.warn('[FlowMode] Streaming track missing streamUrl:', track.title);
                return false;
            }
            const meta = {
                title: track.title || 'Unknown',
                artist: track.artist || '',
                bpm: track.bpm || null,
                key: track.key || null,
                genre: track.genre || null,
                artwork: track.artwork || null,
                source: track.source || 'stream',
                id: track.id || track.sourceId || null,
                // The deck checks the licence on this meta (Licence.js canPlay): a track's own
                // licence, its Audius Creative Commons licence and its uploader must come with it,
                // as they do when the library loads a track by hand.
                licence: track.licence || null,
                audiusLicense: track.audiusLicense || null,
                uploader: track.uploader || null,
            };
            return deck.loadDirect(streamUrl, meta) !== false;
        } else if (track.dataFile) {
            // Local track — use loadTrack. The manifest entry carries the licence, so an
            // unlicensed track is skipped here rather than refused after the handover started.
            if (!canPlay(track).ok) return false;
            deck.loadTrack(track.dataFile);
            return true;
        } else {
            console.warn('[FlowMode] Track has neither dataFile nor streamUrl:', track.title);
            return false;
        }
    }

    // The setlist (and so the mix link) must see what DJ MixZ and Flow play, not only hand loads.
    // Logged when the song goes on air, so a song that never loaded is not in the mix link.
    _logPlay(deckId, track) {
        if (track.dataFile && !track.streamUrl) {
            this.dj.setlist?.logPlay(track.title || track.dataFile.split('/').pop().replace('.json', ''), track.artist || '', track.bpm || null, track.key || null, deckId, { source: 'local', id: track.dataFile, artwork: track.artwork || null });
        } else {
            const meta = { title: track.title || 'Unknown', artist: track.artist || '', bpm: track.bpm || null, key: track.key || null, genre: track.genre || null, artwork: track.artwork || null, source: track.source || 'stream', id: track.id || track.sourceId || null };
            this.dj.setlist?.logPlay(meta.title, meta.artist, meta.bpm, meta.key, deckId, { ...meta, streamUrl: track.streamUrl });
        }
        this.dj.recorder?.logTrackChange?.(deckId, track.title || 'Unknown', track.artist || '');
    }

    start(track) {
        if (!track) return;

        this.currentTrack = track;
        this.currentDeck = 'A';
        this.playedInSession.push(track.id || track.title);
        this._transitioning = false;
        this._nearEndTriggered = false;

        // Reset crossfader to deck A side
        const cf = document.getElementById('crossfader');
        if (cf) { cf.value = 0; }
        this.dj.audioRouter.setCrossfade(0);

        // Load and play on deck A. Loading alone left the first song sitting at 0:00, so
        // press play once it is ready; a song that will not load hands over to the next one.
        this.dj.audioRouter.resume();
        const deckA = this.dj.decks.A;
        if (this._loadTrackToDeck(deckA, track) === false) { this._startNext(); return; }
        this._playWhenReady(deckA, track);

        // Auto-suggest next tracks
        this._suggestNext();
        this._autoFillQueue();
        this._updateUI();
        this._startProgressUpdates();
    }

    // Start deck playback as soon as its song has loaded; on a load error try the next song.
    // The song goes in the setlist here, once it has loaded, not when its load starts.
    _playWhenReady(deck, track) {
        const ws = deck.wavesurfer;
        if (!ws) return;
        const token = (this._startToken = (this._startToken || 0) + 1);
        // ready and error are each registered once, and the one that does not fire stays on the
        // deck: an error on a later song must not restart the set. Whichever comes first wins.
        let settled = false;
        const go = () => {
            if (settled || token !== this._startToken || !this.enabled) return;
            settled = true;
            this.dj.audioRouter.resume();
            if (!deck.isPlaying) deck.play();
            this._logPlay(deck.id, track);
        };
        if (deck.isLoaded && ws.getDuration() > 0) { go(); return; }
        ws.once('ready', go);
        ws.once('error', () => {
            if (settled || token !== this._startToken || !this.enabled || deck.isPlaying) return;
            settled = true;
            console.warn('[FlowMode] First song would not load, trying the next one');
            this._startNext();
        });
    }

    _startNext() {
        if (this.currentTrack) {
            // It never played: take it back out of the played list
            const at = this.playedInSession.lastIndexOf(this.currentTrack.id || this.currentTrack.title);
            if (at >= 0) this.playedInSession.splice(at, 1);
            this.onTrackDropped?.(this.currentTrack);
        }
        this._startFails = (this._startFails || 0) + 1;
        if (this._startFails > 5 || this.queue.length === 0) { this._startFails = 0; return; }
        this.start(this.queue.shift());
    }

    skip() {
        // A second skip mid-mix reloaded the deck coming in and stopped both: one mix at a time.
        if (this.queue.length === 0 || this._transitioning) return;
        this._triggerTransition();
    }

    removeFromQueue(index) {
        this.queue.splice(index, 1);
        this._updateUI();
    }

    addToQueue(track) {
        if (!track) return;
        this.queue.push(track);
        this._updateUI();
    }

    // Calculate the dynamic transition trigger point for the current track
    _getTransitionTriggerTime() {
        const deck = this.dj.decks[this.currentDeck];
        if (!deck || !deck.isLoaded) return this.transitionPoint;

        const duration = deck.getDuration();
        if (duration <= 0) return this.transitionPoint;

        if (this.transitionPointMode === 'percent') {
            // Use percentage of track length
            const triggerSeconds = (this.transitionPointPercent / 100) * duration;
            // Clamp: at least 5 seconds, at most 90% of the track
            return Math.max(5, Math.min(triggerSeconds, duration * 0.9));
        }

        // Fixed mode: use transitionPoint but clamp to track length
        // For short tracks (< 2x transition point), use 25% of track length
        if (duration < this.transitionPoint * 2) {
            return Math.max(5, duration * 0.25);
        }
        return this.transitionPoint;
    }

    // Called by player.js on every timeupdate — we do our own near-end detection
    onTimeUpdate(deck) {
        if (!this.enabled) return;
        if (deck.id !== this.currentDeck) return;
        if (this._transitioning) return;
        if (this._nearEndTriggered) return;
        if (!deck.isLoaded) return;

        const currentTime = deck.getCurrentTime();
        const duration = deck.getDuration();
        if (duration <= 0) return;

        const remaining = duration - currentTime;
        const triggerPoint = this._getTransitionTriggerTime();

        if (remaining <= triggerPoint && remaining > 0) {
            this._nearEndTriggered = true;
            this._triggerTransition();
        }
    }

    // Called by player.js when a deck's track nears its end (Deck's hardcoded 30s)
    // Kept as fallback, but we now prefer onTimeUpdate for dynamic detection
    onTrackNearEnd(deck) {
        if (!this.enabled) return;
        if (deck.id !== this.currentDeck) return;
        if (this._transitioning) return;
        // Ahead of our own trigger point (DJ MixZ arms a shorter one for short moves) the
        // deck's fixed 30s call is early: onTimeUpdate starts the handover when it is due.
        // At the end of the track (onFinish) it always goes.
        const remaining = deck.getDuration() - deck.getCurrentTime();
        if (remaining > this._getTransitionTriggerTime() + 0.5) return;

        this._triggerTransition();
    }

    // Called by player.js when auto-transition finishes
    onTransitionComplete(direction) {
        if (!this.enabled) return;

        // Swap current deck
        this.currentDeck = this.currentDeck === 'A' ? 'B' : 'A';
        this._mixing = null;
        this._aired = null;
        this._transitioning = false;
        this._nearEndTriggered = false;

        // The now-playing track is the first item that was in the queue
        if (this.queue.length > 0) {
            this.currentTrack = this.queue.shift();
        }

        // Refresh suggestions and auto-fill queue
        this._suggestNext();
        this._autoFillQueue();
        this._updateUI();
    }

    _triggerTransition() {
        if (this.queue.length === 0) {
            this._autoFillQueue();
            // Nothing to mix into yet: leave the near-end trigger free, so a song added
            // before this one ends still gets mixed in.
            if (this.queue.length === 0) { this._nearEndTriggered = false; return; }
        }

        this._transitioning = true;
        const token = ++this._mixToken;
        const nextTrack = this.queue[0];
        const idleDeck = this.currentDeck === 'A' ? 'B' : 'A';
        const direction = this.currentDeck === 'A' ? 'AtoB' : 'BtoA';

        // The idle deck may still hold the track it played last time. Stop it and mark it empty,
        // or the wait below sees the OLD track as ready and starts the mix before the new one
        // has loaded (the new track then lands silent at 0:00).
        const incoming = this.dj.decks[idleDeck];
        // A mix into this song was cancelled early: its deck still holds it, so mix it in
        // from where it is instead of reloading it (no gap at the end of the track).
        const reuse = this._aired?.track === nextTrack && this._aired.deck === idleDeck && incoming.isLoaded;
        if (!reuse) {
            if (incoming.isPlaying) { try { incoming.pause(); } catch (e) { /* not fatal */ } }
            incoming.isLoaded = false;
        }

        // Load next track to idle deck (handles both local and streaming).
        // A refused track (no licence) leaves the queue and the current song keeps playing.
        if (!reuse && this._loadTrackToDeck(incoming, nextTrack) === false) {
            this._dropNext(nextTrack);
            this._autoFillQueue();
            this._updateUI();
            return;
        }

        // Wait for deck to be ready, then start transition
        let retries = 0;
        const maxRetries = 250; // 25 seconds: streams load slowly on a weak connection
        const checkReady = () => {
            // Given up on (takeover, cancel, exit): a song that loads now must not start a mix
            if (token !== this._mixToken || !this.enabled) return;
            if (retries++ > maxRetries) {
                // A song that never loads used to stall the set here for good, the same song
                // retried at every near-end. Drop it and go straight to the one after.
                console.warn('[FlowMode] Deck load timed out, skipping', nextTrack.title);
                this._dropNext(nextTrack);
                this._loadFails = (this._loadFails || 0) + 1;
                if (this._loadFails <= 3 && this.queue.length) this._triggerTransition();
                else this._loadFails = 0;
                this._updateUI();
                return;
            }
            if (!incoming.isLoaded) { setTimeout(checkReady, 100); return; }
            this._loadFails = 0;
            this._beginMix(idleDeck, direction, nextTrack);
        };
        checkReady();
    }

    // A song that would not load leaves the queue (and DJ MixZ's plan) unplayed, and frees the
    // near-end trigger, so the next timeupdate tries the song after it while this one still plays.
    _dropNext(track) {
        if (this.queue[0] === track) this.queue.shift();
        this.cancelTransition();
        this._nearEndTriggered = false;
        this.onTrackDropped?.(track);
    }

    // Hand the next song to the mix engine. With no engine, or one that throws, cut to it:
    // the set must never sit with the next song loaded and silent.
    _beginMix(idleDeck, direction, track) {
        const engine = this.dj.autoTransition;
        if (engine?.running) {
            // A mix someone started by hand is still going: leave it alone, try again at the end
            console.warn('[FlowMode] A mix is already running, not starting another');
            this.cancelTransition();
            return;
        }
        if (engine) {
            try {
                engine.startProgrammatic(direction, this.transitionDuration, {
                    type: this.transitionType,
                    sourceBPM: this.dj.decks[this.currentDeck].getBPM(),
                    targetBPM: this.dj.decks[idleDeck].getBPM(),
                });
                if (engine.running) { this._mixing = { track, deck: idleDeck, direction }; this._markPlayed(idleDeck, track); return; }
            } catch (e) {
                console.warn('[FlowMode] Mix engine failed, cutting to the next song instead:', e);
                try { engine.cancel?.(); } catch (e2) { /* already stopped */ }
            }
        }
        this._cut(idleDeck, direction, track);
    }

    _cut(idleDeck, direction, track) {
        const from = this.dj.decks[this.currentDeck];
        const to = this.dj.decks[idleDeck];
        const end = direction === 'AtoB' ? 1 : 0;
        this.dj.audioRouter.resume?.();
        if (!to.isPlaying) to.play();
        this.dj.audioRouter.setCrossfade(end);
        const cf = document.getElementById('crossfader');
        if (cf) cf.value = end * 100;
        if (from.isPlaying) from.pause();
        this._markPlayed(idleDeck, track);
        this.onTransitionComplete(direction);
    }

    // The song is on air: only now does it count as played and go in the setlist.
    _markPlayed(deckId, track) {
        if (this._aired?.track === track) return; // already on air once, in a mix that was cancelled
        this.playedInSession.push(track.id || track.title);
        this._logPlay(deckId, track);
    }

    // Gather ALL available tracks — local + Audius + SoundCloud + Spotify
    _getAllTracks() {
        const lib = this.dj.library;
        if (!lib) return [];

        const all = [];

        // Local manifest tracks
        if (lib.tracks && lib.tracks.length > 0) {
            all.push(...lib.tracks);
        }

        // Audius streaming tracks
        if (lib.audiusTracks && lib.audiusTracks.length > 0) {
            all.push(...lib.audiusTracks);
        }

        // SoundCloud streaming tracks
        if (lib.soundcloudTracks && lib.soundcloudTracks.length > 0) {
            all.push(...lib.soundcloudTracks);
        }

        // Spotify streaming tracks
        if (lib.spotifyTracks && lib.spotifyTracks.length > 0) {
            all.push(...lib.spotifyTracks);
        }

        // Only tracks with a licence go into the auto DJ's pool (Zaal, 16 Oct 2026).
        return all.filter((t) => canPlay(t).ok);
    }

    _suggestNext() {
        if (!this.currentTrack || !this.dj.library) {
            this.suggestions = [];
            return;
        }

        const allTracks = this._getAllTracks();
        const playedSet = new Set(this.playedInSession);
        const queuedSet = new Set(this.queue.map(t => t.id || t.title));

        // Build a currentTrack-like object for getRelatedTracks
        const current = {
            id: this.currentTrack.id || this.currentTrack.title,
            bpm: this.currentTrack.bpm,
            key: this.currentTrack.key,
            genre: this.currentTrack.genre,
        };

        // Try to use playlist-based related track lookup if available
        let related = [];
        if (this.dj.playlists && typeof this.dj.playlists.getRelatedTracks === 'function') {
            related = this.dj.playlists.getRelatedTracks(current, allTracks, this.dj.harmonic);
        }

        // Filter out played and queued tracks
        this.suggestions = related.filter(t => {
            const tid = t.id || t.title;
            return !playedSet.has(tid) && !queuedSet.has(tid);
        });

        // If no compatible tracks from playlists, do our own BPM/key scoring
        if (this.suggestions.length === 0) {
            const scored = allTracks
                .filter(t => {
                    const tid = t.id || t.title;
                    return !playedSet.has(tid) && !queuedSet.has(tid);
                })
                .map(t => {
                    let score = 0;

                    // BPM compatibility (within 5% = high score, 10% = medium)
                    if (current.bpm && t.bpm) {
                        const ratio = t.bpm / current.bpm;
                        if (ratio >= 0.95 && ratio <= 1.05) score += 3;
                        else if (ratio >= 0.9 && ratio <= 1.1) score += 1;
                        // Also check half/double time
                        else if (ratio >= 1.9 && ratio <= 2.1) score += 2;
                        else if (ratio >= 0.45 && ratio <= 0.55) score += 2;
                    }

                    // Key compatibility
                    if (this.dj.harmonic && current.key && t.key) {
                        if (this.dj.harmonic.isCompatible(current.key, t.key)) score += 2;
                    }

                    // Genre match
                    if (current.genre && t.genre && current.genre === t.genre) score += 1;

                    return { track: t, score };
                })
                .sort((a, b) => b.score - a.score);

            this.suggestions = scored.slice(0, 10).map(s => s.track);
        }
    }

    _autoFillQueue() {
        // Keep at least 1 track in queue
        if (this.queue.length === 0 && this.suggestions.length > 0) {
            this.queue.push(this.suggestions.shift());
        }
    }

    _populateSuggestions() {
        // On initial enable, show all available tracks as suggestions (local + streaming)
        if (!this.dj.library) return;
        const allTracks = this._getAllTracks();
        if (this.currentTrack) {
            this._suggestNext();
        } else {
            this.suggestions = [...allTracks].slice(0, 10);
        }
        this._updateUI();
    }

    _getCompatibilityBadges(track) {
        if (!this.currentTrack) return [];
        const badges = [];

        // Source badge for streaming tracks
        if (track.source === 'audius') {
            badges.push({ label: 'AUDIUS', type: 'source' });
        } else if (track.source === 'soundcloud') {
            badges.push({ label: 'SC', type: 'source' });
        } else if (track.source === 'spotify') {
            badges.push({ label: 'SPOTIFY', type: 'source' });
        }

        // BPM compatibility
        if (this.currentTrack.bpm && track.bpm) {
            const ratio = track.bpm / this.currentTrack.bpm;
            if (ratio >= 0.95 && ratio <= 1.05) {
                badges.push({ label: 'BPM', type: 'bpm' });
            }
        }

        // Key compatibility
        if (this.dj.harmonic && this.currentTrack.key && track.key) {
            if (this.dj.harmonic.isCompatible(this.currentTrack.key, track.key)) {
                badges.push({ label: 'KEY', type: 'key' });
            }
        }

        // Genre match
        if (this.currentTrack.genre && track.genre && this.currentTrack.genre === track.genre) {
            badges.push({ label: track.genre, type: 'genre' });
        }

        return badges;
    }

    _startProgressUpdates() {
        this._stopProgressUpdates();
        this._progressInterval = setInterval(() => {
            if (!this.enabled) return;
            this._updateProgress();
        }, 500);
    }

    _stopProgressUpdates() {
        if (this._progressInterval) {
            clearInterval(this._progressInterval);
            this._progressInterval = null;
        }
    }

    _updateProgress() {
        const deck = this.dj.decks[this.currentDeck];
        if (!deck || !deck.isLoaded) return;

        const current = deck.getCurrentTime();
        const duration = deck.getDuration();
        if (duration <= 0) return;

        const pct = (current / duration) * 100;
        const bar = document.getElementById('flow-progress-bar');
        if (bar) bar.style.width = `${pct}%`;

        const elapsed = document.getElementById('flow-elapsed');
        const remaining = document.getElementById('flow-remaining');
        if (elapsed) elapsed.textContent = this._formatTime(current);
        if (remaining) remaining.textContent = `-${this._formatTime(duration - current)}`;

        // Show transition trigger zone on progress bar
        const triggerTime = this._getTransitionTriggerTime();
        const triggerPct = ((duration - triggerTime) / duration) * 100;
        const marker = document.getElementById('flow-trigger-marker');
        if (marker) marker.style.left = `${triggerPct}%`;
    }

    _formatTime(seconds) {
        if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // ===== UI RENDERING =====

    _buildUI() {
        const panel = document.getElementById('flow-panel');
        if (!panel) return;

        panel.innerHTML = `
            <div class="flow-header">
                <div class="flow-title">FLOW MODE</div>
                <button class="flow-exit-btn" id="flow-exit-btn">EXIT</button>
            </div>

            <div class="flow-content">
                <!-- Now Playing -->
                <div class="flow-section">
                    <div class="flow-section-label">NOW PLAYING</div>
                    <div class="flow-now-playing" id="flow-now-playing">
                        <div class="flow-np-info">
                            <div class="flow-np-title" id="flow-np-title">No track loaded</div>
                            <div class="flow-np-artist" id="flow-np-artist"></div>
                            <div class="flow-np-meta">
                                <span class="flow-np-bpm" id="flow-np-bpm"></span>
                                <span class="flow-np-key" id="flow-np-key"></span>
                                <span class="flow-np-genre" id="flow-np-genre"></span>
                            </div>
                        </div>
                        <div class="flow-progress">
                            <div class="flow-progress-track">
                                <div class="flow-progress-bar" id="flow-progress-bar"></div>
                                <div class="flow-trigger-marker" id="flow-trigger-marker"></div>
                            </div>
                            <div class="flow-progress-times">
                                <span id="flow-elapsed">0:00</span>
                                <span id="flow-remaining">-0:00</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Up Next -->
                <div class="flow-section">
                    <div class="flow-section-header">
                        <div class="flow-section-label">UP NEXT</div>
                        <button class="flow-skip-btn" id="flow-skip-btn">SKIP</button>
                    </div>
                    <div class="flow-up-next" id="flow-up-next">
                        <div class="flow-empty-msg">Add tracks to queue below</div>
                    </div>
                </div>

                <!-- Queue -->
                <div class="flow-section">
                    <div class="flow-section-label">QUEUE</div>
                    <div class="flow-queue" id="flow-queue">
                        <div class="flow-empty-msg">Queue is empty</div>
                    </div>
                </div>

                <!-- Suggestions -->
                <div class="flow-section flow-section-grow">
                    <div class="flow-section-label">SUGGESTIONS</div>
                    <div class="flow-suggestions" id="flow-suggestions">
                        <div class="flow-empty-msg">Enable flow mode and pick a starting track</div>
                    </div>
                </div>

                <!-- Settings -->
                <div class="flow-section">
                    <div class="flow-section-label">SETTINGS</div>
                    <div class="flow-settings">
                        <div class="flow-setting-row">
                            <label>Transition Type</label>
                            <select id="flow-trans-type">
                                <option value="blend" ${this.transitionType === 'blend' ? 'selected' : ''}>Blend (Crossfade)</option>
                                <option value="echo-out" ${this.transitionType === 'echo-out' ? 'selected' : ''}>Echo Out</option>
                                <option value="cut" ${this.transitionType === 'cut' ? 'selected' : ''}>Cut (Instant)</option>
                                <option value="filter-sweep" ${this.transitionType === 'filter-sweep' ? 'selected' : ''}>Filter Sweep</option>
                            </select>
                        </div>
                        <div class="flow-setting-row">
                            <label>Transition Duration</label>
                            <input type="range" id="flow-trans-duration" min="2" max="32" value="${this.transitionDuration}" step="1">
                            <span id="flow-trans-duration-val">${this.transitionDuration}s</span>
                        </div>
                        <div class="flow-setting-row">
                            <label>Trigger Mode</label>
                            <select id="flow-trigger-mode">
                                <option value="fixed" ${this.transitionPointMode === 'fixed' ? 'selected' : ''}>Fixed (seconds before end)</option>
                                <option value="percent" ${this.transitionPointMode === 'percent' ? 'selected' : ''}>Percentage of track</option>
                            </select>
                        </div>
                        <div class="flow-setting-row" id="flow-trigger-fixed-row">
                            <label>Trigger Point (seconds)</label>
                            <input type="range" id="flow-trigger-point" min="5" max="60" value="${this.transitionPoint}" step="1">
                            <span id="flow-trigger-point-val">${this.transitionPoint}s</span>
                        </div>
                        <div class="flow-setting-row hidden" id="flow-trigger-percent-row">
                            <label>Trigger Point (%)</label>
                            <input type="range" id="flow-trigger-percent" min="5" max="50" value="${this.transitionPointPercent}" step="1">
                            <span id="flow-trigger-percent-val">${this.transitionPointPercent}%</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Wire up UI events
        document.getElementById('flow-exit-btn')?.addEventListener('click', () => this.disable());
        document.getElementById('flow-skip-btn')?.addEventListener('click', () => this.skip());

        document.getElementById('flow-trans-type')?.addEventListener('change', (e) => {
            this.transitionType = e.target.value;
        });

        document.getElementById('flow-trans-duration')?.addEventListener('input', (e) => {
            this.transitionDuration = parseInt(e.target.value);
            const val = document.getElementById('flow-trans-duration-val');
            if (val) val.textContent = `${this.transitionDuration}s`;
        });

        document.getElementById('flow-trigger-mode')?.addEventListener('change', (e) => {
            this.transitionPointMode = e.target.value;
            const fixedRow = document.getElementById('flow-trigger-fixed-row');
            const percentRow = document.getElementById('flow-trigger-percent-row');
            if (e.target.value === 'fixed') {
                fixedRow?.classList.remove('hidden');
                percentRow?.classList.add('hidden');
            } else {
                fixedRow?.classList.add('hidden');
                percentRow?.classList.remove('hidden');
            }
        });

        document.getElementById('flow-trigger-point')?.addEventListener('input', (e) => {
            this.transitionPoint = parseInt(e.target.value);
            const val = document.getElementById('flow-trigger-point-val');
            if (val) val.textContent = `${this.transitionPoint}s`;
        });

        document.getElementById('flow-trigger-percent')?.addEventListener('input', (e) => {
            this.transitionPointPercent = parseInt(e.target.value);
            const val = document.getElementById('flow-trigger-percent-val');
            if (val) val.textContent = `${this.transitionPointPercent}%`;
        });

        this._updateUI();
    }

    _updateUI() {
        this._renderNowPlaying();
        this._renderUpNext();
        this._renderQueue();
        this._renderSuggestions();
    }

    _renderNowPlaying() {
        const title = document.getElementById('flow-np-title');
        const artist = document.getElementById('flow-np-artist');
        const bpm = document.getElementById('flow-np-bpm');
        const key = document.getElementById('flow-np-key');
        const genre = document.getElementById('flow-np-genre');

        if (!this.currentTrack) {
            if (title) title.textContent = 'No track loaded';
            if (artist) artist.textContent = '';
            if (bpm) bpm.textContent = '';
            if (key) key.textContent = '';
            if (genre) genre.textContent = '';
            return;
        }

        if (title) title.textContent = this.currentTrack.title || 'Unknown';
        if (artist) artist.textContent = this.currentTrack.artist || '';
        if (bpm) bpm.textContent = this.currentTrack.bpm ? `${this.currentTrack.bpm} BPM` : '';
        if (key) key.textContent = this.currentTrack.key || '';
        if (genre) genre.textContent = this.currentTrack.genre || '';
    }

    _renderUpNext() {
        const container = document.getElementById('flow-up-next');
        if (!container) return;

        if (this.queue.length === 0) {
            container.innerHTML = '<div class="flow-empty-msg">Add tracks to queue below</div>';
            return;
        }

        const track = this.queue[0];
        const badges = this._getCompatibilityBadges(track);
        const badgeHtml = badges.map(b =>
            `<span class="flow-badge flow-badge-${b.type}">${esc(b.label)}</span>`
        ).join('');

        container.innerHTML = `
            <div class="flow-next-card">
                <div class="flow-next-info">
                    <div class="flow-next-title">${esc(track.title || 'Unknown')}</div>
                    <div class="flow-next-artist">${esc(track.artist)}</div>
                </div>
                <div class="flow-next-meta">
                    <span>${track.bpm ? esc(track.bpm) + ' BPM' : ''}</span>
                    <span>${esc(track.key)}</span>
                </div>
                <div class="flow-next-badges">${badgeHtml}</div>
            </div>
        `;
    }

    _renderQueue() {
        const container = document.getElementById('flow-queue');
        if (!container) return;

        if (this.queue.length <= 1) {
            container.innerHTML = '<div class="flow-empty-msg">Queue is empty</div>';
            return;
        }

        // Skip first item (shown in Up Next)
        container.innerHTML = this.queue.slice(1).map((track, i) => {
            const actualIndex = i + 1;
            return `
                <div class="flow-queue-item">
                    <span class="flow-queue-num">${actualIndex + 1}</span>
                    <span class="flow-queue-info">${esc(track.title || 'Unknown')} — ${esc(track.artist)}</span>
                    <button class="flow-queue-remove" data-index="${actualIndex}">x</button>
                </div>
            `;
        }).join('');

        // Wire remove buttons
        container.querySelectorAll('.flow-queue-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index);
                this.removeFromQueue(idx);
            });
        });
    }

    _renderSuggestions() {
        const container = document.getElementById('flow-suggestions');
        if (!container) return;

        // Merge suggestions with remaining tracks from all sources if empty
        let items = this.suggestions;
        if (items.length === 0) {
            const allTracks = this._getAllTracks();
            const playedSet = new Set(this.playedInSession);
            const queuedSet = new Set(this.queue.map(t => t.id || t.title));
            items = allTracks.filter(t => {
                const tid = t.id || t.title;
                return !playedSet.has(tid) && !queuedSet.has(tid);
            }).slice(0, 10);
        }

        if (items.length === 0) {
            container.innerHTML = '<div class="flow-empty-msg">No more suggestions available</div>';
            return;
        }

        container.innerHTML = items.map((track, i) => {
            const badges = this._getCompatibilityBadges(track);
            const badgeHtml = badges.map(b =>
                `<span class="flow-badge flow-badge-${b.type}">${esc(b.label)}</span>`
            ).join('');

            return `
                <div class="flow-suggestion-card" data-index="${i}">
                    <div class="flow-sug-info">
                        <div class="flow-sug-title">${esc(track.title || 'Unknown')}</div>
                        <div class="flow-sug-artist">${esc(track.artist)}</div>
                    </div>
                    <div class="flow-sug-meta">
                        <span>${track.bpm ? esc(track.bpm) + ' BPM' : ''}</span>
                        <span>${esc(track.key)}</span>
                        ${badgeHtml}
                    </div>
                    <button class="flow-sug-add" data-index="${i}">
                        ${this.currentTrack ? 'ADD' : 'PLAY'}
                    </button>
                </div>
            `;
        }).join('');

        // Wire add/play buttons
        container.querySelectorAll('.flow-sug-add').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index);
                const track = items[idx];
                if (!track) return;

                if (!this.currentTrack) {
                    // First track — start playing
                    this.start(track);
                } else {
                    this.addToQueue(track);
                    this._suggestNext();
                    this._updateUI();
                }
            });
        });
    }
}
