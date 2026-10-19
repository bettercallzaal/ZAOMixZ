# Stream events: what works today, and a proposed contract

Status: **proposal, event list agreed**. Nothing in this file has been built yet. Part 1 is measured from the code at `6ee5264`. Part 2 is the contract; the event list was approved as written, with one rule added in review: anything that comes in needs a person's tap.

## Part 1. What the live-stream features actually do today

| Feature | Where | What it really does | Works? |
|---|---|---|---|
| GO LIVE button | `web/dj/StreamBroadcast.js` | Flips `isLive` and lets events out on the `aurdour-dj` BroadcastChannel. It does not send any audio anywhere. | Partly |
| Song title to overlays | `StreamBroadcast.updateTrackInfo` and `updatePlayState` (called at `web/player.js` lines 263 and 449), `sendNowPlaying` (no caller) | A deck's title goes out **when the song loads on that deck**, not when it goes on air. So during a handover the overlays show the song coming in before the room hears it. `overlay.html` and `audience.html` show one card per deck. `obs-overlay.html` picks a deck by crossfader position, which is closer to what is on air. `sendNowPlaying` has no caller, so the overlays' single "now playing" line is never set. Anything loaded before GO LIVE stays unsent until the next load (the OBS overlay asks for a replay when it connects). | Partly: deck titles, not the on-air song |
| Overlay and audience pages | `web/overlay.html`, `web/obs-overlay.html`, `web/audience.html` | They listen on BroadcastChannel `aurdour-dj`. A BroadcastChannel only reaches pages in the **same browser profile on the same machine**. OBS's browser source is a separate browser, so by how the API works it gets nothing (not tested in OBS). Audience reactions and requests reach the desk only from another tab of the same browser. | Same browser only |
| Twitch chat | `web/dj/TwitchChat.js` | Reads chat anonymously over IRC WebSocket and spots song requests. The requests go to a text list (`web/player.js` line 1688), **not** to the request line or DJ MixZ. The CHAT panel is archived. | Reads, goes nowhere |
| YouTube Live chat | `web/dj/YouTubeLive.js` | Polls the YouTube Data API using an API key typed into the page. Requests go to the same text list as Twitch. Archived. | Needs a key, goes nowhere |
| Phone remote and listening | `web/dj/RemoteLink.js` | **The one path that works across machines.** It runs through a public relay (`BROKERS`, line 206), sealed end to end, with a 128 bit token and a one-time allow at the desk. The desk sends a state snapshot 5 times a second (`STATE_HZ`): both decks, now and next, the request board. The phone can listen to the mix over a direct WebRTC call (`_listen`, line 528). Every command from a phone is checked against an allowlist (`cleanCommand`, line 50), and viewers get `VIEWER_OK` only. | Yes (pure parts tested) |
| Request line | `web/dj/RequestLine.js` | A listener on a phone calls in a song, and DJ MixZ slots it in oldest first. Tested. | Yes |

So today there is one real pipe off the machine, the RemoteLink relay. There is also one same-browser pipe, the BroadcastChannel. It carries deck titles at load time, but nothing marks which song is on air.

**Requests play without a tap today.** When DJ MixZ is running, `RemoteHost._requestTick` (`web/dj/RemoteLink.js`, from line 452) takes the oldest waiting request once a second and puts it on as the next song through `djMixz.playNext`. Nobody at the desk taps anything. That breaks this contract's rule below, so fixing it comes first in the build order.

## Part 2. Proposed contract

### Principles
1. **Read freely, act through a person.** An outside agent (an overlay, a bot, another AI) can read the events. It can send in only a request or a recommendation, and **neither plays until a person taps it at the desk**. No outside agent gets play, cue, load or crossfader commands.
2. **No credentials in events.** No relay token, API key, OAuth token, device id or call address ever goes into an event. An agent joins the relay with a viewer link, the same way a listener's phone does.
3. **Only what the stream already shows.** Song, artist, licence holder, what the mix is doing, request titles and the first names callers typed. Nothing else.
4. **Chat is moderated before it is an event.** Chat goes out only after the desk's filter has passed it.
5. **Every text field is plain text.** A title, a name or a chat line is never markup: whatever shows an event escapes it, the same way the desk does (`web/dj/Html.js`).

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
| `agent.post` | `agent`, `kind` (`comment` or `question`), `text`, `edited`, `ai: true` | the DJ approved an agent's draft (gate 4). The OBS overlay shows it under its own label, "AI SUGGESTION, APPROVED BY THE HOST", which no event can change |

### Events in (the world to the desk)

| type | data | what the desk does |
|---|---|---|
| `request.new` | `track` (an id from the desk's `tracks` list), `name`, `note` | the request line's limits, then the board. It waits there until a person taps PLAY NEXT. It never goes on air by itself, whoever sent it |
| `agent.recommendation` | `track` (an id from the `tracks` list), `why` (at most 140 characters), `agent` (a name) | it appears as a Flow Director pick, labelled with the agent's name. Nothing plays until a person taps it. At most 1 every 30 seconds per agent |

The desk drops anything else, the same way `cleanCommand` drops unknown phone commands today.

### Transport
- **Same machine:** the existing `aurdour-dj` BroadcastChannel carries these same envelopes, for overlays opened in the same browser.
- **Anywhere else:** the existing RemoteLink relay. An outside agent is a viewer on that relay. It receives the events and may send only `request.new` and `agent.recommendation`.
- No new server, and no new dependency.

## What to build, in order (each its own PR)
1. **Requests wait for a tap.** Stop `_requestTick` from slotting requests in by itself. A request plays only when a person taps PLAY NEXT at the desk. A desk switch, AUTO-PLAY REQUESTS (off unless the DJ turns it on), keeps the old behaviour for listeners' phones. Requests from outside agents never auto-play, even with the switch on.
2. **The on-air title, off the machine.** Send `track.changed` for the song the room hears (from the live deck, not the load), plus `transition.started` and `.finished` and `stream.health`. Send them over the relay too, so an overlay in OBS can follow as a viewer link instead of relying on BroadcastChannel.
3. `request.updated`, `director.advice`, and chat: Twitch and YouTube chat requests go into the request line, through a simple moderation filter, and `chat.message` carries only the lines the filter passed.
4. `agent.recommendation` into the Flow Director, with the rate limit.

## Phase 5. Agent gateway (proposal)

Status: **design only**. Nothing here is built, and there is **no live endpoint for outside agents**. Opening one needs Zaal's explicit yes, given after the requirements below are built and tested.

The idea, from a partner proposal on 18 October 2026: one gateway for every place a show runs, instead of one agent per platform. The desk is the primary client. Twitch, and later other platforms, are distribution.

```
Twitch chat, ZAO MixZ desk, battle platforms (adapters)
        -> one event bus (the v1 envelope above)
        -> agent participation layer (identity, permissions, moderation, receipts)
        -> agents (commentary, next-track ideas, audience questions)
        -> the host approves what is published, and where
```

### Layers

1. **Adapters.** Each platform's adapter turns what happens there into the v1 envelope, adding `platform` (for example `desk`, `twitch`) to `data`. A track change on the desk is one `track.changed`, whatever platform is watching. Adapters only read. None of them writes to a platform without the host approving the message.
2. **Event bus.** The bus is this contract. It is read-only for agents: they receive the events and nothing else.
3. **Agent participation layer.**
   - **Identity.** Each agent connects with its own viewer link, as a phone does today. The desk stamps the agent's name and role from that connection, never from the agent's own messages, as with `from: 'chat'`.
   - **Permissions** are per agent, and off unless the host turns them on. Reading events is the only default. Proposing is a permission the host grants per kind: next track, comment, audience question.
   - **Moderation.** Every proposal goes through the chat filter (`web/dj/ChatFilter.js`) and a rate limit per agent.
   - **Receipts.** Every proposal and every host decision (approved, edited, declined, expired) is logged with the agent, the time and the outcome, so a show can be replayed and audited.
4. **Agents propose; the host publishes.** No agent output reaches the stream, chat or the decks by itself. A next-track proposal arrives as a Flow Director pick (`agent.recommendation`). A comment or a question arrives as a draft in the host's queue. The host picks where an approved item goes.
5. **Audience intelligence.** Requests, votes and engagement from every platform are gathered into one show state.
   - Identities stay distinct per platform (`twitch:name` is not `desk:name`).
   - One vote per identity per round.
   - Agents cannot vote, and an automated or duplicate vote is dropped.
   - The request line's limits and the chat cap apply across every platform.

### Built so far
- **Gate 1, identity** (`web/dj/AgentLink.js`). Each agent gets a key of its own (`mza1.` and a 128-bit token), on a channel of its own. It never gets the phone link, whose token is also the key to the whole phone channel. The desk knows which agent sent a message by the channel it arrived on, and stamps every proposal `from: 'agent'` with the desk's name for that agent. Whatever the agent writes about its own name, role or device is dropped. In gate 1 an agent may only say `hello` and `ping`, and it receives the published events (`OUT_TYPES`, only while ON AIR). A request stamped `from: 'agent'` never auto-plays, whatever the AUTO-PLAY REQUESTS switch says. Nothing in the app creates an agent yet.
- **Gate 2, MUTE ALL AGENTS** (`AgentHost.setMuted`). A toolbar button on the desk, shown whenever an agent is connected or the agents are muted, and a DJ-only button on the phone. Muted: every waiting draft is dropped, new ones are refused, no events go to agents, and it stays muted across a reload.
- **Gate 3, the approval queue and receipts** (`web/dj/AgentQueue.js`). An agent may send `propose` with `kind` (`comment` or `question`) and `text`, and only for a kind the DJ granted that agent (`AgentHost.grant`); every kind starts off. A draft waits in the AGENT DRAFTS panel until the DJ approves it (as written or edited) or declines it, and expires after ten minutes. Every proposal and decision leaves a receipt (agent, time, kind, text, outcome), kept in the browser and saveable as a file. Approving only records it: where an approved draft is published is a later gate.
- **Gate 4, the AI label** (`web/dj/AgentPost.js`). Approving a draft sends one `agent.post` event (only while ON AIR, and never while the agents are muted). It carries the DJ's text when the DJ edited it. The OBS overlay (`obs-overlay.html`) shows it as a card under its own label, "AI SUGGESTION, APPROVED BY THE HOST", with the agent's name; the label is the overlay's text, not the event's, and everything in the card is plain text.
- **Gate 5, moderation and a rate limit** (`AgentQueue.propose`). A granted agent may send one draft every 20 seconds; every try counts, so an agent that keeps sending stays held back. Every draft goes through the stream-chat filter (`ChatFilter.moderate`): links in any form and the DJ's "Words never shown from chat" are refused, and what waits is the filter's cleaned text. Refusals are counted like the others.

### Required before any outside agent connects

These are gates, not features to add later. All of them must exist and be tested first:

- **MUTE ALL AGENTS.** One control on the desk, always visible while any agent is connected. Pressing it drops every pending agent proposal, refuses new ones and stops sending events to agents, until the host unmutes.
- **AI versus human labels.** Every agent proposal on the desk is marked as coming from an agent, with that agent's name. Anything published from one stays labelled where the audience sees it, for example "AI suggestion, approved by the host".
- **The approval queue and receipts above.** Nothing publishes without a person's tap, and every decision is logged.
- **Per-agent permissions, off unless granted,** with a way to disconnect a single agent.

### Out of scope until verified separately
- Voice or avatar co-hosts, and any audio from an agent on the stream.
- X Spaces. It needs its own verified integration.
- Payments of any kind. A payment rail is not a connection endpoint, and none is needed.
- Writing to a battle platform. Reading its public data through an adapter needs its API checked first.

### Open questions for the host
- Which agents, if any, and with which permissions each.
- Whether battle-night votes should ever count desk and Twitch audiences together, or always stay apart.
