import json
import re
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from . import audit
from .auth import Principal, permission
from .errors import AppError

router = APIRouter()
HEX_256 = re.compile(r"[0-9a-f]{64}")


class AuditVerifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_count: int | None = Field(default=None, ge=0)
    expected_hash: str | None = None

    @field_validator("expected_hash")
    @classmethod
    def valid_hash(cls, value):
        if value is not None and not HEX_256.fullmatch(value):
            raise ValueError("invalid hash")
        return value


def _invalid(conn, principal, action="audit_read"):
    entry = audit.record(conn, user=principal.username, role=principal.role,
                         action=action, outcome="denied", severity="warning",
                         reason="INVALID_INPUT")
    raise AppError("INVALID_INPUT", entry)


def _number(value, *, minimum=0, maximum=2**63 - 1):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", value):
        return None
    number = int(value)
    return number if minimum <= number <= maximum else None


@router.get("/audit")
def list_audit(request: Request, p: Principal = Depends(permission("view_audit"))):
    conn, query = request.state.conn, request.query_params
    allowed = {"before_entry", "limit", "action", "user", "outcome", "severity"}
    if set(query) - allowed or len(query.multi_items()) != len(query):
        _invalid(conn, p)
    limit = _number(query.get("limit", "50"), minimum=1, maximum=100)
    before = _number(query["before_entry"], minimum=1) if "before_entry" in query else None
    if limit is None or ("before_entry" in query and before is None):
        _invalid(conn, p)
    clauses, values = [], []
    if before is not None:
        clauses.append("entry_no < ?")
        values.append(before)
    for name, permitted in (("outcome", {"success", "denied", "failure"}),
                            ("severity", {"info", "warning", "critical"})):
        if name in query:
            if query[name] not in permitted:
                _invalid(conn, p)
            clauses.append(f"{name} = ?")
            values.append(query[name])
    for name in ("action", "user"):
        if name in query:
            value = query[name]
            if not value or len(value) > 64 or any(ord(char) < 32 for char in value):
                _invalid(conn, p)
            clauses.append(f"{name} = ?")
            values.append(value)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    rows = conn.execute(
        "SELECT * FROM audit_events" + where + " ORDER BY entry_no DESC LIMIT ?",
        (*values, limit + 1),
    ).fetchall()
    items = []
    for row in rows[:limit]:
        item = dict(row)
        try:
            item["details"] = json.loads(item["details"])
        except (TypeError, json.JSONDecodeError):
            item["details"] = {"invalid": True}
        items.append(item)
    return {
        "data": {
            "items": items,
            "next_cursor": rows[limit - 1]["entry_no"] if len(rows) > limit else None,
            "chain_head": audit.head(conn),
        }
    }


@router.post("/audit/verify")
def verify_audit(request: Request, p: Principal = Depends(permission("view_audit")),
                 raw: Any = Body(None)):
    conn, started = request.state.conn, time.perf_counter()
    try:
        body = AuditVerifyIn.model_validate({} if raw is None else raw, strict=True)
    except ValidationError:
        _invalid(conn, p, "audit_verify")
    checked = audit.verify(conn, expected_count=body.expected_count,
                           expected_hash=body.expected_hash)
    duration = max(0, int((time.perf_counter() - started) * 1000))
    if not checked["valid"]:
        entry = audit.record(
            conn, user=p.username, role=p.role, action="audit_verify",
            outcome="failure", severity="critical", reason="TAMPER_DETECTED",
            duration_ms=duration,
            details={"first_mismatch": checked["first_mismatch"],
                     "mismatch_reason": checked["reason"],
                     "checked_head": {"entry_count": checked["entry_count"],
                                      "hash": checked["hash"]}},
        )
        result = {"valid": False, "first_mismatch": checked["first_mismatch"],
                  "reason": checked["reason"], "checked_head": {
                      "entry_count": checked["entry_count"], "hash": checked["hash"]}}
        raise AppError("TAMPER_DETECTED", entry, result)
    entry = audit.record(
        conn, user=p.username, role=p.role, action="audit_verify",
        outcome="success", duration_ms=duration,
        details={"verified_head": {"entry_count": checked["entry_count"],
                                   "hash": checked["hash"]}},
    )
    return {"result": {"valid": True, "first_mismatch": None,
                       "verified_head": {"entry_count": checked["entry_count"],
                                         "hash": checked["hash"]},
                       "audit_entry": entry},
            "chain_head": audit.head(conn)}
