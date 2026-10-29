-- Keep the immutable snapshot manifest authoritative; this catalog flag is advisory.
CREATE TABLE dataset_layout_next (
 dataset_id TEXT PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE,
 sort_column TEXT, bloom_columns TEXT NOT NULL DEFAULT '[]',
 row_group_size INTEGER NOT NULL, reason TEXT NOT NULL,
 hash_index_enabled INTEGER NOT NULL DEFAULT 0 CHECK(hash_index_enabled IN (0,1)),
 updated_at INTEGER NOT NULL
);
INSERT INTO dataset_layout_next SELECT * FROM dataset_layout;
DROP TABLE dataset_layout;
ALTER TABLE dataset_layout_next RENAME TO dataset_layout;
