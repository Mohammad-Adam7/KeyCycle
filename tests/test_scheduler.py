import time
import threading
from fastapi.testclient import TestClient
from app.db import connect
from app.scheduler import run_due_once, Scheduler
from app.main import create_app
from conftest import PASSPHRASE
from test_part_b import ready


def make_due(ctx):
    now=int(time.time())
    with ctx.db() as db:
        db.execute("UPDATE key_versions SET created_at=? WHERE key_id=?",(now-91*86400,ctx.kid))
    return now


def test_deferred_expiry_catchup(ready):
    c=ready
    now=make_due(c)
    c.app.state.vault.lock()
    conn=connect(c.path)
    warned=set()
    for _ in range(3):
        assert run_due_once(conn,c.app.state.vault,now,warned).deferred == 1
    assert conn.execute("SELECT count(*) FROM audit_events WHERE action='rotation_deferred'").fetchone()[0] == 1
    run_due_once(conn,c.app.state.vault,now,set())
    assert conn.execute("SELECT count(*) FROM audit_events WHERE action='rotation_deferred'").fetchone()[0] == 2
    assert c.app.state.vault.unlock(conn,PASSPHRASE)
    assert run_due_once(conn,c.app.state.vault,now,warned).rotated == 1
    assert run_due_once(conn,c.app.state.vault,now,warned).rotated == 0
    conn.execute("UPDATE keys SET expires_at=? WHERE id=?",(now,c.kid))
    c.app.state.vault.lock()
    assert run_due_once(conn,c.app.state.vault,now,warned).expired == 1
    assert conn.execute("SELECT state FROM keys WHERE id=?",(c.kid,)).fetchone()[0] == "expired"
    assert not warned
    conn.close()


def test_lifespan_and_unlock_wake(ready,monkeypatch):
    c=ready
    make_due(c)
    app=create_app(c.path,scheduler_interval=60)
    finished=threading.Event()
    import app.scheduler as module
    original=module.run_due_once
    def observe(*args,**kwargs):
        r=original(*args,**kwargs)
        if r.rotated:
            finished.set()
        return r
    monkeypatch.setattr(module,"run_due_once",observe)
    with TestClient(app) as client:
        assert app.state.scheduler._thread.is_alive()
        c.login("admin","admin-password-123",client)
        assert client.post("/api/vault/unlock",json={"passphrase":PASSPHRASE}).status_code == 200
        assert finished.wait(5), app.state.scheduler.status()
    assert not app.state.scheduler._thread.is_alive()
    assert not app.state.vault.unlocked


def test_scheduler_failure_continues_and_batches(ready,monkeypatch):
    c=ready
    conn=connect(c.path)
    now=make_due(c)
    # Synthetic rows clone wrapped material only for expiration tests (never use it).
    for i in range(101):
        conn.execute("INSERT INTO keys(name,rotation_days,expires_at,created_by,created_at) VALUES (?,90,?,1,?)",(f"expire-{i}",now,now-100))
    r=run_due_once(conn,c.app.state.vault,now,set())
    assert r.expired == 101 and r.rotated == 1
    conn.close()


def test_one_corrupt_key_does_not_stop_expiry(ready):
    c=ready
    conn=connect(c.path)
    now=int(time.time())
    conn.execute("DELETE FROM key_versions WHERE key_id=?",(c.kid,))
    kid=conn.execute("INSERT INTO keys(name,rotation_days,expires_at,created_by,created_at) VALUES ('expired-after-bad',90,?,1,?)",(now,now-1)).lastrowid
    report=run_due_once(conn,c.app.state.vault,now,set())
    assert report.errors == 1 and report.expired == 1
    assert conn.execute("SELECT state FROM keys WHERE id=?",(kid,)).fetchone()[0] == "expired"
    row=conn.execute("SELECT details FROM audit_events WHERE action='scheduler_failure'").fetchone()
    assert 'ValueError' in row[0] and 'missing current version' not in row[0]
    conn.close()
