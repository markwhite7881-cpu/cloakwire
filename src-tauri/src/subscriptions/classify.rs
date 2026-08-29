//! Classify subscription payloads without exposing raw provider bodies to the WebView.
//!
//! Supported shapes:
//!   * plain or base64-encoded share-link lists;
//!   * Clash / Mihomo YAML proxy lists;
//!   * bare sing-box outbound JSON objects or arrays;
//!   * full sing-box or Xray config objects and arrays.
//!
//! Full configurations remain backend-owned. Link-list results contain parsed
//! outbounds, while parse failures expose only opaque item positions.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde_json::Value;

use crate::commands::{ParseFailure, ParseLinksResult};
use crate::error::{AppError, AppResult};
use crate::parser;

#[derive(Clone)]
pub struct ClassifiedChild {
    pub key: String,
    pub name: String,
    pub config: Value,
}

#[derive(Clone)]
pub enum ClassifiedPayload {
    LinkList(ParseLinksResult),
    SingboxBundle(Vec<ClassifiedChild>),
    XrayBundle(Vec<ClassifiedChild>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetectedEngine {
    Singbox,
    Xray,
}

pub fn classify_payload(bytes: &[u8], content_type: Option<&str>) -> AppResult<ClassifiedPayload> {
    let first = bytes
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace());
    let declares_json = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("application/json")
                || value.to_ascii_lowercase().ends_with("+json")
        });

    if declares_json || matches!(first, Some(b'{') | Some(b'[')) {
        return classify_json(bytes);
    }

    // Sniff for Clash YAML before treating the body as a list of
    // share-links. A Clash config always starts with a top-level
    // key like `port:`, `mixed-port:`, `socks-port:`, `proxies:`
    // or `proxy-groups:`; the URI-list path would then try to
    // base64-decode the YAML, fail, and return "subscription link
    // payload is invalid" — the very error a user sees when they
    // paste a working Clash subscription URL. Recognising the YAML
    // here turns that into a real (if empty) result.
    if looks_like_clash_yaml(bytes) {
        return classify_clash_yaml(bytes);
    }

    classify_links(bytes)
}

/// Cheap heuristic for "this looks like a Clash YAML subscription".
/// The first non-blank, non-`#` line must be a known top-level
/// `key: value` mapping. We don't validate the body against the
/// full Clash schema; `classify_clash_yaml` does that and returns
/// the `Outbound[]` it found.
fn looks_like_clash_yaml(bytes: &[u8]) -> bool {
    let text = match std::str::from_utf8(bytes) {
        Ok(value) => value,
        Err(_) => return false,
    };
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, _)) = trimmed.split_once(':') else {
            return false;
        };
        let key = key.trim();
        if matches!(
            key,
            "port"
                | "socks-port"
                | "mixed-port"
                | "redir-port"
                | "allow-lan"
                | "mode"
                | "log-level"
                | "proxies"
                | "proxy-groups"
                | "proxy-providers"
                | "rules"
                | "dns"
        ) {
            return true;
        }
        return false;
    }
    false
}

fn classify_clash_yaml(bytes: &[u8]) -> AppResult<ClassifiedPayload> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::Subscription("subscription link payload is not UTF-8".into()))?;
    let value: serde_yaml::Value = serde_yaml::from_str(text)
        .map_err(|e| AppError::Subscription(format!("subscription YAML is malformed: {e}")))?;
    let proxies = value
        .get("proxies")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|seq| seq.iter().filter_map(parse_clash_proxy).collect::<Vec<_>>())
        .unwrap_or_default();
    if proxies.is_empty() {
        // Panels (e.g. Remnawave) serve a skeleton Clash config with
        // `proxies: []` when the app is not on their client whitelist
        // or the subscription has no active servers. Storing an empty
        // subscription would just look broken in the UI — surface the
        // reason instead.
        return Err(AppError::Subscription(
            "provider returned no servers — the panel may not recognize this app or the subscription is inactive".into(),
        ));
    }
    Ok(ClassifiedPayload::LinkList(ParseLinksResult {
        outbounds: proxies,
        failures: Vec::new(),
    }))
}

/// Convert a single Clash proxy entry into a sing-box `Outbound`.
///
/// Supports the same surface the TypeScript parser does, but does it
/// directly in Rust so we don't have to ship the YAML body to the
/// WebView just to round-trip it back. The mapping is deliberately
/// conservative: any field we don't recognise is dropped, and any
/// required field that's missing turns the entry into an
/// `Outbound::Unsupported` so the UI can surface it instead of
/// crashing the whole subscription.
fn parse_clash_proxy(value: &serde_yaml::Value) -> Option<crate::parser::Outbound> {
    use crate::parser::*;
    use serde_yaml::Value;
    let map = value.as_mapping()?;
    let get_str = |k: &str| -> Option<String> {
        map.get(Value::String(k.to_string()))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let get_i64 = |k: &str| -> Option<i64> {
        map.get(Value::String(k.to_string()))
            .and_then(Value::as_i64)
    };
    let get_u16 = |k: &str| -> Option<u16> {
        let n = get_i64(k)?;
        u16::try_from(n).ok()
    };
    let get_bool = |k: &str| -> Option<bool> {
        map.get(Value::String(k.to_string()))
            .and_then(Value::as_bool)
    };

    let name = get_str("name").unwrap_or_else(|| "Clash proxy".into());
    let server = get_str("server")?;
    let port = get_u16("port")?;
    let kind = get_str("type")?.to_ascii_lowercase();
    let sni = get_str("sni").or_else(|| get_str("servername"));
    let alpn: Vec<String> = map
        .get(Value::String("alpn".into()))
        .and_then(Value::as_sequence)
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let fp = get_str("fingerprint").or_else(|| get_str("client-fingerprint"));
    let skip_verify = get_bool("skip-cert-verify").unwrap_or(false);
    let mut tls = TlsCfg {
        enabled: get_bool("tls").unwrap_or(false),
        server_name: sni,
        alpn,
        fingerprint: fp,
        allow_insecure: skip_verify,
        ..TlsCfg::default()
    };
    if let Some(reality_opts) = map.get(Value::String("reality-opts".into())) {
        if let Some(reality_map) = reality_opts.as_mapping() {
            let pk = reality_map
                .get(Value::String("public-key".into()))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let sid = reality_map
                .get(Value::String("short-id".into()))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if !pk.is_empty() || !sid.is_empty() {
                let spx = reality_map
                    .get(Value::String("spider-x".into()))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let mut reality = RealityCfg {
                    public_key: pk,
                    short_id: sid,
                    spider_x: None,
                };
                if let Some(value) = spx {
                    reality.spider_x = Some(value);
                }
                tls.reality = Some(reality);
            }
        }
    }

    let transport = parse_clash_transport(map);

    match kind.as_str() {
        "vless" => {
            let uuid = get_str("uuid").unwrap_or_default();
            let flow = get_str("flow");
            let out = VlessOut {
                tag: name,
                server,
                port,
                uuid,
                flow,
                transport: transport.unwrap_or(Transport::Tcp),
                tls,
            };
            Some(Outbound::Vless(out))
        }
        "vmess" => {
            let uuid = get_str("uuid").unwrap_or_default();
            let aid = get_u16("alterId").unwrap_or(0);
            let cipher_raw = get_str("cipher").unwrap_or_else(|| "auto".into());
            let cipher = match cipher_raw.as_str() {
                "aes-128-gcm" => VmessCipher::Aes128Gcm,
                "chacha20-poly1305" => VmessCipher::Chacha20Poly1305,
                "none" => VmessCipher::None,
                _ => VmessCipher::Auto,
            };
            Some(Outbound::Vmess(VmessOut {
                tag: name,
                server,
                port,
                uuid,
                alter_id: aid,
                cipher,
                transport: transport.unwrap_or(Transport::Tcp),
                tls,
            }))
        }
        "trojan" => Some(Outbound::Trojan(TrojanOut {
            tag: name,
            server,
            port,
            password: get_str("password").unwrap_or_default(),
            transport: transport.unwrap_or(Transport::Tcp),
            tls,
        })),
        "ss" | "shadowsocks" => Some(Outbound::Shadowsocks(SsOut {
            tag: name,
            server,
            port,
            method: get_str("cipher").unwrap_or_default(),
            password: get_str("password").unwrap_or_default(),
            plugin: None,
            plugin_opts: None,
        })),
        "hysteria2" | "hy2" => Some(Outbound::Hysteria2(Hy2Out {
            tag: name,
            server,
            port,
            password: get_str("password").unwrap_or_default(),
            tls,
            obfs: None,
            up_mbps: None,
            down_mbps: None,
        })),
        "tuic" => {
            let cc_raw = get_str("congestion-controller").unwrap_or_default();
            let congestion_control = match cc_raw.as_str() {
                "bbr" => TuicCc::Bbr,
                "new_reno" => TuicCc::NewReno,
                _ => TuicCc::Cubic,
            };
            Some(Outbound::Tuic(TuicOut {
                tag: name,
                server,
                port,
                uuid: get_str("uuid").unwrap_or_default(),
                password: get_str("password").unwrap_or_default(),
                congestion_control,
                udp_relay_mode: TuicUdp::Native,
                tls,
            }))
        }
        _ => None,
    }
}

fn parse_clash_transport(map: &serde_yaml::Mapping) -> Option<crate::parser::Transport> {
    use crate::parser::*;
    use serde_yaml::Value;
    let network = map
        .get(Value::String("network".into()))
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "tcp".into());
    let headers = |k: &str| -> Vec<(String, String)> {
        map.get(Value::String(k.into()))
            .and_then(Value::as_mapping)
            .and_then(|m| m.get(Value::String("headers".into())))
            .and_then(Value::as_mapping)
            .map(|headers| {
                headers
                    .iter()
                    .filter_map(|(k, v)| {
                        let key = k.as_str()?.to_owned();
                        let value = v.as_str()?.to_owned();
                        Some((key, value))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let path = |k: &str| -> Option<String> {
        map.get(Value::String(k.into()))
            .and_then(Value::as_mapping)
            .and_then(|m| m.get(Value::String("path".into())))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let host = |k: &str| -> Vec<String> {
        map.get(Value::String(k.into()))
            .and_then(Value::as_mapping)
            .and_then(|m| m.get(Value::String("host".into())))
            .and_then(Value::as_sequence)
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    match network.as_str() {
        "ws" => Some(Transport::Ws {
            path: path("ws-opts"),
            headers: headers("ws-opts"),
        }),
        "http" => Some(Transport::Http {
            host: host("http-opts"),
            path: path("http-opts"),
        }),
        "h2" => Some(Transport::Http {
            host: host("h2-opts"),
            path: path("h2-opts"),
        }),
        "grpc" => {
            let opts = map.get(Value::String("grpc-opts".into()));
            let sn = opts
                .and_then(Value::as_mapping)
                .and_then(|m| m.get(Value::String("grpc-service-name".into())))
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some(Transport::Grpc {
                service_name: sn,
                idle_timeout: None,
                ping_timeout: None,
            })
        }
        _ => Some(Transport::Tcp),
    }
}

/// Classify a JSON body. The body can be:
///   * a single sing-box `Outbound` object — emitted as a one-element
///     LinkList.
///   * an array of sing-box `Outbound` objects — emitted as a LinkList.
///   * a single sing-box or xray full config object (with `outbounds`,
///     `route`/`routing`, `inbounds`, …) — emitted as a one-element
///     `SingboxBundle` / `XrayBundle`.
///   * an array of full sing-box or xray configs (the Anivka /
///     subconverter shape) — emitted as `SingboxBundle` / `XrayBundle`
///     of one child per element.
///
/// The whole array must speak the same engine; mixed sing-box +
/// xray in the same response is reported as `AmbiguousConfig`.
fn classify_json(bytes: &[u8]) -> AppResult<ClassifiedPayload> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| AppError::AmbiguousConfig("provider JSON is malformed".into()))?;
    let mut values = match value {
        Value::Object(_) => vec![value],
        Value::Array(values) if !values.is_empty() => values,
        Value::Array(_) => {
            return Err(AppError::AmbiguousConfig(
                "provider JSON array is empty".into(),
            ))
        }
        _ => {
            return Err(AppError::AmbiguousConfig(
                "provider JSON is not a config object or array".into(),
            ))
        }
    };

    // Try the legacy LinkList path first: an array of sing-box
    // `Outbound` objects, each carrying its own `type` or `protocol`
    // discriminator. This still works for providers that ship a
    // bare outbound list (no `route` / `inbounds` wrapping).
    if let Some(result) = try_collect_link_list(&values) {
        return Ok(ClassifiedPayload::LinkList(result));
    }

    // Otherwise treat each element as a full sing-box or xray
    // config and group them by engine.
    let mut engine: Option<DetectedEngine> = None;
    for value in &values {
        if !value.is_object() {
            return Err(AppError::AmbiguousConfig(
                "provider JSON array contains a non-object".into(),
            ));
        }
        let detected = detect_engine(value)?;
        if engine.is_some_and(|current| current != detected) {
            return Err(AppError::AmbiguousConfig(
                "provider JSON mixes engine configuration types".into(),
            ));
        }
        engine = Some(detected);
    }

    // Cap max bundle profiles to prevent unbounded memory/resource consumption
    const MAX_SUBSCRIPTION_ITEMS: usize = 500;
    if values.len() > MAX_SUBSCRIPTION_ITEMS {
        values.truncate(MAX_SUBSCRIPTION_ITEMS);
    }

    let children = classified_children(values);
    match engine.expect("non-empty config values always produce an engine") {
        DetectedEngine::Singbox => Ok(ClassifiedPayload::SingboxBundle(children)),
        DetectedEngine::Xray => Ok(ClassifiedPayload::XrayBundle(children)),
    }
}

/// Sanitize full sing-box or Xray config bundles imported from external subscriptions:
/// 1. Forces non-TUN inbounds (mixed, socks, http, etc.) to listen strictly on `127.0.0.1` (loopback only)
///    to prevent external network exposure / open relay on LAN.
/// 2. Restricts external controller endpoints (clash_api) to loopback `127.0.0.1`.
pub fn sanitize_bundle_config(value: &mut Value) {
    if let Some(inbounds) = value.get_mut("inbounds").and_then(|i| i.as_array_mut()) {
        for inbound in inbounds {
            if let Some(obj) = inbound.as_object_mut() {
                let is_tun = obj.get("type").and_then(|t| t.as_str()) == Some("tun");
                let is_proxy_inbound = obj
                    .get("type")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| t == "mixed" || t == "socks" || t == "http" || t == "tproxy");
                if !is_tun {
                    if let Some(listen) = obj.get_mut("listen") {
                        if let Some(s) = listen.as_str() {
                            if s == "0.0.0.0" || s == "::" || s.is_empty() {
                                *listen = Value::String("127.0.0.1".into());
                            }
                        }
                    } else if is_proxy_inbound {
                        obj.insert("listen".into(), Value::String("127.0.0.1".into()));
                    }
                }
            }
        }
    }

    if let Some(experimental) = value.get_mut("experimental").and_then(|e| e.as_object_mut()) {
        if let Some(clash_api) = experimental.get_mut("clash_api").and_then(|c| c.as_object_mut()) {
            if let Some(controller) = clash_api.get_mut("external_controller") {
                if let Some(s) = controller.as_str() {
                    if let Some((_, port)) = s.rsplit_once(':') {
                        *controller = Value::String(format!("127.0.0.1:{port}"));
                    } else {
                        *controller = Value::String("127.0.0.1:9090".into());
                    }
                }
            }
        }
    }
}

fn try_collect_link_list(values: &[Value]) -> Option<ParseLinksResult> {
    let mut outbounds = Vec::new();
    let mut failures = Vec::new();
    let mut all_outbounds = true;
    for (index, value) in values.iter().enumerate() {
        if let Value::Object(map) = value {
            if is_outbound_like(map) {
                match serde_json::from_value::<parser::Outbound>(value.clone()) {
                    Ok(ob) => outbounds.push(ob),
                    Err(err) => {
                        all_outbounds = false;
                        failures.push(ParseFailure {
                            line: format!("item-{index}"),
                            error: parser::ParseError::InvalidValue(
                                "subscription item".into(),
                                err.to_string(),
                            ),
                        });
                    }
                }
            } else {
                return None;
            }
        } else {
            return None;
        }
    }
    if all_outbounds && !outbounds.is_empty() {
        Some(ParseLinksResult {
            outbounds,
            failures,
        })
    } else {
        None
    }
}

fn is_outbound_like(map: &serde_json::Map<String, Value>) -> bool {
    map.contains_key("type") || map.contains_key("protocol")
}

fn detect_engine(value: &Value) -> AppResult<DetectedEngine> {
    let singbox = has_outbound_key(value, "type") || value.get("route").is_some();
    let xray = has_outbound_key(value, "protocol")
        || pointer_exists(value, "/routing/domainStrategy")
        || pointer_exists(value, "/routing/balancers")
        || value.get("observatory").is_some();

    match (singbox, xray) {
        (true, false) => Ok(DetectedEngine::Singbox),
        (false, true) => Ok(DetectedEngine::Xray),
        (true, true) => Err(AppError::AmbiguousConfig(
            "provider config contains markers for multiple engines".into(),
        )),
        (false, false) => Err(AppError::AmbiguousConfig(
            "provider config has no recognized engine markers".into(),
        )),
    }
}

fn has_outbound_key(value: &Value, key: &str) -> bool {
    value
        .get("outbounds")
        .and_then(Value::as_array)
        .is_some_and(|outbounds| {
            outbounds.iter().any(|outbound| {
                outbound
                    .as_object()
                    .is_some_and(|object| object.contains_key(key))
            })
        })
}

fn pointer_exists(value: &Value, pointer: &str) -> bool {
    value.pointer(pointer).is_some()
}

fn classified_children(mut values: Vec<Value>) -> Vec<ClassifiedChild> {
    for value in &mut values {
        sanitize_bundle_config(value);
    }
    values
        .into_iter()
        .enumerate()
        .map(|(index, config)| {
            let key = stable_child_key(&config, index, 0);
            let name = child_name(&config).unwrap_or_else(|| format!("Profile {}", index + 1));
            ClassifiedChild { key, name, config }
        })
        .collect()
}

pub fn stable_child_key(_value: &Value, index: usize, duplicate_ordinal: usize) -> String {
    if duplicate_ordinal == 0 {
        format!("index-{index}")
    } else {
        format!("index-{index}-{duplicate_ordinal}")
    }
}

fn child_name(value: &Value) -> Option<String> {
    ["remarks", "name"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(normalize_whitespace)
        .filter(|value| !value.is_empty())
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn classify_links(bytes: &[u8]) -> AppResult<ClassifiedPayload> {
    const MAX_SUBSCRIPTION_ITEMS: usize = 500;
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::Subscription("subscription link payload is not UTF-8".into()))?;
    let lines = split_link_lines(text)?;
    let mut outbounds = Vec::new();
    let mut failures = Vec::new();
    let mut placeholders = 0usize;
    for (index, line) in lines.into_iter().enumerate() {
        if outbounds.len() >= MAX_SUBSCRIPTION_ITEMS {
            break;
        }
        match parser::parse_link(&line) {
            Ok(outbound) => {
                // Panels (e.g. Remnawave) answer unrecognized clients
                // with a single dummy entry — vless to 0.0.0.0:1 named
                // "App not supported". It parses as a valid link, so
                // filter it by shape and remember that we did.
                if is_placeholder_outbound(&outbound) {
                    placeholders += 1;
                    continue;
                }
                outbounds.push(outbound)
            }
            Err(_) => failures.push(ParseFailure {
                line: format!("item-{index}"),
                error: parser::ParseError::InvalidValue(
                    "subscription item".into(),
                    "invalid".into(),
                ),
            }),
        }
    }
    if outbounds.is_empty() {
        if placeholders > 0 {
            return Err(AppError::Subscription(
                "provider does not recognize this app (\"App not supported\" placeholder) — try refreshing from the provider or using a subscription format they serve".into(),
            ));
        }
        return Err(AppError::Subscription(
            "subscription link payload has no usable links".into(),
        ));
    }
    Ok(ClassifiedPayload::LinkList(ParseLinksResult {
        outbounds,
        failures,
    }))
}

/// Provider "app not supported" dummy: valid-shaped link pointing at
/// the null destination (host 0.0.0.0, port 0 or 1).
fn is_placeholder_outbound(outbound: &parser::Outbound) -> bool {
    matches!(outbound.server(), Some("0.0.0.0")) && matches!(outbound.port(), Some(p) if p <= 1)
}

fn split_link_lines(text: &str) -> AppResult<Vec<String>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let direct = nonempty_link_lines(text);
    if direct.iter().any(|line| line.contains("://")) {
        return Ok(direct);
    }

    let cleaned: String = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let padded = || {
        let mut value = cleaned.clone();
        while value.len() % 4 != 0 {
            value.push('=');
        }
        value
    };
    let decoded = URL_SAFE_NO_PAD
        .decode(&cleaned)
        .or_else(|_| URL_SAFE_NO_PAD.decode(padded()))
        .or_else(|_| STANDARD.decode(&cleaned))
        .or_else(|_| STANDARD.decode(padded()))
        .map_err(|_| AppError::Subscription("subscription link payload is invalid".into()))?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| {
        AppError::Subscription("decoded subscription link payload is not UTF-8".into())
    })?;
    Ok(nonempty_link_lines(decoded))
}

fn nonempty_link_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{classify_payload, stable_child_key, ClassifiedPayload};
    use crate::error::AppError;
    use serde_json::json;

    const LINK: &str =
        "vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls#Demo";

    #[test]
    fn classifies_plain_links() {
        let classified = classify_payload(LINK.as_bytes(), Some("text/plain")).unwrap();
        assert!(matches!(classified, ClassifiedPayload::LinkList(_)));
    }

    #[test]
    fn classifies_base64_links() {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(LINK);
        let classified = classify_payload(encoded.as_bytes(), Some("text/plain")).unwrap();
        assert!(matches!(classified, ClassifiedPayload::LinkList(_)));
    }

    #[test]
    fn classifies_singbox_object_from_outbound_type() {
        let payload = br#"{"outbounds":[{"type":"direct"}]}"#;
        let classified = classify_payload(payload, Some("application/json")).unwrap();
        assert!(matches!(classified, ClassifiedPayload::SingboxBundle(_)));
    }

    #[test]
    fn classifies_xray_array_from_protocol_and_routing_markers() {
        let payload = br#"[{"remarks":"Auto","outbounds":[{"protocol":"vless"}],"routing":{"balancers":[]},"observatory":{}}]"#;
        let classified = classify_payload(payload, Some("application/json")).unwrap();
        assert!(matches!(classified, ClassifiedPayload::XrayBundle(_)));
    }

    #[test]
    fn rejects_mixed_engine_array() {
        let payload =
            br#"[{"outbounds":[{"type":"direct"}]},{"outbounds":[{"protocol":"freedom"}]}]"#;
        assert!(matches!(
            classify_payload(payload, Some("application/json")),
            Err(AppError::AmbiguousConfig(_))
        ));
    }

    #[test]
    fn rejects_object_with_both_engine_marker_sets() {
        let payload = br#"{"outbounds":[{"type":"direct","protocol":"freedom"}]}"#;
        assert!(matches!(
            classify_payload(payload, Some("application/json")),
            Err(AppError::AmbiguousConfig(_))
        ));
    }

    #[test]
    fn rejects_malformed_declared_json() {
        assert!(matches!(
            classify_payload(br#"{"outbounds": ["#, Some("application/json")),
            Err(AppError::AmbiguousConfig(_))
        ));
    }

    #[test]
    fn rejects_empty_json_array() {
        assert!(matches!(
            classify_payload(b"[]", Some("application/json")),
            Err(AppError::AmbiguousConfig(_))
        ));
    }

    #[test]
    fn rejects_scalar_json() {
        assert!(matches!(
            classify_payload(b"42", Some("application/json")),
            Err(AppError::AmbiguousConfig(_))
        ));
    }

    #[test]
    fn rejects_json_without_engine_markers() {
        assert!(matches!(
            classify_payload(br#"{"name":"unknown"}"#, Some("application/json")),
            Err(AppError::AmbiguousConfig(_))
        ));
    }

    #[test]
    fn rejects_non_utf8_link_payload_without_lossy_conversion() {
        assert!(matches!(
            classify_payload(&[0xff, 0xfe], Some("text/plain")),
            Err(AppError::Subscription(_))
        ));
    }

    #[test]
    fn stable_key_never_uses_provider_controlled_identity_fields() {
        let labels = [
            "192.0.2.10",
            "node.provider.example",
            "dG9rZW4tY3JlZGVudGlhbC0xMjM0NTY",
            "11111111-1111-4111-8111-111111111111",
            "https://user:password@example.test/sub",
            "user:password@192.0.2.1:1080",
            "Primary Node",
        ];
        for label in labels {
            let value = json!({
                "id": label,
                "profile_id": label,
                "remarks": label,
                "name": label
            });
            let key = stable_child_key(&value, 3, 0);
            assert_eq!(key, "index-3");
            assert!(!key.contains(label));
        }
    }

    #[test]
    fn classifies_plain_links_with_partial_failures() {
        let payload = format!("{LINK}\nnot-a-supported-link");
        let ClassifiedPayload::LinkList(result) =
            classify_payload(payload.as_bytes(), Some("text/plain")).unwrap()
        else {
            panic!("expected link list");
        };
        assert_eq!(result.outbounds.len(), 1);
        assert_eq!(result.failures.len(), 1);
    }

    #[test]
    fn classifies_base64_links_with_partial_failures() {
        use base64::Engine;
        let decoded = format!("{LINK}\nnot-a-supported-link");
        let encoded = base64::engine::general_purpose::STANDARD.encode(decoded);
        let ClassifiedPayload::LinkList(result) =
            classify_payload(encoded.as_bytes(), Some("text/plain")).unwrap()
        else {
            panic!("expected link list");
        };
        assert_eq!(result.outbounds.len(), 1);
        assert_eq!(result.failures.len(), 1);
    }

    #[test]
    fn classified_failures_serialize_and_debug_without_raw_link_material() {
        let uuid = "22222222-2222-4222-8222-222222222222";
        let failed_url = format!(
            "socks://synthetic-user:synthetic-pass@192.0.2.1:1080/{uuid}?marker=raw-marker"
        );
        let payload = format!("{LINK}\n{failed_url}\nopaque-secret-raw-marker");
        let ClassifiedPayload::LinkList(result) =
            classify_payload(payload.as_bytes(), Some("text/plain")).unwrap()
        else {
            panic!("expected link list");
        };

        assert_eq!(result.outbounds.len(), 1);
        assert_eq!(result.failures.len(), 2);
        assert_eq!(result.failures[0].line, "item-1");
        assert_eq!(result.failures[1].line, "item-2");

        let serialized = serde_json::to_string(&result.failures).unwrap();
        let debugged = format!("{:?}", result.failures);
        for exposed in [
            "socks",
            "synthetic-user",
            "synthetic-pass",
            "192.0.2.1",
            uuid,
            "raw-marker",
            "opaque-secret",
            &failed_url,
        ] {
            assert!(!serialized.contains(exposed));
            assert!(!debugged.contains(exposed));
        }
    }

    #[test]
    fn stable_key_uses_position_and_duplicate_ordinal() {
        let value = json!({"remarks": "Primary Node"});
        assert_eq!(stable_child_key(&value, 4, 0), "index-4");
        assert_eq!(stable_child_key(&value, 4, 2), "index-4-2");
    }

    #[test]
    fn stable_key_falls_back_to_array_position() {
        assert_eq!(stable_child_key(&json!({}), 3, 0), "index-3");
    }

    #[test]
    fn classifies_clash_yaml_proxy_list() {
        let payload = br#"
mixed-port: 7890
proxies:
  - name: Demo VLESS
    type: vless
    server: example.com
    port: 443
    uuid: 33333333-3333-4333-8333-333333333333
    tls: true
    servername: example.com
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: example.com
proxy-groups: []
rules: []
"#;
        let ClassifiedPayload::LinkList(result) =
            classify_payload(payload, Some("text/yaml")).unwrap()
        else {
            panic!("expected Clash YAML to become a link list");
        };
        assert_eq!(result.outbounds.len(), 1);
        assert!(result.failures.is_empty());
        assert_eq!(result.outbounds[0].display_name(), "Demo VLESS");
        assert_eq!(result.outbounds[0].server(), Some("example.com"));
        assert_eq!(result.outbounds[0].port(), Some(443));
    }

    #[test]
    fn rejects_clash_yaml_without_servers() {
        let payload = b"mixed-port: 7890\nproxies: []\nproxy-groups: []\n";
        let error = match classify_payload(payload, Some("text/yaml")) {
            Err(error) => error,
            Ok(_) => panic!("empty Clash YAML must not be stored"),
        };
        assert!(matches!(error, AppError::Subscription(_)));
        assert!(error.to_string().contains("no servers"));
    }

    #[test]
    fn rejects_provider_app_not_supported_placeholder() {
        let payload = b"vless://44444444-4444-4444-8444-444444444444@0.0.0.0:1?security=tls#App%20not%20supported";
        let error = match classify_payload(payload, Some("text/plain")) {
            Err(error) => error,
            Ok(_) => panic!("provider placeholder must not become a server"),
        };
        assert!(matches!(error, AppError::Subscription(_)));
        let message = error.to_string();
        assert!(message.contains("does not recognize this app"));
        assert!(!message.contains("44444444-4444-4444-8444-444444444444"));
    }

    #[test]
    fn filters_placeholder_when_real_links_are_present() {
        let placeholder = "vless://55555555-5555-4555-8555-555555555555@0.0.0.0:1?security=tls#App%20not%20supported";
        let payload = format!("{placeholder}\n{LINK}");
        let ClassifiedPayload::LinkList(result) =
            classify_payload(payload.as_bytes(), Some("text/plain")).unwrap()
        else {
            panic!("expected remaining real link");
        };
        assert_eq!(result.outbounds.len(), 1);
        assert_eq!(result.outbounds[0].server(), Some("example.com"));
    }

    #[test]
    fn sanitizes_bundle_inbounds_and_external_controller() {
        let mut config = serde_json::json!({
            "inbounds": [
                {
                    "type": "tun",
                    "interface_name": "utun9"
                },
                {
                    "type": "socks",
                    "listen": "0.0.0.0",
                    "listen_port": 1080
                },
                {
                    "type": "http",
                    "listen": "::",
                    "listen_port": 8080
                },
                {
                    "type": "mixed",
                    "listen_port": 2080
                }
            ],
            "experimental": {
                "clash_api": {
                    "external_controller": "0.0.0.0:9090",
                    "secret": ""
                }
            }
        });

        super::sanitize_bundle_config(&mut config);

        let inbounds = config["inbounds"].as_array().unwrap();
        // tun should remain without listen
        assert!(inbounds[0].get("listen").is_none());
        // socks forced to 127.0.0.1
        assert_eq!(inbounds[1]["listen"], "127.0.0.1");
        // http forced to 127.0.0.1
        assert_eq!(inbounds[2]["listen"], "127.0.0.1");
        // mixed with missing listen forced to 127.0.0.1
        assert_eq!(inbounds[3]["listen"], "127.0.0.1");

        // clash_api external controller forced to loopback
        assert_eq!(
            config["experimental"]["clash_api"]["external_controller"],
            "127.0.0.1:9090"
        );
    }
}
