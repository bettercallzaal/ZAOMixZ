// PluginManager.js — Plugin architecture for community extensions
// Plugins can add effects, visualizers, panels, and analyzers

import { esc } from './Html.js';
export class PluginManager {
    constructor(djPlayer) {
        this.dj = djPlayer;
        this.plugins = new Map(); // name → plugin instance
        this.builtinPlugins = {};

        this._registerBuiltins();
        this._initUI();
    }

    // Plugin API interface:
    // { name, version, author, type ('effect'|'visualizer'|'panel'|'analyzer'),
    //   init(djApp), destroy(), onTrackLoad?(deck, track), onPlay?(deck), onMix?(deckA, deckB) }

    register(plugin) {
        if (!plugin || !plugin.name) {
            console.warn('[PluginManager] Invalid plugin — must have a name');
            return false;
        }

        if (this.plugins.has(plugin.name)) {
            console.warn(`[PluginManager] Plugin "${plugin.name}" already registered`);
            return false;
        }

        try {
            if (plugin.init) plugin.init(this.dj);
            plugin._enabled = true;
            this.plugins.set(plugin.name, plugin);
            this._updateUI();
            return true;
        } catch (e) {
            console.error(`[PluginManager] Plugin "${plugin.name}" init failed:`, e);
            return false;
        }
    }

    unregister(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) return;
        try { if (plugin.destroy) plugin.destroy(); } catch (_) {}
        this.plugins.delete(name);
        this._updateUI();
    }

    enable(name) {
        const plugin = this.plugins.get(name);
        if (!plugin || plugin._enabled) return;
        try { if (plugin.init) plugin.init(this.dj); } catch (_) {}
        plugin._enabled = true;
        this._updateUI();
    }

    disable(name) {
        const plugin = this.plugins.get(name);
        if (!plugin || !plugin._enabled) return;
        try { if (plugin.destroy) plugin.destroy(); } catch (_) {}
        plugin._enabled = false;
        this._updateUI();
    }

    // Emit events to all enabled plugins
    emit(event, ...args) {
        for (const plugin of this.plugins.values()) {
            if (!plugin._enabled) continue;
            try {
                if (typeof plugin[event] === 'function') {
                    plugin[event](...args);
                }
            } catch (e) {
                console.warn(`[Plugin:${plugin.name}] Error in ${event}:`, e);
            }
        }
    }

    // Load plugin from a JS file
    async loadFromFile(file) {
        try {
            const text = await file.text();
            const blob = new Blob([text], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const module = await import(url);
            URL.revokeObjectURL(url);

            if (module.default) {
                const instance = typeof module.default === 'function' ? new module.default() : module.default;
                return this.register(instance);
            }
        } catch (e) {
            console.error('[PluginManager] Failed to load plugin file:', e);
        }
        return false;
    }

    // ===== BUILT-IN PLUGINS =====

    _registerBuiltins() {
        // Auto-Gain Plugin
        this.builtinPlugins.autoGain = {
            name: 'Auto-Gain',
            version: '1.0',
            author: 'AURDOUR',
            type: 'analyzer',
            _enabled: false,
            _analyserA: null,
            _analyserB: null,
            _interval: null,

            init(dj) {
                this._dj = dj;
                this._interval = setInterval(() => this._adjustGain(), 2000);
            },

            destroy() {
                if (this._interval) clearInterval(this._interval);
            },

            _adjustGain() {
                if (!this._dj?.audioRouter) return;
                ['A', 'B'].forEach(id => {
                    const ch = this._dj.audioRouter.channels[id];
                    if (!ch || !ch.analyser) return;
                    const data = new Uint8Array(ch.analyser.frequencyBinCount);
                    ch.analyser.getByteFrequencyData(data);
                    const avg = data.reduce((a, b) => a + b, 0) / data.length;
                    // Target ~100 average level
                    const targetGain = avg > 0 ? Math.min(1.5, Math.max(0.5, 100 / avg)) : 1.0;
                    const current = ch.channelGain.gain.value;
                    // Smooth transition
                    ch.channelGain.gain.setTargetAtTime(
                        current + (targetGain - current) * 0.1,
                        this._dj.audioRouter.getAudioContext().currentTime,
                        0.5
                    );
                });
            },
        };

        // Track Stats Plugin
        this.builtinPlugins.trackStats = {
            name: 'Track Stats',
            version: '1.0',
            author: 'AURDOUR',
            type: 'panel',
            _enabled: false,
            _stats: { tracksPlayed: 0, totalDuration: 0, avgBpm: 0, bpmSum: 0, keys: {} },
            _panelEl: null,

            init(dj) {
                this._dj = dj;
                this._panelEl = document.getElementById('plugin-stats-panel');
                if (!this._panelEl) {
                    this._panelEl = document.createElement('div');
                    this._panelEl.id = 'plugin-stats-panel';
                    this._panelEl.className = 'plugin-panel';
                    this._panelEl.innerHTML = '<div class="plugin-panel-title">SESSION STATS</div><div class="plugin-stats-content" id="plugin-stats-content"></div>';
                    document.getElementById('plugin-panels')?.appendChild(this._panelEl);
                }
                this._panelEl.classList.remove('hidden');
                this._render();
            },

            destroy() {
                if (this._panelEl) this._panelEl.classList.add('hidden');
            },

            onTrackLoad(deck, track) {
                this._stats.tracksPlayed++;
                if (track?.duration) this._stats.totalDuration += track.duration;
                if (track?.bpm) {
                    this._stats.bpmSum += track.bpm;
                    this._stats.avgBpm = Math.round(this._stats.bpmSum / this._stats.tracksPlayed);
                }
                if (track?.key) {
                    this._stats.keys[track.key] = (this._stats.keys[track.key] || 0) + 1;
                }
                this._render();
            },

            _render() {
                const el = document.getElementById('plugin-stats-content');
                if (!el) return;
                const s = this._stats;
                const topKey = Object.entries(s.keys).sort((a, b) => b[1] - a[1])[0];
                el.innerHTML = `
                    <div class="stat-row"><span>Tracks Played</span><strong>${s.tracksPlayed}</strong></div>
                    <div class="stat-row"><span>Total Time</span><strong>${Math.floor(s.totalDuration / 60)}m</strong></div>
                    <div class="stat-row"><span>Avg BPM</span><strong>${s.avgBpm || '-'}</strong></div>
                    <div class="stat-row"><span>Top Key</span><strong>${topKey ? topKey[0] : '-'}</strong></div>
                `;
            },
        };

        // Transition Logger Plugin
        this.builtinPlugins.transitionLog = {
            name: 'Transition Log',
            version: '1.0',
            author: 'AURDOUR',
            type: 'panel',
            _enabled: false,
            _log: [],
            _panelEl: null,

            init(dj) {
                this._dj = dj;
                this._panelEl = document.getElementById('plugin-translog-panel');
                if (!this._panelEl) {
                    this._panelEl = document.createElement('div');
                    this._panelEl.id = 'plugin-translog-panel';
                    this._panelEl.className = 'plugin-panel';
                    this._panelEl.innerHTML = '<div class="plugin-panel-title">TRANSITION LOG</div><div class="plugin-translog-content" id="plugin-translog-content"></div><button class="btn-toolbar btn-sm" id="plugin-translog-export">EXPORT</button>';
                    document.getElementById('plugin-panels')?.appendChild(this._panelEl);
                }
                this._panelEl.classList.remove('hidden');
                document.getElementById('plugin-translog-export')?.addEventListener('click', () => this._export());
            },

            destroy() {
                if (this._panelEl) this._panelEl.classList.add('hidden');
            },

            onTrackLoad(deck, track) {
                this._log.push({
                    time: new Date().toLocaleTimeString(),
                    deck: deck.id,
                    title: track?.title || 'Unknown',
                    artist: track?.artist || '',
                    bpm: track?.bpm || null,
                    key: track?.key || null,
                });
                this._render();
            },

            _render() {
                const el = document.getElementById('plugin-translog-content');
                if (!el) return;
                el.innerHTML = this._log.map(e =>
                    `<div class="translog-entry"><span class="translog-time">${e.time}</span> <span class="translog-deck">[${esc(e.deck)}]</span> ${esc(e.title)} — ${esc(e.artist)}</div>`
                ).join('');
                el.scrollTop = el.scrollHeight;
            },

            _export() {
                const text = this._log.map(e =>
                    `${e.time} [Deck ${e.deck}] ${e.title} — ${e.artist} (${e.bpm || '?'} BPM, ${e.key || '?'})`
                ).join('\n');
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `setlist-${new Date().toISOString().slice(0, 10)}.txt`;
                a.click();
                URL.revokeObjectURL(url);
            },
        };
    }

    _initUI() {
        const pluginBtn = document.getElementById('plugins-btn');
        const pluginPanel = document.getElementById('plugins-panel');
        const loadBtn = document.getElementById('plugin-load-btn');
        const loadFile = document.getElementById('plugin-load-file');

        if (pluginBtn && pluginPanel) {
            pluginBtn.addEventListener('click', () => pluginPanel.classList.toggle('hidden'));
        }

        if (loadBtn && loadFile) {
            loadBtn.addEventListener('click', () => loadFile.click());
            loadFile.addEventListener('change', (e) => {
                if (e.target.files[0]) this.loadFromFile(e.target.files[0]);
            });
        }

        // Wire builtin plugin toggles
        Object.entries(this.builtinPlugins).forEach(([key, plugin]) => {
            const btn = document.getElementById(`plugin-toggle-${key}`);
            if (btn) {
                btn.addEventListener('click', () => {
                    if (this.plugins.has(plugin.name)) {
                        if (plugin._enabled) {
                            this.disable(plugin.name);
                            btn.classList.remove('active');
                        } else {
                            this.enable(plugin.name);
                            btn.classList.add('active');
                        }
                    } else {
                        this.register(plugin);
                        btn.classList.add('active');
                    }
                });
            }
        });
    }

    _updateUI() {
        const list = document.getElementById('plugins-list');
        if (!list) return;

        list.innerHTML = '';
        for (const [name, plugin] of this.plugins) {
            const item = document.createElement('div');
            item.className = 'plugin-item';
            item.innerHTML = `
                <div class="plugin-info">
                    <span class="plugin-name">${esc(name)}</span>
                    <span class="plugin-version">v${esc(plugin.version || '?')}</span>
                    <span class="plugin-type">${esc(plugin.type)}</span>
                </div>
                <span class="plugin-status ${plugin._enabled ? 'on' : 'off'}">${plugin._enabled ? 'ON' : 'OFF'}</span>
            `;
            list.appendChild(item);
        }
    }
}
