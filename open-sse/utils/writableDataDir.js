// Browser credentials and optional runtime packages must stay in the configured
// data directory. Never fall back to a shared temporary directory or source tree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

export function getWritableDataDir() {
  if (cached) return cached;
  const base = path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || path.join(/* turbopackIgnore: true */ os.homedir(), ".9router"));
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ base, { recursive: true, mode: 0o700 });
    fs.accessSync(/* turbopackIgnore: true */ base, fs.constants.W_OK);
  } catch {
    throw new Error("Browser data directory is not writable; configure a private writable DATA_DIR");
  }
  cached = base;
  return base;
}
