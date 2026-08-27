# Android Xray Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add XTLS/Xray as a parallel VPN engine on Android, run as a separate process, with full TUN handoff, sanitized logs, and gRPC stats parity with the desktop.

**Architecture:** Xray ships as a `jniLibs/arm64-v8a/xray` binary and is launched via `ProcessBuilder` from a new `XrayEngine` Kotlin class. `CloakwireVpnService` keeps ownership of Android lifecycle, notification, TUN, `VpnEvents`, and worker threads, and dispatches to either `SingBoxEngine` (existing) or `XrayEngine` (new) based on the user's engine choice. TUN fd is handed off via `env.xray.tun.fd`; gRPC stats go through a Java client over `127.0.0.1:<grpcPort>`.

**Tech Stack:** Kotlin, Android `VpnService`, `ProcessBuilder`, gRPC Java (OkHttp transport, protobuf-lite), protobuf-gradle-plugin, PowerShell verifier, Node test runner for frontend.

## Global Constraints

- Work only in `C:\Users\Public\cwdev\cloakwire-android-v131-port` on branch `android/v1.3.1-port`.
- Xray binary source: official `XTLS/Xray-core` release `v26.7.28`, asset `Xray-android-arm64.zip`.
- Xray binary staging: `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/xray`; runtime path is `applicationInfo.nativeLibraryDir + "/xray"`.
- Do not commit the xray binary, downloaded zip, gradle build outputs, APK/AAR, generated proto, or any build artifact.
- Do not modify `CloakwirePlatform.kt`, `VpnEvents.kt`, generated bridge code, or backend Rust code in this workstream.
- Preserve Android VPN behavior, public bridge contracts, notification behavior, TUN ownership, and `VpnEvents` semantics.
- Keep sing-box primary: every change to `CloakwireVpnService` must remain compatible with the existing `SingBoxEngine` flow.
- Do not introduce a shared `VpnEngine` interface, coroutines, new executors, or test mocks for native code in this iteration.
- No raw provider URLs, profile contents, UUIDs, credentials, or runtime paths reach the WebView.
- ARM64 only; no x86, armeabi-v7a, x86_64 binaries.
- All gRPC work uses `io.grpc:grpc-okhttp`, `grpc-protobuf-lite`, `grpc-stub`, `protobuf-javalite`, all at pinned versions; no other gRPC stacks.
- Frontend keeps the existing color tokens, no new color schemes.
- Engine-specific failure paths must terminate in `STATE_ERROR` and the existing `stopVpn()` cleanup. No silent fallbacks except documented gRPC "stats unavailable".

---

### Task 1: Add the xray binary verifier script

**Files:**
- Create: `scripts/verify-android-xray-binary.ps1`
- Create: `scripts/verify-android-xray-binary.Tests.ps1` (Pester-style smoke test using the file as a function module, optional)

**Interfaces:**
- Consumes: the downloaded `Xray-android-arm64.zip` path via `-ZipPath`; the extracted `xray` path via `-BinaryPath`.
- Produces: SHA-256 and size strings written to stdout; non-zero exit on any mismatch.

- [ ] **Step 1: Implement the verifier.**

  Use `System.Security.Cryptography.SHA256` to hash the zip and the binary, compare to two pinned constants, validate ELF magic (`7F 45 4C 46`) and `e_machine == 0x00B7` (EM_AARCH64) by reading the first 20 bytes and bytes 18–19 as little-endian. Output only the digests, the size, the file name, and a final `OK` line. Never log full paths, URLs, or arguments beyond the explicit `-ZipPath`/`-BinaryPath` inputs.

- [ ] **Step 2: Run the verifier against a fresh download.**

  Download the v26.7.28 asset to a temp path with `Invoke-WebRequest`, then call the verifier with that path. Capture the digests. If the binary's reported SHA-256 does not match the value hardcoded into the script, the script is wrong — update its constants to the actual upstream digests and re-run.

- [ ] **Step 3: Commit.**

  ```powershell
  git add -- scripts/verify-android-xray-binary.ps1
  git commit -m "build(android): add xray sidecar verifier"
  ```

### Task 2: Stage the verified xray binary locally

**Files:**
- Add: `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/xray` (gitignored binary; never committed)
- Add: `.gitignore` entry for `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/xray`
- Create: `scripts/extract-android-xray-binary.ps1` (helper: download, verify, place)

**Interfaces:**
- Consumes: `Xray-android-arm64.zip` downloaded into `.android-build/libxray-v26.7.28/libxray-android.zip`.
- Produces: the verified `xray` binary at the jniLibs path and a SHA-256 marker file `.android-build/libxray-v26.7.28/extracted.sha256`.

- [ ] **Step 1: Write the extractor script.**

  It should: download if missing, run the verifier, extract the zip, copy the `xray` binary into the jniLibs path, leave the SHA marker, and remove the temp zip on success.

- [ ] **Step 2: Run it and verify the staged file.**

  Confirm `File.canExecute()` would be true in the staged copy on a real device by reading the package manager's expected permissions. The staged file should be ~14–20 MB and SHA-256 must match the pinned value.

- [ ] **Step 3: Add the jniLibs path to `.gitignore`.**

  Place the entry near the other `gen/android` ignore rules. Do not add the `.android-build` directory tree; it should already be ignored.

- [ ] **Step 4: Commit the script and `.gitignore` change.**

  ```powershell
  git add -- scripts/extract-android-xray-binary.ps1 .gitignore
  git commit -m "build(android): stage xray sidecar binary"
  ```

### Task 3: Add the XrayLogRedactor helper

**Files:**
- Create: `src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/XrayLogRedactorTest.kt`
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayLogRedactor.kt`

**Interfaces:**
- Consumes: a single log line as `String`.
- Produces: a redacted `String` or `null` if the entire line is dropped.

- [ ] **Step 1: Write failing tests.**

  Cover: UUID redaction (`[REDACTED-UUID]`), base64-like key redaction (`[REDACTED-KEY]`), share-link redaction (entire line dropped), `password=…` redaction, plain log line passes through unchanged.

- [ ] **Step 2: Run `./gradlew :app:testArm64ReleaseUnitTest` to confirm the tests fail.**

- [ ] **Step 3: Implement `XrayLogRedactor`.**

  Pattern-based, with the regexes as `private` constants. No allocation per line beyond the resulting String.

- [ ] **Step 4: Run the unit test task to confirm green.**

- [ ] **Step 5: Commit.**

  ```powershell
  git add -- src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayLogRedactor.kt src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/XrayLogRedactorTest.kt
  git commit -m "feat(android): add xray log redactor"
  ```

### Task 4: Add the XrayConfigBuilder helper

**Files:**
- Create: `src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/XrayConfigBuilderTest.kt`
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayConfigBuilder.kt`

**Interfaces:**
- Consumes: the sanitized `Outbound[]` from the existing frontend, a `grpcPort: Int`, and a `tunFd: Int`.
- Produces: a complete Xray JSON config string with a TUN inbound (handed off via `env.xray.tun.fd`), a `freedom` outbound per server, routing rules, the `api`/`stats` inbound for gRPC, and a `log` block at warning level.

- [ ] **Step 1: Write failing tests.**

  Cover: outbound count matches, no raw URLs, no password values, no share-link fragments, TUN inbound uses `tunFd` env contract, gRPC inbound listens on `127.0.0.1:<grpcPort>`.

- [ ] **Step 2: Run the unit test task to confirm failure.**

- [ ] **Step 3: Implement `XrayConfigBuilder`.**

  Use `org.json.JSONObject`/`JSONArray` to assemble the config. Each test profile becomes one outbound with a tag, with credentials replaced by `[REDACTED]`. Routing matches outbound tags to the appropriate inbound.

- [ ] **Step 4: Run the unit tests to confirm green.**

- [ ] **Step 5: Commit.**

  ```powershell
  git add -- src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayConfigBuilder.kt src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/XrayConfigBuilderTest.kt
  git commit -m "feat(android): add xray config builder"
  ```

### Task 5: Add the XrayEngine class

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayEngine.kt`

**Interfaces:**
- Consumes: `CloakwireVpnService` and a `() -> Unit` stop callback; the prepared Xray config string; the TUN fd integer; the gRPC port integer.
- Produces: a started xray process held inside the engine; a `closeBestEffort()`; an `isActive` read-only flag; a `setErrorIfCurrent(message)` for service-level error reporting.

- [ ] **Step 1: Implement the engine skeleton.**

  Same shape as `SingBoxEngine`: companion-level `BINARY_NAME = "xray"`, `@Volatile private var process: Process?`, `@get:Synchronized val isActive`, `@Synchronized fun closeBestEffort`, `fun setErrorIfCurrent`, and `fun start(config, tunFd, grpcPort)`.

- [ ] **Step 2: Implement the binary resolution and integrity check.**

  Resolve `applicationInfo.nativeLibraryDir + "/" + BINARY_NAME`. Compute SHA-256, compare to a pinned constant matching the verifier. If mismatch or `!File.canExecute()`, throw `IllegalStateException("xray binary not executable (noexec mount)")`. The service catches and reports `STATE_ERROR`.

- [ ] **Step 3: Implement process spawn with sanitized log drain.**

  Write `${filesDir}/xray-config.json`, `ProcessBuilder(nativeBinary, "run", "-c", configFile.absolutePath)`, redirect error stream to stdout, set env `XRAY_TUN_FD=<tunFd>`, start a daemon thread that reads stdout, applies `XrayLogRedactor`, and writes sanitized lines into a bounded ring buffer. Start a second daemon thread that calls `process.waitFor()` and triggers `onServiceStop()` with the exit code if the process dies unexpectedly.

- [ ] **Step 4: Commit.**

  ```powershell
  git add -- src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayEngine.kt
  git commit -m "feat(android): add xray engine"
  ```

### Task 6: Add gRPC stats client

**Files:**
- Modify: `src-tauri/gen/android/app/build.gradle.kts` (add protobuf-gradle-plugin, gRPC dependencies)
- Modify: `src-tauri/gen/android/build.gradle.kts` (apply the protobuf plugin if it lives at the project level)
- Add: `src-tauri/proto/xray_stats.proto` (copied verbatim from `cloakwire-hwid-xray/src-tauri/proto/xray_stats.proto`)
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayStatsClient.kt`

**Interfaces:**
- Consumes: `host: String`, `port: Int`.
- Produces: a started channel that calls `getStats()` and returns `Map<String, Long>` of counter name → value; `close()` to release the channel.

- [ ] **Step 1: Add proto file and Gradle plugin.**

  Apply `com.google.protobuf` plugin version `0.9.4`; set `protobuf { protoc { artifact = "com.google.protobuf:protoc:3.25.3" } plugins { grpc { artifact = "io.grpc:protoc-gen-grpc-java:1.62.2" } } generateProtoTasks { all().forEach { it.plugins { grpc {} }; it.builtins { create("java") { option("lite") } } } }`. Add the four gRPC dependencies at exactly `1.62.2` (grpc-okhttp, grpc-protobuf-lite, grpc-stub) and `protobuf-javalite:3.25.3`.

- [ ] **Step 2: Copy the proto from the desktop worktree.**

  Use the file under `cloakwire-hwid-xray/src-tauri/proto/xray_stats.proto` as the source. Do not modify the proto.

- [ ] **Step 3: Implement `XrayStatsClient`.**

  Wrap a `ManagedChannelBuilder.forAddress(host, port).usePlaintext().build()`, a `StatsServiceGrpc.newBlockingStub(channel)`, and a `getStats()` that issues `GetStatsRequest.newBuilder().setReset(true).build()` and returns the resulting map. Errors are caught and returned as an empty map plus a one-time log line.

- [ ] **Step 4: Run `:app:compileArm64ReleaseKotlin` to confirm the generated code compiles.**

- [ ] **Step 5: Commit.**

  ```powershell
  git add -- src-tauri/gen/android/app/build.gradle.kts src-tauri/gen/android/build.gradle.kts src-tauri/proto/xray_stats.proto src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/XrayStatsClient.kt
  git commit -m "feat(android): add xray gRPC stats client"
  ```

### Task 7: Integrate XrayEngine into CloakwireVpnService

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt`

**Interfaces:**
- Consumes: `EXTRA_ENGINE` string extra on `ACTION_START`; `tunFd` already captured by `onTunEstablished`.
- Produces: a chosen-engine dispatch in `runVpn`; `isAnyEngineActive` for shutdown paths.

- [ ] **Step 1: Add `EXTRA_ENGINE` and the xrayEngine field.**

  Add the constant to the companion. Add `private val xrayEngine = XrayEngine(this) { stopVpn() }`.

- [ ] **Step 2: Add `isAnyEngineActive` helper.**

  Returns `engine.isActive || xrayEngine.isActive`.

- [ ] **Step 3: Branch `runVpn` on the engine choice.**

  For sing-box: existing flow. For xray: generate the xray config via `XrayConfigBuilder`, capture the current `tunFd` from `this.tunFd` after `CloakwirePlatform.openTun` ran, and call `xrayEngine.start(xrayConfig, tunFd!!, grpcPort)`. On any thrown error, log + `VpnEvents.update(STATE_ERROR, ...)` + the engine's `setErrorIfCurrent(...)` + `stopVpn()`. The current TUN ownership story: for xray, the service must establish the TUN *before* calling `xrayEngine.start` and pass the fd in. This requires a service-level helper that wraps the current `CloakwirePlatform.openTun` flow. Implement this helper as a private method `private fun openTunForCurrentConfig(): Int` that mirrors the builder calls from `CloakwirePlatform.openTun` but returns the int fd directly and stores the wrapper in `tunFd`. For sing-box, keep the existing flow untouched; for xray, call the helper.

- [ ] **Step 4: Update `stopVpn`, `onDestroy`, and the no-action restart branch.**

  Replace the `engine.hasActiveServer` checks with `isAnyEngineActive`. Replace `engine.closeBestEffort()` with both `engine.closeBestEffort()` and `xrayEngine.closeBestEffort()` guarded by their `isActive` flags.

- [ ] **Step 5: Commit.**

  ```powershell
  git add -- src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt
  git commit -m "feat(android): wire xray engine into vpn service"
  ```

### Task 8: Extend VpnPlugin.kt with engine choice and xray config

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnPlugin.kt`

**Interfaces:**
- Consumes: optional `engine: String` parameter on the `start` invoke; the existing sanitized outbound list.
- Produces: `ACTION_START` with `EXTRA_ENGINE` set; the xray config written to `${filesDir}/xray-config.json` when engine == xray; a `getStatus` field reporting the active engine.

- [ ] **Step 1: Add `engine` to the `start` invoke payload.**

  Validate it is either `"sing-box"` or `"xray"`; default to `"sing-box"` when absent. Pass the chosen value through to the service intent and write the xray config if needed.

- [ ] **Step 2: Surface the active engine in `getStatus`.**

  Read the most recent `VpnEvents` state plus a new "active engine" field, written by the service into `VpnEvents` when `STATE_RUNNING` is reached.

- [ ] **Step 3: Commit.**

  ```powershell
  git add -- src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnPlugin.kt
  git commit -m "feat(android): add engine choice to vpn plugin"
  ```

### Task 9: Update frontend for engine choice

**Files:**
- Modify: `src/mobile/lib/profile.ts` (or the equivalent server-profile type)
- Modify: `src/mobile/lib/serverGrouping.ts` (engine badge projection)
- Modify: `src/mobile/screens/ServersScreen.tsx` (engine selector, disabled "test proxy" for xray)
- Modify: `src/mobile/screens/HomeScreen.tsx` (engine badge)
- Modify: `src/mobile/lib/vpn.ts` (start with engine)
- Create: `src/mobile/lib/engine.test.ts`

- [ ] **Step 1: Extend the server profile type with `engine: "sing-box" | "xray"`.**

  Default to `"sing-box"` on existing records during hydration.

- [ ] **Step 2: Add pure helpers for the engine badge and the disabled "test proxy" predicate.**

  Cover them with unit tests in `engine.test.ts` (no jsdom; pure assertions).

- [ ] **Step 3: Wire the engine into the `vpn.start` invoke payload.**

  Add a parameter that defaults to `"sing-box"`. Keep sanitized boundaries intact.

- [ ] **Step 4: Run frontend tests and Vite build.**

  ```powershell
  node --experimental-strip-types --test src/mobile/lib/engine.test.ts src/mobile/lib/homeServerCatalog.test.ts src/mobile/lib/reconnectState.test.ts src/mobile/lib/serverGrouping.test.ts src/lib/subscriptionStorage.test.ts
  $env:CLOAKWIRE_TEST_MANIFEST = ''
  npm run build
  ```

- [ ] **Step 5: Commit.**

  ```powershell
  git add -- src/mobile/
  git commit -m "feat(android): add engine choice to mobile UI"
  ```

### Task 10: Verification gates and sign+publish

- [ ] **Step 1: Run Android Kotlin, unit tests, and packaging.**

  ```powershell
  $env:GRADLE_USER_HOME = 'C:\Users\Public\cwdev\gradle-home'
  .\src-tauri\gen\android\gradlew.bat :app:compileArm64ReleaseKotlin :app:testArm64ReleaseUnitTest :app:assembleArm64Release --no-daemon --console=plain -x :app:rustBuildArm64Release
  ```

  Expected: Kotlin compile, unit tests, and packaging succeed. The Rust WebSocket blocker remains excluded and is not a regression.

- [ ] **Step 2: Verify the unsigned APK.**

  Confirm `lib/arm64-v8a/xray` is present, package id and version are unchanged, and the inventory delta is consistent (858 stable entries + xray binary).

- [ ] **Step 3: Sign and validate.**

  Use the existing `scripts/sign-android-release.ps1`; compare the signed APK certificate SHA-256 against the trusted v1.2.0 reference; compare metadata; re-query the SHA-256.

- [ ] **Step 4: Publish to GitHub Release.**

  Tag `android/v1.3.1`, attach the signed APK, re-query the asset and compare the GitHub-reported digest to the local SHA-256.

- [ ] **Step 5: Final repo hygiene.**

  ```powershell
  git status --short
  git diff --check
  ```

  Confirm no forbidden artifacts, no `tsconfig.tsbuildinfo`, no APK/AAR, no downloaded zip, no xray binary. Restore `tsconfig.tsbuildinfo` if generated.

- [ ] **Step 6: Commit any release documentation.**

  Update the changelog, the README, and the release notes in a single commit.

---

## Notes

- Tasks 1–5 deliver a self-contained, host-verifiable core: a verified binary, a sanitized log helper, a tested config builder, and the engine itself. They can be executed and reviewed before the rest.
- Task 6 (gRPC) is independent of Task 7 (service integration); both depend on Task 5.
- Tasks 7–9 are cross-cutting and should be reviewed together because they touch the service/plugin/frontend contract.
- Task 10 is the only step that requires the physical ARM64 device for the end-to-end TUN/handshake/gRPC proof; everything else runs on the host.
- This plan assumes the existing sing-box-only packaging baseline (`f00394c` … `959caea`) remains buildable at every checkpoint.
