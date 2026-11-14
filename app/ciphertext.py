"""Frozen kc1 wire format. No permissive decoder or alternate spelling."""
import base64
import re
from dataclasses import dataclass

from .config import HARD_MAX_PLAINTEXT_BYTES, ID_MAX, MAX_PACKAGE_CHARS

_PACKAGE = re.compile(r"kc1\.([1-9][0-9]{0,18})\.([1-9][0-9]{0,18})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,174784})")


class PackageError(ValueError):
    pass


@dataclass(frozen=True)
class Package:
    key_id: int
    version: int
    nonce: bytes
    ct: bytes


def b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64decode(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]*", value) or len(value) % 4 == 1:
        raise PackageError()
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if b64encode(raw) != value:
        raise PackageError()
    return raw


def decode_package(value: str) -> Package:
    if not isinstance(value, str) or len(value) > MAX_PACKAGE_CHARS:
        raise PackageError()
    m = _PACKAGE.fullmatch(value)
    if not m:
        raise PackageError()
    key_id, version = int(m[1]), int(m[2])
    if key_id > ID_MAX or version > ID_MAX:
        raise PackageError()
    nonce, ct = b64decode(m[3]), b64decode(m[4])
    if len(nonce) != 12 or not 16 <= len(ct) <= HARD_MAX_PLAINTEXT_BYTES + 16:
        raise PackageError()
    return Package(key_id, version, nonce, ct)


def encode_package(p: Package) -> str:
    value = f"kc1.{p.key_id}.{p.version}.{b64encode(p.nonce)}.{b64encode(p.ct)}"
    decode_package(value)  # Symmetric validation, including maximum size.
    return value
