//! Inspect a raw subscription payload and decide what shape it is.
//!
//! For the Android v1.3.1 port we recognise all of:
//!   * `LinkList(ParseLinksResult)` — an array of sanitized `Outbound`s,
//!     ready to feed the mobile `useSubscriptions` or to render in the
//!     picker. Built from a URI list, a base64 blob, a Clash YAML
//!     body, a sing-box outbound JSON array, or a single sing-box
//!     outbound object.
//!   * `SingboxBundle(Vec<ClassifiedChild>)` /
//!     `XrayBundle(Vec<ClassifiedChild>)` — an array of full provider
//!     configs (each is itself a sing-box / xray object with its own
//!     `outbounds`, `route`/`routing`, `inbounds`, …). Stored as
//!     "children" on the subscription so the user can pick which one
//!     to start. The mobile engine path (Kotlin VpnService) is
//!     expected to consume these; that is a separate workstream.
//!
//! `classify_payload` is the entry point.

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
    let values = match value {
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

    let children = classified_children(values);
    match engine.expect("non-empty config values always produce an engine") {
        DetectedEngine::Singbox => Ok(ClassifiedPayload::SingboxBundle(children)),
        DetectedEngine::Xray => Ok(ClassifiedPayload::XrayBundle(children)),
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

fn classified_children(values: Vec<Value>) -> Vec<ClassifiedChild> {
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
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::Subscription("subscription link payload is not UTF-8".into()))?;
    let lines = split_link_lines(text)?;
    let mut outbounds = Vec::new();
    let mut failures = Vec::new();
    let mut placeholders = 0usize;
    for (index, line) in lines.into_iter().enumerate() {
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
