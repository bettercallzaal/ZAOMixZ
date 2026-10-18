// Library.js — Track browser with pagination, sorting, playlist management,
// context menus, bulk actions, and enhanced search

import { loadSourceManifest } from './MusicSource.js';
import { esc } from './Html.js';

export class Library {
    constructor(onLoadTrack) {
        this.tracks = [];
        this.filteredTracks = [];
        this.onLoadTrack = onLoadTrack; // callback(deckId, dataFilePath)
        this.onLoadDirect = null; // callback(deckId, streamUrl, meta) — set by player
        this.onAddToQueue = null; // set by Setlist
        this.playlists = null; // set by player — Playlists instance for liked tracks
        this.tableBody = document.getElementById('library-body');
        this.searchInput = document.getElementById('library-search');
        this.selectedIndex = -1;
        this.selectedTrack = null;

        // Audius
        this.audius = null; // set externally
        this.activeTab = 'local';
        this.audiusTracks = [];
        this._searchDebounce = null;

        // SoundCloud
        this.soundcloud = null; // set externally
        this.soundcloudTracks = [];

        // Spotify
        this.spotify = null; // set externally
        this.spotifyTracks = [];

        // Pagination state
        this.currentPage = 1;
        this.pageSize = 25;
        this._displayedTracks = []; // the full list currently being paged through

        // Sort state
        this.sortColumn = null; // 'title', 'artist', 'bpm', 'key', 'duration'
        this.sortDirection = 'asc'; // 'asc' or 'desc'

        // Bulk selection
        this.selectedIds = new Set();

        // Active playlist view (for Playlists tab)
        this.viewingPlaylist = null;

        // Context menu element
        this._contextMenu = null;

        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => this._onSearchInput());
        }

        this._initTabs();
        this._initSortHeaders();
        this._initSearchClear();
        this._initResizableLibrary();
        this._initContextMenu();
        this._initKeyboardNav();
    }

    // ===== Initialization =====

    _initTabs() {
        const tabs = document.querySelectorAll('.library-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.activeTab = tab.dataset.tab;
                this.currentPage = 1;
                this.selectedIds.clear();
                this.viewingPlaylist = null;
                this._onTabChange();
            });
        });
    }

    _initSortHeaders() {
        const headers = document.querySelectorAll('.library-table thead th[data-sort]');
        headers.forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.sort;
                if (this.sortColumn === col) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortColumn = col;
                    this.sortDirection = 'asc';
                }
                // Update sort indicators
                document.querySelectorAll('.library-table thead th[data-sort]').forEach(h => {
                    h.classList.remove('sort-asc', 'sort-desc');
                });
                th.classList.add(this.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
                this._refreshCurrentView();
            });
        });
    }

    _initSearchClear() {
        const clearBtn = document.getElementById('library-search-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (this.searchInput) {
                    this.searchInput.value = '';
                    this.currentPage = 1;
                    this._onSearchInput();
                }
                clearBtn.classList.add('hidden');
            });
        }
        // Show/hide clear button based on search content
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => {
                const clearBtn = document.getElementById('library-search-clear');
                if (clearBtn) {
                    clearBtn.classList.toggle('hidden', !this.searchInput.value.trim());
                }
            });
        }
    }

    _initResizableLibrary() {
        const resizeHandle = document.getElementById('library-resize-handle');
        const bottomRow = document.querySelector('.bottom-row');
        if (!resizeHandle || !bottomRow) return;

        let startY, startHeight;
        const onMouseMove = (e) => {
            const diff = startY - e.clientY;
            const newHeight = Math.max(200, Math.min(600, startHeight + diff));
            bottomRow.style.minHeight = newHeight + 'px';
            bottomRow.style.maxHeight = newHeight + 'px';
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            resizeHandle.classList.remove('dragging');
        };
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startHeight = bottomRow.offsetHeight;
            resizeHandle.classList.add('dragging');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    _initContextMenu() {
        // Create context menu element
        this._contextMenu = document.createElement('div');
        this._contextMenu.className = 'lib-context-menu hidden';
        this._contextMenu.id = 'lib-context-menu';
        document.body.appendChild(this._contextMenu);

        // Close on click outside
        document.addEventListener('click', (e) => {
            if (!this._contextMenu.contains(e.target)) {
                this._hideContextMenu();
            }
        });
        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('.library-table tbody')) {
                this._hideContextMenu();
            }
        });
    }

    _initKeyboardNav() {
        const wrapper = document.querySelector('.library-table-wrapper');
        if (!wrapper) return;

        wrapper.setAttribute('tabindex', '0');
        wrapper.addEventListener('keydown', (e) => {
            const list = this._displayedTracks;
            const pageStart = (this.currentPage - 1) * this.pageSize;
            const pageEnd = Math.min(pageStart + this.pageSize, list.length);
            const pageLen = pageEnd - pageStart;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const localIdx = this.selectedIndex - pageStart;
                if (localIdx < pageLen - 1) {
                    this.selectedIndex = pageStart + localIdx + 1;
                    this.selectedTrack = list[this.selectedIndex];
                    this._highlightRow();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const localIdx = this.selectedIndex - pageStart;
                if (localIdx > 0) {
                    this.selectedIndex = pageStart + localIdx - 1;
                    this.selectedTrack = list[this.selectedIndex];
                    this._highlightRow();
                }
            } else if (e.key === 'Enter' && this.selectedTrack) {
                e.preventDefault();
                this.loadToDeck(this.selectedTrack, null);
            } else if (e.key === 'Delete' && this.selectedTrack) {
                e.preventDefault();
                if (this.viewingPlaylist && this.playlists) {
                    const trackKey = this._getTrackKey(this.selectedTrack);
                    this.playlists.removeTrackFromPlaylist(this.viewingPlaylist, trackKey);
                    this._refreshCurrentView();
                }
            }
        });
    }

    // ===== Tab changes =====

    _onTabChange() {
        const query = (this.searchInput?.value || '').trim();
        this._updateSearchResultsCount(null);

        if (this.activeTab === 'local') {
            this.searchInput.placeholder = 'Search local tracks...';
            this._filterAndRender();
        } else if (this.activeTab === 'recent') {
            this.searchInput.placeholder = 'Search recent tracks...';
            this._renderRecent();
        } else if (this.activeTab === 'liked') {
            this.searchInput.placeholder = 'Search liked tracks...';
            this._renderLiked();
        } else if (this.activeTab === 'playlists') {
            this.searchInput.placeholder = 'Search playlists...';
            this._renderPlaylistsTab();
        } else if (this.activeTab === 'audius') {
            this.searchInput.placeholder = 'Search Audius...';
            if (query.length >= 2) {
                this._searchAudius(query);
            } else {
                this._loadAudiusTrending();
            }
        } else if (this.activeTab === 'soundcloud') {
            this.searchInput.placeholder = 'Search SoundCloud...';
            if (query.length >= 2) {
                this._searchSoundCloud(query);
            } else {
                this._loadSoundCloudTrending();
            }
        } else if (this.activeTab === 'spotify') {
            this.searchInput.placeholder = 'Search Spotify...';
            if (!this.spotify || !this.spotify.isAuthenticated) {
                this._renderSpotifyLogin();
            } else if (query.length >= 2) {
                this._searchSpotify(query);
            } else {
                this._renderSpotifyLogin();
            }
        }
    }

    _onSearchInput() {
        this.currentPage = 1;
        if (this.activeTab === 'local') {
            this._filterAndRender();
        } else if (this.activeTab === 'recent') {
            this._renderRecent();
        } else if (this.activeTab === 'liked') {
            this._renderLiked();
        } else if (this.activeTab === 'playlists') {
            this._renderPlaylistsTab();
        } else if (this.activeTab === 'audius') {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => {
                const query = (this.searchInput?.value || '').trim();
                if (query.length >= 2) {
                    this._searchAudius(query);
                } else if (query.length === 0) {
                    this._loadAudiusTrending();
                }
            }, 400);
        } else if (this.activeTab === 'soundcloud') {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => {
                const query = (this.searchInput?.value || '').trim();
                if (query.length >= 2) {
                    this._searchSoundCloud(query);
                } else if (query.length === 0) {
                    this._loadSoundCloudTrending();
                }
            }, 400);
        } else if (this.activeTab === 'spotify') {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => {
                const query = (this.searchInput?.value || '').trim();
                if (query.length >= 2) {
                    this._searchSpotify(query);
                }
            }, 400);
        }
    }

    // ===== Streaming searches =====

    async _searchAudius(query) {
        if (!this.audius) return;
        this._renderLoading('Searching Audius...');
        try {
            this.audiusTracks = await this.audius.search(query);
            this._renderPaginatedTracks(this.audiusTracks, 'audius');
        } catch (e) {
            console.error('[Library] Audius search failed:', e);
            this._renderError('Audius search failed. Try again.');
        }
    }

    async _loadAudiusTrending() {
        if (!this.audius) return;
        this._renderLoading('Loading trending...');
        try {
            this.audiusTracks = await this.audius.getTrending(30);
            this._renderPaginatedTracks(this.audiusTracks, 'audius');
        } catch (e) {
            console.error('[Library] Audius trending failed:', e);
            this._renderError('Could not load Audius trending.');
        }
    }

    async _searchSoundCloud(query) {
        if (!this.soundcloud) return;
        this._renderLoading('Searching SoundCloud...');
        try {
            this.soundcloudTracks = await this.soundcloud.search(query);
            this._renderPaginatedTracks(this.soundcloudTracks, 'soundcloud');
        } catch (e) {
            console.error('[Library] SoundCloud search failed:', e);
            this._renderError('SoundCloud search failed. Try again.');
        }
    }

    async _loadSoundCloudTrending() {
        if (!this.soundcloud) return;
        this._renderLoading('Loading trending...');
        try {
            this.soundcloudTracks = await this.soundcloud.getTrending(30);
            this._renderPaginatedTracks(this.soundcloudTracks, 'soundcloud');
        } catch (e) {
            console.error('[Library] SoundCloud trending failed:', e);
            this._renderError('Could not load SoundCloud trending.');
        }
    }

    async _searchSpotify(query) {
        if (!this.spotify || !this.spotify.isAuthenticated) { this._renderSpotifyLogin(); return; }
        this._renderLoading('Searching Spotify...');
        try {
            this.spotifyTracks = await this.spotify.search(query);
            this._renderPaginatedTracks(this.spotifyTracks, 'spotify');
        } catch (e) {
            console.error('[Library] Spotify search failed:', e);
            this._renderError('Spotify search failed. Try again.');
        }
    }

    _renderSpotifyLogin() {
        if (!this.tableBody) return;
        this.tableBody.textContent = '';
        this._displayedTracks = [];
        this._renderPagination(0);
        const row = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 8;
        td.style.textAlign = 'center';
        td.style.padding = '20px';
        if (this.spotify && this.spotify.isAuthenticated) {
            td.style.color = '#1DB954';
            td.textContent = 'Connected to Spotify. Search for tracks above.';
        } else {
            td.innerHTML = '<div style="color:#1DB954;margin-bottom:8px">Connect your Spotify account to search tracks</div>' +
                '<button class="btn-toolbar" id="spotify-login-btn" style="color:#1DB954;border-color:#1DB954">LOGIN WITH SPOTIFY</button>' +
                '<div style="color:#555;font-size:0.6rem;margin-top:8px">Uses 30-second previews (free, no premium needed)</div>';
        }
        row.appendChild(td);
        this.tableBody.appendChild(row);

        const loginBtn = document.getElementById('spotify-login-btn');
        if (loginBtn && this.spotify) {
            loginBtn.addEventListener('click', () => this.spotify.login());
        }
    }

    // ===== Browse encoder support for MIDI controllers =====

    selectNext() {
        const list = this._displayedTracks;
        if (list.length === 0) return;
        this.selectedIndex = Math.min(this.selectedIndex + 1, list.length - 1);
        this.selectedTrack = list[this.selectedIndex];
        // Auto-page if needed
        const page = Math.floor(this.selectedIndex / this.pageSize) + 1;
        if (page !== this.currentPage) {
            this.currentPage = page;
            this._renderCurrentPage();
        }
        this._highlightRow();
    }

    selectPrev() {
        const list = this._displayedTracks;
        if (list.length === 0) return;
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.selectedTrack = list[this.selectedIndex];
        const page = Math.floor(this.selectedIndex / this.pageSize) + 1;
        if (page !== this.currentPage) {
            this.currentPage = page;
            this._renderCurrentPage();
        }
        this._highlightRow();
    }

    _getCurrentList() {
        return this._displayedTracks;
    }

    loadToDeck(track, deckId) {
        if (track && (track.source === 'audius' || track.source === 'songchainn')) {
            if (this.onLoadDirect) {
                this.onLoadDirect(deckId, track.streamUrl, track);
            }
        } else if (track && track.source === 'soundcloud') {
            if (this.onLoadDirect && this.soundcloud) {
                this.soundcloud.getStreamUrl(track.sourceId || track.id).then(url => {
                    if (url) {
                        track.streamUrl = url;
                        this.onLoadDirect(deckId, url, track);
                    }
                }).catch(e => console.error('[Library] SoundCloud stream failed:', e));
            }
        } else if (track && track.source === 'spotify') {
            if (this.onLoadDirect && track.streamUrl) {
                this.onLoadDirect(deckId, track.streamUrl, track);
            }
        } else if (track && track.dataFile) {
            this.onLoadTrack(deckId, track.dataFile);
        }
    }

    _highlightRow() {
        if (!this.tableBody) return;
        const pageStart = (this.currentPage - 1) * this.pageSize;
        const rows = this.tableBody.querySelectorAll('tr.lib-track-row');
        rows.forEach((row, i) => {
            row.classList.toggle('selected', (pageStart + i) === this.selectedIndex);
        });
        const localIdx = this.selectedIndex - pageStart;
        if (rows[localIdx]) {
            rows[localIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    async loadManifest() {
        try {
            const resp = await fetch('data/manifest.json');
            const data = await resp.json();
            // Plus the private music source, if one is set (no music files in this repo).
            this.tracks = [...(data.tracks || []), ...await loadSourceManifest()];
            this._filterAndRender();
        } catch (err) {
            console.error('Failed to load manifest:', err);
            if (this.tableBody) {
                this.tableBody.textContent = '';
                const row = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 8;
                td.style.textAlign = 'center';
                td.style.color = '#666';
                td.textContent = 'No local tracks found. Try the AUDIUS tab to stream music.';
                row.appendChild(td);
                this.tableBody.appendChild(row);
            }
        }
    }

    // ===== Core filtering & search =====

    _filterAndRender() {
        const query = (this.searchInput?.value || '').toLowerCase();
        this.filteredTracks = query
            ? this.tracks.filter(t =>
                (t.title || '').toLowerCase().includes(query) ||
                (t.artist || '').toLowerCase().includes(query) ||
                (t.genre || '').toLowerCase().includes(query) ||
                (String(t.bpm) || '').includes(query) ||
                (t.key || '').toLowerCase().includes(query))
            : [...this.tracks];
        this.selectedIndex = -1;
        this.selectedTrack = null;
        this._renderPaginatedTracks(this.filteredTracks, 'local');
    }

    // ===== Search results count =====

    _updateSearchResultsCount(count) {
        const el = document.getElementById('library-search-results');
        if (!el) return;
        const query = (this.searchInput?.value || '').trim();
        if (query && count !== null) {
            el.textContent = `${count} result${count !== 1 ? 's' : ''} for "${query}"`;
            el.classList.remove('hidden');
        } else {
            el.textContent = '';
            el.classList.add('hidden');
        }
    }

    // ===== Sorting =====

    _sortTracks(tracks) {
        if (!this.sortColumn) return tracks;
        const sorted = [...tracks];
        const dir = this.sortDirection === 'asc' ? 1 : -1;
        sorted.sort((a, b) => {
            let va, vb;
            switch (this.sortColumn) {
                case 'title':
                    va = (a.title || '').toLowerCase();
                    vb = (b.title || '').toLowerCase();
                    return va.localeCompare(vb) * dir;
                case 'artist':
                    va = (a.artist || '').toLowerCase();
                    vb = (b.artist || '').toLowerCase();
                    return va.localeCompare(vb) * dir;
                case 'bpm':
                    va = parseFloat(a.bpm) || 0;
                    vb = parseFloat(b.bpm) || 0;
                    return (va - vb) * dir;
                case 'key':
                    va = (a.key || '').toLowerCase();
                    vb = (b.key || '').toLowerCase();
                    return va.localeCompare(vb) * dir;
                case 'duration':
                    va = parseFloat(a.duration) || 0;
                    vb = parseFloat(b.duration) || 0;
                    return (va - vb) * dir;
                default:
                    return 0;
            }
        });
        return sorted;
    }

    // ===== Track key helpers =====

    _getTrackKey(track) {
        if (track.source === 'audius') return `audius:${track.id}`;
        if (track.source === 'soundcloud') return `soundcloud:${track.id}`;
        if (track.source === 'spotify') return `spotify:${track.id}`;
        return track.dataFile || track.id || track.title;
    }

    // ===== Unified paginated rendering =====

    _renderPaginatedTracks(tracks, source) {
        const query = (this.searchInput?.value || '').trim();
        const sorted = this._sortTracks(tracks);
        this._displayedTracks = sorted;

        if (query) {
            this._updateSearchResultsCount(sorted.length);
        } else {
            this._updateSearchResultsCount(null);
        }

        this._renderCurrentPage();
    }

    _renderCurrentPage() {
        if (!this.tableBody) return;
        this.tableBody.textContent = '';

        const tracks = this._displayedTracks;
        const totalPages = Math.max(1, Math.ceil(tracks.length / this.pageSize));
        if (this.currentPage > totalPages) this.currentPage = totalPages;

        const start = (this.currentPage - 1) * this.pageSize;
        const end = Math.min(start + this.pageSize, tracks.length);
        const pageSlice = tracks.slice(start, end);

        // Update bulk select all checkbox
        this._updateSelectAllState(pageSlice);

        if (tracks.length === 0) {
            const row = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 8;
            td.style.textAlign = 'center';
            td.style.color = '#555577';
            td.style.padding = '20px';
            td.textContent = this._getEmptyMessage();
            row.appendChild(td);
            this.tableBody.appendChild(row);
            this._renderPagination(0);
            return;
        }

        pageSlice.forEach((track, idx) => {
            const globalIdx = start + idx;
            const row = this._createTrackRow(track, globalIdx);
            this.tableBody.appendChild(row);
        });

        this._renderPagination(tracks.length);
    }

    _getEmptyMessage() {
        const query = (this.searchInput?.value || '').trim();
        if (this.activeTab === 'local') return query ? 'No local tracks match your search.' : 'No local tracks found. Try the AUDIUS tab to stream music.';
        if (this.activeTab === 'liked') return query ? 'No liked tracks match your search.' : 'No liked tracks yet. Click the heart on any track to add it here.';
        if (this.activeTab === 'recent') return query ? 'No recent tracks match your search.' : 'No recently loaded tracks yet.';
        if (this.activeTab === 'playlists') return 'No playlists yet. Create one to get started.';
        if (this.activeTab === 'audius') return 'No tracks found on Audius';
        if (this.activeTab === 'soundcloud') return 'No tracks found on SoundCloud';
        if (this.activeTab === 'spotify') return 'No tracks found on Spotify';
        return 'No tracks';
    }

    // ===== Single track row builder =====

    _createTrackRow(track, globalIdx) {
        const row = document.createElement('tr');
        row.className = 'lib-track-row';
        row.dataset.trackIdx = globalIdx;

        // Checkbox for bulk select
        const tdCheck = document.createElement('td');
        tdCheck.className = 'lib-checkbox';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'lib-row-check';
        const trackKey = this._getTrackKey(track);
        checkbox.checked = this.selectedIds.has(trackKey);
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                this.selectedIds.add(trackKey);
            } else {
                this.selectedIds.delete(trackKey);
            }
            this._updateBulkBar();
            this._updateSelectAllState(null);
        });
        tdCheck.appendChild(checkbox);

        // Title with optional artwork
        const tdTitle = document.createElement('td');
        tdTitle.className = 'lib-title';
        if (track.artwork) {
            const img = document.createElement('img');
            img.src = track.artwork;
            img.className = 'audius-artwork';
            img.alt = '';
            img.width = 24;
            img.height = 24;
            tdTitle.appendChild(img);
        }
        const titleSpan = document.createElement('span');
        titleSpan.textContent = track.title || '-';
        tdTitle.appendChild(titleSpan);

        const tdArtist = document.createElement('td');
        tdArtist.className = 'lib-artist';
        tdArtist.textContent = track.artist || '-';

        const tdBpm = document.createElement('td');
        tdBpm.className = 'lib-bpm';
        tdBpm.textContent = track.bpm || '-';

        const tdKey = document.createElement('td');
        tdKey.className = 'lib-key';
        tdKey.textContent = track.key || '-';

        const tdDuration = document.createElement('td');
        tdDuration.className = 'lib-duration';
        if (this.activeTab === 'recent' && track.loadedAt) {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'recent-timestamp';
            timeSpan.textContent = this._formatTimeAgo(track.loadedAt);
            timeSpan.title = new Date(track.loadedAt).toLocaleString();
            tdDuration.appendChild(timeSpan);
        } else {
            tdDuration.textContent = this._formatDuration(track.duration);
        }

        // Actions column
        const tdActions = document.createElement('td');
        tdActions.className = 'lib-actions';

        tdActions.appendChild(this._createHeartBtn(track));

        // Save to playlist button
        const btnPlaylist = document.createElement('button');
        btnPlaylist.className = 'btn-load btn-playlist-add';
        btnPlaylist.title = 'Save to Playlist';
        btnPlaylist.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>';
        btnPlaylist.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showPlaylistDropdown(btnPlaylist, track);
        });
        tdActions.appendChild(btnPlaylist);

        const btnA = document.createElement('button');
        btnA.className = 'btn-load btn-load-a';
        btnA.title = 'Load to Deck A';
        btnA.textContent = 'A';
        btnA.addEventListener('click', (e) => {
            e.stopPropagation();
            this.loadToDeck(track, 'A');
        });

        const btnB = document.createElement('button');
        btnB.className = 'btn-load btn-load-b';
        btnB.title = 'Load to Deck B';
        btnB.textContent = 'B';
        btnB.addEventListener('click', (e) => {
            e.stopPropagation();
            this.loadToDeck(track, 'B');
        });

        const btnQ = document.createElement('button');
        btnQ.className = 'btn-load';
        btnQ.title = 'Add to setlist queue';
        btnQ.textContent = '+';
        btnQ.style.color = '#8b5cf6';
        btnQ.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onAddToQueue) this.onAddToQueue(track);
        });

        tdActions.appendChild(btnA);
        tdActions.appendChild(btnB);
        tdActions.appendChild(btnQ);

        row.appendChild(tdCheck);
        row.appendChild(tdTitle);
        row.appendChild(tdArtist);
        row.appendChild(tdBpm);
        row.appendChild(tdKey);
        row.appendChild(tdDuration);
        row.appendChild(tdActions);

        // Double click to load
        row.addEventListener('dblclick', () => {
            this.loadToDeck(track, null);
        });

        // Single click to select
        row.addEventListener('click', () => {
            this.selectedIndex = globalIdx;
            this.selectedTrack = track;
            this._highlightRow();
        });

        // Right-click context menu
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.selectedIndex = globalIdx;
            this.selectedTrack = track;
            this._highlightRow();
            this._showContextMenu(e.clientX, e.clientY, track);
        });

        // Drag support for playlist reorder
        if (this.viewingPlaylist) {
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', globalIdx.toString());
                row.classList.add('lib-row-dragging');
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('lib-row-dragging');
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                row.classList.add('lib-drag-over');
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('lib-drag-over');
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('lib-drag-over');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = globalIdx;
                if (fromIdx !== toIdx && this.playlists && this.viewingPlaylist) {
                    this.playlists.reorderPlaylistTrack(this.viewingPlaylist, fromIdx, toIdx);
                    this._renderPlaylistTracks(this.viewingPlaylist);
                }
            });
        }

        // Highlight selected
        if (globalIdx === this.selectedIndex) {
            row.classList.add('selected');
        }

        return row;
    }

    // ===== Pagination UI =====

    _renderPagination(totalTracks) {
        let paginationEl = document.getElementById('library-pagination');
        if (!paginationEl) return;

        paginationEl.textContent = '';

        if (totalTracks <= this.pageSize) {
            // Just show count
            const countSpan = document.createElement('span');
            countSpan.className = 'lib-page-info';
            countSpan.textContent = `${totalTracks} track${totalTracks !== 1 ? 's' : ''}`;
            paginationEl.appendChild(countSpan);
            return;
        }

        const totalPages = Math.ceil(totalTracks / this.pageSize);

        const prevBtn = document.createElement('button');
        prevBtn.className = 'lib-page-btn';
        prevBtn.textContent = '\u2039 Prev';
        prevBtn.disabled = this.currentPage <= 1;
        prevBtn.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this._renderCurrentPage();
            }
        });

        const info = document.createElement('span');
        info.className = 'lib-page-info';
        info.textContent = `Page ${this.currentPage} of ${totalPages}  |  ${totalTracks} tracks`;

        const nextBtn = document.createElement('button');
        nextBtn.className = 'lib-page-btn';
        nextBtn.textContent = 'Next \u203A';
        nextBtn.disabled = this.currentPage >= totalPages;
        nextBtn.addEventListener('click', () => {
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this._renderCurrentPage();
            }
        });

        paginationEl.appendChild(prevBtn);
        paginationEl.appendChild(info);
        paginationEl.appendChild(nextBtn);
    }

    // ===== Refresh helper =====

    _refreshCurrentView() {
        if (this.activeTab === 'local') {
            this._filterAndRender();
        } else if (this.activeTab === 'liked') {
            this._renderLiked();
        } else if (this.activeTab === 'recent') {
            this._renderRecent();
        } else if (this.activeTab === 'playlists') {
            if (this.viewingPlaylist) {
                this._renderPlaylistTracks(this.viewingPlaylist);
            } else {
                this._renderPlaylistsTab();
            }
        } else if (this.activeTab === 'audius') {
            this._renderPaginatedTracks(this.audiusTracks, 'audius');
        } else if (this.activeTab === 'soundcloud') {
            this._renderPaginatedTracks(this.soundcloudTracks, 'soundcloud');
        } else if (this.activeTab === 'spotify') {
            this._renderPaginatedTracks(this.spotifyTracks, 'spotify');
        }
    }

    // ===== Liked tab =====

    _renderLiked() {
        if (!this.playlists) {
            this._renderError('Playlists not available.');
            return;
        }

        let likedTracks = this.playlists.getLikedTracks();
        const query = (this.searchInput?.value || '').toLowerCase();
        if (query) {
            likedTracks = likedTracks.filter(t =>
                (t.title || '').toLowerCase().includes(query) ||
                (t.artist || '').toLowerCase().includes(query) ||
                (t.genre || '').toLowerCase().includes(query) ||
                (String(t.bpm) || '').includes(query) ||
                (t.key || '').toLowerCase().includes(query));
        }
        this._renderPaginatedTracks(likedTracks, 'liked');
    }

    // ===== Recently loaded tracks tab =====

    _renderRecent() {
        let recentTracks = [];
        try {
            recentTracks = JSON.parse(localStorage.getItem('aurdour_recent_tracks') || '[]');
        } catch {
            recentTracks = [];
        }

        const query = (this.searchInput?.value || '').toLowerCase();
        if (query) {
            recentTracks = recentTracks.filter(t =>
                (t.title || '').toLowerCase().includes(query) ||
                (t.artist || '').toLowerCase().includes(query) ||
                (t.fileName || '').toLowerCase().includes(query));
        }

        this._renderPaginatedTracks(recentTracks, 'recent');
    }

    // ===== Playlists tab =====

    _renderPlaylistsTab() {
        if (!this.tableBody) return;
        this.tableBody.textContent = '';
        this._displayedTracks = [];
        this._renderPagination(0);
        this.selectedIndex = -1;
        this.selectedTrack = null;

        if (!this.playlists) {
            this._renderError('Playlists not available.');
            return;
        }

        const allPlaylists = this.playlists.getPlaylists();
        const query = (this.searchInput?.value || '').toLowerCase();
        const filtered = query
            ? allPlaylists.filter(p => p.name.toLowerCase().includes(query))
            : allPlaylists;

        if (filtered.length === 0) {
            const row = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 8;
            td.style.textAlign = 'center';
            td.style.color = '#555577';
            td.style.padding = '20px';
            td.innerHTML = query
                ? 'No playlists match your search.'
                : 'No playlists yet. <button class="btn-load" id="lib-create-pl-empty" style="color:var(--accent-a)">+ Create Playlist</button>';
            row.appendChild(td);
            this.tableBody.appendChild(row);
            const createBtn = document.getElementById('lib-create-pl-empty');
            if (createBtn) {
                createBtn.addEventListener('click', () => this._showCreatePlaylistDialog());
            }
            return;
        }

        // Create playlist header row
        const headerRow = document.createElement('tr');
        headerRow.className = 'lib-playlist-header-row';
        const headerTd = document.createElement('td');
        headerTd.colSpan = 8;
        headerTd.style.padding = '6px 12px';
        headerTd.style.textAlign = 'right';
        const createBtn = document.createElement('button');
        createBtn.className = 'btn-load';
        createBtn.style.color = 'var(--accent-a)';
        createBtn.textContent = '+ New Playlist';
        createBtn.addEventListener('click', () => this._showCreatePlaylistDialog());
        headerTd.appendChild(createBtn);
        headerRow.appendChild(headerTd);
        this.tableBody.appendChild(headerRow);

        filtered.forEach(pl => {
            const row = document.createElement('tr');
            row.className = 'lib-playlist-row';

            const tdCheck = document.createElement('td');
            tdCheck.className = 'lib-checkbox';
            tdCheck.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-a);opacity:0.6"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';

            const tdName = document.createElement('td');
            tdName.className = 'lib-title lib-playlist-name';
            tdName.colSpan = 2;
            const nameSpan = document.createElement('span');
            nameSpan.textContent = pl.name;
            tdName.appendChild(nameSpan);

            // Double-click to rename
            tdName.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this._inlineRenamePlaylist(nameSpan, pl.id);
            });

            const tdCount = document.createElement('td');
            tdCount.className = 'lib-bpm';
            tdCount.textContent = `${pl.tracks.length} track${pl.tracks.length !== 1 ? 's' : ''}`;

            const tdBlank1 = document.createElement('td');
            tdBlank1.className = 'lib-key';
            tdBlank1.textContent = '';

            const tdBlank2 = document.createElement('td');
            tdBlank2.className = 'lib-duration';
            tdBlank2.textContent = '';

            const tdActions = document.createElement('td');
            tdActions.className = 'lib-actions';

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-load';
            delBtn.title = 'Delete playlist';
            delBtn.style.color = '#ff6b6b';
            delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Delete playlist "${pl.name}"?`)) {
                    this.playlists.deletePlaylist(pl.id);
                    this._renderPlaylistsTab();
                }
            });
            tdActions.appendChild(delBtn);

            row.appendChild(tdCheck);
            row.appendChild(tdName);
            row.appendChild(tdCount);
            row.appendChild(tdBlank1);
            row.appendChild(tdBlank2);
            row.appendChild(tdActions);

            // Click to view playlist tracks
            row.addEventListener('click', () => {
                this.viewingPlaylist = pl.id;
                this._renderPlaylistTracks(pl.id);
            });

            this.tableBody.appendChild(row);
        });
    }

    _renderPlaylistTracks(playlistId) {
        if (!this.playlists) return;
        const pl = this.playlists.getPlaylists().find(p => p.id === playlistId);
        if (!pl) {
            this.viewingPlaylist = null;
            this._renderPlaylistsTab();
            return;
        }

        // Build track objects from stored track data
        const trackObjs = this.playlists.getPlaylistTrackObjects(playlistId);

        // Add back button row
        if (!this.tableBody) return;
        this.tableBody.textContent = '';

        const backRow = document.createElement('tr');
        backRow.className = 'lib-playlist-header-row';
        const backTd = document.createElement('td');
        backTd.colSpan = 8;
        backTd.style.padding = '6px 12px';
        backTd.style.display = 'flex';
        backTd.style.alignItems = 'center';
        backTd.style.gap = '12px';

        const backBtn = document.createElement('button');
        backBtn.className = 'btn-load';
        backBtn.style.color = 'var(--accent-a)';
        backBtn.innerHTML = '\u2039 All Playlists';
        backBtn.addEventListener('click', () => {
            this.viewingPlaylist = null;
            this._renderPlaylistsTab();
        });

        const playlistTitle = document.createElement('span');
        playlistTitle.style.cssText = 'font-family:var(--font-mono);font-size:0.7rem;font-weight:700;color:var(--text-primary);';
        playlistTitle.textContent = `${pl.name} (${pl.tracks.length} tracks)`;

        backTd.appendChild(backBtn);
        backTd.appendChild(playlistTitle);
        backRow.appendChild(backTd);
        this.tableBody.appendChild(backRow);

        // Now render tracks with pagination
        this._displayedTracks = trackObjs;
        const totalPages = Math.max(1, Math.ceil(trackObjs.length / this.pageSize));
        if (this.currentPage > totalPages) this.currentPage = totalPages;

        const start = (this.currentPage - 1) * this.pageSize;
        const end = Math.min(start + this.pageSize, trackObjs.length);
        const pageSlice = trackObjs.slice(start, end);

        if (trackObjs.length === 0) {
            const row = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 8;
            td.style.textAlign = 'center';
            td.style.color = '#555577';
            td.style.padding = '20px';
            td.textContent = 'This playlist is empty. Add tracks using the folder icon.';
            row.appendChild(td);
            this.tableBody.appendChild(row);
        } else {
            pageSlice.forEach((track, idx) => {
                const globalIdx = start + idx;
                const row = this._createTrackRow(track, globalIdx);
                this.tableBody.appendChild(row);
            });
        }

        this._renderPagination(trackObjs.length);
    }

    _inlineRenamePlaylist(nameSpan, playlistId) {
        const currentName = nameSpan.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'lib-inline-rename';
        input.style.cssText = 'background:var(--bg-input);border:1px solid var(--accent-a);color:var(--text-primary);font-size:0.74rem;padding:2px 6px;border-radius:3px;width:200px;outline:none;';
        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
                this.playlists.renamePlaylist(playlistId, newName);
            }
            const newSpan = document.createElement('span');
            newSpan.textContent = newName || currentName;
            input.replaceWith(newSpan);
            newSpan.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this._inlineRenamePlaylist(newSpan, playlistId);
            });
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') {
                const newSpan = document.createElement('span');
                newSpan.textContent = currentName;
                input.replaceWith(newSpan);
                newSpan.addEventListener('dblclick', (ev) => {
                    ev.stopPropagation();
                    this._inlineRenamePlaylist(newSpan, playlistId);
                });
            }
        });
    }

    _showCreatePlaylistDialog() {
        const overlay = document.createElement('div');
        overlay.className = 'lib-dialog-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        const dialog = document.createElement('div');
        dialog.className = 'lib-dialog';
        dialog.innerHTML = `
            <div class="lib-dialog-title">Create New Playlist</div>
            <input type="text" class="lib-dialog-input" id="lib-new-pl-name" placeholder="Playlist name..." autofocus>
            <div class="lib-dialog-actions">
                <button class="btn-load" id="lib-dialog-cancel" style="color:var(--text-dim)">Cancel</button>
                <button class="btn-load btn-load-a" id="lib-dialog-create">Create</button>
            </div>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const nameInput = document.getElementById('lib-new-pl-name');
        const cancelBtn = document.getElementById('lib-dialog-cancel');
        const createBtnEl = document.getElementById('lib-dialog-create');

        cancelBtn.addEventListener('click', () => overlay.remove());
        createBtnEl.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (name && this.playlists) {
                this.playlists.createPlaylist(name);
                overlay.remove();
                if (this.activeTab === 'playlists') {
                    this._renderPlaylistsTab();
                }
            }
        });
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtnEl.click();
            if (e.key === 'Escape') overlay.remove();
        });
        setTimeout(() => nameInput.focus(), 50);
    }

    // ===== Playlist dropdown on track =====

    _showPlaylistDropdown(anchorEl, track) {
        // Remove existing dropdown
        document.querySelectorAll('.lib-playlist-dropdown').forEach(el => el.remove());

        if (!this.playlists) return;
        const allPlaylists = this.playlists.getPlaylists();

        const dropdown = document.createElement('div');
        dropdown.className = 'lib-playlist-dropdown';

        if (allPlaylists.length > 0) {
            allPlaylists.forEach(pl => {
                const item = document.createElement('div');
                item.className = 'lib-pl-dropdown-item';
                item.textContent = `${pl.name} (${pl.tracks.length})`;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.playlists.addTrackToPlaylist(pl.id, track);
                    dropdown.remove();
                    // Flash feedback
                    anchorEl.style.color = '#00d4ff';
                    setTimeout(() => { anchorEl.style.color = ''; }, 500);
                });
                dropdown.appendChild(item);
            });

            const divider = document.createElement('div');
            divider.className = 'lib-pl-dropdown-divider';
            dropdown.appendChild(divider);
        }

        const newItem = document.createElement('div');
        newItem.className = 'lib-pl-dropdown-item lib-pl-dropdown-new';
        newItem.textContent = '+ New Playlist';
        newItem.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.remove();
            this._showCreatePlaylistDialog();
        });
        dropdown.appendChild(newItem);

        // Position the dropdown
        anchorEl.style.position = 'relative';
        anchorEl.parentElement.style.position = 'relative';
        anchorEl.parentElement.appendChild(dropdown);

        // Close on outside click
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== anchorEl) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    // ===== Context menu =====

    _showContextMenu(x, y, track) {
        const menu = this._contextMenu;
        if (!menu) return;
        menu.textContent = '';
        menu.classList.remove('hidden');

        const items = [
            { label: 'Load to Deck A', icon: 'A', action: () => this.loadToDeck(track, 'A') },
            { label: 'Load to Deck B', icon: 'B', action: () => this.loadToDeck(track, 'B') },
            { type: 'divider' },
            { label: 'Add to Queue', icon: '+', action: () => { if (this.onAddToQueue) this.onAddToQueue(track); } },
            { label: 'Add to Playlist', icon: '\uD83D\uDCC1', submenu: true, action: () => this._showContextPlaylistSubmenu(menu, track) },
            { type: 'divider' },
            { label: this.playlists?.isLiked(track) ? 'Unlike' : 'Like', icon: '\u2665', action: () => {
                if (this.playlists) {
                    this.playlists.toggleLike(track);
                    this._hideContextMenu();
                    this._refreshCurrentView();
                }
            }},
        ];

        // Add remove option if viewing a playlist
        if (this.viewingPlaylist && this.playlists) {
            items.push({ type: 'divider' });
            items.push({
                label: 'Remove from Playlist', icon: '\u2715', action: () => {
                    const trackKey = this._getTrackKey(track);
                    this.playlists.removeTrackFromPlaylist(this.viewingPlaylist, trackKey);
                    this._hideContextMenu();
                    this._renderPlaylistTracks(this.viewingPlaylist);
                }
            });
        }

        items.forEach(item => {
            if (item.type === 'divider') {
                const div = document.createElement('div');
                div.className = 'lib-ctx-divider';
                menu.appendChild(div);
                return;
            }
            const el = document.createElement('div');
            el.className = 'lib-ctx-item';
            const iconSpan = document.createElement('span');
            iconSpan.className = 'lib-ctx-icon';
            iconSpan.textContent = item.icon;
            el.appendChild(iconSpan);
            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.label;
            el.appendChild(labelSpan);
            if (item.submenu) {
                const arrow = document.createElement('span');
                arrow.className = 'lib-ctx-arrow';
                arrow.textContent = '\u203A';
                el.appendChild(arrow);
            }
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                item.action();
                if (!item.submenu) this._hideContextMenu();
            });
            menu.appendChild(el);
        });

        // Position ensuring it stays on screen
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = (x - rect.width) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = (y - rect.height) + 'px';
            }
        });
    }

    _showContextPlaylistSubmenu(parentMenu, track) {
        // Remove any existing submenu
        document.querySelectorAll('.lib-ctx-submenu').forEach(el => el.remove());

        if (!this.playlists) return;
        const allPlaylists = this.playlists.getPlaylists();

        const submenu = document.createElement('div');
        submenu.className = 'lib-ctx-submenu';

        allPlaylists.forEach(pl => {
            const item = document.createElement('div');
            item.className = 'lib-ctx-item';
            item.textContent = `${pl.name} (${pl.tracks.length})`;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playlists.addTrackToPlaylist(pl.id, track);
                this._hideContextMenu();
            });
            submenu.appendChild(item);
        });

        if (allPlaylists.length > 0) {
            const div = document.createElement('div');
            div.className = 'lib-ctx-divider';
            submenu.appendChild(div);
        }

        const newItem = document.createElement('div');
        newItem.className = 'lib-ctx-item lib-pl-dropdown-new';
        newItem.textContent = '+ New Playlist';
        newItem.addEventListener('click', (e) => {
            e.stopPropagation();
            this._hideContextMenu();
            this._showCreatePlaylistDialog();
        });
        submenu.appendChild(newItem);

        parentMenu.appendChild(submenu);
    }

    _hideContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.classList.add('hidden');
            this._contextMenu.textContent = '';
        }
        document.querySelectorAll('.lib-ctx-submenu').forEach(el => el.remove());
    }

    // ===== Bulk actions =====

    _updateSelectAllState(pageSlice) {
        const selectAllCb = document.getElementById('lib-select-all');
        if (!selectAllCb) return;

        if (!pageSlice) {
            // Recompute from current page
            const start = (this.currentPage - 1) * this.pageSize;
            const end = Math.min(start + this.pageSize, this._displayedTracks.length);
            pageSlice = this._displayedTracks.slice(start, end);
        }

        if (pageSlice.length === 0) {
            selectAllCb.checked = false;
            selectAllCb.indeterminate = false;
            return;
        }

        const allSelected = pageSlice.every(t => this.selectedIds.has(this._getTrackKey(t)));
        const someSelected = pageSlice.some(t => this.selectedIds.has(this._getTrackKey(t)));
        selectAllCb.checked = allSelected;
        selectAllCb.indeterminate = someSelected && !allSelected;
    }

    _updateBulkBar() {
        const bar = document.getElementById('library-bulk-bar');
        if (!bar) return;
        const countEl = document.getElementById('library-bulk-count');

        if (this.selectedIds.size > 0) {
            bar.classList.remove('hidden');
            if (countEl) countEl.textContent = `${this.selectedIds.size} selected`;
        } else {
            bar.classList.add('hidden');
        }
    }

    _getSelectedTracks() {
        return this._displayedTracks.filter(t => this.selectedIds.has(this._getTrackKey(t)));
    }

    bulkAddToQueue() {
        if (!this.onAddToQueue) return;
        const tracks = this._getSelectedTracks();
        tracks.forEach(t => this.onAddToQueue(t));
        this.selectedIds.clear();
        this._updateBulkBar();
        this._renderCurrentPage();
    }

    bulkLike() {
        if (!this.playlists) return;
        const tracks = this._getSelectedTracks();
        tracks.forEach(t => {
            if (!this.playlists.isLiked(t)) {
                this.playlists.toggleLike(t);
            }
        });
        this.selectedIds.clear();
        this._updateBulkBar();
        this._renderCurrentPage();
    }

    bulkAddToPlaylist() {
        const tracks = this._getSelectedTracks();
        if (tracks.length === 0) return;

        // Show playlist picker for bulk
        const overlay = document.createElement('div');
        overlay.className = 'lib-dialog-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const dialog = document.createElement('div');
        dialog.className = 'lib-dialog';

        let html = `<div class="lib-dialog-title">Add ${tracks.length} tracks to playlist</div>`;
        const allPlaylists = this.playlists ? this.playlists.getPlaylists() : [];
        if (allPlaylists.length > 0) {
            html += '<div style="max-height:200px;overflow-y:auto;margin:8px 0">';
            allPlaylists.forEach(pl => {
                html += `<div class="lib-pl-dropdown-item" data-plid="${esc(pl.id)}">${esc(pl.name)} (${pl.tracks.length})</div>`;
            });
            html += '</div>';
        }
        html += `<div class="lib-dialog-actions">
            <button class="btn-load" id="lib-bulk-pl-cancel" style="color:var(--text-dim)">Cancel</button>
            <button class="btn-load btn-load-a" id="lib-bulk-pl-new">+ New Playlist</button>
        </div>`;
        dialog.innerHTML = html;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        dialog.querySelectorAll('.lib-pl-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const plId = item.dataset.plid;
                tracks.forEach(t => this.playlists.addTrackToPlaylist(plId, t));
                overlay.remove();
                this.selectedIds.clear();
                this._updateBulkBar();
                this._renderCurrentPage();
            });
        });

        document.getElementById('lib-bulk-pl-cancel')?.addEventListener('click', () => overlay.remove());
        document.getElementById('lib-bulk-pl-new')?.addEventListener('click', () => {
            overlay.remove();
            this._showCreatePlaylistDialog();
        });
    }

    // ===== Heart button helper =====

    _createHeartBtn(track) {
        const btn = document.createElement('button');
        btn.className = 'btn-heart';
        const liked = this.playlists ? this.playlists.isLiked(track) : false;
        btn.classList.toggle('liked', liked);
        btn.title = liked ? 'Unlike' : 'Like';
        btn.innerHTML = liked
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this.playlists) return;
            const nowLiked = this.playlists.toggleLike(track);
            btn.classList.toggle('liked', nowLiked);
            btn.title = nowLiked ? 'Unlike' : 'Like';
            btn.innerHTML = nowLiked
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            if (this.activeTab === 'liked' && !nowLiked) {
                this._renderLiked();
            }
            btn.style.transform = 'scale(1.3)';
            setTimeout(() => { btn.style.transform = ''; }, 200);
        });
        return btn;
    }

    // ===== Utility =====

    _renderLoading(msg) {
        if (!this.tableBody) return;
        this.tableBody.textContent = '';
        this._displayedTracks = [];
        this._renderPagination(0);
        const row = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 8;
        td.style.textAlign = 'center';
        td.style.color = '#8888aa';
        td.style.padding = '20px';
        td.innerHTML = `<span class="audius-loading-spinner"></span> ${esc(msg)}`;
        row.appendChild(td);
        this.tableBody.appendChild(row);
    }

    _renderError(msg) {
        if (!this.tableBody) return;
        this.tableBody.textContent = '';
        this._displayedTracks = [];
        this._renderPagination(0);
        const row = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 8;
        td.style.textAlign = 'center';
        td.style.color = '#ff6b6b';
        td.style.padding = '16px';
        td.textContent = msg;
        row.appendChild(td);
        this.tableBody.appendChild(row);
    }

    _formatDuration(seconds) {
        if (!seconds) return '-';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    _formatTimeAgo(timestamp) {
        if (!timestamp) return '-';
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        return new Date(timestamp).toLocaleDateString();
    }
}
