// Audius.js — Audius music platform integration
// Uses the public Audius API to search, browse trending, and stream tracks

export class Audius {
    constructor() {
        this.host = null;
        this.appName = 'AURDOUR';
        this._hostPromise = this._resolveHost();
    }

    async _resolveHost() {
        try {
            const resp = await fetch('https://api.audius.co');
            const json = await resp.json();
            const hosts = json.data;
            if (hosts && hosts.length > 0) {
                this.host = hosts[Math.floor(Math.random() * hosts.length)];
            }
        } catch (e) {
            console.warn('[Audius] Failed to resolve API host, using fallback');
        }
        if (!this.host) {
            this.host = 'https://discoveryprovider.audius.co';
        }
        return this.host;
    }

    async _ensureHost() {
        if (!this.host) await this._hostPromise;
        return this.host;
    }

    async _apiGet(path) {
        const host = await this._ensureHost();
        const separator = path.includes('?') ? '&' : '?';
        const url = `${host}${path}${separator}app_name=${this.appName}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Audius API error: ${resp.status}`);
        return resp.json();
    }

    async search(query) {
        if (!query || query.trim().length < 2) return [];
        const data = await this._apiGet(`/v1/tracks/search?query=${encodeURIComponent(query)}`);
        return (data.data || []).map(t => this._normalizeTrack(t));
    }

    async getTrending(limit = 20) {
        const data = await this._apiGet(`/v1/tracks/trending?limit=${limit}`);
        return (data.data || []).map(t => this._normalizeTrack(t));
    }

    // Every track on one artist's Audius page, by their handle.
    async getUserTracks(handle, limit = 100) {
        const user = await this._apiGet(`/v1/users/handle/${encodeURIComponent(handle)}`);
        const id = user?.data?.id;
        if (!id) return [];
        return this.getUserIdTracks(id, limit);
    }

    // Every track on one artist's Audius page, by their Audius user id.
    async getUserIdTracks(id, limit = 100) {
        const data = await this._apiGet(`/v1/users/${encodeURIComponent(id)}/tracks?limit=${limit}`);
        return (data.data || []).map(t => this._normalizeTrack(t));
    }

    // Every track on an Audius playlist, by its page link (audius.co/<handle>/playlist/<name>).
    async getPlaylistTracks(url) {
        const found = await this._apiGet(`/v1/resolve?url=${encodeURIComponent(url)}`);
        const p = Array.isArray(found?.data) ? found.data[0] : found?.data;
        if (!p?.id) return [];
        const data = await this._apiGet(`/v1/playlists/${p.id}/tracks`);
        return (data.data || []).map(t => this._normalizeTrack(t));
    }

    // Several tracks at once by their Audius ids (the HOUSE set). Missing or private ids are left out.
    async getTracksByIds(ids) {
        const list = (ids || []).map((id) => encodeURIComponent(id)).filter(Boolean);
        if (!list.length) return [];
        const data = await this._apiGet(`/v1/tracks?${list.map((id) => 'id=' + id).join('&')}`);
        return (data.data || []).map(t => this._normalizeTrack(t));
    }

    // One track by its page link (audius.co/<handle>/<song>), or null. `accept` sees what Audius
    // found before it counts (SongLink.audiusExact: that exact track, public and streamable).
    async resolveTrack(url, accept = () => true) {
        const found = await this._apiGet(`/v1/resolve?url=${encodeURIComponent(url)}`);
        const t = Array.isArray(found?.data) ? found.data[0] : found?.data;
        return t && accept(t) ? this._normalizeTrack(t) : null;
    }

    getStreamUrl(trackId) {
        return `${this.host}/v1/tracks/${trackId}/stream?app_name=${this.appName}`;
    }

    _normalizeTrack(raw) {
        return {
            id: raw.id,
            title: raw.title || 'Unknown',
            artist: raw.user?.name || 'Unknown Artist',
            duration: raw.duration || 0,
            bpm: raw.bpm || null,
            key: raw.musical_key || null,
            genre: raw.genre || '',
            artwork: raw.artwork?.['150x150'] || raw.artwork?.small || null,
            playCount: raw.play_count || 0,
            source: 'audius',
            streamUrl: this.getStreamUrl(raw.id),
            // The licence the artist set on Audius (often blank) and whose page it is on;
            // Licence.js reads both.
            audiusLicense: raw.license || null,
            uploader: raw.user?.handle || null,
            // Audius marks a song it will not stream (gated or taken down) with is_streamable false.
            streamable: raw.is_streamable !== false,
        };
    }
}
