
import os
import sqlite3
import threading
import hmac
import hashlib

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CHECK_TEXT = b"KEYCYCLE-VAULT-CHECK"
CHECK_AAD = b"vault-check"


class VaultLocked(Exception):
    pass


def derive(passphrase: str, salt: bytes, time_cost: int, memory_cost: int, parallelism: int) -> bytes:
    return hash_secret_raw(passphrase.encode(), salt, time_cost=time_cost, memory_cost=memory_cost,
                           parallelism=parallelism, hash_len=32, type=Type.ID)


class Vault:
    def __init__(self):
        self._master: bytearray | None = None
        self._lock = threading.Lock()

    @property
    def unlocked(self) -> bool:
        return self._master is not None

    def initialise(self, conn: sqlite3.Connection, passphrase: str, kdf: dict) -> None:
        salt = os.urandom(16)
        master = derive(passphrase, salt, kdf["time_cost"], kdf["memory_cost"], kdf["parallelism"])
        nonce = os.urandom(12)
        check = AESGCM(master).encrypt(nonce, CHECK_TEXT, CHECK_AAD)
        conn.execute(
            "INSERT INTO vault(id,salt,time_cost,memory_cost,parallelism,check_nonce,check_value) "
            "VALUES (1,?,?,?,?,?,?)",
            (salt, kdf["time_cost"], kdf["memory_cost"], kdf["parallelism"], nonce, check))

    def unlock(self, conn: sqlite3.Connection, passphrase: str) -> bool:
        row = conn.execute("SELECT * FROM vault WHERE id = 1").fetchone()
        if row is None:
            return False
        master = derive(passphrase, row["salt"], row["time_cost"], row["memory_cost"], row["parallelism"])
        try:
            ok = AESGCM(master).decrypt(row["check_nonce"], row["check_value"], CHECK_AAD) == CHECK_TEXT
        except InvalidTag:
            ok = False
        if not ok:
            return False
        with self._lock:
            self._master = bytearray(master)
        return True

    def lock(self) -> None:
        with self._lock:
            if self._master is not None:
                for i in range(len(self._master)):
                    self._master[i] = 0
            self._master = None

    def _key(self) -> bytes:
        with self._lock:
            if self._master is None:
                raise VaultLocked()
            return bytes(self._master)

    def backup_auth_key(self) -> bytes:
        """Derive a domain-separated key without exposing the vault master key."""
        return hmac.new(self._key(), b"KeyCycle backup authentication v1",
                        hashlib.sha256).digest()

    def wrap(self, plaintext_key: bytes, aad: bytes = b"") -> tuple[bytes, bytes]:
        nonce = os.urandom(12)
        return nonce, AESGCM(self._key()).encrypt(nonce, plaintext_key, aad)

    def unwrap(self, nonce: bytes, ciphertext: bytes, aad: bytes = b"") -> bytes:
        return AESGCM(self._key()).decrypt(nonce, ciphertext, aad)
