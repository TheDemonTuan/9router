#!/bin/sh
set -eu
chown -R bun:bun /app/data /app/data-home 2>/dev/null || true
# su-exec replaces supplementary groups. Use the operator-mounted runtime token's
# group as the primary group so the non-root gateway can read the 0640 secrets.
identity=bun
if [ -n "${CHATGPT_WEB_RUNTIME_TOKEN_FILE:-}" ]; then
  identity="bun:$(stat -c %g "$CHATGPT_WEB_RUNTIME_TOKEN_FILE")"
fi
exec su-exec "$identity" "$@"
