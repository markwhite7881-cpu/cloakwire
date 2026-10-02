use serde_json::{json, Value};

/// Build a minimal Sing-box configuration that acts as an auxiliary TUN forwarder
/// capturing all Windows system traffic and detouring it to Xray's local loopback SOCKS port.
pub fn build_aux_tun_config(socks_port: u16) -> Value {
    json!({
        "log": {
            "level": "info"
        },
        "dns": {
            "servers": [
                {
                    "tag": "dns-remote",
                    "address": "1.1.1.1",
                    "detour": "socks-out"
                },
                {
                    "tag": "dns-direct",
                    "address": "local",
                    "detour": "direct"
                }
            ],
            "rules": [
                {
                    "outbound": "any",
                    "server": "dns-direct"
                }
            ],
            "strategy": "ipv4_only"
        },
        "inbounds": [
            {
                "type": "tun",
                "tag": "tun-in",
                "interface_name": "singbox-tun",
                "inet4_address": "172.19.0.1/30",
                "auto_route": true,
                "strict_route": true,
                "stack": "gvisor",
                "sniff": true
            }
        ],
        "outbounds": [
            {
                "type": "socks",
                "tag": "socks-out",
                "server": "127.0.0.1",
                "server_port": socks_port
            },
            {
                "type": "direct",
                "tag": "direct"
            }
        ],
        "route": {
            "auto_detect_interface": true,
            "rules": [
                {
                    "port": 53,
                    "outbound": "socks-out"
                },
                {
                    "ip_is_private": true,
                    "outbound": "direct"
                }
            ],
            "final": "socks-out"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_aux_tun_config_structure() {
        let config = build_aux_tun_config(20808);
        assert_eq!(config["log"]["level"], "info");
        assert_eq!(config["dns"]["servers"][0]["detour"], "socks-out");

        let inbounds = config["inbounds"].as_array().expect("inbounds array");
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["type"], "tun");
        assert_eq!(inbounds[0]["interface_name"], "singbox-tun");
        assert_eq!(inbounds[0]["inet4_address"], "172.19.0.1/30");
        assert_eq!(inbounds[0]["auto_route"], true);
        assert_eq!(inbounds[0]["strict_route"], true);
        assert_eq!(inbounds[0]["stack"], "gvisor");
        assert_eq!(config["inbounds"][0]["sniff"], true);

        let outbounds = config["outbounds"].as_array().expect("outbounds array");
        assert_eq!(outbounds.len(), 2);
        assert_eq!(outbounds[0]["type"], "socks");
        assert_eq!(outbounds[0]["tag"], "socks-out");
        assert_eq!(outbounds[0]["server"], "127.0.0.1");
        assert_eq!(outbounds[0]["server_port"], 20808);
        assert_eq!(outbounds[1]["type"], "direct");
        assert_eq!(outbounds[1]["tag"], "direct");

        let route = &config["route"];
        assert_eq!(route["auto_detect_interface"], true);
        assert_eq!(config["route"]["rules"][0]["port"], 53);
        assert_eq!(route["final"], "socks-out");
    }
}
