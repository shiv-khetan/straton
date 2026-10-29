use super::*;
use crate::{advisor, lake_layout, query_stats};
use datafusion::{
    arrow::{
        array::Int64Array,
        datatypes::{DataType, Field, Schema},
        record_batch::RecordBatch,
    },
    prelude::SessionContext,
};
use std::collections::BTreeMap;

#[tokio::test]
async fn workload_extracts_roles_through_aliases_without_values() {
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("amount", DataType::Int64, false),
    ]));
    ctx.register_batch(
        "a",
        RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from(vec![1, 2])),
                Arc::new(Int64Array::from(vec![5, 8])),
            ],
        )
        .unwrap(),
    )
    .unwrap();
    ctx.register_batch(
        "b",
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(vec![1, 2])),
                Arc::new(Int64Array::from(vec![5, 8])),
            ],
        )
        .unwrap(),
    )
    .unwrap();
    let frame=ctx.sql("SELECT x.id,SUM(x.amount) FROM a x JOIN b y ON x.id=y.id WHERE x.amount>987654321 AND y.id=123456789 GROUP BY x.id ORDER BY x.id").await.unwrap();
    let tables = BTreeMap::from([
        (("public".into(), "a".into()), "dataset-a".into()),
        (("public".into(), "b".into()), "dataset-b".into()),
    ]);
    let usage = query_stats::extract(frame.logical_plan(), &tables);
    for (dataset, column, role, op) in [
        ("dataset-a", "amount", "filter", "range"),
        ("dataset-b", "id", "filter", "equality"),
        ("dataset-a", "id", "join_key", "equality"),
        ("dataset-b", "id", "join_key", "equality"),
        ("dataset-a", "id", "group_by", ""),
        ("dataset-a", "id", "sort", ""),
    ] {
        assert!(
            usage.iter().any(|u| u.dataset == dataset
                && u.column == column
                && u.role == role
                && u.op == op),
            "{usage:?}: {dataset} {role}"
        );
    }
    let debug = format!("{usage:?}");
    assert!(!debug.contains("987654321"));
    assert!(!debug.contains("123456789"));
    let plan=ctx.sql("SELECT * FROM a WHERE CAST(id AS VARCHAR) LIKE 'private-prefix%' AND amount BETWEEN 7 AND 9").await.unwrap();
    let usage = query_stats::extract(plan.logical_plan(), &tables);
    assert!(usage.iter().any(|u| u.op == "like"));
    assert!(usage.iter().any(|u| u.op == "range"));
    assert!(!format!("{usage:?}").contains("private-prefix"));
}
fn workload() -> advisor::Table {
    advisor::Table {
        name: "dbo.orders".into(),
        columns: vec!["id".into(), "email".into(), "amount".into()],
        indexes: vec![],
        workload: vec![advisor::Workload {
            column: "id".into(),
            role: "filter".into(),
            op: "equality".into(),
            count: 20,
            scanned: 10_000,
        }],
    }
}
#[test]
fn advisor_uses_synthetic_dmvs_and_preserves_rollback() {
    let metadata = json!({"online":true,"missing_indexes":[{"schema":"dbo","table":"orders","equality_columns":["email"],"range_columns":[],"include_columns":["amount"],"user_seeks":100.,"user_scans":0.,"avg_total_user_cost":5.,"avg_user_impact":80.}],"tables":[{"schema":"dbo","table":"orders","rows":1000.,"modifications":700.}]});
    let t = workload();
    let rows = advisor::generate("sqlserver", &t, &metadata);
    let index = rows.iter().find(|r| r.ddl.contains("[email]")).unwrap();
    assert!(index.ddl.contains("INCLUDE ([amount]) WITH (ONLINE = ON)"));
    assert!(index.rollback_ddl.starts_with("DROP INDEX [ix_straton_"));
    assert_eq!(index.estimated_benefit, 400.);
    assert!(index.applicable);
    assert!(
        rows.iter()
            .any(|r| r.kind == "statistics_update" && !r.applicable)
    );
    let mut indexed = t.clone();
    indexed.indexes.push(advisor::Index {
        name: "already".into(),
        columns: vec!["id".into()],
        protected: true,
    });
    assert!(advisor::generate("postgres", &indexed, &json!({})).is_empty());
    let pg = json!({"columns":[{"schema":"dbo","table":"orders","column":"id","null_fraction":0.8,"n_distinct":500.}],"indexes":[]});
    let pg = advisor::generate("postgres", &t, &pg);
    assert!(pg[0].ddl.contains("CONCURRENTLY"));
    assert!(pg[0].ddl.contains("WHERE \"id\" IS NOT NULL"));
    assert!(pg[0].rollback_ddl.contains("DROP INDEX CONCURRENTLY"));
    let mut duplicate = t;
    duplicate.indexes = vec![
        advisor::Index {
            name: "keep".into(),
            columns: vec!["id".into()],
            protected: false,
        },
        advisor::Index {
            name: "duplicate".into(),
            columns: vec!["id".into()],
            protected: false,
        },
    ];
    let rows = advisor::generate(
        "sqlserver",
        &duplicate,
        &json!({"indexes":[{"schema":"dbo","table":"orders","name":"duplicate","reads":0.,"writes":500.}]}),
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "drop_unused_duplicate_index");
    assert!(!rows[0].applicable);
    let mut escaped = workload();
    escaped.name = "odd.schema];DROP TABLE x--".into();
    let ddl = &advisor::generate("sqlserver", &escaped, &json!({}))[0].ddl;
    assert!(ddl.contains("[odd].[schema]];DROP TABLE x--]"));
}
async fn insert_advice(f: &Fixture, id: &str) {
    let config: serde_json::Value = serde_json::from_str(
        &sqlx::query_scalar::<_, String>("SELECT config FROM sources WHERE id='source'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
    )
    .unwrap();
    sqlx::query("INSERT INTO advisor_recommendations(id,source_id,target,kind,fingerprint,ddl,rollback_ddl,evidence,estimated_benefit,cost,risk,required_permission,applicable,source_config,created_at,updated_at) VALUES(?,'source','dbo.orders','create_index',?,'CREATE INDEX approved ON target(id);','DROP INDEX approved ON target;','{}',10,'cost','risk','ALTER',1,?,0,0)").bind(id).bind(id).bind(advisor::config_hash("noop",&config)).execute(&f.pool).await.unwrap();
}
#[tokio::test]
async fn advisor_approval_gates_transitions_rollback_and_audit() {
    let f = Fixture::new().await;
    insert_advice(&f, "advice").await;
    let a = app(&f);
    let role = access_role(&a, "advisor reader").await;
    access_grant(&a, &role, "source", "source", "read").await;
    let (_, token) = access_user(&a, "viewer", &[&role]).await;
    for action in ["apply", "rollback", "dismiss"] {
        assert_eq!(
            request_as(
                &a,
                &token,
                "POST",
                &format!("/v1/advisor/advice/{action}"),
                json!(null)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        request(&a, "POST", "/v1/advisor/advice/apply", json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = called.clone();
    assert!(
        advisor::execute_with(&f.pool, "advice", "admin", false, move |_, _| async move {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .await
        .is_err()
    );
    assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    sqlx::query("UPDATE sources SET config='{\"advisor_may_write\":true}' WHERE id='source'")
        .execute(&f.pool)
        .await
        .unwrap();
    let applied = advisor::execute_with(
        &f.pool,
        "advice",
        "admin",
        false,
        |source, ddl| async move {
            assert_eq!(source, "source");
            assert_eq!(ddl, "CREATE INDEX approved ON target(id);");
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(applied["ok"], true);
    assert!(
        advisor::execute_with(&f.pool, "advice", "admin", false, |_, _| async {
            panic!("must not retry an applied recommendation")
        })
        .await
        .is_err()
    );
    let rolled = advisor::execute_with(&f.pool, "advice", "admin", true, |_, ddl| async move {
        assert_eq!(ddl, "DROP INDEX approved ON target;");
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(rolled["ok"], true);
    let status: String =
        sqlx::query_scalar("SELECT status FROM advisor_recommendations WHERE id='advice'")
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(status, "rolled_back");
    insert_advice(&f, "failure").await;
    let result = advisor::execute_with(&f.pool, "failure", "admin", false, |_, _| async {
        anyhow::bail!("password=secret-user-data")
    })
    .await
    .unwrap();
    assert_eq!(result["ok"], false);
    assert!(!result.to_string().contains("secret-user-data"));
    insert_advice(&f, "interrupted").await;
    sqlx::query("UPDATE advisor_recommendations SET status='applying' WHERE id='interrupted'")
        .execute(&f.pool)
        .await
        .unwrap();
    advisor::recover(&f.pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM advisor_recommendations WHERE id='interrupted'"
        )
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        "failed"
    );
    insert_advice(&f, "dismiss").await;
    assert_eq!(
        request(&a, "POST", "/v1/advisor/dismiss/dismiss", json!(null))
            .await
            .0,
        StatusCode::OK
    );
    let audit=sqlx::query("SELECT action,principal_id,detail FROM audit_log WHERE action LIKE 'advisor.%' OR action='optimizer.refused'").fetch_all(&f.pool).await.unwrap();
    for action in [
        "optimizer.refused",
        "advisor.refused",
        "advisor.apply.started",
        "advisor.apply",
        "advisor.rollback.started",
        "advisor.rollback",
        "advisor.interrupted",
        "advisor.dismiss",
    ] {
        assert!(
            audit.iter().any(|r| r.get::<&str, _>("action") == action),
            "{action}"
        );
    }
    assert!(
        audit
            .iter()
            .all(|r| !r.get::<&str, _>("detail").contains("secret-user-data"))
    );
    assert!(store::verify_audit(&f.pool).await.unwrap().ok);
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn optimizer_stats_relayout_and_encryption_stay_correct() {
    let mut f = sql_fixture().await;
    f.config.encryption.enabled = true;
    sql_sync(&f).await;
    let id = dataset_id(&f, "users").await;
    let a = app(&f);
    for _ in 0..6 {
        let (s, v) = request(
            &a,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT * FROM app_db.users WHERE id=1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
    }
    tokio::time::timeout(Duration::from_secs(8),async{loop{let n:i64=sqlx::query_scalar("SELECT COALESCE(SUM(count),0) FROM query_stats WHERE dataset_id=? AND role='filter'").bind(&id).fetch_one(&f.pool).await.unwrap();if n>=6{break;}tokio::time::sleep(Duration::from_millis(50)).await;}}).await.unwrap();
    let (s,v)=request(&a,"POST","/v1/explorer/rows",json!({"schema":"app_db","table":"users","filters":[{"column":"id","op":"eq","value":1}],"sort":[],"limit":10,"offset":0})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (s, v) = request(
        &a,
        "POST",
        "/v1/charts/preview",
        json!({"sql":"SELECT id,name FROM app_db.users WHERE id=1","config":{}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let check = create_check(
        &a,
        quality_input(
            "optimizer range",
            "range",
            &id,
            Some("id"),
            json!({"min":1,"max":2}),
        ),
    )
    .await;
    let (s, v) = request(
        &a,
        "POST",
        &format!("/v1/quality/checks/{check}/run"),
        json!(null),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "passed");
    let model = create_model(
        &a,
        "optimizer_model",
        "SELECT id,name FROM app_db.users WHERE id=1",
        "table",
        "manual",
    )
    .await;
    execute_model(&f, &a, &model).await;
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let n: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(count),0) FROM query_stats WHERE dataset_id=? AND role='scan'",
            )
            .bind(&id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
            if n >= 10 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let (s, v) = request(
        &a,
        "GET",
        &format!("/v1/optimizer/datasets/{id}"),
        json!(null),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["next_layout"]["sort_column"], "id");
    assert!(!v.to_string().contains("Alice"));
    assert_eq!(v["hash_index"]["enabled"], false);
    let (s, v) = request(
        &a,
        "POST",
        &format!("/v1/optimizer/datasets/{id}/relayout"),
        json!(null),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["layout"]["sort_column"], "id");
    let (s, v) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,name FROM app_db.users ORDER BY id"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([[1, "Alice"], [2, "Bob"]]));
    let output = f.dir.join("data/source/users");
    let current = std::fs::read_to_string(output.join("_current")).unwrap();
    let path = output.join(current).join("part-000000.parquet");
    assert!(
        datafusion::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(
            std::fs::File::open(&path).unwrap()
        )
        .is_err()
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action='optimizer.relayout' AND principal_id='admin'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn lake_layout_glob_safe_global_sort_bloom_statistics_and_recovery() {
    let f = Fixture::new().await;
    let path = f.dir.join("snapshot [1]");
    std::fs::create_dir_all(&path).unwrap();
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, true)]));
    for part in 0..2 {
        let values = (0..1000).rev().map(|v| v * 2 + part).collect::<Vec<_>>();
        let batch =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(values))]).unwrap();
        straton_connectors::write_parquet(&path.join(format!("part-{part}.parquet")), &batch, None)
            .unwrap();
    }
    std::fs::write(path.join("sync-result.json"), "{}").unwrap();
    let layout = lake_layout::Layout {
        sort_column: Some("id".into()),
        bloom_columns: vec![],
        row_group_size: 256,
        reason: "test workload".into(),
        hash_index: Default::default(),
    };
    let layout = lake_layout::rewrite(&f.pool, &path, None, layout, &["id".into()])
        .await
        .unwrap();
    assert_eq!(layout.bloom_columns, vec!["id"]);
    let reader = crate::keys::reader(&path.join("part-000000.parquet"), None).unwrap();
    assert_eq!(reader.metadata().row_groups().len(), 8);
    assert!(
        reader
            .metadata()
            .row_group(0)
            .column(0)
            .statistics()
            .is_some()
    );
    assert!(
        reader
            .metadata()
            .row_group(0)
            .column(0)
            .bloom_filter_offset()
            .is_some()
    );
    let mut values = vec![];
    for b in reader.build().unwrap() {
        let b = b.unwrap();
        let a = b.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
        values.extend(a.values().iter().copied());
    }
    assert_eq!(values, (0..2000).collect::<Vec<i64>>());
    assert!(path.join("sync-result.json").is_file());
    let saved = path.with_file_name(".layout-backup-snapshot [1]");
    std::fs::rename(&path, &saved).unwrap();
    lake_layout::recover(&path).unwrap();
    assert!(path.is_dir());
    assert!(!saved.exists());
    f.close().await;
}
#[tokio::test]
async fn advisor_sqlserver_metadata_read_only_gated() {
    let Ok(target) = std::env::var("STRATON_TEST_SQLSERVER") else {
        return;
    };
    let (server, path) = target
        .split_once('/')
        .expect("host:port/database?auth=windows");
    let (database, query) = path.split_once('?').unwrap_or((path, ""));
    assert_eq!(database, "straton_scratch");
    let (host, port) = server
        .rsplit_once(':')
        .map(|(h, p)| (h, p.parse::<u16>().unwrap()))
        .unwrap_or((server, 1433));
    let mut config = json!({"host":host,"port":port,"database":database,"auth":"windows","advisor_may_write":false});
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap();
        match k {
            "auth" | "instance" | "username" => config[k] = json!(v),
            "encrypt" | "trust_server_certificate" => config[k] = json!(v.parse::<bool>().unwrap()),
            _ => panic!("unsupported test option"),
        }
    }
    let secret = std::env::var("STRATON_TEST_SQLSERVER_PASSWORD").ok();
    let connector = straton_connectors::build("sqlserver", &config, secret.as_deref()).unwrap();
    let metadata = connector.advisor_metadata().await.unwrap();
    assert!(metadata["settings"].is_object());
    assert!(metadata["missing_indexes"].is_array());
    let schemas = connector.discover().await.unwrap();
    for schema in schemas {
        let t = advisor::Table {
            name: schema.dataset.name,
            columns: schema.columns.into_iter().map(|c| c.name).collect(),
            indexes: vec![],
            workload: vec![],
        };
        for r in advisor::generate("sqlserver", &t, &metadata) {
            assert!(!r.rollback_ddl.is_empty());
        }
    }
    // This test deliberately never calls advisor_execute or any source mutation API.
}

#[test]
fn mysql_and_mongodb_advice_uses_existing_indexes_and_escaped_commands() {
    let mut t = workload();
    t.name = "scratch.ord`ers".into();
    t.workload[0].column = "em`ail".into();
    t.columns.push("em`ail".into());
    let metadata = json!({"version":"8.0.36","tables":[{"schema":"scratch","table":"ord`ers","engine":"InnoDB"}]});
    let recommendations = advisor::generate("mysql", &t, &metadata);
    assert_eq!(recommendations.len(), 1);
    let r = &recommendations[0];
    assert!(
        r.ddl
            .contains("ON `scratch`.`ord``ers` (`em``ail`) ALGORITHM=INPLACE LOCK=NONE;")
    );
    assert!(r.rollback_ddl.starts_with("DROP INDEX `ix_straton_"));
    assert!(r.applicable);
    let mut indexed = metadata.clone();
    indexed["indexes"] =
        json!([{"schema":"scratch","table":"ord`ers","name":"existing","columns":["em`ail","id"]}]);
    assert!(advisor::generate("mysql", &t, &indexed).is_empty());
    assert!(
        !advisor::generate("mysql", &t, &json!({"version":"5.5.0"}))[0]
            .ddl
            .contains("LOCK=NONE")
    );
    t.name = "ord\"ers".into();
    t.workload[0].column = "user\"Id".into();
    t.columns.push("user\"Id".into());
    let r = advisor::generate("mongodb", &t, &json!({})).remove(0);
    let command: serde_json::Value = serde_json::from_str(&r.ddl).unwrap();
    assert_eq!(command["createIndexes"], t.name);
    assert_eq!(command["indexes"][0]["key"]["user\"Id"], 1);
    let rollback: serde_json::Value = serde_json::from_str(&r.rollback_ddl).unwrap();
    assert_eq!(rollback["index"], command["indexes"][0]["name"]);
    assert!(
        advisor::generate(
            "mongodb",
            &t,
            &json!({"indexes":[{"table":t.name,"name":"existing","columns":["user\"Id"]}]})
        )
        .is_empty()
    );
}
#[tokio::test]
async fn mysql_and_mongo_apply_require_opt_in_and_keep_rollback_audit() {
    for kind in ["mysql", "mongodb"] {
        let f = Fixture::new().await;
        sqlx::query("UPDATE sources SET kind=? WHERE id='source'")
            .bind(kind)
            .execute(&f.pool)
            .await
            .unwrap();
        insert_advice(&f, "new-advice").await;
        let config = json!({});
        sqlx::query("UPDATE advisor_recommendations SET source_config=? WHERE id='new-advice'")
            .bind(advisor::config_hash(kind, &config))
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(
            advisor::execute_with(&f.pool, "new-advice", "admin", false, |_, _| async {
                panic!("disabled advisor must not execute")
            })
            .await
            .is_err()
        );
        sqlx::query("UPDATE sources SET config=? WHERE id='source'")
            .bind(json!({"advisor_may_write":true}).to_string())
            .execute(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            advisor::execute_with(&f.pool, "new-advice", "admin", false, |_, _| async {
                Ok(())
            })
            .await
            .unwrap()["ok"],
            true
        );
        assert_eq!(
            advisor::execute_with(&f.pool, "new-advice", "admin", true, |_, ddl| async move {
                assert!(ddl.starts_with("DROP INDEX"));
                Ok(())
            })
            .await
            .unwrap()["ok"],
            true
        );
        let actions: Vec<String> =
            sqlx::query_scalar("SELECT action FROM audit_log WHERE entity_id='new-advice'")
                .fetch_all(&f.pool)
                .await
                .unwrap();
        assert!(actions.contains(&"advisor.apply".into()));
        assert!(actions.contains(&"advisor.rollback".into()));
    }
}

// The sidecar is only a pruning hint: with it present, corrupt or missing, equality
// queries must return exactly what a plain scan returned, encrypted or not.
#[tokio::test]
async fn hash_sidecar_never_changes_results() {
    for encrypted in [false, true] {
        let mut f = sql_fixture().await;
        f.config.encryption.enabled = encrypted;
        // 300k rows over 2,000 repeated names: enough row groups for the sidecar to pay off.
        let input =
            sqlx::SqlitePool::connect(&format!("sqlite:{}", f.dir.join("sql-input.db").display()))
                .await
                .unwrap();
        sqlx::raw_sql("WITH RECURSIVE c(x) AS (SELECT 3 UNION ALL SELECT x+1 FROM c WHERE x<300000) INSERT INTO users SELECT x,'u'||(x%2000) FROM c;")
            .execute(&input).await.unwrap();
        input.close().await;
        sqlx::query(
            "UPDATE sources SET config=json_set(config,'$.batch_size',100000) WHERE id='source'",
        )
        .execute(&f.pool)
        .await
        .unwrap();
        sql_sync(&f).await;
        let id = dataset_id(&f, "users").await;
        let a = app(&f);
        let queries = [
            "SELECT count(*) FROM app_db.users WHERE name='u7'",
            "SELECT min(id),max(id) FROM app_db.users WHERE name='u1999'",
            "SELECT count(*) FROM app_db.users WHERE name='absent'",
            "SELECT id,name FROM app_db.users WHERE name='Alice'",
            "SELECT count(*) FROM app_db.users",
        ];
        let run = |sql: &'static str| {
            let a = a.clone();
            async move {
                let (s, v) = request(&a, "POST", "/v1/sql", json!({ "query": sql })).await;
                assert_eq!(s, StatusCode::OK, "{v}");
                v["rows"].clone()
            }
        };
        let mut baseline = vec![];
        for sql in queries {
            baseline.push(run(sql).await);
        }
        assert_eq!(baseline[0], json!([[150]]));
        sqlx::query("INSERT INTO query_stats(dataset_id,column,role,op,count,rows_scanned,rows_returned,elapsed_ms,last_seen) VALUES(?,'name','filter','equality',150,3000000,150,1,?) ON CONFLICT(dataset_id,column,role,op) DO UPDATE SET count=count+150,rows_scanned=rows_scanned+3000000")
            .bind(&id).bind(crate::store::now()).execute(&f.pool).await.unwrap();
        let (s, v) = request(
            &a,
            "POST",
            &format!("/v1/optimizer/datasets/{id}/relayout"),
            json!(null),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(
            v["layout"]["hash_index"]["enabled"], true,
            "encrypted={encrypted} {v}"
        );
        let output = f.dir.join("data/source/users");
        let snapshot = output.join(
            std::fs::read_to_string(output.join("_current"))
                .unwrap()
                .trim(),
        );
        let sidecar = snapshot.join("_hash_lookup.bin");
        for stage in ["present", "corrupt", "missing"] {
            match stage {
                "corrupt" => std::fs::write(&sidecar, b"not a sidecar").unwrap(),
                "missing" => std::fs::remove_file(&sidecar).unwrap(),
                _ => assert!(sidecar.exists(), "sidecar should exist after relayout"),
            }
            for (sql, rows) in queries.iter().zip(&baseline) {
                assert_eq!(
                    run(sql).await,
                    *rows,
                    "encrypted={encrypted} stage={stage} {sql}"
                );
            }
        }
        drop(a);
        f.close().await;
    }
}
