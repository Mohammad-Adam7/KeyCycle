import json
import sqlite3
import threading

from fastapi.testclient import TestClient

from app import audit
from app.main import create_app
from app.maintenance import MaintenanceBarrier
from conftest import ADMIN_PW, PASSPHRASE
from scripts.recover_backup import recover


def confirmation(client, action, **extra):
    response = client.post("/api/confirmations", json={"action": action, **extra})
    assert response.status_code == 201, response.text
    return response.json()["data"]["confirmation_token"]


def prepared(admin):
    assert admin.client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE}).status_code == 200
    password = admin.make_user("op1", "operator")
    operator = admin.as_user("op1", password)
    response = admin.client.post("/api/keys", json={"name": "recovery-key", "purpose": "standard"})
    assert response.status_code == 201, response.text
    key_id = response.json()["data"]["id"]
    response = operator.post("/api/crypto/encrypt", json={"key_id": key_id,
                                                           "data": "recovery proof text"})
    assert response.status_code == 200, response.text
    return operator, key_id, response.json()["data"]["package"]


def test_audit_chain_is_canonical_linked_and_append_only(admin):
    with admin.db() as conn:
        rows = conn.execute("SELECT * FROM audit_events ORDER BY entry_no").fetchall()
        assert rows[0]["prev_hash"] == audit.GENESIS_HASH
        assert all(row["hash"] == audit.calculate_hash(row) for row in rows)
        assert all(rows[index]["prev_hash"] == rows[index - 1]["hash"]
                   for index in range(1, len(rows)))
        assert audit.verify(conn)["valid"] is True
        try:
            conn.execute("UPDATE audit_events SET action='altered' WHERE entry_no=1")
        except sqlite3.IntegrityError as error:
            assert "append-only" in str(error)
        else:
            raise AssertionError("audit update unexpectedly succeeded")


def test_verifier_reports_first_tampered_entry_and_critical_event(admin):
    with admin.db() as conn:
        conn.execute("DROP TRIGGER audit_no_update")
        conn.execute("UPDATE audit_events SET action='altered' WHERE entry_no=1")
        conn.commit()
    response = admin.client.post("/api/audit/verify", json={})
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "TAMPER_DETECTED"
    assert response.json()["result"]["first_mismatch"] == 1
    with admin.db() as conn:
        event = conn.execute("SELECT * FROM audit_events ORDER BY entry_no DESC LIMIT 1").fetchone()
        assert event["action"] == "audit_verify"
        assert event["severity"] == "critical"


def test_backup_verify_detects_semantic_tampering(admin):
    prepared(admin)
    token = confirmation(admin.client, "backup")
    response = admin.client.post("/api/backups", json={"confirmation_token": token})
    assert response.status_code == 201, response.text
    name = response.json()["data"]["name"]
    assert admin.client.post(f"/api/backups/{name}/verify").status_code == 200
    path = admin.app.state.backup_store._path(name)
    envelope = json.loads(path.read_text(encoding="utf-8"))
    envelope["content"]["tables"]["users"][0]["role"] = "viewer"
    path.write_text(json.dumps(envelope), encoding="utf-8")
    response = admin.client.post(f"/api/backups/{name}/verify")
    assert response.status_code == 422
    assert response.json()["code"] == "BACKUP_INVALID"


def test_restore_locks_vault_clears_sessions_and_preserves_old_ciphertext(admin):
    operator, key_id, package = prepared(admin)
    token = confirmation(admin.client, "backup")
    created = admin.client.post("/api/backups", json={"confirmation_token": token})
    assert created.status_code == 201, created.text
    name = created.json()["data"]["name"]

    admin.client.patch("/api/settings/rotation_days", json={"value": 7})
    token = confirmation(admin.client, "restore", backup_name=name)
    restored = admin.client.post(f"/api/backups/{name}/restore",
                                 json={"confirmation_token": token, "passphrase": PASSPHRASE})
    assert restored.status_code == 200, restored.text
    assert restored.json()["data"]["vault"] == "locked"
    assert admin.client.get("/api/auth/session").status_code == 401
    assert operator.get("/api/auth/session").status_code == 401

    restarted = TestClient(create_app(admin.path), raise_server_exceptions=False)
    response = restarted.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PW})
    assert response.status_code == 200, response.text
    restarted.headers["x-csrf-token"] = response.json()["csrf_token"]
    assert restarted.post("/api/vault/unlock", json={"passphrase": PASSPHRASE}).status_code == 200
    response = restarted.post("/api/auth/login", json={"username": "op1",
                                                        "password": "user-password-123"})
    assert response.status_code == 200, response.text
    restarted.headers["x-csrf-token"] = response.json()["csrf_token"]
    decrypted = restarted.post("/api/crypto/decrypt", json={"package": package})
    assert decrypted.status_code == 200, decrypted.text
    assert decrypted.json()["data"]["plaintext"] == "recovery proof text"
    assert restarted.get(f"/api/keys/{key_id}").status_code == 200


def test_recovery_drill_authenticates_chain_and_proves_decryption(admin):
    prepared(admin)
    token = confirmation(admin.client, "backup")
    created = admin.client.post("/api/backups", json={"confirmation_token": token})
    name = created.json()["data"]["name"]
    token = confirmation(admin.client, "recovery_drill", backup_name=name)
    response = admin.client.post("/api/recovery-drill", json={
        "confirmation_token": token, "passphrase": PASSPHRASE, "backup_name": name,
    })
    assert response.status_code == 200, response.text
    assert all(step["passed"] for step in response.json()["data"]["steps"])


def test_offline_disaster_recovery_rebuilds_a_lost_database(admin, tmp_path):
    _operator, _key_id, package = prepared(admin)
    token = confirmation(admin.client, "backup")
    created = admin.client.post("/api/backups", json={"confirmation_token": token})
    name = created.json()["data"]["name"]
    target = tmp_path / "recovered.db"
    result = recover(target, name, PASSPHRASE)
    assert result["chain_head"]["entry_count"] > 0

    client = TestClient(create_app(str(target)), raise_server_exceptions=False)
    response = client.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PW})
    client.headers["x-csrf-token"] = response.json()["csrf_token"]
    assert client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE}).status_code == 200
    response = client.post("/api/auth/login", json={"username": "op1",
                                                     "password": "user-password-123"})
    client.headers["x-csrf-token"] = response.json()["csrf_token"]
    response = client.post("/api/crypto/decrypt", json={"package": package})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["plaintext"] == "recovery proof text"


def test_restore_maintenance_barrier_waits_for_requests_and_blocks_new_ones():
    barrier = MaintenanceBarrier()
    barrier.enter(False)
    exclusive_entered = threading.Event()
    release_exclusive = threading.Event()

    def restore_request():
        barrier.enter(True)
        exclusive_entered.set()
        release_exclusive.wait(5)
        barrier.leave(True)

    restore = threading.Thread(target=restore_request)
    restore.start()
    assert not exclusive_entered.wait(0.05)
    barrier.leave(False)
    assert exclusive_entered.wait(1)

    ordinary_entered = threading.Event()

    def ordinary_request():
        barrier.enter(False)
        ordinary_entered.set()
        barrier.leave(False)

    ordinary = threading.Thread(target=ordinary_request)
    ordinary.start()
    assert not ordinary_entered.wait(0.05)
    release_exclusive.set()
    restore.join(1)
    ordinary.join(1)
    assert ordinary_entered.is_set()
