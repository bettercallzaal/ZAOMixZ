// sw.js — Service Worker for AURDOUR DJ PWA
// Full offline support with app shell caching, audio IndexedDB caching,
// graceful updates, and background sync

// 'dev' in the repo. The deploy writes a hash of web/ here (scripts/stamp-sw.mjs), so PRs never bump it.
const CACHE_VERSION = 'dev';
const CACHE_NAME = `aurdour-v${CACHE_VERSION}`;
const AUDIO_CACHE_NAME = 'aurdour-audio-v1';

// App shell — all assets required for offline operation
const APP_SHELL = [
    '/',
    '/index.html',
    '/mix.html',
    '/dj/MixPage.js',
    '/dj/LiveMix.js',
    '/dj/NowPlaying.js',
    '/dj/LibrarySheet.js',
    '/dj/PlayAlong.js',
    '/dj/TestList.js',
    '/dj/DeadAir.js',
    '/styles.css',
    '/music-source.js',
    '/dj/MusicSource.js',
    '/dj/Licence.js',
    '/dj/MidiAsk.js',
    '/dj/ControllerMaps.js',
    '/dj/BattleCrate.js',
    '/how.html',
    '/llms.txt',
    '/feedback.html',
    '/dj/Feedback.js',
    '/player.js',
    '/dj/Deck.js',
    '/dj/AudioRouter.js',
    '/dj/Mixer.js',
    '/dj/Meters.js',
    '/dj/Library.js',
    '/dj/Sampler.js',
    '/dj/Recorder.js',
    '/dj/Visualizer.js',
    '/dj/MidiController.js',
    '/dj/ControllerLights.js',
    '/dj/FxFade.js',
    '/dj/PadModes.js',
    '/dj/Moves.js',
    '/dj/ProLayout.js',
    '/dj/RemoteLink.js',
    '/dj/RequestLine.js',
    '/remote.html',
    '/remote.js',
    '/remote.webmanifest',
    '/dj/Install.js',
    '/icons/mixz-192.png',
    '/icons/mixz-512.png',
    '/icons/remote-192.png',
    '/icons/remote-512.png',
    '/dj/BpmTap.js',
    '/dj/StreamBroadcast.js',
    '/dj/FX.js',
    '/dj/AutoTransition.js',
    '/dj/Clock.js',
    '/dj/AgentQueue.js',
    '/dj/AgentPost.js',
    '/dj/AgentLink.js',
    '/dj/Html.js',
    '/dj/FlowDirector.js',
    '/dj/StreamEvents.js',
    '/dj/ChatFilter.js',
    '/dj/BeatGridOverlay.js',
    '/dj/Archive.js',
    '/dj/ArtistTab.js',
    '/dj/Setlist.js',
    '/dj/HarmonicMixer.js',
    '/dj/StemSeparator.js',
    '/dj/Storage.js',
    '/dj/BpmDetector.js',
    '/dj/JogWheel.js',
    '/dj/DragDrop.js',
    '/dj/CrashRecovery.js',
    '/dj/WaveformCache.js',
    '/dj/Playlists.js',
    '/dj/PerfMonitor.js',
    '/dj/Settings.js',
    '/dj/FlowMode.js',
    '/dj/Audius.js',
    '/dj/SoundCloud.js',
    '/dj/Spotify.js',
    '/dj/TwitchChat.js',
    '/dj/YouTubeLive.js',
    '/dj/SmartRecommend.js',
    '/mixz.css',
    '/mixz.css?v=21',
    '/dj/SwitchPad.js',
    '/dj/ZaoCrate.js',
    '/dj/DjMixz.js',
    '/dj/SongChainn.js',
    '/dj/CloudSync.js',
    '/dj/PluginManager.js',
    '/dj/bpm-worker.js',
    '/dj/TravelMode.js',
    '/manifest.webmanifest',
];

// CDN resources to cache after install
const CDN_ASSETS = [
    'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.min.js',
    'https://unpkg.com/wavesurfer.js@7/dist/plugins/timeline.min.js',
    'https://unpkg.com/wavesurfer.js@7/dist/plugins/regions.min.js',
    'https://unpkg.com/wavesurfer.js@7/dist/plugins/minimap.min.js',
];

// ============ IndexedDB for offline audio ============

function openAudioDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('aurdour-offline-audio', 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('tracks')) {
                const store = db.createObjectStore('tracks', { keyPath: 'id' });
                store.createIndex('title', 'title', { unique: false });
                store.createIndex('cachedAt', 'cachedAt', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function cacheAudioTrack(trackData) {
    const db = await openAudioDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tracks', 'readwrite');
        const store = tx.objectStore('tracks');
        trackData.cachedAt = Date.now();
        store.put(trackData);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

async function getCachedAudio(trackId) {
    const db = await openAudioDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tracks', 'readonly');
        const store = tx.objectStore('tracks');
        const req = store.get(trackId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

async function listCachedAudio() {
    const db = await openAudioDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tracks', 'readonly');
        const store = tx.objectStore('tracks');
        const req = store.getAll();
        req.onsuccess = () => {
            resolve(req.result.map(t => ({
                id: t.id,
                title: t.title,
                artist: t.artist,
                duration: t.duration,
                size: t.audioBlob?.size || 0,
                cachedAt: t.cachedAt,
            })));
        };
        req.onerror = () => reject(req.error);
    });
}

async function removeCachedAudio(trackId) {
    const db = await openAudioDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tracks', 'readwrite');
        const store = tx.objectStore('tracks');
        store.delete(trackId);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

// ============ Install — pre-cache app shell ============

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // Cache app shell — best-effort per file (one 404 shouldn't block everything)
            for (const url of APP_SHELL) {
                try {
                    await cache.add(url);
                } catch (e) {
                    console.warn('[SW] Failed to cache:', url, e.message);
                }
            }
            // Then cache CDN assets (best-effort)
            for (const url of CDN_ASSETS) {
                try {
                    await cache.add(url);
                } catch (e) {
                    console.warn('[SW] Failed to cache CDN asset:', url, e.message);
                }
            }
        })
    );
    // Activate immediately without waiting for old SW to finish
    self.skipWaiting();
});

// ============ Activate — clean old caches, claim clients ============

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== CACHE_NAME && k !== AUDIO_CACHE_NAME)
                    .map((k) => caches.delete(k))
            )
        ).then(() => {
            // Notify all clients about the update
            self.clients.matchAll().then(clients => {
                clients.forEach(client => {
                    client.postMessage({
                        type: 'SW_UPDATED',
                        version: CACHE_VERSION,
                    });
                });
            });
        })
    );
    self.clients.claim();
});

// ============ Fetch — cache strategy per resource type ============

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Unstamped (a local server): let the network answer, so an edit is never hidden by the cache.
    if (CACHE_VERSION === 'dev') return;

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Skip chrome-extension and other non-http(s) schemes
    if (!url.protocol.startsWith('http')) return;

    // Audio files from data folder — network first, fallback to IndexedDB
    if (url.pathname.startsWith('/data/') && (
        url.pathname.endsWith('.mp3') ||
        url.pathname.endsWith('.ogg') ||
        url.pathname.endsWith('.wav') ||
        url.pathname.endsWith('.m4a')
    )) {
        event.respondWith(
            fetch(event.request).catch(async () => {
                // Try IndexedDB cached audio
                const trackId = url.pathname.split('/').pop().replace(/\.[^.]+$/, '');
                const cached = await getCachedAudio(trackId);
                if (cached?.audioBlob) {
                    return new Response(cached.audioBlob, {
                        headers: { 'Content-Type': cached.mimeType || 'audio/mpeg' }
                    });
                }
                return new Response('Audio not available offline', { status: 503 });
            })
        );
        return;
    }

    // JSON data files — network first, cache fallback
    if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
        event.respondWith(
            fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // CDN resources (fonts, wavesurfer) — stale-while-revalidate
    if (url.hostname !== location.hostname) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                const fetchPromise = fetch(event.request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);

                return cached || fetchPromise;
            })
        );
        return;
    }

    // App shell — cache first, network fallback
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        }).catch(() => {
            // Final fallback — return the offline app shell
            if (event.request.mode === 'navigate') {
                return caches.match('/index.html');
            }
            return new Response('Offline', { status: 503 });
        })
    );
});

// ============ Message handler — offline audio management ============

self.addEventListener('message', (event) => {
    const { type, data } = event.data || {};

    switch (type) {
        case 'CACHE_AUDIO':
            // Save audio track blob to IndexedDB for offline playback
            cacheAudioTrack(data).then(() => {
                event.source.postMessage({
                    type: 'AUDIO_CACHED',
                    trackId: data.id,
                    success: true,
                });
            }).catch((err) => {
                event.source.postMessage({
                    type: 'AUDIO_CACHED',
                    trackId: data.id,
                    success: false,
                    error: err.message,
                });
            });
            break;

        case 'LIST_CACHED_AUDIO':
            listCachedAudio().then((tracks) => {
                event.source.postMessage({
                    type: 'CACHED_AUDIO_LIST',
                    tracks,
                });
            });
            break;

        case 'REMOVE_CACHED_AUDIO':
            removeCachedAudio(data.trackId).then(() => {
                event.source.postMessage({
                    type: 'AUDIO_REMOVED',
                    trackId: data.trackId,
                    success: true,
                });
            });
            break;

        case 'GET_CACHED_AUDIO':
            getCachedAudio(data.trackId).then((track) => {
                event.source.postMessage({
                    type: 'CACHED_AUDIO_DATA',
                    track,
                });
            });
            break;

        case 'SKIP_WAITING':
            self.skipWaiting();
            break;

        case 'GET_CACHE_STATUS':
            caches.open(CACHE_NAME).then(async (cache) => {
                const keys = await cache.keys();
                const audioTracks = await listCachedAudio();
                event.source.postMessage({
                    type: 'CACHE_STATUS',
                    appShellCached: keys.length,
                    audioCached: audioTracks.length,
                    version: CACHE_VERSION,
                });
            });
            break;
    }
});
