use super::*;
#[test]
fn heterogeneous_flat_schema_and_coverage() {
    let docs = vec![
        doc! {"_id":bson::oid::ObjectId::new(),"n":1,"nullable":Bson::Null,"mixed":1,"address":{"city":"Pune","geo":{"lat":18}},"tags":[1,2]},
        doc! {"_id":bson::oid::ObjectId::new(),"n":Bson::Int64(9_007_199_254_740_993),"mixed":"two","active":true,"address":{"city":"Mumbai"},"tags":["x"]},
    ];
    let sample = infer("users", &docs).unwrap();
    let fields = &sample.schema.columns;
    let field = |name: &str| fields.iter().find(|c| c.name == name).unwrap();
    assert_eq!(field("n").data_type, "Int64");
    assert_eq!(field("mixed").data_type, "Utf8");
    assert_eq!(field("address.city").data_type, "Utf8");
    assert!(!field("address.city").nullable);
    assert_eq!(field("address.geo").data_type, "Utf8");
    assert!(field("address.geo").nullable);
    assert_eq!(field("tags").data_type, "Utf8");
    assert!(field("nullable").nullable);
    assert!(field("active").nullable);
    assert!(field("_id").primary_key);
    assert_eq!(field("_id").data_type, "Utf8");
    assert_eq!(sample.schema.metadata.sampled_documents, Some(2));
    assert_eq!(sample.schema.metadata.field_coverage["active"], 1);
    let b = make_batch(&sample.schema, &docs).unwrap();
    assert_eq!(b.num_rows(), 2);
    let empty = infer("empty", &[]).unwrap();
    assert_eq!(empty.schema.columns.len(), 1);
    assert!(empty.schema.columns[0].primary_key);
    assert!(flat(&doc! {"address":{"city":"a"},"address.city":"b"}).is_err());
}
#[test]
fn bson_types_dates_binary_and_precision() {
    let docs = vec![
        doc! {"_id":"a","date":bson::DateTime::from_millis(1_700_000_000_123),"flag":true,"bytes":Bson::Binary(bson::Binary{subtype:bson::spec::BinarySubtype::Generic,bytes:vec![0,255]}),"ratio":1.5,"decimal":bson::Decimal128::from_bytes([0;16])},
    ];
    let s = infer("values", &docs).unwrap();
    let b = make_batch(&s.schema, &docs).unwrap();
    assert_eq!(b.num_rows(), 1);
    assert_eq!(widen(&DataType::Int64, &DataType::Float64), DataType::Utf8);
    assert_eq!(
        widen(&DataType::Null, &DataType::Boolean),
        DataType::Boolean
    );
    for value in [
        Bson::Int64(i64::MAX),
        Bson::ObjectId(bson::oid::ObjectId::new()),
        Bson::DateTime(bson::DateTime::from_millis(1_700_000_000_123)),
        Bson::String("a\"} $gt x".into()),
    ] {
        assert_eq!(restore(&checkpoint(&value).unwrap()).unwrap(), value);
    }
}
#[test]
fn relationships_are_inferred_and_require_matching_bson_types() {
    let id = bson::oid::ObjectId::new();
    let mut samples = vec![
        infer("users", &[doc! {"_id":id}]).unwrap(),
        infer(
            "orders",
            &[
                doc! {"_id":1,"user_id":id,"userId":id},
                doc! {"_id":2,"user_id":id},
            ],
        )
        .unwrap(),
        infer("wrong", &[doc! {"_id":1,"user_id":id.to_hex()}]).unwrap(),
    ];
    infer_relationships(&mut samples);
    assert_eq!(samples[1].schema.relationships.len(), 2);
    assert!(samples[1].schema.relationships.iter().all(|r| matches!(
        r.kind,
        RelationshipKind::Inferred
    ) && r.to_dataset == "users"
        && r.to_cols == ["_id"]));
    assert_eq!(
        samples[1]
            .schema
            .relationships
            .iter()
            .find(|r| r.from_cols == ["userId"])
            .unwrap()
            .confidence,
        Some(0.45)
    );
    assert!(samples[2].schema.relationships.is_empty());
}
#[test]
fn safe_filters_and_command_documents() {
    let date = Bson::DateTime(bson::DateTime::from_millis(1_700_000_000_000));
    let id = Bson::ObjectId(bson::oid::ObjectId::new());
    let cursor = json!([checkpoint(&date).unwrap(), checkpoint(&id).unwrap()]);
    let q = filter(
        &["updatedAt".into(), "_id".into()],
        Some(&cursor),
        Some(&json!("2023-01-01T00:00:00Z")),
        "date",
    )
    .unwrap();
    let and = q.get_array("$and").unwrap();
    assert_eq!(and.len(), 2);
    let choices = and[1].as_document().unwrap().get_array("$or").unwrap();
    assert_eq!(choices.len(), 2);
    assert_eq!(
        choices[1]
            .as_document()
            .unwrap()
            .get_datetime("updatedAt")
            .unwrap(),
        &bson::DateTime::from_millis(1_700_000_000_000)
    );
    assert!(filter(&["_id".into()], Some(&json!([null])), None, "").is_err());
    assert!(filter(&["_id".into()], Some(&json!([])), None, "").is_err());
    assert_eq!(
        lower_bound(&json!(id.as_object_id().unwrap().to_hex()), "object_id").unwrap(),
        id
    );
    let create=json!({"createIndexes":"odd\"collection","indexes":[{"key":{"a\"field":1},"name":"ix_straton_123"}]}).to_string();
    assert_eq!(
        advisor::command(&create)
            .unwrap()
            .get_str("createIndexes")
            .unwrap(),
        "odd\"collection"
    );
    assert!(
        advisor::command(&json!({"dropIndexes":"orders","index":"ix_straton_123"}).to_string())
            .is_ok()
    );
    for bad in [
        json!({"dropDatabase":1}),
        json!({"dropIndexes":"orders","index":"*"}),
        json!({"createIndexes":"orders","indexes":[{"key":{"$where":1},"name":"ix_straton_x"}]}),
        json!({"createIndexes":"orders","indexes":[{"key":{"id":1},"name":"ix_straton_x","unique":true}]}),
    ] {
        assert!(advisor::command(&bad.to_string()).is_err());
    }
}
#[tokio::test]
async fn config_and_write_gate() {
    for config in [
        json!({"host":"localhost","database":"scratch"}),
        json!({"hosts":["localhost:27017","127.0.0.1:27018"],"database":"scratch"}),
        json!({"host":"mongodb+srv://example.net","database":"scratch"}),
    ] {
        let c = build(&config, None).unwrap();
        assert!(
            c.advisor_execute("{}")
                .await
                .unwrap_err()
                .to_string()
                .contains("writes are disabled")
        );
    }
    for config in [
        json!({"host":"mongodb+srv://u:sensitive@example.net","database":"scratch"}),
        json!({"host":"localhost","database":"scratch","password":"sensitive"}),
        json!({"hosts":[],"database":"scratch"}),
        json!({"host":"localhost","hosts":["other"],"database":"scratch"}),
        json!({"host":"localhost","database":"scratch","sample_size":0}),
    ] {
        assert!(
            !build(&config, None)
                .err()
                .unwrap()
                .to_string()
                .contains("sensitive")
        );
    }
}
/// STRATON_TEST_MONGODB is JSON config for prepopulated straton_scratch;
/// authenticated fixtures use STRATON_TEST_MONGODB_PASSWORD separately.
#[tokio::test]
async fn live_discovery_and_checkpoint_resume() {
    let Ok(target) = std::env::var("STRATON_TEST_MONGODB") else {
        return;
    };
    let mut config: Value =
        serde_json::from_str(&target).expect("test target must be JSON config without credentials");
    assert_eq!(config["database"], "straton_scratch");
    config["batch_size"] = json!(2);
    let secret = std::env::var("STRATON_TEST_MONGODB_PASSWORD").ok();
    let c = build(&config, secret.as_deref()).unwrap();
    c.check().await.unwrap();
    let datasets = c.discover().await.unwrap();
    let ds = datasets
        .iter()
        .find(|d| !d.metadata.is_view && d.metadata.sampled_documents.unwrap_or(0) > 0)
        .expect("scratch fixture requires documents");
    assert!(!ds.metadata.indexes.is_empty());
    assert!(ds.metadata.field_coverage.contains_key("_id"));
    let batches = c
        .read(&ds.dataset.name, ReadOptions::default())
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert!(!batches.is_empty());
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
    let key = batches[0].1[0].clone();
    if matches!(restore(&key).unwrap(), Bson::ObjectId(_)) {
        let lower = batches[0]
            .0
            .column(ds.columns.iter().position(|c| c.name == "_id").unwrap())
            .as_any()
            .downcast_ref::<arrow::array::StringArray>()
            .unwrap()
            .value(0)
            .to_owned();
        let delta = c
            .read(
                &ds.dataset.name,
                ReadOptions {
                    incremental: Some(straton_core::IncrementalRead {
                        watermark_column: "_id".into(),
                        lower_bound: Some(json!(lower)),
                        key_columns: vec!["_id".into()],
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
