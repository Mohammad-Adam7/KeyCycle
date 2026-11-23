import time
from typing import Any

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import audit, backup, confirmations
from .auth import COOKIE, Principal, permission
from .config import PASSWORD_MAX
from .db import transaction
from .errors import AppError
from .security import token_hash
from .vault import VaultLocked

router = APIRouter()


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class BackupCreateIn(Strict):
    confirmation_token: str = Field(min_length=1, max_length=100)


class BackupRestoreIn(BackupCreateIn):
    passphrase: str = Field(min_length=1, max_length=PASSWORD_MAX)


class RecoveryDrillIn(BackupRestoreIn):
    backup_name: str = Field(min_length=1, max_length=128)


def _session_hash(request: Request) -> str:
    return token_hash(request.cookies[COOKIE])


def _target(action: str, name: str | None = None) -> str:
    return "backup:create" if action == "backup" else f"backup:{name}"


def _record_failure(request: Request, p: Principal, action: str, code: str,
                    *, severity="warning", details=None):
    entry = audit.record(request.state.conn, user=p.username, role=p.role,
                         action=action, target=details.get("backup_name", "") if details else "",
                         outcome="failure" if code in ("BACKUP_INVALID", "TAMPER_DETECTED") else "denied",
                         severity=severity, reason=code, details=details)
    result = details if code == "TAMPER_DETECTED" else None
    raise AppError(code, entry, result)


def _parse(model, raw, request, p, action):
    try:
        return model.model_validate(raw, strict=True)
    except ValidationError:
        _record_failure(request, p, action, "INVALID_INPUT")


def _confirmation(conn, request, p, action, target, raw, now):
    row = confirmations.validate_target(conn, p, _session_hash(request), action, target, raw, now)
    if row is None:
        raise AppError("CONFIRMATION_REQUIRED")
    return row


def issue_confirmation(request: Request, p: Principal, body) -> dict:
    now = int(time.time())
    target = _target(body.action, body.backup_name)
    if body.backup_name is not None:
        try:
            request.app.state.backup_store._path(body.backup_name)
        except backup.BackupInvalid:
            _record_failure(request, p, "confirmation_issue", "INVALID_INPUT")
    with transaction(request.state.conn):
        raw = confirmations.issue_target(request.state.conn, p, _session_hash(request),
                                         body.action, target, None, now)
        entry = audit.record(request.state.conn, user=p.username, role=p.role,
                             action="confirmation_issue", target=target,
                             outcome="success", details={"confirmation_action": body.action})
    return {"result": {"decision": "allowed", "reason": {"code": "CONFIRMATION_ISSUED",
                                                             "message": "Confirmation issued."},
                       "audit_entry": entry},
            "data": {"confirmation_token": raw, "action": body.action,
                     "backup_name": body.backup_name, "expires_in": 300}}


@router.get("/backups")
def list_backups(request: Request, p: Principal = Depends(permission("backup_restore"))):
    if request.query_params:
        _record_failure(request, p, "backup_list", "INVALID_INPUT")
    return {"data": {"items": request.app.state.backup_store.list()}}


@router.post("/backups", status_code=201)
def create_backup(request: Request, p: Principal = Depends(permission("backup_restore")),
                  raw: Any = Body(None)):
    body = _parse(BackupCreateIn, raw, request, p, "backup_create")
    conn, now, written = request.state.conn, int(time.time()), None
    try:
        with transaction(conn):
            confirmation = _confirmation(conn, request, p, "backup", "backup:create",
                                         body.confirmation_token, now)
            verified = audit.verify(conn)
            if not verified["valid"]:
                raise AppError("TAMPER_DETECTED", result={"first_mismatch": verified["first_mismatch"],
                                                          "reason": verified["reason"]})
            key = request.app.state.vault.backup_auth_key()
            content = backup.make_content(conn, request.app.state.vault)
            raw_backup = backup.seal(content, key)
            name, written = request.app.state.backup_store.write(raw_backup)
            confirmations.consume(conn, confirmation, now)
            entry = audit.record(conn, user=p.username, role=p.role, action="backup_create",
                                 target=name, outcome="success",
                                 details={"backup_name": name, "size": len(raw_backup),
                                          "backup_head": content["chain_head"]})
    except AppError as error:
        if written is not None:
            written.unlink(missing_ok=True)
        if error.code == "CONFIRMATION_REQUIRED":
            _record_failure(request, p, "backup_create", error.code)
        _record_failure(request, p, "backup_create", error.code,
                        severity="critical" if error.code == "TAMPER_DETECTED" else "warning",
                        details=error.result)
    except VaultLocked:
        if written is not None:
            written.unlink(missing_ok=True)
        _record_failure(request, p, "backup_create", "VAULT_LOCKED")
    except backup.BackupInvalid:
        if written is not None:
            written.unlink(missing_ok=True)
        _record_failure(request, p, "backup_create", "BACKUP_INVALID")
    except Exception:
        if written is not None:
            written.unlink(missing_ok=True)
        _record_failure(request, p, "backup_create", "INTERNAL_ERROR", severity="critical")
    return {"result": {"decision": "allowed", "reason": {"code": "BACKUP_CREATED",
                                                             "message": "Backup created."},
                       "audit_entry": entry},
            "data": {"name": name, "size": len(raw_backup),
                     "chain_head": content["chain_head"]}}


@router.post("/backups/{name}/verify")
def verify_backup(name: str, request: Request,
                  p: Principal = Depends(permission("backup_restore"))):
    checked = None
    try:
        key = request.app.state.vault.backup_auth_key()
        content, _tables, checked = backup.load_verified(request.app.state.backup_store,
                                                         name, key=key)
    except VaultLocked:
        _record_failure(request, p, "backup_verify", "VAULT_LOCKED",
                        details={"backup_name": name})
    except backup.BackupInvalid:
        _record_failure(request, p, "backup_verify", "BACKUP_INVALID",
                        details={"backup_name": name})
    finally:
        if checked is not None:
            checked.close()
    entry = audit.record(request.state.conn, user=p.username, role=p.role,
                         action="backup_verify", target=name, outcome="success",
                         details={"backup_name": name, "backup_head": content["chain_head"]})
    return {"result": {"valid": True, "audit_entry": entry},
            "data": {"name": name, "chain_head": content["chain_head"]}}


@router.post("/backups/{name}/restore")
def restore_backup(name: str, request: Request,
                   p: Principal = Depends(permission("backup_restore")), raw: Any = Body(None)):
    body = _parse(BackupRestoreIn, raw, request, p, "backup_restore")
    checked = None
    try:
        content, tables, checked = backup.load_verified(request.app.state.backup_store, name,
                                                         passphrase=body.passphrase)
        now = int(time.time())
        evidence = None
        if not audit.verify(request.state.conn)["valid"]:
            # The restore will replace a log that failed verification: keep a copy first.
            evidence = backup.preserve_evidence(request.state.conn,
                                                request.app.state.backup_store.folder.parent / "evidence")
        with transaction(request.state.conn):
            confirmation = _confirmation(request.state.conn, request, p, "restore",
                                         _target("restore", name), body.confirmation_token, now)
            confirmations.consume(request.state.conn, confirmation, now)
            request.app.state.vault.lock()
            restore_result = backup.restore(request.state.conn, tables, content)
            if evidence:
                restore_result["evidence_copy"] = evidence
            entry = audit.record(request.state.conn, user=p.username, role=p.role,
                                 action="backup_restore", target=name, outcome="success",
                                 severity="warning",
                                 details={"backup_name": name, **restore_result})
    except AppError as error:
        _record_failure(request, p, "backup_restore", error.code,
                        details={"backup_name": name})
    except backup.BackupInvalid:
        _record_failure(request, p, "backup_restore", "BACKUP_INVALID",
                        details={"backup_name": name})
    except Exception:
        _record_failure(request, p, "backup_restore", "INTERNAL_ERROR", severity="critical",
                        details={"backup_name": name})
    finally:
        if checked is not None:
            checked.close()
    return {"result": {"decision": "allowed", "reason": {"code": "BACKUP_RESTORED",
                                                             "message": "Backup restored."},
                       "audit_entry": entry},
            "data": {"name": name, "vault": "locked", **restore_result}}


@router.post("/recovery-drill")
def recovery_drill(request: Request, p: Principal = Depends(permission("backup_restore")),
                   raw: Any = Body(None)):
    body = _parse(RecoveryDrillIn, raw, request, p, "recovery_drill")
    name = body.backup_name
    if request.query_params:
        _record_failure(request, p, "recovery_drill", "INVALID_INPUT")
    checked = None
    try:
        content, _tables, checked = backup.load_verified(request.app.state.backup_store, name,
                                                          passphrase=body.passphrase)
        proof = backup.verify_recovery_proof(checked, content, body.passphrase)
        if not proof:
            raise backup.BackupInvalid()
        now = int(time.time())
        with transaction(request.state.conn):
            confirmation = _confirmation(request.state.conn, request, p, "recovery_drill",
                                         _target("recovery_drill", name),
                                         body.confirmation_token, now)
            confirmations.consume(request.state.conn, confirmation, now)
            entry = audit.record(request.state.conn, user=p.username, role=p.role,
                                 action="recovery_drill", target=name, outcome="success",
                                 details={"backup_name": name, "backup_verified": True,
                                          "audit_verified": True, "decryption_proof": True})
    except AppError as error:
        _record_failure(request, p, "recovery_drill", error.code,
                        details={"backup_name": name})
    except backup.BackupInvalid:
        _record_failure(request, p, "recovery_drill", "BACKUP_INVALID",
                        details={"backup_name": name})
    finally:
        if checked is not None:
            checked.close()
    return {"result": {"decision": "allowed", "reason": {"code": "RECOVERY_DRILL_PASSED",
                                                             "message": "Recovery drill passed."},
                       "audit_entry": entry},
            "data": {"name": name, "steps": [
                {"step": "authenticate_backup", "passed": True},
                {"step": "verify_audit_chain", "passed": True},
                {"step": "restore_in_isolation", "passed": True},
                {"step": "decrypt_recovery_proof", "passed": True},
            ]}}
