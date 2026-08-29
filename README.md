<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire Logo" width="112" />

# Cloakwire

**Next-generation, privacy-first VPN client with dual sing-box + Xray engines and a hyper-responsive Linear Bento UI.**

Cross-platform · Lightweight Rust/Tauri Core · VLESS Reality / Hysteria 2 / TUIC · 0 Logs · 100% Open Source

<br/>

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?style=for-the-badge&color=10b981)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge&color=3b82f6)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-blueviolet?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge&color=64748b)](LICENSE)

<br/>

**[ 🇷🇺 Читать на русском (Russian README) ](README.ru.md)**

<br/>

<img src="screenshots/hero-showcase.png" alt="Cloakwire Linear Bento Showcase" width="100%" />

</div>

---

## ⚡ Direct Downloads (v1.4.0)

| Platform | Recommended Installer | Alternative Package | Architecture |
|---|---|---|---|
| 🪟 **Windows** | [⬇️ **Download .exe** (NSIS)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64-setup.exe) | [⬇️ **Download .msi**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64_en-US.msi) | x64 (Intel / AMD) |
| 🍏 **macOS Apple Silicon** | [⬇️ **Download .dmg**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_aarch64.dmg) | [⬇️ **Download .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_aarch64.app.zip) | M1 / M2 / M3 / M4 |
| 🍏 **macOS Intel** | [⬇️ **Download .dmg**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64.dmg) | [⬇️ **Download .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64.app.zip) | x86_64 |
| 🐧 **Linux** | [⬇️ **Download .deb** (Ubuntu / Debian)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_amd64.deb) | [⬇️ **Download .AppImage** (Portable)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_amd64.AppImage) | x86_64 |
| 🤖 **Android** | [⬇️ **Download .apk**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_arm64-v8a.apk) | — | arm64-v8a |

> 🔒 Every binary is cryptographically signed with **Minisign** (`.sig`) and verified with SHA-256 checksums in [`SHA256SUMS.txt`](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/SHA256SUMS.txt).

---

## 🚀 Quick Start in 3 Steps

```
 1. Download & Install        2. Paste Node / Subscription Link       3. Click Power to Connect
┌────────────────────────┐   ┌───────────────────────────────────┐   ┌────────────────────────┐
│  Get the installer for │──▶│  Import vless://, ss://, hy2://   │──▶│  Enjoy unblocked, fast │
│  Windows, Mac or phone │   │  or any Base64/Clash sub URL      │   │  and private internet  │
└────────────────────────┘   └───────────────────────────────────┘   └────────────────────────┘
```

1. **Install Cloakwire** from the download table above.
2. Click **Add Server** or paste your subscription link (`vless://`, `vmess://`, `ss://`, `trojan://`, `hy2://`, `tuic://`, `wireguard://`, or Base64 / Clash subscription URLs).
3. Tap the central **Power Orb** to connect. Your traffic is encrypted, low-latency, and censorship-resistant.

---

## 🛡️ Trust, Privacy & Security

### Why do Windows or macOS show an "Unverified Developer" warning on first launch?
Cloakwire is **100% free and open source**. Commercial proprietary certificates cost hundreds of dollars annually (Microsoft EV Cert: $400+/yr, Apple Developer: $99/yr).
- **Windows SmartScreen**: Click **"More info"** → **"Run anyway"**.
- **macOS Gatekeeper**: Right-click `Cloakwire.app` → select **"Open"** (or allow under *System Settings → Privacy & Security*).
- **Verify Integrity**: You can verify any downloaded file using our public Minisign key or check SHA-256 hashes against `SHA256SUMS.txt`. All builds are 100% reproducible from source.

```powershell
# Verify Windows installer checksum:
(Get-FileHash Cloakwire_1.4.0_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
```

### Privacy Guarantee
- **No Logs, No Telemetry**: We collect zero analytics, zero crash dumps, and zero IP data.
- **Secure Dual-DNS**: System DNS is routed through encrypted DoH (`dns.google`) over the proxy tunnel, completely preventing ISP DNS poisoning and eavesdropping.
- **Sandboxed Subscription Parsing**: Subscription links and tokens are parsed in the native Rust backend and never leaked to the web view.

---

## ⚔️ Why Cloakwire? (Comparison)

| Feature | Cloakwire | v2rayN | Clash Verge / Mihomo | Hiddify |
|---|---|---|---|---|
| **User Interface** | **Linear Bento Dark UI (Clean & Fast)** | Legacy WinForms (2000s era) | Technical YAML-centric | Flutter (heavy animation) |
| **Resource Usage** | **⚡ Ultralight Rust/Tauri (<35 MB RAM)** | 🐢 .NET runtime (~120 MB RAM) | Electron (~150 MB RAM) | Flutter Runtime (~100 MB RAM) |
| **Dual Engine** | **✅ sing-box + Xray (Auto-Fallback)** | ⚠️ Manual switching | ❌ Clash/Mihomo only | ⚠️ sing-box only |
| **Live Traffic Wave** | **✅ 60 FPS Canvas Waveform** | ❌ Text counters only | ⚠️ Basic SVG chart | ⚠️ Basic graph |
| **Smart Split Routing** | **✅ 1-Click "Apps via VPN" / "Apps Direct"** | ⚠️ Complex regex routing | ⚠️ Complex YAML rules | ⚠️ Basic per-app |
| **Modern Protocols** | **✅ VLESS Reality, Vision, Hysteria 2, TUIC** | ✅ Full protocols | ⚠️ Protocol variations | ✅ Full protocols |
| **Platforms** | **Windows, macOS, Linux, Android** | Windows only | Windows, macOS, Linux | Cross-platform |

---

## 🌟 Key Features

### 🎨 Linear Bento UI Design
A sleek dark aesthetic inspired by modern engineering tools: high-contrast zinc palette, subtle emerald glow indicators, real-time KB/s speed counters, and an interactive 60 FPS live traffic wave canvas.

### 🧩 Intelligent Dual-Engine Architecture
- **sing-box (Default Core)**: Blazing fast packet processing, TUN mode, per-app routing, and native URL-test auto-migration.
- **Xray Core (Automatic Fallback)**: Automatically selected for advanced proxy bundles requiring Xray-specific extensions without breaking user experience.

### 🎯 Smart App Routing (Split Tunneling)
- **Apps via VPN**: Route only chosen apps (e.g. Telegram, Discord, Browser) through the encrypted tunnel while leaving everything else on fast local internet.
- **Apps Direct**: Send all traffic through VPN except sensitive local apps like online banking or government services.

### 🌐 Auto Country Detection & Latency Probing
- Automatically extracts ISO country flags (e.g. 🇳🇱 Netherlands, 🇩🇪 Germany, 🇪🇪 Estonia) from server tags.
- Probes all nodes in parallel to display accurate round-trip ping (ms) and signal strength.

---

## 📱 Screenshots

<div align="center">
  <img src="screenshots/01-home.png" alt="Home Screen" width="48%" />
  <img src="screenshots/02-servers.png" alt="Servers List" width="48%" />
</div>
<div align="center">
  <img src="screenshots/04-routing.png" alt="Split Routing" width="48%" />
  <img src="screenshots/03-config.png" alt="Advanced Config" width="48%" />
</div>

---

<details>
<summary><b>🔧 Technical Architecture & Protocols (Click to expand)</b></summary>

<br/>

### Supported Protocols

| Protocol | Transports & Features | Core Engine |
|---|---|---|
| **VLESS** | Reality, XTLS-Vision, WebSocket, gRPC, HTTPUpgrade, Splithttp | `sing-box` / `Xray` |
| **VMess** | TCP, WebSocket, gRPC, TLS | `sing-box` / `Xray` |
| **Trojan** | TLS, WebSocket, gRPC | `sing-box` / `Xray` |
| **Shadowsocks** | AEAD, 2022 (blake3, chacha20, aes-gcm) | `sing-box` / `Xray` |
| **Hysteria 2** | Port-hopping, Salamander obfuscation, BBR | `sing-box` |
| **TUIC** | QUIC, 0-RTT handshake, BBR congestion control | `sing-box` |
| **WireGuard / AWG** | Encrypted UDP tunnel | `sing-box` |

### Building from Source

**Prerequisites**:
- Node.js 20+ & npm
- Rust 1.80+ (`cargo`)
- Platform build dependencies:
  - **Windows**: Visual Studio 2022 C++ Build Tools, WiX Toolset v3, NSIS
  - **macOS**: Xcode Command Line Tools
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `libayatana-appindicator3-dev`

```bash
# Clone the repository
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire

# Install web dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build production installer
npm run tauri:build
```

</details>

---

## 📄 License

Cloakwire is distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.
All bundled core engines (`sing-box`, `Xray-core`) belong to their respective copyright holders under GPL / MPL open-source licenses.