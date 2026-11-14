"""Safe, explicit audit projection: never accepts request dictionaries."""
import json
import time
from . import audit
from .errors import ERRORS

B_ACTIONS = ("key_create", "confirmation_issue", "key_rotate", "key_revoke", "key_expire", "rotation_deferred", "encrypt", "decrypt")
RULES = {"FORBIDDEN":"role_check", "SESSION_EXPIRED":"session_check", "KEY_NOT_FOUND":"key_state_check",
         "KEY_REVOKED":"key_state_check", "KEY_EXPIRED":"key_state_check", "VAULT_LOCKED":"vault_state_check",
         "CONFIRMATION_REQUIRED":"confirmation_check", "RATE_LIMITED":"rate_limit"}
RECOMMEND = {"VAULT_LOCKED":"Ask an administrator to unlock the vault.", "ROTATION_DEFERRED":"Unlock the vault.",
             "KEY_EXPIRED":"Create a new key; expired keys cannot be used.", "KEY_REVOKED":"Use another active key.",
             "CONFIRMATION_REQUIRED":"Request a new confirmation and try again.", "PAYLOAD_TOO_LARGE":"Reduce the data below the limit."}
DEPENDENCIES = {"input_validation":("max_data_kib",), "rotation_policy":("rotation_days",)}


def record(conn, actor, action, code, *, allowed, t0, key_id=None, version=None, thresholds=None,
           evidence=None, rule=None, test=False, repeated=False, trigger=None, error_type=None, reason_text=None):
    thresholds, evidence = thresholds or {}, evidence or {}
    rule = rule or RULES.get(code, "input_validation")
    revision = 1 + sum(thresholds[n]["setting_version"] - 1 for n in DEPENDENCIES.get(rule, ()) if n in thresholds)
    severity = "critical" if code == "INTERNAL_ERROR" else "info" if allowed and code != "ROTATION_DEFERRED" else "warning"
    duration = max(0, int((time.perf_counter() - t0) * 1000))
    message = ERRORS[code][1] if code in ERRORS else code.replace("_", " ").capitalize() + "."
    result = dict(decision="allowed" if allowed else "denied", reason={"code":code, "message":message},
                  rule={"name":rule, "version":revision}, thresholds=thresholds, key={"id":key_id, "version":version},
                  evidence=evidence, severity=severity, recommended_action=RECOMMEND.get(code), duration_ms=duration,
                  audit_entry=None, test=test)
    details = dict(decision=result["decision"], rule_name=rule, rule_version=revision, thresholds=thresholds,
                   key_id=key_id, key_version=version, evidence=evidence, recommended_action=result["recommended_action"],
                   test=test, repeated=repeated, user_id=actor.user_id)
    for n, v in (("trigger", trigger), ("error_type", error_type), ("reason_text", reason_text)):
        if v is not None:
            details[n] = v
    result["audit_entry"] = audit.record(conn, user=actor.username, role=actor.role, action=action,
        target=f"key:{key_id}" if key_id is not None else "", outcome="success" if allowed else "failure" if code == "INTERNAL_ERROR" else "denied",
        severity=severity, reason=code, duration_ms=duration, details=details)
    return result


def project(row, role):
    d = json.loads(row["details"])
    data = dict(entry=row["entry_no"], time=row["time"], action=row["action"], outcome=row["outcome"],
                reason_code=row["reason"], severity=row["severity"], key_id=d.get("key_id"), key_version=d.get("key_version"), test=d.get("test", False))
    if role != "viewer":
        data.update(rule={"name":d.get("rule_name"), "version":d.get("rule_version")}, thresholds=d.get("thresholds", {}),
                    evidence=d.get("evidence", {}), recommended_action=d.get("recommended_action"), duration_ms=row["duration_ms"])
    if role == "administrator":
        data.update(user=row["user"], role=row["role"], reason_text=d.get("reason_text"))
    return data
