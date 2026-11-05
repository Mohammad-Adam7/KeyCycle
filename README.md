# KeyCycle: Cryptographic Key Lifecycle Manager

KeyCycle is a training-grade web service for managing the lifecycle of cryptographic keys. It supports key creation, controlled encryption and decryption, scheduled rotation, expiry, revocation, and backup and recovery. Every security-relevant action is recorded in a tamper-evident audit log.


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
