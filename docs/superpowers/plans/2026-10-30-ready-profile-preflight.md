# Ready profile preflight implementation plan

Goal: Automatically validate the fully prepared ready subscription profile with its own engine before connecting on Windows, macOS and Android, and show a localized actionable error card.

Architecture: Desktop validation runs inside backend ready-profile launch paths before stopping an existing engine or changing system proxy settings. Android validates after the same normalization used for service startup and before persisting/replacing the active configuration. UI handles an allowlisted error code, never raw provider JSON or core stderr.

Contract: kind/message tokens are profile_check_dns, profile_check_ruleset, profile_check_unsupported, profile_check_invalid, profile_check_unavailable, profile_check_timeout, profile_check_failed. Desktop AppError serializes kind and safe token message. Android rejects the invoke with the same token. Unknown failures use profile_check_failed. No raw core diagnostics are returned or logged by preflight.

Checks: DNS resolver references, rule-set errors, unsupported fields/options, malformed/invalid configuration, missing or unusable core, bounded checker timeout, unknown checker failure. A successful config check does not guarantee network reachability; no automatic remote URL probes or silent fallback to another profile.

UI: Reuse existing desktop/mobile error locations with a shared error card, localized title/reason/next step, dismiss and sanitized copy if practical. Preserve the selected profile on error. Existing non-preflight error behavior remains supported. Existing reconnection paths must preflight a ready profile before explicitly stopping the old connection.

- [x] Add failing Rust tests for safe classification and validation success/failure/timeout; implement desktop checker and launch ordering.
- [x] Add frontend behavior tests and implement shared localized error card and mobile error propagation.
- [x] Add Android normalization/validation ordering and classification tests, then implement native checks before service handoff.
- [x] Run targeted native and UI tests, full frontend tests/type build, Android compilation/unit tests, and macOS native checks when useful.
- [x] Review integrated changes and report actual coverage. Leave changes local; this request does not require a new release.

Work ownership: root handles Rust desktop/common and integration; UI agent handles src/ TypeScript/React/locales; Android agent handles Kotlin sources/tests only. No shared-file edits between agents. No commits/pushes or installation/release are required.

## Final implementation and verification

- Desktop: the installed sing-box/Xray validates the prepared profile before the existing engine is stopped. Xray TUN inbounds are preserved during validation. Checker logs are disabled in a temporary copy; provider networking configuration is preserved.
- Android: shared normalization is used for checks and service startup. Libbox and Xray checks precede file persistence/service handoff; saved tile/widget/sticky starts are checked too. Native/subprocess checks have bounded execution and resource ownership.
- Added expected `profile_check_cancelled` sentinel. Stop and newer requests invalidate older attempts; cancellation is quiet in the UI. Runtime candidate and checker files have leases so another request cannot sweep them. Failed-request cleanup checks ownership under the process transition lock.
- UI: shared EN/RU/ZH reason/action card, sanitized report copy with WebView fallback, dismiss/retry behavior, fresh error precedence, retained selected candidate, and actual connected server labels. No silent ready-profile fallback.
- Windows final Rust library command (with ignored bundled-core tests enabled and process/killswitch suites plus the known unrelated Windows Xray process-matcher expectation skipped): 232 passed, 0 failed, 30 filtered.
- macOS Apple Silicon filtered library suite: 230 passed, 0 failed, 29 filtered. The first broad Mac run also exposed the unchanged `engine::xray::tests::resolver_has_targeted_sidecar_names_and_integrity_metadata` assertion (expects a 64-character hash although Mac metadata has an empty hash); that known unrelated test was excluded on the final run. On the final source, all 12 preflight tests passed again with real Mac cores and Intel library compilation passed.
- Android ARM64 Rust library compilation passed; Android production Kotlin compilation and all 31 JVM tests passed (16 added).
- Final frontend suite: 100/100 tests in 22 files; TypeScript and production Vite build passed. Existing import/chunk size warnings remain.
- Real Edge interaction checks passed with the real hook/HomeScreen: old service error dismissed, DNS failure retried and dismissed, same DNS failure shown again, clipboard fallback, retained actual server name, Stop during pending check produces no error card. Mobile screenshot inspected at C:/tmp/preflight-profile-card-mobile.png.
- Diff whitespace and targeted Rust formatting checks passed. Independent review findings (Xray TUN omission, stale UI errors, cancellation and pending-file ownership races) were addressed and reviewed.
- No real Android-device/libbox execution or end-to-end subscription/TUN connection was performed. A configuration check does not prove remote server/rule-set network availability.
- Changes are local on `feat/ready-profile-preflight`; no commit, push, installer publication or installation was performed for this feature. Published v1.4.8 remains the prior GeoIP release.
