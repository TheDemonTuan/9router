#!/usr/bin/env python3
"""Build pinned stable Chromium using upstream GN/autoninja/Linux packaging.

Requires a disposable native Linux builder. Produces browser assets separately
from the corresponding-source archive, never a downloaded branded browser.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / 'chromium-source-lock.json'


def run(command, cwd=None, env=None, stdout=None):
    print('+', ' '.join(map(str, command)), flush=True)
    subprocess.run(command, cwd=cwd, env=env, stdout=stdout, check=True)


def capture(command, cwd=None, env=None):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True).strip()


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_sha256(path, expected):
    if sha256(path) != expected:
        raise RuntimeError(f'CGW_CHROMIUM_INPUT_HASH_MISMATCH: {path}')


def download(url, path, digest):
    with urllib.request.urlopen(url) as response, path.open('wb') as output:
        shutil.copyfileobj(response, output)
    verify_sha256(path, digest)


def prerequisites(arch, workdir):
    native = {'amd64': 'x86_64', 'arm64': 'aarch64'}[arch]
    if platform.system() != 'Linux' or platform.machine() != native:
        raise RuntimeError(f'CGW_CHROMIUM_NATIVE_ARCH_REQUIRED: Linux {native}')
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    available = int(memory['MemAvailable'].split()[0]) * 1024
    limit = Path('/sys/fs/cgroup/memory.max')
    used = Path('/sys/fs/cgroup/memory.current')
    if limit.exists() and limit.read_text().strip() != 'max':
        available = min(available, int(limit.read_text()) - int(used.read_text()))
    free = shutil.disk_usage(workdir).free
    resources = {'availableMemoryBytes': available, 'freeDiskBytes': free,
                 'cpuCount': os.cpu_count(), 'nativeArchitecture': native}
    print(json.dumps(resources), flush=True)
    # Upstream states GB, not GiB. No fabricated architecture-specific minimum.
    if available < 8_000_000_000 or free < 100_000_000_000:
        raise RuntimeError('CGW_CHROMIUM_RESOURCE_INSUFFICIENT: >=8GB available RAM and >=100GB free disk required')
    return resources


def checkout(url, commit, dest):
    dest.mkdir()
    run(['git', 'init', str(dest)])
    run(['git', '-C', str(dest), 'remote', 'add', 'origin', url])
    run(['git', '-C', str(dest), 'fetch', '--depth=1', '--no-tags', 'origin', commit])
    run(['git', '-C', str(dest), 'checkout', '--detach', 'FETCH_HEAD'])
    if capture(['git', '-C', str(dest), 'rev-parse', 'HEAD']) != commit:
        raise RuntimeError(f'CGW_CHROMIUM_SOURCE_REVISION_MISMATCH: {dest}')


def checked_replace(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'CGW_CHROMIUM_NATIVE_PATCH_MISMATCH: {path}')
    path.write_text(text.replace(old, new))


def build(args, lock, resources):
    depot = args.workdir / 'depot_tools'
    src = args.workdir / 'src'
    checkout(lock['depot_tools']['git_url'], lock['depot_tools']['git_commit'], depot)
    cipd = depot / '.cipd_client'
    download('https://chrome-infra-packages.appspot.com/client?platform=linux-'
             + args.arch + '&version=' + lock['depot_tools']['cipd_client_version'],
             cipd, lock['depot_tools']['cipd_digests']['linux-' + args.arch])
    cipd.chmod(0o755)
    python_bin = depot / 'python-bin'
    python_bin.mkdir(exist_ok=True)
    if not (python_bin / 'python3').exists():
        (python_bin / 'python3').symlink_to(sys.executable)
    env = dict(os.environ, PATH=str(depot) + os.pathsep + os.environ['PATH'],
               DEPOT_TOOLS_UPDATE='0', DEPOT_TOOLS_METRICS='0',
               CUSTOM_CIPD_CLIENT=str(cipd), DEPOT_TOOLS_COLLECT_METRICS='0')
    # The real depot_tools wrapper bootstraps its pinned vpython dependencies.
    # Never bypass the upstream vpython environment or unpin Python packages.
    checkout(lock['chromium']['git_url'], lock['chromium']['git_commit'], src)
    for path, digest in lock['source_file_sha256'].items():
        verify_sha256(src / path, digest)
    custom = {}
    if args.arch == 'arm64':
        # Linux stock binaries in these DEPS entries are AMD64 only. Replace
        # them with source-built native tools, not QEMU or mutable system Rust.
        custom = {p: None for p in ['src/third_party/llvm-build/Release+Asserts',
                  'src/third_party/rust-toolchain', 'src/third_party/llvm-libclang',
                  'src/third_party/node/linux', 'src/third_party/gperf/cipd']}
    solution = {'name': 'src', 'url': lock['chromium']['git_url'],
                'deps_file': 'DEPS', 'managed': False, 'custom_deps': custom,
                'custom_vars': {'checkout_configuration': 'small',
                'checkout_telemetry_dependencies': False, 'checkout_android': False,
                'checkout_fuchsia': False, 'checkout_src_internal': False,
                'checkout_src_internal_infra': False, 'download_reclient': False,
                'download_remoteexec_cfg': False}}
    cpu = 'x64' if args.arch == 'amd64' else 'arm64'
    config = 'solutions = ' + repr([solution]) + '\ntarget_os = ["linux"]\ntarget_os_only = True\ntarget_cpu = ' + repr([cpu]) + '\ntarget_cpu_only = True\n'
    (args.workdir / '.gclient').write_text(config)
    gperf_old = ("  'src/third_party/gperf/cipd': {\n"
                 "      'packages': [\n"
                 "        {\n"
                 "          'package': 'infra/3pp/tools/gperf/${{platform}}',\n"
                 "          'version': 'version:3@3.2',\n"
                 "        },\n"
                 "      ],\n"
                 "      'condition': 'host_os == \"linux\" and non_git_source',\n"
                 "      'dep_type': 'cipd',\n"
                 "  },")
    gperf_new = ("  'src/third_party/gperf/cipd': {\n"
                 "      'packages': [\n"
                 "        {\n"
                 "          'package': 'infra/3pp/tools/gperf/${{platform}}',\n"
                 "          'version': 'version:3@3.2',\n"
                 "        },\n"
                 "      ],\n"
                 "      'condition': 'False',\n"
                 "      'dep_type': 'cipd',\n"
                 "  },")
    if args.arch == 'arm64':
        checked_replace(src / 'DEPS', gperf_old, gperf_new)
    run([str(depot / 'gclient'), 'sync', '--nohooks', '--no-history',
         '--revision', 'src@' + lock['chromium']['git_commit']], cwd=args.workdir, env=env)
    if args.arch == 'arm64':
        checked_replace(src / 'DEPS', gperf_new, gperf_old)
    verify_sha256(src / 'DEPS', lock['source_file_sha256']['DEPS'])
    run([str(depot / 'gclient'), 'revinfo', '--actual', '--output-json',
         str(args.workdir / 'dependency-revisions.json')], cwd=args.workdir, env=env)
    if args.arch == 'arm64':
        gperf_bin = src / 'third_party/gperf/cipd/bin'
        gperf_bin.mkdir(parents=True, exist_ok=True)
        if not (gperf_bin / 'gperf').exists():
            (gperf_bin / 'gperf').symlink_to('/usr/bin/gperf')
    # Exact DEPS hash plus gclient's GCS hashes/CIPD instance IDs verify the
    # full dependency graph. Stock compiler identities are additionally checked.
    run([sys.executable, str(src / 'build/install-build-deps.py'), '--no-prompt',
         '--no-chromeos-fonts', '--no-arm', '--no-syms'], cwd=src, env=env)
    run([str(depot / 'gclient'), 'runhooks'], cwd=args.workdir, env=env)
    if args.arch == 'arm64':
        node = lock['native_arm64_toolchain_sources']['node']['arm64_archive']
        node_archive = args.workdir / 'node-arm64.tar.xz'
        download(node['url'], node_archive, node['sha256'])
        node_dir = src / 'third_party/node/linux/node-linux-arm64'
        node_dir.mkdir(parents=True)
        run(['tar', '-xJf', str(node_archive), '--strip-components=1', '-C', str(node_dir)])
        checked_replace(src / 'third_party/node/node.py',
                        "'Linux': ('linux', 'node-linux-x64', 'bin', 'node'),",
                        "'Linux': ('linux', 'node-linux-arm64', 'bin', 'node'),")
        run([sys.executable, str(ROOT / 'scripts/bootstrap-chromium-arm64.py'),
             '--src', str(src), '--lock', str(LOCK_PATH)], cwd=src, env=env)
    else:
        compiler_stamp = (src / 'third_party/llvm-build/Release+Asserts/cr_build_revision').read_text().strip()
        if compiler_stamp != lock['stock_toolchain_x64']['clang']['package_version']:
            raise RuntimeError('CGW_CHROMIUM_TOOLCHAIN_IDENTITY_MISMATCH: stock Clang')
    run([sys.executable, str(src / 'tools/rust/update_rust.py'),
         '--print-revision=validate'], cwd=src, env=env)
    for tool in ['third_party/llvm-build/Release+Asserts/bin/clang',
                 'third_party/rust-toolchain/bin/rustc', 'buildtools/linux64/gn',
                 'third_party/ninja/ninja']:
        binary = src / tool
        with binary.open('rb') as stream:
            header = stream.read(20)
        expected = 62 if args.arch == 'amd64' else 183
        if header[:4] != b'\x7fELF' or int.from_bytes(header[18:20], 'little') != expected:
            raise RuntimeError(f'CGW_CHROMIUM_NATIVE_TOOLCHAIN_ARCH_MISMATCH: {tool}')
    out = src / 'out/Release'
    out.mkdir(parents=True)
    flags = dict(lock['build_flags'], target_cpu=cpu)
    (out / 'args.gn').write_text('\n'.join(k + ' = ' + json.dumps(v) for k, v in flags.items()) + '\n')
    gn_bin = src / 'buildtools/linux64/gn'
    run([str(gn_bin), 'gen', str(out), '--fail-on-unused-args'], cwd=src, env=env)
    jobs = max(1, min(os.cpu_count() or 1, resources['availableMemoryBytes'] // 2_000_000_000))
    ninja_bin = src / 'third_party/ninja/ninja'
    run([str(ninja_bin), '-C', str(out), '-j', str(jobs),
         'chrome/installer/linux:stable_deb'], cwd=src, env=env)
    package = out / f"chromium-browser-stable_{lock['chromium']['version']}-1_{args.arch}.deb"
    extract = args.workdir / 'package-extract'
    run(['dpkg-deb', '-x', str(package), str(extract)])
    args.dest.mkdir(parents=True)
    shutil.copytree(extract / 'opt/chromium.org/chromium', args.dest, dirs_exist_ok=True, symlinks=True)
    # Preserve the official sandbox binary; runtime uses user namespaces and
    # no-new-privileges, so no setuid bit is consumed or silently relied on.
    (args.dest / 'chrome-sandbox').chmod(0o755)
    generate_evidence(args, lock, resources, src, depot, out, package, env)


def generate_evidence(args, lock, resources, src, depot, out, package, env):
    license_tool = src / 'tools/licenses/licenses.py'
    common = ['--gn-out-dir=' + str(out), '--gn-target=//chrome/installer/linux:stable_deb', '--target-os=linux']
    run([sys.executable, str(license_tool), 'scan', *common], cwd=src, env=env)
    run([sys.executable, str(license_tool), 'credits', *common,
         str(args.dest / 'LICENSES.html')], cwd=src, env=env)
    run([sys.executable, str(license_tool), 'license_file', *common, '--format=txt',
         str(args.dest / 'LICENSES.txt')], cwd=src, env=env)
    run([sys.executable, str(license_tool), 'license_file', *common, '--format=spdx',
         '--spdx-doc-name=Chromium ' + lock['chromium']['version'],
         '--spdx-doc-namespace=https://chromium.googlesource.com/chromium/src/+/' + lock['chromium']['git_commit'] + '/' + args.arch,
         '--spdx-link=https://chromium.googlesource.com/chromium/src/+/' + lock['chromium']['git_commit'] + '/',
         str(args.dest / 'sbom.spdx.json')], cwd=src, env=env)
    metadata = capture([sys.executable, str(license_tool), 'list', *common,
                        '--shipped-only', '--verbose'], cwd=src, env=env)
    evidence = args.dest / 'license-evidence'
    evidence.mkdir()
    for line in metadata.splitlines():
        if not line.startswith('{'):
            continue
        entry = ast.literal_eval(line)
        directory = src / entry['dir']
        paths = list(entry['License File'])
        paths += [str(p.relative_to(src)) for p in directory.glob('README.*')]
        for relative in paths:
            path = src / relative
            if not path.resolve().is_relative_to(src):
                raise RuntimeError('CGW_CHROMIUM_LICENSE_PATH_ESCAPE')
            target = evidence / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    (args.dest / 'license-metadata.txt').write_text(metadata + '\n')
    binaries = {}
    linked = {}
    expected_machine = 62 if args.arch == 'amd64' else 183
    for binary in sorted(args.dest.rglob('*')):
        if not binary.is_file() or binary.is_symlink():
            continue
        with binary.open('rb') as stream:
            header = stream.read(20)
        if header[:4] != b'\x7fELF':
            continue
        if header[4:6] != b'\x02\x01' or int.from_bytes(header[18:20], 'little') != expected_machine:
            raise RuntimeError(f'CGW_CHROMIUM_NATIVE_ELF_MISMATCH: {binary}')
        name = str(binary.relative_to(args.dest))
        binaries[name] = {'sha256': sha256(binary), 'size': binary.stat().st_size,
                          'elfMachine': expected_machine, 'mode': oct(binary.stat().st_mode & 0o7777)}
        dynamic = capture(['readelf', '-d', str(binary)])
        if '(NEEDED)' in dynamic:
            dependencies = capture(['ldd', str(binary)])
            if 'not found' in dependencies:
                raise RuntimeError(f'CGW_CHROMIUM_UNRESOLVED_RUNTIME_LIBRARY: {binary}\n{dependencies}')
            linked[name] = {'readelfDynamic': dynamic, 'ldd': dependencies}
    version = capture([str(args.dest / 'chrome'), '--version'])
    if version != 'Chromium ' + lock['chromium']['version']:
        raise RuntimeError('CGW_CHROMIUM_BINARY_VERSION_MISMATCH: ' + version)
    if any('widevine' in str(p.relative_to(args.dest)).lower() for p in args.dest.rglob('*')):
        raise RuntimeError('CGW_CHROMIUM_PROPRIETARY_PAYLOAD_REJECTED')
    shutil.copyfile(args.workdir / 'dependency-revisions.json', args.dest / 'dependency-revisions.json')
    shutil.copyfile(LOCK_PATH, args.dest / 'source-build-lock.json')
    shutil.copyfile(out / 'args.gn', args.dest / 'args.gn')
    native_evidence = args.workdir / 'native-bootstrap-downloads.json'
    if native_evidence.exists():
        shutil.copyfile(native_evidence, args.dest / native_evidence.name)
    # Record the actual native host-selection changes alongside pinned source.
    (args.dest / 'native-source-changes.patch').write_text(
        capture(['git', '-C', str(src), 'diff', '--', 'tools/rust/config.toml.template',
                 'tools/rust/cargo-config.toml.template', 'third_party/node/node.py']))
    os_provenance = Path('/usr/local/share/cgw-os-provenance')
    shutil.copytree(os_provenance, args.dest / 'builder-os-provenance')
    toolchains = {}
    for tool in ['third_party/llvm-build/Release+Asserts/bin/clang',
                 'third_party/llvm-build/Release+Asserts/bin/ld.lld',
                 'third_party/rust-toolchain/bin/rustc', 'third_party/rust-toolchain/bin/bindgen']:
        toolchains[tool] = {'sha256': sha256(src / tool),
                           'version': capture([str(src / tool), '--version'])}
    # Corresponding sources are a separate OCI path, never runtime /opt assets.
    # Copy only source files (including generated source/vendor code) without
    # VCS history, downloaded tool binaries or owned intermediate build output.
    args.sources.mkdir(parents=True)
    archive = args.sources / 'source.tar.zst'
    excludes = ['src/out', 'src/third_party/llvm-build', 'src/third_party/native-llvm-build',
                'src/third_party/native-crubit-build', 'src/third_party/native-gnrt-build',
                'src/third_party/rust-src/build', 'src/third_party/rust-toolchain',
                'src/third_party/rust-toolchain-intermediate/llvm-host-build',
                'src/third_party/rust-toolchain-intermediate/llvm-host-install',
                'src/third_party/rust-toolchain-intermediate/bindgen-host-build',
                'src/third_party/rust-toolchain-intermediate/beta-sysroot',
                'src/third_party/node/linux', 'src/third_party/node/mac',
                'src/third_party/node/mac_arm64', 'src/third_party/node/win',
                'src/third_party/screen-ai/linux',
                'src/third_party/llvm-build-tools/pinned-clang',
                'src/third_party/llvm-build-tools/*/cmake_build',
                'src/third_party/llvm-build-tools/debian_*_sysroot',
                'src/third_party/rust-src/cargo-home',
                'src/third_party/ninja', 'src/third_party/siso/cipd',
                'src/buildtools/linux64', 'src/buildtools/linux64-format',
                'src/buildtools/third_party/mold/cipd']
    tar = ['tar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
           '--exclude=.git', '--exclude=.cipd', '--exclude=__pycache__',
           *['--exclude=' + p for p in excludes], '-I', 'zstd -T1 -3', '-cf', str(archive),
           '-C', str(args.workdir), 'src', '.gclient', 'dependency-revisions.json',
           '-C', str(ROOT), 'chromium-source-lock.json', 'scripts/build-chromium-source.py',
           'scripts/bootstrap-chromium-arm64.py']
    run(tar)
    provenance = {'schemaVersion': 1, 'version': lock['chromium']['version'],
                  'architecture': args.arch, 'src_git_commit': lock['chromium']['git_commit'],
                  'depot_tools_commit': lock['depot_tools']['git_commit'],
                  'unbranded': True, 'widevine_cdm': False, 'proprietary_codecs': False,
                  'chrome_binary': {'path': '/opt/chromium/chrome', **binaries['chrome']},
                  'binaries': binaries, 'linkedLibraries': linked, 'toolchains': toolchains,
                  'resourcePreflight': resources, 'build_flags': lock['build_flags'],
                  'packageSha256': sha256(package),
                  'correspondingSource': {'path': '/usr/local/share/chromium-source/source.tar.zst',
                                          'sha256': sha256(archive), 'size': archive.stat().st_size}}
    (args.dest / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--arch', required=True, choices=['amd64', 'arm64'])
    parser.add_argument('--workdir', type=Path, default=Path('/build/chromium-build'))
    parser.add_argument('--dest', type=Path, default=Path('/opt/chromium'))
    parser.add_argument('--sources', type=Path, default=Path('/usr/local/share/chromium-source'))
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    resources = prerequisites(args.arch, args.workdir)
    if args.preflight_only:
        return
    if any(args.workdir.iterdir()) or args.dest.exists() or args.sources.exists():
        raise RuntimeError('CGW_CHROMIUM_DISPOSABLE_DIRECTORY_REQUIRED: choose fresh output paths')
    lock = json.loads(LOCK_PATH.read_text())
    build(args, lock, resources)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('CGW_CHROMIUM_SOURCE_BUILD_FAILED:', error, file=sys.stderr)
        sys.exit(1)
