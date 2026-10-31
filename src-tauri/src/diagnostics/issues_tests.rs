use super::{issues::*, types::HealthIssue};
#[test]
fn known_runtime_evidence_returns_only_safe_categories() {
    for (raw, expected) in [
        (
            "outbound/vless[node]: reality verification failed",
            HealthIssue::RealityVerification,
        ),
        (
            "tls: failed to verify certificate: x509: certificate signed by unknown authority",
            HealthIssue::TlsVerification,
        ),
        (
            "dns: lookup example.invalid: no such host",
            HealthIssue::Dns,
        ),
        ("proxy authentication required", HealthIssue::Authentication),
        (
            "dial tcp: connect: connection refused",
            HealthIssue::EndpointUnreachable,
        ),
    ] {
        assert_eq!(
            classify_runtime_issue(&format!("{raw} secret-uuid private-subscription-url")),
            Some(expected)
        );
    }
    assert_eq!(
        classify_runtime_issue("unknown secret-uuid private-subscription-url"),
        None
    );
    assert_eq!(
        classify_runtime_issue("a single destination i/o timeout"),
        None,
        "destination timeout is not a global VPN failure"
    );
}
#[test]
fn reality_failure_never_claims_a_wrong_uuid_and_reports_no_raw_text() {
    let issue = RuntimeIssue::notice("17", HealthIssue::RealityVerification);
    let encoded = serde_json::to_string(&issue).unwrap();
    assert!(encoded.contains("reality_verification"));
    assert!(!encoded.contains("uuid"));
    assert_eq!(issue.severity, IssueSeverity::Notice);
}

#[test]
fn old_notice_is_not_promoted_to_a_new_disconnect_cause() {
    let mut old = super::issues::RuntimeIssue::notice("3", HealthIssue::RealityVerification);
    old.observed_at = (chrono::Utc::now() - chrono::Duration::seconds(61)).to_rfc3339();
    let ended = super::issues::disconnect_issue("3", Some(old));
    assert_eq!(ended.code, HealthIssue::EngineUnavailable);
    assert_eq!(ended.severity, super::issues::IssueSeverity::Connection);
}
