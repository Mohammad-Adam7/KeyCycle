"""Regression tests for the minor fixes: password change, failure decay, CSP, UI escaping,
tamper-evidence copy on restore, backup folder permissions, split requirements."""
import os
import re
import sqlite3
import stat
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from app.main import create_app
from scripts.seed_demo import seed

PW = "EvalPassphrase123!"
NEW = "A-brand-new-password-42"
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def env(tmp_path):
    db = str(tmp_path / "m.db")
    seed(db, PW, PW)
    return db, create_app(db)


def client(app, user="operator1", password=PW):
    c = TestClient(app, raise_server_exceptions=False)
    r = c.post("/api/auth/login", json={"username": user, "password": password})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def test_password_change_ends_other_sessions_and_rotates_credentials(env):
    db, app = env
    a, b = client(app), client(app)
    r = a.post("/api/auth/password", json={"current_password": PW, "new_password": NEW})
    assert r.status_code == 200 and r.json()["other_sessions_ended"] == 1
    assert a.get("/api/auth/session").status_code == 200          # this session continues
    assert b.get("/api/auth/session").status_code == 401           # the other one ended
    assert TestClient(app).post("/api/auth/login", json={"username": "operator1", "password": PW}).status_code == 401
    client(app, password=NEW)
    raw = sqlite3.connect(db).execute("SELECT group_concat(details || reason) FROM audit_events").fetchone()[0]
    assert NEW not in raw and PW not in raw
    ok = sqlite3.connect(db).execute("SELECT COUNT(*) FROM audit_events WHERE action='password_change' AND outcome='success'").fetchone()[0]
    assert ok == 1


def test_password_change_rejects_bad_input_and_throttles_guessing(env):
    _db, app = env
    c = client(app, "viewer")
    assert c.post("/api/auth/password", json={"current_password": PW, "new_password": "short"}).status_code == 400
    assert c.post("/api/auth/password", json={"current_password": PW, "new_password": PW}).status_code == 400
    for _ in range(5):
        r = c.post("/api/auth/password", json={"current_password": "wrong-guess", "new_password": NEW})
        assert r.status_code == 403 and r.json()["code"] == "PASSWORD_INVALID"
    assert c.get("/api/auth/session").status_code == 200           # a wrong guess does not end the session
    r = c.post("/api/auth/password", json={"current_password": PW, "new_password": NEW})
    assert r.status_code == 429 and r.json()["code"] == "TOO_MANY_ATTEMPTS"


def test_password_change_requires_csrf_token(env):
    _db, app = env
    c = TestClient(app, raise_server_exceptions=False)
    c.post("/api/auth/login", json={"username": "viewer", "password": PW})   # no X-CSRF-Token header kept
    r = c.post("/api/auth/password", json={"current_password": PW, "new_password": NEW})
    assert r.status_code == 403 and r.json()["code"] == "CSRF_INVALID"


def test_old_failed_logins_decay_instead_of_adding_up(env):
    db, app = env
    c = TestClient(app, raise_server_exceptions=False)
    for _ in range(4):
        c.post("/api/auth/login", json={"username": "viewer", "password": "wrong"})
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT failed_count FROM users WHERE username='viewer'").fetchone()[0] == 4
    conn.execute("UPDATE failures SET updated_at=? WHERE key='loginwin:viewer'", (int(time.time()) - 7200,))
    conn.commit()
    r = c.post("/api/auth/login", json={"username": "viewer", "password": "wrong"})
    assert r.json()["code"] == "AUTH_FAILED"                         # not TOO_MANY_ATTEMPTS
    row = conn.execute("SELECT failed_count, locked_until FROM users WHERE username='viewer'").fetchone()
    assert row == (1, 0)
    assert c.post("/api/auth/login", json={"username": "viewer", "password": PW}).status_code == 200


def test_recent_failures_still_lock_the_account(env):
    _db, app = env
    c = TestClient(app, raise_server_exceptions=False)
    codes = [c.post("/api/auth/login", json={"username": "viewer", "password": "wrong"}).json()["code"] for _ in range(6)]
    assert codes[-1] == "TOO_MANY_ATTEMPTS"


def test_csp_blocks_scripts_but_permits_inline_style_attributes(env):
    _db, app = env
    csp = TestClient(app).get("/").headers["content-security-policy"]
    assert "default-src 'self'" in csp and "style-src-attr 'unsafe-inline'" in csp
    assert "script-src" not in csp and "'unsafe-eval'" not in csp
    assert not re.search(r"default-src[^;]*unsafe-inline", csp)


def test_backup_folder_is_owner_only(env):
    db, _app = env
    mode = stat.S_IMODE(os.stat(Path(db).parent / "backups").st_mode)
    assert mode == 0o700


def _admin_with_backup(app):
    a = client(app, "admin")
    a.post("/api/vault/unlock", json={"passphrase": PW})
    t = a.post("/api/confirmations", json={"action": "backup"}).json()["data"]["confirmation_token"]
    return a, a.post("/api/backups", json={"confirmation_token": t}).json()["data"]["name"]


def _restore(a, name):
    t = a.post("/api/confirmations", json={"action": "restore", "backup_name": name}).json()["data"]["confirmation_token"]
    return a.post(f"/api/backups/{name}/restore", json={"confirmation_token": t, "passphrase": PW})


def test_restore_over_a_tampered_log_keeps_an_owner_only_evidence_copy(env):
    db, app = env
    a, name = _admin_with_backup(app)
    c = sqlite3.connect(db)
    c.execute("DROP TRIGGER audit_no_update")
    c.execute("UPDATE audit_events SET reason='tampered' WHERE entry_no=2")
    c.commit()
    c.close()
    r = _restore(a, name)
    assert r.status_code == 200, r.text
    evidence = r.json()["data"]["evidence_copy"]
    folder = Path(db).parent / "evidence"
    path = folder / evidence
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600 and stat.S_IMODE(os.stat(folder).st_mode) == 0o700
    kept = sqlite3.connect(path).execute("SELECT reason FROM audit_events WHERE entry_no=2").fetchone()[0]
    assert kept == "tampered"                                          # the evidence survives
    live = sqlite3.connect(db).execute("SELECT reason FROM audit_events WHERE entry_no=2").fetchone()[0]
    assert live != "tampered"                                          # while the live log is healed


def test_no_evidence_copy_when_the_live_log_is_intact(env):
    db, app = env
    a, name = _admin_with_backup(app)
    r = _restore(a, name)
    assert r.status_code == 200 and "evidence_copy" not in r.json()["data"]
    assert not (Path(db).parent / "evidence").exists()


def test_every_server_value_in_the_ui_is_escaped():
    source = (ROOT / "app/static/app.js").read_text()
    offenders = []
    for m in re.finditer(r"\$\{([^}]*)\}", source):
        expr = m.group(1)
        if ".map(" in expr or "this.escape(" in expr or re.search(r"\.(disabled|passed) \?", expr):
            continue
        if re.search(r"\?\s*'[^']*'\s*:\s*'[^']*'\s*$", expr):    # picks between two fixed strings
            continue
        if re.search(r"\b(k|v|ev|u|step|b)\.[a-z_]+", expr) and "encodeURIComponent" not in expr:
            offenders.append(expr)
    assert offenders == []
    assert "str === null || str === undefined" in source            # 0 must render as "0", not ""


def test_requirements_are_split_into_runtime_and_development():
    runtime = (ROOT / "requirements.txt").read_text()
    dev = (ROOT / "requirements-dev.txt").read_text()
    assert "pytest" not in runtime and "httpx" not in runtime and "fastapi" in runtime
    assert "-r requirements.txt" in dev and "pytest" in dev and "httpx" in dev
