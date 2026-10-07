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
                    "type": "tcp",
                    "tag": "dns-remote",
                    "server": "1.1.1.1",
                    "detour": "socks-out"
                },
                {
                    "type": "local",
                    "tag": "dns-direct",
                    "detour": "direct"
                }
            ],
            "final": "dns-remote",
            "strategy": "ipv4_only"
        },
        "inbounds": [
            {
                "type": "tun",
                "tag": "tun-in",
                "interface_name": "singbox-tun",
                "address": [
                    "172.19.0.1/30"
                ],
                "auto_route": true,
                "strict_route": true,
                "stack": "gvisor",
                "mtu": 9000,
                "endpoint_independent_nat": false,
                "udp_timeout": "5m"
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
            "default_domain_resolver": "dns-direct",
            "find_process": true,
            "rules": [
                {
                    "action": "route",
                    "process_name": [
                        "xray-x86_64-pc-windows-msvc.exe",
                        "xray.exe",
                        "xray-aarch64-apple-darwin",
                        "xray-x86_64-apple-darwin",
                        "xray"
                    ],
                    "outbound": "direct"
                },
                {
                    "action": "hijack-dns",
                    "port": [53]
                },
                {
                    "action": "route",
                    "ip_is_private": true,
                    "outbound": "direct"
                },
                {
                    "action": "sniff"
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
        assert_eq!(config["dns"]["servers"][0]["type"], "tcp");
        assert_eq!(config["dns"]["servers"][0]["server"], "1.1.1.1");
        assert_eq!(config["dns"]["servers"][0]["detour"], "socks-out");
        assert_eq!(config["dns"]["servers"][1]["type"], "local");
        assert_eq!(config["dns"]["servers"][1]["detour"], "direct");
        assert_eq!(config["dns"]["final"], "dns-remote");
        assert_eq!(config["dns"]["strategy"], "ipv4_only");

        let inbounds = config["inbounds"].as_array().expect("inbounds array");
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["type"], "tun");
        assert_eq!(inbounds[0]["interface_name"], "singbox-tun");
        assert_eq!(inbounds[0]["address"][0], "172.19.0.1/30");
        assert_eq!(inbounds[0]["auto_route"], true);
        assert_eq!(inbounds[0]["strict_route"], true);
        assert_eq!(inbounds[0]["stack"], "gvisor");
        assert_eq!(inbounds[0]["mtu"], 9000);

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
        assert_eq!(route["default_domain_resolver"], "dns-direct");
        assert_eq!(route["find_process"], true);
        assert_eq!(route["rules"][0]["action"], "route");
        assert_eq!(route["rules"][0]["outbound"], "direct");
        assert_eq!(route["rules"][0]["process_name"][0], "xray-x86_64-pc-windows-msvc.exe");
        assert_eq!(route["rules"][1]["action"], "hijack-dns");
        assert_eq!(route["rules"][1]["port"][0], 53);
        assert_eq!(route["rules"][2]["action"], "route");
        assert_eq!(route["rules"][2]["ip_is_private"], true);
        assert_eq!(route["rules"][2]["outbound"], "direct");
        assert_eq!(route["rules"][3]["action"], "sniff");
        assert_eq!(route["final"], "socks-out");
    }

    #[test]
    fn test_aux_tun_config_passes_bundled_singbox_check() {
        let config = build_aux_tun_config(20808);
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
        let bin_path = std::path::Path::new(&manifest_dir)
            .join("binaries")
            .join("sing-box-x86_64-pc-windows-msvc.exe");
        if !bin_path.exists() {
            return;
        }
        let temp_dir = std::env::temp_dir();
        let config_file = temp_dir.join(format!("test-aux-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&config_file, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
        let output = std::process::Command::new(&bin_path)
            .args(["check", "-c", config_file.to_str().unwrap()])
            .output()
            .expect("runs sing-box check");
        let _ = std::fs::remove_file(config_file);
        assert!(
            output.status.success(),
            "sing-box check failed: stdout={}, stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
