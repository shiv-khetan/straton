use crate::{
    access::{Principal, Target},
    notify::{self, Notice},
    quality,
    runner::{self, Events},
    sql::Sql,
    store,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

pub static SAVES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub node_id: String,
    pub kind: String,
    pub ref_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub from_node: String,
    pub to_node: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub cron: Option<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
}
fn enabled() -> bool {
    true
}
pub async fn validate(pool: &SqlitePool, q: &Input) -> Result<Value> {
    let mut errors = vec![];
    if q.name.trim().is_empty() || q.name.len() > 200 {
        errors.push(json!({"message":"name is required (up to 200 bytes)"}));
    }
    if q.nodes.is_empty() {
        errors.push(json!({"message":"graph must be non-empty"}));
    }
    if q.cron
        .as_ref()
        .is_some_and(|c| c.parse::<cron::Schedule>().is_err())
    {
        errors.push(json!({"message":"invalid cron expression (use seconds field)"}));
    }
    let mut ids = BTreeSet::new();
    for n in &q.nodes {
        if n.node_id.is_empty() || !ids.insert(n.node_id.clone()) {
            errors.push(
                json!({"node_id":n.node_id,"message":"node ids must be non-empty and unique"}),
            );
        }
        let exists=match n.kind.as_str(){
            "sync"=>sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=? AND builtin=0 AND model_id IS NULL AND source_id NOT IN ('straton-models','straton-local-lake'))").bind(&n.ref_id).fetch_one(pool).await?,
            "transform"=>sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM models m JOIN jobs j ON j.model_id=m.id WHERE m.id=? AND m.materialization='table')").bind(&n.ref_id).fetch_one(pool).await?,
            "validate"=>sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM quality_checks WHERE id=?)").bind(&n.ref_id).fetch_one(pool).await?,
            _=>false,
        };
        if !exists {
            errors.push(json!({"node_id":n.node_id,"message":"unknown or invalid node reference"}));
        }
    }
    let mut degree: BTreeMap<String, usize> = ids.iter().map(|id| (id.clone(), 0)).collect();
    let mut seen = BTreeSet::new();
    for e in &q.edges {
        if !ids.contains(&e.from_node) || !ids.contains(&e.to_node) {
            errors.push(json!({"node_id":e.to_node,"message":"edge references a missing node"}));
            continue;
        }
        if e.from_node == e.to_node {
            errors.push(json!({"node_id":e.to_node,"message":"self-edges are forbidden"}));
        }
        if !seen.insert((e.from_node.clone(), e.to_node.clone())) {
            errors.push(json!({"node_id":e.to_node,"message":"duplicate edge"}));
            continue;
        }
        *degree.get_mut(&e.to_node).unwrap() += 1;
    }
    let mut ready: Vec<String> = degree
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(n, _)| n.clone())
        .collect();
    let mut count = 0;
    while let Some(id) = ready.pop() {
        count += 1;
        for (from, to) in &seen {
            if from == &id {
                let d = degree.get_mut(to).unwrap();
                *d -= 1;
                if *d == 0 {
                    ready.push(to.clone())
                }
            }
        }
    }
    if count != ids.len() {
        errors.push(json!({"message":"graph contains a cycle"}));
    }
    Ok(json!({"valid":errors.is_empty(),"errors":errors}))
}
pub async fn allowed(pool: &SqlitePool, p: &Principal, n: &Node) -> Result<bool> {
    if p.admin() {
        return Ok(true);
    }
    Ok(match n.kind.as_str() {
        "sync" => {
            let r=sqlx::query("SELECT j.source_id,d.id AS dataset_id FROM jobs j LEFT JOIN datasets d ON d.source_id=j.source_id AND d.name=j.dataset WHERE j.id=? AND j.builtin=0 AND j.model_id IS NULL").bind(&n.ref_id).fetch_optional(pool).await?;
            r.is_some_and(|r| {
                p.allows(
                    "sync_admin",
                    Target {
                        source: r.get("source_id"),
                        dataset: r.get("dataset_id"),
                    },
                )
            })
        }
        "transform" => {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM models WHERE id=? AND owner_id=?)",
            )
            .bind(&n.ref_id)
            .bind(&p.user.id)
            .fetch_one(pool)
            .await?
        }
        "validate" => {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM quality_checks WHERE id=? AND owner_id=?)",
            )
            .bind(&n.ref_id)
            .bind(&p.user.id)
            .fetch_one(pool)
            .await?
        }
        _ => false,
    })
}
pub async fn graph(pool: &SqlitePool, id: &str) -> Result<Input> {
    let r = sqlx::query("SELECT * FROM pipelines WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let nodes = sqlx::query("SELECT * FROM pipeline_nodes WHERE pipeline_id=? ORDER BY node_id")
        .bind(id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| Node {
            node_id: r.get("node_id"),
            kind: r.get("kind"),
            ref_id: r.get("ref_id"),
            label: r.get("label"),
            x: r.get("x"),
            y: r.get("y"),
        })
        .collect();
    let edges =
        sqlx::query("SELECT * FROM pipeline_edges WHERE pipeline_id=? ORDER BY from_node,to_node")
            .bind(id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|r| Edge {
                from_node: r.get("from_node"),
                to_node: r.get("to_node"),
            })
            .collect();
    Ok(Input {
        name: r.get("name"),
        description: r.get("description"),
        cron: r.get("cron"),
        enabled: r.get("enabled"),
        nodes,
        edges,
    })
}
pub async fn enqueue(
    tx: &mut Transaction<'_, Sqlite>,
    pipeline: &str,
    trigger: &str,
) -> Result<String> {
    let id = store::id();
    sqlx::query("INSERT INTO pipeline_runs(id,pipeline_id,state,trigger) VALUES(?,?,'queued',?)")
        .bind(&id)
        .bind(pipeline)
        .bind(trigger)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO pipeline_run_nodes(run_id,node_id,state) SELECT ?,node_id,'pending' FROM pipeline_nodes WHERE pipeline_id=?").bind(&id).bind(pipeline).execute(&mut **tx).await?;
    store::audit(tx, "pipeline.queued", &id, trigger).await?;
    Ok(id)
}
fn event(events: &Events, run: &str, node: Option<&str>, state: &str) {
    let _=events.send(json!({"type":if node.is_some(){"pipeline_node"}else{"pipeline_run"},"id":run,"run_id":run,"node_id":node,"state":state}));
}
async fn node_state(
    pool: &SqlitePool,
    events: &Events,
    run: &str,
    node: &str,
    state: &str,
    error: Option<&str>,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let changed=sqlx::query("UPDATE pipeline_run_nodes SET state=?,error=?,finished_at=? WHERE run_id=? AND node_id=? AND state IN ('pending','running')").bind(state).bind(error).bind(store::now()).bind(run).bind(node).execute(&mut *tx).await?.rows_affected();
    if changed > 0 {
        store::audit(&mut tx, &format!("pipeline_node.{state}"), run, node).await?;
    }
    tx.commit().await?;
    if changed > 0 {
        event(events, run, Some(node), state);
    }
    Ok(())
}
pub async fn cancel(pool: &SqlitePool, events: &Events, id: &str) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let changed=sqlx::query("UPDATE pipeline_runs SET state='cancelled',finished_at=? WHERE id=? AND state IN ('queued','running')").bind(store::now()).bind(id).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Ok(false);
    }
    let children:Vec<String>=sqlx::query_scalar("SELECT child_run_id FROM pipeline_run_nodes WHERE run_id=? AND child_run_id IS NOT NULL AND state='running'").bind(id).fetch_all(&mut *tx).await?;
    for child in &children {
        sqlx::query("UPDATE runs SET cancel_requested=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated_at=? WHERE id=? AND state IN ('queued','running','interrupted')").bind(store::now()).bind(child).execute(&mut *tx).await?;
        store::audit(&mut tx, "run.cancel_requested", child, "").await?;
    }
    let nodes:Vec<String>=sqlx::query_scalar("UPDATE pipeline_run_nodes SET state='cancelled',finished_at=? WHERE run_id=? AND state IN ('pending','running') RETURNING node_id").bind(store::now()).bind(id).fetch_all(&mut *tx).await?;
    for node in &nodes {
        store::audit(&mut tx, "pipeline_node.cancelled", id, node).await?;
    }
    store::audit(&mut tx, "pipeline.cancelled", id, "").await?;
    tx.commit().await?;
    event(events, id, None, "cancelled");
    for node in nodes {
        event(events, id, Some(&node), "cancelled");
    }
    for child in children {
        let state: String = sqlx::query_scalar("SELECT state FROM runs WHERE id=?")
            .bind(&child)
            .fetch_one(pool)
            .await?;
        runner::event(events, &child, &state);
    }
    Ok(true)
}
pub async fn recover(pool: &SqlitePool, events: &Events) -> Result<()> {
    let mut tx = pool.begin().await?;
    let ids:Vec<String>=sqlx::query_scalar("UPDATE pipeline_runs SET state='interrupted',finished_at=?,error='engine stopped during run' WHERE state IN ('queued','running') RETURNING id").bind(store::now()).fetch_all(&mut *tx).await?;
    for id in &ids {
        sqlx::query("UPDATE pipeline_run_nodes SET state='cancelled',finished_at=? WHERE run_id=? AND state IN ('pending','running')").bind(store::now()).bind(id).execute(&mut *tx).await?;
        store::audit(&mut tx, "pipeline.interrupted", id, "").await?;
    }
    tx.commit().await?;
    for id in ids {
        event(events, &id, None, "interrupted");
    }
    Ok(())
}
async fn finish(
    sql: &Sql,
    events: &Events,
    id: &str,
    state: &str,
    error: Option<&str>,
) -> Result<()> {
    let mut tx = sql.pool.begin().await?;
    let owner:Option<String>=sqlx::query_scalar("UPDATE pipeline_runs SET state=?1,error=?2,finished_at=?3 WHERE id=?4 AND state IN ('queued','running') RETURNING (SELECT owner_id FROM pipelines WHERE id=pipeline_id)").bind(state).bind(error).bind(store::now()).bind(id).fetch_optional(&mut *tx).await?;
    if owner.is_some() {
        store::audit(&mut tx, &format!("pipeline.{state}"), id, "").await?;
    }
    tx.commit().await?;
    if let Some(owner) = owner {
        event(events, id, None, state);
        notify::emit(
            &sql.pool,
            events,
            Notice {
                severity: if state == "succeeded" {
                    "info"
                } else {
                    "error"
                },
                kind: if state == "succeeded" {
                    "pipeline.succeeded"
                } else {
                    "pipeline.failed"
                },
                title: if state == "succeeded" {
                    "Pipeline succeeded"
                } else {
                    "Pipeline failed"
                },
                entity_kind: "pipeline_run",
                entity_id: id,
                user_id: Some(&owner),
            },
        )
        .await?;
    }
    Ok(())
}
async fn run_node(sql: Sql, events: Events, run: String, n: Node, p: Principal) -> Result<()> {
    ensure!(
        allowed(&sql.pool, &p, &n).await?,
        "pipeline owner cannot run this node"
    );
    let mut rx = events.subscribe();
    let mut tx = sql.pool.begin().await?;
    let changed=sqlx::query("UPDATE pipeline_run_nodes SET state='running',started_at=? WHERE run_id=? AND node_id=? AND state='pending' AND EXISTS(SELECT 1 FROM pipeline_runs WHERE id=? AND state='running')").bind(store::now()).bind(&run).bind(&n.node_id).bind(&run).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Ok(());
    }
    let child = if n.kind != "validate" {
        let job = if n.kind == "transform" {
            sqlx::query_scalar::<_, String>("SELECT id FROM jobs WHERE model_id=?")
                .bind(&n.ref_id)
                .fetch_one(&mut *tx)
                .await?
        } else {
            n.ref_id.clone()
        };
        let child = store::enqueue(&mut tx, &job, store::now()).await?;
        sqlx::query("UPDATE pipeline_run_nodes SET child_run_id=? WHERE run_id=? AND node_id=?")
            .bind(&child)
            .bind(&run)
            .bind(&n.node_id)
            .execute(&mut *tx)
            .await?;
        Some(child)
    } else {
        None
    };
    store::audit(&mut tx, "pipeline_node.running", &run, &n.node_id).await?;
    tx.commit().await?;
    event(&events, &run, Some(&n.node_id), "running");
    let warning = if let Some(child) = child {
        runner::event(&events, &child, "queued");
        loop {
            let state: String = sqlx::query_scalar("SELECT state FROM runs WHERE id=?")
                .bind(&child)
                .fetch_one(&sql.pool)
                .await?;
            if ["succeeded", "failed", "cancelled"].contains(&state.as_str()) {
                ensure!(state == "succeeded", "child job did not succeed");
                break;
            }
            let active: bool =
                sqlx::query_scalar("SELECT state='running' FROM pipeline_runs WHERE id=?")
                    .bind(&run)
                    .fetch_one(&sql.pool)
                    .await?;
            if !active {
                return Ok(());
            }
            tokio::select! {_=rx.recv()=>{},_=tokio::time::sleep(Duration::from_secs(1))=>{}}
        }
        None
    } else {
        let result = quality::run(&sql, &events, &n.ref_id, Some(&run)).await?;
        let severity: String = sqlx::query_scalar("SELECT severity FROM quality_checks WHERE id=?")
            .bind(&n.ref_id)
            .fetch_one(&sql.pool)
            .await?;
        ensure!(
            result["status"] == "passed" || (result["status"] == "failed" && severity == "warn"),
            "quality check failed"
        );
        if result["status"] != "passed" {
            Some("quality check warning")
        } else {
            None
        }
    };
    node_state(&sql.pool, &events, &run, &n.node_id, "succeeded", warning).await
}
async fn execute(sql: &Sql, events: &Events, id: &str) -> Result<()> {
    let mut tx = sql.pool.begin().await?;
    let pipeline:Option<String>=sqlx::query_scalar("UPDATE pipeline_runs SET state='running',started_at=? WHERE id=? AND state='queued' RETURNING pipeline_id").bind(store::now()).bind(id).fetch_optional(&mut *tx).await?;
    let Some(pipeline) = pipeline else {
        return Ok(());
    };
    store::audit(&mut tx, "pipeline.running", id, "").await?;
    tx.commit().await?;
    event(events, id, None, "running");
    let q = graph(&sql.pool, &pipeline).await?;
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM pipelines WHERE id=?")
        .bind(&pipeline)
        .fetch_one(&sql.pool)
        .await?;
    loop {
        let active: bool =
            sqlx::query_scalar("SELECT state='running' FROM pipeline_runs WHERE id=?")
                .bind(id)
                .fetch_one(&sql.pool)
                .await?;
        if !active {
            return Ok(());
        }
        let rows = sqlx::query("SELECT node_id,state FROM pipeline_run_nodes WHERE run_id=?")
            .bind(id)
            .fetch_all(&sql.pool)
            .await?;
        let states: BTreeMap<String, String> = rows
            .iter()
            .map(|r| (r.get("node_id"), r.get("state")))
            .collect();
        let mut changed = false;
        for n in &q.nodes {
            if states[&n.node_id] == "pending"
                && q.edges
                    .iter()
                    .filter(|e| e.to_node == n.node_id)
                    .any(|e| ["failed", "skipped"].contains(&states[&e.from_node].as_str()))
            {
                node_state(
                    &sql.pool,
                    events,
                    id,
                    &n.node_id,
                    "skipped",
                    Some("upstream node failed"),
                )
                .await?;
                changed = true;
            }
        }
        if changed {
            continue;
        }
        let ready: Vec<_> = q
            .nodes
            .iter()
            .filter(|n| {
                states[&n.node_id] == "pending"
                    && q.edges
                        .iter()
                        .filter(|e| e.to_node == n.node_id)
                        .all(|e| states[&e.from_node] == "succeeded")
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            let failed = states.values().any(|s| s == "failed" || s == "skipped");
            return finish(
                sql,
                events,
                id,
                if failed { "failed" } else { "succeeded" },
                None,
            )
            .await;
        }
        let p = crate::access::principal(&sql.pool, &owner).await?;
        let mut wave = tokio::task::JoinSet::new();
        for n in ready {
            let (sql, events, id, p) = (sql.clone(), events.clone(), id.to_owned(), p.clone());
            wave.spawn(async move {
                let node = n.node_id.clone();
                let result = store::ACTOR
                    .scope(p.user.id.clone(), run_node(sql, events, id, n, p))
                    .await;
                (node, result)
            });
        }
        while let Some(result) = wave.join_next().await {
            let (node, result) = result?;
            if let Err(e) = result {
                let message: String = e.to_string().chars().take(500).collect();
                node_state(&sql.pool, events, id, &node, "failed", Some(&message)).await?;
            }
        }
    }
}
pub fn start(sql: Sql, events: Events, id: String) {
    event(&events, &id, None, "queued");
    tokio::spawn(async move {
        let (worker_sql, worker_events, worker_id) = (sql.clone(), events.clone(), id.clone());
        let task =
            tokio::spawn(async move { execute(&worker_sql, &worker_events, &worker_id).await });
        if !matches!(task.await, Ok(Ok(()))) {
            let cleanup=async{
                let nodes:Vec<String>=sqlx::query_scalar("SELECT node_id FROM pipeline_run_nodes WHERE run_id=? AND state IN ('pending','running')").bind(&id).fetch_all(&sql.pool).await?;
                for node in nodes{node_state(&sql.pool,&events,&id,&node,"failed",Some("executor interrupted")).await?;}
                finish(&sql,&events,&id,"failed",Some("pipeline execution failed")).await
            }.await;
            if let Err(e) = cleanup {
                tracing::error!(error=%e,"cannot record pipeline failure");
            }
        }
    });
}
