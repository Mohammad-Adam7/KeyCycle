# Part D Implementation Plan: Frontend, API Integration, Reports & Security Evaluation

## 1. Overview & Ownership

* **Owner**: Member D
* **Area**: Frontend UI, Cross-Module API Integration, Report Generation & Security Testing
* **Requirements**: Cross-module coverage of FR-1 through FR-7, evaluation cases **T1 to T6** and **T-final**, and interface wireframes (Section 5 of the Project Specification).

---

## 2. Scope & Deliverables

Part D brings together the backend work of Track A (Auth & Vault), Track B (Key Lifecycle & Encryption), and Track C (Audit, Backup & Recovery) into a cohesive, secure, and fully verified system.

### A. Core Deliverables
1. **Report Export Subsystem (Section 3.11, Table 10, Table 12)**:
   * Backend endpoint `GET /api/reports/export?format=csv|json`.
   * Strict role-based content sanitization (Administrator: full; Operator: own operations sanitised; Viewer: key info and decision outcomes without usernames or internal details).
   * Mandatory metadata headers: UTC generation timestamp, audit chain count, and current chain head hash.
   * Audited under action `report_export`.

2. **Frontend User Interface (Section 5 Wireframes)**:
   * Zero external dependencies (no CDNs, no npm build tools; completely self-contained for offline / secure runtime).
   * Strict greyscale visual design adhering to wireframes:
     * **Severity**: info (thin solid border), warning (double border with warning indicator), critical (solid bold black).
     * **Key State**: active (solid outline), expired (dashed border), revoked (solid bold/inverted badge).
   * Implemented Screens:
     * **5.3 Sign-in**: Secure login form, generic failure feedback, 12-character guidance, session inactivity notice.
     * **5.4 Dashboard**: Vault status and lock/unlock toggle, live audit chain head and verification badge, quick filters.
     * **5.5 Key Management**: List keys with state badges, version pagination, creation modal (admin), rotation trigger.
     * **5.6 Revocation Modal**: High-impact dialog requiring confirmation token, explicit reason, and typing key name.
     * **5.7 Encrypt & Decrypt (Operator / Admin Test)**: Active key selector, real-time byte counter against 64 KiB limit, structured decision badge (rule, thresholds, evidence, duration, severity), ciphertext package inspector.
     * **5.8 Audit Log & Verification**: Search/filter audit events, live chain verification action, prominent `TAMPER_DETECTED` alert banner highlighting the first corrupted entry.
     * **5.9 Backup, Recovery & Reports**:
       * List available backups from restricted server folder.
       * Create authenticated backup (`.kcbak`) with single-use confirmation token.
       * Verify backup integrity and HMAC.
       * Restore backup with confirmation token, passphrase, and automatic session logout.
       * Run non-destructive Recovery Drill and display all 4 step results.
       * Export downloadable reports in CSV and JSON formats.
     * **5.10 Administration**:
       * User management (create user, change role, toggle disabled status).
       * System settings view & threshold patcher showing rule version increments.

3. **Evaluation Test Suite: T1 to T6 and T-final (Sections 3.14, 4.4, Table 17)**:
   * **T1 (Wrong Passphrase)**: Vault unlock attempts with incorrect passphrases, lockout trigger, rate-limit defense, and audit recording.
   * **T2 (Unauthorised Use & RBAC)**: Role privilege boundaries (Operator attempting key creation/revocation, Viewer attempting encryption, disabled account lockout, Administrator restricted to test keys, Operator restricted to standard keys).
   * **T3 (Rotation Compatibility)**: Version increment on rotation, validation that packages encrypted under retired versions remain decryptable, tamper detection if version/key ID is altered in AAD.
   * **T4 (Expired or Revoked Keys)**: Refusal of encryption for expired keys, permanent refusal of both encryption and decryption for revoked keys across all versions.
   * **T5 (Audit Tampering)**: Live verification of hash chain, detection of modified entry, deleted entry, inserted entry, and detection of tail truncation via expected count and hash.
   * **T6 (Recovery & Backups)**: Authenticated backup creation, HMAC tamper rejection, full restore with correct passphrase, session invalidation on restore, and 4-step recovery drill.
   * **T-final (System Resilience & Acceptance)**:
     * Malformed and oversized payloads (> 64 KiB).
     * Missing, invalid, or replayed CSRF and single-use confirmation tokens.
     * Repeated high-impact submissions.
     * Safe failure responses without leaking internal traces or secrets.
     * Clean service restart and vault lock state preservation.

---

## 3. Technical Architecture & File Layout

```
KeyCycle/
├── app/
│   ├── reports.py             # Role-based report builder (CSV & JSON)
│   ├── report_routes.py      # GET /api/reports/export endpoint
│   ├── ui_routes.py          # Serves HTML/CSS/JS frontend
│   ├── static/
│   │   ├── app.js            # Frontend application logic & API client
│   │   ├── style.css         # Strict greyscale wireframe styling
│   │   └── index.html        # Single-Page UI shell with screen views
│   └── main.py               # Mounts report_routes and ui_routes
├── doc/
│   ├── Part-D-Plan.md        # This implementation plan
│   └── Part-D-Handoff.md     # Completion documentation & test evidence
└── tests/
    ├── test_reports.py       # Unit tests for CSV/JSON exports and role sanitization
    ├── test_ui.py            # Tests for UI static assets and accessibility
    └── test_part_d_eval.py   # Formal evaluation suite for T1–T6 and T-final
```

---

## 4. Implementation Steps & Milestones

### Phase 1: Report Export Subsystem
1. Create `app/reports.py` implementing role-based filtering:
   * **Administrator**: Full audit trail and details.
   * **Operator**: Own user operations and outcomes; sanitized evidence.
   * **Viewer**: Key catalog and decision outcomes; excludes usernames and sensitive detail dictionaries.
   * Add CSV and JSON formatters including `generated_at`, `chain_count`, and `chain_head`.
2. Create `app/report_routes.py` with `GET /api/reports/export`.
3. Write unit tests in `tests/test_reports.py` validating Table 10 compliance.

### Phase 2: Frontend UI Implementation
1. Build `app/static/style.css` using pure semantic CSS, adhering strictly to the greyscale wireframe specifications:
   * Monochrome palettes (`#000`, `#fff`, shades of grey).
   * Double borders and icons for warnings, solid black for critical, outlines for info.
   * Dashed borders for expired keys, solid black for revoked keys.
2. Build `app/static/index.html` containing modular panels for each of the 8 specified screens.
3. Build `app/static/app.js`:
   * Client-side session and CSRF management.
   * Screen routing and role-based view visibility (Admin vs Operator vs Viewer).
   * Live size calculator for encryption input.
   * Confirmation token request helper for rotation, revocation, backup, and restore.
   * Interactive audit verification display with red/highlighted mismatch alert.
4. Mount UI endpoints in `app/ui_routes.py` and register in `app/main.py`.

### Phase 3: Formal Evaluation Test Suite (T1–T6, T-final)
1. Implement `tests/test_part_d_eval.py`:
   * Case `test_t1_wrong_passphrase`: Tests lockout and audit trails.
   * Case `test_t2_unauthorised_use`: Tests role boundaries across all modules.
   * Case `test_t3_rotation_compatibility`: Tests lifecycle versioning and AAD tamper resistance.
   * Case `test_t4_expired_or_revoked_keys`: Tests state enforcement.
   * Case `test_t5_audit_tampering`: Tests chain tampering and truncation detection.
   * Case `test_t6_recovery`: Tests HMAC backup, restore, and 4-step recovery drill.
   * Case `test_t_final_acceptance`: Tests payload limits, CSRF, single-use token replay, safe failures, and restart behavior.

### Phase 4: Verification & Handoff
1. Execute the entire test suite (all 108 existing tests + new Part D tests).
2. Create `doc/Part-D-Handoff.md` detailing test evidence, screenshots/ASCII UI map, and instructions for running the complete solution.
