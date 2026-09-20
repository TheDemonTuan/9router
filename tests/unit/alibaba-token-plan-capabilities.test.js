import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";

const imageBody = () => ({
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "https://example.test/image.png" } },
    ],
  }],
});

describe("Alibaba Token Plan provider-specific capabilities", () => {
  it("prevents generic Qwen patterns from stripping qwen3.8 image input", () => {
    for (const model of ["qwen3.8-max", "qwen3.8-flash", "qwen3.8-max-preview"]) {
      const caps = getCapabilitiesForModel("alitp-intl", model);
      expect(caps.vision, model).toBe(true);
      expect(caps.videoInput, model).toBe(true);
      expect(caps.contextWindow, model).toBe(1000000);
      const body = imageBody();
      stripUnsupportedModalities(body, "openai", caps);
      expect(body.messages[0].content, model).toHaveLength(2); 
      expect(body.messages[0].content.some((part) => part.type === "image_url"), model).toBe(true);
    }
  });

  it("keeps DeepSeek V4.1 Flash image input plus documented 1M/393216 limits", () => {
    const caps = getCapabilitiesForModel("alitp-intl", "deepseek-v4.1-flash");
    expect(caps).toMatchObject({
      vision: true,
      videoInput: false,
      pdf: false,
      reasoning: true,
      contextWindow: 1000000,
      maxOutput: 393216,
    });
    const body = imageBody();
    stripUnsupportedModalities(body, "openai", caps);
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content.some((part) => part.type === "image_url")).toBe(true);
  });

  it("keeps documented text-only models text-only (does strip unsupported image)", () => {
    for (const model of ["qwen3.7-max", "deepseek-v4-pro", "glm-5.3", "MiniMax-M2.5"]) {
      const caps = getCapabilitiesForModel("alitp-intl", model);
      expect(caps.vision, model).toBe(false);
      const body = imageBody();
      expect(stripUnsupportedModalities(body, "openai", caps), model).toBe(true);
      expect(body.messages[0].content.some((part) => part.type === "image_url")).toBe(false);
    }
  });

  it("applies Team Edition metadata without exposing it to Personal discovery", () => {
    expect(getCapabilitiesForModel("alitp-intl", "qwen3.6-plus")).toMatchObject({
      vision: true,
      contextWindow: 1000000,
    });
    expect(getCapabilitiesForModel("alitp-intl", "kimi-k2.7-code")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingCanDisable: false,
      contextWindow: 262144,
    });
  });

  it("does not change another provider's generic family capabilities", () => {
    const alitp = getCapabilitiesForModel("alitp-intl", "qwen3.8-max");
    const generic = getCapabilitiesForModel("some-other-provider", "qwen3.8-max");
    expect(alitp.vision).toBe(true);
    expect(generic.vision).not.toBe(true);
  });
});
