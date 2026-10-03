export function webModel(overrides = {}) {
  return {
    id: "chatgpt-web/gpt-5.6-sol",
    name: "Sol",
    display_name: "Sol",
    supported_reasoning_levels: ["medium", "high"],
    default_reasoning_level: "medium",
    model_family: "5.6",
    legacy: false,
    context_window: 128000,
    auto_compact_token_limit: 100000,
    max_output: 16000,
    capabilities: { native_responses: true, generic_responses: false, reasoning: true, tools: false, computer_use: false, browser_tool: false },
    ...overrides,
  };
}
export function webCatalog(models = [webModel()], overrides = {}) {
  return { profileId: "personal", profileEpoch: "epoch-one", revision: "rev-one", checkedAt: "2026-10-02T00:00:00Z", maxConcurrency: 5, stale: false, models, ...overrides };
}
export const runtimeHealth = { service: "9router-cgw-runtime", protocolVersion: 1, draining: false };
