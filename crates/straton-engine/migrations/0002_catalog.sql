ALTER TABLE sources ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX datasets_source_name ON datasets(source_id,name);
CREATE UNIQUE INDEX columns_dataset_name ON columns(dataset_id,name);
