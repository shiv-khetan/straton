use anyhow::Result;
#[cfg(not(test))]
use secrecy::ExposeSecret;
use secrecy::SecretString;
#[cfg(not(test))]
pub fn get(id: &str) -> Result<Option<SecretString>> {
    match keyring::Entry::new("straton", id)?.get_password() {
        Ok(s) => Ok(Some(s.into())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => anyhow::bail!("keychain read failed"),
    }
}
#[cfg(not(test))]
pub fn set(id: &str, secret: &SecretString) -> Result<()> {
    keyring::Entry::new("straton", id)?
        .set_password(secret.expose_secret())
        .map_err(|_| anyhow::anyhow!("keychain write failed"))
}
#[cfg(not(test))]
pub fn delete(id: &str) -> Result<()> {
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
