# KeyCycle – cryptographic key lifecycle manager

Class 2 · Group 9 · Proposal 24. A small web application that creates, rotates, expires and revokes
AES-256-GCM keys, lets operators encrypt and decrypt data with them, and records every decision in a
tamper-evident audit log. **All demo data is synthetic.**

| Piece | Choice |
|---|---|
| Server | FastAPI + Uvicorn (one worker – see "Limits") |
| Storage | SQLite (`schema.sql`), append-only hash-chained audit log |
| Passwords / vault | Argon2id (64 MiB, 3 passes, 4 lanes) |
| Encryption | AES-256-GCM, key id and version bound as associated data |
| Roles | administrator, operator, viewer |

## 1. Requirements
Python 3.11 or newer and `pip`. Linux, macOS or Windows. No other services.

## 2. Install
```bash
cd keycycle
python3 -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install -r requirements-dev.txt # runtime + pytest/httpx
```
Use `requirements.txt` instead if you only want to run the app.

## 3. Create a demo database (synthetic users and keys)
```bash
mkdir -p demo
python3 scripts/seed_demo.py --db demo/demo.db --fixtures demo/fixtures.json
```
It asks for one password (all demo users share it, 12+ characters) and a vault passphrase (12+ characters).
Nothing is printed. The target file must not already exist; delete it to start over.
Demo users: `admin`, `operator1`, `operator2`, `viewer`, and `trainee` (disabled).

> Never set `KEYCYCLE_FAST_KDF=1` while seeding a database you intend to keep. That switch weakens
> Argon2 and exists only for automated tests and screenshots.

## 4. Run
```bash
KEYCYCLE_DB=demo/demo.db python3 -m uvicorn app.main:create_app --factory --port 8000
```
Open <http://127.0.0.1:8000>. The overview page tells KeyCycle’s story; press **Sign in** (top right), or go straight to
<http://127.0.0.1:8000/login>. After signing in, press **Unlock vault** on the dashboard and enter the passphrase.
Run **one** worker only (rate limits, lockouts and the unlocked vault key live in process memory).

### Starting with an empty database instead
Leave `KEYCYCLE_DB` unset (creates `keycycle.db`), open <http://127.0.0.1:8000/login>, choose **First-time setup**, and create
the first administrator. Setup works exactly once; afterwards it is refused and the refusal is audited.
The same form asks for the vault passphrase (12+ characters), which creates the vault. Write the passphrase
down – it cannot be recovered or reset. After setup the vault is locked; sign in and unlock it.

## 5. Test
```bash
python3 -m pytest -q                              # 155 tests
python3 scripts/evidence_pack.py                  # T1-T6 + T-final, FP/FN, latency -> evidence/
python3 scripts/evidence_pack.py --fast           # same, weak KDF, ~1 minute
pip install pytest-cov && python3 -m pytest --cov=app -q   # coverage (90% statements at hand-in)
```
Optional screenshots (needs `pip install playwright && playwright install chromium`):
```bash
python3 scripts/capture_screenshots.py            # -> evidence/screenshots/*.png and dialogs.txt
```
The evidence scripts use temporary databases and never touch `demo/demo.db`.

## 6. Disaster recovery in one line
```bash
python3 scripts/recover_backup.py --database restored.db --backup <file>.kcbak   # asks for the vault passphrase
```
Full procedure: `doc/ADMIN_GUIDE.md`, section 6.

## 7. Layout
```
app/        FastAPI application (main.py, auth, vault, key_service, audit, backup, reports)
app/static/ index.html; app.js (signed-in app), landing.js (overview page), kc3d.js (3D helpers),
            style.css, landing.css; vendor/ (three.js, GSAP) and fonts/, served locally, no CDN
schema.sql  database schema and the audit-log triggers
scripts/    seed_demo.py, recover_backup.py, evidence_pack.py, capture_screenshots.py, demo_part_*.py
tests/      pytest suite
evidence/   evidence_report.md, evidence.json, coverage.txt, screenshots/
doc/        USER_GUIDE.md, ADMIN_GUIDE.md, DEMO_SCRIPT.md
```

## 8. Known limits (stated honestly)
- Run behind a TLS-terminating proxy for any real use; the app itself speaks plain HTTP.
- One process only. No MFA. The vault passphrase cannot be changed in the UI.
- Backups are authenticated (HMAC) but **not encrypted**; keys inside are wrapped, but metadata and the audit log are readable. Store them as you would the database.
- The audit chain is unkeyed: an attacker with file access can rewrite it end-to-end. Keep a remembered chain head (the UI stores one in the browser; backups carry one) and verify against it.
- A restore returns the vault to the backup's moment: keys created afterwards are lost. Revocations and disabled users are never undone by a restore.
- Repeated failed logins can lock an account for a while (a deliberate trade-off).
- The interface’s 3D and motion need WebGL and a graphics card to run smoothly. Without WebGL it skips the
  overview page and the 3D pieces and still works; with the system’s “reduce motion” setting on, it shows still screens.
