"""Parameterized storage access. Transaction ownership stays in KeyService."""
from .key_policy import effective_state, utc


def get_key(conn, key_id):
    return conn.execute("SELECT * FROM keys WHERE id=?", (key_id,)).fetchone()


def get_version(conn, key_id, version):
    return conn.execute("SELECT * FROM key_versions WHERE key_id=? AND version=?", (key_id, version)).fetchone()


def metadata(conn, key, now, admin=False, detail=False, version_after=0, versions_limit=50):
    current = get_version(conn, key["id"], key["current_version"])
    if current is None or current["status"] != "current":
        raise ValueError("inconsistent current version")
    state = effective_state(key, now)
    data = {n: key[n] for n in ("id", "name", "algorithm", "purpose", "current_version", "rotation_days")}
    data.update(state=state, expires_at=utc(key["expires_at"]), created_at=utc(key["created_at"]),
                next_rotation_due=utc(current["created_at"] + key["rotation_days"] * 86400) if state == "active" else None)
    if detail:
        rows = conn.execute("SELECT version,status,created_at FROM key_versions WHERE key_id=? AND version>? ORDER BY version LIMIT ?",
                            (key["id"], version_after, versions_limit + 1)).fetchall()
        data["versions"] = [{"version": r["version"], "status": r["status"], "created_at": utc(r["created_at"])} for r in rows[:versions_limit]]
        data["versions_next_cursor"] = rows[versions_limit-1]["version"] if len(rows) > versions_limit else None
        data["revoked_at"] = utc(key["revoked_at"])
        if admin:
            data["created_by"] = conn.execute("SELECT username FROM users WHERE id=?", (key["created_by"],)).fetchone()[0]
            data["revoke_reason"] = key["revoke_reason"]
    return data
