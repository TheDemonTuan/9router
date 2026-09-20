import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleSearchCore: vi.fn(),
  handleTtsCore: vi.fn(),
  handleSttCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: mocks.clearAccountError,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, getCombos: mocks.getCombos }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo, getComboModels: mocks.getComboModels }));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    test: {
      searchConfig: {},
      serviceKinds: ["tts", "stt"],
      ttsConfig: { authType: "bearer" },
      sttConfig: { authType: "bearer" },
    },
  },
  resolveProviderId: (provider) => provider,
}));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.handleSearchCore }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.handleTtsCore }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.handleSttCore }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: vi.fn(), getComboModelsFromData: vi.fn(() => null) }));
vi.mock("@/sse/utils/logger.js", () => ({ request: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn() }));

const { handleSearch } = await import("@/sse/handlers/search.js");
const { handleTts } = await import("@/sse/handlers/tts.js");
const { handleStt } = await import("@/sse/handlers/stt.js");

const credentials = { connectionId: "conn", connectionName: "Test" };
const success = () => ({ success: true, response: new Response("ok") });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getCombos.mockResolvedValue([]);
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockResolvedValue({ provider: "test", model: "voice" });
  mocks.getProviderCredentials.mockResolvedValue(credentials);
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, current) => current);
  mocks.handleTtsCore.mockResolvedValue(success());
  mocks.handleSttCore.mockResolvedValue(success());
  mocks.handleSearchCore.mockImplementation(async ({ onRequestSuccess }) => {
    await onRequestSuccess();
    return success();
  });
});

describe("successful scoped handlers clear their own model lock", () => {
  it("keeps search reset scoped to its capability lock", async () => {
    await handleSearch(new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "test", query: "latest" }),
    }));

    expect(mocks.clearAccountError).toHaveBeenCalledWith("conn", credentials, "websearch:test");
  });

  it("clears TTS and STT model locks after a successful request", async () => {
    await handleTts(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test/voice", input: "hello" }),
    }));

    const form = new FormData();
    form.set("model", "test/transcribe");
    form.set("file", new File(["audio"], "audio.wav", { type: "audio/wav" }));
    mocks.getModelInfo.mockResolvedValueOnce({ provider: "test", model: "transcribe" });
    await handleStt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form }));

    expect(mocks.clearAccountError).toHaveBeenCalledWith("conn", credentials, "voice");
    expect(mocks.clearAccountError).toHaveBeenCalledWith("conn", credentials, "transcribe");
  });
});
