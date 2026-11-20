# Part C API and recovery contract

All paths start with `/api`. Every endpoint requires an authenticated administrator. POST requests also require the session's `x-csrf-token`. Backup/restore operations are covered by the existing per-user sensitive-action rate limit.

## Audit endpoints

### `GET /audit`

Optional query fields: `before_entry`, `limit` (1–100), `action`, `user`, `outcome` and `severity`. Duplicate, unknown or malformed fields are rejected and audited. Items are returned newest first with `next_cursor` and `chain_head`.

### `POST /audit/verify`

The body may be `{}` or may contain a previously retained chain head:

```json
{"expected_count": 125, "expected_hash": "64 lowercase hexadecimal characters"}
```

Verification recomputes from entry 1 and checks sequential entry numbers, each previous hash and each canonical entry hash. Success returns the verified head and then appends an `audit_verify` success event. Failure returns HTTP 409 `TAMPER_DETECTED`, `first_mismatch`, a mismatch reason and a critical audit event. Supplying an expected head also detects recent-entry truncation.

## Confirmation requests

High-impact C operations use `POST /confirmations`:

```json
{"action":"backup"}
{"action":"restore","backup_name":"keycycle-20261120T010203Z-0123abcd.kcbak"}
{"action":"recovery_drill","backup_name":"keycycle-20261120T010203Z-0123abcd.kcbak"}
```

The returned token is bound to the administrator, session, action and target. It is stored only as a hash, expires after 300 seconds and is consumed only by the matching committed action.

## Backup endpoints

| Method and path | Request | Purpose |
|---|---|---|
| `GET /backups` | None | List bounded backup filenames from the fixed server folder |
| `POST /backups` | `{"confirmation_token":"..."}` | Snapshot and authenticate the database while the vault is unlocked |
| `POST /backups/{name}/verify` | None | Verify HMAC, structure, relational invariants and audit chain using the unlocked vault |
| `POST /backups/{name}/restore` | `{"confirmation_token":"...","passphrase":"..."}` | Verify with the backup's vault passphrase, restore and invalidate sessions |

Backup creation refuses a locked vault or a live audit chain that already fails verification. A created file has a server-generated name matching `keycycle-YYYYMMDDTHHMMSSZ-xxxxxxxx.kcbak` and is opened with exclusive creation semantics.

The authenticated content contains format/schema versions, UTC creation time, chain count/hash, a synthetic recovery proof and these tables: users, keys, key versions, audit events, settings and vault. Binary fields use canonical unpadded URL-safe Base64. The HMAC covers canonical UTF-8 JSON with sorted keys and no insignificant whitespace.

Restore never accepts a caller-supplied filesystem path. Before the database transaction it bounds the filename and file size, rejects duplicate JSON keys and authenticates the content. It reconstructs the data in an isolated database to apply SQLite constraints and foreign-key checks. Wrapped key IDs and versions are retained exactly because they are bound into AES-GCM additional authenticated data.

If the live audit chain is valid, its rows remain and the backup head must be a prefix. If the live chain is empty or invalid after loss, the verified backup audit rows become the base chain. The restore event records the before/backup heads. Sessions, confirmations and failure counters are cleared, and the in-memory vault is locked. The initiating HTTP response succeeds, but its session is no longer valid afterwards.

## Recovery drill

`POST /recovery-drill`:

```json
{
  "backup_name": "keycycle-20261120T010203Z-0123abcd.kcbak",
  "confirmation_token": "...",
  "passphrase": "..."
}
```

The drill authenticates the file, verifies its audit chain, reconstructs its records in isolation, unwraps a backed-up key and decrypts the HMAC-protected synthetic challenge. It returns four step results and records the drill. No plaintext application data is placed in a backup.

## Complete database loss

With the server stopped, recover into a path that does not exist:

```powershell
.\.venv\Scripts\python.exe scripts\recover_backup.py `
  --database recovered.db `
  --backup keycycle-20261120T010203Z-0123abcd.kcbak
```

The command reads the vault passphrase from a masked prompt, authenticates and validates the backup, builds a temporary database, appends a `disaster_restore` event and atomically links the completed database into place. It refuses to overwrite an existing target.

## Stable errors

| Code | HTTP | Meaning |
|---|---:|---|
| `FORBIDDEN` | 403 | Role is not administrator |
| `VAULT_LOCKED` | 423 | Backup creation/verification requires the in-memory master key |
| `CONFIRMATION_REQUIRED` | 409 | Token is missing, expired, used or bound to another target/action/session |
| `BACKUP_INVALID` | 422 | Filename, size, JSON, HMAC, schema, constraints or embedded chain failed |
| `TAMPER_DETECTED` | 409 | Live audit verification found its first mismatch |
| `INVALID_INPUT` | 400 | Body/query contains missing, extra or malformed fields |

