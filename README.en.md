<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire" width="128" />

# Cloakwire

**A cross-platform, dual-engine VPN client powered by sing-box and Xray.**

Windows · Linux · macOS · Android — Tauri 2, Rust, React, and a native Android VPNService.

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/markwhite7881-cpu/cloakwire?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/stargazers)

[Русский](README.md) · [Download](https://github.com/markwhite7881-cpu/cloakwire/releases/latest) · [Report a bug](https://github.com/markwhite7881-cpu/cloakwire/issues)

</div>

---

## What is Cloakwire?

Cloakwire turns a subscription or share link into a ready-to-use VPN connection without manual JSON editing. It can run both **sing-box** and **Xray**, displays the active core and its version, remembers the selected server, and exports privacy-safe diagnostics without exposing subscription credentials.

### Highlights

- **Two engines:** sing-box and Xray on desktop and Android.
- **Broad subscription support:** VLESS, VMess, Trojan, Shadowsocks, Hysteria2, and TUIC; plain text, Base64, Clash/Mihomo YAML, and compatible JSON configurations.
- **Per-app routing:** send selected apps through the VPN or directly; desktop process selection and Android package routing.
- **TUN and System Proxy:** system-wide tunnel, local SOCKS/HTTP proxy, or a combined mode where supported.
- **Managed subscriptions:** provider titles, scheduled refresh, HWID controls, safe profile switching, and last-server restoration.
- **Useful diagnostics:** latency, traffic, connection uptime, core versions, sanitized logs, and exportable diagnostics.
- **No telemetry:** settings and credentials stay local, and sensitive runtime data is kept out of frontend logs.

## What's new in 1.3.2

- Restored **full sing-box support on Android** alongside Xray. The JS layer
  engine choice is now wired end-to-end through the Kotlin `VpnService`,
  with a new `CloakwirePlatform.kt` abstraction and a dedicated
  `XrayAppRoutingPolicy`.
- **Android Quick Settings tile upgrade:** the tile now uses the actual
  app-icon glyph (white-on-transparent, density-specific PNGs, scaled to
  96 % of the canvas, with a hard alpha threshold so ColorOS / OnePlus
  monochrome theming no longer paints a white blob).
- **Android last-server persistence:** the selected profile (or bundle
  child) is saved to `localStorage` on every successful connect and
  restored on cold start, with a 5 s give-up for subscription hydration.
  Auto-connect is gated on restore so it never fires with the default
  `profiles[0]`.
- **Picked-row actually picks:** the share-link path no longer sends
  the built profile order to Rust — `useVpnConnection` is now fed a
  selected-first copy of the list, so xray exits through the outbound
  the user actually selected.
- **Custom signed update manifest:** the desktop app uses a backend-
  authoritative updater (`src-tauri/src/app_update.rs`) that fetches
  `latest.json` from the release, validates its GitHub origin and every
  redirect, and verifies a **minisign** signature over the downloaded
  bytes against a public key baked into the binary. The public key
  matches `src-tauri/.tauri-updater.key.pub`.
- **Linux release pipeline:** new `.github/workflows/release-linux.yml`
  plus `scripts/build-linux-local.sh`, `scripts/build-macos-local.sh`,
  `prepare-xray-sidecar.py`, and `xray-core-assets.json` so the AppImage
  / deb and macOS bundles can be produced reproducibly from CI.
- **Desktop `xray.rs` / `singbox.rs` / `process.rs` cleanup:** smaller
  surface, same behavior, fits the new sidecar manifest.
- **Desktop subscription layer:** new `subscriptions/classify.rs`,
  `subscriptions/hwid.rs`, `SubscriptionIdentityCard.tsx`, and
  `diagnostics.ts`. Existing share-link / sing-box / xray paths are
  preserved.
- Hardened sidecar, archive, checksum, log-redaction, and backend / UI
  trust boundaries.

---

## Installation

Download builds only from [GitHub Releases](https://github.com/markwhite7881-cpu/cloakwire/releases/latest). Each release includes `SHA256SUMS.txt` and a signed `latest.json` for desktop auto-update.

### Windows x64

> _Not shipped in v1.3.2. A v1.3.1 NSIS installer is the most recent
> Windows build. The next release will restore the Windows artifact;
> you can track progress on the
> [milestone](https://github.com/markwhite7881-cpu/cloakwire/milestones)._

Windows SmartScreen may warn about an unknown publisher. The Cloakwire
updater signatures do not replace a commercial Authenticode signature.

### Linux x86_64

- `Cloakwire_1.3.2_amd64.deb` — recommended for Debian / Ubuntu and TUN.
- `Cloakwire_1.3.2_amd64.AppImage` — portable build.

```bash
sudo apt install ./Cloakwire_1.3.2_amd64.deb
cloakwire
```

The DEB post-install script grants sing-box the `cap_net_admin` and
`cap_net_raw` capabilities required for TUN. AppImage uses a read-only
SquashFS, so use the DEB for reliable TUN operation.

### macOS

- `Cloakwire_1.3.2_aarch64.dmg` — Apple Silicon.
- `Cloakwire_1.3.2_x64.dmg` — Intel.
- `Cloakwire_1.3.2_aarch64.app.zip` / `Cloakwire_1.3.2_x64.app.zip` — `.app`
  bundles for diagnostics.

The 1.3.2 macOS builds are currently **not signed with an Apple
Developer ID and are not notarized**. On first launch, right-click the
app and choose **Open**, or allow it under Privacy & Security.

### Android

- `Cloakwire_1.3.2_arm64-v8a.apk` — signed release APK for 64-bit ARM
  devices.
- `.idsig` — APK Signature Scheme v3 ID (used for Play Store incremental
  install).
- `.verify.txt` — signing certificate chain and SHA-256 for manual
  verification.

Android supports both engines. **sing-box runs in process**, while
**Xray runs as a protected VPNService sidecar**.

---

## Quick start

1. Open **Servers** and add a subscription URL or share link.
2. Select a server and choose **sing-box** or **Xray**.
3. Configure **Apps via VPN** and **Apps direct** if needed.
4. Select **TUN** for a system-wide tunnel.
5. Press the connect button on Home.

## Security and release verification

```bash
sha256sum -c SHA256SUMS.txt
```

For desktop auto-update the Rust backend
(`src-tauri/src/app_update.rs`) fetches `latest.json` from
`https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/latest.json`,
verifies it against the embedded minisign public key, downloads the
installer for the current platform, and verifies its signature before
running it. The same private key signs all three desktop installers
(`linux-x86_64`, `darwin-aarch64`, `darwin-x86_64`) and lives at
`C:\Users\Алексей\.minimax-agent\projects\singbox-client\src-tauri\.tauri-updater.key`
(back it up — losing it bricks future updates).

Android APKs are signed with the Android release certificate
(`SHA-256 07c14843f191d7f85df335709e0859887bc790f9b0074b98481246638dee2ca1`)
which is separate from the minisign updater signature.

- subscription URLs, UUIDs, and tokens remain behind the backend boundary;
- runtime configurations and logs are sanitized before presentation;
- downloaded cores are checked against pinned SHA-256 values;
- archive extraction rejects path traversal;
- there are no analytics or advertising SDKs.

## Development

```bash
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Platform release scripts live in `scripts/`; CI workflows live in `.github/workflows/`.

### Architecture

```text
React + TypeScript UI
          │ Tauri IPC
Rust backend + subscription/config domain
          │
     ┌────┴────┐
  sing-box    Xray
          │
  TUN / proxy / Android VPNService
```

## Contributing

Issues and pull requests are welcome. Before submitting changes, run the
frontend tests, `cargo fmt --check`, and Rust unit tests. For larger
changes, open an issue describing the behavior and target platforms first.

## License

[MIT](LICENSE).

## Credits

- [sing-box](https://github.com/SagerNet/sing-box) and [sing-box-lx](https://github.com/Leadaxe/sing-box-lx)
- [Xray-core](https://github.com/XTLS/Xray-core)
- [Tauri](https://tauri.app/)
- the Rust, React, and Android open-source communities

<div align="center">

**Privacy without manual configuration. Two engines, one focused client.**

</div>
