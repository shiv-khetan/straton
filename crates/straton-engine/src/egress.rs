//! Outbound connection policy for connectors (SSRF defense).
//!
//! Every connector is built through `catalog::connector`, which calls [`check`] first.
//! The check resolves each configured host and refuses addresses that a data connector
//! never legitimately needs:
//!
//! * always: unspecified (`0.0.0.0`, `::`), link-local (`169.254.0.0/16` — including the
//!   cloud instance-metadata endpoint — and `fe80::/10`), multicast, broadcast, and the
//!   well-known metadata addresses `100.100.100.200` and `fd00:ec2::254`;
//! * when `[network] allow_private = false`: loopback, RFC 1918, CGNAT `100.64.0.0/10`
//!   and IPv6 unique-local `fc00::/7` as well.
//!
//! Self-hosted deployments usually sync from databases on the local network, so private
//! ranges are allowed by default. This is a pre-connect check: a hostname whose DNS
//! answer changes between the check and the driver's own lookup (DNS rebinding) is not
//! covered, and `mongodb+srv` seed lists are checked by their SRV domain only.
use anyhow::{Result, bail};
use serde_json::Value;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::atomic::{AtomicBool, Ordering},
};

static ALLOW_PRIVATE: AtomicBool = AtomicBool::new(true);

pub fn set_allow_private(allow: bool) {
    ALLOW_PRIVATE.store(allow, Ordering::Relaxed);
}

/// Why an address is refused, or `None` when it is allowed.
pub fn refused(ip: IpAddr, allow_private: bool) -> Option<&'static str> {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast() {
                Some("non-unicast address")
            } else if v4.is_link_local() || v4 == Ipv4Addr::new(100, 100, 100, 200) {
                Some("link-local or instance-metadata address")
            } else if !allow_private
                && (v4.is_loopback()
                    || v4.is_private()
                    || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64))
            {
                Some("private-network address (network.allow_private = false)")
            } else {
                None
            }
        }
        IpAddr::V6(v6) => {
            if v6.is_unspecified() || v6.is_multicast() {
                Some("non-unicast address")
            } else if v6.is_unicast_link_local()
                || v6 == Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254)
            {
                Some("link-local or instance-metadata address")
            } else if !allow_private && (v6.is_loopback() || v6.is_unique_local()) {
                Some("private-network address (network.allow_private = false)")
            } else {
                None
            }
        }
    }
}

/// Extract the host from `host`, `host:port`, `[v6]:port`, a bare IPv6 literal, or a URL.
fn host_of(raw: &str) -> Option<String> {
    let raw = raw.trim();
    // Postgres accepts a Unix socket directory as its host; that is not a network target.
    if raw.is_empty() || raw.starts_with('/') {
        return None;
    }
    let rest = raw.split_once("://").map_or(raw, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or(v6)
    } else if authority.matches(':').count() == 1 {
        authority.split(':').next().unwrap_or(authority)
    } else {
        authority
    };
    (!host.is_empty()).then(|| host.to_owned())
}

/// Every network host a connector config can point at.
pub fn hosts(config: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["host", "api_base", "instance_url", "login_url"] {
        if let Some(h) = config.get(key).and_then(Value::as_str).and_then(host_of) {
            out.push(h);
        }
    }
    if let Some(list) = config.get("hosts").and_then(Value::as_array) {
        out.extend(list.iter().filter_map(Value::as_str).filter_map(host_of));
    }
    out
}

/// Refuse a connector whose configured hosts resolve to a forbidden address.
/// Unresolvable names are left to the driver, which will fail to connect.
pub async fn check(config: &Value) -> Result<()> {
    check_with(config, ALLOW_PRIVATE.load(Ordering::Relaxed)).await
}
pub async fn check_with(config: &Value, allow_private: bool) -> Result<()> {
    for host in hosts(config) {
        let addrs: Vec<IpAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![ip]
        } else {
            match tokio::net::lookup_host((host.as_str(), 0)).await {
                Ok(addrs) => addrs.map(|a| a.ip()).collect(),
                Err(_) => continue,
            }
        };
        for ip in addrs {
            if let Some(reason) = refused(ip, allow_private) {
                bail!("connector host {host} resolves to a forbidden {reason}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_addresses() {
        for (ip, always, strict) in [
            ("169.254.169.254", true, true),
            ("100.100.100.200", true, true),
            ("0.0.0.0", true, true),
            ("255.255.255.255", true, true),
            ("224.0.0.1", true, true),
            ("fe80::1", true, true),
            ("fd00:ec2::254", true, true),
            ("::", true, true),
            ("::ffff:169.254.169.254", true, true),
            ("127.0.0.1", false, true),
            ("10.1.2.3", false, true),
            ("172.16.0.1", false, true),
            ("192.168.1.1", false, true),
            ("100.64.0.1", false, true),
            ("::1", false, true),
            ("fd12::1", false, true),
            ("::ffff:10.0.0.1", false, true),
            ("8.8.8.8", false, false),
            ("2606:4700::1111", false, false),
        ] {
            let ip: IpAddr = ip.parse().unwrap();
            assert_eq!(refused(ip, true).is_some(), always, "{ip} default");
            assert_eq!(refused(ip, false).is_some(), strict, "{ip} strict");
        }
    }

    #[test]
    fn extracts_hosts_from_every_config_shape() {
        let config = json!({
            "host": "db.internal:5432",
            "hosts": ["a.example:27017", "[fe80::1]:27018", "::1"],
            "api_base": "https://user:pw@api.example.com:8443/v1?x=1",
            "instance_url": "https://acme.my.salesforce.com",
            "login_url": "mongodb+srv://cluster.example.net/db",
        });
        assert_eq!(
            hosts(&config),
            [
                "db.internal",
                "api.example.com",
                "acme.my.salesforce.com",
                "cluster.example.net",
                "a.example",
                "fe80::1",
                "::1"
            ]
        );
        assert!(hosts(&json!({"host": "/var/run/postgresql"})).is_empty());
        assert!(hosts(&json!({"path": "/data/app.db"})).is_empty());
    }

    #[tokio::test]
    async fn check_refuses_metadata_and_honours_private_switch() {
        let metadata = json!({"host": "169.254.169.254"});
        assert!(check_with(&metadata, true).await.is_err());
        let url = json!({"api_base": "http://[fe80::1]/"});
        assert!(check_with(&url, true).await.is_err());
        let local = json!({"host": "127.0.0.1", "port": 5432});
        assert!(check_with(&local, true).await.is_ok());
        assert!(check_with(&local, false).await.is_err());
        // Names are resolved: localhost is loopback.
        assert!(
            check_with(&json!({"host": "localhost"}), false)
                .await
                .is_err()
        );
        // Unresolvable names are left to the driver.
        assert!(
            check_with(&json!({"host": "no-such-host.invalid"}), false)
                .await
                .is_ok()
        );
    }
}
