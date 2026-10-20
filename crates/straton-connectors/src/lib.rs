//! Phase 1's deterministic connector; it performs no external IO.
use arrow::{
    array::Int64Array,
    datatypes::{DataType, Field, Schema},
    record_batch::RecordBatch,
};
use futures::{StreamExt, stream, stream::BoxStream};
use std::sync::Arc;
use straton_core::{Connector, Cursor, DatasetSchema, Result};

pub struct Noop;
impl Connector for Noop {
    async fn check(&self) -> Result<()> {
        Ok(())
    }
    async fn discover(&self) -> Result<Vec<DatasetSchema>> {
        Ok(vec![])
    }
    async fn read(
        &self,
        _dataset: &str,
        cursor: Option<Cursor>,
    ) -> Result<BoxStream<'_, Result<(RecordBatch, Cursor)>>> {
        let start = cursor.and_then(|c| c.as_u64()).unwrap_or(0);
        Ok(stream::iter((start..3).map(|offset| {
            let schema = Arc::new(Schema::new(vec![Field::new(
                "offset",
                DataType::Int64,
                false,
            )]));
            let batch = RecordBatch::try_new(
                schema,
                vec![Arc::new(Int64Array::from(vec![offset as i64]))],
            )
            .map_err(|e| straton_core::Error::Connector(e.to_string()))?;
            Ok((batch, serde_json::json!(offset + 1)))
        }))
        .boxed())
    }
}
