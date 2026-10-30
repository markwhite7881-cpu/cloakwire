//! Safe, bounded validation of a prepared profile. Raw core output stays local.
use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ProfileCheckIssue {
    #[error("profile_check_dns")]
    Dns,
    #[error("profile_check_ruleset")]
    RuleSet,
    #[error("profile_check_unsupported")]
    Unsupported,
    #[error("profile_check_invalid")]
    Invalid,
    #[error("profile_check_unavailable")]
    Unavailable,
    #[error("profile_check_timeout")]
    Timeout,
    #[error("profile_check_failed")]
    Failed,
    #[error("profile_check_cancelled")]
    Cancelled,
}
impl ProfileCheckIssue {
    pub fn code(self) -> &'static str {
        match self {
            Self::Dns => "profile_check_dns",
            Self::RuleSet => "profile_check_ruleset",
            Self::Unsupported => "profile_check_unsupported",
            Self::Invalid => "profile_check_invalid",
            Self::Unavailable => "profile_check_unavailable",
            Self::Timeout => "profile_check_timeout",
            Self::Failed => "profile_check_failed",
            Self::Cancelled => "profile_check_cancelled",
        }
    }
    pub fn classify(output: &str) -> Self {
        let text = output.to_ascii_lowercase();
        if [
            "default domain resolver not found",
            "dns server not found",
            "unknown dns server",
            "non-existent dns server",
        ]
        .iter()
        .any(|phrase| text.contains(phrase))
        {
            Self::Dns
        } else if [
            "rule-set",
            "rule_set",
            "rule set",
            "geoip.dat",
            "geosite.dat",
        ]
        .iter()
        .any(|phrase| text.contains(phrase))
        {
            Self::RuleSet
        } else if [
            "unknown field",
            "unknown outbound type",
            "unknown inbound type",
            "unknown action",
            "unknown config id",
            "unknown protocol",
            "not supported",
        ]
        .iter()
        .any(|phrase| text.contains(phrase))
        {
            Self::Unsupported
        } else if [
            "decode config",
            "invalid character",
            "unexpected end",
            "invalid config",
        ]
        .iter()
        .any(|phrase| text.contains(phrase))
        {
            Self::Invalid
        } else {
            Self::Failed
        }
    }
}

pub async fn run_check(command: Command) -> AppResult<()> {
    run_check_with_timeout(command, Duration::from_secs(10)).await
}
async fn run_check_with_timeout(mut command: Command, limit: Duration) -> AppResult<()> {
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| ProfileCheckIssue::Timeout)?
        .map_err(|_| ProfileCheckIssue::Unavailable)?;
    if output.status.success() {
        return Ok(());
    }
    let output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Err(ProfileCheckIssue::classify(&output).into())
}

/// Checkers must not open or truncate an active session's log files.
/// All routing, DNS, inbound and outbound settings remain unchanged.
/// A pending runtime/check file cannot be swept by another connection attempt.
pub(crate) fn leased_config_paths() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>>
{
    static PATHS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    PATHS.get_or_init(Default::default)
}
pub(crate) struct ConfigLease(PathBuf);
impl ConfigLease {
    pub(crate) fn new(path: PathBuf) -> Self {
        leased_config_paths()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(path.clone());
        Self(path)
    }
}
impl std::ops::Deref for ConfigLease {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}
impl Drop for ConfigLease {
    fn drop(&mut self) {
        leased_config_paths()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

pub struct CheckConfig(ConfigLease);
impl CheckConfig {
    pub fn new(original: &Path, xray: bool) -> AppResult<Self> {
        let bytes = std::fs::read(original).map_err(|_| ProfileCheckIssue::Failed)?;
        let mut value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| ProfileCheckIssue::Invalid)?;
        let root = value.as_object_mut().ok_or(ProfileCheckIssue::Invalid)?;
        root.insert(
            "log".into(),
            if xray {
                serde_json::json!({"loglevel": "none", "access": "none", "error": "none"})
            } else {
                serde_json::json!({"disabled": true})
            },
        );
        let path = original.with_file_name(format!("check-{}.json", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lease = ConfigLease::new(path);
        let mut file = options
            .open(lease.as_path())
            .map_err(|_| ProfileCheckIssue::Failed)?;
        // Own the cleanup guard before serializing or writing can fail.
        let guard = Self(lease);
        use std::io::Write;
        file.write_all(&serde_json::to_vec(&value).map_err(|_| ProfileCheckIssue::Invalid)?)
            .map_err(|_| ProfileCheckIssue::Failed)?;
        Ok(guard)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for CheckConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0.as_path());
    }
}

pub fn preparation_error(error: AppError) -> AppError {
    match error {
        AppError::ProfileCheck(_) => error,
        AppError::BinaryNotFound(_) | AppError::EngineUnavailable(_) => {
            ProfileCheckIssue::Unavailable.into()
        }
        AppError::Unsupported(_) => ProfileCheckIssue::Unsupported.into(),
        AppError::UnsafeConfig(_) | AppError::Validation(_) | AppError::Serde(_) => {
            ProfileCheckIssue::Invalid.into()
        }
        _ => ProfileCheckIssue::Failed.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifies_known_failures_without_returning_provider_data() {
        for (raw, issue) in [
            (
                "initialize outbound[0]: default domain resolver not found: private-dns",
                ProfileCheckIssue::Dns,
            ),
            (
                "initialize rule-set[0]: open /private/provider.srs: file not found",
                ProfileCheckIssue::RuleSet,
            ),
            (
                "route.rules[0].private: json: unknown field enabled",
                ProfileCheckIssue::Unsupported,
            ),
            (
                "decode config: invalid character at /private/config.json",
                ProfileCheckIssue::Invalid,
            ),
            (
                "unexpected private-uuid@example.test",
                ProfileCheckIssue::Failed,
            ),
        ] {
            assert_eq!(ProfileCheckIssue::classify(raw), issue);
            let rendered = issue.to_string();
            assert!(rendered.starts_with("profile_check_"));
            assert!(!rendered.contains("private"));
        }
    }
    fn exit_command(success: bool) -> Command {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("cmd.exe");
            cmd.args([
                "/C",
                if success {
                    "exit 0"
                } else {
                    "echo default domain resolver not found: secret 1>&2 & exit 1"
                },
            ]);
            cmd
        }
        #[cfg(not(windows))]
        {
            let mut cmd = Command::new("/bin/sh");
            cmd.args([
                "-c",
                if success {
                    "exit 0"
                } else {
                    "echo 'default domain resolver not found: secret' >&2; exit 1"
                },
            ]);
            cmd
        }
    }
    #[tokio::test]
    async fn core_rejection_returns_only_a_safe_cause() {
        let result = run_check(exit_command(false)).await;
        assert!(matches!(
            result,
            Err(AppError::ProfileCheck(ProfileCheckIssue::Dns))
        ));
        let public = serde_json::to_string(&result.unwrap_err()).unwrap();
        assert_eq!(
            public,
            r#"{"kind":"profile_check_dns","message":"profile_check_dns"}"#
        );
    }
    #[tokio::test]
    async fn valid_configuration_passes() {
        run_check(exit_command(true)).await.unwrap();
    }
    #[tokio::test]
    async fn missing_checker_is_reported_without_a_local_path() {
        let error = run_check(Command::new("cloakwire-no-such-core-413782"))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::ProfileCheck(ProfileCheckIssue::Unavailable)
        ));
    }
    #[tokio::test]
    async fn hanging_checker_is_bounded() {
        #[cfg(windows)]
        let mut command = Command::new("powershell.exe");
        #[cfg(windows)]
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        #[cfg(not(windows))]
        let mut command = Command::new("/bin/sleep");
        #[cfg(not(windows))]
        command.arg("30");
        let result = run_check_with_timeout(command, Duration::from_millis(100)).await;
        assert!(matches!(
            result,
            Err(AppError::ProfileCheck(ProfileCheckIssue::Timeout))
        ));
    }
}
#[cfg(test)]
mod check_config_tests {
    use super::*;
    #[test]
    fn checker_copy_preserves_routing_and_removes_only_log_side_effects() {
        for xray in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let original = dir.path().join("provider.json");
            let value = serde_json::json!({"log":{"output":"private-active.log","level":"trace"}, "dns":{"servers":[{"tag":"provider-dns","type":"local"}]}, "route":{"final":"provider"}, "outbounds":[{"tag":"provider","type":"direct"}], "inbounds":[{"type":"tun","tag":"tun-in"}]});
            std::fs::write(&original, serde_json::to_vec(&value).unwrap()).unwrap();
            let path;
            {
                let check = CheckConfig::new(&original, xray).unwrap();
                path = check.path().to_path_buf();
                let checked: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                for field in ["dns", "route", "outbounds", "inbounds"] {
                    assert_eq!(checked[field], value[field]);
                }
                assert!(!checked["log"].to_string().contains("private-active.log"));
                assert_eq!(
                    std::fs::read(&original).unwrap(),
                    serde_json::to_vec(&value).unwrap()
                );
            }
            assert!(!path.exists());
        }
    }
}

#[cfg(all(test, any(windows, target_os = "macos")))]
mod native_check_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires bundled desktop cores"]
    async fn bundled_cores_validate_without_changing_active_logs_or_source() {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let target = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => "x86_64-pc-windows-msvc.exe",
            ("macos", "aarch64") => "aarch64-apple-darwin",
            ("macos", "x86_64") => "x86_64-apple-darwin",
            _ => panic!("unsupported desktop test target"),
        };
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("active.log");
        std::fs::write(&log, "active session log").unwrap();
        let config = dir.path().join("ready.json");
        let mut value = serde_json::json!({
            "log":{"output":log,"level":"info"},
            "dns":{"servers":[{"tag":"provider-dns","type":"local"}]},
            "inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":0}],
            "outbounds":[{"tag":"provider","type":"direct"}],
            "route":{"final":"provider","default_domain_resolver":"provider-dns"}
        });
        std::fs::write(&config, serde_json::to_vec(&value).unwrap()).unwrap();
        crate::engine::singbox::validate_config(
            &binaries.join(format!("sing-box-{target}")),
            &config,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "active session log");
        let mut tun = value.clone();
        tun["inbounds"] = serde_json::json!([{"type":"tun","tag":"tun-in","address":["172.19.0.1/30"],"auto_route":true,"stack":"gvisor"}]);
        std::fs::write(&config, serde_json::to_vec(&tun).unwrap()).unwrap();
        crate::engine::singbox::validate_config(
            &binaries.join(format!("sing-box-{target}")),
            &config,
        )
        .await
        .unwrap();
        value["route"]["default_domain_resolver"] = "not-present-private-name".into();
        std::fs::write(&config, serde_json::to_vec(&value).unwrap()).unwrap();
        let failure = crate::engine::singbox::validate_config(
            &binaries.join(format!("sing-box-{target}")),
            &config,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            failure,
            AppError::ProfileCheck(ProfileCheckIssue::Dns)
        ));
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "active session log");
        let xray = serde_json::json!({"log":{"access":log,"error":log,"loglevel":"debug"}, "outbounds":[{"protocol":"freedom","tag":"provider"}]});
        std::fs::write(&config, serde_json::to_vec(&xray).unwrap()).unwrap();
        crate::engine::xray::validate_config(
            &binaries.join(format!("xray-{target}")),
            &config,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "active session log");
        assert_eq!(
            std::fs::read(&config).unwrap(),
            serde_json::to_vec(&xray).unwrap()
        );
        let mut bad_xray = xray.clone();
        bad_xray["inbounds"] =
            serde_json::json!([{"protocol":"tun","tag":"invalid-tun","settings":{}}]);
        std::fs::write(&config, serde_json::to_vec(&bad_xray).unwrap()).unwrap();
        assert!(crate::engine::xray::validate_config(
            &binaries.join(format!("xray-{target}")),
            &config,
            &[]
        )
        .await
        .is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
