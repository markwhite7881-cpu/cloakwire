use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileRef {
    Manual {
        id: String,
    },
    Subscription {
        subscription_id: String,
        link_key: String,
    },
    Ready {
        subscription_id: String,
        child_key: String,
    },
    Auto {
        snapshot_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionIdentity {
    pub profile_ref: ProfileRef,
    pub profile_revision: String,
    pub run_id: Option<String>,
    pub network_generation: String,
    pub effective_outbound_revision: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthScope {
    SelectedProfile,
    ActiveSession,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStage {
    Preparing,
    Connecting,
    Verifying,
    Complete,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthOutcome {
    Unknown,
    Checking,
    Healthy,
    Failed,
    Unavailable,
    Cancelled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthIssue {
    NetworkUnavailable,
    EndpointUnreachable,
    Timeout,
    RealityVerification,
    TlsVerification,
    Dns,
    Authentication,
    EngineUnavailable,
    UnsupportedProbe,
    ProbeTargetUnavailable,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionHealth {
    #[serde(flatten)]
    pub identity: SessionIdentity,
    pub operation_id: String,
    pub scope: HealthScope,
    pub stage: HealthStage,
    pub outcome: HealthOutcome,
    pub issue: Option<HealthIssue>,
    pub checked_at: Option<String>,
    pub latency_ms: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct HealthSnapshot {
    pub selected_profile: Option<ConnectionHealth>,
    pub active_session: Option<ConnectionHealth>,
}
impl HealthSnapshot {
    pub(crate) fn slot(&mut self, scope: HealthScope) -> &mut Option<ConnectionHealth> {
        match scope {
            HealthScope::SelectedProfile => &mut self.selected_profile,
            HealthScope::ActiveSession => &mut self.active_session,
        }
    }
}
pub struct ProbeResult {
    pub outcome: HealthOutcome,
    pub issue: Option<HealthIssue>,
    pub latency_ms: Option<u64>,
}
impl ProbeResult {
    pub fn healthy(latency_ms: u64) -> Self {
        Self {
            outcome: HealthOutcome::Healthy,
            issue: None,
            latency_ms: Some(latency_ms),
        }
    }
    pub fn failed(issue: HealthIssue) -> Self {
        Self {
            outcome: HealthOutcome::Failed,
            issue: Some(issue),
            latency_ms: None,
        }
    }
    pub fn unavailable(issue: HealthIssue) -> Self {
        Self {
            outcome: HealthOutcome::Unavailable,
            issue: Some(issue),
            latency_ms: None,
        }
    }
}
