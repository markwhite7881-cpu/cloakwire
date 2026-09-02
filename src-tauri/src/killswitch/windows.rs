//! Windows Firewall Kill Switch implementation.
//!
//! Uses Windows Firewall (`netsh advfirewall`) to enforce strict outbound
//! traffic isolation during VPN sessions, permitting only loopback, local LAN,
//! DHCP lease renewal, and Cloakwire core processes (`sing-box.exe` and `xray.exe`).
//!
//! When armed, outbound default policy is set to `BlockOutbound`.
//! When disarmed or during app startup, default policy is restored to `AllowOutbound`
//! and all Cloakwire firewall rules are deleted.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{AppError, AppResult};

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const RULE_PREFIX: &str = "Cloakwire-KS-";
pub const RULE_LOOPBACK: &str = "Cloakwire-KS-Allow-Loopback";
pub const RULE_LAN: &str = "Cloakwire-KS-Allow-LAN";
pub const RULE_DHCP: &str = "Cloakwire-KS-Allow-DHCP";
pub const RULE_TUN: &str = "Cloakwire-KS-Allow-TUN";
pub const RULE_SINGBOX: &str = "Cloakwire-KS-Allow-Core-Singbox";
pub const RULE_XRAY: &str = "Cloakwire-KS-Allow-Core-Xray";

static IS_ARMED: AtomicBool = AtomicBool::new(false);

fn run_netsh(args: &[&str]) -> AppResult<std::process::Output> {
    Command::new("netsh")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AppError::Io(e))
}

/// Reset firewall policy to default AllowOutbound and remove all Cloakwire rules.
pub fn cleanup_stale_rules() -> AppResult<()> {
    log::info!("killswitch: cleaning up firewall rules and restoring default outbound policy");

    // Restore default outbound policy across all profiles
    let _ = run_netsh(&[
        "advfirewall",
        "set",
        "allprofiles",
        "firewallpolicy",
        "blockinbound,allowoutbound",
    ]);

    // Delete specific rules
    for rule in [
        RULE_LOOPBACK,
        RULE_LAN,
        RULE_DHCP,
        RULE_TUN,
        RULE_SINGBOX,
        RULE_XRAY,
    ] {
        let _ = run_netsh(&["advfirewall", "firewall", "delete", "rule", &format!("name={rule}")]);
    }

    IS_ARMED.store(false, Ordering::Release);
    Ok(())
}

/// Arm the Kill Switch: configure whitelist rules and set outbound policy to BlockOutbound.
pub fn arm_kill_switch(singbox_bin: Option<&Path>, xray_bin: Option<&Path>) -> AppResult<()> {
    log::info!("killswitch: arming firewall kill switch");

    // 1. Clean any stale rules first to ensure clean state
    cleanup_stale_rules()?;

    // 2. Add Loopback rule (IPv4 127.0.0.0/8 and IPv6 ::1)
    let output = run_netsh(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={RULE_LOOPBACK}"),
        "dir=out",
        "action=allow",
        "remoteip=127.0.0.0/8,::1",
    ])?;
    if !output.status.success() {
        log::warn!(
            "killswitch: failed to add loopback rule: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    // 3. Add LAN rule (RFC 1918 private subnets and link-local)
    let _ = run_netsh(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={RULE_LAN}"),
        "dir=out",
        "action=allow",
        "remoteip=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16",
    ]);

    // 4. Add DHCP rule (UDP local 68 -> remote 67) so Wi-Fi leases do not expire
    let _ = run_netsh(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={RULE_DHCP}"),
        "dir=out",
        "action=allow",
        "protocol=UDP",
        "localport=68",
        "remoteport=67",
    ]);

    // 4b. Add TUN virtual adapter rule allowing outbound traffic originating from the TUN subnet (172.16.0.0/12 and fd00::/8)
    let _ = run_netsh(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={RULE_TUN}"),
        "dir=out",
        "action=allow",
        "localip=172.16.0.0/12,fd00::/8",
    ]);

    // 5. Whitelist sing-box binary if specified and exists
    if let Some(bin) = singbox_bin {
        if bin.exists() {
            let bin_str = bin.to_string_lossy();
            let _ = run_netsh(&[
                "advfirewall",
                "firewall",
                "add",
                "rule",
                &format!("name={RULE_SINGBOX}"),
                "dir=out",
                "action=allow",
                &format!("program={bin_str}"),
            ]);
        }
    }

    // 6. Whitelist Xray binary if specified and exists
    if let Some(bin) = xray_bin {
        if bin.exists() {
            let bin_str = bin.to_string_lossy();
            let _ = run_netsh(&[
                "advfirewall",
                "firewall",
                "add",
                "rule",
                &format!("name={RULE_XRAY}"),
                "dir=out",
                "action=allow",
                &format!("program={bin_str}"),
            ]);
        }
    }

    // 7. Enforce BlockOutbound policy across all profiles
    let policy_out = run_netsh(&[
        "advfirewall",
        "set",
        "allprofiles",
        "firewallpolicy",
        "blockinbound,blockoutbound",
    ])?;

    if !policy_out.status.success() {
        let err_msg = String::from_utf8_lossy(&policy_out.stderr);
        log::error!("killswitch: failed to set blockoutbound policy: {err_msg}");
        cleanup_stale_rules()?;
        return Err(AppError::KillSwitch(format!(
            "Failed to activate Windows Firewall Kill Switch: {err_msg}"
        )));
    }

    IS_ARMED.store(true, Ordering::Release);
    log::info!("killswitch: successfully armed");
    Ok(())
}

/// Disarm the Kill Switch: restores outbound traffic and deletes rules.
pub fn disarm_kill_switch() -> AppResult<()> {
    cleanup_stale_rules()
}

/// Check whether the Kill Switch is currently armed in this process.
pub fn is_kill_switch_armed() -> bool {
    IS_ARMED.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_constants_have_consistent_prefix() {
        assert!(RULE_LOOPBACK.starts_with(RULE_PREFIX));
        assert!(RULE_LAN.starts_with(RULE_PREFIX));
        assert!(RULE_DHCP.starts_with(RULE_PREFIX));
        assert!(RULE_TUN.starts_with(RULE_PREFIX));
        assert!(RULE_SINGBOX.starts_with(RULE_PREFIX));
        assert!(RULE_XRAY.starts_with(RULE_PREFIX));
    }
}
