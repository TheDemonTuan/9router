import { expect, test } from "bun:test";
import { availableChatGptWebModelRoutes, chatGptWebRouteEfforts, requireChatGptWebModelRoute, resolveChatGptWebContextLimits, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
test("Luna and Sol account discovery are mutually exclusive and unavailable effort cannot route", () => {
  const luna = { solAvailable: false, proAvailable: false, extraHighAvailable: false };
  const sol = { solAvailable: true, proAvailable: false, extraHighAvailable: false };
  expect(availableChatGptWebModelRoutes(luna).map(row => row.slug)).toEqual(["chatgpt-web/gpt-5.6-luna"]);
  expect(availableChatGptWebModelRoutes(sol).map(row => row.slug)).toEqual(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol"]);
  const route = requireChatGptWebModelRoute("chatgpt-web/gpt-5.6-sol", sol, "high");
  expect(chatGptWebRouteEfforts(route, sol)).toEqual(["medium", "high"]);
  expect(() => requireChatGptWebModelRoute(route.slug, sol, "xhigh")).toThrow("does not support effort");
  expect(() => requireChatGptWebModelRoute("chatgpt-web/gpt-6-pro", sol)).toThrow("not available");
});
test("Bigger Context changes total context but never one-message transport limit", () => {
  const capabilities = { solAvailable: true, proAvailable: true, extraHighAvailable: true };
  const ordinary = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", capabilities);
  const bigger = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", { ...capabilities, experimentalBiggerContext: true });
  expect(bigger.contextWindow).toBe(ordinary.contextWindow * 3);
  expect(resolveChatGptWebTransportLimits("gpt-5.6-sol", "high", { ...capabilities, experimentalBiggerContext: true })).toEqual(resolveChatGptWebTransportLimits("gpt-5.6-sol", "high", capabilities));
});
