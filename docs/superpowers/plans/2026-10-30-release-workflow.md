# Reliable cross-platform release workflow

Goal: Make Windows, macOS and Android releases originate from one validated source commit, with canonical version metadata, exact isolated artifacts, cryptographic signature verification, and checked GitHub draft promotion.

Scope: Improve and test release tooling. Preserve the uncommitted ready-profile feature. Do not publish or install a new application during tooling development. Keep the current application version; provide an explicit version synchronization command for the next release.

Design: tauri.conf.json is canonical for app version. A Node helper checks/synchronizes package files, Cargo files and Android metadata. An artifact catalog defines the seven binary names and four updater platforms. A standalone verifier uses the same Minisign key as the updater. Build orchestration rejects dirty source, archives HEAD, extracts a separate source tree and keeps per-run output/logs; every native exit code gates the next phase. Publisher validates locally, uploads only expected files to a draft, compares GitHub digests to local SHA-256, then promotes only with an explicit publish flag.

Artifact catalog: scripts/release-artifacts.json is an array of objects {suffix, platform, updater}. Exactly seven suffixes: x64-setup.exe, x64_en-US.msi, arm64-v8a.apk, aarch64.dmg, aarch64.app.zip, x64.dmg, x64.app.zip. Primary updater artifacts are EXE, APK and both DMGs.

Ownership: metadata worker owns catalog, manifest writer/validator and standalone verifier+tests; version worker owns Node version helper/tests and the two stale Xray test expectations; root owns orchestration, publishing, configuration example, documentation, package scripts/dependency alignment if required, and integration. No overlapping edits.

- [x] Add version consistency and safe explicit synchronization with fixture tests.
- [x] Add all-platform artifact/manifest/checksum/signature validation with positive and negative tests.
- [x] Replace unsafe orchestration with clean-source and fresh-output gates, external command failure checks and machine configuration.
- [x] Add draft-first publisher that checks every uploaded digest before latest promotion.
- [x] Document exact prepare/build/publish commands and required credentials without storing secrets.
- [x] Run release-tool tests, validate existing v1.4.8 artifacts, review final diff and report verified limitations.

Verification (2026-10-30):
- release:test: 119 checks passed (43 version fixtures, 31 cryptographic verifier/fixture tests, 20 workflow checks, 6 Android bootstrap checks, 19 fake-GitHub publication checks), including Windows PowerShell 5.1 launched through npm.
- Frontend: 100 tests passed; TypeScript/Vite production build passed (existing chunk size advisory only).
- Windows Rust: 233 passed, 29 process/killswitch tests excluded because they alter system/network state.
- Android bootstrap from a fresh HEAD archive: Rust aarch64 check, production Kotlin compilation and 15 JVM tests passed. Generated Gradle/Kotlin/ProGuard files verified nonempty.
- Existing v1.4.8 seven-artifact release passed full Minisign, updater-manifest and both SHA-256 catalog verification without reading private keys.
- Real machine prerequisites passed CheckOnly in a clean temporary fixture; local ignored configuration prepared. Tauri JS/Rust versions aligned without ignore-version-mismatches.
- Independent review found/fixed Android generation/assets, PS5 compatibility, retry environment restoration and publication/version gates. Bash/PowerShell parsing, standalone Rust formatting and git whitespace checks passed.

Limits: No complete new installer/APK/DMG set was rebuilt or published. The app version is still 1.4.8. Existing uncommitted ready-profile changes are retained; a real release requires reviewed source committed as one HEAD. GitHub CI workflow is added locally and has not run remotely.
