# Android Subscription Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Android subscription metadata and URL persistence from WebView `localStorage` into an app-private native store while preserving one-time migration from `singbox-client.subscriptions.v1`.

**Architecture:** Keep the existing Kotlin `VpnPlugin` as the Android bridge and add a small app-private JSON store owned by the plugin. The WebView sends only legacy subscription inputs for migration and receives sanitized summaries; raw URLs and parsed private configuration stay native. The first increment does not fetch or parse subscriptions natively and does not alter VPN lifecycle behavior.

**Tech Stack:** Tauri 2 Android plugin, Kotlin, Android `SharedPreferences`/app-private files, React/TypeScript, Vitest or existing frontend test runner, Gradle ARM64 packaging validation.

## Global Constraints

- Work only in `C:\Users\Public\cwdev\cloakwire-android-v131-port`.
- Preserve the verified Android baseline and existing `VpnPlugin`/`CloakwireVpnService` lifecycle.
- Do not add or restore libXray dependencies; sing-box remains the only packaged engine.
- Do not expose provider URLs, UUIDs, credentials, raw configurations, or raw telemetry to logs or summaries.
- Do not commit generated bridge files, APK/AAR outputs, build directories, credentials, or raw subscription fixtures.
- Keep the legacy key exactly `singbox-client.subscriptions.v1` for migration input.

---

### Task 1: Define the Android persistence contract

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/SubscriptionStore.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnPlugin.kt`
- Test: `src-tauri/gen/android/app/src/test/java/ru/classquiz/singbox/vpn/SubscriptionStoreTest.kt`

**Interfaces:**
- `SubscriptionStore(context: Context)` owns an app-private JSON document under `filesDir` and exposes `load()`, `replace(records)`, `upsert(record)`, and `remove(id)`.
- Stored record fields: `id`, `name`, `url`, `intervalMinutes`, `lastFetchedAt`, `lastCount`, `lastErrorKind`; no parsed outbounds or provider payloads in the WebView response.
- `SubscriptionSummary` returned by bridge contains only `id`, `name`, `intervalMinutes`, `lastFetchedAt`, `lastCount`, and safe error kind/message.

- [ ] **Step 1: Write failing unit tests** for empty load, atomic replacement, duplicate-id replacement, removal, malformed-file recovery, and URL redaction from summary serialization.
- [ ] **Step 2: Run the focused Kotlin test and verify failure.**
- [ ] **Step 3: Implement the store with a versioned envelope (`version: 1`, `subscriptions: [...]`), temp-file write plus rename, and safe defaults for malformed data.
- [ ] **Step 4: Run focused tests and verify pass.**
- [ ] **Step 5: Commit** with `feat(android): add native subscription store`.

---

### Task 2: Add migration and safe CRUD commands

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/ru/classquiz/singbox/vpn/VpnPlugin.kt`
- Modify: `src/hooks/useSubscriptions.ts`
- Modify: `src/lib/types.ts`
- Create: `src/lib/mobileSubscriptions.ts`
- Test: `src/lib/mobileSubscriptions.test.ts`

**Interfaces:**
- Kotlin commands: `subscriptionsList`, `subscriptionsMigrateLegacy`, `subscriptionsUpsert`, `subscriptionsRemove`, `subscriptionsSetInterval`.
- Legacy migration input is the parsed array formerly read from `localStorage`: `{ id, name, url, intervalMinutes }[]`.
- Frontend adapter selects native commands only on Android and falls back to existing localStorage behavior on desktop.

- [ ] **Step 1: Add frontend adapter tests** for native-summary mapping, legacy payload validation, and desktop fallback selection.
- [ ] **Step 2: Run the focused frontend test and verify failure.**
- [ ] **Step 3: Implement Kotlin command argument classes, migration de-duplication by id and normalized URL, and safe summaries.
- [ ] **Step 4: Implement `mobileSubscriptions.ts` and update `useSubscriptions` initialization/persistence path so Android first lists native records, then migrates legacy records once, then stops writing subscription data to localStorage.
- [ ] **Step 5: Run frontend tests and TypeScript build.**
- [ ] **Step 6: Commit** with `feat(android): migrate subscriptions to native storage`.

---

### Task 3: Validate Android packaging and regression boundaries

**Files:**
- Modify only if needed: the files from Tasks 1–2
- Test: existing Android unit-test source set and frontend test/build commands

**Interfaces:**
- No new public engine or VPN lifecycle API.
- Existing `prepare`, `start`, `stop`, `status`, `listApps`, `coreVersion`, and `readLogs` behavior remains unchanged.

- [ ] **Step 1: Run frontend unit tests and `npm run build` with `CLOAKWIRE_TEST_MANIFEST=''`.
- [ ] **Step 2: Run Kotlin unit tests for the store and plugin-facing data classes.
- [ ] **Step 3: Run `:app:assembleArm64Release --no-daemon --console=plain -x :app:rustBuildArm64Release`.
- [ ] **Step 4: Verify Git status contains no APK/AAR/build outputs or generated bridge changes.
- [ ] **Step 5: Commit** with `test(android): validate native subscription persistence boundary` if validation-only changes are needed; otherwise record results without a source commit.

---

## Self-review

- The plan intentionally excludes native subscription fetching/parsing, provider metadata parity, reconnect state, and Xray fallback; those are separate increments after this persistence boundary is proven.
- All bridge responses are summaries and do not serialize `url` or private configuration back into the WebView.
- Migration is one-way and idempotent: existing native ids or normalized URLs win, and malformed legacy entries are ignored rather than logged with their contents.
