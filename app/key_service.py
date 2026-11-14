"""Atomic workflows. No output is returned until mutation and audit commit."""
import sqlite3
import time
from cryptography.exceptions import InvalidTag

from . import confirmations, crypto_engine as crypto, decisions, key_repository as repo
from .auth import Principal, PERMISSIONS
from .ciphertext import Package, PackageError, decode_package, encode_package
from .config import CONFIRMATION_TTL_SECONDS, ID_MAX
from .db import transaction
from .errors import AppError
from .key_policy import effective_state, parse_expiry, role_may_use, setting_snapshot, utc
from .vault import VaultLocked

SYSTEM = Principal(None, "system", "system", "")


class Denied(Exception):
    def __init__(self, code):
        self.code = code


class KeyService:
    def __init__(self, conn, vault, actor, session_hash=None, *, now=None, t0=None):
        self.conn, self.vault, self.actor, self.session_hash = conn, vault, actor, session_hash
        self.fixed_now = now
        self.t0 = time.perf_counter() if t0 is None else t0
        self._reset()

    def _reset(self):
        self.key_id = self.version = None
        self.thresholds, self.evidence = {}, {}
        self.test = False
        self.rule = "input_validation"

    def _auth(self, permission, now):
        if self.actor is SYSTEM:
            return
        r = self.conn.execute("SELECT u.role,u.disabled,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.id=?",
                              (self.session_hash, self.actor.user_id)).fetchone()
        if r is None or r["disabled"] or r["expires_at"] <= now:
            raise Denied("SESSION_EXPIRED")
        if r["role"] != self.actor.role or r["role"] not in PERMISSIONS[permission]:
            raise Denied("FORBIDDEN")

    def _event(self, action, code, allowed, **extra):
        hidden = code in ("FORBIDDEN", "SESSION_EXPIRED", "CONFIRMATION_REQUIRED")
        return decisions.record(self.conn, self.actor, action, code, allowed=allowed, t0=self.t0,
            key_id=None if hidden else self.key_id, version=None if hidden else self.version,
            thresholds=self.thresholds, evidence={} if hidden else self.evidence,
            rule=self.rule if allowed else None, test=self.test, **extra)

    def run(self, action, permission, work, *, read=False):
        self._reset()
        try:
            with transaction(self.conn):
                self.now = int(time.time()) if self.fixed_now is None else self.fixed_now
                self._auth(permission, self.now)
                data, code, extra = work()
                result = None if read or code is None else self._event(action, code, True, **extra)
            return {"data":data} if result is None else {"result":result, "data":data}
        except (Denied, VaultLocked) as e:
            code = e.code if isinstance(e, Denied) else "VAULT_LOCKED"
            # Rollback happens before denial audit, so even a late denial cannot
            # consume confirmation or leave a partially rotated version.
            try:
                with transaction(self.conn):
                    result = self._event(action, code, False)
            except Exception:
                raise AppError("INTERNAL_ERROR") from None
            raise AppError(code, result["audit_entry"], result) from None
        except Exception as e:
            try:
                with transaction(self.conn):
                    result = self._event(action, "INTERNAL_ERROR", False, error_type=type(e).__name__)
            except Exception:
                raise AppError("INTERNAL_ERROR") from None
            raise AppError("INTERNAL_ERROR", result["audit_entry"], result) from None

    def deny(self, action, code, permission):
        def work():
            raise Denied(code)
        return self.run(action, permission, work)

    def _key(self, key_id, *, decrypt=False):
        key = repo.get_key(self.conn, key_id)
        if key is None:
            raise Denied("CIPHERTEXT_INVALID" if decrypt else "KEY_NOT_FOUND")
        self.key_id, self.version = key_id, key["current_version"]
        self.evidence = dict(state=effective_state(key, self.now), purpose=key["purpose"], expires_at=utc(key["expires_at"]))
        return key

    def _active(self, key):
        state = effective_state(key, self.now)
        if state != "active":
            raise Denied("KEY_REVOKED" if state == "revoked" else "KEY_EXPIRED")
        self.rule = "key_state_check"

    def _unlocked(self):
        if not self.vault.unlocked:
            raise Denied("VAULT_LOCKED")
        self.rule = "vault_state_check"

    def _purpose(self, key):
        if not role_may_use(self.actor.role, key["purpose"]):
            raise Denied("FORBIDDEN")
        self.test = self.actor.role == "administrator"

    def _detail(self, key):
        return repo.metadata(self.conn, key, self.now, self.actor.role == "administrator", True)

    def create(self, body):
        def work():
            expiry = parse_expiry(body.expires_at)
            if expiry is not None and expiry <= self.now:
                raise Denied("INVALID_INPUT")
            self._unlocked()
            snap = setting_snapshot(self.conn, "rotation_days")
            self.thresholds["rotation_days"] = snap
            days = body.rotation_days if "rotation_days" in body.model_fields_set else snap["value"]
            try:
                cur = self.conn.execute("INSERT INTO keys(name,purpose,rotation_days,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?)",
                    (body.name, body.purpose, days, expiry, self.actor.user_id, self.now))
            except sqlite3.IntegrityError:
                if self.conn.execute("SELECT 1 FROM keys WHERE name=?", (body.name,)).fetchone():
                    raise Denied("INVALID_INPUT") from None
                raise
            key_id = cur.lastrowid
            nonce, wrapped = self.vault.wrap(crypto.generate_data_key(), crypto.wrap_aad(key_id, 1))
            self.conn.execute("INSERT INTO key_versions(key_id,version,wrapped_key,nonce,status,created_at) VALUES (?,1,?,?,'current',?)", (key_id, wrapped, nonce, self.now))
            key = self._key(key_id)
            return self._detail(key), "KEY_CREATED", {}
        return self.run("key_create", "manage_keys", work)

    def get(self, key_id, version_after=0, versions_limit=50):
        def work():
            key = self._key(key_id)
            return repo.metadata(self.conn, key, self.now, self.actor.role == "administrator", True, version_after, versions_limit), None, {}
        return self.run("key_read", "view_keys", work, read=True)

    def list(self, *, state=None, purpose=None, after_id=0, limit=50):
        def work():
            sql = "SELECT * FROM keys WHERE id>?"
            args = [after_id]
            if state:
                sql += " AND (CASE WHEN state='active' AND expires_at IS NOT NULL AND expires_at<=? THEN 'expired' ELSE state END)=?"
                args += [self.now, state]
            if purpose:
                sql += " AND purpose=?"
                args.append(purpose)
            rows = self.conn.execute(sql + " ORDER BY id LIMIT ?", (*args, limit+1)).fetchall()
            return dict(items=[repo.metadata(self.conn, r, self.now) for r in rows[:limit]],
                        next_cursor=rows[limit-1]["id"] if len(rows)>limit else None), None, {}
        return self.run("key_list", "view_keys", work, read=True)

    def encrypt(self, body):
        def work():
            plain = body.data.encode("utf-8")
            snap = setting_snapshot(self.conn, "max_data_kib")
            self.thresholds["max_data_kib"] = snap
            if len(plain) > snap["value"] * 1024:
                raise Denied("PAYLOAD_TOO_LARGE")
            key = self._key(body.key_id)
            self._purpose(key)
            self._active(key)
            self._unlocked()
            row = repo.get_version(self.conn, key["id"], key["current_version"])
            if row is None or row["status"] != "current":
                raise ValueError("inconsistent current version")
            raw = self.vault.unwrap(row["nonce"], row["wrapped_key"], crypto.wrap_aad(key["id"], row["version"]))
            nonce, ct = crypto.encrypt(raw, plain, key["id"], row["version"])
            self.evidence.update(data_bytes=len(plain), input_validation_version=snap["setting_version"])
            return {"package":encode_package(Package(key["id"], row["version"], nonce, ct))}, "ENCRYPT_OK", {}
        return self.run("encrypt", "use_key", work)

    def decrypt(self, body):
        def work():
            try:
                package = decode_package(body.package)
            except PackageError:
                raise Denied("CIPHERTEXT_INVALID") from None
            key = self._key(package.key_id, decrypt=True)
            self._purpose(key)
            self._active(key)
            self._unlocked()
            row = repo.get_version(self.conn, package.key_id, package.version)
            if row is None:
                raise Denied("CIPHERTEXT_INVALID")
            self.version = package.version
            raw = self.vault.unwrap(row["nonce"], row["wrapped_key"], crypto.wrap_aad(package.key_id, package.version))
            try:
                plain = crypto.decrypt(raw, package).decode("utf-8")
            except (InvalidTag, UnicodeDecodeError):
                raise Denied("CIPHERTEXT_INVALID") from None
            return {"plaintext":plain}, "DECRYPT_OK", {}
        return self.run("decrypt", "use_key", work)

    def issue(self, body):
        def work():
            key = self._key(body.key_id)
            if body.action == "rotate":
                self._active(key)
            raw = confirmations.issue(self.conn, self.actor, self.session_hash, body.action, body.key_id,
                                      key["current_version"] if body.action == "rotate" else None, self.now)
            self.rule = "confirmation_check"
            return dict(confirmation_token=raw, action=body.action, key_id=body.key_id,
                        expires_at=utc(self.now+CONFIRMATION_TTL_SECONDS)), "CONFIRMATION_ISSUED", {}
        return self.run("confirmation_issue", "manage_keys", work)

    def _confirmation(self, key_id, action, token):
        row = confirmations.validate(self.conn, self.actor, self.session_hash, action, key_id, token, self.now)
        if row is None:
            raise Denied("CONFIRMATION_REQUIRED")
        return row

    def rotate(self, key_id, token=None, *, expected_version=None):
        def work():
            key = self._key(key_id)
            system = self.actor is SYSTEM
            confirmation = None if system else self._confirmation(key_id, "rotate", token)
            expected = expected_version if system else confirmation["expected_version"]
            if system:
                current = repo.get_version(self.conn, key_id, key["current_version"])
                if (key["current_version"] != expected or effective_state(key,self.now) != "active"
                    or current["created_at"] + key["rotation_days"] * 86400 > self.now):
                    return None, None, {}
            if key["current_version"] != expected:
                raise Denied("CONFIRMATION_REQUIRED")
            self._active(key)
            self._unlocked()
            old, new = key["current_version"], key["current_version"]+1
            if new > ID_MAX:
                raise ValueError("version exhausted")
            cur = self.conn.execute("UPDATE key_versions SET status='retired' WHERE key_id=? AND version=? AND status='current'", (key_id, old))
            if cur.rowcount != 1:
                raise ValueError("inconsistent version")
            nonce, wrapped = self.vault.wrap(crypto.generate_data_key(), crypto.wrap_aad(key_id, new))
            self.conn.execute("INSERT INTO key_versions(key_id,version,wrapped_key,nonce,status,created_at) VALUES (?,?,?,?,'current',?)", (key_id,new,wrapped,nonce,self.now))
            cur = self.conn.execute("UPDATE keys SET current_version=? WHERE id=? AND current_version=?", (new,key_id,old))
            if cur.rowcount != 1:
                raise ValueError("version changed")
            if confirmation:
                confirmations.consume(self.conn, confirmation, self.now)
            key = self._key(key_id)
            if system:
                self.rule = "rotation_policy"
            self.evidence["rotation_days"] = key["rotation_days"]
            return self._detail(key), "ROTATE_OK", {"trigger":"scheduled" if system else "manual"}
        return self.run("key_rotate", "manage_keys", work)

    def revoke(self, key_id, body):
        def work():
            key = self._key(key_id)
            confirmation = self._confirmation(key_id, "revoke", body.confirmation_token)
            if body.confirm_name != key["name"]:
                raise Denied("CONFIRMATION_REQUIRED")
            repeated = key["state"] == "revoked"
            if not repeated:
                self.conn.execute("UPDATE keys SET state='revoked',revoked_at=?,revoke_reason=? WHERE id=?", (self.now,body.reason,key_id))
            confirmations.consume(self.conn, confirmation, self.now)
            self.rule = "confirmation_check"
            key = self._key(key_id)
            return self._detail(key), "REVOKE_REPEATED" if repeated else "REVOKE_OK", {"repeated":repeated, "reason_text":key["revoke_reason"]}
        return self.run("key_revoke", "manage_keys", work)

    def results(self, *, entry=None, before_entry=None, limit=50):
        def work():
            actions = ("encrypt", "decrypt") if self.actor.role == "operator" else decisions.B_ACTIONS
            sql = "SELECT * FROM audit_events WHERE action IN (" + ",".join("?" for _ in actions) + ")"
            args = list(actions)
            if self.actor.role == "operator":
                sql += " AND user=?"
                args.append(self.actor.username)
            if entry is not None:
                sql += " AND entry_no=?"
                args.append(entry)
            elif before_entry is not None:
                sql += " AND entry_no<?"
                args.append(before_entry)
            rows = self.conn.execute(sql + " ORDER BY entry_no DESC LIMIT ?", (*args,limit+1)).fetchall()
            if entry is not None:
                if not rows:
                    raise Denied("RESULT_NOT_FOUND")
                return decisions.project(rows[0], self.actor.role), None, {}
            return dict(items=[decisions.project(r,self.actor.role) for r in rows[:limit]],
                        next_cursor=rows[limit-1]["entry_no"] if len(rows)>limit else None), None, {}
        return self.run("result_read", "view_results", work, read=True)
