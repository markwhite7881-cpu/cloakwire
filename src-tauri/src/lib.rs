//! Cloakwire library entry point.
//!
//! `main.rs` is a thin wrapper that calls `run()` from this crate. The
//! split makes it possible to add a `cdylib` target later for mobile
//! builds without touching the binary entry point.

// Force-rebuild marker: tauri::generate_context!() embeds dist/ at lib
// compile time. Touching this file makes cargo recompile the lib, which
// re-runs the macro and re-embeds the current dist/ (after every
// `npm run build`). 2026-08-20 21:21 (getSubscriptionOutbounds + UI real proto).

use std::sync::Arc;

use tauri::Manager;
#[cfg(not(target_os = "android"))]
use tauri_plugin_autostart::MacosLauncher;

// Desktop-only subsystems. On Android both VPN engines are owned by
// the Kotlin VpnService (in-process libbox or the Xray sidecar), so the
// desktop process manager, Clash polling, updater and system-proxy modules
// are not compiled into the Android .so.
#[cfg(not(target_os = "android"))]
pub mod app_update;
#[cfg(not(target_os = "android"))]
pub mod clash_api;
#[cfg(not(target_os = "android"))]
pub mod commands;
#[cfg(target_os = "android")]
#[path = "commands_android.rs"]
pub mod commands;
pub mod config;
#[cfg(not(target_os = "android"))]
pub mod engine;
pub mod error;
pub mod parser;
#[cfg(not(target_os = "android"))]
pub mod process;
#[cfg(not(target_os = "android"))]
#[path = "subscriptions/mod.rs"]
pub mod subscriptions;
#[cfg(target_os = "android")]
#[path = "subscriptions_android/mod.rs"]
pub mod subscriptions;
#[cfg(not(target_os = "android"))]
pub mod traffic;
#[cfg(not(target_os = "android"))]
pub mod updates;
#[cfg(not(target_os = "android"))]
pub mod xray;
pub mod xray_config;

#[cfg(not(target_os = "android"))]
use process::ProcessManager;
use subscriptions::{HwidStore, SubscriptionHttpClient, SubscriptionService, SubscriptionStore};

/// Registers the app-local Kotlin VPN plugin (`ru.classquiz.singbox
/// .VpnPlugin`). The plugin name "vpn" is what the frontend uses:
/// `invoke("plugin:vpn|start", ...)` / `addPluginListener("vpn", ...)`.
///
/// On Android the returned `PluginHandle` is what the Rust
/// `add_subscription` command uses to dispatch the
/// `subscriptionFetchUrl` IPC call back into Kotlin (the
/// `reqwest`+`rustls-tls` path produces a ClientHello that
/// anivka.top's edge rejects — see [crate::commands::add_subscription]).
/// We park the handle in a managed state so any later command can
/// reach it; commands that don't need it (everything except the
/// Android subscription path) simply ignore the state. 2026-08-21.
#[cfg(target_os = "android")]
fn vpn_mobile_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("vpn")
        .setup(|app, api| {
            let handle = api.register_android_plugin("ru.classquiz.singbox.vpn", "VpnPlugin")?;
            // Stash the handle so `add_subscription` (and any future
            // command that needs to bridge into Kotlin) can call
            // `run_mobile_plugin_async` on it. Tauri only allows one
            // managed value per type, so we wrap in a newtype to
            // avoid colliding with the subscription service state.
            // 2026-08-21.
            app.manage(VpnPluginHandle(handle));
            Ok(())
        })
        .build()
}

/// Marker newtype around the Android `PluginHandle` so it can be
/// stored in Tauri's managed state without colliding with the
/// subscription service. 2026-08-21.
#[cfg(target_os = "android")]
pub struct VpnPluginHandle(pub tauri::plugin::PluginHandle<tauri::Wry>);

/// Resolve the directory the subscription service should live under
/// for this app. Tauri exposes `app_data_dir()` on every platform
/// (desktop: `%APPDATA%/Cloakwire/`, Android: `Context.dataDir`). The
/// store and the HWID both sit in this directory.
fn subscription_data_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<std::path::PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| tauri::Error::from(anyhow::anyhow!(e.to_string())))?;
    Ok(base.join("subscriptions"))
}

fn init_subscription_service<R: tauri::Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    let dir = subscription_data_dir(app.handle())?;
    std::fs::create_dir_all(&dir).map_err(tauri::Error::from)?;
    let store = SubscriptionStore::new(dir.join("subscriptions.v1.json"));
    let hwid = HwidStore::new(dir.join("subscription-hwid"));
    let http = SubscriptionHttpClient::new()
        .map_err(|e| tauri::Error::from(anyhow::anyhow!(e.to_string())))?;
    // Tauri 2 exposes the package version via `app.package_info()`. We
    // fall back to a hard-coded string on the off chance the runtime
    // is built without a `version` field (shouldn't happen — `tauri
    // build` always sets it from tauri.conf.json).
    let version = app.package_info().version.to_string();
    let service = SubscriptionService::new(store, hwid, http, version);
    app.manage(Arc::new(service));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Best-effort logger init. RUST_LOG=info turns it on by default.
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,cloakwire_lib=debug"),
    )
    .try_init();

    #[cfg(not(target_os = "android"))]
    let manager = Arc::new(ProcessManager::new());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    // Desktop-only plugins: process relaunch, shell updater and
    // autostart. On Android the core runs inside the Kotlin
    // VpnService (libbox) and these plugins aren't even compiled in.
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // Forward the `--minimized` flag (no-op on Windows/Linux)
            // so the user can opt into starting in the background.
            Some(vec!["--minimized"]),
        ));
    #[cfg(target_os = "android")]
    let builder = builder.plugin(vpn_mobile_plugin());
    #[cfg(not(target_os = "android"))]
    let builder = builder.manage(manager);
    let builder = builder.setup(|app| {
        // We're now inside Tauri's tokio runtime, safe to spawn.
        #[cfg(not(target_os = "android"))]
        {
            let mgr = app.state::<Arc<ProcessManager>>();
            let mgr = Arc::clone(mgr.inner());
            mgr.spawn_watcher();
        }
        // Make sure the main window is visible and focused.
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
        }
        // Stale-proxy guard: if a previous run of this app crashed while
        // the system proxy was active, the OS would keep routing
        // traffic to 127.0.0.1:<port> even though sing-box is dead.
        // Clear it on startup so the user has working internet
        // immediately, even before they hit "Connect".
        #[cfg(any(windows, target_os = "macos"))]
        {
            use crate::process::clear_system_proxy;
            if let Err(e) = clear_system_proxy() {
                log::warn!("startup: failed to clear stale system proxy: {e}");
            } else {
                log::info!("startup: cleared any stale system proxy from a previous run");
            }
        }

        // Initialise the subscription service. On every platform the
        // store lives under `<data_dir>/subscriptions.v1.json`; the
        // HWID lives next to it. The version string is used in the
        // User-Agent the fetcher sends to providers.
        if let Err(e) = init_subscription_service(app) {
            log::error!("failed to initialise subscription service: {e}");
        }

        Ok(())
    });
    // Two platform-specific command surfaces. Android delegates both
    // engines to the Kotlin VpnService and does not register desktop
    // process-manager, Clash API or updater commands. The subscription
    // suite, link parser and config generators are shared by both
    // platforms. Each platform compiles exactly one command chain.
    #[cfg(target_os = "android")]
    builder
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::write_default_config,
            commands::parse_link,
            commands::parse_links,
            commands::parse_input,
            commands::outbound_to_singbox_json,
            commands::generate_config,
            commands::generate_xray_config,
            commands::generate_xray_test_config,
            commands::save_config_to_path,
            commands::ping_endpoint,
            commands::lookup_geoip,
            commands::get_autostart,
            commands::set_autostart,
            commands::list_subscriptions,
            commands::get_subscription_outbounds,
            commands::add_subscription,
            commands::remove_subscription,
            commands::refresh_subscription,
            commands::set_subscription_interval,
            commands::migrate_legacy_subscriptions,
            commands::get_device_hwid,
            commands::set_custom_hwid,
            commands::reset_device_hwid,
            commands::set_active_child,
            commands::get_active_child_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running singbox-client");

    #[cfg(not(target_os = "android"))]
    builder
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_binary_info,
            commands::get_singbox_version,
            commands::get_xray_version,
            commands::check_config,
            commands::start_singbox,
            commands::start_connection,
            commands::start_managed_singbox,
            commands::start_ready_profile,
            commands::get_ready_profile_metadata,
            commands::stop_singbox,
            commands::stop_connection,
            commands::get_status,
            commands::get_logs,
            commands::is_running,
            commands::get_current_config,
            commands::write_default_config,
            commands::reset_state,
            commands::parse_link,
            commands::parse_links,
            commands::parse_input,
            commands::outbound_to_singbox_json,
            commands::generate_config,
            commands::save_config_to_path,
            commands::check_config_with_binary,
            commands::start_singbox_with_config,
            commands::list_proxies,
            commands::select_proxy,
            commands::test_delay,
            commands::ping_endpoint,
            commands::lookup_geoip,
            commands::start_traffic,
            commands::stop_traffic,
            commands::get_autostart,
            commands::set_autostart,
            commands::apply_system_proxy,
            commands::clear_system_proxy,
            commands::list_processes,
            commands::check_singbox_update,
            commands::apply_singbox_update,
            commands::check_app_update,
            commands::install_app_update,
            commands::list_subscriptions,
            commands::get_subscription_outbounds,
            commands::add_subscription,
            commands::remove_subscription,
            commands::refresh_subscription,
            commands::set_subscription_interval,
            commands::select_subscription_child,
            commands::migrate_legacy_subscriptions,
            commands::get_subscription_hwid,
            commands::set_subscription_hwid,
            commands::reset_subscription_hwid,
            commands::get_device_hwid,
            commands::set_custom_hwid,
            commands::reset_device_hwid,
            commands::set_active_child,
        ])
        .run(tauri::generate_context!())
        .expect("error while running singbox-client");
}
