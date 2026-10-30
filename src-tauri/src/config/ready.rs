use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{build_route, GeneratorSettings, RoutingOptions};
use crate::error::{AppError, AppResult};

/// Apply local routing to a runtime copy of a provider-owned sing-box config.
/// Local rules run first; provider rules and unrelated provider sections keep
/// their original content and relative order.
pub fn merge_ready_routing(mut provider: Value, routing: &RoutingOptions) -> AppResult<Value> {
    let root = provider
        .as_object_mut()
        .ok_or_else(|| AppError::UnsafeConfig("ready sing-box config must be an object".into()))?;
    let tags = outbound_tags(root)?;
    let provider_final = root
        .get("route")
        .and_then(|route| route.get("final"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let proxy_target = resolve_proxy_target(&tags, provider_final.as_deref())?;
    // build_route returns only the route section; merge helpers consume a document.
    let mut generated = serde_json::json!({"route": build_route(&GeneratorSettings {
        routing: routing.clone(),
        ..GeneratorSettings::default()
    })});
    // "local" is the generated-config default, not a DNS tag guaranteed to
    // exist in a provider profile. In that case preserve the provider's
    // explicit resolver (including object-form options) or its implicit DNS.
    let has_local_resolver = root
        .get("dns")
        .and_then(|dns| dns.get("servers"))
        .and_then(Value::as_array)
        .is_some_and(|servers| {
            servers
                .iter()
                .any(|server| server.get("tag").and_then(Value::as_str) == Some("local"))
        });
    if routing.default_domain_resolver == "local" && !has_local_resolver {
        if let Some(route) = generated.get_mut("route").and_then(Value::as_object_mut) {
            route.remove("default_domain_resolver");
        }
    }
    let generated = rewrite_proxy_aliases(generated, &proxy_target, &tags);
    validate_local_targets(&generated, &tags)?;
    ensure_standard_outbounds(root, &generated)?;
    merge_route_documents(root, generated)?;
    Ok(provider)
}

fn outbound_tags(root: &Map<String, Value>) -> AppResult<HashSet<String>> {
    let outbounds = root
        .get("outbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::UnsafeConfig("sing-box outbounds must be an array".into()))?;
    let mut tags = HashSet::new();
    for outbound in outbounds {
        let tag = outbound
            .get("tag")
            .and_then(Value::as_str)
            .filter(|tag| !tag.is_empty())
            .ok_or_else(|| AppError::UnsafeConfig("sing-box outbound tag is missing".into()))?;
        if !tags.insert(tag.to_owned()) {
            return Err(AppError::UnsafeConfig(
                "duplicate sing-box outbound tag".into(),
            ));
        }
    }
    Ok(tags)
}

fn resolve_proxy_target(tags: &HashSet<String>, provider_final: Option<&str>) -> AppResult<String> {
    if tags.contains("proxy") {
        return Ok("proxy".into());
    }
    provider_final
        .filter(|tag| tags.contains(*tag))
        .map(str::to_owned)
        .ok_or_else(|| {
            AppError::UnsafeConfig("ready sing-box config has no usable proxy outbound".into())
        })
}

fn rewrite_proxy_aliases(
    mut generated: Value,
    proxy_target: &str,
    provider_tags: &HashSet<String>,
) -> Value {
    let rewrite = |value: &mut Value| {
        let Some(tag) = value.as_str() else {
            return;
        };
        if matches!(tag, "proxy" | "auto") && !provider_tags.contains(tag) {
            *value = Value::String(proxy_target.to_owned());
        }
    };
    if let Some(route) = generated.get_mut("route").and_then(Value::as_object_mut) {
        if let Some(final_outbound) = route.get_mut("final") {
            rewrite(final_outbound);
        }
        if let Some(rules) = route.get_mut("rules").and_then(Value::as_array_mut) {
            for rule in rules {
                if let Some(outbound) = rule.get_mut("outbound") {
                    rewrite(outbound);
                }
            }
        }
    }
    generated
}

fn validate_local_targets(generated: &Value, tags: &HashSet<String>) -> AppResult<()> {
    let route = generated
        .get("route")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::UnsafeConfig("generated sing-box route is invalid".into()))?;
    let mut targets = Vec::new();
    if let Some(target) = route.get("final").and_then(Value::as_str) {
        targets.push(target);
    }
    for rule in route
        .get("rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(target) = rule.get("outbound").and_then(Value::as_str) {
            targets.push(target);
        }
    }
    for target in targets {
        if !tags.contains(target) && !matches!(target, "direct" | "block") {
            return Err(AppError::UnsafeConfig(format!(
                "routing target does not exist: {target}"
            )));
        }
    }
    Ok(())
}

fn ensure_standard_outbounds(root: &mut Map<String, Value>, generated: &Value) -> AppResult<()> {
    let tags = outbound_tags(root)?;
    let route = generated
        .get("route")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::UnsafeConfig("generated sing-box route is invalid".into()))?;
    let mut required = HashSet::new();
    if let Some(target) = route.get("final").and_then(Value::as_str) {
        required.insert(target);
    }
    for rule in route
        .get("rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(target) = rule.get("outbound").and_then(Value::as_str) {
            required.insert(target);
        }
    }
    let outbounds = root
        .get_mut("outbounds")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::UnsafeConfig("sing-box outbounds must be an array".into()))?;
    for (tag, kind) in [("direct", "direct"), ("block", "block")] {
        if required.contains(tag) && !tags.contains(tag) {
            outbounds.push(serde_json::json!({"type": kind, "tag": tag}));
        }
    }
    Ok(())
}

fn merge_route_documents(root: &mut Map<String, Value>, generated: Value) -> AppResult<()> {
    let generated_route = generated
        .get("route")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::UnsafeConfig("generated sing-box route is invalid".into()))?;
    let route = root
        .entry("route")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| AppError::UnsafeConfig("sing-box route must be an object".into()))?;

    let mut local_rules = generated_route
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let provider_rules = route
        .entry("rules")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| AppError::UnsafeConfig("sing-box route rules must be an array".into()))?;
    local_rules.append(provider_rules);
    route.insert("rules".into(), Value::Array(local_rules));

    merge_rule_sets(route, generated_route.get("rule_set"))?;
    for key in [
        "find_process",
        "final",
        "auto_detect_interface",
        "default_domain_resolver",
        "default_http_client",
    ] {
        if let Some(value) = generated_route.get(key) {
            route.insert(key.into(), value.clone());
        }
    }

    if route.get("default_http_client").and_then(Value::as_str) == Some("rule-set-fetcher") {
        ensure_rule_set_fetcher(root)?;
    }
    Ok(())
}

fn merge_rule_sets(
    route: &mut Map<String, Value>,
    local_rule_sets: Option<&Value>,
) -> AppResult<()> {
    let Some(local_rule_sets) = local_rule_sets.and_then(Value::as_array) else {
        return Ok(());
    };
    let provider_rule_sets = route
        .entry("rule_set")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| AppError::UnsafeConfig("sing-box rule_set must be an array".into()))?;
    let mut tags = HashSet::new();
    for rule_set in provider_rule_sets.iter().chain(local_rule_sets.iter()) {
        let tag = rule_set
            .get("tag")
            .and_then(Value::as_str)
            .filter(|tag| !tag.is_empty())
            .ok_or_else(|| AppError::UnsafeConfig("sing-box rule-set tag is missing".into()))?;
        if !tags.insert(tag.to_owned()) {
            return Err(AppError::UnsafeConfig(
                "local and provider rule-set tags conflict".into(),
            ));
        }
    }
    let mut merged = local_rule_sets.clone();
    merged.extend(provider_rule_sets.iter().cloned());
    route.insert("rule_set".into(), Value::Array(merged));
    Ok(())
}

fn ensure_rule_set_fetcher(root: &mut Map<String, Value>) -> AppResult<()> {
    let clients = root
        .entry("http_clients")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| AppError::UnsafeConfig("sing-box http_clients must be an array".into()))?;
    let exists = clients
        .iter()
        .any(|client| client.get("tag").and_then(Value::as_str) == Some("rule-set-fetcher"));
    if !exists {
        clients.push(serde_json::json!({"tag": "rule-set-fetcher"}));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider() -> Value {
        json!({
            "log": {"level": "warning"},
            "dns": {"servers": [{"tag": "provider-dns", "address": "local"}]},
            "outbounds": [
                {"type": "vless", "tag": "providerProxy", "uuid": "secret-uuid"},
                {"type": "direct", "tag": "direct"},
                {"type": "block", "tag": "block"}
            ],
            "route": {
                "final": "providerProxy",
                "rules": [
                    {"domain_suffix": ["provider-one.test"], "outbound": "providerProxy"},
                    {"domain_suffix": ["provider-two.test"], "outbound": "direct"}
                ]
            }
        })
    }

    #[test]
    fn local_routing_precedes_provider_rules_without_replacing_them() {
        let original = provider();
        let provider_rules = original["route"]["rules"].as_array().unwrap().clone();
        let routing = RoutingOptions {
            direct_processes: vec!["bank.exe".into()],
            vpn_processes: vec!["chat.exe".into()],
            final_outbound: "direct".into(),
            rules: vec![json!({
                "enabled": true,
                "matchers": {"domain_suffix": ["local.test"]},
                "action": {"kind": "route", "outbound": "proxy"}
            })],
            ..RoutingOptions::default()
        };
        let merged = merge_ready_routing(original.clone(), &routing).unwrap();
        let rules = merged["route"]["rules"].as_array().unwrap();
        assert_eq!(rules[0]["action"], json!("hijack-dns"));
        assert!(rules.iter().any(
            |rule| rule["process_name"] == json!(["bank.exe"]) && rule["outbound"] == "direct"
        ));
        assert!(rules
            .iter()
            .any(|rule| rule["process_name"] == json!(["chat.exe"])
                && rule["outbound"] == "providerProxy"));
        assert_eq!(rules[rules.len() - 2], provider_rules[0]);
        assert_eq!(rules[rules.len() - 1], provider_rules[1]);
        assert_eq!(merged["dns"], original["dns"]);
        assert_eq!(merged["log"], original["log"]);
        assert_eq!(merged["route"]["final"], json!("direct"));
        assert_eq!(merged["route"]["find_process"], json!(true));
    }

    #[test]
    fn default_proxy_alias_uses_provider_final() {
        let merged = merge_ready_routing(provider(), &RoutingOptions::default()).unwrap();
        assert_eq!(merged["route"]["final"], json!("providerProxy"));
    }

    #[test]
    fn missing_explicit_target_is_rejected_without_leaking_provider_data() {
        let routing = RoutingOptions {
            final_outbound: "missing".into(),
            ..RoutingOptions::default()
        };
        let error = merge_ready_routing(provider(), &routing).unwrap_err();
        assert!(matches!(error, AppError::UnsafeConfig(_)));
        assert!(error.to_string().contains("missing"));
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("secret-uuid"));
    }

    #[test]
    fn bypass_ru_settings_fixture_merges_into_ready_profile() {
        let settings: GeneratorSettings =
            serde_json::from_str(include_str!("fixtures/bypass-ru-settings.json")).unwrap();
        let original = provider();
        let merged = merge_ready_routing(original.clone(), &settings.routing).unwrap();
        assert_eq!(merged["route"]["final"], "providerProxy");
        assert_eq!(merged["dns"], original["dns"]);
        let sets = merged["route"]["rule_set"].as_array().unwrap();
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0]["tag"], "geoip-ru");
        assert_eq!(
            sets[0]["url"],
            "https://raw.githubusercontent.com/Loyalsoldier/geoip/release/srs/ru.srs"
        );
        assert!(sets[0].get("enabled").is_none());
        assert!(merged["route"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|rule| {
                rule["rule_set"] == json!(["geoip-ru"])
                    && rule["action"] == "route"
                    && rule["outbound"] == "direct"
            }));
        assert_eq!(merged["http_clients"][0]["tag"], "rule-set-fetcher");
    }

    #[test]
    fn ready_profile_preserves_provider_resolver_when_local_alias_is_absent() {
        let mut original = provider();
        original["route"]["default_domain_resolver"] =
            json!({"server": "provider-dns", "strategy": "ipv4_only"});
        let merged = merge_ready_routing(original.clone(), &RoutingOptions::default()).unwrap();
        assert_eq!(
            merged["route"]["default_domain_resolver"],
            original["route"]["default_domain_resolver"]
        );
        assert_eq!(merged["dns"], original["dns"]);
    }

    #[test]
    fn ready_profile_keeps_implicit_dns_when_local_alias_is_absent() {
        let original = provider();
        let merged = merge_ready_routing(original.clone(), &RoutingOptions::default()).unwrap();
        assert!(merged["route"].get("default_domain_resolver").is_none());
        assert_eq!(merged["dns"], original["dns"]);
    }

    #[test]
    fn ready_profile_applies_resolver_available_in_provider() {
        for resolver in ["local", "provider-dns"] {
            let mut original = provider();
            original["dns"]["servers"] = json!([{"type": "local", "tag": resolver}]);
            let routing = RoutingOptions {
                default_domain_resolver: resolver.into(),
                ..RoutingOptions::default()
            };
            let merged = merge_ready_routing(original, &routing).unwrap();
            assert_eq!(merged["route"]["default_domain_resolver"], resolver);
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    #[ignore = "requires the bundled desktop sing-box executable"]
    fn ready_geoip_config_passes_bundled_desktop_core_check() {
        let settings: GeneratorSettings =
            serde_json::from_str(include_str!("fixtures/bypass-ru-settings.json")).unwrap();
        let original = json!({
            "dns": {"servers": [{"type": "local", "tag": "provider-dns"}]},
            "inbounds": [{"type": "mixed", "tag": "probe", "listen": "127.0.0.1", "listen_port": 0}],
            "outbounds": [{"type": "direct", "tag": "providerProxy"}],
            "route": {"final": "providerProxy", "default_domain_resolver": "provider-dns"}
        });
        let merged = merge_ready_routing(original, &settings.routing).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("ready-geoip.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&merged).unwrap()).unwrap();
        let binary_name = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => "sing-box-x86_64-pc-windows-msvc.exe",
            ("macos", "aarch64") => "sing-box-aarch64-apple-darwin",
            ("macos", "x86_64") => "sing-box-x86_64-apple-darwin",
            platform => panic!("no bundled sing-box for {platform:?}"),
        };
        let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(binary_name);
        let output = std::process::Command::new(binary)
            .args(["check", "-c"])
            .arg(&path)
            .output()
            .expect("run bundled desktop sing-box");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn rule_sets_are_merged_and_duplicate_tags_are_rejected() {
        let routing = RoutingOptions {
            rule_sets: vec![
                json!({"tag": "local-set", "type": "remote", "format": "binary", "url": "https://example.test/local.srs"}),
            ],
            ..RoutingOptions::default()
        };
        let mut base = provider();
        base["route"]["rule_set"] = json!([{"tag": "provider-set", "type": "inline"}]);
        let merged = merge_ready_routing(base.clone(), &routing).unwrap();
        assert_eq!(merged["route"]["rule_set"][0]["tag"], json!("local-set"));
        assert_eq!(merged["route"]["rule_set"][1]["tag"], json!("provider-set"));
        assert_eq!(merged["http_clients"][0]["tag"], json!("rule-set-fetcher"));

        base["route"]["rule_set"] = json!([{"tag": "local-set", "type": "inline"}]);
        assert!(merge_ready_routing(base, &routing).is_err());
    }
}
