# Native-only Debian 12/glibc image. Build from the app root with --build-arg APP_REVISION=<40-hex SHA>.
# Digest, snapshot, binary checksums, licenses and security provenance: image-build-manifest.json.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS debian
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261001T000000Z/ bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261001T000000Z/ bookworm-updates main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261001T000000Z/ bookworm-security main' \
      > /etc/apt/sources.list
# The slim base lacks CA roots; bootstrap them from the identical signed snapshot over HTTP.
# APT verifies signed InRelease/Packages/package hashes; no trusted=yes or unauthenticated install.
RUN printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261001T000000Z/ bookworm main' \
      > /etc/apt/sources.list.d/bootstrap.list \
    && apt-get update -o Dir::Etc::sourcelist=sources.list.d/bootstrap.list -o Dir::Etc::sourceparts=- \
    && apt-get install -y --no-install-recommends \
      -o Dir::Etc::sourcelist=sources.list.d/bootstrap.list -o Dir::Etc::sourceparts=- ca-certificates \
    && rm /etc/apt/sources.list.d/bootstrap.list \
    && rm -rf /var/lib/apt/lists/*

FROM debian AS assets
ARG TARGETARCH
ARG APP_REVISION
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY services/chatgpt-web-runtime/image-build-manifest.json /build/image-build-manifest.json
COPY services/chatgpt-web-runtime/scripts/install-image-assets.py /build/install-image-assets.py
COPY services/chatgpt-web-runtime/scripts/build-tunnel-assets.py /build/build-tunnel-assets.py
COPY services/chatgpt-web-runtime/scripts/tunnel-build-lock/ /build/tunnel-build-lock/
RUN python3 /build/install-image-assets.py --manifest /build/image-build-manifest.json \
    --arch "${TARGETARCH}" --revision "${APP_REVISION}" --output /assets \
    && test "$(/assets/bin/bun --version)" = '1.4.0'

FROM debian AS dependencies
COPY --from=assets /assets/bin/bun /usr/local/bin/bun
WORKDIR /opt/cgw
COPY services/chatgpt-web-runtime/package.json services/chatgpt-web-runtime/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM debian AS runtime
ARG APP_REVISION
LABEL org.opencontainers.image.title="9Router ChatGPT Web Runtime" \
      org.opencontainers.image.source="https://github.com/TheDemonTuan/9router" \
      org.opencontainers.image.revision="${APP_REVISION}" \
      org.opencontainers.image.version="6.1.3" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0"
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium=154.0.8037.92-1~deb12u1 chromium-common=154.0.8037.92-1~deb12u1 \
      tini xvfb openbox x11vnc xauth fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cgw \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin cgw \
    && install -d -o 10001 -g 10001 -m 0700 /data /run/cgw /home/cgw
COPY --from=assets /assets/bin/ /usr/local/bin/
COPY --from=assets /assets/share/licenses/ /usr/local/share/licenses/
WORKDIR /opt/cgw
COPY --from=dependencies /opt/cgw/node_modules/ ./node_modules/
# Deliberate allowlist; never COPY the app, .env, local account state or Codex home.
COPY services/chatgpt-web-runtime/package.json services/chatgpt-web-runtime/bun.lock services/chatgpt-web-runtime/tsconfig.json services/chatgpt-web-runtime/protocol.js ./
COPY services/chatgpt-web-runtime/src/ ./src/
COPY services/chatgpt-web-runtime/scripts/ ./scripts/
COPY services/chatgpt-web-runtime/tests/ ./tests/
COPY services/chatgpt-web-runtime/LICENSE ./LICENSE
COPY services/chatgpt-web-runtime/LICENSES/ ./LICENSES/
COPY services/chatgpt-web-runtime/image-build-manifest.json ./image-build-manifest.json
COPY services/chatgpt-web-runtime/security/seccomp.json ./security/seccomp.json
ENV HOME=/home/cgw CGW_DATA_DIR=/data CGW_PORT=17841 CGW_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
    XDG_CACHE_HOME=/tmp/cgw-cache XDG_CONFIG_HOME=/tmp/cgw-config XDG_RUNTIME_DIR=/run/cgw \
    PATH=/usr/local/bin:/usr/bin:/bin
USER 10001:10001
EXPOSE 17841 5900
STOPSIGNAL SIGTERM
# Forward SIGTERM only to the runtime owner; it drains and settles children before exiting.
# Tini remains PID 1 and reaps orphaned grandchildren. Do not use -g to kill child groups early.
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/opt/cgw/scripts/image-entrypoint.sh"]
CMD ["bun", "src/server.ts"]
