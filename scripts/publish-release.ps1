# Validate -> draft -> exact uploads -> GitHub digests -> optional stable promotion.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DistPath,
    [string]$NotesFile,
    [string]$VerifierPath,
    [string]$GhPath = 'gh',
    [switch]$ValidateOnly,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot 'release-workflow.psm1') -Force
$DistPath = [IO.Path]::GetFullPath($DistPath)
$infoPath = Join-Path $DistPath 'release-build.json'
if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf)) { throw 'release-build.json is missing. Publish only a verified build-all-platforms output.' }
$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
if ($info.schema -ne 1 -or $info.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or $info.commit -notmatch '^[0-9a-f]{40}$' -or $info.source_archive_sha256 -notmatch '^[0-9a-f]{64}$') { throw 'Release provenance is invalid.' }
$version = $info.version; $tag = "v$version"; $repository = 'markwhite7881-cpu/cloakwire'
if (-not $VerifierPath) {
    $builtVerifier = Join-Path (Split-Path -Parent $DistPath) 'target/debug/release-verify.exe'
    if (Test-Path -LiteralPath $builtVerifier) { $VerifierPath = $builtVerifier }
}
$validation = @{ Version=$version; DistPath=$DistPath; ManifestPath=(Join-Path $DistPath 'latest.json'); RequiredPlatforms=@('windows-x86_64','darwin-aarch64','darwin-x86_64','android-arm64-v8a'); FullRelease=$true; ProjectRoot=$repo }
if ($VerifierPath) { $validation.VerifierPath = $VerifierPath }
& (Join-Path $PSScriptRoot 'validate-release.ps1') @validation
$catalog = @(Get-ReleaseCatalog $repo)
if (@($info.artifacts).Count -ne $catalog.Count) { throw 'Build provenance does not cover every release artifact.' }
foreach ($item in $catalog) {
    $name = "Cloakwire_$version`_$($item.suffix)"
    $records = @($info.artifacts | Where-Object { $_.name -ceq $name })
    if ($records.Count -ne 1) { throw "Missing or duplicate build provenance: $name" }
    $file = Get-Item -LiteralPath (Join-Path $DistPath $name)
    if ($records[0].size -ne $file.Length -or $records[0].sha256 -cne (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()) { throw "Build provenance differs from staged bytes: $name" }
}
$expected = @(Get-ReleaseAssetNames $repo $version -IncludeBuildInfo)
if ($ValidateOnly) { Write-Output "Verified $tag locally: seven signed artifacts, updater manifest, checksums and provenance. No GitHub write."; return }
$head = Assert-ReleaseSource $repo
if ($head -cne $info.commit) { throw 'Current reviewed HEAD differs from the source commit recorded by the build.' }
$node = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
Invoke-ReleaseCommand $node @((Join-Path $PSScriptRoot 'release-version.mjs'),'check','--project-root',$repo,'--version',$version)
if (-not $NotesFile) { $NotesFile = Join-Path (Split-Path -Parent $DistPath) 'RELEASE_NOTES.md' }
if (-not (Test-Path -LiteralPath $NotesFile -PathType Leaf)) { throw 'Reviewed release notes are missing.' }
$notes = [IO.File]::ReadAllText([IO.Path]::GetFullPath($NotesFile))
if ([string]::IsNullOrWhiteSpace($notes)) { throw 'Release notes are empty.' }

function GhJson([string[]]$Arguments) {
    $json = Invoke-ReleaseCommand $GhPath (@('api') + $Arguments) -PassThru
    $parsed = $json | ConvertFrom-Json
    foreach ($entry in $parsed) { Write-Output $entry }
}
# The remote tag must already identify the exact reviewed build commit.
$ref = GhJson @("repos/$repository/git/ref/tags/$tag")
$object = $ref.object
for ($i=0; $object.type -eq 'tag' -and $i -lt 4; $i++) { $object = (GhJson @("repos/$repository/git/tags/$($object.sha)")).object }
if ($object.type -ne 'commit' -or $object.sha -cne $info.commit) { throw 'Remote release tag does not identify the verified source commit.' }
function Get-GhReleases {
    for ($page=1; $page -le 1000; $page++) {
        $batch = @(GhJson @("repos/$repository/releases?per_page=100&page=$page"))
        foreach ($releaseItem in $batch) { Write-Output $releaseItem }
        if ($batch.Count -lt 100) { return }
    }
    throw 'Release history is too large to verify safely.'
}
$releases = @(Get-GhReleases)
$matches = @($releases | Where-Object { $_.tag_name -ceq $tag })
if ($matches.Count -gt 1) { throw 'GitHub returned ambiguous release drafts.' }
if ($matches.Count -eq 1 -and -not $matches[0].draft) { throw 'This release is already public. Existing published files will not be replaced.' }
if ($Publish) {
    $currentLatest = GhJson @("repos/$repository/releases/latest")
    $stableTags = @($releases | Where-Object { -not $_.draft -and -not $_.prerelease } | ForEach-Object tag_name)
    Assert-ReleaseVersionIncrease $version $currentLatest.tag_name $stableTags
}
if ($matches.Count -eq 0) {
    $payload = [ordered]@{tag_name=$tag;target_commitish=$info.commit;name="Cloakwire $tag";body=$notes;draft=$true;prerelease=$false}
    $payloadPath = Join-Path ([IO.Path]::GetTempPath()) ('cloakwire-release-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($payloadPath,($payload | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
        $release = GhJson @('--method','POST',"repos/$repository/releases",'--input',$payloadPath)
    } finally { if (Test-Path -LiteralPath $payloadPath) { Remove-Item -LiteralPath $payloadPath } }
} else { $release = $matches[0] }
if (-not $release.draft -or $release.tag_name -cne $tag) { throw 'GitHub did not return the expected draft.' }
if ($release.body -cne $notes) {
    $updatePath = Join-Path ([IO.Path]::GetTempPath()) ('cloakwire-notes-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($updatePath,(@{body=$notes} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        $release = GhJson @('--method','PATCH',"repos/$repository/releases/$($release.id)",'--input',$updatePath)
    } finally { if (Test-Path -LiteralPath $updatePath) { Remove-Item -LiteralPath $updatePath } }
    if (-not $release.draft -or $release.body -cne $notes) { throw 'GitHub draft notes do not match the reviewed notes file.' }
}
$existing = @($release.assets)
foreach ($asset in $existing) { if ($asset.name -cnotin $expected) { throw "Draft contains an unexpected asset: $($asset.name)" } }
if ($existing.Count) { Assert-UploadedReleaseAssets $existing $DistPath @($existing | ForEach-Object name) }
$upload = @($expected | Where-Object { $_ -cnotin @($existing | ForEach-Object name) } | ForEach-Object { Join-Path $DistPath $_ })
if ($upload.Count) { Invoke-ReleaseCommand $GhPath (@('release','upload',$tag,'--repo',$repository) + $upload) }
# Fail closed on a missing digest or mismatched remote file. Resume preserves matching assets.
$release = GhJson @("repos/$repository/releases/$($release.id)")
Assert-UploadedReleaseAssets @($release.assets) $DistPath $expected
if (-not $release.draft) { throw 'Release was published by another actor before verification finished.' }
if (-not $Publish) {
    Write-Output "Draft uploaded and all $($expected.Count) GitHub digests verified: $($release.html_url)"
    Write-Output 'Run this command with -Publish to promote the same verified draft.'
    return
}
# Uploading can take time: recheck public versions immediately before promotion.
$currentLatest = GhJson @("repos/$repository/releases/latest")
$stableTags = @(Get-GhReleases | Where-Object { -not $_.draft -and -not $_.prerelease } | ForEach-Object tag_name)
Assert-ReleaseVersionIncrease $version $currentLatest.tag_name $stableTags
$published = GhJson @('--method','PATCH',"repos/$repository/releases/$($release.id)",'-F','draft=false','-F','prerelease=false','-f','make_latest=true')
if ($published.draft -or $published.tag_name -cne $tag) { throw 'GitHub returned an unexpected publication state.' }
$latest = GhJson @("repos/$repository/releases/latest")
if ($latest.id -ne $published.id -or $latest.tag_name -cne $tag) { throw 'Publication completed but latest metadata does not yet point at this release; inspect GitHub before retrying.' }
Assert-UploadedReleaseAssets @($latest.assets) $DistPath $expected
Write-Output "Published and verified latest stable release: $($latest.html_url)"
