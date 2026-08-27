$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Public\cwdev\cloakwire-android-v131-port'
$env:CLOAKWIRE_TEST_MANIFEST = ''
& npm.cmd run build
exit $LASTEXITCODE
