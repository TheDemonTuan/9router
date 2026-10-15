const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { getRuntimeDir } = require("./runtime");

const VERSION = "1.4.3";

function fileHash(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Not a regular file: ${file}`);
  const fd = fs.openSync(file, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(65536);
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function ensureBunRuntime() {
  try {
    const manifestPath = require.resolve("bun/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== VERSION || typeof manifest.bin?.bun !== "string") {
      throw new Error("Installed bun package has the wrong version or executable entry");
    }
    const source = path.resolve(path.dirname(manifestPath), manifest.bin.bun);
    const hash = fileHash(source);
    const directory = path.join(getRuntimeDir(), "bun", VERSION, hash);
    const target = path.join(directory, process.platform === "win32" ? "bun.exe" : "bun");
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.lstatSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const temporary = path.join(directory, `.bun-${process.pid}-${randomUUID()}`);
      try {
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        if (process.platform !== "win32") fs.chmodSync(temporary, 0o700);
        if (fileHash(temporary) !== hash) throw new Error("Runtime copy checksum mismatch");
        // Atomic no-replace publication: rename overwrites an existing winner on POSIX.
        try { fs.linkSync(temporary, target); } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    if (fileHash(target) !== hash) throw new Error("Cached runtime checksum mismatch");
    const result = spawnSync(target, ["--version"], {
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.stdout.trim() !== VERSION) {
      throw new Error("Verified executable did not report the required version", { cause: result.error });
    }
    return target;
  } catch (error) {
    throw new Error(`Bun ${VERSION} runtime unavailable: ${error.message}. Reinstall 9router with lifecycle scripts and optional dependencies enabled.`, { cause: error });
  }
}

module.exports = { ensureBunRuntime };
