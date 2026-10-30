use base64::{engine::general_purpose::STANDARD, Engine};
use minisign::{verify, PublicKey, PublicKeyBox, SignatureBox};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process,
};

type Result<T> = std::result::Result<T, String>;
const RELEASE_BASE: &str = "https://github.com/markwhite7881-cpu/cloakwire/releases/download";
const EXPECTED: &[(&str, &str, bool)] = &[
    ("x64-setup.exe", "windows-x86_64", true),
    ("x64_en-US.msi", "windows-x86_64", false),
    ("arm64-v8a.apk", "android-arm64-v8a", true),
    ("aarch64.dmg", "darwin-aarch64", true),
    ("aarch64.app.zip", "darwin-aarch64", false),
    ("x64.dmg", "darwin-x86_64", true),
    ("x64.app.zip", "darwin-x86_64", false),
];

struct Options {
    version: String,
    dist: PathBuf,
    manifest: PathBuf,
    project: PathBuf,
    platforms: BTreeSet<String>,
    full: bool,
    public_key: Option<PathBuf>,
}
struct Artifact {
    name: String,
    platform: String,
    updater: bool,
}

fn usage() -> &'static str {
    "release-verify --version VERSION --dist PATH --manifest PATH --project-root PATH [--required-platform PLATFORM ...] [--full-release] [--public-key-file PATH]"
}
fn options() -> Result<Options> {
    let mut args = env::args().skip(1);
    let (mut version, mut dist, mut manifest, mut project, mut public_key) =
        (None, None, None, None, None);
    let mut platforms = BTreeSet::new();
    let mut full = false;
    while let Some(arg) = args.next() {
        if arg == "--full-release" {
            full = true;
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {arg}; {}", usage()))?;
        match arg.as_str() {
            "--version" => version = Some(value),
            "--dist" => dist = Some(PathBuf::from(value)),
            "--manifest" => manifest = Some(PathBuf::from(value)),
            "--project-root" => project = Some(PathBuf::from(value)),
            "--public-key-file" => public_key = Some(PathBuf::from(value)),
            "--required-platform" => {
                if !platforms.insert(value) {
                    return Err("duplicate required platform".into());
                }
            }
            _ => return Err(format!("unknown option {arg}; {}", usage())),
        }
    }
    let version = version.ok_or_else(|| usage().to_string())?;
    if !valid_version(&version) {
        return Err(
            "version must be numeric x.y.z without leading zeros or prerelease/build suffixes"
                .into(),
        );
    }
    let all: BTreeSet<String> = EXPECTED
        .iter()
        .filter(|a| a.2)
        .map(|a| a.1.to_string())
        .collect();
    if platforms.is_empty() {
        platforms = all.clone();
    }
    if !platforms.is_subset(&all) || (full && platforms != all) {
        return Err("required platform set is invalid for this release mode".into());
    }
    Ok(Options {
        version,
        dist: dist.ok_or_else(|| usage().to_string())?,
        manifest: manifest.ok_or_else(|| usage().to_string())?,
        project: project.ok_or_else(|| usage().to_string())?,
        platforms,
        full,
        public_key,
    })
}
fn valid_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes().all(|c| c.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'))
        })
}
fn read(path: &Path, kind: &str) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| format!("cannot read {kind} {}: {e}", path.display()))
}
fn read_text(path: &Path, kind: &str) -> Result<String> {
    let bytes = read(path, kind)?;
    String::from_utf8(bytes)
        .map(|s| s.strip_prefix('\u{feff}').unwrap_or(&s).to_string())
        .map_err(|e| format!("{kind} is not UTF-8: {e}"))
}
fn json(path: &Path, kind: &str) -> Result<Value> {
    serde_json::from_str(&read_text(path, kind)?).map_err(|e| format!("invalid {kind} JSON: {e}"))
}
fn catalog(opts: &Options) -> Result<Vec<Artifact>> {
    let value = json(
        &opts.project.join("scripts/release-artifacts.json"),
        "artifact catalog",
    )?;
    let entries = value
        .as_array()
        .ok_or("artifact catalog must be an array")?;
    let mut seen = BTreeSet::new();
    let mut artifacts = Vec::new();
    for entry in entries {
        let suffix = entry["suffix"]
            .as_str()
            .ok_or("invalid artifact catalog suffix")?;
        let platform = entry["platform"]
            .as_str()
            .ok_or("invalid artifact catalog platform")?;
        let updater = entry["updater"]
            .as_bool()
            .ok_or("invalid artifact catalog updater flag")?;
        if !EXPECTED.contains(&(suffix, platform, updater)) || !seen.insert(suffix) {
            return Err("artifact catalog has an unexpected or duplicate entry".into());
        }
        artifacts.push(Artifact {
            name: format!("Cloakwire_{}_{}", opts.version, suffix),
            platform: platform.to_string(),
            updater,
        });
    }
    if artifacts.len() != EXPECTED.len() {
        return Err("artifact catalog must define exactly seven artifacts".into());
    }
    Ok(artifacts)
}
fn public_key(opts: &Options) -> Result<PublicKey> {
    let text = if let Some(path) = &opts.public_key {
        read_text(path, "public key")?
    } else {
        let source = read_text(
            &opts.project.join("src-tauri/src/app_update.rs"),
            "application updater source",
        )?;
        let constant = source
            .split_once("const UPDATER_PUBLIC_KEY:")
            .ok_or("application updater public key constant is missing")?
            .1;
        let encoded = constant
            .split_once('=')
            .and_then(|(_, s)| s.split_once('"'))
            .and_then(|(_, s)| s.split_once('"'))
            .map(|(s, _)| s)
            .ok_or("cannot parse application updater public key constant")?;
        String::from_utf8(
            STANDARD
                .decode(encoded)
                .map_err(|e| format!("application updater public key is not base64: {e}"))?,
        )
        .map_err(|e| format!("application updater public key is not UTF-8: {e}"))?
    };
    let text = if text.starts_with("untrusted comment:") {
        text
    } else {
        String::from_utf8(
            STANDARD
                .decode(text.trim())
                .map_err(|e| format!("public key is not base64: {e}"))?,
        )
        .map_err(|e| format!("public key is not UTF-8: {e}"))?
    };
    PublicKeyBox::from_string(&text)
        .and_then(PublicKeyBox::into_public_key)
        .map_err(|e| format!("invalid public key: {e}"))
}
fn artifact_file(path: &Path) -> Result<(File, u64)> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("missing artifact {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "artifact is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() == 0 {
        return Err(format!("empty artifact: {}", path.display()));
    }
    Ok((
        File::open(path).map_err(|e| format!("cannot open artifact {}: {e}", path.display()))?,
        metadata.len(),
    ))
}
fn signature_bytes(path: &Path) -> Result<Vec<u8>> {
    let bytes = read(path, "signature sidecar")?;
    if bytes.is_empty() {
        return Err(format!("empty signature sidecar: {}", path.display()));
    }
    Ok(bytes)
}
fn verify_signature(key: &PublicKey, bytes: &[u8], file: &mut File, name: &str) -> Result<()> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| format!("signature sidecar for {name} is not UTF-8: {e}"))?;
    let signature = SignatureBox::from_string(text)
        .map_err(|e| format!("invalid signature sidecar for {name}: {e}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("cannot read artifact {name}: {e}"))?;
    verify(key, &signature, file, true, false, false)
        .map_err(|e| format!("signature verification failed for {name}: {e}"))
}
fn unexpected_artifacts(opts: &Options, artifacts: &[Artifact]) -> Result<()> {
    let mut allowed = BTreeSet::new();
    for a in artifacts {
        allowed.insert(a.name.clone());
        allowed.insert(format!("{}.sig", a.name));
    }
    allowed.insert("SHA256SUMS.txt".into());
    allowed.insert(format!("SHA256SUMS_v{}.txt", opts.version));
    for entry in
        fs::read_dir(&opts.dist).map_err(|e| format!("cannot list release directory: {e}"))?
    {
        let entry = entry.map_err(|e| format!("cannot list release entry: {e}"))?;
        if entry
            .file_type()
            .map_err(|e| format!("cannot inspect release entry: {e}"))?
            .is_dir()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        let binary = lower.starts_with("cloakwire_")
            || lower.starts_with("sha256sums")
            || [".exe", ".msi", ".apk", ".dmg", ".zip", ".bin", ".sig"]
                .iter()
                .any(|s| lower.ends_with(s));
        if binary && !allowed.contains(&name) {
            return Err(format!("unexpected release artifact: {name}"));
        }
    }
    Ok(())
}
fn checksum_file(path: &Path, hashes: &BTreeMap<String, String>) -> Result<()> {
    let text = read_text(path, "checksum file")?;
    let mut seen = BTreeSet::new();
    for line in text.lines() {
        let (digest, name) = line
            .split_once("  ")
            .or_else(|| line.split_once(" *"))
            .ok_or_else(|| format!("malformed checksum line in {}", path.display()))?;
        if digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("invalid checksum digest in {}", path.display()));
        }
        if !seen.insert(name.to_string()) {
            return Err(format!("duplicate checksum entry: {name}"));
        }
        let expected = hashes
            .get(name)
            .ok_or_else(|| format!("unexpected checksum filename: {name}"))?;
        if !digest.eq_ignore_ascii_case(expected) {
            return Err(format!("checksum mismatch: {name}"));
        }
    }
    if seen != hashes.keys().cloned().collect() {
        return Err(format!(
            "checksum file does not contain exactly the seven artifacts: {}",
            path.display()
        ));
    }
    Ok(())
}
fn validate(opts: &Options) -> Result<usize> {
    let artifacts = catalog(opts)?;
    unexpected_artifacts(opts, &artifacts)?;
    let manifest = json(&opts.manifest, "manifest")?;
    if manifest["version"].as_str() != Some(&opts.version) {
        return Err(format!(
            "manifest version does not match requested version {}",
            opts.version
        ));
    }
    let entries = manifest["platforms"]
        .as_object()
        .ok_or("manifest platform set must be an object")?;
    if entries.keys().cloned().collect::<BTreeSet<_>>() != opts.platforms {
        return Err("manifest platform set does not exactly match required platforms".into());
    }
    let key = public_key(opts)?;
    let mut hashes = BTreeMap::new();
    let mut verified = 0;
    for artifact in artifacts
        .iter()
        .filter(|a| opts.full || (a.updater && opts.platforms.contains(&a.platform)))
    {
        let path = opts.dist.join(&artifact.name);
        let (mut file, size) = artifact_file(&path)?;
        let sidecar = signature_bytes(&opts.dist.join(format!("{}.sig", artifact.name)))?;
        if artifact.updater && opts.platforms.contains(&artifact.platform) {
            let entry = &entries[&artifact.platform];
            let expected_url = format!("{RELEASE_BASE}/v{}/{}", opts.version, artifact.name);
            if entry["url"].as_str() != Some(&expected_url) {
                return Err(format!(
                    "artifact URL for {} must be exactly {expected_url}",
                    artifact.platform
                ));
            }
            let signature = entry["signature"]
                .as_str()
                .ok_or_else(|| format!("missing manifest signature for {}", artifact.platform))?;
            let bytes = STANDARD.decode(signature).map_err(|e| {
                format!(
                    "manifest signature is not base64 for {}: {e}",
                    artifact.platform
                )
            })?;
            if bytes != sidecar {
                return Err(format!(
                    "manifest signature does not match exact sidecar bytes for {}",
                    artifact.platform
                ));
            }
            // Earlier valid manifests omit size; whenever present, it must match the actual nonempty file.
            if let Some(declared) = entry.get("size") {
                if declared.as_u64() != Some(size) {
                    return Err(format!(
                        "manifest artifact size mismatch for {}",
                        artifact.name
                    ));
                }
            }
        }
        verify_signature(&key, &sidecar, &mut file, &artifact.name)?;
        verified += 1;
        if opts.full {
            file.seek(SeekFrom::Start(0))
                .map_err(|e| format!("cannot hash artifact: {e}"))?;
            let mut hash = Sha256::new();
            let mut buffer = [0_u8; 65536];
            loop {
                let n = file
                    .read(&mut buffer)
                    .map_err(|e| format!("cannot hash artifact: {e}"))?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            hashes.insert(artifact.name.clone(), format!("{:x}", hash.finalize()));
        }
    }
    if opts.full {
        checksum_file(&opts.dist.join("SHA256SUMS.txt"), &hashes)?;
        checksum_file(
            &opts.dist.join(format!("SHA256SUMS_v{}.txt", opts.version)),
            &hashes,
        )?;
    }
    Ok(verified)
}
fn main() {
    if env::args().nth(1).as_deref() == Some("--help") {
        println!("{}", usage());
        return;
    }
    match options().and_then(|opts| validate(&opts).map(|n| (opts.version, n))) {
        Ok((version, count)) => println!(
            "Verified release {version}: {count} Minisign artifact signatures, exact manifest{}.",
            if count == 7 {
                " and both SHA-256 catalogs"
            } else {
                ""
            }
        ),
        Err(error) => {
            eprintln!("Release validation failed: {error}");
            process::exit(1);
        }
    }
}
