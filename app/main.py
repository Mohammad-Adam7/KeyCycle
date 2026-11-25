import os
import time
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import audit
from .auth import COOKIE, Principal, authenticate, permission
from .config import (ANON_DENIED_AUDIT_PER_MINUTE, FAILED_LOGIN_WINDOW_SECONDS, ANON_FAILED_LOGIN_AUDIT_PER_MINUTE,
                     MAX_BODY_BYTES, SETTINGS, kdf_params)
from .db import connect, get_setting, init_db, transaction
from .errors import AppError
from .models import LoginIn, PasswordChangeIn, SetupIn, SettingPatch, UnlockIn, UserCreate, UserPatch
from .bodylimit import BodyLimit
from .security import AuditBudget, FailureTracker, RateLimiter, make_hasher, new_token, token_hash, verify_password
from .vault import Vault
from .key_routes import router as key_router
from .scheduler import Scheduler
from .audit_routes import router as audit_router
from .backup import Store as BackupStore
from .backup_routes import router as backup_router
from .maintenance import MaintenanceBarrier
from .report_routes import router as report_router
from .ui_routes import router as ui_router
from fastapi.staticfiles import StaticFiles
from pathlib import Path

LOGIN_PER_MINUTE_PER_ADDRESS = 20

HEADERS = {
    # Scripts and stylesheets only from this origin. Inline style ATTRIBUTES (display:none and
    # similar in the page markup) are allowed because they cannot run code; without this the
    # browser ignores them and hidden panels such as the setup form appear.
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
                               "frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}


def error_response(e: AppError) -> JSONResponse:
    body = {"code": e.code, "message": e.message, "audit_entry": e.audit_entry}
    if e.result is not None:
        body["result"] = e.result
    return JSONResponse(body, status_code=e.status)


def create_app(db_path: str | None = None, *, scheduler_interval: float = 30.0) -> FastAPI:
    db_path = db_path or os.environ.get("KEYCYCLE_DB", "keycycle.db")
    init_db(db_path)
    startup_conn = connect(db_path)
    try:
        startup_conn.execute("DELETE FROM confirmations")
    finally:
        startup_conn.close()
    @asynccontextmanager
    async def lifespan(application):
        application.state.scheduler.start()
        try:
            yield
        finally:
            await asyncio.to_thread(application.state.scheduler.stop)
            application.state.vault.lock()

    app = FastAPI(title="KeyCycle", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.db_path = db_path
    app.state.backup_store = BackupStore(Path(db_path).resolve().parent / "backups")
    app.state.maintenance = MaintenanceBarrier()
    app.state.vault = Vault()
    app.state.scheduler = Scheduler(db_path, app.state.vault, scheduler_interval)
    app.state.limiter = RateLimiter()
    app.state.login_throttle = RateLimiter()
    app.state.audit_budget = AuditBudget()
    app.state.failures = FailureTracker()
    app.state.hasher = make_hasher()
    app.state.dummy_hash = app.state.hasher.hash("keycycle-dummy-password")

    @app.middleware("http")
    async def wrap(request: Request, call_next):
        exclusive = (request.method == "POST" and request.url.path.startswith("/api/backups/")
                     and request.url.path.endswith("/restore"))
        await asyncio.to_thread(app.state.maintenance.enter, exclusive)
        request.state.t0 = time.perf_counter()
        conn = None
        try:
            conn = connect(db_path)
            request.state.conn = conn
            resp = await call_next(request)
        finally:
            if conn is not None:
                conn.close()
            app.state.maintenance.leave(exclusive)
        for k, v in HEADERS.items():
            resp.headers[k] = v
        if request.url.path.startswith("/api"):
            resp.headers["Cache-Control"] = "no-store"
        elif request.url.path.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.exception_handler(AppError)
    async def _app_error(request, e):
        return error_response(e)

    @app.exception_handler(RequestValidationError)
    async def _invalid(request, e):
        return error_response(AppError("INVALID_INPUT"))

    @app.exception_handler(Exception)
    async def _internal(request, e):
        return error_response(AppError("INTERNAL_ERROR"))

    def anonymous_audit(bucket: str, limit: int, conn, **record):
        """Audit an unauthenticated event within a per-minute budget; returns the entry or None."""
        verdict, carried = app.state.audit_budget.admit(bucket, limit)
        if verdict == "skip":
            return None
        if verdict == "summary":
            return audit.record(conn, user="anonymous", action=record["action"], outcome="denied",
                                severity="warning", reason="AUDIT_SUPPRESSED",
                                details={"bucket": bucket, "limit_per_minute": limit})
        if carried:
            record["details"] = {**(record.get("details") or {}), "suppressed_in_previous_window": carried}
        return audit.record(conn, **record)

    @app.post("/api/setup", status_code=201)
    def setup(body: SetupIn, request: Request):
        conn = request.state.conn
        # Hash outside the write lock; the existence check and every insert then
        # share ONE transaction so concurrent setups cannot each create an admin
        # and a failed setup cannot leave a half-initialised database behind.
        password_hash = app.state.hasher.hash(body.password)
        closed = False
        with transaction(conn):
            if conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                closed = True
            else:
                conn.execute("INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)",
                             (body.username, password_hash, "administrator", int(time.time())))
                app.state.vault.initialise(conn, body.vault_passphrase, kdf_params())
                audit.record(conn, user=body.username, role="administrator", action="setup", outcome="success")
        if closed:
            entry = anonymous_audit("anon_denied", ANON_DENIED_AUDIT_PER_MINUTE, conn, action="setup",
                                    outcome="denied", severity="warning", reason="SETUP_CLOSED")
            raise AppError("SETUP_CLOSED", entry)
        return {"username": body.username, "role": "administrator", "vault": "locked"}

    @app.post("/api/auth/login")
    def login(body: LoginIn, request: Request, response: Response):
        conn, now = request.state.conn, int(time.time())
        client = request.client.host if request.client else "unknown"
        if not app.state.login_throttle.allow(client, LOGIN_PER_MINUTE_PER_ADDRESS):
            entry = anonymous_audit("anon_denied", ANON_DENIED_AUDIT_PER_MINUTE, conn, user=body.username,
                                    action="login", outcome="denied", severity="warning", reason="RATE_LIMITED")
            raise AppError("RATE_LIMITED", entry)
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))   # tidy expired sessions
        limit = get_setting(conn, "failed_logins_before_lockout")
        lock_s = get_setting(conn, "lockout_minutes") * 60
        user = conn.execute("SELECT * FROM users WHERE username = ?", (body.username,)).fetchone()
        key = "login:" + body.username.lower()
        tracker = app.state.failures

        def too_many():
            entry = anonymous_audit("anon_denied", ANON_DENIED_AUDIT_PER_MINUTE, conn, user=body.username,
                                    action="login", outcome="denied", severity="warning", reason="TOO_MANY_ATTEMPTS")
            return AppError("TOO_MANY_ATTEMPTS", entry)

        if (user and user["locked_until"] > now) or (not user and tracker.locked(conn, key)):
            raise too_many()
        stored = user["password_hash"] if user else app.state.dummy_hash   # equal work either way
        ok = verify_password(app.state.hasher, stored, body.password) and user is not None and not user["disabled"]
        if not ok:
            if user:
                window_key = "loginwin:" + body.username.lower()
                last = conn.execute("SELECT updated_at FROM failures WHERE key = ?", (window_key,)).fetchone()
                # Failures older than the window are forgotten rather than added up forever.
                fresh = last is not None and now - last["updated_at"] <= FAILED_LOGIN_WINDOW_SECONDS
                count = (user["failed_count"] if fresh else 0) + 1
                if count >= limit:
                    conn.execute("UPDATE users SET failed_count=0, locked_until=? WHERE id=?", (now + lock_s, user["id"]))
                    conn.execute("DELETE FROM failures WHERE key = ?", (window_key,))
                else:
                    conn.execute("UPDATE users SET failed_count=? WHERE id=?", (count, user["id"]))
                    conn.execute("INSERT INTO failures(key,count,locked_until,updated_at) VALUES (?,0,0,?) "
                                 "ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at", (window_key, now))
            else:
                tracker.fail(conn, key, limit, lock_s)
            if user:   # bounded already: the account locks after a few failures
                entry = audit.record(conn, user=body.username, action="login", outcome="failure",
                                     severity="warning", reason="AUTH_FAILED")
            else:      # unknown usernames are unbounded in number, so budget them
                entry = anonymous_audit("anon_failed_login", ANON_FAILED_LOGIN_AUDIT_PER_MINUTE, conn,
                                        user=body.username, action="login", outcome="failure",
                                        severity="warning", reason="AUTH_FAILED")
            raise AppError("AUTH_FAILED", entry)
        conn.execute("UPDATE users SET failed_count=0, locked_until=0, last_login=? WHERE id=?", (now, user["id"]))
        conn.execute("DELETE FROM failures WHERE key = ?", ("loginwin:" + user["username"].lower(),))
        token, csrf = new_token(), new_token()
        timeout = get_setting(conn, "session_timeout_minutes") * 60
        conn.execute("INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_activity,expires_at) "
                     "VALUES (?,?,?,?,?,?)", (token_hash(token), user["id"], csrf, now, now, now + timeout))
        response.set_cookie(COOKIE, token, httponly=True, samesite="strict",
                            secure=request.url.scheme == "https", path="/")
        audit.record(conn, user=user["username"], role=user["role"], action="login", outcome="success")
        return {"username": user["username"], "role": user["role"], "csrf_token": csrf, "expires_in": timeout}

    @app.post("/api/auth/password")
    def change_password(body: PasswordChangeIn, request: Request, p: Principal = Depends(authenticate)):
        conn, now = request.state.conn, int(time.time())
        key = f"password:{p.user_id}"
        limit = get_setting(conn, "failed_logins_before_lockout")
        lock_s = get_setting(conn, "lockout_minutes") * 60
        if app.state.failures.locked(conn, key):
            entry = audit.record(conn, user=p.username, role=p.role, action="password_change",
                                 outcome="denied", severity="warning", reason="TOO_MANY_ATTEMPTS")
            raise AppError("TOO_MANY_ATTEMPTS", entry)
        stored = conn.execute("SELECT password_hash FROM users WHERE id = ?", (p.user_id,)).fetchone()["password_hash"]
        if not verify_password(app.state.hasher, stored, body.current_password):
            app.state.failures.fail(conn, key, limit, lock_s)
            entry = audit.record(conn, user=p.username, role=p.role, action="password_change",
                                 outcome="denied", severity="warning", reason="PASSWORD_INVALID")
            raise AppError("PASSWORD_INVALID", entry)
        if body.new_password == body.current_password:
            entry = audit.record(conn, user=p.username, role=p.role, action="password_change",
                                 outcome="denied", severity="warning", reason="INVALID_INPUT")
            raise AppError("INVALID_INPUT", entry)
        app.state.failures.reset(conn, key)
        new_hash = app.state.hasher.hash(body.new_password)
        current_session = token_hash(request.cookies[COOKIE])
        with transaction(conn):
            conn.execute("UPDATE users SET password_hash=?, failed_count=0, locked_until=0 WHERE id=?",
                         (new_hash, p.user_id))
            ended = conn.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
                                 (p.user_id, current_session)).rowcount
            audit.record(conn, user=p.username, role=p.role, action="password_change",
                         outcome="success", details={"other_sessions_ended": ended})
        return {"status": "password changed", "other_sessions_ended": ended}

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response):
        p = authenticate(request)
        conn = request.state.conn
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(request.cookies[COOKIE]),))
        audit.record(conn, user=p.username, role=p.role, action="logout", outcome="success")
        response.delete_cookie(COOKIE, path="/")
        return {"status": "signed out"}

    @app.get("/api/auth/session")
    def session(request: Request):
        p = authenticate(request)
        return {"username": p.username, "role": p.role, "csrf_token": p.csrf}

    @app.get("/api/vault/status")
    def vault_status(request: Request):
        authenticate(request)
        return {"locked": not app.state.vault.unlocked}

    @app.post("/api/vault/unlock")
    def vault_unlock(body: UnlockIn, request: Request, p: Principal = Depends(permission("vault_control"))):
        conn = request.state.conn
        key = f"unlock:{p.user_id}"
        limit = get_setting(conn, "failed_logins_before_lockout")
        lock_s = get_setting(conn, "lockout_minutes") * 60
        if app.state.failures.locked(conn, key):
            entry = audit.record(conn, user=p.username, role=p.role, action="vault_unlock",
                                 outcome="denied", severity="warning", reason="TOO_MANY_ATTEMPTS")
            raise AppError("TOO_MANY_ATTEMPTS", entry)
        if not app.state.vault.unlock(conn, body.passphrase):
            app.state.failures.fail(conn, key, limit, lock_s)
            entry = audit.record(conn, user=p.username, role=p.role, action="vault_unlock",
                                 outcome="failure", severity="warning", reason="PASSPHRASE_INVALID")
            raise AppError("PASSPHRASE_INVALID", entry)
        app.state.failures.reset(conn, key)
        audit.record(conn, user=p.username, role=p.role, action="vault_unlock", outcome="success")
        app.state.scheduler.wake()
        return {"locked": False}

    @app.post("/api/vault/lock")
    def vault_lock(request: Request, p: Principal = Depends(permission("vault_control"))):
        app.state.vault.lock()
        audit.record(request.state.conn, user=p.username, role=p.role, action="vault_lock", outcome="success")
        return {"locked": True}

    @app.get("/api/users")
    def list_users(request: Request, p: Principal = Depends(permission("manage_users"))):
        rows = request.state.conn.execute(
            "SELECT id, username, role, disabled, last_login FROM users ORDER BY id").fetchall()
        return [dict(r) for r in rows]

    @app.post("/api/users", status_code=201)
    def create_user(body: UserCreate, request: Request, p: Principal = Depends(permission("manage_users"))):
        conn = request.state.conn
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (body.username,)).fetchone():
            raise AppError("INVALID_INPUT")
        cur = conn.execute("INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)",
                           (body.username, app.state.hasher.hash(body.password), body.role, int(time.time())))
        audit.record(conn, user=p.username, role=p.role, action="user_create", target=body.username,
                     outcome="success", details={"role": body.role})
        return {"id": cur.lastrowid, "username": body.username, "role": body.role}

    @app.patch("/api/users/{user_id}")
    def patch_user(user_id: int, body: UserPatch, request: Request,
                   p: Principal = Depends(permission("manage_users"))):
        conn = request.state.conn
        target = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if target is None:
            raise AppError("INVALID_INPUT")
        role = body.role or target["role"]
        disabled = target["disabled"] if body.disabled is None else int(body.disabled)
        other_admins = conn.execute("SELECT COUNT(*) FROM users WHERE role='administrator' AND disabled=0 AND id<>?",
                                    (user_id,)).fetchone()[0]
        if other_admins == 0 and (role != "administrator" or disabled):
            raise AppError("INVALID_INPUT")        # the last administrator cannot be removed
        conn.execute("UPDATE users SET role=?, disabled=? WHERE id=?", (role, disabled, user_id))
        if disabled:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        audit.record(conn, user=p.username, role=p.role, action="user_change", target=target["username"],
                     outcome="success", details={"role": role, "disabled": bool(disabled)})
        return {"id": user_id, "role": role, "disabled": bool(disabled)}

    @app.get("/api/settings")
    def list_settings(request: Request, p: Principal = Depends(permission("manage_settings"))):
        rows = {r["name"]: r for r in request.state.conn.execute("SELECT * FROM settings")}
        return [{"name": n, "label": lab, "value": rows[n]["value"], "version": rows[n]["version"],
                 "minimum": lo, "maximum": hi, "changed_by": rows[n]["changed_by"]}
                for n, (_d, lo, hi, lab) in SETTINGS.items()]

    @app.patch("/api/settings/{name}")
    def patch_setting(name: str, body: SettingPatch, request: Request,
                      p: Principal = Depends(permission("manage_settings"))):
        conn = request.state.conn
        if name not in SETTINGS:
            raise AppError("INVALID_INPUT")
        _d, lo, hi, _l = SETTINGS[name]
        if not lo <= body.value <= hi:
            entry = audit.record(conn, user=p.username, role=p.role, action="setting_change", target=name,
                                 outcome="failure", severity="warning", reason="SETTING_OUT_OF_RANGE",
                                 details={"value": body.value})
            raise AppError("SETTING_OUT_OF_RANGE", entry)
        old = get_setting(conn, name)
        conn.execute("UPDATE settings SET value=?, version=version+1, changed_by=?, changed_at=? WHERE name=?",
                     (body.value, p.username, int(time.time()), name))
        audit.record(conn, user=p.username, role=p.role, action="setting_change", target=name,
                     outcome="success", details={"old": old, "new": body.value})
        return {"name": name, "value": body.value}

    app.include_router(key_router, prefix="/api")
    app.include_router(audit_router, prefix="/api")
    app.include_router(backup_router, prefix="/api")
    app.include_router(report_router, prefix="/api")
    app.include_router(report_router)

    static_dir = Path(__file__).resolve().parent / "static"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    app.include_router(ui_router)

    app.add_middleware(BodyLimit, limit=MAX_BODY_BYTES)
    return app
