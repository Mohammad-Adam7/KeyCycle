import json
import pytest
from starlette.testclient import TestClient

from app.auth import COOKIE
from scripts.seed_demo import seed


@pytest.fixture
def seeded_app(tmp_path):
    from app.main import create_app
    db_path = tmp_path / "reports_test.db"
    seed(db_path, "Passphrase123456!", "Passphrase123456!")
    return create_app(str(db_path))


def login(client: TestClient, username: str, password: str = "Passphrase123456!") -> str:
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200
    return r.json()["csrf_token"]


def test_admin_json_report(seeded_app):
    client = TestClient(seeded_app)
    csrf = login(client, "admin")

    res = client.get("/api/reports/export?format=json")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    assert "attachment; filename=" in res.headers["content-disposition"]

    data = res.json()
    assert data["report_title"] == "KeyCycle Security & Lifecycle Report"
    assert data["exported_by"] == "admin"
    assert data["role"] == "administrator"
    assert "generated_at" in data
    assert "chain_count" in data
    assert "chain_head" in data
    assert len(data["chain_head"]) == 64

    # Admin gets keys, audit_events, users, and settings
    assert "keys" in data
    assert "audit_events" in data
    assert "users" in data
    assert "settings" in data

    # Verify no secret leak
    content_str = res.text
    assert "password_hash" not in content_str
    assert "wrapped_key" not in content_str
    assert "Passphrase123456!" not in content_str


def test_admin_csv_report(seeded_app):
    client = TestClient(seeded_app)
    login(client, "admin")

    res = client.get("/api/reports/export?format=csv")
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    text = res.text
    assert "# KeyCycle Security & Lifecycle Report" in text
    assert "# Chain head:" in text
    assert "# --- KEYS ---" in text
    assert "# --- AUDIT EVENTS ---" in text
    assert "# --- USERS ---" in text
    assert "# --- SETTINGS ---" in text


def test_operator_report_sanitised(seeded_app):
    client = TestClient(seeded_app)
    login(client, "operator1")

    res = client.get("/api/reports/export?format=json")
    assert res.status_code == 200
    data = res.json()
    assert data["exported_by"] == "operator1"
    assert data["role"] == "operator"

    # Operator must NOT receive users or settings
    assert "users" not in data
    assert "settings" not in data

    # Operator gets only their own audit events
    assert "audit_events" in data
    for event in data["audit_events"]:
        assert event["user"] == "operator1"

    # Keys metadata must not expose created_by or revoke_reason to operators
    for k in data["keys"]:
        assert "created_by" not in k
        assert "revoke_reason" not in k


def test_viewer_report_sanitised(seeded_app):
    client = TestClient(seeded_app)
    login(client, "viewer")

    res = client.get("/api/reports/export?format=json")
    assert res.status_code == 200
    data = res.json()
    assert data["exported_by"] == "viewer"
    assert data["role"] == "viewer"

    # Viewer must NOT receive users or settings
    assert "users" not in data
    assert "settings" not in data

    # Viewer gets decision outcomes without usernames or details
    assert "decision_outcomes" in data
    assert "audit_events" not in data
    for outcome in data["decision_outcomes"]:
        assert "user" not in outcome
        assert "role" not in outcome
        assert "details" not in outcome


def test_invalid_report_query(seeded_app):
    client = TestClient(seeded_app)
    login(client, "admin")

    # Invalid format
    res = client.get("/api/reports/export?format=xml")
    assert res.status_code == 400
    assert res.json()["code"] == "INVALID_INPUT"

    # Unexpected query param
    res = client.get("/api/reports/export?format=json&extra=bad")
    assert res.status_code == 400
    assert res.json()["code"] == "INVALID_INPUT"


def test_unauthenticated_export(seeded_app):
    client = TestClient(seeded_app)
    res = client.get("/api/reports/export?format=json")
    assert res.status_code == 401
    assert res.json()["code"] == "SESSION_EXPIRED"
