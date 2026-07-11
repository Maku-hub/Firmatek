#!/usr/bin/env python3
"""Group-channel fan-out (T4) and reconnect-resilience (T3) tests.

- T4: a message and a typing indicator sent to a multi-member channel reach all
  other members over WebSocket (and the sender is excluded from typing).
- T3: a client that disconnects and reconnects several times in a row still
  receives messages on its latest connection (exercises the hub's
  register-replace / unregister-old path).

See tests/README.md.
"""
import asyncio, json, os, sys, time
import requests
import websockets

BASE = os.environ.get("FIRMATEK_URL", "http://127.0.0.1:8080")
WS = BASE.replace("http", "ws", 1) + "/ws"

results = []
def check(name, cond, detail=""):
    results.append(cond)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

def reg(u, d):
    r = requests.post(f"{BASE}/api/auth/register", json={"username": u, "display_name": d, "password": "secret123"})
    if r.status_code == 409:
        r = requests.post(f"{BASE}/api/auth/login", json={"username": u, "password": "secret123"})
    j = r.json()
    return j["token"], (j.get("user_id") or j["user"]["id"])

async def recv_until(ws, pred, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
        except asyncio.TimeoutError:
            return None
        for line in str(raw).split("\n"):
            line = line.strip()
            if line and pred(json.loads(line)):
                return json.loads(line)
    return None

async def main():
    stamp = int(time.time())
    t1, id1 = reg(f"grp1_{stamp}", "G One")
    t2, id2 = reg(f"grp2_{stamp}", "G Two")
    t3, id3 = reg(f"grp3_{stamp}", "G Three")

    ch = requests.post(f"{BASE}/api/channels", headers={"Authorization": f"Bearer {t1}"},
                       json={"name": f"team_{stamp}", "members": [id2, id3]}).json()
    ch_id = ch["channel_id"]

    # ---- T4: group fan-out ----
    async with websockets.connect(f"{WS}?token={t1}") as w1, \
               websockets.connect(f"{WS}?token={t2}") as w2, \
               websockets.connect(f"{WS}?token={t3}") as w3:
        await asyncio.sleep(0.5)
        await w1.send(json.dumps({"type": "chat_message", "channel_id": ch_id,
                                  "payload": {"channel_id": ch_id, "content": "hello team", "type": "text"}}))
        g2, g3 = await asyncio.gather(
            recv_until(w2, lambda m: m.get("payload", {}).get("content") == "hello team"),
            recv_until(w3, lambda m: m.get("payload", {}).get("content") == "hello team"),
        )
        check("group message reaches both other members", g2 is not None and g3 is not None,
              f"g2={'ok' if g2 else 'miss'} g3={'ok' if g3 else 'miss'}")

        # typing fan-out excludes the sender
        await w1.send(json.dumps({"type": "typing", "channel_id": ch_id, "payload": {"typing": True}}))
        t2_typ, t3_typ = await asyncio.gather(
            recv_until(w2, lambda m: m.get("type") == "typing"),
            recv_until(w3, lambda m: m.get("type") == "typing"),
        )
        sender_typ = await recv_until(w1, lambda m: m.get("type") == "typing", timeout=1)
        check("typing reaches other members, not sender",
              t2_typ is not None and t3_typ is not None and sender_typ is None)

    # ---- T3: reconnect resilience ----
    for _ in range(5):
        w = await websockets.connect(f"{WS}?token={t2}")
        await asyncio.sleep(0.1)
        await w.close()
        await asyncio.sleep(0.1)

    async with websockets.connect(f"{WS}?token={t1}") as w1, \
               websockets.connect(f"{WS}?token={t2}") as w2:
        await asyncio.sleep(0.5)
        await w1.send(json.dumps({"type": "chat_message", "channel_id": ch_id,
                                  "payload": {"channel_id": ch_id, "content": "after reconnects", "type": "text"}}))
        got = await recv_until(w2, lambda m: m.get("payload", {}).get("content") == "after reconnects", timeout=6)
        check("latest connection still receives after 5 reconnects", got is not None)

    passed = sum(1 for c in results if c)
    print(f"\n{passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
