$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Public\cwdev\cloakwire-android-v131-port'

$staging = '.android-build\libxray-v26.7.28'
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$archive = Join-Path $staging 'libxray-android.archive'
$assetUrl = 'https://github.com/XTLS/Xray-core/releases/download/v26.7.28/Xray-android-arm64-v8a.zip'
$expectedArchiveSha = 'a442892c175fa648fc56866ec872aac441c5a6b8946a1b60f0258ae16a7fb402'

if (-not (Test-Path $archive)) {
  Write-Host "Downloading Xray binary..."
  Invoke-WebRequest -Uri $assetUrl -OutFile $archive -UseBasicParsing
}

$archiveItem = Get-Item $archive
$archiveSha = (Get-FileHash $archive -Algorithm SHA256).Hash
Write-Host "archive.size=$($archiveItem.Length)"
Write-Host "archive.sha256=$archiveSha"
if ($archiveSha -ne $expectedArchiveSha) {
  throw "Archive SHA mismatch (expected $expectedArchiveSha)"
}

$extractDir = Join-Path $staging 'expanded'
if (-not (Test-Path $extractDir)) {
  Expand-Archive -Path $archive -DestinationPath $extractDir -Force
}

$candidates = Get-ChildItem -Path $extractDir -Recurse -File | Where-Object { $_.Name -eq 'xray' }
if ($candidates.Count -lt 1) { throw "xray binary not found in archive" }
$bin = $candidates[0].FullName
$binSha = (Get-FileHash $bin -Algorithm SHA256).Hash
$binSize = (Get-Item $bin).Length
Write-Host "binary.path=$bin"
Write-Host "binary.size=$binSize"
Write-Host "binary.sha256=$binSha"

$firstBytes = [System.IO.File]::ReadAllBytes($bin)[0..3] | ForEach-Object { '{0:X2}' -f $_ }
$firstHex = -join $firstBytes
Write-Host "binary.magic=$firstHex"
if ($firstHex -ne '7F454C46') { throw "ELF magic mismatch" }

$reader = New-Object System.IO.BinaryReader([System.IO.File]::Open($bin, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read))
$reader.BaseStream.Seek(18, [System.IO.SeekOrigin]::Begin) | Out-Null
$machine = $reader.ReadUInt16()
$reader.Close()
Write-Host "binary.e_machine=$machine (expect 183 for AArch64)"
if ($machine -ne 183) { throw "Not AArch64 ELF" }

$marker = Join-Path $staging 'extracted.sha256'
"$binSha  $($bin | Resolve-Path -Relative)" | Set-Content -Path $marker
Write-Host "marker=$marker"
Write-Host "DONE"
