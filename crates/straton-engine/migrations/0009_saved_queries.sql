CREATE TABLE saved_queries (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, sql TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX saved_queries_owner ON saved_queries(owner_id);
