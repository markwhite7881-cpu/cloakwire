use super::{active_config::*, probe_config::PROBE_INBOUND_TAG, types::*};
use crate::engine::EngineKind;
use serde_json::json;

#[test]
fn active_copy_checks_the_concrete_running_target_and_preserves_ordinary_rules() {
    let original = json!({"inbounds":[{"type":"mixed","tag":"ordinary","listen":"127.0.0.1","listen_port":2080}],
        "outbounds":[{"type":"selector","tag":"proxy","outbounds":["one","two"],"default":"one"},
        {"type":"vless","tag":"one","server":"192.0.2.1"},{"type":"vless","tag":"two","server":"192.0.2.2"}],
        "route":{"final":"proxy","rules":[{"domain_suffix":["example.test"],"outbound":"two"}]},
        "dns":{"servers":[{"type":"local","tag":"local"}]},
        "experimental":{"clash_api":{"external_controller":"127.0.0.1:9090","secret":"private-controller"}}});
    let before = original.clone();
    let prepared =
        prepare_active_copy(&original, EngineKind::Singbox, 1234, "private-auth").unwrap();
    assert_eq!(prepared.wiring.target(), "one");
    assert_eq!(
        prepared.value["route"]["rules"][0]["inbound"],
        json!([PROBE_INBOUND_TAG])
    );
    assert_eq!(prepared.value["route"]["rules"][0]["outbound"], "one");
    assert_eq!(
        prepared.value["route"]["rules"][1],
        original["route"]["rules"][0]
    );
    assert_eq!(prepared.value["dns"], original["dns"]);
    assert_eq!(original, before);
    assert_eq!(
        prepared.wiring.expected_members(),
        vec![("proxy".into(), "one".into())]
    );
}
#[test]
fn ambiguous_auto_direct_cache_and_untrusted_controller_are_unavailable() {
    let base = json!({"outbounds":[{"type":"selector","tag":"proxy","default":"one","outbounds":["one"]},{"type":"vless","tag":"one","server":"192.0.2.1"}],"route":{"final":"proxy"}});
    for change in ["auto", "direct", "cache", "remote", "cycle"] {
        let mut config = base.clone();
        match change {
            "auto" => config["outbounds"][1]["type"] = json!("urltest"),
            "direct" => config["outbounds"][1]["type"] = json!("direct"),
            "cache" => config["experimental"] = json!({"cache_file":{"enabled":true}}),
            "remote" => {
                config["experimental"] =
                    json!({"clash_api":{"external_controller":"192.0.2.1:9090"}})
            }
            _ => config["outbounds"][0]["default"] = json!("proxy"),
        };
        assert!(matches!(
            prepare_active_copy(&config, EngineKind::Singbox, 1234, "private"),
            Err(HealthIssue::UnsupportedProbe)
        ));
    }
}
#[test]
fn xray_active_check_does_not_use_the_isolated_binding_gate() {
    let config = json!({"inbounds":[],"outbounds":[{"protocol":"vless","tag":"selected","settings":{"vnext":[{"address":"192.0.2.1"}]}}],"routing":{"rules":[{"domain":["geosite:private"],"outboundTag":"selected"}]}});
    let prepared = prepare_active_copy(&config, EngineKind::Xray, 1234, "private").unwrap();
    assert_eq!(prepared.wiring.target(), "selected");
    assert_eq!(
        prepared.value["routing"]["rules"][1],
        config["routing"]["rules"][0]
    );
    assert!(prepared.value["outbounds"][0]["streamSettings"]["sockopt"]["interface"].is_null());
    let mut ambiguous = config;
    ambiguous["outbounds"]
        .as_array_mut()
        .unwrap()
        .push(json!({"protocol":"vless","tag":"other"}));
    assert!(matches!(
        prepare_active_copy(&ambiguous, EngineKind::Xray, 1234, "private"),
        Err(HealthIssue::UnsupportedProbe)
    ));
}
#[test]
fn accepted_source_revision_is_native_and_dto_omits_runtime_secrets() {
    let source = SessionSource::new(
        ProfileRef::Manual {
            id: "stable-id".into(),
        },
        Some("Server A".into()),
        &json!({"password":"secret-sentinel"}),
    );
    let snapshot = source.accepted("9007199254740993", EngineKind::Singbox);
    let output = serde_json::to_string(&snapshot).unwrap();
    assert!(!output.contains("secret-sentinel"));
    assert!(output.contains("9007199254740993"));
    assert_eq!(
        snapshot.identity.profile_ref,
        ProfileRef::Manual {
            id: "stable-id".into()
        }
    );
    let changed = SessionSource::new(
        ProfileRef::Manual {
            id: "stable-id".into(),
        },
        Some("Server A".into()),
        &json!({"password":"changed"}),
    );
    assert_ne!(source.revision(), changed.revision());
}

#[tokio::test]
async fn diagnostic_preflight_failure_restores_the_exact_original_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("candidate.json");
    let bytes=b"{ \"outbounds\": [{\"type\":\"vless\",\"tag\":\"one\",\"server\":\"192.0.2.1\"}], \"route\":{\"final\":\"one\"} }";
    std::fs::write(&path, bytes).unwrap();
    let config: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    let source = SessionSource::new(
        ProfileRef::Manual {
            id: "stable".into(),
        },
        Some("A".into()),
        &config,
    );
    let launch = attach_checked_copy(&path, EngineKind::Singbox, source.clone(), || async {
        Err(crate::config::preflight::ProfileCheckIssue::Unsupported.into())
    })
    .await
    .unwrap();
    assert!(launch.wiring.is_none());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let launch = attach_checked_copy(&path, EngineKind::Singbox, source, || async { Ok(()) })
        .await
        .unwrap();
    assert!(launch.wiring.is_some());
    assert_ne!(std::fs::read(&path).unwrap(), bytes);
    let port = launch.wiring.as_ref().unwrap().port;
    assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_err());
    launch.release_port();
    assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
}

#[tokio::test]
async fn controller_unavailability_is_not_a_confirmed_member_change() {
    use super::active_config::TargetWitness;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = json!({"outbounds":[{"type":"selector","tag":"proxy","default":"one","outbounds":["one","two"]},{"type":"vless","tag":"one"},{"type":"vless","tag":"two"}],"route":{"final":"proxy"},"experimental":{"clash_api":{"external_controller":address.to_string()}}});
    let wiring = prepare_active_copy(&config, EngineKind::Singbox, 1234, "private")
        .unwrap()
        .wiring;
    let task = tokio::spawn(async move {
        for body in [r#"{"now":"one"}"#, "not-json", r#"{"now":"two"}"#] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut input = [0; 2048];
            let _ = socket.read(&mut input).await;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    assert_eq!(wiring.target_witness().await, TargetWitness::Matches);
    assert_eq!(wiring.target_witness().await, TargetWitness::Unavailable);
    assert_eq!(wiring.target_witness().await, TargetWitness::Changed);
    task.await.unwrap();
}

#[tokio::test]
async fn optional_copy_write_failure_falls_back_only_after_successful_restoration() {
    for restore_ok in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original.json");
        let original=b"{ \"outbounds\": [{\"type\":\"vless\",\"tag\":\"one\"}], \"route\":{\"final\":\"one\"} }";
        std::fs::write(&path, original).unwrap();
        let value: serde_json::Value = serde_json::from_slice(original).unwrap();
        let source = SessionSource::new(ProfileRef::Manual { id: "a".into() }, None, &value);
        let mut writes = 0;
        let result = attach_checked_copy_with_writer(
            &path,
            EngineKind::Singbox,
            source,
            || async { panic!("failed write must not preflight") },
            |path, bytes| {
                writes += 1;
                if writes == 1 {
                    std::fs::write(path, b"{partial")?;
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "synthetic disk full",
                    ));
                }
                if !restore_ok {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "restore denied",
                    ));
                }
                std::fs::write(path, bytes)
            },
        )
        .await;
        assert_eq!(writes, 2);
        if restore_ok {
            assert!(result.unwrap().wiring.is_none());
            assert_eq!(std::fs::read(&path).unwrap(), original);
        } else {
            assert!(
                matches!(result,Err(crate::error::AppError::Io(ref error)) if error.kind()==std::io::ErrorKind::PermissionDenied)
            );
        }
    }
}
