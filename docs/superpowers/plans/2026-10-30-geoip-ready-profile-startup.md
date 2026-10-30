# GeoIP ready-profile startup repair

**Goal:** Restore startup when local routing, including Bypass RU, is merged into a ready sing-box subscription profile.

**Scope:** The reported Windows startup failure is not yet linked to an exact user log. Fix the independently reproduced ready-profile failure; keep Xray rule-set translation and release publication outside this patch.

**Approach:** Keep the existing provider-preserving merge. Wrap the route returned by build_route in the document shape its consumers expect. Preserve provider DNS when the generated local resolver alias does not exist in the provider configuration. Do not replace provider DNS or change custom GeoIP sources.

**Evidence:** All four config::ready tests fail on main with generated sing-box route is invalid. The bundled Windows sing-box 1.14.0-lx.24 downloads the current RU rule-set and starts in a temporary loopback-only probe.

## Steps

- [x] Reproduce existing ready-profile failures on Windows.
- [x] Add a fixture-based Bypass RU merge regression, provider DNS regressions, and a bundled-core startup/check regression.
- [x] Confirm the new tests fail before changing production behavior.
- [x] Correct the generated route document and resolver handling in src-tauri/src/config/ready.rs.
- [x] Run Rust library tests, frontend tests/type check, and the bundled Windows core against the merged configuration.
- [x] Review the final diff and report the exact verified scope and any remaining failures.

## Review focus

Provider rules and DNS remain intact; proxy aliases resolve to actual provider outbounds; UI-only enabled metadata does not reach the core; local/provider rule-set tag conflicts remain rejected; an absent local resolver alias must not prevent startup.

## Delivery

Leave the changes reviewable on fix/geoip-ready-profile-startup. Do not commit, push, publish, or install an application as part of this repair. A future release must use a new version number: replacing 1.4.7 assets does not trigger updates for existing 1.4.7 installations.
## Verification results

- Baseline: all 4 existing ready-profile tests failed with `generated sing-box route is invalid`.
- New regressions before production changes: 0/9 passed (Windows core check explicitly enabled).
- Wrapper-only fix: 6/9 passed; two resolver-preservation tests and the core check failed. The real core reported `default domain resolver not found: local`.
- Final targeted command: `cargo test --locked --offline --lib config:: -- --include-ignored --quiet` — 53 passed, 0 failed, 0 ignored.
- Expanded command: `cargo test --locked --offline --lib -- --include-ignored --skip process::tests --skip killswitch::tests --quiet` — 246 passed, 1 failed, 5 filtered. The remaining failure is `xray::routing::tests::translates_custom_process_name_and_path_matchers`: the unchanged Windows test expects process support while the unchanged `supports_process_matcher()` returns false. No Xray changes are included.
- `npm test -- --reporter=dot` — 74/74 passed; TypeScript no-emit check passed.
- The bundled Windows sing-box 1.14.0-lx.24 independently downloaded the current GeoIP RU database and started in a temporary loopback-only probe (no TUN).
- `git diff --check` passed. An independent read-only review found no actionable issues in the patch.
- No real subscription connection or TUN session was tested; the user's exact error is still needed to tie the report conclusively to this repair.
- Xray rule-set translation and new-version release publication remain separate work. No commit, push, installer publication, or application installation was performed.

## macOS and Android coverage

- Both platforms use the corrected common `config::ready::merge_ready_routing`: macOS through `commands::prepare_ready_singbox_config`, Android through `commands_android::get_active_child_config` before Kotlin prepares the TUN.
- Android `CloakwireVpnService.prepareSingBoxConfig` retains the merged rule sets, HTTP clients and provider DNS/resolver. No duplicate platform implementation is needed for this failure.
- Checked the pinned macOS (`9558ceb27bc1e92e2ecfa96ebfe6b3f688344c5a`) and Android (`ff40cf98cb80ca6c9e9ae823ad392045cb4d23de`) sing-box sources: both support `http_clients` and `route.default_http_client` used by the merge.
- Extended `ready_geoip_config_passes_bundled_desktop_core_check` to select the native bundled Windows x64, macOS Apple Silicon or macOS Intel core. It remains opt-in because the binary must be present.
- Android ARM64 Rust library compilation passed: `cargo check --locked --offline --lib --target aarch64-linux-android` with the installed NDK and Android's empty external-bin/resources configuration. This is a compilation check, not an APK build or device test.
- After the test extension, `cargo test --locked --offline --lib config:: -- --include-ignored --quiet` passed again: 53 passed, 0 failed, 0 ignored. The native core check was executed on Windows.
- Single-file rustfmt validation and `git diff --check` passed. No Mac or Android device VPN session was run; macOS native execution remains unverified on this Windows host.
