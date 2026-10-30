#!/bin/bash
set -euo pipefail
version="$1"; commit="$2"; run_id="$3"; build_root="$4"; core_dir="$5"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$run_id" =~ ^[0-9a-zA-Z-]+$ ]] || exit 2
expand_home() {
  case "$1" in '~/'*) printf '%s/%s' "$HOME" "${1:2}";; *) printf '%s' "$1";; esac
}
build_root="$(expand_home "$build_root")"; core_dir="$(expand_home "$core_dir")"
[[ "$build_root" = /* ]] || { echo 'Mac build root must be absolute.' >&2; exit 2; }
[[ "$core_dir" = /* ]] || { echo 'Mac core directory must be absolute.' >&2; exit 2; }
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
work="$build_root/cloakwire-$version-$run_id"
test ! -e "$work"
mkdir -p "$work"
cd "$work"
tar -xzf "/tmp/cloakwire-$run_id.tar.gz"
# Host-specific Cargo configuration is superseded by this run's target directory.
rm -f src-tauri/.cargo/config.toml
export CARGO_TARGET_DIR="$work/.release-target"
node scripts/release-version.mjs check --version "$version"
mkdir -p src-tauri/binaries release-output
inputs=()
for name in sing-box-aarch64-apple-darwin sing-box-x86_64-apple-darwin xray-aarch64-apple-darwin xray-x86_64-apple-darwin wintun.dll; do
  test -f "$core_dir/$name"
  cp "$core_dir/$name" "src-tauri/binaries/$name"
  inputs+=("src-tauri/binaries/$name")
done
chmod +x src-tauri/binaries/sing-box-* src-tauri/binaries/xray-*
node scripts/release-inputs.mjs "${inputs[@]}" > release-output/mac-inputs.json
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib -- --include-ignored --skip process:: --skip killswitch:: --quiet
for arch in aarch64 x86_64; do
  target="$arch-apple-darwin"; label="$arch"
  if [ "$arch" = x86_64 ]; then label=x64; fi
  npm run tauri:build -- --target "$target" --bundles app
  app="$CARGO_TARGET_DIR/$target/release/bundle/macos/Cloakwire.app"
  test -d "$app"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$version"
  lipo "$app/Contents/MacOS/cloakwire" -verify_arch "${arch/aarch64/arm64}"
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"
  ditto -c -k --keepParent "$app" "release-output/Cloakwire_${version}_$label.app.zip"
  dmg_stage="$work/dmg-$label"
  mkdir "$dmg_stage"
  ditto "$app" "$dmg_stage/Cloakwire.app"
  ln -s /Applications "$dmg_stage/Applications"
  hdiutil create -quiet -volname Cloakwire -srcfolder "$dmg_stage" -format UDZO "release-output/Cloakwire_${version}_$label.dmg"
  hdiutil verify "release-output/Cloakwire_${version}_$label.dmg"
done
printf '%s\n' "$commit" > release-output/source-commit.txt
shasum -a 256 release-output/Cloakwire_*

tar -czf "/tmp/cloakwire-$run_id-output.tar.gz" -C release-output "Cloakwire_${version}_aarch64.dmg" "Cloakwire_${version}_aarch64.app.zip" "Cloakwire_${version}_x64.dmg" "Cloakwire_${version}_x64.app.zip" mac-inputs.json source-commit.txt
