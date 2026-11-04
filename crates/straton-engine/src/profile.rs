//! Column profiles over a policy-filtered frame: row count, nulls, approximate distinct
//! values, min/max and, for numeric columns, an equal-width histogram. Explorer's Profile
//! panel and `drift` quality checks share this code.
use anyhow::Result;
use datafusion::{
    arrow::datatypes::DataType,
    common::Column,
    dataframe::DataFrame,
    functions_aggregate::expr_fn::{approx_distinct, count, max, min, sum},
    logical_expr::{cast, when},
    prelude::{col, lit},
};
use serde_json::{Value, json};

/// Columns in one profile; the aggregate stays one bounded pass.
pub const MAX_COLUMNS: usize = 128;
/// Bins per histogram.
pub const BINS: usize = 12;
/// Numeric columns that get a histogram (one more pass over the data).
const MAX_HISTOGRAMS: usize = 32;

fn orderable(ty: &DataType) -> bool {
    ty.is_numeric()
        || matches!(
            ty,
            DataType::Utf8
                | DataType::LargeUtf8
                | DataType::Utf8View
                | DataType::Boolean
                | DataType::Date32
                | DataType::Date64
                | DataType::Timestamp(..)
                | DataType::Time32(_)
                | DataType::Time64(_)
        )
}
fn distinct_countable(ty: &DataType) -> bool {
    ty.is_integer()
        || matches!(
            ty,
            DataType::Utf8
                | DataType::LargeUtf8
                | DataType::Utf8View
                | DataType::Date32
                | DataType::Date64
                | DataType::Timestamp(..)
        )
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .filter(|f: &f64| f.is_finite())
}

/// Profile `fields` of `frame`. Returns the row count and one JSON object per column.
pub async fn profile(
    frame: DataFrame,
    fields: &[(String, DataType)],
    histograms: bool,
) -> Result<(u64, Vec<Value>)> {
    // One aggregate pass: [rows, then per column: non-null, distinct?, min?, max?].
    let mut aggs = vec![count(lit(1)).alias("__rows")];
    for (i, (name, ty)) in fields.iter().enumerate() {
        let c = || col(Column::from_name(name));
        aggs.push(count(c()).alias(format!("__nn{i}")));
        if distinct_countable(ty) {
            aggs.push(approx_distinct(c()).alias(format!("__nd{i}")));
        }
        if orderable(ty) {
            aggs.push(min(c()).alias(format!("__min{i}")));
            aggs.push(max(c()).alias(format!("__max{i}")));
        }
    }
    let batches = frame.clone().aggregate(vec![], aggs)?.collect().await?;
    let batch = batches
        .first()
        .ok_or_else(|| anyhow::anyhow!("empty profile result"))?;
    let get = |name: &str| -> Result<Value> {
        Ok(match batch.schema().index_of(name) {
            Ok(i) => crate::sql::cell(batch.column(i).as_ref(), 0)?,
            Err(_) => Value::Null,
        })
    };
    let rows = get("__rows")?.as_u64().unwrap_or(0);
    let mut columns = fields
        .iter()
        .enumerate()
        .map(|(i, (name, ty))| {
            let non_null = get(&format!("__nn{i}"))?.as_u64().unwrap_or(0);
            Ok(json!({
                "name": name,
                "type": match ty {
                    DataType::Utf8View => "Utf8".to_owned(),
                    DataType::BinaryView => "Binary".to_owned(),
                    other => other.to_string(),
                },
                "non_null": non_null,
                "nulls": rows.saturating_sub(non_null),
                "null_ratio": if rows == 0 { 0.0 } else { (rows - non_null.min(rows)) as f64 / rows as f64 },
                "approx_distinct": get(&format!("__nd{i}"))?,
                "min": get(&format!("__min{i}"))?,
                "max": get(&format!("__max{i}"))?,
                "histogram": Value::Null,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    if histograms {
        histogram_pass(frame, fields, &mut columns).await?;
    }
    Ok((rows, columns))
}

/// Equal-width bins between each numeric column's min and max, counted in one more pass.
/// The last bin includes the maximum. Constant columns get a single bin.
async fn histogram_pass(
    frame: DataFrame,
    fields: &[(String, DataType)],
    columns: &mut [Value],
) -> Result<()> {
    let mut aggs = vec![];
    let mut planned = vec![];
    for (i, (name, ty)) in fields.iter().enumerate() {
        if planned.len() == MAX_HISTOGRAMS {
            break;
        }
        if !ty.is_numeric() {
            continue;
        }
        let (Some(lo), Some(hi)) = (number(&columns[i]["min"]), number(&columns[i]["max"])) else {
            continue;
        };
        if lo == hi {
            columns[i]["histogram"] =
                json!([{"lo": lo, "hi": hi, "count": columns[i]["non_null"]}]);
            continue;
        }
        let width = (hi - lo) / BINS as f64;
        let value = || cast(col(Column::from_name(name)), DataType::Float64);
        for b in 0..BINS {
            let start = lo + width * b as f64;
            let inside = if b + 1 == BINS {
                value().gt_eq(lit(start))
            } else {
                value()
                    .gt_eq(lit(start))
                    .and(value().lt(lit(start + width)))
            };
            aggs.push(
                sum(when(inside, lit(1_i64)).otherwise(lit(0_i64))?).alias(format!("__h{i}_{b}")),
            );
        }
        planned.push((i, lo, width));
    }
    if aggs.is_empty() {
        return Ok(());
    }
    let batches = frame.aggregate(vec![], aggs)?.collect().await?;
    let batch = batches
        .first()
        .ok_or_else(|| anyhow::anyhow!("empty histogram result"))?;
    for (i, lo, width) in planned {
        let mut bins = Vec::with_capacity(BINS);
        for b in 0..BINS {
            let index = batch.schema().index_of(&format!("__h{i}_{b}"))?;
            let count = crate::sql::cell(batch.column(index).as_ref(), 0)?
                .as_i64()
                .unwrap_or(0);
            bins.push(json!({"lo": lo + width * b as f64, "hi": lo + width * (b + 1) as f64, "count": count}));
        }
        columns[i]["histogram"] = json!(bins);
    }
    Ok(())
}
