//! Windows-specific helpers for the Wintun TUN adapter lifecycle.
//!
//! sing-box creates its TUN device through Wintun (`WintunCreateAdapter`).
//! That call fails with `ERROR_FILE_EXISTS` — "Cannot create a file when that
//! file already exists" — whenever Windows still has an adapter registered
//! under the requested name.
//!
//! Wintun adapters are persistent device objects: they outlive the process
//! that created them. A sing-box that is killed (`TerminateProcess`, which is
//! how a forced disconnect ends the child) never gets to run its own cleanup,
//! so the adapter stays behind and every later start fails before the tunnel
//! is established. The same happens when the machine loses power mid-session.
//!
//! The helpers below remove such leftovers. Removal is skipped while another
//! sing-box process is still running, because that process may own the
//! adapter and is very likely tunnelling traffic through it.

use std::path::Path;
use std::process::Command;

use crate::config::DEFAULT_TUN_INTERFACE_NAME;

/// Run a console tool without flashing a window.
fn run(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map_err(|e| format!("spawn {program}: {e}"))
}

/// Uninstall the network adapter `name`.
///
/// `netcfg -u` is the supported way to remove a Wintun adapter from the
/// command line. It needs an elevated shell, which the app already has —
/// creating a TUN device requires it anyway. `netcfg` exits with 0 even when
/// there was nothing to remove, so the call is safe to make unconditionally.
pub fn remove_adapter(name: &str) -> Result<(), String> {
    let output = run("netcfg", &["-u", name])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "netcfg -u {name} exited with {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    Ok(())
}

/// True when a sing-box process is running.
///
/// Another instance of the client may be tunnelling traffic through the very
/// adapter we are about to remove, so this check keeps us from pulling it out
/// from under a live session. The match is by name rather than by path: the
/// bundled sidecar is called `sing-box-<target>.exe` and the plain build
/// `sing-box.exe`, and a sing-box started by another client may own an
/// adapter with the same name.
pub fn singbox_running() -> bool {
    let mut system = sysinfo::System::new();
    // sysinfo 0.32: refresh_processes takes a `ProcessesToUpdate` and
    // a "force_refresh" bool. `All` = every process, no filter.
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system.processes().values().any(|process| {
        process
            .name()
            .to_string_lossy()
            .trim()
            .to_ascii_lowercase()
            .starts_with("sing-box")
    })
}

/// Read the TUN interface name out of a generated sing-box config.
///
/// Returns `None` when the config has no TUN inbound, i.e. when there is no
/// Wintun adapter to clean up.
pub fn tun_interface_name(config_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(config_path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&content).ok()?;
    let inbounds = config.get("inbounds")?.as_array()?;
    let tun = inbounds
        .iter()
        .find(|inbound| inbound.get("type").and_then(|t| t.as_str()) == Some("tun"))?;
    Some(
        tun.get("interface_name")
            .and_then(|name| name.as_str())
            .unwrap_or(DEFAULT_TUN_INTERFACE_NAME)
            .to_string(),
    )
}

/// Remove the TUN adapter left behind by a sing-box that is no longer running.
///
/// The removal is skipped while another sing-box process is alive: that
/// process may own the adapter and be actively tunnelling traffic through it.
pub fn cleanup_tun_adapter(name: &str) -> Result<(), String> {
    if singbox_running() {
        log::warn!("a sing-box process is running; leaving TUN adapter '{name}' alone");
        return Ok(());
    }
    remove_adapter(name)?;
    log::info!("cleared TUN adapter '{name}'");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tun_interface_name_is_read_from_the_config() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "inbounds": [
                    {"type": "mixed", "tag": "mixed-in"},
                    {"type": "tun", "tag": "tun-in", "interface_name": "my-tun"}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(tun_interface_name(&path), Some("my-tun".to_string()));
    }

    #[test]
    fn tun_interface_name_is_none_without_a_tun_inbound() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "inbounds": [{"type": "mixed", "tag": "mixed-in"}]
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(tun_interface_name(&path), None);
    }

    #[test]
    fn tun_interface_name_falls_back_to_the_default() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "inbounds": [{"type": "tun", "tag": "tun-in"}]
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            tun_interface_name(&path),
            Some(DEFAULT_TUN_INTERFACE_NAME.to_string())
        );
    }
}
