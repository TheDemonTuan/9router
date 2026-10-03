import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { posix, win32 } from "node:path";
import type { KeyObject } from "node:crypto";
import type { ChatGptSandboxPolicy } from "./adapters/chatgpt-web/environment";
import { AUTHORITY_AUDIENCE, AUTHORITY_CLOCK_SKEW_SECONDS, AUTHORITY_LIFETIME_SECONDS, MAX_AUTHORITY_BYTES, PUBLIC_PATHS, canonicalPublicPath } from "../protocol.js";

export interface AuthorityEnvironment {
  cwd: string; roots: string[]; writableRoots: string[]; sandboxPolicy: ChatGptSandboxPolicy;
}
export interface AuthorityClaims {
  v: 1; aud: "9router-cgw"; purpose: "responses" | "compact" | "interrupt";
  clientId: string; jti: string; iat: number; exp: number; method: "POST"; path: string;
  bodySha256: string; threadId: string; turnId: string;
  parentThreadId?: string; agentName?: string; subagentKind?: string; sourceTurnId?: string;
  pathFlavor?: "win32" | "posix"; environment?: AuthorityEnvironment;
}
export interface ClientKeyRecord { clientId: string; keyId: string; publicKeyPem: string; enabled: boolean; }
export interface ProvisionedClientKey { clientId: string; key: KeyObject; enabled: boolean; }
export type ProvisionedClientKeys = Map<string, ProvisionedClientKey>;
export class AuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, options?: ErrorOptions) { super(message, options); }
}
export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorityError("codex_authority_invalid", "Authority object required");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\0-\x1f\x7f]/.test(value);
}
export function validateAuthorityEnvironment(value: unknown, flavor: "win32" | "posix"): AuthorityEnvironment {
  const environment = object(value);
  const path = flavor === "win32" ? win32 : posix;
  const identity = (value: string) => flavor === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
  const contains = (root: string, candidate: string) => {
    const relative = path.relative(identity(root), identity(candidate));
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const absolute = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && !/[\0\r\n]/.test(value) && path.isAbsolute(value);
  const roots = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(absolute)
    && new Set(value.map(identity)).size === value.length;
  if (!absolute(environment.cwd) || !roots(environment.roots) || environment.roots.length === 0
    || !roots(environment.writableRoots) || !environment.roots.some(root => contains(root, environment.cwd as string))) {
    throw new AuthorityError("codex_authority_invalid", "Invalid canonical environment paths");
  }
  const sandbox = object(environment.sandboxPolicy);
  if (sandbox.type === "dangerFullAccess") {
    if (Object.keys(sandbox).some(key => key !== "type")) throw new AuthorityError("codex_authority_invalid", "Invalid dangerFullAccess policy");
  } else if (sandbox.type === "readOnly") {
    if (typeof sandbox.networkAccess !== "boolean" || environment.writableRoots.length !== 0
      || Object.keys(sandbox).some(key => !["type", "networkAccess"].includes(key))) throw new AuthorityError("codex_authority_invalid", "Invalid readOnly policy");
  } else if (sandbox.type === "workspaceWrite") {
    if (typeof sandbox.networkAccess !== "boolean" || !roots(sandbox.writableRoots)
      || JSON.stringify(sandbox.writableRoots.map(identity)) !== JSON.stringify(environment.writableRoots.map(identity))
      || Object.keys(sandbox).some(key => !["type", "networkAccess", "writableRoots"].includes(key))) throw new AuthorityError("codex_authority_invalid", "Invalid workspaceWrite policy");
  } else throw new AuthorityError("codex_authority_invalid", "Unsupported sandbox policy");
  if (Object.keys(environment).some(key => !["cwd", "roots", "writableRoots", "sandboxPolicy"].includes(key))) throw new AuthorityError("codex_authority_invalid", "Unexpected environment claim");
  return environment as unknown as AuthorityEnvironment;
}
export function validateAuthorityClaims(value: unknown, now = Date.now() / 1000): AuthorityClaims {
  const claims = object(value);
  if (claims.v !== 1 || claims.aud !== AUTHORITY_AUDIENCE || claims.method !== "POST"
    || !["responses", "compact", "interrupt"].includes(claims.purpose as string)
    || !identifier(claims.clientId) || !identifier(claims.jti) || !identifier(claims.threadId) || !identifier(claims.turnId)
    || typeof claims.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(claims.bodySha256)
    || typeof claims.path !== "string" || claims.path !== PUBLIC_PATHS[claims.purpose as keyof typeof PUBLIC_PATHS]
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
    throw new AuthorityError("codex_authority_invalid", "Invalid authority identity or purpose");
  }
  const iat = claims.iat as number, exp = claims.exp as number;
  if (exp <= iat || exp - iat > AUTHORITY_LIFETIME_SECONDS || iat > now + AUTHORITY_CLOCK_SKEW_SECONDS
    || exp < now - AUTHORITY_CLOCK_SKEW_SECONDS || iat < now - AUTHORITY_LIFETIME_SECONDS - AUTHORITY_CLOCK_SKEW_SECONDS) {
    throw new AuthorityError("codex_authority_expired", "Authority outside its accepted lifetime");
  }
  const allowed = ["v", "aud", "purpose", "clientId", "jti", "iat", "exp", "method", "path", "bodySha256", "threadId", "turnId"];
  if (claims.purpose !== "interrupt") {
    allowed.push("parentThreadId", "agentName", "subagentKind", "sourceTurnId", "pathFlavor", "environment");
    if (claims.pathFlavor !== "win32" && claims.pathFlavor !== "posix") throw new AuthorityError("codex_authority_invalid", "Explicit path flavor required");
    validateAuthorityEnvironment(claims.environment, claims.pathFlavor);
    for (const key of ["parentThreadId", "agentName", "subagentKind", "sourceTurnId"]) {
      if (claims[key] !== undefined && !identifier(claims[key])) throw new AuthorityError("codex_authority_invalid", `Invalid ${key}`);
    }
  }
  if (Object.keys(claims).some(key => !allowed.includes(key))) throw new AuthorityError("codex_authority_invalid", "Unsupported authority claim");
  return claims as unknown as AuthorityClaims;
}
export function parseClientKeys(value: unknown): ProvisionedClientKeys {
  const config = object(value);
  if (config.version !== 1 || !Array.isArray(config.clients)) throw new AuthorityError("client_keys_invalid", "Invalid client key provisioning file");
  const keys: ProvisionedClientKeys = new Map();
  const clients = new Set<string>();
  for (const raw of config.clients) {
    const record = object(raw);
    if (!identifier(record.clientId) || !identifier(record.keyId) || typeof record.publicKeyPem !== "string" || typeof record.enabled !== "boolean"
      || keys.has(record.keyId) || clients.has(record.clientId)) throw new AuthorityError("client_keys_invalid", "Duplicate or malformed client provisioning");
    const key = createPublicKey(record.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new AuthorityError("client_keys_invalid", "Client public key must be Ed25519");
    clients.add(record.clientId);
    keys.set(record.keyId, { clientId: record.clientId, key, enabled: record.enabled });
  }
  return keys;
}
export function signAuthority(options: {
  claims: Omit<AuthorityClaims, "v" | "aud" | "iat" | "exp" | "jti">;
  keyId: string; privateKeyPem: string; now?: number;
}): string {
  if (!identifier(options.keyId)) throw new AuthorityError("client_key_invalid", "Invalid key ID");
  const now = Math.floor(options.now ?? Date.now() / 1000);
  const claims: AuthorityClaims = { ...options.claims, v: 1, aud: "9router-cgw", iat: now, exp: now + AUTHORITY_LIFETIME_SECONDS, jti: randomUUID() };
  validateAuthorityClaims(claims, now);
  const key = createPrivateKey(options.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new AuthorityError("client_key_invalid", "Companion private key must be Ed25519");
  const protectedHeader = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "cgw-authority+jwt", kid: options.keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${protectedHeader}.${payload}`;
  const jws = `${signingInput}.${sign(null, Buffer.from(signingInput), key).toString("base64url")}`;
  if (Buffer.byteLength(jws) > MAX_AUTHORITY_BYTES) throw new AuthorityError("codex_authority_too_large", "Authority header exceeds 8192 bytes", 431);
  return jws;
}
export function verifyAuthority(options: {
  assertion: string | null; rawBody: Uint8Array; method: string; path: string;
  clientKeys: ProvisionedClientKeys; now?: number;
}): AuthorityClaims {
  const assertion = options.assertion;
  if (!assertion) throw new AuthorityError("codex_authority_required", "Use the authenticated local Codex companion");
  if (Buffer.byteLength(assertion) > MAX_AUTHORITY_BYTES) throw new AuthorityError("codex_authority_too_large", "Authority header exceeds 8192 bytes", 431);
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new AuthorityError("codex_authority_invalid", "Invalid compact JWS");
  const decode = (part: string) => {
    const bytes = Buffer.from(part, "base64url");
    if (bytes.toString("base64url") !== part) throw new AuthorityError("codex_authority_invalid", "Noncanonical base64url");
    try { return object(JSON.parse(bytes.toString("utf8"))); }
    catch { throw new AuthorityError("codex_authority_invalid", "Malformed JWS JSON"); }
  };
  const header = decode(parts[0]!);
  if (header.alg !== "EdDSA" || header.typ !== "cgw-authority+jwt" || !identifier(header.kid)
    || Object.keys(header).some(key => !["alg", "typ", "kid"].includes(key))) throw new AuthorityError("codex_authority_invalid", "Unsupported JWS protected header");
  const provisioned = options.clientKeys.get(header.kid);
  if (!provisioned?.enabled) throw new AuthorityError("codex_client_revoked", "Client key unavailable", 403);
  const signature = Buffer.from(parts[2]!, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== parts[2]
    || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), provisioned.key, signature)) throw new AuthorityError("codex_authority_invalid", "Invalid authority signature", 403);
  const claims = validateAuthorityClaims(decode(parts[1]!), options.now);
  if (claims.clientId !== provisioned.clientId || claims.method !== options.method
    || claims.path !== canonicalPublicPath(options.path) || claims.bodySha256 !== sha256(options.rawBody)) throw new AuthorityError("codex_authority_mismatch", "Authority does not match this request", 403);
  if (claims.purpose === "interrupt") {
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(Buffer.from(options.rawBody).toString("utf8"))); }
    catch { throw new AuthorityError("codex_authority_invalid", "Invalid interrupt body"); }
    if (body.threadId !== claims.threadId || body.turnId !== claims.turnId || Object.keys(body).some(key => !["threadId", "turnId"].includes(key))) {
      throw new AuthorityError("codex_authority_mismatch", "Interrupt target mismatch", 403);
    }
  }
  return claims;
}
