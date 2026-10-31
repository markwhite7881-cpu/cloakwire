//! Opt-in real-core loopback tests. No VPN, proxy setting, route or firewall writes.
use super::{
    coordinator::ProbeCoordinator,
    desktop::{DesktopProbe, DesktopProbeRequest},
    desktop_tests::identity,
    network::PhysicalNetwork,
    owned_core::OwnedCore,
    targets::TargetSet,
    types::*,
};
use crate::subscriptions::model::EngineKind;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

pub(super) fn binary(engine: EngineKind) -> PathBuf {
    let name = if engine == EngineKind::Singbox {
        "sing-box"
    } else {
        "xray"
    };
    #[cfg(windows)]
    let suffix = "x86_64-pc-windows-msvc.exe";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let suffix = "aarch64-apple-darwin";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let suffix = "x86_64-apple-darwin";
    #[cfg(not(any(windows, target_os = "macos")))]
    let suffix = "x86_64-unknown-linux-gnu";
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{suffix}"));
    assert!(path.is_file(), "bundled fixture core is required");
    path
}
fn network() -> PhysicalNetwork {
    #[cfg(windows)]
    let name = "Loopback Pseudo-Interface 1";
    #[cfg(not(windows))]
    let name = "lo0";
    PhysicalNetwork::fixture(name)
}
pub(super) fn candidate(engine: EngineKind, port: u16, user: &str) -> Value {
    match engine {
        EngineKind::Singbox => {
            json!({"outbounds":[{"type":"vless","tag":"selected","server":"127.0.0.1","server_port":port,"uuid":user}]})
        }
        EngineKind::Xray => {
            json!({"outbounds":[{"protocol":"vless","tag":"selected","settings":{"vnext":[{"address":"127.0.0.1","port":port,"users":[{"id":user,"encryption":"none"}]}]}}]})
        }
    }
}
pub(super) async fn server(parent: &std::path::Path) -> (OwnedCore, u16, String) {
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let id = uuid::Uuid::new_v4().to_string();
    let config = json!({"log":{"loglevel":"none"},"inbounds":[{"listen":"127.0.0.1","port":port,"protocol":"vless","settings":{"clients":[{"id":id}],"decryption":"none"}}],"outbounds":[{"protocol":"freedom"}]});
    let mut core = OwnedCore::create(parent, &config).unwrap();
    let mut command = tokio::process::Command::new(binary(EngineKind::Xray));
    command.args(["run", "-config"]).arg(core.config_path());
    drop(socket);
    core.spawn(command).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                break;
            }
            assert!(core.is_alive().unwrap());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    (core, port, id)
}
pub(super) async fn endpoint(
    stall: bool,
) -> (
    String,
    Arc<tokio::sync::Notify>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hit = Arc::new(tokio::sync::Notify::new());
    let note = hit.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0; 4096];
            let _ = stream.read(&mut buffer).await;
            note.notify_one();
            if stall {
                std::future::pending::<()>().await;
            }
            let _ = stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .await;
        }
    });
    (format!("http://127.0.0.1:{port}/fixture"), hit, task)
}
fn request(
    parent: &std::path::Path,
    engine: EngineKind,
    config: Value,
    url: &str,
) -> DesktopProbeRequest {
    DesktopProbeRequest::fixture(
        engine,
        binary(engine),
        parent.to_owned(),
        config,
        "selected".into(),
        network(),
        TargetSet::fixture(url, url),
    )
    .allow_loopback_wiring_only()
}
#[tokio::test]
#[ignore = "requires bundled cores; loopback only, no OS networking changes"]
async fn real_cores_check_selected_credentials_and_cleanup_without_stopping_other_core() {
    let parent = tempfile::tempdir().unwrap();
    let probes = tempfile::tempdir().unwrap();
    let (mut server, port, user) = server(parent.path()).await;
    let (url, _, target) = endpoint(false).await;
    for engine in [EngineKind::Singbox, EngineKind::Xray] {
        for valid in [true, false] {
            let coordinator = ProbeCoordinator::default();
            let config = candidate(
                engine,
                port,
                if valid {
                    &user
                } else {
                    "00000000-0000-4000-8000-000000000001"
                },
            );
            let original = config.clone();
            let lease = coordinator
                .begin(identity(), HealthScope::SelectedProfile)
                .lease
                .unwrap();
            DesktopProbe::execute(
                &coordinator,
                lease,
                request(probes.path(), engine, config.clone(), &url),
            )
            .await;
            let state = coordinator.snapshot().selected_profile.unwrap();
            assert_eq!(
                state.outcome == HealthOutcome::Healthy,
                valid,
                "engine {engine:?}, outcome {:?}, issue {:?}",
                state.outcome,
                state.issue
            );
            assert!(coordinator.snapshot().active_session.is_none());
            assert_eq!(config, original);
            assert!(server.is_alive().unwrap());
            assert_eq!(std::fs::read_dir(probes.path()).unwrap().count(), 0);
        }
    }
    target.abort();
    assert!(server.stop(Duration::from_secs(2)).await);
}
#[tokio::test]
#[ignore = "requires bundled cores; loopback only, no OS networking changes"]
async fn real_core_cancel_and_deadline_remove_child_and_temporary_credentials() {
    let parent = tempfile::tempdir().unwrap();
    let probes = tempfile::tempdir().unwrap();
    let (mut server, port, user) = server(parent.path()).await;
    for engine in [EngineKind::Singbox, EngineKind::Xray] {
        for cancel in [true, false] {
            let (url, hit, target) = endpoint(true).await;
            let coordinator = Arc::new(ProbeCoordinator::with_limits(
                Duration::from_secs(3),
                Duration::from_secs(2),
            ));
            let begin = coordinator.begin(identity(), HealthScope::SelectedProfile);
            let operation = begin.operation_id;
            let lease = begin.lease.unwrap();
            let req = request(probes.path(), engine, candidate(engine, port, &user), &url);
            let runner = coordinator.clone();
            let task = tokio::spawn(async move {
                DesktopProbe::execute(&runner, lease, req).await;
            });
            let reached = tokio::time::timeout(Duration::from_secs(2), hit.notified())
                .await
                .is_ok();
            if cancel || !reached {
                coordinator.cancel(&operation);
            }
            task.await.unwrap();
            target.abort();
            assert!(reached, "fixture must have reached target through core");
            let state = coordinator.snapshot().selected_profile.unwrap();
            assert_eq!(
                state.outcome,
                if cancel {
                    HealthOutcome::Cancelled
                } else {
                    HealthOutcome::Failed
                }
            );
            if !cancel {
                assert_eq!(state.issue, Some(HealthIssue::Timeout));
            }
            assert_eq!(std::fs::read_dir(probes.path()).unwrap().count(), 0);
            assert!(server.is_alive().unwrap());
        }
    }
    assert!(server.stop(Duration::from_secs(2)).await);
}
#[tokio::test]
#[ignore = "read-only discovery on a machine with one usable physical default route"]
async fn physical_discovery_is_read_only_and_repeatable() {
    let a = super::network::discover()
        .await
        .expect("unique physical network");
    let b = super::network::discover()
        .await
        .expect("same physical network");
    assert_eq!(a, b);
    assert!(!a.interface().is_empty());
    assert_eq!(a.fingerprint().len(), 64);
}

#[tokio::test]
#[ignore = "requires bundled cores; deliberate owned loopback port collisions only"]
async fn real_core_port_collision_retry_is_bounded_and_cleans_every_attempt() {
    let parent = tempfile::tempdir().unwrap();
    let probes = tempfile::tempdir().unwrap();
    let (mut server, port, user) = server(parent.path()).await;
    let (url, _, target) = endpoint(false).await;
    for engine in [EngineKind::Singbox, EngineKind::Xray] {
        for collisions in [1, 3] {
            let coordinator = ProbeCoordinator::default();
            let lease = coordinator
                .begin(identity(), HealthScope::SelectedProfile)
                .lease
                .unwrap();
            let (req, attempts) =
                request(probes.path(), engine, candidate(engine, port, &user), &url)
                    .fixture_collisions(collisions);
            DesktopProbe::execute(&coordinator, lease, req).await;
            let state = coordinator.snapshot().selected_profile.unwrap();
            assert_eq!(
                state.outcome == HealthOutcome::Healthy,
                collisions == 1,
                "{engine:?}: {:?} {:?}",
                state.outcome,
                state.issue
            );
            assert_eq!(
                attempts.load(std::sync::atomic::Ordering::SeqCst),
                if collisions == 1 { 2 } else { 3 }
            );
            assert_eq!(std::fs::read_dir(probes.path()).unwrap().count(), 0);
            assert!(server.is_alive().unwrap());
        }
    }
    target.abort();
    assert!(server.stop(Duration::from_secs(2)).await);
}

#[tokio::test]
#[ignore = "demonstrates why current Xray binding cannot qualify a production probe"]
async fn xray_unproven_binding_cannot_report_healthy() {
    let parent = tempfile::tempdir().unwrap();
    let probes = tempfile::tempdir().unwrap();
    let (mut server, port, user) = server(parent.path()).await;
    let (url, _, target) = endpoint(false).await;
    let coordinator = ProbeCoordinator::default();
    let lease = coordinator
        .begin(identity(), HealthScope::SelectedProfile)
        .lease
        .unwrap();
    let request = DesktopProbeRequest::fixture(
        EngineKind::Xray,
        binary(EngineKind::Xray),
        probes.path().to_owned(),
        candidate(EngineKind::Xray, port, &user),
        "selected".into(),
        PhysicalNetwork::fixture("cloakwire-nonexistent-interface"),
        TargetSet::fixture(&url, &url),
    );
    DesktopProbe::execute(&coordinator, lease, request).await;
    let state = coordinator.snapshot().selected_profile.unwrap();
    target.abort();
    assert!(server.stop(Duration::from_secs(2)).await);
    assert_eq!(std::fs::read_dir(probes.path()).unwrap().count(), 0);
    assert_eq!(state.outcome, HealthOutcome::Unavailable);
    assert_eq!(state.issue, Some(HealthIssue::UnsupportedProbe));
}

#[tokio::test]
#[ignore = "real core preflight only; env config directory must not be merged"]
async fn xray_external_config_environment_cannot_modify_the_private_candidate() {
    let parent = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    std::fs::write(
        external.path().join("external.json"),
        b"invalid external config sentinel",
    )
    .unwrap();
    for name in ["XRAY_LOCATION_CONFDIR", "xray.location.confdir"] {
        let mut owner = OwnedCore::create(
            parent.path(),
            &json!({"inbounds":[],"outbounds":[{"protocol":"freedom"}]}),
        )
        .unwrap();
        let mut command = tokio::process::Command::new(binary(EngineKind::Xray));
        command
            .args(["run", "-test", "-config"])
            .arg(owner.config_path())
            .env(name, external.path());
        owner.spawn(command).unwrap();
        let passed = owner.wait_exit().await.unwrap();
        assert!(owner.stop(Duration::from_secs(2)).await);
        assert!(
            passed,
            "external environment must not inject another configuration"
        );
    }
}
