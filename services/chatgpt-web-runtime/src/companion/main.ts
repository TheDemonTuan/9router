import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Server } from "bun";
import { parseRequest } from "../responses/parser";
import { readJsonRequestBody } from "../http-body";
import { AuthorityError, sha256, signAuthority } from "../authority";
import type { AuthorityClaims } from "../authority";
import { getCodexHome, resolveCompanionAuthority } from "./local-authority";
import { AUTHORITY_HEADER, PUBLIC_PATHS, isCanonicalCgwModel } from "../../protocol.js";

export interface CompanionConfig {
  gatewayUrl: string; apiKeyFile: string; privateKeyFile: string; keyId: string; clientId: string; codexHome: string; listenPort: number;
}
export function loadCompanionConfig(path: string): CompanionConfig {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["gatewayUrl", "apiKeyFile", "privateKeyFile", "keyId", "clientId", "codexHome", "listenPort"].includes(key))) throw new Error("Invalid companion configuration");
  const gateway = new URL(value.gatewayUrl);
  if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== "/"
    || gateway.protocol !== "https:" && !(gateway.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(gateway.hostname))) throw new Error("Gateway must be HTTPS (HTTP only for loopback fixtures)");
  for (const name of ["apiKeyFile", "privateKeyFile", "codexHome"]) if (typeof value[name] !== "string" || !isAbsolute(value[name])) throw new Error(`${name} must be an operator-owned absolute path`);
  for (const name of ["keyId", "clientId"]) if (typeof value[name] !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value[name])) throw new Error(`Invalid ${name}`);
  const port = value.listenPort ?? 17840;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid companion listenPort");
  return { ...value, gatewayUrl: gateway.origin, listenPort: port, codexHome: getCodexHome(value.codexHome) };
}
const ALLOWED_HEADERS = ["accept", "user-agent", "originator", "version", "x-codex-beta-features", "x-codex-session-id", "x-codex-parent-thread-id"];
export function normalizeTurnMetadata(body: unknown, header: string | null): unknown {
  if (!header) return body;
  if (Buffer.byteLength(header) > 16_384) throw new AuthorityError("codex_metadata_too_large", "Turn metadata exceeds its bounded limit", 431);
  let metadata: unknown;
  try { metadata = JSON.parse(header); } catch { throw new AuthorityError("codex_metadata_invalid", "Invalid native turn metadata"); }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !body || typeof body !== "object" || Array.isArray(body)) throw new AuthorityError("codex_metadata_invalid", "Native turn metadata must be a JSON object");
  const request = body as Record<string, unknown>;
  const existing = request.client_metadata;
  if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) throw new AuthorityError("codex_metadata_invalid", "Invalid client metadata");
  const clientMetadata = existing as Record<string, unknown> | undefined;
  const raw = clientMetadata?.["x-codex-turn-metadata"];
  if (raw !== undefined) {
    let inBody = raw;
    if (typeof raw === "string") {
      try { inBody = JSON.parse(raw); } catch { throw new AuthorityError("codex_metadata_invalid", "Invalid body turn metadata"); }
    }
    if (!isDeepStrictEqual(metadata, inBody)) throw new AuthorityError("codex_metadata_conflict", "Header/body native turn metadata conflict");
  }
  return { ...request, client_metadata: { ...clientMetadata, "x-codex-turn-metadata": metadata } };
}
export function createCompanion(config: CompanionConfig): Server<undefined> {
  const apiKey = readFileSync(config.apiKeyFile, "utf8").trim();
  const privateKeyPem = readFileSync(config.privateKeyFile, "utf8");
  if (!apiKey || /[\r\n\0]/.test(apiKey)) throw new Error("Invalid gateway API key file");
  const expectedHost = `127.0.0.1:${config.listenPort}`;
  const expectedOrigin = `http://${expectedHost}`;
  return Bun.serve({
    hostname: "127.0.0.1", port: config.listenPort, idleTimeout: 0, maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(request) {
      try {
        if (request.headers.get("host") !== expectedHost || request.headers.get("origin") && request.headers.get("origin") !== expectedOrigin) {
          return Response.json({ error: { code: "companion_origin_denied" } }, { status: 403 });
        }
        const url = new URL(request.url);
        const path = url.pathname;
        if (url.search || url.hash) return Response.json({ error: { code: "companion_path_denied" } }, { status: 400 });
        if (request.method === "GET" && path === PUBLIC_PATHS.responses) return new Response(null, { status: 426 });
        const models = request.method === "GET" && path === "/v1/models";
        if (!models && !(request.method === "POST" && Object.values(PUBLIC_PATHS).some(allowed => allowed === path))) return new Response(null, { status: 404 });
        const headers = new Headers({ authorization: `Bearer ${apiKey}` });
        for (const name of ALLOWED_HEADERS) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        let body: string | undefined;
        if (!models) {
          if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new AuthorityError("companion_json_required", "JSON POST required", 415);
          const normalized = normalizeTurnMetadata(await readJsonRequestBody(request), request.headers.get("x-codex-turn-metadata"));
          if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw new AuthorityError("invalid_request", "JSON object required");
          body = JSON.stringify(normalized);
          const wire = normalized as Record<string, unknown>;
          let claims: Omit<AuthorityClaims, "v" | "aud" | "iat" | "exp" | "jti"> | undefined;
          if (path === PUBLIC_PATHS.interrupt) {
            if (typeof wire.threadId !== "string" || typeof wire.turnId !== "string" || Object.keys(wire).some(key => !["threadId", "turnId"].includes(key))) throw new AuthorityError("invalid_interrupt", "Exact native interrupt target required");
            claims = { purpose: "interrupt", clientId: config.clientId, method: "POST", path, bodySha256: sha256(body), threadId: wire.threadId, turnId: wire.turnId };
          } else if (isCanonicalCgwModel(wire.model)) {
            const parsed = parseRequest(normalized);
            if (path === PUBLIC_PATHS.compact) parsed._compactionRequest = true;
            const authority = resolveCompanionAuthority(parsed, config.codexHome);
            const { tools: _tools, ...environment } = authority.environment;
            const { promptCacheKey: _promptCacheKey, ...identity } = authority.identity;
            claims = { purpose: path === PUBLIC_PATHS.compact ? "compact" : "responses", clientId: config.clientId, method: "POST", path, bodySha256: sha256(body),
              ...identity, pathFlavor: authority.pathFlavor, environment, ...(authority.sourceTurnId ? { sourceTurnId: authority.sourceTurnId } : {}) };
          }
          if (claims) headers.set(AUTHORITY_HEADER, signAuthority({ claims, keyId: config.keyId, privateKeyPem }));
          headers.set("content-type", "application/json");
        }
        // POST transport has no retry: ambiguous submission is never replayed automatically.
        const response = await fetch(`${config.gatewayUrl}${path}`, { method: request.method, headers, body, signal: request.signal, redirect: "error" });
        const outputHeaders = new Headers();
        for (const name of ["content-type", "cache-control", "x-9router-no-fallback", "retry-after"]) {
          const value = response.headers.get(name); if (value) outputHeaders.set(name, value);
        }
        return new Response(response.body, { status: response.status, headers: outputHeaders });
      } catch (error) {
        if (error instanceof AuthorityError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
        return Response.json({ error: { code: "companion_transport_failed", message: "Gateway transport or local request validation failed; request was not retried" } }, { status: 502 });
      }
    },
  });
}
if (import.meta.main) {
  const path = process.env.CGW_COMPANION_CONFIG_FILE;
  if (!path) throw new Error("CGW_COMPANION_CONFIG_FILE is required");
  const server = createCompanion(loadCompanionConfig(path));
  console.info(`9router CGW companion listening on 127.0.0.1:${server.port}`);
}
