# Linear Bento Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete visual redesign of the Cloakwire desktop client based on the "Linear Bento" aesthetic while preserving 100% of existing functionality, backend logic, and brand assets.

**Architecture:** Modernize the presentation layer with deep obsidian Bento Grid cards, tactile glowing connect orb, live SVG throughput sparklines, and unified design tokens in Tailwind CSS while keeping all IPC hooks, subscriptions, dual-engine routing, and platform logic untouched.

**Tech Stack:** React 18, TypeScript 5, Tailwind CSS 3, Lucide React, Tauri 2, sing-box & Xray sidecars.

**Spec:** `docs/superpowers/specs/2026-08-28-linear-bento-redesign-design.md`

## Global Constraints
- Preserve all existing functionality: dual-engine switching (sing-box/Xray), subscription management, auto-reconnect, per-app routing, custom DNS, and logs.
- Do NOT modify the official logo (`src-tauri/icons/icon.png` and logo assets).
- Maintain 100% test passing rate across `vitest run` and `cargo test --lib`.
- Build complete Windows release artifact locally for personal testing before touching other platforms.

---

### Task 1: Design Tokens & Base Theme Styling
**Files:**
- Modify: `src/index.css`
- Modify: `src/lib/types.ts`

- [ ] **Step 1:** Update CSS custom properties for deep obsidian palette (`#09090b`), surface gradients, 1px borders (`#27272a`), emerald glow utilities (`.glow-emerald`, `.glow-button`), and sparkline styling.
- [ ] **Step 2:** Run `npm run build` to ensure CSS compiles cleanly.

---

### Task 2: Header & Top Navigation Bar
**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/Tabs.tsx`
- Modify: `src/components/StatusPill.tsx`

- [ ] **Step 1:** Redesign `Tabs.tsx` into a segmented floating pill capsule with smooth active background transitions and server count badges.
- [ ] **Step 2:** Redesign the top brand bar in `App.tsx` with official logo, version tag, active protection pulse, and engine info.
- [ ] **Step 3:** Verify header layout in `npm run build`.

---

### Task 3: Home Tab Bento Grid Layout
**Files:**
- Modify: `src/components/HomeTab.tsx`
- Modify: `src/components/TrafficCard.tsx`
- Modify: `src/components/ProfileCard.tsx`

- [ ] **Step 1:** Reorganize `HomeTab.tsx` into a 12-column Bento Grid.
- [ ] **Step 2:** Implement Hero Connect Card with large tactile power button, ambient emerald halo, active country flag/tag, protocol badge, and quick-switch chips.
- [ ] **Step 3:** Implement Live Throughput Bento Card with download/upload rates, session data total, and dual SVG sparkline waves.
- [ ] **Step 4:** Implement Per-App Routing Snapshot Card showing active split-tunnel apps and direct link to routing tab.
- [ ] **Step 5:** Run existing unit tests `npm test` to verify no regressions in `HomeTab.test.tsx`.

---

### Task 4: Servers, Routing, Config, and Logs Tabs Modernization
**Files:**
- Modify: `src/components/ServersTab.tsx`
- Modify: `src/components/SubscriptionsCard.tsx`
- Modify: `src/components/routing/RoutingTab.tsx`
- Modify: `src/components/ConfigTab.tsx`
- Modify: `src/components/LogsTab.tsx`

- [ ] **Step 1:** Modernize `ServersTab.tsx` and subscription cards with Bento borders, latency badges, and quick-action buttons.
- [ ] **Step 2:** Modernize `RoutingTab.tsx` with clear app cards, running process badges, and refined Advanced drawer.
- [ ] **Step 3:** Modernize `ConfigTab.tsx` and `LogsTab.tsx` with matching design tokens and dark terminal viewer.
- [ ] **Step 4:** Run `npm test` to verify all frontend component tests pass.

---

### Task 5: Verification & Local Windows Release Build
**Files:**
- Build outputs: `src-tauri/target/release/cloakwire.exe`, `src-tauri/target/release/bundle/nsis/Cloakwire_1.3.2_x64-setup.exe`

- [ ] **Step 1:** Run full TypeScript checks: `npm run build`.
- [ ] **Step 2:** Run all unit tests: `npm test` and `cargo test --lib`.
- [ ] **Step 3:** Run `npm run tauri:build` on Windows.
- [ ] **Step 4:** Copy the compiled Windows installer to the Desktop for testing.
