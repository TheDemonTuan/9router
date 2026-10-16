# syntax=docker/dockerfile:1.7
ARG BUN_IMAGE=oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373
FROM ${BUN_IMAGE} AS base
WORKDIR /app
ENV NEXT_PUBLIC_CHATGPT_WEB_ENABLED=false
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
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
RUN mkdir -p /app/data && chown -R bun:bun /app && \
  mkdir -p /app/data-home && chown bun:bun /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true
COPY scripts/docker-entrypoint.sh /entrypoint.sh
# Fix permissions at runtime (handles mounted volumes)
RUN apk upgrade --no-cache && \
  apk add --no-cache su-exec && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "custom-server.js"]
