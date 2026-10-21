use super::*;
use std::{collections::BTreeMap, path::Path};

pub(super) fn routes() -> Router<App> {
    Router::new().route("/v1/storage", get(storage))
}
fn size(path: &Path) -> std::io::Result<u64> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    if meta.is_symlink() {
        return Ok(0);
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    let mut bytes = 0;
    for entry in std::fs::read_dir(path)? {
        bytes += size(&entry?.path())?;
    }
    Ok(bytes)
}
async fn storage(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    let _pin = crate::sql::SNAPSHOTS.read().await;
    let sources = sqlx::query("SELECT id,name FROM sources ORDER BY id")
        .fetch_all(&a.pool)
        .await?;
    let datasets = sqlx::query("SELECT id,source_id,name FROM datasets ORDER BY source_id,name")
        .fetch_all(&a.pool)
        .await?;
    let mut physical = BTreeMap::<(String, String), (u64, Option<String>)>::new();
    let mut entries = BTreeMap::<String, Vec<Value>>::new();
    for d in datasets {
        let source: &str = d.get("source_id");
        let name: &str = d.get("name");
        let (s, t) = if source == "straton-local-lake" {
            name.split_once('/')
                .ok_or_else(|| bad("invalid lake dataset"))?
        } else {
            (source, name)
        };
        catalog::path_component(s)?;
        catalog::path_component(t)?;
        let key = (s.to_owned(), t.to_owned());
        if !physical.contains_key(&key) {
            let dir = a.sql.data_dir.join("data").join(s).join(t);
            let snapshot = match tokio::fs::read_to_string(dir.join("_current")).await {
                Ok(run) => {
                    uuid::Uuid::try_parse(&run).map_err(|_| bad("invalid current snapshot"))?;
                    let path = dir.join(&run).canonicalize().map_err(anyhow::Error::from)?;
                    if path.parent()
                        != Some(dir.canonicalize().map_err(anyhow::Error::from)?.as_path())
                    {
                        return Err(bad("snapshot escapes dataset"));
                    }
                    (size(&path).map_err(anyhow::Error::from)?, Some(run))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (0, None),
                Err(e) => return Err(anyhow::Error::from(e).into()),
            };
            physical.insert(key.clone(), snapshot);
        }
        if !p.admin() && p.read_roles(source, d.get("id")).is_empty() {
            continue;
        }
        let schema = crate::policies::schema_frame(&a.pool, d.get("id")).await?;
        if crate::policies::effective(&a.pool, &p, source, d.get("id"), &schema)
            .await?
            .is_none()
        {
            continue;
        }
        let (bytes, snapshot) = &physical[&key];
        entries.entry(source.to_owned()).or_default().push(json!({"dataset_id":d.get::<String,_>("id"),"name":name,"bytes":bytes,"snapshot":snapshot}));
    }
    let lake_bytes: u64 = physical
        .iter()
        .filter(|((s, _), _)| s != "straton-models")
        .map(|(_, v)| v.0)
        .sum();
    let models_bytes: u64 = physical
        .iter()
        .filter(|((s, _), _)| s == "straton-models")
        .map(|(_, v)| v.0)
        .sum();
    let state_db_bytes = size(&a.sql.data_dir.join("state.db")).map_err(anyhow::Error::from)?;
    let backups_bytes = size(&a.backups.config().backup.dir).map_err(anyhow::Error::from)?;
    let sources:Vec<_>=sources.into_iter().filter_map(|s|{
        let id:String=s.get("id"); let datasets=entries.remove(&id)?;
        let bytes:u64=datasets.iter().filter_map(|d|d["bytes"].as_u64()).sum();
        Some(json!({"source_id":id,"name":s.get::<String,_>("name"),"bytes":bytes,"datasets":datasets}))
    }).collect();
    Ok(Json(
        json!({"total_bytes":state_db_bytes+backups_bytes+lake_bytes+models_bytes,"state_db_bytes":state_db_bytes,"backups_bytes":backups_bytes,"lake_bytes":lake_bytes,"models_bytes":models_bytes,"sources":sources}),
    ))
}
