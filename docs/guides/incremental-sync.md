# Incremental sync

Merge changes by watermark and key instead of reloading whole tables.

Postgres and SQLite jobs can merge changes by watermark and key. Discover the dataset first, then POST this body to `/v1/jobs` (or use the desktop job sheet):

```json
{
  "name": "Incremental users",
  "source_id": "<source-id>",
  "dataset": "users",
  "cron": "0 */5 * * * *",
  "enabled": true,
  "mode": "incremental",
  "watermark_column": "updated_at",
  "key_columns": ["id"],
  "delete_detection": "key_diff",
  "key_diff_every_runs": 10
}
```

The watermark must be an integer, date or timestamp column in the catalog. Omit `key_columns` to use the catalog primary key, or supply an existing, unique, non-null key (including composite keys). Watermarks must be non-null and advance when rows change. SQLite DATE and TIMESTAMP/DATETIME columns should use consistent ISO date/time text. CSV supports full refresh only. Jobs default to `mode: "full"`.

The first incremental run performs a full load and seeds the maximum watermark. Later reads use the **inclusive** condition `watermark >= last`, paginated by (watermark, key...). Rows tied at the boundary are read again, including rows that arrived late with exactly that watermark. A key merge replaces previous versions with delta rows and writes a new snapshot, so re-reading a boundary does not duplicate rows. Changes with a watermark below the saved boundary are not detected.

Delta Parquet parts are staged under `.staging-<run>/delta/`, flushed and renamed before checkpointing. Recovery continues an unfinished read, or reruns the merge from the completed staged delta. At publication, one database transaction records the watermark, snapshot run ID, run statistics, dataset row count and last-sync time. Failed or cancelled runs do not advance the watermark; an empty delta keeps the previous value. SQL continues reading the merged `_current` snapshot through the same row filters and column masks, including Local lake aliases.

Deletes remain in the snapshot by default (`delete_detection: "none"`). With `key_diff`, every Nth successful run scans only all source keys and removes snapshot rows whose keys are absent. The initial full run counts toward this interval; failed/cancelled runs do not. `key_diff_every_runs: 0` disables the scan. `rows_read` includes rows in this key scan. Sources should remain stable during a run for a consistent result.

Changed source column names or types trigger a full refresh for that run, re-seed the watermark, record `fallback_reason` and emit `sync.fallback` in the audit log. Runs expose `mode_used`, `rows_read`, `rows_inserted`, `rows_updated` and `rows_deleted`. Updates count delta keys already in the previous snapshot, including unchanged boundary rows. GET jobs exposes the read-only `watermark`. Jobs/runs require `sync_admin` on their target. Changing sync settings resets job state and requires all active runs to finish; enabling/disabling a job preserves it. Runs for the same target are serialized.
