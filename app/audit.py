
"""Tamper-evident, append-only security audit log."""
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

GENESIS_HASH = "0" * 64
AUDIT_FIELDS = (
    "entry_no", "time", "user", "role", "action", "target", "outcome",
    "severity", "reason", "duration_ms", "details", "prev_hash",
)
SECRET_KEYS = {
    "password", "passphrase", "vault_passphrase", "plaintext", "token", "key",
    "session_token", "csrf_token", "confirmation_token", "master_key",
    "wrapped_key", "key_material",
}


def _redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "[removed]" if str(key).lower() in SECRET_KEYS else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact(item) for item in value]
    return value


def redact(details: dict | None) -> dict:
    """Remove secret-bearing fields recursively before serialisation."""
    return _redact(details or {})


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def payload(values: Mapping[str, Any]) -> dict:
    """Return the exact, versioned set of fields committed by an entry hash."""
    return {name: values[name] for name in AUDIT_FIELDS}


def calculate_hash(values: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(payload(values))).hexdigest()


def _insert(conn: sqlite3.Connection, *, user: str, role: str, action: str,
            target: str, outcome: str, severity: str, reason: str,
            duration_ms: int, details: dict | None) -> int:
    previous = conn.execute(
        "SELECT hash FROM audit_events ORDER BY entry_no DESC LIMIT 1"
    ).fetchone()
    prev_hash = previous["hash"] if previous else GENESIS_HASH
    entry_no = conn.execute(
        "SELECT COALESCE(MAX(entry_no), 0) + 1 FROM audit_events"
    ).fetchone()[0]
    values = {
        "entry_no": entry_no,
        "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "user": user,
        "role": role,
        "action": action,
        "target": target,
        "outcome": outcome,
        "severity": severity,
        "reason": reason,
        "duration_ms": duration_ms,
        "details": json.dumps(redact(details), sort_keys=True, separators=(",", ":"),
                              ensure_ascii=False),
        "prev_hash": prev_hash,
    }
    digest = calculate_hash(values)
    conn.execute(
        "INSERT INTO audit_events(entry_no,time,user,role,action,target,outcome,severity,reason,"
        "duration_ms,details,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (*(values[name] for name in AUDIT_FIELDS), digest),
    )
    return entry_no


def record(conn: sqlite3.Connection, *, user: str = "anonymous", role: str = "none",
           action: str, target: str = "", outcome: str, severity: str = "info",
           reason: str = "", duration_ms: int = 0, details: dict | None = None) -> int:
    """Append one entry, serialising standalone writers with BEGIN IMMEDIATE."""
    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        entry_no = _insert(conn, user=user, role=role, action=action, target=target,
                           outcome=outcome, severity=severity, reason=reason,
                           duration_ms=duration_ms, details=details)
        if owns_transaction:
            conn.execute("COMMIT")
        return entry_no
    except BaseException:
        if owns_transaction and conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def head(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT entry_no, hash FROM audit_events ORDER BY entry_no DESC LIMIT 1"
    ).fetchone()
    return {
        "entry_count": int(row["entry_no"]) if row else 0,
        "hash": row["hash"] if row else GENESIS_HASH,
    }


def verify_rows(rows: Iterable[Mapping[str, Any]], *, expected_count: int | None = None,
                expected_hash: str | None = None,
                anchors: Iterable[tuple[int, str]] = ()) -> dict:
    """``anchors`` are (entry_no, hash) pairs remembered OUTSIDE the database.  An
    anchored entry must still exist with the same hash, which catches tail
    truncation and a full re-hash of history even when the chain is self-consistent."""
    anchors = [(int(n), h) for n, h in anchors]
    wanted = {n for n, _ in anchors}
    seen: dict[int, str] = {}
    previous = GENESIS_HASH
    count = 0
    for row in rows:
        expected_entry = count + 1
        entry_no = int(row["entry_no"])
        if entry_no != expected_entry:
            return {"valid": False, "first_mismatch": expected_entry,
                    "reason": "ENTRY_SEQUENCE", "entry_count": count, "hash": previous}
        if row["prev_hash"] != previous:
            return {"valid": False, "first_mismatch": entry_no,
                    "reason": "PREVIOUS_HASH", "entry_count": count, "hash": previous}
        calculated = calculate_hash(row)
        if row["hash"] != calculated:
            return {"valid": False, "first_mismatch": entry_no,
                    "reason": "ENTRY_HASH", "entry_count": count, "hash": previous}
        previous, count = row["hash"], entry_no
        if count in wanted:
            seen[count] = row["hash"]
    for number, digest in anchors:
        if number > count:
            return {"valid": False, "first_mismatch": count + 1, "reason": "CHAIN_TRUNCATED",
                    "entry_count": count, "hash": previous}
        if seen.get(number) != digest:
            return {"valid": False, "first_mismatch": number, "reason": "ANCHOR_MISMATCH",
                    "entry_count": count, "hash": previous}
    if expected_count is not None and count != expected_count:
        return {"valid": False, "first_mismatch": min(count, expected_count) + 1,
                "reason": "CHAIN_HEAD_COUNT", "entry_count": count, "hash": previous}
    if expected_hash is not None and previous != expected_hash:
        return {"valid": False, "first_mismatch": count or 1,
                "reason": "CHAIN_HEAD_HASH", "entry_count": count, "hash": previous}
    return {"valid": True, "first_mismatch": None, "reason": None,
            "entry_count": count, "hash": previous}


def verify(conn: sqlite3.Connection, *, expected_count: int | None = None,
           expected_hash: str | None = None, anchors: Iterable[tuple[int, str]] = ()) -> dict:
    rows = conn.execute("SELECT * FROM audit_events ORDER BY entry_no").fetchall()
    return verify_rows(rows, expected_count=expected_count, expected_hash=expected_hash,
                       anchors=anchors)


def migrate_legacy(conn: sqlite3.Connection) -> bool:
    """Chain only pre-Part-C rows whose hash fields were never populated."""
    rows = conn.execute("SELECT * FROM audit_events ORDER BY entry_no").fetchall()
    if not rows or any(row["prev_hash"] or row["hash"] for row in rows):
        return False
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DROP TRIGGER IF EXISTS audit_no_update")
        previous = GENESIS_HASH
        for row in rows:
            values = dict(row)
            values["prev_hash"] = previous
            digest = calculate_hash(values)
            conn.execute("UPDATE audit_events SET prev_hash=?, hash=? WHERE entry_no=?",
                         (previous, digest, row["entry_no"]))
            previous = digest
        conn.execute("CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events "
                     "BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END")
        conn.execute("COMMIT")
        return True
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
