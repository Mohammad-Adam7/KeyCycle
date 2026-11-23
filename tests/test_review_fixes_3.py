"""Regression tests: anonymous audit flooding (#5) and oversized KDF parameters in a backup (#8)."""
import sqlite3

import pytest
from starlette.testclient import TestClient

from app import backup
from app.config import (ANON_DENIED_AUDIT_PER_MINUTE, ANON_FAILED_LOGIN_AUDIT_PER_MINUTE,
                        KDF_CEILING)
from app.main import create_app
from app.security import AuditBudget
from scripts.seed_demo import seed

PW = "EvalPassphrase123!"


def _rows(db, where="1=1"):
    c = sqlite3.connect(db)
    return c.execute(f"SELECT COUNT(*) FROM audit_events WHERE {where}").fetchone()[0]


def test_budget_unit_behaviour():
    b = AuditBudget(window=60)
    verdicts = [b.admit("x", 3)[0] for _ in range(6)]
    assert verdicts == ["write", "write", "write", "summary", "skip", "skip"]
    assert b.admit("other", 3)[0] == "write"  # buckets are independent


def test_budget_reports_suppressed_count_in_next_window():
    b = AuditBudget(window=0.05)
    [b.admit("x", 1) for _ in range(4)]            # 1 written, 3 suppressed
    import time
    time.sleep(0.06)
    assert b.admit("x", 1) == ("write", 3)


def test_unknown_username_flood_cannot_grow_audit_without_bound(tmp_path):
    db = str(tmp_path / "f.db")
    seed(db, PW, PW)
    app = create_app(db)
    before = _rows(db)
    # Rotate clients so the per-address login throttle never engages.
    for i in range(ANON_FAILED_LOGIN_AUDIT_PER_MINUTE + 40):
        c = TestClient(app, raise_server_exceptions=False, client=(f"10.0.{i // 250}.{i % 250 + 1}", 5000))
        assert c.post("/api/auth/login", json={"username": f"ghost{i}", "password": "x"}).status_code == 401
    added = _rows(db) - before
    assert added <= ANON_FAILED_LOGIN_AUDIT_PER_MINUTE + 1          # budget + one summary row
    assert _rows(db, "reason='AUDIT_SUPPRESSED'") == 1


def test_real_user_failures_and_successes_are_still_audited(tmp_path):
    db = str(tmp_path / "r.db")
    seed(db, PW, PW)
    app = create_app(db)
    c = TestClient(app, raise_server_exceptions=False)
    r = c.post("/api/auth/login", json={"username": "admin", "password": "wrong-password"})
    assert r.status_code == 401 and r.json()["audit_entry"] is not None
    assert c.post("/api/auth/login", json={"username": "admin", "password": PW}).status_code == 200
    assert _rows(db, "action='login' AND outcome='success'") == 1


def test_closed_setup_probe_spam_is_budgeted(tmp_path):
    db = str(tmp_path / "s.db")
    seed(db, PW, PW)
    app = create_app(db)
    before = _rows(db)
    body = {"username": "evil", "password": "password-number-1", "vault_passphrase": "passphrase-number-1"}
    for _ in range(ANON_DENIED_AUDIT_PER_MINUTE + 25):
        assert TestClient(app, raise_server_exceptions=False).post("/api/setup", json=body).status_code == 404
    assert _rows(db) - before <= ANON_DENIED_AUDIT_PER_MINUTE + 1


@pytest.fixture
def backup_content(tmp_path):
    db = str(tmp_path / "b.db")
    seed(db, PW, PW)
    app = create_app(db)
    c = TestClient(app)
    csrf = c.post("/api/auth/login", json={"username": "admin", "password": PW}).json()["csrf_token"]
    c.headers["X-CSRF-Token"] = csrf
    c.post("/api/vault/unlock", json={"passphrase": PW})
    token = c.post("/api/confirmations", json={"action": "backup"}).json()["data"]["confirmation_token"]
    name = c.post("/api/backups", json={"confirmation_token": token}).json()["data"]["name"]
    return backup.parse(app.state.backup_store.read(name))["content"]


@pytest.mark.parametrize("field,value", [("time_cost", 10), ("memory_cost", 1024 * 1024), ("parallelism", 16),
                                         ("memory_cost", KDF_CEILING["memory_cost"] + 1)])
def test_backup_cannot_demand_excessive_kdf_work(backup_content, monkeypatch, field, value):
    backup_content["tables"]["vault"][0][field] = value
    monkeypatch.setattr(backup, "derive", lambda *a, **k: pytest.fail("Argon2 must not run for oversized parameters"))
    with pytest.raises(backup.BackupInvalid):
        backup.key_from_passphrase(backup_content, PW)


def test_backup_with_normal_kdf_parameters_still_works(backup_content):
    assert len(backup.key_from_passphrase(backup_content, PW)) == 32
