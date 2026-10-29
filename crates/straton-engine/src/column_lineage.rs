use anyhow::{Result, ensure};
use datafusion::{
    arrow::datatypes::{DataType, Field, Schema},
    catalog::MemorySchemaProvider,
    common::{
        Column,
        tree_node::{TreeNode, TreeNodeRecursion},
    },
    datasource::empty::EmptyTable,
    logical_expr::{Expr, LogicalPlan},
    prelude::{SessionConfig, SessionContext},
};
use sqlx::{Sqlite, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Origin {
    pub dataset: String,
    pub column: String,
    pub kind: String,
    pub expression: String,
}
#[derive(Clone, Debug, Default)]
pub struct Analysis {
    pub outputs: Vec<(String, Vec<Origin>)>,
    pub usage: BTreeSet<Origin>,
    pub incomplete: bool,
}
#[derive(Clone)]
struct Slot {
    column: Column,
    origins: Vec<Origin>,
}

pub fn derive(
    plan: &LogicalPlan,
    tables: &BTreeMap<(String, String), String>,
    default_schema: &str,
) -> Analysis {
    fn refs(expr: &Expr, input: &[Slot], incomplete: &mut bool) -> Vec<Origin> {
        let _ = expr.apply(|node| {
            if matches!(
                node,
                Expr::ScalarSubquery(_) | Expr::Exists(_) | Expr::InSubquery(_)
            ) {
                *incomplete = true;
            }
            Ok(TreeNodeRecursion::Continue)
        });
        let mut origins = BTreeSet::new();
        for col in expr.column_refs() {
            let matches: Vec<_> = input
                .iter()
                .filter(|s| {
                    s.column.name == col.name
                        && (col.relation.is_none() || s.column.relation == col.relation)
                })
                .collect();
            if matches.len() != 1 {
                *incomplete = true;
                continue;
            }
            origins.extend(matches[0].origins.clone());
        }
        origins.into_iter().collect()
    }
    fn usage(expr: &Expr, role: &str, input: &[Slot], out: &mut Analysis) {
        for mut origin in refs(expr, input, &mut out.incomplete) {
            origin.kind = role.into();
            origin.expression = expr.to_string();
            out.usage.insert(origin);
        }
    }
    fn project(
        expr: &Expr,
        name: &str,
        input: &[Slot],
        aggregate: bool,
        out: &mut Analysis,
    ) -> Vec<Origin> {
        let bare = match expr {
            Expr::Alias(a) => a.expr.as_ref(),
            _ => expr,
        };
        let direct = matches!(bare, Expr::Column(_));
        refs(expr, input, &mut out.incomplete)
            .into_iter()
            .map(|mut origin| {
                if aggregate || !direct {
                    origin.kind = if aggregate || origin.kind == "aggregate" {
                        "aggregate"
                    } else {
                        "transform"
                    }
                    .into();
                    origin.expression = expr.to_string();
                } else if origin.kind == "passthrough" || origin.kind == "rename" {
                    origin.kind = if name == origin.column {
                        "passthrough"
                    } else {
                        "rename"
                    }
                    .into();
                    origin.expression = expr.to_string();
                }
                origin
            })
            .collect()
    }
    fn visit(
        plan: &LogicalPlan,
        tables: &BTreeMap<(String, String), String>,
        default_schema: &str,
        out: &mut Analysis,
    ) -> Vec<Slot> {
        let columns: Vec<_> = plan.schema().columns();
        if let LogicalPlan::TableScan(scan) = plan {
            let key = (
                scan.table_name
                    .schema()
                    .unwrap_or(default_schema)
                    .to_owned(),
                scan.table_name.table().to_owned(),
            );
            let dataset = tables.get(&key);
            if dataset.is_none() || scan.table_name.catalog().is_some_and(|c| c != "datafusion") {
                out.incomplete = true;
                return vec![];
            }
            let slots: Vec<_> = columns
                .into_iter()
                .map(|column| Slot {
                    origins: vec![Origin {
                        dataset: dataset.unwrap().clone(),
                        column: column.name.clone(),
                        kind: "passthrough".into(),
                        expression: column.to_string(),
                    }],
                    column,
                })
                .collect();
            for filter in &scan.filters {
                usage(filter, "filter", &slots, out);
            }
            return slots;
        }
        let input: Vec<_> = plan
            .inputs()
            .into_iter()
            .flat_map(|p| visit(p, tables, default_schema, out))
            .collect();
        let expressions: Option<Vec<(&Expr, bool)>> = match plan {
            LogicalPlan::Projection(p) => Some(p.expr.iter().map(|e| (e, false)).collect()),
            LogicalPlan::Aggregate(a) => {
                for e in &a.group_expr {
                    usage(e, "group_key", &input, out);
                }
                Some(
                    a.group_expr
                        .iter()
                        .map(|e| (e, false))
                        .chain(a.aggr_expr.iter().map(|e| (e, true)))
                        .collect(),
                )
            }
            LogicalPlan::Filter(f) => {
                usage(&f.predicate, "filter", &input, out);
                None
            }
            LogicalPlan::Join(j) => {
                for (left, right) in &j.on {
                    usage(left, "join_key", &input, out);
                    usage(right, "join_key", &input, out);
                }
                if let Some(filter) = &j.filter {
                    usage(filter, "join_key", &input, out);
                }
                None
            }
            LogicalPlan::Sort(_)
            | LogicalPlan::SubqueryAlias(_)
            | LogicalPlan::Limit(_)
            | LogicalPlan::Repartition(_)
            | LogicalPlan::Distinct(_)
            | LogicalPlan::EmptyRelation(_) => None,
            _ => {
                out.incomplete = true;
                None
            }
        };
        if let Some(exprs) = expressions {
            if exprs.len() != columns.len() {
                out.incomplete = true;
                return vec![];
            }
            return columns
                .into_iter()
                .zip(exprs)
                .map(|(column, (expr, aggregate))| Slot {
                    origins: project(expr, &column.name, &input, aggregate, out),
                    column,
                })
                .collect();
        }
        if matches!(plan, LogicalPlan::SubqueryAlias(_)) && input.len() == columns.len() {
            return columns
                .into_iter()
                .zip(input)
                .map(|(column, slot)| Slot {
                    column,
                    origins: slot.origins,
                })
                .collect();
        }
        columns
            .into_iter()
            .map(|column| {
                let origins = refs(&Expr::Column(column.clone()), &input, &mut out.incomplete);
                Slot { column, origins }
            })
            .collect()
    }
    let mut out = Analysis::default();
    let slots = visit(plan, tables, default_schema, &mut out);
    out.outputs = slots
        .into_iter()
        .map(|s| (s.column.name, s.origins))
        .collect();
    out
}

pub async fn replace(
    tx: &mut Transaction<'_, Sqlite>,
    dataset: &str,
    model: Option<&str>,
    analysis: &Analysis,
) -> Result<()> {
    sqlx::query("DELETE FROM column_lineage WHERE target_dataset_id=?")
        .bind(dataset)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE datasets SET lineage_incomplete=? WHERE id=?")
        .bind(analysis.incomplete)
        .bind(dataset)
        .execute(&mut **tx)
        .await?;
    for (target, origins) in &analysis.outputs {
        for origin in origins.iter().chain(analysis.usage.iter()) {
            sqlx::query("INSERT INTO column_lineage(target_dataset_id,target_column,source_dataset_id,source_column,kind,expression,model_id,view_dataset_id) VALUES(?,?,?,?,?,?,?,?)")
                .bind(dataset).bind(target).bind(&origin.dataset).bind(&origin.column).bind(&origin.kind).bind(&origin.expression).bind(model).bind(if model.is_none() { Some(dataset) } else { None }).execute(&mut **tx).await?;
        }
    }
    Ok(())
}

pub async fn view_plan(
    definition: &str,
    schemas: &[straton_core::DatasetSchema],
    ids: &BTreeMap<String, String>,
    default_schema: &str,
) -> Result<Analysis> {
    view_plan_dialect(definition, schemas, ids, default_schema, false).await
}
async fn view_plan_dialect(
    definition: &str,
    schemas: &[straton_core::DatasetSchema],
    ids: &BTreeMap<String, String>,
    default_schema: &str,
    mysql: bool,
) -> Result<Analysis> {
    use datafusion::sql::{
        parser::Statement,
        sqlparser::{
            ast::Statement as Ast,
            dialect::{Dialect, MsSqlDialect, MySqlDialect},
            parser::Parser,
        },
    };
    let dialect: &dyn Dialect = if mysql {
        &MySqlDialect {}
    } else {
        &MsSqlDialect {}
    };
    let mut statements = Parser::parse_sql(dialect, definition)?;
    ensure!(statements.len() == 1, "one view definition required");
    let Ast::CreateView(view) = statements.remove(0) else {
        anyhow::bail!("expected CREATE VIEW");
    };
    let ctx = SessionContext::new_with_config(
        SessionConfig::new().with_default_catalog_and_schema("datafusion", default_schema),
    );
    let catalog = ctx.catalog("datafusion").unwrap();
    let mut tables = BTreeMap::new();
    for ds in schemas {
        let (schema, table) = ds
            .dataset
            .name
            .split_once('.')
            .ok_or_else(|| anyhow::anyhow!("qualified view input required"))?;
        if catalog.schema(schema).is_none() {
            catalog.register_schema(schema, Arc::new(MemorySchemaProvider::new()))?;
        }
        let fields: Result<Vec<_>> = ds
            .columns
            .iter()
            .map(|c| {
                Ok(Field::new(
                    &c.name,
                    c.data_type.parse::<DataType>()?,
                    c.nullable,
                ))
            })
            .collect();
        catalog.schema(schema).unwrap().register_table(
            table.into(),
            Arc::new(EmptyTable::new(Arc::new(Schema::new(fields?)))),
        )?;
        tables.insert(
            (schema.to_owned(), table.to_owned()),
            ids[&ds.dataset.name].clone(),
        );
    }
    let plan = ctx
        .state()
        .statement_to_plan(Statement::Statement(Box::new(Ast::Query(view.query))))
        .await?;
    let mut analysis = derive(&plan, &tables, default_schema);
    if !view.columns.is_empty() {
        ensure!(
            view.columns.len() == analysis.outputs.len(),
            "view column count mismatch"
        );
        for ((name, origins), column) in analysis.outputs.iter_mut().zip(&view.columns) {
            *name = column.name.value.clone();
            for origin in origins
                .iter_mut()
                .filter(|o| o.kind == "passthrough" || o.kind == "rename")
            {
                origin.kind = if origin.column == *name {
                    "passthrough"
                } else {
                    "rename"
                }
                .into();
            }
        }
    }
    Ok(analysis)
}

pub async fn discover_views(
    tx: &mut Transaction<'_, Sqlite>,
    schemas: &[straton_core::DatasetSchema],
    ids: &BTreeMap<String, String>,
) -> Result<()> {
    for ds in schemas.iter().filter(|d| d.metadata.is_view) {
        let dataset = &ids[&ds.dataset.name];
        let planned = match &ds.metadata.definition {
            Some(definition) if ds.metadata.dialect.as_deref() != Some("mongodb") => {
                if ds.metadata.dialect.as_deref() == Some("mysql") {
                    view_plan_dialect(
                        definition,
                        schemas,
                        ids,
                        ds.dataset.name.split_once('.').map_or("public", |(s, _)| s),
                        true,
                    )
                    .await
                } else {
                    view_plan(
                        definition,
                        schemas,
                        ids,
                        ds.dataset
                            .name
                            .split_once('.')
                            .map_or("dbo", |(schema, _)| schema),
                    )
                    .await
                }
            }
            _ => Err(anyhow::anyhow!("view definition unavailable")),
        };
        let mut analysis = planned.unwrap_or_else(|_| Analysis {
            incomplete: true,
            ..Default::default()
        });
        if analysis.outputs.len() == ds.columns.len() {
            for ((name, _), column) in analysis.outputs.iter_mut().zip(&ds.columns) {
                *name = column.name.clone();
            }
        } else {
            analysis.incomplete = true;
            analysis.outputs.clear();
        }
        // A failed resolution must never leave guessed field edges behind.
        if analysis.incomplete {
            analysis.outputs.clear();
            analysis.usage.clear();
        }
        replace(tx, dataset, None, &analysis).await?;
        let mut sources: BTreeSet<_> = analysis
            .outputs
            .iter()
            .flat_map(|(_, origins)| origins.iter())
            .chain(analysis.usage.iter())
            .map(|o| o.dataset.clone())
            .collect();
        if analysis.incomplete
            && ds.metadata.dialect.as_deref() == Some("mysql")
            && let Some(definition) = &ds.metadata.definition
        {
            use datafusion::sql::sqlparser::{
                ast::{Statement, visit_relations},
                dialect::MySqlDialect,
                parser::Parser,
            };
            if let Ok(statements) = Parser::parse_sql(&MySqlDialect {}, definition) {
                for statement in statements {
                    if let Statement::CreateView(view) = statement {
                        let _ = visit_relations(&view.query, |name| {
                            let parts: Option<Vec<_>> = name
                                .0
                                .iter()
                                .map(|p| p.as_ident().map(|i| i.value.clone()))
                                .collect();
                            if let Some(parts) = parts {
                                let name = if parts.len() == 1 {
                                    format!(
                                        "{}.{}",
                                        ds.dataset.name.split_once('.').map_or("", |(s, _)| s),
                                        parts[0]
                                    )
                                } else {
                                    parts.join(".")
                                };
                                if let Some(id) = ids.get(&name) {
                                    sources.insert(id.clone());
                                }
                            }
                            std::ops::ControlFlow::<()>::Continue(())
                        });
                    }
                }
            }
        }
        for source in sources {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM relationships WHERE from_dataset=? AND to_dataset=? AND kind='lineage')").bind(&source).bind(dataset).fetch_one(&mut **tx).await?;
            if exists {
                continue;
            }
            crate::catalog::edge(
                tx,
                &straton_core::Relationship {
                    id: String::new(),
                    from_dataset: source,
                    from_cols: vec![],
                    to_dataset: dataset.clone(),
                    to_cols: vec![],
                    kind: straton_core::RelationshipKind::Lineage,
                    confidence: None,
                },
            )
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn analyze(text: &str) -> Analysis {
        let ctx = SessionContext::new();
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("amount", DataType::Int64, true),
        ]));
        for table in ["orders", "customers"] {
            ctx.register_table(table, Arc::new(EmptyTable::new(schema.clone())))
                .unwrap();
        }
        let tables = BTreeMap::from([
            (("public".into(), "orders".into()), "orders-id".into()),
            (("public".into(), "customers".into()), "customers-id".into()),
        ]);
        derive(
            &ctx.state().create_logical_plan(text).await.unwrap(),
            &tables,
            "public",
        )
    }
    #[tokio::test]
    async fn classifies_expressions_and_usage() {
        for (sql, kind, source) in [
            ("SELECT id FROM orders", "passthrough", "id"),
            ("SELECT id AS order_id FROM orders", "rename", "id"),
            (
                "SELECT amount * 2 AS doubled FROM orders",
                "transform",
                "amount",
            ),
            (
                "SELECT SUM(amount) + 1 AS total FROM orders",
                "aggregate",
                "amount",
            ),
            (
                "SELECT subtotal AS total FROM (SELECT SUM(amount) AS subtotal FROM orders) t",
                "aggregate",
                "amount",
            ),
            (
                "SELECT doubled FROM (SELECT amount * 2 AS doubled FROM orders) t",
                "transform",
                "amount",
            ),
        ] {
            let result = analyze(sql).await;
            assert!(!result.incomplete, "{sql}: {result:?}");
            let origin = &result.outputs[0].1[0];
            assert_eq!(origin.kind, kind, "{sql}");
            assert_eq!(origin.column, source);
            assert!(!origin.expression.is_empty());
        }
        let result=analyze("SELECT o.id,SUM(o.amount) AS total FROM orders o JOIN customers c ON o.id=c.id WHERE o.amount>0 GROUP BY o.id ORDER BY total").await;
        assert!(!result.incomplete, "{result:?}");
        for (dataset, column, kind) in [
            ("orders-id", "id", "join_key"),
            ("customers-id", "id", "join_key"),
            ("orders-id", "amount", "filter"),
            ("orders-id", "id", "group_key"),
        ] {
            assert!(
                result
                    .usage
                    .iter()
                    .any(|o| o.dataset == dataset && o.column == column && o.kind == kind),
                "{result:?}"
            );
        }
        let result = analyze("SELECT id FROM orders UNION ALL SELECT id FROM customers").await;
        assert!(result.incomplete);
    }
    #[tokio::test]
    async fn sqlserver_view_definition_uses_mssql_parser() {
        use straton_core::{Column, Dataset, DatasetSchema};
        let tables = vec![DatasetSchema {
            dataset: Dataset {
                id: String::new(),
                source_id: "s".into(),
                name: "dbo.orders".into(),
            },
            columns: vec![Column {
                id: String::new(),
                dataset_id: String::new(),
                name: "amount".into(),
                data_type: "Int64".into(),
                nullable: false,
                primary_key: false,
            }],
            relationships: vec![],
            metadata: Default::default(),
        }];
        let ids = BTreeMap::from([("dbo.orders".into(), "orders-id".into())]);
        let result=view_plan("CREATE VIEW [dbo].[totals] AS SELECT [amount] * 2 AS [total] FROM [dbo].[orders] WHERE [amount] > 0",&tables,&ids,"dbo").await.unwrap();
        assert!(!result.incomplete, "{result:?}");
        assert_eq!(result.outputs[0].0, "total");
        assert_eq!(result.outputs[0].1[0].kind, "transform");
        assert_eq!(result.outputs[0].1[0].dataset, "orders-id");
        assert!(result.usage.iter().any(|o| o.kind == "filter"));
        assert!(
            view_plan(
                "CREATE VIEW dbo.broken AS SELECT x FROM unknown",
                &tables,
                &ids,
                "dbo"
            )
            .await
            .is_err()
        );
        assert!(view_plan("not SQL", &tables, &ids, "dbo").await.is_err());
    }
}
