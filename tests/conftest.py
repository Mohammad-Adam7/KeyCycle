import os
import sqlite3

os.environ["KEYCYCLE_FAST_KDF"] = "1"

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

ADMIN_PW = "admin-password-123"
PASSPHRASE = "correct horse battery staple"


class Ctx:
    def __init__(self, path):
        self.path = str(path)
        self.app = create_app(self.path)
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.csrf = None

    def db(self):
        c = sqlite3.connect(self.path)
        c.row_factory = sqlite3.Row
        return c

    def new_client(self):
        return TestClient(self.app, raise_server_exceptions=False)

    def login(self, username, password, client=None):
        client = client or self.client
        r = client.post("/api/auth/login", json={"username": username, "password": password})
        if r.status_code == 200:
            client.headers["x-csrf-token"] = r.json()["csrf_token"]
        return r

    def setup(self):
        return self.client.post("/api/setup", json={"username": "admin", "password": ADMIN_PW,
                                                    "vault_passphrase": PASSPHRASE})

    def make_user(self, username, role, password="user-password-123"):
        r = self.client.post("/api/users", json={"username": username, "password": password, "role": role})
        assert r.status_code == 201, r.text
        return password

    def as_user(self, username, password):
        c = self.new_client()
        assert self.login(username, password, c).status_code == 200
        return c


@pytest.fixture
def ctx(tmp_path):
    return Ctx(tmp_path / "kc.db")


@pytest.fixture
def admin(ctx):
    assert ctx.setup().status_code == 201
    assert ctx.login("admin", ADMIN_PW).status_code == 200
    return ctx
