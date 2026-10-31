pub mod coordinator;
pub mod sources;
#[cfg(test)]
mod tests;
pub mod types;

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn get_connection_health(
    pm: tauri::State<'_, std::sync::Arc<crate::process::ProcessManager>>,
) -> types::HealthSnapshot {
    types::HealthSnapshot {
        selected_profile: None,
        active_session: pm.diagnostics.snapshot().health,
    }
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn cancel_profile_probe(
    operation_id: String,
    pm: tauri::State<'_, std::sync::Arc<crate::process::ProcessManager>>,
) -> bool {
    pm.diagnostics.cancel(&operation_id)
}

pub mod probe_config;
#[cfg(test)]
mod probe_config_tests;

#[cfg(not(target_os = "android"))]
pub mod owned_core;
#[cfg(all(test, not(target_os = "android")))]
mod owned_core_tests;
#[cfg(not(target_os = "android"))]
pub mod targets;
#[cfg(all(test, not(target_os = "android")))]
mod targets_tests;

#[cfg(not(target_os = "android"))]
pub mod network;
#[cfg(all(test, not(target_os = "android")))]
mod network_tests;

#[cfg(not(target_os = "android"))]
pub mod desktop;
#[cfg(all(test, not(target_os = "android")))]
mod desktop_tests;

#[cfg(all(test, not(target_os = "android")))]
mod desktop_native_tests;

#[cfg(not(target_os = "android"))]
pub mod active_config;
#[cfg(all(test, not(target_os = "android")))]
mod active_config_tests;

#[cfg(not(target_os = "android"))]
pub mod issues;
#[cfg(all(test, not(target_os = "android")))]
mod issues_tests;

#[cfg(not(target_os = "android"))]
pub mod active;
#[cfg(all(test, not(target_os = "android")))]
mod active_tests;

#[cfg(all(test, not(target_os = "android")))]
mod active_native_tests;

#[cfg(all(test, not(target_os = "android")))]
mod lifecycle_tests;

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn get_connection_diagnostics(
    pm: tauri::State<'_, std::sync::Arc<crate::process::ProcessManager>>,
) -> active::DesktopHealthSnapshot {
    pm.diagnostics.snapshot()
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn retry_active_probe(
    pm: tauri::State<'_, std::sync::Arc<crate::process::ProcessManager>>,
    expected: types::SessionIdentity,
) -> Result<String, String> {
    pm.diagnostics
        .request(pm.inner().clone(), expected)
        .map_err(|_| "connection_check_stale".to_owned())
}

#[cfg(not(target_os = "android"))]
pub mod network_events;
