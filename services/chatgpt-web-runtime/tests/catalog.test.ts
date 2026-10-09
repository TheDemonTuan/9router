import { expect, test } from "bun:test";
import { availableChatGptWebModelRoutes, chatGptWebRouteEfforts, requireChatGptWebModelRoute, resolveChatGptWebContextLimits, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
import { chatGptModelFamilyMatches } from "../src/adapters/chatgpt-web/model-selection";
import { assertChatGptWebInputWithinLimits } from "../src/adapters/chatgpt-web/browser-worker";
test("Luna and Sol account discovery are mutually exclusive and unavailable effort cannot route", () => {
  const luna = { solAvailable: false, proAvailable: false, extraHighAvailable: false };
  const sol = { solAvailable: true, proAvailable: false, extraHighAvailable: false };
  expect(availableChatGptWebModelRoutes(luna).map(row => row.slug)).toEqual(["chatgpt-web/gpt-5.6-luna"]);
  expect(availableChatGptWebModelRoutes(sol).map(row => row.slug)).toEqual(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol", "chatgpt-web/gpt-6-sol-instant", "chatgpt-web/gpt-6-sol"]);
  const route = requireChatGptWebModelRoute("chatgpt-web/gpt-5.6-sol", sol, "high");
  expect(chatGptWebRouteEfforts(route, sol)).toEqual(["medium", "high"]);
  expect(() => requireChatGptWebModelRoute(route.slug, sol, "xhigh")).toThrow("does not support effort");
  expect(() => requireChatGptWebModelRoute("chatgpt-web/gpt-6-pro", sol)).toThrow("not available");
});
test("Bigger Context changes total context but never one-message transport limit", () => {
  const capabilities = { solAvailable: true, proAvailable: true, extraHighAvailable: true };
  const ordinary = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", capabilities, "5.6");
  const bigger = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", { ...capabilities, experimentalBiggerContext: true }, "5.6");
  expect(bigger.contextWindow).toBe(ordinary.contextWindow * 3);
  expect(resolveChatGptWebTransportLimits("gpt-5.6-sol", "high", { ...capabilities, experimentalBiggerContext: true }, "5.6")).toEqual(resolveChatGptWebTransportLimits("gpt-5.6-sol", "high", capabilities, "5.6"));
});

test("GPT-6 Sol context expansion does not enlarge Instant or non-Pro windows", () => {
  const pro = { solAvailable: true, proAvailable: true, extraHighAvailable: true, experimentalBiggerContext: true };
  const plus = { ...pro, proAvailable: false };
  for (const effort of ["medium", "high", "xhigh"] as const) {
    expect(resolveChatGptWebContextLimits("gpt-5.6-sol", effort, pro, "6")).toMatchObject({ contextWindow: 240_000, autoCompactTokenLimit: 220_000 });
    expect(resolveChatGptWebContextLimits("gpt-5.6-sol", effort, plus, "6")).toMatchObject({ contextWindow: 90_000, autoCompactTokenLimit: 80_000 });
  }
  expect(resolveChatGptWebContextLimits("gpt-5.6-sol", "low", pro, "6")).toMatchObject({ contextWindow: 111_193, autoCompactTokenLimit: 95_000 });
  expect(resolveChatGptWebContextLimits("gpt-5.6-sol", "low", plus, "6")).toMatchObject({ contextWindow: 41_000, autoCompactTokenLimit: 32_000 });
  expect(resolveChatGptWebContextLimits("gpt-5.6-sol", "max", pro, "6").contextWindow).toBe(112_193 * 3);
});

test("composer preflight keeps independent GPT-6 and GPT-5.6 Plus boundaries", () => {
  const plus = { solAvailable: true, proAvailable: false, extraHighAvailable: true, localToolsEnabled: false };
  for (const effort of ["medium", "high", "xhigh"] as const) {
    assertChatGptWebInputWithinLimits(20_000, 10_000, "gpt-5.6-sol", effort, plus, "6", 500_000);
    expect(() => assertChatGptWebInputWithinLimits(20_000, 10_000, "gpt-5.6-sol", effort, plus, "6", 500_001)).toThrow("composer boundary");
    assertChatGptWebInputWithinLimits(20_000, 10_000, "gpt-5.6-sol", effort, plus, "5.6", 1_048_572);
    expect(() => assertChatGptWebInputWithinLimits(20_000, 10_000, "gpt-5.6-sol", effort, plus, "5.6", 1_048_573)).toThrow("composer boundary");
  }
});

test("model proof normalizes Unicode separators without accepting contradictory families", () => {
  for (const separator of ["、", "،", "：", "—"]) {
    expect(chatGptModelFamilyMatches([`GPT-6 Sol High${separator} 3 of 5`], "6", "high")).toBe(true);
  }
  expect(chatGptModelFamilyMatches(["ＧＰＴ-６ S\u200bol High、 3 of 5"], "6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol High, 3 of 5"], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High"], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Pro"], "6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["GPT-6 Astra Pro"], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Sol High", "GPT-5.6 Sol High"], "6", "high")).toBe(false);
});
