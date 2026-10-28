// Claude thinking signature validation.
// An Anthropic thinking signature is a base64 protobuf:
//   outer { 1: version (varint), 2: envelope (length-delimited) }
//   envelope { 1: header (length-delimited, tag 0x0a), 2..5: nonce/ciphertext/tag }
// - E-form (legacy v0): field 1 omitted, starts at field 2 (tag 0x12, base64 'E...').
// - C-form (versioned v1+, e.g. v2 'CAIS...' / v4 'CAQS...'): starts at field 1
//   (tag 0x08, varint version > 0) followed by field 2 (tag 0x12) and inner header (tag 0x0a).
// - R/Q-form: double-layer base64 wrapping an E-form or C-form signature.
// Cache prefix "...#sig" stripped before validation.

const MAX_CLAUDE_SIGNATURE_LEN = 32 * 1024 * 1024;
const CLAUDE_SIGNATURE_MARKER = 0x12;

function stripCachePrefix(rawSignature) {
  const sig = (rawSignature || "").trim();
  if (!sig) return "";
  const idx = sig.indexOf("#");
  return idx >= 0 ? sig.slice(idx + 1).trim() : sig;
}

function hasVersionedEnvelopeMarker(decoded) {
  if (!decoded || decoded.length < 4 || decoded[0] !== 0x08) return false;
  let i = 1;
  let version = 0;
  let shift = 0;
  while (i < decoded.length) {
    const byte = decoded[i++];
    version |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (version <= 0 || i >= decoded.length || decoded[i] !== CLAUDE_SIGNATURE_MARKER) return false;
      let j = i + 1;
      while (j < decoded.length && (decoded[j] & 0x80) !== 0) j++;
      j++;
      return j < decoded.length && decoded[j] === 0x0a;
    }
    shift += 7;
    if (shift > 28) return false;
  }
  return false;
}

export function hasClaudeSignaturePrefix(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  return sig.length > 0 && (sig[0] === "E" || sig[0] === "R" || sig.startsWith("CA"));
}

export function isVersionedClaudeSignature(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  if (!sig || sig.length > MAX_CLAUDE_SIGNATURE_LEN || !sig.startsWith("CA")) return false;
  try {
    return hasVersionedEnvelopeMarker(Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

// Strict-ish: validates base64 layers + Claude protobuf envelope markers.
export function isValidClaudeSignature(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  if (!sig || sig.length > MAX_CLAUDE_SIGNATURE_LEN) return false;

  try {
    if (sig[0] === "E") {
      const decoded = Buffer.from(sig, "base64");
      return decoded.length > 0 && decoded[0] === CLAUDE_SIGNATURE_MARKER;
    }
    if (sig.startsWith("CA")) {
      return hasVersionedEnvelopeMarker(Buffer.from(sig, "base64"));
    }
    if (sig[0] === "R" || sig[0] === "Q") {
      const outer = Buffer.from(sig, "base64");
      if (!outer.length) return false;
      const innerStr = outer.toString();
      if (outer[0] === 0x45) {
        const inner = Buffer.from(innerStr, "base64");
        return inner.length > 0 && inner[0] === CLAUDE_SIGNATURE_MARKER;
      }
      if (innerStr.startsWith("CA")) {
        return hasVersionedEnvelopeMarker(Buffer.from(innerStr, "base64"));
      }
    }
    return false;
  } catch {
    return false;
  }
}
