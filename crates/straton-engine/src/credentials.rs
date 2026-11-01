//! Connector secrets and the KEK. Two stores:
//!
//! * the OS keychain (default): Windows Credential Manager, macOS Keychain, and on Linux the
//!   kernel keyutils keyring, which is **in-memory only and lost on reboot**;
//! * a directory of owner-only files (`[secrets] dir` / `STRATON_SECRETS_DIR`), for servers,
//!   containers and any Linux deployment that must survive a restart.
use anyhow::{Context, Result};
#[cfg(not(test))]
use secrecy::ExposeSecret;
use secrecy::SecretString;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Store secrets as files in `dir` instead of the OS keychain. Call once at startup.
pub fn use_directory(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).context("cannot create secrets directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let dir = std::path::absolute(dir)?;
    let _ = DIR.set(dir);
    Ok(())
}

/// Which store holds secrets, for diagnostics and the Settings page.
pub fn store_kind() -> &'static str {
    if DIR.get().is_some() {
        "file"
    } else if cfg!(target_os = "linux") {
        "kernel-keyring"
    } else {
        "os-keychain"
    }
}

fn file_path(dir: &Path, id: &str) -> PathBuf {
    // Hex keeps any account name (source ids, kek, kek.pending) a single safe file name.
    let name: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    dir.join(name + ".secret")
}
pub(crate) fn file_get(dir: &Path, id: &str) -> Result<Option<SecretString>> {
    let path = file_path(dir, id);
    match std::fs::File::open(&path) {
        Ok(file) => {
            crate::security::restrict(&file, &path)?;
            let value = std::fs::read_to_string(&path).context("secret file read failed")?;
            Ok(Some(value.into()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::from(e).context("secret file read failed")),
    }
}
/// Atomic replace: restricted temp file, fsync, rename, then fsync the directory, so a crash
/// leaves either the old or the new secret, never a truncated KEK.
pub(crate) fn file_set(dir: &Path, id: &str, secret: &str) -> Result<()> {
    let path = file_path(dir, id);
    let mut suffix = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut suffix);
    let temp = dir.join(format!(
        ".tmp-{}",
        suffix
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .context("secret file write failed")?;
    let written = (|| -> Result<()> {
        crate::security::restrict(&file, &temp)?;
        file.write_all(secret.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(e) = written.and_then(|()| Ok(std::fs::rename(&temp, &path)?)) {
        let _ = std::fs::remove_file(&temp);
        return Err(e.context("secret file write failed"));
    }
    #[cfg(unix)]
    std::fs::File::open(dir)?.sync_all()?;
    Ok(())
}
pub(crate) fn file_delete(dir: &Path, id: &str) -> Result<()> {
    match std::fs::remove_file(file_path(dir, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::Error::from(e).context("secret file delete failed")),
    }
}

#[cfg(not(test))]
pub fn get(id: &str) -> Result<Option<SecretString>> {
    if let Some(dir) = DIR.get() {
        return file_get(dir, id);
    }
    match keyring::Entry::new("straton", id)?.get_password() {
        Ok(s) => Ok(Some(s.into())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => anyhow::bail!("keychain read failed"),
    }
}
#[cfg(not(test))]
pub fn set(id: &str, secret: &SecretString) -> Result<()> {
    if let Some(dir) = DIR.get() {
        return file_set(dir, id, secret.expose_secret());
    }
    keyring::Entry::new("straton", id)?
        .set_password(secret.expose_secret())
        .map_err(|_| anyhow::anyhow!("keychain write failed"))
}
#[cfg(not(test))]
pub fn delete(id: &str) -> Result<()> {
    if let Some(dir) = DIR.get() {
        return file_delete(dir, id);
    }
    match keyring::Entry::new("straton", id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => anyhow::bail!("keychain delete failed"),
    }
}
#[cfg(test)]
static SECRETS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, SecretString>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
#[cfg(test)]
pub fn get(id: &str) -> Result<Option<SecretString>> {
    Ok(SECRETS.lock().unwrap().get(id).cloned())
}
#[cfg(test)]
pub fn set(id: &str, secret: &SecretString) -> Result<()> {
    SECRETS.lock().unwrap().insert(id.into(), secret.clone());
    Ok(())
}
#[cfg(test)]
pub fn delete(id: &str) -> Result<()> {
    SECRETS.lock().unwrap().remove(id);
    Ok(())
}

#[cfg(test)]
mod file_store_tests {
    use super::*;
    use secrecy::ExposeSecret;

    #[test]
    fn file_store_round_trips_replaces_atomically_and_restricts() {
        let dir = std::env::temp_dir().join(format!("straton-secrets-{}", crate::store::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(file_get(&dir, "kek").unwrap().is_none());
        file_set(&dir, "kek", "first").unwrap();
        file_set(&dir, "kek", "second").unwrap();
        assert_eq!(
            file_get(&dir, "kek").unwrap().unwrap().expose_secret(),
            "second"
        );
        // Account names cannot escape the directory or collide.
        file_set(&dir, "../evil", "x").unwrap();
        file_set(&dir, "kek.pending", "p").unwrap();
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(
            names
                .iter()
                .all(|n| n.ends_with(".secret") && !n.contains('/'))
        );
        assert!(!dir.parent().unwrap().join("evil").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(file_path(&dir, "kek"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        file_delete(&dir, "kek").unwrap();
        file_delete(&dir, "kek").unwrap();
        assert!(file_get(&dir, "kek").unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
