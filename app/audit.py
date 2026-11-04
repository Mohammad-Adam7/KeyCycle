
import json
import sqlite3
from datetime import datetime, timezone

SECRET_KEYS = {"password", "passphrase", "token", "key", "plaintext", "vault_passphrase"}


def redact(details: dict | None) -> dict:
    return {k: ("[removed]" if k.lower() in SECRET_KEYS else v) for k, v in (details or {}).items()}


def record(conn: sqlite3.Connection, *, user: str = "anonymous", role: str = "none",
           action: str, target: str = "", outcome: str, severity: str = "info",
           reason: str = "", duration_ms: int = 0, details: dict | None = None) -> int:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    cur = conn.execute(
        "INSERT INTO audit_events(time,user,role,action,target,outcome,severity,reason,"
        "duration_ms,details,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (now, user, role, action, target, outcome, severity, reason, duration_ms,
         json.dumps(redact(details), sort_keys=True), "", ""),
    )
    return cur.lastrowid
