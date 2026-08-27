# Builds the Rust core (libcloakwire_lib.so) for Android ARM64 and
# stages it into the Gradle jniLibs directory.
#
# This is the reproducible replacement for the Gradle `rustBuildArm64Release`
# task, which shells out to `tauri android android-studio-script` and has
# proven flaky on this machine. The Gradle gates run with
# `-x :app:rustBuildArm64Release` and expect this script to have staged a
# fresh .so beforehand.
#
# Usage:
#   .\scripts\build-android-rust.ps1            # build + stage
#   .\scripts\build-android-rust.ps1 -SkipDist  # skip the `npm run build`
#                                               # (dist/ is embedded into
#                                               # the .so by tauri's
#                                               # generate_context!)
#
# Requirements (already configured on this machine):
#   - cargo on PATH or at C:\Users\Public\cwdev\cargo\bin
#   - RUSTUP_HOME / CARGO_HOME pointing at C:\Users\Public\cwdev\{rustup,cargo}-home
#   - NDK at C:\Users\Public\cwdev\ndk (symlink to the SDK NDK dir)
[CmdletBinding()]
param(
  [switch]$SkipDist
)

$ErrorActionPreference = 'Stop'

# Self-contained toolchain discovery: the scripts must run from a
# plain PowerShell session without any prior env setup.
$cargoBin = 'C:\Users\Public\cwdev\cargo\bin'
if ((Test-Path $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) {
  $env:PATH = "$cargoBin;$env:PATH"
}
if (-not $env:RUSTUP_HOME) { $env:RUSTUP_HOME = 'C:\Users\Public\cwdev\rustup-home' }
if (-not $env:CARGO_HOME) { $env:CARGO_HOME = 'C:\Users\Public\cwdev\cargo-home' }

$repo = Split-Path -Parent $PSScriptRoot
$target = 'aarch64-linux-android'
$ndkBin = 'C:/Users/Public/cwdev/ndk/toolchains/llvm/prebuilt/windows-x86_64/bin'
$outSo = "C:/Users/Public/cwdev/target/$target/release/libcloakwire_lib.so"
$destSo = Join-Path $repo 'src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libcloakwire_lib.so'

# tauri::generate_context! embeds dist/ at compile time - rebuild the
# frontend first so the .so carries the current UI.
if (-not $SkipDist) {
  Write-Host '== npm run build (frontend dist for generate_context!) =='
  Push-Location $repo
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  } finally {
    Pop-Location
  }
}

Write-Host "== cargo build --release --lib --target $target =="
$env:CC_aarch64_linux_android = "$ndkBin/aarch64-linux-android24-clang.cmd"
$env:CXX_aarch64_linux_android = "$ndkBin/aarch64-linux-android24-clang++.cmd"
$env:AR_aarch64_linux_android = "$ndkBin/llvm-ar.exe"
# Linker/ar come from src-tauri/.cargo/config.toml.
Push-Location (Join-Path $repo 'src-tauri')
try {
  cargo build --release --lib --target $target
  if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
} finally {
  Pop-Location
}

if (-not (Test-Path $outSo)) { throw "expected output not found: $outSo" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destSo) | Out-Null
Copy-Item $outSo $destSo -Force
$hash = (Get-FileHash $destSo -Algorithm SHA256).Hash
Write-Host "staged libcloakwire_lib.so ($((Get-Item $destSo).Length) bytes)"
Write-Host "SHA-256: $hash"
