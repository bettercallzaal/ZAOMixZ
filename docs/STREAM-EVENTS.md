# Stream events: what works today, and a proposed contract

Status: **proposal**. Nothing in this file has been built yet. Part 1 is measured from the code at `6ee5264`; part 2 is the contract to agree before any of it is built.

## Part 1. What the live-stream features actually do today

| Feature | Where | What it really does | Works? |
|---|---|---|---|
| GO LIVE button | `web/dj/StreamBroadcast.js` | Flips `isLive` and lets events out on the `aurdour-dj` BroadcastChannel. It does not send any audio anywhere. | Partly |
| Song title to overlays | `StreamBroadcast.updateTrackInfo`, `sendNowPlaying`, `updatePlayState` (lines 34, 43, 53) | These are defined, but **nothing in the app calls them**. The only producers wired up are crossfader position and transition state (`web/player.js` lines 192 and 199). So `overlay.html`, `obs-overlay.html` and `audience.html` never get the song that is playing. | **No** |
| Overlay and audience pages | `web/overlay.html`, `web/obs-overlay.html`, `web/audience.html` | They listen on BroadcastChannel `aurdour-dj`. A BroadcastChannel only reaches pages in the **same browser profile on the same machine**. OBS's browser source is a separate browser, so by how the API works it gets nothing (not tested in OBS). Audience reactions and requests reach the desk only from another tab of the same browser. | Same browser only |
| Twitch chat | `web/dj/TwitchChat.js` | Reads chat anonymously over IRC WebSocket and spots song requests. The requests go to a text list (`web/player.js` line 1688), **not** to the request line or DJ MixZ. The CHAT panel is archived. | Reads, goes nowhere |
| YouTube Live chat | `web/dj/YouTubeLive.js` | Polls the YouTube Data API using an API key typed into the page. Requests go to the same text list as Twitch. Archived. | Needs a key, goes nowhere |
| Phone remote and listening | `web/dj/RemoteLink.js` | **The one path that works across machines.** It runs through a public relay (`BROKERS`, line 206), sealed end to end, with a 128 bit token and a one-time allow at the desk. The desk sends a state snapshot 5 times a second (`STATE_HZ`): both decks, now and next, the request board. The phone can listen to the mix over a direct WebRTC call (`_listen`, line 528). Every command from a phone is checked against an allowlist (`cleanCommand`, line 50), and viewers get `VIEWER_OK` only. | Yes (pure parts tested) |
| Request line | `web/dj/RequestLine.js` | A listener on a phone calls in a song, and DJ MixZ slots it in oldest first. Tested. | Yes |

So today there is one real pipe off the machine, the RemoteLink relay. There is also one same-browser pipe, the BroadcastChannel, and it never carries song titles.

## Part 2. Proposed contract

### Principles
1. **Read freely, act through a person.** An outside agent (an overlay, a bot, another AI) can read the events. The only thing it can send in is a *recommendation*. That recommendation shows up as one of the Flow Director's picks and needs a tap at the desk. No outside agent gets play, cue, load or crossfader commands.
2. **No credentials in events.** No relay token, API key, OAuth token, device id or call address ever goes into an event. An agent joins the relay with a viewer link, the same way a listener's phone does.
3. **Only what the stream already shows.** Song, artist, licence holder, what the mix is doing, request titles and the first names callers typed. Nothing else.
4. **Chat is moderated before it is an event.** Chat goes out only after the desk's filter has passed it.

### Envelope
Every event has the same shape:

```json
{ "v": 1, "type": "track.changed", "at": 1729280000000, "seq": 42, "data": { } }
```

- `v` is the contract version. A reader ignores a `v` it does not know.
- `at` is milliseconds since the epoch, from the desk's clock.
- `seq` goes up by one per event, so a reader can see a gap.

### Events out (desk to the world)

| type | data | when |
|---|---|---|
| `track.changed` | `deck`, `title`, `artist`, `source`, `licence: { holder, radio }`, `link` | the song the room hears changes (the deck the crossfader is sending out) |
| `transition.started` | `from`, `to`, `type` (blend, echo-out, cut, filter-sweep), `seconds`, `why` | a handover starts |
| `transition.finished` | `outcome` (`mixed`, `cut`, `cancelled`, `dropped`), `title`, `reason` | a handover ends, however it ends |
| `stream.health` | `live`, `liveSince`, `audio` (`running` or `suspended`), `deadAir` (`on`, `silentMs`), `loading` | every 5 seconds, and at once when any value changes |
| `request.updated` | `rid`, `title`, `artist`, `name`, `also` (a count), `status` (`waiting`, `next`, `onair`, `played`, `passed`) | a request is added or changes status |
| `chat.message` | `platform`, `user`, `text` | a chat line the moderation filter passed |
| `director.advice` | `next: { title, why }`, `alts: [{ title, why, better }]` | the Flow Director's advice for the slot coming up changes |

### Events in (the world to the desk)

| type | data | what the desk does |
|---|---|---|
| `request.new` | `track` (an id from the desk's `tracks` list), `name`, `note` | the same path as a phone request: the request line's limits, then the board |
| `agent.recommendation` | `track` (an id from the `tracks` list), `why` (at most 140 characters), `agent` (a name) | it appears as a Flow Director pick, labelled with the agent's name. Nothing plays until a person taps it. At most 1 every 30 seconds per agent |

The desk drops anything else, the same way `cleanCommand` drops unknown phone commands today.

### Transport
- **Same machine:** the existing `aurdour-dj` BroadcastChannel carries these same envelopes, for overlays opened in the same browser.
- **Anywhere else:** the existing RemoteLink relay. An outside agent is a viewer on that relay. It receives the events and may send only `request.new` and `agent.recommendation`.
- No new server, and no new dependency.

## What to build, in order (each its own PR)
1. Wire `track.changed` and `transition.finished`. This is the first one because overlays show no song titles today.
2. Send the same events over the relay, so the OBS overlay works as a viewer link instead of over BroadcastChannel.
3. Route Twitch and YouTube chat requests into the request line, with a simple moderation filter.
4. `agent.recommendation` into the Flow Director, with the rate limit.
