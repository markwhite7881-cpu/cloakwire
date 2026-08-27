//! Xray config assembly for the Android loopback architecture.
//!
//! Architecture (must match the Kotlin `CloakwireVpnService`):
//!
//!   inbounds:  socks on 127.0.0.1:[SOCKS_INBOUND_PORT] — fed by
//!              hev-socks5-tunnel from the VpnService TUN fd
//!   outbounds: mapped proxies (first = default), direct, block, and
//!              the `protected` socks outbound (127.0.0.1:
//!              [PROTECTED_PROXY_PORT], the in-app ProtectedSocks5Proxy)
//!              that every proxy chains through via `sockopt.dialerProxy`
//!
//! Two entry points:
//!  - [link_config]: share-link / Clash-YAML profiles (the classified
//!    `Outbound[]`) → a complete config
//!  - [normalize_bundle]: a provider's full xray config (anivka-style
//!    bundles) → the same config with the protected dialer spliced in,
//!    everything else (selectors, urltests, routing, dns) untouched
//!
//! Hysteria2 / TUIC links are not supported by Xray-core; they are
//! skipped and reported, never silently dropped.

use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::parser::{Outbound, TlsCfg, Transport};

/// xray socks inbound port (loopback). Mirrors
/// `CloakwireVpnService.SOCKS_INBOUND_PORT`.
pub const SOCKS_INBOUND_PORT: u16 = 10808;
/// In-app protected SOCKS5 dialer port. Mirrors
/// `CloakwireVpnService.PROTECTED_PROXY_PORT`.
pub const PROTECTED_PROXY_PORT: u16 = 10810;

/// Tag of the protected dialer outbound every proxy chains through.
pub const PROTECTED_TAG: &str = "protected";

/// Protocols that open remote sockets themselves and therefore must
/// chain through the protected dialer. Selectors, urltests, blackhole
/// and dns outbounds never dial — they are left untouched.
const DIALER_PROTOCOLS: &[&str] = &[
    "vless",
    "vmess",
    "trojan",
    "shadowsocks",
    "socks",
    "http",
    "freedom",
];

/// Build a complete xray config from classified share-link profiles.
///
/// The first mappable profile becomes xray's default outbound; the
/// rest are present so a future selector can reference them. Errors
/// when nothing mappable remains (all Hysteria2/TUIC/unsupported).
pub fn link_config(outbounds: &[Outbound]) -> AppResult<Value> {
    let mut mapped: Vec<Value> = Vec::new();
    let mut skipped: Vec<&str> = Vec::new();
    for outbound in outbounds {
        match outbound_to_xray(outbound, true) {
            Some(value) => mapped.push(value),
            None => skipped.push(outbound.protocol()),
        }
    }
    if mapped.is_empty() {
        return Err(AppError::Unsupported(format!(
            "no xray-compatible profiles (skipped: {})",
            skipped.join(", ")
        )));
    }

    // Direct and block helpers, then the protected dialer.
    mapped.push(json!({ "tag": "direct", "protocol": "freedom" }));
    mapped.push(json!({ "tag": "block", "protocol": "blackhole" }));
    mapped.push(protected_outbound());

    Ok(json!({
        "log": { "loglevel": "warning" },
        "inbounds": [socks_inbound()],
        "outbounds": mapped,
        "dns": {
            "queryStrategy": "UseIPv4",
            "servers": ["1.1.1.1", "8.8.8.8"],
        },
        "routing": {
            "domainStrategy": "AsIs",
            // Block QUIC so browsers fall back to TCP TLS — UDP
            // through some proxy chains stalls Chrome.
            "rules": [
                { "type": "field", "network": "udp", "port": 443,
                  "outboundTag": "block" },
            ],
        },
    }))
}

/// Entry of the latency tester map: which loopback socks port
/// measures which profile tag.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TestEntry {
    pub tag: String,
    pub port: u16,
}

/// Spec returned by [test_config]: the config to spawn a short-lived
/// tester xray with, plus the port→tag map the runner needs.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TestSpec {
    pub config: Value,
    pub entries: Vec<TestEntry>,
}

/// First loopback socks port used by the latency tester. Ports are
/// allocated as `TEST_BASE_PORT + i`, one per profile.
pub const TEST_BASE_PORT: u16 = 20000;

/// Build a latency-tester config: one loopback socks inbound per
/// profile, each routed (by inboundTag) to exactly one proxy outbound.
///
/// No protected chain: the app package is always excluded from the
/// TUN, so the tester's direct dials bypass an active tunnel by
/// themselves. This works with the VPN up AND down, which is exactly
/// the semantics a server picker needs.
///
/// Skips profiles xray cannot run; errors only when NOTHING is
/// testable.
pub fn test_config(outbounds: &[Outbound]) -> AppResult<TestSpec> {
    let mut inbounds: Vec<Value> = Vec::new();
    let mut outbounds_json: Vec<Value> = Vec::new();
    let mut rules: Vec<Value> = Vec::new();
    let mut entries: Vec<TestEntry> = Vec::new();
    let mut skipped: Vec<&str> = Vec::new();

    for (i, outbound) in outbounds.iter().enumerate() {
        let Some(mapped) = outbound_to_xray(outbound, false) else {
            skipped.push(outbound.protocol());
            continue;
        };
        let tag = mapped["tag"].as_str().unwrap_or_default().to_string();
        let port = TEST_BASE_PORT + i as u16;
        let inbound_tag = format!("test-in-{i}");
        inbounds.push(json!({
            "tag": inbound_tag,
            "listen": "127.0.0.1",
            "port": port,
            "protocol": "socks",
            "settings": { "auth": "noauth", "udp": false },
        }));
        rules.push(json!({
            "type": "field",
            "inboundTag": [inbound_tag],
            "outboundTag": tag,
        }));
        outbounds_json.push(mapped);
        entries.push(TestEntry { tag, port });
    }

    if entries.is_empty() {
        return Err(AppError::Unsupported(format!(
            "no xray-compatible profiles to test (skipped: {})",
            skipped.join(", ")
        )));
    }
    outbounds_json.push(json!({ "tag": "direct", "protocol": "freedom" }));

    Ok(TestSpec {
        config: json!({
            "log": { "loglevel": "error" },
            "inbounds": inbounds,
            "outbounds": outbounds_json,
            "routing": { "domainStrategy": "AsIs", "rules": rules },
        }),
        entries,
    })
}

/// Splice the protected dialer into a provider's full xray config.
///
/// - ensures a `protected` socks outbound exists (idempotent);
/// - sets `sockopt.dialerProxy = "protected"` on every dialing
///   outbound (vless/vmess/trojan/ss/socks/http/freedom) that does
///   not already carry one;
/// - everything else — selectors, urltests, routing rules, dns,
///   inbounds — passes through untouched, because the provider wrote
///   it for real xray clients.
pub fn normalize_bundle(mut config: Value) -> AppResult<Value> {
    let Some(obj) = config.as_object_mut() else {
        return Err(AppError::Unsupported(
            "bundle config is not a JSON object".into(),
        ));
    };
    let outbounds = obj
        .get_mut("outbounds")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| AppError::Unsupported("bundle config has no outbounds array".into()))?;
    if outbounds.is_empty() {
        return Err(AppError::Unsupported(
            "bundle config has no outbounds".into(),
        ));
    }

    let mut has_protected = false;
    for outbound in outbounds.iter_mut() {
        let tag = outbound.get("tag").and_then(Value::as_str).unwrap_or("");
        if tag == PROTECTED_TAG {
            has_protected = true;
            continue;
        }
        let protocol = outbound
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !DIALER_PROTOCOLS.contains(&protocol) {
            continue;
        }
        chain_to_protected(outbound);
    }
    if !has_protected {
        outbounds.push(protected_outbound());
    }
    Ok(config)
}

/// Set `streamSettings.sockopt.dialerProxy` unless the outbound
/// already chains through something.
///
/// Placement is load-bearing: xray only reads `dialerProxy` from
/// `streamSettings.sockopt` — a top-level outbound `sockopt` is
/// silently ignored (verified on-device 2026-08-22: the same
/// vless/reality profile worked through `streamSettings.sockopt` and
/// dead-ended with the top-level placement).
fn chain_to_protected(outbound: &mut Value) {
    let obj = match outbound.as_object_mut() {
        Some(o) => o,
        None => return,
    };
    // Hoist a legacy top-level sockopt.dialerProxy (xray ignores it
    // there) into streamSettings.sockopt so an existing chain keeps
    // working instead of being duplicated.
    let legacy_chain = obj
        .get("sockopt")
        .and_then(|s| s.get("dialerProxy"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    // Ensure streamSettings exists and is an object.
    if !obj.get("streamSettings").is_some_and(Value::is_object) {
        obj.insert("streamSettings".into(), json!({}));
    }
    let Some(stream) = obj.get_mut("streamSettings").and_then(Value::as_object_mut) else {
        return;
    };
    if !stream.get("sockopt").is_some_and(Value::is_object) {
        stream.insert("sockopt".into(), json!({}));
    }
    let Some(sockopt) = stream.get_mut("sockopt").and_then(Value::as_object_mut) else {
        return;
    };
    if !sockopt
        .get("dialerProxy")
        .and_then(Value::as_str)
        .is_some_and(|existing| !existing.trim().is_empty())
    {
        // An empty/whitespace dialerProxy (provider panels emit these)
        // is NOT a working chain — it silently dead-ends xray dials
        // (verified on-device 2026-08-22). Only a non-empty existing
        // chain is respected.
        match legacy_chain {
            Some(existing) if !existing.trim().is_empty() => {
                sockopt.insert("dialerProxy".into(), json!(existing));
            }
            _ => {
                sockopt.insert("dialerProxy".into(), json!(PROTECTED_TAG));
            }
        }
    }
}

fn protected_outbound() -> Value {
    json!({
        "tag": PROTECTED_TAG,
        "protocol": "socks",
        "settings": {
            "servers": [
                { "address": "127.0.0.1", "port": PROTECTED_PROXY_PORT },
            ],
        },
    })
}

fn socks_inbound() -> Value {
    json!({
        "tag": "socks-in",
        "listen": "127.0.0.1",
        "port": SOCKS_INBOUND_PORT,
        "protocol": "socks",
        "settings": {
            "auth": "noauth",
            "udp": true,
            "ip": "127.0.0.1",
        },
        "sniffing": {
            "enabled": true,
            "destOverride": ["http", "tls", "quic"],
            "routeOnly": false,
        },
    })
}

/// Map one classified outbound to its xray shape. `chain` attaches
/// the `dialerProxy` link to the protected dialer (session configs).
/// The latency tester passes `false`: the app package is always
/// excluded from the TUN, so its direct dials bypass the tunnel
/// without the chain.
/// `None` = not representable in xray (Hysteria2, TUIC, unsupported
/// links, xhttp transport).
fn outbound_to_xray(outbound: &Outbound, chain: bool) -> Option<Value> {
    let (tag, server, port, protocol, settings, transport, tls) = match outbound {
        Outbound::Vless(o) => (
            o.tag.clone(),
            o.server.clone(),
            o.port,
            "vless",
            json!({
                "vnext": [{
                    "address": o.server,
                    "port": o.port,
                    "users": [{
                        "id": o.uuid,
                        "encryption": "none",
                        "flow": o.flow.clone().unwrap_or_default(),
                    }],
                }],
            }),
            &o.transport,
            &o.tls,
        ),
        Outbound::Vmess(o) => (
            o.tag.clone(),
            o.server.clone(),
            o.port,
            "vmess",
            json!({
                "vnext": [{
                    "address": o.server,
                    "port": o.port,
                    "users": [{
                        "id": o.uuid,
                        "alterId": o.alter_id,
                        "security": vmess_security(&o.cipher),
                    }],
                }],
            }),
            &o.transport,
            &o.tls,
        ),
        Outbound::Trojan(o) => (
            o.tag.clone(),
            o.server.clone(),
            o.port,
            "trojan",
            json!({
                "servers": [{
                    "address": o.server,
                    "port": o.port,
                    "password": o.password,
                }],
            }),
            &o.transport,
            &o.tls,
        ),
        Outbound::Shadowsocks(o) => (
            o.tag.clone(),
            o.server.clone(),
            o.port,
            "shadowsocks",
            json!({
                "servers": [{
                    "address": o.server,
                    "port": o.port,
                    "method": o.method,
                    "password": o.password,
                }],
            }),
            &Transport::Tcp,
            &TlsCfg::default(),
        ),
        Outbound::Hysteria2(_) | Outbound::Tuic(_) | Outbound::Unsupported { .. } => return None,
    };

    if server.is_empty() || port == 0 {
        return None;
    }

    let mut value = json!({
        "tag": tag,
        "protocol": protocol,
        "settings": settings,
    });
    let mut stream = stream_settings(transport, tls);
    if chain {
        // dialerProxy lives under streamSettings.sockopt — see the
        // note on chain_to_protected.
        stream["sockopt"] = json!({ "dialerProxy": PROTECTED_TAG });
    }
    if stream.as_object().map_or(false, |map| !map.is_empty()) {
        value["streamSettings"] = stream;
    }
    Some(value)
}

/// xray's `security` names for the vmess ciphers ("none" is written
/// as the empty string in user entries — xray treats it as "auto").
fn vmess_security(cipher: &crate::parser::VmessCipher) -> &'static str {
    use crate::parser::VmessCipher;
    match cipher {
        VmessCipher::Auto => "auto",
        VmessCipher::Aes128Gcm => "aes-128-gcm",
        VmessCipher::Chacha20Poly1305 => "chacha20-poly1305",
        VmessCipher::None => "none",
    }
}

/// Build `streamSettings` from the parsed transport + TLS config.
/// Returns an empty object for plain TCP without TLS.
fn stream_settings(transport: &Transport, tls: &TlsCfg) -> Value {
    let mut stream = Map::new();
    match transport {
        Transport::Tcp | Transport::Udp => {}
        Transport::Ws { path, headers } => {
            let mut ws = Map::new();
            if let Some(p) = path {
                if !p.is_empty() {
                    ws.insert("path".into(), json!(p));
                }
            }
            if !headers.is_empty() {
                let mut map = Map::new();
                for (k, v) in headers {
                    map.insert(k.clone(), json!(v));
                }
                ws.insert("headers".into(), Value::Object(map));
            }
            stream.insert("network".into(), json!("ws"));
            stream.insert("wsSettings".into(), Value::Object(ws));
        }
        Transport::Http { host, path } | Transport::Xhttp { host, path, .. } => {
            // xray has no xhttp; the plain HTTP/2 transport is the
            // closest representable mapping.
            let mut http = Map::new();
            if !host.is_empty() {
                http.insert("host".into(), json!(host));
            }
            if let Some(p) = path {
                if !p.is_empty() {
                    http.insert("path".into(), json!(p));
                }
            }
            stream.insert("network".into(), json!("http"));
            stream.insert("httpSettings".into(), Value::Object(http));
        }
        Transport::Grpc { service_name, .. } => {
            stream.insert("network".into(), json!("grpc"));
            stream.insert(
                "grpcSettings".into(),
                json!({ "serviceName": service_name.clone().unwrap_or_default() }),
            );
        }
    }

    if tls.enabled {
        if let Some(reality) = &tls.reality {
            let mut reality_settings = Map::new();
            if let Some(sni) = &tls.server_name {
                reality_settings.insert("serverName".into(), json!(sni));
            }
            reality_settings.insert("publicKey".into(), json!(reality.public_key));
            reality_settings.insert("shortId".into(), json!(reality.short_id));
            if let Some(spider) = &reality.spider_x {
                if !spider.is_empty() {
                    reality_settings.insert("spiderX".into(), json!(spider));
                }
            }
            stream.insert("security".into(), json!("reality"));
            stream.insert("realitySettings".into(), Value::Object(reality_settings));
        } else {
            let mut tls_settings = Map::new();
            if let Some(sni) = &tls.server_name {
                if !sni.is_empty() {
                    tls_settings.insert("serverName".into(), json!(sni));
                }
            }
            if !tls.alpn.is_empty() {
                tls_settings.insert("alpn".into(), json!(tls.alpn));
            }
            if let Some(fp) = &tls.fingerprint {
                if !fp.is_empty() {
                    tls_settings.insert("fingerprint".into(), json!(fp));
                }
            }
            if tls.allow_insecure {
                tls_settings.insert("allowInsecure".into(), json!(true));
            }
            stream.insert("security".into(), json!("tls"));
            stream.insert("tlsSettings".into(), Value::Object(tls_settings));
        }
    }

    Value::Object(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{RealityCfg, SsOut, TrojanOut, VlessOut, VmessCipher, VmessOut};

    fn vless_ws_tls() -> Outbound {
        Outbound::Vless(VlessOut {
            tag: "p1".into(),
            server: "example.com".into(),
            port: 443,
            uuid: "11111111-2222-3333-4444-555555555555".into(),
            flow: Some("xtls-rprx-vision".into()),
            transport: Transport::Ws {
                path: Some("/ws".into()),
                headers: vec![("Host".into(), "sniff.example".into())],
            },
            tls: TlsCfg {
                enabled: true,
                server_name: Some("sniff.example".into()),
                alpn: vec!["h2".into()],
                fingerprint: Some("chrome".into()),
                ..TlsCfg::default()
            },
        })
    }

    fn outbound_tags(config: &Value) -> Vec<String> {
        config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["tag"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn link_config_maps_vless_with_chain_transport_and_tls() {
        let config = link_config(&[vless_ws_tls()]).unwrap();
        assert_eq!(config["inbounds"][0]["port"], json!(SOCKS_INBOUND_PORT));
        assert_eq!(config["inbounds"][0]["listen"], json!("127.0.0.1"));
        let outbounds = config["outbounds"].as_array().unwrap();
        // p1 first (default), then direct, block, protected.
        assert_eq!(outbounds[0]["tag"], json!("p1"));
        assert_eq!(
            outbound_tags(&config),
            vec!["p1", "direct", "block", PROTECTED_TAG]
        );
        let p1 = &outbounds[0];
        assert_eq!(p1["protocol"], json!("vless"));
        assert_eq!(
            p1["streamSettings"]["sockopt"]["dialerProxy"],
            json!(PROTECTED_TAG)
        );
        let user = &p1["settings"]["vnext"][0]["users"][0];
        assert_eq!(user["id"], json!("11111111-2222-3333-4444-555555555555"));
        assert_eq!(user["flow"], json!("xtls-rprx-vision"));
        let stream = &p1["streamSettings"];
        assert_eq!(stream["network"], json!("ws"));
        assert_eq!(stream["wsSettings"]["path"], json!("/ws"));
        assert_eq!(
            stream["wsSettings"]["headers"]["Host"],
            json!("sniff.example")
        );
        assert_eq!(stream["tlsSettings"]["serverName"], json!("sniff.example"));
    }

    #[test]
    fn link_config_reality_maps_to_reality_security() {
        let outbound = Outbound::Vless(VlessOut {
            tag: "r1".into(),
            server: "re.example".into(),
            port: 443,
            uuid: "u".into(),
            flow: None,
            transport: Transport::Tcp,
            tls: TlsCfg {
                enabled: true,
                server_name: Some("www.example.com".into()),
                reality: Some(RealityCfg {
                    public_key: "PUB".into(),
                    short_id: "0123".into(),
                    spider_x: None,
                }),
                ..TlsCfg::default()
            },
        });
        let config = link_config(&[outbound]).unwrap();
        let stream = &config["outbounds"][0]["streamSettings"];
        assert_eq!(stream["security"], json!("reality"));
        assert_eq!(stream["realitySettings"]["publicKey"], json!("PUB"));
        assert_eq!(stream["realitySettings"]["shortId"], json!("0123"));
        assert!(stream.get("tlsSettings").is_none());
    }

    #[test]
    fn link_config_maps_trojan_vmess_and_ss() {
        let outbounds = vec![
            Outbound::Trojan(TrojanOut {
                tag: "t1".into(),
                server: "t.example".into(),
                port: 443,
                password: "pw".into(),
                transport: Transport::Tcp,
                tls: TlsCfg {
                    enabled: true,
                    server_name: Some("t.example".into()),
                    ..TlsCfg::default()
                },
            }),
            Outbound::Vmess(VmessOut {
                tag: "v1".into(),
                server: "v.example".into(),
                port: 443,
                uuid: "u".into(),
                alter_id: 0,
                cipher: VmessCipher::Auto,
                transport: Transport::Grpc {
                    service_name: Some("svc".into()),
                    idle_timeout: None,
                    ping_timeout: None,
                },
                tls: TlsCfg::default(),
            }),
            Outbound::Shadowsocks(SsOut {
                tag: "s1".into(),
                server: "s.example".into(),
                port: 8388,
                method: "aes-128-gcm".into(),
                password: "x".into(),
                plugin: None,
                plugin_opts: None,
            }),
        ];
        let config = link_config(&outbounds).unwrap();
        let tags = outbound_tags(&config);
        assert!(tags.contains(&"t1".to_string()));
        assert!(tags.contains(&"v1".to_string()));
        assert!(tags.contains(&"s1".to_string()));
        let trojan = config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["tag"] == json!("t1"))
            .unwrap();
        assert_eq!(trojan["settings"]["servers"][0]["password"], json!("pw"));
        let vmess = config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["tag"] == json!("v1"))
            .unwrap();
        assert_eq!(
            vmess["streamSettings"]["grpcSettings"]["serviceName"],
            json!("svc")
        );
    }

    #[test]
    fn link_config_rejects_when_nothing_mappable() {
        let outbound = Outbound::Hysteria2(crate::parser::Hy2Out {
            tag: "h".into(),
            server: "h.example".into(),
            port: 443,
            password: "x".into(),
            tls: TlsCfg::default(),
            obfs: None,
            up_mbps: None,
            down_mbps: None,
        });
        let err = link_config(&[outbound]).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("hysteria2"), "message: {message}");
    }

    #[test]
    fn normalize_bundle_chains_dialers_and_keeps_the_rest() {
        let bundle = json!({
            "log": { "loglevel": "info" },
            "inbounds": [
                { "tag": "socks", "port": 1080, "protocol": "socks",
                  "settings": { "auth": "noauth" } },
            ],
            "outbounds": [
                { "tag": "proxy", "protocol": "vless",
                  "settings": { "vnext": [] } },
                { "tag": "selector", "protocol": "selector",
                  "settings": { "outbounds": ["proxy", "direct"] } },
                { "tag": "direct", "protocol": "freedom" },
            ],
            "routing": { "rules": [ { "type": "field",
                "domain": ["geosite:google"], "outboundTag": "proxy" } ] },
        });
        let normalized = normalize_bundle(bundle).unwrap();
        let outbounds = normalized["outbounds"].as_array().unwrap();
        // selector untouched, proxy chained, protected appended.
        let proxy = outbounds
            .iter()
            .find(|o| o["tag"] == json!("proxy"))
            .unwrap();
        assert_eq!(
            proxy["streamSettings"]["sockopt"]["dialerProxy"],
            json!(PROTECTED_TAG)
        );
        let selector = outbounds
            .iter()
            .find(|o| o["tag"] == json!("selector"))
            .unwrap();
        assert!(selector.get("streamSettings").is_none());
        assert!(outbounds.iter().any(|o| o["tag"] == json!(PROTECTED_TAG)));
        // Routing and inbounds pass through untouched.
        assert_eq!(
            normalized["routing"]["rules"][0]["outboundTag"],
            json!("proxy")
        );
        assert_eq!(normalized["inbounds"][0]["tag"], json!("socks"));
    }

    #[test]
    fn normalize_bundle_is_idempotent_and_respects_existing_chain() {
        let bundle = json!({
            "outbounds": [
                { "tag": "a", "protocol": "trojan", "settings": {},
                  "sockopt": { "dialerProxy": "custom" } },
                { "tag": PROTECTED_TAG, "protocol": "socks", "settings": {} },
            ],
        });
        let normalized = normalize_bundle(bundle).unwrap();
        let outbounds = normalized["outbounds"].as_array().unwrap();
        assert_eq!(outbounds.len(), 2, "no duplicate protected outbound");
        let a = &outbounds[0];
        assert_eq!(
            a["streamSettings"]["sockopt"]["dialerProxy"],
            json!("custom")
        );
    }

    #[test]
    fn normalize_bundle_overwrites_empty_dialer_proxy() {
        // Provider panels (anivka) emit streamSettings.sockopt.dialerProxy
        // as an empty string — that is NOT a working chain; it dead-ended
        // every dial on-device (2026-08-22). It must be replaced.
        let bundle = json!({
            "outbounds": [
                { "tag": "proxy", "protocol": "vless", "settings": {},
                  "streamSettings": { "network": "tcp", "security": "reality",
                    "sockopt": { "dialerProxy": "" } } },
                { "tag": "direct", "protocol": "freedom", "settings": {} },
            ],
        });
        let normalized = normalize_bundle(bundle).unwrap();
        let proxy = normalized["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["tag"] == json!("proxy"))
            .unwrap();
        assert_eq!(
            proxy["streamSettings"]["sockopt"]["dialerProxy"],
            json!(PROTECTED_TAG),
            "empty dialerProxy must be replaced with the protected chain"
        );
    }

    #[test]
    fn normalize_bundle_rejects_non_object_and_empty_outbounds() {
        assert!(normalize_bundle(json!([])).is_err());
        assert!(normalize_bundle(json!({ "outbounds": [] })).is_err());
        assert!(normalize_bundle(json!({})).is_err());
    }

    #[test]
    fn test_config_maps_one_inbound_per_profile() {
        let outbounds = vec![vless_ws_tls(), trojan()];
        let spec = test_config(&outbounds).unwrap();
        assert_eq!(spec.entries.len(), 2);
        assert_eq!(spec.entries[0].port, TEST_BASE_PORT);
        assert_eq!(spec.entries[1].port, TEST_BASE_PORT + 1);
        let config = &spec.config;
        assert_eq!(config["inbounds"].as_array().unwrap().len(), 2);
        // Each inbound routes to its own outbound tag via inboundTag.
        let rules = config["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["inboundTag"][0], json!("test-in-0"));
        assert_eq!(rules[0]["outboundTag"], json!("p1"));
        assert_eq!(rules[1]["inboundTag"][0], json!("test-in-1"));
        assert_eq!(rules[1]["outboundTag"], json!("t1"));
        // No protected chain in the tester: the app package is
        // TUN-exempt, direct dials bypass an active tunnel already.
        let p1 = config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["tag"] == json!("p1"))
            .unwrap();
        assert!(
            p1.get("streamSettings").is_none() || p1["streamSettings"].get("sockopt").is_none()
        );
        // No share-link strings leak into the test config either.
        assert!(!config.to_string().contains("vless://"));
    }

    #[test]
    fn test_config_skips_unsupported_and_errors_when_empty() {
        let hy2 = Outbound::Hysteria2(crate::parser::Hy2Out {
            tag: "h".into(),
            server: "h.example".into(),
            port: 443,
            password: "x".into(),
            tls: TlsCfg::default(),
            obfs: None,
            up_mbps: None,
            down_mbps: None,
        });
        let spec = test_config(&[vless_ws_tls(), hy2.clone()]).unwrap();
        assert_eq!(spec.entries.len(), 1);
        assert_eq!(spec.entries[0].tag, "p1");
        assert!(test_config(&[hy2]).is_err());
    }

    fn trojan() -> Outbound {
        Outbound::Trojan(TrojanOut {
            tag: "t1".into(),
            server: "t.example".into(),
            port: 443,
            password: "pw".into(),
            transport: Transport::Tcp,
            tls: TlsCfg {
                enabled: true,
                server_name: Some("t.example".into()),
                ..TlsCfg::default()
            },
        })
    }

    #[test]
    fn link_config_has_no_share_link_strings() {
        let config = link_config(&[vless_ws_tls()]).unwrap();
        let text = config.to_string();
        assert!(!text.contains("vless://"));
        assert!(!text.contains("vmess://"));
        assert!(!text.contains("trojan://"));
        assert!(!text.contains("ss://"));
    }
}
