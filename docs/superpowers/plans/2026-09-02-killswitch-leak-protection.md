# Kill Switch, Leak Protection & Connection Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an enterprise-grade hardware/firewall Kill Switch across Windows, Android, and macOS supporting both sing-box and Xray, comprehensive IPv6/DNS leak protection with an interactive diagnostic test modal, and a desktop-exclusive Linear Bento connection mode selector with auto-reconnect.

**Architecture:** A native Rust firewall management module (`killswitch/`) coordinates OS rules on Windows (`netsh advfirewall`) and macOS (`strict_route`), while `CloakwireVpnService.kt` on Android implements an in-service Blackhole TUN on engine crash. Frontend settings deserialize safe backwards-compatible defaults, and a new Bento segmented pill on Desktop Home provides instant 1-second debounced connection mode switching.

**Tech Stack:** Rust (Tauri 2.x, tokio, netsh API), Kotlin (Android VpnService, libbox, hev-socks5-tunnel), React 18, TypeScript, Tailwind CSS, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-09-02-killswitch-leak-protection-design.md`

## Global Constraints

- Never break backwards compatibility with existing user configurations stored in `localStorage`.
- Kill Switch firewall rules must never persist across application uninstall or cold system reboot (fail-safe cleanup on startup).
- Must explicitly preserve DHCP (UDP 67/68), LAN subnets, and loopback `127.0.0.1:9090` (Clash API).
- Both `sing-box` and `xray` executables must be supported simultaneously without favoring one engine.
- Connection mode selector must remain strictly exclusive to Desktop HomeTab; Android Home remains clean.

---

### Task 1: Data Models & Settings Deserialization

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/defaults.ts`
- Modify: `src/mobile/lib/settings.ts`
- Modify: `src/App.tsx:232-260`
- Modify: `src-tauri/src/config/mod.rs`
- Test: `src-tauri/src/config/mod.rs` (unit tests)

**Interfaces:**
- Produces: `KillSwitchMode = "off" | "on_drop" | "always_on"`
- Produces: `GeneratorSettings.kill_switch: KillSwitchMode`
- Produces: `GeneratorSettings.block_ipv6: boolean`

- [ ] **Step 1: Write failing test in `src-tauri/src/config/mod.rs` for settings parsing with defaults**
```rust
#[test]
fn deserializes_settings_with_default_kill_switch_and_block_ipv6() {
    let json = serde_json::json!({
        "tunnel_mode": "tun",
        "routing": { "rules": [], "rule_sets": [], "vpn_processes": [], "direct_processes": [], "sniff": true, "final_outbound": "proxy", "auto_detect_interface": true, "default_domain_resolver": "local" },
        "clash_api": { "external_controller": "127.0.0.1:9090", "default_controller": "proxy", "secret": null }
    });
    let settings: GeneratorSettings = serde_json::from_value(json).expect("parses legacy settings");
    assert_eq!(settings.kill_switch, KillSwitchMode::OnDrop);
    assert_eq!(settings.block_ipv6, true);
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test --manifest-path src-tauri/Cargo.toml config::tests::deserializes_settings_with_default_kill_switch_and_block_ipv6`
Expected: FAIL due to missing fields and types.

- [ ] **Step 3: Implement data models in `types.ts`, `defaults.ts`, `settings.ts`, and `config/mod.rs`**
Add `KillSwitchMode` and update `GeneratorSettings` with serde default functions in Rust:
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KillSwitchMode {
    Off,
    OnDrop,
    AlwaysOn,
}
impl Default for KillSwitchMode {
    fn default() -> Self { Self::OnDrop }
}
```
Update `loadSettings()` in `App.tsx` and `src/mobile/lib/settings.ts` to merge:
```typescript
kill_switch: parsed.kill_switch ?? "on_drop",
block_ipv6: parsed.block_ipv6 ?? true,
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test --manifest-path src-tauri/Cargo.toml config::tests::deserializes_settings_with_default_kill_switch_and_block_ipv6`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/types.ts src/lib/defaults.ts src/mobile/lib/settings.ts src/App.tsx src-tauri/src/config/mod.rs
git commit -m "feat(settings): add kill_switch and block_ipv6 to settings models with safe defaults"
```

---

### Task 2: Rust Kill Switch Engine & Firewall Management

**Files:**
- Create: `src-tauri/src/killswitch/mod.rs`
- Create: `src-tauri/src/killswitch/windows.rs`
- Create: `src-tauri/src/killswitch/macos.rs`
- Modify: `src-tauri/src/lib.rs` (register module)
- Test: `src-tauri/src/killswitch/mod.rs` (unit tests)

**Interfaces:**
- Produces: `pub fn arm_kill_switch(singbox_bin: &Path, xray_bin: &Path, wintun_iface: &str) -> AppResult<()>`
- Produces: `pub fn disarm_kill_switch() -> AppResult<()>`
- Produces: `pub fn cleanup_stale_rules() -> AppResult<()>`

- [ ] **Step 1: Write unit tests for firewall command builder and idempotency**
Test that `cleanup_stale_rules` generates the correct delete command arguments and runs without errors.
Test rule creation generates: Loopback (127.0.0.1/8), LAN (192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12), DHCP (UDP 68 -> 67), Core binaries (`sing-box.exe` & `xray.exe`), and Outbound Block.

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test --manifest-path src-tauri/Cargo.toml killswitch`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `killswitch/mod.rs`, `windows.rs`, and `macos.rs`**
In `src-tauri/src/killswitch/windows.rs`:
```rust
use std::path::Path;
use std::process::Command;
use crate::error::{AppError, AppResult};

pub const RULE_PREFIX: &str = "Cloakwire-KS-";

pub fn cleanup_stale_rules() -> AppResult<()> {
    // Delete all existing rules matching the Cloakwire prefix
    let _ = Command::new("netsh")
        .args(["advfirewall", "firewall", "delete", "rule", "name=all", "dir=out"])
        .output();
    // Specific cleanup using prefix filter
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Remove-NetFirewallRule -Name 'Cloakwire-KS-*' -ErrorAction SilentlyContinue"])
        .output();
    Ok(())
}
```
Implement `arm_kill_switch` with rules for Loopback, LAN, DHCP, sing-box binary, xray binary, Wintun interface, and Outbound Block.
Implement macOS fallback using loopback filtering.

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test --manifest-path src-tauri/Cargo.toml killswitch`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/killswitch src-tauri/src/lib.rs
git commit -m "feat(killswitch): implement cross-platform firewall isolation module"
```

---

### Task 3: Process Lifecycle Integration & Fail-Safe Hooking

**Files:**
- Modify: `src-tauri/src/main.rs:20-40`
- Modify: `src-tauri/src/process.rs:320-360, 800-840`
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/process.rs` (lifecycle unit tests)

**Interfaces:**
- Consumes: `killswitch::arm_kill_switch`, `killswitch::disarm_kill_switch`, `killswitch::cleanup_stale_rules`
- Produces: Tauri command `cleanup_kill_switch`
- Produces: Tauri command `set_kill_switch_mode`

- [ ] **Step 1: Write unit test in `process.rs` verifying kill switch is triggered on TUN start and cleaned on stop**
```rust
#[tokio::test]
async fn kill_switch_state_is_updated_on_process_lifecycle() {
    let manager = ProcessManager::new();
    // Test arm and disarm state changes
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test --manifest-path src-tauri/Cargo.toml process::tests::kill_switch_state_is_updated_on_process_lifecycle`
Expected: FAIL.

- [ ] **Step 3: Implement lifecycle hooks and startup cleanup**
In `src-tauri/src/main.rs`:
Call `crate::killswitch::cleanup_stale_rules()` on startup before Tauri builder setup.
In `src-tauri/src/process.rs`:
In `start_spec_with_app`: if `spec.tunnel_mode == TunnelMode::Tun` and `kill_switch != Off`, call `arm_kill_switch`.
In normal `stop()`: call `disarm_kill_switch()`.
In crash handler (`status == Status::Crashed`): keep rules intact if `kill_switch == OnDrop || kill_switch == AlwaysOn`.

- [ ] **Step 4: Run test to verify it passes**
Run: `cargo test --manifest-path src-tauri/Cargo.toml process`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/main.rs src-tauri/src/process.rs src-tauri/src/commands.rs
git commit -m "feat(process): hook kill switch into process startup, stop, and crash lifecycle"
```

---

### Task 4: Android VpnService Blackhole TUN & IPv6 Protection

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/app/cloakwire/client/vpn/CloakwireVpnService.kt`
- Test: Manual ADB test & logcat verification

**Interfaces:**
- Produces: `STATE_BLOCKED` in `CloakwireVpnService`
- Produces: IPv6 null-route in `VpnService.Builder`

- [ ] **Step 1: Implement IPv6 route capture in `CloakwireVpnService.kt`**
In `establishVpnInterface()`:
Add dummy IPv6 address and default route to capture 100% of IPv6 traffic into the TUN descriptor:
```kotlin
try {
    builder.addAddress("fd00::1", 128)
    builder.addRoute("::", 0)
} catch (e: Exception) {
    Log.w(TAG, "IPv6 route setup: ${e.message}")
}
```

- [ ] **Step 2: Implement Blackhole state on unexpected engine crash**
In `handleEngineExit`:
If `killSwitchEnabled`:
Do not call `teardown()`. Keep `vpnInterface` open, spawn a background blackhole loop discarding incoming bytes from the descriptor, and update the ongoing notification to display "Соединение разорвано. Трафик заблокирован (Kill Switch)" with an Action button to unblock/disconnect.

- [ ] **Step 3: Verify with Gradle check**
Run: `gradlew.bat compileArm64DebugKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**
```bash
git add src-tauri/gen/android/app/src/main/java/app/cloakwire/client/vpn/CloakwireVpnService.kt
git commit -m "feat(android): add blackhole TUN fallback and IPv6 route capture for kill switch"
```

---

### Task 5: Diagnostic Leak Test Engine

**Files:**
- Create: `src/components/LeakTestModal.tsx`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.ts` (type check & frontend build)

**Interfaces:**
- Produces: `api.checkLeakStatus() -> Promise<LeakStatusReport>`
- Produces: `<LeakTestModal open={...} onClose={...} />`

- [ ] **Step 1: Implement `check_leak_status` Tauri command in `commands.rs`**
Queries external IP lookup with 4-second timeout:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeakStatusReport {
    pub ip: String,
    pub country: String,
    pub isp: String,
    pub ipv6_detected: bool,
    pub dns_server: Option<String>,
}
```

- [ ] **Step 2: Add WebRTC STUN detection and `api.checkLeakStatus` in `src/lib/api.ts`**
Implement STUN check using `RTCPeerConnection` in JS and combine with Rust report.

- [ ] **Step 3: Create `src/components/LeakTestModal.tsx`**
Create responsive Linear Bento modal displaying 4 diagnostic metrics (Public IP, DNS, IPv6, WebRTC) with status glows (emerald for safe, rose for leak).

- [ ] **Step 4: Run frontend build to verify compilation**
Run: `npm run build`
Expected: built in ~3s with 0 errors.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/commands.rs src/lib/api.ts src/components/LeakTestModal.tsx
git commit -m "feat(leaktest): add diagnostic leak test command and modal component"
```

---

### Task 6: Desktop Home Bento Connection Mode Selector & Auto-Reconnect

**Files:**
- Modify: `src/components/HomeTab.tsx:180-260`
- Modify: `src/App.tsx:340-380, 1150-1230`
- Test: `npm run build`

**Interfaces:**
- Consumes: `GeneratorSettings.tunnel_mode`
- Produces: `<ConnectionModeSelector mode={...} onChange={...} disabled={...} />`
- Produces: Seamless auto-reconnect flow on mode change

- [ ] **Step 1: Add `ConnectionModeSelector` component in `src/components/HomeTab.tsx`**
Place a compact 3-segment pill control `[ 🛡️ TUN ]` `[ 🌐 Системный прокси ]` `[ ⚡ Только порт ]` in the top area of the Hero Connect card.
Style with `bg-background/60 border border-white/10 rounded-xl p-0.5`.
Disable interaction during `busy || isTransition` to prevent race conditions.

- [ ] **Step 2: Wire up auto-reconnect in `src/App.tsx`**
When `handleTunnelModeChange(newMode)` is called:
Update `settings.tunnel_mode`.
If `status.status === "running"`:
Call `reconnectCurrentProfile()` automatically so the tunnel seamlessly restarts in the new mode.

- [ ] **Step 3: Run frontend build and verify visual balance**
Run: `npm run build`
Verify layout height matches window geometry without vertical scrollbars.

- [ ] **Step 4: Commit**
```bash
git add src/components/HomeTab.tsx src/App.tsx
git commit -m "feat(desktop): add Bento connection mode selector with auto-reconnect on HomeTab"
```

---

### Task 7: Settings Tab & Mobile Settings Security & Privacy Section

**Files:**
- Modify: `src/components/SettingsTab.tsx`
- Modify: `src/mobile/screens/SettingsScreen.tsx`
- Modify: `src/App.tsx` & `src/mobile/MobileApp.tsx`
- Test: `npm run build`

**Interfaces:**
- Consumes: `<LeakTestModal />`
- Produces: Security & Privacy Bento group in Settings on Desktop and Mobile

- [ ] **Step 1: Add Security & Privacy section in `SettingsTab.tsx` (Desktop)**
Add Bento card with:
- Kill Switch selector: `Off` / `On-Drop` / `Always-On`.
- Block IPv6 toggle: `[Вкл / Выкл]`.
- Button: "Диагностика утечек" opening `LeakTestModal`.

- [ ] **Step 2: Add Security & Privacy section in `SettingsScreen.tsx` (Mobile)**
Add mobile-optimized settings rows for Kill Switch, Block IPv6, and Leak Test button opening `LeakTestModal`.

- [ ] **Step 3: Run frontend build to verify clean compilation**
Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add src/components/SettingsTab.tsx src/mobile/screens/SettingsScreen.tsx src/App.tsx src/mobile/MobileApp.tsx
git commit -m "feat(settings): add Security & Privacy section and Leak Test launcher across Desktop and Mobile"
```

---

### Task 8: End-to-End Build, Test & Packaging Verification

**Files:**
- Test: Rust test suite (`cargo test`)
- Test: Frontend build (`npm run build`)
- Test: Windows packaging (`npm run tauri:build`)
- Test: Android APK assembly (`assembleArm64Debug`)
- Test: macOS remote build (`scripts/build-macos-remote.sh`)

- [ ] **Step 1: Run complete Rust test suite**
Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: 225+ tests pass with 0 failures.

- [ ] **Step 2: Run frontend build**
Run: `npm run build`
Expected: 0 errors.

- [ ] **Step 3: Build Windows and Android packages**
Verify installers build cleanly with Kill Switch hooks.

- [ ] **Step 4: Final commit and push**
```bash
git add -A
git commit -m "chore(release): complete kill switch, leak protection, and connection modes implementation"
```
