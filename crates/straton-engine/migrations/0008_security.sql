CREATE TABLE dataset_keys (
 id TEXT PRIMARY KEY, target_id TEXT NOT NULL, wrapped_key BLOB NOT NULL,
 kek_version INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER
);
CREATE UNIQUE INDEX dataset_keys_active ON dataset_keys(target_id) WHERE retired_at IS NULL;
-- Persist the commit decision independently of the OS keychain for rotation recovery.
CREATE TABLE security_state (
 id INTEGER PRIMARY KEY CHECK(id=1), kek_version INTEGER NOT NULL DEFAULT 0,
 audit_backfilled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO security_state(id) VALUES(1);
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN hash TEXT;
