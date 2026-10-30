# Build one complete release from a clean, immutable HEAD archive.
[CmdletBinding()]
param([string]$Version, [string]$ConfigPath, [string]$NotesFile, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot 'release-workflow.psm1') -Force
# Restore the caller environment on success, early return and every failure.
$androidEnvironment = @('TAURI_CONFIG','TAURI_ANDROID_PROJECT_PATH','TAURI_ANDROID_PACKAGE_UNESCAPED','WRY_ANDROID_PACKAGE','WRY_ANDROID_LIBRARY','WRY_ANDROID_KOTLIN_FILES_OUT_DIR')
$savedEnvironment = @{}
foreach ($name in @('RUSTUP_HOME','CARGO_HOME','PATH','JAVA_HOME','CARGO_TARGET_DIR','CLOAKWIRE_TEST_MANIFEST','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_NDK_ROOT','GRADLE_USER_HOME','CC_aarch64_linux_android','CXX_aarch64_linux_android','AR_aarch64_linux_android','CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER') + $androidEnvironment) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
foreach ($name in $androidEnvironment + @('CLOAKWIRE_TEST_MANIFEST')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
if (-not $ConfigPath) { $ConfigPath = Join-Path $repo 'release.local.psd1' }
$node = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
$versionArgs = @((Join-Path $PSScriptRoot 'release-version.mjs'), 'check', '--project-root', $repo)
if ($Version) { $versionArgs += @('--version', $Version) }
$versionOutput = & $node @versionArgs
if ($LASTEXITCODE -ne 0) { throw 'Release version metadata is inconsistent.' }
$versionInfo = $versionOutput | ConvertFrom-Json
$Version = $versionInfo.version
$commit = Assert-ReleaseSource $repo
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Copy scripts/release.local.example.psd1 to release.local.psd1 and configure the build hosts.' }
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
function Setting([string]$Name, [switch]$Optional) {
    if ($config.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace([string]$config[$Name])) { return [Environment]::ExpandEnvironmentVariables([string]$config[$Name]) }
    if (-not $Optional) { throw "Release configuration is missing '$Name'." }
}
foreach ($name in @('CargoBin','RustupHome','CargoHome','WindowsSidecarDirectory','SignerPath','UpdaterKeyPath','JavaHome','AndroidSdkRoot','AndroidNdkRoot','GradleUserHome','AndroidLibboxPath','AndroidNativeDirectory','AndroidGeodataDirectory','AndroidBuildType','AndroidCertificateSha256','MacHost','MacSshKeyPath','MacKnownHostsPath','MacBuildRoot','MacSidecarDirectory','BuildRoot')) { $null = Setting $name }
foreach ($name in @('SignerPath','UpdaterKeyPath','AndroidLibboxPath','MacSshKeyPath','MacKnownHostsPath')) {
    if (-not (Test-Path -LiteralPath (Setting $name) -PathType Leaf)) { throw "Release input '$name' is missing." }
}
foreach ($name in @('CargoBin','RustupHome','CargoHome','WindowsSidecarDirectory','JavaHome','AndroidSdkRoot','AndroidNdkRoot','AndroidNativeDirectory','AndroidGeodataDirectory')) {
    if (-not (Test-Path -LiteralPath (Setting $name) -PathType Container)) { throw "Release input directory '$name' is missing." }
}
if ((Setting 'MacHost') -notmatch '^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$') { throw 'MacHost must be a user@DNS-name or user@IPv4 address.' }
if ((Setting 'AndroidBuildType') -notin @('debug','release')) { throw 'AndroidBuildType must be debug or release.' }
if ((Setting 'AndroidCertificateSha256') -notmatch '^[0-9a-fA-F]{64}$') { throw 'Set the expected existing Android certificate SHA-256 fingerprint.' }
$buildRoot = [IO.Path]::GetFullPath((Setting 'BuildRoot'))
if ($buildRoot -match '[^\x00-\x7F]') { throw 'BuildRoot must use an ASCII path for the Windows/Android toolchain.' }
$env:RUSTUP_HOME = Setting 'RustupHome'; $env:CARGO_HOME = Setting 'CargoHome'
$env:PATH = (Setting 'CargoBin') + ';' + $env:PATH
$env:JAVA_HOME = Setting 'JavaHome'
$java = Join-Path $env:JAVA_HOME 'bin/java.exe'
$javaVersion = Invoke-ReleaseCommand $java @('-version') -PassThru
if ($javaVersion -notmatch 'version "17\.') { throw 'The release build requires JDK 17.' }
$ssh = Setting 'SshPath' -Optional; $scp = Setting 'ScpPath' -Optional
if (-not $ssh) { $command=Get-Command ssh.exe -ErrorAction SilentlyContinue; if ($command) { $ssh=$command.Source } }
if (-not $scp) { $command=Get-Command scp.exe -ErrorAction SilentlyContinue; if ($command) { $scp=$command.Source } }
$gitRoot = Split-Path -Parent (Split-Path -Parent (Get-Command git.exe -ErrorAction Stop | Select-Object -First 1).Source)
if (-not $ssh) { $ssh=Join-Path $gitRoot 'usr/bin/ssh.exe' }
if (-not $scp) { $scp=Join-Path $gitRoot 'usr/bin/scp.exe' }
foreach ($tool in @($ssh,$scp)) { if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'Configure SshPath and ScpPath before building a release.' } }
foreach ($tool in @('cargo.exe','npm.cmd','tar.exe')) { $null=Get-Command $tool -ErrorAction Stop }
foreach ($name in @('geoip.dat','geosite.dat')) { if (-not (Test-Path -LiteralPath (Join-Path (Setting 'AndroidGeodataDirectory') $name) -PathType Leaf)) { throw "Android asset is missing: $name" } }
if ($CheckOnly) {
    Write-Output "Release prerequisites valid: version=$Version; commit=$commit. No build or upload started."
    return
}

$runId = [Guid]::NewGuid().ToString('N')
$run = Join-Path $buildRoot "v$Version-$runId"
$source = Join-Path $run 'source'; $target = Join-Path $run 'target'; $stage = Join-Path $run 'artifacts'; $logs = Join-Path $run 'logs'
foreach ($dir in @($source,$target,$stage,$logs)) { $null = New-Item -ItemType Directory -Path $dir }
$archive = Join-Path $run 'source.tar.gz'
Invoke-ReleaseCommand git @('-C',$repo,'archive','--format=tar.gz',"--output=$archive",$commit)
Invoke-ReleaseCommand tar.exe @('-xzf',$archive,'-C',$source)
Invoke-ReleaseCommand $node @('scripts/release-version.mjs','check','--version',$Version) $source
Invoke-ReleaseCommand $node @('scripts/release-version.mjs','sync-android','--version',$Version) $source
$utf8 = [Text.UTF8Encoding]::new($false)
$notes = if ($NotesFile) { [IO.File]::ReadAllText([IO.Path]::GetFullPath($NotesFile)) } else {
    $changelog = [IO.File]::ReadAllText((Join-Path $source 'CHANGELOG.md'))
    $match = [regex]::Match($changelog, '(?ms)^## \[' + [regex]::Escape($Version) + '\].*?(?=^## \[|\z)')
    if (-not $match.Success) { throw 'Add the version section to CHANGELOG.md before committing, or provide -NotesFile.' }
    $match.Value
}
if ([string]::IsNullOrWhiteSpace($notes)) { throw 'Release notes cannot be empty.' }
[IO.File]::WriteAllText((Join-Path $run 'RELEASE_NOTES.md'),$notes,$utf8)
$inputs = @(); $startedAt = [datetime]::UtcNow
$env:CARGO_TARGET_DIR = $target
Remove-Item Env:CLOAKWIRE_TEST_MANIFEST -ErrorAction SilentlyContinue
# Windows inputs are outside git, but their content hashes are retained in provenance.
$null = New-Item -ItemType Directory -Path (Join-Path $source 'src-tauri/binaries') -Force
foreach ($name in @('sing-box-x86_64-pc-windows-msvc.exe','xray-x86_64-pc-windows-msvc.exe','wintun.dll')) {
    $inputFile = Join-Path (Setting 'WindowsSidecarDirectory') $name
    $inputs += Get-ReleaseFileRecord $inputFile
    Copy-Item -LiteralPath $inputFile -Destination (Join-Path $source "src-tauri/binaries/$name")
}
Invoke-ReleaseCommand npm.cmd @('ci') $source (Join-Path $logs 'npm-ci.log')
Invoke-ReleaseCommand npm.cmd @('test','--','--reporter=dot') $source (Join-Path $logs 'frontend-tests.log')
Invoke-ReleaseCommand npm.cmd @('run','build') $source (Join-Path $logs 'frontend-build.log')
$env:CLOAKWIRE_TEST_MANIFEST = '1'
try { Invoke-ReleaseCommand cargo @('test','--locked','--lib','--','--include-ignored','--skip','process::','--skip','killswitch::','--quiet') (Join-Path $source 'src-tauri') (Join-Path $logs 'windows-tests.log') }
finally { Remove-Item Env:CLOAKWIRE_TEST_MANIFEST -ErrorAction SilentlyContinue }
$phaseStart = [datetime]::UtcNow
Invoke-ReleaseCommand npm.cmd @('run','tauri:build') $source (Join-Path $logs 'windows-build.log')
foreach ($entry in @(@('nsis',"Cloakwire_$Version`_x64-setup.exe"),@('msi',"Cloakwire_$Version`_x64_en-US.msi"))) {
    $file = Join-Path $target "release/bundle/$($entry[0])/$($entry[1])"
    Assert-FreshReleaseArtifact $file $phaseStart
    Copy-Item -LiteralPath $file -Destination $stage
}
$windowsExe = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $target 'release/cloakwire.exe'))
if ($windowsExe.ProductVersion -cne $Version) { throw 'Windows application has the wrong embedded version.' }

# Android uses the same extracted source and frontend; no tauri android-studio-script on Windows.
$env:ANDROID_HOME = Setting 'AndroidSdkRoot'; $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_NDK_ROOT = Setting 'AndroidNdkRoot'; $env:GRADLE_USER_HOME = Setting 'GradleUserHome'
$env:PATH = "$env:JAVA_HOME\bin;" + $env:PATH
$ndkBin = Join-Path $env:ANDROID_NDK_ROOT 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$env:CC_aarch64_linux_android = Join-Path $ndkBin 'aarch64-linux-android24-clang.cmd'
$env:CXX_aarch64_linux_android = Join-Path $ndkBin 'aarch64-linux-android24-clang++.cmd'
$env:AR_aarch64_linux_android = Join-Path $ndkBin 'llvm-ar.exe'
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $env:CC_aarch64_linux_android
$env:TAURI_CONFIG = '{"bundle":{"externalBin":[],"resources":[]}}'
$android = Join-Path $source 'src-tauri/gen/android'
$jni = Join-Path $android 'app/src/main/jniLibs/arm64-v8a'
$null = New-Item -ItemType Directory -Path $jni -Force
$null = New-Item -ItemType Directory -Path (Join-Path $android 'app/libs') -Force
Copy-Item -LiteralPath (Setting 'AndroidLibboxPath') -Destination (Join-Path $android 'app/libs/libbox.aar')
$inputs += Get-ReleaseFileRecord (Setting 'AndroidLibboxPath')
foreach ($name in @('libxray.so','libhev-socks5-tunnel.so')) {
    $file = Join-Path (Setting 'AndroidNativeDirectory') $name
    $inputs += Get-ReleaseFileRecord $file
    Copy-Item -LiteralPath $file -Destination $jni
}
$assets = Join-Path $android 'app/src/main/assets'
$null=New-Item -ItemType Directory -Path $assets -Force
foreach ($name in @('geoip.dat','geosite.dat')) {
    $file=Join-Path (Setting 'AndroidGeodataDirectory') $name
    Copy-Item -LiteralPath $file -Destination $assets
    $inputs += Get-ReleaseFileRecord $file
}
& (Join-Path $source 'scripts/prepare-android-release.ps1') -ProjectRoot $source
$phaseStart = [datetime]::UtcNow
Invoke-ReleaseCommand cargo @('build','--locked','--release','--lib','--target','aarch64-linux-android') (Join-Path $source 'src-tauri') (Join-Path $logs 'android-rust.log')
$so = Join-Path $target 'aarch64-linux-android/release/libcloakwire_lib.so'
Assert-FreshReleaseArtifact $so $phaseStart
Copy-Item -LiteralPath $so -Destination $jni
$type = Setting 'AndroidBuildType'; $flavor = (Get-Culture).TextInfo.ToTitleCase($type)
$gradle = Join-Path $android 'gradlew.bat'
Invoke-ReleaseCommand $gradle @('testArm64DebugUnitTest','-x','rustBuildArm64Debug','--no-daemon','-Dorg.gradle.jvmargs=-Xmx3g','--build-cache') $android (Join-Path $logs 'android-tests.log')
$phaseStart = [datetime]::UtcNow
Invoke-ReleaseCommand $gradle @("assembleArm64$flavor",'-x',"rustBuildArm64$flavor",'--no-daemon','-Dorg.gradle.jvmargs=-Xmx3g','--build-cache') $android (Join-Path $logs 'android-build.log')
$apk = Join-Path $stage "Cloakwire_$Version`_arm64-v8a.apk"
if ($type -eq 'debug') {
    $builtApk = Join-Path $android 'app/build/outputs/apk/arm64/debug/app-arm64-debug.apk'
    Assert-FreshReleaseArtifact $builtApk $phaseStart
    Copy-Item -LiteralPath $builtApk -Destination $apk
} else {
    $builtApk = Join-Path $android 'app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk'
    Assert-FreshReleaseArtifact $builtApk $phaseStart
    & (Join-Path $source 'scripts/sign-android-release.ps1') -InputApkPath $builtApk -OutputApkPath $apk -JavaPath $java
}
$tools = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $tools) { throw 'Android build-tools are missing.' }
$certOutput = & $java -jar (Join-Path $tools.FullName 'lib/apksigner.jar') verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
if (($certOutput -join "`n") -notmatch ('certificate SHA-256 digest: ' + (Setting 'AndroidCertificateSha256'))) { throw 'Android signing certificate changed; this APK would not update existing installations.' }
$badging = & (Join-Path $tools.FullName 'aapt.exe') dump badging $apk
if ($LASTEXITCODE -ne 0 -or ($badging -join "`n") -notmatch ("name='app.cloakwire.client' versionCode='"+$versionInfo.androidVersionCode+"' versionName='"+[regex]::Escape($Version)+"'")) { throw 'APK package/version metadata does not match this release.' }
if (($badging -join "`n") -notmatch "native-code: 'arm64-v8a'") { throw 'APK architecture is incorrect.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($apk)
try {
    foreach ($name in @('assets/geoip.dat','assets/geosite.dat','lib/arm64-v8a/libcloakwire_lib.so','lib/arm64-v8a/libxray.so','lib/arm64-v8a/libhev-socks5-tunnel.so','lib/arm64-v8a/libbox.so')) {
        $entry=$zip.GetEntry($name)
        if ($null -eq $entry -or $entry.Length -le 0) { throw "APK is missing required runtime entry: $name" }
    }
} finally { $zip.Dispose() }
foreach ($name in @('TAURI_CONFIG','TAURI_ANDROID_PROJECT_PATH','TAURI_ANDROID_PACKAGE_UNESCAPED','WRY_ANDROID_PACKAGE','WRY_ANDROID_LIBRARY','WRY_ANDROID_KOTLIN_FILES_OUT_DIR')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }

# The remote command and transferred driver are both from this exact source snapshot.

$sshOptions = @('-i',(Setting 'MacSshKeyPath'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',('UserKnownHostsFile='+(Setting 'MacKnownHostsPath')))
$hostName = Setting 'MacHost'
Invoke-ReleaseCommand $scp ($sshOptions + @($archive,"${hostName}:/tmp/cloakwire-$runId.tar.gz"))
Invoke-ReleaseCommand $scp ($sshOptions + @((Join-Path $source 'scripts/build-release-macos.sh'),"${hostName}:/tmp/cloakwire-$runId.sh"))
$remoteArgs = @("/tmp/cloakwire-$runId.sh",$Version,$commit,$runId,(Setting 'MacBuildRoot'),(Setting 'MacSidecarDirectory')) | ForEach-Object { ConvertTo-ReleaseShellArgument $_ }
Invoke-ReleaseCommand $ssh ($sshOptions + @('-o','ServerAliveInterval=30',$hostName,('bash '+($remoteArgs -join ' ')))) $source (Join-Path $logs 'macos-build.log')
$macArchive = Join-Path $run 'mac-output.tar.gz'
Invoke-ReleaseCommand $scp ($sshOptions + @("${hostName}:/tmp/cloakwire-$runId-output.tar.gz",$macArchive))
$macOutput = Join-Path $run 'mac-output'; $null = New-Item -ItemType Directory -Path $macOutput
Invoke-ReleaseCommand tar.exe @('-xzf',$macArchive,'-C',$macOutput)
if ([IO.File]::ReadAllText((Join-Path $macOutput 'source-commit.txt')).Trim() -cne $commit) { throw 'Mac source commit differs from this release.' }
foreach ($item in (Get-ReleaseCatalog $source | Where-Object { $_.platform -like 'darwin-*' })) {
    $name = "Cloakwire_$Version`_$($item.suffix)"
    $file = Join-Path $macOutput $name
    Assert-FreshReleaseArtifact $file $startedAt
    Copy-Item -LiteralPath $file -Destination $stage
}
foreach ($record in (Get-Content -LiteralPath (Join-Path $macOutput 'mac-inputs.json') -Raw | ConvertFrom-Json)) { $inputs += $record }

# Sign every catalog artifact, then validate bytes rather than signature file presence.
$artifacts = @(Get-ReleaseCatalog $source | ForEach-Object { Join-Path $stage "Cloakwire_$Version`_$($_.suffix)" })
Invoke-ReleaseCommand (Setting 'SignerPath') (@('-k',(Setting 'UpdaterKeyPath')) + $artifacts) $source (Join-Path $logs 'updater-signatures.log')
& (Join-Path $source 'scripts/write-latest-json.ps1') -Version $Version -DistPath $stage -BaseUrl "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v$Version" -NotesFile (Join-Path $run 'RELEASE_NOTES.md') -OutputPath (Join-Path $stage 'latest.json')
$hashLines = @($artifacts | Sort-Object | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($_) })
foreach ($name in @('SHA256SUMS.txt',"SHA256SUMS_v$Version.txt")) { [IO.File]::WriteAllText((Join-Path $stage $name),($hashLines -join "`n")+"`n",$utf8) }
$provenance = [ordered]@{ schema=1; version=$Version; commit=$commit; source_archive_sha256=(Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant(); started_at=$startedAt.ToString('o'); completed_at=[datetime]::UtcNow.ToString('o'); inputs=$inputs; artifacts=@($artifacts | ForEach-Object { Get-ReleaseFileRecord $_ }) }
[IO.File]::WriteAllText((Join-Path $stage 'release-build.json'),($provenance | ConvertTo-Json -Depth 8)+"`n",$utf8)
& (Join-Path $source 'scripts/validate-release.ps1') -Version $Version -DistPath $stage -ManifestPath (Join-Path $stage 'latest.json') -RequiredPlatforms @('windows-x86_64','darwin-aarch64','darwin-x86_64','android-arm64-v8a') -FullRelease -ProjectRoot $source
Write-Output "Release $Version prepared and cryptographically verified: $stage"
Write-Output "Source commit: $commit. Build logs: $logs"
Write-Output 'Next: publish-release.ps1 with this exact DistPath and the reviewed release notes.'
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
