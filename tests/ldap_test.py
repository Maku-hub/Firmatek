#!/usr/bin/env python3
"""LDAP / Active Directory login test (T5).

Requires the server to be running with LDAP enabled against a directory that
has a user `jkowalski` / `ldappass123` (see tests/README.md for the OpenLDAP
setup used in CI/local runs). Verifies that LDAP bind succeeds, the user is
auto-provisioned locally, and a bad password is rejected.
"""
import os, sys
import requests

BASE = os.environ.get("FIRMATEK_URL", "http://127.0.0.1:8080")
results = []
def check(name, cond, detail=""):
    results.append(cond)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

# Server must be in LDAP mode.
cfg = requests.get(f"{BASE}/api/auth/config").json()
check("server reports LDAP enabled", cfg.get("ldap_enabled") is True, str(cfg))

# Correct LDAP credentials authenticate and auto-provision the user.
r = requests.post(f"{BASE}/api/auth/login", json={"username": "jkowalski", "password": "ldappass123"})
ok = r.status_code == 200
token = None
if ok:
    j = r.json()
    token = j.get("token")
    dn = j.get("user", {}).get("display_name")
    ok = bool(token) and dn == "Jan Kowalski"
    check("LDAP login succeeds + display name from directory", ok, f"display_name={dn!r}")
else:
    check("LDAP login succeeds + display name from directory", False, f"HTTP {r.status_code} {r.text[:80]}")

# The token works against a protected route (user provisioned in local DB).
if token:
    me = requests.get(f"{BASE}/api/me", headers={"Authorization": f"Bearer {token}"}).json()
    check("provisioned LDAP user usable via /api/me", me.get("username") == "jkowalski", str(me)[:80])

# Wrong password is rejected.
bad = requests.post(f"{BASE}/api/auth/login", json={"username": "jkowalski", "password": "wrongpass"})
check("wrong LDAP password rejected (401)", bad.status_code == 401, str(bad.status_code))

passed = sum(1 for c in results if c)
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
