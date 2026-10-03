import { readFileSync } from "node:fs";
import { z } from "zod";
import { UPSTREAM_REVISION } from "../protocol.js";
const schema = z.object({ protocolVersion: z.literal(1), upstreamRevision: z.literal(UPSTREAM_REVISION),
  nativeToolLoop: z.literal(true), namespacedTools: z.literal(true), freeformTools: z.literal(true),
  compatibilityV1: z.literal(true), nestedSubagents: z.literal(true), profileConcurrency: z.literal(true),
  approvalOnceOnly: z.literal(true), requestScopeIsolation: z.literal(true) }).strict();
export function harnessBuildCompatible(): boolean {
  try { schema.parse(JSON.parse(readFileSync(new URL("../compatibility.json", import.meta.url), "utf8"))); return true; }
  catch { return false; }
}
