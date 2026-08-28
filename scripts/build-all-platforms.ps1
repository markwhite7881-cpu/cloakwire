# Multi-platform release orchestration script for Cloakwire
# Builds: Windows (NSIS + MSI), Android (ARM64 APK), Linux (DEB + AppImage via WSL), macOS (ARM64 + x64 DMG + ZIP via Mac mini)

param(
    [string]$Version = "1.4.0",
    [switch]$InstallPhone = $true
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  CLOAKWIRE MULTI-PLATFORM RELEASE BUILD (v$Version)   " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$DistDir = Join-Path $ProjectRoot "dist-release"
if (!(Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir | Out-Null }

# 1. Windows Desktop Build
Write-Host "`n[1/4] Building Windows Desktop (.exe / .msi)..." -ForegroundColor Yellow
$env:RUSTUP_HOME = "C:\Users\Public\cwdev\rustup-home"
$env:CARGO_HOME = "C:\Users\Public\cwdev\cargo-home"
$env:PATH = "C:\Users\Public\cwdev\cargo\bin;C:\Program Files\nodejs;C:\Program Files\Git\usr\bin;$env:PATH"
npm run tauri build

Copy-Item "C:\Users\Public\cwdev\target\release\bundle\nsis\Cloakwire_$Version`_x64-setup.exe" -Destination "$DistDir\" -Force
Copy-Item "C:\Users\Public\cwdev\target\release\bundle\msi\Cloakwire_$Version`_x64_en-US.msi" -Destination "$DistDir\" -Force

# 2. Android Build & Deploy
Write-Host "`n[2/4] Building Android APK (arm64-v8a)..." -ForegroundColor Yellow
powershell -ExecutionPolicy Bypass -File scripts\build-android-rust.ps1

$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
$env:ANDROID_HOME = "C:\Users\Алексей\AppData\Local\Android\Sdk"
$env:ANDROID_NDK_ROOT = "C:\Users\Public\cwdev\ndk"
$env:PATH = "C:\Program Files\nodejs;C:\Users\Public\cwdev\cargo\bin;$env:JAVA_HOME\bin;$env:PATH"

Push-Location "src-tauri\gen\android"
try {
    & .\gradlew.bat assembleArm64Debug -x rustBuildArm64Debug --no-daemon "-Dorg.gradle.jvmargs=-Xmx3g" --build-cache
} finally {
    Pop-Location
}

Copy-Item "src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk" -Destination "$DistDir\Cloakwire_$Version`_arm64-v8a.apk" -Force

if ($InstallPhone) {
    $adb = "C:\Users\Алексей\AppData\Local\Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $adb) {
        Write-Host "Installing APK to connected phone..." -ForegroundColor Cyan
        & $adb -s 3B15AV0166300000 install -r "$DistDir\Cloakwire_$Version`_arm64-v8a.apk"
        & $adb -s 3B15AV0166300000 shell "am force-stop ru.classquiz.singbox"
        & $adb -s 3B15AV0166300000 shell "am start -n ru.classquiz.singbox/.MainActivity"
    }
}

# 3. Linux Build (via WSL)
Write-Host "`n[3/4] Building Linux (.deb / .AppImage via WSL)..." -ForegroundColor Yellow
wsl -e bash -l -c "export PATH=/home/alexeyka08/.cargo/bin:/usr/bin:`$PATH && export CARGO_TARGET_DIR=/tmp/cloakwire-target-linux && cd /mnt/c/Users/Public/cwdev/cloakwire-release-v132 && python3 scripts/prepare-xray-sidecar.py --target x86_64-unknown-linux-gnu && ./scripts/build-linux-deb.sh $Version"

# 4. macOS Build (via Mac mini SSH)
Write-Host "`n[4/4] Building macOS (Apple Silicon + Intel via Mac mini)..." -ForegroundColor Yellow
$sshKey = "C:\Users\Public\cwdev\.ssh\mavis_hermes"
$macHost = "alexeyka@100.97.167.112"
$sshExe = "C:\Program Files\Git\usr\bin\ssh.exe"
$scpExe = "C:\Program Files\Git\usr\bin\scp.exe"

git archive -o "$DistDir\v$Version-source.tar.gz" HEAD
& $scpExe -i $sshKey -o StrictHostKeyChecking=no "$DistDir\v$Version-source.tar.gz" "$macHost`:/tmp/v$Version-source.tar.gz"

& $sshExe -i $sshKey -o StrictHostKeyChecking=no $macHost @"
mkdir -p `$HOME/cloakwire-builds/cloakwire-v$Version
cd `$HOME/cloakwire-builds/cloakwire-v$Version
tar -xzf /tmp/v$Version-source.tar.gz
rm -f src-tauri/.cargo/config.toml
mkdir -p src-tauri/binaries
cp -r `$HOME/cloakwire-builds/cloakwire-v1.3.2-fixed/src-tauri/binaries/* src-tauri/binaries/
if [ -d "`$HOME/cloakwire-builds/cloakwire-v1.3.2-fixed/node_modules" ]; then
  cp -R `$HOME/cloakwire-builds/cloakwire-v1.3.2-fixed/node_modules ./
fi
export PATH="/opt/homebrew/bin:`$HOME/.cargo/bin:`$PATH"
export CARGO_TARGET_DIR="`$HOME/cloakwire-builds/cloakwire-v$Version/src-tauri/target"

npm run tauri:build -- --target aarch64-apple-darwin --bundles app
npm run tauri:build -- --target x86_64-apple-darwin --bundles app

mkdir -p dist-release
ditto -c -k --keepParent src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Cloakwire.app dist-release/Cloakwire_$Version`_aarch64.app.zip
hdiutil create -volname "Cloakwire" -srcfolder src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Cloakwire.app -ov -format UDZO dist-release/Cloakwire_$Version`_aarch64.dmg

ditto -c -k --keepParent src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Cloakwire.app dist-release/Cloakwire_$Version`_x64.app.zip
hdiutil create -volname "Cloakwire" -srcfolder src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Cloakwire.app -ov -format UDZO dist-release/Cloakwire_$Version`_x64.dmg
"@

& $scpExe -i $sshKey -o StrictHostKeyChecking=no "$macHost`:`$HOME/cloakwire-builds/cloakwire-v$Version/dist-release/Cloakwire_$Version`_*" "$DistDir\"

# 5. Checksums
Write-Host "`nComputing SHA-256 checksums..." -ForegroundColor Cyan
$files = Get-ChildItem "$DistDir\Cloakwire_$Version`_*" | Select-Object -ExpandProperty FullName
$hashes = foreach ($f in $files) {
  $hash = (Get-FileHash -Path $f -Algorithm SHA256).Hash.ToLower()
  $name = [System.IO.Path]::GetFileName($f)
  "$hash  $name"
}
$hashes | Set-Content -Path "$DistDir\SHA256SUMS_v$Version.txt" -Encoding utf8

Write-Host "`n[SUCCESS] All multi-platform artifacts are ready in $DistDir!" -ForegroundColor Green
Get-ChildItem "$DistDir\Cloakwire_$Version`_*" | Format-Table Name, Length, LastWriteTime -AutoSize
