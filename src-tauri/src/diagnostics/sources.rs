//! Source revisions never contain configuration credentials.
use serde::Serialize;
use sha2::{Digest, Sha256};
pub fn revision(value: &impl Serialize) -> String {
    let canonical = serde_json::to_value(value).expect("serializable profile source");
    format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()))
}
pub fn ready_revision(
    engine: crate::subscriptions::EngineKind,
    config: &serde_json::Value,
) -> String {
    revision(&(engine, config))
}
pub fn require_revision(
    expected: Option<&str>,
    actual: Option<&str>,
) -> crate::error::AppResult<()> {
    if expected.is_some() && expected != actual {
        return Err(crate::error::AppError::Validation(
            "profile_source_changed".into(),
        ));
    }
    Ok(())
}
#[tauri::command]
pub fn profile_source_revisions(outbounds: Vec<crate::parser::Outbound>) -> Vec<String> {
    outbounds.iter().map(revision).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_revision_changes_with_payload_and_engine() {
        let a = serde_json::json!({"server":"test.invalid","password":"secret"});
        let b = serde_json::json!({"server":"test.invalid","password":"changed"});
        assert_ne!(revision(&a), revision(&b));
        assert!(!revision(&a).contains("secret"));
        assert_ne!(
            ready_revision(crate::subscriptions::EngineKind::Singbox, &a),
            ready_revision(crate::subscriptions::EngineKind::Xray, &a)
        );
    }
    #[test]
    fn replaced_positional_entry_cannot_be_reconnected() {
        assert!(require_revision(Some("old"), Some("new")).is_err());
        assert!(require_revision(Some("old"), None).is_err());
        assert!(require_revision(Some("old"), Some("old")).is_ok());
    }
}

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
};
type Invalidate = Arc<dyn Fn() -> crate::error::AppResult<()> + Send + Sync>;

pub(crate) struct SourceCatalog {
    epoch: AtomicU64,
    gate: Arc<tokio::sync::RwLock<()>>,
    invalidator: OnceLock<Invalidate>,
}

impl Default for SourceCatalog {
    fn default() -> Self {
        Self {
            epoch: AtomicU64::new(1),
            gate: Arc::default(),
            invalidator: OnceLock::new(),
        }
    }
}

impl std::fmt::Debug for SourceCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceCatalog")
            .field("epoch", &self.epoch())
            .finish_non_exhaustive()
    }
}

impl SourceCatalog {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    pub(crate) async fn handoff(&self) -> tokio::sync::OwnedRwLockReadGuard<()> {
        self.gate.clone().read_owned().await
    }

    pub(crate) fn mutation(
        &self,
    ) -> crate::error::AppResult<tokio::sync::OwnedRwLockWriteGuard<()>> {
        let guard = self
            .gate
            .clone()
            .try_write_owned()
            .map_err(|_| crate::error::AppError::Validation("profile_source_busy".into()))?;
        self.epoch.fetch_add(1, Ordering::AcqRel);
        if let Some(callback) = self.invalidator.get() {
            callback()?;
        }
        Ok(guard)
    }
}

pub(crate) fn app_catalog() -> &'static Arc<SourceCatalog> {
    static CATALOG: OnceLock<Arc<SourceCatalog>> = OnceLock::new();
    CATALOG.get_or_init(Arc::default)
}

pub fn register_invalidator(callback: Invalidate) {
    let _ = app_catalog().invalidator.set(callback);
}
pub fn catalog_epoch() -> u64 {
    app_catalog().epoch()
}
pub async fn catalog_handoff() -> tokio::sync::OwnedRwLockReadGuard<()> {
    app_catalog().handoff().await
}
pub fn catalog_mutation() -> crate::error::AppResult<tokio::sync::OwnedRwLockWriteGuard<()>> {
    app_catalog().mutation()
}
#[tauri::command]
pub fn profile_catalog_epoch() -> String {
    catalog_epoch().to_string()
}
#[tauri::command]
pub async fn invalidate_profile_preparations() -> crate::error::AppResult<()> {
    let _guard = catalog_mutation()?;
    Ok(())
}
#[tauri::command]
pub async fn validate_subscription_source(
    subscriptions: tauri::State<'_, Arc<crate::subscriptions::SubscriptionService>>,
    profile_ref: super::types::ProfileRef,
    source_revision: String,
) -> crate::error::AppResult<()> {
    #[cfg(not(target_os = "android"))]
    let snapshot = subscriptions.list().await?;
    #[cfg(target_os = "android")]
    let snapshot = subscriptions.list_snapshot().await?;
    let actual = match profile_ref {
        super::types::ProfileRef::Subscription {
            subscription_id,
            link_key,
        } => snapshot
            .link_outbounds
            .iter()
            .find(|g| g.subscription_id == subscription_id)
            .and_then(|g| g.links.iter().find(|l| l.key == link_key))
            .map(|l| l.source_revision.as_str()),
        super::types::ProfileRef::Ready {
            subscription_id,
            child_key,
        } => snapshot
            .subscriptions
            .iter()
            .find(|s| s.id == subscription_id)
            .and_then(|s| s.children.iter().find(|c| c.key == child_key))
            .map(|c| c.source_revision.as_str()),
        _ => None,
    };
    require_revision(Some(&source_revision), actual)
}
#[cfg(all(test, not(target_os = "android")))]
mod mutation_tests {
    use super::*;
    #[tokio::test]
    async fn catalog_change_cancels_pending_but_handoff_rejects_mutation() {
        let catalog = Arc::<SourceCatalog>::default();
        let pm = crate::process::ProcessManager::with_catalog(catalog.clone());
        let ticket = pm.begin_ready_profile_check();
        {
            let _mutation = catalog.mutation().unwrap();
        }
        assert!(!pm.is_ready_profile_check_current(ticket));
        let _handoff = catalog.handoff().await;
        assert!(catalog.mutation().is_err());
    }
}
