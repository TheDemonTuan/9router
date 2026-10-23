# syntax=docker/dockerfile:1.7
ARG BUN_IMAGE=oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
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
ENV HOME=/home/bun
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
RUN mkdir -p /app/data /app/data-home /home/bun && \
  ln -s /app/data-home /home/bun/.9router && \
  chown -R bun:bun /app /home/bun
COPY scripts/docker-entrypoint.sh /entrypoint.sh
# Explicit --user root retains ownership repair for existing mounted volumes.
RUN apk upgrade --no-cache && \
  apk add --no-cache su-exec && \
  chmod +x /entrypoint.sh
USER bun

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "custom-server.js"]
