use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::diagnostics::sources::{app_catalog, SourceCatalog};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::parser::Outbound;

use super::model::{
    ChildProfileRecord, EngineKind, ProviderMetadata, SubscriptionFailure, SubscriptionKind,
    SubscriptionRecord,
};

/// Persistence-only representation. Raw subscription data is serialized only
/// here; command-facing records intentionally do not implement `Serialize`.
#[derive(Clone, Serialize, Deserialize)]
struct StoredSubscriptionRecord {
    id: String,
    name: String,
    #[serde(default)]
    user_named: bool,
    url: String,
    #[serde(default)]
    kind: SubscriptionKind,
    #[serde(default)]
    engine: Option<EngineKind>,
    interval_minutes: u32,
    #[serde(default)]
    active_child_key: Option<String>,
    #[serde(default)]
    children: Vec<StoredChildProfileRecord>,
    #[serde(default)]
    link_outbounds: Vec<Outbound>,
    #[serde(default)]
    bundle_digest: Option<String>,
    #[serde(default)]
    metadata: ProviderMetadata,
    #[serde(default)]
    last_success_at: Option<DateTime<Utc>>,
    #[serde(default)]
    last_http_status: Option<u16>,
    #[serde(default)]
    last_error: Option<SubscriptionFailure>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredChildProfileRecord {
    key: String,
    name: String,
    engine: EngineKind,
    config: Value,
    #[serde(default)]
    digest: String,
}

impl From<StoredSubscriptionRecord> for SubscriptionRecord {
    fn from(stored: StoredSubscriptionRecord) -> Self {
        Self {
            id: stored.id,
            name: stored.name,
            user_named: stored.user_named,
            url: stored.url,
            kind: stored.kind,
            engine: stored.engine,
            interval_minutes: stored.interval_minutes,
            active_child_key: stored.active_child_key,
            children: stored.children.into_iter().map(Into::into).collect(),
            link_outbounds: stored.link_outbounds,
            bundle_digest: stored.bundle_digest,
            metadata: stored.metadata,
            last_success_at: stored.last_success_at,
            last_http_status: stored.last_http_status,
            last_error: stored.last_error,
        }
    }
}

impl From<&SubscriptionRecord> for StoredSubscriptionRecord {
    fn from(record: &SubscriptionRecord) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            user_named: record.user_named,
            url: record.url.clone(),
            kind: record.kind,
            engine: record.engine,
            interval_minutes: record.interval_minutes,
            active_child_key: record.active_child_key.clone(),
            children: record.children.iter().map(Into::into).collect(),
            link_outbounds: record.link_outbounds.clone(),
            bundle_digest: record.bundle_digest.clone(),
            metadata: record.metadata.clone(),
            last_success_at: record.last_success_at,
            last_http_status: record.last_http_status,
            last_error: record.last_error.clone(),
        }
    }
}

impl From<StoredChildProfileRecord> for ChildProfileRecord {
    fn from(stored: StoredChildProfileRecord) -> Self {
        Self {
            key: stored.key,
            name: stored.name,
            engine: stored.engine,
            config: stored.config,
            digest: stored.digest,
        }
    }
}

impl From<&ChildProfileRecord> for StoredChildProfileRecord {
    fn from(record: &ChildProfileRecord) -> Self {
        Self {
            key: record.key.clone(),
            name: record.name.clone(),
            engine: record.engine,
            config: record.config.clone(),
            digest: record.digest.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SubscriptionStore {
    path: PathBuf,
    catalog: Arc<SourceCatalog>,
}

impl SubscriptionStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            catalog: app_catalog().clone(),
        }
    }

    /// Creates a separate fixture catalog. Clone the store to share its write gate.
    #[cfg(test)]
    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self {
            path,
            catalog: Arc::default(),
        }
    }

    pub fn load_all(&self) -> AppResult<Vec<SubscriptionRecord>> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(
                serde_json::from_slice::<Vec<StoredSubscriptionRecord>>(&bytes)?
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            ),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn replace_all(&self, records: &[SubscriptionRecord]) -> AppResult<()> {
        let _mutation = self.catalog.mutation()?;
        self.replace_all_with(records, |temporary_path, target_path| {
            fs::rename(temporary_path, target_path)
        })
    }

    #[cfg(test)]
    fn replace_all_with_replace<F>(
        &self,
        records: &[SubscriptionRecord],
        replace: F,
    ) -> AppResult<()>
    where
        F: FnOnce(&Path, &Path) -> std::io::Result<()>,
    {
        self.replace_all_with(records, replace)
    }

    fn replace_all_with<F>(&self, records: &[SubscriptionRecord], replace: F) -> AppResult<()>
    where
        F: FnOnce(&Path, &Path) -> std::io::Result<()>,
    {
        ensure_parent(&self.path)?;
        let temporary_path = temporary_path(&self.path)?;
        let result = (|| -> AppResult<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temporary_path)?;
            let stored = records
                .iter()
                .map(StoredSubscriptionRecord::from)
                .collect::<Vec<_>>();
            serde_json::to_writer_pretty(&mut file, &stored)?;
            file.write_all(b"\n")?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            replace(&temporary_path, &self.path)?;
            Ok(())
        })();

        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }
}

fn ensure_parent(path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn temporary_path(path: &Path) -> AppResult<PathBuf> {
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::Validation("subscription store path has no file name".into()))?
        .to_string_lossy();
    Ok(path.with_file_name(format!("{file_name}.tmp")))
}

#[cfg(test)]
mod tests {
    use super::SubscriptionStore;
    use crate::subscriptions::model::{
        ChildProfileRecord, EngineKind, ProviderMetadata, SubscriptionKind, SubscriptionRecord,
    };
    use serde_json::json;
    use std::fs;
    use std::io::{self, ErrorKind};

    fn sample_record(name: &str) -> SubscriptionRecord {
        SubscriptionRecord {
            id: "sub-1".into(),
            name: name.into(),
            user_named: false,
            url: "https://example.test/private-token".into(),
            kind: SubscriptionKind::Auto,
            engine: None,
            interval_minutes: 60,
            active_child_key: None,
            children: Vec::new(),
            link_outbounds: Vec::new(),
            bundle_digest: None,
            metadata: ProviderMetadata::default(),
            last_success_at: None,
            last_http_status: None,
            last_error: None,
        }
    }

    #[tokio::test]
    async fn handoff_blocks_its_own_store_and_leaves_other_catalogs_writable() {
        let dir = tempfile::tempdir().unwrap();
        let first = SubscriptionStore::for_test(dir.path().join("first.json"));
        let second = SubscriptionStore::for_test(dir.path().join("second.json"));
        let epoch = first.catalog.epoch();
        let _handoff = first.catalog.handoff().await;

        assert!(matches!(
            first.clone().replace_all(&[]),
            Err(crate::error::AppError::Validation(message)) if message == "profile_source_busy"
        ));
        second.replace_all(&[]).unwrap();
        assert_eq!(first.catalog.epoch(), epoch);
        assert_eq!(second.catalog.epoch(), 2);
    }

    #[test]
    fn missing_store_loads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = SubscriptionStore::for_test(dir.path().join("subscriptions.json"));
        assert!(store.load_all().unwrap().is_empty());
    }

    #[test]
    fn storage_round_trip_preserves_private_bundle_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subscriptions.json");
        let store = SubscriptionStore::for_test(path);
        let mut record = sample_record("Bundle");
        record.children = vec![ChildProfileRecord {
            key: "index-0".into(),
            name: "Private child".into(),
            engine: EngineKind::Singbox,
            config: json!({"outbounds": [{"server": "private.example.test"}]}),
            digest: "digest".into(),
        }];

        store.replace_all(&[record]).unwrap();
        let loaded = store.load_all().unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].children[0].key, "index-0");
        assert!(loaded[0].children[0].config.is_object());
    }

    #[test]
    fn failed_replace_preserves_previous_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subscriptions.json");
        let store = SubscriptionStore::for_test(path.clone());
        store.replace_all(&[sample_record("First")]).unwrap();
        let previous_bytes = fs::read(&path).unwrap();

        let result = store.replace_all_with_replace(&[sample_record("Replacement")], |_, _| {
            Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "forced replacement failure",
            ))
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), previous_bytes);
        assert_eq!(store.load_all().unwrap()[0].name, "First");
    }

    #[test]
    fn replace_all_atomically_replaces_and_survives_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subscriptions.json");
        let store = SubscriptionStore::for_test(path.clone());

        store.replace_all(&[sample_record("First")]).unwrap();
        store.replace_all(&[sample_record("Replacement")]).unwrap();

        let records = SubscriptionStore::for_test(path.clone()).load_all().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "Replacement");
        assert!(!path.with_file_name("subscriptions.json.tmp").exists());
    }
}
