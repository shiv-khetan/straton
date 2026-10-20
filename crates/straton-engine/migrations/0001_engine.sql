CREATE TABLE sources (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, credential_id TEXT
);
CREATE TABLE datasets (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), name TEXT NOT NULL
);
CREATE TABLE columns (
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id), name TEXT NOT NULL,
 data_type TEXT NOT NULL, nullable INTEGER NOT NULL, primary_key INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE relationships (
 id TEXT PRIMARY KEY, from_dataset TEXT NOT NULL REFERENCES datasets(id), from_cols TEXT NOT NULL,
 to_dataset TEXT NOT NULL REFERENCES datasets(id), to_cols TEXT NOT NULL, kind TEXT NOT NULL,
 confidence REAL
);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, source_id TEXT REFERENCES sources(id), dataset TEXT NOT NULL,
 cron TEXT, enabled INTEGER NOT NULL, last_scheduled INTEGER NOT NULL,
 builtin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
 state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted','cancelled')),
 attempt INTEGER NOT NULL DEFAULT 1, available_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0, committed_batches INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX runs_queue ON runs(state, available_at);
CREATE TABLE run_checkpoints (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), cursor TEXT NOT NULL,
 batch_number INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
 action TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
 SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
 SELECT RAISE(ABORT, 'audit_log is append-only'); END;
