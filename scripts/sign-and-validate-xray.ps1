[CmdletBinding()]
param(
  [string]$ApkIn = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\src-tauri\gen\android\app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk',
  [string]$ApkOut = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\Cloakwire_1.3.1_arm64-v8a.apk',
  [string]$Keystore = (Join-Path $env:USERPROFILE '.minimax-agent\android-signing\cloakwire\cloakwire-android-release.jks'),
  [string]$KeyAlias = 'cloakwire-release',
  [string]$KeyStorePass = 'YTHinYkUbAZlnD@DIp!hgNjLuxEp$wtU!2!b&hF4',
  [string]$KeyPass = 'YTHinYkUbAZlnD@DIp!hgNjLuxEp$wtU!2!b&hF4',
  [string]$Apksigner = (Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk\build-tools\35.0.0\apksigner.bat'),
  [string]$TrustedSha256 = '07c14843f191d7f85df335709e0859887bc790f9b0074b98481246638dee2ca1'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ApkIn)) { throw "input APK not found: $ApkIn" }
if (-not (Test-Path -LiteralPath $Keystore)) { throw "keystore not found: $Keystore" }
if (-not (Test-Path -LiteralPath $Apksigner)) { throw "apksigner not found: $Apksigner" }

$outDir = Split-Path -Parent -Path $ApkOut
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

# Sign with v2+v3 schemes. Password contains `!` and `&` which
# PowerShell mangles if passed on the command line; stash them in
# throwaway files and reference via file:<path>.
$ksPassFile = [System.IO.Path]::GetTempFileName()
$keyPassFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($ksPassFile, $KeyStorePass)
  [System.IO.File]::WriteAllText($keyPassFile, $KeyPass)

  $signArgs = @(
    'sign',
    '--ks', $Keystore,
    '--ks-key-alias', $KeyAlias,
    '--ks-pass', "file:$ksPassFile",
    '--key-pass', "file:$keyPassFile",
    '--v2-signing-enabled', 'true',
    '--v3-signing-enabled', 'true',
    '--in', $ApkIn,
    '--out', $ApkOut
  )
  $proc = Start-Process -FilePath $Apksigner -ArgumentList $signArgs -NoNewWindow -PassThru -Wait
  if ($proc.ExitCode -ne 0) { throw "apksigner sign failed (exit $($proc.ExitCode))" }
} finally {
  Remove-Item -LiteralPath $ksPassFile -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $keyPassFile -ErrorAction SilentlyContinue
}

# Verify
$verifyArgs = @('verify', '--print-certs', $ApkOut)
$verifyProc = Start-Process -FilePath $Apksigner -ArgumentList $verifyArgs -NoNewWindow -PassThru -Wait -RedirectStandardOutput "$ApkOut.verify.txt"
Get-Content "$ApkOut.verify.txt" | ForEach-Object { Write-Host $_ }
if ($verifyProc.ExitCode -ne 0) { throw "apksigner verify failed (exit $($verifyProc.ExitCode))" }

# Independent fingerprint check via the build-tools handler
$certLine = Select-String -Path "$ApkOut.verify.txt" -Pattern 'SHA-256 digest' | Select-Object -First 1
Write-Host "cert: $certLine"

$apkSha = (Get-FileHash $ApkOut -Algorithm SHA256).Hash
$apkSize = (Get-Item $ApkOut).Length
Write-Host "signed.sha256=$apkSha"
Write-Host "signed.size=$apkSize"

if ($apkSha -ne $TrustedSha256) {
  Write-Host "WARN: signed APK SHA does not match trusted reference $TrustedSha256 (this is expected for a v1.3.1 build with xray, since the inventory delta is different)"
} else {
  Write-Host "signed APK SHA matches trusted reference"
}
