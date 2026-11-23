# KeyCycle demo script (12–13 minutes)

**Setup (before the audience arrives):** seed a *real-KDF* demo database (README §3), start the server, open two
browser windows (admin and operator, or use a private window), and have `demo/fixtures.json` open. Everything is synthetic.
Start at the overview page (`/`) and scroll through it during the 0:00 slot if time allows; its **Sign in** button leads into the live demo.
Speaker split suggestion: A = roles/vault/audit, B = keys and crypto, C = backup and recovery, D = evaluation.

| Min | Who | Do | Say / point out | Expected |
|---|---|---|---|---|
| 0:00 | D | Show the slide of the 6 threat classes | what KeyCycle defends: wrong people, wrong keys, tampering, loss | – |
| 1:00 | A | Sign in as `admin` with a **wrong** password, then unknown user | identical generic error, no account enumeration (T1.5) | same message both times |
| 2:00 | A | Sign in correctly. Unlock vault with a wrong passphrase, then the right one | attempt audited, passphrase never logged (T1) | "Unlock failed", then "Vault unlocked" |
| 3:00 | B | Keys page: show active, expired, revoked keys. Rotate `payroll-key` (confirmation) | single-use confirmation; version increments | new version, ROTATE_OK |
| 4:00 | B | Sign in as `operator1` (second window). Encrypt with `finance-key` | allowed; package carries key id and version | `kc1.…` package |
| 5:00 | B | Decrypt the pre-rotation `retired_version_package` from fixtures | old versions still work (T3) | plaintext returned |
| 5:45 | B | Paste `altered_ciphertext`, then try a revoked key's package | tamper and revoked key are refused, reason shown (T3, T4) | CIPHERTEXT_INVALID; KEY_REVOKED |
| 6:30 | A | Sign in as `viewer`; try encrypt through the UI/API | viewers have read-only navigation; generic 403 and an audit entry (T2) | FORBIDDEN |
| 7:15 | A | Back as admin → **Users and settings → Settings**: set *Maximum data per request* 64 → 1 | **threshold-change demonstration, step 1** | saved, setting version 2 |
| 7:45 | B | As operator, encrypt a 2 KiB text | refused: `PAYLOAD_TOO_LARGE` | 413 |
| 8:15 | A | Audit page: open that entry | shows rule `input_validation` v2 and `max_data_kib` value 1, setting version 2, and the admin's change entry | traceable cause |
| 8:45 | A | Restore 64; repeat the 2 KiB encrypt | allowed again, setting version 3 | ENCRYPT_OK |
| 9:30 | C | Backups and recovery → Create backup → Recovery drill on its row | four steps pass, live data untouched (T6) | all PASS |
| 10:30 | C | In a terminal, flip a byte in a **copy** of the backup and verify it | corrupted backup rejected (T6.4) | BACKUP_INVALID |
| 11:00 | A | Audit chain → **Verify chain** (green line). Then in a terminal (prepared script/DB copy) edit one row; Verify again | red banner, first bad entry (T5) | TAMPER DETECTED |
| 12:00 | D | Show `evidence/evidence_report.md` | 43/43 steps, 0 false positives, 0 false negatives, ~8 ms decisions, 90% coverage | – |
| 12:45 | all | Limits slide (README §8) and Q&A | be explicit about unkeyed chain, no TLS, lockout trade-off | – |

**Safety net:** if the live tamper step fails, show screenshots 16 and 17 in `evidence/screenshots/`.
**Prepare the tamper step in advance** on a *copy* of the database (drop trigger `audit_no_update`, update one `audit_events.reason`); never edit the live demo database.
