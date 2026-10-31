use crate::{engine::EngineKind, process::ProcessManager};
#[tokio::test]
async fn probe_requires_the_actual_owned_child_not_only_cached_running_status() {
    let manager = ProcessManager::new();
    manager.install_test_child(EngineKind::Singbox).await;
    let run = manager.active_run_id();
    assert!(manager.probe_run_alive(run).await);
    assert!(!manager.probe_run_alive(run + 1).await);
    manager.terminate_test_child().await;
    assert!(
        !manager.probe_run_alive(run).await,
        "cached status must not prove a dead child is alive"
    );
}

#[tokio::test]
async fn pending_optional_listener_releases_stop_gate_and_cancellation_never_falls_back() {
    use super::{
        active_config::{ActiveLaunch, SessionSource},
        types::ProfileRef,
    };
    use crate::{engine::LaunchSpec, process::Status};
    use std::sync::Arc;
    for abort in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.json");
        let config =
            serde_json::json!({"outbounds":[{"type":"vless","tag":"one"}],"route":{"final":"one"}});
        let source = SessionSource::new(
            ProfileRef::Manual {
                id: "fixture".into(),
            },
            None,
            &config,
        );
        let (copy, launch) = ActiveLaunch::prepare(&config, EngineKind::Singbox, source);
        std::fs::write(&path, serde_json::to_vec(&copy).unwrap()).unwrap();
        #[cfg(windows)]
        let (binary, args) = (
            std::path::PathBuf::from("powershell.exe"),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 60".into(),
            ],
        );
        #[cfg(not(windows))]
        let (binary, args) = (
            std::path::PathBuf::from("/bin/sh"),
            vec!["-c".into(), "exec sleep 60".into()],
        );
        let manager = Arc::new(ProcessManager::new());
        let owner = manager.clone();
        let start = tokio::spawn(async move {
            owner
                .start_spec(LaunchSpec {
                    engine: EngineKind::Singbox,
                    binary,
                    args,
                    env: vec![],
                    config_path: path,
                    controller_url: None,
                    profile_key: None,
                    profile_name: None,
                    diagnostics: Some(launch),
                    xray_stats: None,
                })
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while manager.snapshot_status().await.pid.is_none() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(manager.snapshot_status().await.status, Status::Starting);
        let gate = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            manager.acquire_clash_api(),
        )
        .await
        .expect("probe must not hold Stop's gate");
        drop(gate);
        if abort {
            start.abort();
            let _ = start.await;
        } else {
            manager.begin_ready_profile_check();
            assert!(start.await.unwrap().is_err());
        }
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while manager.is_running().await || manager.active_run_id() != 0 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(manager.active_run_id(), 0);
        assert_eq!(manager.snapshot_status().await.status, Status::Stopped);
    }
}

#[tokio::test]
#[ignore = "read-only OS socket ownership inspection"]
async fn readiness_cannot_be_proven_by_another_process_listener() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(super::network_events::owns_listener(std::process::id(), port).await);
    assert!(!super::network_events::owns_listener(0, port).await);
}
