<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire" width="128" />

# Cloakwire

**Privacy-first VPN client for Windows, macOS, Linux, and Android with two engines: sing-box and Xray.**

Tauri 2 + React + TypeScript.

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?include_prereleases&sort=semver&style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/markwhite7881-cpu/cloakwire?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/stargazers)

<br/>

<img src="dist-release/screenshots/hero-showcase.png" alt="Cloakwire Showcase" width="100%" />

</div>

> 🇷🇺 **Russian version:** [README.md](README.md)

---

### ⚡ Quick Download (Latest v1.4.0)

| Platform | Primary Installer | Alternative / Portable |
|---|---|---|
| 🪟 **Windows (x64)** | [⬇️ **Download .exe** (NSIS)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64-setup.exe) | [⬇️ **Download .msi**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64_en-US.msi) |
| 🍏 **macOS (Apple Silicon M1-M4)** | [⬇️ **Download .dmg** (aarch64)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_aarch64.dmg) | [⬇️ **Download .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_aarch64.app.zip) |
| 🍏 **macOS (Intel)** | [⬇️ **Download .dmg** (x64)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64.dmg) | [⬇️ **Download .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64.app.zip) |
| 🐧 **Linux (x64)** | [⬇️ **Download .deb** (Ubuntu / Debian)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_amd64.deb) | [⬇️ **Download .AppImage**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_amd64.AppImage) |
| 🤖 **Android** | [⬇️ **Download .apk** (arm64-v8a)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_arm64-v8a.apk) | — |

---

## 🎯 What is it

**Cloakwire** is a minimal cross-platform VPN client for Windows, macOS, Linux, and Android. It takes share-links and subscriptions, stores configurations locally, and runs the profile in a clean interface with no manual JSON editing.

**sing-box is the primary engine.** It's used on all platforms for TUN, System Proxy, per-app routing, proxy selection, and built-in delay checks.

**Xray is a capability fallback.** If a subscription contains a profile that's safer or more correct to run via Xray, Cloakwire prepares and launches it automatically. Home preserves the status, selected server, and live metrics.

### Supported Protocols

| Protocol | Transports & Features | Engine |
|---|---|---|
| **VLESS** | Reality, XTLS-Vision, WebSocket, gRPC, HTTPUpgrade, Splithttp | `sing-box` / `Xray` |
| **VMess** | TCP, WebSocket, gRPC, TLS | `sing-box` / `Xray` |
| **Trojan** | TLS, WebSocket, gRPC | `sing-box` / `Xray` |
| **Shadowsocks** | AEAD, 2022 (blake3, chacha20, aes-gcm) | `sing-box` / `Xray` |
| **Hysteria 2** | Port-hopping, salamander obfuscation, BBR | `sing-box` |
| **TUIC** | QUIC, 0-RTT, BBR congestion control | `sing-box` |
| **WireGuard / AWG** | Secure UDP tunnel | `sing-box` |

---

## ✨ Features

| | |
|---|---|
| 🚀 **Quick start** | Share-link or subscription → profile ready to connect |
| 🧩 **Two engines** | sing-box — primary on all platforms; Xray — automatic fallback for compatible profiles |
| 🎯 **Per-app routing** | "Telegram via VPN, bank direct" — in one interface |
| 🗂️ **Leak-free subscriptions** | Subscriptions are parsed in the backend; URLs and profile contents never reach the WebView |
| 🧭 **Clear Home** | Servers from the same subscription are grouped; provider names are used as fallback labels |
| 🔄 **Safe reconnect** | Switching servers or active settings triggers an automatic backend-mediated reconnect |
| 📈 **Live status** | Connection state, live traffic graphs, and active engine info |
| 🔐 **Signed auto-update** | Embedded `latest.json` manifest with minisign signatures for desktop auto-update |
| 🔓 **Open Source** | MIT, no analytics, no telemetry |

### Route traffic, not network settings

- **Apps via VPN.** Select a browser, a game, a messenger, or any other app — only their connections go through the VPN tunnel. The rest of your traffic continues directly.
- **Apps direct.** Route system traffic through the VPN and keep direct connections only for selected apps — e.g. banking clients or local network resources.

---

## 📥 Installation Details

All files are available on the **[Releases](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)** page.

### Windows x64

| File | Description |
|---|---|
| `Cloakwire_1.3.2_x64-setup.exe` | NSIS installer (recommended) |
| `Cloakwire_1.3.2_x64_en-US.msi` | MSI package for managed deployment |

> ℹ️ Windows installers are signed with Minisign for secure auto-updates. Because they lack a commercial Authenticode certificate, Windows SmartScreen may show a prompt on first install ("More info" → "Run anyway").

### macOS

| Architecture | Files |
|---|---|
| Apple Silicon (M1/M2/M3/M4) | `Cloakwire_1.3.2_aarch64.dmg` or `Cloakwire_1.3.2_aarch64.app.zip` |
| Intel (x86_64) | `Cloakwire_1.3.2_x64.dmg` or `Cloakwire_1.3.2_x64.app.zip` |

> ℹ️ v1.3.2 macOS builds are not signed with an Apple Developer ID and are not notarized. On first launch, right-click the app and choose **Open**, or allow it under *System Settings → Privacy & Security*.

### Linux x86_64 — Ubuntu / Debian

```bash
sudo apt install ./Cloakwire_1.3.2_amd64.deb
cloakwire
```

The package automatically grants `sing-box` the `cap_net_admin,cap_net_raw=+ep` capability required for TUN mode. A portable `Cloakwire_1.3.2_amd64.AppImage` is also available.

### Android

- `Cloakwire_1.3.2_arm64-v8a.apk` — signed release APK for 64-bit ARM devices.
- Supports both engines: **sing-box runs in-process**, **Xray runs as a protected `VpnService` sidecar**. Switch the engine under Settings.

### Verifying downloads

```powershell
Get-FileHash .\Cloakwire_1.3.2_x64-setup.exe -Algorithm SHA256
```

Cross-platform equivalent:

```bash
sha256sum -c SHA256SUMS.txt
```

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>🛡️ Are my subscriptions and keys safe?</b></summary>
<br>
Yes. All subscription parsing, private keys, and runtime configurations are handled strictly inside the isolated Rust/Kotlin backend core and are never exposed to the WebView interface. The application contains zero analytics, tracking, or third-party telemetry SDKs.
</details>

<details>
<summary><b>⚠️ Windows SmartScreen blocks installation. What should I do?</b></summary>
<br>
Cloakwire is an open-source project without an expensive purchased Microsoft Authenticode certificate. To proceed with the installation, click <i>"More info"</i> and then <i>"Run anyway"</i>. You can always verify the checksum of your downloaded binary against <code>SHA256SUMS.txt</code>.
</details>

<details>
<summary><b>🍏 How do I run the app on macOS?</b></summary>
<br>
On first launch, macOS Gatekeeper may flag unsigned applications. Right-click (or Control-click) the Cloakwire app in Finder and choose <b>"Open"</b>, then confirm the prompt. Alternatively, go to <i>System Settings → Privacy & Security</i> and click <i>"Open Anyway"</i>.
</details>

<details>
<summary><b>⚡ How does Cloakwire compare to Nekoray, v2rayN, and other clients?</b></summary>
<br>
Cloakwire focuses on clean usability and performance:
<ul>
  <li><b>Clean UI:</b> No cluttered menus or manual JSON editing.</li>
  <li><b>Dual-engine:</b> Automatic routing between sing-box and Xray depending on protocol compatibility.</li>
  <li><b>Lightweight & Fast:</b> Built on Tauri 2, consuming a fraction of the memory used by Electron-based clients.</li>
  <li><b>Native Per-App Routing:</b> Effortless per-application split tunneling.</li>
</ul>
</details>

---

## 🚀 First run

1. Launch **Cloakwire**. For TUN mode, accept the privilege elevation.
2. In **Servers**, paste a share-link (`vless://...&`) or a subscription URL, and click **Add**.
3. In **Routing**, add the apps that need the VPN to **Apps via VPN**, or leave **Apps direct** empty.
4. In **Config**, pick the mode — **TUN** (recommended), **System Proxy**, **Both**, or **None**.
5. On **Home**, select a server and press the connect button.

---

## 🖼️ Interface

### Home — connect screen
![Home tab](dist-release/screenshots/01-home.png)

### Servers — subscriptions and profiles
![Servers tab](dist-release/screenshots/02-servers.png)

### Config — mode and DNS
![Config tab](dist-release/screenshots/03-config.png)

### Routing — simple and advanced
![Routing tab — simple UX](dist-release/screenshots/04-routing.png)
![Routing tab — Advanced](dist-release/screenshots/05-routing-advanced.png)

---

## 🏗️ Architecture

```text
React + TypeScript + Tailwind     ← typed tauri::invoke
          │
src/
          │
Rust + Tauri 2                  ← subscriptions, routing, lifecycle, safe IPC
src-tauri/src/
          │
     ┌────┴────┐
  sing-box    Xray
  (primary)    (fallback)
          │
  TUN / proxy control · Android sidecar VPNService
```

---

## 🛠️ Stack

| Layer | Technology |
|---|---|
| Shell | **Tauri 2** (Rust + WebView) |
| UI | **React 18** + **TypeScript 5** |
| Styles | **Tailwind CSS 3** + design tokens |
| Primary VPN engine | [sing-box](https://github.com/SagerNet/sing-box) (sidecar) |
| Fallback engine | [Xray-core](https://github.com/XTLS/Xray-core) (sidecar) |
| Routing | sing-box rules / rule-sets + process routing |
| Auto-update | custom updater; minisign signatures inlined in `latest.json` |

---

## 🧑‍💻 Building from source

```powershell
# Requirements: Node 20+, Rust stable, Tauri-ready for desktop dev
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire
npm ci
npm run tauri:build
```

---

## 🤝 Contributing

Pull requests are welcome. Before submitting, run local checks:

- **Code style:** `cargo fmt` for Rust, Prettier for TS/TSX.
- **Checks:** `npm test`, plus a production build.
- **Commits:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

---

## 📜 License

[MIT](LICENSE) — do whatever you want with the code, no warranty.

---

## 🙏 Credits

- [SagerNet/sing-box](https://github.com/SagerNet/sing-box)
- [XTLS/Xray-core](https://github.com/XTLS/Xray-core)
- [Tauri](https://tauri.app)

---

<div align="center">

**[⬇ Download latest](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)** · **[🐛 Report a bug](https://github.com/markwhite7881-cpu/cloakwire/issues)** · **[⭐ Star the repo](https://github.com/markwhite7881-cpu/cloakwire)**

Made with care for people who value their privacy.

</div>
