import { createHash } from "node:crypto";
import { TOKEN_SAVER_CONFIG as LIMIT, normalizeSessionDedupMode } from "../config/tokenSaverConfig.js";
import { estimateOutputTokens } from "../utils/usageTracking.js";
import { FORMATS } from "../translator/formats.js";
import { inspectSource } from "./sourceWalker.js";
import { detectCacheFence } from "./cacheFence.js";
import { sanitizeGeminiFunctionName } from "../translator/request/openai-to-gemini.js";
import { RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { inspectToolOutput, replaceToolOutputBody, preservesToolOutput } from "./toolOutput.js";

const markerPattern = /^\[9router dedup:v1 this tool result is byte-identical to an earlier preserved result from the same tool family in this request; bytes=(\d+); sha256=([0-9a-f]{64})\]$/;
const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const markerFor = (bytes, digest) => `[9router dedup:v1 this tool result is byte-identical to an earlier preserved result from the same tool family in this request; bytes=${bytes}; sha256=${digest}]`;
const bodyMarkerFor = (bytes, digest) => `[9router dedup:v2 this tool body is byte-identical to an earlier preserved body from the same tool family and adapter in this request; bytes=${bytes}; sha256=${digest}]`;
const bodyMarkerPattern = /^\[9router dedup:v2 this tool body is byte-identical to an earlier preserved body from the same tool family and adapter in this request; bytes=(\d+); sha256=([0-9a-f]{64})\]$/;
const gemini = format => [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY].includes(format);
const responses = format => [FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE, FORMATS.CODEX].includes(format);
function protect(map, result, reason) {
  const keys = map.get(result.owner) ?? new Map();
  keys.set(result.key, reason);
  map.set(result.owner, keys);
}
function reasonFor(result, sourceIndex) {
  if (result.opaqueProtected) return "opaque";
  if (result.cacheProtected) return "cacheFence";
  if (result.blockedReason === "current") return "current";
  if (result.isError) return "error";
  if (result.blockedReason) return result.blockedReason;
  if (sourceIndex.currentTurnIndex < 0 || result.turnIndex < 0) return "unknown_turn";
  if (result.batchIndex == null || !sourceIndex.toolBatches[result.batchIndex]?.completed) return "incompleteBatch";
  if (result.turnIndex < sourceIndex.currentTurnIndex && result.isRecentTurn) return "recent";
  if (result.turnIndex === sourceIndex.currentTurnIndex && result.isRecentToolBatch) return "current";
  return null;
}

const maxMarkerLen = Math.max(markerFor(LIMIT.maxResultBytes, "0".repeat(64)).length, bodyMarkerFor(LIMIT.maxResultBytes, "0".repeat(64)).length);
function hasBodyMarker(text, call) {
  const max = LIMIT.maxToolEnvelopeChars + maxMarkerLen;
  if (typeof text !== "string") return false;
  if (text.length <= max) {
    const descriptor = inspectToolOutput(text, call);
    if (descriptor && bodyMarkerPattern.test(text.slice(descriptor.bodyStart, descriptor.bodyEnd))) return true;
  }
  // Only the exact single-input_text codec emitted by bridgeText, bounded before parsing.
  // Recognition disables savers; this never unwraps JSON for compression or equality.
  if (text[0] !== "[" || text.length > 6 * max + 128) return false;
  try {
    const parts = JSON.parse(text);
    if (!Array.isArray(parts) || parts.length !== 1 || parts[0]?.type !== RESPONSES_ITEM.INPUT_TEXT ||
      Object.keys(parts[0]).length !== 2 || typeof parts[0].text !== "string" || parts[0].text.length > max ||
      JSON.stringify(parts) !== text) return false;
    const descriptor = inspectToolOutput(parts[0].text, call);
    return !!descriptor && bodyMarkerPattern.test(parts[0].text.slice(descriptor.bodyStart, descriptor.bodyEnd));
  } catch { return false; }
}
function hasWellFormedMarker(sourceIndex) {
  for (const r of sourceIndex.results) {
    if (typeof r.text === "string" && r.text.length <= maxMarkerLen && markerPattern.test(r.text)) return true;
    if (hasBodyMarker(r.text, sourceIndex.calls[r.callOrdinal])) return true;
    const geminiLeaf = r.resultContainer?.response?.result?.result;
    if (typeof geminiLeaf === "string" && geminiLeaf.length <= maxMarkerLen && markerPattern.test(geminiLeaf)) return true;
    if (hasBodyMarker(geminiLeaf, sourceIndex.calls[r.callOrdinal])) return true;
  }
  for (const seg of sourceIndex.textSegments) {
    if (seg.kind === "result_text" && typeof seg.text === "string" && seg.text.length <= maxMarkerLen && markerPattern.test(seg.text)) return true;
  }
  return false;
}

export function planSessionDedup(sourceIndex, { mode = "off", fence, signal } = {}) {
  mode = normalizeSessionDedupMode(mode);
  const stats = {
    scannedResults: sourceIndex?.results ? sourceIndex.results.length : 0,
    scannedBytes: 0,
    eligibleResults: 0,
    exactDuplicatesFound: 0,
    rawExactDuplicatesFound: 0,
    bodyExactDuplicatesFound: 0,
    envelopeRejected: 0,
    plannedResults: 0,
    plannedSaveBytes: 0,
    wouldDedupResults: 0,
    wouldSaveBytes: 0,
    crossFamilyDuplicates: 0,
    hashedResults: 0,
    intraTurnEligibleResults: 0,
    intraTurnDuplicatesFound: 0,
    budgetStoppedPreparations: 0,
    protected: { current: 0, recent: 0, error: 0, cacheFence: 0, opaque: 0, incompleteBatch: 0 },
    skipped: {},
  };
  const plan = { mode, stats, protection: new WeakMap(), replacements: [], hasExistingMarkers: false, skipReason: null };
  if (!sourceIndex?.supported || fence?.protectAll && fence?.reason === "opaque_state") return plan;
  if (sourceIndex.blockedReason) {
    plan.skipReason = sourceIndex.blockedReason;
    return plan;
  }

  if (hasWellFormedMarker(sourceIndex)) {
    plan.hasExistingMarkers = true;
    plan.skipReason = "existing_marker";
    stats.skipped.existing_marker = 1;
    return plan;
  }

  if (mode === "off") return plan;
  const canonical = new Map();
  const bodyCanonical = new Map();
  const cross = new Map();
  let entries = 0;
  const stop = reason => {
    plan.skipReason = reason;
    stats.budgetStoppedPreparations++;
    stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
    plan.replacements.length = 0;
    plan.protection = new WeakMap();
    stats.plannedResults = stats.plannedSaveBytes = 0;
    stats.wouldDedupResults = stats.wouldSaveBytes = 0;
  };
  for (let i = 0; i < sourceIndex.results.length; i++) {
    if (signal?.aborted) throw signal.reason;
    const result = sourceIndex.results[i];
    const reason = reasonFor(result, sourceIndex);
    if (reason) {
      const bucket = reason in stats.protected ? stats.protected : stats.skipped;
      bucket[reason] = (bucket[reason] || 0) + 1;
    }
    if (reason && reason !== "cacheFence") continue;
    if (result.text === null || !result.toolFamily) {
      if (!reason) stats.skipped.structured_result = (stats.skipped.structured_result || 0) + 1;
      continue;
    }
    const text = result.text;
    if (text.startsWith("[9router dedup:v1 ") || text.startsWith("[9router dedup:v2 ")) continue;
    if (reason && reason !== "cacheFence") continue;
    if (text.length > LIMIT.maxResultBytes) {
      if (!reason) stats.skipped.above_max_bytes = (stats.skipped.above_max_bytes || 0) + 1;
      continue;
    }
    const size = Buffer.byteLength(text, "utf8");
    if (size > LIMIT.maxResultBytes) {
      if (!reason) stats.skipped.above_max_bytes = (stats.skipped.above_max_bytes || 0) + 1;
      continue;
    }
    if (size < LIMIT.minResultBytes) {
      if (!reason) stats.skipped.below_min_bytes = (stats.skipped.below_min_bytes || 0) + 1;
      continue;
    }
    if (stats.scannedBytes + size > LIMIT.maxScanBytes) {
      stop("scan_budget");
      break;
    }
    stats.scannedBytes += size;
    if (!text.isWellFormed() || preservesToolOutput(text)) continue;
    let envelopeRejected = false;
    const descriptor = inspectToolOutput(text, sourceIndex.calls[result.callOrdinal], () => { envelopeRejected = true; stats.envelopeRejected++; });
    if (envelopeRejected) continue;
    const extracted = descriptor ? text.slice(descriptor.bodyStart, descriptor.bodyEnd) : null;
    const bodyBytes = descriptor ? Buffer.byteLength(extracted) : 0;
    stats.hashedResults++;
    const digest = hash(text);
    const key = `${result.toolFamily}:${size}:${digest}`;
    const prev = canonical.get(key);
    if (prev?.ambiguous) {
      stats.skipped.hash_collision = (stats.skipped.hash_collision || 0) + 1;
      continue;
    }
    if (prev && prev.result.text !== text) {
      prev.ambiguous = true;
      stats.skipped.hash_collision = (stats.skipped.hash_collision || 0) + 1;
      continue;
    }
    if (!prev) {
      if (entries >= LIMIT.maxEntries) {
        stop("entry_budget");
        break;
      }
      canonical.set(key, { result, index: i });
      entries++;
    }
    let bodyPrev = null;
    let bodyDigest = null;
    if (descriptor && bodyBytes >= LIMIT.minResultBytes && !prev) {
      bodyDigest = hash(extracted);
      const bodyKey = `${result.toolFamily}:${descriptor.kind}:${bodyBytes}:${bodyDigest}`;
      bodyPrev = bodyCanonical.get(bodyKey);
      if (bodyPrev?.ambiguous || bodyPrev && bodyPrev.text !== extracted) {
        if (bodyPrev) bodyPrev.ambiguous = true;
        stats.skipped.hash_collision = (stats.skipped.hash_collision || 0) + 1;
        continue;
      }
      if (!bodyPrev && !prev) bodyCanonical.set(bodyKey, { result, index: i, text: extracted, descriptor });
    }
    if (!reason) {
      stats.eligibleResults++;
      if (result.turnIndex === sourceIndex.currentTurnIndex) {
        stats.intraTurnEligibleResults++;
      }
    }
    const others = cross.get(`${size}:${digest}`);
    if (others && others.family !== result.toolFamily && others.text === text) {
      stats.crossFamilyDuplicates++;
    } else if (!others) {
      cross.set(`${size}:${digest}`, { family: result.toolFamily, text });
    }
    if (reason || !prev && !bodyPrev) continue;
    stats.exactDuplicatesFound++;
    if (prev) stats.rawExactDuplicatesFound++;
    else stats.bodyExactDuplicatesFound++;
    if (result.turnIndex === sourceIndex.currentTurnIndex) stats.intraTurnDuplicatesFound++;
    const matchKind = prev ? "raw" : "body";
    const anchor = prev ?? bodyPrev;
    const bodyMarker = matchKind === "body" ? bodyMarkerFor(bodyBytes, bodyDigest) : null;
    const marker = bodyMarker ? replaceToolOutputBody(text, descriptor, bodyMarker) : markerFor(size, digest);
    const markerBytes = Buffer.byteLength(marker);
    if (markerBytes >= size) continue;
    // A body target is not a preserved raw anchor for subsequent carriers.
    if (matchKind === "body") { canonical.delete(key); entries--; }
    const ref = {
      matchKind,
      adapterKind: descriptor?.kind,
      bodyText: matchKind === "body" ? extracted : null,
      bodyBytes,
      anchorOriginalText: anchor.result.text,
      anchorResultIndex: anchor.index,
      resultIndex: i,
      originalText: text,
      originalBytes: size,
      marker,
      markerBytes,
      digest: bodyDigest ?? digest,
    };
    plan.replacements.push(ref);
    const saved = size - markerBytes;
    stats.plannedResults++;
    stats.plannedSaveBytes += saved;
    stats.wouldDedupResults++;
    stats.wouldSaveBytes += saved;
  }
  if (mode === "on") {
    for (const ref of plan.replacements) {
      protect(plan.protection, sourceIndex.results[ref.anchorResultIndex], "dedup_anchor");
      protect(plan.protection, sourceIndex.results[ref.resultIndex], "dedup_candidate");
    }
  }
  return plan;
}

// Codec operates only on a typed result already linked to a source call.
function bridgeText(result, text) {
  if (gemini(result.format)) {
    const response = result.resultContainer.response;
    const value = typeof response === "string" ? text : { ...response, [result.key]: text };
    return JSON.stringify(typeof value === "object" && value?.result ? value.result : value || {});
  }
  if (result.representation === "single_text" && [RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(result.resultContainer?.type))
    return JSON.stringify([{ type: RESPONSES_ITEM.INPUT_TEXT, text }]);
  if (result.format === FORMATS.OPENAI && result.representation === "single_text") return text;
  return text;
}
function selectedLeaf(source, target, text, sourceFormat, finalFormat) {
  if (sourceFormat === finalFormat) return { expected: text, owner: target.owner, key: target.key };
  const bridge = bridgeText(source, text);
  if (gemini(finalFormat)) {
    // openai→gemini preserves a plain, non-JSON tool output in response.result.result.
    if (gemini(sourceFormat)) return null;
    if (bridge !== text || typeof text !== "string") return null;
    const nested = target.resultContainer?.response?.result;
    return typeof nested?.result === "string" ? { expected: text, owner: nested, key: "result" } : null;
  }
  if (gemini(sourceFormat) || (responses(sourceFormat) || [RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(source.resultContainer?.type)) && !responses(finalFormat)) {
    return { expected: bridge, owner: target.owner, key: target.key };
  }
  return { expected: text, owner: target.owner, key: target.key };
}
const writable = (owner, key) => {
  if (!owner || Object.getPrototypeOf(owner) !== Object.prototype) return false;
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return !!descriptor && Object.hasOwn(descriptor, "value") && descriptor.writable;
};
export function commitSessionDedup(body, {
  sourceFormat,
  finalFormat,
  targetModel,
  sourceIndex,
  plan,
  toolNameMap,
  customToolNames,
  signal,
  finalIndex: providedFinalIndex,
  finalFence: providedFinalFence,
} = {}) {
  const zero = (reason, detail = null) => ({ appliedResults: 0, bytesSaved: 0, estimatedTokensSaved: 0, bodyAppliedResults: 0, bodyAppliedSaveBytes: 0, retainedReferences: 0, skipReason: reason, skipDetail: detail });
  if (signal?.aborted) throw signal.reason;
  if (plan?.mode !== "on" || !plan.replacements.length) return zero(null);

  const final = (providedFinalIndex && providedFinalIndex.body === body && providedFinalIndex.format === finalFormat)
    ? providedFinalIndex
    : inspectSource(body, finalFormat);
  const fence = (providedFinalIndex && providedFinalIndex.body === body && providedFinalIndex.format === finalFormat && providedFinalFence)
    ? providedFinalFence
    : detectCacheFence(body, final, { targetFormat: finalFormat, targetModel });

  const reject = (reason, detail = null) => zero(reason, detail);
  if (!final.supported) return reject("final_correspondence", "unsupported_final");
  if (final.calls.length !== sourceIndex.calls.length) return reject("final_correspondence", "call_count");
  if (final.results.length !== sourceIndex.results.length) return reject("final_correspondence", "result_count");
  const mapping = toolNameMap && typeof toolNameMap === "object" ? toolNameMap : {};
  const sanitized = new Map();
  for (let i = 0; i < final.calls.length; i++) {
    const a = sourceIndex.calls[i], b = final.calls[i];
    const mapped = mapping instanceof Map ? mapping.get(b.name) ?? b.name : mapping[b.name] ?? b.name;
    const expected = gemini(finalFormat) && !gemini(sourceFormat) ? sanitizeGeminiFunctionName(a.name) : a.name;
    if (gemini(finalFormat) && sanitized.has(expected) && sanitized.get(expected) !== a.name) return reject("final_correspondence", "call_identity");
    sanitized.set(expected, a.name);
    if (a.ambiguous || b.ambiguous || a.kind !== b.kind && !(a.kind === "custom" && b.kind === "function" && (customToolNames?.has?.(a.name) || customToolNames?.includes?.(a.name))) ||
      expected !== b.name && a.name !== mapped) return reject("final_correspondence", "call_identity");
  }
  for (let i = 0; i < final.results.length; i++) {
    const a = sourceIndex.results[i], b = final.results[i];
    if (a.callOrdinal !== b.callOrdinal || a.callOrdinal == null || ["unlinked_call", "ambiguous_call"].includes(b.blockedReason)) return reject("final_correspondence", "result_linkage");
  }
  for (const ref of plan.replacements) {
    const sourceAnchor = sourceIndex.results[ref.anchorResultIndex];
    const anchor = final.results[ref.anchorResultIndex];
    const sourceTarget = sourceIndex.results[ref.resultIndex];
    const target = final.results[ref.resultIndex];
    if (ref.anchorResultIndex >= ref.resultIndex || sourceAnchor.toolFamily !== sourceTarget.toolFamily ||
      sourceAnchor.callOrdinal !== anchor.callOrdinal || sourceTarget.callOrdinal !== target.callOrdinal) return reject("final_correspondence", "anchor_mapping");
  }

  if (fence?.protectAll && fence?.reason === "opaque_state") return reject("final_opaque_state");
  if (fence?.protectAll && fence?.reason === "cache_fence") return reject("final_cache_fence");
  for (const ref of plan.replacements) {
    const target = final.results[ref.resultIndex];
    const anchor = final.results[ref.anchorResultIndex];
    if (target.opaqueProtected || anchor.opaqueProtected || sourceIndex.results[ref.resultIndex].opaqueProtected ||
      sourceIndex.results[ref.anchorResultIndex].opaqueProtected) return reject("final_opaque_state");
    if (target.cacheProtected) return reject("final_cache_fence");
  }

  if (final.blockedReason === "ambiguous_turn") return reject("final_protection");
  for (const ref of plan.replacements) {
    const target = final.results[ref.resultIndex];
    if (target.isError) return reject("final_protection");
    if (target.blockedReason === "current") return reject("final_protection");
    if (final.currentTurnIndex < 0 || target.turnIndex < 0) return reject("final_protection");
    if (target.batchIndex != null && !final.toolBatches[target.batchIndex]?.completed) return reject("final_protection");
    if (target.turnIndex < final.currentTurnIndex && target.isRecentTurn) return reject("final_protection");
    if (target.turnIndex === final.currentTurnIndex && target.isRecentToolBatch) return reject("final_protection");
  }

  const references = plan.replacements;
  let bounds = 0;
  if (sourceFormat !== finalFormat) for (const ref of references) {
    const source = sourceIndex.results[ref.resultIndex];
    if (!gemini(sourceFormat) && !gemini(finalFormat) &&
      !(source.representation === "single_text" && (responses(sourceFormat) || [RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(source.resultContainer?.type)))) continue;
    for (const text of [ref.anchorOriginalText, ref.originalText, ref.marker]) {
      const bound = 6 * text.length + 128;
      if (bound > LIMIT.maxResultBytes || bounds + bound > LIMIT.maxScanBytes) return reject("final_budget");
      bounds += bound;
    }
  }
  const writes = [];
  for (const ref of references) {
    const sourceAnchor = sourceIndex.results[ref.anchorResultIndex];
    const anchor = final.results[ref.anchorResultIndex];
    const sourceTarget = sourceIndex.results[ref.resultIndex];
    const target = final.results[ref.resultIndex];
    const anchorProof = selectedLeaf(sourceAnchor, anchor, ref.anchorOriginalText, sourceFormat, finalFormat);
    const targetProof = selectedLeaf(sourceTarget, target, ref.originalText, sourceFormat, finalFormat);
    const newValue = selectedLeaf(sourceTarget, target, ref.marker, sourceFormat, finalFormat);
    if (!anchorProof || !targetProof || !newValue) return reject("final_correspondence", "leaf_proof");
    if (!writable(anchorProof.owner, anchorProof.key) || !writable(targetProof.owner, targetProof.key) ||
      !writable(newValue.owner, newValue.key)) return reject("final_correspondence", "non_writable");
    if (anchorProof.owner[anchorProof.key] !== anchorProof.expected || targetProof.owner[targetProof.key] !== targetProof.expected ||
      newValue.owner !== targetProof.owner || newValue.key !== targetProof.key) return reject("final_correspondence", "leaf_proof");
    if (ref.matchKind === "body") {
      // Codec correspondence above proves the carrier; extraction proves the body.
      const a = inspectToolOutput(ref.anchorOriginalText, sourceIndex.calls[sourceAnchor.callOrdinal]);
      const b = inspectToolOutput(ref.originalText, sourceIndex.calls[sourceTarget.callOrdinal]);
      if (!a || !b || a.kind !== ref.adapterKind || b.kind !== ref.adapterKind ||
        ref.anchorOriginalText.slice(a.bodyStart, a.bodyEnd) !== ref.bodyText ||
        ref.originalText.slice(b.bodyStart, b.bodyEnd) !== ref.bodyText) return reject("final_correspondence", "body_proof");
      if (anchorProof.expected === ref.anchorOriginalText && targetProof.expected === ref.originalText) {
        const finalA = inspectToolOutput(anchorProof.owner[anchorProof.key], sourceIndex.calls[sourceAnchor.callOrdinal]);
        const finalB = inspectToolOutput(targetProof.owner[targetProof.key], sourceIndex.calls[sourceTarget.callOrdinal]);
        if (!finalA || !finalB || finalA.kind !== ref.adapterKind || finalB.kind !== ref.adapterKind ||
          anchorProof.owner[anchorProof.key].slice(finalA.bodyStart, finalA.bodyEnd) !== ref.bodyText ||
          targetProof.owner[targetProof.key].slice(finalB.bodyStart, finalB.bodyEnd) !== ref.bodyText) return reject("final_correspondence", "body_proof");
      }
    }
    writes.push({ owner: targetProof.owner, key: targetProof.key, text: newValue.expected, ref });
  }
  if (signal?.aborted) throw signal.reason;
  for (const { owner, key, text } of writes) owner[key] = text;
  return { appliedResults: writes.length, bytesSaved: writes.reduce((n, w) => n + w.ref.originalBytes - w.ref.markerBytes, 0),
    bodyAppliedResults: writes.filter(w => w.ref.matchKind === "body").length,
    bodyAppliedSaveBytes: writes.reduce((n, w) => n + (w.ref.matchKind === "body" ? w.ref.originalBytes - w.ref.markerBytes : 0), 0),
    estimatedTokensSaved: writes.reduce((n, w) => n + Math.max(0, estimateOutputTokens(w.ref.originalText.length) - estimateOutputTokens(w.ref.marker.length)), 0),
    retainedReferences: writes.length, skipReason: null, skipDetail: null };
}
