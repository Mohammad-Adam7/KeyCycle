# KeyCycle evidence report

Generated 2026-11-22 18:42 UTC on linux with production Argon2id settings (64 MiB, 3 passes, 4 lanes). All data is synthetic; every run uses temporary databases.

**Result: 43 of 43 evaluation steps passed.**

| Case | Title | Steps | Passed |
|---|---|---|---|
| T1 | Wrong passphrase | 5 | 5 |
| T5 | Audit tampering | 4 | 4 |
| T2 | Unauthorised use | 9 | 9 |
| T3 | Rotation compatibility | 6 | 6 |
| T4 | Expired or revoked keys | 5 | 5 |
| T6 | Recovery procedures | 5 | 5 |
| T-final | Malformed / oversized input, unauthorised request, repeated submission, safe failure, restart | 9 | 9 |

## T1: Wrong passphrase

| # | Step | Input | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|---|
| T1.1 | Wrong vault passphrase | admin unlocks with an incorrect passphrase | 403 PASSPHRASE_INVALID, vault stays locked, attempt audited | HTTP 403 PASSPHRASE_INVALID | audit #17: vault_unlock/failure/PASSPHRASE_INVALID | PASS |
| T1.2 | Vault still locked | GET /api/vault/status | locked = true | locked = True | - | PASS |
| T1.3 | Lockout after repeated failures | 5 wrong passphrases, then the CORRECT one | 429 TOO_MANY_ATTEMPTS (even the right passphrase is refused during lockout) | HTTP 429 TOO_MANY_ATTEMPTS | audit #22: vault_unlock/denied/TOO_MANY_ATTEMPTS | PASS |
| T1.4 | Passphrase never logged | search every vault_unlock audit entry for any passphrase | no passphrase text in the audit log | 6 unlock entries, passphrase found: False | - | PASS |
| T1.5 | Generic login failure | wrong password for a real user vs unknown username | identical status and message (no account enumeration) | HTTP 401 / 401; messages identical: True | audit #24: login/failure/AUTH_FAILED | PASS |

## T5: Audit tampering

| # | Step | Input | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|---|
| T5.1 | Untouched chain verifies | admin runs Verify chain on the seeded database | 200, valid, head recorded | valid; 16 entries, head 3ed95bf7a76c… | audit #17: audit_verify/success/- | PASS |
| T5.2 | Edited entry is detected | attacker drops the update trigger and edits entry #3, then Verify | 409 TAMPER_DETECTED, first_mismatch 3, severity critical | HTTP 409 TAMPER_DETECTED, first_mismatch=3, reason=ENTRY_HASH | audit #22: audit_verify/failure/TAMPER_DETECTED | PASS |
| T5.3 | Detection itself is audited | count critical audit_verify entries | at least 1 | 1 critical entry | - | PASS |
| T5.4 | Truncated tail caught by an anchor | attacker deletes the last entries; Verify with the remembered head | an unanchored Verify cannot see it; the anchored one returns TAMPER_DETECTED (CHAIN_TRUNCATED) | unanchored: HTTP 200; anchored: HTTP 409 CHAIN_TRUNCATED | audit #16: audit_verify/failure/TAMPER_DETECTED | PASS |

## T2: Unauthorised use

| # | Step | Input | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|---|
| T2.1 | Viewer tries to encrypt | viewer POST /crypto/encrypt key 2 | 403 FORBIDDEN, generic message only (no key, rule or record detail), attempt logged | HTTP 403 FORBIDDEN | audit #21: use_key/denied/FORBIDDEN | PASS |
| T2.2 | Administrator uses a standard key | admin encrypts with finance-key (standard) | 403 FORBIDDEN (purpose separation: admins only use test keys) | HTTP 403 FORBIDDEN (rule role_check v1) | audit #22: encrypt/denied/FORBIDDEN | PASS |
| T2.3 | Operator uses a test key | operator encrypts with test-key | 403 FORBIDDEN | HTTP 403 FORBIDDEN (rule role_check v1) | audit #23: encrypt/denied/FORBIDDEN | PASS |
| T2.4 | Operator creates a key | operator POST /keys | 403 FORBIDDEN | HTTP 403 FORBIDDEN | audit #24: manage_keys/denied/FORBIDDEN | PASS |
| T2.5 | Operator reads the audit log | operator GET /audit | 403 FORBIDDEN | HTTP 403 FORBIDDEN | audit #25: view_audit/denied/FORBIDDEN | PASS |
| T2.6 | No session | POST /crypto/encrypt without signing in | 401 SESSION_EXPIRED | HTTP 401 SESSION_EXPIRED | - | PASS |
| T2.7 | Missing CSRF token | authenticated POST without X-CSRF-Token | 403 CSRF_INVALID | HTTP 403 CSRF_INVALID | - | PASS |
| T2.8 | Disabled account | login as the disabled user 'trainee' with the correct password | 401 AUTH_FAILED | HTTP 401 AUTH_FAILED | audit #28: login/failure/AUTH_FAILED | PASS |
| T2.9 | Viewer sees sanitised results | viewer GET /results | results exclude user names and evidence | 17 items; user/evidence fields present: False | - | PASS |

## T3: Rotation compatibility

| # | Step | Input | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|---|
| T3.1 | Old version still decrypts | operator decrypts a package made under payroll-key v1 (key is now v3) | 200, plaintext 'Synthetic payroll sample' | HTTP 200 DECRYPT_OK (rule vault_state_check v1) | audit #30: decrypt/success/DECRYPT_OK | PASS |
| T3.2 | Rotate payroll-key | admin rotates payroll-key with a single-use confirmation | 200 ROTATE_OK, current version 4 | HTTP 200 ROTATE_OK (rule vault_state_check v1) | audit #33: key_rotate/success/ROTATE_OK | PASS |
| T3.3 | Every version decrypts after rotation | decrypt packages from v1, v3 and the new v4 | all three return their original plaintext | plaintexts: ['version three', 'version four', 'Synthetic payroll sample'] | - | PASS |
| T3.4 | Tampered package: altered_ciphertext | decrypt fixtures.altered_ciphertext | 400 CIPHERTEXT_INVALID (AAD binds key id and version) | HTTP 400 CIPHERTEXT_INVALID (rule input_validation v1) | audit #38: decrypt/denied/CIPHERTEXT_INVALID | PASS |
| T3.5 | Tampered package: altered_version | decrypt fixtures.altered_version | 400 CIPHERTEXT_INVALID (AAD binds key id and version) | HTTP 400 CIPHERTEXT_INVALID (rule input_validation v1) | audit #39: decrypt/denied/CIPHERTEXT_INVALID | PASS |
| T3.6 | Tampered package: altered_key | decrypt fixtures.altered_key | 400 CIPHERTEXT_INVALID (AAD binds key id and version) | HTTP 400 CIPHERTEXT_INVALID (rule input_validation v1) | audit #40: decrypt/denied/CIPHERTEXT_INVALID | PASS |

## T4: Expired or revoked keys

| # | Step | Input | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|---|
| T4.1 | Revoked key | encrypt with legacy-api (revoked) | 409 KEY_REVOKED (rule key_state_check) | HTTP 409 KEY_REVOKED (rule key_state_check v1) | audit #41: encrypt/denied/KEY_REVOKED | PASS |
| T4.2 | Expired key | encrypt with archive-2026 (expired) | 409 KEY_EXPIRED | HTTP 409 KEY_EXPIRED (rule key_state_check v1) | audit #42: encrypt/denied/KEY_EXPIRED | PASS |
| T4.3 | Revoke a rotated key | admin revokes backup-key (two versions) with confirmation and typed name | 200 REVOKE_OK | HTTP 200 REVOKE_OK (rule confirmation_check v1) | audit #48: key_revoke/success/REVOKE_OK | PASS |
| T4.4 | All versions refused after revocation | decrypt the v1 and v2 packages | both 409 KEY_REVOKED | v1: HTTP 409 KEY_REVOKED (rule key_state_check v1) \| v2: HTTP 409 KEY_REVOKED (rule key_state_check v1) | audit #50: decrypt/denied/KEY_REVOKED | PASS |
| T4.5 | Revoked key cannot be rotated | request a rotate confirmation for the revoked key | 409 KEY_REVOKED | HTTP 409 KEY_REVOKED (rule key_state_check v1) | audit #51: confirmation_issue/denied/KEY_REVOKED | PASS |

## T6: Recovery procedures

| # | Step | Input | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|---|
| T6.1 | Create an authenticated backup | admin creates a backup with a single-use confirmation | 201 BACKUP_CREATED | HTTP 201 BACKUP_CREATED | file keycycle-20261122T184226Z-81ca40e1.kcbak; audit #53: backup_create/success/- | PASS |
| T6.2 | Verify the backup | verify HMAC and the embedded audit chain | 200 valid | HTTP 200 OK | audit #54: backup_verify/success/- | PASS |
| T6.3 | Recovery drill | run the 4-step drill in isolation (live data untouched) | authenticate backup, verify chain, restore in isolation, decrypt proof: all pass | HTTP 200: authenticate_backup=pass, verify_audit_chain=pass, restore_in_isolation=pass, decrypt_recovery_proof=pass | audit #56: recovery_drill/success/- | PASS |
| T6.4 | Corrupted backup is rejected | flip one byte in a copy and verify it | 422 BACKUP_INVALID | HTTP 422 BACKUP_INVALID | audit #57: backup_verify/failure/BACKUP_INVALID | PASS |
| T6.5 | Real recovery after losing the database | restore the backup into an empty location with scripts/recover_backup.py; try a wrong passphrase first | wrong passphrase refused; right one restores; vault unlocks; an OLD ciphertext decrypts | wrong passphrase refused: True; restored audit entry #53; unlock HTTP 200; decrypt HTTP 200 | recovery audit entry #53, chain head f87aecef0f65… | PASS |

## T-final: Malformed / oversized input, unauthorised request, repeated submission, safe failure, restart

| # | Step | Input | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|---|
| T-final.1 | Malformed JSON | POST '{not json' | 400 INVALID_INPUT, no stack trace | HTTP 400 INVALID_INPUT | - | PASS |
| T-final.2 | Unexpected field | extra property 'is_admin' | 400 INVALID_INPUT | HTTP 400 INVALID_INPUT (rule input_validation v1) | audit #58: encrypt/denied/INVALID_INPUT | PASS |
| T-final.3 | Injection attempt in a field | key_id = "2; DROP TABLE keys" | 400 INVALID_INPUT (typed schema) | HTTP 400 INVALID_INPUT (rule input_validation v1) | audit #59: encrypt/denied/INVALID_INPUT | PASS |
| T-final.4 | Oversized data | 65 KiB of plaintext (limit 64 KiB) | PAYLOAD_TOO_LARGE with the threshold recorded | HTTP 413 PAYLOAD_TOO_LARGE (rule input_validation v1) | threshold {"max_data_kib": {"value": 64, "setting_version": 1}}; audit #60: encrypt/denied/PAYLOAD_TOO_LARGE | PASS |
| T-final.5 | Oversized request body | 300 KiB body (hard limit 256 KiB) | 413 PAYLOAD_TOO_LARGE before parsing | HTTP 413 PAYLOAD_TOO_LARGE | - | PASS |
| T-final.6 | Repeated submission (replay) | reuse a consumed rotation confirmation | 409 CONFIRMATION_REQUIRED, no second rotation | HTTP 409 CONFIRMATION_REQUIRED (rule confirmation_check v1) | audit #63: key_rotate/denied/CONFIRMATION_REQUIRED | PASS |
| T-final.7 | Rate limit on a sensitive action | 35 encrypts in a few seconds (limit 30/min/user) | first 30 succeed, the rest 429 RATE_LIMITED | 30 x 200, 5 x 429 | - | PASS |
| T-final.8 | Safe failure | verify a backup that does not exist | 422 BACKUP_INVALID with a generic message, no path or stack trace | HTTP 422 BACKUP_INVALID | audit #99: backup_verify/failure/BACKUP_INVALID | PASS |
| T-final.9 | Recovery after restart | start a NEW application process on the same database | vault locked (423 VAULT_LOCKED), keys and audit chain intact, works again after unlock | before unlock HTTP 423; after unlock HTTP 200; chain verify HTTP 200; keys 6 -> 6 | audit chain verified after restart | PASS |

## Decision matrix (false positives and false negatives)

49 requests with a known correct outcome. **False positives** (allowed but should be denied): **0**. **False negatives** (denied but should be allowed): **0**. Accuracy 100.0% (16 correct allows, 33 correct denials).

| Request | Expected | Actual | HTTP | Correct |
|---|---|---|---|---|
| admin encrypts with a standard key | deny | deny | 403 | yes |
| admin encrypts with a test key | allow | allow | 200 | yes |
| operator encrypts with a standard key | allow | allow | 200 | yes |
| operator encrypts with a test key | deny | deny | 403 | yes |
| viewer encrypts with a standard key | deny | deny | 403 | yes |
| viewer encrypts with a test key | deny | deny | 403 | yes |
| anonymous encrypts with a standard key | deny | deny | 401 | yes |
| anonymous encrypts with a test key | deny | deny | 401 | yes |
| admin decrypts a standard-key package | deny | deny | 403 | yes |
| admin decrypts a test-key package | allow | allow | 200 | yes |
| operator decrypts a standard-key package | allow | allow | 200 | yes |
| operator decrypts a test-key package | deny | deny | 403 | yes |
| viewer decrypts a standard-key package | deny | deny | 403 | yes |
| viewer decrypts a test-key package | deny | deny | 403 | yes |
| admin creates a key | allow | allow | 201 | yes |
| operator creates a key | deny | deny | 403 | yes |
| viewer creates a key | deny | deny | 403 | yes |
| anonymous creates a key | deny | deny | 401 | yes |
| admin lists keys | allow | allow | 200 | yes |
| operator lists keys | allow | allow | 200 | yes |
| viewer lists keys | allow | allow | 200 | yes |
| anonymous lists keys | deny | deny | 401 | yes |
| admin reads the audit log | allow | allow | 200 | yes |
| admin lists users | allow | allow | 200 | yes |
| admin lists backups | allow | allow | 200 | yes |
| admin unlocks the vault | allow | allow | 200 | yes |
| operator reads the audit log | deny | deny | 403 | yes |
| operator lists users | deny | deny | 403 | yes |
| operator lists backups | deny | deny | 403 | yes |
| operator unlocks the vault | deny | deny | 403 | yes |
| viewer reads the audit log | deny | deny | 403 | yes |
| viewer lists users | deny | deny | 403 | yes |
| viewer lists backups | deny | deny | 403 | yes |
| viewer unlocks the vault | deny | deny | 403 | yes |
| anonymous reads the audit log | deny | deny | 401 | yes |
| anonymous lists users | deny | deny | 401 | yes |
| anonymous lists backups | deny | deny | 401 | yes |
| anonymous unlocks the vault | deny | deny | 401 | yes |
| admin exports a report | allow | allow | 200 | yes |
| operator exports a report | allow | allow | 200 | yes |
| viewer exports a report | allow | allow | 200 | yes |
| anonymous exports a report | deny | deny | 401 | yes |
| operator encrypts with a revoked key | deny | deny | 409 | yes |
| operator encrypts with an expired key | deny | deny | 409 | yes |
| operator encrypts with a missing key | deny | deny | 404 | yes |
| operator sends an oversized payload | deny | deny | 413 | yes |
| operator sends a malformed package | deny | deny | 400 | yes |
| operator decrypts a tampered package | deny | deny | 400 | yes |
| operator decrypts a valid old-version package | allow | allow | 200 | yes |

## Decision latency

Measured in-process through the full HTTP stack (validation, authorisation, Argon2/AES, database, audit write) with production Argon2id settings (64 MiB, 3 passes, 4 lanes). The audit log held 335 entries when the chain was verified. The per-minute rate limit was raised to 300 for this measurement (a permitted, audited setting).

| Operation | n | mean ms | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|
| login | 10 | 124.2 | 125.0 | 135.4 | 135.4 | 135.4 |
| vault unlock | 3 | 95.2 | 92.3 | 104.8 | 104.8 | 104.8 |
| encrypt (allowed) | 100 | 7.6 | 6.7 | 10.2 | 20.8 | 44.3 |
| decrypt (allowed) | 100 | 6.7 | 6.6 | 7.4 | 8.1 | 8.3 |
| denied decision (viewer encrypt) | 100 | 6.3 | 6.2 | 7.2 | 8.4 | 10.7 |
| list keys | 100 | 4.3 | 4.3 | 4.7 | 4.8 | 6.2 |
| audit verify | 10 | 14.1 | 13.2 | 22.9 | 22.9 | 22.9 |

Server-side `duration_ms` stored in the audit log: encrypt: n=101, mean 1.66 ms, max 33 ms; decrypt: n=100, mean 1 ms, max 1 ms.


## Configuration-change demonstration (traceable threshold change)

| Step | HTTP | Outcome | Rule (version) | Threshold in force | Audit entry |
|---|---|---|---|---|---|
| 1. 2 KiB payload, default limit 64 KiB | 200 | ENCRYPT_OK | vault_state_check (v1) | {"max_data_kib": {"value": 64, "setting_version": 1}} | #346 |
| 2. admin lowers max_data_kib from 64 to 1 | 200 | setting changed | - | - | see below |
| 3. SAME 2 KiB payload, limit now 1 KiB | 413 | PAYLOAD_TOO_LARGE | input_validation (v2) | {"max_data_kib": {"value": 1, "setting_version": 2}} | #348 |
| 4. admin restores max_data_kib to 64 | 200 | setting changed | - | - | see below |
| 5. SAME payload again | 200 | ENCRYPT_OK | vault_state_check (v1) | {"max_data_kib": {"value": 64, "setting_version": 3}} | #350 |

Audit entries recording the configuration change:

- entry #347 by admin: {"new": 1, "old": 64}
- entry #349 by admin: {"new": 64, "old": 1}
