import { stripVTControlCharacters } from "node:util";
import { TOKEN_SAVER_CONFIG as LIMIT } from "../config/tokenSaverConfig.js";

const bytes = value => Buffer.byteLength(value, "utf8");
export function measureCleanupOpportunities(index, { remainingScanBytes = LIMIT.maxScanBytes } = {}) {
  const coverage = { complete: true, visitedSegments: 0, measuredSegments: 0, protectedSegments: 0, budgetStopped: false };
  const result = { ...coverage, scannedBytes: 0, trailingWhitespaceBytes: 0, blankLineBytes: 0,
    ansiBytes: 0, adjacentDuplicateBytes: 0, duplicateSystemBytes: 0, oldToolTruncationBytes: 0 };
  const system = new Map();
  let previous = null;
  for (const segment of index.textSegments) {
    result.visitedSegments++;
    const tool = segment.resultIndex == null ? null : index.results[segment.resultIndex];
    if (segment.protectedReason || tool?.cacheProtected || tool?.isCurrentTurn || tool?.isRecentTurn || tool?.isError || tool?.blockedReason) {
      result.protectedSegments++;
      previous = null;
      continue;
    }
    const text = segment.text;
    if (text.length > Math.min(LIMIT.maxResultBytes, remainingScanBytes - result.scannedBytes)) {
      result.complete = false; result.budgetStopped = true; break;
    }
    const size = bytes(text);
    if (size > LIMIT.maxResultBytes || size > remainingScanBytes - result.scannedBytes) {
      result.complete = false; result.budgetStopped = true; break;
    }
    result.scannedBytes += size;
    result.measuredSegments++;
    let pendingWhitespace = 0;
    let consecutiveTerminators = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 9) { pendingWhitespace++; continue; }
      if (code === 13 || code === 10) {
        const terminatorBytes = code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
        if (terminatorBytes === 2) i++;
        result.trailingWhitespaceBytes += pendingWhitespace;
        pendingWhitespace = 0;
        if (consecutiveTerminators++ >= 2) result.blankLineBytes += terminatorBytes;
      } else {
        pendingWhitespace = 0;
        consecutiveTerminators = 0;
      }
    }
    result.trailingWhitespaceBytes += pendingWhitespace;
    if (text.includes("\u001b") || text.includes("\u009b")) result.ansiBytes += size - bytes(stripVTControlCharacters(text));
    if (tool && tool.turnIndex < index.currentTurnIndex - LIMIT.protectPreviousTurns && !tool.isError && !tool.cacheProtected)
      result.oldToolTruncationBytes += Math.max(0, size - LIMIT.shadowToolRetainBytes);
    const message = index.protocolNodes[segment.messagePosition]?.owner;
    const pure = message && Object.keys(message).every(k => ["role", "type", "content"].includes(k)) && typeof message.content === "string" && segment.owner === message;
    const adjacent = pure && previous?.pure && previous.role === segment.role && previous.text === text;
    if (adjacent) result.adjacentDuplicateBytes += size;
    if (["system", "developer"].includes(segment.role) && !adjacent) {
      if (system.get(segment.role)?.has(text)) result.duplicateSystemBytes += size;
      else { const entries = system.get(segment.role) ?? new Set(); entries.add(text); system.set(segment.role, entries); }
    }
    previous = { pure, role: segment.role, text };
  }
  return result;
}
