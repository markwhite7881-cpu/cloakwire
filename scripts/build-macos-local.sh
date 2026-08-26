#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$ROOT"

SINGBOX_SOURCE="${TMPDIR:-/tmp}/cloakwire-sing-box-lx"
rm -rf "$SINGBOX_SOURCE"
git init "$SINGBOX_SOURCE"
git -C "$SINGBOX_SOURCE" remote add origin https://github.com/Leadaxe/sing-box-lx.git
git -C "$SINGBOX_SOURCE" fetch --depth 1 origin 9558ceb27bc1e92e2ecfa96ebfe6b3f688344c5a
git -C "$SINGBOX_SOURCE" checkout --detach FETCH_HEAD
git -C "$SINGBOX_SOURCE" submodule update --init --depth 1 submodules/gvisor submodules/sing-tun submodules/wireguard-go

build_singbox() {
  local target="$1"
  local goarch="$2"
  (
    cd "$SINGBOX_SOURCE"
    CGO_ENABLED=1 GOOS=darwin GOARCH="$goarch" go build \
      -tags 'with_xhttp with_awg with_quic with_wireguard with_utls with_clash_api with_naive_outbound with_lx_command' \
      -trimpath -ldflags '-s -w -buildid=' \
      -o "$ROOT/src-tauri/binaries/sing-box-$target" \
      ./cmd/sing-box
  )
  chmod +x "src-tauri/binaries/sing-box-$target"
  file "src-tauri/binaries/sing-box-$target"
}

build_singbox aarch64-apple-darwin arm64
build_singbox x86_64-apple-darwin amd64
python3 scripts/prepare-xray-sidecar.py --target aarch64-apple-darwin
python3 scripts/prepare-xray-sidecar.py --target x86_64-apple-darwin
file src-tauri/binaries/xray-aarch64-apple-darwin
file src-tauri/binaries/xray-x86_64-apple-darwin
src-tauri/binaries/sing-box-aarch64-apple-darwin version
src-tauri/binaries/xray-aarch64-apple-darwin version

npm ci
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
CLOAKWIRE_TEST_MANIFEST=1 cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-apple-darwin

mkdir -p dist-release
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  NO_STRIP=true npm run tauri:build -- --target "$target" --bundles app
  if [ "$target" = "aarch64-apple-darwin" ]; then label="aarch64"; else label="x64"; fi
  app="$(find "src-tauri/target/$target/release/bundle/macos" -maxdepth 1 -type d -name '*.app' -print -quit)"
  test -n "$app"
  dmg="dist-release/Cloakwire_1.3.2_${label}.dmg"
  stage="$(mktemp -d)"
  ditto "$app" "$stage/Cloakwire.app"
  ln -s /Applications "$stage/Applications"
  rm -f "$dmg"
  hdiutil create -quiet -ov -volname "Cloakwire" -srcfolder "$stage" -format UDZO "$dmg"
  rm -rf "$stage"
  rm -f "dist-release/Cloakwire_1.3.2_${label}.app.zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "dist-release/Cloakwire_1.3.2_${label}.app.zip"
done
shasum -a 256 dist-release/Cloakwire_1.3.2_*.dmg dist-release/Cloakwire_1.3.2_*.app.zip > dist-release/SHA256SUMS-macos.txt
cat dist-release/SHA256SUMS-macos.txt
