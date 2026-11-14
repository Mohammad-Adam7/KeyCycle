import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import SETTINGS

SCHEMA = Path(__file__).resolve().parent.parent / "schema.sql"


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path: str) -> None:
    conn = connect(path)
    conn.executescript(SCHEMA.read_text())
    for name, (default, *_rest) in SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(name, value) VALUES (?, ?)", (name, default))
    conn.close()


def get_setting(conn: sqlite3.Connection, name: str) -> int:
    row = conn.execute("SELECT value FROM settings WHERE name = ?", (name,)).fetchone()
    return int(row["value"]) if row else SETTINGS[name][0]


@contextmanager
def transaction(conn):
    """The caller owns one write transaction; helpers must never commit."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
