import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { X509Certificate, createPrivateKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { generate } from "selfsigned";

const require = createRequire(import.meta.url);
function loadRootCAWithDataDir(dataDir) {
  const rootCAPath = require.resolve("../../src/mitm/cert/rootCA.js");
  const pathsPath = require.resolve("../../src/mitm/paths.js");
  delete require.cache[rootCAPath];
  delete require.cache[pathsPath];
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try { return require("../../src/mitm/cert/rootCA.js"); }
  finally {
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  }
}

function request(port, ca, servername) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: "127.0.0.1", port, path: "/", ca, servername, agent: false }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve(text)); res.on("error", reject);
    });
    req.on("error", reject);
  });
}

describe("MITM Root CA generation", () => {
  for (const legacy of [false, true]) {
    it(`preserves ${legacy ? "legacy PKCS#1" : "native PKCS#8"} roots and signs trusted domain/wildcard leaf certificates`, async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mitm-ca-"));
      let server;
      try {
        const api = loadRootCAWithDataDir(dataDir);
        const files = await api.generateRootCA();
        if (legacy) {
          const pem = createPrivateKey(fs.readFileSync(files.key)).export({ type: "pkcs1", format: "pem" });
          fs.writeFileSync(files.key, pem);
        }
        const keyBefore = fs.readFileSync(files.key, "utf8"), certBefore = fs.readFileSync(files.cert, "utf8");
        expect(await api.generateRootCA()).toEqual(files);
        expect(fs.readFileSync(files.key, "utf8")).toBe(keyBefore);
        expect(fs.readFileSync(files.cert, "utf8")).toBe(certBefore);
        expect(api.isCertExpired(files.cert)).toBe(false);
        const root = new X509Certificate(certBefore);
        expect(root.ca).toBe(true);
        expect(root.verify(root.publicKey)).toBe(true);
        expect(root.checkPrivateKey(createPrivateKey(keyBefore))).toBe(true);
        const leaf = await api.generateLeafCert("synthetic.test", api.loadRootCA());
        const cert = new X509Certificate(leaf.cert);
        expect(cert.ca).toBe(false);
        expect(cert.verify(root.publicKey)).toBe(true);
        expect(cert.checkPrivateKey(createPrivateKey(leaf.key))).toBe(true);
        expect(cert.checkHost("synthetic.test")).toBe("synthetic.test");
        expect(cert.checkHost("child.synthetic.test")).toBe("*.synthetic.test");
        expect(cert.checkHost("unrelated.test")).toBeUndefined();
        server = https.createServer(leaf, (_req, res) => res.end("synthetic TLS ok"));
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;
        expect(await request(port, certBefore, "synthetic.test")).toBe("synthetic TLS ok");
        expect(await request(port, certBefore, "child.synthetic.test")).toBe("synthetic TLS ok");
        await expect(request(port, certBefore, "unrelated.test")).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
      } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }

  it("treats missing, malformed, expired and soon-expiring certificates as requiring renewal", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mitm-expiry-"));
    try {
      const api = loadRootCAWithDataDir(dataDir), certPath = path.join(dataDir, "synthetic.crt");
      expect(api.isCertExpired(certPath)).toBe(true);
      fs.writeFileSync(certPath, "synthetic invalid certificate");
      expect(api.isCertExpired(certPath)).toBe(true);
      for (const days of [-1, 10]) {
        const pems = await generate([{ name: "commonName", value: "synthetic.test" }], { algorithm: "sha256", notBeforeDate: new Date(Date.now() - 86400000 * 2), notAfterDate: new Date(Date.now() + 86400000 * days) });
        fs.writeFileSync(certPath, pems.cert);
        expect(api.isCertExpired(certPath)).toBe(true);
      }
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
});
