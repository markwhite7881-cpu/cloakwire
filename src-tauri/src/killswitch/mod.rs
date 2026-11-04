//! Cross-platform Kill Switch management.

// Windows does not install kill-switch rules. Older rule names and global
// policies are shared with other installations and cannot prove ownership.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod stub;
#[cfg(not(target_os = "macos"))]
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
