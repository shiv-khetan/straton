# OpenLineage export

Straton can report every sync and model run to an [OpenLineage](https://openlineage.io)
collector, so the tables it loads and builds appear in the same lineage graph as the rest of
your platform: Marquez, DataHub, OpenMetadata, Unity Catalog and other OpenLineage consumers.

## Turn it on

```toml
[lineage]
openlineage_url = "https://marquez.example/api/v1/lineage"
namespace = "straton"
```

Or set `STRATON_LINEAGE_OPENLINEAGE_URL`. The URL must use HTTPS, or plain HTTP to a loopback
address such as a collector on the same host. If the collector needs a bearer API key, set it
in `STRATON_OPENLINEAGE_API_KEY`; keys are never read from the file or written to logs. The
engine checks the URL at startup and refuses to start if it is invalid.

## What is sent

| Run state | Event |
| --- | --- |
| Running | `START` |
| Succeeded | `COMPLETE` |
| Failed | `FAIL`, with the run error in an `errorMessage` facet |
| Cancelled | `ABORT` |

Each event names the job, its inputs and its output, with a `schema` facet listing column names
and types from the catalog:

- **Syncs:** the job is `sync.<schema>.<table>`. The input is the source dataset, named by the
  OpenLineage conventions (`postgres://host:5432` with `database.schema.table`, `mysql://…`,
  `sqlserver://…`, `mongodb://…`, `file` for SQLite and CSV paths, `stripe://<account>`,
  `salesforce://<instance>`). The output is the lake table in your namespace.
- **Models:** the job is `model.<name>`, with the model's SQL in a `sql` facet. The inputs are
  the lake tables and models it reads; the output is `models.<name>`.

Backups are not reported. Run IDs are the engine's run IDs, so an event links back to the run in
the desktop app.

## Delivery

Events never slow down or fail a run. They are built after each state change, queued (up to
1,024), and sent one at a time with up to three attempts. If the collector is unreachable or the
queue is full, events are dropped and the engine logs a warning. Every send passes the same
[egress policy](configuration.md) as connectors, and redirects are refused.

## Try it with Marquez

```bash
docker run -d -p 5000:5000 -p 5001:5001 marquezproject/marquez:latest
```

Then set `openlineage_url = "http://127.0.0.1:5000/api/v1/lineage"`, restart the engine and run a
sync. The job and its datasets appear in Marquez's lineage view.
