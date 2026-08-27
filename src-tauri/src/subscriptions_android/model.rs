//! Public data model for the subscription service.
//!
//! The service stores both:
//!   * a private `SubscriptionRecord` (the on-disk, command-internal form,
//!     with a full URL and a children list that can hold engine configs),
//!   * and a `SubscriptionSummary` (the frontend-facing form that never
//!     carries the raw URL or any bundle payload).
//!
//! `to_summary()` is the only path the WebView ever sees; the commands
//! layer must keep that boundary intact or the URL and bundle payload
//! leak back to the WebView.

use chrono::{DateTime, Utc};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionKind {
    #[default]
    Auto,
    LinkList,
    SingboxBundle,
    XrayBundle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Singbox,
    Xray,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionErrorKind {
    #[default]
    Subscription,
    SubscriptionAuth,
    SubscriptionExpired,
    DeviceLimit,
    PayloadTooLarge,
    UnsafeRedirect,
    AmbiguousConfig,
    Validation,
    EngineUnavailable,
    UnsafeConfig,
}

impl SubscriptionErrorKind {
    pub const fn safe_message(self) -> &'static str {
        match self {
            Self::Subscription => "Subscription operation failed",
            Self::SubscriptionAuth => "Subscription authentication failed",
            Self::SubscriptionExpired => "Subscription has expired",
            Self::DeviceLimit => "Subscription device limit reached",
            Self::PayloadTooLarge => "Subscription payload is too large",
            Self::UnsafeRedirect => "Subscription redirect was blocked",
            Self::AmbiguousConfig => "Subscription configuration is ambiguous",
            Self::Validation => "Subscription validation failed",
            Self::EngineUnavailable => "Required subscription engine is unavailable",
            Self::UnsafeConfig => "Subscription configuration was blocked",
        }
    }
}

#[derive(Clone, Deserialize, PartialEq)]
pub struct SubscriptionRecord {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub kind: SubscriptionKind,
    #[serde(default)]
    pub engine: Option<EngineKind>,
    pub interval_minutes: u32,
    #[serde(default)]
    pub active_child_key: Option<String>,
    #[serde(default)]
    pub children: Vec<ChildProfileRecord>,
    #[serde(default)]
    pub link_outbounds: Vec<crate::parser::Outbound>,
    #[serde(default)]
    pub bundle_digest: Option<String>,
    #[serde(default)]
    pub metadata: ProviderMetadata,
    #[serde(default)]
    pub last_success_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_http_status: Option<u16>,
    #[serde(default)]
    pub last_error: Option<SubscriptionFailure>,
}

impl SubscriptionRecord {
    pub fn to_summary(&self) -> SubscriptionSummary {
        SubscriptionSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
            engine: self.engine,
            interval_minutes: self.interval_minutes,
            active_child_key: self.active_child_key.clone(),
            children: self
                .children
                .iter()
                .map(ChildProfileRecord::to_summary)
                .collect(),
            metadata: self.metadata.clone(),
            last_success_at: self.last_success_at,
            last_http_status: self.last_http_status,
            last_error: self.last_error.as_ref().map(SubscriptionFailure::to_safe),
            server_count: match self.kind {
                SubscriptionKind::LinkList => self.link_outbounds.len(),
                _ => self.children.len(),
            },
        }
    }
}

#[derive(Clone, Deserialize, PartialEq)]
pub struct ChildProfileRecord {
    pub key: String,
    pub name: String,
    pub engine: EngineKind,
    pub config: Value,
    #[serde(default)]
    pub digest: String,
}

impl ChildProfileRecord {
    fn to_summary(&self) -> ChildProfileSummary {
        ChildProfileSummary {
            key: self.key.clone(),
            name: self.name.clone(),
            engine: self.engine,
            endpoint: extract_child_endpoint(&self.config),
        }
    }
}

/// Host+port of the child's dialing outbound, for latency probes.
/// Non-dialing outbounds (freedom/blackhole/selector/dns/the
/// protected relay) are skipped; the first dialer wins.
fn extract_child_endpoint(config: &Value) -> Option<ChildEndpoint> {
    let outbounds = config.get("outbounds")?.as_array()?;
    const SKIP: [&str; 6] = [
        "freedom",
        "blackhole",
        "selector",
        "urltest",
        "dns",
        "loopback",
    ];
    for outbound in outbounds {
        let protocol = outbound.get("protocol")?.as_str()?;
        if SKIP.contains(&protocol) {
            continue;
        }
        let tag = outbound.get("tag").and_then(Value::as_str).unwrap_or("");
        if tag == "protected" {
            continue;
        }
        let settings = outbound.get("settings")?;
        if let Some(vnext) = settings.get("vnext").and_then(Value::as_array) {
            if let Some(first) = vnext.first() {
                if let (Some(address), Some(port)) = (
                    first.get("address").and_then(Value::as_str),
                    first.get("port").and_then(Value::as_u64),
                ) {
                    if !address.is_empty() && port > 0 && port <= u16::MAX as u64 {
                        return Some(ChildEndpoint {
                            host: address.to_string(),
                            port: port as u16,
                        });
                    }
                }
            }
        }
        if let Some(servers) = settings.get("servers").and_then(Value::as_array) {
            if let Some(first) = servers.first() {
                if let (Some(address), Some(port)) = (
                    first.get("address").and_then(Value::as_str),
                    first.get("port").and_then(Value::as_u64),
                ) {
                    if !address.is_empty() && port > 0 && port <= u16::MAX as u64 {
                        return Some(ChildEndpoint {
                            host: address.to_string(),
                            port: port as u16,
                        });
                    }
                }
            }
        }
    }
    None
}

impl fmt::Debug for SubscriptionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SubscriptionRecord")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("engine", &self.engine)
            .field("interval_minutes", &self.interval_minutes)
            .field("active_child_key", &self.active_child_key)
            .field(
                "children",
                &self
                    .children
                    .iter()
                    .map(ChildProfileRecord::to_summary)
                    .collect::<Vec<_>>(),
            )
            .field("link_count", &self.link_outbounds.len())
            .field("bundle_digest", &self.bundle_digest)
            .field("metadata", &self.metadata)
            .field("last_success_at", &self.last_success_at)
            .field("last_http_status", &self.last_http_status)
            .field(
                "last_error",
                &self.last_error.as_ref().map(SubscriptionFailure::to_safe),
            )
            .finish()
    }
}

impl fmt::Debug for ChildProfileRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChildProfileRecord")
            .field("key", &self.key)
            .field("name", &self.name)
            .field("engine", &self.engine)
            .field("digest", &self.digest)
            .field("config", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderMetadata {
    #[serde(default)]
    pub profile_title: Option<String>,
    #[serde(default)]
    pub update_interval_minutes: Option<u32>,
    #[serde(default)]
    pub update_interval_hours: Option<u32>,
    #[serde(default)]
    pub profile_web_page_url: Option<String>,
    #[serde(default)]
    pub support_url: Option<String>,
    #[serde(default)]
    pub userinfo: Option<SubscriptionUserinfo>,
    #[serde(default)]
    pub upload_bytes: Option<u64>,
    #[serde(default)]
    pub download_bytes: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SubscriptionUserinfo {
    #[serde(default)]
    pub upload: Option<u64>,
    #[serde(default)]
    pub download: Option<u64>,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub expire: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionFailure {
    pub kind: SubscriptionErrorKind,
    pub message: String,
}

impl SubscriptionFailure {
    fn to_safe(&self) -> Self {
        Self {
            kind: self.kind,
            message: self.kind.safe_message().into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubscriptionSummary {
    pub id: String,
    pub name: String,
    pub kind: SubscriptionKind,
    pub engine: Option<EngineKind>,
    pub interval_minutes: u32,
    pub active_child_key: Option<String>,
    pub children: Vec<ChildProfileSummary>,
    pub metadata: ProviderMetadata,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_http_status: Option<u16>,
    pub last_error: Option<SubscriptionFailure>,
    /// Persisted server count: link outbounds for link-list
    /// subscriptions, children for bundles. The UI shows this in the
    /// subscriptions overview (a fetch-result-only count reads 0
    /// after an app restart).
    #[serde(default)]
    pub server_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionLinkRef {
    pub subscription_id: String,
    pub link_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubscriptionSnapshot {
    pub subscriptions: Vec<SubscriptionSummary>,
    pub link_outbounds: Vec<SubscriptionOutbounds>,
}

/// The full engine configuration of the currently selected child of a
/// bundle subscription. Returned by `get_active_child_config` so the
/// mobile UI can hand it to the Kotlin `vpn:start` plugin without
/// re-classifying the body. For sing-box the JSON is a complete
/// sing-box config (log/dns/inbounds/outbounds/route). For xray it is
/// a complete xray config — the Kotlin side extracts
/// `outbounds[]` and feeds the rest to `XrayConfigBuilder`. 2026-08-20.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveChildConfig {
    pub engine: EngineKind,
    /// The child key (so the UI can confirm the right one was loaded).
    pub child_key: String,
    /// Child display name (for the user-visible status pill).
    pub child_name: String,
    /// Serialised JSON of the full engine configuration.
    pub config: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionOutbounds {
    pub subscription_id: String,
    pub links: Vec<SubscriptionLinkSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionLinkSummary {
    pub key: String,
    pub label: String,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChildProfileSummary {
    pub key: String,
    pub name: String,
    pub engine: EngineKind,
    /// Dial endpoint of the child's first proxy outbound — feeds the
    /// latency probes in the server list. None when the config has no
    /// recognizable dialer (or is engine-internal).
    #[serde(default)]
    pub endpoint: Option<ChildEndpoint>,
}

/// Sanitized host+port for latency probes — no credentials, no
/// transport details.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChildEndpoint {
    pub host: String,
    pub port: u16,
}

/// What the device-wide HWID panel needs. Returned by
/// `get_device_hwid` and `set_custom_hwid`. The effective value
/// is what the next fetch will send; the auto and custom values
/// let the UI show the user what is happening under the hood.
/// 2026-08-20.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceHwidInfo {
    pub effective: String,
    pub auto: Option<String>,
    pub custom: Option<String>,
}
