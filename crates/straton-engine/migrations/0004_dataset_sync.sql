ALTER TABLE datasets ADD COLUMN row_count INTEGER CHECK (row_count >= 0);
ALTER TABLE datasets ADD COLUMN last_synced_at TEXT;
