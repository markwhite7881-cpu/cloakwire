//! Stub Kill Switch implementation for unsupported desktop platforms.

use std::path::Path;
use crate::error::AppResult;

pub fn cleanup_stale_rules() -> AppResult<()> {
    Ok(())
}

pub fn arm_kill_switch(_singbox_bin: Option<&Path>, _xray_bin: Option<&Path>) -> AppResult<()> {
    Ok(())
}

pub fn disarm_kill_switch() -> AppResult<()> {
    Ok(())
}

pub fn is_kill_switch_armed() -> bool {
    false
}
