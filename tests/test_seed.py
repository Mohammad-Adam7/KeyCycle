import pytest
from scripts.seed_demo import seed
from app.db import connect
from app.vault import Vault
from app.crypto_engine import decrypt, wrap_aad
from app.ciphertext import decode_package


def test_seed_synthetic_fixtures_and_refuses_overwrite(tmp_path):
    path=tmp_path/"seed.db"
    fixtures=seed(path,"demo-password-123","demo-passphrase-123",fixture_path=tmp_path/"fixtures.json")
    with pytest.raises(FileExistsError):
        seed(path,"demo-password-123","demo-passphrase-123")
    conn=connect(str(path))
    assert conn.execute("SELECT count(*) FROM users").fetchone()[0] == 5
    assert conn.execute("SELECT current_version FROM keys WHERE name='payroll-key'").fetchone()[0] == 3
    assert conn.execute("SELECT state FROM keys WHERE name='archive-2026'").fetchone()[0] == "expired"
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM confirmations").fetchone()[0] == 0
    p=decode_package(fixtures["retired_version_package"])
    vault=Vault()
    assert vault.unlock(conn,"demo-passphrase-123")
    row=conn.execute("SELECT nonce,wrapped_key FROM key_versions WHERE key_id=? AND version=?",(p.key_id,p.version)).fetchone()
    raw=vault.unwrap(row[0],row[1],wrap_aad(p.key_id,p.version))
    assert decrypt(raw,p) == b"Synthetic payroll sample"
    vault.lock()
    conn.close()
