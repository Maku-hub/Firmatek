#!/usr/bin/env python3
"""End-to-end WebRTC P2P file-transfer test.

Drives two *real* WebRTC peers (via aiortc) that exchange signaling through the
server's WebSocket relay — exactly the `rtc_offer` / `rtc_answer` /
`ice_candidate` protocol the desktop client uses — and transfers a file over an
SCTP data channel, then verifies the bytes and SHA-256 match.

This exercises the server's RTC signaling relay (routeWSMessage) and the
client's file-transfer data-channel protocol (header -> binary chunks -> eof).

Requires: pip install aiortc websockets requests. See tests/README.md.
"""
import asyncio, hashlib, json, os, sys, time
import requests
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCDataChannel

BASE = os.environ.get("FIRMATEK_URL", "http://127.0.0.1:8080")
WS = BASE.replace("http", "ws", 1) + "/ws"
CHUNK = 16 * 1024
FILE = os.urandom(300 * 1024)  # 300 KB random payload
SHA = hashlib.sha256(FILE).hexdigest()

def reg(u, d):
    r = requests.post(f"{BASE}/api/auth/register", json={"username": u, "display_name": d, "password": "secret123"})
    if r.status_code == 409:
        r = requests.post(f"{BASE}/api/auth/login", json={"username": u, "password": "secret123"})
    j = r.json()
    return j["token"], (j.get("user_id") or j["user"]["id"])

async def ws_sender(ws):
    """Yield decoded JSON frames from a server WS (frames may be \\n-batched)."""
    async for raw in ws:
        for line in str(raw).split("\n"):
            line = line.strip()
            if line:
                yield json.loads(line)

async def run():
    a_tok, a_id = reg("wrtc_alice", "WRTC Alice")
    b_tok, b_id = reg("wrtc_bob", "WRTC Bob")

    a_ws = await websockets.connect(f"{WS}?token={a_tok}")
    b_ws = await websockets.connect(f"{WS}?token={b_tok}")
    await asyncio.sleep(0.4)

    transfer_id = f"{a_id}_{int(time.time())}"
    received = asyncio.get_event_loop().create_future()

    # ---- Receiver (Bob) ----
    async def receiver():
        pc = RTCPeerConnection()
        chunks = bytearray()
        header_seen = {"v": False}

        @pc.on("datachannel")
        def on_dc(channel: RTCDataChannel):
            @channel.on("message")
            def on_msg(message):
                if not header_seen["v"]:
                    header_seen["v"] = True  # first message is the JSON header
                    return
                if isinstance(message, str):
                    if json.loads(message).get("type") == "eof" and not received.done():
                        received.set_result(bytes(chunks))
                else:
                    chunks.extend(message)

        async for msg in ws_sender(b_ws):
            if msg.get("type") == "rtc_offer":
                p = msg["payload"]
                await pc.setRemoteDescription(RTCSessionDescription(sdp=p["sdp"]["sdp"], type=p["sdp"]["type"]))
                ans = await pc.createAnswer()
                await pc.setLocalDescription(ans)
                await b_ws.send(json.dumps({
                    "type": "rtc_answer", "target_id": msg["sender_id"],
                    "payload": {"sdp": {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                                "transferID": p["transferID"]},
                }))
            if received.done():
                await pc.close()
                return

    # ---- Sender (Alice) ----
    async def sender():
        pc = RTCPeerConnection()
        channel = pc.createDataChannel("file-transfer", ordered=True)

        @channel.on("open")
        async def on_open():
            channel.send(json.dumps({"filename": "blob.bin", "fileSize": len(FILE), "transferID": transfer_id}))
            for i in range(0, len(FILE), CHUNK):
                channel.send(FILE[i:i + CHUNK])
                while channel.bufferedAmount > CHUNK * 8:
                    await asyncio.sleep(0.01)
            # Current clients send the checksum with "eof" (computed while
            # streaming) instead of in the offer.
            channel.send(json.dumps({"type": "eof", "sha256": SHA}))

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)  # aiortc gathers ICE into the SDP
        await a_ws.send(json.dumps({
            "type": "rtc_offer", "target_id": b_id,
            "payload": {"sdp": {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                        "transferID": transfer_id, "filename": "blob.bin",
                        "fileSize": len(FILE)},
        }))
        async for msg in ws_sender(a_ws):
            if msg.get("type") == "rtc_answer":
                p = msg["payload"]
                await pc.setRemoteDescription(RTCSessionDescription(sdp=p["sdp"]["sdp"], type=p["sdp"]["type"]))
            if received.done():
                await pc.close()
                return

    rtask = asyncio.create_task(receiver())
    stask = asyncio.create_task(sender())
    try:
        data = await asyncio.wait_for(received, timeout=30)
    except asyncio.TimeoutError:
        print("[FAIL] WebRTC file transfer timed out")
        return 1
    finally:
        for t in (rtask, stask):
            t.cancel()
        await a_ws.close(); await b_ws.close()

    ok_len = len(data) == len(FILE)
    ok_hash = hashlib.sha256(data).hexdigest() == SHA
    print(f"[{'PASS' if ok_len else 'FAIL'}] received size matches ({len(data)}/{len(FILE)})")
    print(f"[{'PASS' if ok_hash else 'FAIL'}] SHA-256 integrity verified")
    return 0 if (ok_len and ok_hash) else 1

sys.exit(asyncio.run(run()))
