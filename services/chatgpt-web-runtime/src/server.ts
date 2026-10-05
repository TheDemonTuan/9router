import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "bun";
import { RuntimeSingletonLock } from "./process";
import { RuntimeState, RuntimeStateError } from "./runtime-state";
import { RuntimeProfiles } from "./profiles";
import { ViewerTransport, LOGIN_ID_PATTERN, VIEWER_MAX_MESSAGE, VIEWER_MAX_BUFFER } from "./viewer-transport";
import { loadRuntimeConfig, providerConfig, tokenMatches } from "./config";
import type { RuntimeConfig } from "./config";
import { loadProfileTunnelConfigs } from "./tunnel";
import { AuthorityError, sha256, validateAuthorityClaims } from "./authority";
import type { AuthorityClaims } from "./authority";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "./adapters/chatgpt-web";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import { cancelStructuredCompactionNativeTurn } from "./adapters/chatgpt-web/compaction-handoff";
import { brokerWorkSnapshot, closeTurnBrokers } from "./adapters/chatgpt-web/turn-broker";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "./adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "./adapters/chatgpt-web/compaction-continuation";
import { requireChatGptWebModelRoute, CHATGPT_WEB_LUNA_BACKEND_MODEL } from "./chatgpt-web-models";
import { parseRequest } from "./responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "./responses/compaction";
import { closeResponseState, expandPreviousResponseInput, rememberResponseState } from "./responses/state";
import { AsyncEventQueue } from "./event-queue";
import { bridgeToResponsesSSE, buildResponseJSON } from "./bridge";
import { readJsonRequestBody } from "./http-body";
import { namespacedToolName } from "./types";
import type { AdapterEvent, CodexParsedRequest } from "./types";
import { PROTOCOL_VERSION, SERVICE_NAME, UPSTREAM_REVISION, validateProfileId } from "../protocol.js";
import { VERSION } from "./version";
import { runtimeExecutionScope } from "./runtime-scope";
import { readChatGptWebSessionImport, SessionTransferError } from "../session-transfer.js";

export interface RuntimeEnvelope {
  protocolVersion: 1; profileId: string; profileEpoch: string; request: Record<string, unknown>; authority: AuthorityClaims;
  originalModel: string; effectiveModel: string; effectiveReasoning: string; transformedRequestSha256: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeStateError("invalid_request", "JSON object required", 400);
  return value as Record<string, unknown>;
}
export function validateRuntimeEnvelope(value: unknown, headerProfile: string | null, compact: boolean): RuntimeEnvelope {
  const envelope = record(value);
  if (envelope.protocolVersion !== PROTOCOL_VERSION || typeof envelope.profileEpoch !== "string" || !envelope.profileEpoch
    || typeof envelope.originalModel !== "string" || typeof envelope.effectiveModel !== "string" || typeof envelope.effectiveReasoning !== "string") {
    throw new RuntimeStateError("protocol_mismatch", "Invalid runtime protocol envelope", 400);
  }
  validateProfileId(envelope.profileId);
  if (headerProfile !== null && headerProfile !== envelope.profileId) throw new RuntimeStateError("profile_mismatch", "Profile header/envelope mismatch", 400);
  const request = record(envelope.request);
  const transformedRequestSha256 = sha256(JSON.stringify(request));
  if (envelope.transformedRequestSha256 !== transformedRequestSha256) throw new RuntimeStateError("transformed_body_mismatch", "Internal request integrity mismatch", 400);
  const authority = validateAuthorityClaims(envelope.authority);
  if (authority.purpose !== (compact ? "compact" : "responses")) throw new RuntimeStateError("authority_purpose_mismatch", "Invalid request purpose", 400);
  const identity = extractChatGptTurnIdentity(parseRequest(request));
  for (const name of ["threadId", "turnId", "parentThreadId", "agentName", "subagentKind"] as const) {
    if (identity[name] !== authority[name]) throw new RuntimeStateError("native_identity_mismatch", "Signed native identity differs from request", 400);
  }
  if (request.model !== envelope.effectiveModel || request._compact !== undefined) throw new RuntimeStateError("model_scope_mismatch", "Effective request model mismatch", 400);
  if (envelope.originalModel !== `cgw/${envelope.effectiveModel}`) throw new RuntimeStateError("model_scope_mismatch", "Original signed model differs from selected runtime route", 400);
  if (request.reasoning !== undefined && request.reasoning !== null) {
    const reasoning = record(request.reasoning);
    if (reasoning.effort !== undefined && reasoning.effort !== envelope.effectiveReasoning) throw new RuntimeStateError("model_scope_mismatch", "Signed reasoning differs from effective request", 400);
  }
  if (Object.keys(envelope).some(key => !["protocolVersion", "profileId", "profileEpoch", "request", "authority", "originalModel", "effectiveModel", "effectiveReasoning", "transformedRequestSha256"].includes(key))) throw new RuntimeStateError("protocol_mismatch", "Unexpected runtime envelope field", 400);
  return { protocolVersion: 1, profileId: validateProfileId(envelope.profileId), profileEpoch: envelope.profileEpoch,
    request, authority, originalModel: envelope.originalModel, effectiveModel: envelope.effectiveModel,
    effectiveReasoning: envelope.effectiveReasoning, transformedRequestSha256 };
}
interface ViewerData { loginId: string; transport?: ViewerTransport; }
export interface RuntimeService { server: Server<ViewerData>; state: RuntimeState; profiles: RuntimeProfiles; initialized: Promise<void>; close(): Promise<void>; }
export function startRuntime(config: RuntimeConfig): RuntimeService {
  const singleton = new RuntimeSingletonLock(config.dataDir);
  let state: RuntimeState;
  try { state = new RuntimeState(config.dataDir); } catch (error) { singleton.close(); throw error; }
  const tunnelFile = process.env.CGW_TUNNEL_PROFILES_FILE;
  let profiles: RuntimeProfiles;
  try { profiles = new RuntimeProfiles(config, state, loadProfileTunnelConfigs(tunnelFile, config.dataDir)); }
  catch (error) { state.close(); singleton.close(); throw error; }
  let activeHttpRequests = 0;
  let shuttingDown = false;
  let initializing = true;
  let childrenInitialized = false;
  const initialized = (state.fence() ? Promise.resolve() : profiles.initialize().then(() => { childrenInitialized = true; })).finally(() => { initializing = false; });
  void initialized.catch(() => {});
  let lifecycleTail: Promise<unknown> = Promise.resolve();
  const lifecycle = <T>(action: () => Promise<T>): Promise<T> => {
    const operation = lifecycleTail.then(action);
    lifecycleTail = operation.catch(() => {});
    return operation;
  };
  const activity = () => ({ activeHttpRequests, activeBrowserTurns: chatGptTurnSessions.activeCount(), pendingToolCalls: brokerWorkSnapshot().pendingToolCalls });
  const hasPhysicalWork = () => {
    const broker = brokerWorkSnapshot();
    return activeHttpRequests > 0 || chatGptTurnSessions.physicalWorkCount() > 0 || broker.owners > 0
      || broker.pendingToolCalls > 0 || broker.activeMcpRequests > 0 || broker.openSockets > 0 || !profiles.physicalIdle();
  };
  const errorResponse = (error: unknown) => {
    const typed = error instanceof RuntimeStateError || error instanceof AuthorityError || error instanceof SessionTransferError;
    const code = typed ? error.code : "runtime_request_failed";
    const status = typed ? error.status : 500;
    return Response.json({ error: { type: "runtime_error", code, message: typed ? error.message : "Runtime request failed",
      retryable: false, submission_state: typed ? "not_sent" : "unknown" } }, { status, headers: { "x-9router-no-fallback": "true", "Cache-Control": "no-store" } });
  };
  const handleResponse = async (request: Request, compact: boolean): Promise<Response> => {
    const envelope = validateRuntimeEnvelope(await readJsonRequestBody(request), request.headers.get("x-cgw-profile-id"), compact);
    await profiles.refreshReadiness(envelope.profileId);
    return runtimeExecutionScope.run({ profileId: envelope.profileId, profileEpoch: envelope.profileEpoch, clientId: envelope.authority.clientId,
      pathFlavor: envelope.authority.pathFlavor, verifiedEnvironment: envelope.authority.environment }, async () => {
    const profile = state.profile(envelope.profileId), evidence = profiles.evidence(profile.profileId);
    if (profile.epoch !== envelope.profileEpoch) throw new RuntimeStateError("profile_epoch_mismatch", "Account epoch changed");
    const row = evidence.models.find(row => row.id === envelope.effectiveModel);
    if (!row || !row.supported_reasoning_levels.includes(envelope.effectiveReasoning)) throw new RuntimeStateError("model_version_unavailable", "Exact model and reasoning route unavailable", 400);
    const route = requireChatGptWebModelRoute(envelope.effectiveModel, evidence.capabilities, envelope.effectiveReasoning);
    if (route.interactionMode !== "automatic") throw new RuntimeStateError("model_version_unavailable", "Manual routes are not supported", 400);
    const modelIdentity = { routeId: route.slug, browserFamily: route.modelFamily || route.backendModel, reasoning: envelope.effectiveReasoning };
    const authority = envelope.authority;
    let raw: unknown = envelope.request;
    if (compact) raw = { ...envelope.request, stream: false, input: [...(Array.isArray(envelope.request.input) ? envelope.request.input : []), { type: "compaction_trigger" }] };
    const expanded = expandPreviousResponseInput(raw);
    if (envelope.request.previous_response_id && expanded === raw) throw new RuntimeStateError("continuation_unavailable", "Exact Responses continuation is unavailable");
    const parsed: CodexParsedRequest = parseRequest(expanded);
    if (Array.isArray(envelope.request.tools) && envelope.request.tools.some(tool => tool && typeof tool === "object"
      && typeof tool.type === "string" && /^(computer|browser)(_|$)/.test(tool.type))) {
      throw new RuntimeStateError("unsupported_tool", "Computer use and browser tools are not supported", 400);
    }
    if (parsed._opaqueMultiAgentV2Payload) throw new RuntimeStateError("opaque_subagent_payload", "Use Codex Compatibility V1", 400);
    if (!parsed._compactionRequest && parsed.context.tools?.length && profile.settings.mode !== "full") throw new RuntimeStateError("harness_unavailable", "Profile is not Full harness ready", 400);
    parsed._chatgptEffectiveModelIdentity = modelIdentity;
    parsed._chatgptModelFamily = route.modelFamily;
    parsed.modelId = route.backendModel; parsed.options.reasoning = route.adapterEffort;
    const provider = providerConfig({ profileId: profile.profileId, profileEpoch: profile.epoch, clientId: authority.clientId,
      pathFlavor: authority.pathFlavor!, verifiedEnvironment: { ...authority.environment!, tools: parsed.context.tools ?? [] },
      settings: profile.settings, capabilities: evidence.capabilities, dataDir: config.dataDir, contextWindow: row.context_window });
    const namespace = chatGptWebExecutionNamespace(provider);
    const existing = chatGptTurnSessions.scopedSession(namespace, authority.threadId, authority.turnId);
    validateAuthorityClaims(authority);
    state.admit(authority, profile.profileId, profile.epoch, JSON.stringify(modelIdentity), existing?.isActive() === true);
    const compaction = parsed._compactionRequest === true;
    const compactionItem = compaction && parsed._compactionResponseFormat !== "message";
    if (compaction) {
      if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) throw new RuntimeStateError("compaction_unavailable", "Luna uses exact-parent rolling checkpoints");
      delete parsed.context.tools; delete parsed.options.toolChoice; delete parsed.options.parallelToolCalls;
      parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
    }
    const adapter = createChatGptWebAdapter(provider, { onDiagnostic: (traceId, diagnostic) => profiles.noteApproval(profile.profileId, traceId, diagnostic.promptInstance) });
    const queue = new AsyncEventQueue<AdapterEvent>();
    const abort = new AbortController();
    const onDisconnect = () => abort.abort();
    request.signal.addEventListener("abort", onDisconnect, { once: true });
    const completed = (response: Record<string, unknown>) => {
      if (!compaction) { rememberResponseState(parsed._rawBody, response, { force: true }); return; }
      if (response.status !== "completed" || !Array.isArray(response.output)) return;
      const items = response.output.filter(item => item?.type === (compactionItem ? "compaction" : "message"));
      if (items.length !== 1) return;
      const item = items[0];
      const summary = compactionItem ? decodeCompactionSummary(item.encrypted_content) : item.content?.filter((part: { type: string }) => part.type === "output_text").map((part: { text: string }) => part.text).join("");
      if (!summary) return;
      const source = extractChatGptCompactionSourceRevision(parsed);
      const body = parsed._rawBody as { input: unknown[] };
      const v1Source = extractChatGptCompactionSourceRevision({ ...parsed, _rawBody: { ...body, input: buildCompactV1Output(extractCompactUserMessages(body.input), summary) } });
      rememberCompactionContinuation(parsed, extractChatGptTurnIdentity(parsed), [source, v1Source], summary);
    };
    const run = async () => {
      try { await adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, event => {
        if (event.type === "error" && ["login_required", "session_expired", "model_version_unavailable"].includes(event.code || "")) profiles.invalidate(profile.profileId, event.code!);
        queue.push(event);
      }); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "runtime_error";
        if (["login_required", "session_expired", "model_version_unavailable"].includes(code)) profiles.invalidate(profile.profileId, code);
        queue.push({ type: "error", message: "ChatGPT Web turn failed", code, retryable: false });
      }
      finally {
        state.settleClaim(authority.clientId, authority.jti);
        profiles.clearApproval(profile.profileId);
        if (compaction) state.settleTurn(profile.profileId, profile.epoch, authority.clientId, authority.threadId, authority.turnId);
        const session = chatGptTurnSessions.scopedSession(namespace, authority.threadId, authority.turnId);
        if (session) void session.physicalSettlement.then(() => state.settleTurn(profile.profileId, profile.epoch, authority.clientId, authority.threadId, authority.turnId));
        request.signal.removeEventListener("abort", onDisconnect); queue.close();
      }
    };
    const toolNsMap = new Map<string, { namespace: string; name: string }>(), freeformToolNames = new Set<string>(), toolSearchToolNames = new Set<string>();
    for (const tool of parsed.context.tools ?? []) {
      if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
      if (tool.freeform) freeformToolNames.add(tool.name); if (tool.toolSearch) toolSearchToolNames.add(tool.name);
    }
    if (parsed.stream && !compact) {
      void run();
      return new Response(bridgeToResponsesSSE(queue, route.slug, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => abort.abort(), 2000, { hideThinkingSummary: parsed.options.hideThinkingSummary, ...(compactionItem ? { compaction: true } : {}), onCompletedResponse: completed }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", "x-9router-no-fallback": "true" } });
    }
    await run();
    const response = buildResponseJSON(await queue.collect(), route.slug, { toolNsMap, freeformToolNames, toolSearchToolNames,
      hideThinkingSummary: parsed.options.hideThinkingSummary, ...(compactionItem ? { compaction: true } : {}) });
    completed(response);
    if (!compact) return Response.json(response);
    const output = response.output as { type: string; encrypted_content?: string }[];
    if (response.status !== "completed" || output.length !== 1 || output[0]?.type !== "compaction") throw new RuntimeStateError("compaction_failed", "Compaction did not return exactly one completed item", 502);
    const summary = decodeCompactionSummary(output[0].encrypted_content || "");
    if (!summary) throw new RuntimeStateError("compaction_failed", "Compaction summary unavailable", 502);
    return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(envelope.request.input), summary) });
    });
  };
  const server = Bun.serve<ViewerData>({ hostname: config.host, port: config.port, idleTimeout: 0, maxRequestBodySize: 128 * 1024 * 1024 + 16_384,
    async fetch(request, server) {
      const url = new URL(request.url), path = url.pathname;
      const admin = path.startsWith("/admin/");
      const authorization = request.headers.get("authorization");
      const livenessAdmin = request.method === "GET" && path === "/healthz" && tokenMatches(authorization, config.adminToken);
      if (!livenessAdmin && !tokenMatches(authorization, admin ? config.adminToken : config.runtimeToken)) return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
      try {
        if (admin && state.fence() && request.method !== "GET" && !["/admin/drain", "/admin/quiesce", "/admin/resume", "/admin/interrupt-turn"].includes(path)) {
          throw new RuntimeStateError("runtime_draining", "Admin profile mutations denied while drained", 503);
        }
        if (!["/admin/drain", "/admin/quiesce", "/admin/resume", "/admin/interrupt-turn", "/healthz", "/admin/profiles", "/readyz"].includes(path)) await initialized;
        if (admin && ["/admin/login/session", "/admin/login/status", "/admin/login/viewer"].includes(path)) {
          const ids = url.searchParams.getAll("loginId");
          if (request.method !== "GET" || ids.length !== 1 || !LOGIN_ID_PATTERN.test(ids[0]!) || [...url.searchParams.keys()].some(key => key !== "loginId")) throw new RuntimeStateError("invalid_login", "Exact login ID required", 400);
          const loginId = ids[0]!;
          if (path === "/admin/login/status") return Response.json(profiles.viewerStatus(loginId), { headers: { "Cache-Control": "no-store" } });
          const session = profiles.viewerSession(loginId);
          if (path === "/admin/login/session") return Response.json(session, { headers: { "Cache-Control": "no-store" } });
          if (!server.upgrade(request, { data: { loginId }, headers: { "Cache-Control": "no-store" } })) return new Response(null, { status: 426, headers: { "Cache-Control": "no-store" } });
          return;
        }
        if (request.method === "GET" && path === "/healthz") return Response.json({ service: SERVICE_NAME, protocolVersion: PROTOCOL_VERSION,
          version: VERSION, upstreamRevision: UPSTREAM_REVISION, draining: !!state.fence(), ...activity() });
        if (request.method === "GET" && path === "/readyz") {
          const profileId = request.headers.get("x-cgw-profile-id");
          if (!initializing && !state.fence()) await Promise.all(state.listProfiles().map(profile => profiles.refreshReadiness(profile.profileId)));
          const ready = !initializing && !shuttingDown && (profileId ? profiles.ready(profileId) : state.listProfiles().some(profile => profiles.ready(profile.profileId)));
          return Response.json({ ready, state: state.fence() ? "draining" : ready ? "ready" : "login_required" }, { status: ready ? 200 : 503 });
        }
        if (request.method === "GET" && path === "/v1/web-models") {
          const profileId = request.headers.get("x-cgw-profile-id"); if (!profileId) throw new RuntimeStateError("profile_required", "Profile header required", 400);
          await profiles.refreshReadiness(profileId);
          return Response.json(profiles.catalog(profileId));
        }
        if (request.method === "GET" && path === "/v1/responses") return new Response(null, { status: 426 });
        if (request.method === "POST" && path === "/v1/thread-bindings/resolve") {
          const body = record(await readJsonRequestBody(request));
          if (typeof body.clientId !== "string" || !body.clientId || typeof body.threadId !== "string" || !body.threadId || !Array.isArray(body.candidateProfileIds)
            || body.candidateProfileIds.some(value => typeof value !== "string")) throw new RuntimeStateError("invalid_binding", "Invalid thread binding candidates", 400);
          await Promise.all((body.candidateProfileIds as string[]).map(id => profiles.refreshReadiness(id)));
          return Response.json(state.resolveBinding({ clientId: body.clientId, threadId: body.threadId, candidateProfileIds: body.candidateProfileIds,
            ...(typeof body.requestedProfileId === "string" ? { requestedProfileId: body.requestedProfileId } : {}), ready: id => profiles.ready(id) }));
        }
        if (request.method === "POST" && (path === "/v1/responses" || path === "/v1/responses/compact")) {
          activeHttpRequests++;
          let counted = true;
          const release = () => { if (counted) { counted = false; activeHttpRequests--; } };
          try {
            const response = await handleResponse(request, path.endsWith("/compact"));
            if (!response.body) { release(); return response; }
            const reader = response.body.getReader();
            return new Response(new ReadableStream({ async pull(controller) {
              try { const chunk = await reader.read(); if (chunk.done) { release(); controller.close(); } else controller.enqueue(chunk.value); }
              catch (error) { release(); controller.error(error); }
            }, async cancel(reason) { release(); await reader.cancel(reason); } }), { status: response.status, headers: response.headers });
          } catch (error) { release(); throw error; }
        }
        if (request.method === "POST" && (path === "/v1/interrupt-turn" || path === "/admin/interrupt-turn")) {
          const body = record(await readJsonRequestBody(request));
          const claims = admin ? body : validateAuthorityClaims(body.authority);
          if (typeof claims.clientId !== "string" || !claims.clientId.trim() || typeof claims.threadId !== "string" || !claims.threadId.trim()
            || typeof claims.turnId !== "string" || !claims.turnId.trim()) throw new RuntimeStateError("invalid_interrupt", "Exact interrupt identity required", 400);
          if (!admin) { if (claims.purpose !== "interrupt") throw new RuntimeStateError("invalid_interrupt", "Interrupt purpose required", 400); state.consumeInterrupt(claims as AuthorityClaims); }
          const binding = state.binding(claims.clientId, claims.threadId);
          if (!binding) {
            if (!admin && typeof claims.jti === "string") state.settleClaim(claims.clientId, claims.jti);
            return Response.json({ cancelled: 0 });
          }
          const namespace = createHash("sha256").update(JSON.stringify([binding.profileId, binding.profileEpoch, claims.clientId])).digest("hex");
          const reason = new DOMException("Codex turn interrupted", "AbortError");
          const browser = chatGptTurnSessions.cancelNativeTurn(namespace, claims.threadId, claims.turnId, reason);
          const compaction = cancelStructuredCompactionNativeTurn(namespace, claims.threadId, claims.turnId, reason);
          await Promise.all([browser.settlement, compaction.settlement]);
          state.settleTurn(binding.profileId, binding.profileEpoch, claims.clientId, claims.threadId, claims.turnId, true);
          if (!admin && typeof claims.jti === "string") state.settleClaim(claims.clientId, claims.jti);
          return Response.json({ cancelled: browser.cancelled + compaction.cancelled });
        }
        if (admin) {
          if (request.method === "GET" && path === "/admin/profiles" && !state.fence()) await Promise.all(state.listProfiles().map(profile => profiles.refreshReadiness(profile.profileId)));
          if (request.method === "GET" && path === "/admin/profiles") return Response.json({
            profiles: state.listProfiles().map(profile => profiles.status(profile.profileId)), protocolVersion: PROTOCOL_VERSION,
            stateSchemaVersion: 1, operationFence: state.fence(), acceptedRequestCount: state.acceptedRequestCount(),
            physicalIdle: !hasPhysicalWork() && profiles.physicalIdle(), physicalSettlement: chatGptTurnSessions.physicalWorkCount(),
          });
          if (path === "/admin/session/import") {
            if (request.method !== "POST") throw new RuntimeStateError("method_not_allowed", "Session import requires POST", 405);
            const body = await readChatGptWebSessionImport(request);
            return await lifecycle(async () => Response.json(await profiles.importSession(body.profileId, body.revision, body.session), { headers: { "Cache-Control": "no-store" } }));
          }
          if (path === "/admin/session/verify" && request.method !== "POST") throw new RuntimeStateError("method_not_allowed", "Session verification requires POST", 405);
          const body = record(await readJsonRequestBody(request));
          if (path === "/admin/session/verify") {
            if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "profileId") || !Object.hasOwn(body, "revision")
              || typeof body.profileId !== "string" || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw new RuntimeStateError("invalid_request", "Exact profile identity and revision required", 400);
            return await lifecycle(async () => Response.json(await profiles.verifySession(body.profileId as string, body.revision as number), { headers: { "Cache-Control": "no-store" } }));
          }
          if (request.method === "POST" && ["/admin/login/close", "/admin/login/complete"].includes(path)) {
            if (typeof body.loginId !== "string" || !LOGIN_ID_PATTERN.test(body.loginId) || Object.keys(body).length !== 1) throw new RuntimeStateError("invalid_login", "Exact login ID required", 400);
            return await lifecycle(async () => Response.json(path.endsWith("/complete") ? await profiles.completeLogin(body.loginId as string) : await profiles.closeViewerLease(body.loginId as string), { headers: { "Cache-Control": "no-store" } }));
          }
          if (request.method === "POST" && path === "/admin/profiles") { state.createProfile(validateProfileId(body.profileId)); return Response.json(profiles.status(body.profileId as string)); }
          const profilePatch = /^\/admin\/profiles\/([a-z0-9-]+)$/.exec(path);
          if (request.method === "PATCH" && profilePatch) return Response.json(await profiles.patch(profilePatch[1]!, Number(body.revision), body.settings));
          if (request.method === "POST" && ["/admin/login/start", "/admin/browser/view"].includes(path)) {
            const profileId = validateProfileId(body.profileId);
            let traceId: string | undefined;
            if (body.turnId !== undefined) {
              if (typeof body.turnId !== "string" || !body.turnId) throw new RuntimeStateError("invalid_viewer_target", "Exact turn ID required", 400);
              const epoch = state.profile(profileId).epoch;
              const matches = state.activeTurnScopes(profileId, body.turnId).map(scope => {
                const namespace = createHash("sha256").update(JSON.stringify([profileId, epoch, scope.clientId])).digest("hex");
                return chatGptTurnSessions.scopedSession(namespace, scope.threadId, body.turnId as string);
              }).filter(session => session?.isActive());
              if (matches.length !== 1 || !matches[0]?.traceId) throw new RuntimeStateError("viewer_target_unavailable", "Exact profile turn is unavailable or ambiguous");
              traceId = matches[0].traceId;
            }
            return await lifecycle(async () => Response.json(await profiles.startViewer(profileId, path.endsWith("/start"), traceId), { headers: { "Cache-Control": "no-store" } }));
          }
          if (request.method === "POST" && path === "/admin/browser/restart") {
            const manager = profiles.manager(validateProfileId(body.profileId)); if (!manager.isIdle) throw new RuntimeStateError("profile_active", "Browser restart requires idle profile");
            await manager.close(); await profiles.probe(body.profileId as string); return Response.json(profiles.status(body.profileId as string));
          }
          if (request.method === "POST" && path === "/admin/smoke") {
            if (body.kind !== "browser" && body.kind !== "harness") throw new RuntimeStateError("invalid_smoke", "Explicit browser or harness smoke required", 400);
            const profileId = validateProfileId(body.profileId);
            if (body.kind === "harness") await profiles.harnessSmoke(profileId); else await profiles.probe(profileId);
            return Response.json({ profile: profiles.status(profileId), outerToolE2eVerified: false });
          }
          if (request.method === "POST" && path === "/admin/drain") return await lifecycle(async () => {
            const result = state.drain(String(body.operationId || ""));
            await profiles.closeViewer();
            return Response.json(result);
          });
          if (request.method === "POST" && path === "/admin/quiesce") return await lifecycle(async () => {
            state.assertFenceOwner(String(body.operationId || ""));
            await initialized.catch(() => {});
            if (hasPhysicalWork()) throw new RuntimeStateError("runtime_busy", "Logical and physical work must settle");
            childrenInitialized = false;
            await profiles.close(); await closeTurnBrokers(); closeResponseState(); state.quiesce(String(body.operationId || ""));
            return Response.json({ operationId: body.operationId, state: "quiesced" });
          });
          if (request.method === "POST" && path === "/admin/resume") return await lifecycle(async () => {
            await initialized.catch(() => {});
            await state.resume(String(body.operationId || ""), async () => {
              if (!childrenInitialized) {
                initializing = true;
                try { await profiles.initialize(); childrenInitialized = true; }
                finally { initializing = false; }
              }
            });
            return Response.json({ resumed: true });
          });
        }
        return new Response(null, { status: 404 });
      } catch (error) { return errorResponse(error); }
    },
    websocket: {
      maxPayloadLength: VIEWER_MAX_MESSAGE, backpressureLimit: VIEWER_MAX_BUFFER, closeOnBackpressureLimit: true,
      open(ws) {
        try { ws.data.transport = new ViewerTransport(ws, profiles, ws.data.loginId); }
        catch { ws.close(1008, "Viewer lease ended"); }
      },
      message(ws, data) { ws.data.transport?.message(data); },
      drain(ws) { ws.data.transport?.drain(); },
      close(ws) { ws.data.transport?.close(); },
    },
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    shuttingDown = true;
    if (!state.fence()) state.drain(`shutdown-${randomUUIDForShutdown()}`);
    closing = lifecycle(async () => {
      await initialized.catch(() => {});
      await profiles.closeViewer();
      while (hasPhysicalWork()) await Bun.sleep(50);
      await profiles.close(); await closeTurnBrokers(); closeResponseState(); state.close(); await server.stop(); singleton.close();
    });
    return closing;
  };
  return { server, state, profiles, initialized, close };
}
function randomUUIDForShutdown(): string { return crypto.randomUUID(); }
if (import.meta.main) {
  const runtime = startRuntime(loadRuntimeConfig());
  console.info(`9router CGW runtime listening on ${runtime.server.hostname}:${runtime.server.port}`);
  process.once("SIGTERM", () => { void runtime.close().catch(() => console.error("Runtime draining; physical work remains active")); });
}
