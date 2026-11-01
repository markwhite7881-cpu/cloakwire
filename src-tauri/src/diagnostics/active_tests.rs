use super::{
    active::*,
    active_config::{ActiveLaunch, SessionSource},
    issues::IssueSeverity,
    types::*,
};
use crate::engine::EngineKind;
use serde_json::json;
use std::sync::Arc;
fn draft(name: &str) -> ActiveLaunch {
    ActiveLaunch::unavailable(SessionSource::new(
        ProfileRef::Manual { id: name.into() },
        Some(name.into()),
        &json!({"fixture":name}),
    ))
}
#[test]
fn accepted_snapshot_does_not_follow_selected_or_removed_source() {
    let state = SessionDiagnostics::default();
    state.accept(1, EngineKind::Singbox, Some(draft("A")));
    let accepted = state.snapshot().session.unwrap();
    assert_eq!(accepted.display_name.as_deref(), Some("A"));
    assert_eq!(accepted.identity.run_id.as_deref(), Some("1"));
    state.observe_line(0, "reality verification failed secret");
    assert!(state.snapshot().issue.is_none());
    state.observe_line(1, "reality verification failed secret");
    state.observe_line(1, "reality verification failed secret");
    assert_eq!(state.snapshot().issue.unwrap().count, 2);
    state.accept(2, EngineKind::Xray, Some(draft("B")));
    assert!(state.snapshot().issue.is_none());
    state.retire(1, false);
    assert_eq!(
        state.snapshot().session.unwrap().display_name.as_deref(),
        Some("B")
    );
}
#[tokio::test]
async fn old_probe_cannot_relabel_a_new_run_or_survive_stop() {
    let state = Arc::new(SessionDiagnostics::default());
    state.accept(1, EngineKind::Singbox, Some(draft("A")));
    let id = state.snapshot().session.unwrap().identity;
    let lease = state.begin(&id).unwrap().lease.unwrap();
    state.accept(2, EngineKind::Singbox, Some(draft("B")));
    state
        .coordinator
        .execute(lease, async { ProbeResult::healthy(5) }, async {})
        .await;
    assert!(state.snapshot().health.is_none());
    assert_eq!(
        state.snapshot().session.unwrap().identity.run_id.as_deref(),
        Some("2")
    );
    assert!(state.begin(&id).is_err());
    state.retire(2, true);
    assert!(state.snapshot().session.is_none());
    assert!(state.snapshot().issue.is_none());
}
#[test]
fn network_or_member_change_clears_health_and_old_owner_actions() {
    let state = SessionDiagnostics::default();
    state.accept(4, EngineKind::Singbox, Some(draft("A")));
    let before = state.snapshot().session.unwrap().identity;
    assert!(state.observe_network(4, Some("physical-a".into())));
    let network = state.snapshot().session.unwrap().identity;
    assert_ne!(network.network_generation, before.network_generation);
    assert!(!state.observe_network(4, Some("physical-a".into())));
    assert!(state.begin(&before).is_err());
    state.target_changed(4);
    let changed = state.snapshot().session.unwrap();
    assert_ne!(
        changed.identity.effective_outbound_revision,
        network.effective_outbound_revision
    );
    assert!(matches!(
        changed.identity.profile_ref,
        ProfileRef::Auto { .. }
    ));
    assert!(changed.display_name.is_none());
    assert!(state.snapshot().health.is_none());
}
#[test]
fn unexpected_exit_is_typed_but_user_stop_is_not_an_error() {
    let state = SessionDiagnostics::default();
    state.accept(7, EngineKind::Singbox, Some(draft("A")));
    state.observe_line(7, "reality verification failed private-secret");
    state.retire(7, false);
    let snapshot = state.snapshot();
    assert!(snapshot.ended_unexpectedly);
    let issue = snapshot.issue.unwrap();
    assert_eq!(issue.code, HealthIssue::RealityVerification);
    assert_eq!(issue.severity, IssueSeverity::Connection);
    assert!(!serde_json::to_string(&state.snapshot())
        .unwrap()
        .contains("private-secret"));
    state.accept(8, EngineKind::Singbox, Some(draft("B")));
    state.retire(8, true);
    assert!(state.snapshot().session.is_none());
}

#[test]
fn os_epoch_change_invalidates_even_when_addresses_are_unchanged() {
    let state = SessionDiagnostics::default();
    state.accept(9, EngineKind::Singbox, Some(draft("A")));
    assert!(state.observe_epoch(9, Some(1)));
    state.observe_network(9, Some("same-address".into()));
    let before = state.session_for_run(9).unwrap().identity;
    assert!(!state.observe_epoch(9, Some(1)));
    assert!(state.observe_epoch(9, Some(2)));
    assert!(state.begin(&before).is_err());
    state.observe_network(9, Some("same-address".into()));
    assert_ne!(
        before.network_generation,
        state
            .session_for_run(9)
            .unwrap()
            .identity
            .network_generation
    );
    state.accept(10, EngineKind::Singbox, Some(draft("B")));
    assert!(
        state.session_for_run(9).is_none(),
        "an old monitor may never request a new run's probe"
    );
    assert!(!state.observe_epoch(9, Some(3)));
}

#[tokio::test]
async fn explicit_retry_can_refresh_failed_discovery_under_the_same_epoch() {
    let state = SessionDiagnostics::default();
    state.accept(12, EngineKind::Singbox, Some(draft("A")));
    state.observe_epoch(12, Some(7));
    state.observe_network(12, None);
    let identity = state.session_for_run(12).unwrap().identity;
    assert!(
        !state
            .refresh_failed_network(12, &identity, || async { None }, || Some(7))
            .await
    );
    assert!(
        state
            .refresh_failed_network(
                12,
                &identity,
                || async { Some("recovered".into()) },
                || Some(7)
            )
            .await
    );
    assert_eq!(state.session_for_run(12).unwrap().identity, identity);
    assert!(state.begin(&identity).is_ok());
    state.observe_epoch(12, Some(8));
    assert!(
        !state
            .refresh_failed_network(12, &identity, || async { Some("stale".into()) }, || Some(8))
            .await
    );
}

// Tauri synchronous commands run outside an entered Tokio runtime.
// Async-only tests used to hide the panic behind the Retry button.
fn retry_from_sync_command(engine: EngineKind) {
    assert!(tokio::runtime::Handle::try_current().is_err());
    let manager = Arc::new(crate::process::ProcessManager::new());
    manager
        .diagnostics
        .accept(1, engine, Some(draft("sync-retry")));
    let identity = manager.diagnostics.snapshot().session.unwrap().identity;
    let operation = manager
        .diagnostics
        .request(manager.clone(), identity.clone())
        .unwrap();
    assert!(!operation.is_empty());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if let Some(health) = manager.diagnostics.snapshot().health {
            if health.outcome != HealthOutcome::Checking {
                assert_eq!(health.identity, identity);
                assert_eq!(health.issue, Some(HealthIssue::EngineUnavailable));
                break;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "retry must finish on the application runtime"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn singbox_retry_from_sync_command_does_not_panic() {
    retry_from_sync_command(EngineKind::Singbox);
}

#[test]
fn xray_retry_from_sync_command_does_not_panic() {
    retry_from_sync_command(EngineKind::Xray);
}
