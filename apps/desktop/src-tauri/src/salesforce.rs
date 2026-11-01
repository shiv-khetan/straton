//! Salesforce OAuth 2.0 authorization-code flow with PKCE, via the system browser.
//! The callback matches the Salesforce CLI convention so admins can reuse connected apps.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{Rng, distr::Alphanumeric};
use reqwest::Url;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::{Duration, timeout},
};

const PORT: u16 = 1717;
const REDIRECT: &str = "http://localhost:1717/OauthRedirect";

#[derive(Serialize)]
pub struct Grant {
    refresh_token: String,
    instance_url: String,
}

fn https(raw: &str) -> Result<Url, String> {
    Url::parse(raw)
        .ok()
        .filter(|u| u.scheme() == "https" && u.username().is_empty() && u.password().is_none())
        .ok_or_else(|| "Salesforce URLs must use https".into())
}
fn random(n: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(n)
        .map(char::from)
        .collect()
}
/// RFC 7636 S256 code challenge.
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[tauri::command]
pub async fn salesforce_authorize(login_url: String, client_id: String) -> Result<Grant, String> {
    let login = https(&login_url)?;
    if client_id.trim().is_empty() {
        return Err("Enter the connected app's consumer key".into());
    }
    let verifier = random(64);
    let state = random(32);
    let listener = TcpListener::bind(("127.0.0.1", PORT))
        .await
        .map_err(|_| "Port 1717 is busy; finish or close the other Salesforce sign-in and retry")?;
    let mut url = login
        .join("services/oauth2/authorize")
        .map_err(|_| "invalid login URL")?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", REDIRECT)
        .append_pair("code_challenge", &challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", "api refresh_token")
        .append_pair("state", &state);
    open_browser(url.as_str())?;
    let code = timeout(Duration::from_secs(300), receive(&listener, &state))
        .await
        .map_err(|_| "Salesforce sign-in timed out after 5 minutes")??;
    let response = reqwest::Client::new()
        .post(
            login
                .join("services/oauth2/token")
                .map_err(|_| "invalid login URL")?,
        )
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("redirect_uri", REDIRECT),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "Could not reach Salesforce")?;
    let ok = response.status().is_success();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if !ok {
        return Err(format!(
            "Salesforce rejected the sign-in ({})",
            body["error"].as_str().unwrap_or("unknown error")
        ));
    }
    let refresh_token = body["refresh_token"]
        .as_str()
        .ok_or("No refresh token returned: add the refresh_token scope to the connected app")?;
    let instance_url = body["instance_url"]
        .as_str()
        .ok_or("No instance URL returned")?;
    https(instance_url)?;
    Ok(Grant {
        refresh_token: refresh_token.into(),
        instance_url: instance_url.into(),
    })
}

/// Constant-time comparison of the OAuth `state` parameter.
fn state_matches(received: Option<&str>, expected: &str) -> bool {
    let Some(received) = received else {
        return false;
    };
    received.len() == expected.len()
        && received
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Serve the loopback redirect until the browser delivers `/OauthRedirect`.
async fn receive(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|_| "Sign-in callback failed")?;
        let mut buf = vec![0u8; 8192];
        // A local client that connects and never sends must not stall the sign-in.
        let n = timeout(Duration::from_secs(5), socket.read(&mut buf))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let path = request
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("");
        if !path.starts_with("/OauthRedirect") {
            // Browsers also ask for /favicon.ico; keep waiting for the real callback.
            let _ = socket
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let query: HashMap<String, String> = Url::parse(&format!("http://localhost{path}"))
            .map(|u| u.query_pairs().into_owned().collect())
            .unwrap_or_default();
        if !state_matches(query.get("state").map(String::as_str), state) {
            // Any local process or web page can hit the loopback port. A request without
            // this flow's state is not the browser callback: reject it and keep waiting
            // instead of letting it abort (or race) the real sign-in.
            let _ = socket
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let result = if let Some(error) = query.get("error") {
            Err(format!("Salesforce sign-in was not completed ({error})"))
        } else {
            query
                .get("code")
                .cloned()
                .ok_or_else(|| "Salesforce returned no authorization code".to_owned())
        };
        let page = if result.is_ok() {
            "Signed in to Salesforce. You can close this tab and return to Straton."
        } else {
            "Salesforce sign-in failed. Return to Straton for details."
        };
        let html = format!(
            "<!doctype html><meta charset=utf-8><title>Straton</title><p style=\"font:16px system-ui;margin:40px\">{page}</p>"
        );
        let _ = socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                    html.len()
                )
                .as_bytes(),
            )
            .await;
        return result;
    }
}

fn open_browser(url: &str) -> Result<(), String> {
    use std::process::Command;
    #[cfg(windows)]
    let spawned = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = Command::new("xdg-open").arg(url).spawn();
    spawned
        .map(|_| ())
        .map_err(|_| "Could not open the system browser".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc_7636_example() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(https("http://login.salesforce.com").is_err());
        assert!(https("https://login.salesforce.com").is_ok());
        assert!(state_matches(Some("abc"), "abc"));
        assert!(!state_matches(Some("abd"), "abc"));
        assert!(!state_matches(Some("ab"), "abc"));
        assert!(!state_matches(None, "abc"));
    }

    #[tokio::test]
    async fn callback_checks_state_and_skips_other_paths() {
        async fn hit(listener_port: u16, path: &str) {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", listener_port))
                .await
                .unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut out = Vec::new();
            let _ = s.read_to_end(&mut out).await;
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = tokio::spawn(async move {
            hit(port, "/favicon.ico").await;
            hit(port, "/OauthRedirect?code=abc&state=s1").await;
        });
        assert_eq!(receive(&listener, "s1").await.unwrap(), "abc");
        client.await.unwrap();

        // A forged callback with the wrong state is ignored; the real one still completes.
        let client = tokio::spawn(async move {
            hit(port, "/OauthRedirect?code=evil&state=other").await;
            hit(port, "/OauthRedirect?error=access_denied").await;
            hit(port, "/OauthRedirect?code=good&state=s1").await;
        });
        assert_eq!(receive(&listener, "s1").await.unwrap(), "good");
        client.await.unwrap();

        // The provider's error is surfaced when it carries the right state.
        let client =
            tokio::spawn(
                async move { hit(port, "/OauthRedirect?error=access_denied&state=s1").await },
            );
        assert!(receive(&listener, "s1").await.is_err());
        client.await.unwrap();

        // A silent connection does not block the real callback forever.
        let client = tokio::spawn(async move {
            let _idle = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            hit(port, "/OauthRedirect?code=late&state=s1").await;
        });
        assert_eq!(
            timeout(Duration::from_secs(15), receive(&listener, "s1"))
                .await
                .unwrap()
                .unwrap(),
            "late"
        );
        client.await.unwrap();
    }
}
