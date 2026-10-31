//! Pure runtime copies. These functions never write config or change OS networking.
//! The caller must still validate with the selected core and prove physical binding.
use super::types::HealthIssue;
use serde_json::{json, Value};
use std::collections::HashSet;
pub const PROBE_INBOUND_TAG: &str = "cloakwire-private-diagnostic";
pub const PROBE_USER: &str = "cloakwire-probe";
type Result<T> = std::result::Result<T, HealthIssue>;
fn unsupported<T>() -> Result<T> {
    Err(HealthIssue::UnsupportedProbe)
}
fn entries<'a>(config: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    config
        .get(key)
        .and_then(Value::as_array)
        .ok_or(HealthIssue::UnsupportedProbe)
}
fn target<'a>(config: &'a Value, tag: &str, protocol: &str, active: bool) -> Result<&'a Value> {
    let list = entries(config, "outbounds")?;
    let mut tags = HashSet::new();
    for item in list {
        let name = item["tag"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(HealthIssue::UnsupportedProbe)?;
        if !tags.insert(name) {
            return unsupported();
        }
    }
    let item = list
        .iter()
        .find(|o| o["tag"].as_str() == Some(tag))
        .ok_or(HealthIssue::UnsupportedProbe)?;
    let kind = item[protocol].as_str().unwrap_or("");
    let proxy = matches!(
        kind,
        "vless" | "vmess" | "trojan" | "shadowsocks" | "socks" | "http"
    ) || (protocol == "type"
        && matches!(kind, "hysteria2" | "tuic" | "anytls" | "shadowtls" | "ssh"));
    if !proxy && !(active && protocol == "type" && matches!(kind, "selector" | "urltest")) {
        return unsupported();
    }
    Ok(item)
}
fn add_inbound(config: &mut Value, inbound: Value) -> Result<()> {
    let root = config
        .as_object_mut()
        .ok_or(HealthIssue::UnsupportedProbe)?;
    let list = root
        .entry("inbounds")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or(HealthIssue::UnsupportedProbe)?;
    if list.iter().any(|i| i["tag"] == PROBE_INBOUND_TAG) {
        return unsupported();
    }
    list.push(inbound);
    Ok(())
}
fn prepend_rule(config: &mut Value, key: &str, rule: Value) -> Result<()> {
    let root = config
        .as_object_mut()
        .ok_or(HealthIssue::UnsupportedProbe)?;
    let route = root
        .entry(key)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(HealthIssue::UnsupportedProbe)?;
    let rules = route
        .entry("rules")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or(HealthIssue::UnsupportedProbe)?;
    // Never allow a provider rule to refer to a name reserved by the runtime.
    if rules
        .iter()
        .any(|r| r.to_string().contains(PROBE_INBOUND_TAG))
    {
        return unsupported();
    }
    rules.insert(0, rule);
    Ok(())
}
fn credentials(port: u16, password: &str) -> Result<()> {
    if port == 0 || password.is_empty() {
        return unsupported();
    }
    Ok(())
}
pub fn inject_active_singbox_probe(
    original: &Value,
    tag: &str,
    port: u16,
    password: &str,
) -> Result<Value> {
    credentials(port, password)?;
    target(original, tag, "type", true)?;
    let mut copy = original.clone();
    add_inbound(
        &mut copy,
        json!({"type":"http","tag":PROBE_INBOUND_TAG,"listen":"127.0.0.1","listen_port":port,
        "users":[{"username":PROBE_USER,"password":password}]}),
    )?;
    prepend_rule(
        &mut copy,
        "route",
        json!({"inbound":[PROBE_INBOUND_TAG],"action":"route","outbound":tag}),
    )?;
    Ok(copy)
}
pub fn inject_active_xray_probe(
    original: &Value,
    tag: &str,
    port: u16,
    password: &str,
) -> Result<Value> {
    credentials(port, password)?;
    target(original, tag, "protocol", true)?;
    let mut copy = original.clone();
    add_inbound(
        &mut copy,
        json!({"protocol":"http","tag":PROBE_INBOUND_TAG,"listen":"127.0.0.1","port":port,
        "settings":{"accounts":[{"user":PROBE_USER,"pass":password}]}}),
    )?;
    prepend_rule(
        &mut copy,
        "routing",
        json!({"type":"field","inboundTag":[PROBE_INBOUND_TAG],"outboundTag":tag}),
    )?;
    Ok(copy)
}
fn physical(interface: &str) -> Result<()> {
    if interface.trim().is_empty() {
        return Err(HealthIssue::NetworkUnavailable);
    }
    Ok(())
}
fn empty_feature(config: &Value, key: &str) -> bool {
    config.get(key).map_or(true, |v| {
        v.is_null() || v.as_array().is_some_and(Vec::is_empty)
    })
}
fn bind_dial(value: &mut Value, interface: &str) -> Result<()> {
    let obj = value.as_object_mut().ok_or(HealthIssue::UnsupportedProbe)?;
    for name in [
        "inet4_bind_address",
        "inet6_bind_address",
        "routing_mark",
        "netns",
        "network_strategy",
        "network_type",
        "fallback_network_type",
    ] {
        if obj.contains_key(name) {
            return unsupported();
        }
    }
    if obj
        .get("bind_interface")
        .and_then(Value::as_str)
        .is_some_and(|s| s != interface)
    {
        return unsupported();
    }
    if obj
        .get("detour")
        .and_then(Value::as_str)
        .map_or(true, str::is_empty)
    {
        obj.insert("bind_interface".into(), json!(interface));
    }
    Ok(())
}
fn visit_singbox(
    tag: &str,
    list: &[Value],
    visiting: &mut HashSet<String>,
    keep: &mut HashSet<String>,
) -> Result<()> {
    if keep.contains(tag) {
        return Ok(());
    }
    if !visiting.insert(tag.to_owned()) {
        return unsupported();
    }
    let item = list
        .iter()
        .find(|o| o["tag"].as_str() == Some(tag))
        .ok_or(HealthIssue::UnsupportedProbe)?;
    if !matches!(
        item["type"].as_str(),
        Some(
            "vless"
                | "vmess"
                | "trojan"
                | "shadowsocks"
                | "socks"
                | "http"
                | "hysteria2"
                | "tuic"
                | "anytls"
                | "shadowtls"
                | "ssh"
                | "direct"
        )
    ) {
        return unsupported();
    }
    if let Some(next) = item["detour"].as_str().filter(|s| !s.is_empty()) {
        visit_singbox(next, list, visiting, keep)?;
    }
    visiting.remove(tag);
    keep.insert(tag.to_owned());
    Ok(())
}
pub fn prepare_singbox_probe(
    original: &Value,
    tag: &str,
    interface: &str,
    port: u16,
    password: &str,
) -> Result<Value> {
    physical(interface)?;
    target(original, tag, "type", false)?;
    if !empty_feature(original, "services") || !empty_feature(original, "endpoints") {
        return unsupported();
    }
    if original
        .as_object()
        .ok_or(HealthIssue::UnsupportedProbe)?
        .keys()
        .any(|k| {
            ![
                "inbounds",
                "outbounds",
                "dns",
                "log",
                "route",
                "experimental",
                "ntp",
                "services",
                "endpoints",
            ]
            .contains(&k.as_str())
        })
    {
        return unsupported();
    }
    let list = entries(original, "outbounds")?;
    let mut keep = HashSet::new();
    visit_singbox(tag, list, &mut HashSet::new(), &mut keep)?;
    let mut copy = original.clone();
    if let Some(dns) = copy.get_mut("dns") {
        for server in dns
            .get_mut("servers")
            .and_then(Value::as_array_mut)
            .ok_or(HealthIssue::UnsupportedProbe)?
        {
            if !matches!(
                server["type"].as_str(),
                Some("udp" | "tcp" | "tls" | "https" | "quic")
            ) {
                return unsupported();
            }
            // Hostname DNS bootstrap and system/local DNS need a separately proven adapter.
            if server["server"]
                .as_str()
                .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                .is_none()
            {
                return unsupported();
            }
            if let Some(next) = server["detour"].as_str().filter(|s| !s.is_empty()) {
                visit_singbox(next, list, &mut HashSet::new(), &mut keep)?;
            }
            bind_dial(server, interface)?;
        }
    }
    let mut outbounds = Vec::new();
    for item in list
        .iter()
        .filter(|o| keep.contains(o["tag"].as_str().unwrap_or("")))
    {
        let mut item = item.clone();
        if let Some(host) = item["server"].as_str() {
            if host.parse::<std::net::IpAddr>().is_err() {
                let resolver = item
                    .get("domain_resolver")
                    .or_else(|| original["route"].get("default_domain_resolver"));
                let resolver_tag =
                    resolver.and_then(|r| r.as_str().or_else(|| r["server"].as_str()));
                let exists = resolver_tag.is_some_and(|tag| {
                    copy["dns"]["servers"].as_array().is_some_and(|servers| {
                        servers.iter().any(|d| d["tag"].as_str() == Some(tag))
                    })
                });
                if !exists {
                    return unsupported();
                }
            }
        }
        bind_dial(&mut item, interface)?;
        outbounds.push(item);
    }
    copy["outbounds"] = json!(outbounds);
    copy["inbounds"] = json!([]);
    for key in ["experimental", "ntp", "services", "endpoints"] {
        copy.as_object_mut().unwrap().remove(key);
    }
    copy["log"] = json!({"level":"warn","timestamp":false});
    let resolver = copy["route"]["default_domain_resolver"].clone();
    copy["route"] = json!({"final":tag,"default_interface":interface});
    if !resolver.is_null() {
        copy["route"]["default_domain_resolver"] = resolver;
    }
    inject_active_singbox_probe(&copy, tag, port, password)
}

fn visit_xray(
    tag: &str,
    list: &[Value],
    visiting: &mut HashSet<String>,
    keep: &mut HashSet<String>,
) -> Result<()> {
    if keep.contains(tag) {
        return Ok(());
    }
    if !visiting.insert(tag.to_owned()) {
        return unsupported();
    }
    let item = list
        .iter()
        .find(|o| o["tag"].as_str() == Some(tag))
        .ok_or(HealthIssue::UnsupportedProbe)?;
    if !matches!(
        item["protocol"].as_str(),
        Some("vless" | "vmess" | "trojan" | "shadowsocks" | "socks" | "http" | "freedom")
    ) {
        return unsupported();
    }
    if item.get("proxySettings").is_some() || item.get("sendThrough").is_some() {
        return unsupported();
    }
    if let Some(next) = item["streamSettings"]["sockopt"]["dialerProxy"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        visit_xray(next, list, visiting, keep)?;
    }
    visiting.remove(tag);
    keep.insert(tag.to_owned());
    Ok(())
}
pub fn prepare_xray_probe(
    original: &Value,
    tag: &str,
    interface: &str,
    port: u16,
    password: &str,
) -> Result<Value> {
    physical(interface)?;
    target(original, tag, "protocol", false)?;
    // Xray's implicit/system DNS and named bootstrap are not bound by setting an
    // outbound's sockopt.interface. Until independently proven, report unavailable.
    if !empty_feature(&original["dns"], "servers") || original.get("fakedns").is_some() {
        return unsupported();
    }
    let list = entries(original, "outbounds")?;
    let mut keep = HashSet::new();
    visit_xray(tag, list, &mut HashSet::new(), &mut keep)?;
    let mut outbounds = Vec::new();
    for item in list
        .iter()
        .filter(|o| keep.contains(o["tag"].as_str().unwrap_or("")))
    {
        for key in ["vnext", "servers"] {
            if let Some(servers) = item["settings"][key].as_array() {
                for server in servers {
                    let host = server["address"]
                        .as_str()
                        .ok_or(HealthIssue::UnsupportedProbe)?;
                    if host.parse::<std::net::IpAddr>().is_err()
                        && original["dns"]["hosts"][host]
                            .as_str()
                            .and_then(|h| h.parse::<std::net::IpAddr>().ok())
                            .is_none()
                    {
                        return unsupported();
                    }
                }
            }
        }
        let mut item = item.clone();
        let root = item.as_object_mut().ok_or(HealthIssue::UnsupportedProbe)?;
        let stream = root
            .entry("streamSettings")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or(HealthIssue::UnsupportedProbe)?;
        let sockopt = stream
            .entry("sockopt")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or(HealthIssue::UnsupportedProbe)?;
        if sockopt
            .get("interface")
            .and_then(Value::as_str)
            .is_some_and(|s| s != interface)
            || ["mark", "bindToDevice", "tcpFastOpen"]
                .iter()
                .any(|key| sockopt.contains_key(*key))
        {
            return unsupported();
        }
        if sockopt
            .get("dialerProxy")
            .and_then(Value::as_str)
            .map_or(true, str::is_empty)
        {
            sockopt.insert("interface".into(), json!(interface));
        }
        outbounds.push(item);
    }
    let mut copy = json!({"inbounds":[],"outbounds":outbounds,"log":{"loglevel":"warning"},
        "routing":{"domainStrategy":"AsIs","rules":[]}});
    if let Some(dns) = original.get("dns") {
        copy["dns"] = dns.clone();
    }
    inject_active_xray_probe(&copy, tag, port, password)
}
