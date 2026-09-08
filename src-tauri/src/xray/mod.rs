//! Runtime-safe preparation of raw Xray provider configurations.

pub mod inbound;
pub mod presentation;
pub mod routing;
pub mod stats;
pub mod windows_tun;

use std::fmt;

use serde_json::Value;

use crate::{config::RoutingOptions, error::AppResult};

pub use routing::{RoutingApplicability, UnavailableReason, UnavailableRule};

#[derive(Clone, PartialEq)]
pub struct PreparedXrayConfig {
    pub value: Value,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub socks_port: u16,
    pub tun_active: bool,
    pub applicability: RoutingApplicability,
    pub(crate) stats: stats::XrayStatsSpec,
}

impl fmt::Debug for PreparedXrayConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedXrayConfig")
            .field("has_runtime_config", &true)
            .field("has_proxy", &true)
            .field(
                "applied_rule_count",
                &self.applicability.applied_rule_ids.len(),
            )
            .field(
                "unavailable_rule_count",
                &self.applicability.unavailable.len(),
            )
            .finish()
    }
}

/// Clone and prepare a provider config only for the running Xray process.
/// The caller's stored provider JSON is never mutated.
pub fn prepare_xray_runtime_config<F>(
    provider: Value,
    routing: &RoutingOptions,
    tunnel_mode: crate::config::TunnelMode,
    mut port_allocator: F,
) -> AppResult<PreparedXrayConfig>
where
    F: FnMut() -> AppResult<u16>,
{
    let inbound = inbound::ensure_managed_inbounds(provider, tunnel_mode, &mut port_allocator)?;
    let routing = routing::merge_routing_with_tun(
        inbound.value,
        routing,
        inbound.tun_active,
        Some(&inbound.traffic_tag),
    )?;
    let (value, stats) =
        stats::merge_stats_config(routing.value, &inbound.traffic_tag, port_allocator)?;
    Ok(PreparedXrayConfig {
        value,
        proxy_host: inbound.proxy_host,
        proxy_port: inbound.proxy_port,
        socks_port: inbound.socks_port,
        tun_active: inbound.tun_active,
        applicability: routing.applicability,
        stats,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::prepare_xray_runtime_config;
    use crate::config::RoutingOptions;

    #[cfg(target_os = "windows")]
    #[test]
    fn preparation_translates_process_rules_without_leaking_provider_secrets() {
        let provider = json!({
            "inbounds": [],
            "outbounds": [{"tag": "proxy", "protocol": "vless", "settings": {"vnext": [{"users": [{"id": "secret-uuid"}]}]}}]
        });
        let original = provider.clone();
        let mut routing = RoutingOptions::default();
        routing.rules = vec![json!({
            "id": "rule-1",
            "label": "Chrome only",
            "enabled": true,
            "matchers": {"process_name": ["chrome.exe"]},
            "action": {"kind": "route", "outbound": "proxy"}
        })];

        let prepared = prepare_xray_runtime_config(
            provider,
            &routing,
            crate::config::TunnelMode::SystemProxy,
            || Ok(20809),
        )
        .unwrap();

        assert_eq!(
            original["outbounds"][0]["settings"]["vnext"][0]["users"][0]["id"],
            "secret-uuid"
        );
        assert_eq!(
            prepared.value["routing"]["rules"][0]["process"],
            json!(["chrome.exe"])
        );
        assert_eq!(prepared.applicability.applied_rule_ids, vec!["rule-1"]);
        assert!(prepared.applicability.unavailable.is_empty());
        let rendered = format!("{:?}", prepared.applicability);
        assert!(!rendered.contains("secret-uuid"));
        assert!(!rendered.contains("vnext"));
    }

    #[test]
    fn preparation_configures_tun_when_tun_mode_selected() {
        let provider = json!({
            "inbounds": [],
            "outbounds": [{"tag": "proxy", "protocol": "vless", "settings": {}}],
            "dns": {
                "servers": ["1.1.1.1", "8.8.8.8"]
            }
        });
        let routing = RoutingOptions::default();
        let prepared = prepare_xray_runtime_config(
            provider,
            &routing,
            crate::config::TunnelMode::Tun,
            || Ok(20809),
        )
        .unwrap();

        assert!(prepared.tun_active);
        assert!(prepared.value["inbounds"].as_array().unwrap().iter().any(|i| i["protocol"] == "tun"));

        // DNS outbound injected
        let dns_outbound = prepared.value["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["protocol"] == "dns")
            .expect("dns outbound present");
        assert_eq!(dns_outbound["tag"], "cloakwire-managed-dns");

        // DNS port 53 rule prepended at index 0
        let first_rule = &prepared.value["routing"]["rules"][0];
        assert_eq!(first_rule["inboundTag"][0], "cloakwire-managed-tun");
        assert_eq!(first_rule["port"], "53");
        assert_eq!(first_rule["outboundTag"], "cloakwire-managed-dns");

        // DNS servers migrated to tcp://
        assert_eq!(
            prepared.value["dns"]["servers"],
            json!(["tcp://1.1.1.1", "tcp://8.8.8.8"])
        );
        assert_eq!(prepared.value["dns"]["queryStrategy"], "UseIPv4");
    }

    #[test]
    fn preparation_neutralizes_provider_category_ru_when_ru_bypass_inactive() {
        let provider = json!({
            "inbounds": [],
            "outbounds": [
                {"tag": "proxy", "protocol": "vless", "settings": {}},
                {"tag": "direct", "protocol": "freedom"}
            ],
            "routing": {
                "rules": [
                    {"type": "field", "protocol": ["bittorrent"], "outboundTag": "direct"},
                    {"type": "field", "domain": ["geosite:category-ru"], "outboundTag": "direct"},
                    {"type": "field", "ip": ["geoip:private"], "outboundTag": "direct"}
                ]
            }
        });
        let routing = RoutingOptions::default();
        let prepared = prepare_xray_runtime_config(
            provider,
            &routing,
            crate::config::TunnelMode::Tun,
            || Ok(20809),
        )
        .unwrap();

        let rules = prepared.value["routing"]["rules"].as_array().unwrap();
        // Port 53 rule is first
        assert_eq!(rules[0]["port"], "53");
        // category-ru direct rule was filtered out
        assert!(!rules.iter().any(|r| {
            r.get("domain")
                .and_then(|d| d.as_array())
                .map_or(false, |arr| arr.iter().any(|item| item == "geosite:category-ru"))
        }));
        // bittorrent and geoip:private were preserved
        assert!(rules.iter().any(|r| r.get("protocol").is_some()));
        assert!(rules.iter().any(|r| r.get("ip").is_some()));
    }

    #[test]
    fn preparation_preserves_provider_category_ru_when_ru_bypass_active() {
        let provider = json!({
            "inbounds": [],
            "outbounds": [
                {"tag": "proxy", "protocol": "vless", "settings": {}},
                {"tag": "direct", "protocol": "freedom"}
            ],
            "routing": {
                "rules": [
                    {"type": "field", "domain": ["geosite:category-ru"], "outboundTag": "direct"}
                ]
            }
        });
        let mut routing = RoutingOptions::default();
        routing.rules = vec![json!({
            "id": "ru-bypass-rule",
            "label": "Bypass RU (migrated)",
            "enabled": true,
            "matchers": {"domain": ["geosite:category-ru"]},
            "action": {"kind": "route", "outbound": "direct"}
        })];

        let prepared = prepare_xray_runtime_config(
            provider,
            &routing,
            crate::config::TunnelMode::Tun,
            || Ok(20809),
        )
        .unwrap();

        let rules = prepared.value["routing"]["rules"].as_array().unwrap();
        // RU bypass is preserved because user enabled it
        assert!(rules.iter().any(|r| {
            r.get("domain")
                .and_then(|d| d.as_array())
                .map_or(false, |arr| arr.iter().any(|item| item == "geosite:category-ru"))
        }));
    }

    #[test]
    fn prepared_config_debug_redacts_runtime_config_and_connection_details() {
        let prepared = prepare_xray_runtime_config(
            json!({
                "inbounds": [{
                    "tag": "sensitive-traffic-tag",
                    "listen": "127.0.0.1",
                    "port": 10809,
                    "protocol": "http"
                }],
                "api": {
                    "tag": "provider-api",
                    "listen": "127.0.0.1:9000",
                    "services": ["HandlerService"]
                },
                "outbounds": [{
                    "tag": "proxy",
                    "protocol": "vless",
                    "settings": {"providerSecret": "synthetic-provider-secret"}
                }]
            }),
            &RoutingOptions::default(),
            crate::config::TunnelMode::SystemProxy,
            || Ok(29001),
        )
        .unwrap();

        let rendered = format!("{prepared:?}");
        for secret_or_connection_detail in [
            "synthetic-provider-secret",
            "127.0.0.1:9000",
            "127.0.0.1:29001",
            "10809",
            "sensitive-traffic-tag",
            "provider-api",
            "HandlerService",
        ] {
            assert!(!rendered.contains(secret_or_connection_detail));
        }
    }

    #[test]
    fn test_anivka_full_runtime_config_preparation() {
        let path = std::path::Path::new(r"C:\Users\Алексей\AppData\Roaming\app.cloakwire.client\subscriptions\subscriptions.v1.json");
        if !path.exists() { return; }
        let content = std::fs::read_to_string(path).unwrap();
        let subs: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap();
        let anivka = subs.iter().find(|s| s.get("name").and_then(|n| n.as_str()) == Some("anivka.top")).unwrap();
        let child = anivka["children"].as_array().unwrap().iter().find(|c| c["key"] == "index-0").unwrap();
        let config = child["config"].clone();

        let prepared = prepare_xray_runtime_config(
            config,
            &RoutingOptions::default(),
            crate::config::TunnelMode::Tun,
            || Ok(20809),
        ).unwrap();

        assert!(prepared.tun_active);
        let out_str = serde_json::to_string_pretty(&prepared.value).unwrap();
        std::fs::write(r"C:\Users\Алексей\.gemini\antigravity\brain\23cb20de-800e-4912-a0b9-6c0b6d19fa14\scratch\anivka_prepared.json", out_str).unwrap();
    }
}
