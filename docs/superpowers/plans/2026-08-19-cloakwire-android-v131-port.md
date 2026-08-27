# Cloakwire Android v1.3.1 Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Android-safe desktop v1.3.1 behavior from the verified `v1.2.0-android.1` baseline and prove an official, pinned ARM64 Xray AAR runtime inside the existing Android `VpnService` before exposing Xray fallback.

**Architecture:** Keep the existing React mobile UI, Rust shared commands, Kotlin `VpnPlugin`, and sing-box `libbox` path intact. Add shared metadata/reconnect parity first, then introduce an Android-only `VpnEngine` boundary in Kotlin; implement Xray as a gated in-process adapter backed by an official upstream AAR/library, with no Xray UI or fallback until the device proof passes.

**Tech Stack:** React 18, TypeScript, Vite, Tauri 2, Rust, Kotlin, Android `VpnService`, sing-box `libbox.aar`, official Xray-compatible Android AAR/library, Gradle, ARM64 Android device validation.

## Global Constraints

- Base all work on `v1.2.0-android.1` at `0d899f0f2457afffcce33903e34196a1a19112ba`.
- Work only in `C:\Users\Public\cwdev\cloakwire-android-v131-port` on `android/v1.3.1-port`.
- Never modify the dirty baseline checkout, the supplied signed APK, or the matching unsigned APK evidence.
- Keep sing-box primary; Xray is a strict capability fallback only after the ARM64 proof passes.
- Do not copy desktop sidecar, updater, system-proxy, desktop process-spawn, Clash-control, or desktop geodata assumptions into Android.
- Do not commit keys, credentials, tokens, APK/AAR outputs, executables, downloaded archives, raw subscription bundles, `target/`, `node_modules/`, generated files, or staging directories.
- Preserve the Android Kotlin plugin command names and response-envelope compatibility.
- Android builds must use an ASCII-only worktree and the existing trusted Android toolchain configuration.
- Frontend must not call `list_proxies`, `select_proxy`, or `test_delay` while Xray is active; `PROXIES` remains visible but unavailable.
- Logs and errors must not expose provider URLs, profile contents, UUIDs, credentials, updater material, runtime paths, or raw telemetry/configuration data.
- Desktop/frontend production builds must use `CLOAKWIRE_TEST_MANIFEST=''`.
- Every task ends with focused tests and its own commit.

---

## File map and ownership

### Shared TypeScript/Rust behavior

- `src-tauri/src/subscriptions/metadata.rs` — **new in this port**; provider-title decoding, fallback, and migration logic.
- `src-tauri/src/subscriptions/store.rs` — **new in this port**; persisted subscription/provider metadata and migration entry point.
- `src-tauri/src/subscriptions/model.rs` — **new in this port**; serializable subscription/provider types.
- `src-tauri/src/subscriptions/service.rs` — **new in this port**; refresh, resolve, and grouped snapshot orchestration.
- `src-tauri/src/subscriptions/{mod.rs,classify.rs,http.rs,hwid.rs,tests.rs}` — **new in this port**; module boundary, input classification/fetching, protected HWID support, and synthetic regression coverage.
- `src-tauri/src/commands.rs` — subscription command registration and safe command-boundary integration.
- `src-tauri/src/lib.rs` — module/state/command registration for the new service.
- `src/lib/types.ts` — shared frontend subscription/profile types.
- `src/hooks/useSubscriptions.ts` — replace the baseline WebView-only persistence/fetch path with the opaque native subscription command API and grouped results consumed by desktop/mobile.
- `src/lib/profileSelection.ts` — selection-boundary policy.
- `src/lib/reconnectState.ts` — reconnect-required and persistent-notice state machine.
- `package.json` / `package-lock.json` — port the desktop v1.3.1 Vitest command and pinned test dependency.
- `src/lib/*.test.ts`, `src/hooks/*.test.ts`, `src/components/*.test.tsx` — focused TypeScript regression coverage.

### Android frontend

- `src/mobile/MobileApp.tsx` — mobile selection, reconnect, and notice integration.
- `src/mobile/screens/HomeScreen.tsx` — grouped profile presentation and active-engine-safe status.
- `src/mobile/screens/ServersScreen.tsx` — subscription groups, unsupported profiles, and unavailable controls.
- `src/mobile/screens/SettingsScreen.tsx` — existing Android settings; no Xray control before the gate.
- `src/mobile/screens/LogsScreen.tsx` — bounded/sanitized native logs.
- `src/mobile/useVpnConnection.ts` — Android connect/disconnect boundary and engine status handling.
- `src/lib/vpn.ts` — typed Kotlin bridge and defensive response unwrapping.

### Android Kotlin runtime

- `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnPlugin.kt` — stable Tauri command bridge.
- `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt` — foreground service and engine lifecycle owner.
- `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwirePlatform.kt` — Android TUN and routing integration.
- `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnEvents.kt` — status/event model.
- `src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/CloakwirePlatformRoutingPolicyTest.kt` — existing routing regression tests.
- `src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/EngineLifecycleTest.kt` — fake-engine lifecycle tests.
- `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine/AndroidVpnEngine.kt` — common engine contract.
- `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine/SingBoxEngine.kt` — current libbox adapter.
- `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine/XrayEngine.kt` — gated Xray adapter.
- `src-tauri/gen/android/app/libs/` — only pinned, ignored native dependency during local proof; never commit the AAR.
- `src-tauri/gen/android/app/build.gradle.kts` — local AAR dependency wiring only after provenance/hash validation.
- `src-tauri/gen/android/gradle.properties` — ARM64-only validation settings; preserve existing values.

### Proof and release validation

- `scripts/verify-android-xray-runtime.ps1` — device proof runner; no secrets or raw configs in output.
- `scripts/validate-android-apk.ps1` — existing/new metadata, ABI, and resource validation.
- `docs/superpowers/specs/2026-08-19-cloakwire-android-v131-port-design.md` — approved design; do not rewrite scope silently.
- `docs/superpowers/plans/2026-08-19-cloakwire-android-v131-port.md` — this plan.

---

### Task 1: Establish clean Android baseline and test harness

**Files:**
- Modify: none unless a test command requires a narrowly scoped ignore/config correction.
- Test: existing repository tests and Android unit-test task.

**Interfaces:**
- Consumes: `v1.2.0-android.1` and the clean worktree.
- Produces: reproducible baseline evidence and a test command record; no product behavior changes.

- [ ] **Step 1: Confirm repository and branch identity**

Run:

```powershell
Set-Location C:\Users\Public\cwdev\cloakwire-android-v131-port
git branch --show-current
git rev-parse HEAD
git status --short
```

Expected: branch `android/v1.3.1-port`, HEAD contains the documented design commit `d937a3e`, `git merge-base --is-ancestor 0d899f0f2457afffcce33903e34196a1a19112ba HEAD` exits 0, and `git status --short` is empty.

- [ ] **Step 2: Install frontend dependencies without lifecycle scripts**

Run:

```powershell
$env:CLOAKWIRE_TEST_MANIFEST = ''
npm ci --ignore-scripts
```

Expected: exit code 0; do not commit `node_modules`.

- [ ] **Step 3: Run the baseline frontend build**

Run:

```powershell
$env:CLOAKWIRE_TEST_MANIFEST = ''
npm run build
```

Expected: TypeScript and Vite build pass; `tsconfig.tsbuildinfo` remains uncommitted.

- [ ] **Step 4: Run baseline Android unit tests**

Run from `src-tauri/gen/android` with the existing ASCII Android SDK/JDK/Gradle environment:

```powershell
.\gradlew.bat :app:testArm64ReleaseUnitTest --no-daemon --console=plain
```

Expected: existing routing tests pass. If the wrapper requires priming, rerun after the distribution is available; do not change Android source to bypass an environment failure.

- [ ] **Step 5: Commit baseline evidence note only if needed**

Do not create a commit if no file changed. Record command output in the task report, not in the repository.

---

### Task 2: Port the frontend test harness and provider metadata/subscription grouping

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src-tauri/src/subscriptions/mod.rs`
- Create: `src-tauri/src/subscriptions/model.rs`
- Create: `src-tauri/src/subscriptions/metadata.rs`
- Create: `src-tauri/src/subscriptions/store.rs`
- Create: `src-tauri/src/subscriptions/service.rs`
- Create: `src-tauri/src/subscriptions/classify.rs`
- Create: `src-tauri/src/subscriptions/http.rs`
- Create: `src-tauri/src/subscriptions/hwid.rs`
- Create: `src-tauri/src/subscriptions/tests.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/hooks/useSubscriptions.ts`
- Create: `src/hooks/useSubscriptions.test.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/mobile/screens/ServersScreen.tsx`
- Modify: `src/mobile/MobileApp.tsx`
- Test: Rust subscription tests and focused Vitest tests.

**Interfaces:**
- Consumes: existing Android subscription persistence and `v1.3.1` desktop behavior from `C:\Users\Public\cwdev\cloakwire-v131-integration`.
- Produces: the desktop-compatible Vitest command (`npm test`) plus idempotent metadata migration, stable subscription group identity, and mobile subscription grouping without URL/profile-content disclosure.

- [ ] **Step 1: Port the test harness dependency and command**

Copy the pinned `vitest` devDependency and `"test": "vitest run"` script from the desktop integration branch into `package.json` and `package-lock.json`. Do not add a second test framework or a jsdom dependency unless a later component test genuinely requires it.

Run:

```powershell
npm ci --ignore-scripts
npm test -- --help
```

Expected: Vitest starts successfully and exits 0 for the help command.

- [ ] **Step 2: Add failing synthetic metadata tests**

Add tests for:

```rust
#[test]
fn provider_title_uses_decoded_metadata_then_name_then_fallback() { /* synthetic records */ }

#[test]
fn provider_metadata_migration_is_idempotent() { /* run migration twice */ }

#[test]
fn grouping_preserves_subscription_identity_and_counts() { /* no credentials */ }
```

Use synthetic hostnames and UUID-like placeholders that are clearly non-credential-bearing.

- [ ] **Step 3: Run focused Rust tests and verify failure**

Run:

```powershell
cargo test -p cloakwire -- subscriptions::tests
```

Expected: the new tests fail against the baseline behavior.

- [ ] **Step 4: Create and integrate the native subscription boundary**

Create the desktop-compatible `subscriptions` module tree under `src-tauri/src/` and register it in `lib.rs` and `commands.rs`. Port only the storage/model/service/metadata logic required for opaque native persistence and grouped snapshots. The WebView must send an add/refresh/select request and receive sanitized summaries; it must never receive persisted provider URLs, raw subscription bodies, child configs, or HWID values.

- [ ] **Step 5: Replace the WebView-only subscription path**

Update `useSubscriptions.ts` to migrate the existing `singbox-client.subscriptions.v1` records once through `migrate_legacy_subscriptions`, then remove the URL-bearing localStorage key only after native persistence succeeds. Preserve the existing manual-profile key and endpoint/tag deduplication behavior. Keep provider titles as presentation metadata, never as IDs.

- [ ] **Step 6: Update mobile rendering**

Render subscription groups and counts in `ServersScreen`. Keep unsupported profiles visible but disabled. Do not render subscription URLs or raw provider metadata.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
cargo test -p cloakwire -- subscriptions::tests
npx vitest run src/hooks/useSubscriptions.test.ts src/components/HomeTab.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src-tauri/src/subscriptions src/hooks/useSubscriptions.ts src/lib/types.ts src/mobile/screens/ServersScreen.tsx src/mobile/MobileApp.tsx
git commit -m "feat(android): port subscription metadata and grouping"
```

---

### Task 3: Port selection boundary, reconnect state, and persistent notices

**Files:**
- Modify: `src/lib/profileSelection.ts`
- Modify: `src/lib/reconnectState.ts`
- Modify: `src/lib/profileSelection.test.ts`
- Modify: `src/lib/reconnectState.test.ts`
- Modify: `src/mobile/MobileApp.tsx`
- Modify: `src/mobile/useVpnConnection.ts`
- Modify: `src/mobile/screens/HomeScreen.tsx`
- Test: focused state-machine and mobile behavior tests.

**Interfaces:**
- Consumes: grouped profiles from Task 2 and the existing mobile VPN hook.
- Produces: `shouldReconnectAfterProfileSelection(status)` semantics identical to desktop v1.3.1; stopped selections remain side-effect free; reconnect notice remains visible during retry and after failure.

- [ ] **Step 1: Add failing selection/reconnect matrix tests**

Cover these exact cases:

```ts
expect(shouldReconnectAfterProfileSelection('running')).toBe(true);
expect(shouldReconnectAfterProfileSelection('stopped')).toBe(false);
expect(shouldReconnectAfterProfileSelection('starting')).toBe(false);
expect(shouldReconnectAfterProfileSelection('error')).toBe(false);
```

Also cover `ready_config` profiles through the caller that maps profile state to VPN status; the profile state must not suppress reconnect when the VPN is actually running.

- [ ] **Step 2: Add failing persistent-notice tests**

Assert that `shouldShowReconnectNotice` is true during reconnect, while the running tunnel still requires reconnect, and after a failed reconnect in stopped/crashed state; assert false for an untouched stopped edit.

- [ ] **Step 3: Implement the shared state boundary**

Keep selection state updates pure. Only the running VPN state authorizes automatic reconnect. Preserve `connectionDirty`/retry state until a successful reconnect or explicit user action clears it.

- [ ] **Step 4: Wire mobile profile selection**

Update `MobileApp.tsx` so selecting a profile while stopped changes settings only. Selecting while running marks the connection dirty and follows the reconnect policy; it must not call proxy-control commands directly.

- [ ] **Step 5: Render persistent mobile notice**

Use the existing design tokens and compact mobile layout. The notice must remain actionable during `starting`, `running`, and failed retry transitions according to the state matrix.

- [ ] **Step 6: Run focused tests and build**

Run:

```powershell
npx vitest run src/lib/profileSelection.test.ts src/lib/reconnectState.test.ts src/components/HomeTab.test.tsx
$env:CLOAKWIRE_TEST_MANIFEST = ''
npm run build
```

Expected: all tests and production build pass.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/profileSelection.ts src/lib/profileSelection.test.ts src/lib/reconnectState.ts src/lib/reconnectState.test.ts src/mobile/MobileApp.tsx src/mobile/useVpnConnection.ts src/mobile/screens/HomeScreen.tsx
git commit -m "feat(android): preserve reconnect selection semantics"
```

---

### Task 4: Define the Android engine contract and wrap sing-box

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine/AndroidVpnEngine.kt`
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine/SingBoxEngine.kt`
- Create: `src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/EngineLifecycleTest.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnEvents.kt` only if the typed engine state requires a backward-compatible field.
- Test: Android unit tests.

**Interfaces:**
- Consumes: current `CloakwireVpnService` and `CloakwirePlatform` behavior.
- Produces: exact Kotlin contract:

```kotlin
interface AndroidVpnEngine {
    val kind: EngineKind
    fun start(config: String): Unit
    fun stop(): Unit
    fun readLogs(maxLines: Int): String
}

enum class EngineKind { SING_BOX, XRAY }
```

`SingBoxEngine` owns the current command-server setup/close operations and calls the existing platform/TUN callbacks. It must not change the `VpnPlugin` command names or frontend response shapes.

- [ ] **Step 1: Write fake-engine lifecycle tests**

Create a fake engine that records `start` and `stop` calls. Test start-once, stop-once, repeated start replacement, start failure, and service destruction cleanup.

- [ ] **Step 2: Run Android unit tests and verify failure**

Run:

```powershell
Set-Location src-tauri/gen/android
.\gradlew.bat :app:testArm64ReleaseUnitTest --no-daemon --console=plain
```

Expected: new tests fail because the contract and service injection do not exist.

- [ ] **Step 3: Extract the sing-box lifecycle**

Move only the existing libbox lifecycle into `SingBoxEngine`. Preserve `SetupOptions`, `OverrideOptions.autoRedirect = false`, config log injection, foreground notification timing, and `VpnEvents` transitions.

- [ ] **Step 4: Inject the engine into the service**

Make `CloakwireVpnService` select `SingBoxEngine` by default. Keep service-level handling for permission revoke, malformed config, forced destruction, and notification updates.

- [ ] **Step 5: Run tests and verify sing-box parity**

Run the Android unit test task plus the existing frontend build. Expected: all baseline routing tests and engine lifecycle tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnEvents.kt src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/EngineLifecycleTest.kt
git commit -m "refactor(android): isolate VPN engine lifecycle"
```

---

### Task 5: Acquire, pin, and validate the official Xray AAR dependency

**Files:**
- Modify: `src-tauri/gen/android/app/build.gradle.kts`
- Modify: `src-tauri/gen/android/app/proguard-rules.pro` only when required by the validated AAR.
- Create: `scripts/verify-android-xray-dependency.ps1`
- Create: `docs/android/xray-libxray-pinning-2026-08-19.md`
- Modify: `.gitignore` only if a narrowly scoped ignored local dependency path is missing.
- Test: dependency verification script and ARM64 packaging build.

**Interfaces:**
- Consumes: approved engine contract and the official upstream candidate selected during research.
- Produces: a local-only AAR dependency with recorded upstream version/commit, source URL in the script/doc, SHA-256 verification, and ARM64-only packaging validation. No binary is committed.

- [ ] **Step 1: Record the official candidate and expected digest**

Use only the official `XTLS/libXray` GitHub Release `v26.7.28`, commit `80263da83e96b2972455b0a94b13ee1a10e51391`, asset `libxray-android.zip`, SHA-256 `28b7dc9d6cc8455fcca5cbd56e387003a7bfb558128651a64899dc3a8ccff666`. Extract its Android AAR into the ignored `app/libs/` directory only after the ZIP digest matches. The verification script must accept a local artifact path and expected digest, print only source/version/digest/ABI facts, and fail closed on mismatch. It must not print file contents or paths containing user credentials.

The wrapper’s official API is `LibXray.invoke(requestJson)`, with Android-specific DNS/process-finder support. The runtime TUN FD must be placed in the Xray config root `env.xray.tun.fd` before `runXray`; `SetTunFd` is not available. As documented upstream, Xray maintains some process-wide state, so the service must serialize all libXray starts/stops and must not run ping/test helpers concurrently with a live tunnel.

- [ ] **Step 2: Write dependency verification tests/checks**

Verify:

```powershell
Test-Path -LiteralPath $AarPath
(Get-FileHash -Algorithm SHA256 -LiteralPath $AarPath).Hash -eq $ExpectedSha256
```

Also inspect the AAR ZIP for `jni/arm64-v8a/` and reject an artifact lacking the required ARM64 native payload.

- [ ] **Step 3: Wire the AAR locally**

Add only the local dependency declaration required by Gradle. Keep desktop and existing sing-box dependencies unchanged. Do not add an unpinned Maven dynamic version.

- [ ] **Step 4: Build the unsigned ARM64 APK**

Run the existing Android build command in the ASCII worktree with the existing ARM64-only Gradle properties. Expected: packaging succeeds and the dependency is resolved without ABI errors.

- [ ] **Step 5: Commit only source/config/script changes**

```powershell
git add src-tauri/gen/android/app/build.gradle.kts src-tauri/gen/android/app/proguard-rules.pro scripts/verify-android-xray-dependency.ps1 docs/android/xray-libxray-pinning-2026-08-19.md .gitignore
git commit -m "build(android): pin official xray aar dependency"
```

Do not stage `app/libs/*.aar`, `app/build/`, or generated Gradle outputs.

---

### Task 6: Implement the Xray engine feasibility adapter

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine/XrayEngine.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnPlugin.kt` only to expose sanitized bounded logs if the existing command is insufficient.
- Create: `src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/XrayEngineTest.kt`
- Test: Android unit tests and device proof script.

**Interfaces:**
- Consumes: `AndroidVpnEngine`, pinned AAR API, `CloakwirePlatform.openTun()`, and service lifecycle.
- Produces: `XrayEngine` with explicit start/stop, TUN FD ownership, timeout, cancellation, bounded logs, and sanitized error mapping. It must never accept an arbitrary executable path from the frontend.

- [ ] **Step 1: Add failing adapter tests**

Test malformed config, start timeout, native start failure, stop idempotence, log truncation, and redaction of paths/credentials. Use a fake native binding; do not place a real config or provider link in fixtures.

- [ ] **Step 2: Implement config and TUN handoff**

Materialize only in the app-private directory. Pass the established TUN descriptor through the AAR’s supported API. Ensure descriptor ownership is unambiguous: exactly one layer closes it after the native engine confirms handoff, and failed handoff closes it locally.

- [ ] **Step 3: Implement lifecycle synchronization**

Serialize start/stop per service instance. On any start failure, emit an error state, release native resources, close temporary files, and return the service to stopped without a restart loop.

- [ ] **Step 4: Implement bounded sanitized logs**

Retain only the last configured number of lines. Redact filesystem paths, UUID-like tokens, credentials, URLs containing userinfo/query secrets, and raw config fragments before exposing logs to `VpnPlugin`.

- [ ] **Step 5: Wire the adapter behind a disabled capability flag**

The service may instantiate the adapter for proof runs, but the normal profile-selection path must continue to choose sing-box only until Task 7 records all gates as passed.

- [ ] **Step 6: Run unit tests**

Run:

```powershell
Set-Location src-tauri/gen/android
.\gradlew.bat :app:testArm64ReleaseUnitTest --no-daemon --console=plain
```

Expected: fake binding tests, lifecycle tests, and existing routing tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/engine/XrayEngine.kt src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnPlugin.kt src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/XrayEngineTest.kt
git commit -m "feat(android): add gated xray engine adapter"
```

---

### Task 7: Run the ARM64 feasibility proof and decide capability exposure

**Files:**
- Create: `scripts/verify-android-xray-runtime.ps1`
- Create: `docs/android/xray-arm64-proof-2026-08-19.md`
- Modify: none in product UI until all gates pass.
- Test: real ARM64 Android device/emulator proof.

**Interfaces:**
- Consumes: signed/unsigned proof-shaped APK from Tasks 5–6, `adb`, the pinned AAR, and the existing service.
- Produces: a redacted proof report with pass/fail for packaging, lifecycle, TUN, logs, switching, failure recovery, and performance sanity.

- [ ] **Step 1: Define proof commands and redacted output**

The script must collect only package name, version, ABI, process/service state, exit/error categories, and test pass/fail. It must not dump logcat wholesale, raw configs, provider URLs, or native paths.

- [ ] **Step 2: Run packaging and install checks**

Validate APK metadata, `arm64-v8a` native libraries, manifest VPN service declaration, and installed package identity. Reject universal/desktop-only native payloads.

- [ ] **Step 3: Run lifecycle/TUN test**

Grant VPN permission through the system flow, start Xray with a synthetic test config, verify foreground notification/service state, perform a controlled connectivity probe, then stop and verify descriptor/resource release.

- [ ] **Step 4: Run switching test**

Repeat sing-box → Xray → sing-box at least three times. Verify no stale `VpnEvents` running state, no dead foreground service, and no leaked TUN descriptor observable through service behavior.

- [ ] **Step 5: Run failure recovery test**

Exercise malformed config, revoked permission, native start failure, and forced service destruction. Expected result for every case: truthful stopped/error state, bounded sanitized log, no auto-restart loop.

- [ ] **Step 6: Record the proof report**

If all gates pass, record the exact runtime version/commit and digest, device/API level, ABI, test matrix, and limitations. If any gate fails, record the failure category and explicitly mark Xray capability as blocked.

- [ ] **Step 7: Commit proof evidence**

```powershell
git add scripts/verify-android-xray-runtime.ps1 docs/android/xray-arm64-proof-2026-08-19.md
git commit -m "test(android): record xray arm64 feasibility proof"
```

---

### Task 8: Expose Xray fallback and enforce UI/API restrictions only after proof success

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnEvents.kt`
- Modify: `src/lib/vpn.ts`
- Modify: `src/mobile/useVpnConnection.ts`
- Modify: `src/mobile/MobileApp.tsx`
- Modify: `src/mobile/screens/HomeScreen.tsx`
- Modify: `src/mobile/screens/ServersScreen.tsx`
- Modify: `src/mobile/screens/LogsScreen.tsx`
- Test: mobile component tests, bridge tests, Android unit tests, and static call-site scan.

**Interfaces:**
- Consumes: proof report marked PASS and both engine adapters.
- Produces: typed engine status and strict capability fallback. If proof report is not PASS, product behavior remains sing-box-only.

- [ ] **Step 1: Add failing capability tests**

Assert:

```ts
expect(activeEngineCapabilities('sing-box')).toMatchObject({ proxies: true, delayTest: true });
expect(activeEngineCapabilities('xray')).toMatchObject({ proxies: false, delayTest: false });
```

Also assert that unsupported Xray controls are rendered disabled, not hidden, when Xray is active.

- [ ] **Step 2: Implement typed engine status**

Add a stable status payload containing only `engine: 'sing-box' | 'xray'` and capability booleans. Do not expose native runtime details.

- [ ] **Step 3: Implement capability-aware frontend calls**

Guard all proxy-list, proxy-selection, and delay-test calls by active engine capabilities. Use the same guard for automatic latency probing and manual Ping all.

- [ ] **Step 4: Implement fallback selection**

Keep sing-box as the first attempt. Only classify and retry with Xray for an explicit typed capability error; do not retry arbitrary runtime failures or silently convert configs.

- [ ] **Step 5: Render active Xray restrictions**

Keep `PROXIES` visible but unavailable. Show a compact engine status and sanitized fallback/error message. Do not add an Xray selector when the proof is blocked.

- [ ] **Step 6: Run focused tests and static scan**

Run:

```powershell
npx vitest run src/lib src/mobile src/components
Set-Location src-tauri/gen/android
.\gradlew.bat :app:testArm64ReleaseUnitTest --no-daemon --console=plain
Set-Location C:\Users\Public\cwdev\cloakwire-android-v131-port
Select-String -Path src/mobile/**/*.ts,src/mobile/**/*.tsx -Pattern 'list_proxies|select_proxy|test_delay' -CaseSensitive
```

Expected: call sites are capability-guarded; no unguarded Xray path remains.

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn src/lib/vpn.ts src/mobile
git commit -m "feat(android): expose verified xray fallback capabilities"
```

---

### Task 9: Final Android release validation and rollback decision

**Files:**
- Modify: `src-tauri/tauri.android.conf.json` only for validated release metadata/config changes.
- Modify: `.github/workflows/release-android.yml` only for required pinned dependency/build changes.
- Modify: `README.md` / release notes only after behavior and packaging are verified.
- Test: complete release-shaped ARM64 build and APK validation.

**Interfaces:**
- Consumes: all prior commits, proof report, trusted signing configuration, and verified v1.2.0 APK as reference.
- Produces: a reproducible unsigned APK validation result, then a signed release candidate only if all gates pass.

- [ ] **Step 1: Run complete frontend and Rust validation**

```powershell
$env:CLOAKWIRE_TEST_MANIFEST = ''
npm run build
cargo test --workspace
```

Expected: pass without source-generated artifacts staged.

- [ ] **Step 2: Build the ARM64 unsigned APK**

Use the existing Android build workflow and ASCII-only toolchain paths. Keep `abiList=arm64-v8a`, `archList=arm64`, and `targetList=aarch64`.

- [ ] **Step 3: Validate the unsigned APK**

Verify package `ru.classquiz.singbox`, requested version/versionCode, `arm64-v8a`, manifest VPN service, stable resource inventory, and expected native libraries. Compare stable payload inventory against the v1.2.0 reference where applicable.

- [ ] **Step 4: Re-run device regression**

Run sing-box-only regression even when Xray passed: permission, connect, disconnect, server selection, reconnect, subscription migration/grouping, routing, logs, service recreation, and auto-connect.

- [ ] **Step 5: Sign only through the trusted signing script**

Use the existing signing configuration without displaying or copying secrets. Do not publish until v2/v3 signature, certificate fingerprint, metadata, ABI, stable inventory, and final SHA-256 are independently verified.

- [ ] **Step 6: Apply rollback rule**

If Xray proof or release validation fails, keep Tasks 1–4 as the sing-box-only Android port and revert/omit Tasks 5–8 from release packaging. Do not weaken gates to produce a release.

- [ ] **Step 7: Commit release documentation only after validation**

```powershell
git add .github/workflows/release-android.yml src-tauri/tauri.android.conf.json README.md RELEASE_NOTES_*.md
git commit -m "docs(android): document v1.3.1 release validation"
```

---

## Plan self-review

- **Spec coverage:** metadata migration/grouping — Task 2; reconnect semantics/notices — Task 3; engine boundary — Task 4; official AAR pinning — Task 5; Xray lifecycle/TUN/logging/switching — Tasks 6–7; UI restrictions and fallback — Task 8; security, rollback, ABI/signing/release — Tasks 5, 7, and 9.
- **Scope:** common Android parity is independently releasable after Task 4; Xray remains separately revertible after the proof gate.
- **Placeholder scan:** no `TODO`, `TBD`, `FIXME`, or unspecified “handle edge cases” steps are used.
- **Type consistency:** `AndroidVpnEngine`, `EngineKind`, capability guards, and proof gates are named consistently across tasks.
- **Safety:** no task permits modifying the recovered baseline or committing native artifacts/secrets.
