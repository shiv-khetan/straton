CREATE TABLE models (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, sql TEXT NOT NULL,
 materialization TEXT NOT NULL CHECK(materialization IN ('table','view')),
 trigger TEXT NOT NULL CHECK(trigger IN ('manual','cron','upstream')), cron TEXT,
 owner_id TEXT NOT NULL REFERENCES users(id), optimize INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'ready', error TEXT
);
CREATE TABLE model_deps (
 model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
 dataset_id TEXT REFERENCES datasets(id), upstream_model_id TEXT REFERENCES models(id),
 CHECK((dataset_id IS NULL) != (upstream_model_id IS NULL)),
 UNIQUE(model_id,dataset_id), UNIQUE(model_id,upstream_model_id)
);
CREATE INDEX model_deps_dataset ON model_deps(dataset_id);
CREATE INDEX model_deps_upstream ON model_deps(upstream_model_id);
ALTER TABLE jobs ADD COLUMN model_id TEXT REFERENCES models(id);
CREATE UNIQUE INDEX jobs_model ON jobs(model_id) WHERE model_id IS NOT NULL;
INSERT INTO sources(id,name,kind) VALUES('straton-models','Models','models');
