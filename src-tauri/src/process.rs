//! sing-box process lifecycle management.
//!
//! Responsibilities:
//! - Locate the bundled sidecar binary (dev + release).
//! - Spawn it with a config file, capture stdout/stderr to a ring buffer.
//! - Health-check loop, automatic restart on unexpected exit (configurable).
//! - Graceful shutdown (SIGTERM on Unix, taskkill on Windows).
//!
//! Why not tauri_plugin_shell's sidecar API?
//!   We need full control over stdin/stdout (live log streaming) and a
//!   child handle we can hold across commands. tokio::process gives us
//!   that with no extra ceremony.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
#[cfg(test)]
use tokio::task::JoinHandle;

use crate::engine::{EngineKind, LaunchSpec};
use crate::error::{AppError, AppResult};
use crate::traffic::TrafficStream;
use crate::xray::stats::{XrayStatsSpec, XrayStatsStream};

const LOG_BUFFER_CAPACITY: usize = 2000;
const DEFAULT_TERMINATE_TIMEOUT: Duration = Duration::from_secs(5);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(3);

/// One log line from sing-box's stdout/stderr.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub ts: chrono::DateTime<chrono::Utc>,
    pub stream: LogStream,
    pub line: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Stopped,
    Starting,
    Running,
    Crashed,
    Stopping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusReport {
    pub status: Status,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub last_exit_code: Option<i32>,
    pub last_error: Option<String>,
    pub engine: Option<EngineKind>,
    pub profile_key: Option<String>,
    pub profile_name: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
}

impl Default for StatusReport {
    fn default() -> Self {
        Self {
            status: Status::Stopped,
            pid: None,
            uptime_secs: None,
            last_exit_code: None,
            last_error: None,
            engine: None,
            profile_key: None,
            profile_name: None,
            run_id: None,
        }
    }
}

/// A child handle paired with the launch generation that owns it.
struct ChildSlot {
    run_id: u64,
    child: Child,
}

#[cfg(test)]
#[derive(Default)]
struct XrayTestState {
    run_id: Option<u64>,
    starts: usize,
    emits: usize,
    events: Vec<&'static str>,
}

/// Cancel an abandoned optional startup without ever touching a newer run.
struct PendingDiagnosticStart {
    manager: std::sync::Weak<ProcessManager>,
    run: u64,
    finished: bool,
}
impl PendingDiagnosticStart {
    fn finish(mut self) {
        self.finished = true;
        if let Some(manager) = self.manager.upgrade() {
            let _ = manager.pending_diagnostic_start.compare_exchange(
                self.run,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }
}
impl Drop for PendingDiagnosticStart {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let Some(manager) = self.manager.upgrade() else {
            return;
        };
        let run = self.run;
        // Keep the watcher excluded until owned cleanup has reaped the child.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _transition = manager.acquire_transition().await;
                let _ = manager.discard_starting_child(run).await;
                let _ = manager.pending_diagnostic_start.compare_exchange(
                    run,
                    0,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
            });
        }
    }
}

/// Centralised state shared across Tauri commands.
pub struct ProcessManager {
    pub diagnostics: Arc<crate::diagnostics::active::SessionDiagnostics>,
    pub recovery: Arc<crate::recovery::coordinator::RecoveryCoordinator>,
    /// Currently running child process, if any.
    child: Mutex<Option<ChildSlot>>,
    pending_diagnostic_start: AtomicU64,
    /// Auxiliary child process (e.g. sing-box TUN forwarder when running Xray).
    aux_child: Mutex<Option<ChildSlot>>,
    /// Ring buffer of recent log lines.
    logs: Mutex<VecDeque<LogLine>>,
    /// Current snapshot used by the frontend.
    status: Mutex<StatusReport>,
    /// When the current process started.
    started_at: Mutex<Option<std::time::Instant>>,
    /// Config path the running process was started with.
    current_config: Mutex<Option<PathBuf>>,
    /// Auxiliary config path (e.g. sing-box TUN forwarder config when running Xray).
    aux_config: Mutex<Option<PathBuf>>,
    /// URL of the Clash API (if any). Set when start() is called.
    controller_url: Mutex<Option<String>>,
    /// Monotonically increasing ID for each launch attempt.
    next_run_id: AtomicU64,
    /// Invalidates pending profile checks on Stop or a newer connection request.
    ready_check_epoch: AtomicU64,
    ready_catalog_epoch: AtomicU64,
    source_catalog: Arc<crate::diagnostics::sources::SourceCatalog>,
    /// ID currently allowed to mutate runtime state; zero means no active run.
    active_run_id: Arc<AtomicU64>,
    /// Run generation currently owning Xray telemetry, or zero when idle.
    xray_stats_run_id: AtomicU64,
    /// Serializes every public API, traffic, and lifecycle transition. Owned
    /// semaphore permits may cross I/O awaits without holding a mutex guard.
    transition: Arc<Semaphore>,
    /// Live traffic WebSocket reader. Started automatically when
    /// `controller_url` is set, stopped when the process exits.
    traffic: Arc<TrafficStream>,
    /// Private Xray StatsService owner; never exposed through command results.
    xray_stats: Arc<XrayStatsStream>,
    /// Test-only observable ownership seam for lifecycle assertions.
    #[cfg(test)]
    xray_test_state: Mutex<XrayTestState>,
    /// Test-only ownership of spawned stdout/stderr tasks, so tests can await
    /// EOF without relying on lifecycle watcher timing.
    #[cfg(test)]
    stdio_readers: Mutex<Vec<JoinHandle<()>>>,
    /// Configured Kill Switch behavior.
    kill_switch_mode: Mutex<crate::config::KillSwitchMode>,
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::with_catalog(crate::diagnostics::sources::app_catalog().clone())
    }
}

impl ProcessManager {
    pub(crate) fn with_catalog(
        source_catalog: Arc<crate::diagnostics::sources::SourceCatalog>,
    ) -> Self {
        Self {
            diagnostics: Arc::new(crate::diagnostics::active::SessionDiagnostics::default()),
            recovery: Arc::new(crate::recovery::coordinator::RecoveryCoordinator::default()),
            child: Mutex::new(None),
            pending_diagnostic_start: AtomicU64::new(0),
            aux_child: Mutex::new(None),
            logs: Mutex::new(VecDeque::with_capacity(LOG_BUFFER_CAPACITY)),
            status: Mutex::new(StatusReport::default()),
            started_at: Mutex::new(None),
            current_config: Mutex::new(None),
            aux_config: Mutex::new(None),
            controller_url: Mutex::new(None),
            next_run_id: AtomicU64::new(0),
            ready_check_epoch: AtomicU64::new(0),
            ready_catalog_epoch: AtomicU64::new(source_catalog.epoch()),
            source_catalog,
            active_run_id: Arc::new(AtomicU64::new(0)),
            xray_stats_run_id: AtomicU64::new(0),
            transition: Arc::new(Semaphore::new(1)),
            traffic: Arc::new(TrafficStream::new()),
            xray_stats: Arc::new(XrayStatsStream::new()),
            #[cfg(test)]
            xray_test_state: Mutex::new(XrayTestState::default()),
            #[cfg(test)]
            stdio_readers: Mutex::new(Vec::new()),
            kill_switch_mode: Mutex::new(crate::config::KillSwitchMode::Off),
        }
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn issue_ready_ticket(&self) -> u64 {
        self.ready_catalog_epoch
            .store(self.source_catalog.epoch(), Ordering::Release);
        self.ready_check_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }
    pub fn begin_ready_profile_check(&self) -> u64 {
        self.recovery.profile_check(|| self.issue_ready_ticket())
    }
    pub fn begin_manual_profile_check(
        self: &Arc<Self>,
    ) -> (crate::recovery::coordinator::ManualRequest, u64) {
        self.recovery
            .manual_profile_check(|| self.issue_ready_ticket())
    }
    pub fn is_ready_profile_check_current(&self, ticket: u64) -> bool {
        self.ready_check_epoch.load(Ordering::Acquire) == ticket
            && self.ready_catalog_epoch.load(Ordering::Acquire) == self.source_catalog.epoch()
    }

    pub(crate) fn is_launch_check_current(&self, epoch: u64, recovering: bool) -> bool {
        if recovering {
            self.ready_check_epoch.load(Ordering::Acquire) == epoch
        } else {
            self.is_ready_profile_check_current(epoch)
        }
    }

    pub async fn set_kill_switch_mode(&self, mode: crate::config::KillSwitchMode) {
        *self.kill_switch_mode.lock().await = mode;
        if mode == crate::config::KillSwitchMode::Off {
            let _ = crate::killswitch::disarm_kill_switch();
        }
    }

    pub async fn get_kill_switch_mode(&self) -> crate::config::KillSwitchMode {
        *self.kill_switch_mode.lock().await
    }

    pub async fn push_log(&self, stream: LogStream, line: impl Into<String>) {
        let line = LogLine {
            ts: chrono::Utc::now(),
            stream,
            line: line.into(),
        };
        let mut logs = self.logs.lock().await;
        if logs.len() >= LOG_BUFFER_CAPACITY {
            logs.pop_front();
        }
        logs.push_back(line);
    }

    pub fn active_run_id(&self) -> u64 {
        self.active_run_id.load(Ordering::Acquire)
    }

    pub async fn probe_run_alive(&self, run_id: u64) -> bool {
        if run_id == 0 || self.active_run_id() != run_id {
            return false;
        }
        if self.status.lock().await.status != Status::Running {
            return false;
        }
        let mut slot = self.child.lock().await;
        slot.as_mut()
            .is_some_and(|slot| slot.run_id == run_id && matches!(slot.child.try_wait(), Ok(None)))
    }
    pub async fn snapshot_status(&self) -> StatusReport {
        self.status.lock().await.clone()
    }

    pub async fn start_aux_child(
        self: &Arc<Self>,
        run_id: u64,
        binary: PathBuf,
        args: Vec<OsString>,
        env: Vec<(String, String)>,
    ) -> AppResult<()> {
        self.start_aux_child_inner(run_id, binary, args, env, false)
            .await
    }
    async fn start_aux_child_inner(
        self: &Arc<Self>,
        run_id: u64,
        binary: PathBuf,
        args: Vec<OsString>,
        env: Vec<(String, String)>,
        background: bool,
    ) -> AppResult<()> {
        if !self.is_active_run(run_id).await {
            return Ok(());
        }
        #[cfg(all(target_os = "macos", not(test)))]
        {
            if background {
                if !crate::platform::macos::is_binary_elevated(&binary) {
                    return Err(AppError::TunCapabilities(
                        "recovery_permission_required".into(),
                    ));
                }
            } else if let Err(e) = crate::platform::macos::ensure_binary_elevated(&binary).await {
                return Err(AppError::TunCapabilities(e));
            }
        }
        #[cfg(not(all(target_os = "macos", not(test))))]
        let _ = background;
        let auxiliary_config = args
            .iter()
            .position(|a| a == "-c")
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from)
            .and_then(|path| {
                std::fs::read(&path)
                    .ok()
                    .map(|bytes| (path, Arc::new(bytes)))
            });
        let captured = crate::recovery::coordinator::Auxiliary {
            binary: binary.clone(),
            args: args.clone(),
            env: env.clone(),
            config: auxiliary_config,
        };
        let mut cmd = Command::new(&binary);
        cmd.args(&args)
            .envs(env.iter().map(|(k, v)| (k, v)))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                return Err(AppError::Spawn(format!(
                    "could not start auxiliary TUN forwarder: {e}"
                )));
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let manager = Arc::clone(self);
            let reader = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(line) = frontend_log_line(EngineKind::Singbox, &line) {
                        manager
                            .push_log(LogStream::Stdout, format!("[TUN] {line}"))
                            .await;
                    }
                }
            });
            #[cfg(test)]
            self.stdio_readers.lock().await.push(reader);
            #[cfg(not(test))]
            drop(reader);
        }
        if let Some(stderr) = child.stderr.take() {
            let manager = Arc::clone(self);
            let reader = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(line) = frontend_log_line(EngineKind::Singbox, &line) {
                        manager
                            .push_log(LogStream::Stderr, format!("[TUN] {line}"))
                            .await;
                    }
                }
            });
            #[cfg(test)]
            self.stdio_readers.lock().await.push(reader);
            #[cfg(not(test))]
            drop(reader);
        }
        let mut aux_slot = self.aux_child.lock().await;
        if !self.is_active_run(run_id).await {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Ok(());
        }
        if let Some(c_idx) = args.iter().position(|a| a == "-c") {
            if let Some(cfg_path) = args.get(c_idx + 1) {
                *self.aux_config.lock().await = Some(PathBuf::from(cfg_path));
            }
        }
        *aux_slot = Some(ChildSlot { run_id, child });
        self.recovery.capture_auxiliary(run_id, captured);
        Ok(())
    }

    #[cfg(test)]
    pub async fn install_test_child(&self, engine: EngineKind) {
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = Command::new("powershell.exe");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            cmd
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "exec sleep 60"]);
            cmd
        };
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("test child starts");
        let pid = child.id();
        let run_id = self.next_run_id.fetch_add(1, Ordering::AcqRel) + 1;
        self.active_run_id.store(run_id, Ordering::Release);
        *self.child.lock().await = Some(ChildSlot { run_id, child });
        let mut status = self.status.lock().await;
        status.status = Status::Running;
        status.pid = pid;
        status.engine = Some(engine);
    }

    #[cfg(test)]
    pub async fn terminate_test_child(&self) {
        if let Some(ChildSlot { mut child, .. }) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }

    #[cfg(test)]
    async fn await_stdio_readers(&self) {
        let readers = std::mem::take(&mut *self.stdio_readers.lock().await);
        for reader in readers {
            reader.await.expect("stdio reader task completes");
        }
    }

    pub async fn snapshot_logs(&self, limit: usize) -> Vec<LogLine> {
        let logs = self.logs.lock().await;
        let start = logs.len().saturating_sub(limit);
        logs.iter().skip(start).cloned().collect()
    }

    /// Find the bundled sing-box binary using the established search order.
    pub fn locate_binary(app: &AppHandle) -> AppResult<PathBuf> {
        crate::engine::singbox::locate_binary(app)
    }

    /// Start exactly one backend-owned engine process.
    pub async fn start_spec(self: &Arc<Self>, spec: LaunchSpec) -> AppResult<StatusReport> {
        self.start_spec_with_app(None, spec).await
    }

    pub async fn start_spec_with_app(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        spec: LaunchSpec,
    ) -> AppResult<StatusReport> {
        let ticket = self.begin_ready_profile_check();
        self.start_spec_with_check(app, spec, Some(ticket), None)
            .await
    }

    pub async fn start_profile_checked_with_app(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        spec: LaunchSpec,
        ticket: u64,
    ) -> AppResult<StatusReport> {
        self.start_spec_with_check(app, spec, Some(ticket), None)
            .await
    }

    async fn start_spec_with_check(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        mut spec: LaunchSpec,
        ticket: Option<u64>,
        recovery: Option<(
            crate::recovery::intent::Token,
            crate::recovery::coordinator::Snapshot,
        )>,
    ) -> AppResult<StatusReport> {
        let mut _clash_transition = self.acquire_transition().await;
        if ticket.is_some_and(|ticket| !self.is_ready_profile_check_current(ticket)) {
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        if let Some((token, snapshot)) = &recovery {
            if !self.recovery.current(*token) {
                return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
            }
            // Background recovery must never request elevation. The ordinary
            // lifecycle below retains all existing process/proxy/cleanup policy.
            if crate::platform::macos::config_requires_tun(&spec.config_path)
                && !crate::platform::macos::is_binary_elevated(&spec.binary)
            {
                return Err(AppError::TunCapabilities(
                    "recovery_permission_required".into(),
                ));
            }
            if let Some(auxiliary) = &snapshot.auxiliary {
                if !crate::platform::macos::is_binary_elevated(&auxiliary.binary) {
                    return Err(AppError::TunCapabilities(
                        "recovery_permission_required".into(),
                    ));
                }
            }
            if !self.recovery.physical_matches(*token, true).await {
                return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
            }
            self.recovery.mark_restarting(*token);
            if self.child.lock().await.is_some() {
                self.stop_with_check_locked(None).await?;
            }
            if !self.recovery.current(*token) {
                return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
            }
            std::fs::write(&spec.config_path, snapshot.config.as_slice()).map_err(AppError::Io)?;
            if let Some((path, bytes)) = snapshot.auxiliary.as_ref().and_then(|a| a.config.as_ref())
            {
                std::fs::write(path, bytes.as_slice()).map_err(AppError::Io)?;
            }
        }
        let startup_epoch = self.ready_check_epoch.load(Ordering::Acquire);
        {
            let mut status = self.status.lock().await;
            if matches!(
                status.status,
                Status::Starting | Status::Running | Status::Stopping
            ) {
                return Err(AppError::AlreadyRunning(status.pid.unwrap_or(0)));
            }
            status.status = Status::Starting;
            status.last_error = None;
        }
        let mut run_id = self.next_run_id.fetch_add(1, Ordering::AcqRel) + 1;
        self.active_run_id.store(run_id, Ordering::Release);
        let label = match spec.engine {
            EngineKind::Singbox => "starting sing-box profile",
            EngineKind::Xray => "starting Xray profile",
        };
        self.push_log(LogStream::System, label).await;
        if spec.engine == EngineKind::Singbox {
            if let Err(message) =
                check_tun_capabilities(&spec.binary, &spec.config_path, recovery.is_none()).await
            {
                self.abort_start(run_id).await;
                self.push_log(
                    LogStream::System,
                    format!("TUN capability check failed: {message}"),
                )
                .await;
                return Err(AppError::TunCapabilities(message));
            }
        }
        let optional_port = spec
            .diagnostics
            .as_ref()
            .and_then(|d| d.wiring.as_ref())
            .map(|w| w.port);
        let mut startup_guard = optional_port.map(|_| {
            self.pending_diagnostic_start
                .store(run_id, Ordering::Release);
            PendingDiagnosticStart {
                manager: Arc::downgrade(self),
                run: run_id,
                finished: false,
            }
        });
        if !self.is_launch_check_current(startup_epoch, recovery.is_some())
            || recovery
                .as_ref()
                .is_some_and(|(token, _)| !self.recovery.current(*token))
        {
            self.abort_start(run_id).await;
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        if let Some((token, _)) = &recovery {
            if !self.recovery.physical_matches(*token, false).await {
                self.abort_start(run_id).await;
                return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
            }
        }
        self.spawn_main_child(&spec, run_id).await?;
        if let Some(port) = optional_port {
            // Readiness is outside the transition gate: Stop/new-start wins.
            drop(_clash_transition);
            let ready = self
                .optional_listener_ready(run_id, startup_epoch, port, recovery.is_some())
                .await;
            _clash_transition = self.acquire_transition().await;
            if self.active_run_id() != run_id
                || !self.is_launch_check_current(startup_epoch, recovery.is_some())
                || recovery
                    .as_ref()
                    .is_some_and(|(token, _)| !self.recovery.current(*token))
            {
                self.discard_starting_child(run_id).await?;
                return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
            }
            if !ready {
                self.discard_starting_child(run_id).await?;
                if let Some(guard) = startup_guard.take() {
                    guard.finish();
                }
                if !self.is_launch_check_current(startup_epoch, recovery.is_some()) {
                    return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
                }
                // The original passed preflight. One owned startup fallback;
                // this is not reconnect/recovery after an accepted connection.
                if let Some(diagnostic) = spec.diagnostics.as_mut() {
                    diagnostic.restore_original(&spec.config_path)?;
                }
                run_id = self.next_run_id.fetch_add(1, Ordering::AcqRel) + 1;
                self.active_run_id.store(run_id, Ordering::Release);
                self.pending_diagnostic_start
                    .store(run_id, Ordering::Release);
                startup_guard = Some(PendingDiagnosticStart {
                    manager: Arc::downgrade(self),
                    run: run_id,
                    finished: false,
                });
                self.spawn_main_child(&spec, run_id).await?;
            }
        }
        if !self.is_launch_check_current(startup_epoch, recovery.is_some())
            || recovery
                .as_ref()
                .is_some_and(|(token, _)| !self.recovery.current(*token))
        {
            self.discard_starting_child(run_id).await?;
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        let mut status = self.status.lock().await;
        status.status = Status::Running;
        let report = status.clone();
        drop(status);
        if let Some(guard) = startup_guard.take() {
            guard.finish();
        }
        if app.is_some() {
            self.diagnostics.spawn_monitor(Arc::downgrade(self), run_id);
        }
        if let Some((token, snapshot)) = &recovery {
            if let Some(auxiliary) = &snapshot.auxiliary {
                if !self.recovery.current(*token) {
                    self.discard_starting_child(run_id).await?;
                    return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
                }
                if let Err(error) = self
                    .start_aux_child_inner(
                        run_id,
                        auxiliary.binary.clone(),
                        auxiliary.args.clone(),
                        auxiliary.env.clone(),
                        true,
                    )
                    .await
                {
                    let _ = self.stop_with_check_locked(None).await;
                    return Err(error);
                }
            }
        }
        if recovery
            .as_ref()
            .is_some_and(|(token, _)| !self.recovery.current(*token))
        {
            let _ = self.stop_with_check_locked(None).await;
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        if let Some((_, snapshot)) = &recovery {
            if let Some((host, http, socks)) = &snapshot.proxy {
                if let Err(error) = apply_system_proxy_with_socks(host, *http, *socks) {
                    let _ = self.stop_with_check_locked(None).await;
                    return Err(error);
                }
            }
        }
        let mut captured = crate::recovery::coordinator::Snapshot::capture(&spec);
        if let (Some(snapshot), Some((_, old))) = (&mut captured, &recovery) {
            snapshot.proxy = old.proxy.clone();
            snapshot.auxiliary = old.auxiliary.clone();
        }
        let proof = if let Some((token, _)) = &recovery {
            crate::recovery::coordinator::Acceptance::Recovery(*token)
        } else {
            crate::recovery::coordinator::Acceptance::Manual(
                ticket.expect("manual launch owns a ready-check ticket"),
            )
        };
        if !self.recovery.accept_checked(run_id, captured, proof) {
            let _ = self.stop_with_check_locked(None).await;
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        if spec.engine == EngineKind::Xray {
            if let Some(stats_spec) = spec.xray_stats {
                self.start_xray_telemetry(run_id, app.cloned(), stats_spec)
                    .await;
            }
        }
        #[cfg(all(windows, not(test)))]
        if spec.engine == EngineKind::Singbox {
            let config_path = spec.config_path.clone();
            let manager = Arc::clone(self);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if !manager.is_active_singbox_run(run_id).await {
                    return;
                }
                if let Err(e) = set_tun_dns_from_config(&manager, run_id, &config_path).await {
                    log::warn!("could not set TUN adapter DNS: {e}");
                }
            });
        }
        if spec.engine == EngineKind::Singbox {
            if let (Some(controller_url), Some(app)) = (spec.controller_url, app.cloned()) {
                if self.is_active_singbox_run(run_id).await {
                    if let Err(error) = self.traffic.start(app, &controller_url).await {
                        log::warn!("traffic stream start failed: {error}");
                    } else if !self.is_active_singbox_run(run_id).await {
                        // Finalization may have invalidated this run while
                        // `TrafficStream::start` was awaiting. Do not leave
                        // an old sing-box controller stream alive for Xray.
                        self.traffic.stop().await;
                    }
                }
            }
        }
        Ok(report)
    }

    pub(crate) async fn apply_proxy_for_run(
        self: &Arc<Self>,
        run: u64,
        proxy: (String, u16, u16),
        ticket: u64,
    ) -> AppResult<()> {
        let _transition = self.acquire_transition().await;
        if self.active_run_id() != run || !self.is_ready_profile_check_current(ticket) {
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        if let Err(error) = apply_system_proxy_with_socks(&proxy.0, proxy.1, proxy.2) {
            let _ = self.stop_with_check_locked(None).await;
            return Err(error);
        }
        self.recovery.capture_proxy(run, Some(proxy));
        Ok(())
    }

    pub(crate) async fn restart_recovery(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        token: crate::recovery::intent::Token,
        snapshot: crate::recovery::coordinator::Snapshot,
    ) -> AppResult<StatusReport> {
        self.start_spec_with_check(app, snapshot.spec.clone(), None, Some((token, snapshot)))
            .await
    }

    pub(crate) async fn recovery_engine_dead(&self, run: u64) -> bool {
        let mut child = self.child.lock().await;
        if let Some(slot) = child.as_mut() {
            return slot.run_id == run && matches!(slot.child.try_wait(), Ok(Some(_)));
        }
        drop(child);
        let active = self.diagnostics.snapshot();
        self.active_run_id() == 0
            && active.ended_unexpectedly
            && active
                .session
                .as_ref()
                .is_some_and(|s| s.identity.run_id.as_deref() == Some(&run.to_string()))
    }

    async fn spawn_main_child(self: &Arc<Self>, spec: &LaunchSpec, run_id: u64) -> AppResult<()> {
        let mut cmd = Command::new(&spec.binary);
        cmd.args(&spec.args)
            .envs(spec.env.iter().map(|(key, value)| (key, value)))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Some(diagnostic) = &spec.diagnostics {
            diagnostic.release_port();
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.abort_start(run_id).await;
                return Err(AppError::Spawn(format!(
                    "could not start sing-box process: {error}"
                )));
            }
        };
        let pid = child.id();
        self.diagnostics
            .accept(run_id, spec.engine, spec.diagnostics.clone());
        if let Some(stdout) = child.stdout.take() {
            let manager = Arc::clone(self);
            let engine = spec.engine;
            let reader = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    manager.diagnostics.observe_line(run_id, &line);
                    if let Some(line) = frontend_log_line(engine, &line) {
                        manager.push_log(LogStream::Stdout, line).await;
                    }
                }
            });
            #[cfg(test)]
            self.stdio_readers.lock().await.push(reader);
            #[cfg(not(test))]
            drop(reader);
        }
        if let Some(stderr) = child.stderr.take() {
            let manager = Arc::clone(self);
            let engine = spec.engine;
            let reader = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    manager.diagnostics.observe_line(run_id, &line);
                    if let Some(line) = frontend_log_line(engine, &line) {
                        manager.push_log(LogStream::Stderr, line).await;
                    }
                }
            });
            #[cfg(test)]
            self.stdio_readers.lock().await.push(reader);
            #[cfg(not(test))]
            drop(reader);
        }
        *self.child.lock().await = Some(ChildSlot { run_id, child });
        *self.started_at.lock().await = Some(std::time::Instant::now());
        *self.current_config.lock().await = Some(spec.config_path.clone());
        if spec.engine == EngineKind::Singbox {
            *self.controller_url.lock().await = spec.controller_url.clone();
        }
        let mut status = self.status.lock().await;
        status.status = Status::Starting;
        status.pid = pid;
        status.last_exit_code = None;
        status.engine = Some(spec.engine);
        status.profile_key = spec.profile_key.clone();
        status.profile_name = spec.profile_name.clone();
        status.run_id = Some(run_id.to_string());
        drop(status);
        Ok(())
    }
    async fn optional_listener_ready(
        &self,
        run: u64,
        epoch: u64,
        port: u16,
        recovering: bool,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if self.active_run_id() != run || !self.is_launch_check_current(epoch, recovering) {
                return false;
            }
            let pid = {
                let mut child = self.child.lock().await;
                child.as_mut().and_then(|slot| {
                    if slot.run_id == run && matches!(slot.child.try_wait(), Ok(None)) {
                        slot.child.id()
                    } else {
                        None
                    }
                })
            };
            let Some(pid) = pid else {
                return false;
            };
            if crate::diagnostics::network_events::owns_listener(pid, port).await
                && crate::diagnostics::desktop::requires_proxy_auth(port).await
            {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    /// Caller owns the transition. Never runs global proxy/firewall cleanup.
    async fn discard_starting_child(&self, run: u64) -> AppResult<()> {
        if self.active_run_id() != run {
            return Ok(());
        }
        let child = {
            let mut slot = self.child.lock().await;
            if slot.as_ref().is_some_and(|slot| slot.run_id == run) {
                slot.take()
            } else {
                None
            }
        };
        if let Some(ChildSlot { mut child, .. }) = child {
            let _ = child.start_kill();
            let reaped = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            if !matches!(reaped, Ok(Ok(_))) {
                self.abort_start(run).await;
                return Err(AppError::Spawn(
                    "could not stop optional diagnostic startup".into(),
                ));
            }
        }
        *self.started_at.lock().await = None;
        *self.current_config.lock().await = None;
        *self.controller_url.lock().await = None;
        self.abort_start(run).await;
        Ok(())
    }

    /// Compatibility route for existing sing-box callers.
    pub async fn start(
        self: &Arc<Self>,
        app: &AppHandle,
        binary: &Path,
        config_path: &Path,
        controller_url: Option<String>,
    ) -> AppResult<StatusReport> {
        self.start_spec_with_app(
            Some(app),
            LaunchSpec {
                engine: EngineKind::Singbox,
                binary: binary.to_path_buf(),
                args: vec![
                    OsString::from("run"),
                    OsString::from("-c"),
                    config_path.as_os_str().to_os_string(),
                ],
                env: Vec::new(),
                config_path: config_path.to_path_buf(),
                controller_url,
                profile_key: None,
                profile_name: None,
                diagnostics: None,
                xray_stats: None,
            },
        )
        .await
    }

    /// Stop the running sing-box. Graceful: send SIGTERM/taskkill, then
    /// escalate to SIGKILL after `DEFAULT_TERMINATE_TIMEOUT`.
    pub async fn stop(self: &Arc<Self>) -> AppResult<StatusReport> {
        let observed_run = self.active_run_id();
        let epoch = self
            .recovery
            .stop_with(|| self.ready_check_epoch.fetch_add(1, Ordering::AcqRel) + 1);
        self.diagnostics.retire(observed_run, true);
        let _transition = self.acquire_transition().await;
        if self.ready_check_epoch.load(Ordering::Acquire) != epoch {
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        self.stop_with_check_locked(None).await
    }

    pub async fn stop_after_profile_check(
        self: &Arc<Self>,
        ticket: u64,
    ) -> AppResult<StatusReport> {
        self.stop_with_check(Some(ticket)).await
    }

    async fn stop_with_check(self: &Arc<Self>, ticket: Option<u64>) -> AppResult<StatusReport> {
        let _clash_transition = self.acquire_transition().await;
        self.stop_with_check_locked(ticket).await
    }

    async fn stop_with_check_locked(
        self: &Arc<Self>,
        ticket: Option<u64>,
    ) -> AppResult<StatusReport> {
        if ticket.is_some_and(|ticket| !self.is_ready_profile_check_current(ticket)) {
            return Err(crate::config::preflight::ProfileCheckIssue::Cancelled.into());
        }
        let ChildSlot { run_id, mut child } =
            self.child.lock().await.take().ok_or(AppError::NotRunning)?;
        self.diagnostics.retire(run_id, true);

        let engine = {
            let mut status = self.status.lock().await;
            if self.active_run_id.load(Ordering::Acquire) == run_id {
                status.status = Status::Stopping;
            }
            status.engine
        };
        let label = match engine {
            Some(EngineKind::Xray) => "stopping Xray",
            _ => "stopping sing-box",
        };
        self.push_log(LogStream::System, label).await;

        if engine == Some(EngineKind::Xray) {
            self.stop_xray_telemetry().await;
        }

        // The traffic stream belongs exclusively to sing-box's Clash controller.
        if engine == Some(EngineKind::Singbox) && self.is_active_run(run_id).await {
            if self.is_active_run(run_id).await {
                self.traffic.stop().await;
            }
        }

        if let Some(ChildSlot { mut child, .. }) = self.aux_child.lock().await.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        *self.aux_config.lock().await = None;

        // Try graceful first. The child is owned locally for the rest of this
        // async operation, so no child mutex guard can cross an await.
        let _ = child.start_kill();
        let deadline = std::time::Instant::now() + DEFAULT_TERMINATE_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.finalize_exit(run_id, Some(status.code().unwrap_or(-1)), None, true)
                        .await;
                    return Ok(self.status.lock().await.clone());
                }
                Ok(None) if std::time::Instant::now() >= deadline => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    self.finalize_exit(
                        run_id,
                        Some(-1),
                        Some("graceful shutdown timed out, force-killed".to_string()),
                        true,
                    )
                    .await;
                    return Ok(self.status.lock().await.clone());
                }
                Ok(None) => {}
                Err(e) => {
                    self.finalize_exit(run_id, None, Some(format!("try_wait failed: {e}")), true)
                        .await;
                    return Ok(self.status.lock().await.clone());
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn is_running(&self) -> bool {
        let g = self.child.lock().await;
        g.is_some()
    }

    pub async fn current_config(&self) -> Option<PathBuf> {
        let engine = self.status.lock().await.engine;
        let path = self.current_config.lock().await.clone();
        path.and_then(|path| public_config_path(engine.unwrap_or(EngineKind::Singbox), path))
    }

    pub fn active_config_path(&self) -> Option<PathBuf> {
        self.current_config.try_lock().ok().and_then(|c| c.clone())
    }

    pub fn active_aux_config_path(&self) -> Option<PathBuf> {
        self.aux_config.try_lock().ok().and_then(|c| c.clone())
    }

    pub async fn set_aux_config(&self, path: Option<PathBuf>) {
        *self.aux_config.lock().await = path;
    }

    pub async fn controller_url(&self) -> Option<String> {
        self.clash_controller().await.ok().map(|(_, url)| url)
    }

    /// Acquire the manager-owned gate for a Clash API request. The owned
    /// permit intentionally remains held across the request await, while
    /// avoiding a mutex guard across await.
    pub async fn acquire_clash_api(&self) -> OwnedSemaphorePermit {
        self.acquire_transition().await
    }

    /// Capture the controller URL together with the sing-box launch generation
    /// that owns it. Callers must validate the generation again after I/O.
    pub async fn clash_controller(&self) -> AppResult<(u64, String)> {
        let run_id = self.active_run_id.load(Ordering::Acquire);
        let status = self.status.lock().await;
        if run_id == 0
            || status.status != Status::Running
            || status.engine != Some(EngineKind::Singbox)
        {
            return Err(AppError::Clash("sing-box is not running".to_string()));
        }
        drop(status);
        let url = self
            .controller_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| AppError::Clash("sing-box controller is unavailable".to_string()))?;
        Ok((run_id, url))
    }

    /// Borrow the live traffic-stream handle (for the `traffic_*`
    /// Tauri commands).
    /// Start manual traffic streaming only for the active sing-box run.
    pub async fn start_traffic(self: &Arc<Self>, app: AppHandle) -> AppResult<()> {
        let run_id = self.active_run_id.load(Ordering::Acquire);
        let controller_url =
            {
                let status = self.status.lock().await;
                if status.status != Status::Running || status.engine != Some(EngineKind::Singbox) {
                    return Err(AppError::Clash("sing-box is not running".to_string()));
                }
                drop(status);
                self.controller_url.lock().await.clone().ok_or_else(|| {
                    AppError::Clash("sing-box controller is unavailable".to_string())
                })?
            };
        let _traffic_transition = self.acquire_transition().await;
        let result = self.traffic.start(app, &controller_url).await;
        if let Err(error) = result {
            return Err(error);
        }
        if !self.is_active_singbox_run(run_id).await {
            self.traffic.stop().await;
            return Err(AppError::Clash("sing-box is no longer running".to_string()));
        }
        Ok(())
    }

    /// Stop manual traffic streaming, without allowing a stale command to
    /// stop a stream belonging to a newer launch generation.
    pub async fn stop_traffic(&self) {
        let run_id = self.active_run_id.load(Ordering::Acquire);
        if self.is_active_run(run_id).await {
            let _traffic_transition = self.acquire_transition().await;
            if self.is_active_run(run_id).await {
                self.traffic.stop().await;
            }
        }
    }

    async fn start_xray_telemetry(&self, run_id: u64, app: Option<AppHandle>, spec: XrayStatsSpec) {
        if !self.is_active_run(run_id).await {
            return;
        }
        self.xray_stats.stop().await;
        self.xray_stats_run_id.store(0, Ordering::Release);
        if !self.is_active_run(run_id).await {
            return;
        }

        #[cfg(test)]
        if app.is_none() {
            let mut state = self.xray_test_state.lock().await;
            if self.active_run_id.load(Ordering::Acquire) == run_id {
                state.run_id = Some(run_id);
                state.starts += 1;
                state.events.push("start");
                self.xray_stats_run_id.store(run_id, Ordering::Release);
            }
            return;
        }

        if let Some(app) = app {
            if let Err(error) = self
                .xray_stats
                .start(app, spec, run_id, Arc::clone(&self.active_run_id))
                .await
            {
                log::warn!("Xray traffic stream start failed: {error}");
                return;
            }
            if self.is_active_run(run_id).await {
                self.xray_stats_run_id.store(run_id, Ordering::Release);
            } else {
                self.xray_stats.stop().await;
            }
        }
    }

    async fn stop_xray_telemetry(&self) {
        #[cfg(test)]
        let owned_run = self.xray_stats_run_id.swap(0, Ordering::AcqRel);
        #[cfg(not(test))]
        self.xray_stats_run_id.swap(0, Ordering::AcqRel);
        self.xray_stats.stop().await;
        #[cfg(test)]
        if owned_run != 0 {
            let mut state = self.xray_test_state.lock().await;
            state.run_id = None;
            state.events.push("stop");
        }
    }

    #[cfg(test)]
    async fn xray_telemetry_run_id(&self) -> Option<u64> {
        let run_id = self.xray_stats_run_id.load(Ordering::Acquire);
        (run_id != 0).then_some(run_id)
    }

    #[cfg(test)]
    async fn test_xray_telemetry_start_count(&self) -> usize {
        self.xray_test_state.lock().await.starts
    }

    #[cfg(test)]
    async fn test_xray_telemetry_emit_count(&self) -> usize {
        self.xray_test_state.lock().await.emits
    }

    #[cfg(test)]
    async fn test_xray_telemetry_events(&self) -> Vec<&'static str> {
        self.xray_test_state.lock().await.events.clone()
    }

    #[cfg(test)]
    async fn test_emit_xray_sample(&self, run_id: u64) {
        let mut state = self.xray_test_state.lock().await;
        if self.xray_stats_run_id.load(Ordering::Acquire) == run_id
            && self.active_run_id.load(Ordering::Acquire) == run_id
        {
            state.emits += 1;
        }
    }

    async fn reset_with_proxy_cleanup<F>(&self, clear_proxy: F)
    where
        F: FnOnce() -> AppResult<()>,
    {
        if let Err(error) = clear_proxy() {
            self.push_log(
                LogStream::System,
                format!("proxy: failed to clear during reset ({error})"),
            )
            .await;
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = crate::killswitch::disarm_kill_switch();
        }
        self.stop_xray_telemetry().await;
        self.diagnostics.clear();
        self.active_run_id.store(0, Ordering::Release);
        if let Some(ChildSlot { mut child, .. }) = self.aux_child.lock().await.take() {
            let _ = child.start_kill();
        }
        *self.child.lock().await = None;
        *self.status.lock().await = StatusReport::default();
        #[cfg(test)]
        self.xray_test_state.lock().await.events.push("state_clear");
        *self.started_at.lock().await = None;
        *self.current_config.lock().await = None;
        *self.aux_config.lock().await = None;
        self.controller_url.lock().await.take();
        self.traffic.stop().await;
        self.push_log(LogStream::System, "process manager state reset")
            .await;
    }

    /// Cleanup belongs to the failed request, and cannot reset a newer engine.
    pub async fn reset_after_profile_check(&self, ticket: u64) {
        let _clash_transition = self.acquire_transition().await;
        if !self.is_ready_profile_check_current(ticket) {
            return;
        }
        // Keep a newer pending check valid if it begins during cleanup. Its
        // engine cannot start until this transition permit is released.
        self.reset_with_proxy_cleanup(clear_system_proxy).await;
    }

    /// Force-clear the manager state. Used by the reset_state command
    /// for manual recovery; the spawned child (if any) is dropped, which
    /// triggers `kill_on_drop` on the underlying Command.
    pub async fn reset(&self) {
        let epoch = self
            .recovery
            .stop_with(|| self.ready_check_epoch.fetch_add(1, Ordering::AcqRel) + 1);
        let _transition = self.acquire_transition().await;
        if self.ready_check_epoch.load(Ordering::Acquire) != epoch {
            return;
        }
        self.reset_with_proxy_cleanup(clear_system_proxy).await;
    }

    /// Update the StatusReport after a process has exited.
    ///
    /// Release the system proxy after this run exits. On Windows the lease
    /// verifies the currently applied settings before restoring the prior values.
    async fn finalize_exit(
        &self,
        run_id: u64,
        code: Option<i32>,
        err: Option<String>,
        _is_intentional_stop: bool,
    ) {
        if self.active_run_id.load(Ordering::Acquire) != run_id {
            return;
        }

        self.diagnostics.retire(run_id, _is_intentional_stop);

        if let Some(ChildSlot { mut child, .. }) = self.aux_child.lock().await.take() {
            let _ = child.start_kill();
        }

        // Unexpected exits bypass `stop`; cancel the old run before another
        // launch can start a sing-box traffic task.
        self.stop_xray_telemetry().await;
        self.traffic.stop().await;
        if self.active_run_id.load(Ordering::Acquire) != run_id {
            return;
        }
        *self.started_at.lock().await = None;
        *self.current_config.lock().await = None;
        *self.aux_config.lock().await = None;
        *self.controller_url.lock().await = None;

        let (line, _engine_label) = {
            let mut status = self.status.lock().await;
            if self.active_run_id.load(Ordering::Acquire) != run_id {
                return;
            }
            let is_xray = status.engine == Some(EngineKind::Xray);
            let engine_label = if is_xray { "Xray" } else { "sing-box" };
            status.status = Status::Stopped;
            status.pid = None;
            status.uptime_secs = None;
            status.last_exit_code = code;
            status.last_error = (!is_xray).then(|| err.clone()).flatten();
            status.engine = None;
            status.profile_key = None;
            status.profile_name = None;
            // Status is the launch gate. Invalidate this ID before dropping it
            // so older async tasks cannot touch a later run.
            self.active_run_id.store(0, Ordering::Release);
            let msg = if is_xray {
                if code == Some(0) {
                    "Xray stopped".to_string()
                } else {
                    "Xray stopped unexpectedly".to_string()
                }
            } else {
                match (&err, code) {
                    (Some(error), _) => format!("{engine_label} exited unexpectedly: {error}"),
                    (None, Some(exit_code)) if exit_code != 0 => {
                        format!("{engine_label} exited with code {exit_code}")
                    }
                    (None, _) => format!("{engine_label} stopped"),
                }
            };
            (msg, engine_label)
        };
        #[cfg(test)]
        self.xray_test_state.lock().await.events.push("state_clear");
        self.push_log(LogStream::System, line).await;
        if let Err(error) = clear_system_proxy() {
            self.push_log(
                LogStream::System,
                format!("proxy: failed to clear on exit ({error})"),
            )
            .await;
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = crate::killswitch::disarm_kill_switch();
        }
    }

    async fn acquire_transition(&self) -> OwnedSemaphorePermit {
        self.transition
            .clone()
            .acquire_owned()
            .await
            .expect("process transition semaphore is never closed")
    }

    async fn take_child_if_run(&self, run_id: u64) -> bool {
        let mut child = self.child.lock().await;
        if child.as_ref().is_some_and(|slot| slot.run_id == run_id) {
            child.take();
            true
        } else {
            false
        }
    }

    async fn is_active_run(&self, run_id: u64) -> bool {
        run_id != 0 && self.active_run_id.load(Ordering::Acquire) == run_id
    }

    pub async fn is_active_singbox_run(&self, run_id: u64) -> bool {
        if self.active_run_id.load(Ordering::Acquire) != run_id {
            return false;
        }
        let status = self.status.lock().await;
        status.status == Status::Running && status.engine == Some(EngineKind::Singbox)
    }

    pub async fn is_active_xray_run(&self, run_id: u64) -> bool {
        if self.active_run_id.load(Ordering::Acquire) != run_id {
            return false;
        }
        let status = self.status.lock().await;
        (status.status == Status::Running || status.status == Status::Starting)
            && status.engine == Some(EngineKind::Xray)
    }

    async fn abort_start(&self, run_id: u64) {
        self.diagnostics.retire(run_id, true);
        if self.active_run_id.load(Ordering::Acquire) != run_id {
            return;
        }
        self.stop_xray_telemetry().await;
        let mut status = self.status.lock().await;
        if self.active_run_id.load(Ordering::Acquire) == run_id {
            *status = StatusReport::default();
            self.active_run_id.store(0, Ordering::Release);
        }
    }

    /// Background watcher: polls the child and surfaces a crash.
    ///
    /// Must be called from inside a tokio runtime (e.g. Tauri's
    /// `setup` callback), NOT at top-level of `run()`.
    pub fn spawn_watcher(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
                let exited = {
                    let mut guard = self.child.lock().await;
                    guard.as_mut().and_then(|slot| {
                        let run_id = slot.run_id;
                        if self.pending_diagnostic_start.load(Ordering::Acquire) == run_id {
                            return None;
                        }
                        let result = match slot.child.try_wait() {
                            Ok(Some(status)) => Some(Ok(status)),
                            Ok(None) => None,
                            Err(error) => Some(Err(error)),
                        };
                        Some((run_id, result))
                    })
                };
                match exited {
                    Some((run_id, Some(Ok(status)))) => {
                        let code = status.code();
                        // A reset/relaunch may have replaced the slot while we
                        // were outside the child mutex. Never take its newer
                        // handle for an older watcher observation.
                        let owns_slot = self.take_child_if_run(run_id).await;
                        if owns_slot {
                            let _clash_transition = self.acquire_transition().await;
                            self.finalize_exit(run_id, code, None, false).await;
                        }
                    }
                    Some((run_id, Some(Err(error)))) => {
                        let owns_slot = self.take_child_if_run(run_id).await;
                        if owns_slot {
                            let _clash_transition = self.acquire_transition().await;
                            self.finalize_exit(
                                run_id,
                                None,
                                Some(format!("try_wait failed: {error}")),
                                false,
                            )
                            .await;
                        }
                    }
                    Some((_run_id, None)) => {
                        // Update uptime without retaining the child guard.
                        if self.child.lock().await.is_some() {
                            if let Some(start) = *self.started_at.lock().await {
                                let mut status = self.status.lock().await;
                                status.uptime_secs = Some(start.elapsed().as_secs());
                            }
                        }
                    }
                    None => {}
                }
            }
        });
    }
}

fn frontend_log_line(engine: EngineKind, line: &str) -> Option<String> {
    (engine == EngineKind::Singbox).then(|| line.to_owned())
}

fn public_config_path(engine: EngineKind, path: PathBuf) -> Option<PathBuf> {
    (engine == EngineKind::Singbox).then_some(path)
}

// --- System proxy management ---------------------------------------
// Windows uses WinINET registry keys, and macOS uses `networksetup`
// per active network service.

#[cfg(target_os = "android")]
pub fn apply_system_proxy(_host: &str, _port: u16) -> AppResult<()> {
    Ok(())
}

#[cfg(target_os = "android")]
pub fn apply_system_proxy_with_socks(
    _host: &str,
    _http_port: u16,
    _socks_port: u16,
) -> AppResult<()> {
    Ok(())
}

#[cfg(target_os = "android")]
pub fn clear_system_proxy() -> AppResult<()> {
    Ok(())
}

#[cfg(windows)]
fn notify_wininet_proxy_change() {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn LoadLibraryA(lp_lib_file_name: *const u8) -> *mut std::ffi::c_void;
            fn GetProcAddress(
                h_module: *mut std::ffi::c_void,
                lp_proc_name: *const u8,
            ) -> *mut std::ffi::c_void;
            fn FreeLibrary(h_lib_module: *mut std::ffi::c_void) -> i32;
        }

        let module = LoadLibraryA(b"wininet.dll\0".as_ptr());
        if module.is_null() {
            return;
        }
        let proc = GetProcAddress(module, b"InternetSetOptionW\0".as_ptr());
        if !proc.is_null() {
            type InternetSetOptionFn = unsafe extern "system" fn(
                *mut std::ffi::c_void,
                u32,
                *mut std::ffi::c_void,
                u32,
            ) -> i32;
            let func: InternetSetOptionFn = std::mem::transmute(proc);
            const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;
            const INTERNET_OPTION_REFRESH: u32 = 37;
            func(
                std::ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                std::ptr::null_mut(),
                0,
            );
            func(
                std::ptr::null_mut(),
                INTERNET_OPTION_REFRESH,
                std::ptr::null_mut(),
                0,
            );
        }
        FreeLibrary(module);
    }
}

#[cfg(windows)]
pub fn apply_system_proxy(host: &str, port: u16) -> AppResult<()> {
    apply_system_proxy_with_socks(host, port, port)
}

#[cfg(windows)]
pub fn apply_system_proxy_with_socks(host: &str, http_port: u16, socks_port: u16) -> AppResult<()> {
    let server = format!("http={host}:{http_port};https={host}:{http_port};socks={host}:{socks_port}");
    if crate::windows_proxy::apply(&server)? {
        notify_wininet_proxy_change();
    }
    Ok(())
}

#[cfg(windows)]
pub fn clear_system_proxy() -> AppResult<()> {
    if crate::windows_proxy::release()? {
        notify_wininet_proxy_change();
    }
    Ok(())
}

// --- System proxy management (macOS) --------------------------------
//
#[cfg(target_os = "macos")]
pub fn apply_system_proxy(host: &str, port: u16) -> AppResult<()> {
    apply_system_proxy_with_socks(host, port, port)
}

#[cfg(target_os = "macos")]
pub fn apply_system_proxy_with_socks(host: &str, http_port: u16, socks_port: u16) -> AppResult<()> {
    crate::macos_proxy::apply(host, http_port, socks_port)
}

#[cfg(target_os = "macos")]
pub fn clear_system_proxy() -> AppResult<()> {
    crate::macos_proxy::clear()
}

// --- TUN adapter DNS (Windows only) --------------------------------
//
// After sing-box brings the TUN interface up, the OS auto-derives a
// DNS server address from the TUN's own address range (e.g. for
// 172.19.0.1/30 it picks 172.19.0.2). Because that address is in the
// same /30 as the TUN itself, Windows treats it as an on-link
// neighbour and tries ARP/Neighbor Discovery instead of routing —
// the ARP never succeeds, the DNS query never reaches sing-box, and
// apps that resolve names directly (e.g. PowerShell's
// `Resolve-DnsName` without `-Server`) hang on the call.
//
// Fix: explicitly set the TUN adapter's DNS server to an external
// IP (e.g. 77.88.8.8, the same upstream we use in the sing-box
// `dns.servers[0]` block). That IP is NOT in 172.19.0.0/30, so
// Windows routes the DNS query normally through the TUN → sing-box
// → upstream, and the whole resolution path works end-to-end.
//
// On macOS this is a no-op: the TUN device on macOS
// doesn't auto-derive a DNS server, so the bug doesn't
// occur.

#[cfg(windows)]
fn configured_tun_interface(json: &serde_json::Value) -> Option<&str> {
    json["inbounds"].as_array()?.iter()
        .find(|inbound| inbound["type"] == "tun")?["interface_name"]
        .as_str().filter(|name| !name.trim().is_empty())
}

/// Read the sing-box config we just wrote, find the TUN interface
/// name and the local-DNS server, and apply that DNS server to the
/// adapter at the OS level.
///
/// Best-effort: returns `Err` on any failure (missing fields, netsh
/// not available, etc.) — the caller logs the error and continues.
#[allow(dead_code)]
async fn set_tun_dns_from_config(
    manager: &ProcessManager,
    run_id: u64,
    config_path: &Path,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let content = tokio::fs::read_to_string(config_path)
            .await
            .map_err(|_| "could not read runtime configuration".to_string())?;
        let json: serde_json::Value = serde_json::from_str(&content)
            .map_err(|_| "runtime configuration is invalid".to_string())?;

        // Pull the local-DNS server out of `dns.servers[0]`. Falls back
        // to 1.1.1.1 if for any reason the field is missing (e.g. a
        // hand-edited config) — the goal here is "any reachable IP
        // outside the TUN's own /30", not "a specific provider".
        let dns = json
            .get("dns")
            .and_then(|d| d.get("servers"))
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|s| s.get("server"))
            .and_then(|s| s.as_str())
            .unwrap_or("1.1.1.1")
            .to_string();

        // Only a named TUN from this run is eligible for DNS setup.
        let Some(interface) = configured_tun_interface(&json) else {
            return Ok(());
        };

        // The config read above may have awaited long enough for this run to
        // be replaced. Validate ownership immediately before mutating DNS.
        if !manager.is_active_singbox_run(run_id).await {
            return Err("stale TUN DNS setup".to_string());
        }

        // `netsh interface ip set dns "<iface>" static <ip> primary validate=no`
        // requires elevation. The whole app is already running as
        // admin (TUN needs it), so this should just work.
        let mut cmd = std::process::Command::new("netsh");
        cmd.args([
            "interface",
            "ip",
            "set",
            "dns",
            interface,
            "static",
            &dns,
            "primary",
            "validate=no",
        ]);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let output = cmd.output().map_err(|e| format!("spawn netsh: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "netsh exit {:?}: stderr={} stdout={}",
                output.status.code(),
                stderr.trim(),
                stdout.trim()
            ));
        }
        log::info!("set TUN adapter '{interface}' DNS to {dns}");
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (manager, run_id, config_path);
        Ok(())
    }
}

async fn check_tun_capabilities(
    binary: &Path,
    config_path: &Path,
    allow_elevation: bool,
) -> Result<(), String> {
    if !crate::platform::macos::config_requires_tun(config_path) {
        return Ok(());
    }
    #[cfg(all(target_os = "macos", not(test)))]
    {
        if allow_elevation {
            crate::platform::macos::ensure_binary_elevated(binary).await?;
        } else if !crate::platform::macos::is_binary_elevated(binary) {
            return Err("recovery_permission_required".into());
        }
    }
    #[cfg(not(all(target_os = "macos", not(test))))]
    {
        let _ = (binary, allow_elevation);
    }
    Ok(())
}

#[cfg(test)]
mod clash_controller_tests {
    use super::*;

    #[tokio::test]
    async fn clash_transition_serializes_api_requests() {
        let manager = ProcessManager::new();
        let permit = manager.acquire_clash_api().await;

        let blocked =
            tokio::time::timeout(Duration::from_millis(10), manager.acquire_clash_api()).await;
        assert!(blocked.is_err());
        drop(permit);

        let _permit = tokio::time::timeout(Duration::from_millis(100), manager.acquire_clash_api())
            .await
            .expect("gate opens after the request permit is released");
    }

    #[tokio::test]
    async fn clash_api_and_lifecycle_share_one_gate() {
        let manager = ProcessManager::new();
        let permit = manager.acquire_clash_api().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), manager.acquire_transition())
                .await
                .is_err()
        );
        drop(permit);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), manager.acquire_transition())
                .await
                .is_ok()
        );
    }
    #[tokio::test]
    async fn clash_controller_rejects_xray_runs() {
        let manager = ProcessManager::new();
        let mut status = manager.status.lock().await;
        status.status = Status::Running;
        status.engine = Some(EngineKind::Xray);
        drop(status);
        *manager.controller_url.lock().await = Some("http://127.0.0.1:9090".to_string());

        let error = manager.clash_controller().await.unwrap_err();
        assert!(error.to_string().contains("sing-box is not running"));
    }

    #[tokio::test]
    async fn clash_controller_captures_generation_and_rejects_stale_generation() {
        let manager = ProcessManager::new();
        manager.active_run_id.store(7, Ordering::Release);
        let mut status = manager.status.lock().await;
        status.status = Status::Running;
        status.engine = Some(EngineKind::Singbox);
        drop(status);
        *manager.controller_url.lock().await = Some("http://127.0.0.1:9090".to_string());

        let (run_id, url) = manager
            .clash_controller()
            .await
            .expect("controller available");
        assert_eq!(run_id, 7);
        assert_eq!(url, "http://127.0.0.1:9090");
        assert!(manager.is_active_singbox_run(run_id).await);

        manager.active_run_id.store(8, Ordering::Release);
        assert!(!manager.is_active_singbox_run(run_id).await);
    }
}

#[cfg(test)]
mod reset_tests {
    use super::*;

    #[tokio::test]
    async fn reset_clears_proxy_before_forgetting_process_state() {
        let manager = ProcessManager::new();
        manager.status.lock().await.status = Status::Running;

        manager
            .reset_with_proxy_cleanup(|| {
                assert_eq!(
                    manager
                        .status
                        .try_lock()
                        .expect("status lock is available")
                        .status,
                    Status::Running
                );
                Ok(())
            })
            .await;

        assert_eq!(manager.snapshot_status().await.status, Status::Stopped);
    }
}

#[cfg(test)]
mod engine_runtime_tests {
    use super::*;
    use crate::subscriptions::EngineKind;
    use std::ffi::OsString;

    #[cfg(windows)]
    fn test_sleep_command() -> (PathBuf, Vec<OsString>) {
        (
            PathBuf::from("powershell.exe"),
            vec![
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from("Start-Sleep -Seconds 60"),
            ],
        )
    }

    #[cfg(not(windows))]
    fn test_sleep_command() -> (PathBuf, Vec<OsString>) {
        (
            PathBuf::from("/bin/sh"),
            vec![OsString::from("-c"), OsString::from("sleep 60")],
        )
    }

    #[cfg(windows)]
    fn test_output_command(stdout: &str, stderr: &str) -> (PathBuf, Vec<OsString>) {
        (
            PathBuf::from("powershell.exe"),
            vec![
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from(format!(
                    "[Console]::Out.WriteLine('{stdout}'); [Console]::Error.WriteLine('{stderr}')"
                )),
            ],
        )
    }

    #[cfg(not(windows))]
    fn test_output_command(stdout: &str, stderr: &str) -> (PathBuf, Vec<OsString>) {
        (
            PathBuf::from("/bin/sh"),
            vec![
                OsString::from("-c"),
                OsString::from(format!(
                    "printf '%s\\n' '{stdout}'; printf '%s\\n' '{stderr}' >&2"
                )),
            ],
        )
    }

    fn test_xray_spec() -> LaunchSpec {
        let (binary, args) = test_sleep_command();
        LaunchSpec {
            engine: EngineKind::Xray,
            binary,
            args,
            env: Vec::new(),
            config_path: PathBuf::from("xray-test-config.json"),
            controller_url: Some("http://controller.test".into()),
            profile_key: Some("test-xray".into()),
            profile_name: Some("Test Xray".into()),
            diagnostics: None,
            xray_stats: None,
        }
    }

    #[tokio::test]
    async fn xray_spawned_stdio_is_not_exposed_to_frontend_logs() {
        const STDOUT_SECRET: &str = "xray-stdout-secret-marker";
        const STDERR_SECRET: &str = "xray-stderr-secret-marker";

        let pm = Arc::new(ProcessManager::new());
        let mut spec = test_xray_spec();
        let (binary, args) = test_output_command(STDOUT_SECRET, STDERR_SECRET);
        spec.binary = binary;
        spec.args = args;

        pm.start_spec(spec).await.unwrap();
        tokio::time::timeout(Duration::from_secs(15), pm.await_stdio_readers())
            .await
            .expect("Xray stdout and stderr readers drain before logs are inspected");

        let logs = pm.snapshot_logs(10).await;
        assert!(logs.iter().all(|log| !log.line.contains(STDOUT_SECRET)));
        assert!(logs.iter().all(|log| !log.line.contains(STDERR_SECRET)));
    }

    #[tokio::test]
    async fn xray_output_is_not_exposed_to_frontend_logs() {
        let manager = ProcessManager::new();
        let secret_output =
            "uuid=secret-uuid https://provider.example/sub C:\\runtime\\config.json";

        if let Some(line) = frontend_log_line(EngineKind::Xray, secret_output) {
            manager.push_log(LogStream::Stdout, line).await;
        }

        assert!(manager.snapshot_logs(10).await.is_empty());
    }

    #[tokio::test]
    async fn xray_runtime_config_path_is_not_public() {
        let manager = ProcessManager::new();
        let secret_path = PathBuf::from("C:\\runtime\\secret-xray-config.json");
        manager.status.lock().await.engine = Some(EngineKind::Xray);
        *manager.current_config.lock().await = Some(secret_path);

        assert_eq!(manager.current_config().await, None);
    }

    #[test]
    fn singbox_output_and_config_path_remain_public() {
        let line = "sing-box safe output";
        let path = PathBuf::from("C:\\runtime\\singbox-config.json");

        assert_eq!(
            frontend_log_line(EngineKind::Singbox, line),
            Some(line.to_owned())
        );
        assert_eq!(
            public_config_path(EngineKind::Singbox, path.clone()),
            Some(path)
        );
    }

    #[tokio::test]
    async fn start_rejects_second_engine_while_first_is_active() {
        let pm = Arc::new(ProcessManager::new());
        pm.install_test_child(EngineKind::Singbox).await;

        let err = pm.start_spec(test_xray_spec()).await.unwrap_err();

        assert!(matches!(err, AppError::AlreadyRunning(_)));
    }

    #[tokio::test]
    async fn xray_launch_does_not_expose_a_clash_controller() {
        let pm = Arc::new(ProcessManager::new());
        pm.start_spec(test_xray_spec()).await.unwrap();

        assert_eq!(pm.controller_url().await, None);
        pm.stop().await.unwrap();
        assert_eq!(pm.controller_url().await, None);
    }

    #[tokio::test]
    async fn spawn_failure_redacts_binary_path() {
        let pm = Arc::new(ProcessManager::new());
        let secret_path = PathBuf::from("/private/secret/sing-box");
        let mut spec = test_xray_spec();
        spec.binary = secret_path.clone();
        spec.args.clear();

        let error = pm.start_spec(spec).await.unwrap_err().to_string();

        assert!(!error.contains(secret_path.to_string_lossy().as_ref()));
        assert!(error.contains("could not start sing-box process"));
    }

    #[tokio::test]
    async fn stale_stop_finalizer_does_not_stop_newer_run() {
        let pm = ProcessManager::new();
        pm.active_run_id.store(2, Ordering::Release);
        {
            let mut status = pm.status.lock().await;
            status.status = Status::Running;
            status.engine = Some(EngineKind::Xray);
            status.profile_key = Some("newer".into());
        }

        pm.finalize_exit(1, Some(-1), Some("old stop".into()), true)
            .await;

        let status = pm.snapshot_status().await;
        assert_eq!(status.status, Status::Running);
        assert_eq!(status.profile_key.as_deref(), Some("newer"));
        assert_eq!(pm.active_run_id.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn stale_watcher_cannot_take_newer_child_slot() {
        let pm = ProcessManager::new();
        pm.install_test_child(EngineKind::Xray).await;
        let old_run_id = pm.active_run_id.load(Ordering::Acquire);
        pm.reset_with_proxy_cleanup(|| Ok(())).await;
        pm.install_test_child(EngineKind::Xray).await;
        let new_run_id = pm.active_run_id.load(Ordering::Acquire);

        assert_ne!(old_run_id, new_run_id);
        assert!(!pm.take_child_if_run(old_run_id).await);
        assert!(pm.is_running().await);
        assert!(pm.take_child_if_run(new_run_id).await);
        assert!(!pm.is_running().await);
    }

    #[tokio::test]
    async fn stale_exit_does_not_clear_a_newer_run() {
        let pm = ProcessManager::new();
        pm.active_run_id.store(2, Ordering::Release);
        {
            let mut status = pm.status.lock().await;
            status.status = Status::Running;
            status.engine = Some(EngineKind::Xray);
            status.profile_key = Some("newer".into());
        }

        pm.finalize_exit(1, Some(0), None, true).await;

        let status = pm.snapshot_status().await;
        assert_eq!(status.status, Status::Running);
        assert_eq!(status.engine, Some(EngineKind::Xray));
        assert_eq!(status.profile_key.as_deref(), Some("newer"));
    }

    #[cfg(windows)]
    #[test]
    fn proxy_only_or_unnamed_tun_cannot_select_another_apps_dns_adapter() {
        use serde_json::json;
        assert_eq!(configured_tun_interface(&json!({"inbounds":[{"type":"mixed"}]})), None);
        assert_eq!(configured_tun_interface(&json!({"inbounds":[{"type":"tun"}]})), None);
        assert_eq!(configured_tun_interface(&json!({"inbounds":[{"type":"tun","interface_name":"our-tun"}]})), Some("our-tun"));
    }
    #[tokio::test]
    async fn dns_ownership_gate_rejects_stale_or_non_singbox_runs() {
        let pm = ProcessManager::new();
        pm.active_run_id.store(7, Ordering::Release);
        {
            let mut status = pm.status.lock().await;
            status.status = Status::Running;
            status.engine = Some(EngineKind::Singbox);
        }
        assert!(pm.is_active_singbox_run(7).await);

        pm.active_run_id.store(8, Ordering::Release);
        assert!(!pm.is_active_singbox_run(7).await);

        pm.active_run_id.store(8, Ordering::Release);
        pm.status.lock().await.engine = Some(EngineKind::Xray);
        assert!(!pm.is_active_singbox_run(8).await);
    }

    #[tokio::test]
    async fn xray_exit_uses_xray_label_and_clears_metadata() {
        let pm = ProcessManager::new();
        {
            let mut status = pm.status.lock().await;
            status.engine = Some(EngineKind::Xray);
            status.profile_key = Some("profile".into());
            status.profile_name = Some("Xray profile".into());
        }

        pm.active_run_id.store(1, Ordering::Release);
        pm.finalize_exit(1, Some(0), None, true).await;

        let logs = pm.snapshot_logs(1).await;
        assert_eq!(logs[0].line, "Xray stopped");
        let status = pm.snapshot_status().await;
        assert_eq!(status.engine, None);
        assert_eq!(status.profile_key, None);
        assert_eq!(status.profile_name, None);
    }

    #[tokio::test]
    async fn xray_launch_starts_one_telemetry_owner() {
        let pm = Arc::new(ProcessManager::new());
        let status = pm.start_spec(test_xray_spec_with_stats()).await.unwrap();
        let run_id = pm.active_run_id.load(Ordering::Acquire);

        assert_eq!(status.status, Status::Running);
        assert_eq!(pm.xray_telemetry_run_id().await, Some(run_id));
        assert_eq!(pm.test_xray_telemetry_start_count().await, 1);
        pm.stop().await.unwrap();
    }

    #[tokio::test]
    async fn stopping_xray_cancels_telemetry_before_process_state_is_cleared() {
        let pm = Arc::new(ProcessManager::new());
        pm.start_spec(test_xray_spec_with_stats()).await.unwrap();

        pm.stop().await.unwrap();

        assert_eq!(pm.xray_telemetry_run_id().await, None);
        assert_eq!(pm.snapshot_status().await.status, Status::Stopped);
        assert_eq!(
            pm.test_xray_telemetry_events().await,
            vec!["start", "stop", "state_clear"]
        );
    }

    #[tokio::test]
    async fn replacing_xray_with_singbox_cannot_emit_from_old_xray_run() {
        let pm = Arc::new(ProcessManager::new());
        pm.start_spec(test_xray_spec_with_stats()).await.unwrap();
        let old_run_id = pm.active_run_id.load(Ordering::Acquire);
        pm.stop().await.unwrap();

        let singbox_spec = test_singbox_spec();
        pm.start_spec(singbox_spec).await.unwrap();
        pm.test_emit_xray_sample(old_run_id).await;

        assert_eq!(pm.test_xray_telemetry_emit_count().await, 0);
        pm.stop().await.unwrap();
    }

    #[tokio::test]
    async fn failed_xray_spawn_does_not_leave_telemetry_running() {
        let pm = Arc::new(ProcessManager::new());
        let mut spec = test_xray_spec_with_stats();
        spec.binary = PathBuf::from("definitely-missing-xray-binary");

        assert!(pm.start_spec(spec).await.is_err());
        assert_eq!(pm.xray_telemetry_run_id().await, None);
        assert_eq!(pm.test_xray_telemetry_start_count().await, 0);
    }

    fn test_xray_spec_with_stats() -> LaunchSpec {
        let mut spec = test_xray_spec();
        spec.xray_stats = Some(crate::xray::stats::XrayStatsSpec {
            api_host: "127.0.0.1".into(),
            api_port: 29001,
            traffic_tag: "xray-test".into(),
        });
        spec
    }

    fn test_singbox_spec() -> LaunchSpec {
        let mut spec = test_xray_spec();
        spec.engine = EngineKind::Singbox;
        spec.xray_stats = None;
        spec
    }

    #[tokio::test]
    async fn kill_switch_disarms_on_intentional_stop_and_holds_on_crash() {
        let pm = ProcessManager::new();
        pm.set_kill_switch_mode(crate::config::KillSwitchMode::Off)
            .await;

        // 1. Intentional stop: disarms
        pm.active_run_id.store(1, Ordering::Release);
        pm.finalize_exit(1, Some(1), None, true).await;
        assert!(!crate::killswitch::is_kill_switch_armed());

        // 2. Unexpected exit (crash): cleanly disarms without locking firewall
        pm.active_run_id.store(2, Ordering::Release);
        pm.finalize_exit(2, Some(-1), Some("unexpected crash".into()), false)
            .await;
        assert!(!crate::killswitch::is_kill_switch_armed());
    }

    #[test]
    fn stopped_status_has_no_engine_or_profile() {
        let status = StatusReport::default();

        assert_eq!(status.engine, None);
        assert_eq!(status.profile_key, None);
        assert_eq!(status.profile_name, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_process_manager_aux_child_slot_lifecycle() {
        let pm = ProcessManager::new();
        assert!(pm.aux_child.lock().await.is_none());
    }

    #[tokio::test]
    async fn test_process_manager_aux_child_termination_on_stop() {
        let pm = Arc::new(ProcessManager::new());
        pm.install_test_child(EngineKind::Xray).await;
        let run_id = pm.active_run_id();

        #[cfg(windows)]
        let (bin, args) = (
            PathBuf::from("powershell.exe"),
            vec![
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from("Start-Sleep -Seconds 60"),
            ],
        );
        #[cfg(not(windows))]
        let (bin, args) = (
            PathBuf::from("/bin/sh"),
            vec![OsString::from("-c"), OsString::from("sleep 60")],
        );

        pm.start_aux_child(run_id, bin, args, Vec::new())
            .await
            .unwrap();
        assert!(pm.aux_child.lock().await.is_some());

        pm.stop().await.unwrap();
        assert!(pm.aux_child.lock().await.is_none());
    }

    #[tokio::test]
    async fn test_process_manager_aux_child_termination_on_reset() {
        let pm = Arc::new(ProcessManager::new());
        pm.install_test_child(EngineKind::Xray).await;
        let run_id = pm.active_run_id();

        #[cfg(windows)]
        let (bin, args) = (
            PathBuf::from("powershell.exe"),
            vec![
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from("Start-Sleep -Seconds 60"),
            ],
        );
        #[cfg(not(windows))]
        let (bin, args) = (
            PathBuf::from("/bin/sh"),
            vec![OsString::from("-c"), OsString::from("sleep 60")],
        );

        pm.start_aux_child(run_id, bin, args, Vec::new())
            .await
            .unwrap();
        assert!(pm.aux_child.lock().await.is_some());

        pm.reset().await;
        assert!(pm.aux_child.lock().await.is_none());
    }

    #[tokio::test]
    async fn test_start_aux_child_aborts_if_run_inactive() {
        let pm = Arc::new(ProcessManager::new());
        #[cfg(windows)]
        let (bin, args) = (
            PathBuf::from("powershell.exe"),
            vec![
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from("Start-Sleep -Seconds 60"),
            ],
        );
        #[cfg(not(windows))]
        let (bin, args) = (
            PathBuf::from("/bin/sh"),
            vec![OsString::from("-c"), OsString::from("sleep 60")],
        );

        let res = pm.start_aux_child(999, bin, args, Vec::new()).await;
        assert!(res.is_ok());
        assert!(pm.aux_child.lock().await.is_none());
    }
}
