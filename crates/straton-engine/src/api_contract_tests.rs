//! Isolated HTTP contract suite; fixture code follows the existing engine tests.
include!("contract_test_support.rs");
#[path = "access_policy_matrix_tests.rs"]
mod access_policy_matrix_tests;

fn keys(value: &serde_json::Value, required: &[&str]) {
    for key in required {
        assert!(value.get(key).is_some(), "missing {key}: {value}");
    }
}

#[tokio::test]
async fn every_v1_method_requires_auth_before_extracting_inputs() {
    let f = Fixture::new().await;
    let a = app(&f);
    for (method, template) in ROUTES {
        let path = template
            .replace("{id}", "missing")
            .replace("{role}", "missing")
            .replace("{column}", "id")
            .replace("{target}", "missing")
            .replace("{token}", "missing")
            .replace("{query_id}", "missing")
            .replace("{tag}", "pii");
        for token in [None, Some("invalid-token")] {
            let mut req = Request::builder()
                .method(*method)
                .uri(&path)
                .header("content-type", "application/json");
            if let Some(token) = token {
                req = req.header("authorization", format!("Bearer {token}"));
            }
            let response = a
                .clone()
                .oneshot(req.body(Body::from("{malformed")).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
            assert_eq!(response.headers()["content-type"], "application/json");
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                value,
                json!({"error":"invalid bearer token"}),
                "{method} {path}"
            );
        }
    }
    drop(a);
    f.close().await;
}

#[test]
fn route_inventory_covers_each_registered_method() {
    let mut actual = std::collections::BTreeSet::new();
    for source in API_SOURCES {
        let routes = source.split("\nasync fn").next().unwrap();
        for route in routes.split(".route(").skip(1) {
            let mut parts = route.split('"');
            parts.next();
            let path = parts.next().unwrap();
            if !path.starts_with("/v1/") {
                continue;
            }
            let expression = parts.collect::<Vec<_>>().join("\"");
            for method in ["get", "post", "put", "delete"] {
                if expression.contains(&format!("{method}(")) {
                    actual.insert((method.to_uppercase(), path.to_owned()));
                }
            }
        }
    }
    let expected = ROUTES
        .iter()
        .map(|(m, p)| (m.to_string(), p.to_string()))
        .collect();
    assert_eq!(
        actual, expected,
        "register new routes in the auth contract table"
    );
}

#[tokio::test]
async fn admin_only_routes_reject_authenticated_readers_before_validation() {
    let f = Fixture::new().await;
    let a = app(&f);
    let role = access_role(&a, "contract reader").await;
    access_grant(&a, &role, "source", "source", "read").await;
    let (_, token) = access_user(&a, "reader", &[&role]).await;
    for (method, template) in ROUTES.iter().filter(|(_, p)| {
        [
            "/v1/users",
            "/v1/roles",
            "/v1/grants",
            "/v1/datasets/",
            "/v1/policies/",
            "/v1/sources",
            "/v1/relationships",
            "/v1/backups",
            "/v1/admin/",
            "/v1/audit/",
            "/v1/advisor",
            "/v1/optimizer",
        ]
        .iter()
        .any(|prefix| p.starts_with(prefix))
    }) {
        let path = template
            .replace("{id}", "missing")
            .replace("{role}", "missing")
            .replace("{column}", "id")
            .replace("{target}", "missing")
            .replace("{token}", "missing");
        let (status, body) = request_as(&a, &token, method, &path, json!({})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
        assert_eq!(body, json!({"error":"forbidden"}));
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn collection_and_system_success_shapes() {
    let f = Fixture::new().await;
    let a = app(&f);
    for path in [
        "/v1/users",
        "/v1/roles",
        "/v1/grants",
        "/v1/sources",
        "/v1/jobs",
        "/v1/runs",
        "/v1/backups",
        "/v1/models",
        "/v1/pipelines",
        "/v1/quality/checks",
        "/v1/quality/runs",
        "/v1/activity",
        "/v1/notifications",
        "/v1/charts",
        "/v1/dashboards",
        "/v1/saved-queries",
        "/v1/admin/keys",
    ] {
        let (status, body) = request(&a, "GET", path, json!(null)).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(body.is_array(), "{path}: {body}");
    }
    for (path, required) in [
        ("/v1/me", vec!["user", "roles", "privileges"]),
        (
            "/v1/status",
            vec![
                "version",
                "uptime_seconds",
                "queue_depth",
                "encryption_enabled",
                "audit_head",
                "last_backup",
            ],
        ),
        ("/v1/datamap", vec!["nodes", "edges"]),
        ("/v1/sql/tables", vec!["tables"]),
        ("/v1/notifications/unread-count", vec!["count"]),
        (
            "/v1/quality/summary",
            vec!["score", "counts", "datasets", "daily"],
        ),
        ("/v1/advisor", vec!["recommendations", "sources"]),
        ("/v1/audit/verify", vec!["ok"]),
        (
            "/v1/admin/auth-failures",
            vec!["window_secs", "threshold", "addresses"],
        ),
    ] {
        let (status, body) = request(&a, "GET", path, json!(null)).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        keys(&body, &required);
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn missing_entities_have_stable_error_contracts() {
    let f = Fixture::new().await;
    let a = app(&f);
    for path in [
        "/v1/users/missing",
        "/v1/roles/missing",
        "/v1/grants/missing",
        "/v1/sources/missing",
        "/v1/jobs/missing",
        "/v1/models/missing",
        "/v1/pipelines/missing",
        "/v1/pipeline-runs/missing",
        "/v1/quality/checks/missing",
        "/v1/charts/missing",
        "/v1/dashboards/missing",
        "/v1/saved-queries/missing",
        "/v1/optimizer/datasets/missing",
    ] {
        let (status, body) = request(&a, "GET", path, json!(null)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}: {body}");
        assert!(body["error"].is_string(), "{path}: {body}");
    }
    for path in [
        "/v1/advisor/missing/apply",
        "/v1/advisor/missing/rollback",
        "/v1/admin/keys/rotate/missing",
    ] {
        let (status, body) = request(&a, "POST", path, json!({})).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}: {body}");
        keys(&body, &["error"]);
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn json_extractors_reject_missing_fields_and_wrong_types() {
    let f = Fixture::new().await;
    let a = app(&f);
    for (method, path) in [
        ("POST", "/v1/sources"),
        ("POST", "/v1/jobs"),
        ("POST", "/v1/users"),
        ("POST", "/v1/roles"),
        ("POST", "/v1/grants"),
        ("POST", "/v1/sql"),
        ("POST", "/v1/sql/explain"),
        ("POST", "/v1/models"),
        ("POST", "/v1/models/validate"),
        ("POST", "/v1/pipelines"),
        ("POST", "/v1/pipelines/validate"),
        ("POST", "/v1/quality/checks"),
        ("POST", "/v1/charts"),
        ("POST", "/v1/charts/preview"),
        ("POST", "/v1/dashboards"),
        ("POST", "/v1/saved-queries"),
        ("POST", "/v1/explorer/rows"),
        ("POST", "/v1/explorer/export"),
        ("POST", "/v1/explorer/profile"),
        ("PUT", "/v1/users/admin/roles"),
    ] {
        for body in [json!({}), json!([])] {
            let (status, _) = request(&a, method, path, body).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{method} {path}");
        }
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn semantic_validation_and_conflicts_return_documented_statuses() {
    let f = Fixture::new().await;
    let a = app(&f);
    for (path, body, status) in [
        (
            "/v1/sources",
            json!({"name":" ","kind":"external"}),
            StatusCode::BAD_REQUEST,
        ),
        ("/v1/users", json!({"name":" "}), StatusCode::BAD_REQUEST),
        ("/v1/roles", json!({"name":" "}), StatusCode::BAD_REQUEST),
        (
            "/v1/saved-queries",
            json!({"name":" ","sql":"SELECT 1"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "/v1/dashboards",
            json!({"name":" ","layout":[]}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "/v1/charts",
            json!({"name":" ","sql":"SELECT 1","kind":"table","config":{}}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "/v1/pipelines",
            json!({"name":"empty","nodes":[]}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        ("/v1/advisor/refresh", json!(null), StatusCode::BAD_REQUEST),
        (
            "/v1/advisor/missing/dismiss",
            json!(null),
            StatusCode::CONFLICT,
        ),
        (
            "/v1/optimizer/datasets/missing/relayout",
            json!(null),
            StatusCode::CONFLICT,
        ),
    ] {
        let (s, v) = request(&a, "POST", path, body).await;
        assert_eq!(s, status, "{path}: {v}");
        if status == StatusCode::UNPROCESSABLE_ENTITY {
            keys(&v, &["valid", "errors"]);
        } else {
            keys(&v, &["error"]);
        }
    }
    for path in [
        "/v1/lineage/impact?node=bad&direction=sideways",
        "/v1/lineage/columns?dataset=bad&column=id&direction=sideways",
    ] {
        let (s, v) = request(&a, "GET", path, json!(null)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{path}: {v}");
        keys(&v, &["error"]);
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn saved_chart_dashboard_crud_status_and_key_contracts() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    for (base, input, required) in [
        (
            "/v1/saved-queries",
            json!({"name":"contract","sql":"SELECT 1","shared":false}),
            vec![
                "id",
                "owner_id",
                "name",
                "sql",
                "shared",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "/v1/charts",
            json!({"name":"contract","sql":"SELECT id,name FROM app_db.users","kind":"table","config":{"x":"id","y":["id"]},"shared":true}),
            vec![
                "id",
                "owner_id",
                "name",
                "sql",
                "kind",
                "config",
                "shared",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "/v1/dashboards",
            json!({"name":"contract","description":"test","layout":[],"shared":false}),
            vec![
                "id",
                "owner_id",
                "name",
                "description",
                "layout",
                "shared",
                "created_at",
                "updated_at",
            ],
        ),
    ] {
        let (s, v) = request(&a, "POST", base, input.clone()).await;
        assert_eq!(s, StatusCode::CREATED, "{base}: {v}");
        keys(&v, &required);
        let endpoint = format!("{base}/{}", v["id"].as_str().unwrap());
        for method in ["GET", "PUT"] {
            let (s, v) = request(&a, method, &endpoint, input.clone()).await;
            assert_eq!(s, StatusCode::OK, "{method} {endpoint}: {v}");
            keys(&v, &required);
        }
        if base == "/v1/charts" {
            for (suffix, body) in [("data", json!({})), ("drill", json!({"x_value":1}))] {
                let (s, v) = request(&a, "POST", &format!("{endpoint}/{suffix}"), body).await;
                assert_eq!(s, StatusCode::OK, "{v}");
                keys(&v, &["columns", "rows"]);
            }
        }
        let (s, v) = request(&a, "DELETE", &endpoint, json!(null)).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert!(v.is_null());
        assert_eq!(
            request(&a, "GET", &endpoint, json!(null)).await.0,
            StatusCode::NOT_FOUND
        );
    }
    drop(a);
    f.close().await;
}

const ROUTES: &[(&str, &str)] = &[
    ("GET", "/v1/users"),
    ("POST", "/v1/users"),
    ("GET", "/v1/users/{id}"),
    ("PUT", "/v1/users/{id}"),
    ("DELETE", "/v1/users/{id}"),
    ("PUT", "/v1/users/{id}/roles"),
    ("GET", "/v1/users/{id}/tokens"),
    ("POST", "/v1/users/{id}/tokens"),
    ("DELETE", "/v1/users/{id}/tokens/{token}"),
    ("GET", "/v1/roles"),
    ("POST", "/v1/roles"),
    ("GET", "/v1/roles/{id}"),
    ("PUT", "/v1/roles/{id}"),
    ("DELETE", "/v1/roles/{id}"),
    ("GET", "/v1/grants"),
    ("POST", "/v1/grants"),
    ("GET", "/v1/grants/{id}"),
    ("PUT", "/v1/grants/{id}"),
    ("DELETE", "/v1/grants/{id}"),
    ("GET", "/v1/datasets/{id}/policies"),
    ("PUT", "/v1/datasets/{id}/row-filters/{role}"),
    ("DELETE", "/v1/datasets/{id}/row-filters/{role}"),
    ("PUT", "/v1/datasets/{id}/masks/{role}/{column}"),
    ("DELETE", "/v1/datasets/{id}/masks/{role}/{column}"),
    ("POST", "/v1/policies/validate"),
    ("PUT", "/v1/datasets/{id}/columns/{column}/tags/{tag}"),
    ("DELETE", "/v1/datasets/{id}/columns/{column}/tags/{tag}"),
    ("GET", "/v1/tags"),
    ("PUT", "/v1/tag-masks/{tag}/{role}"),
    ("DELETE", "/v1/tag-masks/{tag}/{role}"),
    ("GET", "/v1/activity"),
    ("GET", "/v1/charts"),
    ("POST", "/v1/charts"),
    ("POST", "/v1/charts/preview"),
    ("GET", "/v1/charts/{id}"),
    ("PUT", "/v1/charts/{id}"),
    ("DELETE", "/v1/charts/{id}"),
    ("POST", "/v1/charts/{id}/data"),
    ("POST", "/v1/charts/{id}/drill"),
    ("GET", "/v1/dashboards"),
    ("POST", "/v1/dashboards"),
    ("GET", "/v1/dashboards/{id}"),
    ("PUT", "/v1/dashboards/{id}"),
    ("DELETE", "/v1/dashboards/{id}"),
    ("GET", "/v1/explorer/tree"),
    ("POST", "/v1/explorer/rows"),
    ("POST", "/v1/explorer/export"),
    ("POST", "/v1/explorer/profile"),
    ("GET", "/v1/lineage/impact"),
    ("GET", "/v1/lineage/columns"),
    ("GET", "/v1/models"),
    ("POST", "/v1/models"),
    ("POST", "/v1/models/validate"),
    ("GET", "/v1/models/{id}"),
    ("PUT", "/v1/models/{id}"),
    ("DELETE", "/v1/models/{id}"),
    ("POST", "/v1/models/{id}/run"),
    ("GET", "/v1/models/{id}/explain"),
    ("GET", "/v1/models/{id}/lineage"),
    ("GET", "/v1/notifications"),
    ("POST", "/v1/notifications/read"),
    ("GET", "/v1/notifications/unread-count"),
    ("GET", "/v1/optimizer/datasets/{id}"),
    ("POST", "/v1/optimizer/datasets/{id}/relayout"),
    ("GET", "/v1/advisor"),
    ("POST", "/v1/advisor/refresh"),
    ("POST", "/v1/advisor/{id}/apply"),
    ("POST", "/v1/advisor/{id}/rollback"),
    ("POST", "/v1/advisor/{id}/dismiss"),
    ("GET", "/v1/pipelines"),
    ("POST", "/v1/pipelines"),
    ("POST", "/v1/pipelines/validate"),
    ("GET", "/v1/pipelines/{id}"),
    ("PUT", "/v1/pipelines/{id}"),
    ("DELETE", "/v1/pipelines/{id}"),
    ("POST", "/v1/pipelines/{id}/run"),
    ("GET", "/v1/pipelines/{id}/runs"),
    ("GET", "/v1/pipeline-runs/{id}"),
    ("POST", "/v1/pipeline-runs/{id}/cancel"),
    ("GET", "/v1/quality/checks"),
    ("POST", "/v1/quality/checks"),
    ("GET", "/v1/quality/checks/{id}"),
    ("PUT", "/v1/quality/checks/{id}"),
    ("DELETE", "/v1/quality/checks/{id}"),
    ("POST", "/v1/quality/checks/{id}/run"),
    ("GET", "/v1/quality/checks/{id}/runs"),
    ("GET", "/v1/quality/runs"),
    ("GET", "/v1/quality/summary"),
    ("GET", "/v1/saved-queries"),
    ("POST", "/v1/saved-queries"),
    ("GET", "/v1/saved-queries/{id}"),
    ("PUT", "/v1/saved-queries/{id}"),
    ("DELETE", "/v1/saved-queries/{id}"),
    ("GET", "/v1/admin/keys"),
    ("GET", "/v1/admin/settings"),
    ("GET", "/v1/admin/auth-failures"),
    ("POST", "/v1/admin/keys/rotate-kek"),
    ("POST", "/v1/admin/keys/rotate/{target}"),
    ("GET", "/v1/audit/verify"),
    ("GET", "/v1/storage"),
    ("GET", "/v1/me"),
    ("GET", "/v1/status"),
    ("POST", "/v1/sql"),
    ("POST", "/v1/sql/cancel/{query_id}"),
    ("POST", "/v1/sql/explain"),
    ("GET", "/v1/sql/tables"),
    ("GET", "/v1/sources"),
    ("POST", "/v1/sources"),
    ("GET", "/v1/sources/{id}"),
    ("PUT", "/v1/sources/{id}"),
    ("DELETE", "/v1/sources/{id}"),
    ("POST", "/v1/sources/{id}/check"),
    ("POST", "/v1/sources/{id}/discover"),
    ("POST", "/v1/sources/{id}/datasets"),
    ("GET", "/v1/datamap"),
    ("POST", "/v1/relationships"),
    ("DELETE", "/v1/relationships/{id}"),
    ("GET", "/v1/jobs"),
    ("POST", "/v1/jobs"),
    ("GET", "/v1/jobs/{id}"),
    ("PUT", "/v1/jobs/{id}"),
    ("DELETE", "/v1/jobs/{id}"),
    ("POST", "/v1/jobs/{id}/run"),
    ("GET", "/v1/runs"),
    ("POST", "/v1/runs/{id}/cancel"),
    ("GET", "/v1/backups"),
    ("POST", "/v1/backups"),
    ("GET", "/v1/events"),
];
const API_SOURCES: &[&str] = &[
    include_str!("api/access_api.rs"),
    include_str!("api/activity_api.rs"),
    include_str!("api/analytics_api.rs"),
    include_str!("api/explorer_api.rs"),
    include_str!("api/lineage_api.rs"),
    include_str!("api/models_api.rs"),
    include_str!("api/notifications_api.rs"),
    include_str!("api/optimizer_api.rs"),
    include_str!("api/pipelines_api.rs"),
    include_str!("api/quality_api.rs"),
    include_str!("api/saved_queries_api.rs"),
    include_str!("api/security_api.rs"),
    include_str!("api/storage_api.rs"),
    include_str!("api.rs"),
];
