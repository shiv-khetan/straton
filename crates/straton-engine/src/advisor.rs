//! Source changes are never scheduled. Each immutable recommendation needs an explicit approval.
use crate::{catalog, store};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
pub static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recommendation {
    pub kind: String,
    pub target: String,
    pub ddl: String,
    pub rollback_ddl: String,
    pub evidence: Value,
    pub estimated_benefit: f64,
    pub cost: String,
    pub risk: String,
    pub required_permission: String,
    pub applicable: bool,
}
#[derive(Clone, Debug)]
pub struct Index {
    pub name: String,
    pub columns: Vec<String>,
    pub protected: bool,
}
#[derive(Clone, Debug)]
pub struct Workload {
    pub column: String,
    pub role: String,
    pub op: String,
    pub count: i64,
    pub scanned: i64,
}
#[derive(Clone, Debug)]
pub struct Table {
    pub name: String,
    pub columns: Vec<String>,
    pub indexes: Vec<Index>,
    pub workload: Vec<Workload>,
}
fn ident(kind: &str, name: &str) -> String {
    if kind == "mysql" {
        format!("`{}`", name.replace('`', "``"))
    } else if kind == "sqlserver" {
        format!("[{}]", name.replace(']', "]]"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}
fn object(kind: &str, name: &str) -> String {
    if kind == "mongodb" {
        return name.into();
    }
    let (s, t) = name
        .split_once('.')
        .unwrap_or((if kind == "sqlserver" { "dbo" } else { "public" }, name));
    format!("{}.{}", ident(kind, s), ident(kind, t))
}
fn list(kind: &str, columns: &[String]) -> String {
    columns
        .iter()
        .map(|c| ident(kind, c))
        .collect::<Vec<_>>()
        .join(", ")
}
fn rows(value: &Value, key: &str) -> Vec<Value> {
    value[key].as_array().cloned().unwrap_or_default()
}
fn names(v: &Value, key: &str) -> Vec<String> {
    rows(v, key)
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}
fn matches_table(v: &Value, t: &Table) -> bool {
    if v["schema"].is_null() {
        return v["table"] == t.name;
    }
    format!(
        "{}.{}",
        v["schema"].as_str().unwrap_or(""),
        v["table"].as_str().unwrap_or("")
    ) == t.name
}
pub fn config_hash(kind: &str, config: &Value) -> String {
    let mut c = config.clone();
    if let Some(c) = c.as_object_mut() {
        c.remove("advisor_may_write");
    }
    format!("{:x}", Sha256::digest(format!("{kind}:{c}").as_bytes()))
}
pub fn generate(kind: &str, t: &Table, metadata: &Value) -> Vec<Recommendation> {
    if kind == "mysql" || kind == "mongodb" {
        return generate_document_and_mysql(kind, t, metadata);
    }
    let mut t = t.clone();
    let source_indexes: Vec<_> = rows(metadata, "indexes")
        .into_iter()
        .filter(|v| matches_table(v, &t))
        .collect();
    for index in source_indexes {
        let columns = names(&index, "columns");
        if index["filtered"] != true
            && !columns.is_empty()
            && !t.indexes.iter().any(|i| index["name"] == i.name)
        {
            t.indexes.push(Index {
                name: index["name"].as_str().unwrap_or_default().into(),
                columns,
                protected: index["unique"] == true || index["primary"] == true,
            });
        }
    }
    let t = &t;
    let target = object(kind, &t.name);
    let mut out = vec![];
    let mut proposed = std::collections::BTreeSet::new();
    let mut candidates = vec![];
    for missing in rows(metadata, "missing_indexes")
        .into_iter()
        .filter(|m| matches_table(m, t))
    {
        let mut keys = names(&missing, "equality_columns");
        keys.extend(names(&missing, "range_columns"));
        let includes = names(&missing, "include_columns");
        let benefit = (missing["user_seeks"].as_f64().unwrap_or(0.)
            + missing["user_scans"].as_f64().unwrap_or(0.))
            * missing["avg_total_user_cost"].as_f64().unwrap_or(0.)
            * missing["avg_user_impact"].as_f64().unwrap_or(0.)
            / 100.;
        candidates.push((keys, includes, json!({"missing_index":missing}), benefit));
    }
    for w in &t.workload {
        if w.count >= 5
            && (w.role == "join_key"
                || (w.role == "filter" && ["equality", "range"].contains(&w.op.as_str())))
        {
            let source_columns = rows(metadata, "columns")
                .into_iter()
                .filter(|v| matches_table(v, t) && v["column"] == w.column)
                .collect::<Vec<_>>();
            let source_table = rows(metadata, "tables")
                .into_iter()
                .find(|v| matches_table(v, t));
            candidates.push((vec![w.column.clone()],vec![],json!({"observations":w.count,"rows_scanned":w.scanned,"role":w.role,"op":w.op,"source_columns":source_columns,"source_table":source_table}),w.scanned as f64*(w.count as f64).ln_1p()));
        }
    }
    for (keys, includes, evidence, benefit) in candidates {
        if keys.is_empty()
            || keys.len() > 8
            || keys.iter().any(|c| !t.columns.contains(c))
            || !proposed.insert(keys.clone())
            || t.indexes.iter().any(|i| i.columns.starts_with(&keys))
        {
            continue;
        }
        let includes: Vec<_> = includes
            .into_iter()
            .filter(|c| t.columns.contains(c) && !keys.contains(c))
            .take(8)
            .collect();
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("{}:{keys:?}:{includes:?}", t.name).as_bytes())
        );
        let name = format!("ix_straton_{}", &hash[..16]);
        let index = ident(kind, &name);
        let include = if includes.is_empty() {
            String::new()
        } else {
            format!(" INCLUDE ({})", list(kind, &includes))
        };
        let predicate = if keys.len() == 1
            && rows(metadata, "columns").iter().any(|v| {
                matches_table(v, t)
                    && v["column"] == keys[0]
                    && v["null_fraction"].as_f64().unwrap_or(0.) >= 0.5
            }) {
            format!(" WHERE {} IS NOT NULL", ident(kind, &keys[0]))
        } else {
            String::new()
        };
        let online = kind == "sqlserver" && metadata["online"] == true;
        let ddl = if kind == "sqlserver" {
            format!(
                "CREATE INDEX {index} ON {target} ({}){include}{predicate}{};",
                list(kind, &keys),
                if online { " WITH (ONLINE = ON)" } else { "" }
            )
        } else {
            format!(
                "CREATE INDEX CONCURRENTLY {index} ON {target} ({}){include}{predicate};",
                list(kind, &keys)
            )
        };
        let rollback = if kind == "sqlserver" {
            format!("DROP INDEX {index} ON {target};")
        } else {
            let (schema, _) = t.name.split_once('.').unwrap_or(("public", &t.name));
            format!("DROP INDEX CONCURRENTLY {}.{index};", ident(kind, schema))
        };
        out.push(Recommendation{kind:"create_index".into(),target:target.clone(),ddl,rollback_ddl:rollback,evidence,estimated_benefit:benefit.clamp(0.,1e15),cost:format!("One B-tree entry per row across {} key and {} included columns; additional work on every insert, update and delete. Bytes depend on actual column widths.",keys.len(),includes.len()),risk:format!("Benefit is a relative workload score, not a latency guarantee. Source workload may differ from lake reads. Build needs disk, log space and schema locks. {} Check key types and width limits before approval. Timed-out concurrent builds can require manual cleanup.",if online || kind=="postgres"{"Online operation still takes brief locks."}else{"This edition uses an offline build and may block writers."}),required_permission:if kind=="sqlserver"{"ALTER on the target table"}else{"Table ownership and CREATE on its schema"}.into(),applicable:true});
    }
    for (index, n) in t.indexes.iter().zip(0..) {
        if index.protected
            || index.columns.is_empty()
            || !t.indexes[..n].iter().any(|i| i.columns == index.columns)
        {
            continue;
        }
        let usage = rows(metadata, "indexes").into_iter().find(|v| {
            matches_table(v, t) && v["name"] == index.name && v["reads"].as_f64() == Some(0.)
        });
        if let Some(usage) = usage {
            out.push(Recommendation{kind:"drop_unused_duplicate_index".into(),target:target.clone(),ddl:if kind=="sqlserver"{format!("DROP INDEX {} ON {target};",ident(kind,&index.name))}else{let(s,_)=t.name.split_once('.').unwrap_or(("public",&t.name));format!("DROP INDEX CONCURRENTLY {}.{};",ident(kind,s),ident(kind,&index.name))},rollback_ddl:format!("CREATE INDEX {} ON {target} ({});",ident(kind,&index.name),list(kind,&index.columns)),evidence:usage,estimated_benefit:0.,cost:"May reduce write work and storage; validate a full workload cycle first.".into(),risk:"Flag only. Usage counters reset on restart and catalog key lists omit predicates, includes and options. Have a DBA capture the complete definition and confirm dependencies before removal.".into(),required_permission:"DBA review; table ownership or ALTER".into(),applicable:false});
        }
    }
    if let Some(stats) = rows(metadata, "tables").into_iter().find(|v| {
        matches_table(v, t)
            && v["modifications"].as_f64().unwrap_or(0.) > 500.
            && v["modifications"].as_f64().unwrap_or(0.) > v["rows"].as_f64().unwrap_or(0.) * 0.2
    }) {
        out.push(Recommendation{kind:"statistics_update".into(),target:target.clone(),ddl:if kind=="sqlserver"{format!("UPDATE STATISTICS {target};")}else{format!("ANALYZE {target};")},rollback_ddl:"-- Previous statistics cannot be restored through portable SQL. DBA review required.".into(),evidence:stats,estimated_benefit:1.,cost:"Reads a sample of the table and changes source query plans.".into(),risk:"Advice only: statistics refresh has no safe automatic rollback. Schedule with a DBA and verify source plans.".into(),required_permission:if kind=="sqlserver"{"ALTER on the target table"}else{"Table owner or MAINTAIN privilege"}.into(),applicable:false});
    }
    out
}
pub async fn refresh(pool: &SqlitePool, source: &str) -> Result<Value> {
    let _gate = GATE.lock().await;
    let s = sqlx::query(
        "SELECT kind,config FROM sources WHERE id=? AND kind IN ('sqlserver','postgres','mysql','mongodb')",
    )
    .bind(source)
    .fetch_one(pool)
    .await?;
    let kind: &str = s.get("kind");
    let config: Value = serde_json::from_str(s.get("config"))?;
    let fingerprint = config_hash(kind, &config);
    let connector = catalog::connector(pool, source).await?;
    let metadata = match connector.advisor_metadata().await {
        Ok(v) => v,
        Err(_) => {
            json!({"warnings":["Source metadata is unavailable; recommendations use local workload and catalog indexes only."]})
        }
    };
    let datasets = sqlx::query(
        "SELECT id,name FROM datasets WHERE source_id=? AND stale=0 AND dataset_type='table'",
    )
    .bind(source)
    .fetch_all(pool)
    .await?;
    let mut recommendations = vec![];
    for d in datasets {
        let id: String = d.get("id");
        let name: String = d.get("name");
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM columns WHERE dataset_id=?")
                .bind(&id)
                .fetch_all(pool)
                .await?;
        let indexes = sqlx::query("SELECT * FROM dataset_indexes WHERE dataset_id=? ORDER BY name")
            .bind(&id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .filter(|r| match kind {
                "mysql" => r.get::<&str, _>("kind").eq_ignore_ascii_case("BTREE"),
                "mongodb" => r.get::<&str, _>("kind") == "btree",
                _ => true,
            })
            .map(|r| Index {
                name: r.get("name"),
                columns: serde_json::from_str(r.get("columns")).unwrap_or_default(),
                protected: r.get::<bool, _>("unique")
                    || r.get::<bool, _>("clustered")
                    || r.get::<bool, _>("unique_constraint"),
            })
            .collect();
        let workload=sqlx::query("SELECT q.column,q.role,q.op,SUM(q.count) AS n,SUM(q.rows_scanned) AS scanned FROM query_stats q JOIN datasets d ON d.id=q.dataset_id WHERE d.id=?1 OR (d.source_id='straton-local-lake' AND d.name=?2) GROUP BY q.column,q.role,q.op").bind(&id).bind(format!("{source}/{name}")).fetch_all(pool).await?.into_iter().map(|r|Workload{column:r.get("column"),role:r.get("role"),op:r.get("op"),count:r.get("n"),scanned:r.get("scanned")}).collect();
        let t = Table {
            name,
            columns,
            indexes,
            workload,
        };
        recommendations.extend(
            generate(kind, &t, &metadata)
                .into_iter()
                .map(|r| (Some(id.clone()), r)),
        );
    }
    if let Some(settings) = metadata["settings"].as_object() {
        for (key, current) in settings {
            recommendations.push((None,Recommendation{kind:"setting_review".into(),target:format!("database setting: {key}"),ddl:format!("-- Review {key} with the DBA; no automatic setting change is proposed."),rollback_ddl:"-- No setting change is proposed.".into(),evidence:json!({"setting":key,"current_value":current}),estimated_benefit:0.,cost:"Depends on concurrency, memory, storage and the source workload.".into(),risk:match key.as_str(){"work_mem"=>"Memory is allocated per operation and worker; measure concurrency before increasing.","random_page_cost"=>"Calibrate to the actual storage; a lower value can change all query plans.","compatibility_level"=>"Changing compatibility can alter cardinality estimation and existing plans; test a replay first.","innodb_buffer_pool_size"=>"Compare the buffer pool with data_size_bytes and available memory; leave room for connections and the OS.","data_size_bytes"=>"Compare estimated InnoDB data size with the buffer pool and measured cache misses.","slow_query_log"=>"Enable only after reviewing disk space, retention and sensitive query literals.","was"|"slowms"|"sampleRate"=>"Review profiler overhead, slow query thresholds and retention with the database admin.","auto_update_statistics_async"=>"Asynchronous updates can avoid compile waits but temporarily use stale statistics.",_=>"Review Query Store capture, retention and disk limits with the DBA."}.into(),required_permission:"DBA review / ALTER DATABASE or server configuration privilege".into(),applicable:false}));
        }
    }
    let mut tx = pool.begin().await?;
    let mut count = 0;
    for (dataset, mut r) in recommendations {
        if let Some(evidence) = r.evidence.as_object_mut() {
            evidence.insert("metadata_warnings".into(), metadata["warnings"].clone());
        }
        let signature = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{}:{}:{}:{}:{}",
                    fingerprint, r.kind, r.target, r.ddl, r.rollback_ddl
                )
                .as_bytes()
            )
        );
        sqlx::query("INSERT INTO advisor_recommendations(id,source_id,dataset_id,target,kind,fingerprint,ddl,rollback_ddl,evidence,estimated_benefit,cost,risk,required_permission,applicable,source_config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,fingerprint) DO UPDATE SET evidence=excluded.evidence,estimated_benefit=excluded.estimated_benefit,updated_at=excluded.updated_at WHERE advisor_recommendations.status='open'")
   .bind(store::id()).bind(source).bind(dataset).bind(r.target).bind(r.kind).bind(signature).bind(r.ddl).bind(r.rollback_ddl).bind(r.evidence.to_string()).bind(r.estimated_benefit).bind(r.cost).bind(r.risk).bind(r.required_permission).bind(r.applicable).bind(&fingerprint).bind(store::now()).bind(store::now()).execute(&mut *tx).await?;
        count += 1;
    }
    store::audit(
        &mut tx,
        "advisor.refresh",
        source,
        &json!({"recommendations":count,"metadata_warnings":metadata["warnings"]}).to_string(),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"recommendations":count,"warnings":metadata["warnings"]}))
}
pub fn value(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"source_id":r.get::<String,_>("source_id"),"dataset_id":r.get::<Option<String>,_>("dataset_id"),"target":r.get::<String,_>("target"),"kind":r.get::<String,_>("kind"),"ddl":r.get::<String,_>("ddl"),"rollback_ddl":r.get::<String,_>("rollback_ddl"),"evidence":serde_json::from_str::<Value>(r.get("evidence")).unwrap_or(Value::Null),"estimated_benefit":r.get::<f64,_>("estimated_benefit"),"cost":r.get::<String,_>("cost"),"risk":r.get::<String,_>("risk"),"required_permission":r.get::<String,_>("required_permission"),"applicable":r.get::<bool,_>("applicable"),"approval_token":r.get::<String,_>("source_config"),"status":r.get::<String,_>("status"),"applied_by":r.get::<Option<String>,_>("applied_by"),"applied_at":r.get::<Option<i64>,_>("applied_at"),"error":r.get::<Option<String>,_>("error")})
}
pub async fn recover(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM advisor_recommendations WHERE status='applying'")
            .fetch_all(&mut *tx)
            .await?;
    for id in ids {
        sqlx::query("UPDATE advisor_recommendations SET status='failed',error='Engine restarted during the source operation. Outcome is uncertain; inspect the source before making another change.',updated_at=? WHERE id=?").bind(store::now()).bind(&id).execute(&mut *tx).await?;
        store::audit(
            &mut tx,
            "advisor.interrupted",
            &id,
            "outcome uncertain; manual source inspection required",
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn execute(pool: &SqlitePool, id: &str, actor: &str, rollback: bool) -> Result<Value> {
    execute_with(pool, id, actor, rollback, |source, ddl| async move {
        let connector = catalog::connector(pool, &source).await?;
        connector
            .advisor_execute(&ddl)
            .await
            .map_err(anyhow::Error::from)
    })
    .await
}
pub(crate) async fn execute_with<F, Fut>(
    pool: &SqlitePool,
    id: &str,
    actor: &str,
    rollback: bool,
    execute: F,
) -> Result<Value>
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let _gate = GATE.lock().await;
    let mut tx = pool.begin().await?;
    let r=sqlx::query("SELECT r.*,s.config,s.kind AS source_kind FROM advisor_recommendations r JOIN sources s ON s.id=r.source_id WHERE r.id=?").bind(id).fetch_one(&mut *tx).await?;
    let config: Value = serde_json::from_str(r.get("config"))?;
    anyhow::ensure!(
        config["advisor_may_write"] == true,
        "advisor writes are disabled"
    );
    anyhow::ensure!(
        r.get::<&str, _>("source_config") == config_hash(r.get("source_kind"), &config),
        "source configuration changed; refresh and review recommendations"
    );
    let status: &str = r.get("status");
    anyhow::ensure!(
        if rollback {
            status == "applied"
                || (status == "failed" && r.get::<Option<i64>, _>("applied_at").is_some())
        } else {
            status == "open" && r.get::<bool, _>("applicable")
        },
        "recommendation is not eligible for this action"
    );
    let source: String = r.get("source_id");
    let ddl: String = r.get(if rollback { "rollback_ddl" } else { "ddl" });
    anyhow::ensure!(
        !ddl.trim().is_empty() && !ddl.trim_start().starts_with("--"),
        "no reversible DDL is available"
    );
    sqlx::query(
        "UPDATE advisor_recommendations SET status='applying',error=NULL,updated_at=? WHERE id=?",
    )
    .bind(store::now())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let detail = json!({"source_id":source,"target":r.get::<String,_>("target"),"rollback_hash":format!("{:x}",Sha256::digest(r.get::<&str,_>("rollback_ddl").as_bytes())),"operation":if rollback{"rollback"}else{"apply"},"ddl_hash":format!("{:x}",Sha256::digest(ddl.as_bytes()))});
    store::audit_as(
        &mut tx,
        if rollback {
            "advisor.rollback.started"
        } else {
            "advisor.apply.started"
        },
        id,
        &detail.to_string(),
        Some(actor),
    )
    .await?;
    tx.commit().await?;
    let result = execute(source.clone(), ddl).await;
    let success = result.is_ok();
    // Never persist or log a driver error: it can contain credentials or literal values.
    let error=(!success).then_some("Source operation failed or timed out. Inspect the source before any further change; outcome may be uncertain.");
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE advisor_recommendations SET status=?,applied_by=CASE WHEN ? AND NOT ? THEN ? ELSE applied_by END,applied_at=CASE WHEN ? AND NOT ? THEN ? ELSE applied_at END,error=?,updated_at=? WHERE id=?")
 .bind(if success{if rollback{"rolled_back"}else{"applied"}}else{"failed"}).bind(success).bind(rollback).bind(actor).bind(success).bind(rollback).bind(store::now()).bind(error).bind(store::now()).bind(id).execute(&mut *tx).await?;
    store::audit_as(
        &mut tx,
        if rollback {
            "advisor.rollback"
        } else {
            "advisor.apply"
        },
        id,
        &json!({"source_id":source,"success":success}).to_string(),
        Some(actor),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"ok":success,"error":error}))
}

fn generate_document_and_mysql(kind: &str, t: &Table, metadata: &Value) -> Vec<Recommendation> {
    let mut indexes = t.indexes.clone();
    for i in rows(metadata, "indexes")
        .iter()
        .filter(|i| matches_table(i, t))
    {
        if i["filtered"] != true {
            indexes.push(Index {
                name: i["name"].as_str().unwrap_or_default().into(),
                columns: names(i, "columns"),
                protected: i["unique"] == true || i["primary"] == true,
            });
        }
    }
    let target = object(kind, &t.name);
    let mut proposed = std::collections::BTreeSet::new();
    let mut out = vec![];
    for w in &t.workload {
        if w.count < 5
            || !(w.role == "join_key"
                || w.role == "filter" && ["equality", "range"].contains(&w.op.as_str()))
            || !t.columns.contains(&w.column)
            || !proposed.insert(w.column.clone())
            || indexes.iter().any(|i| i.columns.first() == Some(&w.column))
        {
            continue;
        }
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("{}:{}", t.name, w.column).as_bytes())
        );
        let name = format!("ix_straton_{}", &hash[..16]);
        let (ddl, rollback, permission, online) = if kind == "mongodb" {
            let key = serde_json::Map::from_iter([(w.column.clone(), json!(1))]);
            (
                json!({"createIndexes":t.name,"indexes":[{"key":key,"name":name}]}).to_string(),
                json!({"dropIndexes":t.name,"index":name}).to_string(),
                "createIndex and dropIndex on the collection",
                true,
            )
        } else {
            let version = metadata["version"].as_str().unwrap_or_default();
            let numbers = version
                .split('.')
                .take(2)
                .map(|s| s.parse::<u32>().unwrap_or(0))
                .collect::<Vec<_>>();
            let supported = if version.contains("MariaDB") {
                numbers.first().copied().unwrap_or(0) >= 10
            } else {
                numbers.first().copied().unwrap_or(0) > 5
                    || numbers.first() == Some(&5) && numbers.get(1).copied().unwrap_or(0) >= 6
            };
            let online = supported
                && rows(metadata, "tables").iter().any(|v| {
                    matches_table(v, t)
                        && v["engine"]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case("InnoDB"))
                });
            (
                format!(
                    "CREATE INDEX {} ON {target} ({}){};",
                    ident(kind, &name),
                    ident(kind, &w.column),
                    if online {
                        " ALGORITHM=INPLACE LOCK=NONE"
                    } else {
                        ""
                    }
                ),
                format!("DROP INDEX {} ON {target};", ident(kind, &name)),
                "INDEX on the target table",
                online,
            )
        };
        out.push(Recommendation { kind:"create_index".into(), target:target.clone(), ddl, rollback_ddl:rollback, evidence:json!({"observations":w.count,"rows_scanned":w.scanned,"role":w.role,"op":w.op,"source_table":rows(metadata,"tables").into_iter().find(|v|matches_table(v,t))}), estimated_benefit:(w.scanned as f64*(w.count as f64).ln_1p()).clamp(0.,1e15), cost:"Adds index storage and work on inserts, updates and deletes.".into(), risk:format!("Source workload may differ from lake queries. Verify field types and key widths before approval. {} A timed-out build may require manual inspection.",if online { "Builds still need disk space and brief locks." } else { "This server or storage engine may block writers during the build." }), required_permission:permission.into(), applicable:true });
    }
    out
}
