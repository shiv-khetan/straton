use crate::{credentials, store};
use anyhow::{Result, ensure};
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use straton_core::{DatasetSchema, Relationship};
pub async fn connector(pool: &SqlitePool, id: &str) -> Result<Box<dyn straton_core::Connector>> {
    let row = sqlx::query("SELECT kind,config,credential_id FROM sources WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let secret = if row.get::<Option<String>, _>("credential_id").is_some() {
        credentials::get(id)?
    } else {
        None
    };
    Ok(straton_connectors::build(
        row.get("kind"),
        &serde_json::from_str::<Value>(row.get("config"))?,
        secret.as_ref().map(|s| s.expose_secret()),
    )?)
}
pub async fn edge(tx: &mut Transaction<'_, Sqlite>, r: &Relationship) -> Result<()> {
    sqlx::query("INSERT INTO relationships(id,from_dataset,from_cols,to_dataset,to_cols,kind,confidence) VALUES(?,?,?,?,?,?,?)")
.bind(if r.id.is_empty(){store::id()}else{r.id.clone()}).bind(&r.from_dataset).bind(serde_json::to_string(&r.from_cols)?).bind(&r.to_dataset).bind(serde_json::to_string(&r.to_cols)?).bind(serde_json::to_value(&r.kind)?.as_str().unwrap()).bind(r.confidence).execute(&mut **tx).await?;
    Ok(())
}
pub async fn upsert(
    tx: &mut Transaction<'_, Sqlite>,
    source: &str,
    ds: &DatasetSchema,
) -> Result<String> {
    anyhow::ensure!(
        !ds.columns.iter().any(|c| c.name.starts_with("_straton_")),
        "column names starting with _straton_ are reserved"
    );
    let id:String=sqlx::query_scalar("INSERT INTO datasets(id,source_id,name) VALUES(?,?,?) ON CONFLICT(source_id,name) DO UPDATE SET name=excluded.name,stale=0 RETURNING id").bind(store::id()).bind(source).bind(&ds.dataset.name).fetch_one(&mut **tx).await?;
    sqlx::query(
        "UPDATE datasets SET dataset_type=?,definition=?,approximate_row_count=? WHERE id=?",
    )
    .bind(if ds.metadata.is_view { "view" } else { "table" })
    .bind(&ds.metadata.definition)
    .bind(ds.metadata.approximate_rows)
    .bind(&id)
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM dataset_indexes WHERE dataset_id=?")
        .bind(&id)
        .execute(&mut **tx)
        .await?;
    for index in &ds.metadata.indexes {
        sqlx::query("INSERT INTO dataset_indexes(dataset_id,name,columns,\"unique\",clustered,kind,unique_constraint) VALUES(?,?,?,?,?,?,?)")
            .bind(&id).bind(&index.name).bind(serde_json::to_string(&index.columns)?)
            .bind(index.unique).bind(index.clustered).bind(&index.kind).bind(index.unique_constraint)
            .execute(&mut **tx).await?;
    }
    for c in &ds.columns {
        sqlx::query("INSERT INTO columns(id,dataset_id,name,data_type,nullable,primary_key) VALUES(?,?,?,?,?,?) ON CONFLICT(dataset_id,name) DO UPDATE SET data_type=excluded.data_type,nullable=excluded.nullable,primary_key=excluded.primary_key").bind(store::id()).bind(&id).bind(&c.name).bind(&c.data_type).bind(c.nullable).bind(c.primary_key).execute(&mut **tx).await?;
    }
    let names: Vec<_> = ds.columns.iter().map(|c| c.name.clone()).collect();
    sqlx::query(
        "DELETE FROM columns WHERE dataset_id=? AND name NOT IN (SELECT value FROM json_each(?))",
    )
    .bind(&id)
    .bind(serde_json::to_string(&names)?)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}
pub async fn discover(pool: &SqlitePool, id: &str) -> Result<()> {
    let connector = connector(pool, id).await?;
    let schemas = connector.discover().await?;
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM relationships WHERE (kind='declared_fk' AND from_dataset IN(SELECT id FROM datasets WHERE source_id=?1)) OR (kind='lineage' AND to_dataset IN(SELECT id FROM datasets WHERE source_id=?1 AND dataset_type='view'))").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM relationships WHERE kind='inferred'")
        .execute(&mut *tx)
        .await?;
    let mut ids = std::collections::HashMap::new();
    for ds in &schemas {
        ids.insert(ds.dataset.name.clone(), upsert(&mut tx, id, ds).await?);
    }
    let old = sqlx::query("SELECT id,name FROM datasets WHERE source_id=?")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    for row in old {
        let name: String = row.get("name");
        if ids.contains_key(&name) {
            continue;
        }
        let did: String = row.get("id");
        sqlx::query(
            "DELETE FROM relationships WHERE kind!='manual' AND (from_dataset=?1 OR to_dataset=?1)",
        )
        .bind(&did)
        .execute(&mut *tx)
        .await?;
        let manual: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM relationships WHERE kind='manual' AND (from_dataset=?1 OR to_dataset=?1))")
            .bind(&did).fetch_one(&mut *tx).await?;
        if manual {
            let marked = sqlx::query("UPDATE datasets SET stale=1 WHERE id=? AND stale=0")
                .bind(&did)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if marked != 0 {
                store::audit(&mut tx, "dataset.stale", &did, "absent from discovery").await?;
            }
            continue;
        }
        sqlx::query("DELETE FROM columns WHERE dataset_id=?")
            .bind(&did)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM datasets WHERE id=?")
            .bind(&did)
            .execute(&mut *tx)
            .await?;
    }
    for ds in &schemas {
        for r in &ds.relationships {
            if let (Some(from), Some(to)) = (ids.get(&r.from_dataset), ids.get(&r.to_dataset)) {
                let mut r = r.clone();
                r.from_dataset = from.clone();
                r.to_dataset = to.clone();
                edge(&mut tx, &r).await?;
            }
        }
    }
    infer(&mut tx).await?;
    store::audit(&mut tx, "source.discovered", id, "").await?;
    tx.commit().await?;
    Ok(())
}
fn compatible(a: &str, b: &str) -> bool {
    a == b || (["Int16", "Int32", "Int64"].contains(&a) && ["Int16", "Int32", "Int64"].contains(&b))
}
pub async fn infer(tx: &mut Transaction<'_, Sqlite>) -> Result<()> {
    sqlx::query("DELETE FROM relationships WHERE kind='inferred'")
        .execute(&mut **tx)
        .await?;
    let cols=sqlx::query("SELECT c.*,d.source_id,d.name AS dataset_name FROM columns c JOIN datasets d ON d.id=c.dataset_id WHERE d.stale=0").fetch_all(&mut **tx).await?;
    let declared = sqlx::query("SELECT * FROM relationships WHERE kind='declared_fk'")
        .fetch_all(&mut **tx)
        .await?;
    for c in &cols {
        let name = c.get::<String, _>("name").to_lowercase();
        let Some(stem) = name.strip_suffix("_id").or_else(|| name.strip_suffix("id")) else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        for target in &cols {
            if !target.get::<bool, _>("primary_key")
                || !target.get::<String, _>("name").eq_ignore_ascii_case("id")
            {
                continue;
            }
            let from: &str = c.get("dataset_id");
            let to: &str = target.get("dataset_id");
            let target_name = target
                .get::<String, _>("dataset_name")
                .rsplit('.')
                .next()
                .unwrap()
                .to_lowercase();
            if target_name != stem && target_name != format!("{stem}s") {
                continue;
            }
            if cols
                .iter()
                .filter(|x| x.get::<&str, _>("dataset_id") == to && x.get::<bool, _>("primary_key"))
                .count()
                != 1
                || !compatible(c.get("data_type"), target.get("data_type"))
            {
                continue;
            }
            let cname: &str = c.get("name");
            if declared.iter().any(|r| {
                r.get::<&str, _>("from_dataset") == from
                    && r.get::<&str, _>("to_dataset") == to
                    && serde_json::from_str::<Vec<String>>(r.get("from_cols"))
                        .is_ok_and(|v| v.iter().any(|x| x == cname))
            }) {
                continue;
            }
            edge(
                tx,
                &Relationship {
                    id: String::new(),
                    from_dataset: from.into(),
                    from_cols: vec![cname.into()],
                    to_dataset: to.into(),
                    to_cols: vec![target.get::<String, _>("name")],
                    kind: straton_core::RelationshipKind::Inferred,
                    confidence: Some(
                        if c.get::<&str, _>("source_id") == target.get::<&str, _>("source_id") {
                            0.9
                        } else {
                            0.6
                        },
                    ),
                },
            )
            .await?;
        }
    }
    Ok(())
}
pub async fn datamap(pool: &SqlitePool) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let sources = sqlx::query("SELECT id,name,kind FROM sources ORDER BY id")
        .fetch_all(&mut *tx)
        .await?;
    let datasets = sqlx::query("SELECT * FROM datasets ORDER BY id")
        .fetch_all(&mut *tx)
        .await?;
    let cols = sqlx::query("SELECT * FROM columns ORDER BY rowid")
        .fetch_all(&mut *tx)
        .await?;
    let edges = sqlx::query("SELECT * FROM relationships ORDER BY id")
        .fetch_all(&mut *tx)
        .await?;
    let mut nodes:Vec<Value>=sources.iter().map(|r|json!({"type":"source","id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"connected":r.get::<&str,_>("kind")!="external"})).collect();
    let (schema_names, table_names) = crate::sql::catalog_names(&sources, &datasets);
    for d in datasets {
        let id: &str = d.get("id");
        let name: &str = d.get("name");
        // Lake names are stable storage keys; resolve their labels from the current source name.
        let display_name = if d.get::<&str, _>("source_id") == "straton-local-lake" {
            name.split_once('/').and_then(|(source, dataset)| {
                sources
                    .iter()
                    .find(|s| s.get::<&str, _>("id") == source)
                    .map(|s| format!("{}.{dataset}", s.get::<&str, _>("name")))
            })
        } else {
            None
        }
        .unwrap_or_else(|| name.to_owned());
        let columns:Vec<_>=cols.iter().filter(|c|c.get::<&str,_>("dataset_id")==id).map(|c|json!({"name":c.get::<String,_>("name"),"type":c.get::<String,_>("data_type"),"nullable":c.get::<bool,_>("nullable"),"pk":c.get::<bool,_>("primary_key")})).collect();
        nodes.push(json!({"type":"dataset","id":id,"source_id":d.get::<String,_>("source_id"),"name":name,"display_name":display_name,"dataset_type":d.get::<String,_>("dataset_type"),"definition":d.get::<Option<String>,_>("definition"),"approximate_row_count":d.get::<Option<i64>,_>("approximate_row_count"),"stale":d.get::<bool,_>("stale"),"row_count":d.get::<Option<i64>,_>("row_count"),"last_synced_at":d.get::<Option<String>,_>("last_synced_at"),"sql_schema":schema_names[d.get::<&str,_>("source_id")],"sql_table":table_names[id],"columns":columns}));
    }
    let edges:Result<Vec<_>>=edges.iter().map(|r|Ok(json!({"id":r.get::<String,_>("id"),"kind":r.get::<String,_>("kind"),"from_dataset":r.get::<String,_>("from_dataset"),"from_cols":serde_json::from_str::<Value>(r.get("from_cols"))?,"to_dataset":r.get::<String,_>("to_dataset"),"to_cols":serde_json::from_str::<Value>(r.get("to_cols"))?,"confidence":r.get::<Option<f64>,_>("confidence")}))).collect();
    tx.commit().await?;
    Ok(json!({"nodes":nodes,"edges":edges?}))
}
pub fn path_component(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty()
            && s != "."
            && s != ".."
            && !s.chars().any(|c| c < ' ' || "/\\:<>\"|?*".contains(c))
            && !s.ends_with(['.', ' ']),
        "invalid filesystem component"
    );
    Ok(())
}
