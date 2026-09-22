import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const originalLogging = process.env.ENABLE_REQUEST_LOGS;
const tempRoots = [];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalLogging === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalLogging;
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("ChatGPT Web request logger privacy", () => {
  it("never persists native prompts, checkpoints, headers, or streamed events", async () => {
    const root = mkdtempSync(join(tmpdir(), "9router-request-log-"));
    tempRoots.push(root);
    process.chdir(root);
    process.env.ENABLE_REQUEST_LOGS = "true";

    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js?privacy");
    const logger = await createRequestLogger("codex", "openai-responses", "chatgpt-web/high", { redactPayloads: true });
    logger.logClientRawRequest("/v1/responses", { input: "secret prompt" }, { authorization: "secret token" });
    logger.logTargetRequest("unix:/v1/responses", { "x-codex-turn-metadata": "secret metadata" }, { encrypted: "secret checkpoint" });
    logger.logProviderResponse(200, "OK", { "set-cookie": "secret cookie" }, { output: "secret answer" });
    logger.logError(new Error("safe failure"), { input: "secret error prompt" });
    logger.appendProviderChunk("secret stream");
    logger.appendOpenAIChunk("secret intermediate");
    logger.appendConvertedChunk("secret converted");

    const files = readdirSync(logger.sessionPath).map((name) => readFileSync(join(logger.sessionPath, name), "utf8")).join("\n");
    expect(files).not.toContain("secret");
    expect(files).toContain('"redacted": true');
    expect(readdirSync(logger.sessionPath).some((name) => name.endsWith(".txt"))).toBe(false);
  });
});
