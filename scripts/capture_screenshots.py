"""Capture UI screenshots for the report from a throw-away SYNTHETIC demo database.

Optional tool (not needed to run KeyCycle):
    pip install playwright && playwright install chromium
    python3 scripts/capture_screenshots.py

Writes evidence/screenshots/*.png and evidence/screenshots/dialogs.txt (API refusals that a
screenshot cannot show). Captures run with reduced motion so every screen is settled. Nothing here
touches your own database."""
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
            # Reduced motion: the interface skips its transitions, so every capture is of a settled screen.
            context = browser.new_context(viewport={"width": 1280, "height": 860}, reduced_motion="reduce")
            page = context.new_page()
            page.set_default_timeout(120000)   # software-rendered browsers build the 3D lighting slowly

            def shot(name, note=""):
                page.wait_for_timeout(600)
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

            def login(user, password=PW, ok=True):
                page.goto(base + "/login")
                page.wait_for_selector("#auth-submit:not([disabled])")
                page.wait_for_timeout(300)
                page.fill("#login-username", user)
                page.fill("#login-password", password)
                page.click("#auth-submit")
                if ok:
                    try:
                        page.wait_for_selector("#app:not([hidden])")
                    except Exception:
                        print("sign-in failed:", page.inner_text("#auth-error"))
                        raise
                    page.wait_for_timeout(800)

            def logout():
                api("POST", "/api/auth/logout")

            def go(view):
                page.click(f"#nav-{view}")
                page.wait_for_timeout(900)

            def wait_until(js, timeout=30):
                # polled with evaluate: wait_for_function would need eval, which the CSP forbids
                for _ in range(int(timeout * 5)):
                    if page.evaluate(js):
                        return
                    page.wait_for_timeout(200)
                raise TimeoutError(js)

            def dialog_fill(value):
                page.wait_for_selector(".dlg input[type=password]")
                page.fill(".dlg input[type=password]", value)
                page.click(".dlg button[type=submit]")

            # 1. failed sign-in: generic message
            login("admin", "wrong-password-1", ok=False)
            wait_until("document.querySelector('#auth-error').textContent.length > 0")
            shot("01-login-failed-generic-message")
            # 2. admin dashboard, vault locked
            login("admin")
            shot("02-dashboard-admin-vault-locked")
            # 3. wrong passphrase
            page.click("#vault-btn")
            dialog_fill("wrong-passphrase-123")
            wait_until("document.querySelector('.dlg .err') && document.querySelector('.dlg .err').textContent.length > 0")
            shot("03-vault-wrong-passphrase")
            # 4. correct passphrase
            page.fill(".dlg input[type=password]", PW)
            page.click(".dlg button[type=submit]")
            page.wait_for_selector(".dlg", state="detached")
            page.wait_for_timeout(800)
            shot("04-vault-unlocked")
            # 5. keys with active / expired / revoked states
            go("keys")
            page.wait_for_selector("#keys-body tr.k")
            shot("05-keys-states")
            # 6. password dialog
            page.click("#btn-password")
            page.wait_for_selector(".dlg")
            shot("06-change-password-dialog")
            page.keyboard.press("Escape")
            page.wait_for_selector(".dlg", state="detached")
            # 7. backup + recovery drill (admin)
            tok = api("POST", "/api/confirmations", {"action": "backup"})["body"]["data"]["confirmation_token"]
            name = api("POST", "/api/backups", {"confirmation_token": tok})["body"]["data"]["name"]
            go("backup")
            page.wait_for_selector(f'#bk-list li[data-name="{name}"]')
            shot("07-backups-list")
            page.click(f'#bk-list li[data-name="{name}"] button[data-act=drill]')
            dialog_fill(PW)
            wait_until("document.querySelectorAll('#drill li.on').length === 4")
            shot("08-recovery-drill-results")
            go("admin")
            page.wait_for_selector("#settings li[data-name]")
            shot("09-administration-users-settings")
            # prepare a revoked-key package for the operator screen
            logout()
            login("operator1")
            old = api("POST", "/api/crypto/encrypt", {"key_id": fixtures["keys"]["backup-key"], "data": "revoked-key demo"})["body"]["data"]["package"]
            logout()
            login("admin")
            kid = fixtures["keys"]["backup-key"]
            tok = api("POST", "/api/confirmations", {"action": "revoke", "key_id": kid})["body"]["data"]["confirmation_token"]
            api("POST", f"/api/keys/{kid}/revoke", {"confirmation_token": tok, "reason": "screenshot demo", "confirm_name": "backup-key"})
            logout()
            # 8. operator: allowed encrypt, tampered package, revoked key, retired version
            login("operator1")
            go("crypto")
            page.wait_for_selector("#pick-btn:not([disabled])")
            page.click("#pick-btn")
            page.click(f'#pick-list li[data-id="{fixtures["keys"]["finance-key"]}"]')
            page.fill("#enc-data", "Synthetic payroll record")
            page.click("#enc-go")
            page.wait_for_selector("#enc-out .pkg")
            shot("10-operator-encrypt-allowed")

            def decrypt(package, name):
                page.fill("#dec-pkg", package)
                page.click("#dec-go")
                page.wait_for_selector("#dec-out .decision")
                shot(name)
            decrypt(fixtures["altered_ciphertext"], "11-decrypt-tampered-package-denied")
            decrypt(old, "12-decrypt-revoked-key-denied")
            decrypt(fixtures["retired_version_package"], "13-decrypt-old-version-after-rotation")
            logout()
            # 9. viewer: limited navigation
            login("viewer")
            shot("14-viewer-limited-navigation")
            denied = api("POST", "/api/crypto/encrypt", {"key_id": 2, "data": "x"})
            dialogs.append(f"viewer POST /api/crypto/encrypt -> HTTP {denied['status']} {denied['body']}")
            logout()
            # 10. audit log, then tamper and verify
            login("admin")
            go("audit")
            page.wait_for_selector("#entries li[data-entry]")
            shot("15-audit-log")
            page.click("#audit-verify")
            page.wait_for_selector("#entries li.ok")
            shot("16-audit-chain-verified")
            con = sqlite3.connect(db)
            con.execute("DROP TRIGGER audit_no_update")
            con.execute("UPDATE audit_events SET reason='tampered' WHERE entry_no=3")
            con.commit()
            con.close()
            page.click("#audit-verify")
            page.wait_for_selector("#tamper .tamper", timeout=8000)
            shot("17-audit-tamper-detected")
            browser.close()
        (OUT / "dialogs.txt").write_text("\n".join(f"- {m}" for m in dialogs) + "\n")
        print(f"{len(list(OUT.glob('*.png')))} screenshots in {OUT}")
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
