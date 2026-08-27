param(
  [string]$ApkPath = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\src-tauri\gen\android\app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'

$zip = [System.IO.Compression.ZipFile]::OpenRead($ApkPath)
$entries = $zip.Entries
$xray = $entries | Where-Object { $_.FullName -imatch '^lib/arm64-v8a/(xray|libgojni|libbox)' }
foreach ($e in $xray) {
  $name = $e.FullName
  $len = $e.Length
  $sha = ''
  if ($len -gt 0) {
    $shaAlgo = [System.Security.Cryptography.SHA256]::Create()
    $stream = $e.Open()
    $bytes = $shaAlgo.ComputeHash($stream)
    $stream.Close()
    $shaAlgo.Dispose()
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.AppendFormat('{0:x2}', $b) }
    $sha = $sb.ToString()
  }
  Write-Host "name=$name  size=$len  sha256=$sha"
}
$zip.Dispose()
