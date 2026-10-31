//! Read-only physical-route discovery. Ambiguity fails closed; no route/proxy writes.
use super::types::HealthIssue;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{net::Ipv4Addr, time::Duration};
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysicalNetwork {
    interface: String,
    fingerprint: String,
}
impl PhysicalNetwork {
    pub fn interface(&self) -> &str {
        &self.interface
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    #[cfg(test)]
    pub(crate) fn fixture(interface: &str) -> Self {
        Self {
            interface: interface.into(),
            fingerprint: "fixture".into(),
        }
    }
}
#[derive(Deserialize)]
struct Route {
    interface: String,
    #[serde(default)]
    index: u32,
    gateway: String,
    addresses: Vec<String>,
    metric: u64,
    physical: bool,
    up: bool,
}
fn usable_ip(value: &str) -> bool {
    value.parse::<Ipv4Addr>().is_ok_and(|ip| {
        !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast()
    })
}
pub(crate) fn select_physical(value: &serde_json::Value) -> Result<PhysicalNetwork, HealthIssue> {
    let mut routes: Vec<Route> =
        serde_json::from_value(value.clone()).map_err(|_| HealthIssue::NetworkUnavailable)?;
    routes.retain(|r| {
        r.physical
            && r.up
            && !r.interface.is_empty()
            && r.interface.len() <= 256
            && !r.interface.chars().any(char::is_control)
            && usable_ip(&r.gateway)
            && r.addresses.iter().any(|s| usable_ip(s))
    });
    routes.sort_by(|a, b| {
        (a.metric, &a.interface, &a.gateway).cmp(&(b.metric, &b.interface, &b.gateway))
    });
    routes.dedup_by(|a, b| {
        a.interface == b.interface && a.gateway == b.gateway && a.metric == b.metric
    });
    let first = routes.first().ok_or(HealthIssue::NetworkUnavailable)?;
    if routes.get(1).is_some_and(|r| r.metric == first.metric) {
        return Err(HealthIssue::NetworkUnavailable);
    }
    let mut addresses = first.addresses.clone();
    addresses.sort();
    addresses.dedup();
    let identity = serde_json::json!([
        first.interface,
        first.index,
        first.gateway,
        addresses,
        first.metric
    ]);
    let fingerprint = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
    Ok(PhysicalNetwork {
        interface: first.interface.clone(),
        fingerprint,
    })
}

async fn output(program: &str, args: &[&str]) -> Result<String, HealthIssue> {
    let mut command = Command::new(program);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let result = tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .map_err(|_| HealthIssue::NetworkUnavailable)?
        .map_err(|_| HealthIssue::NetworkUnavailable)?;
    if !result.status.success() || result.stdout.len() > 512 * 1024 {
        return Err(HealthIssue::NetworkUnavailable);
    }
    String::from_utf8(result.stdout)
        .map(|s| s.trim_start_matches('\u{feff}').trim().to_owned())
        .map_err(|_| HealthIssue::NetworkUnavailable)
}
#[cfg(windows)]
pub async fn discover() -> Result<PhysicalNetwork, HealthIssue> {
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$adapters=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up')
$rows=@(foreach($route in @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0')) {
 $adapter=$adapters | Where-Object ifIndex -eq $route.ifIndex | Select-Object -First 1
 if($null -eq $adapter){continue}
 $link=Get-NetIPInterface -InterfaceIndex $route.ifIndex -AddressFamily IPv4 | Select-Object -First 1
 $addresses=@(Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred' | ForEach-Object IPAddress)
 [pscustomobject]@{interface=$adapter.Name;index=$route.ifIndex;gateway=$route.NextHop;addresses=$addresses;metric=([long]$route.RouteMetric+[long]$link.InterfaceMetric);physical=$true;up=$true}
})
ConvertTo-Json -InputObject $rows -Depth 5 -Compress"#;
    let text = output(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCRIPT,
        ],
    )
    .await?;
    let value = serde_json::from_str(&text).map_err(|_| HealthIssue::NetworkUnavailable)?;
    select_physical(&value)
}
#[cfg(any(target_os = "macos", test))]
pub(crate) fn mac_default_routes(hardware: &str, routes: &str) -> Vec<(String, String)> {
    let devices: std::collections::HashSet<&str> = hardware
        .lines()
        .filter_map(|l| l.trim().strip_prefix("Device: "))
        .filter(|name| name.starts_with("en") && name[2..].chars().all(|c| c.is_ascii_digit()))
        .collect();
    let mut rows = Vec::new();
    for line in routes.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 4 || fields[0] != "default" || !usable_ip(fields[1]) {
            continue;
        }
        if let Some(name) = fields.iter().find(|f| devices.contains(**f)) {
            rows.push(((*name).to_string(), fields[1].to_string()));
        }
    }
    rows.sort();
    rows.dedup();
    rows
}
#[cfg(target_os = "macos")]
pub async fn discover() -> Result<PhysicalNetwork, HealthIssue> {
    let (hardware, routes) = tokio::try_join!(
        output("/usr/sbin/networksetup", &["-listallhardwareports"]),
        output("/usr/sbin/netstat", &["-rn", "-f", "inet"])
    )?;
    let mut rows = Vec::new();
    for (name, gateway) in mac_default_routes(&hardware, &routes) {
        let state = output("/sbin/ifconfig", &[&name]).await?;
        let addresses: Vec<_> = state
            .lines()
            .filter_map(|l| l.trim().strip_prefix("inet "))
            .filter_map(|l| l.split_whitespace().next())
            .map(str::to_owned)
            .collect();
        rows.push(serde_json::json!({"interface":name,"gateway":gateway,"addresses":addresses,"metric":0,"physical":true,"up":state.lines().any(|l|l.trim()=="status: active")}));
    }
    select_physical(&serde_json::json!(rows))
}
#[cfg(not(any(windows, target_os = "macos")))]
pub async fn discover() -> Result<PhysicalNetwork, HealthIssue> {
    Err(HealthIssue::NetworkUnavailable)
}
