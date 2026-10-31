//! Allowlisted runtime evidence. It is a notice until the owning process dies;
//! one destination failure never changes lifecycle state or triggers reconnect.
use super::types::HealthIssue;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssueSeverity {
    Notice,
    Connection,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeIssue {
    pub run_id: String,
    pub code: HealthIssue,
    pub severity: IssueSeverity,
    pub count: u32,
    pub observed_at: String,
}
impl RuntimeIssue {
    pub fn notice(run_id: &str, code: HealthIssue) -> Self {
        Self {
            run_id: run_id.into(),
            code,
            severity: IssueSeverity::Notice,
            count: 1,
            observed_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
pub fn classify_runtime_issue(line: &str) -> Option<HealthIssue> {
    if line.len() > 4096 {
        return None;
    }
    let text = line.to_ascii_lowercase();
    if text.contains("reality verification failed") {
        Some(HealthIssue::RealityVerification)
    } else if text.contains("x509:")
        || text.contains("failed to verify certificate")
        || text.contains("certificate verify failed")
    {
        Some(HealthIssue::TlsVerification)
    } else if text.contains("lookup ")
        && (text.contains("no such host") || text.contains("server misbehaving"))
    {
        Some(HealthIssue::Dns)
    } else if text.contains("proxy authentication required")
        || text.contains("authentication failed")
        || text.contains("invalid user")
    {
        Some(HealthIssue::Authentication)
    } else if text.contains("connect: connection refused") || text.contains("actively refused") {
        Some(HealthIssue::EndpointUnreachable)
    } else {
        None
    }
}

pub(crate) fn disconnect_issue(run: &str, previous: Option<RuntimeIssue>) -> RuntimeIssue {
    let now = chrono::Utc::now();
    let mut issue = previous
        .filter(|i| {
            i.run_id == run
                && chrono::DateTime::parse_from_rfc3339(&i.observed_at).is_ok_and(|time| {
                    let age = now.signed_duration_since(time);
                    age >= chrono::Duration::zero() && age < chrono::Duration::seconds(60)
                })
        })
        .unwrap_or_else(|| RuntimeIssue::notice(run, HealthIssue::EngineUnavailable));
    issue.severity = IssueSeverity::Connection;
    issue.observed_at = now.to_rfc3339();
    issue
}
