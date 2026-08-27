$ErrorActionPreference = 'Stop'
$src = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\xray-src'
$out = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\xray-arm64.bin'
$log = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\.android-build\xray-build.log'

Set-Location $src

$env:GOOS = 'android'
$env:GOARCH = 'arm64'
$env:CGO_ENABLED = '0'

$argString = 'build -trimpath -ldflags "-s -w -checklinkname=0" -o "' + $out + '" .\main'
Write-Host "cmd: go $argString"

$proc = Start-Process -FilePath 'go.exe' -ArgumentList $argString -NoNewWindow -PassThru -RedirectStandardOutput "$log.stdout" -RedirectStandardError "$log.stderr"
Write-Host "pid=$($proc.Id)"
$proc.WaitForExit()
$exit = $proc.ExitCode
Write-Host "exit=$exit"
if ($exit -ne 0) {
  if (Test-Path "$log.stderr") { Get-Content "$log.stderr" -Tail 30 }
  if (Test-Path "$log.stdout") { Get-Content "$log.stdout" -Tail 30 }
} else {
  if (Test-Path $out) {
    $item = Get-Item $out
    Write-Host "size=$($item.Length)"
  }
}
