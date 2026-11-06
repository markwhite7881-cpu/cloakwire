# Routing application and independent direct DNS

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. Independent DNS work may use dispatching-parallel-agents.

**Goal:** Prevent settings accepted during an in-flight connection from being silently treated as applied, and preserve Windows direct application connectivity when the VPN DNS path fails.

**Architecture:** Track a connection-settings revision at the UI/native handoff. Only acknowledge the revision actually submitted after successful native acceptance. Select local or remote DNS using the application's effective route, preserving VPN DNS privacy and explicit DNS rules.

**Tech Stack:** React/TypeScript, Playwright/Vitest, Rust config generation, bundled sing-box.

**Spec:** User request of 2026-11-06 and reproductions in deep-routing/state/race-results.json and deep-routing/desktop/loopback-results.json in this chat's visualization directory.

## Global constraints

- Fix Windows and Android settings application, including first connection and reconnect.
- Limit DNS changes to Windows sing-box; preserve macOS, Android and Xray behavior.
- Preserve provider DNS sections and relative rule order for ordinary traffic; explicit local application routing takes precedence over provider catch-all resolver routing. Preserve manual/ready profile behavior and failed-replacement safety.
- Do not restart or reconfigure the installed VPN during automated checks.
- No release, version bump or publication is requested.

## Review focus

- Settings edited after a connection starts must retain the pending reconnect notice.
- Successful reconnect without intervening edits must clear the notice.
- Failed or cancelled replacement must not acknowledge pending edits or stop an accepted session.
- Only selected, except selected and all applications must retain correct direct/proxy DNS separation.
- Ready profiles, custom rules, IPv6 blocking and empty process lists must not silently broaden direct DNS.

## Task 1 — Windows DNS independence

Files: src-tauri/src/config/mod.rs and its tests; selected ready-profile policy only if needed; local native regression script.

- [x] Add generator regressions proving direct application DNS uses local resolution while VPN DNS uses the proxy resolver. Run and observe failure.
- [x] Implement process-aware Windows DNS selection with minimal changes. Honor rule precedence and preserve other platforms.
- [x] Run generator and relevant native tests, then repeat the actual bundled-core loopback scenario with proxy unavailable, fresh/cached DNS and direct HTTP.

## Task 2 — Revision-safe routing application

Files: src/App.tsx, src/mobile/MobileApp.tsx, src/mobile/useVpnConnection.ts, e2e/fixtures.ts and a focused routing application regression spec.

- [x] Turn the existing four race reproductions into assertions for the correct pending notice, and add initial-connect, clean reconnect, failure and retry cases. Observe failing assertions before changing production code.
- [x] Capture an edit revision for each connection attempt. Acknowledge only that revision on successful handoff. Remove unconditional pending-state clearing in reconnect wrappers.
- [x] Run routing, reconnect, ownership and error-card browser regressions plus the full frontend unit suite and production build.

## Task 3 — Integrated verification and review

- [x] Independently review both changes for policy/privacy regressions and stale status handling.
- [x] Run full frontend unit/browser suites, Rust tests using available build caches and native DNS regression. Record environmental blockers accurately.
- [x] Verify installed processes and repository diff, preserve user data, and report verified behavior and remaining device-testing limits.

## Execution record

- Baseline: 207 frontend tests pass. Existing AppearanceSelect server-render useLayoutEffect warnings are present before changes.
- Existing linked worktree reused. Changes are on fix/routing-application-and-dns from cc2baef, release branch preserved.
- Ruling: proceed under the user's explicit autonomous implementation request without a separate plan approval round.
- Routing RED: eight initial-connect/reconnect races fail at the missing pending notice; two clean controls pass. GREEN: all ten pass after the fix.
- Expanded routing verification adds both ready-profile engines, native failure/retry and the desktop Stop window. All fifteen applicable cases pass in the first complete browser run.
- Independent UI review found no demonstrated regressions. Failure/permission paths do not acknowledge configuration; out-of-order acknowledgments remain a potential unnecessary-notice edge case, not a demonstrated loss of pending changes.
- First full browser run: 131 passed, 50 platform skips, one failure in profile-actions subscription-refresh test. Its expectation predates the 1.5.1 collapsed subscriptions panel. The regression now opens the existing Edit control before asserting the updated child and still asserts zero starts/stops.
- Frontend verification: 207 unit tests pass; TypeScript and production Vite build pass. Existing SSR useLayoutEffect and bundle-size/dynamic-import warnings remain.
- Ruling: shared Windows DNS Client requests use local DNS when explicit direct-process exclusions exist, after explicit process/domain policy. This makes excluded apps independent of VPN availability, but queries from VPN apps using that same Windows service are also local. Positively attributed VPN DNS never falls back to local. All-applications mode without exceptions is unchanged.
- Native Rust verification excludes process, killswitch and diagnostics lifecycle tests that can mutate workstation networking; those require a dedicated runner.
- Android phone disconnected during implementation; automated mobile browser coverage uses actual React logic with native boundaries replaced, not a device VPN test.
- Independent DNS review identified a ready-profile bootstrap cycle when a hostname proxy had no explicit domain resolver. Add a local bootstrap resolver only where no explicit provider resolver exists, with a separate failing/passing native regression.
- Ruling: explicit application DNS decisions precede provider catch-all transport/fake-IP rules, matching local application route precedence. Otherwise a provider catch-all would silently retain the original dependency for excluded applications. Preserve provider rule order for remaining traffic.
- Ruling: place the Windows shared-client availability decision before conservative synthetic barriers for unprojectable connection IP/port rules, after representable explicit VPN process/domain decisions. Explicit VPN DNS-domain restrictions can intentionally remain dependent on the VPN.
- Full browser rerun: 132 passed, 50 platform skips, zero failures. Additional mobile permission/cancellation/replacement suite: five passed, including preservation of a pending choice across native cancellation and successful retry.
- Ruling: retain the complete provider DNS rule block in its original order behind local overrides; arbitrary partitioning would break evaluate/respond dependencies. All-VPN ready profiles without local overrides preserve provider DNS rather than inferring DNS intent from Rust/UI default-value differences.
- Final native evidence: safe Rust library suite 353 passed, 16 ignored, 32 safety exclusions; actual bundled-core matrix 18/18 passed. Independent root replay passed generated direct default, ready fake-IP direct exclusion and ready hostname-proxy VPN-only DNS cases.
- Final independent UI/DNS reviews have no outstanding must-fix findings. Root rechecked npm test (207 passing), production build and git diff --check after implementation. Installed CloakWire/core PIDs remain 6324/12008 and system proxy remains disabled.
- Integration ruling: preserve the verified changes on fix/routing-application-and-dns in the existing worktree. No release, publication or installed-app replacement is part of this request.
