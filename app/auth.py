
import time
from dataclasses import dataclass

from fastapi import Request

from . import audit
from .db import get_setting
from .errors import AppError
from .security import same, token_hash

COOKIE = "kc_session"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

ALL = ("administrator", "operator", "viewer")
PERMISSIONS = {
    "manage_users": ("administrator",),
    "manage_settings": ("administrator",),
    "vault_control": ("administrator",),
    "manage_keys": ("administrator",),
    "use_key": ("administrator", "operator"),
    "view_keys": ALL,
    "view_results": ALL,
    "view_audit": ("administrator",),
    "backup_restore": ("administrator",),
    "export_report": ALL,
}
SENSITIVE = {"vault_control", "manage_keys", "use_key", "backup_restore", "manage_users", "manage_settings"}


@dataclass
class Principal:
    user_id: int
    username: str
    role: str
    csrf: str


def authenticate(request: Request) -> Principal:
    conn = request.state.conn
    token = request.cookies.get(COOKIE)
    if not token:
        raise AppError("SESSION_EXPIRED")
    now = int(time.time())
    row = conn.execute(
        "SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.username, u.role, u.disabled "
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (token_hash(token),)).fetchone()
    if row is None or row["disabled"]:
        raise AppError("SESSION_EXPIRED")
    if row["expires_at"] < now:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (row["token_hash"],))
        raise AppError("SESSION_EXPIRED")
    if request.method not in SAFE_METHODS:
        sent = request.headers.get("x-csrf-token", "")
        if not sent or not same(sent, row["csrf_token"]):
            audit.record(conn, user=row["username"], role=row["role"], action="csrf_check",
                         outcome="denied", severity="warning", reason="CSRF_INVALID")
            raise AppError("CSRF_INVALID")
    timeout = get_setting(conn, "session_timeout_minutes") * 60
    conn.execute("UPDATE sessions SET last_activity = ?, expires_at = ? WHERE token_hash = ?",
                 (now, now + timeout, row["token_hash"]))
    return Principal(row["id"], row["username"], row["role"], row["csrf_token"])


def require(request: Request, permission: str) -> Principal:
    p = authenticate(request)
    conn = request.state.conn
    if p.role not in PERMISSIONS[permission]:
        entry = audit.record(conn, user=p.username, role=p.role, action=permission,
                             target=request.url.path, outcome="denied", severity="warning",
                             reason="FORBIDDEN")
        raise AppError("FORBIDDEN", entry)
    if permission in SENSITIVE:
        limit = get_setting(conn, "rate_limit_per_minute")
        if not request.app.state.limiter.allow(p.user_id, limit):
            entry = audit.record(conn, user=p.username, role=p.role, action=permission,
                                 outcome="denied", severity="warning", reason="RATE_LIMITED")
            raise AppError("RATE_LIMITED", entry)
    return p


def permission(name: str):
    def dep(request: Request) -> Principal:
        return require(request, name)
    return dep
