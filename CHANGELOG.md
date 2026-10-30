# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.8] - 2026-10-30

### English
- Fixed startup of ready-made sing-box subscription profiles when applying local routing, including GeoIP / Bypass RU, on Windows, macOS and Android.
- Preserved the provider's DNS settings when its profile does not contain a DNS server named `local`, preventing `default domain resolver not found: local`.
- Preserved provider routing rules and added regression checks for the merged configuration.

### Русский
- Исправлен запуск готовых профилей подписки sing-box с локальными правилами маршрутизации, включая GeoIP / Bypass RU, на Windows, macOS и Android.
- Сохраняются настройки DNS провайдера, если в профиле нет DNS-сервера с именем `local`. Это устраняет ошибку `default domain resolver not found: local`.
- Сохранены правила маршрутизации провайдера и добавлены проверки итоговой конфигурации.

### 简体中文
- 修复 Windows、macOS 和 Android 上导入的 sing-box 订阅配置在应用本地路由规则（包括 GeoIP / Bypass RU）时无法启动的问题。
- 当订阅配置中没有名为 `local` 的 DNS 服务器时，保留提供商的 DNS 设置，避免出现 `default domain resolver not found: local` 错误。
- 保留提供商的路由规则，并增加合并配置的回归测试。

---

## [1.4.7] - 2026-10-26

### English
- **Reliable per-app routing**: fixed application-based routing on Windows, macOS, and Android. Include/exclude selections are now applied consistently, macOS `.app` names are normalized, and unsupported Xray rules produce an explicit warning.
- **Android routing improvements**: added application icons to the Routing tab and safe handling of selected packages that are no longer installed.
- **Speed Test and notifications**: added a built-in Speed Test tab and native desktop notifications for connection events.

### Русский
- **Стабильный роутинг по приложениям**: исправлена маршрутизация на Windows, macOS и Android. Режимы включения и исключения применяются согласованно, имена `.app` на macOS нормализуются, а для неподдерживаемых правил Xray показывается явное предупреждение.
- **Улучшения роутинга на Android**: добавлены иконки приложений на вкладку «Роутинг» и безопасная обработка удалённых пакетов.
- **Speed Test и уведомления**: добавлены встроенная проверка скорости и нативные уведомления о событиях подключения на десктопе.

### 简体中文
- **可靠的应用分流**：修复了 Windows、macOS 和 Android 上按应用路由的问题。包含与排除规则现在会一致生效，macOS 的 `.app` 名称会被规范化，Xray 不支持的规则会显示明确警告。
- **Android 分流改进**：在“路由”页面添加应用图标，并安全处理已卸载的所选应用。
- **测速与通知**：新增内置 Speed Test 页面和桌面端原生连接事件通知。

---

## [1.4.6] - 2026-10-13

### 🍏 macOS Administrator Privilege Elevation (osascript & SUID)
- **One-Time Administrator Authentication**: Integrated native macOS elevation prompt via `osascript` when starting TUN mode. Users authenticate once (Touch ID or password) to set SUID root (`chown root:wheel && chmod 4755`) on the `sing-box` binary.
- **Passwordless Subsequent Connections**: All future tunnel startups, reconnections, and profile switches launch seamlessly with root privileges without prompting for credentials again.
- **Granular Privilege Checking**: Profiles running in Proxy mode (mixed/socks/http without TUN) bypass elevation entirely. Automatic re-elevation check triggered if the binary is replaced by an updater.

### 🌐 Full Multilingual Localization (EN, RU, ZH)
- **100% Multilingual Coverage**: Completed exhaustive translation audit across all desktop tabs, dialogs, status badges, hero cards, logs, and mobile screens.
- **Typed Zero-Dependency i18n Engine**: Added reactive translation system supporting English (`en`), Russian (`ru`), and Simplified Chinese (`zh-CN`).
- **In-App Language Switcher**: Added dedicated language selectors in Settings across both Desktop and Mobile.

### ☀️ Adaptive Light Theme & Theme Mode Engine
- **Full Light Mode Support**: Added crisp, high-contrast light theme with carefully tuned contrast, border definitions, and readable typography across all views.
- **Adaptive ThemeMode Engine**: Full support for `system` (auto-detect OS preference), `light`, `dark`, and `oled` pitch-black modes.
- **Theme Mode Switchers**: Integrated quick theme mode selectors in Desktop and Mobile Settings.

### 📱 Android Home Screen Widgets & Mobile Enhancements
- **Interactive VPN Toggle Widget**: One-tap home screen connection toggle reflecting live VPN status and synchronized with app accent colors.
- **Minimal 1x1 Power Button Widget**: Compact 1x1 widget layout for space-efficient home screen layouts.
- **System Synchronization**: Wired `VpnEvents` state notifications, auto-grant permissions, and fixed Android clipboard paste handling.

### 🧹 UI & UX Simplification
- **Removed Hero Redundancy**: Removed "Secure connection" / "Ваш интернет-трафик надежно защищен и зашифрован" banner and shield footer for a cleaner, modern look.
- **Removed Obsolete Leak Diagnostics**: Streamlined Settings by eliminating redundant firewall reset and leak diagnostics cards.
- **Server Subtitle Polish**: Removed duplicate subtitle descriptions across connection cards.

---

### Русская версия (кратко)
- **Запрос прав администратора на macOS (osascript)**: однократный нативный запрос прав (Touch ID / пароль) для установки SUID root на бинарник `sing-box`. Все последующие подключения в режиме TUN запускаются мгновенно без повторного ввода пароля.
- **Полная локализация (Русский, Английский, Китайский)**: 100% перевод всех экранов, вкладок, бейджей и диалогов на десктопе и мобильных устройствах. Переключатель языка в настройках.
- **Светлая тема и адаптивный движок тем**: полноценная поддержка светлой, тёмной, системной и OLED-тем с переключателем в настройках.
- **Виджеты для Android**: интерактивный виджет переключения VPN на рабочем столе с индикацией статуса и синхронизацией акцентного цвета.
- **Упрощение интерфейса**: удалены избыточные плашки и устаревший блок диагностики утечек.

---

## [1.4.5] - 2026-10-08

### 🎨 Custom Accent Themes & OLED Mode (Desktop & Mobile)
- **Dynamic Accent Themes**: Full palette customization (Emerald, Cyan, Violet, Amber, Rose) dynamically controlling UI glow, active tabs, buttons, latency badges, and section accents across Desktop and Mobile.
- **Deep OLED Pitch-Black Mode**: High-contrast pure black (`#000000`) theme optimized for AMOLED/OLED mobile displays and dark desktop workflows.
- **Instant CSS Variable Reactivity**: Real-time theme application with CSS variables (`--theme-accent`, `--theme-glow`, `--theme-subtle`) updating all interactive components instantly without reload.

### ✨ Neon Breathing & Connection Pulse Animation
- **Connection Glow Pulse**: Added living neon breathing effect (`connect-glow-pulse`) to the primary Connect/Disconnect button reflecting live VPN state.
- **Smooth State Transitions**: Fluid visual transitions between idle, connecting, and active tunnel states.

### ⚡ System Tray Quick Menu (Desktop)
- **Tray Quick Controls**: Native desktop system tray menu with one-click Connect / Disconnect toggle, active connection status indicators, and background app control.

### ⏱️ Session Timer & Statistics
- **Live Elapsed Timer**: Integrated real-time session duration counter (`useSessionTimer`) tracking active connection time.
- **Enhanced Data Metrics**: Clean, formatted throughput and connection statistics with modern monospace typography.

### 🖌️ UI Refinements & Polish
- Added dedicated Server icon to the Custom Servers section header on the Servers tab.
- Dynamically tinted Accent Theme palette icon in Settings.
- Unified accent badges and cards across desktop and mobile views.

---

### Русская версия (кратко)
- **Цветовые акцентные темы и OLED-режим**: 5 акцентных палитр (Emerald, Cyan, Violet, Amber, Rose) с полной адаптацией интерфейса на Windows, macOS и Android, а также глубокий черный OLED-режим.
- **Неоновое «дыхание» и анимация кнопки**: живое пульсирующее свечение в такт активному состоянию соединения.
- **Быстрое меню в системном трее**: управление подключением и статус прямо из области уведомлений.
- **Таймер сессии и статистика**: точный учет времени работы туннеля и отображение статистики сессии.
- **Косметические улучшения**: иконка для раздела Custom Servers, динамическая окраска иконки палитры в настройках.

---

## [1.4.4] - 2026-10-07

### 📱 Android Network Teardown & Routing Fixes
- **TUN Kernel File Descriptor Leak Remediation (`CloakwirePlatform.kt`)**:
  - Eliminated duplicate file descriptor creation (`pfd.dup()` and `detachFd()`) in libbox TUN setup. The service now directly passes and owns the single `ParcelFileDescriptor`, allowing the Linux kernel to drop device refcounts to zero upon disconnect.
  - Prevents zombie TUN interfaces (`tun0..tun3`) and stale netd routing rules from blackholing application traffic (such as Ozon and Russian localized services) after VPN shutdown.
- **Socket & Network State Reset (`CloakwireVpnService.kt`)**:
  - Added explicit `setUnderlyingNetworks(null)` during session teardown to signal Android ConnectivityService to terminate half-open sockets and re-route traffic directly.
  - Hardened lifecycle cleanup on `onTaskRemoved` and app swipe-out with orphan Xray process killing.

### 🖥️ Desktop UI & Core Decoupling
- **Streamlined Servers Tab (`ServersTab.tsx`)**:
  - Filtered the main server list to exclusively display user-added manual servers, eliminating performance lag and UI bloat from hundreds of subscription nodes (managed via the Subscriptions section).
- **Core Update Decoupling (`UpdateCard.tsx` & `src-tauri/src/updates.rs`)**:
  - Disabled external GitHub update polling for sing-box core binaries; verified and stable cores are now bundled exclusively with application releases.
- **Xray System Proxy Stability (`src-tauri/src/process.rs`)**:
  - Restored stable system proxy switching logic with WinINet registry cleanup upon disconnect.

---

## [1.4.3] - 2026-08-31

### 🚀 Subscription List Collapse Persistence & Auto-Updater Prompt
- **📂 Persistent Subscription Collapse State (Desktop & Mobile)**:
  - Defaulted subscription server lists to collapsed across Desktop (`HomeTab`) and Mobile (`HomeScreen` & `ServersScreen`).
  - Saved expanded/collapsed subscription states to `localStorage` (`cloakwire:desktop_expanded_subscriptions` / `cloakwire:mobile_expanded_blocks`) so group states are preserved across tab switching and app restarts.
- **✨ In-App Startup Update Notification (`UpdateModal`)**:
  - Integrated automated background update check on application startup.
  - Added Linear Bento update dialog with version diff, release notes, **«Обновить»** (one-click install), and **«Позже»** (session dismiss).
  - Multi-platform update manifest and Minisign signature support across Windows, macOS, and Android.

---

## [1.4.2] - 2026-08-30

### 🪟 Windows Networking & Process Cleanup
- **⚡ Dynamic WinINet Proxy Change Broadcast (`src-tauri/src/process.rs`)**:
  - Implemented dynamic loading and invocation of Windows WinINet API `InternetSetOptionW` with `INTERNET_OPTION_SETTINGS_CHANGED` (39) and `INTERNET_OPTION_REFRESH` (37) on proxy enable and clear.
  - Automatically notifies running applications (Steam, Chromium, game engines, browsers) immediately upon VPN disconnect, preventing connection drops and cached proxy stall.
- **🧹 Registry `ProxyServer` Residue Cleanup**:
  - Explicitly resets and clears the `ProxyServer` string value in `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` on VPN termination, preventing games from attempting connections to closed loopback ports.

---

## [1.4.1] - 2026-08-29

### 🛡️ Security Vulnerabilities Remediated & Hardening
- **🔒 Auto-Updater TOCTOU Mitigation (`src-tauri/src/app_update.rs`)**:
  - Moved installer staging from public `/tmp/cloakwire-update/` to private user application cache (`app.path().app_cache_dir().join("updates")`).
  - Enforced strict permissions on directories and staged update binaries, preventing local package tampering before execution.
- **🔐 Secure Runtime Configuration Storage (`src-tauri/src/commands.rs`)**:
  - Staged sing-box and Xray runtime configuration files (`config.managed.json`) with UUID paths inside private user cache (`app_cache_dir().join("cloakwire-runtime")`).
  - Enforced strict `0600` POSIX file permissions to protect embedded credentials and Reality private keys from unprivileged local readers.
- **🌐 Subscription Inbound & Clash API Sanitization (`src-tauri/src/subscriptions/classify.rs`)**:
  - Implemented `sanitize_bundle_config()` which enforces `listen: "127.0.0.1"` on all socket-based inbounds (`mixed`, `socks`, `http`, `tproxy`) to prevent external LAN exposure.
  - Restricted `clash_api.external_controller` strictly to loopback `127.0.0.1:<port>`.
- **⚡ Latency Ping Concurrency Throttling & DoS Protection (`src/hooks/useServerLatency.ts` & `classify.rs`)**:
  - Replaced unconstrained `Promise.allSettled` ping sweeps with 12-socket batch concurrency.
  - Capped background latency probing to the first 100 profiles and imposed a 500-profile maximum import limit per subscription to prevent socket exhaustion.
- **🔗 Supply Chain Reproducibility & Lockfile Pinning (`Cargo.lock`, `.github/workflows/release-android.yml`)**:
  - Unignored and committed `src-tauri/Cargo.lock` to guarantee reproducible deterministic dependency resolution.
  - Pinned `Leadaxe/sing-box-lx` repository clone in Android CI/CD workflow to verified commit hash `ff40cf98cb80ca6c9e9ae823ad392045cb4d23de`.

---

## [1.4.0] - 2026-08-29

### 🎨 Linear Bento UI Redesign (Desktop & Mobile)
- **Unified Linear Bento Design**: Completely overhauled layout with sleek, dark tactile bento cards, emerald neon glow accents, and responsive typography across both desktop and mobile platforms.
- **60 FPS Live Traffic & Speed Wave**: Re-engineered real-time throughput chart with smooth sub-second interpolation, real-time download/upload speed counters (KB/s, MB/s), and cumulative bandwidth tracking.
- **Hero Tactile Power Orb**: Redesigned central connection button with smooth pulse glow animations, state transition spinners, and tactile haptic feedback.
- **Adaptive Window Sizing**: Fixed desktop window geometry to maintain optimal aspect ratio without redundant empty space.

### ⚡ Server Management & Quick Switcher
- **Instant Server Switcher**: Change active servers directly from the Home Screen with live latency badges without navigating to secondary tabs.
- **Inline Quick Add (+)**: Direct import modal on the main dashboard for pasting VLESS/Shadowsocks/Trojan links or subscription URLs.
- **Smart Clipboard**: Automatically detects VPN share links (`vless://`, `vmess://`, `ss://`, `trojan://`, `tuic://`, `hy2://`, `http://`, `https://`) from clipboard on open and offers 1-tap paste.
- **Automated Ping Updates**: Instant latency calculation with color-coded speed badges (green < 100ms, amber < 250ms, rose > 250ms).

### 📱 Android Experience & Haptics
- **Haptic Vibration Feedback**: Tactile feedback on Power button toggle, server switcher selection, and mode changes.
- **Rich Status Notifications**: Informative ongoing notification displaying connected server name, active core engine (`sing-box` / `Xray`), and quick Disconnect action.
- **Quick Settings Tile**: Android quick tile integration with live connection toggle and server indicator.

### 🛡️ Core Engine & Network Fixes
- **sing-box DNS Hijacking**: Added strict port 53 DNS hijacking (`hijack-dns`) and direct LAN routing (`ip_is_private: true`), resolving DNS resolution timeouts on Android.
- **IPv6 Blackhole Prevention**: Optimized Android TUN interface to avoid IPv6 routing loops when connecting to IPv4-only VPS endpoints.
- **sing-box In-Process Monitoring**: Connected `libbox.CommandClient` to stream real-time throughput statistics directly from the Go network stack.

---

## [1.3.2] - 2026-08-22
- Multi-architecture Android build support (arm64-v8a).
- Initial Xray sidecar integration with hev-socks5-tunnel.
- Split-tunneling per-app routing support.
