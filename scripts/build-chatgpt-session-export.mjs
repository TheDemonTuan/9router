import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "tools/chatgpt-web-session-export");
const output = join(root, "public/downloads/chatgpt-web-session-export");
const files = new Map([
  ["manifest.json", new Uint8Array(await readFile(join(source, "manifest.json")))],
  ["popup.html", new Uint8Array(await readFile(join(source, "popup.html")))],
]);
const built = await Bun.build({
  entrypoints: [join(source, "popup.js"), join(source, "background.js")],
  target: "browser", format: "esm", splitting: false,
  naming: "[name].[ext]", sourcemap: "none",
});
if (!built.success) throw new AggregateError(built.logs, "ChatGPT session helper bundle failed");
for (const artifact of built.outputs) {
  const name = artifact.path.split("/").pop();
  if (!["popup.js", "background.js"].includes(name) || files.has(name)) throw new Error("Unexpected helper build output");
  files.set(name, new Uint8Array(await artifact.arrayBuffer()));
}
if (files.size !== 4 || [...files.values()].some(bytes => !bytes.byteLength)) throw new Error("Incomplete helper build output");
// Explicit four-file allowlist. Never enumerate the checkout or include fixtures.
const archive = {};
for (const [name, bytes] of files) archive[`chatgpt-web-session-export/${name}`] = bytes;
const zip = zipSync(archive, { level: 0, mtime: new Date(1980, 0, 1) });
await mkdir(output, { recursive: true });
for (const [name, bytes] of files) await writeFile(join(output, name), bytes);
await writeFile(join(root, "public/downloads/chatgpt-web-session-export.zip"), zip);
console.log("ChatGPT session helper: bundled four public files and ZIP");
