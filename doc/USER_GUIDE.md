# KeyCycle user guide (operators and viewers)

## Signing in
Open the KeyCycle address and press **Sign in** (top right of the overview page), or open `/login` directly. Enter your
username and password (12+ characters). After 5 wrong attempts the
account is locked for 15 minutes (administrators can change both numbers). The error message is always the
same, whichever part was wrong. You are signed out after 30 minutes of inactivity. **Change password** (bottom of the
sidebar) changes your password; your other sessions end when you do. The arrow next to your name signs you out.

## What you can do
| Role | Can | Cannot |
|---|---|---|
| Operator | list keys, encrypt/decrypt with **standard** keys, see own results, export a report | create, rotate or revoke keys, use test keys, see the audit log, users or backups |
| Viewer | look at the key list and sanitised results, export a report | encrypt, decrypt, anything administrative |
| Administrator | everything administrative, and use **test** keys only | use standard keys (purpose separation) |

A denied action shows a short message. Details are deliberately withheld from the screen; the attempt is
recorded for the administrators.

## Unlocking
Encrypting and decrypting need the vault unlocked. Only an administrator can unlock it. If you see
"Vault is locked", ask an administrator. (The vault locks again whenever the server restarts.)

## Encrypting
1. Open **Encrypt and decrypt** (operators; viewers do not see this page). Under **Seal**, pick a key from the list. Only active keys of your allowed purpose are offered.
2. Type the text (up to 64 KiB by default) and press **Encrypt**.
3. Copy the **package** (**Copy**), a line starting `kc1.`. It contains the key id and version, so keep it exactly as shown.
   The colours mark its parts: format, key id and version, nonce, and ciphertext with its tag.

## Decrypting
Paste a package into **Ciphertext package** under **Open** on the same page and press **Decrypt** (or use **Open it on the right**
after encrypting). You get the text back, or a decision such as:
| Message | Meaning |
|---|---|
| The ciphertext is not valid | edited, truncated or for a different key/version – do not retry with guesses |
| The key has been revoked / has expired | the key owner stopped it; ask an administrator |
| Vault is locked | ask an administrator to unlock |
| Too many requests | wait a minute (limit 30 requests per minute) |

Packages made before a key was rotated still decrypt: each remembers its version.

## Reports
**Keys** lists keys and their state (active, expired, revoked, version, next rotation); click a key for its details and versions.
**Decision history** lists decisions and has *Export CSV* and *Export JSON*, limited to what your role may see (viewers get a sanitised version).
Spreadsheet formulas in exported text are neutralised.

## Do not
Paste real secrets into the demo, share passwords, or reuse a confirmation: administrator confirmations work
once and expire after 5 minutes.
