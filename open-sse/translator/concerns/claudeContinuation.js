import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { CLAUDE_BLOCK } from "../schema/index.js";

// Configure the same secret on each gateway worker for restart-safe continuity.
// Without it, continuations are deliberately scoped to this process lifetime.
const processKey = randomBytes(32);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PREFIX = "ccr1";

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: "invalid_request_error", param: "input" });
}

function key() {
  const secret = process.env.CLAUDE_CONTINUATION_SECRET;
  if (!secret) return processKey;
  if (secret.length < 32) throw invalid("CLAUDE_CONTINUATION_SECRET must contain at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

function binding(context = {}) {
  const credentials = context.credentials || {};
  const scoped = credentials._responsesClaudeContext || {};
  const account = scoped.connectionId || credentials.connectionId || credentials.accountId
    || credentials.apiKey || credentials.accessToken;
  if (!account) throw invalid("Claude reasoning continuity requires an authenticated account scope");
  const provider = context.provider || scoped.provider;
  const model = scoped.model || context.model;
  if (!provider || !model) throw invalid("Claude reasoning continuity requires provider and model scope");
  const client = scoped.clientScope ? createHash("sha256").update(String(scoped.clientScope)).digest("hex") : null;
  return Buffer.from(JSON.stringify([provider, model, createHash("sha256").update(String(account)).digest("hex"), client]));
}

export function hasClaudeContinuationScope(context = {}) {
  const credentials = context.credentials || {};
  const scoped = credentials._responsesClaudeContext || {};
  const account = scoped.connectionId || credentials.connectionId || credentials.accountId
    || credentials.apiKey || credentials.accessToken || context.connectionId || context.apiKey;
  const provider = context.provider || scoped.provider;
  const model = scoped.model || context.model;
  return Boolean(account && provider && model);
}

function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.some(block => !block || (
    block.type === CLAUDE_BLOCK.THINKING
      ? typeof block.thinking !== "string" || typeof block.signature !== "string" || !block.signature
      : block.type === CLAUDE_BLOCK.REDACTED_THINKING
        ? typeof block.data !== "string" || !block.data
        : true
  ))) throw invalid("Claude reasoning continuation does not contain native signed reasoning");
}

export function sealClaudeReasoning(blocks, context) {
  validateBlocks(blocks);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(binding(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ expires: Date.now() + MAX_AGE_MS, blocks })), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function unsealClaudeReasoning(token, context) {
  if (typeof token !== "string" || token.length > 24 * 1024 * 1024) throw invalid("Invalid Claude reasoning continuation");
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw invalid("Unsupported or invalid reasoning.encrypted_content");
  }
  const aad = binding(context);
  let payload;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8"));
  } catch {
    throw invalid("Claude reasoning continuation is invalid or belongs to a different account, provider, model, or gateway key");
  }
  if (!Number.isFinite(payload.expires) || payload.expires < Date.now()) throw invalid("Claude reasoning continuation has expired");
  validateBlocks(payload.blocks);
  return payload.blocks;
}
