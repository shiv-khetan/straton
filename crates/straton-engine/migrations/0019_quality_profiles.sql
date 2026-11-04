-- Profiles recorded by `drift` quality checks: row count plus per-column null ratio and
-- approximate distinct count (no values), computed with the check owner's access. Each run
-- compares with the previous profile of the same check; the last 30 are kept.
CREATE TABLE quality_profiles (
 check_id TEXT NOT NULL REFERENCES quality_checks(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 profile TEXT NOT NULL
);
CREATE INDEX quality_profiles_check ON quality_profiles(check_id, created_at DESC);
