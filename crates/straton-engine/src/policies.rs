use crate::{access::Principal, store};
use anyhow::{Result, bail, ensure};
use datafusion::{
    arrow::{
        array::{Array, StringArray},
        datatypes::{DataType, Field, Schema},
    },
    common::{
        ScalarValue,
        tree_node::{TreeNode, TreeNodeRecursion},
    },
    dataframe::DataFrame,
    datasource::empty::EmptyTable,
    logical_expr::{ColumnarValue, Expr, ExprSchemable, Volatility, create_udf},
    prelude::{SessionContext, lit},
};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::{collections::BTreeMap, sync::Arc};

pub fn hash_udf(ctx: &SessionContext) {
    ctx.register_udf(create_udf(
        "straton_sha256",
        vec![DataType::Utf8],
        DataType::Utf8,
        Volatility::Immutable,
        Arc::new(|args| {
            let values = ColumnarValue::values_to_arrays(args)?;
            let a = values[0]
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| {
                    datafusion::error::DataFusionError::Execution("hash requires Utf8".into())
                })?;
            let out = StringArray::from_iter((0..a.len()).map(|i| {
                if a.is_null(i) {
                    None
                } else {
                    Some(format!("{:x}", Sha256::digest(a.value(i).as_bytes())))
                }
            }));
            Ok(ColumnarValue::Array(Arc::new(out)))
        }),
    ));
}
pub async fn schema_frame(pool: &SqlitePool, dataset: &str) -> Result<DataFrame> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM datasets WHERE id=?)")
        .bind(dataset)
        .fetch_one(pool)
        .await?;
    ensure!(exists, "unknown dataset");
    let rows = sqlx::query(
        "SELECT name,data_type,nullable FROM columns WHERE dataset_id=? ORDER BY rowid",
    )
    .bind(dataset)
    .fetch_all(pool)
    .await?;
    let fields: Result<Vec<_>> = rows
        .iter()
        .map(|r| {
            Ok(Field::new(
                r.get::<String, _>("name"),
                r.get::<&str, _>("data_type").parse::<DataType>()?,
                r.get::<bool, _>("nullable"),
            ))
        })
        .collect();
    let ctx = SessionContext::new();
    hash_udf(&ctx);
    Ok(ctx.read_table(Arc::new(EmptyTable::new(Arc::new(Schema::new(fields?)))))?)
}
pub async fn validate(frame: &DataFrame, text: &str) -> Result<Expr> {
    ensure!(!text.trim().is_empty(), "predicate is required");
    {
        let mut parser = datafusion::sql::sqlparser::parser::Parser::new(
            &datafusion::sql::sqlparser::dialect::GenericDialect {},
        )
        .try_with_sql(text)?;
        parser.parse_expr()?;
        ensure!(
            parser.peek_token().token == datafusion::sql::sqlparser::tokenizer::Token::EOF,
            "expected exactly one predicate"
        );
    }
    let expr = frame.parse_sql_expr(text)?;
    expr.apply(|e| {
        let allowed = match e {
            Expr::Column(c) => frame.schema().qualified_field_from_column(c).is_ok(),
            Expr::ScalarFunction(f) => f.func.signature().volatility == Volatility::Immutable,
            Expr::BinaryExpr(b) => matches!(
                b.op,
                datafusion::logical_expr::Operator::Eq
                    | datafusion::logical_expr::Operator::NotEq
                    | datafusion::logical_expr::Operator::Lt
                    | datafusion::logical_expr::Operator::LtEq
                    | datafusion::logical_expr::Operator::Gt
                    | datafusion::logical_expr::Operator::GtEq
                    | datafusion::logical_expr::Operator::And
                    | datafusion::logical_expr::Operator::Or
                    | datafusion::logical_expr::Operator::Plus
                    | datafusion::logical_expr::Operator::Minus
                    | datafusion::logical_expr::Operator::Multiply
                    | datafusion::logical_expr::Operator::Divide
                    | datafusion::logical_expr::Operator::Modulo
                    | datafusion::logical_expr::Operator::IsDistinctFrom
                    | datafusion::logical_expr::Operator::IsNotDistinctFrom
            ),
            Expr::Literal(..)
            | Expr::Like(_)
            | Expr::Not(_)
            | Expr::Negative(_)
            | Expr::IsNull(_)
            | Expr::IsNotNull(_)
            | Expr::IsTrue(_)
            | Expr::IsFalse(_)
            | Expr::IsUnknown(_)
            | Expr::IsNotTrue(_)
            | Expr::IsNotFalse(_)
            | Expr::IsNotUnknown(_)
            | Expr::Between(_)
            | Expr::InList(_)
            | Expr::Cast(_) => true,
            _ => false,
        };
        if !allowed {
            return Err(datafusion::error::DataFusionError::Plan(
                "policy permits only local columns and deterministic scalar expressions".into(),
            ));
        }
        Ok(TreeNodeRecursion::Continue)
    })?;
    ensure!(
        expr.get_type(frame.schema())? == DataType::Boolean,
        "predicate must be boolean"
    );
    frame
        .clone()
        .filter(expr.clone())?
        .create_physical_plan()
        .await?;
    Ok(expr)
}
pub struct Policy {
    pub filter: Option<Expr>,
    pub masks: BTreeMap<String, String>,
    pub filtered: bool,
    /// HMAC key for `hash` masks; loaded only when one applies.
    pub mask_key: Option<[u8; 32]>,
}
fn strictness(s: &str) -> u8 {
    match s {
        "null" => 4,
        "redact" => 3,
        "hash" => 2,
        "last4" => 1,
        _ => 0,
    }
}
pub async fn effective(
    pool: &SqlitePool,
    p: &Principal,
    source: &str,
    dataset: &str,
    frame: &DataFrame,
) -> Result<Option<Policy>> {
    let filters = sqlx::query("SELECT role_id,predicate FROM row_filters WHERE dataset_id=?")
        .bind(dataset)
        .fetch_all(pool)
        .await?;
    let masks = sqlx::query(r#"SELECT role_id,"column",kind FROM column_masks WHERE dataset_id=?"#)
        .bind(dataset)
        .fetch_all(pool)
        .await?;
    let tag_masks = sqlx::query(
        r#"SELECT t."column",m.role_id,m.kind FROM column_tags t JOIN tag_masks m ON m.tag=t.tag WHERE t.dataset_id=?"#,
    )
    .bind(dataset)
    .fetch_all(pool)
    .await?;
    let mut roles = Vec::new();
    let mut filter = None;
    let mut unrestricted = false;
    let mut filtered = false;
    for role in p.read_roles(source, dataset) {
        let pred = filters
            .iter()
            .find(|r| r.get::<&str, _>("role_id") == role.id);
        if let Some(pred) = pred {
            match validate(frame, pred.get("predicate")).await {
                Ok(expr) => {
                    filtered = true;
                    filter = Some(match filter {
                        Some(prev) => Expr::or(prev, expr),
                        None => expr,
                    });
                }
                Err(_) => {
                    let mut tx = pool.begin().await?;
                    store::audit_as(
                        &mut tx,
                        "policy.invalid",
                        dataset,
                        &serde_json::json!({"role_id":role.id}).to_string(),
                        Some(&p.user.id),
                    )
                    .await?;
                    tx.commit().await?;
                    continue;
                }
            }
        } else {
            unrestricted = true;
        }
        roles.push(role);
    }
    if roles.is_empty() {
        return Ok(None);
    }
    // Per role, a mask on the column wins over masks from its tags (the strictest tag mask
    // applies). Across roles the most permissive wins; when all mask, use
    // null > redact > hash > last4.
    let mut resolved = BTreeMap::new();
    for f in frame.schema().fields() {
        let mut kinds = Vec::new();
        for role in &roles {
            let applies = |m: &&sqlx::sqlite::SqliteRow| {
                m.get::<&str, _>("role_id") == role.id && m.get::<&str, _>("column") == f.name()
            };
            let kind = match masks.iter().find(applies) {
                Some(m) => Some(m.get::<String, _>("kind")),
                None => tag_masks
                    .iter()
                    .filter(applies)
                    .map(|m| m.get::<String, _>("kind"))
                    .max_by_key(|k| strictness(k)),
            };
            kinds.extend(kind);
        }
        if kinds.len() == roles.len() {
            let kind = kinds.into_iter().max_by_key(|s| strictness(s)).unwrap();
            ensure!(strictness(&kind) > 0, "invalid mask");
            resolved.insert(f.name().clone(), kind);
        }
    }
    let mask_key = if resolved.values().any(|k| k == "hash") {
        Some(store::mask_key(pool).await?)
    } else {
        None
    };
    Ok(Some(Policy {
        filter: if unrestricted { None } else { filter },
        masks: resolved,
        filtered: filtered && !unrestricted,
        mask_key,
    }))
}
/// The `hash` mask: lowercase hex HMAC-SHA256 under the engine's mask key. The function is
/// placed straight into the policy's plan and never registered in a session, so SQL users
/// cannot call it to hash their own guesses and compare them with masked values.
fn mask_hash(key: [u8; 32]) -> datafusion::logical_expr::ScalarUDF {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &key);
    create_udf(
        "straton_mask_hash",
        vec![DataType::Utf8],
        DataType::Utf8,
        Volatility::Immutable,
        Arc::new(move |args| {
            let values = ColumnarValue::values_to_arrays(args)?;
            let a = values[0]
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| {
                    datafusion::error::DataFusionError::Execution("hash requires Utf8".into())
                })?;
            let out = StringArray::from_iter((0..a.len()).map(|i| {
                (!a.is_null(i)).then(|| {
                    ring::hmac::sign(&key, a.value(i).as_bytes())
                        .as_ref()
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                })
            }));
            Ok(ColumnarValue::Array(Arc::new(out)))
        }),
    )
}
pub fn project(mut frame: DataFrame, policy: Policy) -> Result<DataFrame> {
    if let Some(expr) = policy.filter {
        frame = frame.filter(expr)?;
    }
    let exprs: Result<Vec<_>> = frame
        .schema()
        .fields()
        .iter()
        .map(|f| {
            let expr = match policy.masks.get(f.name()).map(String::as_str) {
                None => Expr::Column(datafusion::common::Column::from_name(f.name())),
                Some("null") => lit(ScalarValue::try_from(f.data_type())?),
                Some("redact") => lit("***"),
                Some("hash") => {
                    let key = policy
                        .mask_key
                        .ok_or_else(|| anyhow::anyhow!("mask key unavailable"))?;
                    mask_hash(key).call(vec![Expr::Cast(datafusion::logical_expr::Cast::new(
                        Box::new(Expr::Column(datafusion::common::Column::from_name(
                            f.name(),
                        ))),
                        DataType::Utf8,
                    ))])
                }
                // A value of four characters or fewer would be shown whole, so it is hidden.
                Some("last4") => frame.parse_sql_expr(&format!(
                    "CASE WHEN character_length(CAST({0} AS VARCHAR)) > 4 THEN '****' || right(CAST({0} AS VARCHAR), 4) WHEN {0} IS NOT NULL THEN '****' END",
                    quote(f.name())
                ))?,
                _ => bail!("invalid mask"),
            };
            Ok(expr.alias(f.name()))
        })
        .collect();
    Ok(frame.select(exprs?)?)
}
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
