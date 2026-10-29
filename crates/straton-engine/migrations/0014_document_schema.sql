ALTER TABLE datasets ADD COLUMN sampled_documents INTEGER;
ALTER TABLE datasets ADD COLUMN field_coverage TEXT NOT NULL DEFAULT '{}';
