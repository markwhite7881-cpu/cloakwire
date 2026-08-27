$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Public\cwdev\cloakwire-android-v131-port'
$env:CLOAKWIRE_TEST_MANIFEST = ''
& node --experimental-strip-types --test src/mobile/lib/homeServerCatalog.test.ts src/mobile/lib/reconnectState.test.ts src/mobile/lib/serverGrouping.test.ts src/lib/subscriptionStorage.test.ts
exit $LASTEXITCODE
