# Android Home Screen Widgets Design (Toggle & Bento Status Card)

## 1. Goal

Provide Android users with native home screen widgets for Cloakwire in two distinct form factors:
1. **Quick Toggle (1x1 / 2x1)**: Ultra-compact, one-tap VPN connect/disconnect switch with status indicator and active theme accent glow.
2. **Bento Status Card (4x1 / resizable)**: Linear Bento styled card displaying the active server, engine badge, live connection status, real-time session duration (`Chronometer`), and a direct toggle button.

Both widgets operate directly against [`CloakwireVpnService`](file:///C:/Users/Public/cwdev/cloakwire-release-v132/src-tauri/gen/android/app/src/main/java/app/cloakwire/client/vpn/CloakwireVpnService.kt) without opening the WebView, maintaining instant reactivity and zero background battery drain.

---

## 2. Architecture & Subsystems

```
┌────────────────────────────────────────────────────────┐
│                   Android Home Screen                  │
│   ┌───────────────────────────┐   ┌────────────────┐   │
│   │ Bento Card Widget (4x1)   │   │ Toggle (2x1)   │   │
│   └─────────────┬─────────────┘   └────────┬───────┘   │
└─────────────────┼──────────────────────────┼───────────┘
                  │  PendingIntent (Click)   │
                  ▼                          ▼
       ┌───────────────────────────────────────────────┐
       │             CloakwireWidgetReceiver           │
       │       (Handles ACTION_WIDGET_TOGGLE)          │
       └──────────────────────┬────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            │ Is VPN Running?                   │
            ├─────────────────┬─────────────────┤
            │ YES             │ NO              │
            ▼                 ▼                 │
     ACTION_STOP       Check VpnService.prepare │
            │          Check configFile exists  │
            │                 │                 │
            │                 ▼                 │
            │          ACTION_START             │
            │                 │                 │
            └────────┬────────┴─────────────────┘
                     ▼
         ┌────────────────────────┐
         │   CloakwireVpnService  │
         └───────────┬────────────┘
                     │ VpnEvents.update(...)
                     ▼
         ┌────────────────────────┐
         │ CloakwireWidgetUpdater │
         └───────────┬────────────┘
                     │ AppWidgetManager.updateAppWidget
                     ▼
         Both Widgets re-rendered with new RemoteViews
```

### 2.1 Widget Providers & Manifest Registration
Two separate `AppWidgetProvider` classes registered in `AndroidManifest.xml`:
- `app.cloakwire.client.widget.CloakwireToggleWidgetProvider`
  - Meta: `res/xml/widget_toggle_info.xml`
  - Initial Layout: `res/layout/widget_toggle.xml`
  - Default size: 2x1 (120x60dp), resizable horizontally down to 1x1 (60x60dp).
- `app.cloakwire.client.widget.CloakwireCardWidgetProvider`
  - Meta: `res/xml/widget_card_info.xml`
  - Initial Layout: `res/layout/widget_card.xml`
  - Default size: 4x1 (250x60dp), resizable horizontally and vertically.

### 2.2 Shared Widget Updater (`CloakwireWidgetUpdater`)
A centralized Kotlin object responsible for:
1. Reading current state from `VpnEvents.state`, `CloakwireVpnService.activeServerName`, and SharedPreferences (`cloakwire_state`).
2. Constructing `RemoteViews` for both widget types:
   - Power button click: `PendingIntent.getBroadcast(..., ACTION_WIDGET_TOGGLE, ...)`
   - Card body click (Card widget): `PendingIntent.getActivity(..., launchAppIntent, ...)`
   - Session duration: Setting base time on `android.widget.Chronometer` when `VpnEvents.state == STATE_RUNNING` using `VpnEvents.since`.
   - Theme accents: Tinting button borders and status indicators based on active accent (`emerald`, `cyan`, `violet`, `amber`, `rose`).
3. Broadcasting updates to all active widget IDs via `AppWidgetManager.getInstance(context)`.

### 2.3 Service Lifecycle Hooks
In [`VpnEvents.kt`](file:///C:/Users/Public/cwdev/cloakwire-release-v132/src-tauri/gen/android/app/src/main/java/app/cloakwire/client/vpn/VpnEvents.kt), the existing `stateChangeListener` hook already notifies `QuickTileService`. We extend it or notify `CloakwireWidgetUpdater.updateAll(context)` whenever `VpnEvents.update(...)` fires.

---

## 3. Visual & Interaction Specifications

### 3.1 Toggle Widget (`widget_toggle.xml`)
- **Container**: Dark rounded rectangle (`@drawable/widget_bg_card`), 16dp corner radius.
- **Left**: Circular power icon (`@drawable/ic_widget_power`) inside a rounded background (`@drawable/widget_power_btn_bg`).
  - *Disconnected*: Muted gray stroke `#3f3f46`, dark fill.
  - *Connecting*: Animated/accent outline, label "Connecting…".
  - *Connected*: Accent neon ring (matching user's chosen theme), active power symbol.
- **Right** (in 2x1 mode):
  - Primary text: Server name (e.g., "NL Amsterdam") or "Cloakwire".
  - Status indicator: Dot + "Connected" / "Disconnected".

### 3.2 Bento Status Card Widget (`widget_card.xml`)
- **Container**: Linear Bento style panel, dark background `#0c0d12` with subtle border `#27272a`.
- **Left Column**: Tactile power button (48x48dp) with glowing accent boundary and state-reactive power glyph.
- **Center Column**:
  - Top row: Active server label (bold, 14sp, white, truncated).
  - Bottom row: Engine badge (`Xray` / `sing-box`) in a monospace capsule + status label.
- **Right Column**:
  - Live hardware `Chronometer`: Formatted session time (e.g. `01:24:15`), started when VPN becomes active; hidden/reset when disconnected.
  - Connection indicator badge: Filled pill with green/accent online dot.

### 3.3 Tap Actions & Edge Cases
1. **Tap Toggle Button**:
   - If `state == STATE_RUNNING`: Dispatch `ACTION_STOP` to `CloakwireVpnService`. Apply optimistic UI immediately ("Disconnecting…").
   - If `state != STATE_RUNNING`:
     - If `VpnService.prepare(context) != null` (VPN permission missing): Launch `MainActivity` with pending intent so Android shows the system permission prompt.
     - If `CloakwireVpnService.configFile(context)` does not exist: Launch `MainActivity` to prompt the user to choose a server.
     - Else: Dispatch `ACTION_START` with persisted configuration path, engine, server name, and app routing mode. Apply optimistic UI ("Connecting…").
2. **Tap Card Body**:
   - Opens `MainActivity` with `FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_CLEAR_TOP`.
3. **No Battery Drain**:
   - `updatePeriodMillis="0"` in widget provider info XML (no scheduled polling).
   - Updates are triggered purely push-driven on VPN state events and user interaction.

---

## 4. Verification & Testing

1. **Unit / Build Tests**:
   - Gradle Android compilation (`gradlew assembleArm64Debug`).
   - Resource integrity check: XML layouts, drawables, strings, and widget provider infos compile without errors.
2. **On-Device ADB Verification**:
   - Install APK onto connected Android phone (`3B15AV0166300000`).
   - Query widget providers via ADB (`dumpsys appwidget`).
   - Add both widgets to the home screen.
   - Verify toggle action connects/disconnects VPN without opening the app.
   - Verify active server name, engine badge, and session chronometer display properly.
   - Verify tapping card body launches `MainActivity`.
