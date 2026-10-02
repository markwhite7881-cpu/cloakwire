# Design Specification: Xray Auxiliary Sing-box TUN Forwarder on Windows

## 1. Context & Motivation

In Cloakwire v1.4, Sing-box TUN mode functions reliably across Windows, Android, and macOS. However, Xray in TUN mode on Windows has failed to provide functional internet connectivity across all testing iterations.

### Root Causes of Native Xray TUN Failures
1. **Lack of Socket Interface Binding:** Unlike Sing-box which uses `auto_detect_interface: true` and calls Windows IP Helper APIs (`SetUnicastInterface`) to bind physical sockets to the physical NIC, Xray relies on Go runtime socket creation without adapter binding, resulting in routing loops when default routes point to Wintun.
2. **Layer-3 Wintun Gateway Conflicts:** Wintun is an L3 (IP-only) adapter without an ARP layer. Adding gateway routes via external `route add ... 172.19.0.1` causes Windows to attempt ARP resolution, resulting in dropped packets.
3. **DNS Deadlocks:** Xray's `tun_windows.go` overrides Go's DNS resolver via `SkipDNSServers`, causing DNS queries on Windows to deadlock or loop when port 53 is redirected.
4. **Lack of ICMP Support:** Xray's gVisor implementation only dispatches TCP and UDP streams. ICMP (ping) packets are dropped by Xray's netstack.

### Industry Proven Pattern
All major proxy clients supporting Xray with TUN mode on Windows (notably **v2rayN**) use **Sing-box** for TUN mode. v2rayN explicitly displays *"sing-box core is required for tun mode"* and forwards system TUN traffic to Xray's local loopback SOCKS port.

Cloakwire's codebase already contains the foundation for this pattern in `src-tauri/src/process.rs` via `ProcessManager::start_aux_child`, which includes child slot lifecycle management and Sing-box log parsing under the `[TUN]` tag.

---

## 2. Architecture & Data Flow

### Diagram
```
[ Windows Applications (Browser, System, Games) ]
                      │
                      ▼ (IP Packets, DNS, ICMP)
         [ Wintun Adapter ("singbox-tun") ]
                      │
                      ▼
   [ Process 2: Sing-box (Auxiliary TUN Forwarder) ]
      - Stack: gVisor
      - Routing: auto_detect_interface = true, auto_route = true, strict_route = true
      - DNS: 1.1.1.1 (remote via socks-out), local (direct)
      - Detour Outbound: SOCKS5 @ 127.0.0.1:<socks_port>
                      │
                      ▼ (TCP / UDP over 127.0.0.1)
         [ Process 1: Xray-core (Backend Proxy) ]
      - Inbound: "socks" (MANAGED_SOCKS_TAG) @ 127.0.0.1:<socks_port>
      - Inbound: "http" (MANAGED_HTTP_TAG) @ 127.0.0.1:<http_port>
      - Routing: User rules, domain/IP routing, sniffing
      - Outbound: VLESS / VMess / Trojan / Shadowsocks / Reality / Vision
      - Telemetry: Xray stats stream tracking MANAGED_SOCKS_TAG
                      │
                      ▼ (Encrypted proxy traffic via bound physical interface)
                   [ VPS Server ]
```

---

## 3. Detailed Component Design

### 3.1 Auxiliary TUN Config Generator (`src-tauri/src/xray/aux_tun.rs`)
A new dedicated module will generate a minimal, self-contained Sing-box JSON configuration:
```rust
pub fn build_aux_tun_config(socks_port: u16) -> serde_json::Value {
    serde_json::json!({
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

### 3.2 Inbound Preparation (`src-tauri/src/xray/inbound.rs`)
- When `tun_requested` is true on Windows / Desktop:
  - Do NOT inject `protocol: "tun"` into Xray inbounds.
  - Retain the automatically generated `MANAGED_SOCKS_TAG` inbound on `127.0.0.1:<socks_port>`.
  - Mark `ManagedHttpInbound.tun_active = true`.
- Native Xray TUN inbound injection is disabled, preventing Xray's `proxy/tun` from fighting for Wintun or installing conflicting routes.

### 3.3 Routing Integration (`src-tauri/src/xray/routing.rs`)
- In `merge_routing_with_tun`:
  - Keep standard routing translations.
  - Since traffic from Sing-box enters Xray on `MANAGED_SOCKS_TAG`, all regular user routing rules apply seamlessly.
  - DNS from port 53 redirected via Sing-box to `socks-out` will enter Xray as SOCKS5 connections and be handled by Xray's DNS or proxy outbounds.

### 3.4 Windows TUN Setup Cleanup (`src-tauri/src/xray/windows_tun.rs`)
- Deprecate external `netsh` and `route.exe` modifications in `setup_xray_windows_tun`:
  - When Sing-box acts as the auxiliary TUN forwarder, Sing-box's internal auto-router manages Wintun and routes natively via Windows IP Helper APIs.
  - External route manipulation is bypassed completely when auxiliary TUN mode is active.

### 3.5 Process Lifecycle Orchestration (`src-tauri/src/commands.rs` & `src-tauri/src/process.rs`)
- In `start_resolved_xray_profile`:
  - If `profile.tunnel_mode == TunnelMode::Tun`:
    - Retrieve `socks_port` from `prepared_inbound`.
    - Generate auxiliary Sing-box config via `build_aux_tun_config(socks_port)`.
    - Save config to `runtime_dir.join(format!("{profile_id}-aux-tun.json"))`.
    - Locate the bundled Sing-box binary via `ProcessManager::locate_binary(app)`.
    - Start Xray as primary process (`pm.start_spec_with_app(...)`).
    - Immediately spawn auxiliary Sing-box child via `pm.start_aux_child(run_id, singbox_bin, vec!["run".into(), "-c".into(), aux_config_path.into()], vec![])`.
- In `pm.stop()`, `pm.finalize_exit()`, and `pm.reset()`:
  - Existing `aux_child` termination logic ensures that stopping Xray automatically kills the auxiliary Sing-box process, unloads Wintun, and restores normal network connectivity.
  - Temporary auxiliary config files are deleted on shutdown.

---

## 4. Verification & Testing Strategy

1. **Unit Tests:**
   - Test `build_aux_tun_config` structure, ports, and route definitions.
   - Verify `prepare_inbounds` generates valid `MANAGED_SOCKS_TAG` without native TUN inbound when auxiliary TUN is used.
   - Verify routing rules when `tun_active` is true.
2. **Integration / Lifecycle Tests:**
   - Test `ProcessManager::start_aux_child` together with `stop()` and `finalize_exit()` ensuring `aux_child` is properly terminated.
3. **Full Regression Suite:**
   - Run `$env:CLOAKWIRE_TEST_MANIFEST = "1"; cargo test --lib` (all 246+ tests).
   - Run `npm test` (all 48 frontend tests).
4. **Release Installer:**
   - Build and sign production installer to Desktop (`C:\Users\Алексей\Desktop\Cloakwire_1.4.4_x64-setup.exe`).
