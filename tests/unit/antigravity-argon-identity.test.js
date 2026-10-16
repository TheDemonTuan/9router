import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
const { clearAntigravityDiscoveryProfileCache } = await import("../../open-sse/services/antigravityModels.js");
const { ANTIGRAVITY_IDE_USER_AGENT } = await import("../../open-sse/providers/shared.js");

const MANIFEST_RE = /manifest\/latest-arm64-mac\.yml$/;
const generationUserAgents = () => proxyAwareFetch.mock.calls
  .filter(([url]) => String(url).includes("v1internal:"))
  .map(([url, init]) => ({ url, userAgent: new Headers(init.headers).get("user-agent") }));

function execute(executor, model, extra = {}) {
  return executor.execute({
    model,
    body: { model, request: { contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }] } },
    stream: false,
    credentials: { accessToken: "token", projectId: "project" },
    ...extra,
  });
}

describe("Antigravity Argon generation identity", () => {
  beforeEach(() => {
    clearAntigravityDiscoveryProfileCache();
    proxyAwareFetch.mockReset().mockImplementation(async (url) => MANIFEST_RE.test(String(url))
      ? new Response("version: 2.23.1\n")
      : new Response("{}", { status: 200 }));
  });

  it("uses the hub identity only for Argon in concurrent mixed requests", async () => {
    const executor = new AntigravityExecutor();
    await Promise.all([
      execute(executor, "gemini-4-argon-medium"),
      execute(executor, "claude-opus-5-5-high"),
      execute(executor, "gemini-3.8-flash-medium"),
    ]);

    const byModel = Object.fromEntries(proxyAwareFetch.mock.calls
      .filter(([url]) => String(url).includes("v1internal:"))
      .map(([, init]) => [JSON.parse(init.body).model, new Headers(init.headers).get("user-agent")]));
    expect(byModel).toEqual({
      "gemini-4-argon-medium": "antigravity/hub/2.23.1 darwin/arm64",
      "claude-opus-5-5-high": ANTIGRAVITY_IDE_USER_AGENT,
      "gemini-3.8-flash-medium": ANTIGRAVITY_IDE_USER_AGENT,
    });
  });

  it("falls back to the discovery profile version when the manifest is unavailable", async () => {
    proxyAwareFetch.mockImplementation(async (url) => MANIFEST_RE.test(String(url))
      ? new Response("unavailable", { status: 503 })
      : new Response("{}", { status: 200 }));

    await execute(new AntigravityExecutor(), "gemini-4-argon-high");

    expect(generationUserAgents()).toEqual([expect.objectContaining({ userAgent: "antigravity/hub/2.19.1 darwin/arm64" })]);
  });

  it("does not dispatch generation after the client aborts during profile resolution", async () => {
    const controller = new AbortController();
    proxyAwareFetch.mockImplementation((url, init) => MANIFEST_RE.test(String(url))
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
      : Promise.resolve(new Response("{}", { status: 200 })));

    const pending = execute(new AntigravityExecutor(), "gemini-4-argon-low", { signal: controller.signal });
    const reason = new Error("client closed");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(generationUserAgents()).toEqual([]);
  });

  it("keeps explicit provider header overrides ahead of the Argon default", async () => {
    await execute(new AntigravityExecutor(), "gemini-4-argon-medium", {
      providerOverrides: { headers: { "User-Agent": "operator-agent/1" } },
    });

    expect(generationUserAgents()).toEqual([expect.objectContaining({ userAgent: "operator-agent/1" })]);
  });
});
