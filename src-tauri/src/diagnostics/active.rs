use super::{
    active_config::{AcceptedSession, ActiveLaunch, ActiveWiring, SessionSource, TargetWitness},
    coordinator::{BeginProbe, ProbeCoordinator},
    issues::{classify_runtime_issue, disconnect_issue, RuntimeIssue},
    network, network_events,
    targets::{ProbeClient, TargetSet},
    types::*,
};
use crate::{
    engine::EngineKind,
    process::{ProcessManager, Status},
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

#[derive(Debug, Clone, Default, Serialize)]
pub struct DesktopHealthSnapshot {
    pub session: Option<AcceptedSession>,
    pub health: Option<ConnectionHealth>,
    pub issue: Option<RuntimeIssue>,
    pub ended_unexpectedly: bool,
}
#[derive(Default)]
struct ActiveState {
    run: u64,
    session: Option<AcceptedSession>,
    wiring: Option<Arc<ActiveWiring>>,
    fingerprint: Option<String>,
    network_seen: bool,
    epoch: Option<u64>,
    epoch_seen: bool,
    watch_network: bool,
    target_lost: bool,
    issue: Option<RuntimeIssue>,
    ended_unexpectedly: bool,
    last_probe: Option<tokio::time::Instant>,
}
pub struct SessionDiagnostics {
    state: Mutex<ActiveState>,
    pub(crate) coordinator: Arc<ProbeCoordinator>,
}
impl Default for SessionDiagnostics {
    fn default() -> Self {
        Self {
            state: Mutex::new(ActiveState::default()),
            coordinator: Arc::new(ProbeCoordinator::default()),
        }
    }
}
impl SessionDiagnostics {
    pub fn accept(&self, run: u64, engine: EngineKind, launch: Option<ActiveLaunch>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        self.coordinator.invalidate();
        let launch = launch.unwrap_or_else(|| {
            ActiveLaunch::unavailable(SessionSource::new(
                ProfileRef::Auto {
                    snapshot_id: uuid::Uuid::new_v4().to_string(),
                },
                None,
                &serde_json::json!({"run":run}),
            ))
        });
        *state = ActiveState {
            run,
            session: Some(launch.source.accepted(&run.to_string(), engine)),
            wiring: launch.wiring,
            ..ActiveState::default()
        };
    }
    pub fn retire(&self, run: u64, intentional: bool) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run != run {
            return;
        }
        self.coordinator.invalidate();
        if intentional {
            *state = ActiveState::default();
            return;
        }
        state.run = 0;
        state.wiring = None;
        state.ended_unexpectedly = true;
        state.issue = Some(disconnect_issue(&run.to_string(), state.issue.take()));
    }
    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        self.coordinator.invalidate();
        *state = ActiveState::default();
    }
    pub fn snapshot(&self) -> DesktopHealthSnapshot {
        self.synchronize_epoch();
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let health = self.coordinator.snapshot().active_session.filter(|h| {
            state.run != 0
                && state
                    .session
                    .as_ref()
                    .is_some_and(|s| s.identity == h.identity)
        });
        DesktopHealthSnapshot {
            session: state.session.clone(),
            health,
            issue: state.issue.clone(),
            ended_unexpectedly: state.ended_unexpectedly,
        }
    }
    pub fn observe_line(&self, run: u64, line: &str) {
        let Some(code) = classify_runtime_issue(line) else {
            return;
        };
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run != run || run == 0 {
            return;
        }
        let mut issue = RuntimeIssue::notice(&run.to_string(), code);
        if let Some(previous) = &state.issue {
            if previous.code == code {
                issue.count = previous.count.saturating_add(1).min(1000);
            }
        }
        state.issue = Some(issue);
    }
    pub fn observe_network(&self, run: u64, fingerprint: Option<String>) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run != run || run == 0 {
            return false;
        }
        if state.network_seen && state.fingerprint == fingerprint {
            return false;
        }
        state.network_seen = true;
        state.fingerprint = fingerprint;
        if let Some(session) = state.session.as_mut() {
            session.identity.network_generation = uuid::Uuid::new_v4().to_string();
        }
        self.coordinator.invalidate();
        true
    }
    pub(crate) fn observe_epoch(&self, run: u64, epoch: Option<u64>) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run != run || run == 0 || state.epoch_seen && state.epoch == epoch {
            return false;
        }
        state.epoch_seen = true;
        state.epoch = epoch;
        state.network_seen = false;
        state.fingerprint = None;
        if let Some(session) = state.session.as_mut() {
            session.identity.network_generation = uuid::Uuid::new_v4().to_string();
        }
        self.coordinator.invalidate();
        true
    }
    fn synchronize_epoch(&self) {
        let run = {
            let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if s.watch_network {
                s.run
            } else {
                0
            }
        };
        if run != 0 {
            self.observe_epoch(run, network_events::generation());
        }
    }
    pub(crate) fn session_for_run(&self, run: u64) -> Option<AcceptedSession> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.run == run && run != 0 {
            s.session.clone()
        } else {
            None
        }
    }
    /// Retry transient discovery failures inside the deduplicated probe lease.
    /// Readiness may improve without changing the same OS network generation.
    pub(crate) async fn refresh_failed_network<F, Fut, E>(
        &self,
        run: u64,
        expected: &SessionIdentity,
        discover: F,
        epoch: E,
    ) -> bool
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Option<String>>,
        E: Fn() -> Option<u64>,
    {
        let observed = {
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.run != run || state.session.as_ref().map(|s| &s.identity) != Some(expected) {
                return false;
            }
            if state.fingerprint.is_some() {
                return true;
            }
            let Some(observed) = state.epoch else {
                return false;
            };
            observed
        };
        let fingerprint = discover().await;
        if epoch() != Some(observed) {
            return false;
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run != run
            || state.epoch != Some(observed)
            || state.session.as_ref().map(|s| &s.identity) != Some(expected)
        {
            return false;
        }
        state.network_seen = true;
        state.fingerprint = fingerprint;
        state.fingerprint.is_some()
    }
    fn target_availability(&self, run: u64, available: bool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run != run || run == 0 || state.target_lost == !available {
            return false;
        }
        state.target_lost = !available;
        if !available {
            if let Some(session) = state.session.as_mut() {
                session.identity.effective_outbound_revision =
                    Some(uuid::Uuid::new_v4().to_string());
            }
            self.coordinator.invalidate();
        }
        true
    }
    pub fn target_changed(&self, run: u64) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run != run || run == 0 {
            return;
        }
        state.wiring = None;
        if let Some(session) = state.session.as_mut() {
            session.identity.profile_ref = ProfileRef::Auto {
                snapshot_id: uuid::Uuid::new_v4().to_string(),
            };
            session.identity.effective_outbound_revision = Some(uuid::Uuid::new_v4().to_string());
            session.display_name = None;
        }
        self.coordinator.invalidate();
    }
    pub(crate) fn automatic_probe_due(&self, run: u64, now: tokio::time::Instant) -> bool {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.run == run
            && run != 0
            && state
                .last_probe
                .is_none_or(|last| now.saturating_duration_since(last) >= Duration::from_secs(3600))
    }
    pub(crate) fn begin(&self, expected: &SessionIdentity) -> Result<BeginProbe, HealthIssue> {
        self.begin_with_interval(expected, false)
    }
    pub(crate) fn begin_with_interval(
        &self,
        expected: &SessionIdentity,
        automatic: bool,
    ) -> Result<BeginProbe, HealthIssue> {
        self.synchronize_epoch();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.run == 0
            || !state
                .session
                .as_ref()
                .is_some_and(|s| &s.identity == expected)
        {
            return Err(HealthIssue::UnsupportedProbe);
        }
        // Admission and deadline update share the lock: a manual request may
        // have completed since the monitor last observed its due hint.
        if automatic
            && state
                .last_probe
                .is_some_and(|last| last.elapsed() < Duration::from_secs(3600))
        {
            return Err(HealthIssue::UnsupportedProbe);
        }
        let begin = self
            .coordinator
            .begin(expected.clone(), HealthScope::ActiveSession);
        if begin.lease.is_some() {
            state.last_probe = Some(tokio::time::Instant::now());
        }
        Ok(begin)
    }
    fn owned(&self, run: u64) -> bool {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        s.run == run && run != 0
    }
    pub fn cancel(&self, operation: &str) -> bool {
        self.coordinator.cancel(operation)
    }
    pub(crate) fn recovery_identity_matches(&self, expected: &SessionIdentity) -> bool {
        self.current(expected)
    }
    fn current(&self, expected: &SessionIdentity) -> bool {
        self.synchronize_epoch();
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.run != 0
            && state
                .session
                .as_ref()
                .is_some_and(|s| &s.identity == expected)
    }
}

pub(crate) async fn perform_check(
    wiring: &ActiveWiring,
    targets: &TargetSet,
) -> Result<u64, HealthIssue> {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if super::desktop::requires_proxy_auth(wiring.port).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| HealthIssue::EngineUnavailable)?;
    if !wiring.matches_current_target().await {
        return Err(HealthIssue::UnsupportedProbe);
    }
    let result = ProbeClient::new(wiring.port, &wiring.password)?
        .check(targets)
        .await;
    if !wiring.matches_current_target().await {
        return Err(HealthIssue::UnsupportedProbe);
    }
    result
}

impl SessionDiagnostics {
    pub fn request(
        self: &Arc<Self>,
        manager: Arc<ProcessManager>,
        expected: SessionIdentity,
    ) -> Result<String, HealthIssue> {
        self.request_inner(manager, expected, TargetSet::default(), false)
    }
    #[cfg(test)]
    pub(crate) fn request_fixture(
        self: &Arc<Self>,
        manager: Arc<ProcessManager>,
        expected: SessionIdentity,
        targets: TargetSet,
    ) -> Result<String, HealthIssue> {
        assert!(targets.only_loopback_fixture());
        self.request_inner(manager, expected, targets, false)
    }
    fn request_inner(
        self: &Arc<Self>,
        manager: Arc<ProcessManager>,
        expected: SessionIdentity,
        targets: TargetSet,
        automatic: bool,
    ) -> Result<String, HealthIssue> {
        let begin = if automatic {
            self.begin_with_interval(&expected, true)?
        } else {
            self.begin(&expected)?
        };
        let operation = begin.operation_id.clone();
        if let Some(lease) = begin.lease {
            let this = self.clone();
            // Retry is also called from a synchronous Tauri command (UI thread).
            // Use the application runtime; tokio::spawn would panic without an entered runtime.
            tauri::async_runtime::spawn(async move {
                let run = expected
                    .run_id
                    .as_deref()
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let (wiring, network_ready) = {
                    let state = this.state.lock().unwrap_or_else(|p| p.into_inner());
                    (
                        state.wiring.clone(),
                        state.network_seen
                            && state.fingerprint.is_some()
                            && (!state.watch_network || state.epoch.is_some()),
                    )
                };
                let work = async {
                    if !this.current(&expected) || !manager.probe_run_alive(run).await {
                        return ProbeResult::unavailable(HealthIssue::EngineUnavailable);
                    }
                    let Some(wiring) = wiring else {
                        return ProbeResult::unavailable(HealthIssue::UnsupportedProbe);
                    };
                    if !network_ready
                        && !this
                            .refresh_failed_network(
                                run,
                                &expected,
                                || async {
                                    network::discover()
                                        .await
                                        .ok()
                                        .map(|n| n.fingerprint().to_owned())
                                },
                                network_events::generation,
                            )
                            .await
                    {
                        return ProbeResult::unavailable(HealthIssue::NetworkUnavailable);
                    }
                    let result = perform_check(&wiring, &targets).await;
                    if !manager.probe_run_alive(run).await {
                        return ProbeResult::unavailable(HealthIssue::EngineUnavailable);
                    }
                    if !this.current(&expected) {
                        return ProbeResult::unavailable(HealthIssue::NetworkUnavailable);
                    }
                    match result {
                        Ok(ms) => ProbeResult::healthy(ms),
                        Err(issue) => ProbeResult::unavailable(issue),
                    }
                };
                this.coordinator.execute(lease, work, async {}).await;
                let mut state = this.state.lock().unwrap_or_else(|p| p.into_inner());
                if state.run == run
                    && this.coordinator.snapshot().active_session.is_some_and(|h| {
                        h.identity == expected && h.outcome == HealthOutcome::Healthy
                    })
                {
                    state.issue = None;
                }
            });
        }
        Ok(operation)
    }
    pub fn spawn_monitor(self: &Arc<Self>, manager: Weak<ProcessManager>, run: u64) {
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.run != run {
                return;
            }
            state.watch_network = true;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let mut initial = true;
            let mut last_target_check = tokio::time::Instant::now();
            loop {
                let Some(manager) = manager.upgrade() else {
                    break;
                };
                if !this.owned(run) || manager.active_run_id() != run {
                    break;
                }
                if manager.snapshot_status().await.status != Status::Running {
                    break;
                }
                let epoch = network_events::generation();
                let changed = this.observe_epoch(run, epoch);
                let undiscovered = {
                    let state = this.state.lock().unwrap_or_else(|p| p.into_inner());
                    state.run == run && !state.network_seen
                };
                if initial || changed || undiscovered && epoch.is_some() {
                    initial = false;
                    if epoch.is_some() {
                        let network = network::discover()
                            .await
                            .ok()
                            .map(|n| n.fingerprint().to_owned());
                        if !this.owned(run) {
                            break;
                        }
                        if network_events::generation() != epoch {
                            continue;
                        }
                        this.observe_network(run, network);
                    }
                } else if last_target_check.elapsed() >= Duration::from_secs(2) {
                    last_target_check = tokio::time::Instant::now();
                    let wiring = {
                        this.state
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .wiring
                            .clone()
                    };
                    if let Some(wiring) = wiring {
                        match wiring.target_witness().await {
                            TargetWitness::Matches => {
                                this.target_availability(run, true);
                            }
                            TargetWitness::Unavailable => {
                                this.target_availability(run, false);
                            }
                            TargetWitness::Changed => {
                                manager.recovery.target_changed(run);
                                this.target_changed(run);
                            }
                        };
                    }
                }
                // Network/member changes invalidate stale evidence but do not trigger
                // repeated server probes. Manual requests bypass this hourly gate.
                if this.automatic_probe_due(run, tokio::time::Instant::now()) {
                    if let Some(session) = this.session_for_run(run) {
                        let _ = this.request_inner(
                            manager.clone(),
                            session.identity,
                            TargetSet::default(),
                            true,
                        );
                    }
                }
                drop(manager);
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
    }
}
