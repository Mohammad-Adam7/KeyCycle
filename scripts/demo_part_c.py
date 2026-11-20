"""Live Part C walkthrough against a seeded LOCAL KeyCycle server."""
import argparse
import getpass
import os
from urllib.parse import urlparse

import httpx


def demonstrate(base_url: str, password: str, passphrase: str) -> dict:
    if urlparse(base_url).hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Demo credentials may only be sent to a local server")

    def call(client, method, path, body=None, status=200):
        response = client.request(method, path, json=body)
        if response.status_code != status:
            raise RuntimeError(f"{method} {path} returned {response.status_code}: {response.text}")
        return response.json()

    with httpx.Client(base_url=base_url, timeout=30, trust_env=False) as client:
        login = call(client, "POST", "/api/auth/login",
                     {"username": "admin", "password": password})
        client.headers["x-csrf-token"] = login["csrf_token"]
        try:
            call(client, "POST", "/api/vault/unlock", {"passphrase": passphrase})
            before = call(client, "POST", "/api/audit/verify", {})
            assert before["result"]["valid"] is True

            confirmation = call(client, "POST", "/api/confirmations",
                                {"action": "backup"}, 201)
            created = call(client, "POST", "/api/backups", {
                "confirmation_token": confirmation["data"]["confirmation_token"],
            }, 201)
            name = created["data"]["name"]
            verified = call(client, "POST", f"/api/backups/{name}/verify")
            assert verified["result"]["valid"] is True

            confirmation = call(client, "POST", "/api/confirmations", {
                "action": "recovery_drill", "backup_name": name,
            }, 201)
            drill = call(client, "POST", "/api/recovery-drill", {
                "backup_name": name,
                "confirmation_token": confirmation["data"]["confirmation_token"],
                "passphrase": passphrase,
            })
            assert all(step["passed"] for step in drill["data"]["steps"])
            after = call(client, "POST", "/api/audit/verify", {})
            assert after["result"]["valid"] is True
            return {"backup_name": name, "steps": [step["step"] for step in drill["data"]["steps"]]}
        finally:
            call(client, "POST", "/api/vault/lock")
            call(client, "POST", "/api/auth/logout")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    admin_password = os.environ.get("KEYCYCLE_DEMO_PASSWORD") or getpass.getpass(
        "Demo administrator password: ")
    vault_passphrase = os.environ.get("KEYCYCLE_DEMO_PASSPHRASE") or getpass.getpass(
        "Demo vault passphrase: ")
    result = demonstrate(args.base_url, admin_password, vault_passphrase)
    print("PASS: audit chain, authenticated backup, verification and recovery drill.")
    print(f"Backup: {result['backup_name']}")
