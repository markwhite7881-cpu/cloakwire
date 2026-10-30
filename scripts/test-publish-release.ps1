[CmdletBinding()]
param([string]$VerifierPath,[string]$FixtureGeneratorPath)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot 'release-workflow.psm1') -Force
if (-not $VerifierPath -or -not $FixtureGeneratorPath) {
    $toolTarget=Join-Path ([IO.Path]::GetTempPath()) 'cloakwire-release-tool-tests-target'
    $savedTarget=$env:CARGO_TARGET_DIR
    try {
        $env:CARGO_TARGET_DIR=$toolTarget
        Invoke-ReleaseCommand cargo @('build','--locked','--offline','--manifest-path',(Join-Path $repo 'src-tauri/crates/release-verify/Cargo.toml'),'--bin','release-verify','--example','make-fixture')
    } finally { $env:CARGO_TARGET_DIR=$savedTarget }
    $VerifierPath=Join-Path $toolTarget 'debug/release-verify.exe'
    $FixtureGeneratorPath=Join-Path $toolTarget 'debug/examples/make-fixture.exe'
}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('cloakwire-publish-tests-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $fixture
$project=Join-Path $fixture 'project with spaces'; $stage=Join-Path $fixture 'artifacts'; $statePath=Join-Path $fixture 'state.json'
$node=(Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
$savedEnv=@{}
foreach($name in @('CLOAKWIRE_GH_STATE','CLOAKWIRE_GH_NODE','CLOAKWIRE_GH_MOCK')){$savedEnv[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
$passed=0
function Save-State($State){[IO.File]::WriteAllText($statePath,($State|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
function Load-State {Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json}
function Assert-True($Value,[string]$Message){if(-not $Value){throw $Message};$script:passed++}
function Expect-Failure([scriptblock]$Action,[string]$Pattern){try{&$Action;throw 'Expected failure missing'}catch{if($_.Exception.Message -notmatch $Pattern){throw}};$script:passed++}
try{
    Invoke-ReleaseCommand $FixtureGeneratorPath @($stage,'1.4.9')
    $null=New-Item -ItemType Directory -Path (Join-Path $project 'scripts') -Force
    $null=New-Item -ItemType Directory -Path (Join-Path $project 'src-tauri/src') -Force
    foreach($file in @('release-workflow.psm1','release-artifacts.json','release-version.mjs','validate-release.ps1','publish-release.ps1','build-all-platforms.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $project 'scripts')}
    foreach($file in @('package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json')){Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $project $file)}
    $key=[IO.File]::ReadAllText((Join-Path $stage 'updater-public-key.base64')).Trim()
    [IO.File]::WriteAllText((Join-Path $project 'src-tauri/src/app_update.rs'),('const UPDATER_PUBLIC_KEY: &str = "'+$key+'";'),[Text.UTF8Encoding]::new($false))
    Invoke-ReleaseCommand $node @((Join-Path $project 'scripts/release-version.mjs'),'set','1.4.9','--project-root',$project)
    Invoke-ReleaseCommand git @('-C',$project,'init','--quiet')
    Invoke-ReleaseCommand git @('-C',$project,'add','.')
    Invoke-ReleaseCommand git @('-C',$project,'-c','user.name=ReleaseTest','-c','user.email=release-test@example.invalid','commit','--quiet','-m','fixture')
    $commit=Assert-ReleaseSource $project
    $oldTauri=[Environment]::GetEnvironmentVariable('TAURI_CONFIG','Process')
    $oldWry=[Environment]::GetEnvironmentVariable('WRY_ANDROID_LIBRARY','Process')
    try {
        $env:TAURI_CONFIG='caller configuration';$env:WRY_ANDROID_LIBRARY='caller library'
        Expect-Failure {& (Join-Path $project 'scripts/build-all-platforms.ps1') -CheckOnly -ConfigPath (Join-Path $fixture 'missing.psd1')} 'Copy scripts/release.local.example.psd1'
        Assert-True ($env:TAURI_CONFIG -ceq 'caller configuration' -and $env:WRY_ANDROID_LIBRARY -ceq 'caller library') 'Failed build changed caller environment.'
    } finally {
        [Environment]::SetEnvironmentVariable('TAURI_CONFIG',$oldTauri,'Process')
        [Environment]::SetEnvironmentVariable('WRY_ANDROID_LIBRARY',$oldWry,'Process')
    }
    $files=@(Get-ReleaseCatalog $project|ForEach-Object {Get-ReleaseFileRecord (Join-Path $stage "Cloakwire_1.4.9_$($_.suffix)")})
    $info=@{schema=1;version='1.4.9';commit=$commit;source_archive_sha256=('1'*64);artifacts=$files}
    [IO.File]::WriteAllText((Join-Path $stage 'release-build.json'),($info|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $notesPath=Join-Path $fixture 'reviewed notes.md'
    [IO.File]::WriteAllText($notesPath,("Release notes"+[char]10+("Unicode: "+[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("0J/RgNC40LLQtdGC")))),[Text.UTF8Encoding]::new($false))
    $mock=@'
const fs=require('fs'),crypto=require('crypto'),path=require('path');
const file=process.env.CLOAKWIRE_GH_STATE;
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2);
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const out=x=>{save();process.stdout.write(JSON.stringify(x));};
const fail=x=>{save();process.stderr.write(x);process.exit(7);};
state.calls.push(args);
if(args[0]==='release'&&args[1]==='upload'){
 if(state.failUpload)fail('simulated upload interruption');
 state.uploadCalls++;
 for(const name of args.slice(5)){
  const base=path.basename(name);if(state.release.assets.some(a=>a.name===base))fail('duplicate upload');
  const bytes=fs.readFileSync(name);
  state.release.assets.push({name:base,state:'uploaded',size:bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 out({});process.exit(0);
}
if(args[0]!=='api')fail('unexpected CLI invocation');
const route=args.find(a=>a.startsWith('repos/'));
const method=args.includes('--method')?args[args.indexOf('--method')+1]:'GET';
if(route.includes('/git/ref/tags/')){out({object:{type:'tag',sha:'a'.repeat(40)}});process.exit(0);}
if(route.includes('/git/tags/')){out({object:{type:'commit',sha:state.tagMismatch?'0'.repeat(40):state.commit}});process.exit(0);}
if(route.endsWith('/releases/latest')){out(state.promoted?state.release:state.latest);process.exit(0);}
if(route.includes('/releases?')){
 const page=Number(new URL('https://fixture/'+route).searchParams.get('page')||1);
 out(page===1?[...(state.release?[state.release]:[]),...state.stable]:[]);process.exit(0);
}
if(route.endsWith('/releases')&&method==='POST'){
 state.created++;
 const payload=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'));
 state.release={...payload,id:424242,html_url:'https://github.example/draft/424242',assets:[]};
 out(state.release);process.exit(0);
}
if(route.endsWith('/releases/424242')){
 if(method==='GET'&&state.bumpLatestOnAssetRead){state.latest.tag_name='v1.5.0';state.bumpLatestOnAssetRead=false;}
 if(method==='PATCH'){
  if(args.includes('--input'))Object.assign(state.release,JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8')));
  if(args.includes('draft=false')){state.promotions++;state.promoted=true;state.release.draft=false;state.release.prerelease=false;state.release.html_url='https://github.example/releases/tag/v1.4.9';}
 }
 out(state.release);process.exit(0);
}
fail('unexpected API route '+route);
'@
    $mockFile=Join-Path $fixture 'mock-gh.cjs';[IO.File]::WriteAllText($mockFile,$mock,[Text.UTF8Encoding]::new($false))
    $gh=Join-Path $fixture 'mock-gh.cmd';[IO.File]::WriteAllText($gh,'@"%CLOAKWIRE_GH_NODE%" "%CLOAKWIRE_GH_MOCK%" %*'+[Environment]::NewLine,[Text.Encoding]::ASCII)
    $env:CLOAKWIRE_GH_STATE=$statePath;$env:CLOAKWIRE_GH_NODE=$node;$env:CLOAKWIRE_GH_MOCK=$mockFile
    $state=@{commit=$commit;calls=@();created=0;uploadCalls=0;promotions=0;promoted=$false;bumpLatestOnAssetRead=$false;failUpload=$true;tagMismatch=$false;release=$null;latest=@{id=1;tag_name='v1.4.8';draft=$false;prerelease=$false};stable=@(@{id=2;tag_name='v1.3.9';draft=$false;prerelease=$false},@{id=1;tag_name='v1.4.8';draft=$false;prerelease=$false})};Save-State $state
    $publisher=Join-Path $project 'scripts/publish-release.ps1'
    $params=@{DistPath=$stage;NotesFile=$notesPath;VerifierPath=$VerifierPath;GhPath=$gh}
    & $publisher @params -ValidateOnly
    Assert-True ((Load-State).calls.Count -eq 0) 'ValidateOnly contacted GitHub.'
    Expect-Failure {& $publisher @params -Publish} 'exit code 7'
    Assert-True (-not (Load-State).promoted) 'Interrupted upload promoted release.'
    $state=Load-State;$state.failUpload=$false;Save-State $state
    & $publisher @params
    $state=Load-State
    Assert-True ($state.release.draft -and $state.release.assets.Count -eq 18 -and $state.uploadCalls -eq 1) 'Draft upload was incomplete.'
    Assert-True ($state.promotions -eq 0) 'Default command promoted release.'
    [IO.File]::WriteAllText($notesPath,("Updated notes"+[char]10+("Unicode: "+[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("0J7QsdC90L7QstC70LXQvdC+")))),[Text.UTF8Encoding]::new($false))
    & $publisher @params
    $state=Load-State
    Assert-True ($state.uploadCalls -eq 1) 'Resume re-uploaded matching assets.'
    Assert-True ($state.release.body -ceq [IO.File]::ReadAllText($notesPath)) 'Resume ignored reviewed notes.'
    $goodDigest=$state.release.assets[0].digest;$state.release.assets[0].digest='sha256:'+('0'*64);Save-State $state
    Expect-Failure {& $publisher @params -Publish} 'differs'
    Assert-True (-not (Load-State).promoted) 'Digest mismatch promoted release.'
    $state=Load-State;$state.release.assets[0].digest=$goodDigest;$state.tagMismatch=$true;Save-State $state
    Expect-Failure {& $publisher @params -Publish} 'tag does not identify'
    Assert-True (-not (Load-State).promoted) 'Wrong commit promoted release.'
    $state=Load-State;$state.tagMismatch=$false;$state.latest.tag_name='v1.5.0';Save-State $state
    Expect-Failure {& $publisher @params -Publish} 'downgraded'
    $state=Load-State;$state.latest.tag_name='v1.4.8';Save-State $state
    $state=Load-State;$state.bumpLatestOnAssetRead=$true;Save-State $state
    Expect-Failure {& $publisher @params -Publish} 'downgraded'
    Assert-True (-not (Load-State).promoted) 'Concurrent newer release was downgraded.'
    $state=Load-State;$state.latest.tag_name='v1.4.8';Save-State $state
    & $publisher @params -Publish
    $state=Load-State
    Assert-True ($state.promoted -and $state.promotions -eq 1 -and -not $state.release.draft) 'Explicit verified promotion failed.'
    Expect-Failure {& $publisher @params -Publish} 'already public'
    Assert-True ((Load-State).promotions -eq 1) 'Published release was mutated.'
    Write-Output "PASS: $passed publisher end-to-end checks against local fake GitHub."
}finally{
    foreach($name in $savedEnv.Keys){[Environment]::SetEnvironmentVariable($name,$savedEnv[$name],'Process')}
    $resolved=[IO.Path]::GetFullPath($fixture);$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if(-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)-or [IO.Path]::GetFileName($resolved)-notlike 'cloakwire-publish-tests-*'){throw 'Unsafe publisher fixture cleanup.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
