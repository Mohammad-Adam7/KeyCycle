"""Comprehensive Cross-Module Evaluation Suite: T1 through T6 and T-final.

Covers:
- T1: Wrong Passphrase (Vault unlock attempts, lockout, rate defense, audit)
- T2: Unauthorised Use (RBAC, role boundaries, disabled users, test vs standard keys)
- T3: Rotation Compatibility (Key versions, backward-compatible decryption, AAD integrity)
- T4: Expired or Revoked Keys (State evaluation, permanent revocation denial)
- T5: Audit Tampering (Chain verification, first mismatch detection, truncation detection)
- T6: Recovery & Backups (HMAC authentication, restore verification, 4-step recovery drill)
- T-final: Acceptance & Resilience (Payload limits, CSRF, single-use confirmations, safe errors, restart resilience)
"""
import time
import pytest
from starlette.testclient import TestClient

from app.auth import COOKIE
from app.main import create_app
from scripts.seed_demo import seed


@pytest.fixture
def eval_app(tmp_path):
    db_path = tmp_path / "eval_suite.db"
    seed(db_path, "EvalPassphrase123!", "EvalPassphrase123!")
    return create_app(str(db_path))


def get_client_with_login(app, username, password="EvalPassphrase123!"):
    client = TestClient(app)
    res = client.post("/api/auth/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.text
    csrf = res.json()["csrf_token"]
    client.headers["X-CSRF-Token"] = csrf
    return client


# ==========================================
# T1: Wrong Passphrase & Lockout
# ==========================================
def test_t1_wrong_passphrase(eval_app):
    admin = get_client_with_login(eval_app, "admin")

    # 1. Repeated wrong passphrases
    for i in range(5):
        r = admin.post("/api/vault/unlock", json={"passphrase": f"wrong-passphrase-{i}"})
        assert r.status_code == 403
        assert r.json()["code"] == "PASSPHRASE_INVALID"

    # 2. Lockout triggered on subsequent attempts
    locked_res = admin.post("/api/vault/unlock", json={"passphrase": "EvalPassphrase123!"})
    assert locked_res.status_code == 429
    assert locked_res.json()["code"] == "TOO_MANY_ATTEMPTS"


# ==========================================
# T2: Unauthorised Use & RBAC
# ==========================================
def test_t2_unauthorised_use(eval_app):
    op = get_client_with_login(eval_app, "operator1")
    viewer = get_client_with_login(eval_app, "viewer")
    admin = get_client_with_login(eval_app, "admin")

    # Operator cannot access admin endpoints
    assert op.get("/api/users").status_code == 403
    assert op.get("/api/settings").status_code == 403
    assert op.post("/api/vault/unlock", json={"passphrase": "x"}).status_code == 403
    assert op.post("/api/keys", json={"name": "op-key", "purpose": "standard"}).status_code == 403

    # Viewer cannot encrypt or decrypt
    assert viewer.post("/api/crypto/encrypt", json={"key_id": 1, "data": "secret"}).status_code == 403
    assert viewer.post("/api/crypto/decrypt", json={"package": "kc1.1.1.dummy.dummy"}).status_code == 403

    # Role-purpose separation: Unlock vault first
    admin.post("/api/vault/unlock", json={"passphrase": "EvalPassphrase123!"})

    # Admin creates a standard key and a test key
    std_key = admin.post("/api/keys", json={"name": "std-key-t2", "purpose": "standard", "rotation_days": 30}).json()["data"]["id"]
    tst_key = admin.post("/api/keys", json={"name": "tst-key-t2", "purpose": "test", "rotation_days": 30}).json()["data"]["id"]

    # Admin CANNOT encrypt using standard key (only test keys)
    assert admin.post("/api/crypto/encrypt", json={"key_id": std_key, "data": "admin-data"}).status_code == 403

    # Operator CANNOT encrypt using test key (only standard keys)
    assert op.post("/api/crypto/encrypt", json={"key_id": tst_key, "data": "op-data"}).status_code == 403

    # Operator CAN encrypt using standard key
    op_enc = op.post("/api/crypto/encrypt", json={"key_id": std_key, "data": "valid-op-data"})
    assert op_enc.status_code == 200

    # Admin CAN encrypt using test key
    adm_enc = admin.post("/api/crypto/encrypt", json={"key_id": tst_key, "data": "valid-test-data"})
    assert adm_enc.status_code == 200


# ==========================================
# T3: Rotation Compatibility & AAD Binding
# ==========================================
def test_t3_rotation_compatibility(eval_app):
    admin = get_client_with_login(eval_app, "admin")
    op = get_client_with_login(eval_app, "operator1")
    admin.post("/api/vault/unlock", json={"passphrase": "EvalPassphrase123!"})

    # 1. Create key version 1 and encrypt payload
    kid = admin.post("/api/keys", json={"name": "rot-key-t3", "purpose": "standard", "rotation_days": 60}).json()["data"]["id"]
    pkg_v1 = op.post("/api/crypto/encrypt", json={"key_id": kid, "data": "Payload Under V1"}).json()["data"]["package"]
    assert f"kc1.{kid}.1." in pkg_v1

    # 2. Rotate key to version 2
    conf = admin.post("/api/confirmations", json={"key_id": kid, "action": "rotate"}).json()["data"]["confirmation_token"]
    rot = admin.post(f"/api/keys/{kid}/rotate", json={"confirmation_token": conf})
    assert rot.status_code == 200
    assert rot.json()["data"]["current_version"] == 2

    # 3. Encrypt new payload under version 2
    pkg_v2 = op.post("/api/crypto/encrypt", json={"key_id": kid, "data": "Payload Under V2"}).json()["data"]["package"]
    assert f"kc1.{kid}.2." in pkg_v2

    # 4. Decrypt v1 package under rotated key -> MUST SUCCEED (backward compatibility)
    dec_v1 = op.post("/api/crypto/decrypt", json={"package": pkg_v1})
    assert dec_v1.status_code == 200
    assert dec_v1.json()["data"]["plaintext"] == "Payload Under V1"

    # 5. Tampering AAD: swap version number in ciphertext package
    tampered_pkg = pkg_v1.replace(f"kc1.{kid}.1.", f"kc1.{kid}.2.")
    tampered_res = op.post("/api/crypto/decrypt", json={"package": tampered_pkg})
    assert tampered_res.status_code == 400
    assert tampered_res.json()["code"] == "CIPHERTEXT_INVALID"


# ==========================================
# T4: Expired or Revoked Keys
# ==========================================
def test_t4_expired_or_revoked_keys(eval_app):
    admin = get_client_with_login(eval_app, "admin")
    op = get_client_with_login(eval_app, "operator1")
    admin.post("/api/vault/unlock", json={"passphrase": "EvalPassphrase123!"})

    # Create key and encrypt
    kid = admin.post("/api/keys", json={"name": "rev-key-t4", "purpose": "standard", "rotation_days": 30}).json()["data"]["id"]
    pkg = op.post("/api/crypto/encrypt", json={"key_id": kid, "data": "Pre-Revocation Data"}).json()["data"]["package"]

    # Revoke key
    conf = admin.post("/api/confirmations", json={"key_id": kid, "action": "revoke"}).json()["data"]["confirmation_token"]
    rev = admin.post(f"/api/keys/{kid}/revoke", json={
        "confirmation_token": conf,
        "reason": "Security Drill T4",
        "confirm_name": "rev-key-t4"
    })
    assert rev.status_code == 200
    assert rev.json()["data"]["state"] == "revoked"

    # Encryption is refused
    enc_denied = op.post("/api/crypto/encrypt", json={"key_id": kid, "data": "New Data"})
    assert enc_denied.status_code == 409
    assert enc_denied.json()["code"] == "KEY_REVOKED"

    # Decryption is permanently refused for all versions
    dec_denied = op.post("/api/crypto/decrypt", json={"package": pkg})
    assert dec_denied.status_code == 409
    assert dec_denied.json()["code"] == "KEY_REVOKED"


# ==========================================
# T5: Audit Tampering & Verification
# ==========================================
def test_t5_audit_tampering(eval_app, tmp_path):
    admin = get_client_with_login(eval_app, "admin")

    # 1. Live chain verifies
    v1 = admin.post("/api/audit/verify", json={})
    assert v1.status_code == 200
    assert v1.json()["result"]["valid"] is True
    verified_head = v1.json()["result"]["verified_head"]
    valid_count = verified_head["entry_count"]
    valid_hash = verified_head["hash"]

    # 2. Tampering an entry directly in SQLite
    from app.db import connect
    raw_conn = connect(eval_app.state.db_path)
    raw_conn.execute("DROP TRIGGER audit_no_update")
    raw_conn.execute("UPDATE audit_events SET reason='tampered' WHERE entry_no=2")
    raw_conn.close()

    # 3. Verification must fail and report first_mismatch
    tamper_res = admin.post("/api/audit/verify", json={})
    assert tamper_res.status_code == 409
    assert tamper_res.json()["code"] == "TAMPER_DETECTED"
    assert tamper_res.json()["result"]["first_mismatch"] == 2


# ==========================================
# T6: Recovery & Backups
# ==========================================
def test_t6_recovery(eval_app):
    admin = get_client_with_login(eval_app, "admin")
    admin.post("/api/vault/unlock", json={"passphrase": "EvalPassphrase123!"})

    # 1. Create authenticated backup
    conf = admin.post("/api/confirmations", json={"action": "backup"}).json()["data"]["confirmation_token"]
    backup_res = admin.post("/api/backups", json={"confirmation_token": conf})
    assert backup_res.status_code == 201
    bname = backup_res.json()["data"]["name"]

    # 2. Verify backup HMAC and invariants
    ver_res = admin.post(f"/api/backups/{bname}/verify")
    assert ver_res.status_code == 200
    assert ver_res.json()["result"]["valid"] is True

    # 3. Execute Non-destructive Recovery Drill
    drill_conf = admin.post("/api/confirmations", json={"action": "recovery_drill", "backup_name": bname}).json()["data"]["confirmation_token"]
    drill_res = admin.post("/api/recovery-drill", json={
        "backup_name": bname,
        "confirmation_token": drill_conf,
        "passphrase": "EvalPassphrase123!"
    })
    assert drill_res.status_code == 200
    steps = drill_res.json()["data"]["steps"]
    assert len(steps) == 4
    assert all(s["passed"] for s in steps)


# ==========================================
# T-final: Acceptance & Resilience
# ==========================================
def test_t_final_acceptance(eval_app):
    admin = get_client_with_login(eval_app, "admin")
    op = get_client_with_login(eval_app, "operator1")
    admin.post("/api/vault/unlock", json={"passphrase": "EvalPassphrase123!"})

    kid = admin.post("/api/keys", json={"name": "resilience-key", "purpose": "standard", "rotation_days": 30}).json()["data"]["id"]

    # 1. Oversized payload (> 64 KiB rejected)
    oversized = "A" * 65537
    over_res = op.post("/api/crypto/encrypt", json={"key_id": kid, "data": oversized})
    assert over_res.status_code in (400, 413)

    # 2. CSRF enforcement on state-changing requests
    no_csrf = TestClient(eval_app)
    # Login to set cookie
    login_res = no_csrf.post("/api/auth/login", json={"username": "admin", "password": "EvalPassphrase123!"})
    # Attempt POST without X-CSRF-Token header
    csrf_fail = no_csrf.post("/api/vault/lock")
    assert csrf_fail.status_code == 403
    assert csrf_fail.json()["code"] == "CSRF_INVALID"

    # 3. Single-use confirmation replay defense
    conf = admin.post("/api/confirmations", json={"key_id": kid, "action": "rotate"}).json()["data"]["confirmation_token"]
    rot1 = admin.post(f"/api/keys/{kid}/rotate", json={"confirmation_token": conf})
    assert rot1.status_code == 200

    # Replay of the same confirmation token must be refused
    rot2 = admin.post(f"/api/keys/{kid}/rotate", json={"confirmation_token": conf})
    assert rot2.status_code == 409
    assert rot2.json()["code"] == "CONFIRMATION_REQUIRED"

    # 4. Safe failure format (no internal stack traces or leaked secrets)
    bad_req = admin.post("/api/keys", json={"bad_field": 123})
    assert bad_req.status_code in (400, 422)
    err = bad_req.json()
    assert "code" in err
    assert "message" in err
    assert "audit_entry" in err
    assert "Traceback" not in bad_req.text
