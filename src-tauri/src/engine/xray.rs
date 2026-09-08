pub mod geodata;

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PackagedBinaryMetadata {
    name: &'static str,
    sha256: &'static str,
    size: u64,
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn packaged_binary_metadata() -> Option<PackagedBinaryMetadata> {
    Some(PackagedBinaryMetadata {
        name: "xray-x86_64-pc-windows-msvc.exe",
        sha256: "15c2d007954ac53ba69b80ec91242786b3c0b71d52649165b4ca1d5cc96ef8f1",
        size: 35_613_696,
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn packaged_binary_metadata() -> Option<PackagedBinaryMetadata> {
    Some(PackagedBinaryMetadata {
        name: "xray-aarch64-apple-darwin",
        sha256: "",
        size: 0,
    })
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn packaged_binary_metadata() -> Option<PackagedBinaryMetadata> {
    Some(PackagedBinaryMetadata {
        name: "xray-x86_64-apple-darwin",
        sha256: "",
        size: 0,
    })
}

#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64")
)))]
fn packaged_binary_metadata() -> Option<PackagedBinaryMetadata> {
    None
}

/// Locate and verify the packaged, repository-controlled Xray sidecar. Unlike sing-box,
/// Xray is never downloaded or selected through a lossy config conversion.
pub fn locate_binary(app: &AppHandle) -> AppResult<PathBuf> {
    let names = candidate_names();
    if let Ok(path) = std::env::var("XRAY_BIN") {
        let path = PathBuf::from(path);
        if path.exists() {
            return verify_binary(path);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(path) = first_existing(dir, &names) {
                return verify_binary(path);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(path) = first_existing(&resource_dir.join("binaries"), &names) {
            return verify_binary(path);
        }
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let mut cursor = Some(PathBuf::from(manifest));
        for _ in 0..4 {
            let Some(dir) = cursor.take() else { break };
            if let Some(path) = first_existing(&dir.join("binaries"), &names) {
                return verify_binary(path);
            }
            cursor = dir.parent().map(Path::to_path_buf);
        }
    }
    Err(AppError::BinaryNotFound(
        "Xray-core sidecar is unavailable".to_string(),
    ))
}

fn verify_binary(path: PathBuf) -> AppResult<PathBuf> {
    let metadata = packaged_binary_metadata().ok_or_else(|| {
        AppError::BinaryNotFound("Xray-core is unsupported on this target".into())
    })?;
    if metadata.size > 0 && !metadata.sha256.is_empty() {
        let bytes = fs::read(&path)?;
        if bytes.len() as u64 != metadata.size {
            return Err(AppError::BinaryNotFound(
                "Xray-core sidecar integrity check failed".into(),
            ));
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if digest != metadata.sha256 {
            return Err(AppError::BinaryNotFound(
                "Xray-core sidecar integrity check failed".into(),
            ));
        }
    }
    Ok(path)
}

#[cfg(windows)]
pub fn ensure_wintun_driver(app: &AppHandle, binary_path: &Path) -> AppResult<()> {
    let Some(bin_dir) = binary_path.parent() else {
        return Ok(());
    };
    let target_dll = bin_dir.join("wintun.dll");
    if target_dll.exists() {
        return Ok(());
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("binaries").join("wintun.dll");
        if candidate.exists() {
            if std::fs::copy(&candidate, &target_dll).is_ok() {
                return Ok(());
            }
        }
        let direct = resource_dir.join("wintun.dll");
        if direct.exists() {
            if std::fs::copy(&direct, &target_dll).is_ok() {
                return Ok(());
            }
        }
    }

    const EMBEDDED_WINTUN: &[u8] = include_bytes!("../../binaries/wintun.dll");
    let _ = std::fs::write(&target_dll, EMBEDDED_WINTUN);
    Ok(())
}

#[cfg(not(windows))]
pub fn ensure_wintun_driver(_app: &AppHandle, _binary_path: &Path) -> AppResult<()> {
    Ok(())
}

pub fn prepare_validation_config(config_path: &Path) -> std::io::Result<Option<PathBuf>> {
    let content = std::fs::read_to_string(config_path)?;
    let mut value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let has_tun = value
        .get("inbounds")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .any(|i| i.get("protocol").and_then(serde_json::Value::as_str) == Some("tun"))
        })
        .unwrap_or(false);

    if !has_tun {
        return Ok(None);
    }

    if let Some(inbounds) = value.get_mut("inbounds").and_then(serde_json::Value::as_array_mut) {
        inbounds.retain(|i| i.get("protocol").and_then(serde_json::Value::as_str) != Some("tun"));
    }

    let nonce = format!("val-{}.json", uuid::Uuid::new_v4());
    let temp_path = config_path.with_file_name(nonce);
    let bytes = serde_json::to_vec(&value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(&temp_path, bytes)?;
    Ok(Some(temp_path))
}

pub async fn validate_config(
    binary: &Path,
    config_path: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> AppResult<()> {
    let validation_path = match prepare_validation_config(config_path) {
        Ok(Some(temp_path)) => temp_path,
        _ => config_path.to_path_buf(),
    };

    let mut command = Command::new(binary);
    command.args(validation_args(&validation_path));
    command.envs(env.iter().map(|(key, value)| (key, value)));
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .await
        .map_err(|_| AppError::Spawn("Xray config validation could not start".into()))?;

    if validation_path != config_path {
        let _ = std::fs::remove_file(&validation_path);
    }

    if output.status.success() {
        Ok(())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("Xray config validation failed: stdout={stdout}, stderr={stderr}");
        Err(AppError::Validation("Xray config validation failed".into()))
    }
}

pub fn validation_args(config_path: &Path) -> [std::ffi::OsString; 4] {
    [
        "run".into(),
        "-test".into(),
        "-config".into(),
        config_path.as_os_str().to_os_string(),
    ]
}

pub fn run_args(config_path: &Path) -> [std::ffi::OsString; 3] {
    [
        "run".into(),
        "-config".into(),
        config_path.as_os_str().to_os_string(),
    ]
}

pub fn parse_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Xray ")
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_owned)
            .filter(|version| !version.is_empty())
    })
}

fn candidate_names() -> [String; 2] {
    let plain_name = if cfg!(windows) { "xray.exe" } else { "xray" };
    let packaged_name = packaged_binary_metadata()
        .map(|metadata| metadata.name)
        .unwrap_or(plain_name);
    [packaged_name.to_string(), plain_name.to_string()]
}

fn first_existing(dir: &Path, names: &[String; 2]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argument_strings(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn parses_public_xray_version_without_returning_build_banner() {
        let output = "Xray 26.3.27 (Xray, Penetrates Everything.) Custom (go1.24 windows/amd64)";
        assert_eq!(parse_version(output).as_deref(), Some("26.3.27"));
        assert_eq!(parse_version("unrecognized"), None);
    }

    #[test]
    fn xray_validation_uses_test_config_command() {
        let args = argument_strings(validation_args(Path::new("runtime.json")));
        assert_eq!(args, vec!["run", "-test", "-config", "runtime.json"]);
    }

    #[test]
    fn xray_launch_uses_original_runtime_config_path() {
        let args = argument_strings(run_args(Path::new("runtime.json")));
        assert_eq!(args, vec!["run", "-config", "runtime.json"]);
    }

    #[test]
    fn resolver_has_targeted_sidecar_names_and_integrity_metadata() {
        let metadata = packaged_binary_metadata().expect("supported desktop target");
        let names = candidate_names();
        assert_eq!(names[0], metadata.name);
        assert!(metadata.name.starts_with("xray-"));
        assert_eq!(metadata.sha256.len(), 64);
        assert!(metadata.size > 1_000_000);
    }

    #[test]
    fn prepare_validation_config_strips_tun_inbound() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("config.json");
        let content = serde_json::json!({
            "inbounds": [
                {"protocol": "tun", "tag": "cloakwire-managed-tun"},
                {"protocol": "http", "port": 10808}
            ],
            "outbounds": [{"protocol": "freedom", "tag": "direct"}]
        });
        std::fs::write(&config_path, serde_json::to_vec(&content).unwrap()).unwrap();

        let val_path = prepare_validation_config(&config_path).unwrap().expect("creates val path");
        assert!(val_path.exists());
        let val_content: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&val_path).unwrap()).unwrap();
        let inbounds = val_content["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["protocol"], "http");
        let _ = std::fs::remove_file(val_path);
    }

    #[test]
    fn prepare_validation_config_returns_none_when_no_tun() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("config.json");
        let content = serde_json::json!({
            "inbounds": [
                {"protocol": "http", "port": 10808}
            ]
        });
        std::fs::write(&config_path, serde_json::to_vec(&content).unwrap()).unwrap();

        assert!(prepare_validation_config(&config_path).unwrap().is_none());
    }
}
