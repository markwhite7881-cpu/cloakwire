use super::network::*;
use serde_json::json;

fn route(name: &str, metric: u32) -> serde_json::Value {
    json!({"interface":name,"index":2,"gateway":"192.0.2.1","addresses":["192.0.2.2"],"metric":metric,"physical":true,"up":true})
}
#[test]
fn only_an_unambiguous_up_physical_route_can_be_used() {
    let mut tunnel = route("utun4", 1);
    tunnel["physical"] = json!(false);
    let mut down = route("Ethernet 2", 2);
    down["up"] = json!(false);
    let chosen = select_physical(&json!([tunnel, down, route("Ethernet", 20)])).unwrap();
    assert_eq!(chosen.interface(), "Ethernet");
    assert!(select_physical(&json!([route("a", 10), route("b", 10)])).is_err());
    assert!(select_physical(&json!([])).is_err());
    assert!(select_physical(&route("one", 1)).is_err());
}
#[test]
fn fingerprints_track_interface_and_addresses_but_ignore_enumeration_order() {
    let a = select_physical(&json!([route("Ethernet", 1)])).unwrap();
    let mut r = route("Ethernet", 1);
    r["addresses"] = json!(["192.0.2.8"]);
    assert_ne!(a, select_physical(&json!([r])).unwrap());
    let a = select_physical(&json!([route("Ethernet", 1), route("Wi-Fi", 10)])).unwrap();
    let b = select_physical(&json!([route("Wi-Fi", 10), route("Ethernet", 1)])).unwrap();
    assert_eq!(a, b);
    assert!(!a.fingerprint().contains("192.0.2"));
}
#[test]
fn local_or_invalid_uplinks_do_not_fall_back_to_the_vpn() {
    for gateway in ["127.0.0.1", "0.0.0.0", "::1", "host.example"] {
        let mut r = route("Ethernet", 1);
        r["gateway"] = json!(gateway);
        assert!(select_physical(&json!([r])).is_err());
    }
    let mut r = route("", 1);
    r["addresses"] = json!([]);
    assert!(select_physical(&json!([r])).is_err());
}
#[test]
fn mac_route_parser_uses_hardware_ports_and_rejects_multiple_uplinks() {
    let hardware = "Hardware Port: Wi-Fi\nDevice: en0\nHardware Port: Ethernet\nDevice: en7\n";
    let routes="Destination Gateway Flags Netif Expire\ndefault 192.0.2.1 UGScg en0\ndefault link#20 UCSIg utun4\n";
    assert_eq!(
        mac_default_routes(hardware, routes),
        vec![("en0".into(), "192.0.2.1".into())]
    );
}
