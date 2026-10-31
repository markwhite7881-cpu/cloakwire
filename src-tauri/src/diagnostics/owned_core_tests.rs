use super::owned_core::*;
use std::{path::Path, time::Duration};

fn sleeper() -> tokio::process::Command {
    #[cfg(windows)]
    let mut cmd = tokio::process::Command::new("powershell.exe");
    #[cfg(windows)]
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Sleep -Seconds 60",
    ]);
    #[cfg(not(windows))]
    let mut cmd = tokio::process::Command::new("/bin/sh");
    #[cfg(not(windows))]
    cmd.args(["-c", "exec sleep 60"]);
    cmd
}

#[tokio::test]
async fn cleanup_owns_its_process_and_private_config_only() {
    let directory = tempfile::tempdir().unwrap();
    let mut first =
        OwnedCore::create(directory.path(), &serde_json::json!({"secret":"one"})).unwrap();
    let mut second =
        OwnedCore::create(directory.path(), &serde_json::json!({"secret":"two"})).unwrap();
    assert_ne!(first.config_path(), second.config_path());
    first.spawn(sleeper()).unwrap();
    second.spawn(sleeper()).unwrap();
    let a = first.config_path().to_path_buf();
    let b = second.config_path().to_path_buf();
    assert!(first.stop(Duration::from_secs(2)).await);
    assert!(!a.exists());
    assert!(b.exists());
    assert!(second.is_alive().unwrap());
    assert!(second.stop(Duration::from_secs(2)).await);
    assert!(!b.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn cancelled_owner_is_still_available_to_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let owner = std::sync::Arc::new(tokio::sync::Mutex::new(
        OwnedCore::create(directory.path(), &serde_json::json!({})).unwrap(),
    ));
    let work = owner.clone();
    let task = tokio::spawn(async move {
        work.lock().await.spawn(sleeper()).unwrap();
        std::future::pending::<()>().await;
    });
    while !owner.lock().await.has_process() {
        tokio::task::yield_now().await;
    }
    task.abort();
    let _ = task.await;
    assert!(owner.lock().await.stop(Duration::from_secs(2)).await);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
#[test]
fn failed_spawn_and_unused_config_remove_only_their_temporary_directory() {
    let directory = tempfile::tempdir().unwrap();
    let unrelated = directory.path().join("keep");
    std::fs::write(&unrelated, b"keep").unwrap();
    let mut owner = OwnedCore::create(directory.path(), &serde_json::json!({})).unwrap();
    let owned = owner.config_path().to_path_buf();
    assert!(owner
        .spawn(tokio::process::Command::new(Path::new(
            "missing-cloakwire-core-fixture"
        )))
        .is_err());
    drop(owner);
    assert!(!owned.exists());
    assert!(unrelated.exists());
}

#[tokio::test]
async fn preflight_reaps_child_but_retains_config_for_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let mut owner = OwnedCore::create(directory.path(), &serde_json::json!({})).unwrap();
    #[cfg(windows)]
    let mut command = tokio::process::Command::new("powershell.exe");
    #[cfg(windows)]
    command.args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
    #[cfg(not(windows))]
    let mut command = tokio::process::Command::new("/bin/sh");
    #[cfg(not(windows))]
    command.args(["-c", "exit 0"]);
    owner.spawn(command).unwrap();
    assert!(owner.wait_exit().await.unwrap());
    assert!(!owner.has_process());
    assert!(owner.config_path().exists());
    owner.spawn(sleeper()).unwrap();
    assert!(owner.is_alive().unwrap());
    assert!(owner.stop(Duration::from_secs(2)).await);
}
