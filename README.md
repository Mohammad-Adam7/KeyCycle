# KeyCycle: Cryptographic Key Lifecycle Manager

KeyCycle is a training-grade web service for managing the lifecycle of cryptographic keys. Parts A, B and C implement authentication, the encrypted vault, controlled encryption and decryption, key versions, scheduled rotation, expiry and revocation, a tamper-evident audit chain, and authenticated backup and recovery. The frontend/integration work in Part D remains separate.


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
