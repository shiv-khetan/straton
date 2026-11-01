use super::{Error, Mode, Output, Sql, statement};
use crate::config::Config;
use async_trait::async_trait;
use datafusion::{
    arrow::{
        array::Array,
        datatypes::{DataType, Schema, SchemaRef},
        util::display::array_value_to_string,
    },
    common::ScalarValue,
};
use futures::{Sink, SinkExt, stream};
use pgwire::{
    api::{
        ClientInfo, PgWireConnectionState, PgWireServerHandlers, Type,
        auth::{self, DefaultServerParameterProvider, StartupHandler},
        portal::{Format, Portal},
        query::{ExtendedQueryHandler, SimpleQueryHandler},
        results::{FieldInfo, QueryResponse, Response, Tag},
        stmt::QueryParser,
    },
    error::{ErrorInfo, PgWireError, PgWireResult},
    messages::{
        PgWireBackendMessage, PgWireFrontendMessage, data::DataRow, startup::Authentication,
    },
};
use secrecy::{ExposeSecret, SecretString};
use std::{collections::BTreeSet, fmt::Debug, sync::Arc, time::Duration};

use tokio::{
    net::TcpListener,
    sync::watch,
    task::{JoinHandle, JoinSet},
};

/// Concurrent pgwire clients, authenticated or not; excess connections are closed.
const MAX_CLIENTS: usize = 256;
pub struct Server {
    stop: watch::Sender<bool>,
    pub task: JoinHandle<anyhow::Result<()>>,
    #[cfg(test)]
    pub address: Option<std::net::SocketAddr>,
}
impl Server {
    pub async fn start(
        sql: Sql,
        token: Arc<SecretString>,
        config: &Config,
    ) -> anyhow::Result<Self> {
        config.validate()?;
        crate::access::bootstrap(&sql.pool, token.expose_secret()).await?;
        let listener = if sql.config.enabled {
            Some(TcpListener::bind(sql.config.bind).await?)
        } else {
            None
        };
        let address = listener.as_ref().map(TcpListener::local_addr).transpose()?;
        let tls = match (&config.tls_cert, &config.tls_key) {
            (Some(cert), Some(key)) => {
                let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
                Some(pgwire::tokio::TlsAcceptor::from(tls.get_inner()))
            }
            _ => None,
        };
        let backend = Arc::new(Backend {
            sql,
            require_tls: !config.sql.bind.ip().is_loopback(),
        });
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let Some(listener) = listener else {
                let _ = stopped.changed().await;
                return Ok(());
            };
            tracing::info!(?address, "SQL endpoint started");
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    result = listener.accept() => {
                        // Accept errors (EMFILE, ECONNABORTED, ...) are transient: they must
                        // not end the listener and take the SQL endpoint down for good.
                        let socket = match result {
                            Ok((socket, _)) => socket,
                            Err(e) => {
                                tracing::warn!(error=%e, "SQL endpoint accept failed");
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                continue;
                            }
                        };
                        if clients.len() >= MAX_CLIENTS {
                            tracing::warn!("SQL endpoint connection limit reached");
                            drop(socket);
                            continue;
                        }
                        let tls = tls.clone();
                        let backend = backend.clone();
                        clients.spawn(async move {
                            // Authentication errors are sent to the client by pgwire; do not log SQL.
                            let _ = pgwire::tokio::process_socket(socket, tls, backend).await;
                        });
                    },
                    _ = clients.join_next(), if !clients.is_empty() => {},
                }
            }
            drop(listener);
            if tokio::time::timeout(Duration::from_secs(30), async {
                while clients.join_next().await.is_some() {}
            })
            .await
            .is_err()
            {
                clients.abort_all();
                while clients.join_next().await.is_some() {}
            }
            Ok(())
        });
        Ok(Self {
            stop,
            task,
            #[cfg(test)]
            address,
        })
    }
    pub async fn shutdown(&mut self) {
        let _ = self.stop.send(true);
        if !self.task.is_finished() {
            let _ = (&mut self.task).await;
        }
    }
}
#[derive(Clone)]
struct Backend {
    sql: Sql,
    require_tls: bool,
}
impl Backend {
    async fn session<C: ClientInfo>(&self, client: &C) -> PgWireResult<Sql> {
        let hash = client
            .metadata()
            .get("straton_token_hash")
            .ok_or_else(|| pgerror("28P01", "Authentication required"))?;
        let p = crate::access::authenticate_hash(&self.sql.pool, hash)
            .await
            .map_err(|_| pgerror("28P01", "Invalid credentials"))?;
        if client.metadata().get("user") != Some(&p.user.name) {
            return Err(pgerror("28P01", "Invalid credentials"));
        }
        if !p.has("read") {
            return Err(pgerror("42501", "Read privilege required"));
        }
        Ok(self.sql.for_principal(p))
    }
}
impl PgWireServerHandlers for Backend {
    fn simple_query_handler(&self) -> Arc<impl SimpleQueryHandler> {
        Arc::new(self.clone())
    }
    fn extended_query_handler(&self) -> Arc<impl ExtendedQueryHandler> {
        Arc::new(self.clone())
    }
    fn startup_handler(&self) -> Arc<impl StartupHandler> {
        Arc::new(self.clone())
    }
}
#[async_trait]
impl StartupHandler for Backend {
    async fn on_startup<C>(
        &self,
        client: &mut C,
        message: PgWireFrontendMessage,
    ) -> PgWireResult<()>
    where
        C: ClientInfo + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        if self.require_tls && !client.is_secure() {
            return Err(pgerror("08004", "TLS is required for this SQL listener"));
        }
        match message {
            PgWireFrontendMessage::Startup(startup) => {
                auth::protocol_negotiation(client, &startup).await?;
                auth::save_startup_parameters_to_metadata(client, &startup);
                client.set_state(PgWireConnectionState::AuthenticationInProgress);
                client
                    .send(PgWireBackendMessage::Authentication(
                        Authentication::CleartextPassword,
                    ))
                    .await?;
            }
            PgWireFrontendMessage::PasswordMessageFamily(pwd) => {
                let pwd = pwd.into_password()?;
                let p = crate::access::authenticate(&self.sql.pool, &pwd.password)
                    .await
                    .map_err(|_| pgerror("28P01", "Invalid credentials"))?;
                if client.metadata().get("user") != Some(&p.user.name) {
                    return Err(pgerror("28P01", "Invalid credentials"));
                }
                client.metadata_mut().insert(
                    "straton_token_hash".into(),
                    crate::access::hash(&pwd.password),
                );
                let mut parameters = DefaultServerParameterProvider::default();
                parameters.server_version = "16.6-Straton".into();
                parameters.is_superuser = false;
                parameters.default_transaction_read_only = true;
                auth::finish_authentication(client, &parameters).await?;
            }
            _ => {}
        }
        Ok(())
    }
}
fn pgerror(code: &str, message: &str) -> PgWireError {
    PgWireError::UserError(Box::new(ErrorInfo::new(
        "ERROR".into(),
        code.into(),
        message.into(),
    )))
}
impl From<Error> for PgWireError {
    fn from(e: Error) -> Self {
        pgerror(
            match e.class {
                "rejected" => "25006",
                "timeout" => "57014",
                "max_rows" | "memory_limit" => "54000",
                _ => "42601",
            },
            &e.message,
        )
    }
}

// Deliberately small compatibility list; these never alter DataFusion session settings.
fn compatibility(query: &str) -> Option<(String, bool)> {
    let canonical = statement(query).ok()?.to_string();
    let upper = canonical.to_ascii_uppercase();
    let value = match upper.as_str() {
        "SELECT VERSION()" | "SELECT PG_CATALOG.VERSION()" => {
            ("version", "PostgreSQL 16.6 compatible Straton")
        }
        "SELECT CURRENT_SCHEMA()" | "SELECT CURRENT_SCHEMA" => ("current_schema", "public"),
        "SELECT CURRENT_DATABASE()" => ("current_database", "straton"),
        "SHOW SERVER_VERSION" => ("server_version", "16.6"),
        "SHOW SERVER_VERSION_NUM" => ("server_version_num", "160006"),
        "SHOW TRANSACTION_READ_ONLY" | "SHOW DEFAULT_TRANSACTION_READ_ONLY" => {
            ("transaction_read_only", "on")
        }
        "SHOW STANDARD_CONFORMING_STRINGS" => ("standard_conforming_strings", "on"),
        "SHOW CLIENT_ENCODING" => ("client_encoding", "UTF8"),
        "SHOW TIMEZONE" | "SHOW TIME ZONE" => ("TimeZone", "UTC"),
        "SHOW DATESTYLE" => ("DateStyle", "ISO, YMD"),
        "SHOW SEARCH_PATH" => ("search_path", "public"),
        _ => {
            let harmless = [
                "SET EXTRA_FLOAT_DIGITS = 3",
                "SET EXTRA_FLOAT_DIGITS = 2",
                "SET EXTRA_FLOAT_DIGITS TO 3",
                "SET CLIENT_ENCODING = 'UTF8'",
                "SET CLIENT_ENCODING TO 'UTF8'",
                "SET TIME ZONE 'UTC'",
                "SET TIMEZONE = 'UTC'",
                "SET DATESTYLE = 'ISO'",
            ]
            .contains(&upper.as_str())
                || (upper.starts_with("SET APPLICATION_NAME = '")
                    && matches!(statement(query).ok()?, super::Statement::Statement(s) if matches!(s.as_ref(), datafusion::sql::sqlparser::ast::Statement::Set(_))));
            if harmless {
                return Some(("SELECT 1 WHERE false".into(), true));
            }
            return None;
        }
    };
    Some((format!("SELECT '{}' AS \"{}\"", value.1, value.0), false))
}
#[derive(Clone)]
pub struct Prepared {
    original: String,
    query: String,
    noop: bool,
    schema: SchemaRef,
    params: Vec<Type>,
    types: Vec<String>,
}
#[async_trait]
impl QueryParser for Backend {
    type Statement = Prepared;
    async fn parse_sql<C>(
        &self,
        _client: &C,
        query: &str,
        types: &[Option<Type>],
    ) -> PgWireResult<Option<Prepared>>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        let session = self.session(_client).await?;
        let (sql, noop) = compatibility(query).unwrap_or_else(|| (query.to_owned(), false));
        let infer = types.iter().all(Option::is_none);
        let names = if infer {
            Ok(vec![])
        } else {
            types
                .iter()
                .map(|t| sql_type(t.as_ref().unwrap_or(&Type::TEXT)).map(str::to_owned))
                .collect::<PgWireResult<Vec<_>>>()
        };
        let names = match names {
            Ok(names) => names,
            Err(e) => {
                session
                    .audit(query, &BTreeSet::new(), Err("parameters"))
                    .await?;
                return Err(e);
            }
        };
        let out = session
            .audited(query, &sql, vec![], &names, Mode::Describe)
            .await?;
        let params: Vec<Type> = if infer {
            out.parameter_types.iter().map(pg_type).collect()
        } else {
            types
                .iter()
                .map(|t| t.clone().unwrap_or(Type::TEXT))
                .collect()
        };
        let type_names = params
            .iter()
            .map(|t| sql_type(t).map(str::to_owned))
            .collect::<PgWireResult<Vec<_>>>()?;
        Ok(Some(Prepared {
            original: query.to_owned(),
            query: sql,
            noop,
            schema: out.schema,
            params,
            types: type_names,
        }))
    }
    fn get_parameter_types(&self, stmt: &Prepared) -> PgWireResult<Vec<Type>> {
        Ok(stmt.params.clone())
    }
    fn get_result_schema(
        &self,
        stmt: &Prepared,
        format: Option<&Format>,
    ) -> PgWireResult<Vec<FieldInfo>> {
        Ok(if stmt.noop {
            vec![]
        } else {
            fields(&stmt.schema, format.unwrap_or(&Format::UnifiedText))
        })
    }
}
#[async_trait]
impl SimpleQueryHandler for Backend {
    async fn do_query<C>(&self, _client: &mut C, query: &str) -> PgWireResult<Vec<Response>>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        let session = self.session(_client).await?;
        let (sql, noop) = compatibility(query).unwrap_or_else(|| (query.to_owned(), false));
        let result = session
            .audited(query, &sql, vec![], &[], Mode::Query)
            .await?;
        Ok(vec![if noop {
            Response::Execution(Tag::new("SET"))
        } else {
            response(result, &Format::UnifiedText)?
        }])
    }
}
#[async_trait]
impl ExtendedQueryHandler for Backend {
    type Statement = Prepared;
    type QueryParser = Backend;
    fn query_parser(&self) -> Arc<Self::QueryParser> {
        Arc::new(Backend {
            sql: self.sql.clone(),
            require_tls: self.require_tls,
        })
    }
    async fn do_query<C>(
        &self,
        _client: &mut C,
        portal: &Portal<Prepared>,
        _max_rows: usize,
    ) -> PgWireResult<Response>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        let session = self.session(_client).await?;
        let stmt = &portal.statement.statement;
        let params = match parameters(portal) {
            Ok(params) => params,
            Err(e) => {
                session
                    .audit(&stmt.original, &BTreeSet::new(), Err("parameters"))
                    .await?;
                return Err(e);
            }
        };
        let out = session
            .audited(
                &stmt.original,
                &stmt.query,
                params,
                &stmt.types,
                Mode::Query,
            )
            .await?;
        if stmt.noop {
            Ok(Response::Execution(Tag::new("SET")))
        } else {
            response(out, &portal.result_column_format)
        }
    }
}
fn sql_type(t: &Type) -> PgWireResult<&'static str> {
    Ok(match *t {
        Type::BOOL => "BOOLEAN",
        Type::INT2 => "SMALLINT",
        Type::INT4 => "INTEGER",
        Type::INT8 => "BIGINT",
        Type::FLOAT4 => "REAL",
        Type::FLOAT8 => "DOUBLE PRECISION",
        Type::TEXT | Type::VARCHAR | Type::UNKNOWN => "TEXT",
        Type::BYTEA => "BYTEA",
        Type::DATE => "DATE",
        Type::TIMESTAMP => "TIMESTAMP",
        Type::TIMESTAMPTZ => "TIMESTAMP WITH TIME ZONE",
        _ => return Err(pgerror("0A000", "Unsupported parameter type")),
    })
}
fn parameters(portal: &Portal<Prepared>) -> PgWireResult<Vec<ScalarValue>> {
    let types = &portal.statement.statement.params;
    if portal.parameter_len() != types.len() {
        return Err(pgerror("08P01", "Incorrect parameter count"));
    }
    types
        .iter()
        .enumerate()
        .map(|(i, t)| {
            Ok(match *t {
                Type::BOOL => ScalarValue::Boolean(portal.parameter(i, t)?),
                Type::INT2 => ScalarValue::Int16(portal.parameter(i, t)?),
                Type::INT4 => ScalarValue::Int32(portal.parameter(i, t)?),
                Type::INT8 => ScalarValue::Int64(portal.parameter(i, t)?),
                Type::FLOAT4 => ScalarValue::Float32(portal.parameter(i, t)?),
                Type::FLOAT8 => ScalarValue::Float64(portal.parameter(i, t)?),
                Type::TEXT | Type::VARCHAR | Type::UNKNOWN => {
                    ScalarValue::Utf8(portal.parameter(i, &Type::TEXT)?)
                }
                Type::BYTEA => ScalarValue::Binary(portal.parameter(i, t)?),
                Type::DATE => {
                    let date: Option<chrono::NaiveDate> = portal.parameter(i, t)?;
                    let epoch = chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
                    ScalarValue::Date32(date.map(|d| (d - epoch).num_days() as i32))
                }
                Type::TIMESTAMP => {
                    let ts: Option<chrono::NaiveDateTime> = portal.parameter(i, t)?;
                    ScalarValue::TimestampMicrosecond(
                        ts.map(|t| t.and_utc().timestamp_micros()),
                        None,
                    )
                }
                Type::TIMESTAMPTZ => {
                    let ts: Option<chrono::DateTime<chrono::FixedOffset>> =
                        portal.parameter(i, t)?;
                    ScalarValue::TimestampMicrosecond(
                        ts.map(|t| t.timestamp_micros()),
                        Some("+00:00".into()),
                    )
                }
                _ => return Err(pgerror("0A000", "Unsupported parameter type")),
            })
        })
        .collect()
}
fn pg_type(t: &DataType) -> Type {
    match t {
        DataType::Int8 | DataType::Int16 => Type::INT2,
        DataType::Int32 => Type::INT4,
        DataType::Int64 => Type::INT8,
        DataType::Float32 => Type::FLOAT4,
        DataType::Float64 => Type::FLOAT8,
        DataType::Decimal128(..) => Type::NUMERIC,
        DataType::Boolean => Type::BOOL,
        DataType::Date32 | DataType::Date64 => Type::DATE,
        DataType::Timestamp(_, None) => Type::TIMESTAMP,
        DataType::Timestamp(_, Some(_)) => Type::TIMESTAMPTZ,
        DataType::Binary
        | DataType::LargeBinary
        | DataType::BinaryView
        | DataType::FixedSizeBinary(_) => Type::BYTEA,
        _ => Type::TEXT,
    }
}
fn fields(schema: &Schema, format: &Format) -> Vec<FieldInfo> {
    schema
        .fields()
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let mut info = FieldInfo::new(
                f.name().clone(),
                None,
                None,
                pg_type(f.data_type()),
                format.format_for(i),
            );
            if let DataType::Decimal128(precision, scale) = f.data_type() {
                info = info.with_type_modifier(
                    (((*precision as i32) << 16) | (*scale as i32 & 0x7ff)) + 4,
                );
            }
            info
        })
        .collect()
}
fn response(out: Output, format: &Format) -> PgWireResult<Response> {
    let header = Arc::new(fields(&out.schema, format));
    // Keep the Arrow result reservation alive while pgwire drains the portal.
    let stream = stream::try_unfold(
        (out, 0, 0, format.clone()),
        |(out, mut batch, mut row, format)| async move {
            while batch < out.batches.len() && row == out.batches[batch].num_rows() {
                batch += 1;
                row = 0;
            }
            if batch == out.batches.len() {
                return Ok(None);
            }
            let b = &out.batches[batch];
            let mut buffer = Vec::new();
            for (i, a) in b.columns().iter().enumerate() {
                if a.is_null(row) {
                    buffer.extend_from_slice(&(-1_i32).to_be_bytes());
                    continue;
                }
                let value = encode(a.as_ref(), row, format.is_binary(i))?;
                buffer.extend_from_slice(&(value.len() as i32).to_be_bytes());
                buffer.extend_from_slice(&value);
            }
            let data = DataRow::new(buffer.as_slice().into(), b.num_columns() as i16);
            Ok(Some((data, (out, batch, row + 1, format))))
        },
    );
    Ok(Response::Query(QueryResponse::new(header, stream)))
}
fn encode(a: &dyn Array, row: usize, binary: bool) -> PgWireResult<Vec<u8>> {
    let scalar = ScalarValue::try_from_array(a, row).map_err(Error::from)?;
    let text =
        array_value_to_string(a, row).map_err(|_| pgerror("22000", "Cannot format SQL result"))?;
    macro_rules! bytes {
        ($v:expr) => {
            $v.to_be_bytes().to_vec()
        };
    }
    let data = match scalar {
        ScalarValue::Boolean(Some(v)) => {
            if binary {
                vec![u8::from(v)]
            } else {
                if v { b"t".to_vec() } else { b"f".to_vec() }
            }
        }
        ScalarValue::Int8(Some(v)) if binary => bytes!(i16::from(v)),
        ScalarValue::Int16(Some(v)) if binary => bytes!(v),
        ScalarValue::Int32(Some(v)) if binary => bytes!(v),
        ScalarValue::Int64(Some(v)) if binary => bytes!(v),
        ScalarValue::Float32(Some(v)) if binary => bytes!(v),
        ScalarValue::Float64(Some(v)) if binary => bytes!(v),
        ScalarValue::Decimal128(..) if binary => numeric(&text)?,
        ScalarValue::Date32(Some(v)) => {
            if binary {
                bytes!(
                    v.checked_sub(10957)
                        .ok_or_else(|| pgerror("22008", "Date out of range"))?
                )
            } else {
                text.into_bytes()
            }
        }
        ScalarValue::Date64(Some(v)) => {
            let days =
                i32::try_from(v / 86_400_000).map_err(|_| pgerror("22008", "Date out of range"))?;
            if binary {
                bytes!(
                    days.checked_sub(10957)
                        .ok_or_else(|| pgerror("22008", "Date out of range"))?
                )
            } else {
                chrono::DateTime::from_timestamp_millis(v)
                    .ok_or_else(|| pgerror("22008", "Date out of range"))?
                    .date_naive()
                    .to_string()
                    .into_bytes()
            }
        }
        ScalarValue::TimestampSecond(Some(v), _) => {
            timestamp(v.checked_mul(1_000_000), a.data_type(), binary)?
        }
        ScalarValue::TimestampMillisecond(Some(v), _) => {
            timestamp(v.checked_mul(1000), a.data_type(), binary)?
        }
        ScalarValue::TimestampMicrosecond(Some(v), _) => timestamp(Some(v), a.data_type(), binary)?,
        ScalarValue::TimestampNanosecond(Some(v), _) => {
            timestamp(Some(v.div_euclid(1000)), a.data_type(), binary)?
        }
        ScalarValue::Binary(Some(v))
        | ScalarValue::LargeBinary(Some(v))
        | ScalarValue::BinaryView(Some(v))
        | ScalarValue::FixedSizeBinary(_, Some(v)) => {
            if binary {
                v
            } else {
                let mut s = String::from("\\x");
                for b in v {
                    use std::fmt::Write;
                    let _ = write!(s, "{b:02x}");
                }
                s.into_bytes()
            }
        }
        _ => text.into_bytes(),
    };
    Ok(data)
}
fn timestamp(micros: Option<i64>, datatype: &DataType, binary: bool) -> PgWireResult<Vec<u8>> {
    let micros = micros.ok_or_else(|| pgerror("22008", "Timestamp out of range"))?;
    if binary {
        Ok(micros
            .checked_sub(946_684_800_000_000)
            .ok_or_else(|| pgerror("22008", "Timestamp out of range"))?
            .to_be_bytes()
            .to_vec())
    } else {
        let mut s = chrono::DateTime::from_timestamp_micros(micros)
            .ok_or_else(|| pgerror("22008", "Timestamp out of range"))?
            .format("%Y-%m-%d %H:%M:%S%.6f")
            .to_string();
        if matches!(datatype, DataType::Timestamp(_, Some(_))) {
            s.push_str("+00");
        }
        Ok(s.into_bytes())
    }
}
fn numeric(text: &str) -> PgWireResult<Vec<u8>> {
    let negative = text.starts_with('-');
    let unsigned = text.trim_start_matches('-');
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let scale = fraction.len() as i16;
    let left = (4 - whole.len() % 4) % 4;
    let right = (4 - fraction.len() % 4) % 4;
    let padded = format!("{}{whole}{fraction}{}", "0".repeat(left), "0".repeat(right));
    let mut digits = padded
        .as_bytes()
        .chunks(4)
        .map(|b| {
            std::str::from_utf8(b)
                .ok()
                .and_then(|s| s.parse::<i16>().ok())
                .ok_or_else(|| pgerror("22003", "Invalid numeric"))
        })
        .collect::<PgWireResult<Vec<_>>>()?;
    let mut weight = (whole.len() + left) as i16 / 4 - 1;
    while digits.first() == Some(&0) {
        digits.remove(0);
        weight -= 1;
    }
    while digits.last() == Some(&0) {
        digits.pop();
    }
    let mut out = Vec::new();
    for v in [
        digits.len() as i16,
        if digits.is_empty() { 0 } else { weight },
        if negative { 0x4000_i16 } else { 0 },
        scale,
    ] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    for v in digits {
        out.extend_from_slice(&v.to_be_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_binary_preserves_precision_and_scale() {
        let decode = |bytes: Vec<u8>| {
            bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| i16::from_be_bytes(*b))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            decode(numeric("1234.5678").unwrap()),
            vec![2, 0, 0, 4, 1234, 5678]
        );
        assert_eq!(
            decode(numeric("-0.0001").unwrap()),
            vec![1, -1, 0x4000, 4, 1]
        );
        assert_eq!(decode(numeric("10000.00").unwrap()), vec![1, 1, 0, 2, 1]);
        assert_eq!(decode(numeric("0.000").unwrap()), vec![0, 0, 0, 3]);
        assert_eq!(
            decode(numeric("12345678901234567890123456789012345678").unwrap()),
            vec![
                10, 9, 0, 0, 12, 3456, 7890, 1234, 5678, 9012, 3456, 7890, 1234, 5678
            ]
        );
    }
    #[test]
    fn compatibility_is_single_statement_and_does_not_allow_configuration_changes() {
        for query in [
            "SELECT version()",
            "SHOW transaction_read_only",
            "SET extra_float_digits = 3",
            "SET application_name = 'DBeaver'",
        ] {
            assert!(compatibility(query).is_some(), "{query}");
        }
        for query in [
            "SET datafusion.execution.batch_size=1",
            "SET application_name='x'; COPY (SELECT 1) TO 'x.parquet'",
            "SELECT version(); SELECT 2",
            "SET search_path = 'secret'",
        ] {
            assert!(compatibility(query).is_none(), "{query}");
        }
    }
}
