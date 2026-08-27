# Android v1.3.1 Xray Sidecar Design

- **Date:** 2026-08-20
- **Branch:** `android/v1.3.1-port`
- **Scope:** add XTLS/Xray as a parallel engine alongside sing-box on Android, using the same process model as the desktop sidecar

## Goal

Add Xray as a parallel VPN engine on Android so the user can pick `sing-box` or `xray` per session, with full TUN handoff, sanitized logs, and gRPC stats parity with the desktop.

This replaces the abandoned in-JVM `libXray.aar` approach (which was blocked by gomobile runtime class collisions with `libbox.aar`). The new design runs Xray as a separate Android process, eliminating the conflict entirely. `libXray.aar` will be removed.

## Non-goals

- No modifications to `XTLS/libXray` upstream.
- No shared-runtime AAR, no `AndroidVpnEngine` general interface in this iteration.
- No Xray-specific subscription formats in v1; reuse the existing sanitized sing-box bridge.
- No device-runtime proof of unsupported scenarios (Xray over IPv6-only networks, captive portals, etc.).
- No new Android permissions, no manifest changes other than the `xray` binary in `jniLibs`.
- No changes to `CloakwirePlatform`, `VpnEvents`, generated bridge, or backend Rust code.

## Architectural principles

1. **Xray runs as a separate Android process.** It is shipped as a `jniLibs/arm64-v8a/xray` ELF binary and executed via `ProcessBuilder`. It never runs in the JVM. This is the same model the desktop uses (`xray-x86_64-pc-windows-msvc.exe` spawned by Tauri command).
2. **CloakwireVpnService remains the Android lifecycle owner.** It owns the VPN, foreground notification, TUN descriptor, `VpnEvents` transitions, worker threads, and the choice of engine.
3. **Two engines, no shared interface yet.** `SingBoxEngine` and a new `XrayEngine` are sibling Kotlin classes. The service performs an explicit `if`/`else` dispatch. A common interface is YAGNI for two engines.
4. **TUN handoff uses the documented `env.xray.tun.fd` channel.** No new bindings, no `SetTunFd`-style API. This matches our existing pinning doc.
5. **Logs and config stay app-private.** Xray's raw log output is sanitized through a redactor before reaching `VpnEvents` or the WebView. The xray config is written to `filesDir/xray-config.json` and deleted on stop.
6. **gRPC stats are first-class.** v1 ships with `xray.app.stats.command.StatsService` parity.

## Components

### 1. Xray binary

- **Upstream `Xray-core` v26.7.28 does not ship an Android ARM64 CLI binary.** Verified 2026-08-20:
  - `Xray-android-arm64-v8a.zip` (SHA-256 `a442892c175fa648fc56866ec872aac441c5a6b8946a1b60f0258ae16a7fb402`, 19.4 MB) — contains only `libXray.aar` and `libXray-sources.jar` (the gomobile JNI binding for in-JVM use).
  - `Xray-android-amd64.zip` (SHA-256 `5b05c41dc0ae5edb14c234dff6e440dd081d6f5a1105c9c9892debcc5e0f8066`, 20.6 MB) — contains a CLI `xray` (41 MB ELF), `geoip.dat`, `geosite.dat`. This is the x86_64 Android CLI, not ARM64.
- **Source of the ARM64 CLI binary for the sidecar.** Three viable paths; this spec records the chosen one once approved. The candidate paths are:
  1. **Build from source using our Go toolchain.** Verified working on 2026-08-20 with Go 1.26.5 + Windows host. The build command is:

     ```powershell
     git clone --depth 1 --branch v26.7.28 https://github.com/XTLS/Xray-core.git
     cd Xray-core
     $env:GOOS = 'android'; $env:GOARCH = 'arm64'; $env:CGO_ENABLED = '0'
     go build -trimpath -ldflags '-s -w -checklinkname=0' -o xray-android-arm64-v8a .\main
     ```

     The `-checklinkname=0` flag is required because the transitive `github.com/wlynxg/anet` dep uses `//go:linkname` to reach the internal `net.zoneCache`; Go 1.23+ rejects those references by default. Without the flag the linker aborts with `link: github.com/wlynxg/anet: invalid reference to net.zoneCache` (golang/go#78085, wlynxg/anet#9). With the flag, the build produces a static ARM64 ELF that runs as an Android sidecar.

     Result on this host (committed to `.android-build/xray-arm64.bin` for reference; never tracked):
     - size = 35,193,128 bytes
     - SHA-256 = `8593ff12755fa1bfae22f0774a308dcd0752827f94ac75c76712c98a87b76b2f`
     - ELF magic `7F 45 4C 46`, `e_machine == 0x00B7` (AArch64) ✓
     - Equivalent script: `scripts/build-android-xray.ps1`.
  2. **Pre-built from a trusted third party** (e.g. v2rayNG's own bundled xray ARM64, or our own CI artifact pinned to commit `80263da83e96b2972455b0a94b13ee1a10e51391`). Higher trust risk; we still need to verify SHA-256, ELF, AArch64.
  3. **Drop the sidecar approach and stay with `libXray.aar` plus a shared gomobile runtime.** Reopens the original in-JVM conflict. The pinning doc remains correct: this is a packaging hypothesis that has never been proved.
- **Pinning requirements** for whichever binary source is chosen:
  - SHA-256 of the resulting `xray` binary is recorded in the verifier (see section 2).
  - ELF magic `7F 45 4C 46` and `e_machine == 0x00B7` (AArch64).
  - `xray version` (or `--version`) prints the upstream `v26.7.28` revision when run on the device.
  - Staging: `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/xray`.
  - The file is gitignored; the verifier copies the verified binary into `jniLibs` and lets Gradle package it.

### 2. Verifier script

- `scripts/verify-android-xray-binary.ps1`.
- Inputs: the downloaded `Xray-android-arm64.zip` (ignored) or the extracted `xray` binary path.
- Checks (fail-closed):
  1. ZIP asset SHA-256 matches the pinned value.
  2. After extraction, the `xray` file size matches the pinned size.
  3. `xray` SHA-256 matches.
  4. ELF magic bytes `7F 45 4C 46` and `e_machine == EM_AARCH64 (183)`.
- Output: digests and file size only. No URLs, paths into the workspace beyond the explicit `-Path` argument, or other sensitive data.

### 3. `XrayEngine.kt`

- New file: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayEngine.kt`.
- Same API shape as `SingBoxEngine`:

  ```kotlin
  class XrayEngine(
    private val context: CloakwireVpnService,
    private val onServiceStop: () -> Unit,
  ) {
    fun start(config: String, tunFd: Int, grpcPort: Int)
    fun closeBestEffort()
    val hasActiveServer: Boolean
    fun setErrorIfCurrent(message: String)
  }
  ```

- **Binary location at runtime.** On Android 10+ `/data` is mounted `noexec`, so copying the jniLibs binary into `filesDir/bin/xray` and `chmod 0o755` does not work. Instead, the engine resolves the binary from `context.applicationInfo.nativeLibraryDir`, which the package manager extracts with executable permissions. The path is cached for the engine's lifetime. A `noexec` mount on `nativeLibraryDir` (observed on some Android 12+ custom ROMs) is a documented runtime risk: the engine reports `STATE_ERROR` with message `"xray binary not executable (noexec mount)"` and the user is told to use sing-box. We do not silently fall back.
- **Staged name.** AGP's jniLibs packaging filters files without a `.so` extension. The staged name is `libxray.so` even though it is a standalone ARM64 ELF executable. The runtime path is `nativeLibraryDir + "/libxray.so"`. The file is gitignored via `.gitignore`.
- `start` flow:
  1. Verify the binary in `jniLibs` against the pinned SHA-256 (read from the staged copy in `nativeLibraryDir`).
  2. Confirm the resolved path is executable (`File.canExecute()`); if not, fail with the noexec error above.
  3. Write the prepared runtime config to `${filesDir}/xray-config.json`. The config embeds the chosen `grpcPort` in the `stats`/`api` inbound and `warning` log level — xray reads these from the JSON, not from environment variables.
  4. Spawn via `ProcessBuilder` with args: `xray`, `run`, `-c`, `${filesDir}/xray-config.json`.
  5. Set env: `XRAY_TUN_FD=<tunFd>` (the only environment variable xray reads for TUN handoff on Android, per upstream docs). No other xray-specific env is set.
  6. Start a `vpn-xray-watch` thread that drains stdout/stderr into a sanitized log pipe, and exits the engine if the process dies unexpectedly.
- `closeBestEffort`: under `@Synchronized`, snapshot the process, clear the reference, then `destroy()` followed by `destroyForcibly()` under `runCatching`. Always also best-effort delete `${filesDir}/xray-config.json`. The binary itself is left in `nativeLibraryDir` (managed by the system).
- Watcher: a daemon thread that calls `process.waitFor()` and, on non-zero exit while the engine was still "active", invokes `onServiceStop()` with a `process exited (code=<n>)` message.
- No coroutines, no new executors beyond the one watch thread and the existing `vpn-stop` from the service.

### 4. Sanitized log redactor

- Pure helper in `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayLogRedactor.kt`.
- Strips credentials (UUIDs, base64-key fingerprints, password=… values), raw URLs, and any line that contains a `vmess://`, `vless://`, `trojan://`, or `ss://` URL.
- Unit-tested with a small set of fixtures; no libbox or xray mocks.

### 5. gRPC stats

- **Deferred to v1.3.2.** v1.3.1 ships without xray traffic counters in the UI. The `api`/`stats` block in the generated xray config is still emitted (gRPC inbound at `127.0.0.1:<grpcPort>`) so a future client can be added without re-touching the config. No gRPC Java deps, no `protobuf-gradle-plugin`, no `xray_stats.proto` codegen in v1.3.1.
- When v1.3.2 lands:
  - gRPC Java client dependencies (Gradle): `io.grpc:grpc-okhttp:1.62.2`, `grpc-protobuf-lite:1.62.2`, `grpc-stub:1.62.2`, `com.google.protobuf:protobuf-javalite:3.25.3`.
  - Proto file: `src-tauri/proto/xray_stats.proto` (copied verbatim from the desktop proto).
  - Generated classes via `protobuf-gradle-plugin` with `lite` runtime.
  - `XrayStatsClient.kt`: managed channel to `127.0.0.1:<grpcPort>`, `GetStats` returns counters pushed into `VpnEvents` as `vpn.stats`. Connection errors degrade to "unavailable" without disturbing the VPN.

### 6. `CloakwireVpnService` integration

- Add `EXTRA_ENGINE` (`"sing-box" | "xray"`). Default `"sing-box"` for backward compatibility.
- Add `private val xrayEngine = XrayEngine(this) { stopVpn() }` (parallel to the existing `engine` for sing-box).
- In `runVpn`:
  - If engine == sing-box: existing `engine.start(config)`.
  - If engine == xray: `xrayEngine.start(config, tunFd, grpcPort)`. The `tunFd` is the descriptor returned by `CloakwirePlatform.openTun`; the service captures it from the existing `onTunEstablished` callback.
  - In both cases, on success, `STATE_RUNNING` + foreground "Connected".
  - On any error, the service still emits `STATE_ERROR` and `stopVpn()`. The `commandServer?.setError(...)` call is replaced with engine-specific best-effort error reporting.
- The `onRevoke` and `onDestroy` paths close whichever engine was active. The `hasActiveServer` flag is now a service-level `isAnyEngineActive` helper.
- The `commandServer == null` no-action restart check becomes `isAnyEngineActive()`.

### 7. `VpnPlugin.kt` bridge

- The `start` invoke accepts an optional `engine` parameter (`"sing-box" | "xray"`).
- When engine == xray, the plugin writes the Xray runtime config (a thin converter from sanitized `Outbound[]` to Xray JSON) into `filesDir/xray-config.json` and sets `EXTRA_ENGINE="xray"`.
- The `getStatus` invoke returns the active engine name alongside the existing state.
- No raw URLs or credentials cross the WebView boundary.

### 8. Frontend

- `engine: "sing-box" | "xray"` field added to the server profile type.
- Home renders a small badge per profile (sing-box / xray) using the existing color tokens.
- Servers list shows the same badge; the existing "test proxy" control is disabled for `xray` profiles (matches desktop behavior).
- Stats counters from `vpn.stats` (xray) replace the sing-box-native counters when the active engine is xray.
- The engine selector lives on the server-edit form and defaults to the existing per-profile value or "sing-box".

## Data flow

```text
User picks engine in profile
   ↓
VpnPlugin.start({ engine, configPath })
   ↓
Writes xray config when needed; sets EXTRA_ENGINE
   ↓
Service ACTION_START → startForeground, STATE_STARTING
   ↓
vpn-start thread → runVpn(configPath)
   ↓
CloakwirePlatform.openTun → tunFd
   ↓
if (engine == xray) xrayEngine.start(config, tunFd, grpcPort)
else                engine.start(config)
   ↓
STATE_RUNNING, foreground "Connected"
   ↓
xray watch thread catches crashes → STATE_ERROR → stopVpn()
```

## Error handling

- Verifier failure → STATE_ERROR "sidecar binary integrity failed"; engine never starts; service stops cleanly.
- Binary not executable (noexec mount) → STATE_ERROR "xray binary not executable (noexec mount)"; service tells the user to use sing-box; never silently falls back.
- Process spawn failure → STATE_ERROR with spawn error message; tunFd closed; service stops.
- Non-zero exit during a session → watch thread sets STATE_ERROR, calls `onServiceStop`, service tears down the active engine, TUN, and notification.
- gRPC channel failure → logs as "stats unavailable" in `VpnEvents`, does not stop the VPN.
- Repeated start during running engine: stop current engine, close TUN, restart with new engine.
- `ACTION_STOP` and `onRevoke` always wait for engine close (best-effort, with a short timeout on `waitFor`) and delete `xray-config.json`.

## Testing

### Without a device (host/CI)

- `verify-android-xray-binary.ps1` covers SHA, size, ELF, AArch64.
- Pure JVM unit tests:
  - `XrayLogRedactorTest` covers sanitization of UUIDs, share links, password fields, plain traffic lines.
  - `XrayStatsClientCodecTest` covers proto encode/decode for `GetStatsResponse`.
  - `XrayConfigBuilderTest` covers the `Outbound[]` → Xray JSON mapping (no raw URLs, no credentials).
- Frontend unit tests: server profile engine field, engine badges, disabled "test proxy" for xray.
- Android gates: `:app:compileArm64ReleaseKotlin`, `:app:testArm64ReleaseUnitTest`, `:app:assembleArm64Release -x :app:rustBuildArm64Release` (the existing blocker is still excluded).

### With the physical ARM64 device

- TUN handoff through `env.xray.tun.fd` actually brings up xray.
- A real VLESS/REALITY/XTLS subscription profile completes a handshake.
- gRPC stats appear in the UI and update over time.
- Switching sing-box↔xray cleanly tears down both engines.
- xray log lines reaching the bridge contain no credentials or URLs.
- Repeated start/stop cycles leave the device in a clean state.

### Packaging

- Verify the unsigned APK has a `lib/arm64-v8a/xray` entry, an inventory delta consistent with the v1.2.0 baseline (858 stable entries + xray binary), and a stable SHA-256.
- Sign through `scripts/sign-android-release.ps1` (existing workflow) and validate v2/v3, certificate SHA-256, and metadata against the v1.2.0 reference.
- Publish to the existing GitHub Release under a new `android/v1.3.1` tag (do not move `v1.3.0`).

## Out-of-scope (deferred blockers)

- Full Tauri Android Rust build (`failed to build WebSocket client / ConnectionRefused`) remains excluded via `-x :app:rustBuildArm64Release`. Fixing the Rust toolchain is a separate workstream.
- Android clang toolchain setup is not in this spec.
- `cargo fmt --all -- --check` drift is not in this spec.
- Desktop sidecar build (`sing-box-x86_64-pc-windows-msvc.exe`) is not in this spec.
- Shared-runtime AAR for libXray + libbox is **permanently deferred** — the sidecar model replaces it.
- JVM-side test of the Android `org.json` codec is not in this spec.

## Verification gates

1. Run the new verifier on the downloaded binary.
2. Run all new JVM unit tests; existing tests still pass.
3. Run frontend tests; build the Vite production bundle.
4. Run `:app:compileArm64ReleaseKotlin`, `:app:testArm64ReleaseUnitTest`, `:app:assembleArm64Release -x :app:rustBuildArm64Release`.
5. On the device: end-to-end TUN, handshake, gRPC stats, repeated switching, sanitized logs.
6. Sign and validate the APK against the v1.2.0 reference; publish to GitHub.
7. Confirm `git diff --check` is clean and no forbidden artifacts are tracked.
8. Commit the spec, plan, scripts, engine, plugin, and frontend changes as separate, reviewable increments.

Success means the v1.3.1 Android release ships with Xray available as a real engine choice, no gomobile conflicts, and the same UX and security guarantees as the desktop.
