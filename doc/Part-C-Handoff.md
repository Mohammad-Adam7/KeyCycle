# Part C delivery and team handoff

## Project status by owner

| Part | Status |
|---|---|
| A | Authentication, sessions, role permissions and vault security are implemented and regression-tested. |
| B | Encryption, decryption, key versions, rotation, expiry and revocation are implemented and regression-tested. |
| C | Audit hash chaining and verification, authenticated backup, restore and recovery drills are implemented and tested. |
| D | Frontend screens, dashboard/report integration and final acceptance presentation remain. |

## Delivered

Part C implements FR-6 and FR-7. Every audit entry now contains a canonical SHA-256 commitment to all of its fields and the previous entry. The first entry uses 64 zeroes, standalone writers are serialised with `BEGIN IMMEDIATE`, and database triggers reject updates, deletes and an incorrect previous hash. Verification reports the first mismatch and can compare a previously retained count/hash to expose tail truncation.

Administrator-only APIs list and filter audit events, verify the live chain, list/create/verify/restore backups and run a recovery drill. Backup files contain the required users, settings, vault data, keys, encrypted key versions and audit events. They exclude sessions, confirmations, failure counters, plaintext, raw keys, tokens and passphrases. An HMAC-SHA-256 under a domain-separated key derived from the in-memory vault master authenticates the canonical backup content.

Restore accepts only a bounded filename from the fixed server backup directory. It checks the HMAC, structure, constraints, foreign keys, key-version invariants and embedded audit chain before mutation. An intact live audit chain is retained and must contain the backup head. If the live chain is empty or unusable after data loss, the verified backup chain is restored. Restore uses an exclusive HTTP maintenance barrier, clears sessions/transient state and locks the vault before replacing records. An offline recovery command rebuilds a missing database without accepting the passphrase on the command line.

The recovery drill reconstructs and validates the backup in an isolated SQLite database and decrypts an authenticated synthetic recovery challenge. It does not destroy the live database merely to demonstrate recovery.

## Verification result

The final Windows run used Python 3.12.10:

```powershell
$testTemp = "$env:TEMP\keycycle-tests-$PID"
.\.venv\Scripts\python.exe -m pytest tests\test_part_c.py -v --basetemp="$testTemp" -p no:cacheprovider

$testTemp = "$env:TEMP\keycycle-all-tests-$PID"
.\.venv\Scripts\python.exe -m pytest -q --basetemp="$testTemp" -p no:cacheprovider
```

Results after the final maintenance-barrier hardening: **7 Part C tests passed**, the Part C plus real-HTTP demonstration run passed **8 tests**, and the complete project passed **108 tests**. The only warning is Starlette's upstream deprecation of its current `httpx` test-client integration; it does not represent a KeyCycle failure.

## Shared-file changes

| File | Part C change |
|---|---|
| `app/audit.py` | Canonical serialisation, recursive redaction, SHA-256 append/verify/head logic and migration of pre-C blank hashes |
| `schema.sql` | Append-only update/delete rules plus previous-hash insertion rule |
| `app/audit_routes.py` | Administrator audit list and verification endpoints |
| `app/backup.py` | Backup format, HMAC, validation, restricted storage, restore and recovery proof |
| `app/backup_routes.py` | Backup, restore and recovery-drill API workflows |
| `app/maintenance.py` | Exclusive restore barrier for in-flight HTTP requests |
| `app/vault.py` | Domain-separated backup authentication-key derivation |
| `app/confirmations.py`, `app/models.py`, `app/key_routes.py` | Single-use backup/restore/drill confirmation support |
| `app/main.py` | Registers C routes, backup store and maintenance barrier |
| `scripts/recover_backup.py` | Offline disaster recovery into a new database path |
| `scripts/demo_part_c.py` | Local live API demonstration without printing secrets |
| `tests/test_part_c.py` | T5/T6 and FR-6/FR-7 evidence |

## Part D integration

- Use `GET /api/audit` for the audit screen and current chain head. Display `first_mismatch` prominently when verification returns `TAMPER_DETECTED`.
- Use `GET /api/backups` to populate backup choices; never accept or construct arbitrary paths in the browser.
- Request a confirmation immediately before backup, restore or recovery drill. Tokens are session/action/target-bound, single-use and expire after five minutes.
- A successful restore invalidates every session, including the administrator who started it. The UI must return to sign-in and show that the vault is locked.
- The drill returns four named steps. Display each outcome rather than replacing them with a single generic success message.
- Report export remains Part D. Include the latest chain count/hash and generation time, and apply the role sanitisation rules from the main design document.

## Operational and residual limits

- Run one application worker per SQLite database. The maintenance barrier is process-local.
- HMAC authenticates a backup; it does not encrypt usernames, settings or password hashes. Protect the backup directory with operating-system permissions. Key material remains wrapped under the vault master key.
- A privileged attacker who rewrites the complete database chain can evade verification unless the operator compares a previously saved external chain head. The verification API accepts `expected_count` and `expected_hash` for this purpose.
- Losing the vault passphrase makes backups and wrapped keys unrecoverable by design.
- The offline recovery command refuses to overwrite an existing database. Move a damaged file aside first and keep it as evidence.
- Python cannot guarantee erasure of every transient immutable byte-string copy of a derived or unwrapped key.
