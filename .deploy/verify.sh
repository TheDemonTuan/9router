#!/usr/bin/env bash
set -euo pipefail

# Dependencies are installed by the caller at the root and in tests/.
mkdir -p "$HOME" "$DATA_DIR"
(
  cd tests
  mapfile -t response_tests < <(find unit translator -type f -name '*responses*.test.js' ! -path '*/real/*' | sort)
  mapfile -t chatgpt_web_tests < <(find unit integration -type f -name '*chatgpt*.test.js' ! -path '*/real/*' | sort)
  printf 'Responses regression gate:\n'; printf '%s\n' "${response_tests[@]}"
  printf 'ChatGPT Web regression gate:\n'; printf '%s\n' "${chatgpt_web_tests[@]}"
  bun x vitest run --config vitest.config.js \
    "${response_tests[@]}" \
    "${chatgpt_web_tests[@]}" \
    unit/codex-tool-normalization.test.js \
    unit/codex-native-passthrough-thinking.test.js \
    unit/claude-header-forwarding.test.js \
    unit/session-manager.test.js \
    unit/rtk-cursor-pretranslate.test.js \
    unit/rtk.test.js \
    unit/rtkKiro.test.js \
    unit/force-stream-config.test.js \
    unit/minimax-transport-target-format.test.js \
    unit/base-executor-timeout-classification.test.js \
    integration/zcode-concurrent-responses.test.js \
    unit/grok-build-config.test.js \
    unit/quota-classification.test.js \
    unit/quota-response-contract.test.js \
    unit/chat-quota-handler.test.js \
    unit/antigravity-quota-routing.test.js \
    unit/antigravity-retry-hook.test.js \
    unit/base-executor-retry.test.js \
    unit/chat-pre-response-budget.test.js \
    unit/fetch-timeout-body-signal.test.js \
    unit/route-adapter-lifecycle.test.js \
    unit/codex-fast-capacity.test.js \
    unit/codex-models.test.js \
    unit/antigravity-weekly-quota.test.js \
    unit/gemini-native-endpoint.test.js \
    unit/ollama-stream-tail.test.js \
    unit/google-usage-abort.test.js \
    unit/claude-usage-cache.test.js \
    unit/usage-cache-contract.test.js \
    unit/health-route.test.js \
    unit/dashboard-guard.test.js \
    unit/monitor-ready-route.test.js \
    unit/alibaba-token-plan-thinking.test.js \
    unit/alibaba-token-plan-catalog.test.js \
    unit/alibaba-token-plan-capabilities.test.js \
    unit/alibaba-token-plan-models-route.test.js \
    unit/alibaba-token-plan-provider.test.js \
    unit/codex-v1-models.test.js \
    translator/alibaba-token-plan-pipeline.test.js
)
node --version
bun --version
node --test --test-concurrency=1 tests/unit/custom-server-h2c.test.cjs tests/unit/custom-server-h2c-concurrent.test.cjs
bun test tests/unit/custom-server-h2c.test.cjs tests/unit/custom-server-h2c-concurrent.test.cjs tests/unit/bun-client-disconnect.test.cjs tests/unit/bun-next-request-disconnect.test.cjs
bun tests/integration/quota-persistence-smoke.mjs
bun tests/integration/pre-response-lifecycle-smoke.mjs
bun tests/integration/bypass-transport-smoke.mjs
bun tests/integration/retired-settings-smoke.mjs
(
  cd tests
  node __baseline__/verify-providers.mjs
  node __baseline__/verify-alias.mjs
  node __baseline__/verify-oauth-urls.mjs
  set +e
  bun x vitest run --config vitest.config.js translator/alibaba-token-plan-pipeline.test.js --reporter=json --outputFile=translator-results.json
  vitest_status=$?
  set -e
  node __baseline__/verify-no-regression.mjs translator-results.json
  if [ "$vitest_status" -ne 0 ]; then
    echo 'Known baseline failures verified; no new translator regression.'
  fi
)
