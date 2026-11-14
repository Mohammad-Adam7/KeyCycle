**Part B API and integration contract**

Implemented against baseline 2311063. Run one server process and one worker per database. Every path below starts with `/api`. All requests require A's session cookie. Every POST also requires `x-csrf-token` from login. Authentication, CSRF and request limits remain A's code. Use HTTPS outside a local demonstration. The app's UI is still D's work.

**Start and authenticate**

One-time `POST /setup` accepts username/password/vault_passphrase and creates an administrator plus locked vault. Login at `POST /auth/login` with username/password; retain cookies and the returned CSRF token. Administrator unlocks with `POST /vault/unlock {"passphrase":"..."}`. Operator login does not unlock the vault. Never put credentials in URLs or source control.

**Permission matrix**

| Action | Administrator | Operator | Viewer |
|---|---|---|---|
| Create, confirm, rotate, revoke | Yes | No | No |
| Encrypt/decrypt | Test-purpose keys | Standard-purpose keys | No |
| Key metadata | Yes | Yes | Yes |
| Results | All B decisions | Own encrypt/decrypt only | Public projection |

Create/rotate/encrypt/decrypt require an unlocked vault. Metadata, confirmations, revocation and history work while locked. Revocation is final. Expiry at `now >= expires_at` forbids encrypt AND decrypt, across all versions, even before a scheduler tick. Rotation changes only current version, never expiry. Old versions remain decryptable while the parent key is active. Overdue rotation alone does not deny use.

**Routes and request bodies**

| Method/path | Request | Response data |
|---|---|---|
| POST `/keys` | `{"name":"payroll-key","purpose":"standard","rotation_days":90,"expires_at":null}` | 201 KeyDetail |
| GET `/keys` | Optional state, purpose, after_id, limit | 200 items/next_cursor |
| GET `/keys/{key_id}` | Optional version_after, versions_limit | 200 KeyDetail |
| POST `/crypto/encrypt` | `{"key_id":1,"data":"Sample text"}` | 200 `{package}` |
| POST `/crypto/decrypt` | `{"package":"kc1...."}` | 200 `{plaintext}` |
| POST `/confirmations` | `{"action":"rotate","key_id":1}` or revoke | 201 token/action/key_id/expires_at |
| POST `/keys/{key_id}/rotate` | `{"confirmation_token":"..."}` | 200 KeyDetail |
| POST `/keys/{key_id}/revoke` | `{"confirmation_token":"...","reason":"Retired","confirm_name":"payroll-key"}` | 200 KeyDetail |
| GET `/results` | Optional before_entry, limit | 200 items/next_cursor, newest first |
| GET `/results/{entry}` | Audit entry number | 200 projected decision |

Algorithm is omitted or exactly `AES-256-GCM`; no selector. Purpose is required (`standard` or `test`). Omitted rotation_days uses the setting value read at creation; explicit null is invalid. Later setting changes affect new keys only. Interval is a strict integer 1–365. IDs are positive integers no greater than 2^63−1. JSON booleans and strings cannot substitute for integers. Query/path numbers use decimal digits, no leading zeroes except cursor zero. Duplicate or unknown query fields are rejected.

Name is 1–64 characters, reason 1–200, no leading/trailing whitespace or Unicode control characters. All strings must encode as UTF-8; lone surrogates are rejected. Whitespace-only plaintext is valid; empty plaintext is rejected as the adopted team default. Reasons are administrative metadata: do not put secrets in them.

Expiry accepts RFC 3339 timezone-aware strings including browser `.toISOString()` milliseconds and 1–9 fractional digits. It floors to integer UTC seconds, must be later than creation time, and is returned as `YYYY-MM-DDTHH:MM:SSZ`. Naive timestamps and invalid offset components are rejected.

Key lists default to 50, max 100; ascending ID, `next_cursor` becomes next `after_id`. Effective-state filtering accounts for expiry even if stored state is stale. Key detail versions default to 50, max 100; ascending version, `versions_next_cursor` becomes `version_after`. Result lists default to 50, max 100; descending audit entry, `next_cursor` becomes `before_entry`. Authorization filtering precedes pagination.

**Response shapes**

Successful reads are `{data: ...}` and do not add audit entries. Successful POST decisions are `{result: ..., data: ...}`. Errors retain `{code, message, audit_entry}` and include `result` when B produced one. A's errors are unchanged. No B route returns NOT_IMPLEMENTED.

Example encryption success:

```json
{
  "result": {
    "decision": "allowed",
    "reason": {"code": "ENCRYPT_OK", "message": "Encrypt ok."},
    "rule": {"name": "vault_state_check", "version": 1},
    "thresholds": {"max_data_kib": {"value": 64, "setting_version": 1}},
    "key": {"id": 1, "version": 1},
    "evidence": {"state": "active", "purpose": "standard", "expires_at": null, "data_bytes": 11, "input_validation_version": 1},
    "severity": "info",
    "recommended_action": null,
    "duration_ms": 3,
    "audit_entry": 25,
    "test": false
  },
  "data": {"package": "kc1.<id>.<version>.<nonce>.<ciphertext>"}
}
```

KeySummary fields: id, name, algorithm, purpose, effective state, current_version, rotation_days, expires_at, created_at, next_rotation_due (null when inactive). KeyDetail adds versions (`version,status,created_at`), versions_next_cursor and revoked_at. Administrator detail additionally includes created_by username and revoke_reason. Wrapped key bytes/nonces never appear.

Confirmation response data: confirmation_token, action, key_id, expires_at. Tokens expire after 300 seconds, bind to user/session/action/target and expected version for rotation, and are stored hashed. Request a token when opening the dialog. For revoke, collect reason and exact typed name at execution. Tokens are consumed only on successful committed action; failed/denied operations do not spend them. Reuse/wrong name/session/action/key/stale version/expiry returns 409 CONFIRMATION_REQUIRED. Restart clears confirmations. Logout/disable invalidates the bound session. A fresh confirmation for an already revoked key returns REVOKE_REPEATED without changing original metadata.

ResultView common fields: entry, time, action, outcome, reason_code, severity, key_id, key_version, test. Admin/operator additionally receive rule, thresholds, evidence, recommended_action, duration_ms. Admin also receives user, role, reason_text. Viewer never gets those extra fields. Operator sees only own encrypt/decrypt. Missing and unauthorized entry IDs both return RESULT_NOT_FOUND. Result history never stores or returns plaintext/packages/tokens. Authenticated read denials are audited; successful reads are not.

**Error precedence**

Transport size (413) and malformed JSON (400) may precede authentication; A handles these without B audit. Then session (401), CSRF (403), broad role (403), rate limit (429). Valid JSON body schema errors (400) are audited as the authenticated actor. Then payload/package parsing, key existence, confirmation/name where applicable, purpose, effective state, vault and cryptographic checks. Session/role is rechecked inside each B transaction.

| Code | HTTP | Meaning |
|---|---|---|
| INVALID_INPUT | 400 | Invalid schema, type, Unicode, name, reason, expiry, path/query |
| PAYLOAD_TOO_LARGE | 413 | Plaintext or HTTP request exceeds limit |
| CIPHERTEXT_INVALID | 400 | Bad package, unknown decrypt key/version, bad tag or invalid decrypted UTF-8 |
| FORBIDDEN | 403 | Role or key purpose mismatch; no protected evidence |
| KEY_NOT_FOUND | 404 | Unknown key for authorized non-decrypt operation |
| RESULT_NOT_FOUND | 404 | Result absent or invisible to caller |
| KEY_EXPIRED / KEY_REVOKED | 409 | Parent key blocks all versions |
| VAULT_LOCKED | 423 | Master key unavailable |
| CONFIRMATION_REQUIRED | 409 | Confirmation missing, stale, expired, used or mismatched |
| INTERNAL_ERROR | 500 | Unexpected/storage failure; no exception message returned |

Policy denials intentionally remain distinguishable before tag checking; cryptographic failure causes are generic. Corrupt stored wrapped material is INTERNAL_ERROR, not blamed on user ciphertext. Denial/internal auditing is best-effort if storage itself is unavailable; no crypto output is released on audit failure.

**Limits and frozen cryptographic contract**

Data is text only, UTF-8 bytes counted, default 65,536 bytes; setting range 1–128 KiB. Decryption always accepts historical packages up to the hard 131,072-byte plaintext ceiling even after reducing the new-encryption limit. HTTP body stays 262,144 bytes including JSON escaping. A valid text length can still exceed HTTP body size after escaping. D uses `new TextEncoder().encode(text).length` for its counter.

Wire format: `kc1.<key_id>.<version>.<nonce>.<ciphertext>`. ASCII only, at most 180,000 characters. Positive canonical decimal IDs/versions; unpadded URL-safe Base64 only, canonical trailing bits. Nonce is 12 bytes (16 encoded characters). Ciphertext includes a 16-byte tag and is 16–131,088 bytes. Reject added fields/segments, standard Base64 +/ characters, equals padding, whitespace, bad prefix and noncanonical encodings.

Data AAD: ASCII `KeyCycle|data|1|{key_id}|{version}`.
Wrapping AAD: ASCII `KeyCycle|wrap|1|{key_id}|{version}`.
These formats cannot change without an explicit migration. C must preserve IDs and versions. AESGCM library calls use random 256-bit data keys and independent OS-random 96-bit message/wrap nonces; no user-specified AAD/nonce or selectable encryption version. Rotation generates new material; it does not rewrite ciphertext. No nonce registry or invocation counter is implemented: this is a low-volume training deployment, not an enforced high-volume GCM usage-budget system. Random nonces have probabilistic collision resistance and independent cloned databases are unsupported. Python cannot guarantee erasure of all temporary key byte copies.

**Audit and rule contract for C**

B actions: key_create, confirmation_issue, key_rotate, key_revoke, key_expire, rotation_deferred, encrypt, decrypt. Read-denial action names key_list/key_read/result_read are logged but excluded from B result history. Scheduler-local failures use `scheduler_failure` and are audit-only, excluded from result history. System actor is `system/system`. Details use key_id/key_version rather than the redacted top-level name `key`. All nested evidence is built from known fields; no request dictionary is recorded.

Rules: role_check, session_check, input_validation, key_state_check, vault_state_check, confirmation_check, rotation_policy. Integer base version 1; input_validation revision tracks max_data_kib setting version. Success primary rule is the last evaluated rule; evidence also records the input-validation revision for encryption. Key rotation interval is a per-key copied value, shown in evidence, not falsely substituted by today's default setting. Audit records capture values at decision time. Severity info for success, warning for denials/deferrals, critical for internal failures. Exceptions record type only.

State change, token consumption and success audit use one BEGIN IMMEDIATE transaction and one connection. All failures roll back before separate denial/failure auditing. `audit.record` must not commit or start a nested transaction. Successful crypto output is returned only after commit. In-flight crypto that already copied key material may complete while vault lock occurs; later acquisitions fail. Revocation/encryption ordering is serialized by SQLite.

**Scheduler and restore**

Scheduler starts/stops in FastAPI lifespan; TestClient without a context manager does not start it. Startup tick, 30-second interval and immediate unlock wake. Each due key is rechecked transactionally; one catch-up version, next due from actual rotation time. Locked keys produce one warning per key/version per scheduler lifetime; restart may warn again. Expiry works locked. Bounded batches of 100, per-key failure isolation, bounded expired-token cleanup. Shutdown joins before locking vault. `app.state.scheduler.status()` returns last_tick/last_success Unix seconds, error_count, deferred_count for D.

Restore must be offline with server stopped. Merely stopping the scheduler does not stop HTTP requests. C backs up keys/key_versions with original identities, excludes confirmations/sessions, and reopens with a locked vault. C implements backup authentication, chain verification and log preservation. D implements dashboard, screens and exports; B does not claim those routes exist.
