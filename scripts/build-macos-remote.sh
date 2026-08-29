#!/bin/bash
set -ex

VERSION="1.4.0"
BUILD_DIR="$HOME/cloakwire-builds/cloakwire-v$VERSION"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

tar -xzf /tmp/v$VERSION-source.tar.gz
rm -f src-tauri/.cargo/config.toml
mkdir -p src-tauri/binaries
cp -r $HOME/cloakwire-builds/cloakwire-v1.3.2-fixed/src-tauri/binaries/* src-tauri/binaries/
if [ -d "$HOME/cloakwire-builds/cloakwire-v1.3.2-fixed/node_modules" ]; then
  cp -R $HOME/cloakwire-builds/cloakwire-v1.3.2-fixed/node_modules ./
fi

export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$BUILD_DIR/src-tauri/target"

npm run build

echo "== Building ARM64 =="
npm run tauri:build -- --target aarch64-apple-darwin --bundles app

echo "== Building x86_64 =="
npm run tauri:build -- --target x86_64-apple-darwin --bundles app

mkdir -p dist-release

echo "== Packaging ARM64 =="
ditto -c -k --keepParent src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Cloakwire.app dist-release/Cloakwire_${VERSION}_aarch64.app.zip

rm -rf /tmp/dmg-arm64
mkdir -p /tmp/dmg-arm64
cp -R src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Cloakwire.app /tmp/dmg-arm64/
ln -s /Applications /tmp/dmg-arm64/Applications
hdiutil create -volname "Cloakwire" -srcfolder /tmp/dmg-arm64 -ov -format UDZO dist-release/Cloakwire_${VERSION}_aarch64.dmg
rm -rf /tmp/dmg-arm64

echo "== Packaging x86_64 =="
ditto -c -k --keepParent src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Cloakwire.app dist-release/Cloakwire_${VERSION}_x64.app.zip

rm -rf /tmp/dmg-x64
mkdir -p /tmp/dmg-x64
cp -R src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Cloakwire.app /tmp/dmg-x64/
ln -s /Applications /tmp/dmg-x64/Applications
hdiutil create -volname "Cloakwire" -srcfolder /tmp/dmg-x64 -ov -format UDZO dist-release/Cloakwire_${VERSION}_x64.dmg
rm -rf /tmp/dmg-x64

echo "macOS build completed successfully."
