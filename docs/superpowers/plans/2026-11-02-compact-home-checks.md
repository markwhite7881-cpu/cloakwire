# Compact Home checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox - [ ] syntax for tracking.

**Goal:** Compact Home diagnostics on desktop and Android without changing VPN behavior.
**Architecture:** Reuse ProfileProbeCard and ConnectionStatus with their existing handlers and evidence. Move the Android presentation into the existing hero and remove decorative duplicate status labels.
**Tech Stack:** React, TypeScript, Tailwind, Vitest, Playwright.
**Spec:** docs/superpowers/specs/2026-11-02-compact-home-checks-design.md

## Global Constraints
- Preserve all check scheduling, connection/selection handlers and native code. No dependencies, version bump, release or installation.
- Keep the current Home composition, accent colors and traffic visualization.

## Review Focus
- Stored results must describe the selected source, never another candidate.
- Cancel and retry controls remain usable without restarting the running VPN.
- Russian, English and Chinese results wrap at narrow widths and 200% zoom.
- Missing server metadata must not hide the useful accepted-session name.
- Failure details and runtime recovery actions remain visible and actionable.

### Task 1: Compact Home diagnostics

**Files:** src/mobile/components/ProfileProbeCard.tsx, src/mobile/screens/HomeScreen.tsx, src/components/ConnectionStatus.tsx, src/components/HomeTab.tsx, e2e/compact-home.spec.ts.

**Interfaces:**
- Consumes existing HomeScreen.probeCard, ProfileProbeCard props and ConnectionStatus props.
- Produces the same components and callbacks, with compact presentation only.

- [ ] Add browser coverage for Android hero placement and <=64 px completed-check row, cancellation without VPN starts/stops, failure details, and localized long results at zoom.
- [ ] Run the new Android placement test before implementation and observe failure.
- [ ] Move Android checks into the hero; compact retry controls; remove duplicate active/live badges and the desktop core-running fallback.
- [ ] Run npm test and npm run build, then targeted browser suites including existing server-switch and hourly-check regressions.
- [ ] Review the diff, commit this task and request one read-only whole-change review.
