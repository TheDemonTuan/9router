import { createHash } from "node:crypto";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import { enforceKeyAccess, extractClientApiKey } from "./keyAccess.js";
import { getModelInfo } from "../services/model.js";
import { getProviderCredentials } from "../services/auth.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import {
  DEFAULT_SYSTEMONE_ROUTER_MODEL,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  extractPromptState,
  buildChoiceCriteria,
  parseSystemOneRouteAnswer,
} from "open-sse/services/systemoneRouter.js";

// Routing stickiness is a hint, never conversation authority. Do not infer it
// from prompts, assistant text, cache keys, or the process-wide default session.
export function getSmartComboSessionId(request, headers, body) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null;
  const { sessionId } = resolveSessionIdentity({ headers, body, explicitOnly: true });
  return sessionId ? createHash("sha256").update(JSON.stringify([apiKey, sessionId])).digest("hex") : null;
}

/**
 * Dispatch an in-process System One decision evaluation for a combo request.
 * Resolves the configured router model's provider and credentials, sends the choice
 * query with a short timeout, and returns the parsed routing decision.
 *
 * Router timeouts fail open to standard model ordering; client cancellation and
 * the shared pre-response deadline remain terminal.
 *
 * @param {object} opts
 * @param {object} opts.body - Client request body
 * @param {string[]} opts.models - Combo model candidate array
 * @param {string} [opts.routerModel] - System One router model (defaults to oc/jev-1.13-free)
 * @param {object} [opts.log] - Logger
 * @param {number} [opts.timeoutMs=DEFAULT_SYSTEMONE_TIMEOUT_MS] - Hard ceiling for router evaluation
 * @returns {Promise<{ choice: string, confidence: number|null, probabilities: Record<string, number>|null } | null>}
 */
export async function resolveSmartChoice({
  body,
  models,
  routerModel = DEFAULT_SYSTEMONE_ROUTER_MODEL,
  log,
  timeoutMs = DEFAULT_SYSTEMONE_TIMEOUT_MS,
  preResponse = null,
  keyAccess = null,
}) {
  if (!Array.isArray(models) || models.length <= 1) return null;

  const targetModel = (typeof routerModel === "string" && routerModel.trim())
    ? routerModel.trim()
    : DEFAULT_SYSTEMONE_ROUTER_MODEL;

  const state = extractPromptState(body);
  if (!state) {
    log?.debug?.("COMBO", "smart-router: empty prompt state, skipping classification");
    return null;
  }

  const criteria = buildChoiceCriteria(models);
  if (Object.keys(criteria).length === 0) return null;

  try {
    if (await enforceKeyAccess(keyAccess, targetModel)) return null;
    const modelInfo = await getModelInfo(targetModel);
    if (preResponse?.signal?.aborted) throw preResponse.signal.reason;
    if (!modelInfo?.provider) {
      log?.warn?.("COMBO", `smart-router: unrecognized router model "${targetModel}"`);
      return null;
    }

    const { provider, model } = modelInfo;
    const credentials = await getProviderCredentials(provider, new Set(), model);
    if (!credentials || credentials.allRateLimited) {
      log?.warn?.("COMBO", `smart-router: no credentials available for router provider "${provider}"`);
      return null;
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    if (preResponse?.signal?.aborted) throw preResponse.signal.reason;
    const systemoneBody = {
      model,
      state,
      questions: {
        route: {
          type: "choice",
          instructions: "Which of these configured models is the most appropriate for this request?",
          criteria,
        },
      },
    };

    const timeoutController = new AbortController();
    const signal = preResponse?.signal
      ? AbortSignal.any([preResponse.signal, timeoutController.signal])
      : timeoutController.signal;
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`System One router timed out after ${timeoutMs}ms`);
        timeoutController.abort(error);
        reject(error);
      }, timeoutMs);
    });

    let result;
    try {
      const evaluate = () => Promise.race([
        handleSystemoneCore({
          body: systemoneBody,
          modelInfo: { provider, model },
          credentials: refreshedCredentials,
          log,
          signal,
        }),
        timeoutPromise,
      ]);
      result = preResponse ? await preResponse.run(evaluate) : await evaluate();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!result?.success || !result.response) {
      log?.warn?.("COMBO", `smart-router: evaluation failed (${result?.status || "error"})`);
      return null;
    }

    const json = await result.response.json();
    const route = parseSystemOneRouteAnswer(json);
    if (!route || !route.choice) {
      log?.warn?.("COMBO", "smart-router: response missing valid route choice");
      return null;
    }

    return route;
  } catch (err) {
    if (preResponse?.signal?.aborted) throw preResponse.signal.reason;
    log?.warn?.("COMBO", `smart-router: evaluation aborted (${err?.message || String(err)})`);
    return null;
  }
}
