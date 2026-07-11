#!/usr/bin/env python3
"""Message history pagination test (#5).

Creates 75 messages in a group channel (3 senders x 25, within the per-user
rate limit), then verifies GET /channels/:id/messages returns the newest page
and that `before=<oldest.created_at>` returns the previous page with no overlap.

See tests/README.md.
"""
import asyncio, json, os, re, sys, time
from datetime import datetime
import requests
import websockets

def parse_ts(ts: str) -> datetime:
    """Parse a Go RFC3339 timestamp (Z suffix, up to 9 fractional digits)."""
    ts = ts.replace("Z", "+00:00")
    ts = re.sub(r"\.(\d{6})\d+", r".\1", ts)  # trim fractional seconds to 6 digits
    return datetime.fromisoformat(ts)

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
    t1, id1 = reg(f"pg1_{stamp}", "Pg One")
    t2, id2 = reg(f"pg2_{stamp}", "Pg Two")
    t3, id3 = reg(f"pg3_{stamp}", "Pg Three")
    ch = requests.post(f"{BASE}/api/channels", headers={"Authorization": f"Bearer {t1}"},
                       json={"name": f"pagi_{stamp}", "members": [id2, id3]}).json()["channel_id"]

    # 3 senders x 25 = 75 messages (each under the 30-msg burst limit).
    async def send25(tok, tag):
        async with websockets.connect(f"{WS}?token={tok}") as ws:
            await asyncio.sleep(0.2)
            for i in range(25):
                await ws.send(json.dumps({"type": "chat_message", "channel_id": ch,
                                          "payload": {"channel_id": ch, "content": f"{tag}-{i:02d}", "type": "text"}}))
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.3)
    await asyncio.gather(send25(t1, "a"), send25(t2, "b"), send25(t3, "c"))
    time.sleep(0.5)

    hdr = {"Authorization": f"Bearer {t1}"}
    page1 = requests.get(f"{BASE}/api/channels/{ch}/messages?limit=50", headers=hdr).json()
    check("page 1 returns a full page of 50", len(page1) == 50, f"{len(page1)}")
    # Ascending order within the page
    asc = all(parse_ts(page1[i]["created_at"]) <= parse_ts(page1[i + 1]["created_at"]) for i in range(len(page1) - 1))
    check("page is chronologically ordered", asc)

    oldest = page1[0]["created_at"]
    page2 = requests.get(f"{BASE}/api/channels/{ch}/messages?limit=50&before={oldest}", headers=hdr).json()
    check("page 2 (before oldest) returns the remaining ~25", 20 <= len(page2) <= 25, f"{len(page2)}")

    ids1 = {m["id"] for m in page1}
    ids2 = {m["id"] for m in page2}
    check("no overlap between pages", ids1.isdisjoint(ids2))
    check("two pages cover ~75 unique messages", 70 <= len(ids1 | ids2) <= 75, f"{len(ids1 | ids2)}")

    bad = requests.get(f"{BASE}/api/channels/{ch}/messages?before=not-a-date", headers=hdr)
    check("invalid 'before' rejected (400)", bad.status_code == 400, str(bad.status_code))

    passed = sum(1 for c in results if c)
    print(f"\n{passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
