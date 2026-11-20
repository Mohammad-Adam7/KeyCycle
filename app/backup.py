"""Authenticated backup format, validation, and database restoration."""
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import audit, crypto_engine
from .ciphertext import Package, decode_package, encode_package
from .config import BACKUP_FORMAT, MAX_BACKUP_BYTES, MAX_BACKUP_NAME, SCHEMA_VERSION, SETTINGS
from .db import SCHEMA
from .vault import CHECK_AAD, CHECK_TEXT, derive

BACKUP_NAME = re.compile(r"keycycle-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.kcbak")
HEX_256 = re.compile(r"[0-9a-f]{64}")

TABLES = {
    "users": ("id", "username", "password_hash", "role", "disabled", "failed_count",
              "locked_until", "last_login", "created_at"),
    "keys": ("id", "name", "algorithm", "purpose", "state", "current_version",
             "rotation_days", "expires_at", "created_by", "created_at", "revoked_at",
             "revoke_reason"),
    "key_versions": ("key_id", "version", "wrapped_key", "nonce", "status", "created_at"),
    "audit_events": ("entry_no", "time", "user", "role", "action", "target", "outcome",
                     "severity", "reason", "duration_ms", "details", "prev_hash", "hash"),
    "settings": ("name", "value", "version", "changed_by", "changed_at"),
    "vault": ("id", "salt", "time_cost", "memory_cost", "parallelism", "check_nonce",
              "check_value"),
}
BYTE_COLUMNS = {
    ("key_versions", "wrapped_key"), ("key_versions", "nonce"),
    ("vault", "salt"), ("vault", "check_nonce"), ("vault", "check_value"),
}
ORDER = {
    "users": "id", "keys": "id", "key_versions": "key_id, version",
    "audit_events": "entry_no", "settings": "name", "vault": "id",
}
RESTORE_ORDER = ("users", "keys", "key_versions", "settings", "vault")


class BackupInvalid(ValueError):
    pass


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]*", value):
        raise BackupInvalid()
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception:
        raise BackupInvalid() from None
    if _b64encode(decoded) != value:
        raise BackupInvalid()
    return decoded


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def _auth_key(master: bytes) -> bytes:
    return hmac.new(master, b"KeyCycle backup authentication v1", hashlib.sha256).digest()


def _encode_row(table: str, row) -> dict:
    return {
        column: _b64encode(row[column]) if (table, column) in BYTE_COLUMNS else row[column]
        for column in TABLES[table]
    }


def _export_tables(conn: sqlite3.Connection) -> dict:
    return {
        table: [_encode_row(table, row) for row in conn.execute(
            f"SELECT {','.join(columns)} FROM {table} ORDER BY {ORDER[table]}"
        ).fetchall()]
        for table, columns in TABLES.items()
    }


def _recovery_proof(conn, vault) -> dict | None:
    row = conn.execute(
        "SELECT k.id, k.current_version, v.nonce, v.wrapped_key "
        "FROM keys k JOIN key_versions v ON v.key_id=k.id AND v.version=k.current_version "
        "ORDER BY k.id LIMIT 1"
    ).fetchone()
    if row is None:
        return None
    challenge = os.urandom(32)
    raw_key = vault.unwrap(row["nonce"], row["wrapped_key"],
                           crypto_engine.wrap_aad(row["id"], row["current_version"]))
    nonce, ciphertext = crypto_engine.encrypt(raw_key, challenge, row["id"],
                                               row["current_version"])
    package = encode_package(Package(row["id"], row["current_version"], nonce, ciphertext))
    return {"package": package, "plaintext_sha256": hashlib.sha256(challenge).hexdigest()}


def make_content(conn: sqlite3.Connection, vault) -> dict:
    chain_head = audit.head(conn)
    return {
        "format": BACKUP_FORMAT,
        "schema_version": SCHEMA_VERSION,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "chain_head": chain_head,
        "tables": _export_tables(conn),
        "recovery_proof": _recovery_proof(conn, vault),
    }


def seal(content: dict, key: bytes) -> bytes:
    code = hmac.new(key, _canonical(content), hashlib.sha256).hexdigest()
    return _canonical({"authentication_code": code, "content": content})


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BackupInvalid()
        result[key] = value
    return result


def parse(raw: bytes) -> dict:
    try:
        envelope = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, BackupInvalid):
        raise BackupInvalid() from None
    if not isinstance(envelope, dict) or set(envelope) != {"authentication_code", "content"}:
        raise BackupInvalid()
    code, content = envelope["authentication_code"], envelope["content"]
    if not isinstance(code, str) or not HEX_256.fullmatch(code) or not isinstance(content, dict):
        raise BackupInvalid()
    return envelope


def authenticate(envelope: dict, key: bytes) -> None:
    expected = hmac.new(key, _canonical(envelope["content"]), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, envelope["authentication_code"]):
        raise BackupInvalid()


def _decoded_tables(content: dict) -> dict:
    if set(content) != {"format", "schema_version", "created_at", "chain_head", "tables",
                       "recovery_proof"}:
        raise BackupInvalid()
    if content["format"] != BACKUP_FORMAT or content["schema_version"] != SCHEMA_VERSION:
        raise BackupInvalid()
    if not isinstance(content["created_at"], str) or len(content["created_at"]) != 20:
        raise BackupInvalid()
    chain_head = content["chain_head"]
    if (not isinstance(chain_head, dict) or set(chain_head) != {"entry_count", "hash"}
            or type(chain_head["entry_count"]) is not int or chain_head["entry_count"] < 0
            or not isinstance(chain_head["hash"], str)
            or not HEX_256.fullmatch(chain_head["hash"])):
        raise BackupInvalid()
    tables = content["tables"]
    if not isinstance(tables, dict) or set(tables) != set(TABLES):
        raise BackupInvalid()
    decoded = {}
    for table, columns in TABLES.items():
        rows = tables[table]
        if not isinstance(rows, list):
            raise BackupInvalid()
        decoded[table] = []
        for row in rows:
            if not isinstance(row, dict) or set(row) != set(columns):
                raise BackupInvalid()
            item = {}
            for column in columns:
                value = row[column]
                item[column] = _b64decode(value) if (table, column) in BYTE_COLUMNS else value
            decoded[table].append(item)
    proof = content["recovery_proof"]
    if proof is not None:
        if (not isinstance(proof, dict) or set(proof) != {"package", "plaintext_sha256"}
                or not isinstance(proof["package"], str)
                or not isinstance(proof["plaintext_sha256"], str)
                or not HEX_256.fullmatch(proof["plaintext_sha256"])):
            raise BackupInvalid()
        try:
            decode_package(proof["package"])
        except Exception:
            raise BackupInvalid() from None
    return decoded


def validate(content: dict) -> tuple[dict, sqlite3.Connection]:
    tables = _decoded_tables(content)
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.executescript(SCHEMA.read_text())
        conn.execute("BEGIN")
        for table in TABLES:
            columns = TABLES[table]
            marks = ",".join("?" for _ in columns)
            for row in tables[table]:
                conn.execute(f"INSERT INTO {table}({','.join(columns)}) VALUES ({marks})",
                             tuple(row[column] for column in columns))
        conn.execute("COMMIT")
        if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise BackupInvalid()
        if len(tables["vault"]) != 1 or tables["vault"][0]["id"] != 1:
            raise BackupInvalid()
        if {row["name"] for row in tables["settings"]} != set(SETTINGS):
            raise BackupInvalid()
        for key in conn.execute("SELECT id,current_version FROM keys"):
            version = conn.execute(
                "SELECT status FROM key_versions WHERE key_id=? AND version=?",
                (key["id"], key["current_version"]),
            ).fetchone()
            if version is None or version["status"] != "current":
                raise BackupInvalid()
        verified = audit.verify(conn, expected_count=content["chain_head"]["entry_count"],
                                expected_hash=content["chain_head"]["hash"])
        if not verified["valid"]:
            raise BackupInvalid()
        return tables, conn
    except (sqlite3.Error, TypeError, ValueError, OverflowError, BackupInvalid):
        conn.close()
        raise BackupInvalid() from None


def key_from_passphrase(content: dict, passphrase: str) -> bytes:
    tables = _decoded_tables(content)
    if len(tables["vault"]) != 1:
        raise BackupInvalid()
    row = tables["vault"][0]
    if (type(row["time_cost"]) is not int or type(row["memory_cost"]) is not int
            or type(row["parallelism"]) is not int
            or not 1 <= row["time_cost"] <= 10
            or not 8 <= row["memory_cost"] <= 1024 * 1024
            or not 1 <= row["parallelism"] <= 16
            or len(row["salt"]) != 16 or len(row["check_nonce"]) != 12
            or not 16 <= len(row["check_value"]) <= 1024):
        raise BackupInvalid()
    try:
        master = derive(passphrase, row["salt"], row["time_cost"], row["memory_cost"],
                        row["parallelism"])
        if AESGCM(master).decrypt(row["check_nonce"], row["check_value"], CHECK_AAD) != CHECK_TEXT:
            raise BackupInvalid()
    except (InvalidTag, TypeError, ValueError):
        raise BackupInvalid() from None
    return _auth_key(master)


class Store:
    def __init__(self, folder: Path):
        self.folder = Path(folder).resolve()
        self.folder.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        if (not isinstance(name, str) or len(name) > MAX_BACKUP_NAME
                or not BACKUP_NAME.fullmatch(name)):
            raise BackupInvalid()
        path = (self.folder / name).resolve()
        if path.parent != self.folder:
            raise BackupInvalid()
        return path

    def write(self, raw: bytes) -> tuple[str, Path]:
        if len(raw) > MAX_BACKUP_BYTES:
            raise BackupInvalid()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        for _ in range(10):
            name = f"keycycle-{stamp}-{os.urandom(4).hex()}.kcbak"
            path = self._path(name)
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
            except BaseException:
                path.unlink(missing_ok=True)
                raise
            return name, path
        raise BackupInvalid()

    def read(self, name: str) -> bytes:
        path = self._path(name)
        try:
            size = path.stat().st_size
            if not 1 <= size <= MAX_BACKUP_BYTES or not path.is_file():
                raise BackupInvalid()
            with path.open("rb") as stream:
                raw = stream.read(MAX_BACKUP_BYTES + 1)
        except (OSError, BackupInvalid):
            raise BackupInvalid() from None
        if len(raw) != size or len(raw) > MAX_BACKUP_BYTES:
            raise BackupInvalid()
        return raw

    def list(self) -> list[dict]:
        result = []
        try:
            paths = list(self.folder.iterdir())
        except OSError:
            return result
        for path in paths:
            if not path.is_file() or not BACKUP_NAME.fullmatch(path.name):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size <= MAX_BACKUP_BYTES:
                result.append({"name": path.name, "size": stat.st_size,
                               "modified_at": datetime.fromtimestamp(
                                   stat.st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        return sorted(result, key=lambda item: item["name"], reverse=True)


def load_verified(store: Store, name: str, *, key: bytes | None = None,
                  passphrase: str | None = None) -> tuple[dict, dict, sqlite3.Connection]:
    envelope = parse(store.read(name))
    if key is None:
        if passphrase is None:
            raise BackupInvalid()
        key = key_from_passphrase(envelope["content"], passphrase)
    authenticate(envelope, key)
    tables, checked = validate(envelope["content"])
    return envelope["content"], tables, checked


def restore(conn: sqlite3.Connection, tables: dict, content: dict) -> dict:
    live = audit.verify(conn)
    backup_head = content["chain_head"]
    if live["valid"] and live["entry_count"]:
        prefix = conn.execute("SELECT hash FROM audit_events WHERE entry_no=?",
                              (backup_head["entry_count"],)).fetchone()
        if prefix is None or prefix["hash"] != backup_head["hash"]:
            raise BackupInvalid()
    conn.execute("DELETE FROM confirmations")
    conn.execute("DELETE FROM sessions")
    conn.execute("DELETE FROM failures")
    conn.execute("DELETE FROM key_versions")
    conn.execute("DELETE FROM keys")
    conn.execute("DELETE FROM users")
    conn.execute("DELETE FROM settings")
    conn.execute("DELETE FROM vault")
    for table in RESTORE_ORDER:
        columns = TABLES[table]
        marks = ",".join("?" for _ in columns)
        for row in tables[table]:
            conn.execute(f"INSERT INTO {table}({','.join(columns)}) VALUES ({marks})",
                         tuple(row[column] for column in columns))
    replaced_audit = not live["valid"] or live["entry_count"] == 0
    if replaced_audit:
        conn.execute("DROP TRIGGER audit_no_delete")
        conn.execute("DELETE FROM audit_events")
        columns = TABLES["audit_events"]
        marks = ",".join("?" for _ in columns)
        for row in tables["audit_events"]:
            conn.execute(f"INSERT INTO audit_events({','.join(columns)}) VALUES ({marks})",
                         tuple(row[column] for column in columns))
        conn.execute("CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events "
                     "BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END")
        conn.execute("UPDATE sqlite_sequence SET seq=? WHERE name='audit_events'",
                     (backup_head["entry_count"],))
    return {"live_head_before": {"entry_count": live["entry_count"], "hash": live["hash"]},
            "backup_head": backup_head, "audit_replaced": replaced_audit}


def verify_recovery_proof(checked: sqlite3.Connection, content: dict, passphrase: str) -> bool:
    proof = content["recovery_proof"]
    if proof is None:
        return False
    vault_row = checked.execute("SELECT * FROM vault WHERE id=1").fetchone()
    master = derive(passphrase, vault_row["salt"], vault_row["time_cost"],
                    vault_row["memory_cost"], vault_row["parallelism"])
    try:
        if AESGCM(master).decrypt(vault_row["check_nonce"], vault_row["check_value"],
                                  CHECK_AAD) != CHECK_TEXT:
            raise BackupInvalid()
        package = decode_package(proof["package"])
        version = checked.execute(
            "SELECT nonce,wrapped_key FROM key_versions WHERE key_id=? AND version=?",
            (package.key_id, package.version),
        ).fetchone()
        if version is None:
            raise BackupInvalid()
        raw_key = AESGCM(master).decrypt(
            version["nonce"], version["wrapped_key"],
            crypto_engine.wrap_aad(package.key_id, package.version),
        )
        plaintext = crypto_engine.decrypt(raw_key, package)
        return hmac.compare_digest(hashlib.sha256(plaintext).hexdigest(),
                                   proof["plaintext_sha256"])
    except (InvalidTag, ValueError, TypeError):
        raise BackupInvalid() from None
