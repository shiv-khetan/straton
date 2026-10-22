CREATE TABLE pipelines (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', cron TEXT,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), owner_id TEXT NOT NULL REFERENCES users(id),
 last_scheduled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE pipeline_nodes (
 pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE, node_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('sync','transform','validate')), ref_id TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0,
 PRIMARY KEY(pipeline_id,node_id)
);
CREATE INDEX pipeline_nodes_ref ON pipeline_nodes(kind,ref_id);
CREATE TABLE pipeline_edges (
 pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE, from_node TEXT NOT NULL, to_node TEXT NOT NULL,
 PRIMARY KEY(pipeline_id,from_node,to_node), CHECK(from_node!=to_node),
 FOREIGN KEY(pipeline_id,from_node) REFERENCES pipeline_nodes(pipeline_id,node_id) ON DELETE CASCADE,
 FOREIGN KEY(pipeline_id,to_node) REFERENCES pipeline_nodes(pipeline_id,node_id) ON DELETE CASCADE
);
CREATE INDEX pipeline_edges_to ON pipeline_edges(pipeline_id,to_node);
CREATE TABLE pipeline_runs (
 id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled','interrupted')),
 trigger TEXT NOT NULL CHECK(trigger IN ('manual','cron')), started_at INTEGER, finished_at INTEGER, error TEXT
);
CREATE UNIQUE INDEX pipeline_runs_active ON pipeline_runs(pipeline_id) WHERE state IN ('queued','running');
CREATE INDEX pipeline_runs_history ON pipeline_runs(pipeline_id,started_at DESC);
CREATE TABLE pipeline_run_nodes (
 run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE, node_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','skipped','cancelled')),
 child_run_id TEXT REFERENCES runs(id), started_at INTEGER, finished_at INTEGER, error TEXT,
 PRIMARY KEY(run_id,node_id)
);
CREATE INDEX pipeline_run_nodes_child ON pipeline_run_nodes(child_run_id);
CREATE TABLE quality_checks (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE,
 model_id TEXT REFERENCES models(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('not_null','unique','range','freshness','row_count','custom_sql')),
 column_name TEXT, config TEXT NOT NULL CHECK(json_valid(config)),
 severity TEXT NOT NULL CHECK(severity IN ('error','warn')), cron TEXT,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), last_scheduled INTEGER NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK(dataset_id IS NULL OR model_id IS NULL), CHECK(kind='custom_sql' OR dataset_id IS NOT NULL OR model_id IS NOT NULL)
);
CREATE INDEX quality_checks_dataset ON quality_checks(dataset_id);
CREATE INDEX quality_checks_model ON quality_checks(model_id);
CREATE TABLE quality_runs (
 id TEXT PRIMARY KEY, check_id TEXT NOT NULL REFERENCES quality_checks(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('passed','failed','error')), observed REAL, failing_rows INTEGER,
 message TEXT NOT NULL, pipeline_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE CASCADE,
 started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
);
CREATE INDEX quality_runs_history ON quality_runs(check_id,started_at DESC);
CREATE INDEX quality_runs_recent ON quality_runs(started_at DESC);
CREATE INDEX quality_runs_pipeline ON quality_runs(pipeline_run_id);
CREATE TABLE charts (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, sql TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('line','bar','area','stat','table')), config TEXT NOT NULL CHECK(json_valid(config)),
 shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX charts_owner ON charts(owner_id);
CREATE TABLE chart_deps (
 chart_id TEXT NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
 dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE, model_id TEXT REFERENCES models(id) ON DELETE CASCADE,
 CHECK((dataset_id IS NULL)!=(model_id IS NULL)), UNIQUE(chart_id,dataset_id), UNIQUE(chart_id,model_id)
);
CREATE INDEX chart_deps_dataset ON chart_deps(dataset_id);
CREATE INDEX chart_deps_model ON chart_deps(model_id);
CREATE TABLE dashboards (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 layout TEXT NOT NULL CHECK(json_valid(layout)), shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX dashboards_owner ON dashboards(owner_id);
CREATE TABLE notifications (
 id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('info','warn','error')),
 kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX notifications_user ON notifications(user_id,created_at DESC);
CREATE INDEX notifications_retention ON notifications(created_at);
CREATE TABLE notification_reads (
 notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(notification_id,user_id)
);
CREATE INDEX notification_reads_user ON notification_reads(user_id);
