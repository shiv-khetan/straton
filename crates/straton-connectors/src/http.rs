//! Shared HTTP client for SaaS connectors: HTTPS only, rate limited, retrying.
use rand::Rng;
use reqwest::{Method, Response, StatusCode, Url, header::HeaderMap, header::RETRY_AFTER};
use serde_json::Value;
use std::time::{Duration, Instant};
use straton_core::{Error, Result};
use tokio::sync::{Mutex, RwLock};

pub(crate) struct Http {
    client: reqwest::Client,
    base: Url,
    /// `Authorization` header value; swappable for providers with short-lived access tokens.
    auth: RwLock<String>,
    bucket: Mutex<(f64, Instant)>,
    rps: f64,
    pub(crate) backoff: Duration,
    pub(crate) attempts: u32,
}

/// HTTPS is required; plain HTTP is accepted only for a loopback test server.
pub(crate) fn base_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| Error::Invalid("invalid api_base".into()))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(Error::Invalid("api_base must use https".into()));
    }
    Ok(url)
}

/// Provider error bodies can echo masked keys, so only a machine-readable code is kept.
fn error_code(v: &Value) -> Option<String> {
    [
        &v["error"]["code"],
        &v["error"]["type"],
        &v[0]["errorCode"],
        &v["error"],
    ]
    .into_iter()
    .find_map(|c| c.as_str().map(str::to_owned))
}

impl Http {
    pub(crate) fn new(base: Url, auth: String, rps: f64) -> Result<Self> {
        if !(rps > 0.0 && rps <= 1000.0) {
            return Err(Error::Invalid(
                "rate_limit_rps must be between 0 and 1000".into(),
            ));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .https_only(base.scheme() == "https")
            .build()
            .map_err(|_| Error::Connector("HTTP client setup failed".into()))?;
        Ok(Self {
            client,
            base,
            auth: RwLock::new(auth),
            bucket: Mutex::new((rps, Instant::now())),
            rps,
            backoff: Duration::from_millis(500),
            attempts: 5,
        })
    }

    pub(crate) async fn set_auth(&self, auth: String) {
        *self.auth.write().await = auth;
    }

    // ponytail: one token bucket per source, held across the sleep; fine at SaaS request rates.
    async fn throttle(&self) {
        let mut b = self.bucket.lock().await;
        let now = Instant::now();
        b.0 = (b.0 + now.duration_since(b.1).as_secs_f64() * self.rps).min(self.rps);
        b.1 = now;
        if b.0 < 1.0 {
            tokio::time::sleep(Duration::from_secs_f64((1.0 - b.0) / self.rps)).await;
            b.0 = 1.0;
            b.1 = Instant::now();
        }
        b.0 -= 1.0;
    }

    /// Send a request and return a successful response. Only GETs are retried (429/5xx/timeouts).
    /// Errors name the status only: never the URL or credentials.
    async fn send(
        &self,
        method: Method,
        path: &str,
        query: &[(String, String)],
        body: Option<&Value>,
    ) -> Result<Response> {
        let url = self
            .base
            .join(path)
            .map_err(|_| Error::Invalid("invalid request path".into()))?;
        let retry = method == Method::GET;
        let mut attempt = 0;
        loop {
            attempt += 1;
            self.throttle().await;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .query(query)
                .header("Authorization", self.auth.read().await.as_str());
            if let Some(body) = body {
                request = request.json(body);
            }
            let retry_after = match request.send().await {
                Ok(r) if r.status().is_success() => return Ok(r),
                Ok(r)
                    if retry
                        && (r.status() == StatusCode::TOO_MANY_REQUESTS
                            || r.status().is_server_error()) =>
                {
                    r.headers()
                        .get(RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .map(Duration::from_secs)
                }
                Ok(r) if matches!(r.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
                    return Err(Error::Connector(format!(
                        "credentials were rejected (HTTP {})",
                        r.status().as_u16()
                    )));
                }
                Ok(r) => {
                    let status = r.status().as_u16();
                    let code = r.json::<Value>().await.ok().and_then(|v| error_code(&v));
                    return Err(Error::Connector(match code {
                        Some(code) => format!("request failed (HTTP {status}, {code})"),
                        None => format!("request failed (HTTP {status})"),
                    }));
                }
                Err(e) if retry && (e.is_timeout() || e.is_connect()) => None,
                Err(_) => return Err(Error::Connector("request failed".into())),
            };
            if attempt >= self.attempts {
                return Err(Error::Connector(format!(
                    "request failed after {attempt} attempts"
                )));
            }
            let jitter = Duration::from_millis(
                rand::rng().random_range(0..=self.backoff.as_millis() as u64 / 2),
            );
            let wait = retry_after.unwrap_or(self.backoff * 2u32.pow(attempt - 1) + jitter);
            tokio::time::sleep(wait.min(Duration::from_secs(60))).await;
        }
    }

    pub(crate) async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value> {
        json(self.send(Method::GET, path, query, None).await?).await
    }

    /// GET a text body (e.g. CSV) together with its response headers.
    pub(crate) async fn get_text(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<(HeaderMap, String)> {
        let r = self.send(Method::GET, path, query, None).await?;
        let headers = r.headers().clone();
        let text = r
            .text()
            .await
            .map_err(|_| Error::Connector("response body could not be read".into()))?;
        Ok((headers, text))
    }

    /// POST JSON. Not retried: the caller decides whether a repeat is safe.
    pub(crate) async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        json(self.send(Method::POST, path, &[], Some(body)).await?).await
    }

    /// POST an OAuth token request (form-encoded, no Authorization header, not retried).
    /// Returns the provider's `error` code on failure so callers can spot `invalid_grant`.
    pub(crate) async fn token(
        &self,
        path: &str,
        form: &[(&str, &str)],
    ) -> std::result::Result<Value, String> {
        let url = self.base.join(path).map_err(|_| "invalid token path")?;
        self.throttle().await;
        let r = self
            .client
            .post(url)
            .form(form)
            .send()
            .await
            .map_err(|_| "token request failed".to_owned())?;
        let ok = r.status().is_success();
        let body: Value = r.json().await.unwrap_or(Value::Null);
        if ok {
            Ok(body)
        } else {
            Err(body["error"]
                .as_str()
                .unwrap_or("token request failed")
                .to_owned())
        }
    }
}

async fn json(r: Response) -> Result<Value> {
    r.json()
        .await
        .map_err(|_| Error::Connector("response was not valid JSON".into()))
}
