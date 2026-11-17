#!/usr/bin/env python3
"""Regression tests for the second review round.

Covers multi-device sessions, input validation on the WebSocket, token
refresh, DM rules, LIKE wildcard escaping and the reserved system account.
See tests/README.md for setup.
"""
import asyncio, json, os, subprocess, sys, time, uuid
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

def auth(tok):
    return {"Authorization": f"Bearer {tok}"}

async def recv_until(ws, pred, timeout=4):
    end = time.time() + timeout
    while time.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            return None
        for line in str(raw).split("\n"):
            if line.strip():
                msg = json.loads(line)
                if pred(msg):
                    return msg
    return None

async def main():
    stamp = int(time.time())
    a_tok, a_id = reg(f"aud_a_{stamp}", "Audit A")
    b_tok, b_id = reg(f"aud_b_{stamp}", "Audit B")
    dm = requests.post(f"{BASE}/api/channels/direct/{b_id}", headers=auth(a_tok)).json()["channel_id"]

    # The system account name is reserved.
    r = requests.post(f"{BASE}/api/auth/register", json={"username": "system", "display_name": "Fake", "password": "secret123"})
    check("cannot register as 'system'", r.status_code == 409, str(r.status_code))

    r = requests.post(f"{BASE}/api/auth/register", json={"username": "a b", "display_name": "Bad Name", "password": "secret123"})
    check("invalid username gets a readable 400", r.status_code == 400 and "username" in r.json().get("error", ""), r.text[:80])

    r = requests.post(f"{BASE}/api/auth/register", json={"username": f"long_{stamp}", "display_name": "Long Pw", "password": "x" * 80})
    check("password over 72 bytes rejected", r.status_code == 400, str(r.status_code))

    users = requests.get(f"{BASE}/api/users", headers=auth(a_tok)).json()
    check("system account hidden from the user list", all(u["username"] != "system" for u in users))

    # Token refresh returns a working token.
    r = requests.post(f"{BASE}/api/auth/refresh", headers=auth(a_tok))
    new_tok = r.json().get("token") if r.ok else None
    me = requests.get(f"{BASE}/api/me", headers=auth(new_tok or "")) if new_tok else None
    check("token refresh issues a usable token", bool(me is not None and me.ok and me.json()["id"] == a_id), str(r.status_code))

    r = requests.post(f"{BASE}/api/channels/direct/{a_id}", headers=auth(a_tok))
    check("DM with yourself rejected", r.status_code == 400, str(r.status_code))
    r = requests.post(f"{BASE}/api/channels/direct/not-a-uuid", headers=auth(a_tok))
    check("DM with unknown user is 404", r.status_code == 404, str(r.status_code))

    c_tok, c_id = reg(f"aud_c_{stamp}", "Audit C")
    r = requests.post(f"{BASE}/api/channels/{dm}/members", headers=auth(a_tok), json={"user_id": c_id})
    check("third person cannot be added to a DM", r.status_code == 400, str(r.status_code))

    # Two concurrent DM creations must yield one channel.
    d_tok, d_id = reg(f"aud_d_{stamp}", "Audit D")
    loop = asyncio.get_event_loop()
    ids = await asyncio.gather(*[loop.run_in_executor(None, lambda: requests.post(
        f"{BASE}/api/channels/direct/{d_id}", headers=auth(a_tok)).json()["channel_id"]) for _ in range(5)])
    check("concurrent DM creation yields one channel", len(set(ids)) == 1, f"{len(set(ids))} distinct")

    # Channel creation notifies invited members.
    async with websockets.connect(f"{WS}?token={b_tok}") as bws:
        await asyncio.sleep(0.3)
        r = requests.post(f"{BASE}/api/channels", headers=auth(a_tok),
                          json={"name": f"team-{stamp}", "members": [b_id, "garbage"]})
        got = await recv_until(bws, lambda m: m.get("type") == "channel_added")
        check("new channel: invalid member IDs ignored, members notified",
              r.status_code == 201 and got is not None, str(r.status_code))

    async with websockets.connect(f"{WS}?token={a_tok}") as a1, \
               websockets.connect(f"{WS}?token={a_tok}") as a2, \
               websockets.connect(f"{WS}?token={b_tok}") as bws:
        await asyncio.sleep(0.4)

        # Both of A's sessions receive B's message.
        await bws.send(json.dumps({"type": "chat_message", "channel_id": dm,
                                   "payload": {"channel_id": dm, "content": "to both devices", "type": "text"}}))
        m1 = await recv_until(a1, lambda m: m.get("payload", {}).get("content") == "to both devices")
        m2 = await recv_until(a2, lambda m: m.get("payload", {}).get("content") == "to both devices")
        check("message reaches every open session of a user", m1 is not None and m2 is not None)
        check("live message carries avatar colour and DB timestamp",
              bool(m1 and m1["payload"]["sender"].get("avatar_color") and m1["payload"]["id"]))

        # Clients may not forge system messages or inline images.
        await a1.send(json.dumps({"type": "chat_message", "channel_id": dm,
                                  "payload": {"channel_id": dm, "content": "fake", "type": "system"}}))
        err = await recv_until(a1, lambda m: m.get("type") == "error")
        check("client cannot send 'system' messages", err is not None, json.dumps(err)[:80] if err else "no error")

        await a1.send(json.dumps({"type": "chat_message", "channel_id": dm,
                                  "payload": {"channel_id": dm, "content": "   ", "type": "text"}}))
        blank = await recv_until(bws, lambda m: m.get("type") == "chat_message"
                                 and m["payload"]["content"].strip() == "", timeout=1.5)
        check("blank message is not stored or delivered", blank is None)

        # Only the typing flag is relayed, never arbitrary payload fields.
        await a1.send(json.dumps({"type": "typing", "channel_id": dm, "payload": {"typing": True, "x": "<b>"}}))
        typ = await recv_until(bws, lambda m: m.get("type") == "typing")
        check("typing forwarded with sanitised payload", typ is not None and typ["payload"] == {"typing": True})

        # Closing one session must not mark A offline.
        await a2.close()
        off = await recv_until(bws, lambda m: m.get("type") == "user_status" and m["payload"]["user_id"] == a_id
                               and not m["payload"]["online"], timeout=1.5)
        check("closing one of two sessions keeps the user online", off is None)

    # Delivery acknowledgements and idempotent resends.
    async with websockets.connect(f"{WS}?token={a_tok}") as aws, \
               websockets.connect(f"{WS}?token={b_tok}") as bws:
        await asyncio.sleep(0.3)
        cid = str(uuid.uuid4())
        frame = json.dumps({"type": "chat_message", "channel_id": dm,
                            "payload": {"channel_id": dm, "client_id": cid, "content": f"ack me {stamp}", "type": "text"}})
        await aws.send(frame)
        ack = await recv_until(aws, lambda m: m.get("type") == "message_ack")
        check("sender gets message_ack with its client_id",
              bool(ack and ack["payload"]["client_id"] == cid and ack["payload"]["id"]))
        first = await recv_until(bws, lambda m: m.get("payload", {}).get("client_id") == cid)
        check("recipient gets the message once", first is not None)

        await aws.send(frame)  # e.g. the ack was lost and the app resends
        ack2 = await recv_until(aws, lambda m: m.get("type") == "message_ack")
        check("resend is acknowledged with the same message id",
              bool(ack and ack2 and ack2["payload"]["id"] == ack["payload"]["id"]))
        dup = await recv_until(bws, lambda m: m.get("payload", {}).get("client_id") == cid, timeout=1.5)
        check("resend is not delivered a second time", dup is None)

        bad_cid = str(uuid.uuid4())
        await aws.send(json.dumps({"type": "chat_message", "channel_id": dm,
                                   "payload": {"channel_id": dm, "client_id": bad_cid, "content": "x" * 20001, "type": "text"}}))
        err = await recv_until(aws, lambda m: m.get("type") == "error")
        check("rejection names the message it refers to", bool(err and err["payload"].get("client_id") == bad_cid))

    hist = requests.get(f"{BASE}/api/channels/{dm}/messages", headers=auth(a_tok)).json()
    check("resent message stored only once", sum(1 for m in hist if m["content"] == f"ack me {stamp}") == 1)

    # LIKE wildcards are literal.
    async with websockets.connect(f"{WS}?token={a_tok}") as aws:
        await asyncio.sleep(0.3)
        await aws.send(json.dumps({"type": "chat_message", "channel_id": dm,
                                   "payload": {"channel_id": dm, "content": f"discount 100% {stamp}", "type": "text"}}))
        await asyncio.sleep(0.5)
    hits = requests.get(f"{BASE}/api/messages/search", params={"q": "%"}, headers=auth(a_tok)).json()
    check("search for '%' matches only messages containing '%'", all("%" in h["content"] for h in hits), f"{len(hits)} hits")

    # Tokens in query strings must not reach the server log.
    logs = subprocess.run(["docker", "logs", "--since", "2m", "firmatek-server"], capture_output=True, text=True)
    out = logs.stdout + logs.stderr
    check("tokens are not written to the access log", "token=" not in out and a_tok not in out)

    passed = sum(1 for c in results if c)
    print(f"\n{passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
