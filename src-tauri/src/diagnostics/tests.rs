use super::coordinator::ProbeCoordinator;
use super::types::*;
use std::sync::Arc;
use std::time::Duration;

fn identity() -> SessionIdentity {
    serde_json::from_value::<ConnectionHealth>(
        serde_json::from_str(include_str!(
            "../../../src/lib/fixtures/connection-health.json"
        ))
        .unwrap(),
    )
    .unwrap()
    .identity
}
#[test]
fn contract_uses_string_ids_and_roundtrips_shared_fixture() {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/lib/fixtures/connection-health.json"
    ))
    .unwrap();
    let health: ConnectionHealth = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        health.identity.run_id.as_deref(),
        Some("18446744073709551615")
    );
    assert_eq!(serde_json::to_value(health).unwrap(), value);
}
#[test]
fn identical_request_coalesces_and_old_lease_cannot_finish_new_request() {
    let coordinator = ProbeCoordinator::default();
    let first = coordinator.begin(identity(), HealthScope::ActiveSession);
    let duplicate = coordinator.begin(identity(), HealthScope::ActiveSession);
    assert_eq!(first.operation_id, duplicate.operation_id);
    assert!(duplicate.lease.is_none());
    let mut other = identity();
    other.profile_revision = "5".into();
    let second = coordinator.begin(other.clone(), HealthScope::ActiveSession);
    let stale = first.lease.unwrap();
    assert!(stale.is_cancelled());
    assert!(!coordinator.finish(
        &stale,
        HealthOutcome::Failed,
        Some(HealthIssue::Timeout),
        None
    ));
    assert_eq!(
        coordinator.snapshot().active_session.unwrap().identity,
        other
    );
    assert!(coordinator.finish(
        &second.lease.unwrap(),
        HealthOutcome::Healthy,
        None,
        Some(20)
    ));
    assert_eq!(
        coordinator.snapshot().active_session.unwrap().outcome,
        HealthOutcome::Healthy
    );
}
#[test]
fn stop_invalidates_all_results_and_cancel_is_owner_specific() {
    let coordinator = ProbeCoordinator::default();
    let first = coordinator.begin(identity(), HealthScope::SelectedProfile);
    assert!(!coordinator.cancel("unrelated"));
    coordinator.invalidate();
    assert!(first.lease.as_ref().unwrap().is_cancelled());
    assert!(!coordinator.finish(&first.lease.unwrap(), HealthOutcome::Healthy, None, Some(1)));
    assert_eq!(coordinator.snapshot(), HealthSnapshot::default());
}
#[tokio::test]
async fn cancellation_cleans_before_the_next_probe_can_run() {
    let coordinator = Arc::new(ProbeCoordinator::default());
    let first = coordinator.begin(identity(), HealthScope::SelectedProfile);
    let (started, has_started) = tokio::sync::oneshot::channel();
    let (cleaned, mut has_cleaned) = tokio::sync::oneshot::channel();
    let c = coordinator.clone();
    let task = tokio::spawn(async move {
        c.execute(
            first.lease.unwrap(),
            async {
                let _ = started.send(());
                std::future::pending().await
            },
            async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = cleaned.send(());
            },
        )
        .await;
    });
    has_started.await.unwrap();
    let mut other = identity();
    other.network_generation = "2".into();
    let second = coordinator.begin(other, HealthScope::SelectedProfile);
    coordinator
        .execute(
            second.lease.unwrap(),
            async {
                assert!(
                    has_cleaned.try_recv().is_ok(),
                    "new probe ran before old cleanup"
                );
                ProbeResult::healthy(10)
            },
            async {},
        )
        .await;
    task.await.unwrap();
    assert_eq!(
        coordinator.snapshot().selected_profile.unwrap().outcome,
        HealthOutcome::Healthy
    );
}
#[tokio::test]
async fn deadline_does_not_wait_forever_or_skip_cleanup() {
    let coordinator =
        ProbeCoordinator::with_limits(Duration::from_millis(20), Duration::from_millis(20));
    let start = coordinator.begin(identity(), HealthScope::SelectedProfile);
    let cleaned = std::sync::atomic::AtomicBool::new(false);
    coordinator
        .execute(start.lease.unwrap(), std::future::pending(), async {
            cleaned.store(true, std::sync::atomic::Ordering::SeqCst);
        })
        .await;
    assert!(cleaned.load(std::sync::atomic::Ordering::SeqCst));
    let health = coordinator.snapshot().selected_profile.unwrap();
    assert_eq!(health.outcome, HealthOutcome::Failed);
    assert_eq!(health.issue, Some(HealthIssue::Timeout));
}

#[test]
fn selected_probe_does_not_replace_active_health_and_snapshot_survives_resubscribe() {
    let c = ProbeCoordinator::default();
    let active = c.begin(identity(), HealthScope::ActiveSession);
    c.finish(
        &active.lease.unwrap(),
        HealthOutcome::Healthy,
        None,
        Some(12),
    );
    let accepted = c.snapshot().active_session.unwrap();
    let mut selected = identity();
    selected.run_id = None;
    selected.profile_revision = "candidate".into();
    let candidate = c.begin(selected, HealthScope::SelectedProfile);
    c.finish(
        &candidate.lease.unwrap(),
        HealthOutcome::Failed,
        Some(HealthIssue::RealityVerification),
        None,
    );
    let snapshot = c.snapshot();
    assert_eq!(snapshot.active_session, Some(accepted));
    assert_eq!(
        snapshot.selected_profile.unwrap().outcome,
        HealthOutcome::Failed
    );
}
#[tokio::test]
async fn failed_cleanup_blocks_later_work_instead_of_overlapping_children() {
    let c = ProbeCoordinator::with_limits(Duration::from_millis(100), Duration::from_millis(10));
    let first = c.begin(identity(), HealthScope::ActiveSession);
    c.execute(
        first.lease.unwrap(),
        async { ProbeResult::healthy(5) },
        std::future::pending(),
    )
    .await;
    assert_eq!(
        c.snapshot().active_session.unwrap().outcome,
        HealthOutcome::Unavailable
    );
    let next = c.begin(identity(), HealthScope::ActiveSession);
    c.execute(
        next.lease.unwrap(),
        async {
            panic!("cannot start another child after failed cleanup");
        },
        async {},
    )
    .await;
    assert_eq!(
        c.snapshot().active_session.unwrap().issue,
        Some(HealthIssue::EngineUnavailable)
    );
}
