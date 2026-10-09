# Android Home Screen Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement two native Android home screen widgets (Quick Toggle 1x1/2x1 and Bento Status Card 4x1/resizable) for instant VPN control, status feedback, and session duration tracking directly from the launcher.

**Architecture:** Two `AppWidgetProvider` classes registered in `AndroidManifest.xml` backed by a shared `CloakwireWidgetUpdater` that constructs `RemoteViews` reflecting live `VpnEvents.state` and server metadata. A broadcast receiver `CloakwireWidgetReceiver` handles `ACTION_WIDGET_TOGGLE`, triggering `CloakwireVpnService.ACTION_START` or `ACTION_STOP` without opening the app window.

**Tech Stack:** Kotlin, Android RemoteViews, AppWidgetProvider, Chronometer, Vector Drawables, Gradle, ADB.

**Spec:** [2026-10-09-android-home-widgets-design.md](file:///C:/Users/Public/cwdev/cloakwire-release-v132/docs/superpowers/specs/2026-10-09-android-home-widgets-design.md)

## Global Constraints

- Android `minSdk = 24`, `targetSdk = 36`.
- Zero background polling: widget updates must be strictly event-driven via `VpnEvents`.
- Seamless fallback: if VPN permission is missing (`VpnService.prepare != null`) or no config exists, clicking connect must open `MainActivity`.
- Visual styling must adhere to Cloakwire's Linear Bento design: dark palette `#0c0d12`, subtle border `#27272a`, and clean typography.

---

### Task 1: Android Widget Resources & Layouts

**Files:**
- Create: `src-tauri/gen/android/app/src/main/res/drawable/widget_bg_card.xml`
- Create: `src-tauri/gen/android/app/src/main/res/drawable/widget_power_btn_bg.xml`
- Create: `src-tauri/gen/android/app/src/main/res/drawable/widget_badge_bg.xml`
- Create: `src-tauri/gen/android/app/src/main/res/drawable/ic_widget_power.xml`
- Create: `src-tauri/gen/android/app/src/main/res/layout/widget_toggle.xml`
- Create: `src-tauri/gen/android/app/src/main/res/layout/widget_card.xml`
- Create: `src-tauri/gen/android/app/src/main/res/xml/widget_toggle_info.xml`
- Create: `src-tauri/gen/android/app/src/main/res/xml/widget_card_info.xml`
- Modify: `src-tauri/gen/android/app/src/main/res/values/strings.xml`

**Interfaces:**
- Produces: Layout IDs `R.layout.widget_toggle`, `R.layout.widget_card`, View IDs (`widget_btn_power`, `widget_text_server`, `widget_text_status`, `widget_chronometer`, `widget_badge_engine`), and AppWidgetProviderInfo XML definitions.

- [ ] **Step 1: Create drawables and backgrounds**
  - Create `widget_bg_card.xml`: Dark rounded background (`#0c0d12`), stroke `#27272a` (1dp), corner radius 16dp.
  - Create `widget_power_btn_bg.xml`: Circle background with dark fill (`#18181b`) and subtle stroke (`#3f3f46`).
  - Create `widget_badge_bg.xml`: Monospace pill badge background (`#18181b`) with corner radius 4dp and stroke `#27272a`.
  - Create `ic_widget_power.xml`: Vector icon representing the power/toggle glyph.

- [ ] **Step 2: Create layouts `widget_toggle.xml` and `widget_card.xml`**
  - `widget_toggle.xml`: Minimal container with `widget_btn_power`, `widget_text_server`, and `widget_text_status`.
  - `widget_card.xml`: Bento-grid horizontal layout containing `widget_btn_power` (left), `widget_text_server` + `widget_badge_engine` + `widget_text_status` (center), and `widget_chronometer` + status dot (right).

- [ ] **Step 3: Create AppWidgetProviderInfo XMLs & strings**
  - Add string definitions `widget_toggle_name` ("Cloakwire Toggle"), `widget_card_name` ("Cloakwire Card") to `strings.xml`.
  - Create `res/xml/widget_toggle_info.xml` with `targetCellWidth="2"`, `targetCellHeight="1"`, `updatePeriodMillis="0"`, `resizeMode="horizontal"`.
  - Create `res/xml/widget_card_info.xml` with `targetCellWidth="4"`, `targetCellHeight="1"`, `updatePeriodMillis="0"`, `resizeMode="horizontal|vertical"`.

- [ ] **Step 4: Commit Task 1**
  - `git add src-tauri/gen/android/app/src/main/res/`
  - `git commit -m "feat(android): add widget layouts, drawables, and provider metadata"`

---

### Task 2: Widget Providers & Shared Updater Implementation

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/app/cloakwire/client/widget/CloakwireWidgetUpdater.kt`
- Create: `src-tauri/gen/android/app/src/main/java/app/cloakwire/client/widget/CloakwireToggleWidgetProvider.kt`
- Create: `src-tauri/gen/android/app/src/main/java/app/cloakwire/client/widget/CloakwireCardWidgetProvider.kt`
- Create: `src-tauri/gen/android/app/src/main/java/app/cloakwire/client/widget/CloakwireWidgetReceiver.kt`

**Interfaces:**
- Consumes: `VpnEvents.state`, `VpnEvents.since`, `CloakwireVpnService.activeServerName`, `CloakwireVpnService.configFile`.
- Produces: `CloakwireWidgetUpdater.updateAllWidgets(context: Context)` which triggers `AppWidgetManager.updateAppWidget` for all instances of `CloakwireToggleWidgetProvider` and `CloakwireCardWidgetProvider`.

- [ ] **Step 1: Implement `CloakwireWidgetReceiver`**
  - Broadcast receiver handling action `app.cloakwire.client.ACTION_WIDGET_TOGGLE`.
  - If `VpnEvents.state == VpnEvents.STATE_RUNNING`: Dispatch `CloakwireVpnService.ACTION_STOP` to service.
  - If stopped:
    - If `VpnService.prepare(context) != null` or config file missing: launch `MainActivity`.
    - Else: Dispatch `CloakwireVpnService.ACTION_START` with stored `last_engine`, `last_server_name`, `last_apps`, `last_apps_mode`.
  - Call `CloakwireWidgetUpdater.updateAllWidgets(context)` immediately for responsive UI.

- [ ] **Step 2: Implement `CloakwireWidgetUpdater`**
  - Construct `RemoteViews` for `widget_toggle` and `widget_card`:
    - Bind `widget_btn_power` click to `PendingIntent.getBroadcast(..., ACTION_WIDGET_TOGGLE, ...)`.
    - Bind card container click (in Card widget) to `PendingIntent.getActivity(..., launchAppIntent, ...)`.
    - Set server title from `CloakwireVpnService.activeServerName` or SharedPreferences `last_server_name`.
    - Set engine badge (`Xray` / `sing-box`).
    - If running: configure and start `Chronometer` (`setBase(SystemClock.elapsedRealtime() - elapsed)` and `start()`), set status text to "Connected" with accent green color.
    - If stopped: stop `Chronometer` (`stop()`), set status text to "Disconnected" with muted color.

- [ ] **Step 3: Implement `CloakwireToggleWidgetProvider` and `CloakwireCardWidgetProvider`**
  - Override `onUpdate(context, appWidgetManager, appWidgetIds)` to delegate directly to `CloakwireWidgetUpdater.updateAllWidgets(context)`.

- [ ] **Step 4: Commit Task 2**
  - `git add src-tauri/gen/android/app/src/main/java/app/cloakwire/client/widget/`
  - `git commit -m "feat(android): implement widget providers, receiver, and shared remoteviews updater"`

---

### Task 3: Manifest Registration & VpnEvents Wiring

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- Modify: `src-tauri/gen/android/app/src/main/java/app/cloakwire/client/vpn/CloakwireVpnService.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/app/cloakwire/client/vpn/VpnEvents.kt`

**Interfaces:**
- Connects `VpnEvents.update(...)` to `CloakwireWidgetUpdater.updateAllWidgets(context)`.
- Declares widget receivers in AndroidManifest.

- [ ] **Step 1: Register receivers in `AndroidManifest.xml`**
  - Declare `<receiver android:name="app.cloakwire.client.widget.CloakwireToggleWidgetProvider" ...>` with `android.appwidget.action.APPWIDGET_UPDATE` intent-filter.
  - Declare `<receiver android:name="app.cloakwire.client.widget.CloakwireCardWidgetProvider" ...>` with `android.appwidget.action.APPWIDGET_UPDATE` intent-filter.
  - Declare `<receiver android:name="app.cloakwire.client.widget.CloakwireWidgetReceiver" android:exported="false">` with `app.cloakwire.client.ACTION_WIDGET_TOGGLE`.

- [ ] **Step 2: Connect state notifications in `CloakwireVpnService` / `VpnEvents`**
  - In `CloakwireVpnService.onCreate()` or when `VpnEvents` updates state, trigger `CloakwireWidgetUpdater.updateAllWidgets(this)`.
  - Ensure on service destruction or disconnect, `CloakwireWidgetUpdater.updateAllWidgets(this)` updates widgets to stopped state.

- [ ] **Step 3: Commit Task 3**
  - `git add src-tauri/gen/android/app/src/main/AndroidManifest.xml src-tauri/gen/android/app/src/main/java/`
  - `git commit -m "feat(android): register widgets in manifest and wire vpnevents state notifications"`

---

### Task 4: Compilation, Deployment & On-Device ADB Verification

**Files:**
- Output: `dist-release/Cloakwire_1.4.5_arm64-v8a.apk`
- Device: Connected Android phone `3B15AV0166300000`

- [ ] **Step 1: Rebuild Android APK with Gradle**
  - Run `gradlew.bat assembleArm64Debug -x rustBuildArm64Debug --no-daemon`.
  - Verify clean compilation with 0 errors.

- [ ] **Step 2: Install APK onto connected Android phone**
  - Execute `adb -s 3B15AV0166300000 install -r <apkPath>`.
  - Restart app: `am force-stop` followed by `am start`.

- [ ] **Step 3: Verify widget providers via ADB**
  - Run `adb shell dumpsys appwidget` to verify `CloakwireToggleWidgetProvider` and `CloakwireCardWidgetProvider` are recognized by system launcher.
  - Verify widgets can be bound and updated.

- [ ] **Step 4: Commit Task 4**
  - `git commit --allow-empty -m "chore(release): verify android home widgets build and installation"`
