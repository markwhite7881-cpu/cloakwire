//! Tauri commands exposed to the frontend.
//!
//! Every command is async and returns `AppResult<T>`. The frontend
//! sees errors as `{ kind, message }` (see error.rs).

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "android"))]
use tauri::State;
use tauri::{AppHandle, Manager};

use crate::config::{self, GeneratorSettings};
use crate::error::{AppError, AppResult};
use crate::parser::{self, Outbound};
#[cfg(not(target_os = "android"))]
use crate::process::{LogLine, ProcessManager, StatusReport};
use crate::subscriptions::{
    ActiveChildConfig, AddSubscriptionInput, LegacySubscriptionInput, RefreshSubscriptionResult,
    SubscriptionService, SubscriptionSnapshot, SubscriptionSummary,
};

/// Writable scratch directory for generated/validated configs.
///
/// Desktop uses the OS temp dir (configs are throwaway there). On
/// Android there is no usable temp dir for an app process, so we use
/// the app-private data dir — which is also exactly where the Kotlin
/// VpnService can read the file back (same uid).
fn scratch_dir(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "android")]
    {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
    }
    #[cfg(not(target_os = "android"))]
    {
        app.path()
            .temp_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
    }
}

// --- sing-box sidecar lifecycle (desktop only) ---------------------------
//
// On Android the engine is the Xray sidecar owned by the Kotlin
// VpnService; there is no sing-box process for Rust to manage.

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingboxVersion {
    pub version: String,
    pub environment: String,
    pub revision: String,
    pub raw: String,
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryInfo {
    pub path: String,
    pub exists: bool,
    pub size_bytes: u64,
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_binary_info(app: AppHandle) -> AppResult<BinaryInfo> {
    match ProcessManager::locate_binary(&app) {
        Ok(p) => {
            let meta = std::fs::metadata(&p).ok();
            Ok(BinaryInfo {
                path: p.display().to_string(),
                exists: true,
                size_bytes: meta.map(|m| m.len()).unwrap_or(0),
            })
        }
        Err(_) => Ok(BinaryInfo {
            path: String::new(),
            exists: false,
            size_bytes: 0,
        }),
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_singbox_version(app: AppHandle) -> AppResult<SingboxVersion> {
    let binary = ProcessManager::locate_binary(&app)?;
    // `sing-box version` is a console-mode binary; without CREATE_NO_WINDOW
    // it pops a black CMD window for a fraction of a second every time
    // the frontend polls. Hide it the same way we do for the long-lived
    // `sing-box run` child in process.rs.
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("version");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Spawn(format!("version probe failed: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut version = String::new();
    let mut env = String::new();
    let mut revision = String::new();
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("sing-box version ") {
            version = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("Environment: ") {
            env = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("Revision: ") {
            revision = rest.trim().to_string();
        }
    }
    // The Leadaxe sing-box-lx fork intentionally ships the binary
    // with the `version` field set to the literal string "unknown"
    // (it doesn't embed a semver at build time — the fork is on a
    // SagerNet base that hasn't tagged a release in the conventional
    // sense). The Revision field, however, IS populated with a real
    // git SHA. Substitute a useful identifier so the UI shows
    // something actionable instead of "sing-box unknown":
    //
    //   * "lx @ b87b4dc"  (typical Leadaxe fork build)
    //   * "1.14.0-lx.24"  (if upstream ever starts populating
    //                      `version` again — the lx suffix is a
    //                      community convention)
    if version.is_empty() || version == "unknown" {
        if !revision.is_empty() {
            version = format!("lx @ {}", short_rev(&revision));
        } else {
            version = "lx (no revision)".to_string();
        }
    }
    Ok(SingboxVersion {
        version,
        environment: env,
        revision,
        raw: stdout,
    })
}

/// First 8 chars of a git SHA — matches the short format `git log`
/// shows. The Leadaxe revision is 40 hex chars; we don't want the
/// full thing in the UI title.
#[cfg(not(target_os = "android"))]
fn short_rev(rev: &str) -> &str {
    if rev.len() >= 8 {
        &rev[..8]
    } else {
        rev
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn check_config(app: AppHandle, config_path: String) -> AppResult<String> {
    let binary = ProcessManager::locate_binary(&app)?;
    // Same CREATE_NO_WINDOW dance — `sing-box check -c <path>` is a
    // short-lived console-mode spawn and otherwise flashes a CMD window.
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("check").arg("-c").arg(&config_path);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Spawn(format!("check failed: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(AppError::Spawn(format!(
            "config check failed (exit {}): {}{}",
            output.status.code().unwrap_or(-1),
            stdout,
            stderr
        )));
    }
    Ok(format!("{}{}", stdout, stderr))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn start_singbox(
    app: AppHandle,
    pm: State<'_, Arc<ProcessManager>>,
    config_path: String,
) -> AppResult<StatusReport> {
    start_singbox_with_config(app, pm, config_path, None).await
}

/// Like `start_singbox` but also records the Clash API controller URL
/// so subsequent `clash_*` commands know where to talk to.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn start_singbox_with_config(
    app: AppHandle,
    pm: State<'_, Arc<ProcessManager>>,
    config_path: String,
    controller_url: Option<String>,
) -> AppResult<StatusReport> {
    let binary = ProcessManager::locate_binary(&app)?;
    let cfg = PathBuf::from(&config_path);
    if !cfg.exists() {
        return Err(AppError::WriteConfig(format!(
            "config file does not exist: {config_path}"
        )));
    }
    pm.start(&app, &binary, &cfg, controller_url).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn stop_singbox(pm: State<'_, Arc<ProcessManager>>) -> AppResult<StatusReport> {
    pm.stop().await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_status(pm: State<'_, Arc<ProcessManager>>) -> AppResult<StatusReport> {
    Ok(pm.snapshot_status().await)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_logs(
    pm: State<'_, Arc<ProcessManager>>,
    limit: Option<usize>,
) -> AppResult<Vec<LogLine>> {
    Ok(pm.snapshot_logs(limit.unwrap_or(500)).await)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn is_running(pm: State<'_, Arc<ProcessManager>>) -> AppResult<bool> {
    Ok(pm.is_running().await)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_current_config(pm: State<'_, Arc<ProcessManager>>) -> AppResult<Option<String>> {
    Ok(pm.current_config().await.map(|p| p.display().to_string()))
}

/// Marker command the frontend can call to confirm the IPC layer is alive.
#[tauri::command]
pub async fn ping() -> AppResult<String> {
    Ok("pong".to_string())
}

/// Write a minimal default config to the OS temp directory and return the path.
///
/// The frontend uses this for the very first "just make it boot" smoke test
/// before subscription parsing lands.
#[tauri::command]
pub async fn write_default_config(app: AppHandle) -> AppResult<String> {
    let dir = scratch_dir(&app);
    std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
    let path = dir.join("config.default.json");
    let body = serde_json::json!({
        "log": { "level": "info", "timestamp": true },
        "inbounds": [{
            "type": "mixed",
            "tag": "mixed-in",
            "listen": "127.0.0.1",
            "listen_port": 2080
        }],
        "outbounds": [{ "type": "direct", "tag": "direct" }],
        "route": {
            "rules": [{ "ip_version": 6, "action": "reject" }]
        },
        "experimental": {
            "clash_api": {
                "default_mode": "proxy",
                "external_controller": "127.0.0.1:9090"
            },
            "cache_file": { "path": "cache.db", "store_fakeip": false }
        }
    });
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&body).map_err(AppError::Serde)?,
    )
    .map_err(AppError::Io)?;
    Ok(path.display().to_string())
}

/// Force a state into Stopped (used for tests / manual recovery).
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn reset_state(pm: State<'_, Arc<ProcessManager>>) -> AppResult<StatusReport> {
    pm.reset().await;
    Ok(pm.snapshot_status().await)
}

// --- Link parser --------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseFailure {
    pub line: String,
    pub error: parser::ParseError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseLinksResult {
    pub outbounds: Vec<Outbound>,
    pub failures: Vec<ParseFailure>,
}

#[tauri::command]
pub async fn parse_link(link: String) -> AppResult<Outbound> {
    parser::parse_link(&link).map_err(AppError::from)
}

#[tauri::command]
pub async fn parse_links(text: String) -> AppResult<ParseLinksResult> {
    let mut outbounds = Vec::new();
    let mut failures = Vec::new();

    // We need per-line reporting, so walk the input ourselves.
    let (raw_lines, was_base64) = split_subscription_text(&text);
    for line in raw_lines {
        match parser::parse_link(&line) {
            Ok(ob) => outbounds.push(ob),
            Err(e) => failures.push(ParseFailure { line, error: e }),
        }
    }
    let _ = was_base64; // currently informational only
    Ok(ParseLinksResult {
        outbounds,
        failures,
    })
}

/// Parse a user-typed blob that may contain a mix of share-links and
/// subscription URLs. HTTP(S) URLs are surfaced as `Subscription`s in
/// the failures list with a dedicated `kind: "subscription"` so the
/// UI can promote them to the subscriptions list instead of treating
/// them as parse errors.
#[tauri::command]
pub async fn parse_input(text: String) -> AppResult<ParsedInput> {
    let mut outbounds = Vec::new();
    let mut subscriptions = Vec::new();
    let mut failures = Vec::new();

    let (raw_lines, _was_base64) = split_subscription_text(&text);
    for line in raw_lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            // Treat as a subscription URL — the UI will add it via
            // useSubscriptions.add() once the user reviews.
            subscriptions.push(line);
        } else {
            match parser::parse_link(&line) {
                Ok(ob) => outbounds.push(ob),
                Err(e) => failures.push(ParseFailure { line, error: e }),
            }
        }
    }
    Ok(ParsedInput {
        outbounds,
        subscriptions,
        failures,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedInput {
    pub outbounds: Vec<Outbound>,
    /// HTTP(S) URLs discovered in the input that should be added as
    /// subscription entries rather than parsed as share-links.
    pub subscriptions: Vec<String>,
    pub failures: Vec<ParseFailure>,
}

#[tauri::command]
pub async fn outbound_to_singbox_json(outbound: Outbound) -> AppResult<serde_json::Value> {
    Ok(outbound.to_singbox_json())
}

// --- Config generator ---------------------------------------------------

/// Build a complete sing-box config from the given outbounds + settings.
/// Returns the config as a `serde_json::Value` (also serialised to the
/// frontend as plain JSON). The frontend decides whether to display,
/// copy or persist it.
#[tauri::command]
pub async fn generate_config(
    outbounds: Vec<Outbound>,
    settings: GeneratorSettings,
) -> AppResult<serde_json::Value> {
    Ok(config::Config::build(&outbounds, &settings))
}

/// Build a complete xray config from the classified profiles — the
/// Android engine's config source (loopback socks inbound + protected
/// dialer chain; see `xray_config`). Desktop keeps sing-box, so the
/// command is only registered in the Android handler.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn generate_xray_config(outbounds: Vec<Outbound>) -> AppResult<serde_json::Value> {
    Ok(crate::xray_config::link_config(&outbounds)?)
}

/// Latency tester spec: a short-lived xray config with one loopback
/// socks inbound per profile, plus the port→tag map for the Kotlin
/// runner (`plugin:vpn|testLatency`).
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn generate_xray_test_config(
    outbounds: Vec<Outbound>,
) -> AppResult<crate::xray_config::TestSpec> {
    Ok(crate::xray_config::test_config(&outbounds)?)
}

/// Persist a config JSON to a file. If `path` is `None`, writes to
/// `<temp_dir>/config.generated.json` and returns that path.
#[tauri::command]
pub async fn save_config_to_path(
    app: AppHandle,
    content: serde_json::Value,
    path: Option<String>,
) -> AppResult<String> {
    let body = serde_json::to_vec_pretty(&content).map_err(AppError::Serde)?;
    let path = match path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => scratch_dir(&app).join("config.generated.json"),
    };
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(AppError::Io)?;
        }
    }
    std::fs::write(&path, body).map_err(AppError::Io)?;
    Ok(path.display().to_string())
}

/// Validate a config JSON with `sing-box check` and return the output.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn check_config_with_binary(
    app: AppHandle,
    config: serde_json::Value,
) -> AppResult<String> {
    // Write to a temp file (sing-box needs a path), then ask the
    // sidecar to validate it.
    let dir = scratch_dir(&app);
    let path = dir.join("config.check.json");
    let body = serde_json::to_vec_pretty(&config).map_err(AppError::Serde)?;
    std::fs::write(&path, body).map_err(AppError::Io)?;
    check_config(app, path.display().to_string()).await
}

// --- Clash API (desktop only) ------------------------------------------

#[cfg(not(target_os = "android"))]
async fn api_url(pm: &ProcessManager) -> AppResult<String> {
    match pm.controller_url().await {
        Some(u) => Ok(u),
        None => Err(AppError::Clash("sing-box is not running".to_string())),
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn list_proxies(
    pm: State<'_, Arc<ProcessManager>>,
) -> AppResult<crate::clash_api::ProxiesResponse> {
    let base = api_url(&pm).await?;
    let client = crate::clash_api::Client::new();
    client.list_proxies(&base).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn select_proxy(
    pm: State<'_, Arc<ProcessManager>>,
    group: String,
    member: String,
) -> AppResult<()> {
    let base = api_url(&pm).await?;
    let client = crate::clash_api::Client::new();
    client.select_proxy(&base, &group, &member).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn test_delay(
    pm: State<'_, Arc<ProcessManager>>,
    name: String,
    timeout_ms: Option<u32>,
) -> AppResult<Option<u32>> {
    let base = api_url(&pm).await?;
    let client = crate::clash_api::Client::new();
    client
        .test_delay(&base, &name, timeout_ms.unwrap_or(3000))
        .await
}

/// Direct TCP-connect ping, independent of sing-box.
///
/// Used by the frontend's per-server latency probe so the user can
/// see the best server *before* they connect — `test_delay` only
/// works while sing-box is running because it goes through the clash
/// API on 127.0.0.1:9090. We measure the time it takes to complete
/// a `TcpStream::connect()` on the outbound's `host:port` instead;
/// for VLESS/Xray protocols this isn't a real round-trip, but it
/// correlates well with TCP reachability and is a good enough
/// signal to rank servers by latency in the picker.
#[tauri::command]
pub async fn ping_endpoint(
    host: String,
    port: u16,
    timeout_ms: Option<u32>,
) -> AppResult<Option<u32>> {
    use std::time::{Duration, Instant};
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2000) as u64);
    let start = Instant::now();
    let res = tokio::time::timeout(
        timeout,
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await;
    match res {
        Ok(Ok(_stream)) => Ok(Some(start.elapsed().as_millis() as u32)),
        // Both timeout and connect-error mean "unreachable" — we
        // return Ok(None) so the UI can show "—" instead of a hard
        // error. The probe loop already filters these.
        Ok(Err(_)) | Err(_) => Ok(None),
    }
}

/// Batch IP → ISO country-code lookup, using the free
/// `ip-api.com` HTTP endpoint. The frontend caches the result in
/// `localStorage` keyed by IP, so the second lookup is free and
/// the third+ lookups are incremental.
///
/// We hit `/batch` (one HTTP call for up to 100 IPs) and only
/// request `query` + `countryCode`. Privacy note: ip-api sees the
/// caller's egress IP, not the user's traffic — it just answers
/// "where is this IP geolocated" for the IPs we hand it.
#[tauri::command]
pub async fn lookup_geoip(ips: Vec<String>) -> AppResult<Vec<(String, String)>> {
    if ips.is_empty() {
        return Ok(Vec::new());
    }
    // Up to 100 per request (ip-api's batch limit).
    let chunk: Vec<String> = ips.into_iter().take(100).collect();
    let body = serde_json::json!(chunk
        .iter()
        .map(|ip| serde_json::json!({ "query": ip }))
        .collect::<Vec<_>>());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .user_agent("cloakwire/0.1")
        .build()
        .map_err(|e| AppError::Clash(format!("http client: {e}")))?;
    // `system` resolver is fine for a hostname like ip-api.com that
    // is a public, well-known endpoint. No DoH needed here.
    let resp = client
        .post("http://ip-api.com/batch?fields=query,countryCode,status")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Clash(format!("ip-api request: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Clash(format!("ip-api http {status}")));
    }
    let arr: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| AppError::Clash(format!("ip-api decode: {e}")))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let ip = item.get("query").and_then(|v| v.as_str()).unwrap_or("");
        if item.get("status").and_then(|v| v.as_str()) != Some("success") {
            continue;
        }
        if let Some(code) = item.get("countryCode").and_then(|v| v.as_str()) {
            if !code.is_empty() && code.len() == 2 {
                out.push((ip.to_string(), code.to_uppercase()));
            }
        }
    }
    Ok(out)
}

// --- Traffic stream -----------------------------------------------------
//
// The traffic stream is auto-started by `start_singbox_with_config`
// when a controller URL is known. These commands are exposed mostly
// for manual control / debugging.

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn start_traffic(app: AppHandle, pm: State<'_, Arc<ProcessManager>>) -> AppResult<()> {
    let base = api_url(&pm).await?;
    pm.traffic().start(app, &base).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn stop_traffic(pm: State<'_, Arc<ProcessManager>>) -> AppResult<()> {
    pm.traffic().stop().await;
    Ok(())
}

/// Point the Clash API helper at a controller URL without going
/// through `start_singbox_with_config`.
///
/// Desktop never needs this (pm.start sets the URL as part of the
/// sidecar spawn). On Android the core is started by the Kotlin
/// VpnService via libbox, so after the VPN comes up the frontend
/// calls this once with `http://127.0.0.1:9090` and the shared
/// `list_proxies` / `test_delay` / `start_traffic` commands keep
/// working unchanged.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn set_controller_url(
    pm: State<'_, Arc<ProcessManager>>,
    url: Option<String>,
) -> AppResult<()> {
    pm.set_controller_url(url).await;
    Ok(())
}

// --- System proxy (Windows only) -------------------------------------
//
// When sing-box runs in system_proxy mode we have to also tell
// Windows to route HTTP/HTTPS traffic through the local listener,
// otherwise nothing reaches 127.0.0.1:<port>. These two thin wrappers
// toggle the WinINET registry value and are invoked from onStart /
// onStop in App.tsx.

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn apply_system_proxy(host: String, port: u16) -> AppResult<()> {
    crate::process::apply_system_proxy(&host, port)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn clear_system_proxy() -> AppResult<()> {
    crate::process::clear_system_proxy()
}

// --- Windows autostart -------------------------------------------------
//
// Thin wrapper around `tauri-plugin-autostart`. We expose
// `get_autostart` / `set_autostart` instead of letting the frontend
// poke the plugin directly so the surface stays symmetrical with the
// other commands and we can swap backends later (e.g. Task Scheduler).
// Android has no login-item concept for a VPN client (the OS owns
// always-on VPN), so the plugin isn't compiled in there and the
// commands are stubs.

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn get_autostart(app: AppHandle) -> AppResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    mgr.is_enabled()
        .map_err(|e| AppError::Clash(format!("autostart probe failed: {e}")))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> AppResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable()
            .map_err(|e| AppError::Clash(format!("autostart enable failed: {e}")))?;
    } else {
        mgr.disable()
            .map_err(|e| AppError::Clash(format!("autostart disable failed: {e}")))?;
    }
    mgr.is_enabled()
        .map_err(|e| AppError::Clash(format!("autostart recheck failed: {e}")))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn get_autostart() -> AppResult<bool> {
    Err(AppError::Unsupported("autostart".to_string()))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn set_autostart(enabled: bool) -> AppResult<bool> {
    let _ = enabled;
    Err(AppError::Unsupported("autostart".to_string()))
}

// --- Subscriptions -----------------------------------------------------

/// Fetch a subscription URL and return the parsed outbounds + failures.
/// Accepts both raw newline-separated links and base64-encoded blobs
/// (the two common formats used by v2ray/sing-box subscription
/// providers).
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn fetch_subscription(url: String) -> AppResult<ParseLinksResult> {
    let body = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "cloakwire/0.1")
        .send()
        .await
        .map_err(|e| AppError::Clash(format!("subscription fetch failed: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Clash(format!("subscription HTTP error: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Clash(format!("subscription read failed: {e}")))?;

    // We re-implement the per-line reporting here so the UI can
    // surface failures. `parse_links` swallows them and returns a
    // flat Vec.
    let (lines, _was_b64) = split_subscription_text(&body);
    let mut outbounds = Vec::new();
    let mut failures = Vec::new();
    for line in lines {
        match parser::parse_link(&line) {
            Ok(o) => outbounds.push(o),
            Err(e) => failures.push(ParseFailure { line, error: e }),
        }
    }
    Ok(ParseLinksResult {
        outbounds,
        failures,
    })
}

/// Decode a subscription blob: per-line links OR a base64-encoded
/// newline-separated blob. Mirrors the helper in `parser::mod` but
/// works on the post-fetch text.
fn split_subscription_text(text: &str) -> (Vec<String>, bool) {
    let text = text.trim();
    if text.is_empty() {
        return (Vec::new(), false);
    }
    let lines: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect();
    if lines.iter().any(|l| l.contains("://")) {
        return (lines, false);
    }
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let try_decode = |input: &str| {
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use base64::Engine as _;
        let pad = |mut t: String| {
            while t.len() % 4 != 0 {
                t.push('=');
            }
            t
        };
        URL_SAFE_NO_PAD
            .decode(input)
            .or_else(|_| URL_SAFE_NO_PAD.decode(pad(input.to_string())))
            .or_else(|_| STANDARD.decode(input))
            .or_else(|_| STANDARD.decode(pad(input.to_string())))
            .ok()
    };
    if let Some(bytes) = try_decode(&cleaned) {
        let decoded = String::from_utf8_lossy(&bytes).into_owned();
        let lines: Vec<String> = decoded
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(String::from)
            .collect();
        return (lines, true);
    }
    (lines, false)
}

// ── Process enumeration (routing process-name picker) ───────────────────

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
}

/// List currently running processes (name + pid).
///
/// Used by the routing-rule "process name" picker so the user can
/// click on a running app instead of typing its .exe name by hand.
/// Sorted by name (case-insensitive), de-duplicated by name, capped
/// at 500 entries — a typical Windows desktop has 150-300 processes
/// so the cap is a safety net for pathological hosts.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn list_processes() -> AppResult<Vec<ProcessInfo>> {
    use std::collections::BTreeMap;

    let mut sys = sysinfo::System::new();
    // sysinfo 0.32: refresh_processes takes a `ProcessesToUpdate` and
    // a "force_refresh" bool. `All` = every process, no filter.
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut by_name: BTreeMap<String, sysinfo::Pid> = BTreeMap::new();
    for (pid, proc_) in sys.processes().iter() {
        let name = proc_.name().to_string_lossy().trim().to_string();
        if name.is_empty() || name.len() > 64 {
            continue;
        }
        let key = name.to_ascii_lowercase();
        // If two processes share a name, keep the lowest pid (it's the
        // canonical one the user expects — usually the parent).
        by_name
            .entry(key)
            .and_modify(|existing| {
                if *pid < *existing {
                    *existing = *pid;
                }
            })
            .or_insert(*pid);
    }

    let mut out: Vec<ProcessInfo> = by_name
        .into_iter()
        .map(|(_, pid)| {
            let proc_ = sys.process(pid);
            let name = proc_
                .map(|p| p.name().to_string_lossy().to_string())
                .unwrap_or_default();
            ProcessInfo {
                pid: pid.as_u32(),
                name,
            }
        })
        .filter(|p| !p.name.is_empty())
        .collect();
    // Stable display order: by name (case-insensitive), ties broken by pid.
    out.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then(a.pid.cmp(&b.pid))
    });
    out.truncate(500);
    Ok(out)
}

// ── sing-box auto-update (see `updates` module) ─────────────────────────

/// Frontend-facing wrapper: returns the current + latest sing-box
/// versions and whether an update is available.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn check_singbox_update(app: AppHandle) -> AppResult<crate::updates::SingboxUpdateInfo> {
    crate::updates::check_singbox_update(&app).await
}

/// Frontend-facing wrapper: download + replace the runtime-cached
/// sing-box. `download_url` must come from `check_singbox_update`'s
/// `SingboxUpdateInfo.download_url` — we don't refetch the release
/// list, so the user is always updating to the version they were
/// shown.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn apply_singbox_update(app: AppHandle, download_url: String) -> AppResult<String> {
    crate::updates::apply_singbox_update(app, download_url).await
}

/// Custom app-shell update check. Bypasses `tauri-plugin-updater`
/// entirely and uses our own `reqwest` (rustls) client. See
/// `app_update.rs` for the rationale — the bundled Tauri updater
/// fails with "error decoding response body" on a small but real
/// subset of Windows installs because it uses schannel/WinINet,
/// not rustls, and something in that stack doesn't like the
/// GitHub CDN's signed-URL response shape.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> AppResult<crate::app_update::AppUpdateInfo> {
    crate::app_update::check_app_update(&app).await
}

/// Custom app-shell install. Downloads the platform installer to
/// the system temp dir, spawns it with the right flags, then asks
/// Tauri to exit so the installer can replace the running .exe.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn install_app_update(app: AppHandle, download_url: String) -> AppResult<()> {
    crate::app_update::install_app_update(app, download_url).await
}

#[cfg(all(test, not(target_os = "android")))]
mod process_tests {
    use super::*;

    /// Smoke test: the command runs without panicking and returns a
    /// well-formed list on a normal host. We don't assert specific
    /// process names (machine-dependent) — only the invariants.
    #[tokio::test]
    async fn list_processes_returns_well_formed_entries() {
        let procs = list_processes().await.expect("list_processes ok");
        let mut prev: Option<String> = None;
        for p in &procs {
            assert!(!p.name.is_empty(), "process name must not be empty");
            if let Some(p_name) = &prev {
                assert!(
                    p_name.to_ascii_lowercase() <= p.name.to_ascii_lowercase(),
                    "list_processes must be sorted by name (case-insensitive)"
                );
            }
            prev = Some(p.name.clone());
        }
        // Cap of 500 — sanity check.
        assert!(procs.len() <= 500, "list_processes must cap at 500 entries");
    }
}

// --- Subscription service commands -----------------------------------
//
// The mobile (and desktop) frontend drives the subscription store
// exclusively through these commands. The store lives in Rust and
// handles validation, persistence, HTTP fetch, and payload
// classification in a single round trip — the frontend never sees
// the raw URL after `add_subscription` resolves.

/// Look up the shared `SubscriptionService` that `lib.rs` registered
/// in the Tauri setup hook. Returns a sanitized error if the service
/// was not initialised (e.g. the user is on an unsupported build).
fn subscription_service(app: &AppHandle) -> AppResult<Arc<SubscriptionService>> {
    app.try_state::<Arc<SubscriptionService>>()
        .map(|state| Arc::clone(state.inner()))
        .ok_or_else(|| {
            AppError::Unsupported("subscription service is not initialised on this platform".into())
        })
}

#[tauri::command]
pub async fn list_subscriptions(app: AppHandle) -> AppResult<SubscriptionSnapshot> {
    let service = subscription_service(&app)?;
    service.list_snapshot().await
}

/// Return the full `Outbound[]` for a LinkList subscription so the
/// mobile UI can render the real `tag` / `server` / `port` /
/// `uuid` for each link. Returns an empty vec for bundle
/// subscriptions (the children live on `summary.children` and the
/// engine that consumes them is a separate workstream). 2026-08-20.
#[tauri::command]
pub async fn get_subscription_outbounds(
    app: AppHandle,
    id: String,
) -> AppResult<Vec<crate::parser::Outbound>> {
    let service = subscription_service(&app)?;
    service.get_link_outbounds(&id).await
}

#[tauri::command]
pub async fn add_subscription(
    app: AppHandle,
    input: AddSubscriptionInput,
) -> AppResult<RefreshSubscriptionResult> {
    let service = subscription_service(&app)?;
    // On Android, the `reqwest`+`rustls-tls` client that
    // `SubscriptionHttpClient::fetch` builds produces a TLS
    // ClientHello that anivka.top's edge RSTs after the libc
    // `getaddrinfo` resolve succeeds — verified 2026-08-21 on
    // 144.31.148.251:443. The Kotlin `VpnPlugin.subscriptionFetchUrl`
    // command uses `java.net.HttpURLConnection` (the same BoringSSL
    // stack as `curl` on the device), so we hop the network request
    // through there and run the body through the same
    // `classify_payload` pipeline on the way back. PC keeps the
    // existing in-process `service.add` path; the `reqwest`+`rustls`
    // stack works fine there because the network path doesn't
    // fingerprint rustls. 2026-08-21.
    #[cfg(target_os = "android")]
    {
        add_subscription_android(&app, service, input).await
    }
    #[cfg(not(target_os = "android"))]
    {
        service.add(input).await
    }
}

/// Android-only branch of [add_subscription]. Fetches the body
/// through the Kotlin `subscriptionFetchUrl` IPC command, then
/// hands the body + metadata headers to the subscription service for
/// classification and persistence. PC never calls this. 2026-08-21.
#[cfg(target_os = "android")]
async fn add_subscription_android(
    app: &AppHandle,
    service: Arc<SubscriptionService>,
    input: AddSubscriptionInput,
) -> AppResult<RefreshSubscriptionResult> {
    let fetched = fetch_subscription_via_kotlin(app, &service, &input.url).await?;
    let metadata = fetched.metadata();
    service
        .add_with_fetched_body(
            input,
            fetched.body.into_bytes(),
            fetched.content_type,
            metadata,
            fetched.status,
        )
        .await
}

/// Android-only branch of [refresh_subscription]. Same Kotlin
/// transport, same service commit path.
#[cfg(target_os = "android")]
async fn refresh_subscription_android(
    app: &AppHandle,
    service: Arc<SubscriptionService>,
    id: &str,
) -> AppResult<RefreshSubscriptionResult> {
    let url = service.subscription_url(id).await?;
    let fetched = fetch_subscription_via_kotlin(app, &service, &url).await?;
    let metadata = fetched.metadata();
    service
        .refresh_with_fetched_body(
            id,
            fetched.body.into_bytes(),
            fetched.content_type,
            metadata,
            fetched.status,
        )
        .await
}

/// One Kotlin-transported subscription fetch: URL + HWID in, body +
/// content type + real status + metadata headers out. The HWID stays
/// owned by the Rust `HwidStore`; Kotlin just forwards it as a
/// header, so the same UUID is sent on every transport.
#[cfg(target_os = "android")]
async fn fetch_subscription_via_kotlin(
    app: &AppHandle,
    service: &Arc<SubscriptionService>,
    url: &str,
) -> AppResult<AndroidSubscriptionFetchedBody> {
    use tauri::Manager;
    let hwid_info = service.describe_hwid().await?;
    let hwid = hwid_info.effective;
    let plugin_handle = app
        .try_state::<crate::VpnPluginHandle>()
        .map(|state| state.inner().0.clone());
    let Some(plugin_handle) = plugin_handle else {
        return Err(AppError::Unsupported(
            "vpn plugin handle is not initialised on this platform".into(),
        ));
    };
    // Payload matches the Kotlin `SubscriptionFetchUrlArgs` field
    // names: gomobile-style parseArgs lowercases the first letter of
    // every declared field, so `url` / `hwid` / `deviceOs` are the
    // exact wire names. 2026-08-21.
    let payload = serde_json::json!({
        "url": url,
        "hwid": hwid,
        "deviceOs": "Android",
    });
    let response: AndroidSubscriptionFetchedBody = plugin_handle
        .run_mobile_plugin_async("subscriptionFetchUrl", payload)
        .await
        .map_err(|e| {
            // The Kotlin side rejects with precise, pre-sanitized
            // messages ("provider rejected the device HWID (HTTP
            // 403)", "provider timed out", ...). Surface them instead
            // of a generic wrapper so the UI can tell the user what
            // to actually do (e.g. pin the HWID in settings).
            log::error!("subscription fetch via Kotlin failed: {e}");
            AppError::Subscription(format!("provider fetch failed: {e}"))
        })?;
    Ok(response)
}

/// Response shape from the Kotlin `subscriptionFetchUrl` command.
/// Field names mirror the `JSObject.put("…", …)` calls on the Kotlin
/// side exactly. 2026-08-21.
#[cfg(target_os = "android")]
#[derive(Debug, serde::Deserialize)]
struct AndroidSubscriptionFetchedBody {
    body: String,
    #[serde(rename = "contentType", default)]
    content_type: Option<String>,
    #[serde(default = "default_http_status")]
    status: u16,
    /// Selected provider metadata headers (profile-title,
    /// subscription-userinfo, …) as a lowercase-name map.
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
}

#[cfg(target_os = "android")]
fn default_http_status() -> u16 {
    200
}

#[cfg(target_os = "android")]
impl AndroidSubscriptionFetchedBody {
    /// Reuse the desktop `parse_metadata` by replaying the selected
    /// headers into a `HeaderMap`.
    fn metadata(&self) -> crate::subscriptions::ProviderMetadata {
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &self.headers {
            let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) else {
                continue;
            };
            headers.insert(name, value);
        }
        crate::subscriptions::parse_metadata(&headers).unwrap_or_default()
    }
}

#[tauri::command]
pub async fn remove_subscription(app: AppHandle, id: String) -> AppResult<()> {
    let service = subscription_service(&app)?;
    service.remove(&id).await
}

#[tauri::command]
pub async fn refresh_subscription(
    app: AppHandle,
    id: String,
) -> AppResult<RefreshSubscriptionResult> {
    let service = subscription_service(&app)?;
    // Same Kotlin transport as add_subscription (see the note there):
    // the in-process reqwest ClientHello is RST by anivka.top's edge
    // on Android networks.
    #[cfg(target_os = "android")]
    {
        refresh_subscription_android(&app, service, &id).await
    }
    #[cfg(not(target_os = "android"))]
    {
        service.refresh(&id).await
    }
}

#[tauri::command]
pub async fn set_subscription_interval(
    app: AppHandle,
    id: String,
    interval_minutes: u32,
) -> AppResult<SubscriptionSummary> {
    let service = subscription_service(&app)?;
    service.set_interval(&id, interval_minutes).await
}

/// Pin the active child of a bundle subscription. The next
/// `get_active_child_config` call returns that child's full
/// engine configuration. No-op for link_list subscriptions.
/// 2026-08-20.
#[tauri::command]
pub async fn set_active_child(
    app: AppHandle,
    id: String,
    child_key: String,
) -> AppResult<SubscriptionSummary> {
    let service = subscription_service(&app)?;
    service.set_active_child(&id, &child_key).await
}

/// Return the full engine configuration of the currently selected
/// child of a bundle subscription. The mobile UI hands this JSON
/// straight to the Kotlin `vpn:start` plugin. For xray children the
/// plugin extracts `outbounds[]` and rebuilds the rest. 2026-08-20.
#[tauri::command]
pub async fn get_active_child_config(app: AppHandle, id: String) -> AppResult<ActiveChildConfig> {
    let service = subscription_service(&app)?;
    #[cfg_attr(not(target_os = "android"), allow(unused_mut))]
    let mut result = service.get_active_child_config(&id).await?;
    // Android supports both engines. Xray configs need the protected
    // dialer splice; sing-box configs are handed to the in-process libbox
    // engine and receive Android TUN fields in the Kotlin service.
    #[cfg(target_os = "android")]
    {
        use crate::subscriptions::EngineKind;
        match result.engine {
            EngineKind::Xray => {
                let parsed: serde_json::Value =
                    serde_json::from_str(&result.config).map_err(|e| {
                        AppError::Unsupported(format!("bundle config is not valid JSON: {e}"))
                    })?;
                let normalized = crate::xray_config::normalize_bundle(parsed)?;
                result.config = serde_json::to_string(&normalized).map_err(AppError::Serde)?;
            }
            EngineKind::Singbox => {
                // The Android service runs this configuration through
                // the bundled in-process libbox engine. Per-app TUN
                // fields are applied by the Kotlin service at launch.
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn migrate_legacy_subscriptions(
    app: AppHandle,
    inputs: Vec<LegacySubscriptionInput>,
) -> AppResult<SubscriptionSnapshot> {
    let service = subscription_service(&app)?;
    service.migrate_legacy(inputs).await
}

/// Return the current device HWID plus the auto/custom pair so the
/// UI can show the user what the device is sending and let them
/// paste a value from another device to override. 2026-08-20.
#[tauri::command]
pub async fn get_device_hwid(app: AppHandle) -> AppResult<super::subscriptions::DeviceHwidInfo> {
    let service = subscription_service(&app)?;
    service.describe_hwid().await
}

/// Pin the device to a specific HWID. Pass `Some(uuid)` to pin
/// (typically the value copied from another device of the same
/// user), or `None` to clear the override and go back to the
/// auto-generated per-install value. 2026-08-20.
#[tauri::command]
pub async fn set_custom_hwid(
    app: AppHandle,
    value: Option<String>,
) -> AppResult<super::subscriptions::DeviceHwidInfo> {
    let service = subscription_service(&app)?;
    service.set_custom_hwid(value).await
}

/// Regenerate the auto-generated per-install HWID. The custom
/// override (if any) is preserved, so the user can clear the
/// override afterwards and still get a fresh auto value.
#[tauri::command]
pub async fn reset_device_hwid(app: AppHandle) -> AppResult<super::subscriptions::DeviceHwidInfo> {
    let service = subscription_service(&app)?;
    service.reset_hwid().await
}
