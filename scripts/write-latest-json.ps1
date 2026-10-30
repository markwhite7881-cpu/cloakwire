param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$DistPath,
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [string]$OutputPath = (Join-Path $DistPath 'latest.json'),
    [string]$NotesFile,
    [string]$ArtifactName,
    [string]$Platform,
    [string]$SignaturePath
)
$ErrorActionPreference = 'Stop'
$DistPath = (Resolve-Path -LiteralPath $DistPath).ProviderPath
$OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Version must be numeric x.y.z without leading zeros or prerelease/build suffixes.'
}
$expectedBaseUrl = "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v$Version"
if ($BaseUrl.TrimEnd('/') -cne $expectedBaseUrl) {
    throw "BaseUrl must be exactly '$expectedBaseUrl'."
}
$catalog = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'release-artifacts.json') | ConvertFrom-Json
if ($catalog.Count -ne 7 -or @($catalog | Where-Object { $_.updater }).Count -ne 4) {
    throw 'Artifact catalog must contain seven binaries and four updater artifacts.'
}
$legacy = $ArtifactName -or $Platform -or $SignaturePath
if ($legacy) {
    if (-not ($ArtifactName -and $Platform -and $SignaturePath)) { throw 'ArtifactName, Platform and SignaturePath must be supplied together.' }
    $selected = @($catalog | Where-Object { $_.updater -and $_.platform -ceq $Platform -and "Cloakwire_$Version`_$($_.suffix)" -ceq $ArtifactName })
    if ($selected.Count -ne 1) { throw "Artifact '$ArtifactName' does not have the required version token/name for platform '$Platform'." }
} else { $selected = $catalog }
$platforms = [ordered]@{}
foreach ($artifact in $selected) {
    $name = "Cloakwire_$Version`_$($artifact.suffix)"
    $path = Join-Path $DistPath $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Artifact is missing: $path" }
    $size = (Get-Item -LiteralPath $path).Length
    if ($size -le 0) { throw "Artifact is empty: $path" }
    $sidecar = if ($legacy) { $SignaturePath } else { "$path.sig" }
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { throw "Signature is missing: $sidecar" }
    $signatureBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $sidecar).ProviderPath)
    if ($signatureBytes.Length -eq 0) { throw "Signature is empty: $sidecar" }
    if ($artifact.updater) {
        if ($platforms.Contains($artifact.platform)) { throw "Duplicate updater platform '$($artifact.platform)' in artifact catalog." }
        $platforms[$artifact.platform] = [ordered]@{
            url = "$expectedBaseUrl/$name"
            signature = [Convert]::ToBase64String($signatureBytes)
            size = $size
        }
    }
}
$utf8 = [Text.UTF8Encoding]::new($false)
$notes = "Release v$Version - see the GitHub release notes for the full changelog."
if ($NotesFile) { $notes = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $NotesFile).ProviderPath, $utf8) }
$manifest = [ordered]@{
    version = $Version
    notes = $notes
    pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = $platforms
} | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($OutputPath, $manifest, $utf8)
Write-Output "Wrote updater manifest: $OutputPath"
