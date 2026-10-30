$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'release-workflow.psm1') -Force
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('cloakwire-release-tests-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$passed = 0
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action; throw 'Expected failure was not raised.' } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
    }
    $script:passed++
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'." }
    $script:passed++
}
try {
    $repo = Join-Path $fixture 'source'
    $null = New-Item -ItemType Directory -Path (Join-Path $repo 'src')
    [IO.File]::WriteAllText((Join-Path $repo 'src/app.ts'), 'export const ready = true;')
    & git -C $repo init --quiet
    & git -C $repo add src/app.ts
    & git -C $repo -c user.name=ReleaseTest -c user.email=release-test@example.invalid commit --quiet -m fixture
    if ($LASTEXITCODE -ne 0) { throw 'Fixture repository initialization failed.' }
    $commit = (& git -C $repo rev-parse HEAD).Trim()
    Assert-Equal (Assert-ReleaseSource $repo) $commit
    [IO.File]::WriteAllText((Join-Path $repo 'src/app.ts'), 'changed')
    Assert-Throws { Assert-ReleaseSource $repo } 'uncommitted'
    [IO.File]::WriteAllText((Join-Path $repo 'src/app.ts'), 'export const ready = true;')
    [IO.File]::WriteAllText((Join-Path $repo 'src/new.ts'), 'not committed')
    Assert-Throws { Assert-ReleaseSource $repo } 'uncommitted'
    Remove-Item -LiteralPath (Join-Path $repo 'src/new.ts')

    $file = Join-Path $fixture 'expected.exe'
    $start = [datetime]::UtcNow
    Assert-Throws { Assert-FreshReleaseArtifact $file $start } 'did not produce'
    [IO.File]::WriteAllBytes($file, [byte[]]@())
    Assert-Throws { Assert-FreshReleaseArtifact $file $start } 'empty'
    [IO.File]::WriteAllText($file, 'fresh artifact')
    (Get-Item -LiteralPath $file).LastWriteTimeUtc = $start.AddMinutes(-5)
    Assert-Throws { Assert-FreshReleaseArtifact $file $start } 'predates'
    (Get-Item -LiteralPath $file).LastWriteTimeUtc = [datetime]::UtcNow
    Assert-FreshReleaseArtifact $file $start
    $passed++

    $node = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
    Assert-Throws { Invoke-ReleaseCommand $node @('-e', 'process.exit(7)') } 'exit code 7'
    $payload = 'value with spaces, a quote '' and $(no-command)'
    $quotedFile = Join-Path $fixture 'output with spaces.txt'
    Invoke-ReleaseCommand $node @('-e', 'require("fs").writeFileSync(process.argv[1],process.argv[2])', $quotedFile, $payload)
    Assert-Equal ([IO.File]::ReadAllText($quotedFile)) $payload

    $unicode = Invoke-ReleaseCommand $node @('-e', 'process.stdout.write("\u041f\u0440\u0438\u0432\u0435\u0442")') -PassThru
    Assert-Equal $unicode ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('0J/RgNC40LLQtdGC')))
    $java = Get-Command java.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($java) { $probe=Invoke-ReleaseCommand $java.Source @('-version') -PassThru; if ($probe -notmatch 'version "') { throw 'Java stderr version probe failed.' }; $passed++ }
    $asset = [pscustomobject]@{name='expected.exe';state='uploaded';size=(Get-Item $file).Length;digest='sha256:'+(Get-FileHash $file).Hash.ToLowerInvariant()}
    Assert-UploadedReleaseAssets @($asset) $fixture @('expected.exe')
    $passed++
    Assert-Throws { Assert-UploadedReleaseAssets @() $fixture @('expected.exe') } 'expected 1'
    Assert-Throws { Assert-UploadedReleaseAssets @($asset,$asset) $fixture @('expected.exe') } 'expected 1'
    $asset.digest = 'sha256:' + ('0' * 64)
    Assert-Throws { Assert-UploadedReleaseAssets @($asset) $fixture @('expected.exe') } 'differs'
    $asset.digest = 'sha256:'+(Get-FileHash $file).Hash.ToLowerInvariant()
    $asset.state = 'new'
    Assert-Throws { Assert-UploadedReleaseAssets @($asset) $fixture @('expected.exe') } 'incomplete'

    $bash = 'C:\Program Files\Git\usr\bin\bash.exe'
    if (Test-Path -LiteralPath $bash) {
        $literal = 'path with '' quote ; echo INJECTED ; #'
        $quoteLog = Join-Path $fixture 'quoting.log'
        Invoke-ReleaseCommand $bash @('-c', ('printf %s ' + (ConvertTo-ReleaseShellArgument $literal))) -LogPath $quoteLog
        $actual = [IO.File]::ReadAllText($quoteLog)
        Assert-Equal $actual $literal
    }
    Assert-ReleaseVersionIncrease '1.4.9' 'v1.4.8' @('v1.3.9','v1.4.8')
    $passed++
    Assert-Throws { Assert-ReleaseVersionIncrease '1.4.0' 'v1.4.8' @('v1.3.9','v1.4.8') } 'downgraded'
    Assert-Throws { Assert-ReleaseVersionIncrease '1.4.8' 'v1.3.9' @('v1.3.9','v1.4.8') } 'downgraded'
    Write-Output "PASS: $passed release workflow checks."
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'cloakwire-release-tests-*') { throw 'Unsafe fixture cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
