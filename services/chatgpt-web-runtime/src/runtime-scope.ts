import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "./config";
import { validateProfileId } from "../protocol.js";
import type { ChatGptTurnEnvironment } from "./adapters/chatgpt-web/environment";

export interface RuntimeExecutionScope {
  profileId: string; profileEpoch: string; clientId: string;
  pathFlavor?: "win32" | "posix";
  verifiedEnvironment?: Pick<ChatGptTurnEnvironment, "cwd" | "roots" | "writableRoots" | "sandboxPolicy">;
}
export const runtimeExecutionScope = new AsyncLocalStorage<RuntimeExecutionScope>();
export function runtimeScopeKey(scope: RuntimeExecutionScope): string {
  validateProfileId(scope.profileId);
  if (!scope.profileEpoch || !scope.clientId) throw new Error("Exact runtime execution scope required");
  return createHash("sha256").update(JSON.stringify([scope.profileId, scope.profileEpoch, scope.clientId])).digest("hex");
}
export function scopedStatePath(scope: RuntimeExecutionScope, fileName: string): string {
  if (!/^[a-z][a-z-]*\.json$/.test(fileName)) throw new Error("Internal state filename invalid");
  return join(getConfigDir(), "profiles", validateProfileId(scope.profileId), "state", runtimeScopeKey(scope), fileName);
}
