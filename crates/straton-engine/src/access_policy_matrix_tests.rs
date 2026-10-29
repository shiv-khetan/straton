use super::*;

async fn restricted_reader(
    a: &axum::Router,
    dataset: &str,
    name: &str,
) -> (String, String, String) {
    let role = access_role(a, name).await;
    access_grant(a, &role, "dataset", dataset, "read").await;
    let (user, token) = access_user(a, name, &[&role]).await;
    for (suffix, body) in [
        (format!("row-filters/{role}"), json!({"predicate":"id = 2"})),
        (format!("masks/{role}/name"), json!({"kind":"redact"})),
    ] {
        let (s, v) = request(a, "PUT", &format!("/v1/datasets/{dataset}/{suffix}"), body).await;
        assert_eq!(s, StatusCode::OK, "{v}");
    }
    (user, role, token)
}

#[tokio::test]
async fn row_filters_and_masks_match_across_every_read_surface() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let dataset = dataset_id(&f, "users").await;
    let (_, _, token) = restricted_reader(&a, &dataset, "matrix").await;
    let (s,chart) = request(&a,"POST","/v1/charts",json!({"name":"Matrix","sql":"SELECT id,name FROM app_db.users ORDER BY id","kind":"table","config":{"x":"id","y":["id"]},"shared":true})).await;
    assert_eq!(s, StatusCode::CREATED, "{chart}");
    let chart_id = chart["id"].as_str().unwrap();
    for (actor, expected) in [
        ("good-token", json!([[1, "Alice"], [2, "Bob"]])),
        (token.as_str(), json!([[2, "***"]])),
    ] {
        for (path, body) in [
            (
                "/v1/sql".to_owned(),
                json!({"query":"SELECT id,name FROM app_db.users ORDER BY id"}),
            ),
            (
                "/v1/explorer/rows".to_owned(),
                json!({"schema":"app_db","table":"users","sort":[{"column":"id","dir":"asc"}],"columns":["id","name"]}),
            ),
            (
                "/v1/charts/preview".to_owned(),
                json!({"sql":"SELECT id,name FROM app_db.users ORDER BY id","config":{}}),
            ),
            (format!("/v1/charts/{chart_id}/data"), json!({})),
        ] {
            let (s, v) = request_as(&a, actor, "POST", &path, body).await;
            assert_eq!(s, StatusCode::OK, "{path}: {v}");
            keys(&v, &["columns", "rows"]);
            assert_eq!(v["rows"], expected, "{actor} {path}: {v}");
        }
        for (id, expected) in [
            (
                1,
                if actor == "good-token" {
                    json!([[1, "Alice"]])
                } else {
                    json!([])
                },
            ),
            (
                2,
                if actor == "good-token" {
                    json!([[2, "Bob"]])
                } else {
                    json!([[2, "***"]])
                },
            ),
        ] {
            let (s, v) = request_as(
                &a,
                actor,
                "POST",
                &format!("/v1/charts/{chart_id}/drill"),
                json!({"x_value":id}),
            )
            .await;
            assert_eq!(s, StatusCode::OK, "{v}");
            assert_eq!(v["rows"], expected);
        }
        for format in ["csv", "parquet"] {
            let response=a.clone().oneshot(Request::builder().method("POST").uri("/v1/explorer/export")
                .header("authorization",format!("Bearer {actor}")).header("content-type","application/json")
                .body(Body::from(json!({"schema":"app_db","table":"users","columns":["id","name"],"sort":[{"column":"id","dir":"asc"}],"format":format}).to_string())).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            if format == "csv" {
                let csv = String::from_utf8(bytes.to_vec()).unwrap();
                if actor == "good-token" {
                    assert!(csv.contains("Alice"));
                    assert!(csv.contains("Bob"));
                    assert_eq!(csv.lines().count(), 3);
                } else {
                    assert!(!csv.contains("Alice"));
                    assert!(!csv.contains("Bob"));
                    assert!(csv.contains("***"));
                    assert_eq!(csv.lines().count(), 2);
                }
            } else {
                let output = f.dir.join(format!("export-{}.parquet", store::id()));
                std::fs::write(&output, &bytes).unwrap();
                let reader = crate::keys::reader(&output, None).unwrap().build().unwrap();
                let batches = reader.map(Result::unwrap).collect::<Vec<_>>();
                assert_eq!(
                    batches.iter().map(|b| b.num_rows()).sum::<usize>(),
                    if actor == "good-token" { 2 } else { 1 }
                );
                if actor != "good-token" {
                    let names = batches[0]
                        .column(1)
                        .as_any()
                        .downcast_ref::<datafusion::arrow::array::StringArray>()
                        .unwrap();
                    assert_eq!(names.value(0), "***");
                }
            }
        }
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn quality_uses_check_owner_policies_even_when_triggered_by_admin() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let dataset = dataset_id(&f, "users").await;
    let (owner, _, token) = restricted_reader(&a, &dataset, "quality owner").await;
    let (_, stranger) = access_user(&a, "unrelated", &[]).await;
    let (s,check)=request_as(&a,&token,"POST","/v1/quality/checks",json!({"name":"owner count","dataset_id":dataset,"kind":"row_count","config":{"min":1,"max":1},"severity":"error"})).await;
    assert_eq!(s, StatusCode::CREATED, "{check}");
    assert_eq!(check["owner_id"], owner);
    let endpoint = format!("/v1/quality/checks/{}", check["id"].as_str().unwrap());
    for actor in [&token, "good-token"] {
        let (s, v) = request_as(&a, actor, "POST", &format!("{endpoint}/run"), json!(null)).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["observed"], 1.0);
        assert_eq!(v["status"], "passed");
    }
    // The engine answers 403 for checks the caller cannot read.
    assert_eq!(
        request_as(&a, &stranger, "GET", &endpoint, json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request_as(&a, &stranger, "GET", "/v1/quality/runs", json!(null))
            .await
            .1,
        json!([])
    );
    let (_, history) =
        request_as(&a, &token, "GET", &format!("{endpoint}/runs"), json!(null)).await;
    assert_eq!(history.as_array().unwrap().len(), 2);
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn lineage_hides_masked_expressions_without_hiding_unmasked_fields() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let dataset = dataset_id(&f, "users").await;
    let (_, role, token) = restricted_reader(&a, &dataset, "lineage matrix").await;
    access_grant(&a, &role, "source", "straton-models", "read").await;
    create_model(
        &a,
        "matrix_names",
        "SELECT id,upper(name) AS label FROM app_db.users",
        "view",
        "manual",
    )
    .await;
    let target: String = sqlx::query_scalar(
        "SELECT id FROM datasets WHERE source_id='straton-models' AND name='matrix_names'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    for (column, masked) in [("label", true), ("id", false)] {
        let path =
            format!("/v1/lineage/columns?dataset={target}&column={column}&direction=upstream");
        for (actor, hidden) in [("good-token", false), (token.as_str(), masked)] {
            let (s, v) = request_as(&a, actor, "GET", &path, json!(null)).await;
            assert_eq!(s, StatusCode::OK, "{v}");
            keys(&v, &["nodes", "edges", "usage", "incomplete"]);
            let edges = v["edges"].as_array().unwrap();
            assert!(!edges.is_empty(), "{v}");
            // Passthrough hops carry no expression for anyone; only transforms can be hidden.
            assert!(
                edges
                    .iter()
                    .all(|e| e["kind"] == "passthrough" || e["expression"].is_null() == hidden),
                "{column} {v}"
            );
        }
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn activity_and_notification_visibility_isolated_between_users() {
    let f = Fixture::new().await;
    let a = app(&f);
    let role = access_role(&a, "visibility").await;
    access_grant(&a, &role, "source", "source", "read").await;
    let (u1, t1) = access_user(&a, "first", &[&role]).await;
    let (u2, t2) = access_user(&a, "second", &[&role]).await;
    for (user, token) in [(&u1, &t1), (&u2, &t2)] {
        let (s, _) = request_as(
            &a,
            token,
            "POST",
            "/v1/saved-queries",
            json!({"name":user,"sql":"SELECT 'sensitive value'"}),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED);
        crate::notify::emit(
            &f.pool,
            &f.events,
            crate::notify::Notice {
                severity: "info",
                kind: "matrix",
                title: "private",
                entity_kind: "user",
                entity_id: user,
                user_id: Some(user),
            },
        )
        .await
        .unwrap();
    }
    for (user, token, other) in [(&u1, &t1, &u2), (&u2, &t2, &u1)] {
        let (s, rows) = request_as(
            &a,
            token,
            "GET",
            "/v1/activity?action_prefix=saved_query",
            json!(null),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["actor_id"], *user);
        assert!(!rows.to_string().contains("sensitive value"));
        assert_eq!(
            request_as(
                &a,
                token,
                "GET",
                &format!("/v1/activity?actor={other}"),
                json!(null)
            )
            .await
            .1,
            json!([])
        );
        let (s, notices) = request_as(&a, token, "GET", "/v1/notifications", json!(null)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(notices.as_array().unwrap().len(), 1);
        assert_eq!(notices[0]["entity_id"], *user);
    }
    let (_, foreign) = request_as(&a, &t2, "GET", "/v1/notifications", json!(null)).await;
    request_as(
        &a,
        &t1,
        "POST",
        "/v1/notifications/read",
        json!({"ids":[foreign[0]["id"]]}),
    )
    .await;
    for token in [&t1, &t2] {
        assert_eq!(
            request_as(
                &a,
                token,
                "GET",
                "/v1/notifications/unread-count",
                json!(null)
            )
            .await
            .1["count"],
            1
        );
    }
    request_as(
        &a,
        &t1,
        "POST",
        "/v1/notifications/read",
        json!({"all":true}),
    )
    .await;
    assert_eq!(
        request_as(
            &a,
            &t1,
            "GET",
            "/v1/notifications/unread-count",
            json!(null)
        )
        .await
        .1["count"],
        0
    );
    assert_eq!(
        request_as(
            &a,
            &t2,
            "GET",
            "/v1/notifications/unread-count",
            json!(null)
        )
        .await
        .1["count"],
        1
    );
    let (_, all) = request(
        &a,
        "GET",
        "/v1/activity?action_prefix=saved_query",
        json!(null),
    )
    .await;
    assert_eq!(all.as_array().unwrap().len(), 2);
    drop(a);
    f.close().await;
}
