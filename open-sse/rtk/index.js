import { ROLE } from "../translator/schema/roles.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { RTK_CONFIG, RTK_FILTERS, RTK_LOCAL_FILTERS } from "../config/rtkConfig.js";
import { estimateOutputTokens } from "../utils/usageTracking.js";
import { getRtkState, recordRtkRejection, recordRtkFilterOutcome } from "./state.js";
import { classifyToolCall, getRtkToolFamily } from "./classifier.js";
import { filterToolOutput } from "./client.js";
import { filterLocalOutput } from "./local.js";

function collect(body, visit, eligibility) {
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
    if (typeof owner?.[key] !== "string") return 0;
    eligibility.textLeaves++;
    visit(owner, key, shape, call, skip || owner.cache_control != null && "cache_marker");
    return 1;
  }
  function parts(owner, key, type, shape, call, skip) {
    const reason = skip || owner?.cache_control != null && "cache_marker";
    if (typeof owner?.[key] === "string") return leaf(owner, key, shape, call, reason);
    let count = 0;
    if (Array.isArray(owner?.[key])) for (const part of owner[key]) if (part?.type === type) count += leaf(part, "text", shape === "claude-string" ? "claude-array" : shape + "-array", call, reason);
    return count;
  }
  function result(leaves) {
    eligibility.toolResults++;
    if (!leaves) eligibility.resultsWithoutText++;
  }
  if (body.conversationState) {
    const state = body.conversationState;
    const items = [...(Array.isArray(state.history) ? state.history : []), ...(state.currentMessage ? [state.currentMessage] : [])];
    for (const item of items) {
      for (const use of item?.assistantResponseMessage?.toolUses ?? []) add(use?.toolUseId, use?.name, use?.input);
      for (const itemResult of item?.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        const call = match(itemResult?.toolUseId);
        let leaves = 0;
        for (const part of itemResult?.content ?? []) leaves += leaf(part, "text", "kiro-tool-result", call, itemResult.status === "error" || itemResult.is_error === true || itemResult.cache_control != null && "cache_marker");
        result(leaves);
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
      const skip = response.is_error === true || response.status === "error" || response.response?.error != null || part.cache_control != null && "cache_marker";
      if (typeof response.response === "string") result(leaf(response, "response", shape, call, skip));
      else {
        let leaves = 0;
        for (const key of ["result", "output", "content"]) leaves += leaf(response.response, key, shape, call, skip);
        result(leaves);
      }
    }
  } else if (Array.isArray(body.messages)) {
    for (const item of body.messages) {
      if (item?.role === ROLE.ASSISTANT) {
        for (const call of item.tool_calls ?? []) add(call?.id, call?.function?.name, call?.function?.arguments);
        for (const block of Array.isArray(item.content) ? item.content : []) if (block?.type === CLAUDE_BLOCK.TOOL_USE) add(block.id, block.name, block.input);
      }
      if (item?.role === ROLE.TOOL) result(parts(item, "content", OPENAI_BLOCK.TEXT, "openai-tool", match(item.tool_call_id), item.is_error === true || item.status === "error"));
      else for (const block of Array.isArray(item?.content) ? item.content : []) {
        if (block?.type !== CLAUDE_BLOCK.TOOL_RESULT) continue;
        result(parts(block, "content", CLAUDE_BLOCK.TEXT, "claude-string", match(block.tool_use_id), block.is_error === true || block.status === "error"));
      }
    }
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item?.type)) add(item.call_id, item.name, item.arguments ?? item.input);
      if (![RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(item?.type)) continue;
      result(parts(item, "output", RESPONSES_ITEM.INPUT_TEXT, "openai-responses-string", match(item.call_id), item.is_error === true || item.status === "error"));
    }
  }
  return true;
}

export async function compressMessages(body, enabled, { signal, disabledReason = "disabled", getProtectionReason } = {}) {
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
      if (RTK_FILTERS.includes(hit.filter) || RTK_LOCAL_FILTERS.includes(hit.filter)) {
        const row = usage.filters[hit.filter] ??= { filter: hit.filter, appliedOutputs: 0, bytesBefore: 0, bytesAfter: 0, estimatedTokensSaved: 0, engines: { sidecar: 0, local: 0 } };
        row.appliedOutputs++;
        row.engines[hit.engine]++;
        row.bytesBefore += hit.bytesBefore;
        row.bytesAfter += hit.bytesAfter;
        row.estimatedTokensSaved += hit.estimatedTokensSaved;
      }
    }
  };
  try {
    const resultsBefore = usage.eligibility.toolResults;
    const supported = collect(body, (owner, key, shape, call, skip) => {
      if (performance.now() >= deadline || controller.signal.aborted) return;
      const protection = getProtectionReason?.(owner, key);
      if (protection) {
        usage.eligibility.rejected[protection]++;
        return;
      }
      const content = owner[key];
      const size = Buffer.byteLength(content);
      stats.bytesBefore += size;
      stats.bytesAfter += size;
      const toolFamily = getRtkToolFamily(call);
      if (skip) {
        const skipRejection = skip === "cache_marker" ? "cache_marker" : "error_result";
        usage.eligibility.rejected[skipRejection]++;
        recordRtkRejection(toolFamily, skipRejection, "none", size);
        return;
      }
      if (size < RTK_CONFIG.minTextBytes) {
        usage.eligibility.rejected.below_min_bytes++;
        recordRtkRejection(toolFamily, "below_min_bytes", "none", size);
        return;
      }
      if (size > RTK_CONFIG.maxTextBytes) {
        usage.eligibility.rejected.above_max_bytes++;
        recordRtkRejection(toolFamily, "above_max_bytes", "none", size);
        return;
      }
      if (selected + size > RTK_CONFIG.maxSelectedBytes) {
        usage.eligibility.rejected.selection_budget++;
        recordRtkRejection(toolFamily, "selection_budget", "none", size);
        return;
      }
      const filter = classifyToolCall(call, content, (reason, detail = "none") => {
        usage.eligibility.rejected[reason]++;
        recordRtkRejection(toolFamily, reason, detail, size);
      });
      if (!filter) return;
      selected += size;
      jobs.push({ owner, key, content, size, shape, filter, call, toolFamily });
    }, usage.eligibility);
    if (!supported) { reason = "unsupported_shape"; return null; }
    if (usage.eligibility.toolResults === resultsBefore && performance.now() < deadline && !combined.aborted) usage.eligibility.noToolResultsPreparations++;
    let next = 0;
    async function worker() {
      while (next < jobs.length && !combined.aborted && performance.now() < deadline) {
        const job = jobs[next++];
        if (job.call?.ambiguous) {
          usage.eligibility.rejected.unlinked_call++;
          recordRtkRejection("unlinked", "unlinked_call", "none", job.size);
          continue;
        }
        eligibleJobs++;
        const local = job.filter.startsWith("local:");
        const toolFamily = job.toolFamily ?? getRtkToolFamily(job.call);
        let output = null;
        if (local) {
          usage.local.attempts++;
          let rawOutcome = null;
          let rawBytes = 0;
          let finalOutcome = null;
          try {
            output = filterLocalOutput(job.filter.slice(6), job.content, (resOutcome, resBytes) => {
              rawOutcome = resOutcome;
              rawBytes = resBytes;
            });
            finalOutcome = rawOutcome;
            if (signal?.aborted) {
              if (rawOutcome === "candidate") finalOutcome = "discarded_cancelled";
              throw signal.reason;
            }
            if (performance.now() >= deadline && !controller.signal.aborted) {
              controller.abort(Object.assign(new Error("RTK timeout"), { code: "RTK_TIMEOUT" }));
            }
            if (combined.aborted && rawOutcome === "candidate") {
              finalOutcome = signal?.aborted ? "discarded_cancelled" : "discarded_deadline";
            }
            if (!combined.aborted && output !== null) {
              const size = Buffer.byteLength(output);
              if (size && size < job.size) {
                job.owner[job.key] = output;
                finalOutcome = "applied";
                usage.local.applied++;
                stats.bytesAfter -= job.size - size;
                stats.hits.push({
                  shape: job.shape,
                  filter: job.filter,
                  engine: "local",
                  saved: job.size - size,
                  bytesBefore: job.size,
                  bytesAfter: size,
                  estimatedTokensSaved: Math.max(0, estimateOutputTokens(job.content.length) - estimateOutputTokens(output.length)),
                });
              }
            }
          } finally {
            recordRtkFilterOutcome(toolFamily, job.filter, "local", false, finalOutcome ?? rawOutcome, job.size, rawBytes);
          }
        } else {
          let sidecarRawOutcome = null;
          let sidecarRawBytes = 0;
          let sidecarFinalOutcome = null;
          try {
            output = await filterToolOutput({
              filter: job.filter,
              content: job.content,
              signal: combined,
              internalSignal: controller.signal,
              onOutcome: (resOutcome, resBytes) => {
                sidecarRawOutcome = resOutcome;
                sidecarRawBytes = resBytes;
              },
            });
            sidecarFinalOutcome = sidecarRawOutcome;
            if (signal?.aborted) {
              if (sidecarRawOutcome === "candidate") sidecarFinalOutcome = "discarded_cancelled";
              throw signal.reason;
            }
            if (performance.now() >= deadline && !controller.signal.aborted) {
              controller.abort(Object.assign(new Error("RTK timeout"), { code: "RTK_TIMEOUT" }));
            }
            if (combined.aborted && sidecarRawOutcome === "candidate") {
              sidecarFinalOutcome = signal?.aborted ? "discarded_cancelled" : "discarded_deadline";
            }
            if (!combined.aborted && output !== null) {
              const size = Buffer.byteLength(output);
              if (size && size < job.size) {
                job.owner[job.key] = output;
                sidecarFinalOutcome = "applied";
                stats.bytesAfter -= job.size - size;
                stats.hits.push({
                  shape: job.shape,
                  filter: job.filter,
                  engine: "sidecar",
                  saved: job.size - size,
                  bytesBefore: job.size,
                  bytesAfter: size,
                  estimatedTokensSaved: Math.max(0, estimateOutputTokens(job.content.length) - estimateOutputTokens(output.length)),
                });
              }
            }
          } finally {
            recordRtkFilterOutcome(toolFamily, job.filter, "sidecar", false, sidecarFinalOutcome ?? sidecarRawOutcome, job.size, sidecarRawBytes);
          }
          if (output === null && !combined.aborted && ["grep", "git-status"].includes(job.filter)) {
            usage.local.attempts++;
            let fallbackRawOutcome = null;
            let fallbackRawBytes = 0;
            let fallbackFinalOutcome = null;
            let fallbackOutput = null;
            try {
              fallbackOutput = filterLocalOutput(job.filter, job.content, (resOutcome, resBytes) => {
                fallbackRawOutcome = resOutcome;
                fallbackRawBytes = resBytes;
              });
              fallbackFinalOutcome = fallbackRawOutcome;
              if (signal?.aborted) {
                if (fallbackRawOutcome === "candidate") fallbackFinalOutcome = "discarded_cancelled";
                throw signal.reason;
              }
              if (performance.now() >= deadline && !controller.signal.aborted) {
                controller.abort(Object.assign(new Error("RTK timeout"), { code: "RTK_TIMEOUT" }));
              }
              if (combined.aborted && fallbackRawOutcome === "candidate") {
                fallbackFinalOutcome = signal?.aborted ? "discarded_cancelled" : "discarded_deadline";
              }
              if (!combined.aborted && fallbackOutput !== null) {
                const size = Buffer.byteLength(fallbackOutput);
                if (size && size < job.size) {
                  job.owner[job.key] = fallbackOutput;
                  fallbackFinalOutcome = "applied";
                  usage.local.applied++;
                  usage.local.fallbacks++;
                  stats.bytesAfter -= job.size - size;
                  stats.hits.push({
                    shape: job.shape,
                    filter: job.filter,
                    engine: "local",
                    saved: job.size - size,
                    bytesBefore: job.size,
                    bytesAfter: size,
                    estimatedTokensSaved: Math.max(0, estimateOutputTokens(job.content.length) - estimateOutputTokens(fallbackOutput.length)),
                  });
                }
              }
            } finally {
              recordRtkFilterOutcome(toolFamily, job.filter, "local", true, fallbackFinalOutcome ?? fallbackRawOutcome, job.size, fallbackRawBytes);
            }
          }
        }
        if (signal?.aborted) throw signal.reason;
        if (performance.now() >= deadline && !controller.signal.aborted) controller.abort(Object.assign(new Error("RTK timeout"), { code: "RTK_TIMEOUT" }));
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
