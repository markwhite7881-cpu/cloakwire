[CmdletBinding()]
param(
    [string]$StageRoot = (Join-Path $PSScriptRoot '..\.android-build\libxray-v26.7.28'),
    [switch]$ExtractAar
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$expectedZipSha256 = '28B7DC9D6CC8455FCCA5CBD56E387003A7BFB558128651A64899DC3A8CCFF666'
$expectedAarSha256 = '4708A361A74F7E955635DBE3661CEFB459BDC867423C3B1826A2C5A6EA4AC77D'
$zipPath = Join-Path $StageRoot 'libxray-android.zip'
$extractRoot = Join-Path $StageRoot 'extracted'
$aarRelativePath = 'libxray-android/libXray.aar'
$aarPath = Join-Path $extractRoot ($aarRelativePath -replace '/', '\')

if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    throw "Missing pinned libXray ZIP: $zipPath"
}

$zipSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
if ($zipSha256 -ne $expectedZipSha256) {
    throw "libXray ZIP SHA-256 mismatch: $zipSha256"
}

if ($ExtractAar -and -not (Test-Path -LiteralPath $aarPath -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entryNames = @($zip.Entries | ForEach-Object FullName)
    if ($entryNames -notcontains $aarRelativePath) {
        throw "Pinned ZIP does not contain $aarRelativePath"
    }
    $hasSources = $entryNames -contains 'libxray-android/libXray-sources.jar'
} finally {
    $zip.Dispose()
}

if (-not (Test-Path -LiteralPath $aarPath -PathType Leaf)) {
    throw "AAR is not extracted. Rerun with -ExtractAar: $aarPath"
}

$aarSha256 = (Get-FileHash -LiteralPath $aarPath -Algorithm SHA256).Hash.ToUpperInvariant()
if ($aarSha256 -ne $expectedAarSha256) {
    throw "libXray AAR SHA-256 mismatch: $aarSha256"
}

$aarZip = [System.IO.Compression.ZipFile]::OpenRead($aarPath)
try {
    $jniEntries = @($aarZip.Entries | Where-Object { $_.FullName -match '^jni/arm64-v8a/.+\.so$' } | ForEach-Object FullName)
    if ($jniEntries.Count -eq 0) {
        throw 'libXray AAR has no arm64-v8a JNI payload'
    }
    $hasClasses = @($aarZip.Entries | Where-Object { $_.FullName -eq 'classes.jar' }).Count -eq 1
} finally {
    $aarZip.Dispose()
}

[pscustomobject]@{
    zip_sha256 = $zipSha256
    aar_sha256 = $aarSha256
    zip_contains_sources = $hasSources
    aar_contains_classes = $hasClasses
    arm64_jni_entries = ($jniEntries -join ',')
} | ConvertTo-Json -Compress
