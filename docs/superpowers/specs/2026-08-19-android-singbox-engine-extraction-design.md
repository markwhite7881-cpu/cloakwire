# Android v1.3.1 SingBoxEngine Extraction Design

- **Date:** 2026-08-19
- **Branch:** `android/v1.3.1-port`
- **Scope:** behavior-preserving extraction of sing-box/libbox orchestration from `CloakwireVpnService`

## Goal

Create a thin `SingBoxEngine` boundary around the existing in-process sing-box runtime without changing Android VPN behavior, public bridge contracts, notification behavior, TUN ownership, or `VpnEvents` semantics.

This is an extraction, not a new engine abstraction. Do not introduce `AndroidVpnEngine`, a general interface, a new lifecycle model, or support for another runtime.

## Current responsibilities to preserve

`CloakwireVpnService` remains the owner of:

- `VpnService` lifecycle, `onCreate`, `onStartCommand`, `onDestroy`, and `onRevoke`;
- foreground notification creation and updates;
- config-file reading and log-path injection;
- TUN descriptor tracking and closing;
- `CloakwirePlatform` construction context and Android service callbacks;
- `VpnEvents` state transitions;
- worker-thread creation and stop ordering;
- `stopVpn()` and the existing `CommandServerHandler.serviceStop()` behavior through a callback.

`CloakwirePlatform.kt`, `VpnPlugin.kt`, `VpnEvents.kt`, manifests, permissions, generated bridge code, subscriptions, and frontend code are out of scope.

## New boundary

Add `SingBoxEngine.kt` in the existing `ru.classquiz.singbox.vpn` package.

The engine receives:

```kotlin
class SingBoxEngine(
  private val context: CloakwireVpnService,
  private val onServiceStop: () -> Unit,
)
```

The callback is intentionally narrow. The engine may report a core-requested service stop, but it must not directly own Android service shutdown, notifications, `VpnEvents`, or TUN cleanup.

Public engine operations:

```kotlin
fun start(config: String)
fun closeServiceBestEffort()
fun closeBestEffort()
```

The exact visibility may remain package-private where Kotlin permits it; no external plugin or WebView API is added.

## Engine-owned behavior

`SingBoxEngine` owns only:

1. process-wide, one-time `Libbox.setup`;
2. creation of `CloakwirePlatform(context)`;
3. creation of the `CommandServerHandler` implementation;
4. current `CommandServer` reference;
5. replacement of a previous server on repeated starts;
6. `CommandServer.start()`;
7. `OverrideOptions` construction with `autoRedirect = false`;
8. `startOrReloadService(config, overrides)`;
9. best-effort close of the current server.

The handler preserves current behavior exactly:

- `serviceStop()` invokes `onServiceStop`;
- `serviceReload()` remains a no-op;
- system proxy is reported unavailable and disabled;
- native crash trigger throws the same debug exception;
- core debug messages use the same `Log` tag and format;
- SSH agent returns `-1`.

## Setup semantics

Move the existing `SetupOptions` values unchanged:

- `basePath = context.filesDir.absolutePath`;
- `workingPath = File(context.filesDir, "singbox").apply { mkdirs() }.absolutePath`;
- `tempPath = context.cacheDir.absolutePath`;
- `fixAndroidStack = true`;
- `logMaxLines = 300L`;
- `debug = false`.

The process-wide readiness flag remains synchronized and volatile. It may be moved into the engine companion object, but must retain one-time behavior across service instances in the same process. `Libbox.setup` must not run more than once per process.

## Start and replacement semantics

`CloakwireVpnService.runVpn` continues to read and prepare the config before calling the engine.

The engine's `start(config)` sequence is:

1. perform one-time setup;
2. close the previous server with `closeService()` followed by `close()`;
3. clear the current reference;
4. create a fresh server with the handler and `CloakwirePlatform`;
5. publish it as current before calling `start()`;
6. call `start()`;
7. create overrides and set `autoRedirect = false`;
8. call `startOrReloadService(config, overrides)`.

If any step throws, the exception propagates unchanged to `runVpn`, which retains the existing log, error event, `setError`, and `stopVpn()` path.

The current server reference must be cleared when replacement begins and when closing. A failed new start must not leave a stale previous server reachable through the engine.

## Close semantics and synchronization

Preserve the existing synchronization boundary for service stop. `close` operations are best-effort and must not replace the current behavior with blocking lifecycle orchestration.

- `closeServiceBestEffort()` calls `closeService()` under `runCatching`.
- `closeBestEffort()` calls `close()` under `runCatching`.
- A combined helper may perform both in that order.
- `CloakwireVpnService.stopVpn()` continues to clear its Android-visible state, update `VpnEvents`, close TUN, stop foreground mode, and stop the service before/independently of the engine's asynchronous server close thread exactly as today.
- `onDestroy()` remains a synchronous best-effort close path, preserving current behavior.

Do not add locks around libbox calls beyond the current `@Synchronized` stop/setup boundaries unless required to prevent the engine's current-server reference from being replaced incorrectly. Do not introduce coroutines, executors, or new worker pools.

## Service integration

The service will replace:

- `commandServer` with one `private val engine` initialized from the service;
- direct setup/server/handler code in `runVpn` with `engine.start(config)`;
- direct server close calls in `stopVpn()` and `onDestroy()` with engine close helpers.

`CloakwireVpnService` continues to create `thread(name = "vpn-start")` and `thread(name = "vpn-stop")`; thread names and ordering remain unchanged.

The service callback passed to the engine calls `stopVpn()`. This preserves the existing `CommandServerHandler.serviceStop()` behavior without letting the engine depend on Android lifecycle methods beyond the callback.

## Non-goals

- no changes to `CloakwirePlatform` or TUN setup;
- no changes to notification text, IDs, channels, or foreground-service type;
- no changes to `VpnEvents` values or update timing;
- no changes to config generation, log injection, subscriptions, UI, or reconnect logic;
- no libXray/AAR/dependency changes;
- no new runtime interface or test mock framework;
- no attempt to prove device runtime behavior unavailable in this environment.

## Verification gates

After implementation:

1. run the existing frontend test set and production build;
2. compile Android Kotlin;
3. run Android unit tests;
4. assemble the ARM64 APK while excluding the known blocked Rust WebSocket build task;
5. inspect the diff for accidental lifecycle, manifest, generated, dependency, or bridge changes;
6. run `git diff --check`;
7. confirm no forbidden artifacts are tracked;
8. commit the extraction separately from previous Android port increments.

Success means the source-level boundary is extracted, all available automated gates pass, and the known normal-generation/Rust blockers remain unchanged and explicitly reported if encountered.
