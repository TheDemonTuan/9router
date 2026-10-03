#!/usr/bin/env python3
"""Invoke pinned Chromium's own LLVM/Rust builders with native Linux host inputs.

Only host-tool selection changes: browser sources, compiler revisions, LLVM
cherry-picks, Rust stage0 validation and compiler plugins remain upstream.
"""
import argparse
import base64
import hashlib
import importlib
import json
import os
from pathlib import Path
import platform
import subprocess
import shutil
import sys
import tarfile
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', required=True, type=Path)
    parser.add_argument('--lock', required=True, type=Path)
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'aarch64':
        raise RuntimeError('CGW_CHROMIUM_NATIVE_ARCH_REQUIRED: Linux aarch64 required')
    src = args.src.resolve()
    lock = json.loads(args.lock.read_text())
    inputs = lock['native_arm64_toolchain_sources']
    sys.path.insert(0, str(src / 'tools/clang/scripts'))
    sys.path.insert(0, str(src / 'tools/rust'))
    update = importlib.import_module('update')
    clang = importlib.import_module('build')
    rust_update = importlib.import_module('update_rust')
    rust = importlib.import_module('build_rust')
    if update.PACKAGE_VERSION != inputs['llvm']['package_version']:
        raise RuntimeError('CGW_CHROMIUM_TOOLCHAIN_IDENTITY_MISMATCH: LLVM')
    if rust_update.RUST_REVISION != inputs['rust']['revision']:
        raise RuntimeError('CGW_CHROMIUM_TOOLCHAIN_IDENTITY_MISMATCH: Rust')
    if rust_update.STAGE0_JSON_SHA256 != inputs['rust']['stage0_json_sha256']:
        raise RuntimeError('CGW_CHROMIUM_TOOLCHAIN_IDENTITY_MISMATCH: Rust stage0')
    downloads = {v['url']: v['sha256'] for v in
                 [inputs['llvm']['libxml2'], inputs['llvm']['zstd']]}
    downloads.update(lock['native_bootstrap_sysroots'])
    stage0_url = ('https://chromium.googlesource.com/external/github.com/'
                  f"rust-lang/rust/+/{rust_update.RUST_REVISION}/src/stage0?format=TEXT")
    with urllib.request.urlopen(stage0_url) as response:
        stage0 = base64.b64decode(response.read())
    if hashlib.sha256(stage0).hexdigest() != rust_update.STAGE0_JSON_SHA256:
        raise RuntimeError('CGW_CHROMIUM_STAGE0_HASH_MISMATCH')
    fields = dict(line.split('=', 1) for line in stage0.decode().splitlines()
                  if '=' in line and not line.startswith('#'))
    for key, digest in fields.items():
        if key.startswith('dist/'):
            downloads[fields['dist_server'] + '/' + key] = digest
    cache = src.parent / 'verified-bootstrap-downloads'
    cache.mkdir()

    def verified_unpack(url, output_dir, path_prefixes=None, is_known_zip=False):
        if url not in downloads or is_known_zip:
            raise RuntimeError(f'CGW_CHROMIUM_UNPINNED_TOOLCHAIN_DOWNLOAD: {url}')
        archive = cache / downloads[url]
        if not archive.exists():
            with urllib.request.urlopen(url) as response, archive.open('wb') as output:
                shutil.copyfileobj(response, output)
        with archive.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != downloads[url]:
                raise RuntimeError(f'CGW_CHROMIUM_TOOLCHAIN_HASH_MISMATCH: {url}')
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as bundle:
            members = [m for m in bundle.getmembers() if path_prefixes is None
                       or any(m.name.startswith(p) for p in path_prefixes)]
            # These are hash-verified official sysroots; preserve their loader
            # symlinks exactly as Chromium's DownloadAndUnpack does.
            bundle.extractall(output_dir, members=members, filter='fully_trusted')

    # Every archive fetched by the official LLVM bootstrap is hash verified.
    clang.DownloadAndUnpack = verified_unpack
    update.DownloadAndUnpack = verified_unpack
    rust.DownloadAndUnpack = verified_unpack

    def locked_checkout(name, url, revision, destination):
        if name == 'LLVM monorepo':
            if revision != update.CLANG_REVISION:
                raise RuntimeError('CGW_CHROMIUM_TOOLCHAIN_IDENTITY_MISMATCH: LLVM checkout')
            revision = inputs['llvm']['revision']
        expected = {'Rust': inputs['rust']['revision'],
                    'bindgen': inputs['rust']['bindgen']['revision'],
                    'crubit': inputs['rust']['crubit']['revision'],
                    'LLVM monorepo': inputs['llvm']['revision']}[name]
        if revision != expected:
            raise RuntimeError(f'CGW_CHROMIUM_TOOLCHAIN_IDENTITY_MISMATCH: {name}')
        destination = Path(destination)
        if name == 'LLVM monorepo':
            subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', url, str(destination)], check=True)
            subprocess.run(['git', '-C', str(destination), 'checkout', '--detach', revision], check=True)
            for patch in inputs['llvm']['cherry_picks']:
                subprocess.run(['git', '-C', str(destination), 'fetch', 'origin', patch], check=True)
        else:
            destination.mkdir(parents=True)
            subprocess.run(['git', 'init', str(destination)], check=True)
            subprocess.run(['git', '-C', str(destination), 'remote', 'add', 'origin', url], check=True)
            subprocess.run(['git', '-C', str(destination), 'fetch', '--depth=1', '--no-tags',
                            'origin', revision], check=True)
            subprocess.run(['git', '-C', str(destination), 'checkout', '--detach', 'FETCH_HEAD'], check=True)
        os.chdir(destination)

    clang.CheckoutGitRepo = locked_checkout
    rust.CheckoutGitRepo = locked_checkout
    install = src / 'third_party/llvm-build/Release+Asserts'
    # Build LLVM's host libraries as PIC for rustc/bindgen; keep Chromium's
    # default plugins and all upstream Linux compiler runtimes. No remote RBE.
    sys.argv = ['build.py', '--use-system-cmake', '--host-cc=/usr/bin/clang-18',
                '--host-cxx=/usr/bin/clang++-18', '--pic', '--disable-asserts',
                '--without-android', '--without-fuchsia', '--with-ml-inliner-model=',
                '--build-dir', str(src / 'third_party/native-llvm-build'),
                '--install-dir', str(install)]
    if clang.main() != 0:
        raise RuntimeError('CGW_CHROMIUM_NATIVE_LLVM_BUILD_FAILED')
    # Official build writes its stamp under the temporary build dir when an
    # explicit --build-dir is used. Copy the actual compiler identity to install.
    (install / update.STAMP_FILENAME).write_text(update.PACKAGE_VERSION + '\n')
    # Installed LLVM includes libLLVM/libclang archives required by Rust.
    # Reclaim only this build's intermediate object files before Rust stage2.
    if not (install / 'bin/llvm-config').is_file():
        raise RuntimeError('CGW_CHROMIUM_NATIVE_LLVM_INSTALL_INCOMPLETE')
    shutil.rmtree(src / 'third_party/native-llvm-build')

    # Native snapshot libssl-dev/ncurses-dev are linked using the native host
    # root, not AMD64 OpenSSL/CMake/CIPD or a mismatched Bullseye host sysroot.
    # XPy substitutes DEBIAN_SYSROOT in the existing host-config template.
    rust.RustTargetTriple = lambda: 'aarch64-unknown-linux-gnu'
    rust.DownloadDebianSysroot = lambda *_args, **_kwargs: '/'
    rust.AddCMakeToPath = lambda: None
    rust.RUST_HOST_LLVM_INSTALL_DIR = str(install)
    rust.RUST_HOST_LLVM_BUILD_DIR = str(src / 'third_party/native-llvm-build')

    def native_openssl():
        os.environ['OPENSSL_DIR'] = '/usr'
        os.environ['OPENSSL_LIB_DIR'] = '/usr/lib/aarch64-linux-gnu'
        os.environ['OPENSSL_INCLUDE_DIR'] = '/usr/include'
        return '/usr'

    rust.AddOpenSSLToEnv = native_openssl
    template = src / 'tools/rust/config.toml.template'
    template_text = template.read_text()
    token = '[target.x86_64-unknown-linux-gnu]'
    if template_text.count(token) != 1:
        raise RuntimeError('CGW_CHROMIUM_NATIVE_PATCH_MISMATCH: Rust target template')
    template.write_text(template_text.replace(token, '[target.aarch64-unknown-linux-gnu]'))
    host_template = src / 'tools/rust/cargo-config.toml.template'
    host_text = host_template.read_text()
    token = '[host.x86_64-unknown-linux-gnu]'
    if host_text.count(token) != 1:
        raise RuntimeError('CGW_CHROMIUM_NATIVE_PATCH_MISMATCH: Rust host template')
    host_template.write_text(host_text.replace(token, '[host.aarch64-unknown-linux-gnu]'))
    # Rust's own x.py verifies all stage0 archives against the locked stage0.
    sys.argv = ['build_rust.py', '--skip-test', '--skip-llvm-build']
    if rust.main() != 0:
        raise RuntimeError('CGW_CHROMIUM_NATIVE_RUST_BUILD_FAILED')
    bindgen = importlib.import_module('build_bindgen')
    if not (src / 'third_party/rust-toolchain/bin/rustc').is_file():
        raise RuntimeError('CGW_CHROMIUM_NATIVE_RUST_INSTALL_INCOMPLETE')
    shutil.rmtree(rust.RUST_BUILD_DIR)
    bindgen.CheckoutGitRepo = locked_checkout
    bindgen.RUST_HOST_LLVM_INSTALL_DIR = str(install)
    bindgen.DownloadDebianSysroot = lambda *_args, **_kwargs: '/'
    bindgen.FetchNcurseswLibrary = lambda: None
    original_cargo = bindgen.RunCargo

    def locked_cargo(command):
        if command[0] in ('build', 'test') and '--locked' not in command:
            command = [*command, '--locked']
        return original_cargo(command)

    bindgen.RunCargo = locked_cargo
    sys.argv = ['build_bindgen.py', '--skip-test']
    if bindgen.main() != 0:
        raise RuntimeError('CGW_CHROMIUM_NATIVE_BINDGEN_BUILD_FAILED')
    crubit = importlib.import_module('build_crubit')
    crubit.CheckoutGitRepo = locked_checkout
    sys.argv = ['build_crubit.py', '--out-dir', str(src / 'third_party/native-crubit-build')]
    if crubit.main() != 0:
        raise RuntimeError('CGW_CHROMIUM_NATIVE_CRUBIT_BUILD_FAILED')
    # Rust checkout and vendor preparation completed above; use the official
    # gnrt generator with stage0 native beta without launching a stock x64
    # build_rust subprocess. RunGnrt propagates the Cargo exit status.
    rust.InstallRustBetaSysroot(rust_update.RUST_REVISION, [rust.RustTargetTriple()])
    gnrt = importlib.import_module('gnrt_stdlib')
    if gnrt.RunGnrt(rust.RUST_BETA_SYSROOT_DIR,
                    str(src / 'third_party/native-gnrt-build'),
                    ['gen', f'--for-std={os.path.relpath(rust.RUST_SRC_DIR, src)}']):
        raise RuntimeError('CGW_CHROMIUM_NATIVE_STDLIB_RULES_FAILED')
    for binary in [install / 'bin/clang', install / 'bin/ld.lld',
                   src / 'third_party/rust-toolchain/bin/rustc',
                   src / 'third_party/rust-toolchain/bin/bindgen',
                   src / 'third_party/rust-toolchain/bin/cc_bindings_from_rs']:
        header = binary.read_bytes()[:20]
        if header[:4] != b'\x7fELF' or int.from_bytes(header[18:20], 'little') != 183:
            raise RuntimeError(f'CGW_CHROMIUM_NATIVE_TOOLCHAIN_ARCH_MISMATCH: {binary}')
    # Preserve source/vendor inputs, but not object files or transient cargo caches.
    for owned in [src / 'third_party/native-crubit-build',
                  src / 'third_party/native-gnrt-build',
                  Path(bindgen.BINDGEN_HOST_BUILD_DIR),
                  Path(rust.RUST_BETA_SYSROOT_DIR)]:
        shutil.rmtree(owned)
    (src.parent / 'native-bootstrap-downloads.json').write_text(json.dumps(downloads, indent=2))


if __name__ == '__main__':
    main()
