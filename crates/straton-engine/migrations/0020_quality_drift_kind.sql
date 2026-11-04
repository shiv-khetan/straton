-- Allow the `drift` check kind. SQLite cannot change a CHECK constraint, so the table is
-- rebuilt. Migrations run in a transaction, where foreign keys cannot be switched off, so
-- dropping the old table cascades into its children: their rows are kept in temporary
-- tables and restored once the new table has the old name.
CREATE TEMP TABLE keep_quality_runs AS SELECT * FROM quality_runs;
CREATE TEMP TABLE keep_quality_profiles AS SELECT * FROM quality_profiles;
CREATE TABLE quality_checks_next (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE,
 model_id TEXT REFERENCES models(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('not_null','unique','range','freshness','row_count','custom_sql','drift')),
 column_name TEXT, config TEXT NOT NULL CHECK(json_valid(config)),
 severity TEXT NOT NULL CHECK(severity IN ('error','warn')), cron TEXT,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), last_scheduled INTEGER NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK(dataset_id IS NULL OR model_id IS NULL), CHECK(kind='custom_sql' OR dataset_id IS NOT NULL OR model_id IS NOT NULL)
);
INSERT INTO quality_checks_next(id,name,dataset_id,model_id,kind,column_name,config,severity,cron,enabled,last_scheduled,owner_id,created_at,updated_at)
 SELECT id,name,dataset_id,model_id,kind,column_name,config,severity,cron,enabled,last_scheduled,owner_id,created_at,updated_at FROM quality_checks;
DROP TABLE quality_checks;
ALTER TABLE quality_checks_next RENAME TO quality_checks;
CREATE INDEX quality_checks_dataset ON quality_checks(dataset_id);
CREATE INDEX quality_checks_model ON quality_checks(model_id);
INSERT INTO quality_runs SELECT * FROM temp.keep_quality_runs;
INSERT INTO quality_profiles SELECT * FROM temp.keep_quality_profiles;
DROP TABLE temp.keep_quality_runs;
DROP TABLE temp.keep_quality_profiles;
