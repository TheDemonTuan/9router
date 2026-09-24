import { describe, it, expect, vi } from "vitest";
import { parseModel, getModelInfoCore } from "../../open-sse/services/model.js";
import {
  isSameRoute,
  createRouteContext,
  formatRoute,
  formatFallback,
  formatAdapter,
} from "../../open-sse/utils/modelRoute.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { buildRequestDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

describe("Model Route Context & Observability Logging", () => {
  // Case 1: ag/gemini-3.8-flash-high -> direct (no arrow)
  it("case 1: ag/gemini-3.8-flash-high renders as direct request without arrow", () => {
    const parsed = parseModel("ag/gemini-3.8-flash-high");
    expect(parsed).toEqual({
      provider: "antigravity",
      providerAlias: "ag",
      model: "gemini-3.8-flash-high",
      isAlias: false,
    });

    const routeContext = createRouteContext({
      clientModel: "ag/gemini-3.8-flash-high",
      requestedProviderAlias: parsed.providerAlias,
      provider: parsed.provider,
      requestedModel: parsed.model,
      effectiveModel: "ag/gemini-3.8-flash-high",
      reason: "direct",
    });

    const displayModel = formatRoute(routeContext);
    expect(displayModel).toBe("ag/gemini-3.8-flash-high");
    expect(displayModel).not.toContain("→");
    expect(displayModel).not.toContain("antigravity");
  });

  // Case 2: antigravity/gemini-3.8-flash-high -> canonical direct (no arrow)
  it("case 2: antigravity/gemini-3.8-flash-high keeps canonical form without arrow", () => {
    const parsed = parseModel("antigravity/gemini-3.8-flash-high");
    expect(parsed).toEqual({
      provider: "antigravity",
      providerAlias: "antigravity",
      model: "gemini-3.8-flash-high",
      isAlias: false,
    });

    const routeContext = createRouteContext({
      clientModel: "antigravity/gemini-3.8-flash-high",
      requestedProviderAlias: parsed.providerAlias,
      provider: parsed.provider,
      requestedModel: parsed.model,
      effectiveModel: "antigravity/gemini-3.8-flash-high",
      reason: "direct",
    });

    const displayModel = formatRoute(routeContext);
    expect(displayModel).toBe("antigravity/gemini-3.8-flash-high");
    expect(displayModel).not.toContain("→");
  });

  // Case 3: model alias -> AG -> shows arrow from alias to target model
  it("case 3: model alias → AG shows arrow from alias to effective target", () => {
    const routeContext = createRouteContext({
      clientModel: "coding-fast",
      requestedProviderAlias: "ag",
      provider: "antigravity",
      requestedModel: "gemini-3.8-flash-high",
      effectiveModel: "ag/gemini-3.8-flash-high",
      reason: "model-alias",
    });

    const displayModel = formatRoute(routeContext);
    expect(displayModel).toBe("coding-fast → ag/gemini-3.8-flash-high");
    expect(displayModel).toContain("→");
  });

  // Case 4: combo -> AG -> shows arrow from combo name to chosen model
  it("case 4: combo → AG shows arrow from combo name to chosen model", () => {
    const routeContext = createRouteContext({
      clientModel: "best-code",
      requestedProviderAlias: "ag",
      provider: "antigravity",
      requestedModel: "gemini-3.8-flash-high",
      effectiveModel: "ag/gemini-3.8-flash-high",
      reason: "combo",
    });

    const displayModel = formatRoute(routeContext);
    expect(displayModel).toBe("best-code → ag/gemini-3.8-flash-high");
    expect(displayModel).toContain("→");
  });

  // Case 5: fallback Sol -> Luna shows arrow
  it("case 5: fallback Sol → Luna renders arrow in route and fallback notice", () => {
    const routeContext = createRouteContext({
      clientModel: "cx/gpt-6-sol",
      requestedProviderAlias: "cx",
      provider: "codex",
      requestedModel: "gpt-6-luna",
      effectiveModel: "cx/gpt-6-luna",
      reason: "fallback",
    });

    const displayModel = formatRoute(routeContext);
    expect(displayModel).toBe("cx/gpt-6-sol → cx/gpt-6-luna");
    expect(displayModel).toContain("→");

    const fallbackNotice = formatFallback("cx/gpt-6-sol", "cx/gpt-6-luna", "quota exhausted");
    expect(fallbackNotice).toBe("cx/gpt-6-sol → cx/gpt-6-luna · reason: quota exhausted");
  });

  // Case 6: ag/...-high preset thinking: wire model is correct and does not show (high) as new model
  it("case 6: ag/...-high thinking preset resolves correct wire model without (high) in displayModel", () => {
    const configuredUpstream = getModelUpstreamId("ag", "gemini-3.8-flash-high");
    expect(configuredUpstream).toBe("gemini-3.8-flash-high(high)");

    const wireModel = stripThinkingSuffix(configuredUpstream);
    expect(wireModel).toBe("gemini-3.8-flash-high");

    const routeContext = createRouteContext({
      clientModel: "ag/gemini-3.8-flash-high",
      requestedProviderAlias: "ag",
      provider: "antigravity",
      requestedModel: "gemini-3.8-flash-high",
      effectiveModel: "ag/gemini-3.8-flash-high",
      wireModel,
      reason: "direct",
    });

    const displayModel = formatRoute(routeContext);
    expect(displayModel).toBe("ag/gemini-3.8-flash-high");
    expect(displayModel).not.toContain("(high)");
    expect(displayModel).not.toContain("→");
    expect(routeContext.wireModel).toBe("gemini-3.8-flash-high");
  });

  // Critical assertion: ag -> antigravity NEVER rendered as model routing arrow
  it("asserts ag → antigravity is NEVER rendered as a model routing arrow", () => {
    expect(isSameRoute("ag/gemini-3.8-flash-high", "antigravity/gemini-3.8-flash-high")).toBe(true);

    const routeContext = createRouteContext({
      clientModel: "ag/gemini-3.8-flash-high",
      requestedProviderAlias: "ag",
      provider: "antigravity",
      requestedModel: "gemini-3.8-flash-high",
      effectiveModel: "antigravity/gemini-3.8-flash-high",
      reason: "direct",
    });

    const displayModel = formatRoute(routeContext);
    expect(displayModel).toBe("ag/gemini-3.8-flash-high");
    expect(displayModel).not.toContain("→");
    expect(displayModel).not.toBe("ag/gemini-3.8-flash-high → antigravity/gemini-3.8-flash-high");
  });

  // Capacity adapter notice
  it("formats capacity adapter notice with arrow", () => {
    const adapterNotice = formatAdapter("ag/gemini-3.8-flash-high", "ag/gemini-3.8-flash-image", "missing vision");
    expect(adapterNotice).toBe("ag/gemini-3.8-flash-high → ag/gemini-3.8-flash-image · reason: missing vision");
  });

  // Structured request log includes distinct route fields
  it("buildRequestDetail includes structured route fields", () => {
    const routeContext = createRouteContext({
      clientModel: "ag/gemini-3.8-flash-high",
      requestedProviderAlias: "ag",
      provider: "antigravity",
      requestedModel: "gemini-3.8-flash-high",
      effectiveModel: "ag/gemini-3.8-flash-high",
      wireModel: "gemini-3.8-flash-high",
      reason: "direct",
    });

    const detail = buildRequestDetail({
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
      routeContext,
      request: { messages: [] },
      status: "success",
    });

    expect(detail.client_model).toBe("ag/gemini-3.8-flash-high");
    expect(detail.provider_alias).toBe("ag");
    expect(detail.provider).toBe("antigravity");
    expect(detail.model).toBe("gemini-3.8-flash-high");
    expect(detail.wire_model).toBe("gemini-3.8-flash-high");
    expect(detail.route_reason).toBe("direct");
  });

  // ChatCore log line formatting integration
  it("chatCore logs direct request line without arrow", async () => {
    const logLines = [];
    const mockLog = {
      line: vi.fn((tag, icon, msg) => {
        logLines.push({ tag, icon, msg });
      }),
      debug: vi.fn(),
      fmtThink: vi.fn((t) => t),
    };

    // Fast-fail or mock executor check
    const result = await handleChatCore({
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      modelInfo: { provider: "antigravity", providerAlias: "ag", model: "gemini-3.8-flash-high" },
      credentials: { accessToken: "mock-token", connectionName: "acc-1" },
      log: mockLog,
      clientRawRequest: { body: { model: "ag/gemini-3.8-flash-high" } },
    });

    // Find the request line (icon '▶')
    const reqLine = logLines.find((l) => l.icon === "▶");
    expect(reqLine).toBeDefined();
    expect(reqLine.msg).toContain("POST ag/gemini-3.8-flash-high");
    expect(reqLine.msg).not.toContain("POST ag/gemini-3.8-flash-high → antigravity/gemini-3.8-flash-high");
  });
});
