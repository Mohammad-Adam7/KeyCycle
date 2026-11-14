import pytest


@pytest.mark.parametrize("role", ["operator", "viewer"])
def test_T2_non_admin_cannot_create_a_key(admin, role):
    pw = admin.make_user(f"{role}1", role)
    c = admin.as_user(f"{role}1", pw)
    r = c.post("/api/keys")
    assert r.status_code == 403 and r.json()["code"] == "FORBIDDEN"

    assert "key" not in r.json()["message"].lower()
    row = admin.db().execute("SELECT * FROM audit_events WHERE entry_no = ?", (r.json()["audit_entry"],)).fetchone()
    assert row["outcome"] == "denied" and row["user"] == f"{role}1" and row["reason"] == "FORBIDDEN"


def test_administrator_passes_the_role_check(admin):
    r = admin.client.post("/api/keys")
    assert r.json()["code"] == "INVALID_INPUT"
    from conftest import PASSPHRASE
    admin.client.post("/api/vault/unlock", json={"passphrase": PASSPHRASE})
    assert admin.client.post("/api/keys", json={"name":"role-test", "purpose":"test"}).status_code == 201


@pytest.mark.parametrize("path", ["/api/users", "/api/settings"])
def test_admin_screens_are_closed_to_other_roles(admin, path):
    pw = admin.make_user("op1", "operator")
    assert admin.as_user("op1", pw).get(path).status_code == 403


def test_operator_cannot_control_the_vault(admin):
    pw = admin.make_user("op1", "operator")
    c = admin.as_user("op1", pw)
    assert c.post("/api/vault/unlock", json={"passphrase": "x"}).status_code == 403
    assert c.post("/api/vault/lock").status_code == 403


def test_user_management(admin):
    admin.make_user("op1", "operator")
    assert admin.client.post("/api/users", json={"username": "op1", "password": "user-password-123",
                                                 "role": "viewer"}).status_code == 400        # duplicate
    assert admin.client.post("/api/users", json={"username": "short", "password": "tooshort",
                                                 "role": "viewer"}).status_code == 400        # password < 12
    assert admin.client.post("/api/users", json={"username": "x", "password": "user-password-123",
                                                 "role": "viewer"}).status_code == 400        # username < 3
    assert admin.client.post("/api/users", json={"username": "boss", "password": "user-password-123",
                                                 "role": "root"}).status_code == 400          # unknown role


def test_disabled_user_loses_access_and_cannot_log_in(admin):
    pw = admin.make_user("op1", "operator")
    c = admin.as_user("op1", pw)
    uid = [u for u in admin.client.get("/api/users").json() if u["username"] == "op1"][0]["id"]
    assert admin.client.patch(f"/api/users/{uid}", json={"disabled": True}).status_code == 200
    assert c.get("/api/auth/session").status_code == 401
    assert admin.login("op1", pw, admin.new_client()).json()["code"] == "AUTH_FAILED"


def test_last_administrator_cannot_be_removed(admin):
    uid = admin.client.get("/api/users").json()[0]["id"]
    assert admin.client.patch(f"/api/users/{uid}", json={"disabled": True}).status_code == 400
    assert admin.client.patch(f"/api/users/{uid}", json={"role": "viewer"}).status_code == 400


def test_settings_are_range_checked_and_versioned(admin):
    r = admin.client.patch("/api/settings/lockout_minutes", json={"value": 0})
    assert r.status_code == 422 and r.json()["code"] == "SETTING_OUT_OF_RANGE"
    assert admin.client.patch("/api/settings/rate_limit_per_minute", json={"value": 1000000}).status_code == 422
    assert admin.client.patch("/api/settings/lockout_minutes", json={"value": 20}).status_code == 200
    row = [s for s in admin.client.get("/api/settings").json() if s["name"] == "lockout_minutes"][0]
    assert row["value"] == 20 and row["version"] == 2 and row["changed_by"] == "admin"


def test_rate_limit_applies_to_sensitive_actions(admin):
    admin.client.patch("/api/settings/rate_limit_per_minute", json={"value": 5})
    codes = [admin.client.post("/api/vault/lock").status_code for _ in range(8)]
    assert 429 in codes
