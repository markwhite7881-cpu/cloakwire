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
