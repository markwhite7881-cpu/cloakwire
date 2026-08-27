[CmdletBinding()]
param(
  [string]$BinaryPath = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\xray-arm64.bin',
  [string]$StagingPath = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\libxray.so'
)

$ErrorActionPreference = 'Stop'

$PinnedSha = '8593ff12755fa1bfae22f0774a308dcd0752827f94ac75c76712c98a87b76b2f'

if (-not (Test-Path -LiteralPath $BinaryPath)) {
  throw "xray binary not found at: $BinaryPath"
}

$bytes = [System.IO.File]::ReadAllBytes($BinaryPath)
$size = $bytes.Length
if ($size -lt 1024) { throw "xray binary is too small ($size bytes)" }

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $got = -join ($sha.ComputeHash($bytes) | ForEach-Object { '{0:x2}' -f $_ })
} finally {
  $sha.Dispose()
}
if ($got -ne $PinnedSha) {
  throw "xray SHA-256 mismatch (pinned $PinnedSha, got $got)"
}

$magic = ($bytes[0..3] | ForEach-Object { '{0:X2}' -f $_ }) -join ''
if ($magic -ne '7F454C46') { throw "xray ELF magic mismatch" }

$machine = [System.BitConverter]::ToUInt16($bytes, 18)
if ($machine -ne 183) { throw "xray e_machine != 183 (AArch64)" }

$stagingDir = Split-Path -Parent -Path $StagingPath
if (-not (Test-Path -LiteralPath $stagingDir)) {
  New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
}

# AGP's jniLibs packaging filters out non-.so files. We exec the
# binary by absolute path at runtime, so the .so extension is
# cosmetic — the file is still a standalone ARM64 ELF executable.
Copy-Item -LiteralPath $BinaryPath -Destination $StagingPath -Force

Write-Host "xray.size=$size"
Write-Host "xray.sha256=$got"
Write-Host "xray.staged=$StagingPath"
Write-Host "OK"
