"""Primitives only; authorization and transactions belong to the service."""
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def generate_data_key():
    return AESGCM.generate_key(bit_length=256)


def data_aad(key_id, version):
    return f"KeyCycle|data|1|{key_id}|{version}".encode("ascii")


def wrap_aad(key_id, version):
    return f"KeyCycle|wrap|1|{key_id}|{version}".encode("ascii")


def encrypt(key, data, key_id, version):
    nonce = os.urandom(12)
    return nonce, AESGCM(key).encrypt(nonce, data, data_aad(key_id, version))


def decrypt(key, package):
    return AESGCM(key).decrypt(package.nonce, package.ct, data_aad(package.key_id, package.version))
