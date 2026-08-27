# Android libXray pinning — 2026-08-19

## Purpose

This document pins the **feasibility-only** Xray runtime candidate for the Android ARM64 proof gate. It does **not** enable an Xray engine, UI control, automatic fallback, or release packaging by itself. Sing-box remains the production Android engine unless every device proof gate in the approved port design passes.

## Upstream provenance

| Field | Pinned value |
| --- | --- |
| Upstream repository | `XTLS/libXray` |
| Official release tag | `v26.7.28` |
| Release commit | `80263da83e96b2972455b0a94b13ee1a10e51391` |
| Release asset | `libxray-android.zip` |
| Asset location | Official GitHub release for the tag above |
| ZIP SHA-256 | `28b7dc9d6cc8455fcca5cbd56e387003a7bfb558128651a64899dc3a8ccff666` |
| Contained AAR | `libxray-android/libXray.aar` |
| AAR SHA-256 | `4708a361a74f7e955635dbe3661cefb459bdc867423c3b1826a2c5a6ea4ac77d` |
| Required ABI evidence | `jni/arm64-v8a/libgojni.so` |

The release ZIP also contains `libxray-android/libXray-sources.jar`. The pinned AAR contains `classes.jar` and JNI artifacts for `arm64-v8a`, `armeabi-v7a`, `x86`, and `x86_64`; ARM64 is the only target for this proof.

## Local staging and verification

The downloaded ZIP, extracted AAR, and Gradle-local copy are intentionally ignored. They must never be committed:

```text
.android-build/libxray-v26.7.28/libxray-android.zip
.android-build/libxray-v26.7.28/extracted/libxray-android/libXray.aar
src-tauri/gen/android/app/libs/libXray.aar
```

Before wiring or building, run the committed verifier from the repository root:

```powershell
.\scripts\verify-android-xray-dependency.ps1 -ExtractAar
```

It fails closed unless the ZIP and extracted AAR match both pinned SHA-256 digests and the AAR contains an ARM64 JNI `.so`. Its output contains only digests and archive entry names—never configuration, provider, or credential data.

After successful validation, copy the verified extracted AAR to `src-tauri/gen/android/app/libs/libXray.aar` and use only the local Gradle dependency. Do not replace this with an unpinned Maven coordinate or a dynamic version.

## Packaging feasibility result — 2026-08-19

The pinned AAR was verified locally and contains the required `jni/arm64-v8a/libgojni.so`. A packaging-only ARM64 Gradle run was then attempted with the Tauri Rust generation task excluded:

```powershell
.\src-tauri\gen\android\gradlew.bat :app:assembleArm64Release --no-daemon --console=plain -x :app:rustBuildArm64Release
```

The first run was blocked by a missing local baseline `libbox.aar`; restoring the exact verified baseline AAR (`C8D638AA8D3357B69796D5E727C864FA90BA39E106403CDCA79105443BF3148A`) allowed Gradle to reach Android duplicate-class validation. The second run failed because `libXray.aar` and `libbox.aar` both embed gomobile `go.*` classes, including `go.Seq` and `go.Universe`. The class sets overlap, but their bytecode is not wholly identical (9 of 12 overlapping runtime classes differ), so suppressing duplicate-class errors or arbitrarily stripping one runtime is not an accepted fix.

No APK was produced, and no `lib/arm64-v8a/libgojni.so` APK evidence exists from this run. The direct local AAR dependency was therefore removed from the generated Gradle file. This preserves the verified sing-box Android build and leaves libXray as a pinned, feasibility-only artifact pending a deliberate adapter/packaging strategy and subsequent physical ARM64 proof.


- `XTLS/libXray` is an official wrapper but upstream does not promise a stable consumer API; confine calls behind an Android-only `XrayEngine` adapter.
- The wrapper's Xray state is process-wide. Starts, stops, and future invocation work must be serialized inside `CloakwireVpnService`; no parallel ping/test helper may run beside an active Xray tunnel.
- Android TUN handoff uses `env.xray.tun.fd` in the Xray configuration. Do not invent a `SetTunFd` binding.
- Keep raw configs app-private, logs bounded and sanitized, and capability fallback typed and explicit.
- A packaging success alone is insufficient: lifecycle, TUN traffic, sanitized log behavior, repeated switching, failure recovery, and performance must be proved on a physical ARM64 Android target before exposing Xray.
