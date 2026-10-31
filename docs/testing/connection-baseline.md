# Connection regression baseline

Source: application 1.4.9, public commit fadbaa6d6e833700a40f4815f2a6cb5fe957171b.
Plan-only HEAD before implementation: f541c28. Measured 2026-10-31.

| Check | Fresh result |
| --- | --- |
| npm test | PASS: 101 tests, 23 files |
| npm run build | PASS; existing >500 kB bundle warning |
| Windows Rust library (safe subset) | PASS: 231 passed, 2 ignored, 29 excluded |
| Android ARM JVM | PASS: 31 tests, 0 failures |
| macOS ARM Rust (safe subset) | PASS: 229 passed, 2 ignored, 28 excluded |
| Core runner unit tests | PASS: 7 |
| Windows real-core loopback matrix | PASS: 8 |
| Windows preflight including real-core checks | PASS: 8, including generated application config |
| Android device / Windows isolated system matrix | UNVERIFIED: no test device/VM available |

Windows cores (the installed binaries match the packaged sidecars):
- sing-box 1.14.0-lx.24, SHA-256 225722d039c6a58749c90212429643f16896c564fde5d622caa56a80090433b7
- Xray 26.3.27, SHA-256 15c2d007954ac53ba69b80ec91242786b3c0b71d52649165b4ca1d5cc96ef8f1

## Reproduce without changing the working computer's network

Run npm test and npm run build from the repository root.
Run node --test scripts/connection-matrix/*.test.mjs.
Run npm run test:connections -- --suite core --binaries src-tauri/binaries --output <temporary-report-directory>.

The core suite owns temporary configs/processes and binds only loopback listeners. It uses an ephemeral local VLESS server and a local HTTP target; no user's server, public test site, TUN, firewall, system proxy, or routing modification. HTTP here is a local fixture, not the production HTTPS probe. Wrong-user rejection is checked independently from TCP reachability. Reports allowlist fields and issue codes; stdout/stderr and UUIDs are never exported. Each report records source HEAD, dirty status, and actual core hashes.

For Windows Rust: set CLOAKWIRE_TEST_MANIFEST=1 and the local Rust paths, then cargo test --lib -- --skip process:: --skip killswitch:: from src-tauri. Remove CLOAKWIRE_TEST_MANIFEST before any production build. Test inspection confirms the included command cancellation cases call stop with no child; the rejected candidate test owns a dummy process and terminates it without system cleanup. Network-mutating process/killswitch cases stay excluded on the user's computer.

Additionally run cargo test --lib config::preflight -- --include-ignored: bundled cores only check candidate config copies. This exercises provider DNS, rejected configs, preserved active logs, and the actual application's generated VLESS config.

Android uses flavors: the plan's :app:testDebugUnitTest is ambiguous. Use :app:testArmDebugUnitTest (JDK 17, existing SDK/Gradle cache). Initial ambiguous invocation exited before running tests; corrected invocation passed.

## Existing regression coverage retained

- commands::ready_preflight_tests: invalid candidate preserves active child.
- commands::preflight_cancellation_tests and preflight_ownership_tests: Stop/new request invalidates late starts; old cleanup cannot cancel a newer check.
- config::ready and config::tests: UI-only rule-set fields stripped; provider DNS preserved; process rule order/final and GeoIP behavior.
- subscriptions::tests: refresh retains positional index-N selection; changed credentials do not imply stable server identity.
- All of these passed in the fresh safe Rust suite above.

## Required release evidence still outstanding

System suite deliberately refuses execution until a dedicated platform adapter is supplied. It must cover real VLESS/Reality success and wrong-key rejection with freshly generated camouflage/server keys in an isolated fixture, actual TUN/app routing, simultaneous accepted session and diagnostic probe, Stop/cancel/recovery races, physical-network changes, and Android libbox isolation. A loopback VLESS success is not a Reality/TUN/Android PASS. Never reset this baseline to conceal new failures.
