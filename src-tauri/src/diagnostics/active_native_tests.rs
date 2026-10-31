//! Opt-in loopback session tests. No TUN/proxy/firewall changes.
use super::{
    active::perform_check,
    active_config::prepare_active_copy,
    desktop_native_tests::{binary, candidate, endpoint, server},
    owned_core::OwnedCore,
    targets::TargetSet,
};
use crate::engine::EngineKind;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires bundled cores; checks the already-running core, no system networking"]
async fn active_checks_use_the_existing_core_and_never_stop_it() {
    let server_dir = tempfile::tempdir().unwrap();
    let main_dir = tempfile::tempdir().unwrap();
    let (mut upstream, server_port, user) = server(server_dir.path()).await;
    let (url, _, target) = endpoint(false).await;
    for engine in [EngineKind::Singbox, EngineKind::Xray] {
        for valid in [true, false] {
            let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = reservation.local_addr().unwrap().port();
            let mut config = candidate(
                engine,
                server_port,
                if valid {
                    &user
                } else {
                    "00000000-0000-4000-8000-000000000001"
                },
            );
            if engine == EngineKind::Singbox {
                config["route"] = serde_json::json!({"final":"selected"});
            }
            let prepared =
                prepare_active_copy(&config, engine, port, "private-active-fixture").unwrap();
            let mut main = OwnedCore::create(main_dir.path(), &prepared.value).unwrap();
            let mut command = tokio::process::Command::new(binary(engine));
            command.args(["run", "-c"]).arg(main.config_path());
            drop(reservation);
            main.spawn(command).unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(11),
                perform_check(&prepared.wiring, &TargetSet::fixture(&url, &url)),
            )
            .await
            .unwrap();
            assert_eq!(result.is_ok(), valid, "active {engine:?} result {result:?}");
            assert!(
                main.is_alive().unwrap(),
                "a failed check must not stop the actual session"
            );
            assert!(upstream.is_alive().unwrap());
            assert!(main.stop(Duration::from_secs(2)).await);
        }
    }
    target.abort();
    assert!(upstream.stop(Duration::from_secs(2)).await);
    assert_eq!(std::fs::read_dir(main_dir.path()).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires bundled cores; starts only loopback fixtures without app or OS cleanup"]
async fn accepted_process_publishes_health_and_cancellation_keeps_main_core_alive() {
    use super::{
        active_config::{ActiveLaunch, SessionSource},
        types::{HealthOutcome, ProfileRef},
    };
    use crate::{engine::LaunchSpec, process::ProcessManager};
    use std::sync::Arc;
    let server_dir = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (mut upstream, server_port, user) = server(server_dir.path()).await;
    let (url, _, target) = endpoint(false).await;
    for engine in [EngineKind::Singbox, EngineKind::Xray] {
        let mut config = candidate(engine, server_port, &user);
        if engine == EngineKind::Singbox {
            config["route"] = serde_json::json!({"final":"selected"});
        }
        let source = SessionSource::new(
            ProfileRef::Manual {
                id: "fixture-owner".into(),
            },
            Some("Accepted A".into()),
            &config,
        );
        let (copy, launch) = ActiveLaunch::prepare(&config, engine, source);
        assert!(launch.wiring.is_some());
        let path = dir.path().join(format!("{engine:?}.json"));
        std::fs::write(&path, serde_json::to_vec(&copy).unwrap()).unwrap();
        let manager = Arc::new(ProcessManager::new());
        let status = manager
            .start_spec(LaunchSpec {
                engine,
                binary: binary(engine),
                args: vec!["run".into(), "-c".into(), path.as_os_str().into()],
                env: vec![],
                config_path: path,
                controller_url: None,
                profile_key: None,
                profile_name: None,
                diagnostics: Some(launch),
                xray_stats: None,
            })
            .await
            .unwrap();
        let run = manager.active_run_id();
        assert_eq!(status.run_id, Some(run.to_string()));
        manager
            .diagnostics
            .observe_network(run, Some("loopback-fixture".into()));
        let session = manager.diagnostics.session_for_run(run).unwrap();
        let operation = manager
            .diagnostics
            .request_fixture(
                manager.clone(),
                session.identity.clone(),
                TargetSet::fixture(&url, &url),
            )
            .unwrap();
        let repeated = manager
            .diagnostics
            .request_fixture(
                manager.clone(),
                session.identity.clone(),
                TargetSet::fixture(&url, &url),
            )
            .unwrap();
        assert_eq!(operation, repeated);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = manager.diagnostics.snapshot();
                if snapshot
                    .health
                    .as_ref()
                    .is_some_and(|h| h.outcome != HealthOutcome::Checking)
                {
                    let health = snapshot.health.unwrap();
                    assert_eq!(
                        health.outcome,
                        HealthOutcome::Healthy,
                        "{engine:?}: {health:?}"
                    );
                    assert_eq!(health.identity, session.identity);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        assert!(manager.probe_run_alive(run).await);
        let pending = manager
            .diagnostics
            .request_fixture(
                manager.clone(),
                session.identity.clone(),
                TargetSet::fixture(&url, &url),
            )
            .unwrap();
        assert!(manager.diagnostics.cancel(&pending));
        assert!(manager.probe_run_alive(run).await);
        manager.diagnostics.retire(run, true);
        assert!(manager
            .diagnostics
            .request_fixture(
                manager.clone(),
                session.identity,
                TargetSet::fixture(&url, &url)
            )
            .is_err());
        manager.terminate_test_child().await;
        assert!(!manager.probe_run_alive(run).await);
    }
    target.abort();
    assert!(upstream.stop(Duration::from_secs(2)).await);
}

#[tokio::test]
#[ignore = "real cores, deterministic loopback collision; no OS networking writes"]
async fn diagnostic_collision_falls_back_to_original_and_preserves_foreign_listener() {
    use super::{
        active_config::{ActiveLaunch, SessionSource},
        probe_config::PROBE_USER,
        targets::ProbeClient,
        types::ProfileRef,
    };
    use crate::{engine::LaunchSpec, process::ProcessManager};
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let (mut upstream, server_port, user) = server(dir.path()).await;
    let (url, _, target) = endpoint(false).await;
    for engine in [EngineKind::Singbox, EngineKind::Xray] {
        let regular = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let regular_port = regular.local_addr().unwrap().port();
        let mut original = candidate(engine, server_port, &user);
        if engine == EngineKind::Singbox {
            original["route"] = serde_json::json!({"final":"selected"});
            original["inbounds"] = serde_json::json!([{"type":"mixed","tag":"regular","listen":"127.0.0.1","listen_port":regular_port,"users":[{"username":PROBE_USER,"password":"regular-password"}]}]);
        } else {
            original["inbounds"] = serde_json::json!([{"protocol":"http","tag":"regular","listen":"127.0.0.1","port":regular_port,"settings":{"accounts":[{"user":PROBE_USER,"pass":"regular-password"}]}}]);
        }
        let source = SessionSource::new(
            ProfileRef::Manual {
                id: "collision-fixture".into(),
            },
            Some("A".into()),
            &original,
        );
        let (copy, launch) = ActiveLaunch::prepare(&original, engine, source);
        let port = launch.wiring.as_ref().unwrap().port;
        launch.release_port();
        let foreign = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        let path = dir.path().join(format!("collision-{engine:?}.json"));
        std::fs::write(&path, serde_json::to_vec(&copy).unwrap()).unwrap();
        drop(regular);
        let manager = Arc::new(ProcessManager::new());
        let result = manager
            .start_spec(LaunchSpec {
                engine,
                binary: binary(engine),
                args: vec!["run".into(), "-c".into(), path.as_os_str().into()],
                env: vec![],
                config_path: path.clone(),
                controller_url: None,
                profile_key: None,
                profile_name: None,
                diagnostics: Some(launch),
                xray_stats: None,
            })
            .await;
        assert!(result.is_ok());
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            manager.probe_run_alive(manager.active_run_id()).await,
            "optional diagnostic listener killed {engine:?}"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            serde_json::to_vec(&original).unwrap()
        );
        assert!(
            ProbeClient::new(regular_port, "regular-password")
                .unwrap()
                .check(&TargetSet::fixture(&url, &url))
                .await
                .is_ok(),
            "ordinary inbound must remain usable"
        );
        manager.terminate_test_child().await;
        assert_eq!(foreign.local_addr().unwrap().port(), port);
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_err());
    }
    target.abort();
    assert!(upstream.stop(Duration::from_secs(2)).await);
}
