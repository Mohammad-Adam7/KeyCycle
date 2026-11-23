"""Regression tests for the setup race and the restore-rolls-back-revocations flaw."""
import sqlite3
import threading

from starlette.testclient import TestClient

from app.main import create_app
from scripts.seed_demo import seed

PW = "EvalPassphrase123!"


def login(app, username):
    client = TestClient(app, raise_server_exceptions=False)
    r = client.post("/api/auth/login", json={"username": username, "password": PW})
    assert r.status_code == 200, r.text
    client.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return client


def test_concurrent_setup_creates_exactly_one_admin(tmp_path):
    db = str(tmp_path / "race.db")
    app = create_app(db)
    codes = []

    def attempt(i):
        c = TestClient(app, raise_server_exceptions=False)
        codes.append(c.post("/api/setup", json={"username": f"admin{i}", "password": "password-number-1",
                                                "vault_passphrase": "passphrase-number-1"}).status_code)

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    conn = sqlite3.connect(db)
    assert codes.count(201) == 1
    assert 500 not in codes
    assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM vault").fetchone()[0] == 1


def _backup(admin):
    token = admin.post("/api/confirmations", json={"action": "backup"}).json()["data"]["confirmation_token"]
    return admin.post("/api/backups", json={"confirmation_token": token}).json()["data"]["name"]


def _restore(admin, name):
    token = admin.post("/api/confirmations", json={"action": "restore", "backup_name": name}).json()["data"]["confirmation_token"]
    return admin.post(f"/api/backups/{name}/restore", json={"confirmation_token": token, "passphrase": PW})


def test_restore_does_not_unrevoke_keys_or_reenable_users(tmp_path):
    db = str(tmp_path / "restore.db")
    seed(db, PW, PW)
    app = create_app(db)
    admin = login(app, "admin")
    assert admin.post("/api/vault/unlock", json={"passphrase": PW}).status_code == 200
    name = _backup(admin)

    # After the backup: revoke finance-key (id 2) and disable the viewer.
    token = admin.post("/api/confirmations", json={"action": "revoke", "key_id": 2}).json()["data"]["confirmation_token"]
    assert admin.post("/api/keys/2/revoke", json={"confirmation_token": token, "confirm_name": "finance-key",
                                                  "reason": "compromised"}).status_code == 200
    viewer_id = next(u["id"] for u in admin.get("/api/users").json() if u["username"] == "viewer")
    assert admin.patch(f"/api/users/{viewer_id}", json={"disabled": True}).status_code == 200

    r = _restore(admin, name)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["revocations_preserved"] == 1
    assert r.json()["data"]["user_restrictions_preserved"] >= 1

    admin = login(app, "admin")
    admin.post("/api/vault/unlock", json={"passphrase": PW})
    op = login(app, "operator1")
    enc = op.post("/api/crypto/encrypt", json={"key_id": 2, "data": "x"})
    assert enc.status_code == 409 and enc.json()["code"] == "KEY_REVOKED"
    assert TestClient(app).post("/api/auth/login", json={"username": "viewer", "password": PW}).status_code == 401


def test_restore_never_leaves_zero_active_admins(tmp_path):
    from app import backup as b
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, disabled INTEGER)")
    conn.execute("CREATE TABLE keys(id INTEGER PRIMARY KEY, name TEXT, state TEXT, revoked_at INT, revoke_reason TEXT)")
    # Backup state restored into the table: the only admin is enabled.
    conn.execute("INSERT INTO users VALUES (1,'alice','administrator',0)")
    # Live state said alice was disabled (another admin existed live, but is not in the backup).
    live = {"revoked": [], "users": [(1, "alice", "administrator", 1)]}
    out = b._reapply_restrictions(conn, live)
    assert out["user_restrictions_applied"] is False
    assert conn.execute("SELECT disabled FROM users WHERE id=1").fetchone()[0] == 0
