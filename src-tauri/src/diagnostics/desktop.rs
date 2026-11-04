//! Isolated desktop adapter. Its private core is independent of the live session.
//! Only loopback listeners and interface-bound outbound sockets; never OS routing.
use super::{
    coordinator::{ProbeCoordinator, ProbeLease},
    network::{self, PhysicalNetwork},
    owned_core::OwnedCore,
    probe_config::{prepare_singbox_probe, prepare_xray_probe},
    targets::{ProbeClient, TargetSet},
    types::{HealthIssue, HealthScope, ProbeResult},
};
use crate::subscriptions::model::EngineKind;
use serde_json::Value;
#[cfg(test)]
use std::sync::Arc;
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::Mutex,
    time::timeout,
};

pub struct DesktopProbeRequest {
    engine: EngineKind,
    binary: PathBuf,
    parent: PathBuf,
    config: Value,
    tag: String,
    network: PhysicalNetwork,
    targets: TargetSet,
    #[cfg(test)]
    fixture: bool,
    #[cfg(test)]
    loopback_wiring_only: bool,
    #[cfg(test)]
    collisions: usize,
    #[cfg(test)]
    attempts: Option<Arc<std::sync::atomic::AtomicUsize>>,
}
impl DesktopProbeRequest {
    /// Caller supplies the native-owned resolved snapshot, never an arbitrary UI
    /// executable or directory. The application cache inherits the user ACL.
    pub fn from_resolved(
        app: &tauri::AppHandle,
        engine: EngineKind,
        config: Value,
        tag: String,
        network: PhysicalNetwork,
    ) -> Result<Self, HealthIssue> {
        ensure_isolation_available(engine)?;
        use tauri::Manager;
        let binary = match engine {
            EngineKind::Singbox => crate::engine::singbox::locate_binary(app),
            EngineKind::Xray => crate::engine::xray::locate_binary(app),
        }
        .map_err(|_| HealthIssue::EngineUnavailable)?;
        let parent = app
            .path()
            .app_cache_dir()
            .map_err(|_| HealthIssue::EngineUnavailable)?
            .join("diagnostics");
        std::fs::create_dir_all(&parent).map_err(|_| HealthIssue::EngineUnavailable)?;
        Ok(Self {
            engine,
            binary,
            parent,
            config,
            tag,
            network,
            targets: TargetSet::default(),
            #[cfg(test)]
            fixture: false,
            #[cfg(test)]
            loopback_wiring_only: false,
            #[cfg(test)]
            collisions: 0,
            #[cfg(test)]
            attempts: None,
        })
    }
    #[cfg(test)]
    pub(crate) fn fixture(
        engine: EngineKind,
        binary: PathBuf,
        parent: PathBuf,
        config: Value,
        tag: String,
        network: PhysicalNetwork,
        targets: TargetSet,
    ) -> Self {
        Self {
            engine,
            binary,
            parent,
            config,
            tag,
            network,
            targets,
            fixture: true,
            loopback_wiring_only: false,
            collisions: 0,
            attempts: None,
        }
    }
    /// Deliberately test-only: exercises Xray transport/cleanup, NOT isolation.
    #[cfg(test)]
    pub(crate) fn allow_loopback_wiring_only(mut self) -> Self {
        assert!(matches!(
            self.network.interface(),
            "lo0" | "lo" | "Loopback Pseudo-Interface 1"
        ));
        assert!(self.targets.only_loopback_fixture());
        self.loopback_wiring_only = true;
        self
    }
    #[cfg(test)]
    pub(crate) fn fixture_collisions(
        mut self,
        count: usize,
    ) -> (Self, Arc<std::sync::atomic::AtomicUsize>) {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        self.collisions = count;
        self.attempts = Some(attempts.clone());
        (self, attempts)
    }
    async fn network_unchanged(&self) -> bool {
        #[cfg(test)]
        if self.fixture {
            return true;
        }
        network::discover()
            .await
            .is_ok_and(|current| current == self.network)
    }
    fn command(&self, path: &std::path::Path, check: bool) -> Command {
        let mut command = Command::new(&self.binary);
        match self.engine {
            EngineKind::Singbox => {
                command
                    .args([if check { "check" } else { "run" }, "-c"])
                    .arg(path);
            }
            EngineKind::Xray => {
                command.arg("run");
                if check {
                    command.arg("-test");
                }
                command.arg("-config").arg(path);
            }
        }
        command
    }
}
/// Bundled Xray26.3.27 logs and ignores interface-binding failures. Until
/// positive isolation is proven, ordinary Xray VPN runs remain unaffected but
/// this independent diagnostic MUST be unavailable. Never replace it with sing-box.
pub(crate) fn ensure_isolation_available(engine: EngineKind) -> Result<(), HealthIssue> {
    if engine == EngineKind::Xray {
        Err(HealthIssue::UnsupportedProbe)
    } else {
        Ok(())
    }
}
pub struct DesktopProbe;
type Owner = Mutex<Option<OwnedCore>>;
impl DesktopProbe {
    /// The coordinator owns cancellation and total deadline; cleanup retains the
    /// exact child handle even when run() is dropped in the middle of an await.
    pub async fn execute(
        coordinator: &ProbeCoordinator,
        lease: ProbeLease,
        request: DesktopProbeRequest,
    ) {
        if lease.scope() != HealthScope::SelectedProfile || lease.identity().run_id.is_some() {
            coordinator.cancel(lease.operation_id());
            return;
        }
        let owner = &coordinator.private_core;
        let work = async {
            match Self::run(request, owner).await {
                Ok(latency) => ProbeResult::healthy(latency),
                Err(issue) => ProbeResult::unavailable(issue),
            }
        };
        let cleanup = async move {
            let mut slot = owner.lock().await;
            let clean = match slot.as_mut() {
                Some(core) => core.stop(Duration::from_secs(1)).await,
                None => true,
            };
            if clean {
                slot.take();
            } else {
                // Never turn unproved cleanup into a successful report or let
                // the coordinator start another child. Its budget poisons it.
                drop(slot);
                std::future::pending::<()>().await;
            }
        };
        coordinator.execute(lease, work, cleanup).await;
    }
    async fn run(request: DesktopProbeRequest, owner: &Owner) -> Result<u64, HealthIssue> {
        #[cfg(not(test))]
        ensure_isolation_available(request.engine)?;
        #[cfg(test)]
        if !request.loopback_wiring_only {
            ensure_isolation_available(request.engine)?;
        }
        if !request.network_unchanged().await {
            return Err(HealthIssue::NetworkUnavailable);
        }
        // A port is reserved throughout config creation/check. The small release-
        // to-spawn race is bounded and additionally guarded by authentication.
        #[cfg(test)]
        let mut blockers = Vec::new();
        for _attempt in 0..3 {
            #[cfg(test)]
            if let Some(counter) = &request.attempts {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }

            let reservation = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|_| HealthIssue::EngineUnavailable)?;
            let port = reservation
                .local_addr()
                .map_err(|_| HealthIssue::EngineUnavailable)?
                .port();
            let password = uuid::Uuid::new_v4().to_string();
            let config = match request.engine {
                EngineKind::Singbox => prepare_singbox_probe(
                    &request.config,
                    &request.tag,
                    request.network.interface(),
                    port,
                    &password,
                ),
                EngineKind::Xray => prepare_xray_probe(
                    &request.config,
                    &request.tag,
                    request.network.interface(),
                    port,
                    &password,
                ),
            }?;
            let mut slot = owner.lock().await;
            if slot.is_some() {
                // A previous command was dropped before its cleanup ran.
                return Err(HealthIssue::EngineUnavailable);
            }
            *slot = Some(OwnedCore::create(&request.parent, &config)?);
            let core = slot.as_mut().ok_or(HealthIssue::EngineUnavailable)?;
            core.spawn(request.command(core.config_path(), true))?;
            if !core.wait_exit().await? {
                return Err(HealthIssue::UnsupportedProbe);
            }
            drop(reservation);
            #[cfg(test)]
            if _attempt < request.collisions {
                blockers.push(
                    TcpListener::bind(("127.0.0.1", port))
                        .await
                        .map_err(|_| HealthIssue::EngineUnavailable)?,
                );
            }
            core.spawn(request.command(core.config_path(), false))?;
            let ready = timeout(Duration::from_secs(2), async {
                loop {
                    if !core.is_alive()? {
                        core.wait_exit().await?;
                        return Ok::<bool, HealthIssue>(false);
                    }
                    if requires_proxy_auth(port).await {
                        return Ok(true);
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .map_err(|_| HealthIssue::Timeout)??;
            if !ready {
                let collision = core.address_in_use();
                if !core.stop(Duration::from_secs(1)).await {
                    return Err(HealthIssue::EngineUnavailable);
                }
                slot.take();
                if collision {
                    continue;
                }
                return Err(HealthIssue::EngineUnavailable);
            }
            drop(slot);
            let result = ProbeClient::new(port, &password)?
                .check(&request.targets)
                .await;
            let mut slot = owner.lock().await;
            let core = slot.as_mut().ok_or(HealthIssue::EngineUnavailable)?;
            if !core.is_alive()? {
                return Err(HealthIssue::EngineUnavailable);
            }
            if !request.network_unchanged().await {
                return Err(HealthIssue::NetworkUnavailable);
            }
            return result;
        }
        Err(HealthIssue::EngineUnavailable)
    }
}
/// An unrelated permissive local proxy must never produce a successful probe.
/// The authenticated client subsequently has to pass with a fresh random secret.
pub(crate) async fn requires_proxy_auth(port: u16) -> bool {
    timeout(Duration::from_millis(350),async {
        let mut stream=TcpStream::connect(("127.0.0.1",port)).await.ok()?;
        stream.write_all(b"CONNECT www.gstatic.com:443 HTTP/1.1\r\nHost: www.gstatic.com:443\r\nConnection: close\r\n\r\n").await.ok()?;
        let mut head=Vec::new();let mut byte=[0u8;1];
        while head.len()<256 {
            if stream.read(&mut byte).await.ok()?==0{return None;}
            head.push(byte[0]);if head.ends_with(b"\r\n"){break;}
        }
        let line=std::str::from_utf8(&head).ok()?;
        let fields:Vec<_>=line.split_whitespace().collect();
        Some(fields.len()>=2&&matches!(fields[0],"HTTP/1.0"|"HTTP/1.1")&&fields[1]=="407")
    }).await.ok().flatten().unwrap_or(false)
}
