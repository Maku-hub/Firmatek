#!/usr/bin/env python3
"""New-DM notification test.

When a user opens a direct message with someone for the first time, the other
participant must receive a `channel_added` event over WebSocket so the DM shows
up in their sidebar without a manual refresh.

See tests/README.md.
"""
import asyncio, json, os, sys, time
import requests
import websockets

BASE = os.environ.get("FIRMATEK_URL", "http://127.0.0.1:8080")
WS = BASE.replace("http", "ws", 1) + "/ws"

def reg(u, d):
    r = requests.post(f"{BASE}/api/auth/register", json={"username": u, "display_name": d, "password": "secret123"})
    if r.status_code == 409:
        r = requests.post(f"{BASE}/api/auth/login", json={"username": u, "password": "secret123"})
    j = r.json()
    return j["token"], (j.get("user_id") or j["user"]["id"])

async def main():
    stamp = int(time.time())
    a_tok, a_id = reg(f"dmn_a_{stamp}", "DM A")
    b_tok, b_id = reg(f"dmn_b_{stamp}", "DM B")

    # B is online and has NOT opened this DM yet.
    async with websockets.connect(f"{WS}?token={b_tok}") as bws:
        await asyncio.sleep(0.4)
        # A opens a brand-new DM with B.
        dm = requests.post(f"{BASE}/api/channels/direct/{b_id}",
                           headers={"Authorization": f"Bearer {a_tok}"}).json()
        assert dm.get("existing") is False, f"expected a new DM, got {dm}"

        # B should receive channel_added for that DM.
        got = None
        end = time.time() + 5
        while time.time() < end:
            try:
                raw = await asyncio.wait_for(bws.recv(), timeout=end - time.time())
            except asyncio.TimeoutError:
                break
            for line in str(raw).split("\n"):
                line = line.strip()
                if not line:
                    continue
                m = json.loads(line)
                if m.get("type") == "channel_added" and m.get("payload", {}).get("id") == dm["channel_id"]:
                    got = m
                    break
            if got:
                break

    ok = got is not None and got["payload"].get("is_direct") is True
    print(f"[{'PASS' if ok else 'FAIL'}] recipient gets channel_added for a new DM",
          "-", "received" if got else "NOT received")
    sys.exit(0 if ok else 1)

asyncio.run(main())
