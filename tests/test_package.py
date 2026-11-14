import pytest
from pydantic import ValidationError
from app.ciphertext import Package, PackageError, encode_package, decode_package, b64decode
from app.crypto_engine import generate_data_key, encrypt, decrypt
from app.config import ID_MAX
from app.models import KeyCreate, EncryptIn
from app.key_policy import effective_state, parse_expiry
from app.db import init_db, connect, transaction


@pytest.mark.parametrize("size", [0, 1, 65536, 131072])
def test_package_roundtrip(size):
    key = generate_data_key()
    nonce, ct = encrypt(key, b"x" * size, ID_MAX, ID_MAX)
    value = encode_package(Package(ID_MAX, ID_MAX, nonce, ct))
    assert len(value) <= 180000
    assert decrypt(key, decode_package(value)) == b"x" * size


@pytest.mark.parametrize("value", ["QU*JD", "QUJD+w", "QUJD/w", "QUI=", "QUJ", "A", "é"])
def test_strict_base64(value):
    with pytest.raises(PackageError):
        b64decode(value)


@pytest.mark.parametrize("value", ["", "kc2.1.1.a.b", "kc1.01.1.a.b", "kc1.9223372036854775808.1.a.b"])
def test_invalid_package(value):
    with pytest.raises(PackageError):
        decode_package(value)


def test_models_and_expiry():
    for data in ["", "\ud800"]:
        with pytest.raises(ValidationError):
            EncryptIn(key_id=1, data=data)
    for name in [" x", "x ", "x\n", "\ud800"]:
        with pytest.raises(ValidationError):
            KeyCreate(name=name, purpose="standard")
    assert parse_expiry("2027-01-01T00:00:00.123456789Z") == parse_expiry("2027-01-01T05:00:00+05:00")
    assert effective_state({"state":"active", "expires_at":10}, 10) == "expired"


def test_additive_schema_and_rollback(tmp_path):
    path = str(tmp_path / "schema.db")
    init_db(path)
    with connect(path) as c:
        c.execute("INSERT INTO users(username,password_hash,role,created_at) VALUES ('u','h','administrator',0)")
    init_db(path)
    c = connect(path)
    assert c.execute("SELECT count(*) FROM users").fetchone()[0] == 1
    with pytest.raises(RuntimeError):
        with transaction(c):
            c.execute("DELETE FROM users")
            raise RuntimeError()
    assert c.execute("SELECT count(*) FROM users").fetchone()[0] == 1
    c.close()
