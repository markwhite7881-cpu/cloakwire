$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot | Split-Path -Parent
Set-Location $repo

Write-Host "== [1/3] Building Rust core for Android ARM64 ==" -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-android-rust.ps1')

Write-Host "`n== [2/3] Building Android APK with Gradle ==" -ForegroundColor Cyan
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
$env:ANDROID_HOME = Join-Path $env:USERPROFILE "AppData\Local\Android\Sdk"
$env:ANDROID_NDK_ROOT = "C:\Users\Public\cwdev\ndk"
$env:PATH = "C:\Program Files\nodejs;C:\Users\Public\cwdev\cargo\bin;" + (Join-Path $env:JAVA_HOME "bin") + ";" + $env:PATH

Push-Location (Join-Path $repo "src-tauri\gen\android")
try {
    & .\gradlew.bat assembleArm64Debug -x rustBuildArm64Debug --no-daemon "-Dorg.gradle.jvmargs=-Xmx3g" --build-cache
    if ($LASTEXITCODE -ne 0) { throw "gradlew failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "`n== [3/3] Delivering APK to Desktop ==" -ForegroundColor Cyan
$apkSrc = Join-Path $repo "src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk"
$desktopApk = Join-Path $env:USERPROFILE "Desktop\Cloakwire_1.4.5_arm64-v8a.apk"
Copy-Item $apkSrc -Destination $desktopApk -Force
Write-Host "Delivered APK to: $desktopApk" -ForegroundColor Green

$adb = Join-Path $env:USERPROFILE "AppData\Local\Android\Sdk\platform-tools\adb.exe"
if (Test-Path $adb) {
    $devices = & $adb devices
    Write-Host "`nADB devices output:"
    $devices | ForEach-Object { Write-Host "  $_" }
    if ($devices -match '3B15AV0166300000\s+device') {
        Write-Host "Installing APK to connected phone (3B15AV0166300000)..." -ForegroundColor Cyan
        & $adb -s 3B15AV0166300000 install -r $desktopApk
        & $adb -s 3B15AV0166300000 shell "am force-stop app.cloakwire.client"
        & $adb -s 3B15AV0166300000 shell "am start -n app.cloakwire.client/.MainActivity"
        Write-Host "Installed and restarted Cloakwire on phone!" -ForegroundColor Green
    } else {
        Write-Host "Phone 3B15AV0166300000 is not currently authorized/attached via adb. APK is ready on Desktop." -ForegroundColor Yellow
    }
}
