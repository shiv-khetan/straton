//! Workload counters contain identifiers and operator classes only, never expressions or values.
use crate::store;
use anyhow::Result;
use datafusion::{
    arrow::record_batch::RecordBatch,
    common::{
        Column,
        tree_node::{TreeNode, TreeNodeRecursion},
    },
    dataframe::DataFrame,
    datasource::{physical_plan::FileScanConfig, source::DataSourceExec},
    logical_expr::{Expr, LogicalPlan, Operator},
    physical_plan::{ExecutionPlan, execute_stream},
};
use futures::{StreamExt, TryStreamExt, stream::BoxStream};
use sqlx::{Row, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Instant,
};
use tokio::sync::mpsc;

type Tables = BTreeMap<(String, String), String>;
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Usage {
    pub dataset: String,
    pub column: String,
    pub role: String,
    pub op: String,
}
#[derive(Clone)]
struct Slot {
    column: Column,
    origins: Vec<(String, String)>,
}
fn refs(expr: &Expr, slots: &[Slot]) -> Vec<(String, String)> {
    let mut out = BTreeSet::new();
    for c in expr.column_refs() {
        let found: Vec<_> = slots
            .iter()
            .filter(|s| {
                s.column.name == c.name && (c.relation.is_none() || s.column.relation == c.relation)
            })
            .collect();
        if found.len() == 1 {
            out.extend(found[0].origins.clone());
        }
    }
    out.into_iter().collect()
}
fn add(expr: &Expr, role: &str, op: &str, slots: &[Slot], out: &mut BTreeSet<Usage>) {
    for (dataset, column) in refs(expr, slots) {
        out.insert(Usage {
            dataset,
            column,
            role: role.into(),
            op: op.into(),
        });
    }
}
fn predicate(expr: &Expr, slots: &[Slot], out: &mut BTreeSet<Usage>) {
    let _ = expr.apply(|e| {
        let op = match e {
            Expr::BinaryExpr(b) => match b.op {
                Operator::Eq | Operator::IsNotDistinctFrom => "equality",
                Operator::Lt | Operator::LtEq | Operator::Gt | Operator::GtEq => "range",
                _ => "",
            },
            Expr::Like(_) | Expr::SimilarTo(_) => "like",
            Expr::Between(_) => "range",
            Expr::InList(_) => "equality",
            Expr::IsNull(_) | Expr::IsNotNull(_) => "null",
            _ => "",
        };
        if !op.is_empty() {
            let role=if matches!(e,Expr::BinaryExpr(b) if !b.left.column_refs().is_empty() && !b.right.column_refs().is_empty()){"join_key"}else{"filter"};
            add(e, role, op, slots, out);
        }
        Ok(TreeNodeRecursion::Continue)
    });
}
pub fn extract(plan: &LogicalPlan, tables: &Tables) -> BTreeSet<Usage> {
    fn visit(p: &LogicalPlan, tables: &Tables, out: &mut BTreeSet<Usage>) -> Vec<Slot> {
        let columns = p.schema().columns();
        if let LogicalPlan::TableScan(s) = p {
            let key = (
                s.table_name.schema().unwrap_or("public").to_owned(),
                s.table_name.table().to_owned(),
            );
            let slots: Vec<_> = if let Some(id) = tables.get(&key) {
                out.insert(Usage {
                    dataset: id.clone(),
                    column: String::new(),
                    role: "scan".into(),
                    op: String::new(),
                });
                columns
                    .into_iter()
                    .map(|column| Slot {
                        origins: vec![(id.clone(), column.name.clone())],
                        column,
                    })
                    .collect()
            } else if let Some(plan) = s.source.get_logical_plan() {
                let input = visit(&plan, tables, out);
                columns
                    .into_iter()
                    .enumerate()
                    .map(|(i, column)| Slot {
                        column,
                        origins: input.get(i).map(|s| s.origins.clone()).unwrap_or_default(),
                    })
                    .collect()
            } else {
                vec![]
            };
            let mut slots = slots;
            if tables.contains_key(&key)
                && let Some(plan) = s.source.get_logical_plan()
            {
                let base = visit(&plan, tables, out);
                for slot in &mut slots {
                    if let Some(origin) = base.iter().find(|b| b.column.name == slot.column.name) {
                        slot.origins.extend(origin.origins.clone());
                    }
                }
            }
            for f in &s.filters {
                predicate(f, &slots, out);
            }
            return slots;
        }
        let input: Vec<_> = p
            .inputs()
            .into_iter()
            .flat_map(|p| visit(p, tables, out))
            .collect();
        let project = match p {
            LogicalPlan::Filter(f) => {
                predicate(&f.predicate, &input, out);
                None
            }
            LogicalPlan::Join(j) => {
                for (l, r) in &j.on {
                    add(l, "join_key", "equality", &input, out);
                    add(r, "join_key", "equality", &input, out);
                }
                if let Some(f) = &j.filter {
                    predicate(f, &input, out);
                }
                None
            }
            LogicalPlan::Aggregate(a) => {
                for e in &a.group_expr {
                    add(e, "group_by", "", &input, out);
                }
                Some(a.group_expr.iter().chain(&a.aggr_expr).collect::<Vec<_>>())
            }
            LogicalPlan::Sort(s) => {
                for e in &s.expr {
                    add(&e.expr, "sort", "", &input, out);
                }
                None
            }
            LogicalPlan::Projection(p) => Some(p.expr.iter().collect()),
            _ => None,
        };
        if let Some(exprs) = project {
            return columns
                .into_iter()
                .zip(exprs)
                .map(|(column, e)| Slot {
                    column,
                    origins: refs(e, &input),
                })
                .collect();
        }
        if let LogicalPlan::SubqueryAlias(alias) = p {
            let key = (
                alias.alias.schema().unwrap_or("public").to_owned(),
                alias.alias.table().to_owned(),
            );
            let dataset = tables.get(&key);
            if let Some(dataset) = dataset {
                out.insert(Usage {
                    dataset: dataset.clone(),
                    column: String::new(),
                    role: "scan".into(),
                    op: String::new(),
                });
            }
            return columns
                .into_iter()
                .enumerate()
                .map(|(i, column)| {
                    let mut origins = input.get(i).map(|s| s.origins.clone()).unwrap_or_default();
                    if let Some(dataset) = dataset {
                        origins.push((dataset.clone(), column.name.clone()));
                    }
                    Slot { column, origins }
                })
                .collect();
        }
        columns
            .into_iter()
            .map(|column| Slot {
                origins: refs(&Expr::Column(column.clone()), &input),
                column,
            })
            .collect()
    }
    let mut out = BTreeSet::new();
    visit(plan, tables, &mut out);
    out
}
struct Sample {
    usage: BTreeSet<Usage>,
    scans: BTreeMap<String, u64>,
    rows: u64,
    elapsed: u64,
}
#[derive(Clone)]
pub struct Recorder(mpsc::Sender<Sample>);
impl Recorder {
    pub fn new(pool: SqlitePool) -> Self {
        let (tx, mut rx) = mpsc::channel::<Sample>(1024);
        tokio::spawn(async move {
            let mut pending = Vec::new();
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3));
            loop {
                tokio::select! {sample=rx.recv()=>match sample{Some(s)=>pending.push(s),None=>{let _=flush(&pool,&pending).await;break;}},_=tick.tick()=>{if !pending.is_empty(){if flush(&pool,&pending).await.is_ok(){pending.clear();}else{tracing::warn!("workload counters could not be persisted");}}}}
                // Bound memory if the local catalog is unavailable; telemetry never blocks a query.
                if pending.len() > 4096 {
                    pending.drain(..pending.len() - 4096);
                }
            }
        });
        Self(tx)
    }
    pub async fn stream(
        &self,
        pool: &SqlitePool,
        data_dir: &std::path::Path,
        frame: DataFrame,
        logical: &LogicalPlan,
    ) -> Result<BoxStream<'static, datafusion::common::Result<RecordBatch>>> {
        let sources = sqlx::query("SELECT id,name FROM sources ORDER BY id")
            .fetch_all(pool)
            .await?;
        let datasets =
            sqlx::query("SELECT id,source_id,name FROM datasets ORDER BY source_id,name")
                .fetch_all(pool)
                .await?;
        let (schemas, names) = crate::sql::catalog_names(&sources, &datasets);
        let tables = datasets
            .iter()
            .map(|d| {
                (
                    (
                        schemas[d.get::<&str, _>("source_id")].clone(),
                        names[d.get::<&str, _>("id")].clone(),
                    ),
                    d.get::<String, _>("id"),
                )
            })
            .collect();
        let usage = extract(logical, &tables);
        let paths = datasets
            .iter()
            .filter_map(|d| {
                let source: &str = d.get("source_id");
                let name: &str = d.get("name");
                let (s, t) = if source == "straton-local-lake" {
                    name.split_once('/')?
                } else {
                    (source, name)
                };
                datafusion::object_store::path::Path::from_filesystem_path(
                    data_dir.join("data").join(s).join(t),
                )
                .ok()
                .map(|p| (d.get::<String, _>("id"), format!("{p}/")))
            })
            .collect();
        let plan = frame.create_physical_plan().await?;
        let stream = execute_stream(plan.clone(), Arc::new(frame.task_ctx()))?;
        let tracker = Tracker {
            recorder: self.clone(),
            usage,
            paths,
            plan,
            start: Instant::now(),
            rows: 0,
        };
        Ok(
            futures::stream::unfold((stream, tracker), |(mut stream, mut tracker)| async move {
                let batch = stream.next().await?;
                if let Ok(b) = &batch {
                    tracker.rows += b.num_rows() as u64;
                }
                Some((batch, (stream, tracker)))
            })
            .boxed(),
        )
    }
}
struct Tracker {
    recorder: Recorder,
    usage: BTreeSet<Usage>,
    paths: BTreeMap<String, String>,
    plan: Arc<dyn ExecutionPlan>,
    start: Instant,
    rows: u64,
}
impl Drop for Tracker {
    fn drop(&mut self) {
        fn scans(
            p: &Arc<dyn ExecutionPlan>,
            paths: &BTreeMap<String, String>,
            out: &mut BTreeMap<String, u64>,
        ) {
            if let Some(scan) = p.downcast_ref::<DataSourceExec>()
                && let Some(config) = scan.data_source().downcast_ref::<FileScanConfig>()
            {
                let rows = p
                    .metrics()
                    .map(|m| {
                        m.iter()
                            .filter(|m| {
                                matches!(m.value().name(), "output_rows" | "pushdown_rows_pruned")
                            })
                            .map(|m| m.value().as_usize() as u64)
                            .sum()
                    })
                    .unwrap_or(0);
                for (id, prefix) in paths {
                    if config.file_groups.iter().any(|g| {
                        g.iter()
                            .any(|f| f.object_meta.location.as_ref().starts_with(prefix))
                    }) {
                        *out.entry(id.clone()).or_default() += rows;
                    }
                }
            }
            for c in p.children() {
                scans(c, paths, out);
            }
        }
        let mut counts = BTreeMap::new();
        scans(&self.plan, &self.paths, &mut counts);
        let _ = self.recorder.0.try_send(Sample {
            usage: self.usage.clone(),
            scans: counts,
            rows: self.rows,
            elapsed: self.start.elapsed().as_millis() as u64,
        });
    }
}
async fn flush(pool: &SqlitePool, samples: &[Sample]) -> Result<()> {
    let mut counts = BTreeMap::<Usage, (i64, i64, i64, i64)>::new();
    for s in samples {
        for u in &s.usage {
            let c = counts.entry(u.clone()).or_default();
            c.0 += 1;
            c.1 += s.scans.get(&u.dataset).copied().unwrap_or(0) as i64;
            c.2 += s.rows as i64;
            c.3 += s.elapsed as i64;
        }
    }
    let mut tx = pool.begin().await?;
    for (u, (count, scanned, returned, elapsed)) in counts {
        sqlx::query("INSERT INTO query_stats(dataset_id,column,role,op,count,rows_scanned,rows_returned,elapsed_ms,last_seen) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM datasets WHERE id=?) ON CONFLICT(dataset_id,column,role,op) DO UPDATE SET count=count+excluded.count,rows_scanned=rows_scanned+excluded.rows_scanned,rows_returned=rows_returned+excluded.rows_returned,elapsed_ms=elapsed_ms+excluded.elapsed_ms,last_seen=excluded.last_seen").bind(&u.dataset).bind(&u.column).bind(&u.role).bind(&u.op).bind(count).bind(scanned).bind(returned).bind(elapsed).bind(store::now()).bind(&u.dataset).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn collect(sql: &crate::sql::Sql, frame: DataFrame) -> Result<Vec<RecordBatch>> {
    sql.stream(frame)
        .await?
        .try_collect()
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn counters_upsert_without_text() {
        let dir = std::env::temp_dir().join(format!("straton-stats-{}", store::id()));
        let pool = store::open(&dir).await.unwrap();
        sqlx::query("INSERT INTO sources(id,name,kind) VALUES('s','S','noop')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO datasets(id,source_id,name) VALUES('d','s','table')")
            .execute(&pool)
            .await
            .unwrap();
        let sample = Sample {
            usage: BTreeSet::from([Usage {
                dataset: "d".into(),
                column: "id".into(),
                role: "filter".into(),
                op: "equality".into(),
            }]),
            scans: BTreeMap::from([("d".into(), 100)]),
            rows: 1,
            elapsed: 2,
        };
        flush(&pool, std::slice::from_ref(&sample)).await.unwrap();
        flush(&pool, &[sample]).await.unwrap();
        let r = sqlx::query("SELECT * FROM query_stats")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(r.get::<i64, _>("count"), 2);
        assert_eq!(r.get::<i64, _>("rows_scanned"), 200);
        pool.close().await;
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
