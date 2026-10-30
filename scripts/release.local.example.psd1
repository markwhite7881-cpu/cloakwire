@{
    # Copy to release.local.psd1 (ignored). Paths and public certificate fingerprints only.
    BuildRoot = 'C:\Build\cloakwire-runs'
    CargoBin = 'C:\Users\Public\cwdev\cargo\bin'
    RustupHome = 'C:\Users\Public\cwdev\rustup-home'
    CargoHome = 'C:\Users\Public\cwdev\cargo-home'
    WindowsSidecarDirectory = 'C:\Users\Public\cwdev\cloakwire-release-v132\src-tauri\binaries'
    SignerPath = 'C:\Users\Public\cwdev\target\release\tauri-signer.exe'
    UpdaterKeyPath = 'C:\Users\Public\cwdev\cloakwire-release-v132\src-tauri\.tauri-updater.key'
    JavaHome = 'C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
    AndroidSdkRoot = '%LOCALAPPDATA%\Android\Sdk'
    AndroidNdkRoot = 'C:\Users\Public\cwdev\ndk'
    GradleUserHome = 'C:\Users\Public\cwdev\gradle-home'
    AndroidLibboxPath = 'C:\Users\Public\cwdev\cloakwire-release-v132\src-tauri\gen\android\app\libs\libbox.aar'
    AndroidNativeDirectory = 'C:\Users\Public\cwdev\cloakwire-release-v132\src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a'
    # v1.4.8 uses this existing debug certificate. Do not replace the certificate on updates.
    AndroidGeodataDirectory = 'C:\Users\Public\cwdev\cloakwire-release-v132\src-tauri\gen\android\app\src\main\assets'
    AndroidBuildType = 'debug'
    AndroidCertificateSha256 = '2d3955e76241181ef04c493219963e753b3ac93329d2b80637937aab7124bb00'
    # For release build type, signing reads CLOAKWIRE_ANDROID_* env vars, never this file.
    SshPath = 'C:\Program Files\Git\usr\bin\ssh.exe'
    ScpPath = 'C:\Program Files\Git\usr\bin\scp.exe'
    MacHost = 'alexeyka@server'
    MacSshKeyPath = 'C:\Users\Public\cwdev\.ssh\mavis_hermes'
    MacKnownHostsPath = 'C:\Users\Public\cwdev\.ssh\known_hosts'
    MacBuildRoot = '~/cloakwire-builds'
    MacSidecarDirectory = '~/cloakwire-builds/cloakwire-v1.4.8/src-tauri/binaries'
}
