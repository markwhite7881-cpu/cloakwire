[CmdletBinding()]
param(
  [string]$SourceApk = 'C:\Users\Алексей\.minimax\v2\assets\2026\08\17\02-21-16-783-asset_20260817-022116-783_07711c61dec3_8ae9cec2-Cloakwire_1.2.0_arm64-v8a.apk',
  [string]$OutDir = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a',
  [string]$OutFile = 'libcloakwire_lib.so'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'

if (-not (Test-Path -LiteralPath $SourceApk)) { throw "source APK not found: $SourceApk" }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$zip = [System.IO.Compression.ZipFile]::OpenRead($SourceApk)
$entry = $zip.Entries | Where-Object { $_.FullName -eq "lib/arm64-v8a/$OutFile" } | Select-Object -First 1
if ($null -eq $entry) {
  $zip.Dispose()
  throw "lib/arm64-v8a/$OutFile not found inside $SourceApk"
}

$targetPath = Join-Path $OutDir $OutFile
$stream = $entry.Open()
$fileStream = [System.IO.File]::Create($targetPath)
$stream.CopyTo($fileStream)
$fileStream.Close()
$stream.Close()
$zip.Dispose()

$size = (Get-Item $targetPath).Length
$sha = (Get-FileHash $targetPath -Algorithm SHA256).Hash
Write-Host "extracted=$targetPath"
Write-Host "size=$size"
Write-Host "sha256=$sha"

# ELF magic + AArch64 sanity check
$reader = New-Object System.IO.BinaryReader([System.IO.File]::Open($targetPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read))
$reader.BaseStream.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
$magic = $reader.ReadBytes(4)
$hex = -join ($magic | ForEach-Object { '{0:X2}' -f $_ })
$reader.BaseStream.Seek(18, [System.IO.SeekOrigin]::Begin) | Out-Null
$machine = $reader.ReadUInt16()
$reader.Close()
Write-Host "magic=$hex  e_machine=$machine (expect 183 for AArch64)"
if ($hex -ne '7F454C46') { throw "ELF magic mismatch" }
if ($machine -ne 183) { throw "Not AArch64" }
Write-Host "OK"
