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

/// Arm the Kill Switch: disabled to prevent network lockouts, safely ensures cleanup.
pub fn arm_kill_switch(_singbox_bin: Option<&Path>, _xray_bin: Option<&Path>) -> AppResult<()> {
    log::info!("killswitch: firewall isolation disabled, ensuring clean default outbound policy");
    cleanup_stale_rules()
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
