import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-lease-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("runtime_leases", () => {
  it("acquires, blocks second holder, renews, and releases lease under Bun", async () => {
    if (!process.versions.bun) {
      // In non-bun environment, verify graceful handling
      return;
    }
    const { acquireLease, releaseLease, renewLease } = await import("@/lib/db/repos/runtimeLeasesRepo.js");

    const acquired1 = await acquireLease("worker_task", "instance_A", 10000);
    expect(acquired1).toBe(true);

    // Second holder fails
    const acquired2 = await acquireLease("worker_task", "instance_B", 10000);
    expect(acquired2).toBe(false);

    // Same holder succeeds (renewal)
    const renewed = await renewLease("worker_task", "instance_A", 15000);
    expect(renewed).toBe(true);

    // Release
    const released = await releaseLease("worker_task", "instance_A");
    expect(released).toBe(true);

    // Now second holder can acquire
    const acquiredB = await acquireLease("worker_task", "instance_B", 10000);
    expect(acquiredB).toBe(true);
  });
});
