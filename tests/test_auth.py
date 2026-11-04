import time

from conftest import ADMIN_PW


def test_setup_runs_once(ctx):
    assert ctx.setup().status_code == 201
    r = ctx.setup()
    assert r.status_code == 404 and r.json()["code"] == "SETUP_CLOSED"


def test_passwords_and_sessions_are_stored_hashed(admin):
    db = admin.db()
    assert db.execute("SELECT password_hash FROM users").fetchone()[0].startswith("$argon2id$")
    token = admin.client.cookies.get("kc_session")
    stored = db.execute("SELECT token_hash FROM sessions").fetchone()[0]
    assert token and token != stored and len(stored) == 64


def test_login_errors_are_generic(ctx):
    ctx.setup()
    wrong_pw = ctx.login("admin", "not-the-password")
    unknown = ctx.login("nobody", "not-the-password")
    assert wrong_pw.status_code == unknown.status_code == 401
    assert wrong_pw.json()["code"] == unknown.json()["code"] == "AUTH_FAILED"
    assert wrong_pw.json()["message"] == unknown.json()["message"]


def test_lockout_after_five_failures_then_automatic_unlock(ctx):
    ctx.setup()
    for _ in range(5):
        assert ctx.login("admin", "bad-password").json()["code"] == "AUTH_FAILED"
    r = ctx.login("admin", ADMIN_PW)
    assert r.status_code == 429 and r.json()["code"] == "TOO_MANY_ATTEMPTS"
    db = ctx.db()
    db.execute("UPDATE users SET locked_until = ?", (int(time.time()) - 1,))
    db.commit()
    assert ctx.login("admin", ADMIN_PW).status_code == 200


def test_unknown_username_is_also_locked_with_same_response(ctx):
    ctx.setup()
    for _ in range(5):
        ctx.login("ghost", "bad-password")
    r = ctx.login("ghost", "bad-password")
    assert r.status_code == 429 and r.json()["code"] == "TOO_MANY_ATTEMPTS"


def test_unauthenticated_request_is_refused(ctx):
    ctx.setup()
    r = ctx.client.get("/api/users")
    assert r.status_code == 401 and r.json()["code"] == "SESSION_EXPIRED"


def test_idle_session_expires(admin):
    db = admin.db()
    db.execute("UPDATE sessions SET expires_at = ?", (int(time.time()) - 1,))
    db.commit()
    r = admin.client.get("/api/auth/session")
    assert r.status_code == 401 and r.json()["code"] == "SESSION_EXPIRED"


def test_activity_extends_the_session(admin):
    db = admin.db()
    db.execute("UPDATE sessions SET expires_at = ?", (int(time.time()) + 5,))
    db.commit()
    assert admin.client.get("/api/auth/session").status_code == 200
    assert db.execute("SELECT expires_at FROM sessions").fetchone()[0] > time.time() + 1000


def test_logout_ends_the_session(admin):
    assert admin.client.post("/api/auth/logout").status_code == 200
    assert admin.client.get("/api/auth/session").status_code == 401


def test_state_change_needs_csrf_token(admin):
    del admin.client.headers["x-csrf-token"]
    r = admin.client.post("/api/vault/lock")
    assert r.status_code == 403 and r.json()["code"] == "CSRF_INVALID"
    admin.client.headers["x-csrf-token"] = "wrong"
    assert admin.client.post("/api/vault/lock").json()["code"] == "CSRF_INVALID"


def test_cookie_flags_and_security_headers(ctx):
    ctx.setup()
    r = ctx.login("admin", ADMIN_PW)
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors" in r.headers["content-security-policy"]
    assert r.headers["cache-control"] == "no-store"


def test_unexpected_field_is_rejected(ctx):
    ctx.setup()
    r = ctx.client.post("/api/auth/login", json={"username": "admin", "password": "x", "extra": 1})
    assert r.status_code == 400 and r.json()["code"] == "INVALID_INPUT"


def test_oversized_request_is_rejected(ctx):
    ctx.setup()
    r = ctx.client.post("/api/auth/login", content=b"x" * (257 * 1024),
                        headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"
