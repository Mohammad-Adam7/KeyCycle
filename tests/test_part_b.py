import json
import time
import pytest
from fastapi.testclient import TestClient
from conftest import PASSPHRASE, ADMIN_PW
from app.main import create_app
from app import audit
from app.ciphertext import decode_package, encode_package, Package


@pytest.fixture
def ready(admin):
    a=admin.client
    assert a.post("/api/vault/unlock",json={"passphrase":PASSPHRASE}).status_code == 200
    a.patch("/api/settings/rate_limit_per_minute",json={"value":300})
    pw=admin.make_user("op1","operator")
    admin.op=admin.as_user("op1",pw)
    pw=admin.make_user("view1","viewer")
    admin.viewer=admin.as_user("view1",pw)
    r=a.post("/api/keys",json={"name":"payroll-key","purpose":"standard"})
    assert r.status_code == 201, r.text
    admin.kid=r.json()["data"]["id"]
    return admin


def token(ctx, action="rotate"):
    r=ctx.client.post("/api/confirmations",json={"action":action,"key_id":ctx.kid})
    assert r.status_code == 201, r.text
    return r.json()["data"]["confirmation_token"]


def encrypt(ctx,text="Salary: 80000"):
    r=ctx.op.post("/api/crypto/encrypt",json={"key_id":ctx.kid,"data":text})
    assert r.status_code == 200, r.text
    return r.json()["data"]["package"]


def test_full_lifecycle(ready):
    c=ready
    old=encrypt(c,"اردو text\n")
    t=token(c)
    r=c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["current_version"] == 2
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t}).json()["code"] == "CONFIRMATION_REQUIRED"
    assert c.op.post("/api/crypto/decrypt",json={"package":old}).json()["data"]["plaintext"] == "اردو text\n"
    assert decode_package(encrypt(c)).version == 2
    t=token(c,"revoke")
    body={"confirmation_token":t,"reason":"Suspected compromise","confirm_name":"payroll-key"}
    assert c.client.post(f"/api/keys/{c.kid}/revoke",json=body).status_code == 200
    assert c.op.post("/api/crypto/decrypt",json={"package":old}).json()["code"] == "KEY_REVOKED"
    body["confirmation_token"]=token(c,"revoke")
    body["reason"]="New reason"
    r=c.client.post(f"/api/keys/{c.kid}/revoke",json=body)
    assert r.json()["result"]["reason"]["code"] == "REVOKE_REPEATED"
    assert r.json()["data"]["revoke_reason"] == "Suspected compromise"


def test_permissions_reads_and_purpose(ready):
    c=ready
    assert c.client.post("/api/crypto/encrypt",json={"key_id":c.kid,"data":"x"}).status_code == 403
    r=c.client.post("/api/keys",json={"name":"test-key","purpose":"test"})
    kid=r.json()["data"]["id"]
    r=c.client.post("/api/crypto/encrypt",json={"key_id":kid,"data":"x"})
    assert r.json()["result"]["test"] is True
    assert c.op.post("/api/crypto/encrypt",json={"key_id":kid,"data":"x"}).status_code == 403
    assert c.viewer.post("/api/crypto/encrypt",json={}).status_code == 403
    with c.db() as db:
        count=db.execute("SELECT count(*) FROM audit_events").fetchone()[0]
    for path in ["/api/keys",f"/api/keys/{c.kid}","/api/results"]:
        r=c.viewer.get(path)
        assert r.status_code == 200
        assert "wrapped_key" not in r.text and "revoke_reason" not in r.text
    with c.db() as db:
        assert db.execute("SELECT count(*) FROM audit_events").fetchone()[0] == count


@pytest.mark.parametrize("body", [{}, {"key_id":True,"data":"x"}, {"key_id":1,"data":""}, {"key_id":1,"data":"\ud800"}, {"key_id":1,"data":"x","nonce":"a"}])
def test_validation_audited(ready,body):
    r=ready.op.post("/api/crypto/encrypt",content=json.dumps(body),headers={"content-type":"application/json"})
    assert r.status_code == 400, r.text
    assert r.json()["audit_entry"] is not None


@pytest.mark.parametrize("path", ["/api/keys/9223372036854775808","/api/keys/-1","/api/keys/0","/api/results/999999999999999999999999","/api/keys?limit=101","/api/keys?state=bad"])
def test_bounded_paths_queries(ready,path):
    assert ready.op.get(path).status_code == 400


def test_limits_and_historical_decryption(ready):
    c=ready
    encrypt(c,"x"*65536)
    assert c.op.post("/api/crypto/encrypt",json={"key_id":c.kid,"data":"x"*65537}).status_code == 413
    c.client.patch("/api/settings/max_data_kib",json={"value":128})
    package=encrypt(c,"x"*131072)
    c.client.patch("/api/settings/max_data_kib",json={"value":1})
    r=c.op.post("/api/crypto/decrypt",json={"package":package})
    assert r.status_code == 200 and len(r.json()["data"]["plaintext"]) == 131072


def test_tamper_and_unknown_version(ready):
    c=ready
    p=decode_package(encrypt(c))
    cases=[Package(p.key_id,p.version,p.nonce,bytes([p.ct[0]^1])+p.ct[1:]),Package(p.key_id,999,p.nonce,p.ct),Package(999,p.version,p.nonce,p.ct),Package(p.key_id,p.version,bytes([p.nonce[0]^1])+p.nonce[1:],p.ct)]
    for bad in cases:
        r=c.op.post("/api/crypto/decrypt",json={"package":encode_package(bad)})
        assert r.json()["code"] == "CIPHERTEXT_INVALID"


def test_expiry_while_stored_active_and_locked(ready):
    c=ready
    package=encrypt(c)
    with c.db() as db:
        db.execute("UPDATE keys SET expires_at=? WHERE id=?",(int(time.time()),c.kid))
    c.client.post("/api/vault/lock")
    assert c.op.post("/api/crypto/decrypt",json={"package":package}).json()["code"] == "KEY_EXPIRED"
    assert c.op.get(f"/api/keys/{c.kid}").json()["data"]["state"] == "expired"


def test_confirmation_denial_keeps_token_and_failure_rolls_back(ready,monkeypatch):
    c=ready
    t=token(c)
    c.client.post("/api/vault/lock")
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t}).json()["code"] == "VAULT_LOCKED"
    c.client.post("/api/vault/unlock",json={"passphrase":PASSPHRASE})
    original=c.app.state.vault.wrap
    def fail(*a,**kw):
        raise ValueError("secret exception must not leak")
    monkeypatch.setattr(c.app.state.vault,"wrap",fail)
    r=c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t})
    assert r.status_code == 500 and "secret exception" not in r.text
    assert c.client.get(f"/api/keys/{c.kid}").json()["data"]["current_version"] == 1
    monkeypatch.setattr(c.app.state.vault,"wrap",original)
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t}).status_code == 200


def test_audit_failure_releases_no_output(ready,monkeypatch):
    original=audit.record
    def fail(conn, **kw):
        if kw["action"] == "encrypt" and kw["outcome"] == "success":
            raise RuntimeError("no audit")
        return original(conn,**kw)
    monkeypatch.setattr(audit,"record",fail)
    r=ready.op.post("/api/crypto/encrypt",json={"key_id":ready.kid,"data":"SENTINEL"})
    assert r.status_code == 500 and "package" not in r.text and "SENTINEL" not in r.text


def test_history_ownership_redaction_and_secret_storage(ready):
    c=ready
    package=encrypt(c,"secret-sentinel-38476")
    own=c.op.get("/api/results").json()["data"]["items"]
    assert all(r["action"] in ("encrypt","decrypt") and "user" not in r for r in own)
    pw=c.make_user("op2","operator")
    other=c.as_user("op2",pw)
    assert other.get(f"/api/results/{own[0]['entry']}").status_code == 404
    viewer=c.viewer.get("/api/results").json()["data"]["items"]
    assert all("evidence" not in r and "user" not in r for r in viewer)
    with c.db() as db:
        dump="\n".join(db.iterdump())
        assert "secret-sentinel-38476" not in dump and package not in dump
        row=db.execute("SELECT details FROM audit_events WHERE action='encrypt' AND outcome='success'").fetchone()
        assert json.loads(row[0])["key_id"] == c.kid


def test_restart_invalidates_confirmations_and_preserves_packages(ready):
    c=ready
    package=encrypt(c)
    t=token(c)
    restarted=TestClient(create_app(c.path))
    c.login("admin",ADMIN_PW,restarted)
    assert restarted.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t}).json()["code"] == "CONFIRMATION_REQUIRED"
    restarted.post("/api/vault/unlock",json={"passphrase":PASSPHRASE})
    c.login("op1","user-password-123",restarted)
    assert restarted.post("/api/crypto/decrypt",json={"package":package}).status_code == 200
