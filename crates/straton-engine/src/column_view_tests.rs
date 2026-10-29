use super::*;
use std::collections::{BTreeMap, BTreeSet};
use straton_core::{Column, Dataset, DatasetMetadata, DatasetSchema};

async fn imported_views(
    f: &Fixture,
    dialect: &str,
) -> (Vec<DatasetSchema>, BTreeMap<String, String>) {
    let definition = "CREATE VIEW sales.revenue AS SELECT c.customer_id, c.region, SUM(i.quantity * i.unit_price) AS revenue FROM sales.customers c JOIN sales.orders o ON o.customer_id = c.customer_id JOIN sales.order_items i ON i.order_id = o.order_id WHERE o.status = 'paid' GROUP BY c.customer_id, c.region";
    let definition = definition.replace(
        "sales.",
        if dialect == "mysql" {
            "`sales`."
        } else {
            "[sales]."
        },
    );
    let schemas: Vec<_> = [
        (
            "sales.customers",
            vec![("customer_id", "Int64"), ("region", "Utf8")],
        ),
        (
            "sales.orders",
            vec![
                ("order_id", "Int64"),
                ("customer_id", "Int64"),
                ("status", "Utf8"),
            ],
        ),
        (
            "sales.order_items",
            vec![
                ("order_id", "Int64"),
                ("quantity", "Int64"),
                ("unit_price", "Int64"),
            ],
        ),
        (
            "sales.revenue",
            vec![
                ("customer_id", "Int64"),
                ("region", "Utf8"),
                ("revenue", "Int64"),
            ],
        ),
    ]
    .into_iter()
    .map(|(name, columns)| DatasetSchema {
        dataset: Dataset {
            id: String::new(),
            source_id: "source".into(),
            name: name.into(),
        },
        columns: columns
            .into_iter()
            .map(|(name, data_type)| Column {
                id: String::new(),
                dataset_id: String::new(),
                name: name.into(),
                data_type: data_type.into(),
                nullable: true,
                primary_key: false,
            })
            .collect(),
        relationships: vec![],
        metadata: DatasetMetadata {
            is_view: name == "sales.revenue",
            definition: (name == "sales.revenue").then(|| definition.clone()),
            dialect: Some(dialect.into()),
            ..Default::default()
        },
    })
    .collect();
    let mut tx = f.pool.begin().await.unwrap();
    let mut ids = BTreeMap::new();
    for schema in &schemas {
        ids.insert(
            schema.dataset.name.clone(),
            crate::catalog::upsert(&mut tx, "source", schema)
                .await
                .unwrap(),
        );
    }
    crate::column_lineage::discover_views(&mut tx, &schemas, &ids)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (schemas, ids)
}

fn expected_usage() -> BTreeSet<(String, String, String)> {
    [
        ("sales.customers", "customer_id", "join_key"),
        ("sales.orders", "customer_id", "join_key"),
        ("sales.orders", "order_id", "join_key"),
        ("sales.order_items", "order_id", "join_key"),
        ("sales.orders", "status", "filter"),
        ("sales.customers", "customer_id", "group_key"),
        ("sales.customers", "region", "group_key"),
    ]
    .into_iter()
    .map(|(d, c, k)| (d.into(), c.into(), k.into()))
    .collect()
}

#[tokio::test]
async fn stored_sqlserver_and_mysql_views_record_base_column_usage() {
    for dialect in ["sqlserver", "mysql"] {
        let f = Fixture::new().await;
        let (mut schemas, ids) = imported_views(&f, dialect).await;
        let view = &ids["sales.revenue"];
        let rows = sqlx::query("SELECT d.name,l.* FROM column_lineage l JOIN datasets d ON d.id=l.source_dataset_id WHERE l.target_dataset_id=? AND l.kind IN ('join_key','filter','group_key')")
            .bind(view).fetch_all(&f.pool).await.unwrap();
        let actual = rows
            .iter()
            .map(|r| {
                assert_eq!(r.get::<&str, _>("view_dataset_id"), view);
                assert!(r.get::<Option<String>, _>("model_id").is_none());
                (r.get("name"), r.get("source_column"), r.get("kind"))
            })
            .collect();
        assert_eq!(expected_usage(), actual, "{dialect}");
        assert!(
            !sqlx::query_scalar::<_, bool>("SELECT lineage_incomplete FROM datasets WHERE id=?")
                .bind(view)
                .fetch_one(&f.pool)
                .await
                .unwrap()
        );
        schemas.last_mut().unwrap().metadata.definition = Some(
            schemas
                .last()
                .unwrap()
                .metadata
                .definition
                .as_ref()
                .unwrap()
                .replace("o.customer_id = c.customer_id", "o.missing = c.customer_id"),
        );
        let mut tx = f.pool.begin().await.unwrap();
        crate::column_lineage::discover_views(&mut tx, &schemas, &ids)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM column_lineage WHERE target_dataset_id=?"
            )
            .bind(view)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
            0,
            "unresolvable references must clear stale edges and usage: {dialect}"
        );
        assert!(
            sqlx::query_scalar::<_, bool>("SELECT lineage_incomplete FROM datasets WHERE id=?")
                .bind(view)
                .fetch_one(&f.pool)
                .await
                .unwrap()
        );
        f.close().await;
    }
}

#[tokio::test]
async fn columns_api_reports_view_usage_with_dataset_identity() {
    for dialect in ["sqlserver", "mysql"] {
        let f = Fixture::new().await;
        let (_, ids) = imported_views(&f, dialect).await;
        let a = app(&f);
        for (dataset, column, role) in expected_usage() {
            let id = &ids[&dataset];
            let (status, graph) = request(
                &a,
                "GET",
                &format!("/v1/lineage/columns?dataset={id}&column={column}&depth=0"),
                json!(null),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{graph}");
            assert!(
                graph["usage"].as_array().unwrap().contains(&json!({
                    "dataset_id": id,
                    "column": column,
                    "role": role,
                    "in": {"kind": "view", "id": ids["sales.revenue"], "name": "sales.revenue"}
                })),
                "{dialect}: {graph}"
            );
            assert!(graph["edges"].as_array().unwrap().is_empty(), "{graph}");
        }
        let role = access_role(&a, "base tables only").await;
        access_grant(&a, &role, "dataset", &ids["sales.customers"], "read").await;
        let (_, token) = access_user(&a, "base table reader", &[&role]).await;
        let (status, graph) = request_as(
            &a,
            &token,
            "GET",
            &format!(
                "/v1/lineage/columns?dataset={}&column=customer_id",
                ids["sales.customers"]
            ),
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{graph}");
        assert!(graph["usage"].as_array().unwrap().is_empty(), "{graph}");
        drop(a);
        f.close().await;
    }
}
