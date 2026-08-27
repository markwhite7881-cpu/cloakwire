$ErrorActionPreference = 'Stop'
$src = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\xray-src'
$out = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\xray-arm64.bin'
$log = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\xray-build.log'

Set-Location $src

$env:GOOS = 'android'
$env:GOARCH = 'arm64'
$env:CGO_ENABLED = '0'

$argList = @('build', '-trimpath', '-ldflags', '-s -w', '-o', $out, '.\main')
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Get-Command go.exe).Source
foreach ($a in $argList) { $psi.ArgumentList.Add($a) }
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "pid=$($proc.Id)"
$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()
$proc.WaitForExit()
$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result
$stdout + "`n---STDERR---`n" + $stderr | Set-Content -Path $log -Encoding utf8
Write-Host "exit=$($proc.ExitCode)"
if ($proc.ExitCode -ne 0) {
  Write-Host "tail of log:"
  Get-Content $log -Tail 30
} else {
  $item = Get-Item $out
  Write-Host "size=$($item.Length)"
}
