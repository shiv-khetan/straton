use super::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/lineage/impact", get(impact))
        .route("/v1/lineage/columns", get(columns))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    node: String,
    direction: Option<String>,
    depth: Option<usize>,
}
async fn impact(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Query(q): Query<Input>,
) -> ApiResult<Json<Value>> {
    let direction = q.direction.as_deref().unwrap_or("downstream");
    if !["downstream", "upstream", "both"].contains(&direction) {
        return Err(bad("invalid direction"));
    }
    if !q.node.starts_with("dataset:") && !q.node.starts_with("model:") {
        return Err(bad("root must be dataset:{id} or model:{id}"));
    }
    let map = filtered_map(&a.pool, &p, false).await?;
    let mut nodes = BTreeMap::<String, Value>::new();
    let mut edges = BTreeSet::<(String, String, String)>::new();
    for n in map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["type"] == "dataset")
    {
        let id = format!("dataset:{}", n["id"].as_str().unwrap());
        nodes.insert(id.clone(),json!({"id":id,"kind":"dataset","name":n["name"],"status":if n["stale"]==true{"stale"}else{"ready"}}));
    }
    for e in map["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "lineage")
    {
        edges.insert((
            format!("dataset:{}", e["from_dataset"].as_str().unwrap()),
            format!("dataset:{}", e["to_dataset"].as_str().unwrap()),
            "lineage".into(),
        ));
    }
    for r in sqlx::query("SELECT m.*,d.id AS dataset_id FROM models m JOIN datasets d ON d.source_id='straton-models' AND d.name=m.name").fetch_all(&a.pool).await?{
        let id=format!("model:{}",r.get::<&str,_>("id"));let dataset=format!("dataset:{}",r.get::<&str,_>("dataset_id"));
        if p.admin()||r.get::<&str,_>("owner_id")==p.user.id||nodes.contains_key(&dataset){
            nodes.insert(id.clone(),json!({"id":id,"kind":"model","name":r.get::<String,_>("name"),"status":r.get::<String,_>("status")}));
            edges.insert((id,dataset,"output".into()));
        }
    }
    for r in sqlx::query("SELECT * FROM model_deps")
        .fetch_all(&a.pool)
        .await?
    {
        let from = if let Some(d) = r.get::<Option<String>, _>("dataset_id") {
            format!("dataset:{d}")
        } else {
            format!("model:{}", r.get::<String, _>("upstream_model_id"))
        };
        edges.insert((
            from,
            format!("model:{}", r.get::<String, _>("model_id")),
            "dependency".into(),
        ));
    }
    for r in sqlx::query("SELECT q.*,(SELECT status FROM quality_runs WHERE check_id=q.id ORDER BY started_at DESC,rowid DESC LIMIT 1) AS status FROM quality_checks q").fetch_all(&a.pool).await?{
        if p.admin()||crate::quality::readable(&a.pool,&p,r.get("dataset_id"),r.get("model_id")).await?||r.get::<&str,_>("owner_id")==p.user.id{
            let id=format!("check:{}",r.get::<&str,_>("id"));nodes.insert(id.clone(),json!({"id":id,"kind":"check","name":r.get::<String,_>("name"),"status":r.get::<Option<String>,_>("status")}));
            if let Some(d)=r.get::<Option<String>,_>("dataset_id"){edges.insert((format!("dataset:{d}"),id.clone(),"check".into()));}
            if let Some(m)=r.get::<Option<String>,_>("model_id"){edges.insert((format!("model:{m}"),id,"check".into()));}
        }
    }
    for r in sqlx::query("SELECT p.*,(SELECT state FROM pipeline_runs WHERE pipeline_id=p.id ORDER BY rowid DESC LIMIT 1) AS status FROM pipelines p WHERE owner_id=? OR ?").bind(&p.user.id).bind(p.admin()).fetch_all(&a.pool).await?{
        let id=format!("pipeline:{}",r.get::<&str,_>("id"));nodes.insert(id.clone(),json!({"id":id,"kind":"pipeline","name":r.get::<String,_>("name"),"status":r.get::<Option<String>,_>("status")}));
        for n in sqlx::query("SELECT n.*,d.id AS dataset_id FROM pipeline_nodes n LEFT JOIN jobs j ON j.id=n.ref_id AND n.kind='sync' LEFT JOIN datasets d ON d.source_id=j.source_id AND d.name=j.dataset WHERE n.pipeline_id=?").bind(r.get::<&str,_>("id")).fetch_all(&a.pool).await?{
            let from=match n.get::<&str,_>("kind"){
                "sync"=>n.get::<Option<String>,_>("dataset_id").map(|d|format!("dataset:{d}")),
                "transform"=>Some(format!("model:{}",n.get::<&str,_>("ref_id"))),
                _=>Some(format!("check:{}",n.get::<&str,_>("ref_id"))),
            };
            if let Some(from)=from{edges.insert((from,id.clone(),"pipeline".into()));}
        }
    }
    for r in sqlx::query("SELECT * FROM charts WHERE owner_id=? OR shared=1 OR ?")
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_all(&a.pool)
        .await?
    {
        let id = format!("chart:{}", r.get::<&str, _>("id"));
        nodes.insert(
            id.clone(),
            json!({"id":id,"kind":"chart","name":r.get::<String,_>("name"),"status":"ready"}),
        );
        for d in sqlx::query("SELECT * FROM chart_deps WHERE chart_id=?")
            .bind(r.get::<&str, _>("id"))
            .fetch_all(&a.pool)
            .await?
        {
            let from = if let Some(d) = d.get::<Option<String>, _>("dataset_id") {
                format!("dataset:{d}")
            } else {
                format!("model:{}", d.get::<&str, _>("model_id"))
            };
            edges.insert((from, id.clone(), "chart".into()));
        }
    }
    for r in sqlx::query("SELECT * FROM dashboards WHERE owner_id=? OR shared=1 OR ?")
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_all(&a.pool)
        .await?
    {
        let id = format!("dashboard:{}", r.get::<&str, _>("id"));
        nodes.insert(
            id.clone(),
            json!({"id":id,"kind":"dashboard","name":r.get::<String,_>("name"),"status":"ready"}),
        );
        let layout: Value = serde_json::from_str(r.get("layout")).map_err(anyhow::Error::from)?;
        for tile in layout.as_array().unwrap() {
            if let Some(chart) = tile["chart_id"].as_str() {
                edges.insert((format!("chart:{chart}"), id.clone(), "dashboard".into()));
            }
        }
    }
    if !nodes.contains_key(&q.node) {
        return Err(ApiError(StatusCode::NOT_FOUND, "not found".into()));
    }
    edges.retain(|(from, to, _)| nodes.contains_key(from) && nodes.contains_key(to));
    let mut seen = BTreeSet::from([q.node.clone()]);
    let mut queue = VecDeque::from([(q.node.clone(), 0)]);
    let depth = q.depth.unwrap_or(50).min(50);
    while let Some((id, d)) = queue.pop_front() {
        if d >= depth {
            continue;
        }
        for (from, to, _) in &edges {
            let next = if from == &id && direction != "upstream" {
                Some(to)
            } else if to == &id && direction != "downstream" {
                Some(from)
            } else {
                None
            };
            if let Some(next) = next
                && seen.insert(next.clone())
            {
                queue.push_back((next.clone(), d + 1));
            }
        }
    }
    let nodes: Vec<_> = nodes
        .into_iter()
        .filter(|(id, _)| seen.contains(id))
        .map(|(_, n)| n)
        .collect();
    let count = |kind: &str| nodes.iter().filter(|n| n["kind"] == kind).count();
    let summary = json!({"models":count("model"),"pipelines":count("pipeline"),"checks":count("check"),"charts":count("chart"),"dashboards":count("dashboard")});
    Ok(Json(
        json!({"root":q.node,"nodes":nodes,"edges":edges.into_iter().filter(|(f,t,_)|seen.contains(f)&&seen.contains(t)).map(|(from,to,kind)|json!({"from":from,"to":to,"kind":kind})).collect::<Vec<_>>(),"summary":summary}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnInput {
    dataset: String,
    column: String,
    direction: Option<String>,
    depth: Option<usize>,
}
type FieldKey = (String, String);
fn field_key(value: &Value) -> FieldKey {
    (
        value["dataset_id"].as_str().unwrap().into(),
        value["column"].as_str().unwrap().into(),
    )
}
async fn columns(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Query(q): Query<ColumnInput>,
) -> ApiResult<Json<Value>> {
    let direction = q.direction.as_deref().unwrap_or("both");
    if !["upstream", "downstream", "both"].contains(&direction) {
        return Err(bad("invalid direction"));
    }
    let map = filtered_map(&a.pool, &p, false).await?;
    let mut fields = BTreeMap::<FieldKey, Value>::new();
    let mut masked = BTreeSet::new();
    let mut readable = BTreeSet::new();
    for dataset in map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["type"] == "dataset")
    {
        let id = dataset["id"].as_str().unwrap();
        readable.insert(id.to_owned());
        for column in dataset["columns"].as_array().unwrap() {
            let key = (id.to_owned(), column["name"].as_str().unwrap().to_owned());
            if column["masked"] == true {
                masked.insert(key.clone());
            }
            fields.insert(key, json!({"dataset_id":id,"dataset_name":dataset["display_name"],"column":column["name"],"kind":if dataset["source_id"] == "straton-models" { "model" } else if dataset["dataset_type"] == "view" { "view" } else { "column" }}));
        }
    }
    let root = (q.dataset, q.column);
    if !fields.contains_key(&root) {
        return Err(ApiError(StatusCode::NOT_FOUND, "not found".into()));
    }
    let rows = sqlx::query("SELECT * FROM column_lineage ORDER BY target_dataset_id,target_column,source_dataset_id,source_column,kind").fetch_all(&a.pool).await?;
    // Redact the entire defining entity: a second input of the same expression may be hidden.
    let mut redacted = BTreeSet::new();
    for r in &rows {
        let source = (
            r.get::<String, _>("source_dataset_id"),
            r.get::<String, _>("source_column"),
        );
        let target = (
            r.get::<String, _>("target_dataset_id"),
            r.get::<String, _>("target_column"),
        );
        if !fields.contains_key(&source)
            || !fields.contains_key(&target)
            || masked.contains(&source)
            || masked.contains(&target)
        {
            redacted.insert(r.get::<String, _>("target_dataset_id"));
        }
    }
    let mut tainted = masked;
    loop {
        let before = tainted.len();
        for r in &rows {
            let source = (
                r.get::<String, _>("source_dataset_id"),
                r.get::<String, _>("source_column"),
            );
            let target = (
                r.get::<String, _>("target_dataset_id"),
                r.get::<String, _>("target_column"),
            );
            if !fields.contains_key(&source) || tainted.contains(&source) {
                redacted.insert(target.0.clone());
                tainted.insert(target);
            }
        }
        if tainted.len() == before {
            break;
        }
    }
    let mut edges = vec![];
    let mut uses = BTreeSet::<(String, String, String, String)>::new();
    let model_names: BTreeMap<String,String> = sqlx::query("SELECT m.id,m.name,d.id AS dataset_id FROM models m JOIN datasets d ON d.source_id='straton-models' AND d.name=m.name").fetch_all(&a.pool).await?.into_iter().filter(|r|readable.contains(r.get::<&str,_>("dataset_id"))).map(|r|(r.get("id"),r.get("name"))).collect();
    for r in &rows {
        let source = (
            r.get::<String, _>("source_dataset_id"),
            r.get::<String, _>("source_column"),
        );
        let target = (
            r.get::<String, _>("target_dataset_id"),
            r.get::<String, _>("target_column"),
        );
        if !fields.contains_key(&source) || !fields.contains_key(&target) {
            continue;
        }
        let kind: &str = r.get("kind");
        let model: Option<String> = r.get("model_id");
        if ["filter", "join_key", "group_key"].contains(&kind) {
            if let Some(model) = model
                && model_names.contains_key(&model)
            {
                uses.insert((source.0, source.1, kind.into(), model));
            }
            continue;
        }
        let expression: Option<String> = if p.admin() || !redacted.contains(&target.0) {
            r.get("expression")
        } else {
            None
        };
        let via = if let Some(model) = model {
            json!({"model_id":model})
        } else {
            json!({"view_id":r.get::<Option<String>,_>("view_dataset_id")})
        };
        edges.push(json!({"from":{"dataset_id":source.0,"column":source.1},"to":{"dataset_id":target.0,"column":target.1},"kind":kind,"expression":expression,"via":via}));
    }
    edges.dedup();
    let mut seen = BTreeSet::from([root.clone()]);
    // Walk each direction independently so "both" does not pull in siblings of an ancestor.
    for upstream in [true, false] {
        if (upstream && direction == "downstream") || (!upstream && direction == "upstream") {
            continue;
        }
        let mut visited = BTreeSet::from([root.clone()]);
        let mut queue = VecDeque::from([(root.clone(), 0)]);
        while let Some((current, depth)) = queue.pop_front() {
            if depth >= q.depth.unwrap_or(50).min(50) {
                continue;
            }
            for edge in &edges {
                let (from, to) = (field_key(&edge["from"]), field_key(&edge["to"]));
                let (at, next) = if upstream { (to, from) } else { (from, to) };
                if at == current && visited.insert(next.clone()) {
                    seen.insert(next.clone());
                    queue.push_back((next, depth + 1));
                }
            }
        }
    }
    let flags: BTreeSet<String> =
        sqlx::query_scalar("SELECT id FROM datasets WHERE lineage_incomplete=1")
            .fetch_all(&a.pool)
            .await?
            .into_iter()
            .collect();
    let incomplete = seen.iter().any(|(dataset, _)| flags.contains(dataset));
    let mut usage: Vec<Value> = uses.into_iter().filter(|(d,c,_,_)|seen.contains(&(d.clone(),c.clone()))).map(|(d,c,role,id)|json!({"dataset_id":d,"column":c,"role":role,"in":{"kind":"model","id":id,"name":model_names[&id]}})).collect();
    let sql = a.sql.for_principal(p.clone());
    let _snapshot = crate::sql::SNAPSHOTS.read().await;
    let mut consumers = vec![];
    for r in sqlx::query("SELECT * FROM charts WHERE owner_id=? OR shared=1 OR ?")
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_all(&a.pool)
        .await?
    {
        consumers.push((
            "chart",
            r.get::<String, _>("id"),
            r.get::<String, _>("name"),
            r.get::<String, _>("sql"),
        ));
    }
    for r in sqlx::query("SELECT * FROM quality_checks")
        .fetch_all(&a.pool)
        .await?
    {
        if !(p.admin()
            || r.get::<&str, _>("owner_id") == p.user.id
            || crate::quality::readable(&a.pool, &p, r.get("dataset_id"), r.get("model_id"))
                .await?)
        {
            continue;
        }
        let id: String = r.get("id");
        let name: String = r.get("name");
        if r.get::<&str, _>("kind") == "custom_sql" {
            let config: Value =
                serde_json::from_str(r.get("config")).map_err(anyhow::Error::from)?;
            if let Some(text) = config["sql"].as_str() {
                consumers.push(("check", id, name, text.to_owned()));
            }
        } else if let Some(column) = r.get::<Option<String>, _>("column_name") {
            let dataset: Option<String> = match r.get::<Option<String>,_>("dataset_id") {
                Some(d) => Some(d),
                None => sqlx::query_scalar("SELECT d.id FROM datasets d JOIN models m ON m.name=d.name AND d.source_id='straton-models' WHERE m.id=?").bind(r.get::<Option<String>,_>("model_id")).fetch_optional(&a.pool).await?,
            };
            if let Some(dataset) = dataset
                && seen.contains(&(dataset.clone(), column.clone()))
            {
                usage.push(json!({"dataset_id":dataset,"column":column,"role":if r.get::<&str,_>("kind") == "unique" { "group_key" } else { "filter" },"in":{"kind":"check","id":id,"name":name}}));
            }
        }
    }
    for (kind, id, name, text) in consumers {
        match crate::models::plan(&sql, &text).await {
            Ok((_, deps)) => {
                for origin in deps.lineage.usage {
                    if seen.contains(&(origin.dataset.clone(), origin.column.clone())) {
                        usage.push(json!({"dataset_id":origin.dataset,"column":origin.column,"role":origin.kind,"in":{"kind":kind,"id":id,"name":name}}));
                    }
                }
            }
            Err(_) => { /* Unreadable consumer SQL must not reveal its dependencies. */ }
        }
    }
    usage.sort_by_key(Value::to_string);
    usage.dedup();
    Ok(Json(
        json!({"root":{"dataset_id":root.0,"column":root.1},"nodes":fields.into_iter().filter(|(k,_)|seen.contains(k)).map(|(_,v)|v).collect::<Vec<_>>(),"edges":edges.into_iter().filter(|e|seen.contains(&field_key(&e["from"])) && seen.contains(&field_key(&e["to"]))).collect::<Vec<_>>(),"usage":usage,"incomplete":incomplete}),
    ))
}
