param(
  [string]$ApkPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
$zip = [System.IO.Compression.ZipFile]::OpenRead($ApkPath)
$zip.Entries | Where-Object { $_.FullName -imatch '^lib/' } | ForEach-Object {
  $name = $_.FullName
  $len = $_.Length
  $sha = ''
  if ($len -gt 0) {
    $shaAlgo = [System.Security.Cryptography.SHA256]::Create()
    $stream = $_.Open()
    $bytes = $shaAlgo.ComputeHash($stream)
    $stream.Close()
    $shaAlgo.Dispose()
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.AppendFormat('{0:x2}', $b) }
    $sha = $sb.ToString()
  }
  Write-Host ("name=" + $name + "  size=" + $len + "  sha256=" + $sha)
}
$zip.Dispose()
