[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Called with & in the build process: process environment changes deliberately
# survive script scope so Cargo and the following Gradle invocation share them.
$rootItem = Get-Item -LiteralPath $ProjectRoot -Force -ErrorAction Stop
if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Android release ProjectRoot must be an existing directory, not a link.'
}
$root = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar)

function Assert-PrivateDirectory([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Android generated path must stay within ProjectRoot: $fullPath"
    }
    $cursor = $root
    foreach ($component in $fullPath.Substring($prefix.Length).Split([IO.Path]::DirectorySeparatorChar)) {
        $cursor = Join-Path $cursor $component
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Android generated directory must be a private directory, not a file or link: $cursor"
            }
        }
    }
}

function Read-ProjectSource([string]$RelativePath) {
    $path = Join-Path $root $RelativePath
    Assert-PrivateDirectory (Split-Path -Parent $path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Android source is missing: $RelativePath" }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Android source must not be a link: $RelativePath" }
    return [IO.File]::ReadAllText($path)
}

$configText = Read-ProjectSource 'src-tauri/tauri.conf.json'
try { $config = $configText | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'Canonical Tauri config is not valid JSON.' }
if (-not $config.PSObject.Properties['identifier']) { throw 'Canonical Tauri config is missing its Android package identifier.' }
$package = [string]$config.identifier
if ($package -notmatch '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$') {
    throw 'Tauri identifier must be a supported dotted Android package name.'
}

$cargo = Read-ProjectSource 'src-tauri/Cargo.toml'
$librarySections = [regex]::Matches($cargo, '(?ms)^\[lib\][ \t]*\r?\n(?<body>.*?)(?=^\[|\z)')
if ($librarySections.Count -ne 1) { throw 'Cargo.toml must contain exactly one [lib] section for the Android library.' }
$libraryNames = [regex]::Matches($librarySections[0].Groups['body'].Value, '(?m)^[ \t]*name[ \t]*=[ \t]*"(?<name>[A-Za-z_][A-Za-z0-9_]*)"[ \t]*(?:#[^\r\n]*)?\r?$')
if ($libraryNames.Count -ne 1) { throw 'Cargo.toml [lib] must declare one valid Rust library name.' }
$library = $libraryNames[0].Groups['name'].Value

$android = Join-Path $root 'src-tauri/gen/android'
$null = Read-ProjectSource 'src-tauri/gen/android/settings.gradle'
$gradle = Read-ProjectSource 'src-tauri/gen/android/app/build.gradle.kts'
foreach ($field in @('namespace', 'applicationId')) {
    $fieldMatches = [regex]::Matches($gradle, ('\b' + $field + '[ \t]*=[ \t]*"(?<value>[^"\r\n]+)"'))
    if ($fieldMatches.Count -ne 1 -or $fieldMatches[0].Groups['value'].Value -cne $package) {
        throw "Android Gradle $field must match canonical Tauri package $package."
    }
}

$packagePath = $package.Replace('.', [IO.Path]::DirectorySeparatorChar)
$activityRelativePath = Join-Path 'src-tauri/gen/android/app/src/main/java' (Join-Path $packagePath 'MainActivity.kt')
$activity = Read-ProjectSource $activityRelativePath
$activityPackages = [regex]::Matches($activity, '(?m)^[ \t]*package[ \t]+(?<package>[A-Za-z_][A-Za-z0-9_.]*)[ \t]*\r?$')
if ($activityPackages.Count -ne 1 -or $activityPackages[0].Groups['package'].Value -cne $package) {
    throw "MainActivity package must match canonical Tauri package $package."
}
$generated = Join-Path (Split-Path -Parent (Join-Path $root $activityRelativePath)) 'generated'
Assert-PrivateDirectory $generated

# Tauri and Wry canonicalize this directory before generating their wrappers.
# Generate from installed crate sources during Cargo; never copy old wrappers,
# host-specific Gradle includes, or generated ProGuard rules into the archive.
[IO.Directory]::CreateDirectory($generated) | Out-Null
$env:TAURI_ANDROID_PROJECT_PATH = $android
$env:TAURI_ANDROID_PACKAGE_UNESCAPED = $package
$env:WRY_ANDROID_PACKAGE = $package
$env:WRY_ANDROID_LIBRARY = $library
$env:WRY_ANDROID_KOTLIN_FILES_OUT_DIR = $generated

[pscustomobject]@{
    AndroidProjectPath = $android
    KotlinOutputDirectory = $generated
    Package = $package
    Library = $library
}
