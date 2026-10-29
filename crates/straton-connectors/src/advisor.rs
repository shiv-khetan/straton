use super::*;
use std::time::Duration;
pub(super) async fn metadata(pool: &sqlx::PgPool) -> Result<Value> {
    let mut tx = pool.begin().await.map_err(error)?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(error)?;
    sqlx::query("SET LOCAL statement_timeout='15000ms'")
        .execute(&mut *tx)
        .await
        .map_err(error)?;
    let settings = sqlx::query(
        "SELECT name,setting,unit FROM pg_settings WHERE name IN ('work_mem','random_page_cost')",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(error)?;
    let settings:serde_json::Map<String,Value>=settings.into_iter().map(|r|(r.get::<String,_>("name"),json!({"value":r.get::<String,_>("setting"),"unit":r.get::<Option<String>,_>("unit")}))).collect();
    let tables=sqlx::query("SELECT schemaname,relname,n_live_tup,n_mod_since_analyze,seq_scan,idx_scan FROM pg_stat_user_tables").fetch_all(&mut *tx).await.map_err(error)?.into_iter().map(|r|json!({"schema":r.get::<String,_>("schemaname"),"table":r.get::<String,_>("relname"),"rows":r.get::<i64,_>("n_live_tup"),"modifications":r.get::<i64,_>("n_mod_since_analyze"),"seq_scan":r.get::<i64,_>("seq_scan"),"idx_scan":r.get::<Option<i64>,_>("idx_scan")})).collect::<Vec<_>>();
    let indexes=sqlx::query("SELECT u.schemaname,u.relname,u.indexrelname,u.idx_scan,i.indisunique,i.indisprimary,(i.indpred IS NOT NULL) AS filtered,COALESCE((SELECT json_agg(a.attname ORDER BY k.ord)::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.ord<=i.indnkeyatts),'[]') AS columns FROM pg_stat_user_indexes u JOIN pg_index i ON i.indexrelid=u.indexrelid").fetch_all(&mut *tx).await.map_err(error)?.into_iter().map(|r|json!({"schema":r.get::<String,_>("schemaname"),"table":r.get::<String,_>("relname"),"name":r.get::<String,_>("indexrelname"),"reads":r.get::<i64,_>("idx_scan"),"columns":serde_json::from_str::<Value>(r.get("columns")).unwrap_or(json!([])),"unique":r.get::<bool,_>("indisunique"),"primary":r.get::<bool,_>("indisprimary"),"filtered":r.get::<bool,_>("filtered")})).collect::<Vec<_>>();
    // Deliberately do not read most_common_vals or histogram_bounds.
    let columns=sqlx::query("SELECT schemaname,tablename,attname,null_frac,n_distinct,correlation FROM pg_stats").fetch_all(&mut *tx).await.map_err(error)?.into_iter().map(|r|json!({"schema":r.get::<String,_>("schemaname"),"table":r.get::<String,_>("tablename"),"column":r.get::<String,_>("attname"),"null_fraction":r.get::<f32,_>("null_frac"),"n_distinct":r.get::<f32,_>("n_distinct"),"correlation":r.get::<Option<f32>,_>("correlation")})).collect::<Vec<_>>();
    tx.rollback().await.map_err(error)?;
    Ok(
        json!({"online":true,"settings":settings,"tables":tables,"indexes":indexes,"columns":columns,"missing_indexes":[],"warnings":[]}),
    )
}
pub(super) async fn execute(pool: &sqlx::PgPool, ddl: &str) -> Result<()> {
    let mut connection = pool.acquire().await.map_err(error)?.detach();
    // CONCURRENTLY cannot run in a transaction. Never return a timed-out session to the pool.
    let work = async {
        sqlx::query("SET statement_timeout='55000ms'")
            .execute(&mut connection)
            .await
            .map_err(error)?;
        sqlx::query("SET lock_timeout='5000ms'")
            .execute(&mut connection)
            .await
            .map_err(error)?;
        sqlx::query(ddl)
            .execute(&mut connection)
            .await
            .map_err(error)?;
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(60), work)
        .await
        .map_err(error)?
}
