# syntax=docker/dockerfile:1.7
ARG BUN_IMAGE=oven/bun:1.4.2-alpine
FROM ${BUN_IMAGE} AS base
WORKDIR /app
FROM base AS builder
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile
COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build
RUN printf 'Standalone size: ' && du -sh /app/.next/standalone
FROM ${BUN_IMAGE} AS runner
WORKDIR /app
LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
RUN mkdir -p /app/data && chown -R bun:bun /app && \
  mkdir -p /app/data-home && chown bun:bun /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true
# Fix permissions at runtime (handles mounted volumes)
RUN apk add --no-cache su-exec && \
  printf '#!/bin/sh\nchown -R bun:bun /app/data /app/data-home 2>/dev/null\nexec su-exec bun "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "custom-server.js"]
