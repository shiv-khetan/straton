use super::*;
use futures::TryStreamExt;
fn native(name: &str, typ: &str, unsigned: bool, precision: u8, scale: u8) -> NativeColumn {
    NativeColumn {
        column: column(
            name.into(),
            arrow_type(typ, unsigned, precision, scale),
            false,
            true,
        ),
        typ: typ.into(),
        unsigned,
        precision,
        scale,
    }
}
#[test]
fn types_and_lossless_arrays() {
    for (typ, unsigned, expected) in [
        ("tinyint", false, DataType::Int8),
        ("tinyint", true, DataType::UInt8),
        ("smallint", true, DataType::UInt16),
        ("mediumint", false, DataType::Int32),
        ("int", true, DataType::UInt32),
        ("bigint", true, DataType::UInt64),
        ("bit", false, DataType::UInt64),
        ("year", false, DataType::UInt16),
        ("float", false, DataType::Float32),
        ("double", false, DataType::Float64),
        ("date", false, DataType::Date32),
        ("time", false, DataType::Duration(TimeUnit::Microsecond)),
        ("blob", false, DataType::Binary),
        ("json", false, DataType::Utf8),
        ("enum", false, DataType::Utf8),
        ("set", false, DataType::Utf8),
        ("text", false, DataType::Utf8),
    ] {
        assert_eq!(arrow_type(typ, unsigned, 0, 0), expected);
    }
    assert_eq!(
        arrow_type("decimal", true, 65, 30),
        DataType::Decimal256(65, 30)
    );
    let columns = vec![
        native("big", "bigint", true, 20, 0),
        native("amount", "decimal", false, 38, 4),
        native("bytes", "blob", false, 0, 0),
        native("duration", "time", false, 0, 0),
        native("ts", "timestamp", false, 0, 0),
    ];
    let b = make_batch(
        &columns,
        vec![
            vec![Some(u64::MAX.to_string())],
            vec![Some("12345678901234567890.1234".into())],
            vec![Some("00FF61".into())],
            vec![Some("-90000000000.000000".into())],
            vec![Some("2026-10-29 12:00:00.123456".into())],
        ],
    )
    .unwrap();
    assert_eq!(b.num_rows(), 1);
    assert_eq!(
        b.column(0)
            .as_any()
            .downcast_ref::<arrow::array::UInt64Array>()
            .unwrap()
            .value(0),
        u64::MAX
    );
    assert_eq!(
        b.column(2)
            .as_any()
            .downcast_ref::<arrow::array::BinaryArray>()
            .unwrap()
            .value(0),
        [0, 255, 97]
    );
    assert_eq!(
        b.column(3)
            .as_any()
            .downcast_ref::<DurationMicrosecondArray>()
            .unwrap()
            .value(0),
        -90_000_000_000
    );
    assert!(
        make_batch(
            &[native("b", "blob", false, 0, 0)],
            vec![vec![Some("é".into())]]
        )
        .is_err()
    );
}
#[test]
fn safe_typed_keysets_and_config() {
    assert_eq!(ident("a`b"), "`a``b`");
    assert_eq!(object("db.t`x").unwrap(), "`db`.`t``x`");
    let cols = vec![
        native("ts", "timestamp", false, 0, 0),
        native("id`", "bigint", true, 20, 0),
    ];
    let (sql, params) = page_query(
        &object("db.t").unwrap(),
        &cols,
        &cols,
        Some(&json!("2026-10-29T00:00:00")),
        Some(&json!(["2026-10-29T00:00:00", "9; DROP TABLE x"])),
        2,
    )
    .unwrap();
    assert!(sql.contains("(`ts`,`id```) > (CAST(? AS DATETIME(6)),CAST(? AS UNSIGNED))"));
    assert!(sql.contains("`ts` >= CAST(? AS DATETIME(6))"));
    assert!(!sql.contains("DROP"));
    assert_eq!(params.len(), 3);
    assert!(page_query("`t`", &cols, &cols, None, Some(&json!([null, 1])), 2).is_err());
    assert!(page_query("`t`", &cols, &cols, None, Some(&json!([1])), 2).is_err());
    let config = json!({"host":"localhost","database":"scratch","username":"reader"});
    assert!(build(&config, None).is_ok());
    for (key, value) in [
        ("password", json!("sensitive")),
        ("ssl_mode", json!("sensitive")),
        ("host", json!("reader:sensitive@host")),
        ("port", json!(65536)),
    ] {
        let mut bad = config.clone();
        bad[key] = value;
        assert!(
            !build(&bad, None)
                .err()
                .unwrap()
                .to_string()
                .contains("sensitive")
        );
    }
}
#[tokio::test]
async fn writes_require_source_flag_before_connecting() {
    let c = build(
        &json!({"host":"localhost","database":"scratch","username":"reader"}),
        Some("secret"),
    )
    .unwrap();
    assert!(
        c.advisor_execute("CREATE INDEX x ON t(id)")
            .await
            .unwrap_err()
            .to_string()
            .contains("writes are disabled")
    );
}
/// STRATON_TEST_MYSQL is JSON config for a prepopulated straton_scratch database;
/// its test password is supplied separately via STRATON_TEST_MYSQL_PASSWORD.
#[tokio::test]
async fn live_read_discovery_and_resume() {
    let Ok(target) = std::env::var("STRATON_TEST_MYSQL") else {
        return;
    };
    let mut config: Value =
        serde_json::from_str(&target).expect("test target must be JSON config without credentials");
    assert_eq!(config["database"], "straton_scratch");
    config["batch_size"] = json!(2);
    let secret = std::env::var("STRATON_TEST_MYSQL_PASSWORD").ok();
    let c = build(&config, secret.as_deref()).unwrap();
    c.check().await.unwrap();
    let datasets = c.discover().await.unwrap();
    let ds = datasets
        .iter()
        .find(|d| !d.metadata.is_view && d.columns.iter().any(|c| c.primary_key))
        .expect("scratch requires a table with PK and rows");
    assert!(!ds.metadata.indexes.is_empty());
    let batches = c
        .read(&ds.dataset.name, ReadOptions::default())
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert!(!batches.is_empty(), "scratch fixture must contain rows");
    let resumed = c
        .read(
            &ds.dataset.name,
            ReadOptions {
                cursor: Some(batches[0].1.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert_eq!(
        batches
            .iter()
            .skip(1)
            .map(|b| b.0.num_rows())
            .sum::<usize>(),
        resumed.iter().map(|b| b.0.num_rows()).sum::<usize>()
    );
    let keys = ds
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
    if let Some(w) = ds
        .columns
        .iter()
        .find(|c| c.data_type.starts_with("Int") || c.data_type.starts_with("UInt"))
    {
        let delta = c
            .read(
                &ds.dataset.name,
                ReadOptions {
                    incremental: Some(straton_core::IncrementalRead {
                        watermark_column: w.name.clone(),
                        lower_bound: None,
                        key_columns: keys,
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert_eq!(
            batches.iter().map(|b| b.0.num_rows()).sum::<usize>(),
            delta.iter().map(|b| b.0.num_rows()).sum::<usize>()
        );
    }
}
