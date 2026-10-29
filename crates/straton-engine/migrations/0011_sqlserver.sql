ALTER TABLE datasets ADD COLUMN dataset_type TEXT NOT NULL DEFAULT 'table' CHECK(dataset_type IN ('table','view'));
ALTER TABLE datasets ADD COLUMN definition TEXT;
ALTER TABLE datasets ADD COLUMN approximate_row_count INTEGER;
CREATE TABLE dataset_indexes (
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    columns TEXT NOT NULL,
    "unique" INTEGER NOT NULL,
    clustered INTEGER NOT NULL,
    kind TEXT NOT NULL,
    unique_constraint INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(dataset_id, name)
);
