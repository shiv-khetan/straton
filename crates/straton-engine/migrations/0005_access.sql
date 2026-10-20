CREATE TABLE users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), created_at INTEGER NOT NULL
);
CREATE TABLE api_tokens (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
 last_used_at INTEGER, expires_at INTEGER, revoked_at INTEGER
);
CREATE TABLE roles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1))
);
CREATE TABLE user_roles (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(user_id,role_id)
);
CREATE TABLE grants (
 id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
 target_kind TEXT NOT NULL CHECK(target_kind IN ('source','dataset')), target_id TEXT NOT NULL,
 privilege TEXT NOT NULL CHECK(privilege IN ('read','sync_admin','admin')),
 UNIQUE(role_id,target_kind,target_id,privilege)
);
CREATE TRIGGER grants_target_insert BEFORE INSERT ON grants BEGIN
 SELECT CASE WHEN (NEW.target_kind='source' AND NOT EXISTS(SELECT 1 FROM sources WHERE id=NEW.target_id)) OR (NEW.target_kind='dataset' AND NOT EXISTS(SELECT 1 FROM datasets WHERE id=NEW.target_id)) THEN RAISE(ABORT,'unknown grant target') END;
END;
CREATE TRIGGER grants_target_update BEFORE UPDATE ON grants BEGIN
 SELECT CASE WHEN (NEW.target_kind='source' AND NOT EXISTS(SELECT 1 FROM sources WHERE id=NEW.target_id)) OR (NEW.target_kind='dataset' AND NOT EXISTS(SELECT 1 FROM datasets WHERE id=NEW.target_id)) THEN RAISE(ABORT,'unknown grant target') END;
END;
CREATE TRIGGER grants_source_delete AFTER DELETE ON sources BEGIN
 DELETE FROM grants WHERE target_kind='source' AND target_id=OLD.id;
END;
CREATE TRIGGER grants_dataset_delete AFTER DELETE ON datasets BEGIN
 DELETE FROM grants WHERE target_kind='dataset' AND target_id=OLD.id;
END;
CREATE TABLE row_filters (
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, predicate TEXT NOT NULL,
 UNIQUE(dataset_id,role_id)
);
CREATE TABLE column_masks (
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 "column" TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('null','redact','hash','last4')),
 UNIQUE(dataset_id,"column",role_id)
);
ALTER TABLE audit_log ADD COLUMN principal_id TEXT REFERENCES users(id);
