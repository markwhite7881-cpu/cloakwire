[CmdletBinding()]
param([string]$HelperPath)
if (-not $HelperPath) { $HelperPath = Join-Path $PSScriptRoot 'prepare-android-release.ps1' }

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('cloakwire-android-bootstrap-' + [guid]::NewGuid().ToString('N'))
$names = @('TAURI_ANDROID_PROJECT_PATH', 'TAURI_ANDROID_PACKAGE_UNESCAPED', 'WRY_ANDROID_PACKAGE', 'WRY_ANDROID_LIBRARY', 'WRY_ANDROID_KOTLIN_FILES_OUT_DIR')
$savedEnvironment = @{}
foreach ($name in $names) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$passed = 0

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) { throw "${Message}: expected '$Expected', received '$Actual'." }
}
function Write-FixtureFile([string]$Root, [string]$RelativePath, [string]$Content) {
    $path = Join-Path $Root $RelativePath
    [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
    [IO.File]::WriteAllText($path, $Content, [Text.UTF8Encoding]::new($false))
}
function New-Fixture([string]$Name) {
    $root = Join-Path $fixtureRoot $Name
    Write-FixtureFile $root 'src-tauri/tauri.conf.json' '{"identifier":"app.cloakwire.client","version":"1.4.8"}'
    Write-FixtureFile $root 'src-tauri/Cargo.toml' "[package]`nname = `"cloakwire`"`nversion = `"1.4.8`"`n`n[lib]`nname = `"cloakwire_lib`"`ncrate-type = [`"cdylib`"]`n"
    Write-FixtureFile $root 'src-tauri/gen/android/settings.gradle' "include ':app'`napply from: 'tauri.settings.gradle'`n"
    Write-FixtureFile $root 'src-tauri/gen/android/app/build.gradle.kts' "android {`n namespace = `"app.cloakwire.client`"`n defaultConfig { applicationId = `"app.cloakwire.client`" }`n}`n"
    Write-FixtureFile $root 'src-tauri/gen/android/app/src/main/java/app/cloakwire/client/MainActivity.kt' "package app.cloakwire.client`nclass MainActivity : TauriActivity()`n"
    return $root
}
function Assert-InvalidFixture([string]$Root, [string]$Pattern) {
    $before = @{}
    foreach ($name in $names) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    $rejected = $false
    try { & $HelperPath -ProjectRoot $Root | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        $rejected = $true
    }
    Assert-Equal $rejected $true 'Invalid project must fail'
    foreach ($name in $names) { Assert-Equal ([Environment]::GetEnvironmentVariable($name, 'Process')) $before[$name] "Invalid project changed $name" }
    Assert-Equal (Test-Path -LiteralPath (Join-Path $Root 'src-tauri/gen/android/app/src/main/java/app/cloakwire/client/generated')) $false 'Invalid project created a generated directory'
}

try {
    $valid = New-Fixture 'valid project with spaces'
    $source = Join-Path $valid 'src-tauri/gen/android/app/src/main/java/app/cloakwire/client/MainActivity.kt'
    $sourceBefore = [IO.File]::ReadAllText($source)
    $env:TAURI_ANDROID_PROJECT_PATH = 'stale-project'
    $result = & $HelperPath -ProjectRoot $valid
    $android = Join-Path $valid 'src-tauri/gen/android'
    $generated = Join-Path $android 'app/src/main/java/app/cloakwire/client/generated'
    Assert-Equal $env:TAURI_ANDROID_PROJECT_PATH $android 'Android project environment persists in caller'
    Assert-Equal $env:TAURI_ANDROID_PACKAGE_UNESCAPED 'app.cloakwire.client' 'Unescaped JNI package'
    Assert-Equal $env:WRY_ANDROID_PACKAGE 'app.cloakwire.client' 'Wry package'
    Assert-Equal $env:WRY_ANDROID_LIBRARY 'cloakwire_lib' 'Rust library name'
    Assert-Equal $env:WRY_ANDROID_KOTLIN_FILES_OUT_DIR $generated 'Kotlin generation directory'
    Assert-Equal ([IO.Directory]::Exists($generated)) $true 'Kotlin directory must exist before Rust build scripts canonicalize it'
    Assert-Equal @(Get-ChildItem -LiteralPath $generated -Force).Count 0 'Helper must not copy stale generated wrappers'
    Assert-Equal ([IO.File]::ReadAllText($source)) $sourceBefore 'MainActivity source must remain untouched'
    Assert-Equal $result.Library 'cloakwire_lib' 'Reviewable helper result'
    & $HelperPath -ProjectRoot $valid | Out-Null
    $passed++

    $missing = New-Fixture 'missing-activity'
    Remove-Item -LiteralPath (Join-Path $missing 'src-tauri/gen/android/app/src/main/java/app/cloakwire/client/MainActivity.kt')
    Assert-InvalidFixture $missing 'MainActivity|missing'
    $passed++

    $mismatch = New-Fixture 'mismatched-activity'
    Write-FixtureFile $mismatch 'src-tauri/gen/android/app/src/main/java/app/cloakwire/client/MainActivity.kt' 'package another.application'
    Assert-InvalidFixture $mismatch 'package|MainActivity'
    $passed++

    $gradleMismatch = New-Fixture 'mismatched-gradle'
    Write-FixtureFile $gradleMismatch 'src-tauri/gen/android/app/build.gradle.kts' 'android { namespace = "another.application"; defaultConfig { applicationId = "another.application" } }'
    Assert-InvalidFixture $gradleMismatch 'namespace|applicationId|Gradle'
    $passed++

    $libraryMissing = New-Fixture 'missing-library'
    Write-FixtureFile $libraryMissing 'src-tauri/Cargo.toml' "[package]`nname = `"cloakwire`"`nversion = `"1.4.8`"`n"
    Assert-InvalidFixture $libraryMissing 'library|\[lib\]|Cargo'
    $passed++

    $invalidConfig = New-Fixture 'malformed-config'
    Write-FixtureFile $invalidConfig 'src-tauri/tauri.conf.json' '{invalid json'
    Assert-InvalidFixture $invalidConfig 'JSON|config'
    $passed++

    Write-Output "Android bootstrap fixture tests: $passed passed."
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedFixture).StartsWith('cloakwire-android-bootstrap-')) {
        if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
    } else { throw 'Refusing to clean an Android fixture outside the temporary directory.' }
}
