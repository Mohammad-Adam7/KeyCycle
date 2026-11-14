**Part B delivery and team handoff**

**Project status by owner**

| Part | Status |
|---|---|
| A | Authentication, sessions, role permissions, vault setup and lock/unlock, and basic audit recording are implemented. |
| B | Key management, encryption and decryption, versioning, lifecycle enforcement, and result history are implemented and tested. |
| C | Audit hash chaining and verification, authenticated backup, restore, and the recovery drill remain. |
| D | The frontend, dashboard, reports, and full-system integration and acceptance testing remain. |

**Delivered**

All ten B endpoints: create/list/detail, encryption/decryption, confirmation issuance, rotation, revocation, result list/detail. Role and key-purpose enforcement, wrapped version storage, strict kc1 packages, use-time expiry, old-version decryption, atomic audit/mutation, token replay resistance, scheduled rotation, deferred warnings, catch-up on unlock, result privacy and pagination. Seed and HTTP demonstration scripts. Full details are in Part-B-API.md.

The full suite passed locally with **101 passed, 1 warning**. The live walkthrough also passed, including decryption after rotation and the expected denial after revocation. From the project folder, run:

```powershell
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m pytest -q --basetemp=.pytest_cache/team-review --tb=short
```

The Windows run used Python 3.14.6 and the dependency versions captured in `requirements-lock.txt`. The warning concerns Starlette's deprecated `httpx` test-client integration. The README has the seed and live demo commands.

**Shared-file changes for Adam**

| File | Change |
|---|---|
| app/main.py | Register B router; remove placeholder; request start time; optional error result; scheduler lifespan/unlock wake; clear transient confirmations |
| app/db.py | Explicit BEGIN IMMEDIATE context manager |
| app/config.py | B constants and schema version |
| app/models.py | Add strict B models; existing A models unchanged |
| app/errors.py | Optional result and RESULT_NOT_FOUND |
| schema.sql | Add confirmations, indexes, legal-state trigger; no column changes |
| requirements.txt | Pin locally tested dependencies |
| tests/test_roles.py, test_hardening.py | Replace placeholder expectation; enumerate included routers through OpenAPI; explicit viewer allowlist |

app/auth.py, vault.py, bodylimit.py, security.py and audit.py remain unchanged.

Items for A: SettingPatch still coerces booleans/strings to integers; use StrictInt if the team chooses to tighten that shared contract. User-management path IDs are not bounded to SQLite's integer range. Anonymous/transport denials and CSRF audit-ID propagation remain A/C policy decisions. `/openapi.json` remains enabled despite interactive docs being disabled. B does not silently patch these unrelated behaviors. B rejects corrupt out-of-range stored settings; it cannot recover the original input type after A has stored a coerced integer.

**C integration**

- Back up keys and key_versions, original IDs and versions, and A's required records. Never back up sessions or confirmations. Restore locked with sessions/confirmations cleared.
- Preserve kc1 and the two AAD strings exactly. Wrapped blobs cannot be renumbered or reassigned to other rows.
- `audit.record` is called inside B's transaction, using its connection. Do not commit/start a nested BEGIN. Return the audit entry number. B writes safe flat key_id/key_version fields, not top-level key/token fields filtered by A.
- Current audit hashes are still empty because C's chain is not implemented. B's append calls are integration-ready, not proof of tamper-evidence.
- Generic confirmations target is TEXT, with code-level rotate/revoke allowlist. C can add backup/restore semantics explicitly; no such API action is currently accepted.
- Restore offline with the server stopped. Stopping scheduler alone does not block HTTP writers. Online restore needs a separate maintenance barrier designed by C/A.
- SCHEMA_VERSION is 1 for the proposed backup header. It is not a general migration engine.
- No nonce-registry/deferral tables need backup. Deferral dedupe lives in memory and may warn again after restart.

Pending C/D tests: cryptographic chain verification, backup authentication/tampering, actual recovery drill, real cross-module restore. They are not claimed passed using mocks.

**D integration**

Use Part-B-API.md as the wire contract. Successful reads return data only; successful decisions return result/data; errors preserve A's fields plus optional result. Metadata is available while locked. Operators use active standard keys; administrators use active test keys. Empty plaintext is rejected, whitespace text accepted. Size counts UTF-8 bytes. Browser ISO timestamps with milliseconds are accepted.

For destructive actions request a confirmation, then submit token; revoke also includes exact key name and validated reason. Tokens are bound to session, expire in five minutes, and stale/used tokens require a fresh dialog/token. A fresh confirmation on an already revoked key returns the original metadata. Version details are paginated. Result history never contains plaintext/packages.

Dashboard aggregation, screens and report exports remain D's work. `app.state.scheduler.status()` supplies safe operational counters/timestamps; do not fabricate a verified chain head before C exists. No browser UI was created as part of B.

**Verification map**

| Test file | Evidence |
|---|---|
| Existing A tests | Auth, roles, sessions, vault, lockout, transport regressions |
| test_package.py | Strict Base64/format, size boundaries, Unicode, fractional timestamps, transactions/schema idempotence |
| test_part_b.py | Complete lifecycle, role/purpose, errors, boundaries, tampering, expiry, failed mutation rollback, history isolation, restart |
| test_part_b_edges.py | 100 unique packages, setting snapshots, confirmation session/action/expiry, state trigger, corrupt wrapping, audit-failure rollback, stale actor, real KDF, legacy schema convergence, pagination, rate limit |
| test_concurrency.py | Simultaneous duplicate creates, same-token rotation, manual/scheduled race, encrypt/revoke ordering, in-flight decrypt/vault-lock semantics |
| test_scheduler.py | Deferred warning dedupe, expiry while locked, catch-up, batch >100, corrupt-key failure isolation, lifespan join/unlock wake |
| test_seed.py | Five users, three payroll versions, expired/revoked keys, retained old package, no sessions, overwrite refusal |
| test_http_demo.py | Real loopback Uvicorn HTTP walkthrough with scheduler lifespan and clean shutdown |

These tests support B's T1/T2 integration and T3/T4/T-final contribution. They are not a comprehensive production security audit. Crash-during-filesystem-commit and arbitrary database corruption are not exhaustively tested. No raw keys/plaintext are persisted; intended transient success responses necessarily contain plaintext, packages or confirmation tokens. Secret-absence claims exclude those explicitly authorized output fields.

**Operational limits**

One worker/process per database; no multi-worker vault coordination or OS ownership lock. SQLite serializes B transactions. Data keys temporarily exist in memory; Python cannot guarantee all copies are erased. Crypto already holding a master-key copy may finish after lock. Revocation cannot retract data/keys previously copied outside the application. Random nonce safety is probabilistic; no global invocation budget is enforced. Expiry/revocation deliberately make previous data unavailable through the API. Lost vault passphrase has no bypass.

Before starting against an existing database, stop all writers and take a consistent SQLite backup. Additive DDL applies at initialization; an invalid database with multiple current versions fails the unique index rather than silently dropping data. Demo script failures leave their newly created file in place for inspection; choose a new filename instead of reusing it blindly.
