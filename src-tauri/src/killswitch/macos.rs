//! macOS Kill Switch implementation.
//!
//! On macOS, sing-box uses native `strict_route: true` on the `utun` interface.
//! This module provides the unified interface and state management.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use crate::error::AppResult;

static IS_ARMED: AtomicBool = AtomicBool::new(false);

pub fn cleanup_stale_rules() -> AppResult<()> {
    IS_ARMED.store(false, Ordering::Release);
    Ok(())
}

pub fn arm_kill_switch(_singbox_bin: Option<&Path>, _xray_bin: Option<&Path>) -> AppResult<()> {
    IS_ARMED.store(true, Ordering::Release);
    log::info!("killswitch: macOS kill switch state marked armed");
    Ok(())
}

pub fn disarm_kill_switch() -> AppResult<()> {
    cleanup_stale_rules()
}

pub fn is_kill_switch_armed() -> bool {
    IS_ARMED.load(Ordering::Acquire)
}
