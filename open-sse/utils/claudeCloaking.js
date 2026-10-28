import { createHash, randomBytes, randomUUID } from "crypto";
import { CLAUDE_TOOL_SUFFIX, CC_DEFAULT_TOOLS } from "../config/appConstants.js";
import { CLAUDE_CLI_VERSION } from "../providers/shared.js";

const CC_ENTRYPOINT = "sdk-cli";
const BILLING_PREFIX = "x-anthropic-billing-header:";

// Claude Code wire constants, ported from CLIProxyAPI (claude_executor_cloaking.go,
// claude_signing.go — Claude Code 2.1.220+ parity).
const FINGERPRINT_SALT = "59cf53e54c78";
const CCH_SEED = 0x4D659218E32A3268n;
const CCH_PLACEHOLDER = "00000";
const CCH_DIGITS_RE = /cch=[0-9a-f]{5};/;
const CURRENT_DATE_REMINDER_PREFIX = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ";

export function isClaudeOAuthToken(token) {
  return typeof token === "string" && token.includes("sk-ant-oat");
}

// Text of the first user message that Claude Code samples for its build fingerprint
// (reminder blocks it injects itself are skipped).
function fingerprintMessageText(body) {
  const first = Array.isArray(body?.messages) ? body.messages.find((m) => m?.role === "user") : null;
  const content = first?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (part?.type !== "text") continue;
    const text = typeof part.text === "string" ? part.text : "";
    if (text.startsWith(CURRENT_DATE_REMINDER_PREFIX)) continue;
    if (text.startsWith("<system-reminder>") && text.includes("</system-reminder>")) continue;
    return text;
  }
  return "";
}

// cc_version build suffix: sha256(salt + text[4] + text[7] + text[20] + version)[:3],
// indexing UTF-16 code units like the JS client ("0" past the end).
function computeFingerprint(text, version) {
  const sampled = [4, 7, 20].map((i) => (i < text.length ? text[i] : "0")).join("");
  return createHash("sha256").update(FINGERPRINT_SALT + sampled + version).digest("hex").slice(0, 3);
}

// Billing header with the cch placeholder; signClaudeBody fills it from the final body.
function generateBillingHeader(body) {
  const fingerprint = computeFingerprint(fingerprintMessageText(body), CLAUDE_CLI_VERSION);
  return `${BILLING_PREFIX} cc_version=${CLAUDE_CLI_VERSION}.${fingerprint}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${CCH_PLACEHOLDER};`;
}

// Derive a deterministic UUID-v4-shaped string from a seed (stable per account)
function deriveUuid(seed) {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Generate fake user ID in the current Claude Code JSON format:
// {"device_id":"<64hex>","account_uuid":"<uuid>","session_id":"<uuid>"}
// device_id/account_uuid derive from the account seed, session_id per-conversation
function generateFakeUserID(sessionId, seed) {
  const deviceId = seed ? createHash("sha256").update(`device:${seed}`).digest("hex") : randomBytes(32).toString("hex");
  const accountUuid = seed ? deriveUuid(`account:${seed}`) : randomUUID();
  const cleanSessionId = typeof sessionId === "string" ? sessionId.replace(/^claude:/i, "").trim() : null;
  const sessionUuid = cleanSessionId || randomUUID();
  return `{"device_id":"${deviceId}","account_uuid":"${accountUuid}","session_id":"${sessionUuid}"}`;
}

export function extractClaudeSessionIdFromUserId(userId) {
  if (typeof userId !== "string" || !userId) return null;
  if (userId[0] === "{") {
    try {
      const sid = JSON.parse(userId)?.session_id;
      return typeof sid === "string" && sid ? sid.replace(/^claude:/i, "").trim() || null : null;
    } catch {
      return null;
    }
  }
  const clean = userId.replace(/^claude:/i, "").trim();
  return clean || null;
}

/**
 * Cloak tools before sending to Claude provider (anti-ban):
 * - Rename client tools with the CLAUDE_TOOL_SUFFIX ("_ide") in tools[] and messages[]
 * - Skip tools that carry a `type` (server-side built-ins) — sent as-is
 * - Inject CC_DECOY_TOOLS after client tools
 * Returns { body, toolNameMap } where toolNameMap maps suffixed → original
 * @param {object} body - Claude API request body
 * @returns {{ body: object, toolNameMap: Map|null }}
 */
export function cloakClaudeTools(body) {
  const tools = body.tools;
  if (!tools || tools.length === 0) return { body, toolNameMap: null };

  const suffix = (name) => `${name}${CLAUDE_TOOL_SUFFIX}`;
  const toolNameMap = new Map();
  const clientToolNames = new Set();
  const clientDeclarations = [];

  // All client tools get renamed with suffix.
  // Built-in server tools (web_search_20250305, etc.) carry a `type` and require
  // an exact reserved `name` — never suffix those or Claude rejects the request.
  for (const tool of tools) {
    if (tool.type) { clientDeclarations.push(tool); continue; }
    const suffixed = suffix(tool.name);
    toolNameMap.set(suffixed, tool.name);
    clientToolNames.add(tool.name);
    clientDeclarations.push({ ...tool, name: suffixed });
  }

  // Client tools first, then CC decoy tools (no overlap: client tools all have _cc suffix)
  const allTools = [...clientDeclarations, ...CC_DECOY_TOOLS];

  // Rename tool_use in message history (all client tools get suffix)
  const renamedMessages = body.messages?.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const renamedContent = msg.content.map(block =>
      block.type === "tool_use" ? { ...block, name: suffix(block.name) } : block
    );
    return { ...msg, content: renamedContent };
  });

  const cloakedBody = { ...body, tools: allTools, messages: renamedMessages || body.messages };

  // A forced tool_choice ({ type: "tool", name }) must point at the suffixed
  // tool name, otherwise Claude rejects it: "Tool '<name>' not found in provided tools".
  // Only rewrite when the choice targets one of the client tools we actually
  // renamed — never a decoy/built-in name (those are sent unsuffixed).
  if (
    body.tool_choice?.type === "tool" &&
    clientToolNames.has(body.tool_choice.name)
  ) {
    cloakedBody.tool_choice = { ...body.tool_choice, name: suffix(body.tool_choice.name) };
  }

  return {
    body: cloakedBody,
    toolNameMap: toolNameMap.size > 0 ? toolNameMap : null
  };
}

// Strip a trailing CLAUDE_TOOL_SUFFIX from a cloaked name as a last-resort
// fallback when the name isn't in toolNameMap (e.g. map lost across a retry/
// reconnect). Never strips decoy names — those are meant to reach the client
// unresolved so it can see "tool unavailable" instead of silently no-oping.
export function stripCloakSuffix(name) {
  if (typeof name !== "string" || !name.endsWith(CLAUDE_TOOL_SUFFIX)) return null;
  if (CC_DEFAULT_TOOLS.has(name)) return null;
  const original = name.slice(0, -CLAUDE_TOOL_SUFFIX.length);
  return original.length > 0 ? original : null;
}

// Decloak tool_use names in non-streaming Claude response body (INPUT side)
export function decloakToolNames(body, toolNameMap) {
  if (!Array.isArray(body?.content)) return body;
  const content = body.content.map(block => {
    if (block?.type !== "tool_use") return block;
    if (toolNameMap?.has(block.name)) {
      return { ...block, name: toolNameMap.get(block.name) };
    }
    // toolNameMap missing/stale for this name — fall back to suffix stripping
    // rather than forwarding an unresolvable "<tool>_ide" name to the client.
    const fallback = stripCloakSuffix(block.name);
    return fallback ? { ...block, name: fallback } : block;
  });
  return { ...body, content };
}

/**
 * Decloak the tool name inside a single streamed Claude SSE event.
 *
 * Streaming counterpart of decloakToolNames(). Required for claude→claude
 * proxying: translateResponse() returns same-format chunks untouched, so
 * without this the client receives the cloaked ("_ide"-suffixed) tool name
 * and rejects the call as an unknown tool. In a Claude SSE stream a tool
 * name appears exactly once per call — on the content_block_start event of
 * a tool_use block; argument deltas carry no name.
 *
 * Falls back to stripping the literal CLAUDE_TOOL_SUFFIX when the name isn't
 * in toolNameMap (map lost across a retry/reconnect), matching the
 * non-streaming decloak behavior. Decoy tool names (real CC tool names) and
 * anything else pass through unchanged.
 *
 * @param {object|null} chunk - Parsed SSE event (may be null on stream flush)
 * @param {Map|null} toolNameMap - Suffixed → original name map from cloakClaudeTools()
 * @returns {object|null} The chunk, with the tool_use name restored when cloaked
 */
export function decloakStreamChunk(chunk, toolNameMap) {
  if (!chunk || typeof chunk !== "object") return chunk;
  if (chunk.type !== "content_block_start") return chunk;
  const block = chunk.content_block;
  if (block?.type !== "tool_use" || typeof block.name !== "string") return chunk;
  const original = toolNameMap?.get(block.name) || stripCloakSuffix(block.name);
  if (!original) return chunk;
  return { ...chunk, content_block: { ...block, name: original } };
}

// CC decoy tools — Claude Code native tool names, marked unavailable
const CC_DECOY_TOOLS = [
  { name: "Task", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskOutput", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskStop", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskCreate", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskGet", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskUpdate", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskList", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Bash", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Glob", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Grep", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Read", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Edit", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Write", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "NotebookEdit", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "WebFetch", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "WebSearch", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "AskUserQuestion", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Skill", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "EnterPlanMode", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "ExitPlanMode", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
];

/**
 * Apply Claude cloaking to request body:
 * 1. Inject billing header as first system block
 * 2. Inject fake user ID into metadata (JSON format, session_id aligned with X-Claude-Code-Session-Id)
 * Only applies when using OAuth token (sk-ant-oat).
 * @param {object} body - Claude API request body
 * @param {string} apiKey - API key or OAuth token
 * @param {string} [sessionId] - Session ID to align with X-Claude-Code-Session-Id header
 * @returns {object} Modified body
 */
export function applyCloaking(body, apiKey, sessionId) {
  if (!isClaudeOAuthToken(apiKey)) return body;

  const result = { ...body };

  // Inject billing header as system[0], preserve existing system blocks
  const billingText = generateBillingHeader(body);
  const billingBlock = { type: "text", text: billingText };

  if (Array.isArray(result.system)) {
    // Skip if already injected
    if (!result.system[0]?.text?.startsWith(BILLING_PREFIX)) {
      result.system = [billingBlock, ...result.system];
    }
  } else if (typeof result.system === "string") {
    result.system = [billingBlock, { type: "text", text: result.system }];
  } else {
    result.system = [billingBlock];
  }

  // Inject fake user ID into metadata (session_id must match X-Claude-Code-Session-Id)
  const existingUserId = result.metadata?.user_id;
  if (!existingUserId) {
    result.metadata = { ...result.metadata, user_id: generateFakeUserID(sessionId, apiKey) };
  }

  return result;
}

/**
 * Bind metadata.user_id to the routed OAuth account, for every Claude path
 * (translated and native passthrough). device_id/account_uuid derive from the
 * connection, never from the client, so accounts behind one gateway share no
 * device identity; the client's session id is scoped to the account so a
 * failover never presents one conversation id from two accounts.
 * Copy-on-write: the input body is reused across retry attempts.
 */
export function bindClaudeOAuthIdentity(body, token, connectionId = null) {
  if (!isClaudeOAuthToken(token) || !body || typeof body !== "object" || !Array.isArray(body.messages)) return body;
  const seed = connectionId ? `connection:${connectionId}` : token;
  const clientSessionId = extractClaudeSessionIdFromUserId(body.metadata?.user_id);
  const sessionId = clientSessionId ? deriveUuid(`session:${seed}:${clientSessionId}`) : null;
  const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
  return { ...body, metadata: { ...metadata, user_id: generateFakeUserID(sessionId, seed) } };
}

// Claude Code pointed at a non-first-party base URL omits cch; the OAuth hop
// restores it, so a billing header without digits gets the placeholder.
export function ensureBillingCchPlaceholder(body) {
  const first = Array.isArray(body?.system) ? body.system[0] : null;
  const text = first?.text;
  if (typeof text !== "string" || !text.startsWith(BILLING_PREFIX) || CCH_DIGITS_RE.test(text)) return body;
  const entrypoint = text.indexOf("cc_entrypoint=");
  const end = entrypoint < 0 ? -1 : text.indexOf(";", entrypoint);
  if (end < 0) return body;
  const withPlaceholder = `${text.slice(0, end + 1)} cch=${CCH_PLACEHOLDER};${text.slice(end + 1)}`;
  return { ...body, system: [{ ...first, text: withPlaceholder }, ...body.system.slice(1)] };
}

const CCH_EXCLUDED_KEYS = new Set(['"max_tokens"', '"fallbacks"', '"fallback_credit_token"']);

// Single pass over serialized JSON: records the hash-view edits (model string
// values emptied, dispatch-only members removed) and the system[0].text range.
class CchScanner {
  constructor(json) {
    this.json = json;
    this.pos = 0;
    this.edits = [];
    this.billing = null;
  }

  ws() {
    const s = this.json;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return;
      this.pos++;
    }
  }

  consume(ch) {
    if (this.json[this.pos] !== ch) return false;
    this.pos++;
    return true;
  }

  // Jump between quotes natively; a quote preceded by an odd backslash run is escaped.
  string() {
    const s = this.json;
    if (s.charCodeAt(this.pos) !== 34) throw new Error(`missing JSON string at ${this.pos}`);
    const start = this.pos;
    let from = start + 1;
    for (;;) {
      const quote = s.indexOf('"', from);
      if (quote < 0) throw new Error(`unterminated JSON string at ${start}`);
      let slashes = 0;
      while (s.charCodeAt(quote - 1 - slashes) === 92) slashes++;
      if ((slashes & 1) === 0) {
        this.pos = quote + 1;
        return [start, this.pos];
      }
      from = quote + 1;
    }
  }

  // target: "top" (root), "system" (top-level system), "system0" (system[0])
  value(collect, target = null) {
    this.ws();
    const c = this.json[this.pos];
    if (c === "{") return this.object(collect, target);
    if (c === "[") return this.array(collect, target);
    if (c === '"') return this.string();
    const start = this.pos;
    for (const s = this.json; this.pos < s.length; this.pos++) {
      const ch = s.charCodeAt(this.pos);
      if (ch === 44 || ch === 125 || ch === 93 || ch === 32 || ch === 9 || ch === 13 || ch === 10) break;
    }
    if (this.pos === start) throw new Error(`missing JSON value at ${start}`);
  }

  array(collect, target) {
    this.pos++;
    this.ws();
    if (this.consume("]")) return;
    for (let index = 0; ; index++) {
      this.value(collect, target === "system" && index === 0 ? "system0" : null);
      this.ws();
      if (this.consume(",")) continue;
      if (!this.consume("]")) throw new Error(`missing array end at ${this.pos}`);
      return;
    }
  }

  object(collect, target) {
    this.pos++;
    this.ws();
    if (this.consume("}")) return;
    const members = [];
    let commaBefore = -1;
    for (;;) {
      this.ws();
      const memberStart = this.pos;
      const [keyStart, keyEnd] = this.string();
      this.ws();
      if (!this.consume(":")) throw new Error(`missing object colon at ${this.pos}`);
      this.ws();
      const key = this.json.slice(keyStart, keyEnd);
      const excluded = collect && CCH_EXCLUDED_KEYS.has(key);
      if (collect && key === '"model"' && this.json[this.pos] === '"') {
        const [valueStart, valueEnd] = this.string();
        if (valueEnd - valueStart > 2) this.edits.push([valueStart + 1, valueEnd - 1]);
      } else if (target === "system0" && key === '"text"' && this.json[this.pos] === '"') {
        this.billing = this.string();
      } else {
        this.value(collect && !excluded, target === "top" && key === '"system"' ? "system" : null);
      }
      const memberEnd = this.pos;
      this.ws();
      const commaAfter = this.consume(",") ? this.pos - 1 : -1;
      members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded });
      if (commaAfter >= 0) { commaBefore = commaAfter; continue; }
      if (!this.consume("}")) throw new Error(`missing object end at ${this.pos}`);
      break;
    }
    if (collect) this.excludeMembers(members);
  }

  excludeMembers(members) {
    for (let start = 0; start < members.length;) {
      if (!members[start].excluded) { start++; continue; }
      let end = start;
      while (end + 1 < members.length && members[end + 1].excluded) end++;
      if (end + 1 < members.length) this.edits.push([members[start].start, members[end].commaAfter + 1]);
      // Claude Code leaves the preceding comma when an object ends with
      // several consecutive dispatch members.
      else if (start > 0 && end > start) this.edits.push([members[start].start, members[end].end]);
      else if (start > 0) this.edits.push([members[start].commaBefore, members[end].end]);
      else this.edits.push([members[start].start, members[end].end]);
      start = end + 1;
    }
  }
}

/**
 * Fill the billing header's cch with Claude Code's final-body integrity token:
 * xxHash64(seed) of the serialized body with cch=00000, model values emptied and
 * max_tokens/fallbacks/fallback_credit_token members removed, masked to 20 bits.
 * Changes only the five digits; any body without a signable header is returned as-is.
 */
export function signClaudeBody(json) {
  if (typeof json !== "string" || !json.includes(BILLING_PREFIX)) return json;
  const scanner = new CchScanner(json);
  try {
    scanner.value(true, "top");
  } catch {
    return json;
  }
  if (!scanner.billing) return json;
  const [rawStart, rawEnd] = scanner.billing;
  if (!json.startsWith(BILLING_PREFIX, rawStart + 1)) return json;
  const raw = json.slice(rawStart, rawEnd);
  const match = CCH_DIGITS_RE.exec(raw);
  if (!match) return json;
  const offset = rawStart + match.index + "cch=".length;
  const unsigned = `${json.slice(0, offset)}${CCH_PLACEHOLDER}${json.slice(offset + CCH_PLACEHOLDER.length)}`;

  const edits = scanner.edits.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let last = 0;
  for (const [start, end] of edits) {
    if (start < last) return json;
    parts.push(unsigned.slice(last, start));
    last = end;
  }
  parts.push(unsigned.slice(last));
  const cch = (Bun.hash.xxHash64(parts.join(""), CCH_SEED) & 0xFFFFFn).toString(16).padStart(5, "0");
  return `${json.slice(0, offset)}${cch}${json.slice(offset + CCH_PLACEHOLDER.length)}`;
}
