use super::probe_config::*;
use super::types::HealthIssue;
use serde_json::json;

#[test]
fn isolated_copy_preserves_dns_detours_and_original_while_removing_system_listeners() {
    let original = json!({
        "log":{"output":"active.log"},
        "dns":{"servers":[{"tag":"provider","type":"udp","server":"192.0.2.53","detour":"relay"}]},
        "inbounds":[{"type":"tun","tag":"tun-in","auto_route":true}],
        "outbounds":[
            {"type":"vless","tag":"selected","server":"fixture.invalid","server_port":443,"uuid":"synthetic","detour":"relay"},
            {"type":"socks","tag":"relay","server":"192.0.2.1","server_port":1080},
            {"type":"direct","tag":"direct"}],
        "route":{"final":"selected","rules":[{"domain_suffix":["example.test"],"outbound":"direct"}],"default_domain_resolver":"provider"},
        "experimental":{"clash_api":{"external_controller":"127.0.0.1:9090"}}
    });
    let prepared = prepare_singbox_probe(
        &original,
        "selected",
        "physical-fixture",
        12345,
        "fixture-password",
    )
    .unwrap();
    assert_eq!(original["inbounds"][0]["type"], "tun");
    assert_eq!(original["log"]["output"], "active.log");
    assert_eq!(prepared["dns"]["servers"][0]["detour"], "relay");
    assert_eq!(prepared["outbounds"][0]["detour"], "relay");
    assert_eq!(
        prepared["outbounds"][1]["bind_interface"],
        "physical-fixture"
    );
    assert_eq!(prepared["dns"]["servers"][0]["server"], "192.0.2.53");
    assert_eq!(prepared["inbounds"].as_array().unwrap().len(), 1);
    assert_eq!(prepared["inbounds"][0]["listen"], "127.0.0.1");
    assert!(prepared.get("experimental").is_none());
    assert!(prepared["log"].get("output").is_none());
    assert_eq!(
        prepared["route"]["rules"][0]["inbound"],
        json!([PROBE_INBOUND_TAG])
    );
    assert_eq!(prepared["route"]["rules"][0]["outbound"], "selected");
}
#[test]
fn selector_is_pinned_only_in_probe_and_missing_or_direct_targets_are_unavailable() {
    let original = json!({"outbounds":[
        {"type":"selector","tag":"proxy","outbounds":["one","two"],"default":"two"},
        {"type":"vless","tag":"one","server":"192.0.2.1","server_port":443},
        {"type":"vless","tag":"two","server":"192.0.2.2","server_port":443},
        {"type":"direct","tag":"direct"}
    ]});
    let result = prepare_singbox_probe(&original, "one", "fixture-if", 1234, "secret").unwrap();
    assert_eq!(result["route"]["rules"][0]["outbound"], "one");
    assert_eq!(original["outbounds"][0]["default"], "two");
    for tag in ["missing", "direct", "proxy"] {
        assert_eq!(
            prepare_singbox_probe(&original, tag, "fixture-if", 1234, "secret"),
            Err(HealthIssue::UnsupportedProbe)
        );
    }
    assert_eq!(
        prepare_singbox_probe(&original, "one", "", 1234, "secret"),
        Err(HealthIssue::NetworkUnavailable)
    );
}
#[test]
fn active_probe_rule_cannot_match_ordinary_inbounds_and_does_not_rewrite_provider_dns() {
    let original = json!({"inbounds":[{"type":"tun","tag":"tun-in"}],"dns":{"servers":[{"tag":"own","type":"local"}]},"route":{"rules":[{"domain":["example.test"],"outbound":"direct"}],"final":"proxy"},"outbounds":[{"type":"selector","tag":"proxy","outbounds":["one"]},{"type":"vless","tag":"one","server":"192.0.2.1","server_port":443}]});
    let copy = inject_active_singbox_probe(&original, "proxy", 4321, "secret").unwrap();
    assert_eq!(copy["inbounds"][0], original["inbounds"][0]);
    assert_eq!(copy["dns"], original["dns"]);
    assert_eq!(copy["route"]["rules"][1], original["route"]["rules"][0]);
    assert_eq!(copy["route"]["final"], "proxy");
    assert_eq!(
        copy["route"]["rules"][0]["inbound"],
        json!([PROBE_INBOUND_TAG])
    );
    assert_eq!(copy["inbounds"][1]["users"][0]["password"], "secret");
}
#[test]
fn unsupported_provider_services_and_conflicting_interface_do_not_run_as_success() {
    let original = json!({"outbounds":[{"type":"vless","tag":"one","server":"192.0.2.1","server_port":443,"bind_interface":"other-uplink"}]});
    assert_eq!(
        prepare_singbox_probe(&original, "one", "fixture-if", 1234, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
    let mut original = original;
    original["outbounds"][0]
        .as_object_mut()
        .unwrap()
        .remove("bind_interface");
    original["services"] = json!([{"type":"resolved"}]);
    assert_eq!(
        prepare_singbox_probe(&original, "one", "fixture-if", 1234, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
}
#[test]
fn xray_preserves_provider_chain_and_private_route_before_ordinary_rules() {
    let original = json!({"dns":{"servers":["192.0.2.53"]},"inbounds":[{"protocol":"socks","listen":"127.0.0.1","port":1080}],"outbounds":[
        {"tag":"selected","protocol":"vless","settings":{"vnext":[{"address":"192.0.2.1","port":443,"users":[{"id":"synthetic"}]}]},"streamSettings":{"sockopt":{"dialerProxy":"relay"}}},
        {"tag":"relay","protocol":"socks","settings":{"servers":[{"address":"192.0.2.2","port":1080}]}}
    ],"routing":{"rules":[{"domain":["example.test"],"outboundTag":"relay"}]}});
    let active = inject_active_xray_probe(&original, "selected", 4321, "secret").unwrap();
    assert_eq!(active["dns"], original["dns"]);
    assert_eq!(
        active["routing"]["rules"][1],
        original["routing"]["rules"][0]
    );
    assert_eq!(
        active["routing"]["rules"][0]["inboundTag"],
        json!([PROBE_INBOUND_TAG])
    );
    assert_eq!(
        prepare_xray_probe(&original, "selected", "fixture-if", 4321, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
    let mut original = original;
    original["dns"] = json!({"hosts":{"fixture.invalid":"192.0.2.53"}});
    let probe = prepare_xray_probe(&original, "selected", "fixture-if", 4321, "secret").unwrap();
    assert_eq!(
        probe["outbounds"][0]["streamSettings"]["sockopt"]["dialerProxy"],
        "relay"
    );
    assert_eq!(
        probe["outbounds"][1]["streamSettings"]["sockopt"]["interface"],
        "fixture-if"
    );
    assert_eq!(probe["inbounds"].as_array().unwrap().len(), 1);
}

#[test]
fn implicit_system_dns_and_unknown_root_services_are_unavailable() {
    let sb = json!({"outbounds":[{"type":"vless","tag":"one","server":"fixture.invalid","server_port":443}]});
    assert_eq!(
        prepare_singbox_probe(&sb, "one", "fixture-if", 4321, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
    let xr = json!({"outbounds":[{"protocol":"vless","tag":"one","settings":{"vnext":[{"address":"fixture.invalid","port":443}]}}]});
    assert_eq!(
        prepare_xray_probe(&xr, "one", "fixture-if", 4321, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
    let unknown = json!({"future_service":{"listen":"0.0.0.0"},"outbounds":[{"type":"vless","tag":"one","server":"192.0.2.1","server_port":443}]});
    assert_eq!(
        prepare_singbox_probe(&unknown, "one", "fixture-if", 4321, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
}
#[test]
fn duplicate_tags_detour_cycles_and_reserved_inbound_are_rejected() {
    let cyclic = json!({"outbounds":[{"type":"vless","tag":"a","server":"192.0.2.1","detour":"b"},{"type":"socks","tag":"b","server":"192.0.2.2","detour":"a"}]});
    assert_eq!(
        prepare_singbox_probe(&cyclic, "a", "fixture-if", 4321, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
    let duplicate = json!({"outbounds":[{"type":"vless","tag":"a"},{"type":"socks","tag":"a"}]});
    assert_eq!(
        prepare_singbox_probe(&duplicate, "a", "fixture-if", 4321, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
    let collision = json!({"inbounds":[{"type":"http","tag":PROBE_INBOUND_TAG}],"outbounds":[{"type":"vless","tag":"a"}]});
    assert_eq!(
        inject_active_singbox_probe(&collision, "a", 4321, "secret"),
        Err(HealthIssue::UnsupportedProbe)
    );
    assert_eq!(
        inject_active_singbox_probe(&collision, "a", 4321, ""),
        Err(HealthIssue::UnsupportedProbe)
    );
}
