import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexParsedRequest } from "../types";
import type { ChatGptTurnEnvironment, ChatGptTurnIdentity } from "../adapters/chatgpt-web/environment";
import { extractChatGptCompactionSourceRevision, extractChatGptContinuationEnvironmentClaim, extractChatGptRootThreadMetadata, extractChatGptThreadSpawnLineage, extractChatGptTurnIdentity, hasChatGptCalendarEnvironmentDelta, hasAttributedCurrentChatGptEnvironmentContext, historicalChatGptEnvironmentMessages } from "../adapters/chatgpt-web/environment";
import { resolveCurrentCodexRolloutEnvironment } from "../adapters/chatgpt-web/codex-rollout-environment";
import { AuthorityError, validateAuthorityEnvironment } from "../authority";
import { expandUserPath } from "../config";

export interface VerifiedLocalAuthority {
  identity: ChatGptTurnIdentity & { threadId: string; turnId: string };
  environment: ChatGptTurnEnvironment;
  pathFlavor: "win32" | "posix";
  sourceTurnId?: string;
}
export function getCodexHome(configured?: string): string {
  return resolve(expandUserPath(configured || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")));
}
export function resolveCompanionAuthority(parsed: CodexParsedRequest, codexHome: string): VerifiedLocalAuthority {
  try {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId) throw new Error("Native thread and turn metadata required");
    const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
    if (!lineage) throw new Error("Canonical native thread metadata required");
    let sourceTurnId: string | undefined;
    if (parsed._compactionRequest) {
      // This locates a possible latest source; only the resolver can prove it. No runtime cache is consulted.
      try { sourceTurnId = extractChatGptCompactionSourceRevision(parsed).turnId; } catch { /* Current native rollout is still mandatory below. */ }
    }
    const hasCurrentClaim = hasAttributedCurrentChatGptEnvironmentContext(parsed);
    const historical = historicalChatGptEnvironmentMessages(parsed);
    const environment = resolveCurrentCodexRolloutEnvironment({
      codexHome, lineage, turnId: identity.turnId,
      ...(sourceTurnId && parsed._compactionRequest ? { compactionSourceTurnId: sourceTurnId } : {}),
      ...(historical.length ? { historicalEnvironmentMessages: historical } : {}), tools: parsed.context.tools,
    });
    if (!environment) throw new Error("Current canonical Codex rollout unavailable");
    const stripTools = ({ tools: _tools, ...value }: ChatGptTurnEnvironment) => value;
    let claim: ChatGptTurnEnvironment | undefined;
    if (hasCurrentClaim) {
      // Parse the current claim without requiring a runtime-owned compaction checkpoint on this machine.
      claim = extractChatGptContinuationEnvironmentClaim(parsed);
    }
    if (hasChatGptCalendarEnvironmentDelta(parsed) && environment.sandboxPolicy.type !== "dangerFullAccess") throw new Error("Calendar environment conflicts with rollout");
    if (claim && !isDeepStrictEqual(stripTools(claim), stripTools(environment))) throw new Error("Request environment conflicts with canonical rollout");
    const pathFlavor = process.platform === "win32" ? "win32" : "posix";
    validateAuthorityEnvironment(stripTools(environment), pathFlavor);
    return { identity: { ...identity, threadId: identity.threadId, turnId: identity.turnId }, environment, pathFlavor,
      ...(sourceTurnId && sourceTurnId !== identity.turnId ? { sourceTurnId } : {}) };
  } catch (error) {
    throw new AuthorityError("codex_authority_unavailable", "Current canonical Codex rollout authority is missing, stale, unsupported or conflicting", 400, { cause: error });
  }
}
