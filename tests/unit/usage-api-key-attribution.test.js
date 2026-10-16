import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-api-key-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(async () => {
  const { resetAdapterForTest } = await import("../../src/lib/db/driver.js");
  resetAdapterForTest();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Usage stats API key attribution", () => {
  it("keeps API keys with the same masked prefix in separate buckets", async () => {
    const apiKeyA = "sk-machine-aaaaaa-11111111";
    const apiKeyB = "sk-machine-bbbbbb-22222222";

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyA,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyB,
      tokens: { prompt_tokens: 20, completion_tokens: 10 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    const stats = await db.getUsageStats("24h");
    const apiKeyEntries = Object.values(stats.byApiKey);

    expect(apiKeyEntries).toHaveLength(2);

    expect(
      apiKeyEntries
        .map((entry) => entry.promptTokens)
        .sort((a, b) => a - b)
    ).toEqual([10, 20]);
  });
});

describe("usage input/output fallback and scoped node cleanup", () => {
  it("counts Responses token JSON without combining same-name keys", async () => {
    const keys = await Promise.all([db.createApiKey("Same display name", "synthetic-machine"), db.createApiKey("Same display name", "synthetic-machine")]);
    for (const [apiKey, input, output] of [[keys[0].key, 11, 3], [keys[1].key, 23, 7]]) {
      await db.saveRequestUsage({ provider: "openai", model: "test", connectionId: "synthetic", apiKey,
        tokens: { input_tokens: input, output_tokens: output }, status: "ok" });
    }
    const stats = await db.getUsageStats("24h");
    const entries = Object.values(stats.byApiKey);
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.promptTokens).sort((a, b) => a - b)).toEqual([11, 23]);
    expect(entries.map(entry => entry.completionTokens).sort((a, b) => a - b)).toEqual([3, 7]);
  });

  it("deletes only the literal node prefix, including underscore-containing IDs", async () => {
    const a = await db.createProviderNode({ id: "openai-compatible-a_b", type: "openai-compatible", name: "A", prefix: "a", baseUrl: "https://example.invalid/v1" });
    const b = await db.createProviderNode({ id: "openai-compatible-axb", type: "openai-compatible", name: "B", prefix: "b", baseUrl: "https://example.invalid/v1" });
    await db.addCustomModel({ providerAlias: a.id, id: "model-a" });
    await db.addCustomModel({ providerAlias: b.id, id: "model-b" });
    await db.deleteProviderNode(a.id);
    const models = await db.getCustomModels();
    expect(models.some(model => model.providerAlias === a.id)).toBe(false);
    expect(models.some(model => model.providerAlias === b.id && model.id === "model-b")).toBe(true);
    expect(await db.getProviderNodeById(b.id)).not.toBeNull();
  });
});
