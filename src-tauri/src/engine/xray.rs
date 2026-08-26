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

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn packaged_binary_metadata() -> Option<PackagedBinaryMetadata> {
    Some(PackagedBinaryMetadata {
        name: "xray-x86_64-unknown-linux-gnu",
        sha256: "8255dd939c34cf966cc91517b6324dd3c8d0bcf49ffac8beca049a38c46845ed",
        size: 36_577_406,
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn packaged_binary_metadata() -> Option<PackagedBinaryMetadata> {
    Some(PackagedBinaryMetadata {
        name: "xray-aarch64-apple-darwin",
        sha256: "5d9dd24c0aba4b6cfcc6a33a5d67f854816ee17f392bf932ec8176da46f7e404",
        size: 33_678_802,
    })
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn packaged_binary_metadata() -> Option<PackagedBinaryMetadata> {
    Some(PackagedBinaryMetadata {
        name: "xray-x86_64-apple-darwin",
        sha256: "afd0eaebb77994a18f29b00c5f50a4f7fbb77da06e24352d43035f3cad3c3786",
        size: 35_723_312,
    })
}

#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64"),
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
    Ok(path)
}

pub async fn validate_config(
    binary: &Path,
    config_path: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> AppResult<()> {
    let mut command = Command::new(binary);
    command.args(validation_args(config_path));
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
    if output.status.success() {
        Ok(())
    } else {
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
}
