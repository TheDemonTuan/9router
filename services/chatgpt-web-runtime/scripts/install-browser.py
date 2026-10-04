#!/usr/bin/env python3
"""Provision pinned Chrome in the Docker browser cache; never add its payload to an image."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import tempfile
import urllib.request
import zipfile


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def check_binary(path, arch, expected):
    with path.open('rb') as stream:
        header = stream.read(20)
    if header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != {'amd64': 62, 'arm64': 183}[arch]:
        raise ValueError('CGW_BROWSER_ARCHITECTURE')
    if sha256(path) != expected:
        raise ValueError('CGW_BROWSER_BINARY_CHECKSUM')


def verify_existing(output, browser, arch):
    if output.is_symlink() or not output.is_dir():
        raise ValueError('CGW_BROWSER_DIRECTORY')
    proof_path = output / '.cgw-chrome.json'
    if proof_path.is_symlink():
        raise ValueError('CGW_BROWSER_PROVENANCE')
    proof = json.loads(proof_path.read_text(encoding='utf-8'))
    asset = browser['platforms'][arch]
    for key, value in {'version': browser['version'], 'architecture': arch,
                       'archiveSha256': asset['sha256'], 'binarySha256': asset['binarySha256']}.items():
        if proof.get(key) != value:
            raise ValueError('CGW_BROWSER_PROVENANCE')
    files = proof.get('files')
    if not isinstance(files, dict) or not files or files.get('chrome') != asset['binarySha256']:
        raise ValueError('CGW_BROWSER_PROVENANCE')
    actual = set()
    for path in output.rglob('*'):
        if path.is_symlink() or not (path.is_file() or path.is_dir()) or path.stat().st_mode & 0o022:
            raise ValueError('CGW_BROWSER_FILE_POLICY')
        if path.is_file() and path != proof_path:
            relative = path.relative_to(output).as_posix()
            actual.add(relative)
            if files.get(relative) != sha256(path):
                raise ValueError('CGW_BROWSER_FILE_CHECKSUM')
    if actual != set(files):
        raise ValueError('CGW_BROWSER_FILE_CLOSURE')
    check_binary(output / 'chrome', arch, asset['binarySha256'])


def unpack(archive, destination, asset, arch):
    prefix = PurePosixPath(asset['member']).parent.as_posix() + '/'
    seen = set()
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            if not entry.filename.startswith(prefix):
                raise ValueError('CGW_BROWSER_ARCHIVE_ROOT')
            name = entry.filename[len(prefix):]
            if not name and entry.is_dir():
                continue
            parts = name.rstrip('/').split('/')
            if not name or any(part in ('', '.', '..') for part in parts) or '\\' in name:
                raise ValueError('CGW_BROWSER_ARCHIVE_PATH')
            normalized = '/'.join(parts)
            if normalized in seen or normalized in ('.cgw-chrome.json', 'browser.spdx.json'):
                raise ValueError('CGW_BROWSER_ARCHIVE_DUPLICATE')
            seen.add(normalized)
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG):
                raise ValueError('CGW_BROWSER_ARCHIVE_TYPE')
            target = destination.joinpath(*parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                target.chmod(0o755)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with bundle.open(entry) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if mode & 0o111 else 0o644)
    destination.chmod(0o755)
    for directory in destination.rglob('*'):
        if directory.is_dir():
            directory.chmod(0o755)
    check_binary(destination / 'chrome', arch, asset['binarySha256'])
    if not os.access(destination / 'chrome', os.X_OK):
        raise ValueError('CGW_BROWSER_NOT_EXECUTABLE')


def native_arch():
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if platform.system() != 'Linux' or arch is None:
        raise ValueError('CGW_BROWSER_NATIVE_LINUX_REQUIRED')
    return arch


def install(browser, arch, output):
    if arch != native_arch():
        raise ValueError('CGW_BROWSER_NATIVE_LINUX_REQUIRED')
    output = Path(os.path.abspath(output))
    if output.exists() or output.is_symlink():
        verify_existing(output, browser, arch)
        return
    asset = browser['platforms'][arch]
    expected_url = ('https://storage.googleapis.com/chrome-for-testing-public/' + browser['version'] + '/' +
                    {'amd64': 'linux64/chrome-linux64.zip', 'arm64': 'linux-arm64/chrome-linux-arm64.zip'}[arch])
    if asset['url'] != expected_url:
        raise ValueError('CGW_BROWSER_DOWNLOAD_ORIGIN')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.cgw-browser-', dir=output.parent) as temporary:
        staging = Path(temporary)
        archive = staging / 'chrome.zip'
        with urllib.request.urlopen(asset['url'], timeout=180) as response, archive.open('wb') as stream:
            if response.url != expected_url:
                raise ValueError('CGW_BROWSER_DOWNLOAD_REDIRECT')
            shutil.copyfileobj(response, stream)
        if sha256(archive) != asset['sha256']:
            raise ValueError('CGW_BROWSER_ARCHIVE_CHECKSUM')
        payload = staging / 'payload'
        payload.mkdir(mode=0o755)
        unpack(archive, payload, asset, arch)
        sbom = {'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0', 'SPDXID': 'SPDXRef-DOCUMENT',
                'name': 'Google Chrome for Testing',
                'documentNamespace': 'https://9router.local/browser/' + asset['sha256'],
                'creationInfo': {'creators': ['Tool: 9router-browser-installer'], 'created': '2026-10-04T00:00:00Z'},
                'packages': [{'name': 'Google Chrome', 'SPDXID': 'SPDXRef-Chrome', 'versionInfo': browser['version'],
                    'downloadLocation': asset['url'], 'filesAnalyzed': False,
                    'checksums': [{'algorithm': 'SHA256', 'checksumValue': asset['sha256']}],
                    'licenseConcluded': 'NOASSERTION', 'licenseDeclared': 'NOASSERTION',
                    'copyrightText': 'NOASSERTION',
                    'externalRefs': [{'referenceCategory': 'SECURITY', 'referenceType': 'cpe23Type',
                        'referenceLocator': 'cpe:2.3:a:google:chrome:' + browser['version'] + ':*:*:*:*:*:*:*'}]}],
                'relationships': [{'spdxElementId': 'SPDXRef-DOCUMENT', 'relationshipType': 'DESCRIBES',
                                   'relatedSpdxElement': 'SPDXRef-Chrome'}]}
        (payload / 'browser.spdx.json').write_text(json.dumps(sbom, indent=2) + '\n', encoding='utf-8')
        (payload / 'browser.spdx.json').chmod(0o644)
        proof = {'version': browser['version'], 'architecture': arch, 'archiveSha256': asset['sha256'],
                 'binarySha256': asset['binarySha256'],
                 'files': {path.relative_to(payload).as_posix(): sha256(path) for path in sorted(payload.rglob('*')) if path.is_file()}}
        (payload / '.cgw-chrome.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
        (payload / '.cgw-chrome.json').chmod(0o644)
        verify_existing(payload, browser, arch)
        # Rename only a new directory; never replace the browser under a running owner.
        payload.rename(output)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--arch', choices=('amd64', 'arm64'))
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    browser = json.loads(args.manifest.read_text(encoding='utf-8'))['browser']
    arch = args.arch or native_arch()
    output = args.output or Path(browser['installRoot'])
    install(browser, arch, output)
    print(json.dumps({'gate': 'browser-provisioned', 'architecture': arch, 'path': str(output)}))


if __name__ == '__main__':
    main()
