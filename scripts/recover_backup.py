"""Restore a lost KeyCycle database from an authenticated server-side backup."""
import argparse
import getpass
import os
import tempfile
from pathlib import Path

from app import audit, backup
from app.db import connect, init_db, transaction


def recover(database: Path, backup_name: str, passphrase: str) -> dict:
    target = Path(database).resolve()
    if target.exists():
        raise FileExistsError("target database already exists; move it aside before recovery")
    if not target.parent.is_dir():
        raise FileNotFoundError("target database folder does not exist")

    store = backup.Store(target.parent / "backups")
    content, tables, checked = backup.load_verified(store, backup_name,
                                                     passphrase=passphrase)
    fd, temporary_name = tempfile.mkstemp(prefix=".keycycle-recovery-", suffix=".db",
                                          dir=target.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    conn = None
    try:
        init_db(str(temporary))
        conn = connect(str(temporary))
        with transaction(conn):
            result = backup.restore(conn, tables, content)
            entry = audit.record(
                conn, user="system", role="system", action="disaster_restore",
                target=backup_name, outcome="success", severity="warning",
                details={"backup_name": backup_name, **result},
            )
        conn.close()
        conn = None
        os.link(temporary, target)
        temporary.unlink()
        final_conn = connect(str(target))
        try:
            chain_head = audit.head(final_conn)
        finally:
            final_conn.close()
        return {"database": str(target), "backup_name": backup_name,
                "audit_entry": entry, "chain_head": chain_head}
    finally:
        if conn is not None:
            conn.close()
        checked.close()
        temporary.unlink(missing_ok=True)
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default="keycycle.db",
                        help="New database path; it must not already exist")
    parser.add_argument("--backup", required=True,
                        help="Backup filename from the fixed backups folder")
    args = parser.parse_args()
    secret = getpass.getpass("Vault passphrase: ")
    restored = recover(Path(args.database), args.backup, secret)
    print(f"Recovery complete: {restored['database']}")
    print(f"Audit entry: {restored['audit_entry']}")
