// Verify DB driver selection (Bun-first: bun:sqlite only)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chain-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("DB driver initialization", () => {
  it("uses bun:sqlite under Bun or fails fast under other runtimes", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    if (process.versions.bun) {
      const db = await getAdapter();
      expect(db.driver).toBe("bun:sqlite");
    } else {
      await expect(getAdapter()).rejects.toThrow(/bun:sqlite requires Bun runtime/);
    }
  });
});
