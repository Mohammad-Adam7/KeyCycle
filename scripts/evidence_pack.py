"""Run the evaluation cases T1-T6 and T-final against freshly seeded SYNTHETIC databases and write
a reproducible evidence report (input, expected result, actual result, evidence, pass/fail),
a decision matrix (false positives / false negatives), latency measurements and the
configuration-change demonstration.

    python3 scripts/evidence_pack.py            # real Argon2 settings (realistic latency)
    python3 scripts/evidence_pack.py --fast     # weak KDF, finishes in seconds (latency not meaningful)

Output: evidence/evidence_report.md and evidence/evidence.json.  Nothing here touches your own
database: every run uses temporary databases that are deleted afterwards."""
import argparse
import json
import os
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if "--fast" in sys.argv:
    os.environ["KEYCYCLE_FAST_KDF"] = "1"

from starlette.testclient import TestClient  # noqa: E402

from app import audit  # noqa: E402
from app.main import create_app  # noqa: E402
from scripts.recover_backup import recover  # noqa: E402
from scripts.seed_demo import seed  # noqa: E402

PW = "Evidence-Run-Password-1"          # synthetic, exists only for this run
STEPS: list[dict] = []


# --------------------------------------------------------------------------- helpers
class Env:
    def __init__(self, label):
        self.dir = Path(tempfile.mkdtemp(prefix=f"kc-evidence-{label}-"))
        self.db = str(self.dir / "kc.db")
        self.fix = seed(self.db, PW, PW)
        self.app = create_app(self.db)

    def client(self, user=None):
        c = TestClient(self.app, raise_server_exceptions=False)
        if user:
            r = c.post("/api/auth/login", json={"username": user, "password": PW})
            assert r.status_code == 200, (user, r.text)
            c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
        return c

    def row(self, entry):
        c = sqlite3.connect(self.db)
        c.row_factory = sqlite3.Row
        r = c.execute("SELECT * FROM audit_events WHERE entry_no=?", (entry,)).fetchone()
        c.close()
        return r

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def entry_of(resp):
    try:
        body = resp.json()
    except ValueError:
        return None
    return body.get("audit_entry") or (body.get("result") or {}).get("audit_entry")


def describe(env, resp):
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code} (non-JSON)"
    code = body.get("code") or ((body.get("result") or {}).get("reason") or {}).get("code") or "OK"
    rule = ((body.get("result") or {}).get("rule") or {})
    text = f"HTTP {resp.status_code} {code}"
    if rule.get("name"):
        text += f" (rule {rule['name']} v{rule.get('version')})"
    return text


def step(case, title, given, expected, env, resp, ok, evidence=None, actual=None):
    n = entry_of(resp) if resp is not None else None
    ev = evidence or ""
    if n and env is not None:
        r = env.row(n)
        if r is not None:
            ev = (ev + "; " if ev else "") + f"audit #{n}: {r['action']}/{r['outcome']}/{r['reason'] or '-'}"
    STEPS.append(dict(case=case, step=title, input=given, expected=expected,
                      actual=actual or describe(env, resp), evidence=ev or "-", passed=bool(ok)))
    return resp


def post(c, path, body=None):
    return c.post(path, json=body if body is not None else {})


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def confirm_and(c, action, **kw):
    r = c.post("/api/confirmations", json={"action": action, **kw})
    assert r.status_code == 201, r.text
    return r.json()["data"]["confirmation_token"]


# --------------------------------------------------------------------------- cases
def t1():
    env = Env("t1")
    admin = env.client("admin")
    r = post(admin, "/api/vault/unlock", {"passphrase": "wrong-passphrase-1"})
    step("T1", "Wrong vault passphrase", "admin unlocks with an incorrect passphrase",
         "403 PASSPHRASE_INVALID, vault stays locked, attempt audited", env, r,
         r.status_code == 403 and r.json()["code"] == "PASSPHRASE_INVALID")
    locked = admin.get("/api/vault/status").json()["locked"]
    step("T1", "Vault still locked", "GET /api/vault/status", "locked = true", env, None, locked,
         actual=f"locked = {locked}")
    for i in range(2, 6):
        post(admin, "/api/vault/unlock", {"passphrase": f"wrong-passphrase-{i}"})
    r = post(admin, "/api/vault/unlock", {"passphrase": PW})
    step("T1", "Lockout after repeated failures", "5 wrong passphrases, then the CORRECT one",
         "429 TOO_MANY_ATTEMPTS (even the right passphrase is refused during lockout)", env, r,
         r.status_code == 429 and r.json()["code"] == "TOO_MANY_ATTEMPTS")
    rows = sqlite3.connect(env.db).execute(
        "SELECT details||reason FROM audit_events WHERE action='vault_unlock'").fetchall()
    blob = " ".join(x[0] for x in rows)
    leaked = any(p in blob for p in [PW, "wrong-passphrase"])
    step("T1", "Passphrase never logged", "search every vault_unlock audit entry for any passphrase",
         "no passphrase text in the audit log", env, None, not leaked and len(rows) >= 6,
         actual=f"{len(rows)} unlock entries, passphrase found: {leaked}")
    unknown = TestClient(env.app).post("/api/auth/login", json={"username": "nobody-here", "password": "x" * 12})
    known = TestClient(env.app).post("/api/auth/login", json={"username": "viewer", "password": "x" * 12})
    same = unknown.json()["message"] == known.json()["message"] and unknown.status_code == known.status_code
    step("T1", "Generic login failure", "wrong password for a real user vs unknown username",
         "identical status and message (no account enumeration)", env, known, same,
         actual=f"HTTP {known.status_code} / {unknown.status_code}; messages identical: {same}")
    env.close()


def build_main():
    env = Env("main")
    env.admin, env.op, env.op2 = env.client("admin"), env.client("operator1"), env.client("operator2")
    env.viewer = env.client("viewer")
    assert post(env.admin, "/api/vault/unlock", {"passphrase": PW}).status_code == 200
    return env


def t2(env):
    r = post(env.viewer, "/api/crypto/encrypt", {"key_id": 2, "data": "x"})
    step("T2", "Viewer tries to encrypt", "viewer POST /crypto/encrypt key 2",
         "403 FORBIDDEN, generic message only (no key, rule or record detail), attempt logged", env, r,
         r.status_code == 403 and r.json()["code"] == "FORBIDDEN" and set(r.json()) == {"code", "message", "audit_entry"})
    r = post(env.admin, "/api/crypto/encrypt", {"key_id": 2, "data": "x"})
    step("T2", "Administrator uses a standard key", "admin encrypts with finance-key (standard)",
         "403 FORBIDDEN (purpose separation: admins only use test keys)", env, r, r.status_code == 403)
    r = post(env.op, "/api/crypto/encrypt", {"key_id": 5, "data": "x"})
    step("T2", "Operator uses a test key", "operator encrypts with test-key", "403 FORBIDDEN", env, r,
         r.status_code == 403)
    r = post(env.op, "/api/keys", {"name": "op-made-key", "purpose": "standard"})
    step("T2", "Operator creates a key", "operator POST /keys", "403 FORBIDDEN", env, r, r.status_code == 403)
    r = env.op.get("/api/audit")
    step("T2", "Operator reads the audit log", "operator GET /audit", "403 FORBIDDEN", env, r, r.status_code == 403)
    r = env.client().post("/api/crypto/encrypt", json={"key_id": 2, "data": "x"})
    step("T2", "No session", "POST /crypto/encrypt without signing in", "401 SESSION_EXPIRED", env, r,
         r.status_code == 401 and r.json()["code"] == "SESSION_EXPIRED")
    c = env.client()
    c.post("/api/auth/login", json={"username": "admin", "password": PW})        # cookie but no CSRF header
    r = c.post("/api/keys", json={"name": "csrf-probe", "purpose": "standard"})
    step("T2", "Missing CSRF token", "authenticated POST without X-CSRF-Token", "403 CSRF_INVALID", env, r,
         r.status_code == 403 and r.json()["code"] == "CSRF_INVALID")
    r = TestClient(env.app).post("/api/auth/login", json={"username": "trainee", "password": PW})
    step("T2", "Disabled account", "login as the disabled user 'trainee' with the correct password",
         "401 AUTH_FAILED", env, r, r.status_code == 401 and r.json()["code"] == "AUTH_FAILED")
    post(env.op, "/api/crypto/encrypt", {"key_id": 2, "data": "sanitised-view probe"})
    items = env.viewer.get("/api/results").json()["data"]["items"]
    clean = bool(items) and all("user" not in i and "evidence" not in i for i in items)
    step("T2", "Viewer sees sanitised results", "viewer GET /results",
         "results exclude user names and evidence", env, None, clean,
         actual=f"{len(items)} items; user/evidence fields present: {not clean}")


def t3(env):
    fx = env.fix
    r = post(env.op, "/api/crypto/decrypt", {"package": fx["retired_version_package"]})
    step("T3", "Old version still decrypts", "operator decrypts a package made under payroll-key v1 (key is now v3)",
         "200, plaintext 'Synthetic payroll sample'", env, r,
         r.status_code == 200 and r.json()["data"]["plaintext"] == "Synthetic payroll sample")
    p3 = post(env.op, "/api/crypto/encrypt", {"key_id": 1, "data": "version three"}).json()["data"]["package"]
    tok = confirm_and(env.admin, "rotate", key_id=1)
    r = post(env.admin, "/api/keys/1/rotate", {"confirmation_token": tok})
    step("T3", "Rotate payroll-key", "admin rotates payroll-key with a single-use confirmation",
         "200 ROTATE_OK, current version 4", env, r, r.status_code == 200 and r.json()["data"]["current_version"] == 4)
    p4 = post(env.op, "/api/crypto/encrypt", {"key_id": 1, "data": "version four"}).json()["data"]["package"]
    both = [post(env.op, "/api/crypto/decrypt", {"package": p}).json().get("data", {}).get("plaintext")
            for p in (p3, p4, fx["retired_version_package"])]
    step("T3", "Every version decrypts after rotation", "decrypt packages from v1, v3 and the new v4",
         "all three return their original plaintext", env, None,
         both == ["version three", "version four", "Synthetic payroll sample"],
         actual=f"plaintexts: {both}")
    for name in ("altered_ciphertext", "altered_version", "altered_key"):
        r = post(env.op, "/api/crypto/decrypt", {"package": fx[name]})
        step("T3", f"Tampered package: {name}", f"decrypt fixtures.{name}",
             "400 CIPHERTEXT_INVALID (AAD binds key id and version)", env, r,
             r.status_code == 400 and r.json()["code"] == "CIPHERTEXT_INVALID")


def t4(env):
    r = post(env.op, "/api/crypto/encrypt", {"key_id": env.fix["keys"]["legacy-api"], "data": "x"})
    step("T4", "Revoked key", "encrypt with legacy-api (revoked)", "409 KEY_REVOKED (rule key_state_check)",
         env, r, r.status_code == 409 and r.json()["code"] == "KEY_REVOKED")
    r = post(env.op, "/api/crypto/encrypt", {"key_id": env.fix["keys"]["archive-2026"], "data": "x"})
    step("T4", "Expired key", "encrypt with archive-2026 (expired)", "409 KEY_EXPIRED", env, r,
         r.status_code == 409 and r.json()["code"] == "KEY_EXPIRED")
    kid, name = env.fix["keys"]["backup-key"], "backup-key"
    v1 = post(env.op, "/api/crypto/encrypt", {"key_id": kid, "data": "under v1"}).json()["data"]["package"]
    post(env.admin, f"/api/keys/{kid}/rotate", {"confirmation_token": confirm_and(env.admin, "rotate", key_id=kid)})
    v2 = post(env.op, "/api/crypto/encrypt", {"key_id": kid, "data": "under v2"}).json()["data"]["package"]
    r = post(env.admin, f"/api/keys/{kid}/revoke", {"confirmation_token": confirm_and(env.admin, "revoke", key_id=kid),
                                                     "reason": "evidence run", "confirm_name": name})
    step("T4", "Revoke a rotated key", "admin revokes backup-key (two versions) with confirmation and typed name",
         "200 REVOKE_OK", env, r, r.status_code == 200)
    outs = [post(env.op, "/api/crypto/decrypt", {"package": p}) for p in (v1, v2)]
    step("T4", "All versions refused after revocation", "decrypt the v1 and v2 packages",
         "both 409 KEY_REVOKED", env, outs[1], all(o.status_code == 409 and o.json()["code"] == "KEY_REVOKED" for o in outs),
         actual="v1: " + describe(env, outs[0]) + " | v2: " + describe(env, outs[1]))
    r = post(env.admin, "/api/confirmations", {"action": "rotate", "key_id": kid})
    step("T4", "Revoked key cannot be rotated", "request a rotate confirmation for the revoked key",
         "409 KEY_REVOKED", env, r, r.status_code == 409 and r.json()["code"] == "KEY_REVOKED")


def t5():
    env = Env("t5")
    admin = env.client("admin")
    ok = post(admin, "/api/audit/verify", {})
    head = ok.json()["result"]["verified_head"]
    step("T5", "Untouched chain verifies", "admin runs Verify chain on the seeded database",
         "200, valid, head recorded", env, ok, ok.status_code == 200,
         actual=f"valid; {head['entry_count']} entries, head {head['hash'][:12]}…")
    for _ in range(3):
        TestClient(env.app).post("/api/auth/login", json={"username": "nobody", "password": "x" * 12})
    post(admin, "/api/audit/verify", {})
    con = sqlite3.connect(env.db)
    con.execute("DROP TRIGGER audit_no_update")
    con.execute("UPDATE audit_events SET reason='tampered' WHERE entry_no=3")
    con.commit()
    r = post(admin, "/api/audit/verify", {})
    res = r.json().get("result", {})
    step("T5", "Edited entry is detected", "attacker drops the update trigger and edits entry #3, then Verify",
         "409 TAMPER_DETECTED, first_mismatch 3, severity critical", env, r,
         r.status_code == 409 and res.get("first_mismatch") == 3,
         actual=f"HTTP {r.status_code} TAMPER_DETECTED, first_mismatch={res.get('first_mismatch')}, reason={res.get('reason')}")
    crit = sqlite3.connect(env.db).execute(
        "SELECT COUNT(*) FROM audit_events WHERE action='audit_verify' AND severity='critical'").fetchone()[0]
    step("T5", "Detection itself is audited", "count critical audit_verify entries", "at least 1", env, None, crit >= 1,
         actual=f"{crit} critical entry")
    env.close()
    env = Env("t5b")
    admin = env.client("admin")
    head = post(admin, "/api/audit/verify", {}).json()["result"]["verified_head"]
    for _ in range(3):
        TestClient(env.app).post("/api/auth/login", json={"username": "nobody", "password": "x" * 12})
    con = sqlite3.connect(env.db)
    for t in ("audit_no_update", "audit_no_delete", "audit_chain_previous"):
        con.execute(f"DROP TRIGGER {t}")
    con.execute("DELETE FROM audit_events WHERE entry_no > ?", (head["entry_count"] - 2,))
    con.commit()
    plain = post(admin, "/api/audit/verify", {})
    anchored = post(admin, "/api/audit/verify", {"anchor_count": head["entry_count"], "anchor_hash": head["hash"]})
    step("T5", "Truncated tail caught by an anchor", "attacker deletes the last entries; Verify with the remembered head",
         "an unanchored Verify cannot see it; the anchored one returns TAMPER_DETECTED (CHAIN_TRUNCATED)", env, anchored,
         anchored.status_code == 409 and anchored.json()["result"]["reason"] == "CHAIN_TRUNCATED",
         actual=f"unanchored: HTTP {plain.status_code}; anchored: HTTP {anchored.status_code} "
                f"{anchored.json()['result'].get('reason')}")
    env.close()


def t6(env):
    tok = confirm_and(env.admin, "backup")
    r = post(env.admin, "/api/backups", {"confirmation_token": tok})
    name = r.json()["data"]["name"]
    step("T6", "Create an authenticated backup", "admin creates a backup with a single-use confirmation",
         "201 BACKUP_CREATED", env, r, r.status_code == 201, evidence=f"file {name}")
    r = env.admin.post(f"/api/backups/{name}/verify")
    step("T6", "Verify the backup", "verify HMAC and the embedded audit chain", "200 valid", env, r, r.status_code == 200)
    tok = confirm_and(env.admin, "recovery_drill", backup_name=name)
    r = post(env.admin, "/api/recovery-drill", {"backup_name": name, "confirmation_token": tok, "passphrase": PW})
    steps = r.json()["data"]["steps"] if r.status_code == 200 else []
    step("T6", "Recovery drill", "run the 4-step drill in isolation (live data untouched)",
         "authenticate backup, verify chain, restore in isolation, decrypt proof: all pass", env, r,
         r.status_code == 200 and all(s["passed"] for s in steps),
         actual=f"HTTP {r.status_code}: " + ", ".join(f"{s['step']}={'pass' if s['passed'] else 'FAIL'}" for s in steps))
    raw = bytearray((Path(env.db).parent / "backups" / name).read_bytes())
    raw[len(raw) // 2] ^= 1
    bad = "keycycle-20200101T000000Z-deadbeef.kcbak"
    (Path(env.db).parent / "backups" / bad).write_bytes(bytes(raw))
    r = env.admin.post(f"/api/backups/{bad}/verify")
    step("T6", "Corrupted backup is rejected", "flip one byte in a copy and verify it", "422 BACKUP_INVALID", env, r,
         r.status_code == 422 and r.json()["code"] == "BACKUP_INVALID")
    (Path(env.db).parent / "backups" / bad).unlink()
    # real recovery into a brand-new location, as after losing the database
    new = Path(tempfile.mkdtemp(prefix="kc-evidence-recovered-"))
    (new / "backups").mkdir()
    shutil.copy(Path(env.db).parent / "backups" / name, new / "backups" / name)
    try:
        recover(new / "kc.db", name, "not-the-passphrase")
        wrong_rejected = False
    except Exception:
        wrong_rejected = True
    out = recover(new / "kc.db", name, PW)
    app2 = create_app(str(new / "kc.db"))
    a2 = TestClient(app2, raise_server_exceptions=False)
    lr = a2.post("/api/auth/login", json={"username": "admin", "password": PW})
    a2.headers["X-CSRF-Token"] = lr.json()["csrf_token"]
    ur = a2.post("/api/vault/unlock", json={"passphrase": PW})
    o2 = TestClient(app2, raise_server_exceptions=False)
    o2.headers["X-CSRF-Token"] = o2.post("/api/auth/login", json={"username": "operator1", "password": PW}).json()["csrf_token"]
    dec = o2.post("/api/crypto/decrypt", json={"package": env.fix["retired_version_package"]})
    ok = (wrong_rejected and ur.status_code == 200 and dec.status_code == 200
          and dec.json()["data"]["plaintext"] == "Synthetic payroll sample")
    STEPS.append(dict(case="T6", step="Real recovery after losing the database",
                      input="restore the backup into an empty location with scripts/recover_backup.py; try a wrong passphrase first",
                      expected="wrong passphrase refused; right one restores; vault unlocks; an OLD ciphertext decrypts",
                      actual=f"wrong passphrase refused: {wrong_rejected}; restored audit entry #{out['audit_entry']}; "
                             f"unlock HTTP {ur.status_code}; decrypt HTTP {dec.status_code}",
                      evidence=f"recovery audit entry #{out['audit_entry']}, chain head {out['chain_head']['hash'][:12]}…",
                      passed=bool(ok)))
    shutil.rmtree(new, ignore_errors=True)


def t_final(env):
    h = {"Content-Type": "application/json"}
    r = env.op.post("/api/crypto/encrypt", content="{not json", headers=h)
    step("T-final", "Malformed JSON", "POST '{not json'", "400 INVALID_INPUT, no stack trace", env, r,
         r.status_code == 400 and r.json()["code"] == "INVALID_INPUT" and "Traceback" not in r.text)
    r = post(env.op, "/api/crypto/encrypt", {"key_id": 2, "data": "x", "is_admin": True})
    step("T-final", "Unexpected field", "extra property 'is_admin'", "400 INVALID_INPUT", env, r, r.status_code == 400)
    r = post(env.op, "/api/crypto/encrypt", {"key_id": "2; DROP TABLE keys", "data": "x"})
    step("T-final", "Injection attempt in a field", "key_id = \"2; DROP TABLE keys\"", "400 INVALID_INPUT (typed schema)",
         env, r, r.status_code == 400)
    r = post(env.op, "/api/crypto/encrypt", {"key_id": 2, "data": "A" * (64 * 1024 + 1)})
    step("T-final", "Oversized data", "65 KiB of plaintext (limit 64 KiB)", "PAYLOAD_TOO_LARGE with the threshold recorded",
         env, r, r.json().get("code") == "PAYLOAD_TOO_LARGE",
         evidence="threshold " + json.dumps(r.json().get("result", {}).get("thresholds", {})))
    r = env.op.post("/api/crypto/encrypt", content=b"x" * (300 * 1024), headers=h)
    step("T-final", "Oversized request body", "300 KiB body (hard limit 256 KiB)", "413 PAYLOAD_TOO_LARGE before parsing",
         env, r, r.status_code == 413)
    tok = confirm_and(env.admin, "rotate", key_id=2)
    post(env.admin, "/api/keys/2/rotate", {"confirmation_token": tok})
    r = post(env.admin, "/api/keys/2/rotate", {"confirmation_token": tok})
    step("T-final", "Repeated submission (replay)", "reuse a consumed rotation confirmation",
         "409 CONFIRMATION_REQUIRED, no second rotation", env, r,
         r.status_code == 409 and r.json()["code"] == "CONFIRMATION_REQUIRED")
    codes = [post(env.op2, "/api/crypto/encrypt", {"key_id": 2, "data": f"burst {i}"}).status_code for i in range(35)]
    step("T-final", "Rate limit on a sensitive action", "35 encrypts in a few seconds (limit 30/min/user)",
         "first 30 succeed, the rest 429 RATE_LIMITED", env, None, codes[:30] == [200] * 30 and set(codes[30:]) == {429},
         actual=f"{codes.count(200)} x 200, {codes.count(429)} x 429")
    r = env.admin.post("/api/backups/keycycle-20990101T000000Z-00000000.kcbak/verify")
    step("T-final", "Safe failure", "verify a backup that does not exist",
         "422 BACKUP_INVALID with a generic message, no path or stack trace", env, r,
         r.status_code == 422 and "Traceback" not in r.text and "/" not in r.json()["message"])
    before = sqlite3.connect(env.db).execute("SELECT COUNT(*) FROM keys").fetchone()[0]
    app2 = create_app(env.db)
    c2 = TestClient(app2, raise_server_exceptions=False)
    c2.headers["X-CSRF-Token"] = c2.post("/api/auth/login", json={"username": "operator1", "password": PW}).json()["csrf_token"]
    locked = c2.post("/api/crypto/encrypt", json={"key_id": 2, "data": "x"})
    ac = TestClient(app2, raise_server_exceptions=False)
    ac.headers["X-CSRF-Token"] = ac.post("/api/auth/login", json={"username": "admin", "password": PW}).json()["csrf_token"]
    ac.post("/api/vault/unlock", json={"passphrase": PW})
    after = c2.post("/api/crypto/encrypt", json={"key_id": 2, "data": "x"})
    verify = post(ac, "/api/audit/verify", {})
    keys = sqlite3.connect(env.db).execute("SELECT COUNT(*) FROM keys").fetchone()[0]
    ok = (locked.status_code == 423 and after.status_code == 200 and verify.status_code == 200 and keys == before)
    STEPS.append(dict(case="T-final", step="Recovery after restart",
                      input="start a NEW application process on the same database",
                      expected="vault locked (423 VAULT_LOCKED), keys and audit chain intact, works again after unlock",
                      actual=f"before unlock HTTP {locked.status_code}; after unlock HTTP {after.status_code}; "
                             f"chain verify HTTP {verify.status_code}; keys {before} -> {keys}",
                      evidence="audit chain verified after restart", passed=bool(ok)))


# --------------------------------------------------------------------------- measurements
def decision_matrix(env):
    """Each case states whether the request SHOULD be allowed.  A false positive here is a request
    that was allowed but should have been refused (security failure); a false negative is a
    legitimate request that was refused (availability failure)."""
    fx = env.fix["keys"]
    new = iter(range(1000))

    def fresh(p="standard"):
        r = post(env.admin, "/api/keys", {"name": f"matrix-{next(new)}", "purpose": p})
        return r.json()["data"]["id"], r.json()["data"]["name"]

    c = {"admin": env.admin, "operator": env.op, "viewer": env.viewer, "anonymous": env.client()}
    cases = []
    for who, std, tst in (("admin", False, True), ("operator", True, False), ("viewer", False, False),
                          ("anonymous", False, False)):
        cases += [(f"{who} encrypts with a standard key", who, "POST", "/api/crypto/encrypt", {"key_id": 2, "data": "m"}, std),
                  (f"{who} encrypts with a test key", who, "POST", "/api/crypto/encrypt", {"key_id": 5, "data": "m"}, tst)]
    pkg = post(env.op, "/api/crypto/encrypt", {"key_id": 2, "data": "m"}).json()["data"]["package"]
    tpk = post(env.admin, "/api/crypto/encrypt", {"key_id": 5, "data": "m"}).json()["data"]["package"]
    for who, std, tst in (("admin", False, True), ("operator", True, False), ("viewer", False, False)):
        cases += [(f"{who} decrypts a standard-key package", who, "POST", "/api/crypto/decrypt", {"package": pkg}, std),
                  (f"{who} decrypts a test-key package", who, "POST", "/api/crypto/decrypt", {"package": tpk}, tst)]
    for who, ok in (("admin", True), ("operator", False), ("viewer", False), ("anonymous", False)):
        cases.append((f"{who} creates a key", who, "POST", "/api/keys", {"name": f"matrix-c-{who}", "purpose": "standard"}, ok))
    for who, ok in (("admin", True), ("operator", True), ("viewer", True), ("anonymous", False)):
        cases.append((f"{who} lists keys", who, "GET", "/api/keys", None, ok))
    for who, ok in (("admin", True), ("operator", False), ("viewer", False), ("anonymous", False)):
        cases += [(f"{who} reads the audit log", who, "GET", "/api/audit", None, ok),
                  (f"{who} lists users", who, "GET", "/api/users", None, ok),
                  (f"{who} lists backups", who, "GET", "/api/backups", None, ok),
                  (f"{who} unlocks the vault", who, "POST", "/api/vault/unlock", {"passphrase": PW}, ok)]
    for who, ok in (("admin", True), ("operator", True), ("viewer", True), ("anonymous", False)):
        cases.append((f"{who} exports a report", who, "GET", "/api/reports/export?format=csv", None, ok))
    cases += [("operator encrypts with a revoked key", "operator", "POST", "/api/crypto/encrypt", {"key_id": fx["legacy-api"], "data": "m"}, False),
              ("operator encrypts with an expired key", "operator", "POST", "/api/crypto/encrypt", {"key_id": fx["archive-2026"], "data": "m"}, False),
              ("operator encrypts with a missing key", "operator", "POST", "/api/crypto/encrypt", {"key_id": 99999, "data": "m"}, False),
              ("operator sends an oversized payload", "operator", "POST", "/api/crypto/encrypt", {"key_id": 2, "data": "A" * 70000}, False),
              ("operator sends a malformed package", "operator", "POST", "/api/crypto/decrypt", {"package": "kc1.not.a.package"}, False),
              ("operator decrypts a tampered package", "operator", "POST", "/api/crypto/decrypt", {"package": env.fix["altered_ciphertext"]}, False),
              ("operator decrypts a valid old-version package", "operator", "POST", "/api/crypto/decrypt", {"package": env.fix["retired_version_package"]}, True)]
    rows = []
    for label, who, method, path, body, should in cases:
        cl = c[who]
        resp = cl.get(path) if method == "GET" else cl.post(path, json=body)
        allowed = resp.status_code < 400
        rows.append(dict(case=label, expected="allow" if should else "deny", actual="allow" if allowed else "deny",
                         status=resp.status_code, correct=allowed == should))
    tp = sum(r["expected"] == "allow" and r["actual"] == "allow" for r in rows)
    tn = sum(r["expected"] == "deny" and r["actual"] == "deny" for r in rows)
    fp = sum(r["expected"] == "deny" and r["actual"] == "allow" for r in rows)
    fn = sum(r["expected"] == "allow" and r["actual"] == "deny" for r in rows)
    return rows, dict(total=len(rows), true_allow=tp, true_deny=tn, false_positives=fp, false_negatives=fn,
                      accuracy=round((tp + tn) / len(rows) * 100, 1))


def latency(env):
    post(env.admin, "/api/vault/unlock", {"passphrase": PW})
    r = env.admin.patch("/api/settings/rate_limit_per_minute", json={"value": 300})   # traceable, permitted setting
    assert r.status_code == 200
    ops = {"login": [], "vault unlock": [], "encrypt (allowed)": [], "decrypt (allowed)": [],
           "denied decision (viewer encrypt)": [], "list keys": [], "audit verify": []}

    def timed(bucket, fn):
        t = time.perf_counter()
        resp = fn()
        ops[bucket].append((time.perf_counter() - t) * 1000)
        return resp

    for _ in range(10):
        timed("login", lambda: TestClient(env.app).post("/api/auth/login", json={"username": "viewer", "password": PW}))
    for _ in range(3):
        timed("vault unlock", lambda: post(env.admin, "/api/vault/unlock", {"passphrase": PW}))
    pkg = None
    for i in range(100):
        r = timed("encrypt (allowed)", lambda: post(env.op, "/api/crypto/encrypt", {"key_id": 2, "data": f"latency probe {i}"}))
        pkg = r.json()["data"]["package"]
    for _ in range(100):
        timed("decrypt (allowed)", lambda: post(env.op, "/api/crypto/decrypt", {"package": pkg}))
    for _ in range(100):
        timed("denied decision (viewer encrypt)", lambda: post(env.viewer, "/api/crypto/encrypt", {"key_id": 2, "data": "x"}))
    for _ in range(100):
        timed("list keys", lambda: env.op.get("/api/keys"))
    entries = sqlite3.connect(env.db).execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
    for _ in range(10):
        timed("audit verify", lambda: post(env.admin, "/api/audit/verify", {}))
    con = sqlite3.connect(env.db)
    server = {a: [x[0] for x in con.execute("SELECT duration_ms FROM audit_events WHERE action=? AND outcome='success'", (a,))]
              for a in ("encrypt", "decrypt")}
    table = []
    for name, vals in ops.items():
        table.append(dict(operation=name, n=len(vals), p50=round(pct(vals, .5), 1), p95=round(pct(vals, .95), 1),
                          p99=round(pct(vals, .99), 1), max=round(max(vals), 1), mean=round(statistics.mean(vals), 1)))
    return table, dict(audit_entries_at_verify=entries,
                       server_side_ms={k: dict(n=len(v), max=max(v), mean=round(statistics.mean(v), 2)) for k, v in server.items()})


def threshold_demo(env):
    out = []
    big = "A" * 2048

    def attempt(label):
        r = post(env.op, "/api/crypto/encrypt", {"key_id": 2, "data": big})
        body = r.json()
        res = body.get("result") or {}
        out.append(dict(label=label, http=r.status_code, code=(body.get("code") or (res.get("reason") or {}).get("code")),
                        rule=res.get("rule"), thresholds=res.get("thresholds"), audit_entry=entry_of(r)))

    attempt("1. 2 KiB payload, default limit 64 KiB")
    r = env.admin.patch("/api/settings/max_data_kib", json={"value": 1})
    out.append(dict(label="2. admin lowers max_data_kib from 64 to 1", http=r.status_code, setting=r.json()))
    attempt("3. SAME 2 KiB payload, limit now 1 KiB")
    r = env.admin.patch("/api/settings/max_data_kib", json={"value": 64})
    out.append(dict(label="4. admin restores max_data_kib to 64", http=r.status_code, setting=r.json()))
    attempt("5. SAME payload again")
    con = sqlite3.connect(env.db)
    con.row_factory = sqlite3.Row
    changes = [dict(entry=r["entry_no"], user=r["user"], details=json.loads(r["details"]))
               for r in con.execute("SELECT * FROM audit_events WHERE action='setting_change' AND target='max_data_kib'")]
    return out, changes


# --------------------------------------------------------------------------- report
def render(meta, matrix_rows, matrix, lat, lat_extra, demo, changes):
    cases = {}
    for s in STEPS:
        cases.setdefault(s["case"], []).append(s)
    titles = {"T1": "Wrong passphrase", "T2": "Unauthorised use", "T3": "Rotation compatibility",
              "T4": "Expired or revoked keys", "T5": "Audit tampering", "T6": "Recovery procedures",
              "T-final": "Malformed / oversized input, unauthorised request, repeated submission, safe failure, restart"}
    passed = sum(s["passed"] for s in STEPS)
    md = [f"# KeyCycle evidence report\n",
          f"Generated {meta['generated']} on {meta['platform']} with {meta['kdf']}. All data is synthetic; "
          "every run uses temporary databases.\n",
          f"**Result: {passed} of {len(STEPS)} evaluation steps passed.**\n"]
    md.append("| Case | Title | Steps | Passed |\n|---|---|---|---|")
    for k, v in cases.items():
        md.append(f"| {k} | {titles[k]} | {len(v)} | {sum(x['passed'] for x in v)} |")
    for k, v in cases.items():
        md.append(f"\n## {k}: {titles[k]}\n")
        md.append("| # | Step | Input | Expected | Actual | Evidence | Result |\n|---|---|---|---|---|---|---|")
        for i, s in enumerate(v, 1):
            esc = lambda t: str(t).replace("|", "\\|").replace("\n", " ")
            md.append(f"| {k}.{i} | {esc(s['step'])} | {esc(s['input'])} | {esc(s['expected'])} | {esc(s['actual'])} | "
                      f"{esc(s['evidence'])} | {'PASS' if s['passed'] else '**FAIL**'} |")
    md.append("\n## Decision matrix (false positives and false negatives)\n")
    md.append(f"{matrix['total']} requests with a known correct outcome. **False positives** (allowed but should be denied): "
              f"**{matrix['false_positives']}**. **False negatives** (denied but should be allowed): **{matrix['false_negatives']}**. "
              f"Accuracy {matrix['accuracy']}% ({matrix['true_allow']} correct allows, {matrix['true_deny']} correct denials).\n")
    md.append("| Request | Expected | Actual | HTTP | Correct |\n|---|---|---|---|---|")
    for r in matrix_rows:
        md.append(f"| {r['case']} | {r['expected']} | {r['actual']} | {r['status']} | {'yes' if r['correct'] else '**NO**'} |")
    md.append("\n## Decision latency\n")
    md.append(f"Measured in-process through the full HTTP stack (validation, authorisation, Argon2/AES, database, audit write) "
              f"with {meta['kdf']}. The audit log held {lat_extra['audit_entries_at_verify']} entries when the chain was verified. "
              "The per-minute rate limit was raised to 300 for this measurement (a permitted, audited setting).\n")
    md.append("| Operation | n | mean ms | p50 ms | p95 ms | p99 ms | max ms |\n|---|---|---|---|---|---|---|")
    for r in lat:
        md.append(f"| {r['operation']} | {r['n']} | {r['mean']} | {r['p50']} | {r['p95']} | {r['p99']} | {r['max']} |")
    md.append("\nServer-side `duration_ms` stored in the audit log: " + "; ".join(
        f"{k}: n={v['n']}, mean {v['mean']} ms, max {v['max']} ms" for k, v in lat_extra["server_side_ms"].items()) + ".\n")
    md.append("\n## Configuration-change demonstration (traceable threshold change)\n")
    md.append("| Step | HTTP | Outcome | Rule (version) | Threshold in force | Audit entry |\n|---|---|---|---|---|---|")
    for d in demo:
        if "setting" in d:
            md.append(f"| {d['label']} | {d['http']} | setting changed | - | - | see below |")
        else:
            rule = d["rule"] or {}
            th = json.dumps(d["thresholds"]) if d["thresholds"] else "-"
            md.append(f"| {d['label']} | {d['http']} | {d['code']} | {rule.get('name', '-')} (v{rule.get('version', '-')}) | {th} | #{d['audit_entry']} |")
    md.append("\nAudit entries recording the configuration change:\n")
    for c in changes:
        md.append(f"- entry #{c['entry']} by {c['user']}: {json.dumps(c['details'])}")
    return "\n".join(md) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "evidence"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    kdf = "FAST (weak) key derivation - latency not representative" if args.fast else "production Argon2id settings (64 MiB, 3 passes, 4 lanes)"
    t1()
    t5()
    env = build_main()
    t2(env)
    t3(env)
    t4(env)
    t6(env)
    t_final(env)
    env.close()
    env = build_main()
    rows, matrix = decision_matrix(env)
    env.close()
    env = build_main()
    lat, extra = latency(env)
    demo, changes = threshold_demo(env)
    con = sqlite3.connect(env.db)
    con.row_factory = sqlite3.Row
    chain = audit.verify(con)
    con.close()
    env.close()
    meta = dict(generated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), platform=sys.platform, kdf=kdf,
                final_chain_valid=chain["valid"])
    (out / "evidence.json").write_text(json.dumps(dict(meta=meta, steps=STEPS, decision_matrix=dict(summary=matrix, cases=rows),
                                                        latency=lat, latency_extra=extra, threshold_demo=demo,
                                                        setting_change_entries=changes), indent=2))
    (out / "evidence_report.md").write_text(render(meta, rows, matrix, lat, extra, demo, changes))
    failed = [s for s in STEPS if not s["passed"]]
    print(f"{len(STEPS) - len(failed)}/{len(STEPS)} evaluation steps passed; matrix FP={matrix['false_positives']} "
          f"FN={matrix['false_negatives']} accuracy={matrix['accuracy']}%")
    for s in failed:
        print("FAILED:", s["case"], s["step"], "->", s["actual"])
    print(f"Report: {out / 'evidence_report.md'}")
    return 1 if failed or matrix["false_positives"] or matrix["false_negatives"] else 0


if __name__ == "__main__":
    sys.exit(main())
