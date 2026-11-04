-- Tag-based masking: columns carry tags (for example `pii`), and a role can have one mask per
-- tag that applies to every column with that tag. A mask set on the column itself wins.
CREATE TABLE column_tags (
 dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 "column" TEXT NOT NULL,
 tag TEXT NOT NULL,
 PRIMARY KEY(dataset_id, "column", tag)
);
CREATE INDEX column_tags_tag ON column_tags(tag);
CREATE TABLE tag_masks (
 tag TEXT NOT NULL,
 role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('null','redact','hash','last4')),
 PRIMARY KEY(tag, role_id)
);
