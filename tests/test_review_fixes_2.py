"""Regression tests: audit anchoring (truncation / re-hash) and CSV formula injection."""
import sqlite3

import pytest
from starlette.testclient import TestClient

from app import audit
from app.main import create_app
from app.reports import format_csv_report
from scripts.seed_demo import seed

PW = "EvalPassphrase123!"


def login(app, username):
    client = TestClient(app, raise_server_exceptions=False)
    r = client.post("/api/auth/login", json={"username": username, "password": PW})
    assert r.status_code == 200, r.text
    client.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return client


@pytest.fixture
def env(tmp_path):
    db = str(tmp_path / "a.db")
    seed(db, PW, PW)
    app = create_app(db)
    return db, app, login(app, "admin")


def _drop_triggers(db):
    c = sqlite3.connect(db)
    for t in ("audit_no_update", "audit_no_delete", "audit_chain_previous"):
        c.execute(f"DROP TRIGGER IF EXISTS {t}")
    return c


def _verify(admin, **body):
    return admin.post("/api/audit/verify", json=body)


def test_anchor_accepts_a_growing_valid_chain(env):
    _db, _app, admin = env
    head = _verify(admin).json()["result"]["verified_head"]
    admin.get("/api/audit")  # more activity
    admin.post("/api/auth/login", json={"username": "ghost", "password": "x"})
    r = _verify(admin, anchor_count=head["entry_count"], anchor_hash=head["hash"])
    assert r.status_code == 200 and r.json()["result"]["anchors_checked"][0]["source"] == "client"


def test_anchor_detects_tail_truncation(env):
    db, _app, admin = env
    head = _verify(admin).json()["result"]["verified_head"]
    for _ in range(3):
        admin.post("/api/auth/login", json={"username": "ghost", "password": "x"})
    c = _drop_triggers(db)
    c.execute("DELETE FROM audit_events WHERE entry_no > ?", (head["entry_count"] - 2,))
    c.commit()
    assert _verify(admin).status_code == 200  # an unanchored check is blind to this ...
    r = _verify(admin, anchor_count=head["entry_count"], anchor_hash=head["hash"])  # ... an anchor is not
    assert r.status_code == 409 and r.json()["result"]["reason"] == "CHAIN_TRUNCATED"


def test_anchor_detects_full_rehash_of_history(env):
    db, _app, admin = env
    head = _verify(admin).json()["result"]["verified_head"]
    c = _drop_triggers(db)
    c.row_factory = sqlite3.Row
    rows = [dict(r) for r in c.execute("SELECT * FROM audit_events ORDER BY entry_no")]
    prev = audit.GENESIS_HASH
    for row in rows:
        if row["entry_no"] == 2:
            row["reason"] = "REWRITTEN"
        row["prev_hash"] = prev
        row["hash"] = audit.calculate_hash(row)
        prev = row["hash"]
        c.execute("UPDATE audit_events SET reason=?, prev_hash=?, hash=? WHERE entry_no=?",
                  (row["reason"], row["prev_hash"], row["hash"], row["entry_no"]))
    c.commit()
    assert _verify(admin).status_code == 200  # self-consistent, so unanchored passes
    r = _verify(admin, anchor_count=head["entry_count"], anchor_hash=head["hash"])
    assert r.status_code == 409 and r.json()["result"]["reason"] == "ANCHOR_MISMATCH"


def test_backup_acts_as_built_in_anchor_without_any_client_state(env):
    db, _app, admin = env
    admin.post("/api/vault/unlock", json={"passphrase": PW})
    token = admin.post("/api/confirmations", json={"action": "backup"}).json()["data"]["confirmation_token"]
    assert admin.post("/api/backups", json={"confirmation_token": token}).status_code == 201
    ok = _verify(admin)
    assert ok.status_code == 200 and ok.json()["result"]["anchors_checked"][0]["source"].startswith("backup:")
    n = ok.json()["result"]["verified_head"]["entry_count"]
    c = _drop_triggers(db)
    c.execute("DELETE FROM audit_events WHERE entry_no > ?", (n - 3,))
    c.commit()
    r = _verify(admin)  # plain Verify, nothing remembered by the client
    assert r.status_code == 409 and r.json()["result"]["reason"] == "CHAIN_TRUNCATED"


def test_anchor_fields_must_come_as_a_pair(env):
    _db, _app, admin = env
    assert _verify(admin, anchor_count=3).status_code == 400
    assert _verify(admin, anchor_hash="0" * 64).status_code == 400
    assert _verify(admin, anchor_count=3, anchor_hash="nothex").status_code == 400


def test_csv_export_neutralises_formula_cells():
    data = {"generated_at": "t", "chain_count": 1, "chain_head": "h", "exported_by": "u", "role": "viewer",
            "keys": [{"id": 1, "name": '=HYPERLINK("http://evil","x")', "purpose": "+cmd", "state": "-1", "algorithm": "@SUM(A1)"}],
            "audit_events": [{"entry_no": 1, "user": "ok", "target": "=1+1", "details": {}}]}
    out = format_csv_report(data)
    for line in out.splitlines():
        for cell in line.split(","):
            assert not cell.strip('"').startswith(("=", "+", "@")), line
    assert "'=HYPERLINK" in out and "'=1+1" in out and "'-1" in out


def test_csv_export_end_to_end_through_the_api(env):
    _db, app, admin = env
    admin.post("/api/vault/unlock", json={"passphrase": PW})
    assert admin.post("/api/keys", json={"name": "=2+2", "purpose": "standard"}).status_code == 201
    csv_text = login(app, "viewer").get("/api/reports/export?format=csv").text
    assert "'=2+2" in csv_text and ",=2+2," not in csv_text
