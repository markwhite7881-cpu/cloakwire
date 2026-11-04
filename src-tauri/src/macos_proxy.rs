//! Journal per-service settings before networksetup enables them. A process
//! crash releases the OS lock but preserves the installation's recovery record.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    net::{IpAddr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
enum Kind {
    Http,
    Https,
    Socks,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Http => "webproxy",
            Self::Https => "securewebproxy",
            Self::Socks => "socksfirewallproxy",
        }
    }
}
const KINDS: [Kind; 3] = [Kind::Http, Kind::Https, Kind::Socks];
#[derive(PartialEq, Serialize, Deserialize)]
struct Endpoint {
    host: String,
    port: u16,
}
#[derive(PartialEq, Serialize, Deserialize)]
struct Owned {
    service: String,
    kind: Kind,
    endpoint: Endpoint,
}

struct MacProxy {
    journal: PathBuf,
    lock: PathBuf,
    held: Mutex<Option<File>>,
}
impl MacProxy {
    fn new(journal: PathBuf, lock: PathBuf) -> Self {
        Self {
            journal,
            lock,
            held: Mutex::new(None),
        }
    }
    fn load(&self) -> AppResult<Vec<Owned>> {
        match std::fs::read(&self.journal) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }
    fn save(&self, entries: &[Owned]) -> AppResult<()> {
        if entries.is_empty() {
            match std::fs::remove_file(&self.journal) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                result => result?,
            }
        } else {
            if let Some(parent) = self.journal.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = self.journal.with_extension("tmp");
            let mut file = File::create(&tmp)?;
            file.write_all(&serde_json::to_vec(entries)?)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(tmp, &self.journal)?;
        }
        Ok(())
    }
    fn apply(
        &self,
        host: &str,
        http: u16,
        socks: u16,
        run: impl Fn(&[&str]) -> AppResult<String>,
    ) -> AppResult<()> {
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        // A temporary guard is dropped on every early failure, including
        // unreadable journals and failed startup recovery.
        let fresh = if held.is_none() {
            Some(lock_file(&self.lock)?)
        } else {
            None
        };
        let mut owned = self.load()?;
        if fresh.is_some() {
            self.restore(&mut owned, &run, true)?;
        }
        let mut attempted = false;
        let result = (|| {
            let services = run(&["-listallnetworkservices"])?;
            let mut count = 0;
            for service in services
                .lines()
                .skip(1)
                .filter(|s| !s.trim().is_empty() && !s.starts_with('*'))
            {
                // An enabled foreign facility protects the entire service. Never
                // install HTTP/SOCKS next to somebody else's HTTPS proxy.
                if !KINDS.iter().all(|&kind| match get(&run, service, kind) {
                    Ok((false, _)) => true,
                    Ok((true, Some(endpoint))) => owned.iter().any(|entry| {
                        entry.service == service && entry.kind == kind && entry.endpoint == endpoint
                    }),
                    _ => false,
                }) {
                    continue;
                }
                for kind in KINDS {
                    let port = if kind == Kind::Socks { socks } else { http };
                    let entry = Owned {
                        service: service.into(),
                        kind,
                        endpoint: Endpoint {
                            host: host.into(),
                            port,
                        },
                    };
                    attempted = true;
                    if !owned.contains(&entry) {
                        // Keep the old endpoint too until the new value is applied.
                        owned.push(entry);
                        self.save(&owned)?;
                    }
                    let name = kind.name();
                    run(&[&format!("-set{name}"), service, host, &port.to_string()])?;
                    run(&[&format!("-set{name}state"), service, "on"])?;
                    owned.retain(|old| {
                        old.service != service
                            || old.kind != kind
                            || (old.endpoint.host == host && old.endpoint.port == port)
                    });
                    self.save(&owned)?;
                }
                count += 1;
            }
            if count == 0 {
                return Err(AppError::Unsupported(
                    "no available network service proxy".into(),
                ));
            }
            Ok(())
        })();
        if result.is_err() && attempted {
            // Roll back immediately, retaining journal entries only if their
            // owned OS settings could not yet be inspected or reverted.
            if let Err(error) = self.restore(&mut owned, &run, false) {
                log::warn!("could not fully roll back service proxies: {error}");
            }
        }
        if owned.is_empty() {
            held.take();
        } else if fresh.is_some() {
            *held = fresh;
        }
        result
    }

    fn restore(
        &self,
        owned: &mut Vec<Owned>,
        run: &impl Fn(&[&str]) -> AppResult<String>,
        stale: bool,
    ) -> AppResult<()> {
        let mut failure = None;
        owned.retain(|entry| {
            match get(run, &entry.service, entry.kind) {
                Ok((true, Some(endpoint))) if entry.endpoint == endpoint => {
                    // Another application can reuse a standard local port after
                    // a crash. A live/unverifiable endpoint forfeits this claim.
                    if stale && !vacant_loopback(&endpoint) {
                        return false;
                    }
                    if let Err(error) = run(&[
                        &format!("-set{}state", entry.kind.name()),
                        &entry.service,
                        "off",
                    ]) {
                        failure = Some(error);
                        return true;
                    }
                }
                Err(error) => {
                    failure = Some(error);
                    return true;
                }
                _ => {}
            }
            false
        });
        self.save(owned)?;
        failure.map_or(Ok(()), Err)
    }

    fn clear(&self, run: impl Fn(&[&str]) -> AppResult<String>) -> AppResult<()> {
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        if self.load()?.is_empty() {
            held.take();
            return Ok(());
        }
        let stale_lock = if held.is_none() {
            match lock_file(&self.lock) {
                Ok(file) => Some(file),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.raw_os_error() == Some(32) => {
                    return Ok(())
                }
                Err(e) => return Err(e.into()),
            }
        } else {
            None
        };
        let mut owned = self.load()?;
        let result = self.restore(&mut owned, &run, stale_lock.is_some());
        if owned.is_empty() {
            held.take();
        }
        result
    }
}

fn vacant_loopback(endpoint: &Endpoint) -> bool {
    let Ok(ip) = endpoint.host.parse::<IpAddr>() else {
        return false;
    };
    // Binding proves exclusivity immediately, also when the host silently
    // drops SYN packets instead of returning ECONNREFUSED for a closed port.
    ip.is_loopback() && TcpListener::bind(SocketAddr::new(ip, endpoint.port)).is_ok()
}

fn lock_file(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        // LOCK_EX | LOCK_NB. This open file owns the advisory lock until close.
        if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(file)
}

fn get(
    run: &impl Fn(&[&str]) -> AppResult<String>,
    service: &str,
    kind: Kind,
) -> AppResult<(bool, Option<Endpoint>)> {
    let output = run(&[&format!("-get{}", kind.name()), service])?;
    let field = |label| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(label))
            .map(str::trim)
    };
    match field("Enabled:") {
        Some("No") => Ok((false, None)),
        Some("Yes") => {
            let endpoint = field("Server:")
                .zip(field("Port:").and_then(|s| s.parse::<u16>().ok()))
                .map(|(host, port)| Endpoint {
                    host: host.into(),
                    port,
                });
            Ok((true, endpoint))
        }
        _ => Err(AppError::Unsupported(
            "could not inspect service proxy".into(),
        )),
    }
}

#[cfg(target_os = "macos")]
static PROXY: std::sync::OnceLock<MacProxy> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
pub(crate) fn initialize(app: &tauri::AppHandle) -> AppResult<()> {
    use tauri::Manager;
    let _ = PROXY.set(MacProxy::new(
        app.path()
            .app_local_data_dir()?
            .join("network-service-proxies.json"),
        app.path()
            .local_data_dir()?
            .join("CloakWire")
            .join("networksetup.lock"),
    ));
    clear()
}

#[cfg(all(target_os = "macos", not(test)))]
fn networksetup(args: &[&str]) -> AppResult<String> {
    let output = std::process::Command::new("/usr/sbin/networksetup")
        .env("LC_ALL", "C")
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(AppError::Unsupported(format!(
            "networksetup {} failed",
            args[0]
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(all(target_os = "macos", test))]
fn networksetup(_: &[&str]) -> AppResult<String> {
    Err(AppError::Unsupported(
        "networksetup disabled in the test harness".into(),
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn apply(host: &str, http: u16, socks: u16) -> AppResult<()> {
    PROXY
        .get()
        .ok_or_else(|| AppError::Unsupported("system proxy owner unavailable".into()))?
        .apply(host, http, socks, networksetup)
}

#[cfg(target_os = "macos")]
pub(crate) fn clear() -> AppResult<()> {
    match PROXY.get() {
        Some(proxy) => proxy.clear(networksetup),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    #[derive(Default)]
    struct Network(RefCell<HashMap<String, (String, u16, bool)>>);
    impl Network {
        fn run(&self, args: &[&str]) -> AppResult<String> {
            let mut state = self.0.borrow_mut();
            match args {
                ["-listallnetworkservices"] => Ok("legend\nWi-Fi\n*disabled".into()),
                [get, "Wi-Fi"] => {
                    let kind = get.strip_prefix("-get").unwrap();
                    Ok(match state.get(kind) {
                        Some((host, port, true)) => {
                            format!("Enabled: Yes\nServer: {host}\nPort: {port}")
                        }
                        _ => "Enabled: No\nServer: \nPort: 0".into(),
                    })
                }
                [set, "Wi-Fi", host, port] => {
                    state.insert(
                        set.trim_start_matches("-set").into(),
                        (host.to_string(), port.parse().unwrap(), true),
                    );
                    Ok(String::new())
                }
                [set, "Wi-Fi", toggle] => {
                    state
                        .get_mut(set.trim_start_matches("-set").trim_end_matches("state"))
                        .unwrap()
                        .2 = *toggle == "on";
                    Ok(String::new())
                }
                _ => panic!("unexpected networksetup arguments"),
            }
        }
    }

    #[test]
    fn idle_exit_and_foreign_service_are_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let proxy = MacProxy::new(temp.path().join("journal"), temp.path().join("lock"));
        proxy.clear(|_| panic!("unowned cleanup")).unwrap();
        let network = Network::default();
        network
            .0
            .borrow_mut()
            .insert("securewebproxy".into(), ("elsewhere".into(), 81, true));
        assert!(proxy
            .apply("127.0.0.1", 80, 81, |a| network.run(a))
            .is_err());
        assert_eq!(network.0.borrow().len(), 1);
    }
    #[test]
    fn failed_second_protocol_rolls_back_the_first_and_releases_lock() {
        let temp = tempfile::tempdir().unwrap();
        let client = || MacProxy::new(temp.path().join("journal"), temp.path().join("lock"));
        let network = Network::default();
        let first = client();
        assert!(first
            .apply("127.0.0.1", 80, 81, |args| {
                if args[0] == "-setsecurewebproxy" {
                    return Err(AppError::Unsupported("fixture failure".into()));
                }
                network.run(args)
            })
            .is_err());
        assert!(
            !network.0.borrow()["webproxy"].2,
            "partial service was left enabled"
        );
        assert!(first.load().unwrap().is_empty());
        client()
            .apply("127.0.0.1", 82, 83, |args| network.run(args))
            .unwrap();
    }

    #[test]
    fn live_instance_is_protected_and_crash_recovers_only_exact_dead_endpoints() {
        let temp = tempfile::tempdir().unwrap();
        let client = || MacProxy::new(temp.path().join("journal"), temp.path().join("lock"));
        let network = Network::default();
        let first = client();
        let live = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = socket.local_addr().unwrap().port();
        drop(socket);
        let port = live.local_addr().unwrap().port();
        first
            .apply("127.0.0.1", dead, port, |a| network.run(a))
            .unwrap();
        client().clear(|_| panic!("live instance")).unwrap();
        network.0.borrow_mut().get_mut("webproxy").unwrap().0 = "replaced".into();
        drop(first);
        client().clear(|a| network.run(a)).unwrap();
        let state = network.0.borrow();
        assert!(state["webproxy"].2);
        assert!(!state["securewebproxy"].2);
        assert!(state["socksfirewallproxy"].2);
    }
}
