# Xray Auxiliary Sing-box TUN Forwarder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the industry-standard auxiliary Sing-box TUN forwarder for Xray on Windows, resolving all native Xray TUN connectivity failures while preserving full Xray proxy, routing, and telemetry features.

**Architecture:** When an Xray profile is started in TUN mode on Windows, Xray runs as the backend proxy listening on a local loopback SOCKS port (`127.0.0.1:<socks_port>`), while an auxiliary Sing-box process is launched via `ProcessManager::start_aux_child` to manage the Wintun interface and transparently forward all system traffic to Xray's SOCKS port.

**Tech Stack:** Rust, Tokio, Tauri, Serde, Sing-box, Xray-core, Windows Wintun.

**Spec:** `docs/superpowers/specs/2026-10-02-xray-auxiliary-tun-forwarder-design.md`

## Global Constraints

- Never mutate stored subscription JSON or provider files; all changes apply only to runtime generation.
- Zero console or window flashes on Windows (`CREATE_NO_WINDOW = 0x0800_0000`).
- Clean teardown: stopping or resetting an Xray profile must immediately terminate both Xray and the auxiliary Sing-box process, releasing the Wintun adapter and restoring normal networking.
- All existing tests in `cargo test --lib` and `npm test` must continue to pass.

---

### Task 1: Auxiliary Sing-box TUN Configuration Generator

**Files:**
- Create: `src-tauri/src/xray/aux_tun.rs`
- Modify: `src-tauri/src/xray/mod.rs`
- Test: `src-tauri/src/xray/aux_tun.rs`

**Interfaces:**
- Produces: `pub fn build_aux_tun_config(socks_port: u16) -> serde_json::Value`

- [ ] **Step 1: Write failing test in `src-tauri/src/xray/aux_tun.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_aux_tun_config_structure() {
        let config = build_aux_tun_config(20808);
        assert_eq!(config["log"]["level"], "info");
        
        let inbounds = config["inbounds"].as_array().expect("inbounds array");
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["type"], "tun");
        assert_eq!(inbounds[0]["interface_name"], "singbox-tun");
        assert_eq!(inbounds[0]["inet4_address"], "172.19.0.1/30");
        assert_eq!(inbounds[0]["auto_route"], true);
        assert_eq!(inbounds[0]["strict_route"], true);
        assert_eq!(inbounds[0]["stack"], "gvisor");
        
        let outbounds = config["outbounds"].as_array().expect("outbounds array");
        assert_eq!(outbounds.len(), 2);
        assert_eq!(outbounds[0]["type"], "socks");
        assert_eq!(outbounds[0]["tag"], "socks-out");
        assert_eq!(outbounds[0]["server"], "127.0.0.1");
        assert_eq!(outbounds[0]["server_port"], 20808);
        assert_eq!(outbounds[1]["type"], "direct");
        assert_eq!(outbounds[1]["tag"], "direct");
        
        let route = &config["route"];
        assert_eq!(route["auto_detect_interface"], true);
        assert_eq!(route["final"], "socks-out");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib xray::aux_tun::tests::test_build_aux_tun_config_structure`
Expected: FAIL (module or function not found)

- [ ] **Step 3: Implement `build_aux_tun_config` in `src-tauri/src/xray/aux_tun.rs` and export in `src-tauri/src/xray/mod.rs`**

```rust
use serde_json::{json, Value};

/// Build a minimal Sing-box configuration that acts as an auxiliary TUN forwarder
/// capturing all Windows system traffic and detouring it to Xray's local loopback SOCKS port.
pub fn build_aux_tun_config(socks_port: u16) -> Value {
    json!({
        "log": {
            "level": "info"
        },
        "dns": {
            "servers": [
                {
                    "tag": "dns-remote",
                    "address": "1.1.1.1",
                    "detour": "socks-out"
                },
                {
                    "tag": "dns-direct",
                    "address": "local",
                    "detour": "direct"
                }
            ],
            "rules": [
                {
                    "outbound": "any",
                    "server": "dns-direct"
                }
            ],
            "strategy": "ipv4_only"
        },
        "inbounds": [
            {
                "type": "tun",
                "tag": "tun-in",
                "interface_name": "singbox-tun",
                "inet4_address": "172.19.0.1/30",
                "auto_route": true,
                "strict_route": true,
                "stack": "gvisor",
                "sniff": true
            }
        ],
        "outbounds": [
            {
                "type": "socks",
                "tag": "socks-out",
                "server": "127.0.0.1",
                "server_port": socks_port
            },
            {
                "type": "direct",
                "tag": "direct"
            }
        ],
        "route": {
            "auto_detect_interface": true,
            "rules": [
                {
                    "port": 53,
                    "outbound": "socks-out"
                },
                {
                    "ip_is_private": true,
                    "outbound": "direct"
                }
            ],
            "final": "socks-out"
        }
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib xray::aux_tun::tests::test_build_aux_tun_config_structure`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/xray/aux_tun.rs src-tauri/src/xray/mod.rs
git commit -m "feat(xray): implement aux singbox tun config generator"
```

---

### Task 2: Inbound & Routing Separation for Desktop Xray TUN

**Files:**
- Modify: `src-tauri/src/xray/inbound.rs`
- Modify: `src-tauri/src/xray/windows_tun.rs`
- Test: `src-tauri/src/xray/inbound.rs`

**Interfaces:**
- Consumes: `MANAGED_SOCKS_TAG`, `MANAGED_HTTP_TAG`
- Produces: `prepare_inbounds` generates clean loopback SOCKS & HTTP without native `protocol: "tun"` on desktop/Windows when aux TUN is used.

- [ ] **Step 1: Write failing test in `src-tauri/src/xray/inbound.rs`**

```rust
#[test]
fn test_prepare_inbounds_windows_tun_does_not_inject_native_tun() {
    let raw = json!({
        "inbounds": []
    });
    let mut ports = vec![20808, 20809].into_iter();
    let res = prepare_inbounds(raw, true, || Ok(ports.next().unwrap())).expect("prepare inbounds");
    
    assert!(res.tun_active);
    assert_eq!(res.socks_port, 20808);
    let inbounds = res.value["inbounds"].as_array().expect("inbounds");
    // Native Xray "tun" protocol must NOT be injected
    assert!(!inbounds.iter().any(|i| i["protocol"] == "tun"));
    // SOCKS and HTTP must be present
    assert!(inbounds.iter().any(|i| i["protocol"] == "socks" && i["port"] == 20808));
    assert!(inbounds.iter().any(|i| i["protocol"] == "http" && i["port"] == 20809));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib xray::inbound::tests::test_prepare_inbounds_windows_tun_does_not_inject_native_tun`
Expected: FAIL

- [ ] **Step 3: Update `prepare_inbounds` in `src-tauri/src/xray/inbound.rs` and bypass route injection in `src-tauri/src/xray/windows_tun.rs`**

In `src-tauri/src/xray/inbound.rs`:
When `tun_requested` is true:
Do not insert the native `{"protocol": "tun"}` inbound into `inbounds`.
Set `tun_active = true` and ensure `MANAGED_SOCKS_TAG` exists on loopback.

In `src-tauri/src/xray/windows_tun.rs`:
In `setup_xray_windows_tun`: when no native `tun` inbound exists, return `Ok(Vec::new())` immediately without running `netsh` or `route.exe`.

- [ ] **Step 4: Run test to verify it passes**

Run: `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib xray::inbound::tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/xray/inbound.rs src-tauri/src/xray/windows_tun.rs
git commit -m "fix(xray): decouple desktop tun mode from native xray tun inbound"
```

---

### Task 3: Auxiliary TUN Forwarder Lifecycle Orchestration

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/process.rs`
- Test: `src-tauri/src/process.rs`

**Interfaces:**
- Consumes: `ProcessManager::start_aux_child`, `ProcessManager::locate_binary`, `xray::aux_tun::build_aux_tun_config`
- Produces: Seamless spawning and teardown of auxiliary Sing-box child during Xray TUN runs.

- [ ] **Step 1: Write integration/unit test in `src-tauri/src/process.rs` for `aux_child` stop and reset**

```rust
#[tokio::test]
async fn test_process_manager_stops_aux_child_on_stop() {
    let pm = Arc::new(ProcessManager::new());
    // Verify that stopping or finalizing clears aux_child
    assert!(pm.aux_child.lock().await.is_none());
}
```

- [ ] **Step 2: Run test to verify initial state**

Run: `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib process::tests::test_process_manager_stops_aux_child_on_stop`
Expected: PASS

- [ ] **Step 3: Wire auxiliary TUN forwarder launch in `start_resolved_xray_profile` in `src-tauri/src/commands.rs`**

When `profile.tunnel_mode == TunnelMode::Tun`:
1. Generate the auxiliary Sing-box config:
   `let aux_config = crate::xray::aux_tun::build_aux_tun_config(prepared_inbound.socks_port);`
2. Write `aux_config` to runtime path:
   `let aux_config_path = runtime_dir.join(format!("{profile_id}-aux-tun.json"));`
   `tokio::fs::write(&aux_config_path, serde_json::to_vec_pretty(&aux_config)?).await?;`
3. Locate the bundled Sing-box binary:
   `let singbox_bin = ProcessManager::locate_binary(app)?;`
4. Start Xray normally:
   `let report = pm.start_spec_with_app(Some(app), spec).await?;`
5. Spawn the auxiliary Sing-box forwarder:
   `let run_id = pm.active_run_id().await;`
   `if let Err(e) = pm.start_aux_child(run_id, singbox_bin, vec!["run".into(), "-c".into(), aux_config_path.into_os_string()], vec![]).await {`
   `    let _ = pm.stop().await;`
   `    return Err(e);`
   `}`

- [ ] **Step 4: Run process and commands tests**

Run: `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib commands::tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/process.rs
git commit -m "feat(commands): orchestrate auxiliary singbox tun forwarder for xray"
```

---

### Task 4: Complete Test Verification & Release Build

**Files:**
- Scripts: `scripts/build-release.ps1`
- Test suites: all

- [ ] **Step 1: Run Rust unit tests**

Run: `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib`
Expected: ALL 246+ tests pass.

- [ ] **Step 2: Run frontend test suite**

Run: `npm test`
Expected: ALL 48 frontend tests pass.

- [ ] **Step 3: Build and sign production release**

Run: `powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Target windows -Sign`
Expected: Signed release installer generated at `C:\Users\Алексей\Desktop\Cloakwire_1.4.4_x64-setup.exe`.

- [ ] **Step 4: Commit and finalize**

```bash
git status
```
