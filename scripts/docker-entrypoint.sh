#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi
chown -R bun:bun /app/data /app/data-home 2>/dev/null || true
exec su-exec bun "$@"
