#!/usr/bin/env python3
"""
Stateless Signaling Relay for MapleStory WASM P2P Social

This server stores NOTHING. It exists only to help browsers establish
WebRTC connections to each other. All social data (buddies, guilds, chat)
lives in each player's browser via IndexedDB.

The relay:
  1. Tracks which usernames are currently connected (in-memory only)
  2. Forwards WebRTC signaling messages (SDP offers/answers, ICE candidates)
  3. Broadcasts presence (who just came online / went offline)

If this relay goes down, no data is lost. Players just can't establish
NEW peer connections until it comes back. Existing WebRTC connections
between peers continue working.

Usage:
    python social_server.py [--port PORT]

Default: ws://0.0.0.0:8090
"""

import asyncio
import json
import argparse
import sys

try:
    import websockets
except ImportError:
    print("Missing dependency: pip install websockets")
    sys.exit(1)


# username -> websocket (in-memory only, lost on restart)
peers: dict[str, websockets.WebSocketServerProtocol] = {}


async def send_json(ws, msg: dict):
    try:
        await ws.send(json.dumps(msg))
    except websockets.exceptions.ConnectionClosed:
        pass


async def handle_connection(ws):
    username = None
    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                await send_json(ws, {"type": "error", "message": "Invalid JSON."})
                continue

            msg_type = data.get("type")

            # ── Register ────────────────────────────────────────
            if msg_type == "register":
                name = data.get("username", "").strip()
                if not name or len(name) > 13:
                    await send_json(ws, {"type": "error", "message": "Invalid username."})
                    continue

                # Kick old connection with same name
                old_ws = peers.pop(name, None)
                if old_ws and old_ws != ws:
                    await send_json(old_ws, {"type": "kicked"})
                    try:
                        await old_ws.close()
                    except Exception:
                        pass

                username = name
                peers[username] = ws

                # Tell the new peer who's online
                online = [n for n in peers if n != username]
                await send_json(ws, {"type": "registered", "username": username, "online": online})

                # Tell everyone else this peer came online
                for other_name, other_ws in peers.items():
                    if other_name != username:
                        await send_json(other_ws, {"type": "peer_joined", "username": username})

                print(f"[Relay] {username} registered ({len(peers)} online)")

            # ── Signal (forward WebRTC SDP/ICE to target) ───────
            elif msg_type == "signal":
                if not username:
                    await send_json(ws, {"type": "error", "message": "Register first."})
                    continue

                target = data.get("to", "").strip()
                signal_data = data.get("data")
                if not target or not signal_data:
                    continue

                target_ws = peers.get(target)
                if target_ws:
                    await send_json(target_ws, {
                        "type": "signal",
                        "from": username,
                        "data": signal_data,
                    })
                else:
                    await send_json(ws, {"type": "peer_offline", "username": target})

            else:
                await send_json(ws, {"type": "error", "message": f"Unknown type: {msg_type}"})

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if username:
            # Only remove if this is still the active connection for this name
            if peers.get(username) is ws:
                del peers[username]
            # Notify everyone
            for other_name, other_ws in peers.items():
                await send_json(other_ws, {"type": "peer_left", "username": username})
            print(f"[Relay] {username} disconnected ({len(peers)} online)")


async def main():
    parser = argparse.ArgumentParser(description="Stateless signaling relay for P2P social")
    parser.add_argument("--port", type=int, default=8090, help="WebSocket port (default: 8090)")
    args = parser.parse_args()

    print("=" * 60)
    print("MapleStory WASM — P2P Signaling Relay")
    print("=" * 60)
    print(f"WebSocket: ws://0.0.0.0:{args.port}")
    print()
    print("This server stores NOTHING. It only relays WebRTC")
    print("signaling so browsers can find each other.")
    print("All social data lives in each player's browser.")
    print("=" * 60)
    print("Waiting for connections...")

    async with websockets.serve(handle_connection, "0.0.0.0", args.port):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Relay] Shutting down...")
        sys.exit(0)
