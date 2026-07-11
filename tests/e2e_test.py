#!/usr/bin/env python3
"""Functional end-to-end test suite for the Firmatek server.

Talks to a live server over REST + WebSocket. See tests/README.md for setup.
"""
import asyncio, base64, hashlib, hmac, json, os, sys, time
import requests
import websockets

BASE = os.environ.get("FIRMATEK_URL", "http://127.0.0.1:8080")
WS = BASE.replace("http", "ws", 1) + "/ws"
NOTIFY_TOKEN = os.environ.get("FIRMATEK_NOTIFY_TOKEN", "test_notify_token_123")
TURN_SECRET = os.environ.get("FIRMATEK_TURN_SECRET", "test_turn_shared_secret_1234567890")

results = []
def check(name, cond, detail=""):
    results.append((name, cond, detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

def reg(username, display):
    r = requests.post(f"{BASE}/api/auth/register",
                      json={"username": username, "display_name": display, "password": "secret123"})
    if r.status_code == 409:  # already exists -> login
        r = requests.post(f"{BASE}/api/auth/login", json={"username": username, "password": "secret123"})
        return r.json()["token"], r.json()["user"]["id"]
    j = r.json()
    return j["token"], j.get("user_id") or j["user"]["id"]

async def recv_until(ws, pred, timeout=5):
    """Collect frames until pred(msg) is True or timeout. Server may batch
    multiple JSON frames separated by newlines."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
        except asyncio.TimeoutError:
            return None
        for line in str(raw).split("\n"):
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            if pred(msg):
                return msg
    return None

async def main():
    alice_tok, alice_id = reg("alice", "Alice Anderson")
    bob_tok, bob_id = reg("bob", "Bob Brown")
    check("register/login two users", bool(alice_tok and bob_tok and alice_id and bob_id),
          f"alice={alice_id[:8]} bob={bob_id[:8]}")

    me = requests.get(f"{BASE}/api/me", headers={"Authorization": f"Bearer {alice_tok}"}).json()
    check("GET /api/me", me.get("username") == "alice", me.get("display_name"))

    bad = requests.post(f"{BASE}/api/auth/login", json={"username": "alice", "password": "wrong"})
    check("invalid password rejected 401", bad.status_code == 401, str(bad.status_code))

    noauth = requests.get(f"{BASE}/api/channels")
    check("protected route needs token 401", noauth.status_code == 401, str(noauth.status_code))

    dm = requests.post(f"{BASE}/api/channels/direct/{bob_id}",
                       headers={"Authorization": f"Bearer {alice_tok}"}).json()
    dm_id = dm["channel_id"]
    check("create DM channel", bool(dm_id), dm_id[:8])

    dm2 = requests.post(f"{BASE}/api/channels/direct/{bob_id}",
                        headers={"Authorization": f"Bearer {alice_tok}"}).json()
    check("DM dedup returns existing", dm2.get("channel_id") == dm_id and dm2.get("existing") is True, str(dm2))

    async with websockets.connect(f"{WS}?token={alice_tok}") as aws, \
               websockets.connect(f"{WS}?token={bob_tok}") as bws:
        await asyncio.sleep(0.5)
        await aws.send(json.dumps({
            "type": "chat_message", "channel_id": dm_id,
            "payload": {"channel_id": dm_id, "content": "Hello Bob (realtime)", "type": "text"}
        }))
        got = await recv_until(bws, lambda m: m.get("type") == "chat_message"
                               and m.get("payload", {}).get("content") == "Hello Bob (realtime)")
        check("realtime DM delivered to online recipient", got is not None,
              got["payload"]["content"] if got else "no message received")

        await aws.send(json.dumps({"type": "typing", "channel_id": dm_id, "payload": {"typing": True}}))
        typ = await recv_until(bws, lambda m: m.get("type") == "typing")
        check("typing indicator delivered", typ is not None)

        # heartbeat: client ping -> server pong
        await aws.send(json.dumps({"type": "ping"}))
        pong = await recv_until(aws, lambda m: m.get("type") == "pong", timeout=3)
        check("heartbeat ping -> pong", pong is not None)

    async with websockets.connect(f"{WS}?token={alice_tok}") as aws:
        await asyncio.sleep(0.3)
        await aws.send(json.dumps({
            "type": "chat_message", "channel_id": dm_id,
            "payload": {"channel_id": dm_id, "content": "Offline queued message", "type": "text"}
        }))
        await asyncio.sleep(0.5)

    await asyncio.sleep(0.3)
    async with websockets.connect(f"{WS}?token={bob_tok}") as bws:
        got = await recv_until(bws, lambda m: m.get("type") == "chat_message"
                               and m.get("payload", {}).get("content") == "Offline queued message", timeout=6)
        check("offline message delivered on reconnect", got is not None,
              got["payload"]["content"] if got else "not received")

    hist = requests.get(f"{BASE}/api/channels/{dm_id}/messages",
                        headers={"Authorization": f"Bearer {bob_tok}"}).json()
    contents = [m["content"] for m in hist]
    check("message history persisted", "Hello Bob (realtime)" in contents and "Offline queued message" in contents,
          f"{len(hist)} messages")

    ch = requests.post(f"{BASE}/api/channels", headers={"Authorization": f"Bearer {alice_tok}"},
                       json={"name": "alice-private", "members": []}).json()
    forbidden = requests.get(f"{BASE}/api/channels/{ch['channel_id']}/messages",
                             headers={"Authorization": f"Bearer {bob_tok}"})
    check("non-member cannot read channel (403)", forbidden.status_code == 403, str(forbidden.status_code))

    n = requests.post(f"{BASE}/api/notify", headers={"X-Notify-Token": NOTIFY_TOKEN},
                      json={"channel": "general", "title": "Deploy", "message": "v1.2.3 shipped", "level": "success"})
    check("notify to 'general' channel by name 200", n.status_code == 200, str(n.status_code) + " " + n.text[:80])

    nbad = requests.post(f"{BASE}/api/notify", headers={"X-Notify-Token": "nope"},
                         json={"channel": "general", "message": "x"})
    check("notify bad token 401", nbad.status_code == 401, str(nbad.status_code))

    time.sleep(0.3)
    s = requests.get(f"{BASE}/api/messages/search?q=Offline",
                     headers={"Authorization": f"Bearer {alice_tok}"}).json()
    check("search finds message", any("Offline" in r["content"] for r in s), f"{len(s)} hits")

    # TURN credentials endpoint: must return STUN, and (when configured) a TURN
    # entry whose password is the correct HMAC-SHA1 of "<expiry>:<userID>".
    tc = requests.get(f"{BASE}/api/turn-credentials",
                      headers={"Authorization": f"Bearer {alice_tok}"}).json()
    servers = tc.get("ice_servers", [])
    has_stun = any("stun:" in str(s.get("urls", "")) for s in servers)
    turn = next((s for s in servers if s.get("username")), None)
    ok = has_stun
    detail = f"{len(servers)} servers, turn={'yes' if turn else 'no'}"
    if turn:
        expected = base64.b64encode(
            hmac.new(TURN_SECRET.encode(), turn["username"].encode(), hashlib.sha1).digest()).decode()
        hmac_ok = turn["credential"] == expected
        uid_ok = turn["username"].split(":", 1)[1] == alice_id
        ok = ok and hmac_ok and uid_ok
        detail += f", hmac_ok={hmac_ok}, uid_ok={uid_ok}"
    check("TURN credentials endpoint (STUN + valid HMAC)", ok, detail)

    # Brute-force protection: rapid wrong-password logins for one account should
    # eventually be rate-limited (429). Uses a throwaway username so real
    # accounts aren't affected.
    codes = [requests.post(f"{BASE}/api/auth/login",
                           json={"username": "bruteforce_target", "password": f"guess{i}"}).status_code
             for i in range(15)]
    check("login brute-force is rate-limited (429)", 429 in codes,
          f"codes={sorted(set(codes))}")

    print("\n==== SUMMARY ====")
    passed = sum(1 for _, c, _ in results if c)
    print(f"{passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
