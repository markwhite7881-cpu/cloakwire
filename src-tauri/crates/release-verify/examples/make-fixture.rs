//! Test-only, tiny signed release assets for local publisher regression tests.
//! The ephemeral signing secret is never written or printed.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign::{sign, KeyPair};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Write},
    path::Path,
    process,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const ARTIFACTS: &[(&str, Option<&str>)] = &[
    ("x64-setup.exe", Some("windows-x86_64")),
    ("x64_en-US.msi", None),
    ("arm64-v8a.apk", Some("android-arm64-v8a")),
    ("aarch64.dmg", Some("darwin-aarch64")),
    ("aarch64.app.zip", None),
    ("x64.dmg", Some("darwin-x86_64")),
    ("x64.app.zip", None),
];
fn write_new(out: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(name))?;
    file.write_all(bytes)?;
    Ok(())
}
fn make_fixture(out: &Path, version: &str) -> Result<()> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || !parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes().all(|c| c.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'))
        })
    {
        return Err("fixture version must be numeric x.y.z without leading zeros".into());
    }
    if out.exists() {
        if fs::read_dir(out)?.next().is_some() {
            return Err("fixture output directory must be empty".into());
        }
    } else {
        fs::create_dir_all(out)?;
    }
    let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair()?;
    let public_key = STANDARD.encode(pk.to_box()?.to_string().as_bytes());
    let mut platforms = serde_json::Map::new();
    let mut hashes = BTreeMap::new();
    for (suffix, platform) in ARTIFACTS {
        let name = format!("Cloakwire_{version}_{suffix}");
        let payload = format!("Cloakwire release test fixture {version} {suffix}\n");
        let signature = sign(
            Some(&pk),
            &sk,
            Cursor::new(payload.as_bytes()),
            Some("ephemeral publisher test fixture"),
            None,
        )?
        .to_string();
        write_new(out, &name, payload.as_bytes())?;
        write_new(out, &format!("{name}.sig"), signature.as_bytes())?;
        hashes.insert(
            name.clone(),
            format!("{:x}", Sha256::digest(payload.as_bytes())),
        );
        if let Some(platform) = platform {
            platforms.insert((*platform).to_string(), json!({
                "url": format!("https://github.com/markwhite7881-cpu/cloakwire/releases/download/v{version}/{name}"),
                "signature": STANDARD.encode(signature.as_bytes()),
                "size": payload.len(),
            }));
        }
    }
    let sums: String = hashes
        .iter()
        .map(|(name, hash)| format!("{hash}  {name}\n"))
        .collect();
    write_new(out, "SHA256SUMS.txt", sums.as_bytes())?;
    write_new(out, &format!("SHA256SUMS_v{version}.txt"), sums.as_bytes())?;
    let manifest = json!({
        "version": version,
        "notes": "Signed fixture for release-tool tests.",
        "pub_date": "2026-10-30T00:00:00Z",
        "platforms": platforms,
    });
    write_new(out, "latest.json", &serde_json::to_vec_pretty(&manifest)?)?;
    write_new(
        out,
        "updater-public-key.base64",
        format!("{public_key}\n").as_bytes(),
    )?;
    Ok(())
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        eprintln!("Usage: cargo run --example make-fixture -- OUTDIR VERSION");
        process::exit(1);
    }
    match make_fixture(Path::new(&args[0]), &args[1]) {
        Ok(()) => println!(
            "Wrote 17 signed test release assets and updater-public-key.base64 to {}",
            args[0]
        ),
        Err(error) => {
            eprintln!("Cannot create release test fixture: {error}");
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use minisign::{verify, PublicKeyBox, SignatureBox};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::{
        collections::BTreeSet,
        fs,
        io::Cursor,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "cloakwire-example-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            if self.0.exists() {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }
    }
    #[test]
    fn generates_seven_real_signatures_exact_manifest_and_checksums_without_secret_file() {
        let temp = Temp::new();
        make_fixture(&temp.0, "1.2.3").unwrap();
        let encoded = fs::read_to_string(temp.0.join("updater-public-key.base64")).unwrap();
        let text = String::from_utf8(STANDARD.decode(encoded.trim()).unwrap()).unwrap();
        let key = PublicKeyBox::from_string(&text)
            .unwrap()
            .into_public_key()
            .unwrap();
        let manifest: Value =
            serde_json::from_slice(&fs::read(temp.0.join("latest.json")).unwrap()).unwrap();
        assert_eq!(manifest["version"], "1.2.3");
        let platforms = manifest["platforms"].as_object().unwrap();
        assert_eq!(
            platforms
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>(),
            [
                "windows-x86_64",
                "android-arm64-v8a",
                "darwin-aarch64",
                "darwin-x86_64"
            ]
            .into_iter()
            .collect()
        );
        let artifacts = [
            ("x64-setup.exe", Some("windows-x86_64")),
            ("x64_en-US.msi", None),
            ("arm64-v8a.apk", Some("android-arm64-v8a")),
            ("aarch64.dmg", Some("darwin-aarch64")),
            ("aarch64.app.zip", None),
            ("x64.dmg", Some("darwin-x86_64")),
            ("x64.app.zip", None),
        ];
        let mut expected_files = [
            "latest.json",
            "SHA256SUMS.txt",
            "SHA256SUMS_v1.2.3.txt",
            "updater-public-key.base64",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
        let mut sums = BTreeSet::new();
        for (suffix, platform) in artifacts {
            let name = format!("Cloakwire_1.2.3_{suffix}");
            let data = fs::read(temp.0.join(&name)).unwrap();
            assert!(!data.is_empty());
            assert!(data.len() < 1024);
            let sig_bytes = fs::read(temp.0.join(format!("{name}.sig"))).unwrap();
            let signature =
                SignatureBox::from_string(std::str::from_utf8(&sig_bytes).unwrap()).unwrap();
            verify(&key, &signature, Cursor::new(&data), true, false, false).unwrap();
            let mut changed = data.clone();
            changed[0] ^= 1;
            assert!(verify(&key, &signature, Cursor::new(changed), true, false, false).is_err());
            if let Some(platform) = platform {
                assert_eq!(platforms[platform]["url"], format!("https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3/{name}"));
                assert_eq!(
                    STANDARD
                        .decode(platforms[platform]["signature"].as_str().unwrap())
                        .unwrap(),
                    sig_bytes
                );
                assert_eq!(
                    platforms[platform]["size"].as_u64(),
                    Some(data.len() as u64)
                );
            }
            sums.insert(format!("{:x}  {name}", Sha256::digest(data)));
            expected_files.insert(name.clone());
            expected_files.insert(format!("{name}.sig"));
        }
        for name in ["SHA256SUMS.txt", "SHA256SUMS_v1.2.3.txt"] {
            let contents = fs::read_to_string(temp.0.join(name)).unwrap();
            assert_eq!(contents.lines().count(), 7);
            assert_eq!(
                contents
                    .lines()
                    .map(str::to_string)
                    .collect::<BTreeSet<_>>(),
                sums
            );
        }
        let actual = fs::read_dir(&temp.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(actual, expected_files);
    }
    #[test]
    fn refuses_existing_contents_and_invalid_version() {
        let temp = Temp::new();
        fs::create_dir(&temp.0).unwrap();
        fs::write(temp.0.join("keep.txt"), "preserve").unwrap();
        assert!(make_fixture(&temp.0, "1.2.3").is_err());
        assert_eq!(
            fs::read_to_string(temp.0.join("keep.txt")).unwrap(),
            "preserve"
        );
        let other = Temp::new();
        assert!(make_fixture(&other.0, "../1.2.3").is_err());
        assert!(!other.0.exists());
    }
}
