pub mod coordinator;
#[cfg(test)]
mod tests;
pub mod types;

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn get_connection_health(
    coordinator: tauri::State<'_, coordinator::ProbeCoordinator>,
) -> types::HealthSnapshot {
    coordinator.snapshot()
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn cancel_profile_probe(
    operation_id: String,
    coordinator: tauri::State<'_, coordinator::ProbeCoordinator>,
) -> bool {
    coordinator.cancel(&operation_id)
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
