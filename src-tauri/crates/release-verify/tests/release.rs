use base64::{engine::general_purpose::STANDARD, Engine};
use minisign::{sign, KeyPair};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

const VERSION: &str = "1.2.3";
const ARTIFACTS: &[(&str, &str, bool)] = &[
    ("x64-setup.exe", "windows-x86_64", true),
    ("x64_en-US.msi", "windows-x86_64", false),
    ("arm64-v8a.apk", "android-arm64-v8a", true),
    ("aarch64.dmg", "darwin-aarch64", true),
    ("aarch64.app.zip", "darwin-aarch64", false),
    ("x64.dmg", "darwin-x86_64", true),
    ("x64.app.zip", "darwin-x86_64", false),
];
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "cloakwire-verifier-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("project/scripts")).unwrap();
        fs::create_dir_all(root.join("project/src-tauri/src")).unwrap();
        let project = root.join("project");
        let catalog: Vec<_> = ARTIFACTS.iter().map(|(suffix, platform, updater)| json!({"suffix": suffix, "platform": platform, "updater": updater})).collect();
        fs::write(
            project.join("scripts/release-artifacts.json"),
            serde_json::to_vec(&catalog).unwrap(),
        )
        .unwrap();
        // The secret key is generated for this fixture and never serialized.
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
        let key_text = pk.to_box().unwrap().to_string();
        fs::write(root.join("public.pub"), &key_text).unwrap();
        fs::write(
            project.join("src-tauri/src/app_update.rs"),
            format!(
                "const UPDATER_PUBLIC_KEY: &str =\n    \"{}\";\n",
                STANDARD.encode(key_text.as_bytes())
            ),
        )
        .unwrap();
        let mut platforms = serde_json::Map::new();
        let mut sums = String::new();
        for (suffix, platform, updater) in ARTIFACTS {
            let name = format!("Cloakwire_{VERSION}_{suffix}");
            let data = format!("signed test payload for {name}\n");
            fs::write(root.join(&name), data.as_bytes()).unwrap();
            let sig = sign(
                Some(&pk),
                &sk,
                Cursor::new(data.as_bytes()),
                Some("fixture"),
                None,
            )
            .unwrap()
            .to_string();
            fs::write(root.join(format!("{name}.sig")), sig.as_bytes()).unwrap();
            sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(data.as_bytes())));
            if *updater {
                platforms.insert(platform.to_string(), json!({"url": format!("https://github.com/markwhite7881-cpu/cloakwire/releases/download/v{VERSION}/{name}"), "signature": STANDARD.encode(sig.as_bytes()), "size": data.len()}));
            }
        }
        fs::write(root.join("SHA256SUMS.txt"), &sums).unwrap();
        fs::write(root.join(format!("SHA256SUMS_v{VERSION}.txt")), &sums).unwrap();
        fs::write(
            root.join("latest.json"),
            serde_json::to_vec(&json!({"version": VERSION, "platforms": platforms})).unwrap(),
        )
        .unwrap();
        Self { root, project }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn manifest(&self, edit: impl FnOnce(&mut Value)) {
        let mut value: Value =
            serde_json::from_slice(&fs::read(self.path("latest.json")).unwrap()).unwrap();
        edit(&mut value);
        fs::write(
            self.path("latest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_release-verify"))
            .args(["--version", VERSION, "--dist"])
            .arg(&self.root)
            .arg("--manifest")
            .arg(self.path("latest.json"))
            .arg("--project-root")
            .arg(&self.project)
            .arg("--full-release")
            .output()
            .unwrap()
    }
    fn reject(&self, expected: &str) {
        let output = self.run();
        assert!(
            !output.status.success(),
            "accepted invalid fixture; expected {expected}"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(expected),
            "expected {expected:?}, received {stderr:?}"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn accepts_all_seven_signed_artifacts_with_application_public_key() {
    let f = Fixture::new();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn rejects_artifact_tampering_even_when_checksums_are_recomputed() {
    let f = Fixture::new();
    let name = "Cloakwire_1.2.3_x64_en-US.msi";
    fs::write(f.path(name), b"tampered").unwrap();
    for sums in ["SHA256SUMS.txt", "SHA256SUMS_v1.2.3.txt"] {
        let text = fs::read_to_string(f.path(sums)).unwrap();
        let text: String = text
            .lines()
            .map(|line| {
                if line.ends_with(name) {
                    format!("{:x}  {name}\n", Sha256::digest(b"tampered"))
                } else {
                    format!("{line}\n")
                }
            })
            .collect();
        fs::write(f.path(sums), text).unwrap();
    }
    f.reject("signature verification failed");
}
#[test]
fn rejects_missing_companion_signature() {
    let f = Fixture::new();
    fs::remove_file(f.path("Cloakwire_1.2.3_x64.app.zip.sig")).unwrap();
    f.reject("signature sidecar");
}
#[test]
fn rejects_missing_artifact() {
    let f = Fixture::new();
    fs::remove_file(f.path("Cloakwire_1.2.3_aarch64.dmg")).unwrap();
    f.reject("artifact");
}
#[test]
fn rejects_zero_length_artifact() {
    let f = Fixture::new();
    fs::write(f.path("Cloakwire_1.2.3_x64_en-US.msi"), []).unwrap();
    f.reject("empty artifact");
}
#[test]
fn rejects_wrong_manifest_version() {
    let f = Fixture::new();
    f.manifest(|m| m["version"] = json!("1.2.30"));
    f.reject("manifest version");
}
#[test]
fn rejects_other_owner_other_tag_http_query_and_prefix_collision() {
    for url in [
        "https://github.com/other/cloakwire/releases/download/v1.2.3/Cloakwire_1.2.3_x64-setup.exe",
        "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.30/Cloakwire_1.2.3_x64-setup.exe",
        "http://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3/Cloakwire_1.2.3_x64-setup.exe",
        "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3/Cloakwire_1.2.3_x64-setup.exe?download=1",
        "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3/Cloakwire_1.2.30_x64-setup.exe",
    ] {
        let f = Fixture::new(); f.manifest(|m| m["platforms"]["windows-x86_64"]["url"] = json!(url)); f.reject("artifact URL");
    }
}
#[test]
fn rejects_missing_platform() {
    let f = Fixture::new();
    f.manifest(|m| {
        m["platforms"]
            .as_object_mut()
            .unwrap()
            .remove("darwin-aarch64");
    });
    f.reject("platform set");
}
#[test]
fn rejects_unexpected_platform() {
    let f = Fixture::new();
    f.manifest(|m| m["platforms"]["linux-x86_64"] = m["platforms"]["windows-x86_64"].clone());
    f.reject("platform set");
}
#[test]
fn rejects_manifest_signature_that_differs_only_in_trailing_newline() {
    let f = Fixture::new();
    f.manifest(|m| {
        let sig = STANDARD
            .decode(
                m["platforms"]["windows-x86_64"]["signature"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        m["platforms"]["windows-x86_64"]["signature"] =
            json!(STANDARD.encode(&sig[..sig.len() - 1]));
    });
    f.reject("sidecar bytes");
}
#[test]
fn rejects_malformed_base64_signature() {
    let f = Fixture::new();
    f.manifest(|m| m["platforms"]["windows-x86_64"]["signature"] = json!("%%%"));
    f.reject("base64");
}
#[test]
fn rejects_size_mismatch() {
    let f = Fixture::new();
    f.manifest(|m| m["platforms"]["windows-x86_64"]["size"] = json!(1));
    f.reject("artifact size");
}
#[test]
fn rejects_checksum_tampering_duplicate_missing_and_unexpected_names() {
    for replacement in ["bad hash", "duplicate", "missing", "unexpected"] {
        let f = Fixture::new();
        let text = fs::read_to_string(f.path("SHA256SUMS.txt")).unwrap();
        let changed = match replacement {
            "bad hash" => format!("{}{}", "0".repeat(64), &text[64..]),
            "duplicate" => format!("{text}{}\n", text.lines().next().unwrap()),
            "missing" => text.lines().skip(1).map(|l| format!("{l}\n")).collect(),
            _ => format!("{text}{}  surprise.exe\n", "0".repeat(64)),
        };
        fs::write(f.path("SHA256SUMS.txt"), changed).unwrap();
        f.reject("checksum");
    }
}
#[test]
fn requires_both_checksum_files_and_checks_versioned_file() {
    let f = Fixture::new();
    fs::remove_file(f.path("SHA256SUMS_v1.2.3.txt")).unwrap();
    f.reject("checksum");
    let f = Fixture::new();
    fs::write(f.path("SHA256SUMS_v1.2.3.txt"), "").unwrap();
    f.reject("checksum");
}
#[test]
fn rejects_unexpected_release_binary_or_signature() {
    for name in [
        "Cloakwire_1.2.3_extra.bin",
        "Cloakwire_1.2.30_x64-setup.exe",
        "unlisted.apk",
        "unlisted.zip.sig",
    ] {
        let f = Fixture::new();
        fs::write(f.path(name), "extra").unwrap();
        f.reject("unexpected release artifact");
    }
}
#[test]
fn allows_build_logs_notes_source_archive_and_provenance() {
    let f = Fixture::new();
    for name in [
        "build.log",
        "RELEASE_NOTES.md",
        "source-v1.2.3.tar.gz",
        "verified-draft.json",
        "build-macos.sh",
    ] {
        fs::write(f.path(name), "stage metadata").unwrap();
    }
    fs::create_dir(f.path("source")).unwrap();
    fs::write(f.path("source/unrelated.exe"), "source internals").unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn rejects_wrong_public_key() {
    let f = Fixture::new();
    let KeyPair { pk, .. } = KeyPair::generate_unencrypted_keypair().unwrap();
    fs::write(
        f.project.join("src-tauri/src/app_update.rs"),
        format!(
            "const UPDATER_PUBLIC_KEY: &str = \"{}\";",
            STANDARD.encode(pk.to_box().unwrap().to_string())
        ),
    )
    .unwrap();
    f.reject("signature verification failed");
}
#[test]
fn supports_explicit_windows_only_legacy_mode_and_public_key_override() {
    let f = Fixture::new();
    f.manifest(|m| {
        m["platforms"]
            .as_object_mut()
            .unwrap()
            .retain(|k, _| k == "windows-x86_64")
    });
    for (suffix, _, _) in ARTIFACTS.iter().filter(|(s, _, _)| *s != "x64-setup.exe") {
        fs::remove_file(f.path(&format!("Cloakwire_{VERSION}_{suffix}"))).unwrap();
        fs::remove_file(f.path(&format!("Cloakwire_{VERSION}_{suffix}.sig"))).unwrap();
    }
    let out = Command::new(env!("CARGO_BIN_EXE_release-verify"))
        .args(["--version", VERSION, "--dist"])
        .arg(&f.root)
        .arg("--manifest")
        .arg(f.path("latest.json"))
        .arg("--project-root")
        .arg(&f.project)
        .args(["--required-platform", "windows-x86_64", "--public-key-file"])
        .arg(f.path("public.pub"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn powershell(script: &Path, args: &[&str]) -> Output {
    Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .args(args)
        .output()
        .unwrap()
}
#[test]
#[cfg(windows)]
fn writer_and_wrapper_roundtrip_with_exact_signature_bytes_and_notes() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    fs::write(f.path("notes.md"), "Fixture release notes\nsecond line\n").unwrap();
    let dist = f.root.to_str().unwrap();
    let output = f.path("written.json");
    let notes = f.path("notes.md");
    let out = powershell(
        &root.join("scripts/write-latest-json.ps1"),
        &[
            "-Version",
            VERSION,
            "-DistPath",
            dist,
            "-OutputPath",
            output.to_str().unwrap(),
            "-BaseUrl",
            "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3",
            "-NotesFile",
            notes.to_str().unwrap(),
        ],
    );
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let m: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    assert_eq!(m["notes"], "Fixture release notes\nsecond line\n");
    assert_eq!(m["platforms"].as_object().unwrap().len(), 4);
    assert_eq!(
        STANDARD
            .decode(
                m["platforms"]["windows-x86_64"]["signature"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
        fs::read(f.path("Cloakwire_1.2.3_x64-setup.exe.sig")).unwrap()
    );
    let key = f.path("public.pub");
    let out = powershell(
        &root.join("scripts/validate-release.ps1"),
        &[
            "-Version",
            VERSION,
            "-DistPath",
            dist,
            "-ManifestPath",
            output.to_str().unwrap(),
            "-FullRelease",
            "-VerifierPath",
            env!("CARGO_BIN_EXE_release-verify"),
            "-ProjectRoot",
            root.to_str().unwrap(),
            "-PublicKeyPath",
            key.to_str().unwrap(),
        ],
    );
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
#[cfg(windows)]
fn writer_rejects_missing_companion_signature_and_wrong_release_url() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    let script = root.join("scripts/write-latest-json.ps1");
    fs::remove_file(f.path("Cloakwire_1.2.3_aarch64.app.zip.sig")).unwrap();
    let out = powershell(
        &script,
        &[
            "-Version",
            VERSION,
            "-DistPath",
            f.root.to_str().unwrap(),
            "-BaseUrl",
            "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3",
        ],
    );
    assert!(
        !out.status.success(),
        "writer accepted missing companion signature"
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("Signature is missing"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let f = Fixture::new();
    let out = powershell(
        &script,
        &[
            "-Version",
            VERSION,
            "-DistPath",
            f.root.to_str().unwrap(),
            "-BaseUrl",
            "https://github.com/other/cloakwire/releases/download/v1.2.3",
        ],
    );
    assert!(!out.status.success(), "writer accepted another repository");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("BaseUrl must be exactly"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn rejects_noncanonical_version_arguments_before_reading_artifacts() {
    let f = Fixture::new();
    for version in ["01.2.3", "1.2.3-beta", "1.2.3+build", "../1.2.3", "1.2"] {
        let out = Command::new(env!("CARGO_BIN_EXE_release-verify"))
            .args(["--version", version, "--dist"])
            .arg(&f.root)
            .arg("--manifest")
            .arg(f.path("latest.json"))
            .arg("--project-root")
            .arg(&f.project)
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("version must"),
            "version {version}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
#[test]
fn verifies_crypto_for_each_primary_and_companion_even_with_matching_sha256() {
    for (suffix, platform, primary) in ARTIFACTS {
        let f = Fixture::new();
        let name = format!("Cloakwire_{VERSION}_{suffix}");
        fs::write(f.path(&name), b"changed payload").unwrap();
        if *primary {
            f.manifest(|m| m["platforms"][platform]["size"] = json!(15));
        }
        for sums in ["SHA256SUMS.txt", "SHA256SUMS_v1.2.3.txt"] {
            let text = fs::read_to_string(f.path(sums)).unwrap();
            let text: String = text
                .lines()
                .map(|line| {
                    if line.ends_with(&name) {
                        format!("{:x}  {name}\n", Sha256::digest(b"changed payload"))
                    } else {
                        format!("{line}\n")
                    }
                })
                .collect();
            fs::write(f.path(sums), text).unwrap();
        }
        f.reject("signature verification failed");
    }
}
#[test]
fn rejects_replaced_signature_even_when_manifest_and_sidecar_match() {
    let f = Fixture::new();
    let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
    let name = "Cloakwire_1.2.3_x64-setup.exe";
    let forged = sign(
        Some(&pk),
        &sk,
        Cursor::new(fs::read(f.path(name)).unwrap()),
        Some("different key"),
        None,
    )
    .unwrap()
    .to_string();
    fs::write(f.path(&format!("{name}.sig")), &forged).unwrap();
    f.manifest(|m| {
        m["platforms"]["windows-x86_64"]["signature"] = json!(STANDARD.encode(forged.as_bytes()))
    });
    f.reject("signature verification failed");
}
#[test]
fn rejects_corrupt_catalog_and_full_release_platform_subset() {
    let f = Fixture::new();
    fs::write(
        f.project.join("scripts/release-artifacts.json"),
        r#"[{"suffix":"unexpected.exe","platform":"windows-x86_64","updater":true}]"#,
    )
    .unwrap();
    f.reject("artifact catalog");
    let f = Fixture::new();
    let out = Command::new(env!("CARGO_BIN_EXE_release-verify"))
        .args(["--version", VERSION, "--dist"])
        .arg(&f.root)
        .arg("--manifest")
        .arg(f.path("latest.json"))
        .arg("--project-root")
        .arg(&f.project)
        .args(["--full-release", "--required-platform", "windows-x86_64"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("platform set"));
}
#[test]
#[cfg(windows)]
fn writer_supports_explicit_legacy_windows_arguments() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let outpath = f.path("legacy.json");
    let sig = f.path("Cloakwire_1.2.3_x64-setup.exe.sig");
    let out = powershell(
        &root.join("scripts/write-latest-json.ps1"),
        &[
            "-Version",
            VERSION,
            "-DistPath",
            f.root.to_str().unwrap(),
            "-OutputPath",
            outpath.to_str().unwrap(),
            "-BaseUrl",
            "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3",
            "-ArtifactName",
            "Cloakwire_1.2.3_x64-setup.exe",
            "-Platform",
            "windows-x86_64",
            "-SignaturePath",
            sig.to_str().unwrap(),
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let manifest: Value = serde_json::from_slice(&fs::read(outpath).unwrap()).unwrap();
    assert_eq!(manifest["platforms"].as_object().unwrap().len(), 1);
    assert_eq!(manifest["platforms"]["windows-x86_64"]["url"], "https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3/Cloakwire_1.2.3_x64-setup.exe");
}
#[test]
#[cfg(windows)]
fn writer_rejects_noncanonical_version_before_artifact_lookup() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    for version in ["01.2.3", "1.2.3-beta", "1.2.3+build"] {
        let url =
            format!("https://github.com/markwhite7881-cpu/cloakwire/releases/download/v{version}");
        let out = powershell(
            &root.join("scripts/write-latest-json.ps1"),
            &[
                "-Version",
                version,
                "-DistPath",
                f.root.to_str().unwrap(),
                "-BaseUrl",
                &url,
            ],
        );
        assert!(!out.status.success());
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("Version must"),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
#[cfg(windows)]
fn wrapper_defaults_to_script_project_under_windows_powershell() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let manifest = f.path("latest.json");
    let key = f.path("public.pub");
    let out = powershell(
        &root.join("scripts/validate-release.ps1"),
        &[
            "-Version",
            VERSION,
            "-DistPath",
            f.root.to_str().unwrap(),
            "-ManifestPath",
            manifest.to_str().unwrap(),
            "-FullRelease",
            "-VerifierPath",
            env!("CARGO_BIN_EXE_release-verify"),
            "-PublicKeyPath",
            key.to_str().unwrap(),
        ],
    );
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
#[cfg(windows)]
fn wrapper_runs_exact_verifier_when_given_filename_in_current_directory() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let launch = f.path("verifier");
    fs::create_dir(&launch).unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_release-verify"),
        launch.join("fixture-verifier.exe"),
    )
    .unwrap();
    let manifest = f.path("latest.json");
    let key = f.path("public.pub");
    let out = Command::new("powershell.exe")
        .current_dir(&launch)
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(root.join("scripts/validate-release.ps1"))
        .args([
            "-Version",
            VERSION,
            "-DistPath",
            f.root.to_str().unwrap(),
            "-ManifestPath",
            manifest.to_str().unwrap(),
            "-FullRelease",
            "-VerifierPath",
            "fixture-verifier.exe",
            "-ProjectRoot",
            root.to_str().unwrap(),
            "-PublicKeyPath",
            key.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
#[cfg(windows)]
fn writer_resolves_relative_input_and_output_against_powershell_location() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let launch = f.path("launch");
    fs::create_dir(&launch).unwrap();
    let script = format!("Set-Location -LiteralPath '{}'; & '{}' -Version 1.2.3 -DistPath '.' -OutputPath 'relative.json' -BaseUrl 'https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.2.3' -ArtifactName 'Cloakwire_1.2.3_x64-setup.exe' -Platform 'windows-x86_64' -SignaturePath 'Cloakwire_1.2.3_x64-setup.exe.sig'", f.root.display().to_string().replace('\'', "''"), root.join("scripts/write-latest-json.ps1").display().to_string().replace('\'', "''"));
    let encoded: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let out = Command::new("powershell.exe")
        .current_dir(&launch)
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
        ])
        .arg(STANDARD.encode(encoded))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        f.path("relative.json").is_file(),
        "manifest was not written in PowerShell's current location"
    );
    assert!(
        !launch.join("relative.json").exists(),
        "manifest was written in the process launch directory"
    );
}
