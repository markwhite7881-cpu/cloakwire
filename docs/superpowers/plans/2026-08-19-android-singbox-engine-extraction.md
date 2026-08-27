# Android SingBoxEngine Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract sing-box/libbox orchestration into a thin `SingBoxEngine` while preserving the current Android VPN behavior exactly.

**Architecture:** `CloakwireVpnService` remains the Android lifecycle owner and delegates only libbox setup, `CommandServer` creation/replacement/start/reload, and best-effort close operations to `SingBoxEngine`. The engine receives the service as the platform context and a narrow `onServiceStop` callback; it does not own notifications, TUN descriptors, `VpnEvents`, config preparation, or service shutdown.

**Tech Stack:** Kotlin, Android `VpnService`, sing-box `libbox` Java bindings, Gradle ARM64 Android build, existing Kotlin/JVM unit-test setup.

## Global Constraints

- Work only in `C:\Users\Public\cwdev\cloakwire-android-v131-port` on branch `android/v1.3.1-port`.
- Preserve public bridge contracts, VPN lifecycle behavior, notification behavior, TUN ownership, and `VpnEvents` semantics.
- Keep sing-box primary; do not add or restore libXray dependencies or AARs.
- Do not modify `CloakwirePlatform.kt`, `VpnPlugin.kt`, `VpnEvents.kt`, manifests, permissions, generated bridge files, subscriptions, or frontend code.
- Do not expose or log provider URLs, profile contents, UUIDs, credentials, raw configurations, or runtime paths.
- Preserve one-time process-wide `Libbox.setup` and current close ordering: `closeService()` then `close()`.
- Preserve worker thread names and ownership: `vpn-start` and `vpn-stop` remain in `CloakwireVpnService`.
- Do not introduce `AndroidVpnEngine`, a general interface, coroutines, executors, new worker pools, or test mocks for libbox.
- Do not commit generated files, APK/AAR outputs, executables, archives, credentials, or forbidden artifacts.

---

### Task 1: Add the thin SingBoxEngine

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/SingBoxEngine.kt`
- Reference: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt:13-20, 44-50, 62, 127-155, 176-190, 192-207, 288-320`

**Interfaces:**
- Consumes: `CloakwireVpnService` as the `Context`/platform owner and `onServiceStop: () -> Unit`.
- Produces: `start(config: String)`, `closeBestEffort()`, `setErrorIfCurrent(message: String)`, and read-only `hasActiveServer` for service integration.

- [ ] **Step 1: Copy the existing libbox handler behavior into the new engine.**

  Define `SingBoxEngine` in package `ru.classquiz.singbox.vpn` with:

  ```kotlin
  class SingBoxEngine(
    private val context: CloakwireVpnService,
    private val onServiceStop: () -> Unit,
  )
  ```

  Preserve the current `CommandServerHandler` methods exactly:

  ```kotlin
  private inner class Handler : CommandServerHandler {
    override fun serviceStop() = onServiceStop()
    override fun serviceReload() {}

    override fun getSystemProxyStatus(): SystemProxyStatus =
      SystemProxyStatus().apply {
        available = false
        enabled = false
      }

    override fun setSystemProxyEnabled(enabled: Boolean) {}

    override fun triggerNativeCrash() {
      throw Exception("triggerNativeCrash is a debug facility — not wired up")
    }

    override fun writeDebugMessage(message: String) {
      Log.d(TAG, "core: $message")
    }

    override fun connectSSHAgent(): Int = -1
  }
  ```

  Use the same `TAG = "CloakwireVpnService"` value so core logs do not change.

- [ ] **Step 2: Move one-time setup into the engine without changing values.**

  Add a companion-level process-wide flag:

  ```kotlin
  @Volatile private var libboxReady = false
  ```

  Implement a synchronized setup method using the exact existing `SetupOptions` assignments:

  ```kotlin
  @Synchronized
  private fun setupLibboxOnce() {
    if (libboxReady) return
    val options = SetupOptions()
    options.basePath = context.filesDir.absolutePath
    options.workingPath = File(context.filesDir, "singbox").apply { mkdirs() }.absolutePath
    options.tempPath = context.cacheDir.absolutePath
    options.fixAndroidStack = true
    options.logMaxLines = 300L
    options.debug = false
    Libbox.setup(options)
    libboxReady = true
  }
  ```

- [ ] **Step 3: Implement start and repeated-start replacement.**

  Keep `start(config: String)` exception-transparent. Its body must preserve this order:

  ```kotlin
  fun start(config: String) {
    setupLibboxOnce()

    currentServer?.let { old ->
      runCatching { old.closeService() }
      runCatching { old.close() }
    }
    currentServer = null

    val server = Libbox.newCommandServer(Handler(), CloakwirePlatform(context))
    currentServer = server
    server.start()

    val overrides = OverrideOptions()
    overrides.autoRedirect = false
    server.startOrReloadService(config, overrides)
  }
  ```

  Do not catch or wrap exceptions from setup, server creation, `start`, or reload; `CloakwireVpnService.runVpn` must continue to own the existing error path.

- [ ] **Step 4: Implement the combined best-effort close operation with current-server clearing.**

  Keep the current server private and clear it before close work so a failed close cannot leave a stale reachable reference. The only service-facing close method is:

  ```kotlin
  private var currentServer: CommandServer? = null

  @get:Synchronized
  val hasActiveServer: Boolean
    get() = currentServer != null

  @Synchronized
  fun closeBestEffort() {
    val server = currentServer ?: return
    currentServer = null
    runCatching { server.closeService() }
    runCatching { server.close() }
  }
  ```

  The two calls must remain in this order. Do not add separate service calls that clear the reference after the first close and skip the second close.

### Task 2: Integrate the engine into CloakwireVpnService

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt:13-20, 44-50, 62, 112-155, 176-220, 288-320`
- Test impact: existing Android Kotlin compilation and unit tests; no new libbox mocks.

**Interfaces:**
- Consumes: `SingBoxEngine.start(config)` and its best-effort close operation.
- Produces: unchanged `ACTION_START`, `ACTION_STOP`, `VpnEvents`, notification, TUN, and service lifecycle behavior.

- [ ] **Step 1: Remove imports and state that become engine-owned.**

  Remove from `CloakwireVpnService.kt` only the now-unused libbox orchestration imports:

  - `CommandServer`
  - `CommandServerHandler`
  - `Libbox`
  - `OverrideOptions`
  - `SetupOptions`
  - `SystemProxyStatus`

  Remove the companion `libboxReady` flag and the `commandServer` property. Add:

  ```kotlin
  private val engine = SingBoxEngine(this) { stopVpn() }
  ```

  Keep all Android and notification imports unchanged unless the compiler proves one is unused after the integration.

- [ ] **Step 2: Replace the start orchestration with one engine call.**

  In `runVpn`, preserve config reading and `injectLogFile(raw)` exactly. Replace the block from `setupLibboxOnce()` through `server.startOrReloadService(config, overrides)` with:

  ```kotlin
  engine.start(config)
  ```

  Leave the surrounding `try/catch` unchanged, including:

  ```kotlin
  Log.e(TAG, "VPN start failed", e)
  VpnEvents.update(VpnEvents.STATE_ERROR, e.message ?: e.toString())
  engine.setErrorIfCurrent(e.message ?: "start failed")
  stopVpn()
  ```

  Since the existing service currently calls `commandServer?.setError(...)`, add the smallest engine method needed to preserve this operation:

  ```kotlin
  fun setErrorIfCurrent(message: String) {
    currentServer?.setError(message)
  }
  ```

  It must be best-effort only if the existing call was nullable/best-effort; preserve the exact exception behavior of the current `commandServer?.setError` expression.

- [ ] **Step 3: Preserve repeated-start, stop, and destroy behavior.**

  In `stopVpn`, keep the existing order:

  1. `VpnEvents.update(STATE_STOPPED)`;
  2. detach/clear the service-visible engine/server state;
  3. launch `thread(name = "vpn-stop")`;
  4. close service then close server;
  5. close and clear `tunFd`;
  6. stop foreground and stop self.

  Replace only the server snapshot/close block with a `vpn-stop` thread calling the engine’s combined best-effort close operation. The engine must own the libbox server reference; the service must not retain a duplicate reference.

  In `onDestroy`, replace the synchronous server close block with `engine.closeBestEffort()`, preserving TUN cleanup, `active = null`, conditional stopped event, and `super.onDestroy()` order.

  In the no-action restart branch, replace `commandServer == null` with an engine query such as `engine.hasActiveServer`. Add only this read-only property if needed; it must not expose the server object.

- [ ] **Step 4: Remove the old handler and setup methods only after compilation confirms no remaining callers.**

  Delete `setupLibboxOnce()` and the `Handler` inner class from `CloakwireVpnService.kt`. Do not alter notification, config injection, `onTunEstablished`, `mainActivityPendingIntent`, `onRevoke`, or lifecycle branches.

### Task 3: Run focused static and Android verification

**Files:**
- Inspect only: `SingBoxEngine.kt`, `CloakwireVpnService.kt`, `git diff`

- [ ] **Step 1: Check the Kotlin diff for preserved behavior.**

  Run:

  ```powershell
  git diff --check
  git diff -- src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/SingBoxEngine.kt src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt
  ```

  Confirm only the new engine and the minimal service delegation changed. Confirm no references to `CloakwirePlatform`, `VpnEvents`, manifests, permissions, generated bridge code, libXray, or dependencies changed.

- [ ] **Step 2: Run frontend regression gates.**

  Run from the repository root:

  ```powershell
  node --experimental-strip-types --test src/mobile/lib/homeServerCatalog.test.ts src/mobile/lib/reconnectState.test.ts src/mobile/lib/serverGrouping.test.ts src/lib/subscriptionStorage.test.ts
  $env:CLOAKWIRE_TEST_MANIFEST = ''
  npm run build
  ```

  Expected: all selected tests pass and Vite production build succeeds; an existing large-chunk warning is acceptable.

- [ ] **Step 3: Run Android Kotlin, unit-test, and packaging gates.**

  Run from `src-tauri/gen/android`:

  ```powershell
  $env:GRADLE_USER_HOME = 'C:\Users\Public\cwdev\gradle-home'
  .\gradlew.bat :app:compileArm64ReleaseKotlin :app:testArm64ReleaseUnitTest :app:assembleArm64Release --no-daemon --console=plain -x :app:rustBuildArm64Release
  ```

  Expected: Kotlin compilation, Android unit tests, and ARM64 packaging-only assembly pass. The normal Rust WebSocket-generation blocker is intentionally excluded and must not be misreported as fixed.

- [ ] **Step 4: Check forbidden artifacts and generated changes.**

  Run:

  ```powershell
  git status --short
  git diff --name-only HEAD
  git diff --check
  ```

  Restore `tsconfig.tsbuildinfo` if generated, and reject any APK/AAR, executable, downloaded archive, raw configuration, credential, or generated bridge file appearing in the diff.

### Task 4: Review and commit the isolated extraction

**Files:**
- Commit: `SingBoxEngine.kt` and the minimal `CloakwireVpnService.kt` change only.

- [ ] **Step 1: Review the final changed-path set.**

  Confirm the final change set contains only:

  ```text
  src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/SingBoxEngine.kt
  src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt
  ```

  Do not include build outputs or unrelated files.

- [ ] **Step 2: Commit the extraction.**

  Run:

  ```powershell
  git add -- src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/SingBoxEngine.kt src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/CloakwireVpnService.kt
  git commit -m "refactor(android): extract sing-box engine"
  ```

- [ ] **Step 3: Report verified and blocked gates accurately.**

  Report the commit hash, test/build results, changed files, and any unchanged known blockers. Do not claim device-runtime proof or normal Rust generation success unless independently observed.
