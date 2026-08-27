# Full Android build gates (2026-08-21 rebuild).
#
# Pipeline:
#   1. npm run build          - frontend dist (embedded into the .so)
#   2. build-android-rust.ps1 - cargo release .so -> jniLibs
#   3. Gradle: Kotlin compile + unit tests + assembleArm64Release
#      (rustBuild task excluded: the .so was just staged by step 2)
#
# Every step fails the script on error. Run scripts/sign-and-validate-
# xray.ps1 afterwards to sign the APK.
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host '== gate 1: frontend dist =='
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

Write-Host '== gate 2: Rust .so =='
& (Join-Path $PSScriptRoot 'build-android-rust.ps1') -SkipDist
if ($LASTEXITCODE -ne 0) { throw 'build-android-rust.ps1 failed' }

Write-Host '== gate 3: Gradle compile + unit tests + assemble =='
Set-Location (Join-Path $repo 'src-tauri/gen/android')
$env:GRADLE_USER_HOME = 'C:\Users\Public\cwdev\gradle-home'
& .\gradlew.bat :app:compileArm64ReleaseKotlin :app:testArm64ReleaseUnitTest :app:assembleArm64Release --no-daemon --console=plain -x :app:rustBuildArm64Release
if ($LASTEXITCODE -ne 0) { throw 'gradle gates failed' }

$apk = Get-Item 'app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk'
$sizeMb = [math]::Round($apk.Length / 1MB, 1)
Write-Host "GATES PASSED - unsigned APK: $($apk.FullName) ($sizeMb MB)"
