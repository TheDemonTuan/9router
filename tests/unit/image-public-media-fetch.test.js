import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn(), agents: [] }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici/index.js", () => ({
  fetch: mocks.fetch,
  Agent: class {
    constructor(options) { this.options = options; this.close = vi.fn(async () => {}); mocks.agents.push(this); }
  },
}));
import { fetchPublicMedia } from "../../open-sse/translator/concerns/image.js";

beforeEach(() => {
  vi.resetAllMocks(); mocks.agents.length = 0;
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.fetch.mockResolvedValue(new Response("media"));
});

describe("shared public media transport", () => {
  it.each([202, 404, 409, 425])("preserves artifact readiness status %s", async (status) => {
    mocks.fetch.mockResolvedValue(new Response(null, { status }));
    expect((await fetchPublicMedia("https://cdn.example/video.mp4")).status).toBe(status);
  });

  it("pins the validated address for scalar and all lookups without forwarding ambient credentials", async () => {
    const result = await fetchPublicMedia("https://cdn.example/video.mp4");
    expect(result.body.toString()).toBe("media");
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith("cdn.example", { all: true });
    const callback = vi.fn();
    mocks.agents[0].options.connect.lookup("cdn.example", {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, "93.184.216.34", 4);
    mocks.agents[0].options.connect.lookup("cdn.example", { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", dispatcher: mocks.agents[0] });
    expect(mocks.fetch.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(mocks.agents[0].close).toHaveBeenCalledOnce();
  });

  it("rejects mixed public/private DNS answers before opening a transport", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(fetchPublicMedia("https://cdn.example/video.mp4")).rejects.toThrow("blocked");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("revalidates redirect destinations and never follows a redirect into a private network", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://internal.example/private" } }));
    mocks.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }]);
    await expect(fetchPublicMedia("https://cdn.example/video.mp4", { maxRedirects: 3 })).rejects.toThrow("blocked");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("rejects URL credentials before DNS or network access", async () => {
    await expect(fetchPublicMedia("https://user:secret@cdn.example/video.mp4")).rejects.toThrow("without credentials");
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("cancels oversized streams before buffering further chunks", async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel,
    })));
    await expect(fetchPublicMedia("https://cdn.example/video.mp4", { maxBytes: 4 })).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalled(); expect(mocks.agents[0].close).toHaveBeenCalledOnce();
  });

  it("closes the full transport when the request fails without attempting a fallback", async () => {
    mocks.fetch.mockRejectedValue(new Error("transport failed"));
    await expect(fetchPublicMedia("https://cdn.example/video.mp4")).rejects.toThrow("transport failed");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.agents[0].close).toHaveBeenCalledOnce();
  });

  it("does not suppress dispatcher lifecycle errors", async () => {
    mocks.fetch.mockImplementation(async () => {
      mocks.agents[0].close.mockRejectedValue(new Error("dispatcher close failed"));
      return new Response("media");
    });
    await expect(fetchPublicMedia("https://cdn.example/video.mp4")).rejects.toThrow("dispatcher close failed");
  });

  it("honors cancellation before resolution or submission", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchPublicMedia("https://cdn.example/video.mp4", { signal: controller.signal })).rejects.toThrow();
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
