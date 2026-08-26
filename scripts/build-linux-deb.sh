#!/usr/bin/env bash
# Build/finalize the Cloakwire Linux DEB and AppImage release artifacts.
set -euo pipefail

VERSION="${1:-1.3.2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ "${SKIP_TAURI_BUILD:-0}" != "1" ]; then
  echo "==> building DEB and AppImage"
  npm run tauri:build -- --bundles deb,appimage
fi

DEB_DIR="src-tauri/target/release/bundle/deb"
APPIMAGE_DIR="src-tauri/target/release/bundle/appimage"
DEB_SRC="$(find "$DEB_DIR" -maxdepth 1 -type f -name 'Cloakwire_*_amd64.deb' -print -quit 2>/dev/null || true)"
APPIMAGE_SRC="$(find "$APPIMAGE_DIR" -maxdepth 1 -type f -name '*.AppImage' -print -quit 2>/dev/null || true)"
[ -n "$DEB_SRC" ] || { echo "ERROR: no DEB produced in $DEB_DIR" >&2; exit 1; }
[ -n "$APPIMAGE_SRC" ] || { echo "ERROR: no AppImage produced in $APPIMAGE_DIR" >&2; exit 1; }

WORK="$(mktemp -d)"
VERIFY_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK" "$VERIFY_DIR"' EXIT

dpkg-deb -R "$DEB_SRC" "$WORK/extracted"
cp scripts/deb-postinst.sh "$WORK/extracted/DEBIAN/postinst"
chmod 0755 "$WORK/extracted/DEBIAN/postinst"
dpkg-deb --root-owner-group -b "$WORK/extracted" "$DEB_SRC"

dpkg-deb -e "$DEB_SRC" "$VERIFY_DIR"
[ -x "$VERIFY_DIR/postinst" ] || { echo "ERROR: DEB postinst is missing" >&2; exit 1; }
grep -q 'setcap' "$VERIFY_DIR/postinst" || { echo "ERROR: DEB postinst does not configure capabilities" >&2; exit 1; }
DEB_CONTENTS="$VERIFY_DIR/contents.txt"
dpkg-deb -c "$DEB_SRC" > "$DEB_CONTENTS"
grep -Eq '/usr/bin/sing-box$' "$DEB_CONTENTS" || { echo "ERROR: sing-box missing from DEB" >&2; exit 1; }
grep -Eq '/usr/bin/xray$' "$DEB_CONTENTS" || { echo "ERROR: Xray missing from DEB" >&2; exit 1; }

mkdir -p dist-release
DEB_DEST="dist-release/Cloakwire_${VERSION}_amd64.deb"
APPIMAGE_DEST="dist-release/Cloakwire_${VERSION}_amd64.AppImage"
cp "$DEB_SRC" "$DEB_DEST"
cp "$APPIMAGE_SRC" "$APPIMAGE_DEST"
chmod +x "$APPIMAGE_DEST"

rm -rf "$WORK/squashfs-root"
(
  cd "$WORK"
  "$PROJECT_ROOT/$APPIMAGE_DEST" --appimage-extract >/dev/null
)
find "$WORK/squashfs-root" -type f -name sing-box -perm -111 -print -quit | grep -q . || { echo "ERROR: sing-box missing from AppImage" >&2; exit 1; }
find "$WORK/squashfs-root" -type f -name xray -perm -111 -print -quit | grep -q . || { echo "ERROR: Xray missing from AppImage" >&2; exit 1; }

sha256sum "$DEB_DEST" "$APPIMAGE_DEST"
echo "==> ready: $DEB_DEST"
echo "==> ready: $APPIMAGE_DEST"
