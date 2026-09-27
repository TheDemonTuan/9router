import { ROLE } from "../translator/schema/roles.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { RTK_CONFIG, RTK_FILTERS } from "../config/rtkConfig.js";
import { estimateOutputTokens } from "../utils/usageTracking.js";
import { getRtkState } from "./state.js";
import { classifyToolCall } from "./classifier.js";
import { filterToolOutput } from "./client.js";

function collect(body, visit) {
  const shapes = [body.conversationState, body.request?.contents, body.contents, body.messages, body.input].filter(x => Array.isArray(x) ? x.length : Boolean(x));
  if (shapes.length !== 1) return false;
  const calls = new Map();
  const duplicates = new Set();
  const names = new Map();
  function add(id, name, input, byName = false) {
    if (typeof name !== "string") return;
    if (id != null && (typeof id !== "string" || !id)) return;
    const call = { name, input, id };
    if (typeof id === "string") {
      if (calls.has(id)) { duplicates.add(id); calls.get(id).ambiguous = true; }
      else calls.set(id, call);
    } else if (byName) names.set(name, names.has(name) ? null : call);
  }
  function match(id, name, byName = false) {
    if (id != null) return typeof id === "string" && id && !duplicates.has(id) ? calls.get(id) : null;
    if (!byName) return null;
    const call = names.get(name);
    names.set(name, null);
    return call;
  }
  function leaf(owner, key, shape, call, skip) {
    if (typeof owner?.[key] === "string") visit(owner, key, shape, call, skip);
  }
  function parts(owner, key, type, shape, call, skip) {
    if (typeof owner?.[key] === "string") leaf(owner, key, shape, call, skip);
    else if (Array.isArray(owner?.[key])) for (const part of owner[key]) if (part?.type === type) leaf(part, "text", shape === "claude-string" ? "claude-array" : shape + "-array", call, skip);
  }
  if (body.conversationState) {
    const state = body.conversationState;
    const items = [...(Array.isArray(state.history) ? state.history : []), ...(state.currentMessage ? [state.currentMessage] : [])];
    for (const item of items) {
      for (const use of item?.assistantResponseMessage?.toolUses ?? []) add(use?.toolUseId, use?.name, use?.input);
      for (const result of item?.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        const call = match(result?.toolUseId);
        for (const part of result?.content ?? []) leaf(part, "text", "kiro-tool-result", call, result.status === "error" || result.is_error === true);
      }
    }
  } else if (body.request?.contents || body.contents) {
    const items = body.request?.contents ?? body.contents;
    const shape = body.request?.contents ? "antigravity-tool-result" : "gemini-tool-result";
    for (const item of items) for (const part of item?.parts ?? []) {
      const callPart = part?.functionCall;
      if (callPart) add(callPart.id, callPart.name, callPart.args, true);
      const response = part?.functionResponse;
      if (!response) continue;
      const call = match(response.id, response.name, true);
      const skip = response.is_error === true || response.status === "error" || response.response?.error != null;
      if (typeof response.response === "string") leaf(response, "response", shape, call, skip);
      else for (const key of ["result", "output", "content"]) leaf(response.response, key, shape, call, skip);
    }
  } else if (Array.isArray(body.messages)) {
    for (const item of body.messages) {
      if (item?.role === ROLE.ASSISTANT) {
        for (const call of item.tool_calls ?? []) add(call?.id, call?.function?.name, call?.function?.arguments);
        for (const block of Array.isArray(item.content) ? item.content : []) if (block?.type === CLAUDE_BLOCK.TOOL_USE) add(block.id, block.name, block.input);
      }
      if (item?.role === ROLE.TOOL) parts(item, "content", OPENAI_BLOCK.TEXT, "openai-tool", match(item.tool_call_id), item.is_error === true || item.status === "error");
      else for (const block of Array.isArray(item?.content) ? item.content : []) {
        if (block?.type !== CLAUDE_BLOCK.TOOL_RESULT) continue;
        parts(block, "content", CLAUDE_BLOCK.TEXT, "claude-string", match(block.tool_use_id), block.is_error === true || block.status === "error");
      }
    }
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item?.type)) add(item.call_id, item.name, item.arguments ?? item.input);
      if (![RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(item?.type)) continue;
      parts(item, "output", RESPONSES_ITEM.INPUT_TEXT, "openai-responses-string", match(item.call_id), item.is_error === true || item.status === "error");
    }
  }
  return true;
}

export async function compressMessages(body, enabled, { signal, disabledReason = "disabled" } = {}) {
  const usage = getRtkState().usage;
  usage.preparations++;
  if (!enabled) {
    usage.preparationReasons[["opted_out", "structured_output", "native_passthrough"].includes(disabledReason) ? disabledReason : "disabled"]++;
    return null;
  }
  if (!body || typeof body !== "object") { usage.preparationReasons.unsupported_shape++; return null; }
  if (signal?.aborted) { usage.preparationReasons.cancelled++; throw signal.reason; }
  const deadline = performance.now() + RTK_CONFIG.requestMs;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("RTK timeout"), { code: "RTK_TIMEOUT" })), RTK_CONFIG.requestMs);
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const jobs = [];
  let selected = 0;
  let eligibleJobs = 0;
  let reason;
  const commit = () => {
    usage.preparationReasons[reason ?? (stats.hits.length ? "compressed" : eligibleJobs ? "no_change" : "no_eligible_output")]++;
    if (!stats.hits.length) return;
    usage.compressedPreparations++;
    usage.appliedOutputs += stats.hits.length;
    usage.lastAppliedAt = new Date().toISOString();
    for (const hit of stats.hits) {
      usage.bytesBefore += hit.bytesBefore;
      usage.bytesAfter += hit.bytesAfter;
      usage.estimatedTokensSaved += hit.estimatedTokensSaved;
      if (RTK_FILTERS.includes(hit.filter)) {
        const row = usage.filters[hit.filter] ??= { filter: hit.filter, appliedOutputs: 0, bytesBefore: 0, bytesAfter: 0, estimatedTokensSaved: 0 };
        row.appliedOutputs++;
        row.bytesBefore += hit.bytesBefore;
        row.bytesAfter += hit.bytesAfter;
        row.estimatedTokensSaved += hit.estimatedTokensSaved;
      }
    }
  };
  try {
    const supported = collect(body, (owner, key, shape, call, skip) => {
      if (performance.now() >= deadline || controller.signal.aborted) return;
      const content = owner[key];
      const size = Buffer.byteLength(content);
      stats.bytesBefore += size;
      stats.bytesAfter += size;
      if (skip || size < RTK_CONFIG.minTextBytes || size > RTK_CONFIG.maxTextBytes || selected + size > RTK_CONFIG.maxSelectedBytes) return;
      const filter = classifyToolCall(call, content);
      if (!filter) return;
      selected += size;
      jobs.push({ owner, key, content, size, shape, filter, call });
    });
    if (!supported) { reason = "unsupported_shape"; return null; }
    let next = 0;
    async function worker() {
      while (next < jobs.length && !combined.aborted && performance.now() < deadline) {
        const job = jobs[next++];
        if (job.call?.ambiguous) continue;
        eligibleJobs++;
        const output = await filterToolOutput({ filter: job.filter, content: job.content, signal: combined, internalSignal: controller.signal });
        if (signal?.aborted) throw signal.reason;
        if (combined.aborted || output === null) continue;
        const size = Buffer.byteLength(output);
        job.owner[job.key] = output;
        stats.bytesAfter -= job.size - size;
        stats.hits.push({ shape: job.shape, filter: job.filter, saved: job.size - size, bytesBefore: job.size, bytesAfter: size, estimatedTokensSaved: Math.max(0, estimateOutputTokens(job.content.length) - estimateOutputTokens(output.length)) });
      }
    }
    await Promise.all(Array.from({ length: Math.min(RTK_CONFIG.perRequestConcurrency, jobs.length) }, worker));
    if (signal?.aborted) throw signal.reason;
    return stats;
  } catch (err) {
    if (signal?.aborted) { reason = "cancelled"; throw signal.reason; }
    if (controller.signal.aborted) { reason = "timeout"; return stats; }
    reason = "failed";
    throw err;
  } finally {
    if (signal?.aborted) usage.preparationReasons.cancelled++;
    else if (reason === "failed") usage.preparationReasons.failed++;
    else { if (controller.signal.aborted) reason = "timeout"; commit(); }
    clearTimeout(timer);
    controller.abort(Object.assign(new Error("RTK finished"), { code: "RTK_TIMEOUT" }));
  }
}

export function formatRtkLog(stats) {
  if (!stats?.hits?.length) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
