const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { X509Certificate } = require("node:crypto");
const childProcess = require("node:child_process");

const root = path.resolve(process.argv[2] || path.join(__dirname, "../.."));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mitm-startup-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, DATA_DIR: path.join(home, "data"), NODE_ENV: "production" });
for (const key of Object.keys(process.env)) if (/proxy/i.test(key)) delete process.env[key];
const timer = setTimeout(() => { console.error("MITM startup smoke timed out"); process.exit(1); }, 20000);
process.on("exit", () => { clearTimeout(timer); fs.rmSync(home, { recursive: true, force: true }); });

// Only isolate host administration and the listen address. Certificate generation,
// server startup, async SNICallback and TLS verification all run unchanged.
childProcess.execSync = () => "";
const listen = https.Server.prototype.listen;
https.Server.prototype.listen = function (_port, onListening) {
  const server = this;
  return listen.call(server, 0, "127.0.0.1", async () => {
    onListening?.();
    try {
      const ca = fs.readFileSync(path.join(process.env.DATA_DIR, "mitm/rootCA.crt"), "utf8");
      const request = servername => new Promise((resolve, reject) => {
        const req = https.get({ host: "127.0.0.1", port: server.address().port, servername, ca, path: "/_mitm_health", agent: false }, response => {
          let text = "";
          const peer = new X509Certificate(response.socket.getPeerCertificate().raw);
          response.setEncoding("utf8");
          response.on("data", chunk => { text += chunk; });
          response.on("end", () => resolve({ body: JSON.parse(text), peer }));
          response.on("error", reject);
        });
        req.on("error", reject);
      });
      const first = await request("synthetic.test");
      assert.equal(first.body.ok, true);
      assert.equal(first.body.pid, process.pid);
      assert.equal(first.peer.ca, false);
      assert.equal(first.peer.checkHost("synthetic.test"), "synthetic.test");
      const repeat = await request("synthetic.test");
      assert.equal(repeat.peer.fingerprint256, first.peer.fingerprint256, "repeat SNI reuses the cached certificate");
      const second = await request("other.synthetic.test");
      assert.equal(second.body.ok, true);
      assert.equal(second.peer.checkHost("other.synthetic.test"), "other.synthetic.test");
      assert.notEqual(second.peer.fingerprint256, first.peer.fingerprint256);
      console.log(JSON.stringify({ scenario: "MITM async startup and SNI", rootCreated: true, trustedTls: true, cachedRepeat: true, distinctSni: true }));
      server.close(() => process.exit(0));
    } catch (error) { console.error(error); server.close(() => process.exit(1)); }
  });
};
require(path.join(root, "src/mitm/server.js"));
