//! WinINET has a single manual proxy for the current user. Each installation
//! keeps its own recovery journal; patched clients share an exclusive file lock
//! while using the proxy. A dead process automatically releases the lock.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::fs::OpenOptionsExt,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use winreg::{enums::*, types::ToRegValue, RegKey, RegValue};

// Stamp the bypass list first. Enable the listener last. Undo in reverse order.
const VALUES: [&str; 3] = ["ProxyOverride", "ProxyServer", "ProxyEnable"];
type Settings = [Option<RegValue>; 3];
static PROXY: OnceLock<WindowsProxy> = OnceLock::new();

pub(crate) fn initialize(app: &tauri::AppHandle) -> AppResult<()> {
    use tauri::Manager;
    let client = WindowsProxy::new(
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings".into(),
        format!(
            r"Software\CloakWire\{}\WinInetLease",
            app.config().identifier
        ),
        app.path()
            .local_data_dir()?
            .join("CloakWire")
            .join("wininet.lock"),
    );
    let _ = PROXY.set(client);
    Ok(())
}

pub(crate) fn apply(server: &str) -> AppResult<bool> {
    PROXY
        .get()
        .ok_or_else(|| AppError::Unsupported("system proxy owner unavailable".into()))?
        .apply(server)
}

pub(crate) fn release() -> AppResult<bool> {
    match PROXY.get() {
        Some(client) => client.release(),
        None => Ok(false),
    }
}

struct WindowsProxy {
    settings_path: String,
    owner_path: String,
    lock_path: PathBuf,
    instance_lock: Mutex<Option<File>>,
}

fn optional<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn read(key: &RegKey) -> io::Result<Settings> {
    let [a, b, c] = VALUES.map(|name| optional(key.get_raw_value(name)));
    Ok([a?, b?, c?])
}

fn write(key: &RegKey, index: usize, value: &Option<RegValue>) -> io::Result<()> {
    match value {
        Some(value) => key.set_raw_value(VALUES[index], value),
        None => optional(key.delete_value(VALUES[index])).map(|_| ()),
    }
}

#[derive(Serialize, Deserialize)]
struct Lease {
    server: String,
    bypass: String,
    // Set before a single-value switch of an active listener.
    previous_server: Option<String>,
    // Partial states are accepted only during an interrupted installation/release.
    settled: bool,
}

impl Lease {
    fn save(&self, owner: &RegKey) -> AppResult<()> {
        owner.set_value("Lease", &serde_json::to_string(self)?)?;
        Ok(())
    }
    fn applied(&self, current: &Settings) -> Settings {
        let server = self
            .previous_server
            .as_ref()
            .filter(|old| current[1] == Some(old.to_reg_value()))
            .unwrap_or(&self.server);
        [
            Some(self.bypass.to_reg_value()),
            Some(server.to_reg_value()),
            Some(1u32.to_reg_value()),
        ]
    }
}

fn phase_matches(now: &Settings, before: &Settings, applied: &Settings, phase: usize) -> bool {
    now[..phase] == applied[..phase] && now[phase..] == before[phase..]
}

// Re-check every value before each write. A foreign edit relinquishes the lease.
fn transition(
    key: &RegKey,
    before: &Settings,
    applied: &Settings,
    mut phase: usize,
    end: usize,
) -> io::Result<bool> {
    while phase_matches(&read(key)?, before, applied, phase) {
        if phase == end {
            return Ok(true);
        }
        if phase < end {
            write(key, phase, &applied[phase])?;
            phase += 1;
        } else {
            phase -= 1;
            write(key, phase, &before[phase])?;
        }
    }
    Ok(false)
}

fn conflict() -> AppError {
    AppError::Unsupported(
        "another application or Windows settings controls the system proxy".into(),
    )
}

impl WindowsProxy {
    fn new(settings_path: String, owner_path: String, lock_path: PathBuf) -> Self {
        Self {
            settings_path,
            owner_path,
            lock_path,
            instance_lock: Mutex::new(None),
        }
    }
    fn lock(&self) -> io::Result<File> {
        if let Some(parent) = self.lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&self.lock_path)
    }
    fn owner(&self) -> io::Result<Option<RegKey>> {
        optional(
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(&self.owner_path, KEY_READ | KEY_SET_VALUE),
        )
    }
    fn settings(&self) -> io::Result<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&self.settings_path, KEY_READ | KEY_SET_VALUE)
    }
    fn journal(owner: &RegKey) -> AppResult<Option<Lease>> {
        optional(owner.get_value::<String, _>("Lease"))?
            .map(|text| serde_json::from_str(&text))
            .transpose()
            .map_err(Into::into)
    }

    fn apply(&self, server: &str) -> AppResult<bool> {
        let mut held = self.instance_lock.lock().unwrap_or_else(|p| p.into_inner());
        let new_lock = if held.is_none() {
            Some(self.lock().map_err(|error| {
                if error.raw_os_error() == Some(32) {
                    conflict()
                } else {
                    error.into()
                }
            })?)
        } else {
            None
        };
        let settings = self.settings()?;
        let result = self.apply_locked(&settings, server);
        if result.is_err() {
            // Reclaim a partial write when possible; a failed cleanup keeps its journal.
            let _ = self.restore_locked();
        } else if new_lock.is_some() {
            *held = new_lock;
        }
        result
    }

    fn apply_locked(&self, settings: &RegKey, server: &str) -> AppResult<bool> {
        if let Some(owner) = self.owner()? {
            if let Some(mut lease) = Self::journal(&owner)? {
                let now = read(settings)?;
                if lease.settled && now == lease.applied(&now) {
                    if lease.server != server {
                        lease.previous_server =
                            Some(std::mem::replace(&mut lease.server, server.to_owned()));
                        lease.settled = false;
                        lease.save(&owner)?;
                        if read(settings)? != now {
                            return Err(conflict());
                        }
                        settings.set_value("ProxyServer", &server)?;
                        lease.previous_server = None;
                        lease.settled = true;
                        lease.save(&owner)?;
                    }
                    return Ok(true);
                }
            }
            drop(owner);
            self.restore_locked()?;
        }
        let before = read(settings)?;
        if before[2].is_some() && before[2] != Some(0u32.to_reg_value()) {
            return Err(conflict());
        }
        let owner = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(&self.owner_path)?
            .0;
        for (index, prior) in before.iter().enumerate() {
            write(&owner, index, prior)?;
        }
        // The unique exact hostname is reserved for loopback. It distinguishes
        // installations even when their local endpoint strings are identical.
        let mut lease = Lease {
            server: server.to_owned(),
            bypass: format!(
                "<local>;localhost;127.*;cw-{}.localhost",
                uuid::Uuid::new_v4()
            ),
            previous_server: None,
            settled: false,
        };
        lease.save(&owner)?;
        if !transition(settings, &before, &lease.applied(&before), 0, 3)? {
            return Err(conflict());
        }
        lease.settled = true;
        lease.save(&owner)?;
        Ok(true)
    }

    fn restore_locked(&self) -> AppResult<bool> {
        let Some(owner) = self.owner()? else {
            return Ok(false);
        };
        let mut changed = false;
        if let Some(mut lease) = Self::journal(&owner)? {
            let settings = self.settings()?;
            let current = read(&settings)?;
            let before = read(&owner)?;
            let applied = lease.applied(&current);
            let phase = (1..=3).rev().find(|&phase| {
                (!lease.settled || phase == 3) && phase_matches(&current, &before, &applied, phase)
            });
            if let Some(phase) = phase {
                lease.settled = false;
                lease.save(&owner)?;
                changed = transition(&settings, &before, &applied, phase, 0)?;
            }
        }
        drop(owner);
        RegKey::predef(HKEY_CURRENT_USER).delete_subkey(&self.owner_path)?;
        Ok(changed)
    }

    fn release(&self) -> AppResult<bool> {
        let mut held = self.instance_lock.lock().unwrap_or_else(|p| p.into_inner());
        if self.owner()?.is_none() {
            held.take();
            return Ok(false); // Idle startup never opens Internet Settings.
        }
        let _temporary_lock = if held.is_none() {
            match self.lock() {
                Ok(file) => Some(file),
                Err(e) if e.raw_os_error() == Some(32) => return Ok(false),
                Err(e) => return Err(e.into()),
            }
        } else {
            None
        };
        let changed = self.restore_locked()?;
        held.take();
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // A unique disposable application key; no WinINET access or notification.
    struct Fixture {
        root: String,
        key: RegKey,
        dir: tempfile::TempDir,
    }
    impl Fixture {
        fn new() -> Self {
            let root = format!(r"Software\CloakWire-Tests\{}", uuid::Uuid::new_v4());
            let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(format!(r"{}\settings", root))
                .unwrap();
            Self {
                root,
                key,
                dir: tempfile::tempdir().unwrap(),
            }
        }
        fn client(&self, channel: &str) -> WindowsProxy {
            WindowsProxy::new(
                format!(r"{}\settings", self.root),
                format!(r"{}\{}", self.root, channel),
                self.dir.path().join("wininet.lock"),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            RegKey::predef(HKEY_CURRENT_USER)
                .delete_subkey_all(&self.root)
                .unwrap();
        }
    }
    #[test]
    fn startup_preserves_foreign_proxy_and_explicit_apply_refuses_to_take_it() {
        let f = Fixture::new();
        let preview = f.client("preview");
        f.key.set_value("ProxyEnable", &1u32).unwrap();
        f.key.set_value("ProxyServer", &"127.0.0.1:9090").unwrap();
        f.key.set_value("ProxyOverride", &"*.lan").unwrap();
        assert!(!preview.release().unwrap());
        assert!(preview.apply("127.0.0.1:9090").is_err());
        assert_eq!(f.key.get_value::<u32, _>("ProxyEnable").unwrap(), 1);
        assert_eq!(
            f.key.get_value::<String, _>("ProxyServer").unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(
            f.key.get_value::<String, _>("ProxyOverride").unwrap(),
            "*.lan"
        );
    }
    #[test]
    fn separate_channel_and_live_instance_cannot_restore_another_lease() {
        let f = Fixture::new();
        let first = f.client("preview");
        f.key.set_value("ProxyServer", &"old:123").unwrap();
        f.key.set_value("ProxyOverride", &"*.lan").unwrap();
        first.apply("127.0.0.1:90").unwrap();
        assert!(!f.client("stable").release().unwrap());
        let second = f.client("preview");
        assert!(!second.release().unwrap());
        assert!(second.apply("127.0.0.1:99").is_err());
        assert!(first.apply("127.0.0.1:91").unwrap());
        drop(first); // abrupt exit: OS releases only the instance lock.
        assert!(second.release().unwrap());
        assert!(!second.release().unwrap());
        assert!(f.key.get_raw_value("ProxyEnable").is_err());
        assert_eq!(
            f.key.get_value::<String, _>("ProxyServer").unwrap(),
            "old:123"
        );
        assert_eq!(
            f.key.get_value::<String, _>("ProxyOverride").unwrap(),
            "*.lan"
        );
    }
    #[test]
    fn restores_each_interrupted_install_or_release_step() {
        for phase in 1..=3 {
            let f = Fixture::new();
            let client = f.client("preview");
            f.key.set_value("ProxyServer", &"old:123").unwrap();
            let before = read(&f.key).unwrap();
            client.apply("127.0.0.1:90").unwrap();
            let owner = client.owner().unwrap().unwrap();
            let mut lease = WindowsProxy::journal(&owner).unwrap().unwrap();
            lease.settled = false;
            lease.save(&owner).unwrap();
            // Leave exactly the values present after the first writes of a partial transition.
            for i in phase..3 {
                write(&f.key, i, &before[i]).unwrap();
            }
            drop(client);
            assert!(f.client("preview").release().unwrap());
            assert!(read(&f.key).unwrap() == before);
        }
    }
    #[test]
    fn replacing_one_setting_invalidates_the_whole_stale_lease() {
        let f = Fixture::new();
        let preview = f.client("preview");
        preview.apply("127.0.0.1:90").unwrap();
        f.key.set_value("ProxyOverride", &"stable").unwrap();
        drop(preview);
        assert!(!f.client("preview").release().unwrap());
        assert_eq!(f.key.get_value::<u32, _>("ProxyEnable").unwrap(), 1);
        assert_eq!(
            f.key.get_value::<String, _>("ProxyServer").unwrap(),
            "127.0.0.1:90"
        );
        assert_eq!(
            f.key.get_value::<String, _>("ProxyOverride").unwrap(),
            "stable"
        );
    }
}
