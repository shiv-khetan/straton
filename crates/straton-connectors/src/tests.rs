use super::*;
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn dir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "straton-connectors-{}-{}-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}
#[test]
fn sqlite_discovery_and_resume() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async{
let dir=dir();let path=dir.join("test.db");let p=SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true)).await.unwrap();
sqlx::raw_sql("CREATE TABLE parents(a INTEGER,b INTEGER,PRIMARY KEY(a,b));CREATE TABLE children(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES parents(a,b));INSERT INTO children VALUES(1,NULL,NULL),(2,NULL,NULL),(3,NULL,NULL),(4,NULL,NULL),(5,NULL,NULL);").execute(&p).await.unwrap();
let c=build("sqlite",&json!({"path":path,"batch_size":2}),None).unwrap();let d=c.discover().await.unwrap();let parent=d.iter().find(|d|d.dataset.name=="parents").unwrap();assert_eq!(parent.columns.iter().filter(|c|c.primary_key).count(),2);let child=d.iter().find(|d|d.dataset.name=="children").unwrap();assert_eq!(child.relationships[0].from_cols,vec!["a","b"]);assert_eq!(child.relationships[0].to_cols,vec!["a","b"]);
let mut batches=c.read("children",Default::default()).await.unwrap();let(b,cursor)=batches.next().await.unwrap().unwrap();assert_eq!(b.num_rows(),2);drop(batches);let rest=c.read("children",ReadOptions {cursor:Some(cursor),..Default::default()}).await.unwrap().collect::<Vec<_>>().await;assert_eq!(rest.iter().map(|r|r.as_ref().unwrap().0.num_rows()).sum::<usize>(),3);assert_eq!(rest.last().unwrap().as_ref().unwrap().1,json!(5));drop(c);p.close().await;let _=std::fs::remove_dir_all(dir);
});
}
#[test]
fn csv_discovery_and_resume() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let dir = dir();
            std::fs::write(dir.join("people.csv"), "id,name\n1,Alice\n2,Bob\n3,Carol\n").unwrap();
            std::fs::write(dir.join("ignored.txt"), "x").unwrap();
            let c = build("csv", &json!({"path":dir,"batch_size":2}), None).unwrap();
            let d = c.discover().await.unwrap();
            assert_eq!(d.len(), 1);
            assert_eq!(d[0].columns[0].data_type, "Int64");
            assert!(d[0].relationships.is_empty());
            let mut batches = c.read("people", Default::default()).await.unwrap();
            let (b, cursor) = batches.next().await.unwrap().unwrap();
            assert_eq!(b.num_rows(), 2);
            drop(batches);
            let mut rest = c
                .read(
                    "people",
                    straton_core::ReadOptions {
                        cursor: Some(cursor),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            let (b, cursor) = rest.next().await.unwrap().unwrap();
            assert_eq!(b.num_rows(), 1);
            assert_eq!(cursor, json!(3));
            assert!(rest.next().await.is_none());
            drop(rest);
            drop(c);
            let _ = std::fs::remove_dir_all(dir);
        });
}
#[test]
fn postgres_integration() {
    let Ok(config) = std::env::var("STRATON_TEST_PG") else {
        return;
    };
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let mut config: Value = serde_json::from_str(&config).expect("STRATON_TEST_PG must be JSON connector config");
        let secret = config.as_object_mut().unwrap().remove("secret").and_then(|v| v.as_str().map(str::to_owned));
        config["batch_size"] = json!(2);
        let c = build("postgres", &config, secret.as_deref()).unwrap();
        c.check().await.unwrap();
        let mut opts = PgConnectOptions::new()
            .host(config["host"].as_str().unwrap_or("localhost"))
            .port(config["port"].as_u64().unwrap_or(5432) as u16)
            .database(config["database"].as_str().unwrap())
            .username(config["username"].as_str().unwrap_or("postgres"));
        if let Some(secret) = &secret { opts = opts.password(secret); }
        let pool = PgPoolOptions::new().connect_with(opts).await.unwrap();
        let ns = format!("straton_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        sqlx::raw_sql(&format!("CREATE SCHEMA {ns}; CREATE TABLE {ns}.parents(a INTEGER,b INTEGER,PRIMARY KEY(a,b)); CREATE TABLE {ns}.items(a INTEGER,b INTEGER,amount NUMERIC(12,2),unbounded NUMERIC,flag BOOLEAN,d DATE,t TIMESTAMP,tz TIMESTAMPTZ,u UUID,j JSONB,p POINT,PRIMARY KEY(a,b),FOREIGN KEY(a,b) REFERENCES {ns}.parents(a,b)); INSERT INTO {ns}.parents VALUES(1,1),(1,2),(2,1); INSERT INTO {ns}.items SELECT a,b,12.34,123.456,true,'2026-10-20','2026-10-20 12:00:00','2026-10-20 12:00:00+00','00000000-0000-0000-0000-000000000001','{{\"x\":1}}','(1,2)' FROM {ns}.parents;")).execute(&pool).await.unwrap();
        let name = format!("{ns}.items");
        let schemas = c.discover().await.unwrap();
        let ds = schemas.iter().find(|d| d.dataset.name == name).unwrap();
        assert_eq!(ds.columns.iter().filter(|c| c.primary_key).count(), 2);
        assert_eq!(ds.relationships[0].from_cols, vec!["a", "b"]);
        assert_eq!(ds.relationships[0].to_cols, vec!["a", "b"]);
        assert_eq!(ds.columns.iter().find(|c| c.name == "amount").unwrap().data_type, "Decimal128(12, 2)");
        assert_eq!(ds.columns.iter().find(|c| c.name == "unbounded").unwrap().data_type, "Utf8");
        let mut stream = c.read(&name, Default::default()).await.unwrap();
        let (batch, cursor) = stream.next().await.unwrap().unwrap();
        assert_eq!(batch.num_rows(), 2); assert_eq!(cursor, json!(["1", "2"])); drop(stream);
        let mut rest = c.read(&name, straton_core::ReadOptions { cursor: Some(cursor), ..Default::default() }).await.unwrap();
        assert_eq!(rest.next().await.unwrap().unwrap().0.num_rows(), 1);
        assert!(rest.next().await.is_none()); drop(rest); drop(c);
        sqlx::raw_sql(&format!("DROP SCHEMA {ns} CASCADE")).execute(&pool).await.unwrap(); pool.close().await;
    });
}

#[test]
fn arrow_type_conversion_is_strict() {
    let cases = vec![
        (DataType::Int16, "12"),
        (DataType::Int32, "123"),
        (DataType::Int64, "1234"),
        (DataType::Float32, "1.25"),
        (DataType::Float64, "1.25"),
        (DataType::Boolean, "true"),
        (DataType::Date32, "2026-10-20"),
        (
            DataType::Timestamp(TimeUnit::Microsecond, None),
            "2026-10-20 12:34:56.123456",
        ),
        (
            DataType::Timestamp(TimeUnit::Microsecond, Some("+00:00".into())),
            "2026-10-20 12:34:56.123456+00",
        ),
        (DataType::Decimal128(12, 2), "12345.67"),
        (DataType::Utf8, "{\"key\":true}"),
    ];
    for (dt, value) in cases {
        let columns = vec![column("value".into(), dt.clone(), true, false)];
        let b = batch(&columns, vec![vec![Some(value.into()), None]])
            .unwrap_or_else(|e| panic!("{dt:?}: {e}"));
        assert_eq!(b.schema().field(0).data_type(), &dt);
        assert_eq!(b.column(0).null_count(), 1);
    }
    assert!(
        batch(
            &[column("value".into(), DataType::Int64, true, false)],
            vec![vec![Some("invalid".into())]]
        )
        .is_err()
    );
}

#[test]
fn sqlite_incremental_ties_parameters_resume_and_keys_only() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let dir=dir(); let path=dir.join("incremental.db");
        let pool=SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true)).await.unwrap();
        sqlx::raw_sql("CREATE TABLE items(id TEXT NOT NULL, tenant INTEGER NOT NULL, updated_at INTEGER NOT NULL, body TEXT, PRIMARY KEY(id,tenant)); INSERT INTO items VALUES('old',1,1,'old'),('a',1,2,'a1'),('a',2,2,'a2'),('b',1,2,'b1'),('c',1,2,'c1'),('z',1,3,'z');").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO items VALUES(?,1,2,'quoted')").bind("b' OR 1=1 --").execute(&pool).await.unwrap();
        let c=build("sqlite",&json!({"path":path,"batch_size":2}),None).unwrap();
        let options=ReadOptions { incremental:Some(straton_core::IncrementalRead {watermark_column:"updated_at".into(),lower_bound:Some(json!(2)),key_columns:vec!["id".into(),"tenant".into()]}),..Default::default() };
        let mut mixed=options.clone();mixed.keys_only=Some(vec!["id".into()]);
        assert!(c.read("items",mixed).await.err().unwrap().to_string().contains("mutually exclusive"));
        let mut batches=c.read("items",options.clone()).await.unwrap();
        let (first,cursor)=batches.next().await.unwrap().unwrap(); assert_eq!(first.num_rows(),2); drop(batches);
        let mut resumed=options.clone(); resumed.cursor=Some(cursor);
        let rest=c.read("items",resumed).await.unwrap().collect::<Vec<_>>().await;
        assert_eq!(rest.iter().map(|b|b.as_ref().unwrap().0.num_rows()).sum::<usize>(),4);
        let mut ids=Vec::new();
        for b in c.read("items",options.clone()).await.unwrap().collect::<Vec<_>>().await {
            let b=b.unwrap().0; let wm=b.column(2).as_any().downcast_ref::<Int64Array>().unwrap();
            let id=b.column(0).as_any().downcast_ref::<StringArray>().unwrap();
            for i in 0..b.num_rows() {assert!(wm.value(i)>=2);ids.push(id.value(i).to_owned());}
        }
        assert_eq!(ids,vec!["a","a","b","b' OR 1=1 --","c","z"]);
        // The bound stays a parameter even when its text contains SQL syntax.
        let mut injected=options; injected.incremental.as_mut().unwrap().lower_bound=Some(json!("2 OR 1=1"));
        let rows=c.read("items",injected).await.unwrap().collect::<Vec<_>>().await;
        assert_eq!(rows.iter().map(|r|r.as_ref().unwrap().0.num_rows()).sum::<usize>(),6);
        let rows=c.read("items",ReadOptions {keys_only:Some(vec!["id".into(),"tenant".into()]),..Default::default()}).await.unwrap().collect::<Vec<_>>().await;
        assert_eq!(rows.iter().map(|b|b.as_ref().unwrap().0.num_rows()).sum::<usize>(),7);
        assert!(rows.iter().all(|b|b.as_ref().unwrap().0.num_columns()==2));
        sqlx::raw_sql("CREATE TABLE nullable_watermark(id INTEGER PRIMARY KEY,updated_at INTEGER); INSERT INTO nullable_watermark VALUES(1,1),(2,2),(3,NULL);").execute(&pool).await.unwrap();
        let null_options=ReadOptions {incremental:Some(straton_core::IncrementalRead {watermark_column:"updated_at".into(),lower_bound:None,key_columns:vec!["id".into()]}),..Default::default()};
        let mut nulls=c.read("nullable_watermark",null_options).await.unwrap();
        assert!(nulls.next().await.unwrap().err().unwrap().to_string().contains("non-null"));drop(nulls);
        drop(c);pool.close().await;let _=std::fs::remove_dir_all(dir);
    });
}
#[test]
fn csv_incremental_is_unsupported() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let dir = dir();
            std::fs::write(dir.join("items.csv"), "id,updated_at\n1,1\n").unwrap();
            let c = build("csv", &json!({"path":dir}), None).unwrap();
            let result = c
                .read(
                    "items",
                    ReadOptions {
                        incremental: Some(straton_core::IncrementalRead {
                            watermark_column: "updated_at".into(),
                            lower_bound: Some(json!(1)),
                            key_columns: vec!["id".into()],
                        }),
                        ..Default::default()
                    },
                )
                .await;
            assert!(
                result
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("CSV supports full reads only")
            );
            drop(c);
            let _ = std::fs::remove_dir_all(dir);
        });
}
