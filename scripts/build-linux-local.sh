#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.local/go/bin:$PATH"
cd "$ROOT"

SINGBOX_SOURCE="${TMPDIR:-/tmp}/cloakwire-sing-box-lx"
rm -rf "$SINGBOX_SOURCE"
git init "$SINGBOX_SOURCE"
git -C "$SINGBOX_SOURCE" remote add origin https://github.com/Leadaxe/sing-box-lx.git
git -C "$SINGBOX_SOURCE" fetch --depth 1 origin 9558ceb27bc1e92e2ecfa96ebfe6b3f688344c5a
git -C "$SINGBOX_SOURCE" checkout --detach FETCH_HEAD
git -C "$SINGBOX_SOURCE" submodule update --init --recursive --depth 1
(
  cd "$SINGBOX_SOURCE"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -tags 'with_xhttp with_awg with_quic with_wireguard with_utls with_clash_api with_lx_command' \
    -trimpath -ldflags '-s -w -buildid=' \
    -o "$ROOT/src-tauri/binaries/sing-box-x86_64-unknown-linux-gnu" \
    ./cmd/sing-box
)
chmod +x src-tauri/binaries/sing-box-x86_64-unknown-linux-gnu
src-tauri/binaries/sing-box-x86_64-unknown-linux-gnu version
python3 scripts/prepare-xray-sidecar.py --target x86_64-unknown-linux-gnu
src-tauri/binaries/xray-x86_64-unknown-linux-gnu version

npm ci
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
CLOAKWIRE_TEST_MANIFEST=1 cargo test --manifest-path src-tauri/Cargo.toml --lib
./scripts/build-linux-deb.sh 1.3.2
