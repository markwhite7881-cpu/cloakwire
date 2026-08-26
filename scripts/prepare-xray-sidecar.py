#!/usr/bin/env python3
"""Download and verify the pinned Xray sidecar for a Tauri target."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile
import urllib.request
import zipfile


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_zip_members(archive: zipfile.ZipFile) -> None:
    for info in archive.infolist():
        member = PurePosixPath(info.filename)
        if member.is_absolute() or ".." in member.parts:
            raise RuntimeError(f"unsafe archive member: {info.filename}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--project-root", type=Path)
    args = parser.parse_args()

    project_root = (args.project_root or Path(__file__).resolve().parent.parent).resolve()
    manifest_path = project_root / "scripts" / "xray-core-assets.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    try:
        asset = manifest["targets"][args.target]
    except KeyError as error:
        raise SystemExit(f"unsupported Xray target: {args.target}") from error

    suffix = ".exe" if args.target.endswith("windows-msvc") else ""
    output = project_root / "src-tauri" / "binaries" / f"xray-{args.target}{suffix}"
    output.parent.mkdir(parents=True, exist_ok=True)

    if output.exists():
        if output.stat().st_size == asset["executableSize"] and sha256_file(output) == asset["executableSha256"]:
            print(f"verified existing {output}")
            return
        output.unlink()

    with tempfile.TemporaryDirectory(prefix="cloakwire-xray-") as temp_dir:
        temp = Path(temp_dir)
        archive_path = temp / "xray.zip"
        request = urllib.request.Request(
            asset["archiveUrl"], headers={"User-Agent": "Cloakwire-release-builder/1.3.2"}
        )
        with urllib.request.urlopen(request, timeout=180) as response, archive_path.open("wb") as target:
            shutil.copyfileobj(response, target)

        archive_hash = sha256_file(archive_path)
        if archive_hash != asset["archiveSha256"]:
            raise RuntimeError(f"Xray archive hash mismatch: {archive_hash}")

        with zipfile.ZipFile(archive_path) as archive:
            validate_zip_members(archive)
            matches = [info for info in archive.infolist() if info.filename == asset["archiveMember"]]
            if len(matches) != 1:
                raise RuntimeError(f"expected one {asset['archiveMember']} member, found {len(matches)}")
            extracted = temp / "xray"
            with archive.open(matches[0]) as source, extracted.open("wb") as target:
                shutil.copyfileobj(source, target)

        executable_hash = sha256_file(extracted)
        executable_size = extracted.stat().st_size
        if executable_hash != asset["executableSha256"] or executable_size != asset["executableSize"]:
            raise RuntimeError(
                f"Xray executable integrity mismatch: size={executable_size} sha256={executable_hash}"
            )

        temporary_output = output.with_suffix(output.suffix + ".tmp")
        shutil.copyfile(extracted, temporary_output)
        os.chmod(temporary_output, 0o755)
        temporary_output.replace(output)

    print(f"prepared {output} ({manifest['version']})")


if __name__ == "__main__":
    main()
