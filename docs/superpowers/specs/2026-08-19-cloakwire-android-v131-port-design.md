# Cloakwire Android v1.3.1 Port Design

- **Date:** 2026-08-19
- **Branch:** `android/v1.3.1-port`
- **Baseline:** `v1.2.0-android.1` (`0d899f0f2457afffcce33903e34196a1a19112ba`)
- **Scope:** Android-safe port of desktop v1.3.1 behavior plus a gated Xray ARM64 feasibility spike
- **Status:** approved design; implementation must follow a separate implementation plan

## 1. Goals

1. Preserve the verified Android v1.2.0 behavior and release provenance.
2. Port desktop v1.3.1 behavior that is independent of desktop process management:
   - provider-title fallback, decoding, and migration;
   - subscription grouping and metadata persistence;
   - shared profile-selection and reconnect semantics;
   - persistent reconnect notices;
   - corresponding mobile UI behavior.
3. Add an Android engine boundary that keeps sing-box primary and permits a future Xray capability fallback without exposing unsupported controls.
4. Prove an Android ARM64 Xray runtime before exposing Xray selection or fallback in the UI.
5. Keep all sensitive provider URLs, profile contents, UUIDs, credentials, raw runtime paths, updater keys, and raw telemetry out of the WebView and logs.

## 2. Non-goals

- Do not merge the desktop sidecar implementation into Android.
- Do not add desktop updater, system-proxy, desktop Clash-control, process-spawn, or desktop geodata assumptions to Android.
- Do not expose Xray UI controls before the runtime proof succeeds.
- Do not change the verified Android baseline worktree or the supplied signed APK.
- Do not add multi-user synchronization or server-side state.
- Do not commit AAR/APK outputs, Xray executables, downloaded archives, raw subscription bundles, credentials, or generated build directories.

## 3. Source and worktree policy

Implementation occurs only in the clean worktree:

```text
C:\Users\Public\cwdev\cloakwire-android-v131-port
```

on branch `android/v1.3.1-port`, created from `v1.2.0-android.1`.

The following remain immutable evidence and rollback sources:

- the original dirty checkout at `C:\Users\Алексей\.minimax-agent\projects\singbox-client`;
- the exact unsigned APK payload matching the supplied signed Android v1.2.0 APK;
- the supplied signed APK;
- historical tag `v1.2.0-android.1`.

Every implementation commit must be independently testable and must not include generated `tsconfig.tsbuildinfo`, Android build output, `target/`, `node_modules/`, staging directories, or native runtime downloads.

## 4. Architecture

### 4.1 Existing Android path

The current Android path remains authoritative for sing-box:

```text
React mobile UI
  -> shared Rust config generation / metadata commands
  -> Kotlin VpnPlugin
  -> CloakwireVpnService
  -> libbox CommandServer
  -> CloakwirePlatform.openTun()
  -> Android VpnService TUN
```

The existing Kotlin bridge and Tauri plugin command names remain stable. Frontend bridge code must unwrap Kotlin response envelopes defensively, because gomobile/Tauri payload shapes are runtime behavior rather than TypeScript guarantees.

### 4.2 Engine abstraction

Introduce an Android-only engine boundary inside the Kotlin VPN service. The exact interface is to be finalized in the implementation plan, but it must express only Android-relevant operations:

- `start(config, sessionContext)`;
- `stop()`;
- `isRunning` / state;
- bounded, sanitized log tail;
- fatal-error callback;
- optional engine identifier for status display.

`SingBoxEngine` wraps the current `Libbox.setup`, `CommandServer`, `startOrReloadService`, and `closeService` lifecycle without changing sing-box semantics.

`XrayEngine` is initially a feasibility-spike implementation. It is not available to profile selection or normal UI until all proof gates pass. Engine choice is an internal capability result, not a free-form WebView-provided executable path.

### 4.3 Xray runtime policy

The selected runtime must come from an official, auditable upstream source and be pinned by version/commit and SHA-256. The preferred technical form is an Android AAR/library based on the upstream gomobile path or the upstream-compatible `libXray` project, integrated in-process with `CloakwireVpnService`.

A desktop-style executable sidecar is not the default Android design. It may be evaluated only as a fallback experiment if the in-process library path fails, and it must not enter production code without a separate security and lifecycle review.

The Xray adapter must own:

- config materialization in the app-private directory;
- TUN file-descriptor handoff;
- start/stop synchronization;
- cancellation and timeout handling;
- log capture with redaction and bounded size;
- mapping native failures to stable user-facing errors.

The WebView must never receive the native library path, temporary config path, raw Xray config, raw native log lines, or unredacted startup arguments.

## 5. Feature migration matrix

| Desktop v1.3.1 behavior | Android port | Boundary / rule |
|---|---|---|
| Provider title fallback and decoding | Yes | Shared metadata/model layer; no provider URL disclosure |
| Provider metadata migration | Yes | Idempotent migration with tests for old and new records |
| Subscription grouping | Yes | Shared subscription store and mobile rendering |
| Profile endpoint/tag deduplication | Yes | Preserve existing mobile list semantics |
| Selection boundary and reconnect | Yes | Reconnect only when VPN state is `running`; stopped selection remains side-effect free |
| Persistent reconnect notices | Yes | Notice survives retry/failure until actionable state changes |
| Auto-connect | Yes | Keep Android opt-in behavior and avoid fighting an existing service |
| Desktop updater | No | Android release pipeline remains separate |
| Desktop system proxy | No | Android uses `VpnService`; no desktop proxy commands |
| Desktop Clash proxy controls | Restricted | Only allowed when sing-box is active and controller is available |
| Xray `list_proxies` / `select_proxy` / `test_delay` | No | Disabled while Xray is active; UI remains visible but unavailable |
| Desktop sidecar process management | No | Replaced by Android in-process engine lifecycle |
| Desktop geodata paths | No | Android-specific provisioned assets only, with fixed provenance and integrity checks |

## 6. Profile capability and engine selection

1. Keep sing-box as the first candidate for every supported profile.
2. If config generation or a native sing-box start fails because the profile requires a capability unavailable in the embedded sing-box runtime, classify the failure as a potential Xray fallback only when the profile is known to be supported by the Xray adapter.
3. Do not silently convert a profile between engines when the conversion could change security or routing semantics.
4. If no engine can run the profile, show a stable, sanitized unsupported-profile error and keep the current VPN session stopped or unchanged according to the existing selection boundary.
5. Engine capability must be represented by a typed result, not inferred from UI labels or protocol strings alone.

## 7. Feasibility spike gates

The spike must run on a real ARM64 Android device or equivalent validated ARM64 target. A desktop compile is not evidence of runtime viability.

Required gates:

1. **Packaging:** pinned AAR loads in the release-shaped ARM64 APK; no missing native symbols or ABI mismatch.
2. **Lifecycle:** Xray starts from the existing foreground `VpnService`, reports running, and stops cleanly.
3. **TUN:** Xray receives the Android TUN descriptor through an explicit, tested handoff and routes a controlled connectivity probe.
4. **Logs:** bounded logs are available through the existing Logs screen without raw secrets or paths.
5. **Switching:** sing-box → Xray → sing-box works repeatedly without leaked descriptors, stale notifications, or a dead service.
6. **Failure recovery:** malformed config, revoked VPN permission, native start failure, and forced service destruction all return to a truthful stopped/error state.
7. **Performance sanity:** no sustained main-thread blocking, unbounded log growth, or obvious service restart loop during the test window.

Failure of any gate blocks Xray UI exposure. The app must remain a valid sing-box-only Android build.

## 8. UI and command restrictions

Before the spike passes:

- no Xray toggle, engine selector, or fallback badge is shown;
- unsupported profiles retain the existing disabled presentation;
- no frontend command targets Xray.

After the spike passes:

- active engine may be shown as a compact status detail;
- `PROXIES` remains visible but unavailable while Xray is active;
- frontend must not call `list_proxies`, `select_proxy`, or `test_delay` while Xray is active;
- reconnect notices use the same running/stopped/crashed policy as desktop v1.3.1;
- all displayed errors are user-facing summaries, never raw native output.

## 9. Data migration and compatibility

- Read old subscription/provider records without requiring a reinstall.
- Apply migrations once, idempotently, and preserve unknown fields where safe.
- Treat decoded provider titles as presentation metadata; never use them as identifiers.
- Preserve subscription identity and selected profile identity across migration.
- If a record cannot be migrated safely, retain it and show a non-destructive warning rather than deleting it.
- Add fixtures containing only synthetic, non-credential-bearing data.

## 10. Testing strategy

### Shared TypeScript/Rust behavior

- metadata decoding/fallback and migration tests;
- subscription grouping and deduplication tests;
- profile selection and reconnect state tests;
- persistent notice status matrix tests;
- mobile component tests for grouped subscriptions and unavailable Xray controls;
- production frontend build with `CLOAKWIRE_TEST_MANIFEST=''`.

### Android/Kotlin behavior

- existing `CloakwirePlatform` routing tests must remain green;
- `VpnPlugin` bridge tests for command names and envelope unwrapping;
- engine lifecycle unit tests with fake native engine;
- service transition tests for start, stop, crash, revoke, and repeated switching;
- ARM64 device proof test suite for the seven feasibility gates;
- unsigned APK metadata/ABI/resource validation;
- signed APK validation only through the existing trusted signing process.

### Security checks

- scan changes for provider URLs, UUIDs, credentials, raw configs, private keys, runtime paths, and generated artifacts;
- verify AAR/native hashes and provenance are recorded without committing downloaded binaries;
- verify logs are bounded and redacted;
- verify active-Xray code has no proxy-control or delay-test calls.

## 11. Rollback and release policy

- The first implementation commits are common Android behavior only; Xray work is separate and revertible.
- If the AAR or TUN proof fails, revert only Xray commits and ship sing-box-only Android functionality.
- Do not move `v1.2.0-android.1` or alter the supplied v1.2.0 APK.
- A future Android release must use a new version/tag and a new signed APK; it must not overwrite historical release artifacts.
- No release claim is made until device validation, APK metadata validation, signing validation, and final digest verification all pass.

## 12. Acceptance criteria for this design

This design is accepted when:

- the clean worktree and branch are documented;
- common v1.3.1 behavior is explicitly separated from desktop-only behavior;
- the Kotlin engine boundary and sing-box primary policy are explicit;
- Xray AAR provenance, pinning, and feasibility gates are explicit;
- UI restrictions and security boundaries are explicit;
- failure, rollback, testing, and release rules are explicit;
- implementation can be split into independently testable commits without modifying the verified baseline.
