# P2P Social System — Technical Documentation

**Version:** 1.0
**Audience:** Developers, server operators, and contributors
**Scope:** Complete specification for the peer-to-peer social system including architecture, protocol, persistence, and deployment

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Components](#3-components)
4. [Signaling Relay Protocol](#4-signaling-relay-protocol)
5. [WebRTC Peer Protocol](#5-webrtc-peer-protocol)
6. [IndexedDB Schema](#6-indexeddb-schema)
7. [Social Features](#7-social-features)
8. [Connection Lifecycle](#8-connection-lifecycle)
9. [Sync & Conflict Resolution](#9-sync--conflict-resolution)
10. [Deployment](#10-deployment)
11. [Configuration](#11-configuration)
12. [Limitations & Constraints](#12-limitations--constraints)
13. [Troubleshooting](#13-troubleshooting)
14. [Future Considerations](#14-future-considerations)

---

## 1. Overview

The P2P Social System provides cross-server buddy list, guild, and chat functionality for MapleStory WASM players. Unlike traditional client-server social systems, all social data lives in each player's browser via IndexedDB. Players communicate directly through WebRTC data channels.

The only server component is a stateless **signaling relay** that helps browsers discover each other and exchange WebRTC connection offers. It stores nothing — if it goes down, no data is lost.

### Design Goals

- **No central authority** — players own their social data
- **Cross-server** — works regardless of which game server (Cosmic instance) players are connected to
- **Resilient** — social data survives server outages, relay restarts, and browser refreshes
- **Minimal infrastructure** — the relay is a single Python process with zero dependencies beyond `websockets`

---

## 2. Architecture

```
┌─────────────────────┐                      ┌─────────────────────┐
│     Browser A        │                      │     Browser B        │
│                      │                      │                      │
│  ┌───────────────┐   │   WebRTC DataChannel │   ┌───────────────┐ │
│  │ Social Client │◄──┼──────────────────────┼──►│ Social Client │ │
│  │ (social_      │   │   (chat, buddy sync, │   │ (social_      │ │
│  │  client.js)   │   │    guild sync)       │   │  client.js)   │ │
��  └──────┬────────┘   │                      │   └──────┬────────┘ │
│         │            │                      │          │          │
│  ┌─���────▼────────┐   │                      │   ┌──────▼────────┐ │
│  │  IndexedDB    │   │                      │   │  IndexedDB    │ │
│  │  (buddies,    │   │                      │   │  (buddies,    │ │
│  │   guild,      │   │                      │   │   guild,      │ │
│  │   chat)       │   │                      │   │   chat)       │ │
│  └───────────────┘   │                      │   └───────────────┘ │
│         │            │                      │          │          │
└─────────┼────────────┘                      └──────────┼──────────┘
          │ WebSocket                                    │ WebSocket
          │ (SDP/ICE signaling only)                     │
          ▼                                              ▼
    ┌──────────────────────────────────────────────────────────┐
    │              Signaling Relay (social_server.py)           │
    │                                                          │
    │   - Tracks online usernames (in-memory only)             │
    │   - Forwards WebRTC SDP offers/answers                   │
    │   - Forwards ICE candidates                              │
    │   - Broadcasts join/leave presence events                │
    │   - Stores NOTHING to disk                               │
    │                                                          │
    │   ws://0.0.0.0:8090                                      │
    └──────────────────────────────────────────────────────────┘
```

### How It Differs From the Game Server Path

The social system is completely independent of the MapleStory game connection:

```
Browser
  ├── WebSocket → ws_proxy.py :8080 → Cosmic Server (game packets)
  ├── WebSocket → assets_server.py :8765 (LazyFS asset streaming)
  ├── WebSocket → social_server.py :8090 (signaling ONLY)
  └── WebRTC → Other players directly (chat, buddy, guild data)
```

The game server knows nothing about the social system. The social system knows nothing about the game server. They share no state.

---

## 3. Components

### 3.1 Signaling Relay (`web/social_server.py`)

| Property | Value |
|----------|-------|
| Language | Python 3.9+ |
| Dependencies | `websockets` |
| Default Port | 8090 |
| State | None (in-memory peer map only) |
| Database | None |
| Persistence | None — fully stateless |

The relay maintains a single in-memory dictionary: `username → WebSocket`. When a player registers, it broadcasts their arrival. When they disconnect, it broadcasts their departure. When a player wants to connect to another via WebRTC, it forwards the SDP/ICE messages between them.

**If the relay restarts:**
- All players reconnect automatically (5-second retry)
- Existing WebRTC data channels between peers remain active
- The relay rebuilds its in-memory peer map from re-registrations
- No data is lost because no data was ever stored

### 3.2 Social Client (`web/social_client.js`)

| Property | Value |
|----------|-------|
| Language | JavaScript (vanilla, no framework) |
| Dependencies | None (uses browser-native WebRTC, IndexedDB, WebSocket) |
| Loaded By | `index.html` alongside the WASM client |
| Persistence | IndexedDB (`mapleSocial` database) |

The client handles:
- WebSocket connection to signaling relay
- WebRTC peer connection management (create, signal, teardown)
- All social logic (buddy requests, guild management, chat routing)
- IndexedDB reads/writes for persistence
- Overlay UI rendering (floating panel with Chat/Buddies/Guild tabs)

### 3.3 Overlay UI

The social panel is a DOM overlay positioned above the WASM canvas. It does not modify the C++ client or the WASM binary.

- **Toggle:** "Social" button, top-right corner (next to "Profiles")
- **Tabs:** Chat | Buddies | Guild
- **Input isolation:** All text inputs call `e.stopPropagation()` to prevent keystrokes from reaching the game canvas

---

## 4. Signaling Relay Protocol

All messages are JSON over WebSocket. The relay understands exactly three message types from clients.

### 4.1 Client → Relay

#### `register`
Announce your presence. Must be sent before any other message.

```json
{
  "type": "register",
  "username": "PlayerName"
}
```

- Username must be 1-13 characters
- If another connection is already registered with this username, the old one is kicked

#### `signal`
Forward a WebRTC signaling message to another player.

```json
{
  "type": "signal",
  "to": "TargetPlayer",
  "data": {
    "type": "offer|answer|ice",
    "sdp": { ... },
    "candidate": { ... }
  }
}
```

### 4.2 Relay → Client

#### `registered`
Confirms registration and provides the current online list.

```json
{
  "type": "registered",
  "username": "PlayerName",
  "online": ["Alice", "Bob", "Charlie"]
}
```

#### `peer_joined`
A new player came online.

```json
{
  "type": "peer_joined",
  "username": "Alice"
}
```

#### `peer_left`
A player disconnected.

```json
{
  "type": "peer_left",
  "username": "Alice"
}
```

#### `signal`
A signaling message forwarded from another player.

```json
{
  "type": "signal",
  "from": "Alice",
  "data": { ... }
}
```

#### `peer_offline`
The target of a `signal` message is not currently connected.

```json
{
  "type": "peer_offline",
  "username": "TargetPlayer"
}
```

#### `kicked`
Your session was replaced by a newer connection with the same username.

```json
{
  "type": "kicked"
}
```

#### `error`
```json
{
  "type": "error",
  "message": "description"
}
```

---

## 5. WebRTC Peer Protocol

Once two browsers establish a WebRTC data channel, they communicate using JSON messages. These messages flow directly between browsers — the relay is not involved.

### 5.1 Chat

```json
{
  "type": "chat",
  "channel": "all|buddy|guild",
  "message": "Hello!"
}
```

- `all`: broadcast to all connected peers
- `buddy`: whisper to a specific buddy (sent only to that peer)
- `guild`: sent to all guild members

The `from` field is not included in the message — the recipient knows who sent it based on which data channel it arrived on.

### 5.2 Buddy System

#### Request
```json
{ "type": "buddy_request" }
```

Sender has saved an outgoing request in their IndexedDB. If the recipient also has a pending outgoing request to the sender (mutual request), it auto-accepts.

#### Accept
```json
{ "type": "buddy_accept" }
```

#### Decline
```json
{ "type": "buddy_decline" }
```

#### Remove
```json
{ "type": "buddy_remove" }
```

Removes the buddy relationship. Both sides delete the record.

#### Confirm (sync)
```json
{ "type": "buddy_confirm" }
```

Sent on connection to a peer who is already in your buddy list. If the remote side doesn't have you as a buddy, they auto-add you (sync recovery).

### 5.3 Guild System

#### Invite
```json
{
  "type": "guild_invite",
  "guild_name": "MyGuild",
  "members": [
    { "username": "Leader", "rank": 1 },
    { "username": "Officer", "rank": 2 }
  ]
}
```

The invite includes the current member list so the invitee can bootstrap their guild state on accept.

#### Accept
```json
{ "type": "guild_accept" }
```

The inviter adds the accepter to their roster and broadcasts a guild sync.

#### Decline
```json
{ "type": "guild_decline" }
```

#### Leave
```json
{ "type": "guild_leave" }
```

Sent to all guild peers. Each peer removes the leaver from their local roster.

#### Kick
```json
{
  "type": "guild_kick",
  "target": "PlayerName"
}
```

Sent by a leader/officer. All peers remove the target from their roster. The target receives this message directly and clears their guild data.

#### Promote / Demote / Transfer
```json
{
  "type": "guild_promote",
  "target": "PlayerName",
  "rank": 1|2|3
}
```

Rank 1 = leader, 2 = officer, 3 = member. Setting someone to rank 1 transfers leadership (the sender becomes rank 2).

#### Sync
```json
{
  "type": "guild_sync",
  "guild": {
    "name": "MyGuild",
    "leader": "LeaderName",
    "members": [
      { "username": "Leader", "rank": 1 },
      { "username": "Officer", "rank": 2 },
      { "username": "Member", "rank": 3 }
    ]
  }
}
```

Sent on connection to guild peers. Authority is rank-based: a sync from a higher-ranked member overwrites a lower-ranked member's data.

---

## 6. IndexedDB Schema

Database name: `mapleSocial` (version 1)

### Object Stores

| Store | Key | Fields | Purpose |
|-------|-----|--------|---------|
| `buddies` | `username` | `username`, `addedAt` | Accepted buddy relationships |
| `buddy_requests_in` | `from` | `from`, `ts` | Incoming requests not yet accepted/declined |
| `buddy_requests_out` | `to` | `to`, `ts` | Outgoing requests not yet accepted. Re-sent when the target comes online |
| `guild` | `key` (always `"current"`) | `key`, `data: {name, leader, members[]}` | Your guild membership. `null` if not in a guild |
| `guild_invites` | `guild_name` | `guild_name`, `from`, `members[]`, `ts` | Pending guild invitations |
| `chat` | `id` (auto-increment) | `channel`, `from`, `message`, `ts` | Chat message history. Index on `ts`. Trimmed to 200 messages |

### Data Lifecycle

- **Buddies:** Persist until explicitly removed by either party
- **Buddy requests:** Persist until accepted, declined, or cancelled. Outgoing requests are automatically re-sent when the target comes online
- **Guild:** Persists until the player leaves or is kicked. Synced from higher-authority members on reconnect
- **Guild invites:** Persist until accepted or declined
- **Chat:** Rolling window of the last 200 messages. Survives browser refresh. Cleared on IndexedDB reset

---

## 7. Social Features

### 7.1 Chat

| Channel | Behavior | Recipients |
|---------|----------|------------|
| All | Broadcast | Every connected peer (buddies + guild members) |
| Buddy | Whisper | One specific buddy. Format: `<name> <message>` |
| Guild | Guild chat | All connected guild members |

Chat messages are stored in IndexedDB with timestamps. The chat panel displays the last 200 messages and auto-scrolls to the latest.

System messages (buddy requests, guild events, errors) appear in yellow in the chat panel.

### 7.2 Buddy List

| Action | Requires Both Online? | Notes |
|--------|----------------------|-------|
| Send request | No | Saved locally. Sent when target connects |
| Accept request | Yes | Both sides update their IndexedDB |
| Decline request | Yes | Request deleted on both sides |
| Remove buddy | No | Local delete immediate. Remote notified on next connect |
| Whisper | Yes | Direct WebRTC message |

**Presence:** A buddy shows as online (green dot) when a WebRTC data channel is open to them. Offline (grey dot) otherwise.

**Sync recovery:** When two buddies connect, each sends a `buddy_confirm` message. If one side lost their data (cleared browser, new device), the confirm from the other side re-establishes the relationship.

### 7.3 Guild

| Action | Who Can Do It | Requires Target Online? |
|--------|---------------|------------------------|
| Create guild | Anyone not in a guild | N/A |
| Invite player | Leader or officer (rank <= 2) | Yes |
| Accept invite | Invitee | Yes (invite includes roster snapshot) |
| Leave guild | Any member | No (peers notified on next connect) |
| Kick member | Leader or officer | No (target notified on next connect) |
| Promote to officer | Leader only | No |
| Demote to member | Leader only | No |
| Transfer leadership | Leader only | No |

**Rank system:**
| Rank | Label | Can Invite | Can Kick | Can Promote |
|------|-------|-----------|----------|-------------|
| 1 | Leader | Yes | Yes (rank 2-3) | Yes |
| 2 | Officer | Yes | Yes (rank 3) | No |
| 3 | Member | No | No | No |

**Guild sync authority:** When two guild members connect, both send their guild state. The message from the higher-ranked member (lower rank number) is accepted. This prevents members from overwriting leader decisions.

---

## 8. Connection Lifecycle

### 8.1 Startup

```
1. Browser loads social_client.js
2. IndexedDB opens (creates stores on first visit)
3. WebSocket connects to signaling relay
4. User enters character name → "Login"
5. Client sends { type: "register", username } to relay
6. Relay responds with { type: "registered", online: [...] }
7. Client checks local buddies and guild members against online list
8. For each known peer that is online, initiates WebRTC connection
9. On WebRTC channel open, sends sync messages (buddy_confirm, guild_sync)
```

### 8.2 New Peer Appears

```
1. Relay sends { type: "peer_joined", username: "Alice" }
2. Client checks if Alice is a buddy or guild member (IndexedDB lookup)
3. If yes, initiates WebRTC connection to Alice via signaling relay
4. On channel open, sends sync messages
```

### 8.3 Peer Disconnects

```
1. Relay sends { type: "peer_left", username: "Alice" }
2. Client closes the RTCPeerConnection for Alice
3. UI updates: Alice shows as offline in buddy/guild lists
4. No data is lost — everything persists in IndexedDB
```

### 8.4 Relay Disconnects

```
1. WebSocket onclose fires
2. Client schedules reconnect (5-second interval)
3. Existing WebRTC data channels remain active
4. On reconnect, client re-registers with relay
5. Relay sends fresh online list, client re-establishes any missing WebRTC connections
```

---

## 9. Sync & Conflict Resolution

Because there is no central database, state can diverge between peers. The system handles this through deterministic rules:

### Buddy List
- **Mutual confirm:** If A has B as a buddy but B doesn't have A, the `buddy_confirm` message from A causes B to auto-add A. This handles data loss on one side.
- **Mutual request:** If A sends a buddy request to B, and B also sends one to A, both auto-accept (mutual interest).
- **Removal:** When A removes B, B is notified immediately (if online) or on next connection. Both sides delete independently.

### Guild
- **Authority hierarchy:** Guild syncs are accepted only from a peer of equal or higher rank. A leader's view of the roster always wins.
- **Offline changes:** If the leader kicks a member while they're offline, the kicked member learns about it on next connect when they receive a `guild_kick` message.
- **Split brain:** If two members are both offline and somehow have divergent rosters, the first connection between them resolves it — the higher-ranked member's state is authoritative.
- **Guild dissolution:** Not explicitly handled in P2P. If the leader wants to dissolve, they must kick all members first, then leave.

### Chat
- No sync. Chat messages are fire-and-forget. Each browser stores what it received. If you were offline when a message was sent, you don't receive it. There is no message relay or offline queue.

---

## 10. Deployment

### 10.1 Docker (Recommended)

The signaling relay is included in the existing Docker Compose stack:

```bash
# Start all services including social relay
./scripts/run_all.sh
```

Or directly:

```bash
docker compose up html-server ws-proxy assets-server social-server
```

The relay runs on port 8090 with zero configuration.

### 10.2 Local (No Docker)

```bash
pip install websockets
python web/social_server.py
```

Options:

```
--port PORT    WebSocket port (default: 8090)
```

### 10.3 Production / Shared Community Instance

The relay is lightweight enough to run on minimal infrastructure:

| Scale | Hardware | Notes |
|-------|----------|-------|
| 1-50 players | Any VPS ($5/month) | Single Python process |
| 50-500 players | 1 CPU, 512MB RAM | `websockets` library is efficient for this scale |
| 500+ players | Consider adding TURN relay | WebRTC may fail for some NAT configurations |

**TURN servers:** The system uses Google's public STUN servers for NAT traversal. For players behind symmetric NATs, a TURN server may be needed. This is configured in `social_client.js` in the `RTC_CONFIG` object:

```javascript
const RTC_CONFIG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        // Add TURN server here if needed:
        // { urls: "turn:your-turn-server.com", username: "user", credential: "pass" },
    ],
};
```

---

## 11. Configuration

### 11.1 Server Profile Fields

The following fields are available in the connection profile panel (index.html):

| Field | Default | Description |
|-------|---------|-------------|
| Social IP | `window.location.hostname` | Hostname of the signaling relay |
| Social Port | `8090` | WebSocket port of the signaling relay |

### 11.2 config.json

```json
{
  "SocialServerIP": null,
  "SocialServerPort": null
}
```

When `null`, the client auto-detects from the browser's current hostname.

### 11.3 Profile Overrides

Profile config values (saved in localStorage) override `config.json`. This allows players to save different social server addresses per profile.

---

## 12. Limitations & Constraints

### Both Players Must Be Online

The fundamental constraint of the P2P model. These actions require both parties to be connected simultaneously:

| Action | If target is offline |
|--------|---------------------|
| Send buddy request | Saved locally, sent on next mutual online window |
| Guild invite | Fails with "not connected" message |
| Chat (any channel) | Message not delivered. No offline queue |
| Guild kick/promote | Saved locally, target learns on next connect |

### No Global Chat

"All" chat only reaches your connected peers (buddies and guild members). There is no server-wide or world-wide broadcast channel. To chat with someone, you must first establish a buddy or guild relationship.

### No Offline Messages

If a player sends you a message while you're offline, it is lost. There is no message queue or store-and-forward mechanism.

### No Player Discovery

You cannot search for players by name. To add someone as a buddy, you must know their exact character name. The signaling relay does not expose a player search API (by design — privacy).

### Data Portability

Social data lives in the browser's IndexedDB. If a player:
- Clears browser data: social data is lost (but can recover buddies via sync on reconnect)
- Uses a different browser: starts fresh (no cross-browser sync)
- Uses incognito/private mode: data is lost on tab close

### NAT Traversal

WebRTC connections may fail between players behind certain NAT types (symmetric NAT). STUN handles most cases, but a TURN relay may be needed for full connectivity.

### No Authentication

The system uses self-reported usernames. There is no cryptographic proof that a player is who they claim to be. A malicious user could register as someone else's username. In a trusted private server community this is acceptable. For untrusted environments, consider adding authentication (e.g., signing messages with a key derived from the game login).

---

## 13. Troubleshooting

### Social button doesn't appear

- Check browser console for JavaScript errors
- Verify `social_client.js` is loaded (Network tab: `/web/social_client.js` should return 200)
- Ensure `loadWasmClient()` is called (the social script is loaded alongside the WASM client)

### "Disconnected" status after login

- Verify the signaling relay is running: `ws://hostname:8090` should accept WebSocket connections
- Check browser console for WebSocket connection errors
- If using Docker, ensure `social-server` container is running: `docker compose ps`
- If behind a reverse proxy, ensure it forwards WebSocket upgrades for port 8090

### Buddy shows as offline even though they're playing

- Both players must be logged into the social overlay (clicked "Login" with their character name)
- The signaling relay must be reachable by both players
- If behind different NATs, the WebRTC connection may have failed. Check console for ICE connection failures. A TURN server may be needed.

### Guild state is wrong / out of sync

- The highest-ranked online member's state is authoritative
- Ask the guild leader to log in — their view will overwrite incorrect state on other members
- As a last resort, members can clear their guild data: browser DevTools → Application → IndexedDB → `mapleSocial` → `guild` → delete the `"current"` entry

### Chat messages not appearing

- Verify WebRTC data channels are open: console will show `[P2P] Channel open with <name>`
- "All" chat only reaches connected peers. If no peers are connected, messages go nowhere.
- Buddy whisper requires the exact username before the space: `Alice Hello there`

### Data lost after browser update / clear

- IndexedDB data does not survive "Clear browsing data" if storage is included
- Buddy relationships can self-heal via `buddy_confirm` on reconnect (both sides must have had the relationship before the data loss occurred on one side)
- Guild data can recover from any online member with higher rank

---

## 14. Future Considerations

These are not planned features — they are architectural notes for potential future development.

### Offline Message Queue
A lightweight message relay could store messages for offline players, delivering them on next connect. This could be a separate opt-in service without changing the core P2P architecture.

### Authentication
Signing social messages with a key derived from the game session (or a separate keypair) would prevent username spoofing. The signaling relay could verify signatures before forwarding.

### Deeper Client Integration
The current overlay UI is a DOM layer above the WASM canvas. A deeper integration could pipe social messages into the C++ `UIChatBar` via Emscripten's `ccall`/`cwrap` bridge, using the existing chat target system (`CHT_BUDDY`, `CHT_GUILD`, etc.).

### Federation
Multiple signaling relays could peer with each other, allowing players on different relays to discover each other. This would eliminate the single-relay dependency without centralizing data.
