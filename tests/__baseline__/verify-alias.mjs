// Verify alias resolution is byte-for-byte stable (both directions, all sources).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

const here = dirname(fileURLToPath(import.meta.url));
const snapPath = join(here, "alias-baseline.json");

// All known alias tokens to probe (collected from both maps' historical keys)
const ALIAS_TOKENS = [
  "cc","cx","gc","qw","if","ag","gh","kr","cu","kc","kmc","cl","oc","ocg","qd","qoder",
  "el","openai","vercel","vercel-ai-gateway","anthropic","gemini","openrouter","glm","kimi",
  "minimax","minimax-cn","hf","huggingface","ds","deepseek","cmc","commandcode","groq","xai",
  "mistral","pplx","perplexity","together","fireworks","cerebras","cohere","nvidia","nebius",
  "siliconflow","hyp","hyperbolic","dg","deepgram","aai","assemblyai","nb","nanobanana","ch",
  "chutes","ark","volcengine-ark","byteplus","bpm","cursor","vx","vertex","vxp","vertex-partner",
  "gw","grok-web","gcli","gb","grok-build","grok-cli","pw","perplexity-web","mimo","xiaomi-mimo",
  "xmtp","xiaomi-tokenplan","cf",
  "cloudflare-ai","fal","fal-ai","stability","stability-ai","bfl","black-forest-labs","recraft",
  "topaz","runway","runwayml","jina","jina-ai","polly","aws-polly","bb","blackbox",
  "af","airforce","api-airforce","llm7","llm-7","samba","sambanova","bm","bluesminds",
  "bzl","bazaarlink","kgw","kilo-gateway","hunyuan","tencent","qianfan","baidu","ernie",
  "dv","devin","devin-cli","morph","morphllm",
  "muse","muse-ai","meta-model-api",
  "muse-code","muse-subscription",
  "br","bedrock","aws-bedrock",
  "brx","bedrock-xai","bedrock-grok",
  "nous","nous-portal","nous-research","ns",
];

// Sort idToAlias by key — runtime accesses by key, order is irrelevant (content-based)
const sortedIdToAlias = Object.fromEntries(
  Object.keys(PROVIDER_ID_TO_ALIAS).sort().map(k => [k, PROVIDER_ID_TO_ALIAS[k]])
);
const resolved = {
  aliasToId: Object.fromEntries(ALIAS_TOKENS.map(a => [a, resolveProviderAlias(a)])),
  idToAlias: sortedIdToAlias,
  modelKeys: Object.keys(PROVIDER_MODELS).sort(),
};
const current = JSON.parse(JSON.stringify(resolved));

if (process.argv[2] === "--snapshot") {
  writeFileSync(snapPath, JSON.stringify(current, null, 2));
  console.log(`Snapshot alias resolution → ${snapPath}`);
  process.exit(0);
}
if (!existsSync(snapPath)) { console.error("No baseline. Run --snapshot first."); process.exit(1); }
const baseline = JSON.parse(readFileSync(snapPath, "utf8"));
// Approved upstream catalog additions; verify both alias directions, then compare
// every historical alias and model key without replacing the baseline snapshot.
const addedAliases = {
  "deepseek-web": "deepseek-web", "gemini-web": "gemini-web",
  "muse-web": "muse-web", runcrate: "runcrate", sensenova: "sensenova",
  "uc-web": "uc", "veoaifree-web": "veo-free",
};
for (const [id, alias] of Object.entries(addedAliases)) {
  if (current.idToAlias[id] !== alias || resolveProviderAlias(alias) !== id || !current.modelKeys.includes(alias)) {
    throw new Error(`Invalid upstream alias: ${alias} -> ${id}`);
  }
  delete current.idToAlias[id];
}
const addedModelKeys = new Set([...Object.values(addedAliases), "ollama-local", "ollama-local-tts-models", "ollama-local-tts-voices"]);
for (const key of addedModelKeys) {
  if (!current.modelKeys.includes(key)) throw new Error(`Missing upstream catalog: ${key}`);
}
current.modelKeys = current.modelKeys.filter((key) => !addedModelKeys.has(key));
// Check the approved public additions explicitly as well as preserving the full map.
for (const [id, alias] of [["minimax-code", "mm"], ["minimax-code-global", "mmg"], ["nous", "nous"]]) {
  if (current.idToAlias[id] !== alias || resolveProviderAlias(alias) !== id || !current.modelKeys.includes(alias)) {
    console.error(`Invalid provider alias: ${alias} -> ${id}`);
    process.exit(1);
  }
}
if (JSON.stringify(baseline) === JSON.stringify(current)) {
  console.log(`✅ Alias resolution byte-for-byte equal (${ALIAS_TOKENS.length} tokens).`);
  process.exit(0);
}
// Diff
for (const a of ALIAS_TOKENS) {
  if (baseline.aliasToId[a] !== current.aliasToId[a]) {
    console.error(`~ alias ${a}: ${baseline.aliasToId[a]} -> ${current.aliasToId[a]}`);
  }
}
if (JSON.stringify(baseline.idToAlias) !== JSON.stringify(current.idToAlias)) console.error("~ idToAlias changed");
if (JSON.stringify(baseline.modelKeys) !== JSON.stringify(current.modelKeys)) console.error("~ modelKeys changed");
process.exit(1);
