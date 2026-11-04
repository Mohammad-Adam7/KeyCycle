import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from .config import kdf_params


def make_hasher() -> PasswordHasher:
    p = kdf_params()
    return PasswordHasher(time_cost=p["time_cost"], memory_cost=p["memory_cost"], parallelism=p["parallelism"])


def verify_password(hasher: PasswordHasher, stored: str, password: str) -> bool:
    try:
        return hasher.verify(stored, password)
    except (VerificationError, InvalidHashError):
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


class RateLimiter:

    def __init__(self):
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key, limit: int) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True


class FailureTracker:

    STALE_SECONDS = 3600

    def locked(self, conn, key: str) -> bool:
        row = conn.execute("SELECT locked_until FROM failures WHERE key = ?", (key,)).fetchone()
        return bool(row and row["locked_until"] > time.time())

    def fail(self, conn, key: str, limit: int, lock_seconds: int) -> bool:
        now = int(time.time())

        conn.execute("DELETE FROM failures WHERE locked_until < ? AND updated_at < ?", (now, now - self.STALE_SECONDS))
        row = conn.execute("SELECT count, locked_until FROM failures WHERE key = ?", (key,)).fetchone()
        count = (row["count"] if row and row["locked_until"] <= now else 0) + 1
        if count >= limit:
            conn.execute("INSERT INTO failures(key,count,locked_until,updated_at) VALUES (?,0,?,?) "
                         "ON CONFLICT(key) DO UPDATE SET count=0, locked_until=excluded.locked_until, "
                         "updated_at=excluded.updated_at", (key, now + lock_seconds, now))
            return True
        conn.execute("INSERT INTO failures(key,count,locked_until,updated_at) VALUES (?,?,0,?) "
                     "ON CONFLICT(key) DO UPDATE SET count=excluded.count, locked_until=0, "
                     "updated_at=excluded.updated_at", (key, count, now))
        return False

    def reset(self, conn, key: str) -> None:
        conn.execute("DELETE FROM failures WHERE key = ?", (key,))
