param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$propertiesPath = Join-Path $projectRoot 'src-tauri\gen\android\app\tauri.properties'
$versionTool = Join-Path $PSScriptRoot 'release-version.mjs'

if ($CheckOnly -and -not (Test-Path -LiteralPath $propertiesPath -PathType Leaf)) {
    throw "Android version metadata is missing: $propertiesPath"
}

$command = if ($CheckOnly) { 'check' } else { 'sync-android' }
& node $versionTool $command --project-root $projectRoot
if ($LASTEXITCODE -ne 0) {
    throw "Release version validation failed with exit code $LASTEXITCODE."
}
