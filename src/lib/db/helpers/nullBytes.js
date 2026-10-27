/**
 * Normalize embedded NUL characters at the SQLite text binding boundary.
 * Request-derived telemetry can contain raw control characters; remove NULs
 * while retaining the rest of the text. This does not add a database backend:
 * the production driver remains bun:sqlite only.
 *
 * JSON columns need no special handling: JSON.stringify escapes control
 * characters, so a serialised payload never carries a literal NUL.
 *
 * Non-string values pass through untouched — numbers, null and undefined are
 * not text, and Buffers / TypedArrays are bound as BLOBs, which have an
 * explicit length and store binary fine.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripNullBytes(value) {
  if (typeof value !== "string") return value;
  if (!value.includes("\0")) return value;
  return value.replace(/\0/g, "");
}
