#!/usr/bin/env python3
"""Hub concurrency soak / crash regression test for the Firmatek server.

Exercises the mutex-guarded hub paths that the double-close fix protects:
register / unregister / closeSend / SendToAll, all concurrently, including a
slow reader that gets evicted by the (non-rate-limited) status broadcasts.

This is the integration-level guard for the `panic: close of closed channel`
regression. The authoritative race-free proof is the Go race-detector unit test
(`server/internal/hub/client_test.go`, run with `go test -race`).

See tests/README.md.
"""
import asyncio, json, os, sys, time
import requests
import websockets

BASE = os.environ.get("FIRMATEK_URL", "http://127.0.0.1:8080")
WS = BASE.replace("http", "ws", 1) + "/ws"

def reg(username, display):
    r = requests.post(f"{BASE}/api/auth/register",
                      json={"username": username, "display_name": display, "password": "secret123"})
    if r.status_code == 409:
        r = requests.post(f"{BASE}/api/auth/login", json={"username": username, "password": "secret123"})
        return r.json()["token"], r.json()["user"]["id"]
    j = r.json()
    return j["token"], j.get("user_id") or j["user"]["id"]

async def churn(tok):
    """Open a WS connection, then drop it abruptly — each connect+disconnect
    triggers a user_status broadcast (SendToAll) across the hub."""
    try:
        async with websockets.connect(f"{WS}?token={tok}") as ws:
            await asyncio.sleep(0.05)
    except Exception:
        pass

async def main():
    stamp = int(time.time())
    # A pool of worker users reused across many short-lived connections.
    workers = [reg(f"w{i}_{stamp}", f"W{i}") for i in range(8)]
    bob_tok, bob_id = reg(f"bob_{stamp}", "Bob Slow")

    # Slow reader: small queue, never reads -> broadcasts back up and the hub
    # eventually evicts it (the close #1 path).
    bob = await websockets.connect(f"{WS}?token={bob_tok}", max_queue=8)
    await asyncio.sleep(0.2)

    health_ok = True
    async def health_poller():
        nonlocal health_ok
        for _ in range(20):
            try:
                if requests.get(f"{BASE}/health", timeout=3).status_code != 200:
                    health_ok = False
            except Exception:
                health_ok = False
            await asyncio.sleep(0.5)
    poll = asyncio.create_task(health_poller())

    # Storm: ~300 short-lived connections in concurrent batches + registration
    # churn (user_new broadcasts) interleaved.
    for rnd in range(15):
        batch = [churn(workers[i % len(workers)][0]) for i in range(20)]
        await asyncio.gather(*batch)
        for k in range(2):
            requests.post(f"{BASE}/api/auth/register",
                          json={"username": f"churn_{stamp}_{rnd}_{k}", "display_name": "C", "password": "secret123"})

    poll.cancel()
    try: await bob.close()
    except Exception: pass
    await asyncio.sleep(1.0)

    h = requests.get(f"{BASE}/health")
    alive = h.status_code == 200 and health_ok
    print(f"[{'PASS' if alive else 'FAIL'}] server healthy throughout the connect/disconnect storm ({h.status_code}, poll_ok={health_ok})")

    # Prove the server is still fully functional with a fresh pair of users.
    roundtrip = False
    if h.status_code == 200:
        ctok, _ = reg(f"charlie_{stamp}", "Charlie")
        dtok, did = reg(f"dave_{stamp}", "Dave")
        fresh_dm = requests.post(f"{BASE}/api/channels/direct/{did}",
                                 headers={"Authorization": f"Bearer {ctok}"}).json()["channel_id"]
        async with websockets.connect(f"{WS}?token={ctok}") as c2, \
                   websockets.connect(f"{WS}?token={dtok}") as d2:
            await asyncio.sleep(0.4)
            await c2.send(json.dumps({"type": "chat_message", "channel_id": fresh_dm,
                                      "payload": {"channel_id": fresh_dm, "content": "post-storm ping", "type": "text"}}))
            end = time.time() + 6
            while time.time() < end:
                try:
                    raw = await asyncio.wait_for(d2.recv(), timeout=end - time.time())
                except asyncio.TimeoutError:
                    break
                if any(json.loads(l).get("payload", {}).get("content") == "post-storm ping"
                       for l in str(raw).split("\n") if l.strip()):
                    roundtrip = True
                    break
    print(f"[{'PASS' if roundtrip else 'FAIL'}] realtime messaging works after the storm (fresh users)")
    sys.exit(0 if (alive and roundtrip) else 1)

asyncio.run(main())
