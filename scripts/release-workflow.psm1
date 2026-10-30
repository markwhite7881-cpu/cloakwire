# npm or a PowerShell 7 parent can pass its module search path to Windows
# PowerShell. Load that shell's own utility module, including Get-FileHash.
if ($PSVersionTable.PSVersion.Major -eq 5) {
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -Global -Force
}
Set-StrictMode -Version Latest

function ConvertTo-ReleaseWindowsArgument {
    param([AllowEmptyString()][string]$Value)
    '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-ReleaseCommand {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory, [string]$LogPath, [switch]$PassThru)
    $executable = if (Test-Path -LiteralPath $FilePath -PathType Leaf) { [IO.Path]::GetFullPath($FilePath) } else { (Get-Command $FilePath -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.WorkingDirectory = if ($WorkingDirectory) { [IO.Path]::GetFullPath($WorkingDirectory) } else { (Get-Location).ProviderPath }
    $startInfo.FileName = $executable
    $quoted = @($Arguments | ForEach-Object { ConvertTo-ReleaseWindowsArgument $_ })
    if ([IO.Path]::GetExtension($executable) -in @('.cmd','.bat')) {
        # Batch wrappers need cmd.exe. Their arguments are build task names and
        # flags, never arbitrary shell fragments or secret values.
        foreach ($argument in $Arguments) {
            if ($argument -match '["\r\n%!]') { throw 'Unsafe batch-wrapper argument. Use an executable for arguments containing quotes, percent signs, or newlines.' }
        }
        $startInfo.FileName = $env:ComSpec
        $startInfo.Arguments = '/d /s /c "' + ((ConvertTo-ReleaseWindowsArgument $executable) + ' ' + ($quoted -join ' ')) + '"'
    } elseif ($startInfo.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
    } else { $startInfo.Arguments = $quoted -join ' ' }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Cannot start release command: $executable" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $output = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        $code = $process.ExitCode
        if ($LogPath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($LogPath), $output, [Text.UTF8Encoding]::new($false)) }
        if ($output) { if ($PassThru) { Write-Output $output } else { Write-Host $output.TrimEnd() } }
    } finally { $process.Dispose() }
    if ($code -ne 0) { throw "Release command '$([IO.Path]::GetFileName($executable))' failed with exit code $code. See its build log." }
}
function Get-ReleaseCatalog {
    param([string]$ProjectRoot)
    $catalog = Get-Content -LiteralPath (Join-Path $ProjectRoot 'scripts/release-artifacts.json') -Raw | ConvertFrom-Json
    foreach ($entry in $catalog) { Write-Output $entry }
}

function Get-ReleaseAssetNames {
    param([string]$ProjectRoot, [string]$Version, [switch]$IncludeBuildInfo)
    $names = @()
    foreach ($item in (Get-ReleaseCatalog $ProjectRoot)) {
        $name = "Cloakwire_$Version`_$($item.suffix)"
        $names += $name
        $names += "$name.sig"
    }
    $names += @('latest.json', 'SHA256SUMS.txt', "SHA256SUMS_v$Version.txt")
    if ($IncludeBuildInfo) { $names += 'release-build.json' }
    $names
}

function Assert-ReleaseSource {
    param([string]$ProjectRoot)
    $tracked = @(& git -C $ProjectRoot status --porcelain=v1 --untracked-files=no)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the release source repository.' }
    # Ignored/prebuilt SDKs and binary inputs are recorded separately, not app source.
    $sourcePaths = @('src', 'src-tauri/src', 'scripts', '.github', 'src-tauri/gen/android/app/src/main/java', 'src-tauri/gen/android/app/src/main/res', 'src-tauri/gen/android/app/src/test', 'src-tauri/gen/android/buildSrc')
    $untracked = @(& git -C $ProjectRoot ls-files --others --exclude-standard -- @sourcePaths)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect uncommitted release source files.' }
    if ($tracked.Count -gt 0 -or $untracked.Count -gt 0) {
        throw 'Release source has uncommitted changes. Commit the reviewed application and release tooling first: all platforms are built from one HEAD archive.'
    }
    $commit = (& git -C $ProjectRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Release HEAD is not a valid commit.' }
    $commit
}

function Assert-FreshReleaseArtifact {
    param([string]$Path, [datetime]$StartedAt)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Build did not produce required artifact: $Path" }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -le 0) { throw "Build produced an empty artifact: $Path" }
    if ($item.LastWriteTimeUtc -lt $StartedAt.ToUniversalTime().AddSeconds(-2)) { throw "Build artifact predates this run: $Path" }
}

function Assert-UploadedReleaseAssets {
    param([object[]]$Assets, [string]$DistPath, [string[]]$ExpectedNames)
    if ($Assets.Count -ne $ExpectedNames.Count) { throw "Uploaded release has $($Assets.Count) assets; expected $($ExpectedNames.Count)." }
    foreach ($name in $ExpectedNames) {
        $matches = @($Assets | Where-Object { $_.name -ceq $name })
        if ($matches.Count -ne 1 -or $matches[0].state -ne 'uploaded') { throw "Missing, duplicate or incomplete uploaded asset: $name" }
        $local = Get-Item -LiteralPath (Join-Path $DistPath $name)
        $expectedDigest = 'sha256:' + (Get-FileHash -LiteralPath $local.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($matches[0].size -ne $local.Length -or $matches[0].digest -cne $expectedDigest) { throw "GitHub content differs from the verified local asset: $name" }
    }
}

function ConvertTo-ReleaseShellArgument {
    param([AllowEmptyString()][string]$Value)
    "'" + $Value.Replace("'", "'" + [char]34 + "'" + [char]34 + "'") + "'"
}

function Get-ReleaseFileRecord {
    param([string]$Path)
    $file = Get-Item -LiteralPath $Path
    [ordered]@{ name = $file.Name; size = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Assert-ReleaseVersionIncrease {
    param([string]$Version, [string]$LatestTag, [string[]]$StableTags)
    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Invalid candidate release version.' }
    foreach ($tag in @($LatestTag) + $StableTags) {
        if ($tag -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw "Cannot compare stable release version: $tag" }
        if ([version]$Version -le [version]$tag.Substring(1)) { throw 'Stable publication must increase every public stable version; latest cannot be downgraded.' }
    }
}
Export-ModuleMember -Function Assert-ReleaseVersionIncrease, Invoke-ReleaseCommand, Get-ReleaseCatalog, Get-ReleaseAssetNames, Assert-ReleaseSource, Assert-FreshReleaseArtifact, Assert-UploadedReleaseAssets, ConvertTo-ReleaseShellArgument, Get-ReleaseFileRecord
