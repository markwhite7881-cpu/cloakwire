# Architectural Specification: Kill Switch, Leak Protection & Connection Modes

- **Date**: 2026-09-02
- **Topic**: Enterprise-Grade Kill Switch, Multi-Vector Leak Protection & Desktop Connection Mode Selector
- **Target Platforms**: Windows (x64), macOS (Apple Silicon / Intel), Android (ARM64)
- **Status**: Approved for Implementation Plan

---

## 1. Executive Summary & Goals

This specification defines the architectural design for three interconnected security and user experience capabilities in Cloakwire:

1. **Native Firewall Kill Switch**:
   - Total isolation of unencrypted outbound traffic during sudden VPN core crashes or network drops.
   - Dual-engine compatibility: supports both `sing-box` and `xray` without protocol or core lock-in.
   - Fail-safe design: zero possibility of permanent network blackout on reboot, uninstallation, or abnormal termination.
2. **Comprehensive Leak Protection & Diagnostic Test**:
   - Automatic IPv6 null-routing / rejection preventing dual-stack ISP deanonymization.
   - Strict DNS port 53 hijacking to internal encrypted resolvers.
   - Built-in multi-vector Leak Test (Public IP/Geo, DNS Canary, WebRTC STUN, IPv6 status).
3. **Desktop Connection Mode Selector**:
   - Seamlessly integrated Linear Bento Segmented Pill on the Desktop Home screen:
     `[ 🛡️ TUN ]` `[ 🌐 System Proxy ]` `[ ⚡ Only Inbound ]`.
   - 1-second debounced auto-reconnection upon mode switch during active sessions.
   - Mobile Home screen remains clean and uncluttered (Android operates exclusively via native `VpnService` TUN).

---

## 2. Architecture & Subsystems

### 2.1. Backend Kill Switch Engine (`src-tauri/src/killswitch/`)

A new cross-platform Rust module `src-tauri/src/killswitch/` manages OS-level network isolation rules:

#### A. Windows Implementation (`windows.rs`)
- Interacts with Windows Firewall via `netsh advfirewall firewall` using the isolated prefix `Cloakwire-KS-*`.
- **Rule Set when Kill Switch is Active**:
  1. `Cloakwire-KS-Allow-Loopback`: Outbound ALLOW to `127.0.0.0/8` and `::1` (preserves Clash API on port 9090, local WebViews, and IPC).
  2. `Cloakwire-KS-Allow-LAN`: Outbound ALLOW to private subnets `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12` (preserves router access, local printers, and LAN peers).
  3. `Cloakwire-KS-Allow-DHCP`: Outbound ALLOW UDP port 68 to port 67 (`255.255.255.255`) preventing Wi-Fi lease expiration.
  4. `Cloakwire-KS-Allow-Core-Singbox`: Outbound ALLOW for `<app_cache_dir>/binaries/sing-box.exe` to all destinations (allows bootstrap DNS resolution of server domain names and tunnel handshake).
  5. `Cloakwire-KS-Allow-Core-Xray`: Outbound ALLOW for `<app_cache_dir>/binaries/xray.exe`.
  6. `Cloakwire-KS-Allow-Wintun`: Outbound ALLOW through interface `singbox-tun` / Wintun adapter.
  7. `Cloakwire-KS-Block-Outbound`: Outbound BLOCK for all other processes and interfaces (IPv4 and IPv6).
- **Graceful Error Handling**:
  - Checks if Windows Firewall service (`MpsSvc`) is running. If disabled by third-party antivirus, logs warning and returns `AppError::KillSwitch("Windows Firewall service is unavailable")` rather than panicking.

#### B. Android Implementation (`CloakwireVpnService.kt`)
- `setBlocking(true)` configured during `VpnService.Builder` setup.
- **Blackhole Fallback State**:
  - When either `sing-box` (via libbox callback) or `xray` (via watcher thread) crashes, `CloakwireVpnService` does **not** close the `vpnInterface` file descriptor if Kill Switch is enabled (`on_drop` or `always_on`).
  - Instead, the service enters `STATE_BLOCKED`: packets routed by Android OS into the TUN descriptor are discarded into a null sink, preventing any app from leaking packets to Wi-Fi or LTE.
  - Notification displays: *"VPN connection dropped. Kill Switch active"* with action button *"Disconnect / Unblock"*.

#### C. macOS Implementation (`macos.rs`)
- Utilizes `sing-box` native `strict_route: true` on `utun` interface combined with loopback packet filtering.

---

### 2.2. Fail-Safe Recovery Mechanisms

To eliminate any risk of locking a user out of the internet:
1. **Startup Cleanup**: On every app launch (`src-tauri/src/main.rs`), `killswitch::cleanup_stale_rules()` executes before any network commands, removing any dangling `Cloakwire-KS-*` rules left by sudden power loss.
2. **RAII Drop & Panic Hooks**: The Kill Switch guard implements `Drop` and registers a panic hook to clean up firewall rules when the process terminates.
3. **Uninstaller Integration**: Both NSIS (`.exe`) and WiX (`.msi`) installer scripts include an uninstall step running `netsh advfirewall firewall delete rule name="Cloakwire-KS-*"` to clean rules upon software removal.

---

### 2.3. Leak Protection (IPv6 & DNS)

1. **IPv6 Leak Elimination**:
   - Setting: `block_ipv6: boolean` (default: `true`).
   - In `sing-box` and `xray` configs: rule `{ "ip_version": 6, "outbound": "block" }` rejects native IPv6 connections, forcing dual-stack browsers (Happy Eyeballs RFC 8305) to immediately fall back to encrypted IPv4 without timeout stalls.
   - On Android: `VpnService.Builder.addAddress("2001:db8::1", 128)` and `addRoute("::", 0)` routes 100% of IPv6 into TUN, where the core drops it safely.
2. **DNS Leak Prevention**:
   - `sing-box` captures all port 53 UDP/TCP traffic via `inbound.type: "direct"` or `hijack-dns`.
   - Primary DNS on Wintun adapter is locked to `1.1.1.1` (or local core DNS listener).
3. **Leak Test Engine**:
   - Rust command `check_leak_status()` queries external endpoints with a strict 4-second timeout:
     - Public IP / ISP / Country lookup.
     - DNS resolver identity check.
     - IPv6 availability check.
   - JavaScript engine tests WebRTC STUN via `RTCPeerConnection` in the WebView to detect any leaked local or WAN IPs.

---

### 2.4. Desktop Home Connection Mode Selector

- Located on the Desktop `HomeTab` inside Bento Card 1 (Hero Connect Card).
- **Modes**:
  - `tun`: Wintun L3 adapter (complete system traffic, games, torrents).
  - `system_proxy`: Local proxy + WinINet proxy settings (browsers only, no virtual adapter).
  - `none` / `both`: Outbound ports only or hybrid.
- **Visual Design**:
  - Linear Bento segmented pill: `h-7`, `bg-background/60`, border `border-white/10`, rounded `rounded-xl`.
  - Active pill: `bg-emerald-500/15`, `border-emerald-500/30`, text `text-emerald-400 font-medium`.
  - Disabled during transit (`isTransition || busy`) to prevent race conditions.
  - Switching mode while `status === "running"` triggers seamless auto-reconnect (`reconnectCurrentProfile()`) in ~1 second.

---

## 3. Data Models & API Contracts

### 3.1. Settings Model Additions (`types.ts` & `src-tauri/src/config/mod.rs`)

```typescript
export type KillSwitchMode = "off" | "on_drop" | "always_on";

export interface GeneratorSettings {
  tunnel_mode: TunnelMode;
  kill_switch: KillSwitchMode;
  block_ipv6: boolean;
  routing: RoutingOptions;
  clash_api: ClashApiOptions;
  tun_interface_name: string | null;
  mixed_port: number | null;
  local_dns: string | null;
  remote_dns: string | null;
  default_outbound: string | null;
}
```

### 3.2. Tauri Commands

- `check_leak_status() -> Result<LeakStatusReport, AppError>`: Executes public IP and DNS resolver probes with 4s timeout.
- `set_kill_switch_mode(mode: KillSwitchMode) -> Result<(), AppError>`: Activates or resets firewall rules.
- `cleanup_kill_switch() -> Result<(), AppError>`: Removes all Cloakwire firewall rules.

---

## 4. Verification & Testing Plan

1. **Unit Tests (Cargo)**:
   - `killswitch::tests::parses_rules_and_generates_correct_netsh_args`.
   - `killswitch::tests::cleanup_removes_stale_rules_idempotently`.
   - `config::tests::block_ipv6_injects_rejection_rules`.
2. **Integration Tests (Windows)**:
   - Verify rules appear in `netsh advfirewall firewall show rule name="Cloakwire-KS-*"`.
   - Kill `sing-box.exe` / `xray.exe` via Task Manager: verify ping to `8.8.8.8` is blocked while Kill Switch is on.
   - Verify local LAN ping (`192.168.1.1`) and loopback (`127.0.0.1:9090`) remain functional.
   - Start Cloakwire again: verify stale rules are cleaned up on startup.
3. **Android Verification**:
   - Verify `VpnService` blackhole on engine crash.
   - Verify IPv6 route capture into TUN.
4. **Leak Test Verification**:
   - Run Leak Test in UI: verify IP, DNS, IPv6 and WebRTC statuses report accurate results.
