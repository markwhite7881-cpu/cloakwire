param([string]$TargetDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$cargo = Get-Command cargo -ErrorAction Stop
if (-not $TargetDirectory) {
    $TargetDirectory = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path ([IO.Path]::GetTempPath()) 'cloakwire-release-verify-target' }
}
# Rust integration tests create ephemeral in-memory signing keys, exercise real
# Minisign signatures, and invoke both PowerShell entry points on signed fixtures.
& $cargo.Source test --locked --offline --manifest-path (Join-Path $projectRoot 'src-tauri/crates/release-verify/Cargo.toml') --target-dir $TargetDirectory
if ($LASTEXITCODE -ne 0) { throw "Release validation tests failed with exit code $LASTEXITCODE." }
