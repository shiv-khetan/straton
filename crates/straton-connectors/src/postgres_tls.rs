use super::*;
use sqlx::postgres::PgSslMode;
use std::str::FromStr;

pub(super) fn local(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|a| a.is_loopback())
}
pub(super) fn host_valid(host: &str) -> bool {
    !host.is_empty()
        && !host
            .chars()
            .any(|c| c.is_whitespace() || "@/?#\\".contains(c))
}
pub(super) fn options(config: &Value) -> Result<PgConnectOptions> {
    let allowed = [
        "host",
        "port",
        "database",
        "username",
        "batch_size",
        "advisor_may_write",
        "sslmode",
        "ca_cert_path",
        "options",
    ];
    if config
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(invalid(
            "invalid Postgres configuration; credentials belong in secret",
        ));
    }
    let host = config["host"].as_str().unwrap_or("localhost");
    if !host_valid(host) {
        return Err(invalid("invalid Postgres host"));
    }
    let mode =
        match config["sslmode"]
            .as_str()
            .unwrap_or(if local(host) { "prefer" } else { "require" })
        {
            "disable" => PgSslMode::Disable,
            "prefer" => PgSslMode::Prefer,
            "require" => PgSslMode::Require,
            "verify-full" => PgSslMode::VerifyFull,
            _ => return Err(invalid("invalid Postgres SSL mode")),
        };
    let mut opts = if let Some(options) = config["options"].as_str() {
        let endpoint = options
            .strip_prefix("endpoint=")
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .ok_or_else(|| invalid("Postgres options must be endpoint=<id>"))?;
        // sqlx's options() builder adds -c; Neon needs the raw startup option.
        PgConnectOptions::from_str(&format!("postgres:///?options=endpoint%3D{endpoint}"))
            .map_err(error)?
    } else {
        PgConnectOptions::new()
    }
    .ssl_mode(mode);
    if let Some(path) = config["ca_cert_path"].as_str() {
        if path.is_empty() {
            return Err(invalid("CA certificate path is empty"));
        }
        opts = opts.ssl_root_cert(path);
    }
    Ok(opts)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_neon_options() {
        assert!(matches!(
            options(&json!({})).unwrap().get_ssl_mode(),
            PgSslMode::Prefer
        ));
        assert!(matches!(options(&json!({"host":"ep-example-pooler.us-east-2.aws.neon.tech","options":"endpoint=ep-example"})).unwrap().get_ssl_mode(), PgSslMode::Require));
        assert!(matches!(
            options(&json!({"host":"::1","sslmode":"verify-full","ca_cert_path":"root.pem"}))
                .unwrap()
                .get_ssl_mode(),
            PgSslMode::VerifyFull
        ));
        for bad in [
            json!({"password":"hidden"}),
            json!({"options":"endpoint=x -c log_statement=all"}),
            json!({"sslmode":"unknown"}),
            json!({"host":"user:secret@host"}),
        ] {
            assert!(options(&bad).is_err());
        }
    }
}
