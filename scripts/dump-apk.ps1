param(
  [string]$ApkPath = 'C:\Users\Public\cwdev\cloakwire-android-v131-port\src-tauri\gen\android\app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
$zip = [System.IO.Compression.ZipFile]::OpenRead($ApkPath)
$entries = $zip.Entries | Where-Object { $_.FullName -imatch 'lib/' }
foreach ($e in $entries) {
  Write-Host ("name=" + $e.FullName + "  size=" + $e.Length)
}
$zip.Dispose()
