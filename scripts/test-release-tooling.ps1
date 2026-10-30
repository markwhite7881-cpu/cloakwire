[CmdletBinding()]
param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot 'release-workflow.psm1') -Force
if (-not $ConfigPath) { $ConfigPath = Join-Path $repo 'release.local.psd1' }
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    $config = Import-PowerShellDataFile -LiteralPath $ConfigPath
    foreach ($pair in @(@('RustupHome','RUSTUP_HOME'),@('CargoHome','CARGO_HOME'))) {
        if ($config.ContainsKey($pair[0])) { [Environment]::SetEnvironmentVariable($pair[1], [Environment]::ExpandEnvironmentVariables($config[$pair[0]]), 'Process') }
    }
    if ($config.ContainsKey('CargoBin')) { $env:PATH = [Environment]::ExpandEnvironmentVariables($config.CargoBin) + ';' + $env:PATH }
}
$node = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
$target = Join-Path ([IO.Path]::GetTempPath()) 'cloakwire-release-tool-tests-target'
$crate = Join-Path $repo 'src-tauri/crates/release-verify/Cargo.toml'
Invoke-ReleaseCommand $node @((Join-Path $PSScriptRoot 'release-version.mjs'),'check','--project-root',$repo)
Invoke-ReleaseCommand $node @('--test',(Join-Path $PSScriptRoot 'release-version-tests.mjs'))
# Fetch only missing locked helper dependencies. No application build, credentials or network writes.
Invoke-ReleaseCommand cargo @('build','--locked','--manifest-path',$crate,'--target-dir',$target,'--bin','release-verify','--example','make-fixture')
Invoke-ReleaseCommand cargo @('test','--offline','--locked','--manifest-path',$crate,'--target-dir',$target)
$shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
foreach ($test in @('test-release-workflow.ps1','test-android-release-bootstrap.ps1')) {
    Invoke-ReleaseCommand $shell @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot $test))
}
Invoke-ReleaseCommand $shell @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'test-publish-release.ps1'),'-VerifierPath',(Join-Path $target 'debug/release-verify.exe'),'-FixtureGeneratorPath',(Join-Path $target 'debug/examples/make-fixture.exe'))
Write-Output 'Release tooling checks passed. No application release was built, uploaded or installed.'
