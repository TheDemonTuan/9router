#!/usr/bin/env python3
"""Build-time only: verify Bun release and rebuild the complete pinned tunnel closure."""
import argparse
import hashlib
import io
import json
import pathlib
import platform
import re
import runpy
import urllib.request
import zipfile


def verify(data, expected, description):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Checksum mismatch: {description}")


def download_archive(asset):
    # Redirects are needed for GitHub's release asset CDN, never for runtime traffic.
    if not asset["url"].startswith("https://github.com/"):
        raise ValueError("Build assets must use pinned GitHub HTTPS releases")
    with urllib.request.urlopen(asset["url"], timeout=180) as response:
        if not response.url.startswith("https://"):
            raise ValueError("Release asset redirected away from HTTPS")
        data = response.read()
    verify(data, asset["sha256"], asset["url"])
    return zipfile.ZipFile(io.BytesIO(data))


def install(manifest, arch, root, revision):
    expected_machine = {"amd64": "x86_64", "arm64": "aarch64"}[arch]
    if platform.system() != "Linux" or platform.machine() != expected_machine:
        raise ValueError("Native Linux builder required; emulation/cross-build is not a release gate")
    binaries = root / "bin"
    binaries.mkdir(parents=True, exist_ok=True)
    bun_asset = manifest["bun"]["platforms"][arch]
    bun = download_archive(bun_asset)
    expected_members = {bun_asset["member"], str(pathlib.PurePosixPath(bun_asset["member"]).parent) + "/"}
    if len(bun.namelist()) != len(expected_members) or set(bun.namelist()) != expected_members:
        raise ValueError("Bun release archive differs from reviewed exact closure")
    elf_machine = {"amd64": 62, "arm64": 183}[arch]

    def binary(name, content, expected_hash):
        verify(content, expected_hash, name)
        if content[:6] != b"\x7fELF\x02\x01" or int.from_bytes(content[18:20], "little") != elf_machine:
            raise ValueError(f"Wrong native ELF architecture: {name}")
        destination = binaries / name
        destination.write_bytes(content)
        destination.chmod(0o755)

    binary("bun", bun.read(bun_asset["member"]), bun_asset["binarySha256"])
    bun.close()
    builder = runpy.run_path(str(pathlib.Path(__file__).with_name("build-tunnel-assets.py")))
    builder["build"](manifest, arch, root, revision)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--arch", choices=("amd64", "arm64"), required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        parser.error("--revision must be the full app git SHA")
    install(json.loads(args.manifest.read_text()), args.arch, args.output, args.revision)
