use datafusion::{
    arrow::datatypes::DataType,
    common::{
        DFSchema, Result, ScalarValue,
        tree_node::{Transformed, TreeNode, TreeNodeRecursion},
    },
    dataframe::DataFrame,
    logical_expr::{Expr, ExprSchemable, LogicalPlan, Operator, Volatility, expr::Cast},
    optimizer::{OptimizerConfig, OptimizerRule, optimizer::ApplyOrder, utils::NamePreserver},
    physical_plan::displayable,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct Firing {
    pub rule: &'static str,
    pub before: String,
    pub after: String,
}
pub type Firings = Arc<Mutex<Vec<Firing>>>;
#[derive(Debug)]
struct Cancel {
    fired: Firings,
}
// OptimizerRule (not AnalyzerRule): this preserves semantics after type coercion and
// standard view/projection inlining. DataFusion 55.2 Int64 arithmetic wraps (probe below).
// Only equal Int64 intermediate/output types are proven here. Decimal precision/scale
// changes and other integer widths are deliberately skipped until separately proven.
impl OptimizerRule for Cancel {
    fn name(&self) -> &str {
        "cancel_compensating_arithmetic"
    }
    fn apply_order(&self) -> Option<ApplyOrder> {
        Some(ApplyOrder::BottomUp)
    }
    fn rewrite(
        &self,
        plan: LogicalPlan,
        _: &dyn OptimizerConfig,
    ) -> Result<Transformed<LogicalPlan>> {
        if let Some(merged) = self.projection(&plan)? {
            return Ok(Transformed::yes(merged));
        }
        let mut schema = DFSchema::empty();
        for input in plan.inputs() {
            schema.merge(input.schema());
        }
        if let LogicalPlan::TableScan(scan) = &plan {
            schema = DFSchema::try_from_qualified_schema(
                scan.table_name.clone(),
                &scan.source.schema(),
            )?;
        }
        let names = NamePreserver::new(&plan);
        plan.map_expressions(|expr| {
            let name = names.save(&expr);
            let out = expr.transform_up(|e| self.expression(e, &schema))?;
            Ok(Transformed::new_transformed(
                name.restore(out.data),
                out.transformed,
            ))
        })
    }
}
fn constant(e: &Expr) -> Option<i64> {
    match e {
        Expr::Literal(ScalarValue::Int64(Some(v)), _) => Some(*v),
        _ => None,
    }
}
fn deterministic(e: &Expr) -> bool {
    let mut safe = true;
    let _=e.apply(|e|{
        if matches!(e,Expr::ScalarFunction(f) if f.func.signature().volatility!=Volatility::Immutable)
            || matches!(e,Expr::ScalarSubquery(_)|Expr::Exists(_)|Expr::InSubquery(_)) {safe=false;}
        Ok(TreeNodeRecursion::Continue)
    });
    safe && !e.is_volatile()
}
impl Cancel {
    fn projection(&self, plan: &LogicalPlan) -> Result<Option<LogicalPlan>> {
        let LogicalPlan::Projection(p) = plan else {
            return Ok(None);
        };
        let mut expressions = p.expr.clone();
        let mut input = p.input.clone();
        let mut crossed = false;
        loop {
            let replacements = match input.as_ref() {
                LogicalPlan::SubqueryAlias(a) => a
                    .input
                    .schema()
                    .columns()
                    .into_iter()
                    .map(Expr::Column)
                    .collect::<Vec<_>>(),
                LogicalPlan::Projection(p) if p.expr.iter().all(deterministic) => {
                    p.expr.iter().cloned().map(Expr::unalias).collect()
                }
                _ => break,
            };
            let mut next = Vec::new();
            for expr in expressions {
                next.push(
                    expr.transform_up(|e| {
                        if let Expr::Column(c) = &e {
                            let i = input.schema().index_of_column(c)?;
                            Ok(Transformed::yes(replacements[i].clone()))
                        } else {
                            Ok(Transformed::no(e))
                        }
                    })?
                    .data,
                );
            }
            expressions = next;
            input = Arc::new(input.inputs()[0].clone());
            crossed = true;
        }
        if !crossed {
            return Ok(None);
        }
        let local = Cancel {
            fired: Firings::default(),
        };
        let names = NamePreserver::new(plan);
        let mut changed = false;
        let mut rewritten = vec![];
        for (original, expr) in p.expr.iter().zip(expressions) {
            let out = expr.transform_up(|e| local.expression(e, input.schema()))?;
            changed |= out.transformed;
            let expr = names.save(original).restore(out.data);
            if expr.get_type(input.schema())? != original.get_type(p.input.schema())?
                || expr.nullable(input.schema())? != original.nullable(p.input.schema())?
            {
                return Ok(None);
            }
            rewritten.push(expr);
        }
        if !changed {
            return Ok(None);
        }
        let merged =
            LogicalPlan::Projection(datafusion::logical_expr::Projection::try_new_with_schema(
                rewritten,
                input,
                p.schema.clone(),
            )?);
        self.fired
            .lock()
            .unwrap()
            .extend(local.fired.lock().unwrap().iter().cloned());
        Ok(Some(merged))
    }
    fn expression(&self, expr: Expr, schema: &DFSchema) -> Result<Transformed<Expr>> {
        let Expr::BinaryExpr(outer) = &expr else {
            return Ok(Transformed::no(expr));
        };
        let Expr::BinaryExpr(inner) = outer.left.as_ref() else {
            return Ok(Transformed::no(expr));
        };
        let opposite = matches!(
            (inner.op, outer.op),
            (Operator::Plus, Operator::Minus) | (Operator::Minus, Operator::Plus)
        );
        let (Some(a), Some(b)) = (constant(&inner.right), constant(&outer.right)) else {
            return Ok(Transformed::no(expr));
        };
        if !opposite
            || expr.get_type(schema)? != DataType::Int64
            || outer.left.get_type(schema)? != DataType::Int64
            || !deterministic(&inner.left)
        {
            return Ok(Transformed::no(expr));
        }
        // Modulo 2^64 subtraction is exactly the kernel's overflow behavior.
        let delta = if inner.op == Operator::Plus {
            a.wrapping_sub(b)
        } else {
            b.wrapping_sub(a)
        };
        let mut after = inner.left.as_ref().clone();
        if after.get_type(schema)? != DataType::Int64 {
            after = Expr::Cast(Cast::new_from_field(
                Box::new(after),
                Arc::new(datafusion::arrow::datatypes::Field::new(
                    "",
                    DataType::Int64,
                    expr.nullable(schema)?,
                )),
            ));
        }
        if delta != 0 {
            after = after + datafusion::prelude::lit(delta);
        }
        // A rewrite must preserve nullability as well as the type.
        if after.nullable(schema)? != expr.nullable(schema)? {
            return Ok(Transformed::no(expr));
        }
        self.fired.lock().unwrap().push(Firing {
            rule: "cancel_compensating_arithmetic",
            before: expr.to_string(),
            after: after.to_string(),
        });
        Ok(Transformed::yes(after))
    }
}
pub fn optimize(frame: DataFrame, enabled: bool) -> Result<(DataFrame, Firings)> {
    let (state, plan) = frame.into_parts();
    let fired = Firings::default();
    let state = if enabled {
        let mut rules = state.optimizers().to_vec();
        rules.push(Arc::new(Cancel {
            fired: fired.clone(),
        }));
        datafusion::execution::session_state::SessionStateBuilder::new_from_existing(state)
            .with_optimizer_rules(rules)
            .build()
    } else {
        state
    };
    let plan = state.optimize(&plan)?;
    // The returned frame has a standard-only state: physical planning cannot record a
    // second, different optimization pass into this plan's firing log.
    let standard =
        datafusion::execution::session_state::SessionStateBuilder::new_from_existing(state)
            .with_optimizer_rules(datafusion::optimizer::Optimizer::new().rules)
            .build();
    Ok((DataFrame::new(standard, plan), fired))
}
pub async fn explain(frame: DataFrame, enabled: bool) -> Result<Value> {
    let before = frame.logical_plan().display_indent().to_string();
    let (frame, fired) = optimize(frame, enabled)?;
    let after = frame.logical_plan().display_indent().to_string();
    let physical = displayable(frame.create_physical_plan().await?.as_ref())
        .indent(true)
        .to_string();
    Ok(
        json!({"logical_before":before,"logical_after":after,"physical":physical,"rules_fired":*fired.lock().unwrap()}),
    )
}

#[cfg(test)]
mod tests {
    use datafusion::{
        arrow::{
            array::Int64Array,
            datatypes::{DataType, Field, Schema},
            record_batch::RecordBatch,
        },
        prelude::SessionContext,
    };
    use std::sync::Arc;
    #[tokio::test]
    async fn int64_overflow_semantics() {
        for (value, op) in [(i64::MAX, "+"), (i64::MIN, "-")] {
            let ctx = SessionContext::new();
            let batch = RecordBatch::try_new(
                Arc::new(Schema::new(vec![Field::new("x", DataType::Int64, true)])),
                vec![Arc::new(Int64Array::from(vec![Some(value), None]))],
            )
            .unwrap();
            ctx.register_batch("t", batch).unwrap();
            let result = ctx
                .sql(&format!("SELECT x {op} 1 FROM t"))
                .await
                .unwrap()
                .collect()
                .await;
            let batches = result.expect("DataFusion 55 Int64 overflow wraps rather than errors");
            let array = batches[0]
                .column(0)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap();
            assert_eq!(array.value(0), if op == "+" { i64::MIN } else { i64::MAX });
            use datafusion::arrow::array::Array;
            assert!(array.is_null(1));
        }
    }
}

#[cfg(test)]
mod rewrite_tests {
    use super::*;
    use datafusion::{
        arrow::{
            array::{Array, Float64Array, Int32Array, Int64Array},
            datatypes::{Field, Schema},
            record_batch::RecordBatch,
        },
        prelude::SessionContext,
    };
    async fn integer_frame(query: &str) -> DataFrame {
        let ctx = SessionContext::new();
        let schema = Arc::new(Schema::new(vec![
            Field::new("x", DataType::Int64, true),
            Field::new("small", DataType::Int32, true),
            Field::new("f", DataType::Float64, true),
        ]));
        ctx.register_batch(
            "t",
            RecordBatch::try_new(
                schema,
                vec![
                    Arc::new(Int64Array::from(vec![Some(i64::MAX), Some(i64::MIN), None])),
                    Arc::new(Int32Array::from(vec![Some(i32::MAX), Some(i32::MIN), None])),
                    Arc::new(Float64Array::from(vec![Some(1e30), Some(1.0), None])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
        ctx.sql(query).await.unwrap()
    }
    #[tokio::test]
    async fn cancellation_preserves_overflow_nulls_and_schema() {
        for expr in [
            "(x + 1) - 1",
            "(x - 1) + 1",
            "(x + 10) - 2",
            "(x - 10) + 2",
            "(CAST(small AS BIGINT) + 1) - 1",
            "(x + 9223372036854775807) - (-1)",
        ] {
            let frame = integer_frame(&format!("SELECT {expr} AS y FROM t")).await;
            let expected = frame.clone().collect().await.unwrap();
            let (after, fired) = optimize(frame, true).unwrap();
            assert!(
                !fired.lock().unwrap().is_empty(),
                "{expr}: {}",
                after.logical_plan().display_indent()
            );
            let actual = after.collect().await.unwrap();
            assert_eq!(actual, expected, "{expr}");
            assert!(actual[0].column(0).is_null(2));
        }
    }
    #[tokio::test]
    async fn no_float_decimal_volatile_or_disabled_rewrite() {
        for (query, enabled) in [
            ("SELECT (f + 1) - 1 AS y FROM t", true),
            (
                "SELECT (CAST(x AS DECIMAL(20,0)) + 1) - 1 AS y FROM t",
                true,
            ),
            ("SELECT (x + 1) - 1 AS y FROM t", false),
            (
                "SELECT (CAST(random() AS BIGINT) + 1) - 1 AS y FROM t",
                true,
            ),
        ] {
            let frame = integer_frame(query).await;
            let (_, fired) = optimize(frame, enabled).unwrap();
            assert!(fired.lock().unwrap().is_empty(), "{query}");
        }
    }
}

#[cfg(test)]
mod decimal_tests {
    use super::*;
    use datafusion::{
        arrow::{
            array::Decimal128Array,
            datatypes::{Field, Schema},
            record_batch::RecordBatch,
        },
        prelude::SessionContext,
    };
    #[tokio::test]
    async fn decimal_overflow_errors_are_not_removed() {
        let ctx = SessionContext::new();
        let max = 10_i128.pow(38) - 1;
        let array = Decimal128Array::from(vec![Some(max), None])
            .with_precision_and_scale(38, 0)
            .unwrap();
        ctx.register_batch(
            "t",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![Field::new(
                    "x",
                    DataType::Decimal128(38, 0),
                    true,
                )])),
                vec![Arc::new(array)],
            )
            .unwrap(),
        )
        .unwrap();
        let query = format!(
            "SELECT (x + CAST('{max}' AS DECIMAL(38,0))) - CAST('{max}' AS DECIMAL(38,0)) AS y FROM t"
        );
        let frame = ctx.sql(&query).await.unwrap();
        let error = frame.clone().collect().await.unwrap_err().to_string();
        assert!(error.to_lowercase().contains("overflow"), "{error}");
        let (frame, fired) = optimize(frame, true).unwrap();
        assert!(fired.lock().unwrap().is_empty());
        assert!(frame.collect().await.is_err());
    }
}

#[cfg(test)]
mod cast_tests {
    use super::*;
    use datafusion::{
        arrow::{
            array::Int32Array,
            datatypes::{Field, Schema},
            record_batch::RecordBatch,
        },
        prelude::SessionContext,
    };
    #[tokio::test]
    async fn int32_input_int64_literals_keep_type_and_non_nullability() {
        let ctx = SessionContext::new();
        ctx.register_batch(
            "t",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![Field::new("x", DataType::Int32, false)])),
                vec![Arc::new(Int32Array::from(vec![i32::MIN, i32::MAX]))],
            )
            .unwrap(),
        )
        .unwrap();
        let frame = ctx
            .sql("SELECT (x + CAST(1 AS BIGINT)) - CAST(1 AS BIGINT) AS y FROM t")
            .await
            .unwrap();
        let expected = frame.clone().collect().await.unwrap();
        let (frame, fired) = optimize(frame, true).unwrap();
        assert!(!fired.lock().unwrap().is_empty());
        assert_eq!(frame.schema().field(0).data_type(), &DataType::Int64);
        assert!(!frame.schema().field(0).is_nullable());
        assert_eq!(frame.collect().await.unwrap(), expected);
    }
}
