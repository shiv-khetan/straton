CREATE TABLE query_stats (
 dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 column TEXT NOT NULL, role TEXT NOT NULL, op TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 0, rows_scanned INTEGER NOT NULL DEFAULT 0,
 rows_returned INTEGER NOT NULL DEFAULT 0, elapsed_ms INTEGER NOT NULL DEFAULT 0,
 last_seen INTEGER NOT NULL, PRIMARY KEY(dataset_id,column,role,op)
);
CREATE TABLE dataset_layout (
 dataset_id TEXT PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE,
 sort_column TEXT, bloom_columns TEXT NOT NULL DEFAULT '[]',
 row_group_size INTEGER NOT NULL, reason TEXT NOT NULL,
 hash_index_enabled INTEGER NOT NULL DEFAULT 0 CHECK(hash_index_enabled=0),
 updated_at INTEGER NOT NULL
);
CREATE TABLE advisor_recommendations (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE, target TEXT NOT NULL,
 kind TEXT NOT NULL, fingerprint TEXT NOT NULL, ddl TEXT NOT NULL, rollback_ddl TEXT NOT NULL,
 evidence TEXT NOT NULL, estimated_benefit REAL NOT NULL, cost TEXT NOT NULL,
 risk TEXT NOT NULL, required_permission TEXT NOT NULL, applicable INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','dismissed','applying','applied','failed','rolled_back')),
 applied_by TEXT, applied_at INTEGER, error TEXT, source_config TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(source_id,fingerprint)
);
CREATE INDEX advisor_source_status ON advisor_recommendations(source_id,status);
