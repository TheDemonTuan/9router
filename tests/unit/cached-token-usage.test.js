import { describe, it, expect } from "vitest";
import { canonicalizeUsage, extractUsage, mergeUsage, normalizeUsage, hasValidUsage } from "../../open-sse/utils/usageTracking.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { buildUsage, toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";

const split = { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 };
const raw = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: split, output_tokens: 50 };
describe("Claude TTL accounting", () => {
  it("retains TTL counters through output-only and partial deltas without double-folding", () => {
    const start = extractUsage({ type: "message_start", message: { usage: raw } });
    const delta = extractUsage({ type: "message_delta", usage: { output_tokens: 50 } });
    const merged = mergeUsage(start, delta);
    expect(merged.cache_creation).toEqual(split);
    expect(mergeUsage(merged, { cache_creation: { ephemeral_5m_input_tokens: 5 } }).cache_creation).toEqual(split);
    const canonical = canonicalizeUsage(merged);
    expect(canonical).toMatchObject({ prompt_tokens: 330, completion_tokens: 50, total_tokens: 380, cached_tokens: 200, cache_creation_input_tokens: 30, cache_creation: split });
    expect(canonicalizeUsage(canonical)).toEqual(canonical);
    expect(calculateCostFromTokens(canonical, getPricingForModel("claude", "claude-sonnet-4-6"))).toBeCloseTo(0.0012675, 12);
  });
  it.each([["claude-sonnet-4-6", 0.6], ["claude-opus-5-5", 0.8]])("prices pure 1h writes for %s", (model, expected) => {
    expect(calculateCostFromTokens({ prompt_tokens: 100000, cache_creation_input_tokens: 100000, cache_creation: { ephemeral_1h_input_tokens: 100000 } }, getPricingForModel("claude", model))).toBeCloseTo(expected, 12);
  });
  it.each([null, {}, { ephemeral_1h_input_tokens: -1 }, { ephemeral_1h_input_tokens: Infinity }, { ephemeral_1h_input_tokens: "bad" }])("does not invent a split for absent/invalid data %j", cache_creation => {
    expect(normalizeUsage({ ...raw, cache_creation }).cache_creation).toBeUndefined();
    expect(canonicalizeUsage({ ...raw, cache_creation }).cache_creation).toBeUndefined();
  });
  it("uses aggregate fallback for invalid/over-budget splits, remainder and optional rates", () => {
    const pricing = { input: 3, output: 15, cached: 0.3, cache_creation: 3.75, cache_creation_1h: 6 };
    const tokens = { prompt_tokens: 30, cache_creation_input_tokens: 30 };
    for (const cache_creation of [undefined, {}, { ephemeral_1h_input_tokens: 31 }, { ephemeral_1h_input_tokens: -1 }, { ephemeral_5m_input_tokens: NaN, ephemeral_1h_input_tokens: 20 }]) {
      expect(calculateCostFromTokens({ ...tokens, cache_creation }, pricing)).toBeCloseTo(30 * 3.75 / 1e6, 12);
    }
    expect(calculateCostFromTokens({ ...tokens, cache_creation: { ephemeral_1h_input_tokens: 20 } }, pricing)).toBeCloseTo((20 * 6 + 10 * 3.75) / 1e6, 12);
    expect(calculateCostFromTokens({ ...tokens, cache_creation: split }, { input: 3, output: 15, cache_creation: 0, cache_creation_1h: 0 })).toBe(0);
    expect(calculateCostFromTokens({ ...tokens, cache_creation: split }, { input: 3, output: 15, cache_creation: 3.75 })).toBeCloseTo(30 * 3.75 / 1e6, 12);
  });
  it.each(["cache_read_input_tokens", "cache_creation_input_tokens"])("recognizes cache-only %s as authoritative", field => {
    expect(hasValidUsage({ input_tokens: 0, output_tokens: 0, [field]: 30 })).toBe(true);
  });
});
// Canonical convention (single source of truth for storage + cost):
//   prompt_tokens             = total input INCLUDING cache read + cache creation
//   cached_tokens             = cache-read portion (subset of prompt_tokens)
//   cache_creation_input_tokens = cache-write portion (subset of prompt_tokens)
//   completion_tokens         = output
// Discriminator: Claude reports cache separately (prompt EXCLUDES cache);
// OpenAI/Gemini report prompt INCLUDING cached_tokens.
describe("canonicalizeUsage", () => {
  it("folds Claude exclusive cache into an inclusive prompt count", () => {
    // Claude: input_tokens excludes cache; cache_read + cache_creation are separate
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    expect(out.prompt_tokens).toBe(330); // 100 + 200 + 30
    expect(out.completion_tokens).toBe(50);
    expect(out.cached_tokens).toBe(200);
    expect(out.cache_creation_input_tokens).toBe(30);
  });

  it("passes through OpenAI inclusive prompt unchanged", () => {
    // OpenAI: prompt_tokens already includes cached_tokens (a subset)
    const out = canonicalizeUsage({
      prompt_tokens: 330,
      completion_tokens: 50,
      cached_tokens: 200,
    });
    expect(out.prompt_tokens).toBe(330);
    expect(out.cached_tokens).toBe(200);
    expect(out.cache_creation_input_tokens).toBe(0);
  });

  it("passes through Gemini inclusive prompt (cachedContent already counted)", () => {
    const out = canonicalizeUsage({
      prompt_tokens: 500,
      completion_tokens: 80,
      cached_tokens: 120,
      reasoning_tokens: 40,
    });
    expect(out.prompt_tokens).toBe(500);
    expect(out.cached_tokens).toBe(120);
    expect(out.reasoning_tokens).toBe(40);
  });

  it("reads cached_tokens from the nested buildUsage() shape", () => {
    // buildUsage() only emits cache reads under prompt_tokens_details. The
    // Responses translator overwrites state.usage with that shape on
    // response.completed, so a top-level-only read silently drops the cache
    // count for every Responses provider (codex, grok-cli, ...).
    const out = canonicalizeUsage(
      buildUsage({ promptTokens: 330, completionTokens: 50, totalTokens: 380, cachedTokens: 200 })
    );
    expect(out.prompt_tokens).toBe(330);
    expect(out.cached_tokens).toBe(200);
  });

  it("handles no-cache usage", () => {
    const out = canonicalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
    expect(out.prompt_tokens).toBe(100);
    expect(out.cached_tokens).toBe(0);
    expect(out.cache_creation_input_tokens).toBe(0);
  });

  it("is idempotent (running twice yields the same canonical shape)", () => {
    const once = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    const twice = canonicalizeUsage(once);
    expect(twice.prompt_tokens).toBe(330);
    expect(twice.cached_tokens).toBe(200);
    expect(twice.cache_creation_input_tokens).toBe(30);
    expect(twice.completion_tokens).toBe(50);
  });

  it("returns null for invalid input", () => {
    expect(canonicalizeUsage(null)).toBeNull();
    expect(canonicalizeUsage(undefined)).toBeNull();
  });

  it("folds a Claude cache-miss first write (cache_creation only, no cache_read yet)", () => {
    // Cache-miss on first write: upstream emits cache_creation_input_tokens but
    // no cache_read_input_tokens at all (not even 0). Must still fold into prompt
    // instead of falling through to the OpenAI passthrough branch.
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      cache_creation_input_tokens: 500,
    });
    expect(out.prompt_tokens).toBe(600); // 100 + 0 (no read) + 500
    expect(out.cached_tokens).toBe(0);
    expect(out.cache_creation_input_tokens).toBe(500);
  });
});

describe("calculateCostFromTokens (canonical inclusive convention)", () => {
  const pricing = { input: 3, output: 15, cached: 0.3, cache_creation: 3.75 };

  it("prices cached + cache_creation as subsets of an inclusive prompt without double-counting", () => {
    // prompt=330 includes 200 cached + 30 cache_creation → 100 full-price input
    const cost = calculateCostFromTokens(
      { prompt_tokens: 330, completion_tokens: 50, cached_tokens: 200, cache_creation_input_tokens: 30 },
      pricing
    );
    const expected =
      (100 * 3 + 200 * 0.3 + 30 * 3.75 + 50 * 15) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("does not let cache_creation drive nonCached negative", () => {
    // pathological: cached + creation exceeds prompt → nonCached clamps at 0
    const cost = calculateCostFromTokens(
      { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 80, cache_creation_input_tokens: 40 },
      pricing
    );
    const expected = (0 * 3 + 80 * 0.3 + 40 * 3.75) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("matches plain input pricing when no cache present", () => {
    const cost = calculateCostFromTokens({ prompt_tokens: 100, completion_tokens: 50 }, pricing);
    expect(cost).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 12);
  });
});

describe("Anthropic streaming usage (message_start carries cache, message_delta output-only)", () => {
  it("extractUsage reads input + cache from message_start", () => {
    const u = extractUsage({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } },
    });
    expect(u.prompt_tokens).toBe(100);
    expect(u.cache_read_input_tokens).toBe(200);
    expect(u.cache_creation_input_tokens).toBe(30);
  });

  it("merges message_start cache with message_delta output without clobbering", () => {
    // Real Anthropic SSE: cache only in message_start, real output only in message_delta.
    const start = extractUsage({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } },
    });
    const delta = extractUsage({ type: "message_delta", usage: { output_tokens: 50 } });
    const merged = mergeUsage(start, delta);
    expect(merged.prompt_tokens).toBe(100);
    expect(merged.cache_read_input_tokens).toBe(200);
    expect(merged.cache_creation_input_tokens).toBe(30);
    expect(merged.completion_tokens).toBe(50);

    // And it canonicalizes to a cache-inclusive prompt for storage/cost.
    const canon = canonicalizeUsage(merged);
    expect(canon.prompt_tokens).toBe(330); // 100 + 200 + 30
    expect(canon.cached_tokens).toBe(200);
    expect(canon.cache_creation_input_tokens).toBe(30);
    expect(canon.completion_tokens).toBe(50);
  });

  it("does not let a NaN field poison the running max-merge", () => {
    // typeof NaN === "number", so a naive Math.max(prev, NaN) is NaN — one
    // malformed chunk must not wipe out an already-accumulated good value.
    const prev = { prompt_tokens: 100, cache_read_input_tokens: 200 };
    const bad = { prompt_tokens: NaN, completion_tokens: 50 };
    const merged = mergeUsage(prev, bad);
    expect(merged.prompt_tokens).toBe(100);
    expect(merged.cache_read_input_tokens).toBe(200);
    expect(merged.completion_tokens).toBe(50);
  });
});

describe("Kiro usage pass-through", () => {
  it("passes through plain input/output when no cache fields are present", () => {
    const out = toOpenAIUsage({ inputTokens: 100, outputTokens: 50 }, "kiro");
    expect(out.prompt_tokens).toBe(100);
    expect(out.completion_tokens).toBe(50);
    expect(out.total_tokens).toBe(150);
    expect(out.prompt_tokens_details).toBeUndefined();
  });

  it("forward-compat: surfaces cache fields if Kiro event shape grows them", () => {
    // ponytail: Amazon Q upstream doesn't expose cache today, but if it starts
    // sending cache_read_input_tokens / cache_creation_input_tokens / cachedTokens,
    // cost tracking should pick them up automatically without another change.
    const out = toOpenAIUsage(
      { inputTokens: 500, outputTokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      "kiro"
    );
    expect(out.prompt_tokens_details).toBeDefined();
    expect(out.prompt_tokens_details.cached_tokens).toBe(200);
    expect(out.prompt_tokens_details.cache_creation_tokens).toBe(50);
  });
});
