//! Windows Wintun interface & routing table management for Xray TUN mode.
//!
//! Unlike sing-box which embeds an internal auto-router calling Windows IP Helper APIs,
//! Xray-core is purely a packet processor on Wintun. On Windows, Cloakwire manages:
//! 1. Interface IP (`172.19.0.2/30`) and Gateway (`172.19.0.1`) on the Wintun adapter.
//! 2. Static DNS (`1.1.1.1` and `8.8.8.8`) on the Wintun adapter.
//! 3. Host bypass routes (`/32`) to the remote proxy server(s) via the physical default gateway.
//! 4. Split default routes (`0.0.0.0/1` and `128.0.0.0/1`) via `172.19.0.1`.
//! 5. Clean teardown and route removal upon disconnect or unexpected process termination.

use std::net::Ipv4Addr;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteRecord {
    pub destination: String,
    pub mask: String,
    pub gateway: String,
    pub if_index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultGateway {
    pub gateway_ip: Ipv4Addr,
    pub if_index: Option<u32>,
}

/// Check if an Xray config has a managed TUN inbound.
pub fn has_tun_inbound(config: &Value) -> bool {
    config
        .get("inbounds")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .any(|i| i.get("protocol").and_then(Value::as_str) == Some("tun"))
        })
        .unwrap_or(false)
}

/// Extract all server hostnames or IP addresses from Xray outbounds.
pub fn extract_xray_server_hosts(config: &Value) -> Vec<String> {
    let mut hosts = Vec::new();
    if let Some(outbounds) = config.get("outbounds").and_then(Value::as_array) {
        for outbound in outbounds {
            extract_hosts_from_outbound(outbound, &mut hosts);
        }
    }
    hosts.sort();
    hosts.dedup();
    hosts
}

fn extract_hosts_from_outbound(outbound: &Value, hosts: &mut Vec<String>) {
    if let Some(nested) = outbound.get("outbounds").and_then(Value::as_array) {
        for inner in nested {
            extract_hosts_from_outbound(inner, hosts);
        }
    }
    let protocol = outbound.get("protocol").and_then(Value::as_str).unwrap_or("");
    if !matches!(protocol, "vless" | "vmess" | "trojan" | "shadowsocks" | "socks") {
        return;
    }
    let settings = match outbound.get("settings") {
        Some(s) => s,
        None => return,
    };
    if let Some(vnext) = settings.get("vnext").and_then(Value::as_array) {
        for item in vnext {
            if let Some(addr) = item.get("address").and_then(Value::as_str) {
                let trimmed = addr.trim();
                if !trimmed.is_empty() {
                    hosts.push(trimmed.to_string());
                }
            }
        }
    }
    if let Some(servers) = settings.get("servers").and_then(Value::as_array) {
        for item in servers {
            if let Some(addr) = item
                .get("address")
                .or_else(|| item.get("server"))
                .and_then(Value::as_str)
            {
                let trimmed = addr.trim();
                if !trimmed.is_empty() {
                    hosts.push(trimmed.to_string());
                }
            }
        }
    }
}

/// Resolve a list of hostnames or IP strings into unique IPv4 addresses.
/// Excludes loopback addresses (127.0.0.1, etc.).
pub fn resolve_server_ips(hosts: &[String]) -> Vec<Ipv4Addr> {
    use std::net::ToSocketAddrs;
    let mut ips = Vec::new();
    for host in hosts {
        if let Ok(ip) = host.parse::<Ipv4Addr>() {
            if !ip.is_loopback() {
                ips.push(ip);
            }
            continue;
        }
        if let Ok(iter) = (host.as_str(), 80).to_socket_addrs() {
            for addr in iter {
                if let std::net::SocketAddr::V4(v4) = addr {
                    let ip = *v4.ip();
                    if !ip.is_loopback() {
                        ips.push(ip);
                    }
                }
            }
        }
    }
    ips.sort();
    ips.dedup();
    ips
}

/// Extract all upstream DNS server IPv4 addresses from Xray config.
/// Falls back to 1.1.1.1 and 8.8.8.8 if none found.
pub fn extract_xray_dns_ips(config: &Value) -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    if let Some(servers) = config.get("dns").and_then(|d| d.get("servers")).and_then(Value::as_array) {
        for server in servers {
            let addr_str = if let Some(s) = server.as_str() {
                s
            } else if let Some(addr) = server.get("address").and_then(Value::as_str) {
                addr
            } else {
                continue;
            };
            let cleaned = addr_str
                .strip_prefix("tcp://")
                .or_else(|| addr_str.strip_prefix("udp://"))
                .unwrap_or(addr_str);
            let ip_only = cleaned.split(':').next().unwrap_or(cleaned);
            if let Ok(ip) = ip_only.parse::<Ipv4Addr>() {
                if !ip.is_loopback() && !ip.is_unspecified() {
                    ips.push(ip);
                }
            }
        }
    }
    if ips.is_empty() {
        ips.push("1.1.1.1".parse().unwrap());
        ips.push("8.8.8.8".parse().unwrap());
    }
    ips.sort();
    ips.dedup();
    ips
}

/// Parse default gateway and interface index from PowerShell output: "192.168.1.254 9"
pub fn parse_gateway_output(output: &str) -> Option<DefaultGateway> {
    let mut tokens = output.split_whitespace();
    let gw_str = tokens.next()?;
    let gw_ip = gw_str.parse::<Ipv4Addr>().ok()?;
    if gw_ip.is_unspecified() || gw_ip.is_loopback() || gw_str.starts_with("172.19.") {
        return None;
    }
    let if_index = tokens.next().and_then(|s| s.parse::<u32>().ok());
    Some(DefaultGateway {
        gateway_ip: gw_ip,
        if_index,
    })
}

/// Parse interface index from `netsh interface ipv4 show interface <name>` output.
pub fn parse_if_index(output: &str) -> Option<u32> {
    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("ifindex") {
            if let Some(idx_str) = line.split(':').nth(1) {
                if let Ok(idx) = idx_str.trim().parse::<u32>() {
                    return Some(idx);
                }
            }
        }
    }
    None
}

/// Parse route print 0.0.0.0 output as a fallback
pub fn parse_route_print_fallback(output: &str) -> Option<DefaultGateway> {
    let mut best: Option<(Ipv4Addr, u32)> = None;
    for line in output.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() >= 5 && tokens[0] == "0.0.0.0" && tokens[1] == "0.0.0.0" {
            if let Ok(gw) = tokens[2].parse::<Ipv4Addr>() {
                if !gw.is_unspecified() && !gw.is_loopback() && !tokens[2].starts_with("172.19.") {
                    let metric = tokens[4].parse::<u32>().unwrap_or(9999);
                    match &best {
                        Some((_, best_metric)) if *best_metric <= metric => {}
                        _ => best = Some((gw, metric)),
                    }
                }
            }
        }
    }
    best.map(|(gateway_ip, _)| DefaultGateway {
        gateway_ip,
        if_index: None,
    })
}

/// Discover the physical default gateway and interface index.
pub fn find_physical_default_gateway() -> Option<DefaultGateway> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // Try PowerShell Get-NetRoute first
        let ps_cmd = "$r = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Where-Object { $_.NextHop -ne '0.0.0.0' -and $_.NextHop -notlike '172.19.*' -and $_.InterfaceAlias -notmatch '(?i)(tun|tap|wintun|singbox)' } | Sort-Object RouteMetric | Select-Object -First 1); if ($r) { Write-Output ($r.NextHop + ' ' + $r.InterfaceIndex) }";
        if let Ok(output) = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", ps_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(gw) = parse_gateway_output(&text) {
                    return Some(gw);
                }
            }
        }

        // Fallback: route print 0.0.0.0
        if let Ok(output) = std::process::Command::new("route")
            .args(["print", "0.0.0.0"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(gw) = parse_route_print_fallback(&text) {
                    return Some(gw);
                }
            }
        }
    }
    None
}

/// Setup Wintun interface and routes on Windows for an active Xray TUN run.
pub async fn setup_xray_windows_tun(
    config_path: &Path,
) -> Result<Vec<RouteRecord>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let content = tokio::fs::read_to_string(config_path)
            .await
            .map_err(|e| format!("failed to read runtime config: {e}"))?;
        let config: Value = serde_json::from_str(&content)
            .map_err(|e| format!("failed to parse runtime config: {e}"))?;

        if !has_tun_inbound(&config) {
            return Ok(Vec::new());
        }

        // Poll for wintun adapter creation up to 10 seconds (40 * 250ms)
        let mut adapter_ready = false;
        let mut wintun_if_index = None;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let check = std::process::Command::new("netsh")
                .args(["interface", "ipv4", "show", "interface", "wintun"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            if let Ok(out) = check {
                if out.status.success() {
                    let text = String::from_utf8_lossy(&out.stdout);
                    if !text.contains("не найден") && !text.contains("not found") {
                        adapter_ready = true;
                        wintun_if_index = parse_if_index(&text);
                        break;
                    }
                }
            }
        }

        if !adapter_ready {
            return Err("wintun adapter was not created within timeout".to_string());
        }

        // Find physical default gateway
        let default_gw = find_physical_default_gateway()
            .ok_or_else(|| "could not determine physical default gateway".to_string())?;

        let server_hosts = extract_xray_server_hosts(&config);
        let server_ips = tokio::task::spawn_blocking(move || resolve_server_ips(&server_hosts))
            .await
            .unwrap_or_default();

        let mut bypass_ips = server_ips;
        let dns_ips = extract_xray_dns_ips(&config);
        bypass_ips.extend(dns_ips);
        bypass_ips.sort();
        bypass_ips.dedup();

        let mut added_routes = Vec::new();

        // 1. Add host bypass routes for all proxy servers and DNS servers via the physical default gateway
        for ip in &bypass_ips {
            let ip_str = ip.to_string();
            let gw_str = default_gw.gateway_ip.to_string();

            let _ = std::process::Command::new("route")
                .args(["delete", &ip_str])
                .creation_flags(CREATE_NO_WINDOW)
                .output();

            let mut cmd = std::process::Command::new("route");
            cmd.args([
                "add",
                &ip_str,
                "mask",
                "255.255.255.255",
                &gw_str,
                "metric",
                "1",
            ]);
            if let Some(if_idx) = default_gw.if_index {
                let if_str = if_idx.to_string();
                cmd.args(["if", &if_str]);
            }
            cmd.creation_flags(CREATE_NO_WINDOW);

            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    added_routes.push(RouteRecord {
                        destination: ip_str,
                        mask: "255.255.255.255".to_string(),
                        gateway: gw_str,
                        if_index: default_gw.if_index,
                    });
                } else {
                    log::warn!("failed to add bypass route for {}: {:?}", ip, out.status);
                }
            }
        }

        // 2. Configure wintun IP address (without gateway to avoid default route collision)
        let set_addr = std::process::Command::new("netsh")
            .args([
                "interface",
                "ip",
                "set",
                "address",
                "name=wintun",
                "source=static",
                "addr=172.19.0.2",
                "mask=255.255.255.252",
                "gateway=none",
                "store=active",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("failed to run netsh set address: {e}"))?;

        if !set_addr.status.success() {
            log::warn!(
                "netsh set address exited with status {:?}",
                set_addr.status
            );
        }

        // 3. Configure DNS on wintun
        let _ = std::process::Command::new("netsh")
            .args([
                "interface", "ip", "set", "dns", "name=wintun", "source=static", "addr=1.1.1.1", "validate=no",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        let _ = std::process::Command::new("netsh")
            .args([
                "interface", "ip", "add", "dns", "name=wintun", "addr=8.8.8.8", "index=2", "validate=no",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        // 4. Add split default routes: 0.0.0.0/1 and 128.0.0.0/1 via 172.19.0.1
        for (dest, mask) in [("0.0.0.0", "128.0.0.0"), ("128.0.0.0", "128.0.0.0")] {
            let _ = std::process::Command::new("route")
                .args(["delete", dest, "mask", mask, "172.19.0.1"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();

            let mut cmd = std::process::Command::new("route");
            cmd.args(["add", dest, "mask", mask, "172.19.0.1", "metric", "1"]);
            if let Some(if_idx) = wintun_if_index {
                let if_str = if_idx.to_string();
                cmd.args(["if", &if_str]);
            }
            cmd.creation_flags(CREATE_NO_WINDOW);

            if let Ok(o) = cmd.output() {
                if o.status.success() {
                    added_routes.push(RouteRecord {
                        destination: dest.to_string(),
                        mask: mask.to_string(),
                        gateway: "172.19.0.1".to_string(),
                        if_index: wintun_if_index,
                    });
                } else {
                    log::warn!("failed to add route {} mask {}: {:?}", dest, mask, o.status);
                }
            }
        }

        log::info!(
            "configured Xray TUN on wintun (gw: {}, bypass routes: {})",
            default_gw.gateway_ip,
            bypass_ips.len()
        );
        Ok(added_routes)
    }

    #[cfg(not(windows))]
    {
        let _ = config_path;
        Ok(Vec::new())
    }
}

/// Teardown routes added for Xray TUN mode.
pub fn teardown_xray_windows_tun(routes: &[RouteRecord]) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        for r in routes {
            let _ = std::process::Command::new("route")
                .args(["delete", &r.destination, "mask", &r.mask, &r.gateway])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }

        // Unconditionally delete the split default routes if present
        teardown_xray_windows_tun_unconditional();
        log::info!("cleaned up Xray TUN routes ({})", routes.len());
    }

    #[cfg(not(windows))]
    {
        let _ = routes;
    }
}

/// Unconditionally remove split default routes pointing to 172.19.0.1.
pub fn teardown_xray_windows_tun_unconditional() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let _ = std::process::Command::new("route")
            .args(["delete", "0.0.0.0", "mask", "128.0.0.0", "172.19.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = std::process::Command::new("route")
            .args(["delete", "128.0.0.0", "mask", "128.0.0.0", "172.19.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = std::process::Command::new("route")
            .args(["-p", "delete", "0.0.0.0", "172.19.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = std::process::Command::new("route")
            .args(["delete", "0.0.0.0", "172.19.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_dns_server_ips() {
        let config = serde_json::json!({
            "dns": {
                "servers": ["tcp://1.1.1.1", "tcp://8.8.8.8", "1.0.0.1"]
            }
        });
        let ips = extract_xray_dns_ips(&config);
        assert_eq!(ips, vec![
            "1.0.0.1".parse::<Ipv4Addr>().unwrap(),
            "1.1.1.1".parse::<Ipv4Addr>().unwrap(),
            "8.8.8.8".parse::<Ipv4Addr>().unwrap()
        ]);
    }

    #[test]
    fn extracts_dns_server_ips_fallback_and_objects() {
        let empty_config = serde_json::json!({});
        let ips = extract_xray_dns_ips(&empty_config);
        assert_eq!(ips, vec![
            "1.1.1.1".parse::<Ipv4Addr>().unwrap(),
            "8.8.8.8".parse::<Ipv4Addr>().unwrap()
        ]);

        let object_config = serde_json::json!({
            "dns": {
                "servers": [
                    {"address": "udp://9.9.9.9:53"},
                    {"address": "127.0.0.1"},
                    "tcp://149.112.112.112:53"
                ]
            }
        });
        let ips2 = extract_xray_dns_ips(&object_config);
        assert_eq!(ips2, vec![
            "9.9.9.9".parse::<Ipv4Addr>().unwrap(),
            "149.112.112.112".parse::<Ipv4Addr>().unwrap()
        ]);
    }

    #[test]
    fn detects_tun_inbound() {
        assert!(has_tun_inbound(&json!({
            "inbounds": [
                {"protocol": "http", "port": 1080},
                {"protocol": "tun", "tag": "cloakwire-managed-tun"}
            ]
        })));

        assert!(!has_tun_inbound(&json!({
            "inbounds": [
                {"protocol": "http", "port": 1080}
            ]
        })));

        assert!(!has_tun_inbound(&json!({})));
    }

    #[test]
    fn extracts_server_hosts_from_various_protocols() {
        let config = json!({
            "outbounds": [
                {
                    "protocol": "vless",
                    "settings": {
                        "vnext": [{"address": "cdn.extera-game.ru", "port": 443}]
                    }
                },
                {
                    "protocol": "vmess",
                    "settings": {
                        "vnext": [{"address": "1.2.3.4", "port": 8443}]
                    }
                },
                {
                    "protocol": "trojan",
                    "settings": {
                        "servers": [{"address": "trojan.example.com", "port": 443}]
                    }
                },
                {
                    "protocol": "shadowsocks",
                    "settings": {
                        "servers": [{"server": "5.6.7.8", "port": 8388}]
                    }
                },
                {
                    "protocol": "freedom",
                    "settings": {}
                }
            ]
        });

        let hosts = extract_xray_server_hosts(&config);
        assert_eq!(
            hosts,
            vec![
                "1.2.3.4".to_string(),
                "5.6.7.8".to_string(),
                "cdn.extera-game.ru".to_string(),
                "trojan.example.com".to_string(),
            ]
        );
    }

    #[test]
    fn parses_gateway_output_correctly() {
        let gw = parse_gateway_output("192.168.1.254 9\r\n").unwrap();
        assert_eq!(gw.gateway_ip, "192.168.1.254".parse::<Ipv4Addr>().unwrap());
        assert_eq!(gw.if_index, Some(9));

        // Ignores 172.19.* and 0.0.0.0
        assert!(parse_gateway_output("172.19.0.1 46\n").is_none());
        assert!(parse_gateway_output("0.0.0.0 1\n").is_none());
    }

    #[test]
    fn parses_route_print_fallback_correctly() {
        let sample = "\
===========================================================================
Активные маршруты:
Сетевой адрес      Маска сети    Адрес шлюза      Интерфейс  Метрика
          0.0.0.0          0.0.0.0    192.168.1.254     192.168.1.70     75
          0.0.0.0          0.0.0.0         26.0.0.1      26.84.2.140   9257
          0.0.0.0          0.0.0.0       172.19.0.2       172.19.0.1      0
===========================================================================\n";

        let gw = parse_route_print_fallback(sample).unwrap();
        assert_eq!(gw.gateway_ip, "192.168.1.254".parse::<Ipv4Addr>().unwrap());
        assert_eq!(gw.if_index, None);
    }

    #[test]
    fn resolves_server_ips_filters_loopback() {
        let hosts = vec!["127.0.0.1".to_string(), "1.2.3.4".to_string()];
        let ips = resolve_server_ips(&hosts);
        assert_eq!(ips, vec!["1.2.3.4".parse::<Ipv4Addr>().unwrap()]);
    }

    #[test]
    fn parses_if_index_correctly() {
        let sample_ru = "\
Параметры интерфейса Ethernet
----------------------------------------------
IfLuid                             : ethernet_32769
IfIndex                            : 9
Состояние                              : connected\n";
        assert_eq!(parse_if_index(sample_ru), Some(9));

        let sample_en = "\
Configuration for interface \"wintun\"
    IfLuid                             : loopback_0
    IfIndex                            : 46
    State                              : connected\n";
        assert_eq!(parse_if_index(sample_en), Some(46));

        assert_eq!(parse_if_index("No index here"), None);
    }
}
