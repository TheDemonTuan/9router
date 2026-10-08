#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test "$(bun --version)" = 1.4.0

# A sibling-free copy must resolve only runtime dependencies, even when the
# caller has already installed fflate and other gateway packages at the root.
cold_root="$(mktemp -d /tmp/cgw-runtime-closure.XXXXXX)"
trap 'rm -rf -- "$cold_root"' EXIT
mkdir -p "$cold_root/runtime" "$cold_root/home/data"
tar -C "$repo_root/services/chatgpt-web-runtime" -cf - \
  package.json bun.lock tsconfig.json protocol.js session-transfer.js browser-request.js agent-request.js \
  image-build-manifest.json src scripts tests | tar -C "$cold_root/runtime" -xf -

export HOME="$cold_root/home" USERPROFILE="$cold_root/home" APPDATA="$cold_root/home"
export DATA_DIR="$cold_root/home/data" CGW_DATA_DIR="$cold_root/home/data"
export ENABLE_REQUEST_LOGS=false NEXT_TELEMETRY_DISABLED=1
cd "$cold_root/runtime"
bun install --frozen-lockfile
bun run typecheck
bun run test
bun build src/server.ts src/companion/main.ts --target bun --external playwright-core --outdir "$cold_root/entrypoints"
