use super::*;

pub(super) async fn metadata(source: &Sqlserver) -> Result<Value> {
    let mut client = source.connect().await?;
    let mut warnings = vec![];
    let settings=client.simple_query("SELECT compatibility_level, is_auto_update_stats_async_on, CONVERT(int,SERVERPROPERTY('EngineEdition')) AS edition FROM sys.databases WHERE database_id=DB_ID()")
 .await.map_err(error)?.into_first_result().await.map_err(error)?;
    let mut settings=settings.first().map(|r|json!({"compatibility_level":r.get::<u8,_>("compatibility_level"),"auto_update_statistics_async":r.get::<bool,_>("is_auto_update_stats_async_on")})).unwrap_or(json!({}));
    // Enterprise/Developer, Azure SQL and Managed Instance support online index operations.
    let edition = client
        .simple_query("SELECT CONVERT(int,SERVERPROPERTY('EngineEdition')) AS edition")
        .await
        .map_err(error)?
        .into_first_result()
        .await
        .map_err(error)?;
    let online = edition
        .first()
        .and_then(|r| r.get::<i32, _>("edition"))
        .is_some_and(|e| [3, 5, 8].contains(&e));
    match client
        .simple_query("SELECT actual_state_desc FROM sys.database_query_store_options")
        .await
    {
        Ok(q) => {
            if let Ok(rows) = q.into_first_result().await {
                settings["query_store"] = json!(rows.first().and_then(|r| r.get::<&str, _>(0)));
            }
        }
        Err(_) => warnings.push("Query Store settings are unavailable"),
    }
    let mut missing = BTreeMap::<i32, Value>::new();
    let query = "SELECT d.index_handle,OBJECT_SCHEMA_NAME(d.object_id) AS schema_name,OBJECT_NAME(d.object_id) AS table_name,c.column_name,c.column_usage,CONVERT(float,s.user_seeks) AS seeks,CONVERT(float,s.user_scans) AS scans,s.avg_total_user_cost,s.avg_user_impact FROM sys.dm_db_missing_index_details d JOIN sys.dm_db_missing_index_groups g ON g.index_handle=d.index_handle JOIN sys.dm_db_missing_index_group_stats s ON s.group_handle=g.index_group_handle CROSS APPLY sys.dm_db_missing_index_columns(d.index_handle) c WHERE d.database_id=DB_ID()";
    match client.simple_query(query).await {
        Ok(q) => match q.into_first_result().await {
            Ok(rows) => {
                for r in rows {
                    let id = r.get::<i32, _>("index_handle").unwrap_or(0);
                    let v=missing.entry(id).or_insert_with(||json!({"schema":r.get::<&str,_>("schema_name"),"table":r.get::<&str,_>("table_name"),"equality_columns":[],"range_columns":[],"include_columns":[],"user_seeks":r.get::<f64,_>("seeks"),"user_scans":r.get::<f64,_>("scans"),"avg_total_user_cost":r.get::<f64,_>("avg_total_user_cost"),"avg_user_impact":r.get::<f64,_>("avg_user_impact")}));
                    let key = match r.get::<&str, _>("column_usage") {
                        Some("EQUALITY") => "equality_columns",
                        Some("INEQUALITY") => "range_columns",
                        Some("INCLUDE") => "include_columns",
                        _ => continue,
                    };
                    if let Some(name) = r.get::<&str, _>("column_name") {
                        v[key].as_array_mut().unwrap().push(json!(name));
                    }
                }
            }
            Err(_) => warnings.push("Missing-index DMV permission is unavailable"),
        },
        Err(_) => warnings.push("Missing-index DMV permission is unavailable"),
    }
    let mut indexes = vec![];
    let query = "SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,OBJECT_NAME(i.object_id) AS table_name,i.name,CONVERT(float,COALESCE(u.user_seeks,0)+COALESCE(u.user_scans,0)+COALESCE(u.user_lookups,0)) AS reads,CONVERT(float,COALESCE(u.user_updates,0)) AS writes FROM sys.indexes i LEFT JOIN sys.dm_db_index_usage_stats u ON u.object_id=i.object_id AND u.index_id=i.index_id AND u.database_id=DB_ID() WHERE i.object_id IN(SELECT object_id FROM sys.tables) AND i.index_id>0";
    match client.simple_query(query).await {
        Ok(q) => match q.into_first_result().await {
            Ok(rows) => {
                for r in rows {
                    indexes.push(json!({"schema":r.get::<&str,_>("schema_name"),"table":r.get::<&str,_>("table_name"),"name":r.get::<&str,_>("name"),"reads":r.get::<f64,_>("reads"),"writes":r.get::<f64,_>("writes")}));
                }
            }
            Err(_) => warnings.push("Index-usage DMV permission is unavailable"),
        },
        Err(_) => warnings.push("Index-usage DMV permission is unavailable"),
    }
    let mut tables = vec![];
    let query = "SELECT OBJECT_SCHEMA_NAME(s.object_id) AS schema_name,OBJECT_NAME(s.object_id) AS table_name,MAX(CONVERT(float,p.modification_counter)) AS modifications,MAX(CONVERT(float,p.rows)) AS rows FROM sys.stats s CROSS APPLY sys.dm_db_stats_properties(s.object_id,s.stats_id) p WHERE s.object_id IN(SELECT object_id FROM sys.tables) GROUP BY s.object_id";
    match client.simple_query(query).await {
        Ok(q) => match q.into_first_result().await {
            Ok(rows) => {
                for r in rows {
                    tables.push(json!({"schema":r.get::<&str,_>("schema_name"),"table":r.get::<&str,_>("table_name"),"modifications":r.get::<f64,_>("modifications"),"rows":r.get::<f64,_>("rows")}));
                }
            }
            Err(_) => warnings.push("Statistics freshness is unavailable"),
        },
        Err(_) => warnings.push("Statistics freshness is unavailable"),
    }
    Ok(
        json!({"online":online,"settings":settings,"missing_indexes":missing.into_values().collect::<Vec<_>>(),"indexes":indexes,"tables":tables,"warnings":warnings}),
    )
}
pub(super) async fn execute(source: &Sqlserver, ddl: &str) -> Result<()> {
    if !source.advisor_may_write {
        return Err(invalid("advisor writes are disabled"));
    }
    let mut client = source.connect_mode(true).await?;
    // The connection is dedicated to one approved statement; dropping it cancels on timeout.
    client
        .simple_query("SET LOCK_TIMEOUT 5000; SET XACT_ABORT ON;")
        .await
        .map_err(error)?
        .into_results()
        .await
        .map_err(error)?;
    client
        .simple_query(ddl)
        .await
        .map_err(error)?
        .into_results()
        .await
        .map_err(error)?;
    Ok(())
}
