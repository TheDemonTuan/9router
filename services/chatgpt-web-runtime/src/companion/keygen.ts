import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function generateCompanionKey(privateKeyFile: string, publicKeyFile: string): void {
  const privatePath = resolve(privateKeyFile), publicPath = resolve(publicKeyFile);
  if (privatePath === publicPath || existsSync(privatePath) || existsSync(publicPath)) throw new Error("Key output paths must be distinct and must not exist");
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
  });
  mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(publicPath), { recursive: true, mode: 0o700 });
  writeFileSync(privatePath, keys.privateKey, { flag: "wx", mode: 0o600 });
  chmodSync(privatePath, 0o600);
  if (process.platform === "win32") {
    const who = spawnSync("whoami", [], { encoding: "utf8", windowsHide: true });
    if (who.status !== 0 || !who.stdout.trim()) throw new Error("Cannot establish key owner ACL");
    const acl = spawnSync("icacls", [privatePath, "/inheritance:r", "/grant:r", `${who.stdout.trim()}:F`], { encoding: "utf8", windowsHide: true });
    if (acl.status !== 0) throw new Error("Private key was created, but owner-only ACL failed; do not use it");
  }
  writeFileSync(publicPath, keys.publicKey, { flag: "wx", mode: 0o600 });
}
if (import.meta.main) {
  const [privateKeyFile, publicKeyFile, ...extra] = process.argv.slice(2);
  if (!privateKeyFile || !publicKeyFile || extra.length) throw new Error("Usage: companion:keygen <private-key-file> <public-key-file>");
  generateCompanionKey(privateKeyFile, publicKeyFile);
  console.info("Companion keypair created; provision only the public PEM through an authenticated private channel.");
}
