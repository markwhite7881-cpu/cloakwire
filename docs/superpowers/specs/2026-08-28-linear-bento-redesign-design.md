# Design Specification: Linear Bento Redesign for Cloakwire

**Date:** 2026-08-28  
**Topic:** Complete Desktop UI Redesign based on "Linear Bento" aesthetic  
**Author:** Pair Programming Agent & User  
**Status:** Validated Design Spec  

---

## 1. Goal & Philosophy

Transform Cloakwire into the most visually stunning, tactile, and intuitive VPN client on the market while preserving 100% of its existing capabilities, stability, and backend logic.

### Design Principles:
1. **Linear & Raycast Precision:** Deep obsidian matte background (`#09090b`), razor-thin 1px borders (`#27272a`), crisp Inter typography, and structured Bento Grid cards.
2. **Tactile Feedback & Live Metrics:** A prominent circular power orb with soft emerald ambient backlight, animated SVG sparkline waves for throughput, and latency pills.
3. **Zero Functionality Loss:** All existing capabilities (dual-engine sing-box/Xray, subscriptions, per-app routing with `find_process: true`, TUN/System proxy, DNS settings, logs, auto-updater) remain fully functional and integrated.
4. **Brand Continuity:** Preserve existing application icon and logo glyph.

---

## 2. Visual Architecture & Design System

### 2.1 Color Palette & Design Tokens
```css
--bg-canvas: #08090b;       /* Deep matte obsidian */
--bg-surface-1: #0c0e12;     /* Card background top gradient */
--bg-surface-2: #08090c;     /* Card background bottom gradient */
--border-subtle: #27272a;    /* 1px subtle card border */
--border-highlight: rgba(255, 255, 255, 0.08); /* 0.5px top light catcher */
--accent-emerald: #10b981;   /* Active VPN green / glow */
--accent-cyan: #06b6d4;      /* Upload / secondary telemetry */
--accent-amber: #f59e0b;     /* Reconnecting / Warning */
--text-primary: #f4f4f5;     /* High contrast zinc-100 */
--text-muted: #71717a;       /* Monospace tags / labels */
```

### 2.2 Component Hierarchy
- **Header:** Window drag area, official Cloakwire logo + version pill, segmented floating pill navigation (`Home`, `Servers`, `Routing`, `Config`, `Logs`), and live `Protected` status badge.
- **Home (Bento Grid):**
  - **Module 1 (Primary Hero):** Active server name, country flag, protocol badge (`VLESS • Reality`), center tactile orb button with pulsing emerald glow, and quick-switch server chips.
  - **Module 2 (Live Traffic Stream):** Large download/upload rate counters, session totals, and dual smooth SVG sparkline waves.
  - **Module 3 (Per-App Routing Snapshot):** Instant view of apps running via VPN vs Direct with quick management shortcut.
  - **Module 4 (Session Footer):** Uptime counter, active IP, core engine (`sing-box` / `Xray`), and TUN interface indicator.
- **Servers Tab:** Bento cards per subscription, categorized list of profiles with country flags, latency badges, and instant connect buttons.
- **Routing Tab:** Clean app picker with running processes, search filter, and split-tunnel rules.
- **Config Tab:** Segmented mode switcher (TUN / System Proxy / Both / None), DNS configuration, and binary diagnostics.
- **Logs Tab:** Dark terminal-style log viewer with auto-scroll and severity tags.

---

## 3. Implementation Verification & Deliverables
1. **Frontend Tests:** Ensure all existing React unit tests (`npm test` / Vitest) continue to pass.
2. **Backend Tests:** Run `cargo test --lib` in `src-tauri`.
3. **Local Windows Build:** Compile full release package with `npm run tauri:build` for user testing.
