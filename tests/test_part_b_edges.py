import json
import sqlite3
import time
import pytest
from app import audit
from app.auth import Principal
from app.config import KDF_STRONG
from app.db import connect, init_db, SCHEMA
from app.errors import AppError
from app.key_service import KeyService
from app.models import EncryptIn, KeyCreate
from app.security import token_hash
from app.vault import Vault
from conftest import PASSPHRASE, ADMIN_PW
from test_part_b import ready, token, encrypt


def test_nonce_uniqueness_and_rule_snapshots(ready):
    c=ready
    packages={encrypt(c,"same text") for _ in range(100)}
    assert len(packages) == 100
    for value in [2,1]:
        c.client.patch("/api/settings/max_data_kib",json={"value":value})
    r=c.op.post("/api/crypto/encrypt",json={"key_id":c.kid,"data":"x"*1025})
    assert r.json()["result"]["rule"] == {"name":"input_validation","version":3}
    assert r.json()["result"]["thresholds"]["max_data_kib"]["setting_version"] == 3


def test_confirmation_bindings_and_mismatch(ready):
    c=ready
    t=token(c,"revoke")
    body={"confirmation_token":t,"reason":"Retire", "confirm_name":"wrong"}
    assert c.client.post(f"/api/keys/{c.kid}/revoke",json=body).json()["code"] == "CONFIRMATION_REQUIRED"
    another=c.new_client()
    c.login("admin",ADMIN_PW,another)
    body["confirm_name"]="payroll-key"
    assert another.post(f"/api/keys/{c.kid}/revoke",json=body).json()["code"] == "CONFIRMATION_REQUIRED"
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t}).json()["code"] == "CONFIRMATION_REQUIRED"
    c.client.post("/api/vault/lock")
    assert c.client.post(f"/api/keys/{c.kid}/revoke",json=body).status_code == 200
    with c.db() as db:
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE keys SET state='active' WHERE id=?",(c.kid,))


def test_expired_confirmation_and_stale_version(ready):
    c=ready
    old=token(c)
    newer=token(c)
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":newer}).status_code == 200
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":old}).json()["code"] == "CONFIRMATION_REQUIRED"
    t=token(c)
    with c.db() as db:
        db.execute("UPDATE confirmations SET expires_at=? WHERE token_hash=?",(int(time.time()),token_hash(t)))
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t}).json()["code"] == "CONFIRMATION_REQUIRED"


def test_corrupt_wrapping_is_internal_failure(ready):
    c=ready
    package=encrypt(c)
    r=c.client.post("/api/keys",json={"name":"other","purpose":"standard"})
    other=r.json()["data"]["id"]
    with c.db() as db:
        row=db.execute("SELECT wrapped_key,nonce FROM key_versions WHERE key_id=?",(other,)).fetchone()
        db.execute("UPDATE key_versions SET wrapped_key=?,nonce=? WHERE key_id=?",(*row,c.kid))
    r=c.op.post("/api/crypto/decrypt",json={"package":package})
    assert r.json()["code"] == "INTERNAL_ERROR" and "plaintext" not in r.text


def test_rotate_audit_failure_rolls_back_everything(ready,monkeypatch):
    c=ready
    t=token(c)
    original=audit.record
    def fail(conn,**kw):
        if kw["action"] == "key_rotate" and kw["outcome"] == "success":
            raise RuntimeError("sensitive failure")
        return original(conn,**kw)
    monkeypatch.setattr(audit,"record",fail)
    assert c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":t}).status_code == 500
    with c.db() as db:
        assert db.execute("SELECT used_at FROM confirmations WHERE token_hash=?",(token_hash(t),)).fetchone()[0] is None
        assert db.execute("SELECT count(*) FROM key_versions WHERE key_id=?",(c.kid,)).fetchone()[0] == 1
        assert db.execute("SELECT status FROM key_versions WHERE key_id=?",(c.kid,)).fetchone()[0] == "current"


def test_recheck_disabled_session_at_transaction_entry(ready):
    c=ready
    conn=connect(c.path)
    row=conn.execute("SELECT id FROM users WHERE username='op1'").fetchone()
    p=Principal(row[0],"op1","operator","")
    s=KeyService(conn,c.app.state.vault,p,token_hash(c.op.cookies["kc_session"]))
    conn.execute("UPDATE users SET disabled=1 WHERE id=?",(p.user_id,))
    with pytest.raises(AppError) as err:
        s.encrypt(EncryptIn(key_id=c.kid,data="x"))
    assert err.value.code == "SESSION_EXPIRED"
    conn.close()


def test_real_default_kdf_smoke(tmp_path):
    path=str(tmp_path/"strong.db")
    init_db(path)
    conn=connect(path)
    vault=Vault()
    vault.initialise(conn,"strong-demo-passphrase",KDF_STRONG)
    assert vault.unlock(conn,"strong-demo-passphrase")
    n,ct=vault.wrap(b"x"*32,b"bound")
    assert vault.unwrap(n,ct,b"bound") == b"x"*32
    vault.lock()
    conn.close()


def test_legacy_schema_converges_without_loss(tmp_path):
    legacy=str(tmp_path/"legacy.db")
    fresh=str(tmp_path/"fresh.db")
    c=connect(legacy)
    c.executescript(SCHEMA.read_text().split("CREATE UNIQUE INDEX IF NOT EXISTS key_versions_one_current")[0])
    c.execute("INSERT INTO users(username,password_hash,role,created_at) VALUES ('old','hash','administrator',0)")
    audit.record(c,action="legacy",outcome="success")
    c.close()
    init_db(legacy)
    init_db(fresh)
    a,b=connect(legacy),connect(fresh)
    sql="SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
    assert [tuple(r) for r in a.execute(sql)] == [tuple(r) for r in b.execute(sql)]
    assert a.execute("SELECT count(*) FROM users").fetchone()[0] == 1
    assert a.execute("SELECT count(*) FROM audit_events").fetchone()[0] == 1
    a.close(); b.close()


def test_pagination_and_viewer_projection(ready):
    c=ready
    for i in range(3):
        encrypt(c,str(i))
    first=c.op.get("/api/results?limit=2").json()["data"]
    second=c.op.get(f"/api/results?limit=2&before_entry={first['next_cursor']}").json()["data"]
    assert set(r["entry"] for r in first["items"]).isdisjoint(r["entry"] for r in second["items"])
    assert len(first["items"])+len(second["items"]) == 3
    for _ in range(2):
        c.client.post(f"/api/keys/{c.kid}/rotate",json={"confirmation_token":token(c)})
    detail=c.viewer.get(f"/api/keys/{c.kid}?versions_limit=2").json()["data"]
    assert detail["versions_next_cursor"] == 2
    assert "created_by" not in detail and "revoke_reason" not in detail


def test_crypto_rate_limit_default(ready):
    c=ready
    c.client.patch("/api/settings/rate_limit_per_minute",json={"value":30})
    responses=[c.op.post("/api/crypto/encrypt",json={"key_id":c.kid,"data":"x"}) for _ in range(31)]
    assert all(r.status_code == 200 for r in responses[:30])
    assert responses[-1].json()["code"] == "RATE_LIMITED"


@pytest.mark.parametrize("expiry",["2030-01-01T00:00:00.000Z","2030-01-01T00:00:00.123456789Z","2030-01-01T05:00:00+05:00"])
def test_browser_expiry(ready,expiry):
    r=ready.client.post("/api/keys",json={"name":"future","purpose":"test","expires_at":expiry})
    assert r.status_code == 201
    assert r.json()["data"]["expires_at"] == "2030-01-01T00:00:00Z"
