$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workflowPath = Join-Path $projectRoot '.github\workflows\release-macos.yml'
$workflow = [IO.File]::ReadAllText($workflowPath, [Text.UTF8Encoding]::new($false))

if ($workflow -match 'find .* -print -quit') {
    throw 'macOS workflow selects the first matching build artifact instead of rejecting ambiguous output.'
}

$required = @(
    'while IFS= read -r path; do apps+=("$path"); done < <(find "$app_dir" -maxdepth 1 -type d -name ''*.app'')',
    '[ "${#apps[@]}" -eq 1 ] ||',
    'version=1.14.4-lx.35',
    'shasum -a 256 -c -',
    'python3 scripts/prepare-xray-sidecar.py'
)
foreach ($needle in $required) {
    if (-not $workflow.Contains($needle)) {
        throw "macOS workflow is missing required exact-output/source-pinning guard: $needle"
    }
}

Write-Output 'PASS: macOS workflow rejects ambiguous artifacts and verifies the pinned core archives.'
