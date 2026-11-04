//! Sole native recovery owner. Snapshots contain secrets and are never serialized.
use super::{
    intent::{Intent, Token},
    policy::{Decision, Evidence, Policy},
};
use crate::{
    diagnostics::{
        self,
        coordinator::ProbeCoordinator,
        desktop::{DesktopProbe, DesktopProbeRequest},
        types::*,
    },
    engine::LaunchSpec,
    process::ProcessManager,
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Snapshot {
    pub spec: LaunchSpec,
    pub config: Arc<Vec<u8>>,
    pub proxy: Option<(String, u16, u16)>,
    pub auxiliary: Option<Auxiliary>,
}
#[derive(Clone)]
pub struct Auxiliary {
    pub binary: std::path::PathBuf,
    pub args: Vec<std::ffi::OsString>,
    pub env: Vec<(String, String)>,
    pub config: Option<(std::path::PathBuf, Arc<Vec<u8>>)>,
}
impl Snapshot {
    pub fn capture(spec: &LaunchSpec) -> Option<Self> {
        let config = std::fs::read(&spec.config_path).ok()?;
        Some(Self {
            spec: spec.clone(),
            config: Arc::new(config),
            proxy: None,
            auxiliary: None,
        })
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct RecoveryStatus {
    pub enabled: bool,
    pub phase: &'static str,
    pub attempts: usize,
    pub issue: Option<&'static str>,
    pub run_id: Option<String>,
}
#[derive(Clone, Copy)]
pub enum Acceptance {
    Manual(u64),
    Recovery(Token),
}
#[derive(Default)]
struct State {
    intent: Intent<Snapshot>,
    policy: Policy,
    phase: Option<&'static str>,
    issue: Option<&'static str>,
    dead_proven: Option<u64>,
    proven_network: Option<diagnostics::network::PhysicalNetwork>,
    proof_epoch: Option<u64>,
    manual_ticket: Option<u64>,
    attempt: Option<(Token, bool)>,
}
pub struct RecoveryCoordinator {
    state: Mutex<State>,
    origin: Instant,
    probe_budget: Duration,
    candidate: Arc<ProbeCoordinator>,
}
impl Default for RecoveryCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            origin: Instant::now(),
            probe_budget: Duration::from_secs(10),
            candidate: Arc::new(ProbeCoordinator::default()),
        }
    }
}
pub struct ManualRequest(Arc<RecoveryCoordinator>);
impl Drop for ManualRequest {
    fn drop(&mut self) {
        let mut s = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        s.intent.pending_manual = s.intent.pending_manual.saturating_sub(1);
    }
}
impl RecoveryCoordinator {
    fn now(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }
    fn invalidate_state(s: &mut State) {
        s.intent.invalidate();
        s.manual_ticket = None;
        s.policy.cancel();
        s.phase = None;
        s.issue = None;
    }
    pub fn manual_request(self: &Arc<Self>) -> ManualRequest {
        self.candidate.invalidate();
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Self::invalidate_state(&mut s);
        s.intent.pending_manual += 1;
        ManualRequest(self.clone())
    }
    pub fn manual_profile_check(
        self: &Arc<Self>,
        next: impl FnOnce() -> u64,
    ) -> (ManualRequest, u64) {
        self.candidate.invalidate();
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Self::invalidate_state(&mut s);
        s.intent.pending_manual += 1;
        let ticket = next();
        s.manual_ticket = Some(ticket);
        (ManualRequest(self.clone()), ticket)
    }
    /// Intent cancellation and the native ready-check epoch share one lock.
    pub fn invalidate(&self) {
        self.candidate.invalidate();
        Self::invalidate_state(&mut self.state.lock().unwrap_or_else(|p| p.into_inner()));
    }
    pub(crate) async fn shutdown_probes(&self) {
        self.stop();
        self.candidate.shutdown().await;
    }
    pub fn stop(&self) {
        self.stop_with(|| ());
    }
    pub fn stop_with<R>(&self, invalidate_native: impl FnOnce() -> R) -> R {
        self.candidate.invalidate();
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Self::invalidate_state(&mut s);
        s.intent.accepted = None;
        invalidate_native()
    }
    pub fn set_enabled(&self, enabled: bool) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.intent.enabled == enabled {
            return;
        }
        s.intent.invalidate();
        s.intent.enabled = enabled;
        s.policy.enabled = enabled;
        s.policy.cancel();
        s.phase = None;
        s.issue = None;
        drop(s);
        self.candidate.invalidate();
        if enabled {
            if let Some(generation) = diagnostics::network_events::generation() {
                self.event(generation);
            }
        }
    }
    pub fn status(&self) -> RecoveryStatus {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        RecoveryStatus {
            enabled: s.intent.enabled,
            phase: s.phase.unwrap_or("idle"),
            attempts: s.policy.attempts,
            issue: s.issue,
            run_id: s.intent.accepted.as_ref().map(|(run, _)| run.to_string()),
        }
    }
    pub fn profile_check(&self, next: impl FnOnce() -> u64) -> u64 {
        self.candidate.invalidate();
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Self::invalidate_state(&mut s);
        let ticket = next();
        s.manual_ticket = Some(ticket);
        ticket
    }
    pub fn accept_checked(&self, run: u64, snapshot: Option<Snapshot>, proof: Acceptance) -> bool {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let recovering = match proof {
            Acceptance::Manual(ticket) => {
                if s.manual_ticket != Some(ticket) {
                    return false;
                }
                false
            }
            Acceptance::Recovery(token) => {
                if !s.intent.current(token)
                    || diagnostics::network_events::wake_generation() != token.wake
                {
                    return false;
                }
                true
            }
        };
        if !recovering {
            s.intent.invalidate();
            s.manual_ticket = None;
            s.attempt = None;
            s.policy = Policy::default();
            s.policy.enabled = s.intent.enabled;
        }
        s.dead_proven = None;
        s.phase = None;
        s.issue = None;
        if let Some(snapshot) = snapshot {
            s.intent.capture(run, snapshot);
        } else {
            s.intent.accepted = None;
            s.phase = Some("unavailable");
            s.issue = Some("engine_unavailable");
        }
        true
    }
    #[cfg(test)]
    pub fn accept(&self, run: u64, snapshot: Snapshot, recovering: bool) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !recovering {
            s.intent.invalidate();
            s.policy = Policy::default();
            s.attempt = None;
            s.policy.enabled = s.intent.enabled;
        }
        s.intent.capture(run, snapshot);
        s.phase = None;
        s.issue = None;
        s.dead_proven = None;
    }
    /// A runtime selector change cannot be attributed by replaying old config.
    /// Keep live traffic intact; only a new manual launch can capture it safely.
    pub fn target_changed(&self, run: u64) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.intent.accepted.as_ref().map(|(owned, _)| *owned) != Some(run) {
            return;
        }
        s.intent.invalidate();
        s.intent.accepted = None;
        s.policy.cancel();
        s.phase = Some("unavailable");
        s.issue = Some("unsupported_probe");
        self.candidate.invalidate();
    }
    pub fn capture_auxiliary(&self, run: u64, auxiliary: Auxiliary) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((owned, snapshot)) = s.intent.accepted.as_mut() {
            if *owned == run {
                snapshot.auxiliary = Some(auxiliary);
            }
        }
    }
    pub fn capture_proxy(&self, run: u64, proxy: Option<(String, u16, u16)>) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((owned, snapshot)) = s.intent.accepted.as_mut() {
            if *owned == run {
                snapshot.proxy = proxy;
            }
        }
    }
    pub(crate) fn mark_restarting(&self, token: Token) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.intent.current(token) {
            s.dead_proven = Some(token.run);
            if let Some((owner, started)) = s.attempt.as_mut() {
                if *owner == token {
                    *started = true;
                }
            }
        }
    }
    pub fn current(&self, token: Token) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .intent
            .current(token)
            && diagnostics::network_events::wake_generation() == token.wake
    }
    pub(crate) async fn physical_matches(&self, token: Token, check_epoch: bool) -> bool {
        if !self.current(token) {
            return false;
        }
        let (network, epoch) = {
            let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            (s.proven_network.clone(), s.proof_epoch)
        };
        if check_epoch && diagnostics::network_events::generation() != epoch {
            return false;
        }
        let current = diagnostics::network::discover().await.ok();
        network.is_some()
            && current == network
            && self.current(token)
            && (!check_epoch || diagnostics::network_events::generation() == epoch)
    }
    fn event(&self, generation: u64) {
        self.candidate.invalidate();
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        s.intent.network = generation;
        s.intent.wake = diagnostics::network_events::wake_generation();
        if s.intent.token().is_some() && !s.policy.is_exhausted() {
            s.policy.event(self.now(), &generation.to_string());
            s.phase = Some("waiting");
            s.issue = None;
        }
    }
    fn snapshot(&self) -> Option<(Token, Snapshot)> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Some((s.intent.token()?, s.intent.accepted.as_ref()?.1.clone()))
    }
    fn report(&self, token: Token, phase: &'static str, issue: Option<&'static str>) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.intent.current(token) {
            s.phase = Some(phase);
            s.issue = issue;
        }
    }
    fn attempt_finished(&self, token: Token) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some((owner, started)) = s.attempt else {
            return;
        };
        if owner != token {
            return;
        }
        s.attempt = None;
        if started {
            s.policy.attempt_finished(self.now());
        } else {
            s.policy.abandon_unstarted();
        }
    }
    fn observe(&self, token: Token, evidence: Evidence) -> Decision {
        if !self.current(token) {
            return Decision::Cancel;
        }
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !s.intent.current(token) {
            return Decision::Cancel;
        }
        let decision = s.policy.observe(self.now(), evidence);
        if decision == Decision::Reconnect {
            s.attempt = Some((token, false));
        }
        if decision == Decision::GiveUp {
            s.phase = Some("exhausted");
            s.issue = Some(
                s.issue
                    .filter(|issue| matches!(*issue, "authentication" | "permission_required"))
                    .unwrap_or(if evidence == Evidence::Authentication {
                        "authentication"
                    } else {
                        "retry_exhausted"
                    }),
            );
        } else if matches!(evidence, Evidence::Healthy) {
            s.phase = None;
            s.issue = None;
        }
        decision
    }
    async fn guarded_probe<T>(
        &self,
        token: Token,
        work: impl std::future::Future<Output = T>,
    ) -> Option<T> {
        self.guarded(token, tokio::time::Instant::now() + self.probe_budget, work)
            .await
    }
    async fn cancelled(&self, token: Token) {
        loop {
            if !self.current(token) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    async fn guarded<T>(
        &self,
        token: Token,
        deadline: tokio::time::Instant,
        work: impl std::future::Future<Output = T>,
    ) -> Option<T> {
        tokio::select! {biased;
            _=self.cancelled(token)=>None,
            _=tokio::time::sleep_until(deadline)=>None,
            result=work=>Some(result)
        }
    }
    async fn same_network(
        &self,
        token: Token,
        epoch: Option<u64>,
        network: &diagnostics::network::PhysicalNetwork,
    ) -> bool {
        let result = self
            .guarded(
                token,
                tokio::time::Instant::now() + Duration::from_secs(3),
                diagnostics::network::discover(),
            )
            .await;
        result.is_some_and(|r| r.is_ok_and(|current| &current == network))
            && self.current(token)
            && diagnostics::network_events::generation() == epoch
    }
    /// No boolean 'not alive' heuristic: only owned exit or finalized unexpected exit.
    async fn evidence(
        &self,
        pm: &Arc<ProcessManager>,
        app: &tauri::AppHandle,
        token: Token,
        snapshot: &Snapshot,
    ) -> Evidence {
        if !self.current(token) {
            return Evidence::Unavailable;
        }
        let proof_epoch = diagnostics::network_events::generation();
        let active = pm.diagnostics.snapshot();
        if active.issue.as_ref().is_some_and(|i| {
            matches!(
                i.code,
                HealthIssue::Authentication
                    | HealthIssue::RealityVerification
                    | HealthIssue::TlsVerification
            )
        }) {
            return Evidence::Authentication;
        }
        let Some(Ok(network)) = self
            .guarded_probe(token, diagnostics::network::discover())
            .await
        else {
            self.report(token, "unavailable", Some("network_unavailable"));
            return Evidence::Unavailable;
        };
        if !self.current(token) || diagnostics::network_events::generation() != proof_epoch {
            return Evidence::Unavailable;
        }
        {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if !s.intent.current(token) {
                return Evidence::Unavailable;
            }
            s.proven_network = Some(network.clone());
            s.proof_epoch = proof_epoch;
        }
        let known_dead = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .dead_proven
            == Some(token.run);
        if pm.recovery_engine_dead(token.run).await || known_dead && pm.active_run_id() == 0 {
            self.state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .dead_proven = Some(token.run);
            return Evidence::DeadEngine;
        }
        if pm.active_run_id() != token.run {
            return Evidence::Unavailable;
        }
        let Some(launch) = snapshot.spec.diagnostics.as_ref() else {
            self.report(token, "unavailable", Some("unsupported_probe"));
            return Evidence::Unavailable;
        };
        let Some(wiring) = launch.wiring.as_ref() else {
            self.report(token, "unavailable", Some("unsupported_probe"));
            return Evidence::Unavailable;
        };
        let Some(identity) = active.session.map(|s| s.identity) else {
            return Evidence::Unavailable;
        };
        if !pm.diagnostics.recovery_identity_matches(&identity) {
            return Evidence::Unavailable;
        }
        for failure in 0..2 {
            let targets = diagnostics::targets::TargetSet::default();
            let Some(result) = self
                .guarded_probe(token, diagnostics::active::perform_check(wiring, &targets))
                .await
            else {
                self.report(token, "unavailable", Some("network_unavailable"));
                return Evidence::Unavailable;
            };
            if !self.current(token)
                || diagnostics::network_events::generation() != proof_epoch
                || !pm.diagnostics.recovery_identity_matches(&identity)
                || !self.same_network(token, proof_epoch, &network).await
            {
                return Evidence::Unavailable;
            }
            match result {
                Ok(_) => return Evidence::Healthy,
                Err(
                    HealthIssue::Authentication
                    | HealthIssue::RealityVerification
                    | HealthIssue::TlsVerification,
                ) => return Evidence::Authentication,
                Err(
                    HealthIssue::EndpointUnreachable
                    | HealthIssue::Timeout
                    | HealthIssue::ProbeTargetUnavailable,
                ) => {}
                _ => {
                    self.report(token, "unavailable", Some("unsupported_probe"));
                    return Evidence::Unavailable;
                }
            }
            if failure == 0 {
                self.observe(token, Evidence::ActiveFailure);
                if self
                    .guarded_probe(token, tokio::time::sleep(Duration::from_millis(250)))
                    .await
                    .is_none()
                {
                    return Evidence::Unavailable;
                }
            }
        }
        if self.observe(token, Evidence::ActiveFailure) != Decision::ProbeCandidate {
            return Evidence::Unavailable;
        }
        // Candidate is built from captured accepted bytes, never current provider storage.
        let Ok(config) = serde_json::from_slice::<serde_json::Value>(&snapshot.config) else {
            return Evidence::Unavailable;
        };
        let request = DesktopProbeRequest::from_resolved(
            app,
            snapshot.spec.engine,
            config,
            wiring.target().into(),
            network.clone(),
        );
        let Ok(request) = request else {
            self.report(token, "unavailable", Some("unsupported_probe"));
            return Evidence::Unavailable;
        };
        let mut candidate_identity = identity.clone();
        candidate_identity.run_id = None;
        let begin = self
            .candidate
            .begin(candidate_identity, HealthScope::SelectedProfile);
        if let Some(lease) = begin.lease {
            // Each distinct active/candidate probe gets a fresh bounded window.
            // Two full active timeouts must not consume the candidate's budget.
            let deadline = tokio::time::Instant::now() + self.probe_budget;
            let execute = DesktopProbe::execute(&self.candidate, lease, request);
            tokio::pin!(execute);
            let interrupted = tokio::select! {biased;
                _=self.cancelled(token)=>true,
                _=tokio::time::sleep_until(deadline)=>true,
                _=&mut execute=>false
            };
            if interrupted {
                self.candidate.invalidate();
                // Complete the adapter's bounded cleanup, never drop its owner.
                execute.await;
                self.report(token, "unavailable", Some("network_unavailable"));
                return Evidence::Unavailable;
            }
        }
        if !self.current(token)
            || diagnostics::network_events::generation() != proof_epoch
            || !pm.diagnostics.recovery_identity_matches(&identity)
            || !self.same_network(token, proof_epoch, &network).await
        {
            return Evidence::Unavailable;
        }
        if self.candidate.snapshot().selected_profile.is_some_and(|h| {
            h.operation_id == begin.operation_id && h.outcome == HealthOutcome::Healthy
        }) {
            Evidence::CandidateHealthy
        } else {
            self.report(token, "unavailable", Some("network_unavailable"));
            Evidence::Unavailable
        }
    }
    pub fn spawn(self: &Arc<Self>, manager: Weak<ProcessManager>, app: tauri::AppHandle) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut generation = diagnostics::network_events::generation();
            let mut wake = diagnostics::network_events::wake_generation();
            let mut physical = super::event_filter::PhysicalEvents::default();
            let mut last_health = Instant::now();
            let mut last_dead_run = 0;
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let Some(pm) = manager.upgrade() else {
                    break;
                };
                let Some((_, _)) = this.snapshot() else {
                    physical = super::event_filter::PhysicalEvents::default();
                    continue;
                };
                let observed = diagnostics::network_events::generation();
                let observed_wake = diagnostics::network_events::wake_generation();
                if observed != generation || observed_wake != wake || !physical.seen() {
                    let path = diagnostics::network::discover().await.ok();
                    if diagnostics::network_events::generation() != observed {
                        continue;
                    }
                    let changed = physical.observe(path, observed_wake);
                    generation = observed;
                    wake = observed_wake;
                    if changed {
                        if let Some(g) = observed {
                            this.event(g);
                        }
                    }
                }
                let Some((token, snapshot)) = this.snapshot() else {
                    continue;
                };
                if !this.current(token) {
                    continue;
                }
                if token.run != last_dead_run && pm.recovery_engine_dead(token.run).await {
                    last_dead_run = token.run;
                    this.event(token.network);
                }
                let mut decision = {
                    this.state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .policy
                        .next(this.now())
                };
                // Stable health resets budget only after a sequence of fresh checks.
                let verify_stable = {
                    this.state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .policy
                        .attempts
                        > 0
                };
                if matches!(decision, Decision::Cancel | Decision::GiveUp)
                    && verify_stable
                    && last_health.elapsed() >= Duration::from_secs(10)
                    && (decision != Decision::GiveUp || pm.probe_run_alive(token.run).await)
                {
                    decision = Decision::ProbeActive;
                }
                if !matches!(decision, Decision::ProbeActive | Decision::Reconnect) {
                    continue;
                }
                last_health = Instant::now();
                this.report(token, "checking", None);
                let evidence = this.evidence(&pm, &app, token, &snapshot).await;
                if !this.current(token) {
                    continue;
                }
                let action = this.observe(token, evidence);
                if action == Decision::Reconnect
                    && matches!(evidence, Evidence::DeadEngine | Evidence::CandidateHealthy)
                {
                    this.report(token, "recovering", None);
                    let result = pm.restart_recovery(Some(&app), token, snapshot).await;
                    this.attempt_finished(token);
                    match result {
                        Ok(_) => {}
                        Err(crate::error::AppError::TunCapabilities(_)) => {
                            this.report(token, "exhausted", Some("permission_required"));
                            let mut s = this.state.lock().unwrap_or_else(|p| p.into_inner());
                            if s.intent.current(token) {
                                s.policy.observe(this.now(), Evidence::Authentication);
                            }
                        }
                        Err(crate::error::AppError::ProfileCheck(
                            crate::config::preflight::ProfileCheckIssue::Cancelled,
                        )) => {
                            this.report(token, "unavailable", Some("network_unavailable"));
                            this.observe(token, Evidence::Unavailable);
                        }
                        Err(_) => {
                            this.observe(token, Evidence::DeadEngine);
                        }
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineKind;
    fn fixture(path: std::path::PathBuf) -> Snapshot {
        let spec = LaunchSpec {
            engine: EngineKind::Singbox,
            binary: "not-a-core".into(),
            args: vec![],
            env: vec![],
            config_path: path,
            controller_url: None,
            profile_key: Some("accepted-A".into()),
            profile_name: None,
            diagnostics: None,
            xray_stats: None,
        };
        Snapshot::capture(&spec).unwrap()
    }
    #[test]
    fn accepted_snapshot_survives_config_and_ui_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accepted.json");
        std::fs::write(&path, br#"{"outbounds":[{"tag":"A"}]}"#).unwrap();
        let snapshot = fixture(path.clone());
        std::fs::write(&path, br#"{"outbounds":[{"tag":"foreign B"}]}"#).unwrap();
        assert_eq!(
            snapshot.config.as_slice(),
            br#"{"outbounds":[{"tag":"A"}]}"#
        );
        assert_eq!(snapshot.spec.profile_key.as_deref(), Some("accepted-A"));
    }
    #[test]
    fn manual_request_blocks_recovery_and_rejection_preserves_previous_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, b"{}").unwrap();
        let c = Arc::new(RecoveryCoordinator::default());
        c.accept(7, fixture(path), false);
        let before = c.state.lock().unwrap().intent.epoch;
        let guard = c.manual_request();
        {
            let s = c.state.lock().unwrap();
            assert!(s.intent.epoch > before);
            assert_eq!(s.intent.pending_manual, 1);
            assert_eq!(s.intent.accepted.as_ref().unwrap().0, 7);
        }
        drop(guard);
        assert_eq!(c.state.lock().unwrap().intent.pending_manual, 0);
        assert_eq!(c.status().run_id.as_deref(), Some("7"));
    }
    #[test]
    fn duplicate_setting_does_not_cancel_or_reset_budget() {
        let c = RecoveryCoordinator::default();
        {
            let mut s = c.state.lock().unwrap();
            s.intent.enabled = true;
            s.policy.enabled = true;
            s.policy.attempts = 2;
        }
        let before = c.state.lock().unwrap().intent.epoch;
        c.set_enabled(true);
        assert_eq!(c.status().attempts, 2);
        assert_eq!(c.state.lock().unwrap().intent.epoch, before);
        c.set_enabled(false);
        assert!(!c.status().enabled);
        assert_eq!(c.status().attempts, 2);
    }
    #[test]
    fn recovery_accept_keeps_budget_manual_accept_starts_new_intent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, b"{}").unwrap();
        let c = RecoveryCoordinator::default();
        c.state.lock().unwrap().policy.attempts = 2;
        c.accept(2, fixture(path.clone()), true);
        assert_eq!(c.status().attempts, 2);
        c.accept(3, fixture(path), false);
        assert_eq!(c.status().attempts, 0);
    }
    #[test]
    fn callbacks_cannot_hide_terminal_issue() {
        let c = RecoveryCoordinator::default();
        {
            let mut s = c.state.lock().unwrap();
            s.intent.enabled = true;
            s.policy.enabled = true;
            s.policy.observe(0, Evidence::Authentication);
            s.phase = Some("exhausted");
            s.issue = Some("authentication");
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("a.json");
            std::fs::write(&path, b"{}").unwrap();
            s.intent.capture(1, fixture(path));
        }
        c.event(9);
        assert_eq!(c.status().phase, "exhausted");
        assert_eq!(c.status().issue, Some("authentication"));
    }
    #[tokio::test]
    async fn recovery_snapshot_ignores_catalog_revision_but_not_manual_stop() {
        let pm = Arc::new(ProcessManager::new());
        let ticket = pm.begin_ready_profile_check();
        {
            let _mutation = diagnostics::sources::catalog_mutation().unwrap();
        }
        assert!(pm.is_launch_check_current(ticket, true));
        assert!(!pm.is_launch_check_current(ticket, false));
        let _ = pm.stop().await;
        assert!(!pm.is_launch_check_current(ticket, true));
    }
    #[test]
    fn stop_or_new_request_before_accept_cannot_recapture_old_run() {
        for recovering in [false, true] {
            for stop in [true, false] {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("a.json");
                std::fs::write(&path, b"{}").unwrap();
                let c = Arc::new(RecoveryCoordinator::default());
                let ticket = c.profile_check(|| 1);
                let snapshot = fixture(path);
                let proof = if recovering {
                    {
                        let mut s = c.state.lock().unwrap();
                        s.intent.enabled = true;
                        s.intent.wake = diagnostics::network_events::wake_generation();
                        s.policy.enabled = true;
                    }
                    c.accept(1, snapshot.clone(), false);
                    Acceptance::Recovery(c.snapshot().unwrap().0)
                } else {
                    Acceptance::Manual(ticket)
                };
                let paused = Arc::new(std::sync::Barrier::new(2));
                let release = Arc::new(std::sync::Barrier::new(2));
                let worker = c.clone();
                let p = paused.clone();
                let r = release.clone();
                let thread = std::thread::spawn(move || {
                    p.wait();
                    r.wait();
                    worker.accept_checked(2, Some(snapshot), proof)
                });
                paused.wait();
                if stop {
                    c.stop();
                } else {
                    c.profile_check(|| 2);
                }
                let expected = c.status().run_id;
                release.wait();
                assert!(!thread.join().unwrap());
                assert_eq!(c.status().run_id, expected);
            }
        }
    }
    #[test]
    fn started_completion_survives_disable_or_rejected_manual_request() {
        for disable in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("a.json");
            std::fs::write(&path, b"{}").unwrap();
            let mut coordinator = RecoveryCoordinator::default();
            coordinator.origin = Instant::now() - Duration::from_secs(3);
            let c = Arc::new(coordinator);
            {
                let mut s = c.state.lock().unwrap();
                s.intent.enabled = true;
                s.intent.wake = diagnostics::network_events::wake_generation();
                s.policy.enabled = true;
            }
            c.accept(1, fixture(path), false);
            {
                let mut s = c.state.lock().unwrap();
                s.policy.event(0, "a");
                s.policy.next(2000);
            }
            let token = c.snapshot().unwrap().0;
            assert_eq!(c.observe(token, Evidence::DeadEngine), Decision::Reconnect);
            c.mark_restarting(token);
            if disable {
                c.set_enabled(false);
            } else {
                drop(c.manual_request());
            }
            c.attempt_finished(token);
            {
                let mut s = c.state.lock().unwrap();
                s.intent.enabled = true;
                s.policy.enabled = true;
            }
            c.event(9);
            let now = c.now();
            assert_eq!(
                c.state.lock().unwrap().policy.next(now + 4999),
                Decision::Wait
            );
            assert_eq!(c.status().attempts, 1);
        }
    }
    #[tokio::test]
    async fn evidence_deadline_and_stop_cancel_pending_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, b"{}").unwrap();
        let c = Arc::new(RecoveryCoordinator::default());
        {
            let mut s = c.state.lock().unwrap();
            s.intent.enabled = true;
            s.intent.wake = diagnostics::network_events::wake_generation();
            s.policy.enabled = true;
        }
        c.accept(1, fixture(path), false);
        let token = c.snapshot().unwrap().0;
        let work = c.guarded(
            token,
            tokio::time::Instant::now() + Duration::from_millis(1),
            std::future::pending::<()>(),
        );
        let result = tokio::time::timeout(Duration::from_millis(100), work).await;
        assert!(
            matches!(result, Ok(None)),
            "deadline must cancel pending evidence"
        );
        let pending = c.clone();
        let work = tokio::spawn(async move {
            pending
                .guarded(
                    token,
                    tokio::time::Instant::now() + Duration::from_secs(10),
                    std::future::pending::<()>(),
                )
                .await
        });
        tokio::task::yield_now().await;
        c.stop();
        assert!(
            matches!(
                tokio::time::timeout(Duration::from_millis(150), work).await,
                Ok(Ok(None))
            ),
            "Stop must promptly cancel pending evidence"
        );
    }
    #[tokio::test]
    async fn two_delayed_active_failures_and_healthy_candidate_can_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, b"{}").unwrap();
        let mut c = RecoveryCoordinator::default();
        c.probe_budget = Duration::from_millis(250);
        {
            let mut s = c.state.lock().unwrap();
            s.intent.enabled = true;
            s.intent.wake = diagnostics::network_events::wake_generation();
            s.policy.enabled = true;
        }
        c.accept(1, fixture(path), false);
        let token = c.snapshot().unwrap().0;
        let mut policy = Policy::default();
        policy.enabled = true;
        policy.event(0, "a");
        policy.next(2000);
        for expected in [Decision::ProbeActive, Decision::ProbeCandidate] {
            let evidence = c
                .guarded_probe(token, async {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    Evidence::ActiveFailure
                })
                .await;
            assert_eq!(evidence, Some(Evidence::ActiveFailure));
            assert_eq!(policy.observe(2000, evidence.unwrap()), expected);
        }
        let candidate = c
            .guarded_probe(token, async { Evidence::CandidateHealthy })
            .await
            .unwrap();
        assert_eq!(policy.observe(2000, candidate), Decision::Reconnect);
    }
    #[tokio::test]
    async fn queued_stop_is_superseded_before_any_lifecycle_io() {
        let pm = Arc::new(ProcessManager::new());
        let permit = pm.acquire_clash_api().await;
        use std::future::Future;
        let mut stopping = Box::pin(pm.stop());
        std::future::poll_fn(|cx| {
            assert!(stopping.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        pm.begin_ready_profile_check();
        drop(permit);
        assert!(matches!(
            stopping.await,
            Err(crate::error::AppError::ProfileCheck(
                crate::config::preflight::ProfileCheckIssue::Cancelled
            ))
        ));
    }
    #[tokio::test]
    async fn selector_a_to_b_never_restores_a_after_engine_death() {
        let pm = Arc::new(ProcessManager::new());
        pm.install_test_child(EngineKind::Singbox).await;
        let before = pm.snapshot_status().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, br#"{"outbounds":[{"tag":"A"}]}"#).unwrap();
        {
            let mut s = pm.recovery.state.lock().unwrap();
            s.intent.enabled = true;
            s.intent.wake = diagnostics::network_events::wake_generation();
            s.policy.enabled = true;
        }
        pm.recovery.accept(pm.active_run_id(), fixture(path), false);
        let (token, snapshot) = pm.recovery.snapshot().unwrap();
        pm.recovery.target_changed(token.run);
        assert!(pm.recovery.snapshot().is_none());
        assert_eq!(pm.recovery.status().issue, Some("unsupported_probe"));
        assert_eq!(
            pm.snapshot_status().await.pid,
            before.pid,
            "selector boundary leaves live VPN intact"
        );
        assert!(pm
            .restart_recovery(None, token, snapshot.clone())
            .await
            .is_err());
        assert_eq!(pm.snapshot_status().await.pid, before.pid);
        pm.terminate_test_child().await;
        assert!(pm.restart_recovery(None, token, snapshot).await.is_err());
        assert!(pm.recovery.snapshot().is_none());
    }
    #[tokio::test]
    async fn cancelled_recovery_never_touches_live_child_or_config() {
        let pm = Arc::new(ProcessManager::new());
        pm.install_test_child(EngineKind::Singbox).await;
        let before = pm.snapshot_status().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, b"{}").unwrap();
        let snapshot = fixture(path.clone());
        std::fs::write(&path, b"edited").unwrap();
        let token = Token {
            epoch: 0,
            network: 0,
            run: pm.active_run_id(),
            wake: 0,
        };
        let result = pm.restart_recovery(None, token, snapshot).await;
        assert!(result.is_err());
        assert_eq!(pm.snapshot_status().await.pid, before.pid);
        assert_eq!(std::fs::read(path).unwrap(), b"edited");
        pm.terminate_test_child().await;
    }
}
