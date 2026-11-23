"""Role-based security report generator (CSV and JSON).

Strictly adheres to Table 10 role sanitisation rules:
- Administrator: All records, including audit detail
- Operator: Own operations and outcomes, sanitised
- Viewer: Key information and decision outcomes, without user names or details

No report contains raw secrets, passphrases, tokens, or plaintext.
Every report embeds generation timestamp and current audit chain head.
"""
import csv
import io
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from . import audit
from .auth import Principal
from .key_policy import utc


def build_report_data(conn: sqlite3.Connection, principal: Principal) -> dict[str, Any]:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    chain = audit.head(conn)

    report: dict[str, Any] = {
        "report_title": "KeyCycle Security & Lifecycle Report",
        "generated_at": now,
        "chain_count": chain["entry_count"],
        "chain_head": chain["hash"],
        "exported_by": principal.username,
        "role": principal.role,
    }

    # 1. Keys data
    keys_rows = conn.execute("SELECT * FROM keys ORDER BY id").fetchall()
    keys_list = []
    for k in keys_rows:
        item: dict[str, Any] = {
            "id": k["id"],
            "name": k["name"],
            "algorithm": k["algorithm"],
            "purpose": k["purpose"],
            "state": k["state"],
            "current_version": k["current_version"],
            "rotation_days": k["rotation_days"],
            "expires_at": utc(k["expires_at"]),
            "created_at": utc(k["created_at"]),
        }
        if principal.role in ("administrator", "operator"):
            item["revoked_at"] = utc(k["revoked_at"])
        if principal.role == "administrator":
            creator = conn.execute("SELECT username FROM users WHERE id=?", (k["created_by"],)).fetchone()
            item["created_by"] = creator[0] if creator else "unknown"
            item["revoke_reason"] = k["revoke_reason"]
            versions = conn.execute(
                "SELECT version, status, created_at FROM key_versions WHERE key_id=? ORDER BY version",
                (k["id"],),
            ).fetchall()
            item["versions"] = [
                {"version": v["version"], "status": v["status"], "created_at": utc(v["created_at"])}
                for v in versions
            ]
        keys_list.append(item)
    report["keys"] = keys_list

    # 2. Audit Events & Decision Outcomes
    if principal.role == "administrator":
        events_rows = conn.execute("SELECT * FROM audit_events ORDER BY entry_no").fetchall()
        events_list = []
        for e in events_rows:
            try:
                details = json.loads(e["details"]) if e["details"] else {}
            except Exception:
                details = e["details"]
            events_list.append({
                "entry_no": e["entry_no"],
                "time": e["time"],
                "user": e["user"],
                "role": e["role"],
                "action": e["action"],
                "target": e["target"],
                "outcome": e["outcome"],
                "severity": e["severity"],
                "reason": e["reason"],
                "duration_ms": e["duration_ms"],
                "details": details,
                "prev_hash": e["prev_hash"],
                "hash": e["hash"],
            })
        report["audit_events"] = events_list

    elif principal.role == "operator":
        events_rows = conn.execute(
            "SELECT * FROM audit_events WHERE user=? ORDER BY entry_no",
            (principal.username,),
        ).fetchall()
        events_list = []
        for e in events_rows:
            events_list.append({
                "entry_no": e["entry_no"],
                "time": e["time"],
                "user": e["user"],
                "role": e["role"],
                "action": e["action"],
                "target": e["target"],
                "outcome": e["outcome"],
                "severity": e["severity"],
                "reason": e["reason"],
                "duration_ms": e["duration_ms"],
                "prev_hash": e["prev_hash"],
                "hash": e["hash"],
            })
        report["audit_events"] = events_list

    else:  # Viewer
        events_rows = conn.execute("SELECT * FROM audit_events ORDER BY entry_no").fetchall()
        events_list = []
        for e in events_rows:
            # Viewer gets decision outcomes without usernames, roles, or internal details
            events_list.append({
                "entry_no": e["entry_no"],
                "time": e["time"],
                "action": e["action"],
                "target": e["target"],
                "outcome": e["outcome"],
                "severity": e["severity"],
                "reason": e["reason"],
                "duration_ms": e["duration_ms"],
                "prev_hash": e["prev_hash"],
                "hash": e["hash"],
            })
        report["decision_outcomes"] = events_list

    # 3. Administrator extras: Users and Settings
    if principal.role == "administrator":
        users_rows = conn.execute("SELECT id, username, role, disabled, last_login, created_at FROM users ORDER BY id").fetchall()
        report["users"] = [
            {
                "id": u["id"],
                "username": u["username"],
                "role": u["role"],
                "disabled": bool(u["disabled"]),
                "last_login": utc(u["last_login"]),
                "created_at": utc(u["created_at"]),
            }
            for u in users_rows
        ]

        settings_rows = conn.execute("SELECT name, value, version, changed_by, changed_at FROM settings ORDER BY name").fetchall()
        report["settings"] = [
            {
                "name": s["name"],
                "value": s["value"],
                "version": s["version"],
                "changed_by": s["changed_by"],
                "changed_at": utc(s["changed_at"]),
            }
            for s in settings_rows
        ]

    return report


def format_json_report(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False)


_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _neutralise(value):
    """Stop spreadsheets from executing text as a formula (CSV injection)."""
    if isinstance(value, str) and value.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


class _SafeWriter:
    def __init__(self, buf):
        self._writer = csv.writer(buf)

    def writerow(self, row):
        self._writer.writerow([_neutralise(cell) for cell in row])


def format_csv_report(data: dict[str, Any]) -> str:
    buf = io.StringIO()
    writer = _SafeWriter(buf)

    # Metadata Header Comments
    writer.writerow(["# KeyCycle Security & Lifecycle Report"])
    writer.writerow([f"# Generated at: {data['generated_at']}"])
    writer.writerow([f"# Chain count: {data['chain_count']}"])
    writer.writerow([f"# Chain head: {data['chain_head']}"])
    writer.writerow([f"# Exported by: {data['exported_by']} ({data['role']})"])
    writer.writerow([])

    # Keys Section
    writer.writerow(["# --- KEYS ---"])
    keys = data.get("keys", [])
    if keys:
        keys_headers = list(keys[0].keys())
        # Filter out nested objects like versions for flat CSV
        flat_headers = [h for h in keys_headers if h != "versions"]
        writer.writerow(flat_headers)
        for k in keys:
            writer.writerow([k.get(h, "") for h in flat_headers])
    else:
        writer.writerow(["No keys recorded"])
    writer.writerow([])

    # Audit Events / Decision Outcomes Section
    events = data.get("audit_events") or data.get("decision_outcomes") or []
    section_name = "# --- AUDIT EVENTS ---" if "audit_events" in data else "# --- DECISION OUTCOMES ---"
    writer.writerow([section_name])
    if events:
        events_headers = [h for h in events[0].keys() if h != "details"]
        if "details" in events[0]:
            events_headers.append("details")
        writer.writerow(events_headers)
        for e in events:
            row = []
            for h in events_headers:
                val = e.get(h, "")
                if isinstance(val, (dict, list)):
                    val = json.dumps(val)
                row.append(val)
            writer.writerow(row)
    else:
        writer.writerow(["No events recorded"])
    writer.writerow([])

    # Users Section (Admin only)
    if "users" in data:
        writer.writerow(["# --- USERS ---"])
        users = data["users"]
        if users:
            users_headers = list(users[0].keys())
            writer.writerow(users_headers)
            for u in users:
                writer.writerow([u.get(h, "") for h in users_headers])
        else:
            writer.writerow(["No users recorded"])
        writer.writerow([])

    # Settings Section (Admin only)
    if "settings" in data:
        writer.writerow(["# --- SETTINGS ---"])
        settings = data["settings"]
        if settings:
            settings_headers = list(settings[0].keys())
            writer.writerow(settings_headers)
            for s in settings:
                writer.writerow([s.get(h, "") for h in settings_headers])
        else:
            writer.writerow(["No settings recorded"])

    return buf.getvalue()
