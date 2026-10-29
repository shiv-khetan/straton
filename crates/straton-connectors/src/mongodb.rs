use super::{batch, column, error, invalid, relationship, schema};
use ::mongodb::{
    Client,
    bson::{self, Bson, Document, doc},
    options::{ClientOptions, Credential, ServerAddress, Tls, TlsOptions},
};
use arrow::{
    array::{ArrayRef, BinaryBuilder},
    datatypes::{DataType, Field, Schema, TimeUnit},
    record_batch::RecordBatch,
};
use futures::{StreamExt, TryStreamExt, future::BoxFuture, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use straton_core::{
    Batches, Connector, DatasetIndex, DatasetSchema, ReadOptions, RelationshipKind, Result,
};

mod advisor;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    host: Option<String>,
    hosts: Option<Vec<String>>,
    database: String,
    username: Option<String>,
    auth_source: Option<String>,
    tls: Option<bool>,
    replica_set: Option<String>,
    #[serde(default = "sample_size")]
    sample_size: usize,
    #[serde(default = "batch_size")]
    batch_size: usize,
    #[serde(default)]
    advisor_may_write: bool,
}
fn sample_size() -> usize {
    1000
}
fn batch_size() -> usize {
    10_000
}
struct Mongo {
    config: Config,
    password: Option<String>,
    client: tokio::sync::OnceCell<Client>,
    tls: bool,
}
pub(super) fn build(value: &Value, secret: Option<&str>) -> Result<Box<dyn Connector>> {
    let config: Config = serde_json::from_value(value.clone())
        .map_err(|_| invalid("invalid MongoDB configuration; credentials belong in secret"))?;
    if config.database.is_empty()
        || config
            .database
            .chars()
            .any(|c| c.is_control() || "/\\. \"$".contains(c))
        || config.host.is_some() == config.hosts.is_some()
        || config.batch_size == 0
        || config.batch_size > i32::MAX as usize
        || config.sample_size == 0
        || config.sample_size > i32::MAX as usize
        || config
            .username
            .as_ref()
            .is_some_and(|s| s.trim().is_empty())
        || config
            .auth_source
            .as_ref()
            .is_some_and(|s| s.trim().is_empty())
        || config
            .replica_set
            .as_ref()
            .is_some_and(|s| s.trim().is_empty())
    {
        return Err(invalid("invalid MongoDB configuration"));
    }
    let hosts = config
        .hosts
        .clone()
        .unwrap_or_else(|| vec![config.host.clone().unwrap()]);
    if hosts.is_empty() {
        return Err(invalid("MongoDB requires a host"));
    }
    for h in &hosts {
        let host = h.strip_prefix("mongodb+srv://").unwrap_or(h);
        if !super::postgres_tls::host_valid(host)
            || h.contains("mongodb+srv://") && (hosts.len() != 1 || host.contains(':'))
            || ServerAddress::parse(host).is_err()
        {
            return Err(invalid(
                "invalid MongoDB host; credentials belong in secret",
            ));
        }
    }
    let local = hosts.iter().all(|h| {
        if h.starts_with('[') {
            h.split_once(']')
                .is_some_and(|(a, _)| super::postgres_tls::local(a.trim_start_matches('[')))
        } else {
            super::postgres_tls::local(h.split(':').next().unwrap_or(h))
        }
    });
    let tls = config.tls.unwrap_or(!local);
    Ok(Box::new(Mongo {
        config,
        password: secret.map(str::to_owned),
        client: tokio::sync::OnceCell::new(),
        tls,
    }))
}
#[derive(Clone)]
struct Sample {
    schema: DatasetSchema,
    types: BTreeMap<String, BTreeSet<String>>,
}
fn flat(document: &Document) -> Result<BTreeMap<String, Bson>> {
    let mut out = BTreeMap::new();
    for (name, value) in document {
        if let Bson::Document(child) = value
            && name != "_id"
            && !child.is_empty()
        {
            for (field, value) in child {
                if out
                    .insert(format!("{name}.{field}"), value.clone())
                    .is_some()
                {
                    return Err(invalid("ambiguous dotted MongoDB fields"));
                }
            }
            continue;
        }
        if out.insert(name.clone(), value.clone()).is_some() {
            return Err(invalid("ambiguous dotted MongoDB fields"));
        }
    }
    Ok(out)
}
fn native(value: &Bson) -> &'static str {
    match value {
        Bson::ObjectId(_) => "object_id",
        Bson::String(_) => "string",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::Double(_) => "double",
        Bson::Null => "null",
        Bson::DateTime(_) => "date",
        Bson::Boolean(_) => "bool",
        Bson::Binary(_) => "binary",
        _ => "json",
    }
}
fn arrow_type(value: &Bson) -> DataType {
    match value {
        Bson::Int32(_) => DataType::Int32,
        Bson::Int64(_) => DataType::Int64,
        Bson::Double(_) => DataType::Float64,
        Bson::Boolean(_) => DataType::Boolean,
        Bson::DateTime(_) => DataType::Timestamp(TimeUnit::Millisecond, Some("+00:00".into())),
        Bson::Binary(_) => DataType::Binary,
        Bson::Null => DataType::Null,
        _ => DataType::Utf8,
    }
}
fn widen(a: &DataType, b: &DataType) -> DataType {
    if a == b || *b == DataType::Null {
        return a.clone();
    }
    if *a == DataType::Null {
        return b.clone();
    }
    if matches!(a, DataType::Int32 | DataType::Int64)
        && matches!(b, DataType::Int32 | DataType::Int64)
    {
        return DataType::Int64;
    }
    // Keep mixed integer/double values as text: converting Int64 to double can lose precision.
    DataType::Utf8
}
fn infer(name: &str, documents: &[Document]) -> Result<Sample> {
    let mut fields = BTreeMap::<String, (DataType, usize, bool)>::new();
    let mut types = BTreeMap::<String, BTreeSet<String>>::new();
    for document in documents {
        for (name, value) in flat(document)? {
            let ty = if name == "_id" {
                DataType::Utf8
            } else {
                arrow_type(&value)
            };
            let f = fields
                .entry(name.clone())
                .or_insert((DataType::Null, 0, false));
            f.0 = widen(&f.0, &ty);
            f.1 += 1;
            f.2 |= value == Bson::Null;
            if value != Bson::Null {
                types.entry(name).or_default().insert(native(&value).into());
            }
        }
    }
    fields
        .entry("_id".into())
        .or_insert((DataType::Utf8, documents.len(), false));
    let columns = fields
        .iter()
        .map(|(name, (ty, n, null))| {
            column(
                name.clone(),
                if *ty == DataType::Null {
                    DataType::Utf8
                } else {
                    ty.clone()
                },
                name != "_id" && (*null || *n < documents.len()),
                name == "_id",
            )
        })
        .collect();
    let mut schema = schema(name.into(), columns, vec![]);
    schema.metadata.sampled_documents = Some(documents.len());
    schema.metadata.field_coverage = fields
        .into_iter()
        .map(|(name, (_, n, _))| (name, n))
        .collect();
    schema.metadata.dialect = Some("mongodb".into());
    Ok(Sample { schema, types })
}
fn infer_relationships(samples: &mut [Sample]) {
    let targets: Vec<_> = samples
        .iter()
        .filter(|s| !s.schema.metadata.is_view)
        .filter_map(|s| {
            s.types
                .get("_id")
                .filter(|t| t.len() == 1)
                .map(|t| (s.schema.dataset.name.clone(), t.clone()))
        })
        .collect();
    for sample in samples {
        for (field, types) in &sample.types {
            let stem = field
                .strip_suffix("_id")
                .or_else(|| field.strip_suffix("Id"));
            let Some(stem) = stem.filter(|s| !s.is_empty()) else {
                continue;
            };
            for (name, target_type) in &targets {
                if types != target_type
                    || !(name.eq_ignore_ascii_case(stem)
                        || name.eq_ignore_ascii_case(&format!("{stem}s")))
                {
                    continue;
                }
                let mut rel = relationship(
                    &sample.schema.dataset.name,
                    vec![field.clone()],
                    name,
                    vec!["_id".into()],
                );
                rel.kind = RelationshipKind::Inferred;
                rel.confidence = Some(
                    0.9 * sample
                        .schema
                        .metadata
                        .field_coverage
                        .get(field)
                        .copied()
                        .unwrap_or(0) as f64
                        / sample.schema.metadata.sampled_documents.unwrap_or(1).max(1) as f64,
                );
                sample.schema.relationships.push(rel);
            }
        }
    }
}
impl Mongo {
    async fn client(&self) -> Result<&Client> {
        self.client
            .get_or_try_init(|| async {
                if self.config.username.is_some()
                    && self.password.as_ref().is_none_or(|s| s.is_empty())
                {
                    return Err(invalid("MongoDB password is missing from the keychain"));
                }
                let hosts = self
                    .config
                    .hosts
                    .clone()
                    .unwrap_or_else(|| vec![self.config.host.clone().unwrap()]);
                let mut opts = if hosts[0].starts_with("mongodb+srv://") {
                    ClientOptions::parse(&hosts[0]).await.map_err(error)?
                } else {
                    let mut o = ClientOptions::default();
                    o.hosts = hosts
                        .iter()
                        .map(ServerAddress::parse)
                        .collect::<std::result::Result<_, _>>()
                        .map_err(error)?;
                    o
                };
                opts.tls = Some(if self.tls {
                    Tls::Enabled(TlsOptions::default())
                } else {
                    Tls::Disabled
                });
                opts.repl_set_name = self.config.replica_set.clone();
                opts.server_selection_timeout = Some(Duration::from_secs(20));
                opts.connect_timeout = Some(Duration::from_secs(20));
                if let Some(username) = &self.config.username {
                    opts.credential = Some(
                        Credential::builder()
                            .username(username.clone())
                            .password(self.password.clone())
                            .source(
                                self.config
                                    .auth_source
                                    .clone()
                                    .unwrap_or_else(|| self.config.database.clone()),
                            )
                            .build(),
                    );
                }
                Client::with_options(opts).map_err(error)
            })
            .await
    }
    async fn samples(&self) -> Result<Vec<Sample>> {
        let db = self.client().await?.database(&self.config.database);
        let descriptions: Vec<_> = db
            .list_collections()
            .await
            .map_err(error)?
            .try_collect()
            .await
            .map_err(error)?;
        let mut samples = vec![];
        for collection in descriptions {
            if collection.name.starts_with("system.") {
                continue;
            }
            let coll = db.collection::<Document>(&collection.name);
            let docs: Vec<Document> = coll
                .find(doc! {})
                .limit(self.config.sample_size as i64)
                .await
                .map_err(error)?
                .try_collect()
                .await
                .map_err(error)?;
            let mut sample = infer(&collection.name, &docs)?;
            if let Some(base) = collection.options.view_on {
                sample.schema.metadata.is_view = true;
                sample.schema.metadata.definition = Some(json!({"viewOn":base,"pipeline":collection.options.pipeline.unwrap_or_default()}).to_string());
                let mut rel = relationship(&base, vec![], &collection.name, vec![]);
                rel.kind = RelationshipKind::Lineage;
                sample.schema.relationships.push(rel);
            } else {
                sample.schema.metadata.approximate_rows = coll
                    .estimated_document_count()
                    .await
                    .ok()
                    .and_then(|n| i64::try_from(n).ok());
                let indexes: Vec<_> = coll
                    .list_indexes()
                    .await
                    .map_err(error)?
                    .try_collect()
                    .await
                    .map_err(error)?;
                for index in indexes {
                    let options = index.options.unwrap_or_default();
                    sample.schema.metadata.indexes.push(DatasetIndex {
                        name: options.name.unwrap_or_default(),
                        columns: index.keys.keys().cloned().collect(),
                        unique: options.unique.unwrap_or(false),
                        clustered: false,
                        kind: if options.partial_filter_expression.is_some() {
                            "partial"
                        } else if options.sparse == Some(true) {
                            "sparse"
                        } else if index
                            .keys
                            .values()
                            .all(|v| matches!(v, Bson::Int32(1 | -1) | Bson::Int64(1 | -1)))
                        {
                            "btree"
                        } else {
                            "special"
                        }
                        .into(),
                        unique_constraint: false,
                    });
                }
            }
            samples.push(sample);
        }
        infer_relationships(&mut samples);
        Ok(samples)
    }
}
fn text(value: &Bson) -> Result<Option<String>> {
    Ok(match value {
        Bson::Null => None,
        Bson::String(s) => Some(s.clone()),
        Bson::ObjectId(id) => Some(id.to_hex()),
        Bson::Int32(n) => Some(n.to_string()),
        Bson::Int64(n) => Some(n.to_string()),
        Bson::Double(n) => Some(n.to_string()),
        Bson::Boolean(b) => Some(b.to_string()),
        Bson::DateTime(d) => Some(
            chrono::DateTime::from_timestamp_millis(d.timestamp_millis())
                .ok_or_else(|| invalid("MongoDB date outside Arrow range"))?
                .to_rfc3339(),
        ),
        v => Some(serde_json::to_string(v).map_err(error)?),
    })
}
fn make_batch(sample: &DatasetSchema, documents: &[Document]) -> Result<RecordBatch> {
    let flattened = documents.iter().map(flat).collect::<Result<Vec<_>>>()?;
    let mut arrays = Vec::<ArrayRef>::new();
    let mut fields = vec![];
    for c in &sample.columns {
        let ty = c.data_type.parse::<DataType>().map_err(error)?;
        fields.push(Field::new(&c.name, ty.clone(), c.nullable));
        if ty == DataType::Binary {
            let mut builder = BinaryBuilder::new();
            for d in &flattened {
                match d.get(&c.name) {
                    Some(Bson::Binary(b)) => builder.append_value(&b.bytes),
                    None | Some(Bson::Null) => builder.append_null(),
                    _ => return Err(invalid("MongoDB field type changed; rediscover schema")),
                }
            }
            arrays.push(Arc::new(builder.finish()));
        } else {
            let values = flattened
                .iter()
                .map(|d| d.get(&c.name).map(text).transpose().map(Option::flatten))
                .collect::<Result<Vec<_>>>()?;
            arrays.push(
                batch(std::slice::from_ref(c), vec![values])?
                    .column(0)
                    .clone(),
            );
        }
    }
    RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays).map_err(error)
}
fn checkpoint(value: &Bson) -> Result<Value> {
    serde_json::to_value(value.clone().into_canonical_extjson()).map_err(error)
}
fn restore(value: &Value) -> Result<Bson> {
    Bson::try_from(value.clone()).map_err(error)
}
fn lower_bound(value: &Value, typ: &str) -> Result<Bson> {
    if value.is_object() {
        let v = restore(value)?;
        if matches!(
            (&v, typ),
            (Bson::ObjectId(_), "object_id") | (Bson::DateTime(_), "date")
        ) {
            return Ok(v);
        }
        return Err(invalid("MongoDB watermark type changed"));
    }
    if typ == "object_id" {
        return Ok(Bson::ObjectId(
            bson::oid::ObjectId::parse_str(
                value
                    .as_str()
                    .ok_or_else(|| invalid("invalid ObjectId watermark"))?,
            )
            .map_err(error)?,
        ));
    }
    if typ == "date" {
        let s = value
            .as_str()
            .ok_or_else(|| invalid("invalid date watermark"))?;
        let date = chrono::DateTime::parse_from_rfc3339(s).map_err(error)?;
        return Ok(Bson::DateTime(bson::DateTime::from_millis(
            date.timestamp_millis(),
        )));
    }
    Err(invalid(
        "MongoDB incremental reads require a timestamp or ObjectId watermark",
    ))
}
fn filter(
    order: &[String],
    cursor: Option<&Value>,
    lower: Option<&Value>,
    typ: &str,
) -> Result<Document> {
    let mut terms = vec![];
    if let Some(lower) = lower {
        terms.push(doc! { &order[0]: {"$gte": lower_bound(lower,typ)?} });
    }
    if let Some(cursor) = cursor {
        let values = cursor
            .as_array()
            .filter(|a| a.len() == order.len())
            .ok_or_else(|| invalid("invalid MongoDB checkpoint"))?;
        let values = values.iter().map(restore).collect::<Result<Vec<_>>>()?;
        if values.contains(&Bson::Null) {
            return Err(invalid("MongoDB checkpoint keys must be non-null"));
        }
        let mut choices = vec![];
        for i in 0..order.len() {
            let mut term = Document::new();
            for j in 0..i {
                term.insert(&order[j], values[j].clone());
            }
            term.insert(&order[i], doc! {"$gt":values[i].clone()});
            choices.push(term);
        }
        terms.push(doc! {"$or": choices});
    }
    Ok(if terms.is_empty() {
        doc! {}
    } else {
        doc! {"$and": terms}
    })
}
impl Connector for Mongo {
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.client()
                .await?
                .database(&self.config.database)
                .run_command(doc! {"ping":1})
                .await
                .map_err(error)?;
            Ok(())
        })
    }
    fn discover(&self) -> BoxFuture<'_, Result<Vec<DatasetSchema>>> {
        Box::pin(async move {
            Ok(self
                .samples()
                .await?
                .into_iter()
                .map(|s| s.schema)
                .collect())
        })
    }
    fn advisor_metadata(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(advisor::metadata(self))
    }
    fn advisor_execute<'a>(&'a self, ddl: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(advisor::execute(self, ddl))
    }
    fn read<'a>(
        &'a self,
        dataset: &'a str,
        options: ReadOptions,
    ) -> BoxFuture<'a, Result<Batches<'a>>> {
        Box::pin(async move {
            if options.incremental.is_some() && options.keys_only.is_some() {
                return Err(invalid(
                    "incremental and key-only reads are mutually exclusive",
                ));
            }
            let mut sample = self
                .samples()
                .await?
                .into_iter()
                .find(|s| s.schema.dataset.name == dataset)
                .ok_or_else(|| invalid("MongoDB dataset not found"))?;
            let mut order = vec![];
            let mut typ = String::new();
            if let Some(i) = &options.incremental {
                if i.key_columns != ["_id"] {
                    return Err(invalid("MongoDB merge key must be _id"));
                }
                let types = sample
                    .types
                    .get(&i.watermark_column)
                    .filter(|t| t.len() == 1)
                    .ok_or_else(|| invalid("MongoDB watermark type is not consistent"))?;
                typ = types.first().unwrap().clone();
                if typ != "date" && !(typ == "object_id" && i.watermark_column == "_id") {
                    return Err(invalid(
                        "MongoDB watermark must be a timestamp field or ObjectId _id",
                    ));
                }
                if sample
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.name == i.watermark_column)
                    .is_none_or(|c| c.nullable)
                {
                    return Err(invalid("MongoDB watermark must be present and non-null"));
                }
                order.push(i.watermark_column.clone());
            }
            if options.keys_only.as_ref().is_some_and(|k| k != &["_id"]) {
                return Err(invalid("MongoDB merge key must be _id"));
            }
            if !order.iter().any(|n| n == "_id") {
                order.push("_id".into());
            }
            if options.keys_only.is_some() {
                sample.schema.columns.retain(|c| c.name == "_id");
            }
            let lower = options.incremental.and_then(|i| i.lower_bound);
            let coll = self
                .client()
                .await?
                .database(&self.config.database)
                .collection::<Document>(dataset);
            Ok(stream::try_unfold(options.cursor, move |cursor| {
                let coll = coll.clone();
                let sample = sample.clone();
                let order = order.clone();
                let lower = lower.clone();
                let typ = typ.clone();
                async move {
                    let query = filter(&order, cursor.as_ref(), lower.as_ref(), &typ)?;
                    let sort: Document =
                        order.iter().map(|k| (k.clone(), Bson::Int32(1))).collect();
                    let docs: Vec<Document> = coll
                        .find(query)
                        .sort(sort)
                        .limit(self.config.batch_size as i64)
                        .batch_size(self.config.batch_size as u32)
                        .await
                        .map_err(error)?
                        .try_collect()
                        .await
                        .map_err(error)?;
                    if docs.is_empty() {
                        return Ok(None);
                    }
                    let flattened = docs.iter().map(flat).collect::<Result<Vec<_>>>()?;
                    for doc in &flattened {
                        for k in &order {
                            if doc.get(k).is_none_or(|v| *v == Bson::Null) {
                                return Err(invalid("MongoDB watermark and _id must be non-null"));
                            }
                        }
                    }
                    let last = flattened.last().unwrap();
                    let next = Value::Array(
                        order
                            .iter()
                            .map(|k| checkpoint(&last[k]))
                            .collect::<Result<_>>()?,
                    );
                    Ok(Some((
                        (make_batch(&sample.schema, &docs)?, next.clone()),
                        Some(next),
                    )))
                }
            })
            .boxed())
        })
    }
}
#[cfg(test)]
mod tests;
