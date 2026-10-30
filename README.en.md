<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire Logo" width="112" />

# Cloakwire

**Cross-platform desktop & mobile VPN client powered by sing-box and Xray cores.**

Windows · macOS · Android · Rust/Tauri & React · VLESS Reality · Hysteria 2 · TUIC · 0 Telemetry · Open Source

<br/>

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?style=for-the-badge&color=10b981)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge&color=3b82f6)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Android-blueviolet?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge&color=64748b)](LICENSE)

<br/>

**[ 🇬🇧 English ](README.md)** &nbsp;|&nbsp; **[ 🇷🇺 Русский ](README.ru.md)** &nbsp;|&nbsp; **[ 🇨🇳 简体中文 ](README.zh-CN.md)**

<br/>

<img src="screenshots/hero-showcase.png" alt="Cloakwire Interface Showcase" width="100%" />

</div>

---

## ⚡ Downloads (v1.4.9)

| Platform | Installer | Alternative | Architecture |
|---|---|---|---|
| **Windows** | [Download .exe](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64-setup.exe) | [Download .msi](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64_en-US.msi) | x64 (Intel / AMD) |
| **macOS Apple Silicon** | [Download .dmg](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_aarch64.dmg) | [Download .app.zip](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_aarch64.app.zip) | arm64 (Apple Silicon) |
| **macOS Intel** | [Download .dmg](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64.dmg) | [Download .app.zip](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64.app.zip) | x86_64 |
| **Android** | [Download .apk](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_arm64-v8a.apk) | — | arm64-v8a · Android 7.0+ |

> 🔒 All seven release packages, including Android, have **Minisign** `.sig` files. SHA-256 checksums are published in [`SHA256SUMS.txt`](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/SHA256SUMS.txt).

## 🚀 What's new in 1.4.9

- Ready-made subscription profiles are checked by their engine before connecting on Windows, macOS and Android.
- Profile errors show a clear reason, a suggested next step and a safe report that can be copied without provider configuration.
- A rejected profile keeps the active connection intact; cancelling a check does not start the VPN.
- Release checks cover all packages, updater signatures, checksums and required Android GeoIP assets.
- The desktop and Android interfaces and diagnostic reports use the synchronized application version.

[Full history](CHANGELOG.md) · [v1.4.9](https://github.com/markwhite7881-cpu/cloakwire/releases/tag/v1.4.9)

## Quick start

Cloakwire is a client. You need your own server or a subscription from a provider.

1. Download and install the package for your operating system from the table above.
2. Add a server or subscription. Share links, Base64 link lists, Clash subscriptions and ready-made sing-box/Xray profiles are supported.
3. Select a server or profile and connect. A ready-made profile is validated before an active connection is replaced; if validation fails, follow the error card's instructions.

## 🌟 Key features

### Dual engines and subscriptions

- **sing-box** is the default engine; **Xray** handles compatible Xray profiles.
- Ready-made configurations use their declared engine. Validation errors are shown before connection.
- Import individual links, manage subscriptions and refresh provider profiles.

### Routing and connection modes

- TUN and desktop system proxy modes; application and domain/IP rules, including GeoIP / Bypass RU.
- Ready-made sing-box profiles retain provider DNS and routing settings when local GeoIP / Bypass RU rules are applied.
- Route selected applications through VPN or directly. Availability depends on platform and engine; unsupported Xray application rules produce a warning.
- On macOS, TUN requests administrator approval when needed. Prepared binaries can reuse granted permissions; replacing a binary may require approval again.

### Desktop and Android

- Desktop system tray, quick connection controls, session timer and traffic statistics.
- Android VPN service, home screen widgets with connection status, and clipboard import.
- Built-in speed test and desktop connection notifications.

### Appearance and languages

- System, Light, Dark and OLED themes; Emerald, Cyan, Violet, Amber and Rose accents.
- English, Russian and Simplified Chinese; switch languages in Settings.

## 🛡️ Privacy and release verification

- No built-in telemetry, analytics or automatic crash-report uploads.
- Profiles, subscriptions and credentials are processed and stored in the local application data directory.
- DNS behavior depends on the selected settings and provider profile. Ready-made profiles preserve provider DNS configuration.
- The updater checks release signatures using the public key embedded in the application.

Minisign protects updater downloads. Windows packages are distributed without Authenticode signing; macOS apps use ad hoc signing and are not Apple-notarized. Operating-system security prompts may therefore appear. Verify the download against the published checksums before installing.

Example: check the Windows installer and compare the result with `SHA256SUMS.txt`:

```powershell
(Get-FileHash Cloakwire_1.4.9_x64-setup.exe -Algorithm SHA256).Hash.ToLowerInvariant()
```

## 🔧 Share-link formats

| Protocol | Link schemes | Compatible engine |
|---|---|---|
| VLESS | `vless://` | sing-box / Xray |
| VMess | `vmess://` | sing-box / Xray |
| Trojan | `trojan://` | sing-box / Xray |
| Shadowsocks | `ss://` | sing-box / Xray |
| Hysteria 2 | `hy2://` / `hysteria2://` | sing-box |
| TUIC | `tuic://` | sing-box |

Transport and routing support depends on the engine and profile. Ready-made profiles are checked in the engine's native format before connection.

## 🛠️ Building from source

### Toolchains

- Node.js and npm; the 1.4.9 release was built with Node.js 24 on Windows and 22 on macOS.
- Rust stable with the target for the platform being built.
- Windows: Visual Studio C++ Build Tools and the WebView2 runtime; Tauri packages releases with NSIS/WiX.
- macOS: Xcode Command Line Tools; install both `aarch64-apple-darwin` and `x86_64-apple-darwin` Rust targets to build both architectures.
- Android: JDK 17, Android SDK platform 36 and build-tools, NDK `28.0.13004108`, and Rust target `aarch64-linux-android`. Use the checked-in Gradle wrapper.

### Binary inputs

A clean clone does not include the large engine binaries, Android libraries or geodata. Stage these before building the native app:

- `src-tauri/binaries/`: target-specific `sing-box` and `xray` executables; the current bundle configuration also requires `wintun.dll`.
- Android: `app/libs/libbox.aar` and `app/src/main/jniLibs/arm64-v8a/libxray.so`, `libhev-socks5-tunnel.so` under `src-tauri/gen/android/`.
- Android: `geoip.dat` and `geosite.dat` in `src-tauri/gen/android/app/src/main/assets/`. The Rust library is compiled from source by the release driver.

For engine preparation, see the [Xray helper](scripts/prepare-xray-sidecar.ps1), [Android build workflow](.github/workflows/release-android.yml) and [macOS build workflow](.github/workflows/release-macos.yml).

The checked-in `src-tauri/.cargo/config.toml` contains host-specific Windows paths. Adjust or override them for your machine; the cross-platform release driver configures the paths from a local settings file and removes this Windows-specific configuration on the Mac build host.

### Frontend checks

These commands check and build the interface without compiling the native application:

```bash
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire
npm ci
npm test
npm run build
```

With the toolchains and native inputs prepared, use `npm run tauri:dev` for desktop development and `npm run tauri:build` for a desktop release package.

### Full cross-platform release

The complete release driver runs on Windows and builds macOS remotely over SSH. Copy `scripts/release.local.example.psd1` to the ignored `release.local.psd1` and set your toolchain, engine, signing and Mac-host paths. Use an ASCII-only `BuildRoot`; keep private keys and passwords out of Git.

The canonical version is in `src-tauri/tauri.conf.json`. Use `npm run release:version -- set <version>` to synchronize package, Rust and Android metadata before committing a new release.

Build the standalone signing tool, then set `SignerPath` to `.release-work/tools/release/tauri-signer.exe`:

```powershell
cargo build --release --manifest-path src-tauri/crates/tauri-signer/Cargo.toml --target-dir .release-work/tools
```

```powershell
Copy-Item scripts/release.local.example.psd1 release.local.psd1
# Set local paths in release.local.psd1 before continuing.
npm run release:check
npm run release:test
npm run release:build -- -CheckOnly
npm run release:build
```

Commit the reviewed source and release notes before `release:build`: all platforms are built from one clean HEAD archive. Every run gets separate source, target, artifact and log directories. The seven packages are signed and validated; publication first creates a draft and checks all 18 uploaded asset digests. `npm run release:publish -- -DistPath <artifacts> -Publish` explicitly promotes the verified draft after the matching Git tag has been pushed.

[Detailed release guide (Russian)](docs/RELEASE_WORKFLOW.md)

## 📄 License

Cloakwire application source is distributed under the **MIT License**; see [LICENSE](LICENSE). Bundled engines and third-party libraries retain their respective licenses.
