//! Failed-authentication telemetry for the HTTP API and the SQL endpoint.
//!
//! Tokens are 256-bit random values, so guessing one is infeasible. Repeated failures
//! point instead at a revoked or leaked token still in use, a misconfigured client, or
//! scanning. The engine counts presented-but-invalid credentials per source address in a
//! bounded in-memory window. When an address crosses [`THRESHOLD`] within [`WINDOW`], it
//! writes one `auth.failures` audit row and notifies admins.
//!
//! It deliberately does not lock addresses out: behind a reverse proxy or NAT every client
//! shares one address, so a lockout would let anyone deny service to everyone else.
use crate::{notify, runner::Events, store};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const WINDOW: Duration = Duration::from_secs(600);
pub const THRESHOLD: u32 = 20;
/// Addresses tracked at once; beyond this, expired and then the quietest entries go first.
const MAX_TRACKED: usize = 4096;

struct Entry {
    failures: u32,
    started: Instant,
    first_at: i64,
    last_at: i64,
    alerted: bool,
    surface: &'static str,
}
impl Entry {
    fn new(now: Instant, at: i64, surface: &'static str) -> Self {
        Self {
            failures: 0,
            started: now,
            first_at: at,
            last_at: at,
            alerted: false,
            surface,
        }
    }
}

/// One per engine (held by [`crate::sql::Sql`], shared by the HTTP API and pgwire).
#[derive(Default)]
pub struct AuthFailures {
    map: Mutex<HashMap<IpAddr, Entry>>,
}
static EVENTS: OnceLock<Events> = OnceLock::new();

/// Lets alerts reach connected admins live; without it they are stored only.
pub fn init(events: Events) {
    let _ = EVENTS.set(events);
}

impl AuthFailures {
    /// Count one failure. Returns the count when this failure first crosses the threshold
    /// in the current window, so each address alerts at most once per window.
    fn count(&self, ip: IpAddr, surface: &'static str) -> Option<u32> {
        let now = Instant::now();
        let at = store::now();
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if !map.contains_key(&ip) && map.len() >= MAX_TRACKED {
            map.retain(|_, e| now.duration_since(e.started) < WINDOW);
            if map.len() >= MAX_TRACKED
                && let Some(quietest) = map.iter().min_by_key(|(_, e)| e.last_at).map(|(k, _)| *k)
            {
                map.remove(&quietest);
            }
        }
        let entry = map
            .entry(ip)
            .or_insert_with(|| Entry::new(now, at, surface));
        if now.duration_since(entry.started) >= WINDOW {
            *entry = Entry::new(now, at, surface);
        }
        entry.failures += 1;
        entry.last_at = at;
        entry.surface = surface;
        (entry.failures >= THRESHOLD && !std::mem::replace(&mut entry.alerted, true))
            .then_some(entry.failures)
    }

    /// Record a rejected credential from `ip`. Best effort: telemetry never changes the
    /// authentication answer and never fails the request.
    pub async fn record(&self, pool: &SqlitePool, ip: Option<IpAddr>, surface: &'static str) {
        let Some(ip) = ip else { return };
        let Some(failures) = self.count(ip, surface) else {
            return;
        };
        let address = ip.to_string();
        tracing::warn!(%address, failures, surface, "repeated failed authentication");
        let detail = json!({"address":address,"failures":failures,"window_secs":WINDOW.as_secs(),"surface":surface}).to_string();
        if let Ok(mut tx) = pool.begin().await
            && store::audit_as(&mut tx, "auth.failures", &address, &detail, None)
                .await
                .is_ok()
        {
            let _ = tx.commit().await;
        }
        let events = EVENTS
            .get()
            .cloned()
            .unwrap_or_else(|| tokio::sync::broadcast::channel(1).0);
        let _ = notify::emit(
            pool,
            &events,
            notify::Notice {
                severity: "warn",
                kind: "auth.failures",
                title: "Repeated failed sign-ins",
                entity_kind: "address",
                entity_id: &address,
                user_id: None,
            },
        )
        .await;
    }

    /// Addresses with failures in the current window, most failures first.
    pub fn snapshot(&self) -> Vec<Value> {
        let now = Instant::now();
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let mut rows: Vec<_> = map
            .iter()
            .filter(|(_, e)| now.duration_since(e.started) < WINDOW)
            .collect();
        rows.sort_by(|a, b| {
            b.1.failures
                .cmp(&a.1.failures)
                .then(b.1.last_at.cmp(&a.1.last_at))
        });
        rows.into_iter()
            .map(|(ip, e)| {
                json!({"address":ip.to_string(),"failures":e.failures,"first_at":e.first_at,"last_at":e.last_at,"surface":e.surface,"alerted":e.alerted})
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn alerts_once_per_window_and_stays_bounded() {
        let failures = AuthFailures::default();
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        for n in 1..THRESHOLD {
            assert_eq!(failures.count(ip, "http"), None, "{n}");
        }
        assert_eq!(failures.count(ip, "http"), Some(THRESHOLD));
        assert_eq!(failures.count(ip, "sql"), None, "one alert per window");
        assert_eq!(failures.snapshot()[0]["failures"], THRESHOLD + 1);
        for i in 0..(MAX_TRACKED as u32 + 10) {
            failures.count(IpAddr::from(i.to_be_bytes()), "http");
        }
        assert!(failures.map.lock().unwrap().len() <= MAX_TRACKED);
    }
}
