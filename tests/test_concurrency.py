import threading
import time
from concurrent.futures import ThreadPoolExecutor
import pytest
from app.auth import Principal
from app.db import connect
from app.errors import AppError
from app.key_service import KeyService, SYSTEM
from app.models import KeyCreate, RevokeIn
from app.models import EncryptIn, DecryptIn
from app.security import token_hash
from test_part_b import ready, token
from test_part_b import encrypt


def actor(ctx):
    with ctx.db() as db:
        row=db.execute("SELECT id FROM users WHERE username='admin'").fetchone()
    return Principal(row[0],"admin","administrator",""), token_hash(ctx.client.cookies["kc_session"])


def race(ctx, jobs):
    barrier=threading.Barrier(len(jobs))
    p,session=actor(ctx)
    def worker(job):
        conn=connect(ctx.path)
        try:
            s=KeyService(conn,ctx.app.state.vault,p,session)
            barrier.wait(5)
            try:
                return job(s)
            except AppError as e:
                return e.code
        finally:
            conn.close()
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures=[pool.submit(worker,j) for j in jobs]
        return [f.result(15) for f in futures]


def test_duplicate_create_and_single_use_races(ready):
    c=ready
    results=race(c,[lambda s:s.create(KeyCreate(name="race",purpose="test"))]*2)
    assert sum(isinstance(r,dict) for r in results) == 1
    assert "INVALID_INPUT" in results
    t=token(c)
    results=race(c,[lambda s:s.rotate(c.kid,t)]*2)
    assert sum(isinstance(r,dict) for r in results) == 1
    assert "CONFIRMATION_REQUIRED" in results


def test_manual_scheduled_race(ready):
    c=ready
    with c.db() as db:
        db.execute("UPDATE key_versions SET created_at=? WHERE key_id=?",(int(time.time())-91*86400,c.kid))
    t=token(c)
    def scheduled(s):
        return KeyService(s.conn,s.vault,SYSTEM).rotate(c.kid,expected_version=1)
    race(c,[lambda s:s.rotate(c.kid,t),scheduled])
    with c.db() as db:
        assert db.execute("SELECT current_version FROM keys WHERE id=?",(c.kid,)).fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM key_versions WHERE key_id=? AND status='current'",(c.kid,)).fetchone()[0] == 1


def operator_service(ctx,conn):
    row=conn.execute("SELECT id FROM users WHERE username='op1'").fetchone()
    return KeyService(conn,ctx.app.state.vault,Principal(row[0],"op1","operator",""),token_hash(ctx.op.cookies["kc_session"]))


def test_encrypt_vs_revoke_and_subsequent_denial(ready):
    c=ready
    t=token(c,"revoke")
    def use(s):
        return operator_service(c,s.conn).encrypt(EncryptIn(key_id=c.kid,data="race text"))
    results=race(c,[use,lambda s:s.revoke(c.kid,RevokeIn(confirmation_token=t,reason="Retired",confirm_name="payroll-key"))])
    assert isinstance(results[1],dict)
    assert isinstance(results[0],dict) or results[0] == "KEY_REVOKED"
    conn=connect(c.path)
    try:
        with pytest.raises(AppError) as err:
            operator_service(c,conn).encrypt(EncryptIn(key_id=c.kid,data="after revoke"))
        assert err.value.code == "KEY_REVOKED"
    finally:
        conn.close()


def test_lock_after_decrypt_acquires_key(ready,monkeypatch):
    c=ready
    package=encrypt(c,"in flight")
    from app import crypto_engine
    original=crypto_engine.decrypt
    acquired,release=threading.Event(),threading.Event()
    def paused(*args):
        acquired.set()
        if not release.wait(5):
            raise RuntimeError("test release timeout")
        return original(*args)
    monkeypatch.setattr(crypto_engine,"decrypt",paused)
    def decrypt():
        conn=connect(c.path)
        try:
            return operator_service(c,conn).decrypt(DecryptIn(package=package))
        finally:
            conn.close()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(decrypt)
        try:
            assert acquired.wait(5)
            c.app.state.vault.lock()
        finally:
            release.set()
        assert future.result(10)["data"]["plaintext"] == "in flight"
    conn=connect(c.path)
    try:
        with pytest.raises(AppError) as err:
            operator_service(c,conn).decrypt(DecryptIn(package=package))
        assert err.value.code == "VAULT_LOCKED"
    finally:
        conn.close()
