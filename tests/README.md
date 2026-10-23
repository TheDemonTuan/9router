# 9Router Embeddings Tests

Unit tests for the `/v1/embeddings` endpoint implementation.

## Setup

Install test dependencies from the `tests/` directory:

```bash
cd tests/ && bun install --frozen-lockfile
```

## Running Tests

From the `tests/` directory:

```bash
bun run test --config vitest.config.js unit/embeddingsCore.test.js
```

Vitest runs on the pinned Bun 1.4.4 runtime. Keep the explicit config for app/engine aliases; use the focused suite needed for your change:

```bash
bun run test --config vitest.config.js unit/responses-native-forwarding.test.js
```

`bun test` is reserved for suites already written for Bun or Node-compatible runners (for example the runtime service and selected `.cjs` regressions). It is not a drop-in runner for the Vitest tree: hoisted module mocks, module resets, and async fake-timer controls need deliberate migration. Do not enable `RUN_REAL=1` for an offline check; isolate `HOME` and `DATA_DIR` when exercising persistence.

## Test Files

| File | What it tests |
|------|--------------|
| `unit/embeddingsCore.test.js` | `open-sse/handlers/embeddingsCore.js` — core logic: body builder, URL router, headers, handler flow |
| `unit/embeddings.cloud.test.js` | `cloud/src/handlers/embeddings.js` — cloud worker handler: auth, validation, rate limits, CORS |

## Coverage Summary (59 tests)

### `embeddingsCore.test.js` (36 tests)
- `buildEmbeddingsBody`: single string, array, encoding_format, default float
- `buildEmbeddingsUrl`: openai, openrouter, openai-compatible-*, unsupported providers
- `buildEmbeddingsHeaders`: per-provider header sets, fallback to accessToken
- `handleEmbeddingsCore` input validation: missing, wrong type, null, empty
- `handleEmbeddingsCore` success: response format, CORS, Content-Type, callbacks
- `handleEmbeddingsCore` errors: 400/429/500, network error, invalid JSON
- `handleEmbeddingsCore` token refresh: 401 retry, graceful fallback

### `embeddings.cloud.test.js` (23 tests)
- CORS OPTIONS: 200 response, empty body, correct headers
- Authentication: missing key, bad format, old-format key, wrong key value, valid key
- Body validation: invalid JSON, missing model, missing input, bad model
- Happy path: single string, array, correct delegation, CORS header, machineId override
- Rate limiting: all accounts rate-limited → 503 + Retry-After, no credentials → 400
- Error propagation: non-fallback errors passed through, 429 exhausts accounts
- machineId override: validates key, rejects wrong key
