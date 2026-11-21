# KeyCycle: Cryptographic Key Lifecycle Manager

KeyCycle is a training-grade web service for managing the lifecycle of cryptographic keys. Parts A, B, C, and D are fully implemented, providing authentication, an encrypted master vault, controlled encryption and decryption, key versioning, scheduled and manual rotation, expiry enforcement, permanent revocation, a tamper-evident SHA-256 audit chain, authenticated backups, non-destructive recovery drills, downloadable sanitized reports, and a complete browser UI.


## Design principles

- **The server decides.** Authorisation is enforced on the server for every request. Restrictions in the browser are a convenience, not a safeguard.
- **No readable secrets.** Passwords are stored only as Argon2id hashes. Key material is stored only in encrypted form, and the master key exists only in server memory.
- **Every decision is explainable.** Each result records the rule applied, its version and the thresholds in force.
- **Safe failure.** Errors use stable codes and never expose internal detail.

## Team and responsibilities

| Member | Area | Requirements | Responsibility |
|---|---|---|---|
| **A** | Authentication, Roles and Vault Security | FR-1, FR-2 | User login and logout, secure sessions, password hashing, Administrator / Operator / Viewer permissions, vault locking and unlocking, master-key derivation, and encrypted storage of keys. |
| **B** | Encryption Engine and Key Lifecycle | FR-3, FR-4, FR-5 | Key versioning, AES-256-GCM encryption and decryption, ciphertext package handling, scheduled and manual rotation, expiry enforcement and revocation. |
| **C** | Audit Chain, Backup and Recovery | FR-6, FR-7 | Append-only audit entries, SHA-256 hash chaining and verification, authenticated backups, restore checks and recovery drills. |
| **D** | Frontend, API Integration and Security Testing | Cross-module | Implementation of the wireframe screens, connection to the A/B/C APIs, display of decisions and errors, report views and exports, and integration tests T1 to T6 and T-final. |

Full requirements, data model, roles, API and threat model are in the project design document.

## Architecture

The system is arranged in five layers. Security logic lives in the lower layers and is never left to the browser alone.

| Layer | Contents |
|---|---|
| Browser interface | Forms, dashboard, evidence view and report export |
| API and service layer | Authentication, authorisation, input validation and safe error handling |
| Security engine | Cryptography, key-state, policy and audit-chain logic, independent of the web framework |
| Repository layer | SQLite storage with parameterised queries and an append-only audit table |
| Test fixtures | Synthetic sample inputs, including invalid and hostile cases |

## Quick start

Requires Python 3.11 or later.

```
pip install -r requirements.txt
uvicorn app.main:create_app --factory
```

The database is created as `keycycle.db` in the working directory. Set `KEYCYCLE_DB` to use another path.

**First run.** Create the first administrator and the vault once:

```
POST /api/setup
{"username": "...", "password": "...", "vault_passphrase": "..."}
```

Setup closes permanently after first use. The vault is locked every time the service starts; an administrator unlocks it with `POST /api/vault/unlock`. If the vault passphrase is lost, stored keys cannot be recovered.

**Run the tests.**

```
python -m pytest
```

Set `KEYCYCLE_FAST_KDF=1` to use lightweight key-derivation settings for tests only. Never use it in a real deployment.

## Part C: audit and recovery

Every audit entry commits to its complete canonical content and the previous entry with SHA-256. The database blocks updates and deletes, and `POST /api/audit/verify` reports the first mismatch. `GET /api/audit` provides administrator-only filtering and the current chain head; verification can also compare a previously saved `expected_count` and `expected_hash` to detect truncation.

Backups are stored only in the `backups/` folder beside the database. They include encrypted key versions, metadata, users with password hashes, vault parameters, settings, and the audit chain—never sessions, tokens, passphrases, plaintext, or raw keys. Each file is authenticated with HMAC-SHA-256 under a domain-separated key derived from the in-memory vault master key.

Backup creation and restore use single-use confirmations:

```
POST /api/confirmations  {"action":"backup"}
POST /api/backups        {"confirmation_token":"..."}

POST /api/confirmations  {"action":"restore","backup_name":"keycycle-...kcbak"}
POST /api/backups/{name}/restore
{"confirmation_token":"...","passphrase":"..."}
```

A restore accepts only a listed server-side filename, verifies the HMAC and embedded audit chain before changing the database, retains an intact live audit chain, clears all sessions, and leaves the vault locked. `POST /api/recovery-drill` validates a backup in an isolated database and proves that a restored encrypted key can decrypt an authenticated recovery challenge without replacing live data.

If the database file itself has been lost, recover it offline into a path that does not already exist. The passphrase is read from a masked prompt and never accepted as a command-line argument:

```
python scripts/recover_backup.py --database keycycle.db --backup keycycle-...kcbak
```

For a presentation-ready live walkthrough, start the server against a seeded demo database and run:

```powershell
python scripts/demo_part_c.py --base-url http://127.0.0.1:8000
```

The walkthrough checks the audit chain, creates and verifies an authenticated backup, runs all four recovery-drill steps, verifies the resulting chain again, and prints no credentials or key material.

## Part D: Frontend, Reports and Evaluation Suite

Part D delivers the browser user interface, report export subsystem, and cross-module security evaluation suite:

### 1. Browser Interface (Midnight Navy + Electric Cyan)

A fully self-contained, zero-dependency browser application compliant with strict Content-Security-Policy (`default-src 'self'`). It covers all wireframe screens from Section 5 of the design specification:

- **Sign-in & One-Time Setup (5.3)**: Initial setup handler with automatic credential transfer to prevent sign-in typos, masked inputs, and session timeout indicators.
- **Dashboard (5.4)**: In-memory vault status indicator with lock/unlock toggle, live audit chain head counter, verification status, and key metrics.
- **Key Management (5.5 & 5.6)**: Key catalog with active/expired/revoked state badges, version inspection modal, manual rotation with single-use confirmation, and permanent revocation dialog requiring reason and typed confirmation.
- **Encrypt and Decrypt (5.7)**: Role-restricted key selector, real-time byte size counter against the 64 KiB limit, `kc1` wire format package output, and explainable decision badges (rule name and version, decision outcome, key ID/version, duration).
- **Audit Log & Integrity Verification (5.8)**: Full audit trail with action/outcome filters, live chain verification, and prominent pulsing red alert banner upon tamper detection.
- **Backups, Recovery Drill & Reports (5.9)**: List of server-stored `.kcbak` files with byte sizes, HMAC verification, 4-step non-destructive recovery drill runner, and role-sanitized report exports.
- **Administration (5.10)**: User management with enable/disable toggles, user creation modal, security threshold viewer, and rule version patcher.

To launch the web interface:
```bash
uvicorn app.main:create_app --factory --reload
```
Navigate to `http://127.0.0.1:8000/`.

### 2. Report Export Subsystem

`GET /api/reports/export?format=csv|json` provides downloadable reports stamped with generation time, audit chain count, and chain head hash:
- **Administrator**: Full records including keys, versions, users, settings, and complete audit events with details.
- **Operator**: Key information and own audit events only.
- **Viewer**: Key catalog and decision outcomes without usernames, roles, or internal details.

### 3. Evaluation Test Suite: T1 to T6 and T-final

Run the complete 124-test suite:
```bash
KEYCYCLE_FAST_KDF=1 python -m pytest
```
Covers:
- **T1**: Wrong passphrase lockout defense.
- **T2**: Role-based access control and purpose separation.
- **T3**: Rotation compatibility (retired versions remain decryptable) and AAD binding.
- **T4**: Expired key encryption refusal and permanent revocation refusal.
- **T5**: Cryptographic audit hash verification and first-mismatch tamper detection.
- **T6**: Authenticated backup verification and 4-step recovery drill.
- **T-final**: Acceptance testing (payload size limits, CSRF protection, single-use confirmation replay prevention, safe failure formatting).
