#!/usr/bin/env python3
"""Message-size-limit (T6) and concurrency (T8) tests.

- T6: a WebSocket message larger than the server's 512 KB read limit causes the
  server to close that connection (it must not accept unbounded frames).
- T8: many users register, connect and send concurrently without errors and the
  server stays healthy (concurrent DB writes + hub registration under load).

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

async def main():
    stamp = int(time.time())

    # ---- T6: oversized message is rejected (connection closed) ----
    tok, _ = reg(f"big_{stamp}", "Big Sender")
    gen = requests.get(f"{BASE}/api/channels", headers={"Authorization": f"Bearer {tok}"}).json()
    ch_id = next((c["id"] for c in gen if c["name"] == "general"), None)
    closed = False
    try:
        async with websockets.connect(f"{WS}?token={tok}", max_size=None) as ws:
            await asyncio.sleep(0.3)
            huge = "Z" * (600 * 1024)  # 600 KB > 512 KB server read limit
            await ws.send(json.dumps({"type": "chat_message", "channel_id": ch_id,
                                      "payload": {"channel_id": ch_id, "content": huge, "type": "text"}}))
            # Drain any buffered broadcasts; the server must close the connection.
            deadline = time.time() + 6
            while time.time() < deadline:
                try:
                    await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
                except websockets.ConnectionClosed:
                    closed = True
                    break
                except asyncio.TimeoutError:
                    break
    except websockets.ConnectionClosed:
        closed = True
    check("oversized (>512KB) message closes the connection", closed)

    # ---- T8: concurrent registrations + connections + sends ----
    N = 20
    async def worker(i):
        try:
            t2, _ = await asyncio.get_event_loop().run_in_executor(None, reg, f"conc{i}_{stamp}", f"C{i}")
            async with websockets.connect(f"{WS}?token={t2}") as ws:
                await asyncio.sleep(0.2)
                await ws.send(json.dumps({"type": "chat_message", "channel_id": ch_id,
                                          "payload": {"channel_id": ch_id, "content": f"hi from {i}", "type": "text"}}))
                await asyncio.sleep(0.2)
            return True
        except Exception as e:
            print(f"  worker {i} error: {type(e).__name__}: {e}")
            return False

    outcomes = await asyncio.gather(*[worker(i) for i in range(N)])
    check(f"{sum(outcomes)}/{N} concurrent users registered/connected/sent OK", all(outcomes))

    h = requests.get(f"{BASE}/health")
    check("server healthy after concurrency", h.status_code == 200, str(h.status_code))

    passed = sum(1 for c in results if c)
    print(f"\n{passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
