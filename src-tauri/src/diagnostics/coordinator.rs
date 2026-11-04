use super::types::*;
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::{
    sync::{watch, Semaphore},
    time::{timeout, timeout_at, Instant},
};

struct Active {
    id: String,
    identity: SessionIdentity,
    scope: HealthScope,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
struct State {
    closed: bool,
    active: Option<Active>,
    snapshot: HealthSnapshot,
}
pub struct ProbeLease {
    id: String,
    identity: SessionIdentity,
    scope: HealthScope,
    cancel: watch::Receiver<bool>,
    deadline: Instant,
}
impl ProbeLease {
    pub fn is_cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
    pub fn operation_id(&self) -> &str {
        &self.id
    }
    pub(crate) fn scope(&self) -> HealthScope {
        self.scope
    }
    pub fn identity(&self) -> &SessionIdentity {
        &self.identity
    }
}
pub struct BeginProbe {
    pub operation_id: String,
    pub lease: Option<ProbeLease>,
}

/// Separate from ProcessManager's transition semaphore. No state lock spans
/// network I/O; a cancelled owner's cleanup finishes before another probe runs.
pub struct ProbeCoordinator {
    state: Mutex<State>,
    probe_slot: Semaphore,
    #[cfg(not(target_os = "android"))]
    pub(super) private_core: tokio::sync::Mutex<Option<super::owned_core::OwnedCore>>,
    budget: Duration,
    cleanup_budget: Duration,
    cleanup_failed: AtomicBool,
}
impl Default for ProbeCoordinator {
    fn default() -> Self {
        Self::with_limits(Duration::from_secs(12), Duration::from_secs(2))
    }
}
impl ProbeCoordinator {
    pub(crate) fn with_limits(budget: Duration, cleanup_budget: Duration) -> Self {
        Self {
            state: Mutex::new(State::default()),
            probe_slot: Semaphore::new(1),
            #[cfg(not(target_os = "android"))]
            private_core: Default::default(),
            budget,
            cleanup_budget,
            cleanup_failed: AtomicBool::new(false),
        }
    }
    pub fn begin(&self, identity: SessionIdentity, scope: HealthScope) -> BeginProbe {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed {
            return BeginProbe {
                operation_id: String::new(),
                lease: None,
            };
        }
        if let Some(active) = &state.active {
            if active.identity == identity && active.scope == scope {
                return BeginProbe {
                    operation_id: active.id.clone(),
                    lease: None,
                };
            }
        }
        Self::cancel_active(&mut state);
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = watch::channel(false);
        *state.snapshot.slot(scope) = Some(ConnectionHealth {
            identity: identity.clone(),
            operation_id: id.clone(),
            scope,
            stage: HealthStage::Preparing,
            outcome: HealthOutcome::Checking,
            issue: None,
            checked_at: None,
            latency_ms: None,
        });
        state.active = Some(Active {
            id: id.clone(),
            identity: identity.clone(),
            scope,
            cancel: tx,
        });
        BeginProbe {
            operation_id: id.clone(),
            lease: Some(ProbeLease {
                id,
                identity,
                scope,
                cancel: rx,
                deadline: Instant::now() + self.budget,
            }),
        }
    }
    fn cancel_active(state: &mut State) {
        if let Some(active) = state.active.take() {
            let _ = active.cancel.send(true);
            if let Some(health) = state.snapshot.slot(active.scope) {
                if health.operation_id == active.id {
                    health.outcome = HealthOutcome::Cancelled;
                    health.stage = HealthStage::Complete;
                    health.issue = None;
                    health.checked_at = None;
                    health.latency_ms = None;
                }
            }
        }
    }
    pub fn cancel(&self, id: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.active.as_ref().is_some_and(|active| active.id == id) {
            Self::cancel_active(&mut state);
            true
        } else {
            false
        }
    }
    /// Stop/new accepted session/network-generation change invokes this before I/O.
    pub fn invalidate(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Self::cancel_active(&mut state);
        state.snapshot = HealthSnapshot::default();
    }
    #[cfg(not(target_os = "android"))]
    pub(super) fn is_closed(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).closed
    }

    /// Seal admission before signalling cancellation. An in-flight preparation
    /// cannot acquire a fresh lease after the exit barrier has drained.
    #[cfg(not(target_os = "android"))]
    pub(crate) async fn shutdown(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closed = true;
            Self::cancel_active(&mut state);
        }
        let _permit = self
            .probe_slot
            .acquire()
            .await
            .expect("probe slot is never closed");
        // A cancelled command or an expired cleanup budget can leave an owner
        // here. Retry using its exact child handle and private paths.
        let mut slot = self.private_core.lock().await;
        if let Some(core) = slot.as_mut() {
            if core.stop(Duration::from_secs(5)).await {
                slot.take();
            } else {
                log::error!(
                    "failed to reap owned diagnostic core or remove its private files on exit"
                );
            }
        }
    }
    pub fn snapshot(&self) -> HealthSnapshot {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .snapshot
            .clone()
    }
    pub fn stage(&self, lease: &ProbeLease, stage: HealthStage) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !state
            .active
            .as_ref()
            .is_some_and(|a| a.id == lease.id && a.identity == lease.identity)
        {
            return false;
        }
        if let Some(health) = state.snapshot.slot(lease.scope) {
            health.stage = stage;
        }
        true
    }
    pub(crate) fn finish(
        &self,
        lease: &ProbeLease,
        outcome: HealthOutcome,
        issue: Option<HealthIssue>,
        latency_ms: Option<u64>,
    ) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if lease.is_cancelled()
            || !state
                .active
                .as_ref()
                .is_some_and(|a| a.id == lease.id && a.identity == lease.identity)
        {
            return false;
        }
        if let Some(health) = state.snapshot.slot(lease.scope) {
            health.stage = HealthStage::Complete;
            health.outcome = outcome;
            health.issue = issue;
            health.latency_ms = latency_ms;
            health.checked_at = Some(chrono::Utc::now().to_rfc3339());
        }
        state.active = None;
        true
    }
    pub async fn execute<F, C>(&self, mut lease: ProbeLease, work: F, cleanup: C)
    where
        F: Future<Output = ProbeResult>,
        C: Future<Output = ()>,
    {
        // Waiting for a previous owner also counts against the total deadline.
        let permit = tokio::select! {
            biased;
            _ = lease.cancel.changed() => return,
            permit = timeout_at(lease.deadline, self.probe_slot.acquire()) => permit,
        };
        let Ok(Ok(_permit)) = permit else {
            self.finish(
                &lease,
                HealthOutcome::Failed,
                Some(HealthIssue::Timeout),
                None,
            );
            return;
        };
        if lease.is_cancelled() {
            return;
        }
        if self.cleanup_failed.load(Ordering::Acquire) {
            self.finish(
                &lease,
                HealthOutcome::Unavailable,
                Some(HealthIssue::EngineUnavailable),
                None,
            );
            return;
        }
        let result = tokio::select! {
            biased;
            _ = lease.cancel.changed() => None,
            result = timeout_at(lease.deadline, work) => Some(result.unwrap_or_else(|_| ProbeResult::failed(HealthIssue::Timeout))),
        };
        // Never allow a second child to start if the former owner cannot prove
        // cleanup within its budget. Adapters must additionally own kill-on-drop.
        if timeout(self.cleanup_budget, cleanup).await.is_err() {
            self.cleanup_failed.store(true, Ordering::Release);
            self.finish(
                &lease,
                HealthOutcome::Unavailable,
                Some(HealthIssue::EngineUnavailable),
                None,
            );
            return;
        }
        if let Some(result) = result {
            self.finish(&lease, result.outcome, result.issue, result.latency_ms);
        }
    }
}
