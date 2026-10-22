use super::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(super) fn routes() -> Router<App> {
    Router::new().route("/v1/lineage/impact", get(impact))
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
