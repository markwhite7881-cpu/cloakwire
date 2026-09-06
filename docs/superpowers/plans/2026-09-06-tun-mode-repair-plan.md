# TUN Mode Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Windows TUN mode in Cloakwire so that full system internet traffic is properly routed and DNS does not time out or loop for both Sing-box and Xray engines.

**Architecture:** 
1. For Sing-box: add mandatory `auto_detect_interface: true` to the generated `route` object, ensure `local` DNS server has `detour: "direct"`, and route domestic/direct queries to local DNS.
2. For Xray: inject an explicit catch-all TUN inbound routing rule in `xray/routing.rs` for `cloakwire-managed-tun` to forward traffic to the proxy/balancer, and in `windows_tun.rs` add `/32` physical gateway bypass routes for upstream DNS servers (`1.1.1.1`, `8.8.8.8`) to eliminate routing loops on Windows.

**Tech Stack:** Rust (Tauri 2 backend), Sing-box 1.14+, Xray-core, Wintun driver, Windows IP Helper & `route.exe`.

**Spec:** [docs/superpowers/specs/2026-09-06-tun-mode-repair-design.md](file:///C:/Users/Public/cwdev/cloakwire-release-v132/docs/superpowers/specs/2026-09-06-tun-mode-repair-design.md)

## Global Constraints

- Never mutate stored subscription JSON or provider files; all changes apply only to runtime generation.
- Zero windows or console flashes during `route` or `netsh` executions (`CREATE_NO_WINDOW = 0x0800_0000`).
- Clean teardown: all added `/32` routes must be cleanly deleted when stopping or resetting.
- All existing tests in `cargo test --lib` must continue to pass.

---

### Task 1: Sing-box Routing & DNS Auto-Detect (`src-tauri/src/config/mod.rs`)

**Files:**
- Modify: `src-tauri/src/config/mod.rs:379-440` (`build_route`)
- Modify: `src-tauri/src/config/mod.rs:685-745` (`build_dns`)
- Test: `src-tauri/src/config/mod.rs` (unit tests in `mod tests`)

**Interfaces:**
- Produces: `build_route` with `"auto_detect_interface": true`.
- Produces: `build_dns` with `local_obj` having `"detour": "direct"`.

- [ ] **Step 1: Write failing unit test**

Add tests to `src-tauri/src/config/mod.rs` in `mod tests`:
```rust
#[test]
fn route_contains_auto_detect_interface() {
    let settings = GeneratorSettings::default();
    let route = build_route(&settings);
    assert_eq!(route.get("auto_detect_interface"), Some(&serde_json::Value::Bool(true)));
}

#[test]
fn dns_local_server_has_direct_detour() {
    let settings = GeneratorSettings::default();
    let dns = build_dns(&settings.dns, &settings.routing);
    let servers = dns["servers"].as_array().expect("servers array");
    let local = servers.iter().find(|s| s["tag"] == "local").expect("local server");
    assert_eq!(local["detour"], "direct");
}
```

- [ ] **Step 2: Run test to verify failure**

Run:
```powershell
$env:CLOAKWIRE_TEST_MANIFEST = "1"; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test --lib config::tests::route_contains_auto_detect_interface config::tests::dns_local_server_has_direct_detour
```
Expected: FAIL.

- [ ] **Step 3: Implement minimal code in `src-tauri/src/config/mod.rs`**

In `build_route`:
```rust
    json!({
        "rules": rules,
        "auto_detect_interface": true,
        "final": "proxy"
    })
```
In `build_dns`:
```rust
    let mut local_obj = Map::new();
    local_obj.insert("type".into(), Value::String(local_type));
    local_obj.insert("tag".into(), Value::String("local".into()));
    local_obj.insert("server".into(), Value::String(local_server));
    local_obj.insert("detour".into(), Value::String("direct".into()));
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```powershell
$env:CLOAKWIRE_TEST_MANIFEST = "1"; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test --lib config::tests
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config/mod.rs
git commit -m "fix(singbox): add auto_detect_interface and direct detour to local dns"
```

---

### Task 2: Xray Catch-All TUN Inbound Routing (`src-tauri/src/xray/routing.rs`)

**Files:**
- Modify: `src-tauri/src/xray/routing.rs:168-215` (`merge_routing_with_tun`)
- Test: `src-tauri/src/xray/routing.rs` (unit tests)

**Interfaces:**
- Consumes: `tun_active: bool`, `tun_tag: Option<&str>`, `balancer_tags: HashSet<String>`.
- Produces: `routing.rules` containing an inbound route for `cloakwire-managed-tun` mapped to active balancer or primary proxy outbound.

- [ ] **Step 1: Write failing test**

In `src-tauri/src/xray/routing.rs` test module:
```rust
#[test]
fn tun_inbound_has_catch_all_routing_rule() {
    let provider = serde_json::json!({
        "inbounds": [],
        "outbounds": [{"tag": "proxy-germany", "protocol": "vless"}],
        "routing": {"rules": []}
    });
    let routing = RoutingOptions::default();
    let prep = merge_routing_with_tun(provider, &routing, true, Some("cloakwire-managed-tun")).unwrap();
    let rules = prep.value["routing"]["rules"].as_array().unwrap();
    let tun_catch_all = rules.iter().find(|r| {
        r.get("inboundTag")
            .and_then(|t| t.as_array())
            .map(|arr| arr.iter().any(|v| v == "cloakwire-managed-tun"))
            .unwrap_or(false)
            && r.get("port").is_none()
    });
    assert!(tun_catch_all.is_some(), "catch-all TUN rule must be present");
    assert_eq!(tun_catch_all.unwrap()["outboundTag"], "proxy-germany");
}
```

- [ ] **Step 2: Run test to verify failure**

Run:
```powershell
$env:CLOAKWIRE_TEST_MANIFEST = "1"; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test --lib xray::routing::tests::tun_inbound_has_catch_all_routing_rule
```
Expected: FAIL.

- [ ] **Step 3: Implement in `src-tauri/src/xray/routing.rs`**

In `merge_routing_with_tun`:
After prepending the DNS rule for `cloakwire-managed-tun`, append a catch-all route for the TUN inbound:
```rust
    if tun_active {
        let tun_inbound_tag = tun_tag.unwrap_or(crate::xray::inbound::MANAGED_TUN_TAG);
        let target_balancer = balancer_tags.iter().next().cloned();
        let target_outbound = outbound_tags.first().cloned().unwrap_or_else(|| "proxy".to_string());
        
        let catch_all_rule = if let Some(balancer) = target_balancer {
            serde_json::json!({
                "type": "field",
                "inboundTag": [tun_inbound_tag],
                "network": "tcp,udp",
                "balancerTag": balancer
            })
        } else {
            serde_json::json!({
                "type": "field",
                "inboundTag": [tun_inbound_tag],
                "network": "tcp,udp",
                "outboundTag": target_outbound
            })
        };
        final_rules.push(catch_all_rule);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```powershell
$env:CLOAKWIRE_TEST_MANIFEST = "1"; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test --lib xray::routing::tests
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/xray/routing.rs
git commit -m "fix(xray): add catch-all routing rule for managed tun inbound"
```

---

### Task 3: Windows Wintun DNS Bypass Routes & Loop Prevention (`src-tauri/src/xray/windows_tun.rs`)

**Files:**
- Modify: `src-tauri/src/xray/windows_tun.rs:260-310` (`setup_xray_windows_tun`)
- Test: `src-tauri/src/xray/windows_tun.rs` (unit tests)

**Interfaces:**
- Produces: `extract_xray_dns_ips(config: &Value) -> Vec<Ipv4Addr>`
- Ensures: `/32` bypass routes via default gateway added for all DNS servers (`1.1.1.1`, `8.8.8.8`, etc.).

- [ ] **Step 1: Write failing test**

In `src-tauri/src/xray/windows_tun.rs` tests:
```rust
#[test]
fn extracts_dns_server_ips() {
    let config = serde_json::json!({
        "dns": {
            "servers": ["tcp://1.1.1.1", "tcp://8.8.8.8", "1.0.0.1"]
        }
    });
    let ips = extract_xray_dns_ips(&config);
    assert_eq!(ips, vec![
        "1.0.0.1".parse::<Ipv4Addr>().unwrap(),
        "1.1.1.1".parse::<Ipv4Addr>().unwrap(),
        "8.8.8.8".parse::<Ipv4Addr>().unwrap()
    ]);
}
```

- [ ] **Step 2: Run test to verify failure**

Run:
```powershell
$env:CLOAKWIRE_TEST_MANIFEST = "1"; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test --lib xray::windows_tun::tests::extracts_dns_server_ips
```
Expected: FAIL.

- [ ] **Step 3: Implement DNS extraction and bypass routing**

1. Implement `extract_xray_dns_ips`:
```rust
pub fn extract_xray_dns_ips(config: &Value) -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    if let Some(servers) = config.get("dns").and_then(|d| d.get("servers")).and_then(Value::as_array) {
        for server in servers {
            let addr_str = if let Some(s) = server.as_str() {
                s
            } else if let Some(addr) = server.get("address").and_then(Value::as_str) {
                addr
            } else {
                continue;
            };
            let cleaned = addr_str
                .strip_prefix("tcp://")
                .or_else(|| addr_str.strip_prefix("udp://"))
                .unwrap_or(addr_str);
            let ip_only = cleaned.split(':').next().unwrap_or(cleaned);
            if let Ok(ip) = ip_only.parse::<Ipv4Addr>() {
                if !ip.is_loopback() && !ip.is_unspecified() {
                    ips.push(ip);
                }
            }
        }
    }
    if ips.is_empty() {
        ips.push("1.1.1.1".parse().unwrap());
        ips.push("8.8.8.8".parse().unwrap());
    }
    ips.sort();
    ips.dedup();
    ips
}
```
2. In `setup_xray_windows_tun`:
Combine `server_ips` and `dns_ips`:
```rust
    let mut bypass_ips = server_ips;
    let dns_ips = extract_xray_dns_ips(&config);
    bypass_ips.extend(dns_ips);
    bypass_ips.sort();
    bypass_ips.dedup();
```
Route each `ip in &bypass_ips` with metric 1 via `default_gw.gateway_ip`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```powershell
$env:CLOAKWIRE_TEST_MANIFEST = "1"; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test --lib xray::windows_tun::tests
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/xray/windows_tun.rs
git commit -m "fix(xray): add host bypass routes for dns servers to eliminate routing loops"
```

---

### Task 4: Complete Test Suite & Release Build Verification

**Files:**
- Entire repository

- [ ] **Step 1: Run all Rust library tests**

Run:
```powershell
$env:CLOAKWIRE_TEST_MANIFEST = "1"; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test --lib
```
Expected: All 240+ tests pass.

- [ ] **Step 2: Run all frontend tests**

Run:
```powershell
npm test
```
Expected: All frontend tests pass.

- [ ] **Step 3: Build, sign, and deliver the release binary**

Run:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Target windows -Sign
```
Expected: Installer generated and delivered to `C:\Users\Алексей\Desktop\Cloakwire_1.4.4_x64-setup.exe`.
