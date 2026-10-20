ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full' CHECK(mode IN ('full','incremental'));
ALTER TABLE jobs ADD COLUMN watermark_column TEXT;
ALTER TABLE jobs ADD COLUMN key_columns TEXT CHECK(key_columns IS NULL OR json_valid(key_columns));
ALTER TABLE jobs ADD COLUMN delete_detection TEXT NOT NULL DEFAULT 'none' CHECK(delete_detection IN ('none','key_diff'));
ALTER TABLE jobs ADD COLUMN key_diff_every_runs INTEGER NOT NULL DEFAULT 0 CHECK(key_diff_every_runs>=0);
CREATE TABLE job_state (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
 watermark TEXT CHECK(watermark IS NULL OR json_valid(watermark)),
 snapshot_run_id TEXT REFERENCES runs(id), updated_at INTEGER NOT NULL
);
ALTER TABLE runs ADD COLUMN mode_used TEXT NOT NULL DEFAULT 'full';
ALTER TABLE runs ADD COLUMN rows_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN rows_inserted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN rows_updated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN rows_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN fallback_reason TEXT;
