import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
