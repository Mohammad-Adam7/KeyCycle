
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('administrator','operator','viewer')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  last_login    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  algorithm      TEXT NOT NULL DEFAULT 'AES-256-GCM' CHECK (algorithm = 'AES-256-GCM'),
  purpose        TEXT NOT NULL DEFAULT 'standard' CHECK (purpose IN ('standard','test')),
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','expired','revoked')),
  current_version INTEGER NOT NULL DEFAULT 1,
  rotation_days  INTEGER NOT NULL,
  expires_at     INTEGER,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoke_reason  TEXT
);

CREATE TABLE IF NOT EXISTS key_versions (
  key_id      INTEGER NOT NULL REFERENCES keys(id),
  version     INTEGER NOT NULL,
  wrapped_key BLOB NOT NULL,
  nonce       BLOB NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('current','retired')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (key_id, version)
);

CREATE TABLE IF NOT EXISTS audit_events (
  entry_no    INTEGER PRIMARY KEY AUTOINCREMENT,
  time        TEXT NOT NULL,
  user        TEXT NOT NULL,
  role        TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL DEFAULT '',
  outcome     TEXT NOT NULL CHECK (outcome IN ('success','denied','failure')),
  severity    TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  reason      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  details     TEXT NOT NULL DEFAULT '{}',
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE IF NOT EXISTS settings (
  name       TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  changed_by TEXT,
  changed_at INTEGER
);

CREATE TABLE IF NOT EXISTS vault (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  salt        BLOB NOT NULL,
  time_cost   INTEGER NOT NULL,
  memory_cost INTEGER NOT NULL,
  parallelism INTEGER NOT NULL,
  check_nonce BLOB NOT NULL,
  check_value BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  csrf_token    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);


CREATE TABLE IF NOT EXISTS failures (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
