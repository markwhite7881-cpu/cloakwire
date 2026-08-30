param(
    [string]$Version = "1.4.0"
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$KeyPath = Join-Path $ProjectRoot 'src-tauri\.tauri-updater.key'
$SignerExe = "C:\Users\Public\cwdev\target\release\tauri-signer.exe"
$DistDir = Join-Path $ProjectRoot "dist-release"

$BaseUrl = "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v$Version"

$artifacts = @(
    @{ File = "Cloakwire_$Version`_x64-setup.exe"; Platform = "windows-x86_64" },
    @{ File = "Cloakwire_$Version`_aarch64.dmg"; Platform = "darwin-aarch64" },
    @{ File = "Cloakwire_$Version`_x64.dmg"; Platform = "darwin-x86_64" }
)

$signatures = [ordered]@{}
$utf8 = [Text.UTF8Encoding]::new($false)

foreach ($item in $artifacts) {
    $filePath = Join-Path $DistDir $item.File
    if (!(Test-Path $filePath)) {
        throw "Missing artifact: $filePath"
    }
    Write-Host "Signing $($item.File)..." -ForegroundColor Cyan
    & $SignerExe -k $KeyPath $filePath
    $sigPath = "$filePath.sig"
    if (!(Test-Path $sigPath)) {
        throw "Missing signature: $sigPath"
    }
    $sigText = (Get-Content $sigPath -Raw -Encoding UTF8).Trim()
    $sigB64 = [Convert]::ToBase64String($utf8.GetBytes($sigText))
    
    $signatures[$item.Platform] = [ordered]@{
        url = "$BaseUrl/$($item.File)"
        signature = $sigB64
    }
}

# Also sign msi if present
$msiFile = Join-Path $DistDir "Cloakwire_$Version`_x64_en-US.msi"
if (Test-Path $msiFile) {
    & $SignerExe -k $KeyPath $msiFile
}

$changelogText = Get-Content -Raw -Encoding UTF8 "CHANGELOG.md"

$manifest = [ordered]@{
    version = $Version
    notes = "## Cloakwire $Version\n\nLinear Bento Redesign, 60 FPS live traffic wave, haptic feedback, smart clipboard, sing-box DNS & route fixes."
    pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = $signatures
}

$latestJsonPath = Join-Path $DistDir "latest.json"
$jsonContent = $manifest | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($latestJsonPath, $jsonContent, $utf8)

Write-Host "`nGenerated $latestJsonPath successfully:" -ForegroundColor Green
Get-Content $latestJsonPath
