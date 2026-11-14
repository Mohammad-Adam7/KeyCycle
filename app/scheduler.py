"""Single-worker scheduler; no HTTP connection or key material is cached."""
import logging
import threading
import time
from dataclasses import dataclass

from . import decisions, key_repository as repo
from .config import SCHEDULER_BATCH, SCHEDULER_INTERVAL_SECONDS
from .db import connect, transaction
from .errors import AppError
from .key_policy import effective_state
from .key_service import KeyService, SYSTEM


@dataclass
class TickReport:
    expired: int = 0
    rotated: int = 0
    deferred: int = 0
    errors: int = 0


def run_due_once(conn, vault, now, warned, stop_event=None):
    report = TickReport()
    # Prune obsolete in-memory warning keys, including manual revocation/rotation.
    for key_id, version in tuple(warned):
        key = repo.get_key(conn,key_id)
        if key is None or effective_state(key,now) != "active" or key["current_version"] != version:
            warned.discard((key_id,version))
    after = 0
    while not (stop_event and stop_event.is_set()):
        rows = conn.execute("SELECT id FROM keys WHERE state='active' AND id>? ORDER BY id LIMIT ?", (after,SCHEDULER_BATCH)).fetchall()
        if not rows:
            break
        for candidate in rows:
            if stop_event and stop_event.is_set():
                return report
            key_id = after = candidate["id"]
            t0 = time.perf_counter()
            due_version = None
            try:
                # Recheck every candidate under the same writer lock as manual actions.
                with transaction(conn):
                    key = repo.get_key(conn,key_id)
                    if key is None or key["state"] != "active":
                        continue
                    if effective_state(key,now) == "expired":
                        conn.execute("UPDATE keys SET state='expired' WHERE id=?", (key_id,))
                        decisions.record(conn,SYSTEM,"key_expire","KEY_EXPIRED_BY_SCHEDULE",allowed=True,t0=t0,
                            key_id=key_id,version=key["current_version"],rule="key_state_check",evidence={"state":"expired"})
                        expired = True
                    else:
                        expired = False
                        current = repo.get_version(conn,key_id,key["current_version"])
                        if current is None:
                            raise ValueError("missing current version")
                        if current["created_at"] + key["rotation_days"] * 86400 <= now:
                            due_version = current["version"]
                if expired:
                    report.expired += 1
                    warned.difference_update({p for p in warned if p[0] == key_id})
                    continue
                if due_version is None:
                    continue
                if vault.unlocked:
                    try:
                        out = KeyService(conn,vault,SYSTEM,now=now,t0=t0).rotate(key_id,expected_version=due_version)
                        if out["data"] is not None:
                            report.rotated += 1
                            warned.discard((key_id,due_version))
                        continue
                    except AppError as e:
                        if e.code != "VAULT_LOCKED":
                            raise
                        # A concurrent lock can invalidate the initial availability check.
                marker=(key_id,due_version)
                if marker not in warned:
                    with transaction(conn):
                        key=repo.get_key(conn,key_id)
                        if key is None or effective_state(key,now) != "active" or key["current_version"] != due_version:
                            continue
                        decisions.record(conn,SYSTEM,"rotation_deferred","ROTATION_DEFERRED",allowed=False,t0=t0,
                            key_id=key_id,version=due_version,rule="rotation_policy",
                            evidence={"rotation_days":key["rotation_days"]})
                    warned.add(marker)  # Only after successful commit.
                report.deferred += 1
            except Exception as e:
                report.errors += 1
                # Service errors already carry an audit entry. Failures in the
                # scheduler's own expiry/lookup path need their own safe event.
                if not isinstance(e, AppError):
                    try:
                        with transaction(conn):
                            decisions.record(conn,SYSTEM,"scheduler_failure","INTERNAL_ERROR",allowed=False,t0=t0,
                                key_id=key_id,error_type=type(e).__name__)
                    except Exception:
                        pass  # Unavailable audit storage must not kill the worker.
                logging.getLogger("keycycle.scheduler").error("Scheduler operation failed: %s",type(e).__name__)
        if len(rows) < SCHEDULER_BATCH:
            break
    with transaction(conn):
        conn.execute("DELETE FROM confirmations WHERE token_hash IN (SELECT token_hash FROM confirmations WHERE expires_at<=? LIMIT 500)",(now,))
    return report


class Scheduler:
    def __init__(self, db_path, vault, interval=SCHEDULER_INTERVAL_SECONDS):
        if interval <= 0:
            raise ValueError("scheduler interval must be positive")
        self.db_path,self.vault,self.interval=db_path,vault,interval
        self._stop=threading.Event()
        self._wake=threading.Event()
        self._guard=threading.Lock()
        self._thread=None
        self._warned=set()
        self._status=dict(last_tick=None,last_success=None,error_count=0,deferred_count=0)

    def start(self):
        with self._guard:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._wake.clear()
            self._warned.clear()
            self._thread=threading.Thread(target=self._run,name="keycycle-scheduler",daemon=True)
            self._thread.start()

    def wake(self):
        self._wake.set()

    def stop(self, timeout=None):
        self._stop.set()
        self._wake.set()
        thread=self._thread
        if thread is not None:
            thread.join(timeout)
            if thread.is_alive():
                raise RuntimeError("scheduler has not stopped")

    def status(self):
        with self._guard:
            return dict(self._status)

    def _run(self):
        while not self._stop.is_set():
            self._wake.clear()  # A wake during work stays set for the next iteration.
            conn=None
            now=int(time.time())
            try:
                conn=connect(self.db_path)
                report=run_due_once(conn,self.vault,now,self._warned,self._stop)
                with self._guard:
                    self._status.update(last_tick=now,deferred_count=report.deferred)
                    self._status["error_count"] += report.errors
                    if not report.errors:
                        self._status["last_success"]=now
            except Exception as e:
                with self._guard:
                    self._status["last_tick"]=now
                    self._status["error_count"] += 1
                logging.getLogger("keycycle.scheduler").error("Scheduler tick failed: %s",type(e).__name__)
            finally:
                if conn is not None:
                    conn.close()
            self._wake.wait(self.interval)
