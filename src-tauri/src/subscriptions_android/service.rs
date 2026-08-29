//! Subscription service — the single Rust-side owner of the subscription
//! state machine.
//!
//! Public entry points (used by the Tauri commands):
//!   * `list` / `list_snapshot`  — read everything, sanitized.
//!   * `add`                     — validate, persist, fetch, classify,
//!                                  store parsed `Outbound[]`.
//!   * `remove`                  — delete one record.
//!   * `refresh`                 — re-fetch a single subscription.
//!   * `migrate_legacy`          — import pre-v1.3.1 records (id+name+url).
//!   * `set_interval`            — change the auto-refresh cadence.
//!   * `get_hwid` / `reset_hwid` — manage the per-install HWID sent to
//!                                  providers that need it (anivka.top
//!                                  and similar).
//!
//! All write paths go through the `SubscriptionStore` (atomic temp +
//! rename) and take a single `tokio::sync::Mutex` to keep concurrent
//! add/refresh calls from racing on disk.

use std::sync::Arc;

use base64::Engine;
use chrono::Utc;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::parser;

use super::http::SubscriptionHttpClient;
use super::hwid::HwidStore;
use super::model::{
    ActiveChildConfig, ChildProfileRecord, DeviceHwidInfo, EngineKind, ProviderMetadata,
    SubscriptionKind, SubscriptionLinkSummary, SubscriptionOutbounds, SubscriptionRecord,
    SubscriptionSnapshot, SubscriptionSummary,
};
use super::store::SubscriptionStore;
use super::{classify_payload, ClassifiedPayload};

#[derive(Debug, Clone, Deserialize)]
pub struct AddSubscriptionInput {
    pub name: String,
    pub url: String,
    // The frontend sends `intervalMinutes` (camelCase) — match the
    // field name explicitly so the Tauri command deserialisation
    // does not fail with "missing field `interval_minutes`".
    // (PC version carries the same `#[serde(rename)]`.)
    #[serde(rename = "intervalMinutes")]
    pub interval_minutes: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LegacySubscriptionInput {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(rename = "intervalMinutes")]
    pub interval_minutes: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefreshSubscriptionResult {
    pub subscription: SubscriptionSummary,
    pub selection_changed: bool,
}

#[derive(Clone)]
pub struct SubscriptionService {
    store: SubscriptionStore,
    hwid: HwidStore,
    http: SubscriptionHttpClient,
    version: String,
    lock: Arc<Mutex<()>>,
}

impl SubscriptionService {
    pub fn new(
        store: SubscriptionStore,
        hwid: HwidStore,
        http: SubscriptionHttpClient,
        version: String,
    ) -> Self {
        Self {
            store,
            hwid,
            http,
            version,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn list_snapshot(&self) -> AppResult<SubscriptionSnapshot> {
        let _guard = self.lock.lock().await;
        let records = self.store.load_all()?;
        Ok(snapshot(records))
    }

    pub async fn get_link_outbounds(&self, id: &str) -> AppResult<Vec<parser::Outbound>> {
        let _guard = self.lock.lock().await;
        let records = self.store.load_all()?;
        let record = records.iter().find(|r| r.id == id).ok_or_else(not_found)?;
        Ok(record.link_outbounds.clone())
    }

    pub async fn describe_hwid(&self) -> AppResult<DeviceHwidInfo> {
        let _guard = self.lock.lock().await;
        let desc = self.hwid.describe()?;
        Ok(DeviceHwidInfo {
            effective: desc.effective.to_string(),
            auto: desc.auto.map(|u| u.to_string()),
            custom: desc.custom.map(|u| u.to_string()),
        })
    }

    pub async fn set_custom_hwid(&self, value: Option<String>) -> AppResult<DeviceHwidInfo> {
        let _guard = self.lock.lock().await;
        let parsed = match value.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None => None,
            Some(raw) => Some(Uuid::parse_str(raw).map_err(|e| {
                AppError::Validation(format!("HWID override is not a valid UUID: {e}"))
            })?),
        };
        self.hwid.set_custom(parsed)?;
        let desc = self.hwid.describe()?;
        Ok(DeviceHwidInfo {
            effective: desc.effective.to_string(),
            auto: desc.auto.map(|u| u.to_string()),
            custom: desc.custom.map(|u| u.to_string()),
        })
    }

    pub async fn reset_hwid(&self) -> AppResult<DeviceHwidInfo> {
        let _guard = self.lock.lock().await;
        self.hwid.reset()?;
        let desc = self.hwid.describe()?;
        Ok(DeviceHwidInfo {
            effective: desc.effective.to_string(),
            auto: desc.auto.map(|u| u.to_string()),
            custom: desc.custom.map(|u| u.to_string()),
        })
    }

    pub async fn add(&self, input: AddSubscriptionInput) -> AppResult<RefreshSubscriptionResult> {
        validate_input(&input.name, &input.url, input.interval_minutes)?;
        // If the same URL is already in the store, refuse the add.
        // Matching the PC behaviour: the user clicked "Add", so they
        // expect either a new entry or a clear "this URL is already
        // in your list" error. Silently refreshing an existing record
        // (the previous mobile behaviour) surprised users who had just
        // renamed the subscription, and made the UI's own de-dup logic
        // unreliable. 2026-08-21.
        {
            let _guard = self.lock.lock().await;
            if self.store.load_all()?.iter().any(|record| {
                normalized_url_digest(&record.url) == normalized_url_digest(&input.url)
            }) {
                return Err(AppError::Subscription("subscription already exists".into()));
            }
        }
        let (record, records) = {
            let _guard = self.lock.lock().await;
            let records = self.store.load_all()?;
            let record = SubscriptionRecord {
                id: Uuid::new_v4().to_string(),
                name: input.name.trim().to_owned(),
                url: input.url.trim().to_owned(),
                kind: SubscriptionKind::Auto,
                engine: None,
                interval_minutes: input.interval_minutes,
                active_child_key: None,
                children: Vec::new(),
                link_outbounds: Vec::new(),
                bundle_digest: None,
                metadata: ProviderMetadata::default(),
                last_success_at: None,
                last_http_status: None,
                last_error: None,
            };
            (record, records)
        };

        let candidate = match self.prepare_candidate(&record).await {
            Ok(c) => c,
            Err(e) => {
                log::error!("subscription add: prepare_candidate failed: {e}");
                return Err(e);
            }
        };
        let _guard = self.lock.lock().await;
        let current = self.store.load_all()?;
        if current != records {
            return Err(concurrent_change());
        }
        let result = RefreshSubscriptionResult {
            subscription: candidate.to_summary(),
            selection_changed: false,
        };
        let mut next = records;
        next.push(candidate);
        self.store.replace_all(&next)?;
        Ok(result)
    }

    /// Add a subscription from a body that the caller has already
    /// fetched. On Android the `add_subscription` Tauri command
    /// fetches the body through the Kotlin `VpnPlugin.subscriptionFetchUrl`
    /// command (which uses Android's stock BoringSSL), then calls
    /// this method with the result. On PC the caller goes through
    /// `add`, which fetches via the `reqwest`/`rustls-tls` client
    /// instead.
    ///
    /// Behaviour matches `add` exactly except for the transport:
    /// same validation, same duplicate-URL check, same persistent
    /// state shape. The `content_type` is whatever the remote server
    /// returned (the Kotlin side falls back to `text/plain` when the
    /// header is missing). The `metadata` is `ProviderMetadata::default()`
    /// because we don't surface response headers through the
    /// Kotlin bridge yet — the user's name is preserved as-is. 2026-08-21.
    pub async fn add_with_fetched_body(
        &self,
        input: AddSubscriptionInput,
        body: Vec<u8>,
        content_type: Option<String>,
        metadata: ProviderMetadata,
        http_status: u16,
    ) -> AppResult<RefreshSubscriptionResult> {
        validate_input(&input.name, &input.url, input.interval_minutes)?;
        // Duplicate-URL check. Same rule as `add` — refuse rather
        // than silently refresh, so the UI's own de-dup logic stays
        // the source of truth. 2026-08-21.
        {
            let _guard = self.lock.lock().await;
            if self.store.load_all()?.iter().any(|record| {
                normalized_url_digest(&record.url) == normalized_url_digest(&input.url)
            }) {
                return Err(AppError::Subscription("subscription already exists".into()));
            }
        }
        let (record, records) = {
            let _guard = self.lock.lock().await;
            let records = self.store.load_all()?;
            let record = SubscriptionRecord {
                id: Uuid::new_v4().to_string(),
                name: input.name.trim().to_owned(),
                url: input.url.trim().to_owned(),
                kind: SubscriptionKind::Auto,
                engine: None,
                interval_minutes: input.interval_minutes,
                active_child_key: None,
                children: Vec::new(),
                link_outbounds: Vec::new(),
                bundle_digest: None,
                metadata: ProviderMetadata::default(),
                last_success_at: None,
                last_http_status: None,
                last_error: None,
            };
            (record, records)
        };

        // The Kotlin bridge reports the real HTTP status alongside the
        // body, so it is recorded instead of an assumed 200.
        let candidate = match self.classify_with_body(
            &record,
            &body,
            content_type.as_deref(),
            &metadata,
            http_status,
        ) {
            Ok(c) => c,
            Err(e) => {
                log::error!("subscription add (Android path): classify_with_body failed: {e}");
                return Err(e);
            }
        };
        let _guard = self.lock.lock().await;
        let current = self.store.load_all()?;
        if current != records {
            return Err(concurrent_change());
        }
        let result = RefreshSubscriptionResult {
            subscription: candidate.to_summary(),
            selection_changed: false,
        };
        let mut next = records;
        next.push(candidate);
        self.store.replace_all(&next)?;
        Ok(result)
    }

    pub async fn remove(&self, id: &str) -> AppResult<()> {
        let _guard = self.lock.lock().await;
        let mut records = self.store.load_all()?;
        let count = records.len();
        records.retain(|record| record.id != id);
        if records.len() == count {
            return Err(not_found());
        }
        self.store.replace_all(&records)
    }

    pub async fn set_interval(
        &self,
        id: &str,
        interval_minutes: u32,
    ) -> AppResult<SubscriptionSummary> {
        let _guard = self.lock.lock().await;
        validate_interval(interval_minutes)?;
        let mut records = self.store.load_all()?;
        let record = record_mut(&mut records, id)?;
        record.interval_minutes = interval_minutes;
        let summary = record.to_summary();
        self.store.replace_all(&records)?;
        Ok(summary)
    }

    /// Pin a bundle subscription's `active_child_key` to one of its
    /// stored children. The next `get_active_child_config` call for
    /// this id will return that child's full engine configuration.
    /// No-op for link_list and `Auto`-kind subscriptions (they have
    /// no children to select between). 2026-08-21.
    pub async fn set_active_child(
        &self,
        id: &str,
        child_key: &str,
    ) -> AppResult<SubscriptionSummary> {
        let _guard = self.lock.lock().await;
        let mut records = self.store.load_all()?;
        let record = record_mut(&mut records, id)?;
        if !matches!(
            record.kind,
            SubscriptionKind::SingboxBundle | SubscriptionKind::XrayBundle
        ) {
            // No children to pick from — return the existing summary
            // unchanged so the UI can call this defensively without
            // needing to know the kind.
            return Ok(record.to_summary());
        }
        let exists = record.children.iter().any(|c| c.key == child_key);
        if !exists {
            return Err(AppError::Validation(format!(
                "child key {child_key:?} is not part of subscription {id:?}"
            )));
        }
        record.active_child_key = Some(child_key.to_string());
        let summary = record.to_summary();
        self.store.replace_all(&records)?;
        Ok(summary)
    }

    /// Return the active child's full engine configuration for a
    /// bundle subscription. For sing-box bundles the JSON is a
    /// complete sing-box config (already has log/dns/inbounds/
    /// outbounds/route). For xray bundles the JSON is a complete
    /// xray config — the caller is expected to extract `outbounds[]`
    /// before handing it to the xray engine. Returns 404 if the
    /// subscription is not a bundle, has no children, or has no
    /// `active_child_key` set. 2026-08-20.
    pub async fn get_active_child_config(&self, id: &str) -> AppResult<ActiveChildConfig> {
        let _guard = self.lock.lock().await;
        let records = self.store.load_all()?;
        let record = records.iter().find(|r| r.id == id).ok_or_else(not_found)?;
        if !matches!(
            record.kind,
            SubscriptionKind::SingboxBundle | SubscriptionKind::XrayBundle
        ) {
            return Err(AppError::Validation(format!(
                "subscription {id:?} is not a bundle (kind={:?})",
                record.kind
            )));
        }
        let key = record.active_child_key.clone().ok_or_else(|| {
            AppError::Validation(format!(
                "subscription {id:?} has no active child; call set_active_child first"
            ))
        })?;
        let child = record
            .children
            .iter()
            .find(|c| c.key == key)
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "active child {key:?} is missing from subscription {id:?} (stale record)"
                ))
            })?;
        let config = serde_json::to_string(&child.config)
            .map_err(|e| AppError::Validation(format!("child config serialise failed: {e}")))?;
        Ok(ActiveChildConfig {
            engine: child.engine,
            child_key: child.key.clone(),
            child_name: child.name.clone(),
            config,
        })
    }

    pub async fn refresh(&self, id: &str) -> AppResult<RefreshSubscriptionResult> {
        let original = {
            let _guard = self.lock.lock().await;
            let records = self.store.load_all()?;
            records
                .iter()
                .find(|record| record.id == id)
                .cloned()
                .ok_or_else(not_found)?
        };
        let candidate = self.prepare_candidate(&original).await?;
        self.commit_refresh(id, original, candidate).await
    }

    /// Android refresh: the network fetch happens in Kotlin (the
    /// reqwest/rustls ClientHello is RST by anivka.top's edge), so the
    /// body + metadata headers arrive pre-fetched. Same commit path
    /// as [refresh].
    pub async fn refresh_with_fetched_body(
        &self,
        id: &str,
        body: Vec<u8>,
        content_type: Option<String>,
        metadata: ProviderMetadata,
        http_status: u16,
    ) -> AppResult<RefreshSubscriptionResult> {
        let original = {
            let _guard = self.lock.lock().await;
            let records = self.store.load_all()?;
            records
                .iter()
                .find(|record| record.id == id)
                .cloned()
                .ok_or_else(not_found)?
        };
        let candidate = self.classify_with_body(
            &original,
            &body,
            content_type.as_deref(),
            &metadata,
            http_status,
        )?;
        self.commit_refresh(id, original, candidate).await
    }

    /// The stored URL of a subscription, for callers that need to run
    /// their own transport (the Android Kotlin fetch). Sanitized on
    /// error paths — never part of an error message.
    pub async fn subscription_url(&self, id: &str) -> AppResult<String> {
        let _guard = self.lock.lock().await;
        let records = self.store.load_all()?;
        records
            .iter()
            .find(|record| record.id == id)
            .map(|record| record.url.clone())
            .ok_or_else(not_found)
    }

    async fn commit_refresh(
        &self,
        id: &str,
        original: SubscriptionRecord,
        candidate: SubscriptionRecord,
    ) -> AppResult<RefreshSubscriptionResult> {
        let _guard = self.lock.lock().await;
        let mut records = self.store.load_all()?;
        let index = records
            .iter()
            .position(|record| record.id == id)
            .ok_or_else(not_found)?;
        if records[index] != original {
            return Err(concurrent_change());
        }
        let selection_changed = candidate.active_child_key != original.active_child_key;
        let result = RefreshSubscriptionResult {
            subscription: candidate.to_summary(),
            selection_changed,
        };
        records[index] = candidate;
        self.store.replace_all(&records)?;
        Ok(result)
    }

    pub async fn migrate_legacy(
        &self,
        inputs: Vec<LegacySubscriptionInput>,
    ) -> AppResult<SubscriptionSnapshot> {
        let (mut records, original) = {
            let _guard = self.lock.lock().await;
            let records = self.store.load_all()?;
            (records.clone(), records)
        };
        for input in inputs {
            validate_input(&input.name, &input.url, input.interval_minutes)?;
            if records.iter().any(|record| record.id == input.id)
                || records.iter().any(|record| {
                    normalized_url_digest(&record.url) == normalized_url_digest(&input.url)
                })
            {
                continue;
            }
            let record = SubscriptionRecord {
                id: input.id,
                name: input.name.trim().to_owned(),
                url: input.url.trim().to_owned(),
                kind: SubscriptionKind::Auto,
                engine: None,
                interval_minutes: input.interval_minutes,
                active_child_key: None,
                children: Vec::new(),
                link_outbounds: Vec::new(),
                bundle_digest: None,
                metadata: ProviderMetadata::default(),
                last_success_at: None,
                last_http_status: None,
                last_error: None,
            };
            records.push(self.prepare_candidate(&record).await?);
        }
        let _guard = self.lock.lock().await;
        if self.store.load_all()? != original {
            return Err(concurrent_change());
        }
        self.store.replace_all(&records)?;
        Ok(snapshot(records))
    }

    async fn prepare_candidate(
        &self,
        current: &SubscriptionRecord,
    ) -> AppResult<SubscriptionRecord> {
        let url = parse_url(&current.url)?;
        // The HWID comes from `HwidStore`, which the user can
        // override once in settings (anivka.top etc. whitelist the
        // first HWID they see and 403 the device's auto-generated
        // one). 2026-08-20.
        let hwid = self.hwid.get_or_create()?;
        let payload = self
            .http
            .fetch(&url, hwid, &self.version, platform())
            .await?;
        self.classify_with_body(
            current,
            &payload.bytes,
            payload.content_type.as_deref(),
            &payload.metadata,
            payload.status,
        )
    }

    /// Run the body through the same `classify_payload` pipeline
    /// the network path uses, but accept the body and metadata from
    /// any source. The PC `prepare_candidate` calls this with the
    /// `reqwest` result; the Android `add_with_fetched_body` /
    /// `refresh_with_fetched_body` calls it with the body and
    /// metadata headers the Kotlin `subscriptionFetchUrl` command
    /// returned. 2026-08-21.
    fn classify_with_body(
        &self,
        current: &SubscriptionRecord,
        bytes: &[u8],
        content_type: Option<&str>,
        metadata: &ProviderMetadata,
        status: u16,
    ) -> AppResult<SubscriptionRecord> {
        let mut candidate = current.clone();
        let previous_profile_title = candidate.metadata.profile_title.clone();
        candidate.metadata = metadata.clone();
        apply_provider_title_fallback(&mut candidate, previous_profile_title.as_deref());
        candidate.last_http_status = Some(status);
        candidate.last_success_at = Some(Utc::now());
        candidate.last_error = None;

        match classify_payload(bytes, content_type)? {
            ClassifiedPayload::LinkList(result) => {
                candidate.kind = SubscriptionKind::LinkList;
                candidate.engine = Some(EngineKind::Singbox);
                candidate.children.clear();
                candidate.active_child_key = None;
                candidate.link_outbounds = result.outbounds;
                candidate.bundle_digest = None;
            }
            ClassifiedPayload::SingboxBundle(children) => {
                // The mobile Kotlin VpnService currently consumes a
                // single sing-box outbound. The bundle path is fully
                // recognised and persisted here so the user sees
                // every profile the provider ships; the engine that
                // actually starts one of these children is a separate
                // workstream (Android-side xray/sing-box template).
                let child_records: Vec<ChildProfileRecord> = children
                    .into_iter()
                    .map(|child| ChildProfileRecord {
                        key: child.key,
                        name: child.name,
                        engine: EngineKind::Singbox,
                        config: child.config,
                        digest: String::new(),
                    })
                    .collect();
                if child_records.is_empty() {
                    return Err(AppError::EngineUnavailable(
                        "provider returned a sing-box bundle with no usable configs".into(),
                    ));
                }
                candidate.kind = SubscriptionKind::SingboxBundle;
                candidate.engine = Some(EngineKind::Singbox);
                // Preserve the active child on refresh if the same key
                // is still in the new bundle; otherwise fall back to
                // the first child. 2026-08-21.
                candidate.active_child_key =
                    preserve_active_child(candidate.active_child_key.as_deref(), &child_records);
                candidate.children = child_records;
                candidate.link_outbounds.clear();
                candidate.bundle_digest = None;
            }
            ClassifiedPayload::XrayBundle(children) => {
                let child_records: Vec<ChildProfileRecord> = children
                    .into_iter()
                    .map(|child| ChildProfileRecord {
                        key: child.key,
                        name: child.name,
                        engine: EngineKind::Xray,
                        config: child.config,
                        digest: String::new(),
                    })
                    .collect();
                if child_records.is_empty() {
                    return Err(AppError::EngineUnavailable(
                        "provider returned an xray bundle with no usable configs".into(),
                    ));
                }
                candidate.kind = SubscriptionKind::XrayBundle;
                candidate.engine = Some(EngineKind::Xray);
                candidate.active_child_key =
                    preserve_active_child(candidate.active_child_key.as_deref(), &child_records);
                candidate.children = child_records;
                candidate.link_outbounds.clear();
                candidate.bundle_digest = None;
            }
        }
        Ok(candidate)
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "Android"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "ios") {
        "iOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "Unknown"
    }
}

fn apply_provider_title_fallback(
    record: &mut SubscriptionRecord,
    previous_profile_title: Option<&str>,
) {
    let Some(title) = record
        .metadata
        .profile_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
    else {
        return;
    };
    let Some(resolved_title) = decode_provider_title(title) else {
        return;
    };

    if record.name.trim() == "Subscription"
        || previous_profile_title
            .map(str::trim)
            .is_some_and(|previous| record.name == previous && previous == title)
    {
        record.name = resolved_title;
    }
}

fn decode_provider_title(title: &str) -> Option<String> {
    let Some(encoded) = title.strip_prefix("base64:") else {
        return Some(title.to_owned());
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    String::from_utf8(bytes)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn snapshot(records: Vec<SubscriptionRecord>) -> SubscriptionSnapshot {
    let link_outbounds = records
        .iter()
        .filter(|record| record.kind == SubscriptionKind::LinkList)
        .map(|record| SubscriptionOutbounds {
            subscription_id: record.id.clone(),
            links: record
                .link_outbounds
                .iter()
                .enumerate()
                .map(|(index, outbound)| {
                    let protocol = outbound.protocol().to_owned();
                    let display = outbound.display_name();
                    let label = if !display.trim().is_empty() {
                        display
                    } else {
                        format!("{protocol} link {}", index + 1)
                    };
                    SubscriptionLinkSummary {
                        key: format!("index-{index}"),
                        label,
                        protocol,
                    }
                })
                .collect(),
        })
        .collect();
    let subscriptions = records.iter().map(SubscriptionRecord::to_summary).collect();
    SubscriptionSnapshot {
        subscriptions,
        link_outbounds,
    }
}

fn validate_input(name: &str, url: &str, interval_minutes: u32) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::Validation("subscription name is required".into()));
    }
    let _ = parse_url(url)?;
    validate_interval(interval_minutes)
}

fn validate_interval(interval_minutes: u32) -> AppResult<()> {
    if !(15..=43_200).contains(&interval_minutes) {
        return Err(AppError::Validation(
            "subscription interval is out of range".into(),
        ));
    }
    Ok(())
}

fn parse_url(value: &str) -> AppResult<Url> {
    Url::parse(value.trim())
        .map_err(|_| AppError::Subscription("subscription URL is invalid".into()))
}

fn normalized_url_digest(value: &str) -> String {
    let normalized = value.trim();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn not_found() -> AppError {
    AppError::Subscription("subscription was not found".into())
}

fn concurrent_change() -> AppError {
    AppError::Validation("subscriptions changed during the operation".into())
}

fn record_mut<'a>(
    records: &'a mut [SubscriptionRecord],
    id: &str,
) -> AppResult<&'a mut SubscriptionRecord> {
    records
        .iter_mut()
        .find(|record| record.id == id)
        .ok_or_else(not_found)
}

/// Pick the active child key for a freshly-classified bundle. If the
/// user already had a selection (`previous`) and that key is still in
/// the new `children` list, keep it. Otherwise fall back to the first
/// child. Used by both the sing-box and xray bundle branches in
/// `prepare_candidate` so a refresh of an unchanged provider does
/// not silently switch the user's active profile. 2026-08-21.
fn preserve_active_child(
    previous: Option<&str>,
    children: &[ChildProfileRecord],
) -> Option<String> {
    if let Some(key) = previous {
        if children.iter().any(|child| child.key == key) {
            return Some(key.to_string());
        }
    }
    children.first().map(|child| child.key.clone())
}
