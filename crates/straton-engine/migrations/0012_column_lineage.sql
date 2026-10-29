ALTER TABLE datasets ADD COLUMN lineage_incomplete INTEGER NOT NULL DEFAULT 0 CHECK(lineage_incomplete IN (0,1));
UPDATE datasets SET lineage_incomplete=1 WHERE dataset_type='view' OR source_id='straton-models';
CREATE TABLE column_lineage (
 target_dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 target_column TEXT NOT NULL,
 source_dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 source_column TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('passthrough','rename','transform','aggregate','filter','join_key','group_key')),
 expression TEXT,
 model_id TEXT REFERENCES models(id) ON DELETE CASCADE,
 view_dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE,
 FOREIGN KEY(target_dataset_id,target_column) REFERENCES columns(dataset_id,name) ON DELETE CASCADE,
 FOREIGN KEY(source_dataset_id,source_column) REFERENCES columns(dataset_id,name) ON DELETE CASCADE
);
CREATE INDEX column_lineage_target ON column_lineage(target_dataset_id,target_column);
CREATE INDEX column_lineage_source ON column_lineage(source_dataset_id,source_column);
CREATE INDEX column_lineage_model ON column_lineage(model_id);
