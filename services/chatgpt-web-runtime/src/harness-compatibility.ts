import { readFileSync } from "node:fs";
import { z } from "zod";
import { UPSTREAM_REVISION } from "../protocol.js";
const schema = z.object({ protocolVersion: z.literal(1), upstreamRevision: z.literal(UPSTREAM_REVISION),
  nativeToolLoop: z.literal(true), namespacedTools: z.literal(true), freeformTools: z.literal(true),
  compatibilityV1: z.literal(true), nestedSubagents: z.literal(true), profileConcurrency: z.literal(true),
  approvalOnceOnly: z.literal(true), requestScopeIsolation: z.literal(true), genericToolHandoff: z.literal(true).optional() }).strict();
export function harnessBuildCompatible(): boolean {
  try { schema.parse(JSON.parse(readFileSync(new URL("../compatibility.json", import.meta.url), "utf8"))); return true; }
  catch { return false; }
}
export function genericToolHandoffBuildCompatible(): boolean {
  try { return schema.parse(JSON.parse(readFileSync(new URL("../compatibility.json", import.meta.url), "utf8"))).genericToolHandoff === true; }
  catch { return false; }
}
