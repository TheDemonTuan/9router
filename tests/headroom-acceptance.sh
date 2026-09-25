#!/usr/bin/env bash
set -euo pipefail

# tests/headroom-acceptance.sh
# Acceptance test runner for Headroom 0.38.0 Gateway integration.
# Supports --fast and --strong modes with isolated HOME and DATA_DIR.
# Exit nonzero on any required failure; never fake passes or swallow errors.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODE="fast"
if [[ "${1:-}" == "--strong" || "${1:-}" == "strong" ]]; then
  MODE="strong"
fi

echo "=========================================================="
echo " Running Headroom Acceptance Runner: MODE=${MODE}"
echo " Worktree: ${WORKTREE_ROOT}"
echo "=========================================================="

# Disposable isolated environment
TMP_ISOLATION_DIR=$(mktemp -d -t 9router-headroom-acceptance-XXXXXX)
trap 'rm -rf "${TMP_ISOLATION_DIR}"' EXIT

if command -v cygpath >/dev/null 2>&1; then
  export HOME="$(cygpath -w "${TMP_ISOLATION_DIR}/home")"
  export USERPROFILE="${HOME}"
  export APPDATA="${HOME}"
  export DATA_DIR="$(cygpath -w "${TMP_ISOLATION_DIR}/data")"
else
  export HOME="${TMP_ISOLATION_DIR}/home"
  export USERPROFILE="${HOME}"
  export APPDATA="${HOME}"
  export DATA_DIR="${TMP_ISOLATION_DIR}/data"
fi
mkdir -p "${TMP_ISOLATION_DIR}/home" "${TMP_ISOLATION_DIR}/data"

cd "${WORKTREE_ROOT}"

echo "[Step 1/6] Running Headroom Focused Unit Suites..."
cd tests
  bun run test --config vitest.config.js \
    unit/headroom.test.js \
    unit/headroom-responses-format.test.js \
    unit/headroom-detect.test.js \
    unit/headroom-chat-core.test.js \
    unit/headroom-stage-invariants.test.js \
    unit/claude-header-forwarding.test.js \
    unit/headroom-resilience.test.js \
    unit/headroom-status-route.test.js \
    unit/session-manager.test.js \
    unit/chat-quota-handler.test.js \
    unit/quota-response-contract.test.js
cd "${WORKTREE_ROOT}"

if [[ "${MODE}" == "strong" ]]; then
  echo "[Step 2/6] Running Affected Translator & Lifecycle Regressions..."
  cd tests
  bun run test --config vitest.config.js \
    unit/dashboard-guard.test.js \
    unit/chat-pre-response-budget.test.js \
    unit/codex-native-passthrough-thinking.test.js \
    unit/pxpipe.test.js \
    translator/coverage-all-models.test.js \
    translator/format-roundtrip.test.js \
    translator/responses-gemini-direct.test.js
  cd "${WORKTREE_ROOT}"
  echo "[Step 3/6] Running isolated offline network smoke..."
  bun tests/integration/headroom-resilience-smoke.mjs --offline

  echo "[Step 4/6] Linting Changed Supported JavaScript Files..."
  CHANGED_JS=(
    open-sse/rtk/headroom.js
    open-sse/rtk/headroomGateway.js
    open-sse/rtk/headroomStage.js
    open-sse/rtk/headroomInvariants.js
    open-sse/rtk/headroomRelay.js
    open-sse/handlers/chatCore.js
    open-sse/handlers/chatCore/streamingHandler.js
    open-sse/handlers/chatCore/nonStreamingHandler.js
    open-sse/handlers/chatCore/sseToJsonHandler.js
    open-sse/executors/base.js
    src/dashboardGuard.js
    src/lib/headroom/detect.js
    src/lib/headroom/process.js
    open-sse/utils/anthropicBeta.js
    open-sse/utils/sessionManager.js
    open-sse/config/runtimeConfig.js
    src/app/api/settings/route.js
    src/lib/db/repos/settingsRepo.js
    src/lib/db/migrations/002-headroom-timeout-default.js
    src/app/'(dashboard)'/dashboard/token-saver/TokenSaverClient.js
    src/app/api/headroom/proxy/[...path]/route.js
    src/app/api/headroom/status/route.js
  )
  EXISTING_CHANGED_JS=()
  for f in "${CHANGED_JS[@]}"; do
    if [[ -f "${WORKTREE_ROOT}/${f}" ]]; then
      EXISTING_CHANGED_JS+=("${f}")
    fi
  done
  if [[ ${#EXISTING_CHANGED_JS[@]} -gt 0 ]]; then
    bunx --no-install eslint "${EXISTING_CHANGED_JS[@]}"
  fi

  echo "[Step 5/6] Checking Docker Compose Config..."
  if command -v docker >/dev/null 2>&1; then
    docker compose config -q
    docker compose -f docker-compose.prod.yml config -q
    echo "Docker compose validation passed via docker CLI."
  else
    echo "NOTICE: docker CLI is not installed on this host. Running graceful static verification of compose configuration..."
    bun -e '
      const fs = require("fs");
      const dev = fs.readFileSync("docker-compose.yml", "utf8");
      const prod = fs.readFileSync("docker-compose.prod.yml", "utf8");
      if (!dev.includes("ghcr.io/headroomlabs-ai/headroom:0.38.0")) throw new Error("docker-compose.yml missing 0.38.0 image");
      if (!prod.includes("ghcr.io/headroomlabs-ai/headroom:0.38.0@sha256:")) throw new Error("docker-compose.prod.yml missing pinned digest image");
      if (!prod.includes("memory: 1024M")) throw new Error("docker-compose.prod.yml missing 1024M memory limit");
      if (prod.includes("8787:8787")) throw new Error("docker-compose.prod.yml must not expose port 8787 to host");
      console.log("Static Docker Compose configuration checks passed successfully.");
    '
  fi

  echo "[Step 6/6] Checking Bun Build Production Output..."
  bun run build
fi

echo "=========================================================="
echo " Headroom Acceptance Runner Completed Successfully!"
echo "=========================================================="
