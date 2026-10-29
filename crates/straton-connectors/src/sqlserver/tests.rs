use super::*;
use arrow::array::{Decimal128Array, FixedSizeBinaryArray};

fn native(name: &str, typ: &str, precision: u8, scale: u8) -> NativeColumn {
    NativeColumn {
        column: column(name.into(), arrow_type(typ, precision, scale), true, false),
        typ: typ.into(),
        precision,
        scale,
        max_length: 40,
    }
}

#[test]
fn sqlserver_types_and_arrow_values() {
    for (typ, expected) in [
        ("tinyint", DataType::UInt8),
        ("smallint", DataType::Int16),
        ("int", DataType::Int32),
        ("bigint", DataType::Int64),
        ("bit", DataType::Boolean),
        ("real", DataType::Float32),
        ("float", DataType::Float64),
        ("decimal", DataType::Decimal128(38, 10)),
        ("numeric", DataType::Decimal128(38, 10)),
        ("money", DataType::Decimal128(19, 4)),
        ("smallmoney", DataType::Decimal128(10, 4)),
        ("date", DataType::Date32),
        ("datetime", DataType::Timestamp(TimeUnit::Microsecond, None)),
        ("datetime2", DataType::Timestamp(TimeUnit::Nanosecond, None)),
        (
            "datetimeoffset",
            DataType::Timestamp(TimeUnit::Nanosecond, Some("+00:00".into())),
        ),
        ("time", DataType::Time64(TimeUnit::Nanosecond)),
        ("timestamp", DataType::FixedSizeBinary(8)),
        ("rowversion", DataType::FixedSizeBinary(8)),
        ("binary", DataType::Binary),
        ("varbinary", DataType::Binary),
        ("image", DataType::Binary),
        ("uniqueidentifier", DataType::Utf8),
        ("xml", DataType::Utf8),
        ("char", DataType::Utf8),
        ("varchar", DataType::Utf8),
        ("nchar", DataType::Utf8),
        ("nvarchar", DataType::Utf8),
        ("text", DataType::Utf8),
        ("ntext", DataType::Utf8),
    ] {
        assert_eq!(arrow_type(typ, 38, 10), expected, "{typ}");
    }
    let columns = vec![
        native("amount", "decimal", 38, 10),
        native("version", "rowversion", 0, 0),
    ];
    let b = arrow_batch(
        &columns,
        vec![
            vec![Some("1234567890123456789012345678.1234567890".into()), None],
            vec![Some("00000000000000FF".into()), None],
        ],
    )
    .unwrap();
    assert_eq!(
        b.column(0)
            .as_any()
            .downcast_ref::<Decimal128Array>()
            .unwrap()
            .value(0),
        12345678901234567890123456781234567890_i128
    );
    assert_eq!(
        b.column(1)
            .as_any()
            .downcast_ref::<FixedSizeBinaryArray>()
            .unwrap()
            .value(0),
        &[0, 0, 0, 0, 0, 0, 0, 255]
    );
    assert_eq!(b.column(1).null_count(), 1);
    for (typ, value) in [
        ("bit", "1"),
        ("date", "2026-10-29"),
        ("datetime2", "2026-10-29T12:34:56.1234567"),
        ("datetimeoffset", "2026-10-29T12:34:56.1234567+05:30"),
        ("time", "12:34:56.1234567"),
        ("varbinary", "00FF10"),
        ("nvarchar", "こんにちは"),
    ] {
        let b = arrow_batch(
            &[native(
                "v",
                typ,
                0,
                if typ == "datetime2" || typ == "datetimeoffset" {
                    7
                } else {
                    0
                },
            )],
            vec![vec![Some(value.into()), None]],
        )
        .unwrap_or_else(|e| panic!("{typ}: {e}"));
        assert_eq!(b.column(0).null_count(), 1);
    }
    assert!(decode_hex("0").is_err());
    assert!(decode_hex("ZZ").is_err());
    assert!(
        arrow_batch(
            &[native("v", "rowversion", 0, 0)],
            vec![vec![Some("00".into())]]
        )
        .is_err()
    );
    let empty = arrow_batch(&columns, vec![vec![], vec![]]).unwrap();
    assert_eq!(empty.num_rows(), 0);
    assert_eq!(
        empty.schema().field(1).data_type(),
        &DataType::FixedSizeBinary(8)
    );
    assert!(straton_core::eligible_watermark("FixedSizeBinary(8)"));
}

#[test]
fn sqlserver_sql_generation_binds_values_and_escapes_identifiers() {
    assert_eq!(ident("a]; DROP TABLE x;--"), "[a]]; DROP TABLE x;--]");
    let order = vec![
        native("version", "rowversion", 0, 0),
        native("id]", "int", 10, 0),
    ];
    let mut values = vec![];
    let sql = keyset(
        &order,
        &[json!("00000000000000FF"), json!("1; DROP TABLE x")],
        &mut values,
    )
    .unwrap();
    assert_eq!(
        sql,
        "(([version] > CONVERT(varbinary(max), @P1, 2)) OR ([version] = CONVERT(varbinary(max), @P1, 2) AND [id]]] > CONVERT(int, @P2, 126)))"
    );
    assert_eq!(values, ["00000000000000FF", "1; DROP TABLE x"]);
    assert!(!sql.contains("DROP"));
    let mut shifted = vec!["upper-fence".into(), "lower-bound".into()];
    let sql = keyset(&order, &[json!("00000000000000FF"), json!(1)], &mut shifted).unwrap();
    assert!(sql.contains("@P3"));
    assert!(sql.contains("@P4"));
    assert!(!sql.contains("@P1"));
    assert!(keyset(&order, &[Value::Null, json!(1)], &mut vec![]).is_err());
    assert!(keyset(&order, &[json!(1)], &mut vec![]).is_err());
    assert_eq!(
        native("v", "numeric", 30, 12).parameter(3).unwrap(),
        "CONVERT(decimal(30,12), @P3, 126)"
    );
    assert!(native("v", "sql_variant", 0, 0).parameter(1).is_err());
    assert_eq!(
        native("rv]", "timestamp", 0, 0).watermark_fence().unwrap(),
        "[rv]]] < CONVERT(varbinary(max), @P1, 2)"
    );
    assert!(native("v", "int", 0, 0).watermark_fence().is_none());
    assert_eq!(
        native("v", "nvarchar", 0, 0).parameter(1).unwrap(),
        "CONVERT(nvarchar(20), @P1, 126)"
    );
    assert_eq!(
        native("v", "money", 19, 4).select(),
        "CONVERT(nvarchar(max), [v], 2)"
    );
    assert_eq!(
        native("v", "float", 0, 0).select(),
        "CONVERT(nvarchar(max), [v], 3)"
    );
}

#[test]
fn sqlserver_config_defaults_and_secret_boundary() {
    let value = json!({"host":"localhost","database":"scratch","auth":"sql","username":"reader"});
    let config: SqlserverConfig = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(config.port, 1433);
    assert!(config.encrypt);
    assert!(!config.trust_server_certificate);
    config.validate().unwrap();
    assert!(build(&value, None).is_ok());
    for (key, value) in [
        ("password", json!("sensitive")),
        ("port", json!(65536)),
        ("auth", json!("sensitive")),
        ("encrypt", json!("false")),
        ("trust_server_certificate", json!("true")),
    ] {
        let mut bad =
            json!({"host":"localhost","database":"scratch","auth":"sql","username":"reader"});
        bad[key] = value;
        let message = build(&bad, None).err().unwrap().to_string();
        assert!(!message.contains("sensitive"));
    }
    let auth = format!("{:?}", AuthMethod::sql_server("reader", "never-log-this"));
    assert!(!auth.contains("never-log-this"));
    assert!(browser_port(&[]).is_err());
    let body = b"ServerName;HOST;InstanceName;SQLEXPRESS;tcp;1433;";
    let mut response = vec![5, body.len() as u8, 0];
    response.extend_from_slice(body);
    assert_eq!(browser_port(&response).unwrap(), 1433);
}

#[tokio::test]
async fn sqlserver_live_read_only() {
    let Ok(target) = std::env::var("STRATON_TEST_SQLSERVER") else {
        return;
    };
    let url = reqwest::Url::parse(&format!("sqlserver://{target}")).unwrap();
    assert_eq!(
        url.path().trim_start_matches('/'),
        "straton_scratch",
        "live tests are limited to the scratch database"
    );
    let mut config = json!({
        "host":url.host_str().unwrap(), "port":url.port().unwrap_or(1433),
        "database":"straton_scratch", "auth":"windows", "batch_size":2,
    });
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "auth" | "instance" | "username" => config[key.as_ref()] = json!(value),
            "encrypt" | "trust_server_certificate" => {
                config[key.as_ref()] = json!(value.parse::<bool>().unwrap())
            }
            _ => panic!("unsupported SQL Server test option"),
        }
    }
    let secret = std::env::var("STRATON_TEST_SQLSERVER_PASSWORD").ok();
    let connector = build(&config, secret.as_deref()).unwrap();
    connector.check().await.unwrap();
    let datasets = connector.discover().await.unwrap();
    for name in [
        "sales.customers",
        "sales.products",
        "sales.orders",
        "sales.order_items",
        "sales.v_customer_revenue",
    ] {
        assert!(
            datasets.iter().any(|d| d.dataset.name == name),
            "missing {name}"
        );
    }
    for (from, to) in [
        ("sales.orders", "sales.customers"),
        ("sales.order_items", "sales.orders"),
        ("sales.order_items", "sales.products"),
    ] {
        let ds = datasets.iter().find(|d| d.dataset.name == from).unwrap();
        assert!(
            ds.relationships
                .iter()
                .any(|r| r.to_dataset == to && matches!(r.kind, RelationshipKind::DeclaredFk)),
            "missing {from} -> {to}"
        );
    }
    let view = datasets
        .iter()
        .find(|d| d.dataset.name == "sales.v_customer_revenue")
        .unwrap();
    assert!(view.metadata.is_view);
    assert!(view.metadata.definition.is_some());
    assert!(
        view.relationships
            .iter()
            .any(|r| matches!(r.kind, RelationshipKind::Lineage))
    );
    let orders = datasets
        .iter()
        .find(|d| d.dataset.name == "sales.orders")
        .unwrap();
    assert!(!orders.metadata.indexes.is_empty());
    assert!(orders.metadata.approximate_rows.is_some());
    let mut stream = connector
        .read("sales.orders", ReadOptions::default())
        .await
        .unwrap();
    let (first, cursor) = stream
        .next()
        .await
        .expect("scratch orders must contain rows")
        .unwrap();
    let mut total = first.num_rows();
    while let Some(batch) = stream.next().await {
        total += batch.unwrap().0.num_rows();
    }
    drop(stream);
    let mut resumed = connector
        .read(
            "sales.orders",
            ReadOptions {
                cursor: Some(cursor.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut rest = 0;
    while let Some(batch) = resumed.next().await {
        rest += batch.unwrap().0.num_rows();
    }
    assert_eq!(total, first.num_rows() + rest);
    drop(resumed);
    // Exercise the inclusive watermark boundary and runner-compatible [watermark, keys...] cursor.
    let keys = orders
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
    let wm = keys
        .first()
        .expect("orders must have a primary key")
        .clone();
    let mut delta = connector
        .read(
            "sales.orders",
            ReadOptions {
                incremental: Some(straton_core::IncrementalRead {
                    watermark_column: wm,
                    lower_bound: Some(cursor[0].clone()),
                    key_columns: keys,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut delta_rows = 0;
    while let Some(batch) = delta.next().await {
        delta_rows += batch.unwrap().0.num_rows();
    }
    assert!(delta_rows >= rest);
}
