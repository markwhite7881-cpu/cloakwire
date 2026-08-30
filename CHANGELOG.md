# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.2] - 2026-08-30

### 🪟 Windows Networking & Process Cleanup
- **⚡ Dynamic WinINet Proxy Change Broadcast (`src-tauri/src/process.rs`)**:
  - Implemented dynamic loading and invocation of Windows WinINet API `InternetSetOptionW` with `INTERNET_OPTION_SETTINGS_CHANGED` (39) and `INTERNET_OPTION_REFRESH` (37) on proxy enable and clear.
  - Automatically notifies running applications (Steam, Chromium, game engines, browsers) immediately upon VPN disconnect, preventing connection drops and cached proxy stall.
- **🧹 Registry `ProxyServer` Residue Cleanup**:
  - Explicitly resets and clears the `ProxyServer` string value in `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` on VPN termination, preventing games from attempting connections to closed loopback ports.

---

## [1.4.1] - 2026-08-29

### 🛡️ Security Vulnerabilities Remediated & Hardening
- **🔒 Auto-Updater TOCTOU Mitigation (`src-tauri/src/app_update.rs`)**:
  - Moved installer staging from public `/tmp/cloakwire-update/` to private user application cache (`app.path().app_cache_dir().join("updates")`).
  - Enforced strict permissions on directories and staged update binaries, preventing local package tampering before execution.
- **🔐 Secure Runtime Configuration Storage (`src-tauri/src/commands.rs`)**:
  - Staged sing-box and Xray runtime configuration files (`config.managed.json`) with UUID paths inside private user cache (`app_cache_dir().join("cloakwire-runtime")`).
  - Enforced strict `0600` POSIX file permissions to protect embedded credentials and Reality private keys from unprivileged local readers.
- **🌐 Subscription Inbound & Clash API Sanitization (`src-tauri/src/subscriptions/classify.rs`)**:
  - Implemented `sanitize_bundle_config()` which enforces `listen: "127.0.0.1"` on all socket-based inbounds (`mixed`, `socks`, `http`, `tproxy`) to prevent external LAN exposure.
  - Restricted `clash_api.external_controller` strictly to loopback `127.0.0.1:<port>`.
- **⚡ Latency Ping Concurrency Throttling & DoS Protection (`src/hooks/useServerLatency.ts` & `classify.rs`)**:
  - Replaced unconstrained `Promise.allSettled` ping sweeps with 12-socket batch concurrency.
  - Capped background latency probing to the first 100 profiles and imposed a 500-profile maximum import limit per subscription to prevent socket exhaustion.
- **🔗 Supply Chain Reproducibility & Lockfile Pinning (`Cargo.lock`, `.github/workflows/release-android.yml`)**:
  - Unignored and committed `src-tauri/Cargo.lock` to guarantee reproducible deterministic dependency resolution.
  - Pinned `Leadaxe/sing-box-lx` repository clone in Android CI/CD workflow to verified commit hash `ff40cf98cb80ca6c9e9ae823ad392045cb4d23de`.

---

## [1.4.0] - 2026-08-29

### 🎨 Linear Bento UI Redesign (Desktop & Mobile)
- **Unified Linear Bento Design**: Completely overhauled layout with sleek, dark tactile bento cards, emerald neon glow accents, and responsive typography across both desktop and mobile platforms.
- **60 FPS Live Traffic & Speed Wave**: Re-engineered real-time throughput chart with smooth sub-second interpolation, real-time download/upload speed counters (KB/s, MB/s), and cumulative bandwidth tracking.
- **Hero Tactile Power Orb**: Redesigned central connection button with smooth pulse glow animations, state transition spinners, and tactile haptic feedback.
- **Adaptive Window Sizing**: Fixed desktop window geometry to maintain optimal aspect ratio without redundant empty space.

### ⚡ Server Management & Quick Switcher
- **Instant Server Switcher**: Change active servers directly from the Home Screen with live latency badges without navigating to secondary tabs.
- **Inline Quick Add (+)**: Direct import modal on the main dashboard for pasting VLESS/Shadowsocks/Trojan links or subscription URLs.
- **Smart Clipboard**: Automatically detects VPN share links (`vless://`, `vmess://`, `ss://`, `trojan://`, `tuic://`, `hy2://`, `http://`, `https://`) from clipboard on open and offers 1-tap paste.
- **Automated Ping Updates**: Instant latency calculation with color-coded speed badges (green < 100ms, amber < 250ms, rose > 250ms).

### 📱 Android Experience & Haptics
- **Haptic Vibration Feedback**: Tactile feedback on Power button toggle, server switcher selection, and mode changes.
- **Rich Status Notifications**: Informative ongoing notification displaying connected server name, active core engine (`sing-box` / `Xray`), and quick Disconnect action.
- **Quick Settings Tile**: Android quick tile integration with live connection toggle and server indicator.

### 🛡️ Core Engine & Network Fixes
- **sing-box DNS Hijacking**: Added strict port 53 DNS hijacking (`hijack-dns`) and direct LAN routing (`ip_is_private: true`), resolving DNS resolution timeouts on Android.
- **IPv6 Blackhole Prevention**: Optimized Android TUN interface to avoid IPv6 routing loops when connecting to IPv4-only VPS endpoints.
- **sing-box In-Process Monitoring**: Connected `libbox.CommandClient` to stream real-time throughput statistics directly from the Go network stack.

---

## [1.3.2] - 2026-08-22
- Multi-architecture Android build support (arm64-v8a).
- Initial Xray sidecar integration with hev-socks5-tunnel.
- Split-tunneling per-app routing support.
