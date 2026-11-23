"""Capture UI screenshots for the report from a throw-away SYNTHETIC demo database.

Optional tool (not needed to run KeyCycle):
    pip install playwright && playwright install chromium
    python3 scripts/capture_screenshots.py

Writes evidence/screenshots/*.png and evidence/screenshots/dialogs.txt (the text of browser
pop-ups, which screenshots cannot show). Nothing here touches your own database."""
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("KEYCYCLE_FAST_KDF", "1")      # demo data only; keeps the capture fast

from playwright.sync_api import sync_playwright  # noqa: E402

from scripts.seed_demo import seed  # noqa: E402

PW = "Screenshot-Run-Password-1"
OUT = ROOT / "evidence" / "screenshots"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="kc-shots-"))
    db = str(work / "kc.db")
    fixtures = seed(db, PW, PW)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = subprocess.Popen([os.environ.get("KEYCYCLE_SERVER_PY", sys.executable), "-m", "uvicorn", "app.main:create_app", "--factory", "--port", str(port)],
                              cwd=ROOT, env={**os.environ, "KEYCYCLE_DB": db}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(base, timeout=1)
                break
            except OSError:
                time.sleep(0.5)
        dialogs = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 860})
            page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))

            def shot(name, note=""):
                page.wait_for_timeout(500)
                page.screenshot(path=str(OUT / f"{name}.png"))
                print("captured", name, note)

            def api(method, path, body=None):
                return page.evaluate(
                    """async ([m, p, b]) => {
                        const s = await fetch('/api/auth/session').then(r => r.json());
                        const r = await fetch(p, {method: m, headers: {'Content-Type': 'application/json',
                            'X-CSRF-Token': s.csrf_token}, body: b ? JSON.stringify(b) : undefined});
                        return {status: r.status, body: await r.json().catch(() => null)};
                    }""", [method, path, body])

            def login(user, password=PW):
                page.goto(base)
                page.wait_for_selector("#form-login")
                page.fill("#login-username", user)
                page.fill("#login-password", password)
                page.click("#form-login button[type=submit]")

            def logout():
                page.click("#btn-signout")
                page.wait_for_selector("#form-login")

            def go(view):
                page.click(f"button.nav-btn[data-view={view}]")
                page.wait_for_timeout(700)

            # 1. failed login: generic message
            login("admin", "wrong-password-1")
            page.wait_for_selector("#auth-error:visible")
            shot("01-login-failed-generic-message")
            # 2. admin dashboard, vault locked
            login("admin")
            page.wait_for_selector("#user-name")
            shot("02-dashboard-admin-vault-locked")
            # 3. wrong passphrase
            page.click("#btn-dash-vault")
            page.fill("#unlock-passphrase", "wrong-passphrase-123")
            page.click("#form-unlock button[type=submit]")
            page.wait_for_timeout(800)
            shot("03-vault-wrong-passphrase")
            # 4. correct passphrase
            page.fill("#unlock-passphrase", PW)
            page.click("#form-unlock button[type=submit]")
            page.wait_for_timeout(800)
            page.reload()
            page.wait_for_selector("#user-name")
            shot("04-vault-unlocked")
            # 5. keys with active / expired / revoked states
            go("keys")
            shot("05-keys-states")
            # 6. password dialog
            page.click("#btn-password")
            page.wait_for_selector("#modal-password.active")
            shot("06-change-password-dialog")
            page.click("#modal-password [data-action=close-modal]")
            # 7. backup + recovery drill (admin)
            tok = api("POST", "/api/confirmations", {"action": "backup"})["body"]["data"]["confirmation_token"]
            name = api("POST", "/api/backups", {"confirmation_token": tok})["body"]["data"]["name"]
            go("backup")
            shot("07-backups-list")
            page.select_option("#drill-backup-select", name)
            page.fill("#drill-passphrase", PW)
            page.click("#form-drill button[type=submit]")
            page.wait_for_timeout(2500)
            shot("08-recovery-drill-results")
            go("admin")
            shot("09-administration-users-settings")
            # prepare a revoked-key package for the operator screen
            logout()
            login("operator1")
            page.wait_for_selector("#user-name")
            old = api("POST", "/api/crypto/encrypt", {"key_id": fixtures["keys"]["backup-key"], "data": "revoked-key demo"})["body"]["data"]["package"]
            logout()
            login("admin")
            page.wait_for_selector("#user-name")
            kid = fixtures["keys"]["backup-key"]
            tok = api("POST", "/api/confirmations", {"action": "revoke", "key_id": kid})["body"]["data"]["confirmation_token"]
            api("POST", f"/api/keys/{kid}/revoke", {"confirmation_token": tok, "reason": "screenshot demo", "confirm_name": "backup-key"})
            logout()
            # 8. operator: allowed encrypt, tampered package, revoked key
            login("operator1")
            page.wait_for_selector("#user-name")
            go("crypto")
            page.select_option("#encrypt-key-id", str(fixtures["keys"]["finance-key"]))
            page.fill("#encrypt-plaintext", "Synthetic payroll record")
            page.click("#form-encrypt button[type=submit]")
            page.wait_for_selector("#encrypt-result:visible")
            shot("10-operator-encrypt-allowed")
            page.fill("#decrypt-package-input", fixtures["altered_ciphertext"])
            page.click("#form-decrypt button[type=submit]")
            page.wait_for_timeout(900)
            shot("11-decrypt-tampered-package-denied")
            page.fill("#decrypt-package-input", old)
            page.click("#form-decrypt button[type=submit]")
            page.wait_for_timeout(900)
            shot("12-decrypt-revoked-key-denied")
            page.fill("#decrypt-package-input", fixtures["retired_version_package"])
            page.click("#form-decrypt button[type=submit]")
            page.wait_for_timeout(900)
            shot("13-decrypt-old-version-after-rotation")
            logout()
            # 9. viewer: limited navigation
            login("viewer")
            page.wait_for_selector("#user-name")
            shot("14-viewer-limited-navigation")
            denied = api("POST", "/api/crypto/encrypt", {"key_id": 2, "data": "x"})
            dialogs.append(f"viewer POST /api/crypto/encrypt -> HTTP {denied['status']} {denied['body']}")
            logout()
            # 10. audit log, then tamper and verify
            login("admin")
            page.wait_for_selector("#user-name")
            go("audit")
            shot("15-audit-log")
            page.click("#btn-verify-audit-full")
            page.wait_for_timeout(900)
            shot("16-audit-chain-verified")
            con = sqlite3.connect(db)
            con.execute("DROP TRIGGER audit_no_update")
            con.execute("UPDATE audit_events SET reason='tampered' WHERE entry_no=3")
            con.commit()
            con.close()
            page.click("#btn-verify-audit-full")
            page.wait_for_selector("#audit-tamper-banner:visible", timeout=8000)
            shot("17-audit-tamper-detected")
            browser.close()
        (OUT / "dialogs.txt").write_text("\n".join(f"- {m}" for m in dialogs) + "\n")
        print(f"{len(list(OUT.glob('*.png')))} screenshots in {OUT}")
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
