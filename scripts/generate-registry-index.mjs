import { readdir, writeFile } from "node:fs/promises";

const directory = new URL("../open-sse/providers/registry/", import.meta.url);
// Preserve intentionally disabled providers; do not enable them during generation.
const excluded = new Set(["index.js", "REGISTRY_TEMPLATE.js", "trae.js", "windsurf.js", "devin-cli.js"]);
const files = (await readdir(directory)).filter((name) => name.endsWith(".js") && !excluded.has(name)).sort();
const imports = files.map((name, index) => `import p${index} from "./${name}";`);
const entries = files.map((_, index) => `  p${index},`);
await writeFile(new URL("index.js", directory), ["// Auto-generated: static imports for all registry entries", ...imports, "export default [", ...entries, "];", ""].join("\n"));
console.log(`Generated registry index: ${files.length} providers`);
