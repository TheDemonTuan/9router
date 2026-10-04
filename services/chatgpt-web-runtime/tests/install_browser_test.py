import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import zipfile

spec = importlib.util.spec_from_file_location('install_browser', Path(__file__).parents[1] / 'scripts/install-browser.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class BrowserExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = b'\x7fELF\x02\x01' + bytes(12) + (62).to_bytes(2, 'little') + b'fixture'
        self.asset = {'member': 'chrome-linux64/chrome', 'sha256': 'a' * 64,
                      'binarySha256': hashlib.sha256(self.binary).hexdigest()}

    def archive(self, entries):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as bundle:
            for name, data, mode in entries:
                entry = zipfile.ZipInfo('chrome-linux64/' + name)
                entry.external_attr = mode << 16
                bundle.writestr(entry, data)
        stream.seek(0)
        return stream

    def test_traversal_and_symlink_are_rejected_without_writing_outside(self):
        for name, mode in [('../outside', stat.S_IFREG | 0o644), ('link', stat.S_IFLNK | 0o777)]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    installer.unpack(self.archive([(name, b'contents', mode)]), self.root, self.asset, 'amd64')
                self.assertFalse((self.root.parent / 'outside').exists())
                self.assertFalse((self.root / 'link').exists())

    def test_wrong_architecture_and_binary_hash_are_rejected(self):
        for arch, asset in [('arm64', self.asset), ('amd64', {**self.asset, 'binarySha256': 'b' * 64})]:
            with self.subTest(arch=arch):
                target = self.root / arch
                target.mkdir(exist_ok=True)
                with self.assertRaises(ValueError):
                    installer.unpack(self.archive([('chrome', self.binary, stat.S_IFREG | 0o755)]), target, asset, arch)

    def test_existing_payload_tampering_or_additional_files_are_rejected(self):
        installer.unpack(self.archive([('chrome', self.binary, stat.S_IFREG | 0o755)]), self.root, self.asset, 'amd64')
        proof = {'version': '154.0.8037.92', 'architecture': 'amd64',
                 'archiveSha256': self.asset['sha256'], 'binarySha256': self.asset['binarySha256'],
                 'files': {'chrome': self.asset['binarySha256']}}
        (self.root / '.cgw-chrome.json').write_text(json.dumps(proof), encoding='utf-8')
        browser = {'version': proof['version'], 'platforms': {'amd64': self.asset}}
        installer.verify_existing(self.root, browser, 'amd64')
        extra = self.root / 'injected'
        extra.write_bytes(b'unreviewed')
        with self.assertRaisesRegex(ValueError, 'FILE_CHECKSUM'):
            installer.verify_existing(self.root, browser, 'amd64')
        extra.unlink()
        (self.root / 'chrome').write_bytes(self.binary + b'changed')
        with self.assertRaisesRegex(ValueError, 'FILE_CHECKSUM'):
            installer.verify_existing(self.root, browser, 'amd64')

    def downloaded_browser(self):
        arch = installer.native_arch()
        member = {'amd64': 'chrome-linux64/chrome', 'arm64': 'chrome-linux-arm64/chrome'}[arch]
        binary = b'\x7fELF\x02\x01' + bytes(12) + {'amd64': 62, 'arm64': 183}[arch].to_bytes(2, 'little') + b'fixture'
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as bundle:
            entry = zipfile.ZipInfo(member)
            entry.external_attr = (stat.S_IFREG | 0o755) << 16
            bundle.writestr(entry, binary)
        content = stream.getvalue()
        version = '154.0.8037.92'
        asset = {'url': 'https://storage.googleapis.com/chrome-for-testing-public/' + version + '/' +
                 {'amd64': 'linux64/chrome-linux64.zip', 'arm64': 'linux-arm64/chrome-linux-arm64.zip'}[arch],
                 'member': member, 'sha256': hashlib.sha256(content).hexdigest(),
                 'binarySha256': hashlib.sha256(binary).hexdigest()}
        browser = {'version': version, 'installRoot': str(self.root / version), 'platforms': {arch: asset}}
        response = io.BytesIO(content)
        response.url = asset['url']
        return arch, browser, response

    def test_manifest_defaults_publish_version_and_preserve_rollback(self):
        arch, browser, response = self.downloaded_browser()
        rollback = self.root / '153.0.8010.12'
        rollback.mkdir()
        (rollback / 'retained').write_bytes(b'previous browser')
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'browser': browser}), encoding='utf-8')
        with mock.patch.object(installer.urllib.request, 'urlopen', return_value=response):
            installer.main(['--manifest', str(manifest)])
        output = Path(browser['installRoot'])
        installer.verify_existing(output, browser, arch)
        self.assertEqual((rollback / 'retained').read_bytes(), b'previous browser')
        self.assertFalse(list(self.root.glob('.cgw-browser-*')))
        self.assertEqual(output.stat().st_mode & 0o777, 0o755)
        sbom = json.loads((output / 'browser.spdx.json').read_text(encoding='utf-8'))
        self.assertEqual(sbom['packages'][0]['versionInfo'], browser['version'])
        with mock.patch.object(installer.urllib.request, 'urlopen', side_effect=AssertionError('must reuse verified version')):
            installer.main(['--manifest', str(manifest), '--arch', arch, '--output', str(output)])
        (output / 'chrome').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'FILE_CHECKSUM'):
            installer.install(browser, arch, output)

    def test_failed_download_verification_never_publishes_version(self):
        for failure in ('checksum', 'redirect'):
            with self.subTest(failure=failure):
                arch, browser, response = self.downloaded_browser()
                if failure == 'checksum':
                    browser['platforms'][arch]['sha256'] = '0' * 64
                else:
                    response.url = 'https://untrusted.invalid/browser.zip'
                with mock.patch.object(installer.urllib.request, 'urlopen', return_value=response):
                    with self.assertRaisesRegex(ValueError, 'ARCHIVE_CHECKSUM|DOWNLOAD_REDIRECT'):
                        installer.install(browser, arch, Path(browser['installRoot']))
                self.assertFalse(Path(browser['installRoot']).exists())
                self.assertFalse(list(self.root.glob('.cgw-browser-*')))

    def test_native_architecture_and_cross_arch_install_boundary(self):
        for machine, arch in [('x86_64', 'amd64'), ('aarch64', 'arm64')]:
            with mock.patch.object(installer.platform, 'system', return_value='Linux'), mock.patch.object(installer.platform, 'machine', return_value=machine):
                self.assertEqual(installer.native_arch(), arch)
                with self.assertRaisesRegex(ValueError, 'NATIVE_LINUX_REQUIRED'):
                    installer.install({}, 'arm64' if arch == 'amd64' else 'amd64', self.root / 'wrong')
        with mock.patch.object(installer.platform, 'system', return_value='Windows'):
            with self.assertRaisesRegex(ValueError, 'NATIVE_LINUX_REQUIRED'):
                installer.native_arch()

    def test_streaming_checksum_covers_multiple_chunks(self):
        data = b'a' * (1024 * 1024 + 17)
        path = self.root / 'large-file'
        path.write_bytes(data)
        self.assertEqual(installer.sha256(path), hashlib.sha256(data).hexdigest())


if __name__ == '__main__':
    unittest.main()
