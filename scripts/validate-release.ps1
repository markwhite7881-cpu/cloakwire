param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$DistPath,
    [Parameter(Mandatory = $true)][string]$Version,
    [string[]]$RequiredPlatforms = @('windows-x86_64', 'android-arm64-v8a', 'darwin-aarch64', 'darwin-x86_64'),
    [switch]$FullRelease,
    [string]$VerifierPath,
    [string]$ProjectRoot,
    [string]$PublicKeyPath
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$arguments = @('--version', $Version, '--dist', (Resolve-Path -LiteralPath $DistPath).ProviderPath,
    '--manifest', (Resolve-Path -LiteralPath $ManifestPath).ProviderPath,
    '--project-root', (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath)
if ($RequiredPlatforms.Count -eq 0) { throw 'RequiredPlatforms must not be empty.' }
foreach ($platform in $RequiredPlatforms) { $arguments += @('--required-platform', $platform) }
if ($FullRelease) { $arguments += '--full-release' }
if ($PublicKeyPath) { $arguments += @('--public-key-file', (Resolve-Path -LiteralPath $PublicKeyPath).ProviderPath) }
if ($VerifierPath) {
    if (-not (Test-Path -LiteralPath $VerifierPath -PathType Leaf)) { throw "Release verifier is missing: $VerifierPath" }
    & (Resolve-Path -LiteralPath $VerifierPath).ProviderPath @arguments
} else {
    $cargo = Get-Command cargo -ErrorAction Stop
    $crate = Join-Path $ProjectRoot 'src-tauri/crates/release-verify/Cargo.toml'
    # Keep helper build output outside both the checkout and the application's target tree.
    $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path ([IO.Path]::GetTempPath()) 'cloakwire-release-verify-target' }
    & $cargo.Source run --quiet --locked --offline --manifest-path $crate --target-dir $targetDir -- @arguments
}
if ($LASTEXITCODE -ne 0) { throw "Release verifier failed with exit code $LASTEXITCODE." }
