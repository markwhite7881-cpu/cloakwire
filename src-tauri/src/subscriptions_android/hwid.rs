//! Hardware-ID store.
//!
//! Some providers (anivka.top and similar) want a stable per-install
//! identifier so they can enforce a device limit. We persist a random
//! UUID v4 in `<data_dir>/subscription-hwid` and send it as the
//! `X-HWID` header on every subscription fetch. The user can rotate it
//! via `reset_device_hwid`; the next fetch uses a new value.
//!
//! The user can also pin the HWID to a value they paste from another
//! device (e.g. a Cloakwire PC install of theirs) via
//! `set_custom_hwid`. This is the right way to share a single
//! anivka-style subscription between two devices: the user pastes the
//! HWID from the device that already registered the URL with the
//! provider, and from then on this device sends that exact value
//! instead of its auto-generated one. The custom value is stored in
//! the same file as the auto-generated one and supersedes it; clearing
//! it (`set_custom_hwid(None)`) reverts to the auto-generated value.
//!
//! Persistence is atomic: write to `<file>.tmp.<uuid>` and rename. If
//! the rename fails, the old file is preserved (the next read returns
//! the previous value).

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::{Uuid, Version};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredHwid {
    /// The auto-generated per-install UUID. Created on first read
    /// and never changed by `set_custom_hwid` — only by `reset_hwid`.
    /// `Option` so that a freshly-installed app (no file yet) does
    /// not fail to deserialise.
    #[serde(default)]
    auto: Option<Uuid>,
    /// Optional user-pinned override. When set, `get_or_create`
    /// returns this value verbatim. When `None`, the auto value is
    /// returned. 2026-08-20.
    #[serde(default)]
    custom: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct HwidStore {
    path: PathBuf,
}

impl HwidStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The HWID that should be sent on the next subscription fetch.
    /// - If the user has pinned a custom value via `set_custom_hwid`,
    ///   that value wins (regardless of whether an auto UUID exists).
    /// - Otherwise the auto UUID is returned, generating one on the
    ///   fly if the file is missing.
    pub fn get_or_create(&self) -> AppResult<Uuid> {
        let stored = self.read_or_default()?;
        if let Some(custom) = stored.custom {
            return Ok(custom);
        }
        if let Some(auto) = stored.auto {
            return Ok(auto);
        }
        let auto = Uuid::new_v4();
        let next = StoredHwid {
            auto: Some(auto),
            custom: stored.custom,
        };
        self.write_atomic(&next)?;
        Ok(auto)
    }

    /// Force-regenerate the auto UUID. The custom override (if any)
    /// is preserved. The new auto value is written and returned.
    pub fn reset(&self) -> AppResult<Uuid> {
        let mut stored = self.read_or_default()?;
        let new_auto = Uuid::new_v4();
        stored.auto = Some(new_auto);
        self.write_atomic(&stored)?;
        Ok(new_auto)
    }

    /// Set the custom HWID override. Passing `Some(uuid)` pins the
    /// device to that value; passing `None` clears the override
    /// (the next call to `get_or_create` returns the auto UUID).
    /// Persists immediately so the change survives restarts.
    pub fn set_custom(&self, value: Option<Uuid>) -> AppResult<()> {
        let mut stored = self.read_or_default()?;
        // Make sure there is an auto UUID even when we are pinning
        // a custom value, so that clearing the override later
        // returns a stable value.
        if stored.auto.is_none() {
            stored.auto = Some(Uuid::new_v4());
        }
        stored.custom = value;
        self.write_atomic(&stored)
    }

    /// Returns `(current_effective, auto, custom)`. The first value
    /// is what `get_or_create` would return right now. The auto and
    /// custom values let the UI show the user what the device is
    /// sending and what the underlying "real" identity is.
    pub fn describe(&self) -> AppResult<HwidDescription> {
        // Use `get_or_create` (not a synthesised in-memory UUID) so the
        // value the UI shows is the SAME value the next fetch will
        // send. Without this, a fresh install that hits `describe`
        // before any `get_or_create` call would see one UUID in the
        // settings screen and a different one on the wire. 2026-08-21.
        let effective = self.get_or_create()?;
        let stored = self.read_or_default()?;
        Ok(HwidDescription {
            effective,
            auto: stored.auto,
            custom: stored.custom,
        })
    }

    fn read_or_default(&self) -> AppResult<StoredHwid> {
        match fs::read_to_string(&self.path) {
            Ok(value) if !value.trim().is_empty() => {
                match serde_json::from_str::<StoredHwid>(&value) {
                    Ok(stored) => {
                        // Sanity-check the parsed values: garbage UUIDs
                        // (e.g. left by an older release) are silently dropped
                        // so the next `get_or_create` regenerates.
                        Ok(StoredHwid {
                            auto: stored.auto.filter(|uuid| is_v4(*uuid)),
                            custom: stored.custom.filter(|uuid| is_v4(*uuid)),
                        })
                    }
                    // Fallback: the PC install of Cloakwire writes a raw
                    // UUID string (not a JSON object) to this file. A
                    // mobile user who copies their data dir from PC would
                    // otherwise hit a hard error on every fetch. Treat a
                    // bare v4 UUID as a valid `auto` value; on the next
                    // `write_atomic` the file will be rewritten as proper
                    // JSON. 2026-08-21.
                    Err(_) => match Uuid::parse_str(value.trim()) {
                        Ok(uuid) if is_v4(uuid) => Ok(StoredHwid {
                            auto: Some(uuid),
                            custom: None,
                        }),
                        Ok(_) | Err(_) => Ok(StoredHwid::default()),
                    },
                }
            }
            Ok(_) => Ok(StoredHwid::default()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(StoredHwid::default()),
            Err(error) => Err(error.into()),
        }
    }

    fn write_atomic(&self, stored: &StoredHwid) -> AppResult<()> {
        ensure_parent(&self.path)?;
        let temporary_path = temporary_path(&self.path)?;
        let result = (|| -> AppResult<()> {
            let body = serde_json::to_string_pretty(stored)
                .map_err(|e| AppError::Validation(format!("HWID serialise failed: {e}")))?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)?;
            file.write_all(body.as_bytes())?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary_path, &self.path)?;
            Ok(())
        })();

        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HwidDescription {
    /// What the next fetch will actually send.
    pub effective: Uuid,
    /// The auto-generated per-install UUID (None if it has not been
    /// generated yet).
    pub auto: Option<Uuid>,
    /// The user-pinned override (None if the override is cleared).
    pub custom: Option<Uuid>,
}

fn is_v4(uuid: Uuid) -> bool {
    uuid.get_version() == Some(Version::Random)
}

fn ensure_parent(path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn temporary_path(path: &Path) -> AppResult<PathBuf> {
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::Validation("HWID path has no file name".into()))?
        .to_string_lossy();
    Ok(path.with_file_name(format!("{file_name}.{}.tmp", Uuid::new_v4())))
}
