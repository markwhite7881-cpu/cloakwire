use super::{
    coordinator::ProbeCoordinator, desktop::*, network::PhysicalNetwork, targets::TargetSet,
    types::*,
};
use crate::subscriptions::model::EngineKind;
use serde_json::json;
use std::path::PathBuf;

pub(super) fn identity() -> SessionIdentity {
    SessionIdentity {
        profile_ref: ProfileRef::Manual {
            id: "fixture".into(),
        },
        profile_revision: "1".into(),
        run_id: None,
        network_generation: "1".into(),
        effective_outbound_revision: None,
    }
}
fn request(parent: &std::path::Path, config: serde_json::Value) -> DesktopProbeRequest {
    DesktopProbeRequest::fixture(
        EngineKind::Singbox,
        PathBuf::from("missing-cloakwire-core-fixture"),
        parent.to_owned(),
        config,
        "selected".into(),
        PhysicalNetwork::fixture("loopback"),
        TargetSet::default(),
    )
}
#[tokio::test]
async fn unsupported_target_never_creates_a_child_or_changes_source() {
    let parent = tempfile::tempdir().unwrap();
    let source = json!({"outbounds":[{"type":"direct","tag":"selected"}]});
    let original = source.clone();
    let coordinator = ProbeCoordinator::default();
    let lease = coordinator
        .begin(identity(), HealthScope::SelectedProfile)
        .lease
        .unwrap();
    DesktopProbe::execute(&coordinator, lease, request(parent.path(), source.clone())).await;
    let state = coordinator.snapshot().selected_profile.unwrap();
    assert_eq!(state.outcome, HealthOutcome::Unavailable);
    assert_eq!(state.issue, Some(HealthIssue::UnsupportedProbe));
    assert_eq!(source, original);
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
    assert!(coordinator.snapshot().active_session.is_none());
}
#[tokio::test]
async fn failed_preflight_spawn_removes_private_config() {
    let parent = tempfile::tempdir().unwrap();
    let config = json!({"outbounds":[{"type":"vless","tag":"selected","server":"127.0.0.1","server_port":1234,"uuid":uuid::Uuid::new_v4().to_string()}]});
    let coordinator = ProbeCoordinator::default();
    let lease = coordinator
        .begin(identity(), HealthScope::SelectedProfile)
        .lease
        .unwrap();
    DesktopProbe::execute(&coordinator, lease, request(parent.path(), config)).await;
    assert_eq!(
        coordinator.snapshot().selected_profile.unwrap().issue,
        Some(HealthIssue::EngineUnavailable)
    );
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn unrelated_unauthenticated_proxy_is_not_accepted() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (status, expected) in [
        ("200 Connection established", false),
        ("407 Proxy Authentication Required", true),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let n = stream.read(&mut buffer).await.unwrap();
            let text = String::from_utf8_lossy(&buffer[..n]);
            assert!(text.starts_with("CONNECT "));
            assert!(!text.to_lowercase().contains("proxy-authorization"));
            stream
                .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
                .await
                .unwrap();
        });
        assert_eq!(requires_proxy_auth(port).await, expected);
        task.await.unwrap();
    }
}

#[tokio::test]
async fn isolated_adapter_rejects_active_session_and_running_identity_leases() {
    for (scope, run) in [
        (HealthScope::ActiveSession, None),
        (HealthScope::ActiveSession, Some("live")),
        (HealthScope::SelectedProfile, Some("live")),
    ] {
        let parent = tempfile::tempdir().unwrap();
        let coordinator = ProbeCoordinator::default();
        let mut id = identity();
        id.run_id = run.map(str::to_owned);
        let lease = coordinator.begin(id, scope).lease.unwrap();
        DesktopProbe::execute(&coordinator, lease, request(parent.path(), json!({}))).await;
        let state = match scope {
            HealthScope::SelectedProfile => coordinator.snapshot().selected_profile,
            HealthScope::ActiveSession => coordinator.snapshot().active_session,
        }
        .unwrap();
        assert_eq!(state.outcome, HealthOutcome::Cancelled);
        assert!(state.latency_ms.is_none());
        assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
    }
}

#[test]
fn production_xray_requires_positive_interface_binding_proof() {
    assert_eq!(
        ensure_isolation_available(EngineKind::Xray),
        Err(HealthIssue::UnsupportedProbe)
    );
    assert!(ensure_isolation_available(EngineKind::Singbox).is_ok());
}
