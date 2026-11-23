# KeyCycle administrator guide

## 1. Accounts
**Administration → Users** creates users (role administrator / operator / viewer, 12+ character password), changes
roles and disables or re-enables accounts. Disabled users cannot sign in. Keep at least one active administrator.
Two administrators are recommended so a lock-out does not stop the work.

## 2. The vault
The vault master key is derived from the vault passphrase with Argon2id and is held only in memory.
- **Unlock** (Dashboard → Vault) after every server start. Five wrong passphrases lock the unlock endpoint for a while; even the right one is refused during lockout.
- **Lock** removes the key from memory immediately.
- The passphrase is never stored or logged and **cannot be recovered**. Keep it in a safe, separate from backups. There is currently no passphrase-change function.

## 3. Key lifecycle
| Action | How | Rules |
|---|---|---|
| Create | Keys → **+ Create Key** (name, purpose standard/test, optional expiry) | names unique |
| Rotate | Keys → **Rotate** button | single-use confirmation; new version becomes current; old versions still decrypt |
| Revoke | Keys → **Revoke** button | single-use confirmation, type the key name and a reason; **all versions** stop working, permanently |
| Expire | automatic | the scheduler marks keys past their expiry; keys older than their rotation interval are rotated automatically while the vault is unlocked, otherwise a "rotation deferred" entry is logged once |

Confirmation tokens live 5 minutes and work once.

## 4. Settings (Administration → Settings)
Every change is versioned and audited; later decisions record which setting version they used.
| Setting | Default | Range |
|---|---|---|
| Failed logins before lockout | 5 | 3–10 |
| Lockout duration (min) | 15 | 1–60 |
| Session timeout (min) | 30 | 5–120 |
| Rate limit (requests/min/user) | 30 | 5–300 |
| Default rotation interval (days) | 90 | 1–365 |
| Maximum data per request (KiB) | 64 | 1–128 |

To demonstrate a threshold change: lower *Maximum data per request* to 1, send a 2 KiB payload (denied,
`PAYLOAD_TOO_LARGE`, rule `input_validation` v2, threshold value 1), restore 64, repeat (allowed).

## 5. Audit log
**Audit** shows every decision: who, role, action, outcome, reason code, rule and version, threshold, duration.
The log is append-only (database triggers refuse edits and deletes) and each entry contains the hash of the previous one.
- **Verify chain** recomputes everything. Green = intact. Red banner = tampering; it reports the first bad entry.
- The page remembers the latest verified head in your browser (`kc_audit_anchor`) and sends it next time, so truncation or a rewrite of earlier history is caught too. With the vault unlocked the newest backup's head is used as a second anchor.
- Write down the head after important events (it is a SHA-256 value) – this is the strongest defence.
- Anonymous noise (failed logins for unknown names) is rate-limited into summary entries so the log cannot be flooded.

## 6. Backups and recovery
### Create
Backups & Reports → **+ Create Backup** (single-use confirmation, vault unlocked). The file `keycycle-<time>-<id>.kcbak` appears in
the `backups/` folder next to the database (permissions 0700). It is authenticated with an HMAC key derived from the vault passphrase.
Back up before and after rotations or user changes, and copy files off the machine.
### Verify and drill (do this regularly)
Backups & Reports → pick a file → **Verify**, then **Non-Destructive Recovery Drill** (enter the passphrase). The drill authenticates the
file, checks the audit chain, restores into an isolated temporary database and decrypts a proof value. Live data is untouched.
Expected: four lines, all PASS. A single flipped byte gives `BACKUP_INVALID`.
### Restore into the running system
Backups & Reports → Restore. A restore **never** un-revokes a key, re-enables a disabled user or raises a role; those are kept
as they are now. If the live audit chain is invalid, an owner-only evidence copy of the damaged database is saved first (`evidence/`).
Anything created after the backup is lost, so take a fresh backup of a still-working system before restoring.
### Total loss of the database
1. Stop the server. Move any damaged `*.db` aside (keep it as evidence).
2. Put the `backups/` folder next to where the new database will live.
3. Run `python3 scripts/recover_backup.py --database keycycle.db --backup <file>.kcbak`
4. Enter the vault passphrase. A wrong one is refused and nothing is created.
5. Start the server, unlock the vault, run **Verify chain**, decrypt a known package, and note the `disaster_restore` audit entry.
Expected: "Recovery complete", with the audit entry number.
### Lost vault passphrase
Not recoverable by design: encrypted keys and backups cannot be opened. Create a new deployment and re-encrypt data.

## 7. Incident quick reference
| Sign | Action |
|---|---|
| Red tamper banner | stop changes, take a copy of the database file, compare the head against your written/backup anchor, restore from the last good backup |
| Many `AUTH_FAILED`/`TOO_MANY_ATTEMPTS` | check the source, shorten the lockout or rate limit if it is an attack on one user |
| A key is suspected leaked | revoke it (all versions die), create a replacement, re-encrypt data |
| Server restarted | vault is locked – unlock; scheduled rotations resume |
| User cannot sign in | check Administration → Users: disabled or locked (wait out the lockout) |

## 8. Operations
Run one worker. Put TLS in front (reverse proxy). Keep `KEYCYCLE_DB` and `backups/` on an encrypted disk with
owner-only permissions. Update dependencies from `requirements.txt` (pinned) and run `pytest` after.
