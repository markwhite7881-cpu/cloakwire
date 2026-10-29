//! Platform-specific integration and elevation utilities.

pub mod macos;
#[cfg(windows)]
pub mod windows;
