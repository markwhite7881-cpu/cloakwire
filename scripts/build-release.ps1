<#
.SYNOPSIS
    Builds, signs, and packages the Cloakwire release installer.

.DESCRIPTION
    Compiles the frontend, builds Tauri desktop bundles (NSIS & MSI),
    signs the outputs with the Tauri updater minisign key, and delivers
    the signed installer to the Desktop.

.PARAMETER Target
    Target platform: 'windows' (default) or 'all'.

.PARAMETER Sign
    Signs the release binaries using tauri-signer and .tauri-updater.key.

.PARAMETER Version
    The version string to build (e.g. '1.4.4'). If omitted, read from package.json.

.PARAMETER DesktopPath
    Destination directory for delivering the release installer.
    Defaults to the current user's Desktop ($env:USERPROFILE\Desktop).
#>

[CmdletBinding()]
param(
    [ValidateSet('windows', 'all')]
    [string]$Target = 'windows',

    [switch]$Sign,

    [string]$Version,

    [string]$DesktopPath
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# 1. Resolve DesktopPath
if ([string]::IsNullOrWhiteSpace($DesktopPath)) {
    $DesktopPath = Join-Path $env:USERPROFILE 'Desktop'
}

# 2. Resolve Version
if ([string]::IsNullOrWhiteSpace($Version)) {
    $pkgJsonPath = Join-Path $ProjectRoot 'package.json'
    if (Test-Path -LiteralPath $pkgJsonPath) {
        $pkg = Get-Content -LiteralPath $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Version = $pkg.version
    } else {
        $Version = '1.4.4'
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Cloakwire Release Build: Target=$Target, Version=$Version" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 3. Toolchain and Environment Setup
Write-Host "`n[1/5] Configuring build environment..." -ForegroundColor Yellow

$env:RUSTUP_HOME = "C:\Users\Public\cwdev\rustup-home"
$env:CARGO_HOME = "C:\Users\Public\cwdev\cargo-home"

$cargoCandidates = @(
    "C:\Users\Public\cwdev\cargo\bin",
    (Join-Path $env:USERPROFILE '.cargo\bin')
)
foreach ($cDir in $cargoCandidates) {
    if ((Test-Path -LiteralPath $cDir) -and ($env:PATH -notlike "*$cDir*")) {
        $env:PATH = "$cDir;$env:PATH"
    }
}

$toolsDirs = @(
    "C:\Program Files\nodejs",
    "C:\Program Files\Git\usr\bin",
    "C:\Program Files\Git\cmd"
)
foreach ($tDir in $toolsDirs) {
    if ((Test-Path -LiteralPath $tDir) -and ($env:PATH -notlike "*$tDir*")) {
        $env:PATH = "$env:PATH;$tDir"
    }
}

# CRITICAL: Production release builds must not embed the test manifest
Remove-Item Env:CLOAKWIRE_TEST_MANIFEST -ErrorAction SilentlyContinue
$env:CLOAKWIRE_TEST_MANIFEST = $null

# Verify Cargo and Node
$cargoExe = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoExe) {
    throw "Cargo was not found on PATH or candidate directories."
}
Write-Host "Using Cargo: $($cargoExe.Source)" -ForegroundColor Gray

# 4. Verify sidecars
Write-Host "`n[2/5] Verifying sidecar binaries..." -ForegroundColor Yellow
$binariesDir = Join-Path $ProjectRoot 'src-tauri\binaries'
$requiredSidecars = @(
    (Join-Path $binariesDir 'xray-x86_64-pc-windows-msvc.exe'),
    (Join-Path $binariesDir 'sing-box-x86_64-pc-windows-msvc.exe'),
    (Join-Path $binariesDir 'wintun.dll')
)
foreach ($sidecar in $requiredSidecars) {
    if (-not (Test-Path -LiteralPath $sidecar)) {
        throw "Required binary missing: $sidecar"
    }
    $item = Get-Item -LiteralPath $sidecar
    Write-Host "  OK: $($item.Name) ($($item.Length) bytes)" -ForegroundColor Gray
}

# 5. Build Frontend & Tauri App
Write-Host "`n[3/5] Building Windows release bundle..." -ForegroundColor Yellow

$distDir = Join-Path $ProjectRoot "dist-release"
if (-not (Test-Path -LiteralPath $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

# Run frontend build
Write-Host "  -> Running frontend build (npm run build)..." -ForegroundColor Gray
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& npm.cmd run build
$npmBuildExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($npmBuildExit -ne 0) {
    throw "Frontend build failed with exit code $npmBuildExit"
}

# Run tauri build
Write-Host "  -> Running Tauri release build (npm run tauri build)..." -ForegroundColor Gray
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& npm.cmd run tauri build
$tauriExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($tauriExit -ne 0) {
    throw "Tauri build failed with exit code $tauriExit"
}

# Locate generated bundle
$expectedNsisName = "Cloakwire_$Version`_x64-setup.exe"
$candidateNsisPaths = @(
    "C:\Users\Public\cwdev\target\release\bundle\nsis\$expectedNsisName",
    (Join-Path $ProjectRoot "src-tauri\target\release\bundle\nsis\$expectedNsisName")
)
$sourceNsis = $candidateNsisPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $sourceNsis) {
    throw "Generated NSIS installer not found! Checked locations: $($candidateNsisPaths -join '; ')"
}

$expectedMsiName = "Cloakwire_$Version`_x64_en-US.msi"
$candidateMsiPaths = @(
    "C:\Users\Public\cwdev\target\release\bundle\msi\$expectedMsiName",
    (Join-Path $ProjectRoot "src-tauri\target\release\bundle\msi\$expectedMsiName")
)
$sourceMsi = $candidateMsiPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

# Copy to dist-release
$distNsis = Join-Path $distDir $expectedNsisName
Copy-Item -LiteralPath $sourceNsis -Destination $distNsis -Force
Write-Host "  -> Staged NSIS installer to: $distNsis" -ForegroundColor Green

if ($sourceMsi) {
    $distMsi = Join-Path $distDir $expectedMsiName
    Copy-Item -LiteralPath $sourceMsi -Destination $distMsi -Force
    Write-Host "  -> Staged MSI installer to: $distMsi" -ForegroundColor Green
}

# 6. Sign Artifacts (if requested)
if ($Sign) {
    Write-Host "`n[4/5] Signing release artifacts..." -ForegroundColor Yellow
    $keyPath = Join-Path $ProjectRoot 'src-tauri\.tauri-updater.key'
    if (-not (Test-Path -LiteralPath $keyPath)) {
        throw "Tauri updater signing key not found at: $keyPath"
    }

    $signerExe = "C:\Users\Public\cwdev\target\release\tauri-signer.exe"
    if (-not (Test-Path -LiteralPath $signerExe)) {
        $signerExe = Join-Path $ProjectRoot 'src-tauri\crates\tauri-signer\target\release\tauri-signer.exe'
    }
    if (-not (Test-Path -LiteralPath $signerExe)) {
        Write-Host "  Building tauri-signer..." -ForegroundColor Gray
        & $cargoExe.Source build --release --manifest-path (Join-Path $ProjectRoot 'src-tauri\crates\tauri-signer\Cargo.toml')
        $signerExe = Join-Path $ProjectRoot 'src-tauri\crates\tauri-signer\target\release\tauri-signer.exe'
    }
    if (-not (Test-Path -LiteralPath $signerExe)) {
        throw "tauri-signer.exe is missing and could not be built."
    }

    # Sign NSIS
    Write-Host "  Signing $distNsis..." -ForegroundColor Gray
    & $signerExe -k $keyPath $distNsis
    $sigPath = "$distNsis.sig"
    if (-not (Test-Path -LiteralPath $sigPath)) {
        throw "Signature sidecar was not generated: $sigPath"
    }
    Write-Host "  Created signature: $sigPath" -ForegroundColor Green

    # Sign MSI if present
    if ($sourceMsi -and (Test-Path -LiteralPath $distMsi)) {
        Write-Host "  Signing $distMsi..." -ForegroundColor Gray
        & $signerExe -k $keyPath $distMsi
    }
} else {
    Write-Host "`n[4/5] Skipping signing (-Sign not specified)." -ForegroundColor Gray
}

# 7. Deliver to Desktop
Write-Host "`n[5/5] Delivering release binary to Desktop..." -ForegroundColor Yellow
if (-not (Test-Path -LiteralPath $DesktopPath)) {
    New-Item -ItemType Directory -Path $DesktopPath -Force | Out-Null
}

$desktopInstaller = Join-Path $DesktopPath $expectedNsisName
Copy-Item -LiteralPath $distNsis -Destination $desktopInstaller -Force

if ($Sign -and (Test-Path -LiteralPath "$distNsis.sig")) {
    $desktopSig = Join-Path $DesktopPath "$expectedNsisName.sig"
    Copy-Item -LiteralPath "$distNsis.sig" -Destination $desktopSig -Force
}

$finalItem = Get-Item -LiteralPath $desktopInstaller
$sha256 = (Get-FileHash -LiteralPath $desktopInstaller -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  RELEASE BUILD & DELIVERY SUCCESSFUL" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Artifact:  $($finalItem.FullName)" -ForegroundColor Green
Write-Host "Size:      $($finalItem.Length) bytes ($([math]::Round($finalItem.Length / 1MB, 2)) MB)" -ForegroundColor Green
Write-Host "Modified:  $($finalItem.LastWriteTime)" -ForegroundColor Green
Write-Host "SHA256:    $sha256" -ForegroundColor Green
if ($Sign) {
    Write-Host "Signature: $($finalItem.FullName).sig (present)" -ForegroundColor Green
}
