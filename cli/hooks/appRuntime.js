const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { getRuntimeDir } = require("./runtime");

// Next changes cwd to its standalone directory. On Windows that directory cannot
// be replaced by npm while running; lazy-loaded chunks also need the old build.
function ensureAppRuntime() {
  const source = path.join(__dirname, "..", "app");
  const buildId = fs.readFileSync(path.join(source, ".next-cli-build", "BUILD_ID"), "utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(buildId)) throw new Error("Invalid standalone build identity");
  const identity = createHash("sha256").update(buildId)
    .update(fs.readFileSync(path.join(source, "custom-server.js")))
    .update(fs.readFileSync(path.join(source, "chatgpt-web-viewer-proxy.cjs"))).digest("hex");
  const root = path.join(getRuntimeDir(), "app");
  const target = path.join(root, identity);
  function verify() {
    if (!fs.lstatSync(target).isDirectory()) throw new Error("Cached app must be a regular directory");
    if (fs.readFileSync(path.join(target, ".9router-ready"), "utf8") !== identity) throw new Error("Cached app identity mismatch");
    for (const name of ["server.js", "custom-server.js", "chatgpt-web-viewer-proxy.cjs", ".next-cli-build/BUILD_ID"]) {
      if (!fs.lstatSync(path.join(target, name)).isFile()) throw new Error(`Missing cached app artifact: ${name}`);
    }
  }
  fs.mkdirSync(root, { recursive: true });
  try { fs.lstatSync(target); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = path.join(root, `.app-${process.pid}-${randomUUID()}`);
    try {
      fs.cpSync(source, temporary, { recursive: true, dereference: true, errorOnExist: true, force: false });
      fs.writeFileSync(path.join(temporary, ".9router-ready"), identity, { flag: "wx" });
      try { fs.renameSync(temporary, target); } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) || !fs.existsSync(target)) throw error;
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  verify();
  return target;
}

module.exports = { ensureAppRuntime };
