use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

pub const MANAGED_TUN_TAG: &str = "cloakwire-managed-tun";
pub const MANAGED_HTTP_TAG: &str = "cloakwire-managed-http";
pub const MANAGED_SOCKS_TAG: &str = "cloakwire-managed-socks";

#[derive(Debug, Clone, PartialEq)]
pub struct ManagedHttpInbound {
    pub value: Value,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub socks_port: u16,
    pub traffic_tag: String,
    pub injected: bool,
    pub tun_active: bool,
}

pub fn ensure_managed_http_inbound<F>(
    mut value: Value,
    mut port_allocator: F,
) -> AppResult<ManagedHttpInbound>
where
    F: FnMut() -> AppResult<u16>,
{
    let root = value
        .as_object_mut()
        .ok_or_else(|| AppError::UnsafeConfig("Xray provider config must be an object".into()))?;
    let inbounds = root
        .entry("inbounds")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| AppError::UnsafeConfig("Xray inbounds must be an array".into()))?;

    let mut candidates = Vec::new();
    let mut existing_socks = None;

    for (index, inbound) in inbounds.iter().enumerate() {
        let object = inbound
            .as_object()
            .ok_or_else(|| AppError::UnsafeConfig("Xray inbound must be an object".into()))?;
        let proto = object.get("protocol").and_then(Value::as_str);
        if proto == Some("socks") {
            if let Ok(p) = valid_port(object.get("port")) {
                existing_socks = Some(p);
            }
        }
        if object.get("tag").and_then(Value::as_str) == Some(MANAGED_HTTP_TAG) {
            return Err(AppError::UnsafeConfig(
                "provider uses reserved Xray inbound tag".into(),
            ));
        }
        if proto != Some("http") {
            continue;
        }
        let listen = object
            .get("listen")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::UnsafeConfig("Xray HTTP inbound has no listen address".into())
            })?;
        let port = valid_port(object.get("port"))?;
        if !is_loopback(listen) {
            return Err(AppError::UnsafeConfig(
                "Xray HTTP inbound must listen on loopback".into(),
            ));
        }
        let tag = object
            .get("tag")
            .and_then(Value::as_str)
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned);
        candidates.push((index, listen.to_string(), port, tag));
    }

    let socks_port = match existing_socks {
        Some(p) => p,
        None => {
            let p = port_allocator()?;
            inbounds.push(json!({
                "tag": MANAGED_SOCKS_TAG,
                "listen": "127.0.0.1",
                "port": p,
                "protocol": "socks",
                "settings": {
                    "auth": "noauth",
                    "udp": true
                },
                "sniffing": {
                    "enabled": true,
                    "destOverride": ["http", "tls", "quic"]
                }
            }));
            p
        }
    };

    match candidates.len() {
        0 => {
            let port = port_allocator()?;
            if port == 0 {
                return Err(AppError::UnsafeConfig(
                    "Xray managed HTTP inbound has an invalid port".into(),
                ));
            }
            inbounds.push(json!({
                "tag": MANAGED_HTTP_TAG,
                "listen": "127.0.0.1",
                "port": port,
                "protocol": "http",
                "settings": {}
            }));
            Ok(ManagedHttpInbound {
                value,
                proxy_host: "127.0.0.1".into(),
                proxy_port: port,
                socks_port,
                traffic_tag: MANAGED_HTTP_TAG.into(),
                injected: true,
                tun_active: false,
            })
        }
        1 => {
            let (index, proxy_host, proxy_port, tag) = candidates.pop().expect("one candidate");
            let traffic_tag = tag.unwrap_or_else(|| {
                let object = inbounds[index]
                    .as_object_mut()
                    .expect("validated Xray inbound object");
                object.insert("tag".into(), Value::String(MANAGED_HTTP_TAG.into()));
                MANAGED_HTTP_TAG.into()
            });
            Ok(ManagedHttpInbound {
                value,
                proxy_host,
                proxy_port,
                socks_port,
                traffic_tag,
                injected: false,
                tun_active: false,
            })
        }
        _ => Err(AppError::UnsafeConfig(
            "Xray provider has ambiguous HTTP inbounds".into(),
        )),
    }
}

pub fn ensure_managed_inbounds<F>(
    mut value: Value,
    tunnel_mode: crate::config::TunnelMode,
    port_allocator: F,
) -> AppResult<ManagedHttpInbound>
where
    F: FnMut() -> AppResult<u16>,
{
    let mut tun_active = false;
    let mut tun_tag = None;

    if matches!(
        tunnel_mode,
        crate::config::TunnelMode::Tun | crate::config::TunnelMode::Both
    ) {
        let root = value
            .as_object_mut()
            .ok_or_else(|| AppError::UnsafeConfig("Xray provider config must be an object".into()))?;
        let inbounds = root
            .entry("inbounds")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| AppError::UnsafeConfig("Xray inbounds must be an array".into()))?;

        let existing_tun_idx = inbounds.iter().position(|i| {
            i.as_object()
                .and_then(|obj| obj.get("protocol"))
                .and_then(Value::as_str)
                == Some("tun")
        });

        if let Some(idx) = existing_tun_idx {
            let existing = &mut inbounds[idx];
            let tag = existing
                .get("tag")
                .and_then(Value::as_str)
                .unwrap_or(MANAGED_TUN_TAG)
                .to_string();
            let settings = existing
                .as_object_mut()
                .map(|obj| obj.entry("settings").or_insert_with(|| json!({})))
                .and_then(Value::as_object_mut);
            if let Some(s) = settings {
                s.entry("name").or_insert_with(|| json!("wintun"));
                s.entry("mtu").or_insert_with(|| json!(1500));
                s.entry("gateway").or_insert_with(|| json!(["172.19.0.1/30"]));
                s.entry("dns").or_insert_with(|| json!(["1.1.1.1", "8.8.8.8"]));
                s.entry("autoSystemRoutingTable")
                    .or_insert_with(|| json!(["0.0.0.0/1", "128.0.0.0/1"]));
                s.entry("autoOutboundsInterface")
                    .or_insert_with(|| json!("auto"));
            }
            tun_tag = Some(tag);
            tun_active = true;
        } else {
            inbounds.insert(
                0,
                json!({
                    "tag": MANAGED_TUN_TAG,
                    "protocol": "tun",
                    "settings": {
                        "name": "wintun",
                        "mtu": 1500,
                        "gateway": ["172.19.0.1/30"],
                        "dns": ["1.1.1.1", "8.8.8.8"],
                        "autoSystemRoutingTable": ["0.0.0.0/1", "128.0.0.0/1"],
                        "autoOutboundsInterface": "auto"
                    },
                    "sniffing": {
                        "enabled": true,
                        "destOverride": ["http", "tls", "quic"]
                    }
                }),
            );
            tun_tag = Some(MANAGED_TUN_TAG.to_string());
            tun_active = true;
        }
    }

    let mut inbound = ensure_managed_http_inbound(value, port_allocator)?;
    inbound.tun_active = tun_active;
    if let Some(tag) = tun_tag {
        inbound.traffic_tag = tag;
    }
    Ok(inbound)
}

fn valid_port(value: Option<&Value>) -> AppResult<u16> {
    let port = value
        .and_then(Value::as_u64)
        .filter(|port| (1..=u16::MAX as u64).contains(port))
        .ok_or_else(|| AppError::UnsafeConfig("Xray HTTP inbound has an invalid port".into()))?;
    Ok(port as u16)
}

fn is_loopback(listen: &str) -> bool {
    matches!(listen, "127.0.0.1" | "::1" | "localhost")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ensure_managed_http_inbound, MANAGED_HTTP_TAG};

    #[test]
    fn preserves_existing_http_inbound_tag_for_stats() {
        let result = ensure_managed_http_inbound(
            json!({"inbounds":[{"tag":"provider-http","listen":"127.0.0.1","port":10809,"protocol":"http"}]}),
            || Ok(20809),
        )
        .unwrap();

        assert_eq!(result.traffic_tag, "provider-http");
        assert_eq!(result.value["inbounds"][0]["tag"], "provider-http");
    }

    #[test]
    fn assigns_reserved_tag_to_untagged_runtime_inbound() {
        let result = ensure_managed_http_inbound(
            json!({"inbounds":[{"listen":"127.0.0.1","port":10809,"protocol":"http"}]}),
            || Ok(20809),
        )
        .unwrap();

        assert_eq!(result.traffic_tag, MANAGED_HTTP_TAG);
        assert_eq!(result.value["inbounds"][0]["tag"], MANAGED_HTTP_TAG);
    }

    #[test]
    fn selects_unambiguous_loopback_http_inbound() {
        let config = json!({"inbounds":[{"tag":"local-http","listen":"127.0.0.1","port":10809,"protocol":"http"}]});

        let result = ensure_managed_http_inbound(config, || Ok(20809)).unwrap();

        assert_eq!(result.proxy_host, "127.0.0.1");
        assert_eq!(result.proxy_port, 10809);
        assert!(!result.injected);
    }

    #[test]
    fn injects_runtime_only_http_inbound_when_missing() {
        let result = ensure_managed_http_inbound(json!({"inbounds":[]}), || Ok(20809)).unwrap();

        assert_eq!(result.proxy_host, "127.0.0.1");
        assert_eq!(result.proxy_port, 20809);
        assert!(result.value["inbounds"].as_array().unwrap().iter().any(|i| i["tag"] == "cloakwire-managed-http"));
        assert!(result.value["inbounds"].as_array().unwrap().iter().any(|i| i["tag"] == "cloakwire-managed-socks"));
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_http_inbounds_and_reserved_tags() {
        for config in [
            json!({"inbounds":[{"tag":"public","listen":"0.0.0.0","port":10809,"protocol":"http"}]}),
            json!({"inbounds":[{"tag":"a","listen":"127.0.0.1","port":10809,"protocol":"http"},{"tag":"b","listen":"::1","port":10810,"protocol":"http"}]}),
            json!({"inbounds":[{"tag":"bad","listen":"127.0.0.1","port":0,"protocol":"http"}]}),
            json!({"inbounds":[{"tag":"cloakwire-managed-http","listen":"127.0.0.1","port":10809,"protocol":"socks"}]}),
        ] {
            assert!(ensure_managed_http_inbound(config, || Ok(20809)).is_err());
        }
    }

    #[test]
    fn injects_tun_inbound_in_tun_mode() {
        use super::{ensure_managed_inbounds, MANAGED_TUN_TAG};
        let result = ensure_managed_inbounds(
            json!({"inbounds":[]}),
            crate::config::TunnelMode::Tun,
            || Ok(20809),
        )
        .unwrap();

        assert!(result.tun_active);
        assert_eq!(result.traffic_tag, MANAGED_TUN_TAG);
        let tun = result.value["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["protocol"] == "tun")
            .expect("tun inbound present");
        assert_eq!(tun["tag"], MANAGED_TUN_TAG);
        assert_eq!(tun["settings"]["name"], "wintun");
        assert_eq!(tun["settings"]["mtu"], 1500);
        assert_eq!(tun["settings"]["gateway"], json!(["172.19.0.1/30"]));
        assert_eq!(tun["settings"]["dns"], json!(["1.1.1.1", "8.8.8.8"]));
        assert_eq!(
            tun["settings"]["autoSystemRoutingTable"],
            json!(["0.0.0.0/1", "128.0.0.0/1"])
        );
        assert_eq!(tun["settings"]["autoOutboundsInterface"], "auto");
    }

    #[test]
    fn does_not_inject_tun_inbound_in_system_proxy_mode() {
        use super::{ensure_managed_inbounds, MANAGED_HTTP_TAG};
        let result = ensure_managed_inbounds(
            json!({"inbounds":[]}),
            crate::config::TunnelMode::SystemProxy,
            || Ok(20809),
        )
        .unwrap();

        assert!(!result.tun_active);
        assert_eq!(result.traffic_tag, MANAGED_HTTP_TAG);
        assert!(!result.value["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["protocol"] == "tun"));
    }
}
