import pytest

from app.vault import VaultLocked
from conftest import PASSPHRASE


def test_vault_is_locked_after_setup_and_after_restart(admin):
    assert admin.client.get("/api/vault/status").json() == {"locked": True}
    assert admin.client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE}).status_code == 200
    assert admin.client.get("/api/vault/status").json() == {"locked": False}
    from app.main import create_app
    assert create_app(admin.path).state.vault.unlocked is False


def test_T1_wrong_passphrase_keeps_vault_locked(admin):
    r = admin.client.post("/api/vault/unlock", json={"passphrase": "wrong passphrase here"})
    assert r.status_code == 403
    assert r.json()["code"] == "PASSPHRASE_INVALID" and r.json()["message"] == "Unlock failed."
    assert admin.client.get("/api/vault/status").json() == {"locked": True}
    assert admin.app.state.vault.unlocked is False
    with pytest.raises(VaultLocked):
        admin.app.state.vault.wrap(b"k" * 32)
    row = admin.db().execute("SELECT * FROM audit_events WHERE entry_no = ?", (r.json()["audit_entry"],)).fetchone()
    assert row["action"] == "vault_unlock" and row["outcome"] == "failure" and row["reason"] == "PASSPHRASE_INVALID"
    assert "wrong passphrase here" not in str(dict(row))


def test_T1_repeated_wrong_passphrases_lock_out_unlock_attempts(admin):
    for _ in range(5):
        assert admin.client.post("/api/vault/unlock", json={"passphrase": "bad passphrase!"}).json()["code"] == "PASSPHRASE_INVALID"
    r = admin.client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE})
    assert r.status_code == 429 and r.json()["code"] == "TOO_MANY_ATTEMPTS"
    assert admin.app.state.vault.unlocked is False


def test_unlock_wrap_unwrap_and_lock(admin):
    v = admin.app.state.vault
    admin.client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE})
    data_key = b"\x01" * 32
    nonce, ct = v.wrap(data_key, b"key-1:v1")
    assert ct != data_key and v.unwrap(nonce, ct, b"key-1:v1") == data_key
    with pytest.raises(Exception):
        v.unwrap(nonce, ct, b"key-2:v1")
    assert admin.client.post("/api/vault/lock").status_code == 200
    with pytest.raises(VaultLocked):
        v.unwrap(nonce, ct, b"key-1:v1")
    admin.client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE})
    assert v.unwrap(nonce, ct, b"key-1:v1") == data_key


def test_vault_record_holds_no_key_material_or_passphrase(admin):
    row = admin.db().execute("SELECT * FROM vault").fetchone()
    blob = b"".join(bytes(v) if isinstance(v, (bytes, bytearray)) else str(v).encode() for v in dict(row).values())
    assert PASSPHRASE.encode() not in blob
    assert admin.db().execute("SELECT COUNT(*) FROM key_versions").fetchone()[0] == 0


def test_audit_log_is_append_only(admin):
    db = admin.db()
    assert db.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0] > 0
    with pytest.raises(Exception, match="append-only"):
        db.execute("UPDATE audit_events SET outcome = 'success'")
    with pytest.raises(Exception, match="append-only"):
        db.execute("DELETE FROM audit_events")


def test_secrets_never_appear_in_the_audit_log(admin):
    admin.client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE})
    admin.login("admin", "bad-password-attempt", admin.new_client())
    dump = str([dict(r) for r in admin.db().execute("SELECT * FROM audit_events")])
    for secret in (PASSPHRASE, "bad-password-attempt", "admin-password-123"):
        assert secret not in dump
