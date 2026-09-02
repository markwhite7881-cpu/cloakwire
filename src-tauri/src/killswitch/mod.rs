//! Cross-platform Kill Switch management.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod stub;
#[cfg(not(any(windows, target_os = "macos")))]
pub use stub::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_succeeds_idempotently() {
        assert!(cleanup_stale_rules().is_ok());
        assert!(!is_kill_switch_armed());
    }
}
