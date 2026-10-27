// TwitchChat.js — Twitch IRC chat integration via WebSocket
// Supports anonymous read-only mode and authenticated mode with OAuth

export class TwitchChat {
    constructor(onChatMessage, onSongRequest, onCommand) {
        this.ws = null;
        this.channel = null;
        this.nick = null;
        this.oauthToken = null;
        this.isConnected = false;
        this.isAuthenticated = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.viewerCount = 0;

        this.onChatMessage = onChatMessage || (() => {});
        this.onSongRequest = onSongRequest || (() => {});
        this.onCommand = onCommand || (() => {});
        this.onConnectionChange = () => {};
        this.onViewerCount = () => {};
        this.onError = () => {};

        this.nowPlaying = { title: '', artist: '' };
        this.requestQueue = [];
        this.maxRequests = 25;
    }

    connectAnonymous(channel) {
        this.channel = channel.toLowerCase().replace(/^#/, '');
        this.nick = 'justinfan' + Math.floor(10000 + Math.random() * 90000);
        this.oauthToken = null;
        this.isAuthenticated = false;
        this._connect();
    }

    connectAuthenticated(channel, nick, oauthToken) {
        this.channel = channel.toLowerCase().replace(/^#/, '');
        this.nick = nick.toLowerCase();
        this.oauthToken = oauthToken.replace(/^oauth:/i, '');
        this.isAuthenticated = true;
        this._connect();
    }

    disconnect() {
        this.reconnectAttempts = this.maxReconnectAttempts;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.pingTimer);
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.onConnectionChange(false, this.channel);
    }

    sendMessage(message) {
        if (!this.isConnected || !this.isAuthenticated || !this.ws) return false;
        try {
            this.ws.send('PRIVMSG #' + this.channel + ' :' + message);
            return true;
        } catch (_) { return false; }
    }

    broadcastNowPlaying(title, artist) {
        this.nowPlaying = { title, artist };
        if (this.isAuthenticated && this.isConnected) {
            this.sendMessage(artist ? `Now Playing: ${title} - ${artist}` : `Now Playing: ${title}`);
        }
    }

    setNowPlaying(title, artist) { this.nowPlaying = { title, artist }; }
    getRequestQueue() { return [...this.requestQueue]; }
    clearRequestQueue() { this.requestQueue = []; }
    removeRequest(index) {
        return (index >= 0 && index < this.requestQueue.length) ? this.requestQueue.splice(index, 1)[0] : null;
    }

    _connect() {
        if (this.ws) { try { this.ws.close(); } catch (_) {} }
        this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

        this.ws.onopen = () => {
            this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
            if (this.isAuthenticated && this.oauthToken) this.ws.send('PASS oauth:' + this.oauthToken);
            this.ws.send('NICK ' + this.nick);
        };

        this.ws.onmessage = (event) => {
            for (const line of event.data.split('\r\n')) {
                if (line) this._handleMessage(line);
            }
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            clearInterval(this.pingTimer);
            this.onConnectionChange(false, this.channel);
            this._tryReconnect();
        };

        this.ws.onerror = () => this.onError('WebSocket connection error');
    }

    _tryReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
        this.reconnectTimer = setTimeout(() => {
            if (this.isAuthenticated) this.connectAuthenticated(this.channel, this.nick, this.oauthToken);
            else this.connectAnonymous(this.channel);
        }, delay);
    }

    _handleMessage(raw) {
        if (raw.startsWith('PING')) { this.ws.send('PONG :tmi.twitch.tv'); return; }

        if (raw.includes('001')) {
            this.ws.send('JOIN #' + this.channel);
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.onConnectionChange(true, this.channel);
            this._startPing();
            return;
        }

        const parsed = this._parsePrivMsg(raw);
        if (!parsed) return;
        const msgLower = parsed.message.trim().toLowerCase();

        if (msgLower.startsWith('!songrequest ') || msgLower.startsWith('!sr ')) {
            const query = parsed.message.replace(/^!(songrequest|sr)\s+/i, '').trim();
            if (query && this.requestQueue.length < this.maxRequests) {
                const request = { user: parsed.displayName, query, timestamp: Date.now(), platform: 'twitch' };
                this.requestQueue.push(request);
                this.onSongRequest(request);
            }
            return;
        }

        if (msgLower === '!queue' || msgLower === '!q') {
            this.onCommand({ command: 'queue', user: parsed.displayName, platform: 'twitch' });
            return;
        }

        if (msgLower === '!np' || msgLower === '!nowplaying' || msgLower === '!song') {
            if (this.isAuthenticated && this.nowPlaying.title) {
                const np = this.nowPlaying.artist
                    ? `Now Playing: ${this.nowPlaying.title} - ${this.nowPlaying.artist}`
                    : `Now Playing: ${this.nowPlaying.title}`;
                this.sendMessage(np);
            }
            this.onCommand({ command: 'np', user: parsed.displayName, platform: 'twitch' });
            return;
        }

        this.onChatMessage({
            user: parsed.displayName,
            message: parsed.message,
            color: parsed.color,
            emotes: parsed.emotes,
            platform: 'twitch',
            timestamp: Date.now(),
        });
    }

    _parsePrivMsg(raw) {
        if (!raw.includes('PRIVMSG')) return null;
        let tags = {}, rest = raw;
        if (raw.startsWith('@')) {
            const tagEnd = raw.indexOf(' ');
            rest = raw.substring(tagEnd + 1);
            for (const pair of raw.substring(1, tagEnd).split(';')) {
                const eq = pair.indexOf('=');
                if (eq !== -1) tags[pair.substring(0, eq)] = pair.substring(eq + 1);
            }
        }
        const m = rest.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/);
        if (!m) return null;
        return {
            username: m[1],
            displayName: tags['display-name'] || m[1],
            message: m[2],
            color: tags['color'] || this._defaultColor(m[1]),
            emotes: this._parseEmotes(tags['emotes'] || '', m[2]),
        };
    }

    _parseEmotes(emoteStr, message) {
        if (!emoteStr) return [];
        const emotes = [];
        for (const part of emoteStr.split('/')) {
            const ci = part.indexOf(':');
            if (ci === -1) continue;
            const id = part.substring(0, ci);
            for (const pos of part.substring(ci + 1).split(',')) {
                const r = pos.split('-').map(Number);
                emotes.push({
                    id, start: r[0], end: r[1],
                    text: message.substring(r[0], r[1] + 1),
                    url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`,
                });
            }
        }
        return emotes.sort((a, b) => a.start - b.start);
    }

    _defaultColor(username) {
        const colors = ['#FF0000','#0000FF','#008000','#B22222','#FF7F50','#9ACD32','#FF4500','#2E8B57','#DAA520','#D2691E','#5F9EA0','#1E90FF','#FF69B4','#8A2BE2','#00FF7F'];
        let hash = 0;
        for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    }

    _startPing() {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('PING :tmi.twitch.tv');
        }, 240000);
    }
}
