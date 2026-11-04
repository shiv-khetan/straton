#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod salesforce;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri_plugin_fs::FsExt;

#[derive(Serialize, Deserialize)]
struct Connection {
    url: String,
    token: String,
}

fn entry() -> Result<Entry, String> {
    Entry::new("straton-desktop", "connection").map_err(|_| "OS keychain is unavailable".into())
}

fn validate_connection(url: &str, token: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Invalid engine URL")?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || token.trim().is_empty()
    {
        return Err("Use HTTPS or loopback HTTP, a root URL, and a nonempty token".into());
    }
    Ok(())
}

#[tauri::command]
fn save_connection(url: String, token: String) -> Result<(), String> {
    validate_connection(&url, &token)?;
    let value = serde_json::to_string(&Connection { url, token })
        .map_err(|_| "Could not encode connection")?;
    entry()?
        .set_password(&value)
        .map_err(|_| "Could not save connection in OS keychain".into())
}

#[tauri::command]
fn load_connection() -> Result<Option<Connection>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "Invalid saved connection".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read OS keychain".into()),
    }
}

#[tauri::command]
fn forget_connection() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not forget connection in OS keychain".into()),
    }
}

#[tauri::command]
async fn save_export(app: tauri::AppHandle, path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = std::path::PathBuf::from(path);
    if !target.is_absolute() || !app.fs_scope().is_allowed(&target) {
        return Err("Choose the export path in the Save dialog first".into());
    }
    if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_symlink()) {
        return Err("Export path must be a regular file".into());
    }
    tauri::async_runtime::spawn_blocking(move || std::fs::write(target, bytes))
        .await
        .map_err(|_| "Export writer stopped".to_string())?
        .map_err(|e| format!("Could not save export: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![
            save_export,
            save_connection,
            load_connection,
            forget_connection,
            salesforce::salesforce_authorize
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Straton desktop");
}

#[cfg(test)]
mod tests {
    use super::validate_connection;

    #[test]
    fn only_root_https_or_loopback_http_with_token() {
        for url in [
            "http://127.0.0.1:8787",
            "http://localhost:8787",
            "http://[::1]:8787",
            "https://engine.example",
        ] {
            assert!(validate_connection(url, "token").is_ok());
        }
        for url in [
            "http://engine.example",
            "http://[::2]:8787",
            "https://user:secret@engine.example",
            "https://engine.example/path",
            "https://engine.example/?token=secret",
            "https://engine.example/#fragment",
            "file:///engine",
            "not a url",
        ] {
            assert!(validate_connection(url, "token").is_err(), "{url}");
        }
        assert!(validate_connection("https://engine.example", "  ").is_err());
    }
}
