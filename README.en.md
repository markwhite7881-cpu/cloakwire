<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire" width="128" />

# Cloakwire

**Privacy-first VPN client for Windows, macOS, Linux, and Android with two engines: sing-box and Xray.**

Tauri 2 + React + TypeScript.

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?include_prereleases&sort=semver&style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/markwhite7881-cpu/cloakwire?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/stargazers)

</div>

> 🇷🇺 **Russian version:** [README.md](README.md)

---

## 🎯 What is it

**Cloakwire** is a minimal VPN client for Windows, macOS, Linux, and Android. It takes share-links and subscriptions, stores configurations locally, and runs the profile in a clean interface with no manual JSON editing.

**sing-box is the primary engine.** It's used on all platforms for TUN, System Proxy, per-app routing, proxy selection, and built-in delay checks.

**Xray is a capability fallback.** If a subscription contains a profile that's safer or more correct to run via Xray, Cloakwire prepares and launches it automatically. Home preserves the status, selected server, and live metrics. Proxy-group management and built-in delay tests are only available with sing-box active — this is intentional, not an interface bug.

### What's new in 1.3.2

- **Desktop: stability and per-app routing** — fixed startup crash across desktop platforms and enabled `find_process: true` for socket matching in Windows, Linux, and macOS.
- **Android: dual-engine.** Xray is no longer the only option. Both engines run on Android: sing-box runs in-process, Xray runs as a protected `VpnService` sidecar with bundled `libxray.so` and `libhev-socks5-tunnel.so`. The engine choice in Settings is wired end-to-end through `CloakwirePlatform.kt`.
- **Android: Quick Settings tile.** Instead of a generic power icon, the tile now uses the actual app-icon glyph (white-on-transparent, density-specific, scaled to 96% of the canvas with a hard alpha threshold). ColorOS / OnePlus monochrome theming no longer paints a white blob.
- **Android: last-server persistence.** Your selected profile (tag or bundle child) is saved to `localStorage` on every successful connect and restored on cold start. Auto-connect is gated on restore to prevent accidentally falling back to `profiles[0]`.
- **Accurate server selection:** share-link connect routes Xray traffic through the specific outbound selected by the user.
- **Custom signed update manifest.** `latest.json` is now part of every release: `src-tauri/src/app_update.rs` fetches it from GitHub, validates the GitHub origin and all redirects, and verifies a **minisign** signature over downloaded binaries against the public key (`src-tauri/.tauri-updater.key.pub`).
- **macOS and Linux release pipeline.** Native builds for Apple Silicon (`aarch64`) and Intel (`x86_64`), plus reproducible CI workflows (`release-linux.yml`).

### Route traffic, not network settings

**Apps via VPN.** Select a browser, a game, a messenger, or any other app — only their connections go through the VPN tunnel. The rest of your traffic continues directly.

**Apps direct.** Or the opposite: route system traffic through the VPN and keep direct connections only for selected apps — e.g. banking clients, corporate services, or programs on your local network.

---

## ✨ Features

| | |
|---|---|
| 🚀 **Quick start** | Share-link or subscription → profile ready to connect |
| 🧩 **Two engines** | sing-box — primary on all platforms; Xray — automatic fallback for compatible profiles |
| 🎯 **Per-app routing** | "Telegram via VPN, bank direct" — in one interface |
| 🗂️ **Leak-free subscriptions** | Subscriptions are parsed in the backend; URLs and profile contents never reach the WebView |
| 🧭 **Clear Home** | Servers from the same subscription are grouped; provider names are used as fallback labels |
| 🔄 **Safe reconnect** | Switching servers or active Config/Routing triggers an automatic backend-mediated reconnect |
| 📈 **Live status** | Connection state, traffic, and active engine info |
| 🔐 **Signed auto-update** | `latest.json` with minisign signatures for desktop auto-update |
| 🔓 **Open Source** | MIT, no analytics, no telemetry |

Supported link protocols include VLESS, VMess, Trojan, Shadowsocks, Hysteria2, and TUIC. Real compatibility for a specific profile depends on its parameters and the chosen engine.

---

## 📥 Installation

Download files from **[Releases → Latest](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)**. Below is the contents of the current `v1.3.2` release.

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

> ℹ️ v1.3.2 macOS builds are not signed with an Apple Developer ID and are not notarized. On first launch, right-click the app and choose **Open**, or allow it under *System Settings → Privacy & Security*. `.app.zip` archives are also provided for diagnostics.

### Linux x86_64 — Ubuntu / Debian

Install the package:

```bash
sudo apt install ./Cloakwire_1.3.2_amd64.deb
cloakwire
```

The package installs `/usr/bin/cloakwire`, `sing-box`, and Xray. Its `postinst` automatically grants `sing-box` the `cap_net_admin,cap_net_raw=+ep` capability required for TUN mode:

```bash
getcap /usr/bin/sing-box
# expected: /usr/bin/sing-box cap_net_admin,cap_net_raw=ep
```

If the capability was reset by an update or by manual permission changes, restore it:

```bash
sudo setcap cap_net_admin,cap_net_raw=+ep /usr/bin/sing-box
```

A portable build is also available as `Cloakwire_1.3.2_amd64.AppImage`. The AppImage cannot persist file capabilities (its SquashFS is read-only), so use the DEB for reliable TUN support.

Linux builds target Ubuntu 22.04+ and Debian 12+ desktop. TUN is recommended: it intercepts traffic at the network layer and does not depend on per-app proxy support.

### Android

- `Cloakwire_1.3.2_arm64-v8a.apk` — signed release APK for 64-bit ARM devices.
- `Cloakwire_1.3.2_arm64-v8a.apk.idsig` — APK Signature Scheme v3 ID (used by Play Store for incremental install).
- `Cloakwire_1.3.2_arm64-v8a.apk.verify.txt` — signing certificate chain and SHA-256 for manual verification.

Android supports both engines. **sing-box runs in process**, **Xray runs as a protected `VpnService` sidecar**. Switch the engine under Settings.

### Verifying downloads

Cross-check the SHA-256 against the sums in `SHA256SUMS.txt`. Example:

```powershell
Get-FileHash .\Cloakwire_1.3.2_x64-setup.exe -Algorithm SHA256
```

Cross-platform equivalent:

```bash
sha256sum -c SHA256SUMS.txt
```

A hash mismatch means the file is corrupted or has been replaced — re-download.

---

## 🚀 First run

1. Launch **Cloakwire**. For TUN mode, accept the privilege elevation.
2. In **Servers**, paste a share-link (`vless://...&`) or a subscription URL, and click **Add**.
3. In **Routing**, add the apps that need the VPN to **Apps via VPN**, or leave **Apps direct** empty.
4. In **Config**, pick the mode — **TUN** (recommended), **System Proxy**, **Both**, or **None**. The DNS-server fields stay blank if you want to use your provider's DNS.
5. On **Home**, select a server and press the connect button.

If the VPN drops while you're changing the server or tweaking active Config/Routing settings, Cloakwire auto-reconnects. To avoid double-clicks and unstable restarts, all reconnects go through a backend queue with debounce.

---

## 🖼️ Interface

### Home — connect screen

Shows the selected profile, live Download/Upload, and the reconnect button. The backend auto-resets Home to "not connected" only when you change the server or Config/Routing.

![Home tab](dist-release/screenshots/01-home.png)

### Servers — subscriptions and profiles

Add share-links and subscriptions in URL, base64, or Clash YAML. The format is auto-detected; custom profile parsing stays in the backend.

![Servers tab](dist-release/screenshots/02-servers.png)

### Config — mode and DNS

Four modes: **TUN**, **System Proxy**, **Both**, **None**. The DNS-server fields stay blank if you want your provider's DNS.

![Config tab](dist-release/screenshots/03-config.png)

### Routing — simple and advanced

In Simple mode — **Apps via VPN** and **Apps direct**. In Advanced you get custom rules, rule-sets, sniffing, auto-detect interface, and final outbound.

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

`sing-box` is the primary engine on all platforms and runs the typical supported profiles. On Android it runs in-process; on desktop it runs as a sidecar.

`Xray` is the capability fallback. Cloakwire automatically prepares and launches it when a subscription contains a profile that is safer or more correct to run through Xray.

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
| Auto-update | custom updater; minisign signatures inlined in `latest.json` shipped with every release |
| Runtime updates | managed update in CI for sing-box; Xray update is intentionally not included because profiles are version-sensitive |

---

## 🔐 Security and data boundaries

- Subscription URLs, share-links, UUIDs, and runtime configs stay in the backend; the WebView never sees them.
- `Xray` runtime commands and its stdout/stderr are logged only on the backend side.
- When Xray is active it is not used by sing-box's Clash API for routing or delay tests.
- No analytics, no telemetry, no third-party SDKs.
- Updates and downloaded cores are checked against pinned SHA-256; for new releases, cross-check with `SHA256SUMS.txt`.

---

## 🧑‍💻 Building from source

```powershell
# Requirements: Node 20+, Rust stable, Tauri-ready for desktop dev
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire
npm ci
npm run tauri:build
```

For a Linux `.deb` on Ubuntu 22.04+ / Debian 12+ (or WSL2) with AOT compilation:

```bash
./scripts/build-linux-deb.sh 1.3.2
```

The `postinst` in the resulting `.deb` automatically assigns the `sing-box` capability (`cap_net_admin,cap_net_raw=+ep`) — without it, Linux TUN mode won't work.

---

## 🤝 Contributing

Pull requests are welcome. Before submitting, run local checks:

- **Code style:** `cargo fmt` for Rust, Prettier for TS/TSX.
- **Checks:** `npm test`, plus a production build; smoke-test on desktop before opening the PR.
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
