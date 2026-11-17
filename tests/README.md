# Tests

Integration and stress tests that exercise the running server end-to-end
(REST API + WebSocket), plus notes on how they were used to find and verify
bug fixes.

These are **black-box** tests: they talk to a live server over HTTP/WS, so no
Go toolchain is required to run them — only Python 3 and a running stack.

## Prerequisites

```bash
# From the repo root – bring up the stack (server + postgres + redis)
cp .env.example .env      # or use your own values
docker compose up -d --build

# Python deps for the test scripts
python -m pip install websockets requests
# extra dep for the WebRTC transfer test:
python -m pip install aiortc
```

By default the scripts target `http://localhost:8080` and expect
`NOTIFY_TOKEN=test_notify_token_123` (see `.env`). Override via environment
variables `FIRMATEK_URL` and `FIRMATEK_NOTIFY_TOKEN`.

## Scripts

### `e2e_test.py` — functional end-to-end suite

Simulates two users (Alice, Bob) and asserts the core product flows:

- register / login, `GET /api/me`
- invalid password rejected (401), protected routes require a token (401)
- direct-message channel creation + dedup (same channel returned)
- **real-time** message delivery to an online recipient over WebSocket
- typing indicators
- **offline queueing**: message sent while the recipient is offline is
  delivered on reconnect
- message history persistence
- access control: a non-member gets 403 on a channel they don't belong to
- CI/CD `POST /api/notify` by channel **name** (+ bad-token rejection)
- full-text message search

```bash
python tests/e2e_test.py
```

Exit code 0 when all checks pass.

### `stress_test.py` — hub concurrency soak / crash regression

Drives the mutex-guarded hub paths that the double-close fix protects —
`register` / `unregister` / `closeSend` / `SendToAll` — all concurrently:
~300 short-lived WebSocket connections in batches (each connect+disconnect fans
out a `user_status` broadcast), interleaved with registration churn
(`user_new` broadcasts), plus a slow reader that never drains. It polls
`/health` throughout and asserts the server stays healthy, never panics, and
still delivers a fresh real-time round-trip afterwards.

> The original bug: a slow client's send buffer filled → hub eviction closed
> the channel (close #1); the same client then disconnected → `unregister`
> closed it again (close #2) → `panic: close of closed channel`, crashing the
> process. The **authoritative** race-free proof of the fix is the Go
> race-detector unit test (`server/internal/hub/client_test.go`); this script
> is the integration-level soak that also stresses the surrounding paths.

```bash
python tests/stress_test.py
```

### `webrtc_test.py` — WebRTC P2P file-transfer e2e

Drives two real WebRTC peers (via `aiortc`) that exchange signaling through the
server's WebSocket relay (`rtc_offer` / `rtc_answer`) and transfer a 300 KB file
over an SCTP data channel, then verifies the byte count and SHA-256. Exercises
the server's RTC signaling relay and the client's file-transfer protocol
(header → binary chunks → `eof`).

```bash
python tests/webrtc_test.py
```

### `group_reconnect_test.py` — group fan-out (T4) + reconnect resilience (T3)

A message and typing indicator sent to a multi-member channel reach all other
members (sender excluded from typing); a client that reconnects 5× still
receives on its latest connection.

```bash
python tests/group_reconnect_test.py
```

### `limits_concurrency_test.py` — message size limit (T6) + concurrency (T8)

An oversized (>512 KB) WebSocket message closes the connection; 20 users
register/connect/send concurrently without errors.

```bash
python tests/limits_concurrency_test.py
```

### `audit_test.py` — validation, sessions and access rules

Reserved `system` account, username/password validation, token refresh, DM
rules (no self-DM, no third member, no duplicates under concurrent creation),
channel invitations, delivery to every session of a user, refusal of forged
`system` messages, delivery acknowledgements (a resend with the same
`client_id` is stored and delivered once), LIKE wildcard escaping and that
tokens never reach the access log (reads `docker logs firmatek-server`).

```bash
python tests/audit_test.py
```

### `ldap_test.py` — Active Directory / LDAP login (T5)

Requires the server running with LDAP enabled against a directory containing
`jkowalski` / `ldappass123`. Local test directory:

```bash
net=firmatek_default
docker run -d --name firmatek-openldap --network "$net" \
  -e LDAP_ORGANISATION=Firma -e LDAP_DOMAIN=firma.local \
  -e LDAP_ADMIN_PASSWORD=adminpass -e LDAP_TLS_VERIFY_CLIENT=never \
  osixia/openldap:1.5.0
# add ou=users + uid=jkowalski (cn "Jan Kowalski", userPassword ldappass123) via ldapadd
# then set in .env: LDAP_ENABLED=true, LDAP_URL=ldap://firmatek-openldap:389,
#   LDAP_BASE_DN=dc=firma,dc=local, LDAP_BIND_USER=cn=admin,dc=firma,dc=local,
#   LDAP_BIND_PASSWORD=adminpass, LDAP_USER_FILTER=(uid=%s)
docker compose up -d --force-recreate server
python tests/ldap_test.py
```

### Manual: Tauri UI (T7)

The desktop UI must be exercised on a machine with a display:
`cd client && npm run tauri:dev` (needs the Rust toolchain). Verify the English
strings render, the Settings → Language selector switches EN/PL, code
highlighting works, and file transfer runs in a DM. Not automatable headlessly.

## Go unit tests

Alongside these black-box tests, the server has Go unit tests (in
`server/internal/**/**_test.go`), including a race-detector regression guard for
the hub's send/close concurrency. Run them with a Go toolchain, or via Docker:

```bash
docker run --rm -v "$(pwd)/server:/app" -w /app golang:1.22 go test -race ./...
```

(`golang:1.22` — the Debian-based image — is used rather than `-alpine` because
the race detector needs a C toolchain.)

## Bugs found / verified with these tests

- **`close of closed channel` panic** in `server/internal/hub` — fixed by
  guarding send/close behind a per-client mutex + `closed` flag
  (`trySend` / `closeSend`). Verified by `stress_test.py` (0 panics, 0
  restarts under the storm).
- **`POST /api/notify` by channel name always returned 404** — `resolveChannel`
  compared the `uuid` `id` column directly against a plain string, which errors
  in PostgreSQL. Fixed with `id::text = $1 OR name = $1`. Verified by
  `e2e_test.py`.
