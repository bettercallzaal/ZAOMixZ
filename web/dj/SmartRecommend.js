// SmartRecommend.js — AI-powered track recommendation engine
// Scores tracks by BPM proximity, key compatibility, genre, and energy flow

import { esc } from './Html.js';
export class SmartRecommend {
    constructor(harmonicMixer) {
        this.harmonic = harmonicMixer;
        this.setHistory = []; // tracks played in this session
        this.energyArc = []; // energy trend (0-1 values over time)
        this.panel = document.getElementById('suggest-panel');
        this.listEl = document.getElementById('suggest-list');
    }

    // Score a candidate track against the current track
    scoreTrack(current, candidate) {
        if (!current || !candidate) return { score: 0, reasons: [] };

        let score = 0;
        const reasons = [];

        // BPM compatibility (0-40 points)
        if (current.bpm && candidate.bpm) {
            const ratio = candidate.bpm / current.bpm;
            if (ratio >= 0.97 && ratio <= 1.03) {
                score += 40;
                reasons.push('BPM match');
            } else if (ratio >= 0.95 && ratio <= 1.05) {
                score += 30;
                reasons.push('BPM close');
            } else if (ratio >= 0.90 && ratio <= 1.10) {
                score += 15;
                reasons.push('BPM compatible');
            } else if ((ratio >= 0.48 && ratio <= 0.52) || (ratio >= 1.95 && ratio <= 2.05)) {
                score += 20;
                reasons.push('Half/double BPM');
            }
        }

        // Key compatibility (0-35 points)
        if (this.harmonic && current.key && candidate.key) {
            const compat = this.harmonic.isCompatible(current.key, candidate.key);
            if (compat === true) {
                score += 35;
                reasons.push('Key match');
            } else if (compat === false) {
                // Check if same root note
                const root1 = current.key.replace('m', '');
                const root2 = candidate.key.replace('m', '');
                if (root1 === root2) {
                    score += 15;
                    reasons.push('Same root');
                }
            }
        }

        // Genre matching (0-15 points)
        if (current.genre && candidate.genre) {
            if (current.genre.toLowerCase() === candidate.genre.toLowerCase()) {
                score += 15;
                reasons.push('Genre match');
            }
        }

        // Energy flow (0-10 points) — prefer gradual changes
        if (current.energy !== null && current.energy !== undefined &&
            candidate.energy !== null && candidate.energy !== undefined) {
            const diff = Math.abs(current.energy - candidate.energy);
            if (diff < 0.1) {
                score += 10;
                reasons.push('Energy match');
            } else if (diff < 0.25) {
                score += 7;
                reasons.push('Energy flow');
            }
        }

        // Penalty for recently played
        const candidateId = candidate.id || candidate.title;
        const recentIndex = this.setHistory.findIndex(t => (t.id || t.title) === candidateId);
        if (recentIndex >= 0) {
            score -= 100; // never recommend recently played
        }

        // Classify match quality
        let matchLevel = 'ok';
        if (score >= 60) matchLevel = 'perfect';
        else if (score >= 40) matchLevel = 'good';
        else if (score >= 20) matchLevel = 'creative';

        return { score, reasons, matchLevel };
    }

    // Get ranked recommendations from a list of candidate tracks
    getRecommendations(currentTrack, allTracks, limit = 8) {
        if (!currentTrack || !allTracks || allTracks.length === 0) return [];

        const currentId = currentTrack.id || currentTrack.title;
        const historySet = new Set(this.setHistory.map(t => t.id || t.title));

        const scored = allTracks
            .filter(t => (t.id || t.title) !== currentId && !historySet.has(t.id || t.title))
            .map(track => {
                const { score, reasons, matchLevel } = this.scoreTrack(currentTrack, track);
                return { track, score, reasons, matchLevel };
            })
            .sort((a, b) => b.score - a.score);

        return scored.slice(0, limit);
    }

    // Track a played track for history
    trackPlayed(track) {
        if (!track) return;
        this.setHistory.push(track);
        if (track.energy !== null && track.energy !== undefined) {
            this.energyArc.push(track.energy);
        }
    }

    // Suggest transition type based on track characteristics
    suggestTransition(currentTrack, nextTrack) {
        if (!currentTrack || !nextTrack) return 'blend';

        const bpmDiff = Math.abs((currentTrack.bpm || 0) - (nextTrack.bpm || 0));
        const keyCompat = this.harmonic ? this.harmonic.isCompatible(currentTrack.key, nextTrack.key) : null;

        if (bpmDiff <= 3 && keyCompat) return 'blend';     // smooth crossfade
        if (bpmDiff <= 8) return 'echo-out';                // echo transition
        return 'cut';                                        // hard cut
    }

    // Render suggestions panel
    renderSuggestions(currentTrack, allTracks, onLoadToDeck) {
        if (!this.listEl) return;
        this.listEl.innerHTML = '';

        const recs = this.getRecommendations(currentTrack, allTracks);
        if (recs.length === 0) {
            this.listEl.innerHTML = '<div class="suggest-empty">No recommendations available</div>';
            return;
        }

        recs.forEach(({ track, score, reasons, matchLevel }) => {
            const item = document.createElement('div');
            item.className = `suggest-item suggest-${matchLevel}`;

            const badge = matchLevel === 'perfect' ? 'PERFECT' :
                          matchLevel === 'good' ? 'GOOD' :
                          matchLevel === 'creative' ? 'CREATIVE' : '';

            item.innerHTML = `
                <div class="suggest-info">
                    <div class="suggest-title">${esc(track.title || 'Unknown')}</div>
                    <div class="suggest-artist">${esc(track.artist)}</div>
                </div>
                <div class="suggest-meta">
                    <span class="suggest-bpm">${esc(track.bpm || '-')}</span>
                    <span class="suggest-key">${esc(track.key || '-')}</span>
                    <span class="suggest-badge suggest-badge-${matchLevel}">${badge}</span>
                </div>
                <div class="suggest-reasons">${esc(reasons.join(' + '))}</div>
                <div class="suggest-actions">
                    <button class="btn-load btn-load-a suggest-load" data-deck="A">A</button>
                    <button class="btn-load btn-load-b suggest-load" data-deck="B">B</button>
                </div>
            `;

            item.querySelectorAll('.suggest-load').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (onLoadToDeck) onLoadToDeck(track, btn.dataset.deck);
                });
            });

            this.listEl.appendChild(item);
        });
    }

    clearHistory() {
        this.setHistory = [];
        this.energyArc = [];
    }
}
