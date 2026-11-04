use super::selected::*;
use super::{
    probe_config::prepare_singbox_probe,
    sources,
    types::{HealthIssue, ProfileRef},
};
use crate::{
    config::GeneratorSettings,
    parser::{parse_link, Outbound},
    subscriptions::{
        model::ChildProfileRecord, EngineKind, HwidStore, SubscriptionHttpClient, SubscriptionKind,
        SubscriptionRecord, SubscriptionService, SubscriptionStore,
    },
};
use serde_json::{json, Value};

fn link(name: &str) -> Outbound {
    parse_link(&format!(
        "vless://11111111-1111-4111-8111-111111111111@192.0.2.1:443?security=none#{name}"
    ))
    .unwrap()
}

fn catalog(dir: &std::path::Path, config: Value) -> SubscriptionService {
    let template: SubscriptionRecord = serde_json::from_value(json!({
        "id":"links","name":"Fixture","url":"https://example.test","kind":"link_list",
        "interval_minutes":60
    }))
    .unwrap();
    let mut links = template.clone();
    links.link_outbounds.push(link("stored"));
    let mut ready = template;
    ready.id = "ready".into();
    ready.kind = SubscriptionKind::SingboxBundle;
    ready.children.push(ChildProfileRecord {
        key: "child".into(),
        name: "Ready".into(),
        engine: EngineKind::Singbox,
        config,
        digest: String::new(),
    });
    ready.children.push(ChildProfileRecord {
        key: "xray".into(),
        name: "Xray".into(),
        engine: EngineKind::Xray,
        config: json!({"outbounds":[{"protocol":"vless","tag":"proxy"}]}),
        digest: String::new(),
    });
    let store = SubscriptionStore::for_test(dir.join("subscriptions.json"));
    store.replace_all(&[links, ready]).unwrap();
    SubscriptionService::new(
        store,
        HwidStore::new(dir.join("hwid")),
        SubscriptionHttpClient::new().unwrap(),
        "test".into(),
    )
}

#[tokio::test]
async fn selected_profiles_use_native_sources_and_compare_exact_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let config = json!({"outbounds":[
        {"type":"selector","tag":"entry","outbounds":["ignored","picked"],"default":"picked"},
        {"type":"vless","tag":"ignored"},{"type":"trojan","tag":"picked"}],
        "route":{"final":"entry"}});
    let service = catalog(dir.path(), config.clone());
    let manual = link("manual");
    let manual_ref = ProfileRef::Manual {
        id: "local-1".into(),
    };
    let stored_ref = ProfileRef::Subscription {
        subscription_id: "links".into(),
        link_key: "index-0".into(),
    };
    let ready_ref = ProfileRef::Ready {
        subscription_id: "ready".into(),
        child_key: "child".into(),
    };
    let settings = GeneratorSettings {
        remote_dns: Some("1.1.1.1".into()),
        ..GeneratorSettings::default()
    };
    let manual_revision = sources::revision(&manual);
    let cases = [
        (&manual_ref, manual_revision.clone(), "manual"),
        (&stored_ref, sources::revision(&link("stored")), "stored"),
        (
            &ready_ref,
            sources::ready_revision(EngineKind::Singbox, &config),
            "picked",
        ),
    ];
    for (reference, revision, expected) in cases {
        let (value, tag) =
            resolve_profile(&service, reference, &revision, Some(&manual), &settings)
                .await
                .unwrap();
        assert_eq!(tag, expected);
        assert_eq!(
            prepare_singbox_probe(&value, &tag, "test-physical", 16400, "secret").unwrap()["route"]
                ["final"],
            expected
        );
        let issue = resolve_profile(&service, reference, "wrong", Some(&manual), &settings)
            .await
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(issue).unwrap(),
            "profile_source_changed"
        );
    }
    let issue = resolve_profile(
        &service,
        &stored_ref,
        &manual_revision,
        Some(&manual),
        &settings,
    )
    .await
    .unwrap_err();
    assert_eq!(
        serde_json::to_value(issue).unwrap(),
        "profile_source_changed"
    );
    let xray = ProfileRef::Ready {
        subscription_id: "ready".into(),
        child_key: "xray".into(),
    };
    let expected = sources::ready_revision(
        EngineKind::Xray,
        &json!({"outbounds":[{"protocol":"vless","tag":"proxy"}]}),
    );
    let error = resolve_profile(&service, &xray, &expected, Some(&manual), &settings)
        .await
        .unwrap_err();
    assert_eq!(serde_json::to_value(error).unwrap(), "unsupported_probe");
}

#[test]
fn ready_profiles_resolve_the_implicit_first_outbound_and_fail_closed_on_dynamic_paths() {
    let original =
        json!({"outbounds":[{"type":"trojan","tag":"first"},{"type":"vless","tag":"second"}]});
    assert_eq!(ready_target(&original).unwrap(), "first");
    for source in [
        json!({"outbounds":[{"type":"direct","tag":"direct"},{"type":"vless","tag":"one"}]}),
        json!({"outbounds":[{"type":"urltest","tag":"auto","outbounds":["one"]},{"type":"vless","tag":"one"}]}),
        json!({"outbounds":[{"type":"selector","tag":"s","outbounds":["s"]}]}),
        json!({"outbounds":[{"type":"selector","tag":"s","outbounds":["one"],"default":"other"},{"type":"vless","tag":"one"}]}),
        json!({"outbounds":[{"type":"selector","tag":"s","outbounds":["one"]},{"type":"vless","tag":"one"}],"experimental":{"cache_file":{"enabled":true}}}),
        json!({"outbounds":[{"type":"trojan","tag":"first"}],"route":{"final":"missing"}}),
    ] {
        assert_eq!(ready_target(&source), Err(HealthIssue::UnsupportedProbe));
    }
}

#[tokio::test]
#[ignore = "bundled cores, local VLESS server and loopback HTTP target only"]
async fn resolved_link_checks_through_the_private_core_without_stopping_the_server() {
    use super::{
        coordinator::ProbeCoordinator,
        desktop::{DesktopProbe, DesktopProbeRequest},
        desktop_native_tests::{binary, endpoint, server},
        desktop_tests::identity,
        network::PhysicalNetwork,
        targets::TargetSet,
        types::{HealthOutcome, HealthScope},
    };
    let dir = tempfile::tempdir().unwrap();
    let private = tempfile::tempdir().unwrap();
    let (mut upstream, port, user) = server(dir.path()).await;
    let (url, _, target) = endpoint(false).await;
    let service = catalog(dir.path(), json!({}));
    let source = parse_link(&format!(
        "vless://{user}@127.0.0.1:{port}?security=none#manual"
    ))
    .unwrap();
    let mut id = identity();
    id.profile_revision = sources::revision(&source);
    let settings = GeneratorSettings {
        local_dns: Some("127.0.0.1".into()),
        remote_dns: Some("127.0.0.1".into()),
        ..GeneratorSettings::default()
    };
    let (config, tag) = resolve_profile(
        &service,
        &id.profile_ref,
        &id.profile_revision,
        Some(&source),
        &settings,
    )
    .await
    .unwrap();
    let interface = if cfg!(windows) {
        "Loopback Pseudo-Interface 1"
    } else {
        "lo0"
    };
    let request = DesktopProbeRequest::fixture(
        EngineKind::Singbox,
        binary(EngineKind::Singbox),
        private.path().to_owned(),
        config,
        tag,
        PhysicalNetwork::fixture(interface),
        TargetSet::fixture(&url, &url),
    );
    let coordinator = ProbeCoordinator::default();
    let lease = coordinator
        .begin(id, HealthScope::SelectedProfile)
        .lease
        .unwrap();
    DesktopProbe::execute(&coordinator, lease, request).await;
    let health = coordinator.snapshot().selected_profile.unwrap();
    assert_eq!(health.outcome, HealthOutcome::Healthy, "{:?}", health.issue);
    assert!(upstream.is_alive().unwrap());
    assert!(upstream.stop(std::time::Duration::from_secs(2)).await);
    target.abort();
    assert_eq!(std::fs::read_dir(private.path()).unwrap().count(), 0);
}
