# Data quality

Quality checks test a dataset or model and record a pass or fail on every run. Run them by hand,
on a UTC cron schedule, or as a **validate** step in a pipeline (an `error` check stops the
pipeline; a `warn` check lets it continue). Manage them under **Intelligence → Data Quality**.

## Check kinds

| Kind | Fails when |
| --- | --- |
| `not_null` | the chosen column has nulls |
| `unique` | values of the chosen column repeat |
| `range` | values fall outside `min` / `max` |
| `freshness` | the last sync is older than `max_age_seconds` |
| `row_count` | the row count is outside `min` / `max` |
| `custom_sql` | a read-only query returns any rows |
| `drift` | the table's profile changed more than allowed since the previous run |

### Drift

A `drift` check profiles its target on every run and compares the result with its previous
run. Thresholds are fractions, and you need at least one:

```json
{"kind": "drift", "dataset_id": "…",
 "config": {"max_row_change": 0.5, "max_null_increase": 0.1, "max_distinct_change": 0.5}}
```

- `max_row_change`: relative change in row count (0.5 = more than 50% up or down);
- `max_null_increase`: rise in a column's null share, in points (0.1 = ten points);
- `max_distinct_change`: relative change in a column's approximate distinct count.

Added and removed columns are always reported. The first run records a baseline and passes.
A failing run explains itself, for example `rows 200 → 80; email nulls 1% → 35%`. Profiles
keep only counts and ratios (never values) and the last 30 per check are kept.

## Who sees what

Checks run with their **owner's** access, so a check never counts rows or columns its owner
cannot read. Anyone who can read the target can see the check and its pass/fail history.
Observed values, failing-row counts and drift details are shown only to the owner,
administrators, and readers whose own access to the target is not row-filtered. Others see
pass or fail only, so a check cannot reveal how many rows a row filter hides from them.

## Column profiles

In **Explorer**, open a table's details and choose **Profile columns** for row count, null
share, approximate distinct values and min/max of every column in the current view (same
filters, search and policies as the grid). Numeric columns also get a twelve-bin histogram;
hover a bar for its range and count. `POST /v1/explorer/profile` returns the same data, with
`histogram` as `[{lo, hi, count}]` (the last bin includes the maximum).
