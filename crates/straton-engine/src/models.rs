use crate::{
    access::{self, Principal},
    catalog,
    sql::{self, Sql, Table},
    store,
};
use anyhow::{Result, ensure};
use datafusion::{
    arrow::datatypes::Schema, common::tree_node::TreeNodeRecursion, dataframe::DataFrame,
    datasource::empty::EmptyTable, logical_expr::LogicalPlan, prelude::SessionContext,
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub const SOURCE: &str = "straton-models";
// Serialize validation plus writes: concurrent saves cannot introduce a cycle.
pub static SAVES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub name: String,
    pub sql: String,
    pub materialization: String,
    pub trigger: String,
    pub cron: Option<String>,
    #[serde(default = "enabled")]
    pub optimize: bool,
}
fn enabled() -> bool {
    true
}
pub fn validate_input(m: &Input) -> Result<()> {
    ensure!(
        !m.name.is_empty()
            && m.name.len() <= 128
            && m.name
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_lowercase() || (i > 0 && b.is_ascii_digit())),
        "name must be a lowercase SQL identifier"
    );
    catalog::path_component(&m.name)?;
    ensure!(
        ["table", "view"].contains(&m.materialization.as_str()),
        "materialization must be table or view"
    );
    ensure!(
        ["manual", "cron", "upstream"].contains(&m.trigger.as_str()),
        "invalid trigger"
    );
    ensure!(
        m.materialization == "table" || m.trigger == "manual",
        "view models have no runs; use a manual trigger"
    );
    if m.trigger == "cron" {
        m.cron
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("cron is required"))?
            .parse::<cron::Schedule>()?;
    } else {
        ensure!(m.cron.is_none(), "cron is only valid with the cron trigger");
    }
    select(&m.sql)?;
    Ok(())
}
pub fn select(text: &str) -> Result<()> {
    use datafusion::sql::{parser::Statement, sqlparser::ast::Statement as Ast};
    ensure!(
        matches!(sql::statement(text)?, Statement::Statement(s) if matches!(s.as_ref(),Ast::Query(_))),
        "one read-only SELECT is required"
    );
    Ok(())
}

// Views are planned with the QUERYING principal's filtered/masked tables, never their owner's.
// During validation, table models expose their definition's schema even before a first publish.
pub async fn register(
    pool: &SqlitePool,
    p: &Principal,
    ctx: &SessionContext,
    tables: &mut Vec<Table>,
    validation: bool,
) -> Result<()> {
    let rows = sqlx::query("SELECT m.*,d.id AS dataset_id FROM models m JOIN datasets d ON d.source_id='straton-models' AND d.name=m.name ORDER BY m.id").fetch_all(pool).await?;
    let deps = sqlx::query(
        "SELECT model_id,upstream_model_id FROM model_deps WHERE upstream_model_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut done = BTreeSet::new();
    let schema = ctx.catalog("datafusion").unwrap().schema("models").unwrap();
    for _ in 0..rows.len() {
        let mut progress = false;
        for r in &rows {
            let id: &str = r.get("id");
            if done.contains(id)
                || deps.iter().any(|d| {
                    d.get::<&str, _>("model_id") == id
                        && !done.contains(d.get::<&str, _>("upstream_model_id"))
                })
            {
                continue;
            }
            done.insert(id.to_owned());
            progress = true;
            let name: &str = r.get("name");
            let dataset: &str = r.get("dataset_id");
            if !p.admin() && p.read_roles(SOURCE, dataset).is_empty() {
                continue;
            }
            let view = r.get::<&str, _>("materialization") == "view";
            if !validation && !view {
                continue;
            }
            // Never leave a stale snapshot registered when validating a changed definition.
            schema.deregister_table(name)?;
            tables.retain(|t| !(t.schema == "models" && t.name == name));
            let planned = async {
                select(r.get("sql"))?;
                let plan = ctx.state().create_logical_plan(r.get("sql")).await?;
                sql::options().verify_plan(&plan)?;
                let frame = if view {
                    DataFrame::new(ctx.state(), plan)
                } else {
                    ctx.read_table(Arc::new(EmptyTable::new(Arc::new(
                        plan.schema().as_arrow().clone(),
                    ))))?
                };
                let policy = crate::policies::effective(pool, p, SOURCE, dataset, &frame)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("forbidden"))?;
                Ok::<_, anyhow::Error>(crate::policies::project(frame, policy)?.into_view())
            }
            .await;
            if let Ok(provider) = planned {
                tables.push(Table {
                    schema: "models".into(),
                    name: name.into(),
                    columns: sql::columns(&provider.schema()),
                });
                let provider: Arc<dyn datafusion::catalog::TableProvider> = if validation {
                    Arc::new(EmptyTable::new(provider.schema()))
                } else {
                    provider
                };
                schema.register_table(name.into(), provider)?;
            }
        }
        if !progress {
            break;
        }
    }
    Ok(())
}
#[derive(Default, Debug)]
pub struct Dependencies {
    pub datasets: BTreeSet<String>,
    pub models: BTreeSet<String>,
    pub lineage: crate::column_lineage::Analysis,
}
pub async fn plan(sql: &Sql, text: &str) -> Result<(DataFrame, Dependencies)> {
    select(text)?;
    let (ctx, _) = sql.context_for_models(true).await?;
    let frame = sql.plan(&ctx, text, &[]).await?;
    let sources = sqlx::query("SELECT id,name FROM sources ORDER BY id")
        .fetch_all(&sql.pool)
        .await?;
    let datasets = sqlx::query("SELECT id,source_id,name FROM datasets ORDER BY source_id,name")
        .fetch_all(&sql.pool)
        .await?;
    let models = sqlx::query("SELECT id,name FROM models")
        .fetch_all(&sql.pool)
        .await?;
    let (schemas, tables) = sql::catalog_names(&sources, &datasets);
    let lineage_tables = datasets
        .iter()
        .map(|d| {
            (
                (
                    schemas[d.get::<&str, _>("source_id")].clone(),
                    tables[d.get::<&str, _>("id")].clone(),
                ),
                d.get::<String, _>("id"),
            )
        })
        .collect();
    let mut deps = Dependencies {
        lineage: crate::column_lineage::derive(frame.logical_plan(), &lineage_tables, "public"),
        ..Default::default()
    };
    frame.logical_plan().apply_with_subqueries(|p| {
        if let LogicalPlan::TableScan(scan) = p
            && let Some(d) = datasets.iter().find(|d| {
                let source: &str = d.get("source_id");
                schemas[source] == scan.table_name.schema().unwrap_or("public")
                    && tables[d.get::<&str, _>("id")] == scan.table_name.table()
            })
        {
            if d.get::<&str, _>("source_id") == SOURCE {
                if let Some(m) = models
                    .iter()
                    .find(|m| m.get::<&str, _>("name") == d.get::<&str, _>("name"))
                {
                    deps.models.insert(m.get("id"));
                }
            } else {
                deps.datasets.insert(d.get("id"));
            }
        }
        Ok(TreeNodeRecursion::Continue)
    })?;
    Ok((frame, deps))
}
pub async fn check_cycle(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    deps: &Dependencies,
) -> Result<()> {
    let rows = sqlx::query(
        "SELECT model_id,upstream_model_id FROM model_deps WHERE upstream_model_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut graph = BTreeMap::<String, Vec<String>>::new();
    for r in rows {
        if r.get::<&str, _>("model_id") != id {
            graph
                .entry(r.get("model_id"))
                .or_default()
                .push(r.get("upstream_model_id"));
        }
    }
    graph.insert(id.into(), deps.models.iter().cloned().collect());
    fn visit(
        node: &str,
        graph: &BTreeMap<String, Vec<String>>,
        path: &mut Vec<String>,
        seen: &mut BTreeSet<String>,
    ) -> Option<Vec<String>> {
        if let Some(i) = path.iter().position(|x| x == node) {
            let mut cycle = path[i..].to_vec();
            cycle.push(node.into());
            return Some(cycle);
        }
        if !seen.insert(node.into()) {
            return None;
        }
        path.push(node.into());
        for next in graph.get(node).into_iter().flatten() {
            if let Some(c) = visit(next, graph, path, seen) {
                return Some(c);
            }
        }
        path.pop();
        None
    }
    if let Some(cycle) = visit(id, &graph, &mut vec![], &mut BTreeSet::new()) {
        let rows = sqlx::query("SELECT id,name FROM models")
            .fetch_all(pool)
            .await?;
        let names: Vec<_> = cycle
            .iter()
            .map(|n| {
                if n == id {
                    name.to_owned()
                } else {
                    rows.iter()
                        .find(|r| r.get::<&str, _>("id") == n)
                        .map(|r| r.get::<String, _>("name"))
                        .unwrap_or(n.clone())
                }
            })
            .collect();
        anyhow::bail!("model cycle: {}", names.join(" → "));
    }
    Ok(())
}
pub async fn catalog_model(
    tx: &mut Transaction<'_, Sqlite>,
    id: &str,
    name: &str,
    schema: &Schema,
    deps: &Dependencies,
) -> Result<()> {
    let dataset = catalog::upsert(
        tx,
        SOURCE,
        &straton_core::DatasetSchema {
            dataset: straton_core::Dataset {
                id: String::new(),
                source_id: SOURCE.into(),
                name: name.into(),
            },
            columns: schema
                .fields()
                .iter()
                .map(|f| straton_core::Column {
                    id: String::new(),
                    dataset_id: String::new(),
                    name: f.name().clone(),
                    data_type: f.data_type().to_string(),
                    nullable: f.is_nullable(),
                    primary_key: false,
                })
                .collect(),
            relationships: vec![],
            metadata: Default::default(),
        },
    )
    .await?;
    sqlx::query("DELETE FROM model_deps WHERE model_id=?")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    for d in &deps.datasets {
        sqlx::query("INSERT INTO model_deps(model_id,dataset_id) VALUES(?,?)")
            .bind(id)
            .bind(d)
            .execute(&mut **tx)
            .await?;
    }
    for m in &deps.models {
        sqlx::query("INSERT INTO model_deps(model_id,upstream_model_id) VALUES(?,?)")
            .bind(id)
            .bind(m)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("DELETE FROM relationships WHERE kind='lineage' AND to_dataset=?")
        .bind(&dataset)
        .execute(&mut **tx)
        .await?;
    let upstream:Vec<String>=sqlx::query_scalar("SELECT dataset_id FROM model_deps WHERE model_id=?1 AND dataset_id IS NOT NULL UNION SELECT d.id FROM model_deps md JOIN models m ON m.id=md.upstream_model_id JOIN datasets d ON d.source_id='straton-models' AND d.name=m.name WHERE md.model_id=?1").bind(id).fetch_all(&mut **tx).await?;
    for from in upstream {
        catalog::edge(
            tx,
            &straton_core::Relationship {
                id: String::new(),
                from_dataset: from,
                from_cols: vec![],
                to_dataset: dataset.clone(),
                to_cols: vec![],
                kind: straton_core::RelationshipKind::Lineage,
                confidence: None,
            },
        )
        .await?;
    }
    crate::column_lineage::replace(tx, &dataset, Some(id), &deps.lineage).await?;
    Ok(())
}
pub async fn revalidate(sql: &Sql, changed: &str) -> Result<()> {
    let ids:Vec<String>=sqlx::query_scalar("WITH RECURSIVE downstream(id) AS (SELECT model_id FROM model_deps WHERE upstream_model_id=? UNION SELECT md.model_id FROM model_deps md JOIN downstream d ON md.upstream_model_id=d.id) SELECT id FROM downstream").bind(changed).fetch_all(&sql.pool).await?;
    for id in ids {
        let r = sqlx::query("SELECT * FROM models WHERE id=?")
            .bind(&id)
            .fetch_one(&sql.pool)
            .await?;
        let result = async {
            let p = access::principal(&sql.pool, r.get("owner_id")).await?;
            plan(&sql.for_principal(p), r.get("sql")).await
        }
        .await;
        let mut tx = sql.pool.begin().await?;
        if let Ok((frame, deps)) = &result {
            catalog_model(&mut tx, &id, r.get("name"), frame.schema().as_arrow(), deps).await?;
        }
        if result.is_err() {
            let dataset: String = sqlx::query_scalar(
                "SELECT id FROM datasets WHERE source_id='straton-models' AND name=?",
            )
            .bind(r.get::<&str, _>("name"))
            .fetch_one(&mut *tx)
            .await?;
            crate::column_lineage::replace(
                &mut tx,
                &dataset,
                Some(&id),
                &crate::column_lineage::Analysis {
                    incomplete: true,
                    ..Default::default()
                },
            )
            .await?;
        }
        sqlx::query("UPDATE models SET status=?,error=? WHERE id=?")
            .bind(if result.is_ok() { "ready" } else { "broken" })
            .bind(result.err().map(|e| e.to_string()))
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        store::audit(&mut tx, "model.revalidated", &id, "").await?;
        tx.commit().await?;
    }
    Ok(())
}
pub async fn enqueue_upstream(
    tx: &mut Transaction<'_, Sqlite>,
    published: &[String],
) -> Result<Vec<String>> {
    // Follow view-only paths too: views never publish their own snapshots.
    let jobs:Vec<String>=sqlx::query_scalar("WITH RECURSIVE affected(id) AS (SELECT model_id FROM model_deps WHERE dataset_id IN (SELECT value FROM json_each(?1)) OR upstream_model_id IN (SELECT m.id FROM models m JOIN datasets d ON d.name=m.name AND d.source_id='straton-models' WHERE d.id IN (SELECT value FROM json_each(?1))) UNION SELECT md.model_id FROM model_deps md JOIN affected a ON md.upstream_model_id=a.id JOIN models v ON v.id=a.id AND v.materialization='view') SELECT j.id FROM affected a JOIN models m ON m.id=a.id JOIN jobs j ON j.model_id=m.id WHERE m.trigger='upstream' AND m.status='ready' AND j.enabled=1 AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.job_id=j.id AND r.state='queued')").bind(serde_json::to_string(published)?).fetch_all(&mut **tx).await?;
    let mut ids = vec![];
    for job in jobs {
        ids.push(store::enqueue(tx, &job, store::now()).await?);
    }
    Ok(ids)
}
