//! Shared HTTP client for SaaS connectors: HTTPS only, rate limited, retrying.
use rand::Rng;
use reqwest::{StatusCode, Url, header::RETRY_AFTER};
use serde_json::Value;
use std::time::{Duration, Instant};
use straton_core::{Error, Result};
use tokio::sync::Mutex;

pub(crate) struct Http {
    client: reqwest::Client,
    base: Url,
    auth: String,
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
            auth,
            bucket: Mutex::new((rps, Instant::now())),
            rps,
            backoff: Duration::from_millis(500),
            attempts: 5,
        })
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

    /// GET a JSON document. Errors name the status only: never the URL or credentials.
    pub(crate) async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value> {
        let url = self
            .base
            .join(path)
            .map_err(|_| Error::Invalid("invalid request path".into()))?;
        let mut attempt = 0;
        loop {
            attempt += 1;
            self.throttle().await;
            let sent = self
                .client
                .get(url.clone())
                .query(query)
                .header("Authorization", &self.auth)
                .send()
                .await;
            let retry_after = match sent {
                Ok(r) if r.status().is_success() => {
                    return r
                        .json()
                        .await
                        .map_err(|_| Error::Connector("response was not valid JSON".into()));
                }
                Ok(r)
                    if r.status() == StatusCode::TOO_MANY_REQUESTS
                        || r.status().is_server_error() =>
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
                    // Provider messages can echo masked keys, so only the error code is kept.
                    let code = r.json::<Value>().await.ok().and_then(|v| {
                        v["error"]["code"]
                            .as_str()
                            .or(v["error"]["type"].as_str())
                            .map(str::to_owned)
                    });
                    return Err(Error::Connector(match code {
                        Some(code) => format!("request failed (HTTP {status}, {code})"),
                        None => format!("request failed (HTTP {status})"),
                    }));
                }
                Err(e) if e.is_timeout() || e.is_connect() => None,
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
}
