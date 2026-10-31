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
static CATALOG_EPOCH: AtomicU64 = AtomicU64::new(1);
static CATALOG_GATE: OnceLock<Arc<tokio::sync::RwLock<()>>> = OnceLock::new();
type Invalidate = Arc<dyn Fn() -> crate::error::AppResult<()> + Send + Sync>;
static INVALIDATOR: OnceLock<Invalidate> = OnceLock::new();
pub fn register_invalidator(callback: Invalidate) {
    let _ = INVALIDATOR.set(callback);
}
pub fn catalog_epoch() -> u64 {
    CATALOG_EPOCH.load(Ordering::Acquire)
}
fn gate() -> Arc<tokio::sync::RwLock<()>> {
    CATALOG_GATE
        .get_or_init(|| Arc::new(tokio::sync::RwLock::new(())))
        .clone()
}
pub async fn catalog_handoff() -> tokio::sync::OwnedRwLockReadGuard<()> {
    gate().read_owned().await
}
pub fn catalog_mutation() -> crate::error::AppResult<tokio::sync::OwnedRwLockWriteGuard<()>> {
    let guard = gate()
        .try_write_owned()
        .map_err(|_| crate::error::AppError::Validation("profile_source_busy".into()))?;
    CATALOG_EPOCH.fetch_add(1, Ordering::AcqRel);
    if let Some(callback) = INVALIDATOR.get() {
        callback()?;
    }
    Ok(guard)
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
        let pm = crate::process::ProcessManager::new();
        let ticket = pm.begin_ready_profile_check();
        {
            let _mutation = catalog_mutation().unwrap();
        }
        assert!(!pm.is_ready_profile_check_current(ticket));
        let _handoff = catalog_handoff().await;
        assert!(catalog_mutation().is_err());
    }
}
