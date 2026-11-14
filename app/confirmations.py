import secrets
from .security import token_hash
from .config import CONFIRMATION_TTL_SECONDS


def issue(conn, actor, session_hash, action, key_id, version, now):
    conn.execute("DELETE FROM confirmations WHERE token_hash IN (SELECT token_hash FROM confirmations WHERE expires_at<=? LIMIT 500)", (now,))
    raw = secrets.token_urlsafe(32)
    conn.execute("INSERT INTO confirmations(token_hash,user_id,session_hash,action,target,expected_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)",
                 (token_hash(raw), actor.user_id, session_hash, action, f"key:{key_id}", version, now, now + CONFIRMATION_TTL_SECONDS))
    return raw


def validate(conn, actor, session_hash, action, key_id, raw, now):
    return conn.execute("SELECT * FROM confirmations WHERE token_hash=? AND user_id=? AND session_hash=? AND action=? AND target=? AND used_at IS NULL AND expires_at>?",
                        (token_hash(raw), actor.user_id, session_hash, action, f"key:{key_id}", now)).fetchone()


def consume(conn, row, now):
    cur = conn.execute("UPDATE confirmations SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
                       (now, row["token_hash"], now))
    if cur.rowcount != 1:
        raise RuntimeError("confirmation changed inside transaction")
