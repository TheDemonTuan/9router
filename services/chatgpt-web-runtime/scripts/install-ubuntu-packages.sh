#!/bin/sh
# Build-time only. Release images are pinned by OCI digest after security gates.
# Use Ubuntu's authenticated official archives; record exact resolver provenance.
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
    amd64) machine=x86_64; archive=https://archive.ubuntu.com/ubuntu; security=https://security.ubuntu.com/ubuntu ;;
    arm64) machine=aarch64; archive=https://ports.ubuntu.com/ubuntu-ports; security=$archive ;;
    *) fail ARCHITECTURE 'Only native amd64 and arm64 are supported' ;;
esac
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = "$machine" ] \
    && [ "$(dpkg --print-architecture)" = "$arch" ] \
    || fail ARCHITECTURE 'A matching native Linux builder is required'
[ "$(id -u)" = 0 ] || fail BUILD_USER 'Package installation requires build-stage root'
for package in "$@"; do
    case "$package" in ''|-*|*[!a-z0-9+.-]*) fail PACKAGE 'Only APT package names are accepted' ;; esac
done

keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
[ -s "$keyring" ] || fail SIGNING_KEY 'The pinned Ubuntu base must include its archive keyring'
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
verify_hash() {
    [ -f "$1" ] || fail METADATA "Missing $1"
    actual=$(sha256sum "$1")
    [ "${actual%% *}" = "$2" ] || fail CHECKSUM "SHA256 mismatch: $1"
}

# BuildKit fetches the CA bootstrap over certificate-verified HTTPS with
# ADD --checksum; verify again before using its PEM roots. Extraction is NOT
# installation and never fabricates dpkg state.
if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
    [ -n "$bootstrap" ] || fail CA_BOOTSTRAP 'Supply the pinned ca-certificates .deb from the Dockerfile HTTPS ADD'
    verify_hash "$bootstrap" 6bac2a01979e210d9eac1d4d56747ec709ea60654744d66705dc3c36e7629e50
    dpkg-deb --extract "$bootstrap" "$temporary/ca"
    mkdir -p /etc/ssl/certs
    cat "$temporary"/ca/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt
    [ -s /etc/ssl/certs/ca-certificates.crt ] || fail CA_BOOTSTRAP 'Pinned package contains no Mozilla CA roots'
fi

# Delete inherited sources and lists before any APT access. Require current signed
# metadata, certificate-verified HTTPS and authenticated package hashes.
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources
rm -rf /var/lib/apt/lists/*
mkdir -p /etc/apt/sources.list.d
for suite in noble noble-updates; do
    printf 'deb [signed-by=%s] %s/ %s main universe\n' "$keyring" "$archive" "$suite"
done > /etc/apt/sources.list.d/cgw-ubuntu.list
printf 'deb [signed-by=%s] %s/ noble-security main universe\n' "$keyring" "$security" \
    >> /etc/apt/sources.list.d/cgw-ubuntu.list
cat > /etc/apt/apt.conf.d/99cgw-ubuntu <<'APT'
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
provenance=/usr/local/share/cgw-os-provenance
mkdir -p "$provenance"
cp /var/lib/apt/lists/*_InRelease "$provenance/"
sha256sum /var/lib/apt/lists/*_Packages > "$provenance/packages-index-sha256.txt"
cp /etc/apt/sources.list.d/cgw-ubuntu.list "$provenance/sources.list"

# Upgrade the full inherited closure. APT verifies every .deb against package
# indexes authenticated by Ubuntu's signed InRelease metadata.
apt-get dist-upgrade -y --no-install-recommends
apt-get install -y --no-install-recommends ca-certificates "$@"
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' \
    > /usr/local/share/cgw-os-provenance/installed-packages.tsv
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
