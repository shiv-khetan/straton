use super::*;
pub(super) async fn metadata(source: &Mysql) -> Result<Value> {
    let datasets = source.discover_all().await?;
    let mut conn = source.connect().await?;
    let version: Option<String> = conn.query_first("SELECT VERSION()").await.map_err(error)?;
    let mut warnings = vec![];
    let mut settings = serde_json::Map::new();
    if let Ok(rows) = conn.query::<Row,_>("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size','slow_query_log')").await {
        for r in rows { settings.insert(get::<String>(&r,"Variable_name")?,json!(get::<String>(&r,"Value")?)); }
    } else { warnings.push("Server settings are unavailable"); }
    let rows: Vec<Row> = conn.exec("SELECT TABLE_NAME,ENGINE,DATA_LENGTH,INDEX_LENGTH,TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'",(&source.config.database,)).await.map_err(error)?;
    let tables = rows.iter().map(|r| Ok(json!({"schema":source.config.database,"table":get::<String>(r,"TABLE_NAME")?,"engine":get::<Option<String>>(r,"ENGINE")?,"data_bytes":get::<Option<u64>>(r,"DATA_LENGTH")?,"index_bytes":get::<Option<u64>>(r,"INDEX_LENGTH")?,"rows":get::<Option<u64>>(r,"TABLE_ROWS")?}))).collect::<Result<Vec<_>>>()?;
    let data_bytes: u64 = tables.iter().filter_map(|v| v["data_bytes"].as_u64()).sum();
    settings.insert("data_size_bytes".into(), json!(data_bytes));
    let indexes = datasets.iter().flat_map(|d| d.metadata.indexes.iter().filter(|i| i.kind.eq_ignore_ascii_case("BTREE")).map(|i| json!({"schema":source.config.database,"table":d.dataset.name.split_once('.').map(|(_,t)|t),"name":i.name,"columns":i.columns,"unique":i.unique,"primary":i.name=="PRIMARY"}))).collect::<Vec<_>>();
    Ok(
        json!({"version":version,"settings":settings,"tables":tables,"indexes":indexes,"warnings":warnings}),
    )
}
pub(super) async fn execute(source: &Mysql, ddl: &str) -> Result<()> {
    if !source.config.advisor_may_write {
        return Err(invalid("advisor writes are disabled"));
    }
    let mut conn = source.connect().await?;
    let work = async {
        conn.query_drop("SET SESSION lock_wait_timeout=5")
            .await
            .map_err(error)?;
        conn.query_drop("SET SESSION innodb_lock_wait_timeout=5")
            .await
            .map_err(error)?;
        conn.query_drop(ddl).await.map_err(error)?;
        conn.disconnect().await.map_err(error)
    };
    tokio::time::timeout(Duration::from_secs(60), work)
        .await
        .map_err(error)?
}
