use crate::{credentials, store};
use anyhow::{Context, Result, ensure};
use datafusion::{
    arrow::datatypes::SchemaRef,
    common::config::{EncryptionFactoryOptions, TableParquetOptions},
    datasource::file_format::parquet::ParquetFormat,
    execution::parquet_encryption::EncryptionFactory,
    object_store::path::Path as ObjectPath,
    prelude::SessionContext,
};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::{collections::BTreeSet, io::Write, path::Path, sync::Arc};
use straton_connectors::parquet::{
    arrow::arrow_reader::{ArrowReaderOptions, ParquetRecordBatchReaderBuilder},
    encryption::{decrypt::FileDecryptionProperties, encrypt::FileEncryptionProperties},
};

// All keychain/DB transitions share this gate, including snapshot key resolution.
static GATE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

pub struct DataKey {
    pub id: String,
    key: [u8; 32],
}
#[derive(Serialize, Deserialize)]
struct Kek {
    version: i64,
    key: [u8; 32],
}
pub(crate) fn account(pool: &SqlitePool, pending: bool) -> String {
    let name = if pending { "kek.pending" } else { "kek" };
    #[cfg(test)]
    {
        format!("{name}:{}", pool.connect_options().get_filename().display())
    }
    #[cfg(not(test))]
    {
        let _ = pool;
        name.into()
    }
}
fn get_kek(pool: &SqlitePool, pending: bool) -> Result<Option<Kek>> {
    credentials::get(&account(pool, pending))
        .context("cannot read KEK from OS keychain")?
        .map(|s| serde_json::from_str(s.expose_secret()).context("invalid KEK keychain entry"))
        .transpose()
}
fn set_kek(pool: &SqlitePool, pending: bool, kek: &Kek) -> Result<()> {
    credentials::set(&account(pool, pending), &serde_json::to_string(kek)?.into())
        .context("cannot write KEK to OS keychain")
}
fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("secure key generation failed"))?;
    Ok(bytes)
}
fn wrapping_key(kek: &[u8; 32]) -> Result<aead::LessSafeKey> {
    Ok(aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, kek)
            .map_err(|_| anyhow::anyhow!("invalid KEK"))?,
    ))
}
// JSON array framing makes the key-id / target-id boundary unambiguous.
fn associated_data(id: &str, target: &str) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&(id, target))?)
}
fn wrap(kek: &[u8; 32], id: &str, target: &str, dek: &[u8; 32]) -> Result<Vec<u8>> {
    let nonce = random::<12>()?;
    let mut ciphertext = dek.to_vec();
    wrapping_key(kek)?
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(associated_data(id, target)?),
            &mut ciphertext,
        )
        .map_err(|_| anyhow::anyhow!("DEK wrapping failed"))?;
    let mut wrapped = nonce.to_vec();
    wrapped.extend(ciphertext);
    Ok(wrapped)
}
fn unwrap(kek: &[u8; 32], id: &str, target: &str, wrapped: &[u8]) -> Result<[u8; 32]> {
    ensure!(
        wrapped.len() == 12 + 32 + aead::AES_256_GCM.tag_len(),
        "cannot unwrap dataset key: invalid wrapped DEK"
    );
    let nonce: [u8; 12] = wrapped[..12].try_into()?;
    let mut ciphertext = wrapped[12..].to_vec();
    let plaintext = wrapping_key(kek)?
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(associated_data(id, target)?),
            &mut ciphertext,
        )
        .map_err(|_| anyhow::anyhow!("cannot unwrap dataset key; encrypted data is unavailable"))?;
    let mut dek = [0; 32];
    dek.copy_from_slice(plaintext);
    Ok(dek)
}
async fn load_kek(pool: &SqlitePool) -> Result<Kek> {
    let version: i64 = sqlx::query_scalar("SELECT kek_version FROM security_state WHERE id=1")
        .fetch_one(pool)
        .await?;
    let active = get_kek(pool, false)?;
    if let Some(kek) = active.as_ref()
        && kek.version == version
    {
        return Ok(Kek {
            version,
            key: kek.key,
        });
    }
    // A committed rotation can always finish from the durable pending keychain entry.
    if let Some(pending) = get_kek(pool, true)?
        && pending.version == version
    {
        set_kek(pool, false, &pending)?;
        credentials::delete(&account(pool, true))?;
        return Ok(pending);
    }
    anyhow::bail!("KEK missing or version mismatch in OS keychain; encrypted data is unavailable")
}
pub async fn initialize(pool: &SqlitePool) -> Result<()> {
    let _guard = GATE.write().await;
    let version: i64 = sqlx::query_scalar("SELECT kek_version FROM security_state WHERE id=1")
        .fetch_one(pool)
        .await?;
    if version != 0 {
        load_kek(pool).await?;
        return Ok(());
    }
    let has_keys: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM dataset_keys)")
        .fetch_one(pool)
        .await?;
    ensure!(
        !has_keys,
        "KEK version is missing for existing dataset keys; encrypted data is unavailable"
    );
    // Keychain first: a crash before this DB commit simply retries initialization.
    let kek = match get_kek(pool, false)? {
        Some(kek) => kek,
        None => {
            let kek = Kek {
                version: 1,
                key: random()?,
            };
            set_kek(pool, false, &kek)?;
            kek
        }
    };
    sqlx::query("UPDATE security_state SET kek_version=? WHERE id=1 AND kek_version=0")
        .bind(kek.version)
        .execute(pool)
        .await?;
    Ok(())
}
async fn resolve(pool: &SqlitePool, id: &str) -> Result<DataKey> {
    let _guard = GATE.read().await;
    let kek = load_kek(pool).await?;
    let row = sqlx::query("SELECT target_id,wrapped_key,kek_version FROM dataset_keys WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("snapshot references an unknown dataset key"))?;
    ensure!(
        row.get::<i64, _>("kek_version") == kek.version,
        "dataset key KEK version mismatch"
    );
    Ok(DataKey {
        id: id.into(),
        key: unwrap(&kek.key, id, row.get("target_id"), row.get("wrapped_key"))?,
    })
}
async fn active(pool: &SqlitePool, target: &str) -> Result<DataKey> {
    initialize(pool).await?;
    let _guard = GATE.read().await;
    let kek = load_kek(pool).await?;
    let mut tx = pool.begin().await?;
    // Acquire SQLite's writer reservation before looking up the active key.
    sqlx::query("UPDATE security_state SET kek_version=kek_version WHERE id=1")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT id,wrapped_key,kek_version FROM dataset_keys WHERE target_id=? AND retired_at IS NULL")
        .bind(target).fetch_optional(&mut *tx).await?;
    let key = if let Some(row) = row {
        ensure!(
            row.get::<i64, _>("kek_version") == kek.version,
            "dataset key KEK version mismatch"
        );
        let id: String = row.get("id");
        DataKey {
            key: unwrap(&kek.key, &id, target, row.get("wrapped_key"))?,
            id,
        }
    } else {
        let id = store::id();
        let key = random()?;
        sqlx::query("INSERT INTO dataset_keys(id,target_id,wrapped_key,kek_version,created_at) VALUES(?,?,?,?,?)")
            .bind(&id).bind(target).bind(wrap(&kek.key, &id, target, &key)?).bind(kek.version).bind(store::now())
            .execute(&mut *tx).await?;
        DataKey { id, key }
    };
    tx.commit().await?;
    Ok(key)
}
fn durable(path: &Path, value: &str) -> Result<()> {
    let temporary = path.with_extension("partial");
    let mut file = std::fs::File::create(&temporary)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(temporary, path)?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
pub async fn for_write(
    pool: &SqlitePool,
    dir: &Path,
    target: &str,
    enabled: bool,
) -> Result<Option<DataKey>> {
    std::fs::create_dir_all(dir)?;
    let marker = dir.join("_staging_key");
    match std::fs::read_to_string(&marker) {
        Ok(id) if id == "plaintext" => return Ok(None),
        Ok(id) => return Ok(Some(resolve(pool, &id).await?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if enabled {
        // Never mix newly encrypted parts with a pre-upgrade checkpoint's plaintext parts.
        let mut directories = vec![dir.to_owned()];
        while let Some(directory) = directories.pop() {
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    directories.push(entry.path());
                } else {
                    ensure!(
                        entry.path().extension().is_none_or(|e| e != "parquet"),
                        "legacy staging has no key record; cancel and start a new run"
                    );
                }
            }
        }
    }
    let key = if enabled {
        Some(active(pool, target).await?)
    } else {
        None
    };
    durable(&marker, key.as_ref().map_or("plaintext", |k| k.id.as_str()))?;
    Ok(key)
}
pub fn finish(dir: &Path, key: Option<&DataKey>) -> Result<()> {
    if let Some(key) = key {
        durable(&dir.join("_key"), &key.id)?;
    }
    Ok(())
}
pub async fn snapshot(pool: &SqlitePool, dir: &Path) -> Result<Option<DataKey>> {
    match std::fs::read_to_string(dir.join("_key")) {
        Ok(id) => Ok(Some(resolve(pool, &id).await?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn encryption(key: Option<&DataKey>) -> Result<Option<Arc<FileEncryptionProperties>>> {
    key.map(|k| {
        FileEncryptionProperties::builder(k.key.to_vec())
            .build()
            .map_err(Into::into)
    })
    .transpose()
}
pub fn reader(
    path: &Path,
    key: Option<&DataKey>,
) -> Result<ParquetRecordBatchReaderBuilder<std::fs::File>> {
    let mut options = ArrowReaderOptions::new();
    if let Some(key) = key {
        options = options.with_file_decryption_properties(
            FileDecryptionProperties::builder(key.key.to_vec()).build()?,
        );
    }
    Ok(ParquetRecordBatchReaderBuilder::try_new_with_options(
        std::fs::File::open(path)?,
        options,
    )?)
}

// Each table carries only its key id. The shared runtime never retains plaintext DEKs.
struct Decryption(SqlitePool);
impl std::fmt::Debug for Decryption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SnapshotDecryption([redacted])")
    }
}
#[async_trait::async_trait]
impl EncryptionFactory for Decryption {
    async fn get_file_encryption_properties(
        &self,
        _: &EncryptionFactoryOptions,
        _: &SchemaRef,
        _: &ObjectPath,
    ) -> datafusion::error::Result<Option<Arc<FileEncryptionProperties>>> {
        Ok(None)
    }
    async fn get_file_decryption_properties(
        &self,
        config: &EncryptionFactoryOptions,
        _: &ObjectPath,
    ) -> datafusion::error::Result<Option<Arc<FileDecryptionProperties>>> {
        let id = config.options.get("key_id").ok_or_else(|| {
            datafusion::error::DataFusionError::Execution("snapshot key id missing".into())
        })?;
        let key = resolve(&self.0, id)
            .await
            .map_err(|e| datafusion::error::DataFusionError::Execution(e.to_string()))?;
        Ok(Some(
            FileDecryptionProperties::builder(key.key.to_vec()).build()?,
        ))
    }
}
pub fn format(pool: &SqlitePool, ctx: &SessionContext, key: Option<&DataKey>) -> ParquetFormat {
    let mut options = TableParquetOptions::default();
    if let Some(key) = key {
        let _ = ctx
            .runtime_env()
            .register_parquet_encryption_factory("straton", Arc::new(Decryption(pool.clone())));
        options.crypto.factory_id = Some("straton".into());
        options
            .crypto
            .factory_options
            .options
            .insert("key_id".into(), key.id.clone());
    }
    ParquetFormat::default().with_options(options)
}
#[derive(Serialize)]
pub struct KeyInfo {
    id: String,
    target_id: String,
    kek_version: i64,
    created_at: i64,
    retired_at: Option<i64>,
}
pub async fn list(pool: &SqlitePool) -> Result<Vec<KeyInfo>> {
    Ok(sqlx::query("SELECT id,target_id,kek_version,created_at,retired_at FROM dataset_keys ORDER BY created_at,id")
        .fetch_all(pool).await?.into_iter().map(|r| KeyInfo {
            id: r.get("id"), target_id: r.get("target_id"), kek_version: r.get("kek_version"),
            created_at: r.get("created_at"), retired_at: r.get("retired_at"),
        }).collect())
}
pub async fn rotate_kek(pool: &SqlitePool) -> Result<i64> {
    let _guard = GATE.write().await;
    let old = load_kek(pool).await?;
    let new = Kek {
        version: old.version.checked_add(1).context("KEK version overflow")?,
        key: random()?,
    };
    // Crash-safe ordering: persist pending in the keychain, commit all wraps + version,
    // then replace kek. Before commit the old KEK works; after commit load_kek recovers pending.
    set_kek(pool, true, &new)?;
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE security_state SET kek_version=? WHERE id=1")
        .bind(new.version)
        .execute(&mut *tx)
        .await?;
    for row in sqlx::query("SELECT id,target_id,wrapped_key FROM dataset_keys")
        .fetch_all(&mut *tx)
        .await?
    {
        let id: &str = row.get("id");
        let target: &str = row.get("target_id");
        let dek = unwrap(&old.key, id, target, row.get("wrapped_key"))?;
        sqlx::query("UPDATE dataset_keys SET wrapped_key=?,kek_version=? WHERE id=?")
            .bind(wrap(&new.key, id, target, &dek)?)
            .bind(new.version)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    store::audit(
        &mut tx,
        "keys.rotate_kek",
        "kek",
        &format!("version {}", new.version),
    )
    .await?;
    tx.commit().await?;
    set_kek(pool, false, &new)?;
    credentials::delete(&account(pool, true))?;
    Ok(new.version)
}
pub async fn retire(pool: &SqlitePool, target: &str) -> Result<()> {
    let _guard = GATE.write().await;
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE security_state SET kek_version=kek_version WHERE id=1")
        .execute(&mut *tx)
        .await?;
    let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runs r JOIN jobs j ON j.id=r.job_id JOIN datasets d ON d.source_id=j.source_id AND d.name=j.dataset WHERE d.id=? AND r.state IN ('queued','running','interrupted'))")
        .bind(target).fetch_one(&mut *tx).await?;
    ensure!(
        !busy,
        "wait for active runs before rotating the dataset key"
    );
    sqlx::query("UPDATE dataset_keys SET retired_at=? WHERE target_id=? AND retired_at IS NULL")
        .bind(store::now())
        .bind(target)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "keys.rotate_dataset", target, "").await?;
    tx.commit().await?;
    Ok(())
}
pub async fn cleanup(pool: &SqlitePool, root: &Path) -> Result<()> {
    let _guard = GATE.write().await;
    let retired =
        sqlx::query_scalar::<_, String>("SELECT id FROM dataset_keys WHERE retired_at IS NOT NULL")
            .fetch_all(pool)
            .await?;
    if retired.is_empty() {
        return Ok(());
    }
    let mut referenced = BTreeSet::new();
    let mut dirs = vec![root.to_owned()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                dirs.push(entry.path());
            } else if kind.is_file()
                && (entry.file_name() == "_key" || entry.file_name() == "_staging_key")
            {
                referenced.insert(std::fs::read_to_string(entry.path())?);
            }
        }
    }
    let mut tx = pool.begin().await?;
    for id in retired {
        if !referenced.contains(&id) {
            sqlx::query("DELETE FROM dataset_keys WHERE id=? AND retired_at IS NOT NULL")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wrap_round_trip_and_authentication() {
        let kek = random().unwrap();
        let dek = random().unwrap();
        let wrapped = wrap(&kek, "key", "target", &dek).unwrap();
        assert_eq!(unwrap(&kek, "key", "target", &wrapped).unwrap(), dek);
        let mut tampered = wrapped.clone();
        tampered[20] ^= 1;
        assert!(unwrap(&kek, "key", "target", &tampered).is_err());
        assert!(unwrap(&kek, "other", "target", &wrapped).is_err());
        assert!(unwrap(&kek, "key", "other", &wrapped).is_err());
    }
    #[tokio::test]
    async fn committed_rotation_recovers_pending_and_failed_wrap_preserves_old_kek() {
        let dir = std::env::temp_dir().join(format!("straton-keys-test-{}", store::id()));
        let pool = store::open(&dir).await.unwrap();
        initialize(&pool).await.unwrap();
        let first = active(&pool, "target").await.unwrap();
        let original = credentials::get(&account(&pool, false)).unwrap().unwrap();
        assert_eq!(rotate_kek(&pool).await.unwrap(), 2);
        let replacement = credentials::get(&account(&pool, false)).unwrap().unwrap();
        // Reproduce a stop after commit, before replacing the active keychain entry.
        credentials::set(&account(&pool, true), &replacement).unwrap();
        credentials::set(&account(&pool, false), &original).unwrap();
        initialize(&pool).await.unwrap();
        assert_eq!(resolve(&pool, &first.id).await.unwrap().key, first.key);
        assert_eq!(get_kek(&pool, false).unwrap().unwrap().version, 2);
        assert!(get_kek(&pool, true).unwrap().is_none());
        // A broken DEK aborts the transaction and never replaces the active KEK.
        sqlx::query("UPDATE dataset_keys SET wrapped_key=? WHERE id=?")
            .bind(vec![0_u8; 60])
            .bind(&first.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(rotate_kek(&pool).await.is_err());
        assert_eq!(get_kek(&pool, false).unwrap().unwrap().version, 2);
        let version: i64 = sqlx::query_scalar("SELECT kek_version FROM security_state WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, 2);
        credentials::delete(&account(&pool, false)).unwrap();
        credentials::delete(&account(&pool, true)).unwrap();
        pool.close().await;
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn staging_keeps_its_key_choice_and_rejects_mixed_legacy_parts() {
        let dir = std::env::temp_dir().join(format!("straton-staging-key-test-{}", store::id()));
        let pool = store::open(&dir).await.unwrap();
        let staging = dir.join("data/staging");
        let key = for_write(&pool, &staging, "target", true)
            .await
            .unwrap()
            .unwrap();
        let resumed = for_write(&pool, &staging, "target", false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(key.id, resumed.id);
        retire(&pool, "target").await.unwrap();
        cleanup(&pool, &dir.join("data")).await.unwrap();
        assert!(resolve(&pool, &key.id).await.is_ok());
        std::fs::remove_dir_all(staging).unwrap();
        cleanup(&pool, &dir.join("data")).await.unwrap();
        assert!(resolve(&pool, &key.id).await.is_err());
        let legacy = dir.join("data/legacy");
        std::fs::create_dir_all(legacy.join("delta")).unwrap();
        std::fs::write(legacy.join("delta/part-000000.parquet"), b"legacy").unwrap();
        assert!(for_write(&pool, &legacy, "target", true).await.is_err());
        assert!(
            for_write(&pool, &legacy, "target", false)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            for_write(&pool, &legacy, "target", true)
                .await
                .unwrap()
                .is_none()
        );
        pool.close().await;
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
