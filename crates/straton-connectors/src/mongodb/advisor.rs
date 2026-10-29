use super::*;
pub(super) async fn metadata(source: &Mongo) -> Result<Value> {
    let samples = source.samples().await?;
    let indexes = samples.iter().flat_map(|s| s.schema.metadata.indexes.iter().filter(|i| i.kind == "btree").map(|i| json!({"table":s.schema.dataset.name,"name":i.name,"columns":i.columns,"unique":i.unique,"primary":i.name=="_id_"}))).collect::<Vec<_>>();
    let db = source.client().await?.database(&source.config.database);
    let mut settings = serde_json::Map::new();
    let mut warnings = vec![];
    match db.run_command(doc! {"profile":-1}).await {
        Ok(d) => {
            for key in ["was", "slowms", "sampleRate"] {
                if let Some(v) = d.get(key) {
                    settings.insert(key.into(), serde_json::to_value(v).map_err(error)?);
                }
            }
        }
        Err(_) => warnings.push("Profiler settings are unavailable"),
    }
    Ok(json!({"indexes":indexes,"settings":settings,"warnings":warnings}))
}
pub(super) fn command(ddl: &str) -> Result<Document> {
    let command: Document =
        serde_json::from_str(ddl).map_err(|_| invalid("invalid advisor index command"))?;
    if command.contains_key("createIndexes") {
        if command.len() != 2 || !command.contains_key("indexes") {
            return Err(invalid("only index commands are allowed"));
        }
        let collection = command.get_str("createIndexes").map_err(error)?;
        if collection.is_empty() || collection.starts_with("system.") {
            return Err(invalid("invalid index collection"));
        }
        let indexes = command.get_array("indexes").map_err(error)?;
        if indexes.len() != 1 {
            return Err(invalid("one approved index is required"));
        }
        let index = indexes[0]
            .as_document()
            .ok_or_else(|| invalid("invalid index definition"))?;
        let name = index.get_str("name").map_err(error)?;
        let keys = index.get_document("key").map_err(error)?;
        if index.len() != 2
            || !name.starts_with("ix_straton_")
            || keys.is_empty()
            || keys.len() > 8
            || keys.iter().any(|(k, v)| {
                k.is_empty()
                    || k.starts_with('$')
                    || !matches!(v, Bson::Int32(1 | -1) | Bson::Int64(1 | -1))
            })
        {
            return Err(invalid("invalid advisor index definition"));
        }
    } else if command.contains_key("dropIndexes") {
        if command.len() != 2
            || command.get_str("dropIndexes").map_err(error)?.is_empty()
            || !command
                .get_str("index")
                .map_err(error)?
                .starts_with("ix_straton_")
        {
            return Err(invalid("invalid index rollback command"));
        }
    } else {
        return Err(invalid("only index commands are allowed"));
    }
    Ok(command)
}
pub(super) async fn execute(source: &Mongo, ddl: &str) -> Result<()> {
    if !source.config.advisor_may_write {
        return Err(invalid("advisor writes are disabled"));
    }
    let mut cmd = command(ddl)?;
    cmd.insert("maxTimeMS", 55_000);
    tokio::time::timeout(
        Duration::from_secs(60),
        source
            .client()
            .await?
            .database(&source.config.database)
            .run_command(cmd)
            .into_future(),
    )
    .await
    .map_err(error)?
    .map_err(error)?;
    Ok(())
}
