import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFile } from "../../config";
import { runtimeExecutionScope, runtimeScopeKey, scopedStatePath } from "../../runtime-scope";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface CompletedCheckpoint { summaryHash: string; sourceHashes: ReadonlySet<string>; source: ChatGptTurnUserRevision; }
const revisionSchema = z.object({ content: z.unknown(), turnId: z.string().min(1).max(256).optional(), itemId: z.string().min(1).max(256).optional() }).strict();
const checkpointSchema = z.object({ summaryHash: z.string().regex(/^[a-f0-9]{64}$/), sourceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(4), source: revisionSchema }).strict();
const snapshotSchema = z.object({ version: z.literal(1), namespace: z.string().regex(/^[a-f0-9]{64}$/), checkpoints: z.array(z.tuple([z.string(), checkpointSchema])).max(256) }).strict();
const checkpoints = new Map<string, CompletedCheckpoint>();
const loadedPaths = new Set<string>();
const MAX_CHECKPOINTS = 256;
function checkpointScope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): { key: string; namespace: string; path: string } | undefined {
  const execution = runtimeExecutionScope.getStore(), selected = parsed._chatgptEffectiveModelIdentity;
  if (!execution || !selected || !identity.threadId || !identity.turnId) return undefined;
  const namespace = runtimeScopeKey(execution);
  const path = scopedStatePath(execution, "compaction-checkpoints.json");
  if (!loadedPaths.has(path)) {
    if (existsSync(path)) {
      const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (snapshot.namespace !== namespace) throw new Error("Checkpoint namespace mismatch");
      for (const [key, checkpoint] of snapshot.checkpoints) {
        const owner = JSON.parse(key);
        if (!Array.isArray(owner) || owner[0] !== namespace) throw new Error("Checkpoint owner mismatch");
        checkpoints.set(key, { ...checkpoint, source: checkpoint.source as ChatGptTurnUserRevision, sourceHashes: new Set(checkpoint.sourceHashes) });
      }
      while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
    }
    loadedPaths.add(path);
  }
  return { key: JSON.stringify([namespace, identity.threadId, identity.turnId, selected.routeId, selected.browserFamily, selected.reasoning]), namespace, path };
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sourceDigest(source: ChatGptTurnUserRevision): string { return digest([source.turnId, source.content]); }
export function rememberCompactionContinuation(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity, sources: readonly ChatGptTurnUserRevision[], summary: string): void {
  const scope = checkpointScope(parsed, identity);
  if (!scope || !parsed._compactionRequest || !summary || !sources[0]) return;
  checkpoints.delete(scope.key);
  checkpoints.set(scope.key, { summaryHash: digest(summary), sourceHashes: new Set(sources.map(sourceDigest)), source: structuredClone(sources[0]) });
  while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
  const entries = [...checkpoints].filter(([key]) => JSON.parse(key)[0] === scope.namespace)
    .map(([key, value]) => [key, { summaryHash: value.summaryHash, sourceHashes: [...value.sourceHashes], source: value.source }]);
  atomicWriteFile(scope.path, JSON.stringify({ version: 1, namespace: scope.namespace, checkpoints: entries }));
}
export function isAcceptedCompactionContinuation(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity, source: ChatGptTurnUserRevision): boolean {
  return acceptedCheckpoint(parsed, identity)?.checkpoint.sourceHashes.has(sourceDigest(source)) === true;
}
export function recoverCompactionInstruction(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): { source: ChatGptTurnUserRevision; summaryIndex: number } | undefined {
  const accepted = acceptedCheckpoint(parsed, identity);
  return accepted ? { source: structuredClone(accepted.checkpoint.source), summaryIndex: accepted.summaryIndex } : undefined;
}
function acceptedCheckpoint(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  const scope = checkpointScope(parsed, identity);
  const checkpoint = scope ? checkpoints.get(scope.key) : undefined;
  if (!scope || !checkpoint) return undefined;
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || !("input" in body) || !Array.isArray(body.input)) return undefined;
  const input = body.input;
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    let summary: string | null;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    } else {
      if (item.type !== "message" || item.role !== "user") continue;
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
        ? item.content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n") : "";
      if (!isReadableCompactionSummaryText(text)) continue;
      summary = text.slice(SUMMARY_PREFIX.length + 1);
    }
    const metadata = item.internal_chat_message_metadata_passthrough;
    const owner = metadata && typeof metadata === "object" && "turn_id" in metadata ? metadata.turn_id : undefined;
    if (owner !== undefined && owner !== identity.turnId || summary === null || digest(summary) !== checkpoint.summaryHash) return undefined;
    checkpoints.delete(scope.key); checkpoints.set(scope.key, checkpoint);
    return { checkpoint, summaryIndex: index };
  }
  return undefined;
}
