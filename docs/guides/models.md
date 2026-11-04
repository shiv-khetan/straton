# SQL models

Build tables and views from synced data with SQL, scheduled or triggered by upstream changes.

Create and edit models in **Engineering → Transformations**, or through the API. Names are lowercase SQL identifiers. Sync input datasets first, then create a model (replace URL, token and input table):

```powershell
$headers = @{ Authorization = "Bearer <user-token>" }
$body = @{
  name = "customers"; sql = "SELECT id, name FROM app_db.users"
  materialization = "table"; trigger = "manual"; cron = $null; optimize = $true
} | ConvertTo-Json
$model = Invoke-RestMethod http://127.0.0.1:8787/v1/models -Method Post -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod "http://127.0.0.1:8787/v1/models/$($model.id)/run" -Method Post -Headers $headers
```

Query the published result with `SELECT * FROM models.customers` through SQL or pgwire. A `table` model streams into staging Parquet parts and atomically publishes under `data/straton-models/<name>/`. Row counts, last-sync times, and input lineage appear under the built-in **Models** source in the Lineage map. Recovery re-executes an unfinished query; a durable renamed snapshot resumes publication.

A `view` model is an ephemeral logical plan, evaluated when queried, with no snapshot or run. Views use a manual trigger. Table triggers are `manual`, `cron` (UTC, seconds first, e.g. `0 */5 * * * *`), or `upstream`. An input publish queues an upstream model once while it already has a queued run. Publications propagate through view inputs. Downstream runs wait while upstream models are queued or running.

Every save validates a single read-only SELECT as the **model owner**, using only their readable, filtered and masked tables. Dependencies come from logical-plan scans. Unknown tables and cycles are rejected; downstream definitions are revalidated after edits and expose `status: "broken"` and `error` when invalid. Owners and administrators may edit, run and explain models. Active runs must finish before editing. Deleting a model with dependents is refused; historical runs are retained.

Table runs execute as the owner, so their row filters and masks constrain the output. Reading that output separately requires a grant on the Models source or dataset, and its own output policies apply. **Views are planned with the querying user's input views, never the owner's session**, so granting a view cannot widen input access. Views also require a Models grant.

## Expectations

Table models can carry expectations, the data-quality rules Databricks calls DLT
expectations. Each has a name, a rule (a boolean SQL predicate over the model's output columns)
and an action for rows where the rule is not true (`NULL` counts as not true):

| Action | Effect |
| --- | --- |
| `warn` | Count the rows; publish them anyway. |
| `drop` | Remove the rows before the snapshot is published. |
| `fail` | Stop the run on the first violating batch. Nothing is published, so the previous snapshot stays current; the run fails with the rule's name. |

```json
"expectations": [
  {"name": "has_email", "predicate": "email LIKE '%@%'", "action": "warn"},
  {"name": "eu_only", "predicate": "country IN ('DE','FR','NL')", "action": "drop"},
  {"name": "positive_amount", "predicate": "amount > 0", "action": "fail"}
]
```

Rules follow the row-filter grammar: the output's own columns, literals, operators and
deterministic functions; no subqueries or other tables. Saving and `POST /v1/models/validate`
check every rule against the planned output. Every rule sees every row (a `warn` rule also counts
rows that a `drop` rule removes). Each checked run stores per-rule counts, returned as
`expectation_results` on the model (readers whose row filter hides part of the output see
pass/fail without counts), and writes a `model.expectations` audit row. In the desktop app, the
model sheet lists the rules with their last result.

The `cancel_compensating_arithmetic` logical **OptimizerRule** runs after DataFusion's standard rules simplify views. It can combine deterministic view projection chains when a cancellation fires. It preserves semantics after type coercion, so an AnalyzerRule is not appropriate. A view `SELECT id + 1 AS y FROM app_db.users` followed by `SELECT y - 1 FROM models.v` can collapse to `id`. DataFusion 55.2 Int64 add/sub wraps modulo 2^64 (including MAX + 1 and MIN - 1); cancellation and constant-chain folding use the same wrapping semantics. Casts preserve result type and nullability. Floats and volatile expressions are excluded. Decimal128 arithmetic uses checked operations: cancelling a chain can remove an overflow error, so decimals are conservatively skipped (a regression test covers this). Other integer widths remain unchanged pending separate proofs.

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/v1/models/$($model.id)/explain" -Headers $headers | ConvertTo-Json -Depth 8
```

Explain returns `logical_before`, `logical_after`, `physical`, and `rules_fired` entries with `rule`, `before` and `after`. Set `optimize: false` to use only DataFusion's standard optimizer for that model's run or Explain plan. The desktop shows before/after diff rows and expandable plans. `POST /v1/models/validate` validates an unsaved editor definition without mutation.
