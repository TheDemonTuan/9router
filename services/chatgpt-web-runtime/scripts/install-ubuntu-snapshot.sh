#!/bin/sh
# Build-time only. Keep these hashes synchronized with image-build-manifest.json.
# Source: Ubuntu's signed 20261003T000000Z snapshot (noble/main + universe).
set -eu

fail() { printf '%s\n' "CGW_OS_$1: $2" >&2; exit 1; }
bootstrap=''
if [ "${1:-}" = '--ca-bootstrap' ]; then
    bootstrap=${2:?Missing bootstrap package path}
    shift 2
fi
[ "${1:-}" = '--arch' ] || fail ARGUMENT 'Expected --arch amd64|arm64 [package names...]'
arch=${2:?Missing native architecture}
shift 2
case "$arch" in
    amd64) machine=x86_64 ;;
    arm64) machine=aarch64 ;;
    *) fail ARCHITECTURE 'Only native amd64 and arm64 are supported' ;;
esac
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = "$machine" ] \
    && [ "$(dpkg --print-architecture)" = "$arch" ] \
    || fail ARCHITECTURE 'A matching native Linux builder is required'
[ "$(id -u)" = 0 ] || fail BUILD_USER 'Snapshot installation requires build-stage root'
for package in "$@"; do
    case "$package" in ''|-*|*[!a-z0-9+.-]*) fail PACKAGE 'Only APT package names are accepted' ;; esac
done

snapshot=20261003T000000Z
archive="https://snapshot.ubuntu.com/ubuntu/$snapshot"
keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
[ -s "$keyring" ] || fail SIGNING_KEY 'The pinned Ubuntu base must include its archive keyring'
helper=/usr/lib/apt/apt-helper
[ -x "$helper" ] || fail APT_HELPER 'The pinned Ubuntu base must include apt-helper'
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
verify_hash() {
    [ -f "$1" ] || fail METADATA "Missing $1"
    actual=$(sha256sum "$1")
    [ "${actual%% *}" = "$2" ] || fail CHECKSUM "SHA256 mismatch: $1"
}

# Ubuntu's snapshot service redirects HTTP to HTTPS. BuildKit fetches this .deb
# over certificate-verified HTTPS with ADD --checksum; verify again before using
# its PEM roots. Extraction is NOT installation and never fabricates dpkg state.
if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
    [ -n "$bootstrap" ] || fail CA_BOOTSTRAP 'Supply the pinned ca-certificates .deb from the Dockerfile HTTPS ADD'
    verify_hash "$bootstrap" 6bac2a01979e210d9eac1d4d56747ec709ea60654744d66705dc3c36e7629e50
    dpkg-deb --extract "$bootstrap" "$temporary/ca"
    mkdir -p /etc/ssl/certs
    cat "$temporary"/ca/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt
    [ -s /etc/ssl/certs/ca-certificates.crt ] || fail CA_BOOTSTRAP 'Pinned package contains no Mozilla CA roots'
fi

# Delete inherited live sources and lists before any APT access. Expired Release
# dates are permitted only for this immutable, signed, hash-pinned snapshot.
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources
rm -rf /var/lib/apt/lists/*
mkdir -p /etc/apt/sources.list.d
for suite in noble noble-updates noble-security; do
    printf 'deb [signed-by=%s check-valid-until=no] %s/ %s main universe\n' "$keyring" "$archive" "$suite"
done > /etc/apt/sources.list.d/cgw-snapshot.list
cat > /etc/apt/apt.conf.d/99cgw-snapshot <<'APT'
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
APT::Get::AllowUnauthenticated "false";
Acquire::https::Verify-Peer "true";
Acquire::https::Verify-Host "true";
Acquire::Languages "none";
Acquire::GzipIndexes "false";
Acquire::IndexTargets::deb::DEP-11::DefaultEnabled "false";
APT
# Override minimal-base documentation filters for redistributable license evidence.
mkdir -p /etc/dpkg/dpkg.cfg.d
printf '%s\n' 'path-include=/usr/share/doc/*/copyright' \
    > /etc/dpkg/dpkg.cfg.d/zz-cgw-copyright
export DEBIAN_FRONTEND=noninteractive
apt-get update -o APT::Update::Error-Mode=any -o Acquire::GzipIndexes=false
prefix="/var/lib/apt/lists/snapshot.ubuntu.com_ubuntu_${snapshot}_dists"
while read -r suite digest; do
    verify_hash "${prefix}_${suite}_InRelease" "$digest"
done <<'RELEASES'
noble cdb2f31d809f589719a53c6ad15f255b27569c4059542ada282aaa21b8e164b0
noble-updates 73e9ce9b343db391c104da5f3574adaccd0cd672c450801afa5e6a53de0f2b2c
noble-security 3b358f744efb789bab437ac77209ac20be2c8665197ce274f65c5f812bd4d519
RELEASES
case "$arch" in
    amd64) cat > "$temporary/indexes" <<'INDEXES'
noble main 2a6a199e1031a5c279cb346646d594993f35b1c03dd4a82aaa0323980dd92451 8f6f71ae839c8cba390a7643fcbbdacddb0bc7d12c1583a2dd80a1f8443a30e5
noble universe ba9057fa1b91438cc8a1d26808d00c85389fe101d0c1496254df97236405599a 687ffc969e7700137677b9cfe2f614ee2d638052a91a7c9bf31f3f6a3040a99a
noble-updates main 610b5ea3c37df19cbd666da4db2ae7a5a4adb5f3e0dc87ae975e55579818fa94 0929964db78a694c2c35f2ad20337c782794ac121f818facede7243605d24295
noble-updates universe 34ab72f37091ed1bcd7f53afaf12b0a2f058cc571548f0e80458826b40792be5 d3ead0aa8653199a7aef25b69d366e41cbe305ef9ac1e4649a560b669b5534e8
noble-security main 3046c3f258f076eb9024497156ad77e685680726db8985c28616eb04834d88ae 96ebaa6dcfaa00ad04c5a56f26f7bdc104a6da15d0fdd22ae29c91c299c3f276
noble-security universe 6f7d2304a200c42a390f1e9edb3a4c1ceec05e373f9e603b91d2181c829c02b2 54fd4642a6f7a861cd5fa2297ff4614d9d81cba6eb389129ecb90b4b797ca435
INDEXES
        ;;
    arm64) cat > "$temporary/indexes" <<'INDEXES'
noble main 4a1901e6124fb0a111f5dffc8f5c14474f449e2ecfa71f2eaf0b29917edb53f9 423c9185185cfc15df7bb3e748afc94b79ed09e0c437a0589aace46b61090d29
noble universe 6df230cf5cfebcbd59e4e2713b8eed07dc0aaed66fb471ebf046cb70ccb07275 adb1c01115c3b11d2a5cde43b17ce3c53fa7cc48f834b930f63910d2c7dc74f5
noble-updates main c1a84bc868a824aa7f2a6e08ab9f8d3eddad6af99da95553d3e0396a5af9d885 e144106ad9fa26afbf1603ba0014081c7d94c90ec08427f14d4af9c0f45c4a14
noble-updates universe 49b011473b5a0c85019c9cadc6d44fdcf3baa159c23e10d5c89c17eadd54eb44 a2be149572b6ff8a4acffd56584ad269222db78ccd6c9c8215ec235d39bc5347
noble-security main 9e07335ecc5232829a007f34a0f3e9cb9cfbb72a816190628a03f5adc9eec72b ca610a50eefa6037f6975fa7cca0a815f69f9491a6f63d6c5dea65d1f040c2c7
noble-security universe b3e5292bb709f043836b0b987b9d44141374f7e721b3ea1cafd237daa766933f 4cc7d9c1fe76b5c24be6e45b584e0983b19a04f13dec0a9e601e2e2506ea9b2a
INDEXES
        ;;
esac
while read -r suite component compressed uncompressed; do
    # Check both APT's actual resolver input and the immutable compressed index.
    verify_hash "${prefix}_${suite}_${component}_binary-${arch}_Packages" "$uncompressed"
    "$helper" download-file "$archive/dists/$suite/$component/binary-$arch/Packages.xz" \
        "$temporary/Packages.xz" "SHA256:$compressed"
    verify_hash "$temporary/Packages.xz" "$compressed"
    "$helper" cat-file "$temporary/Packages.xz" > "$temporary/Packages"
    verify_hash "$temporary/Packages" "$uncompressed"
    rm -f "$temporary/Packages.xz" "$temporary/Packages"
done < "$temporary/indexes"

# All inherited packages are upgraded, not just the requested runtime closure.
# APT authenticates every .deb against the verified Packages hashes.
apt-get dist-upgrade -y --no-install-recommends
apt-get install -y --no-install-recommends ca-certificates "$@"
mkdir -p /usr/local/share/cgw-os-provenance
cp "${prefix}_noble_InRelease" "${prefix}_noble-updates_InRelease" \
    "${prefix}_noble-security_InRelease" /usr/local/share/cgw-os-provenance/
cp "$temporary/indexes" /usr/local/share/cgw-os-provenance/packages-index-sha256.txt
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' \
    > /usr/local/share/cgw-os-provenance/installed-packages.tsv
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
