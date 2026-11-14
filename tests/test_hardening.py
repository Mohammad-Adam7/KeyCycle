import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from conftest import ADMIN_PW, PASSPHRASE

PUBLIC = {("POST", "/api/setup"), ("POST", "/api/auth/login")}
OPEN_TO_ANY_SIGNED_IN_USER = {("GET", "/api/auth/session"), ("POST", "/api/auth/logout"),
    ("GET", "/api/vault/status"), ("GET", "/api/keys"), ("GET", "/api/keys/1"),
    ("GET", "/api/results"), ("GET", "/api/results/1")}


def routes(app):
    # OpenAPI enumerates included routers too (new FastAPI uses lazy wrappers).
    for path, operations in app.openapi()["paths"].items():
        if path.startswith("/api"):
            for m in operations:
                if m in {"get", "post", "patch", "put", "delete"}:
                    yield m.upper(), path.replace("{user_id}", "1").replace("{name}", "lockout_minutes").replace("{key_id}", "1").replace("{entry}", "1")


def test_every_endpoint_refuses_unauthenticated_requests(ctx):
    ctx.setup()
    checked = 0
    for method, path in routes(ctx.app):
        if (method, path) in PUBLIC:
            continue
        r = ctx.new_client().request(method, path, json={})
        assert r.status_code == 401 and r.json()["code"] == "SESSION_EXPIRED", (method, path)
        checked += 1
    assert checked >= 10


def test_every_endpoint_outside_the_allowlist_refuses_a_viewer(admin):
    pw = admin.make_user("view1", "viewer")
    c = admin.as_user("view1", pw)
    for method, path in routes(admin.app):
        if (method, path) in PUBLIC or (method, path) in OPEN_TO_ANY_SIGNED_IN_USER:
            continue
        r = c.request(method, path, json={})
        assert r.status_code == 403 and r.json()["code"] == "FORBIDDEN", (method, path)


def test_login_lockout_survives_a_restart(ctx):
    ctx.setup()
    for _ in range(5):
        ctx.login("ghost", "bad-password")                       # unknown username
        ctx.login("admin", "bad-password")                       # real account
    restarted = TestClient(create_app(ctx.path), raise_server_exceptions=False)
    for name in ("ghost", "admin"):
        r = restarted.post("/api/auth/login", json={"username": name, "password": ADMIN_PW})
        assert r.status_code == 429 and r.json()["code"] == "TOO_MANY_ATTEMPTS", name


def test_vault_unlock_lockout_survives_a_restart(admin):
    for _ in range(5):
        admin.client.post("/api/vault/unlock", json={"passphrase": "bad passphrase!"})
    restarted = TestClient(create_app(admin.path), raise_server_exceptions=False)
    r = restarted.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PW})
    restarted.headers["x-csrf-token"] = r.json()["csrf_token"]
    r = restarted.post("/api/vault/unlock", json={"passphrase": PASSPHRASE})
    assert r.status_code == 429 and r.json()["code"] == "TOO_MANY_ATTEMPTS"


def test_failure_counters_expire_and_are_cleaned_up(ctx):
    ctx.setup()
    db = ctx.db()
    ctx.login("ghost1", "bad-password")
    old = int(time.time()) - 7200
    db.execute("UPDATE failures SET updated_at = ?, locked_until = 0", (old,))
    db.commit()
    ctx.login("ghost2", "bad-password")                          # triggers cleanup of stale rows
    keys = [r[0] for r in db.execute("SELECT key FROM failures")]
    assert "login:ghost1" not in keys and "login:ghost2" in keys


def test_body_limit_counts_real_bytes_without_content_length(ctx):
    ctx.setup()
    def chunks():                                                # streamed: no Content-Length header
        for _ in range(300):
            yield b"x" * 1024
    r = ctx.client.post("/api/auth/login", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"


def test_body_limit_allows_a_normal_request(ctx):
    ctx.setup()
    assert ctx.login("admin", ADMIN_PW).status_code == 200


def test_login_attempts_are_throttled_per_address(ctx):
    ctx.setup()
    codes = [ctx.client.post("/api/auth/login", json={"username": f"user{i}", "password": "x"}).json()["code"]
             for i in range(25)]
    assert codes[0] == "AUTH_FAILED" and codes[-1] == "RATE_LIMITED"


def test_expired_sessions_are_purged_on_login(admin):
    db = admin.db()
    db.execute("UPDATE sessions SET expires_at = ?", (int(time.time()) - 5,))
    db.commit()
    admin.login("admin", ADMIN_PW, admin.new_client())
    assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


def test_each_login_issues_a_fresh_session_token(ctx):
    ctx.setup()
    a, b = ctx.new_client(), ctx.new_client()
    ctx.login("admin", ADMIN_PW, a)
    ctx.login("admin", ADMIN_PW, b)
    assert a.cookies.get("kc_session") != b.cookies.get("kc_session")
