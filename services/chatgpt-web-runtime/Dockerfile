# Native-only Ubuntu 24.04/glibc runtime. Docker browser-init provisions Chrome into a volume, never this image.
# Build from the app root with --build-arg APP_REVISION=<40-hex SHA>.
FROM ubuntu:noble@sha256:a853f94d226358a79c740cfc7bce0c289748f3fe3488d921d038ccd752c61b60 AS ubuntu
ARG TARGETARCH
COPY services/chatgpt-web-runtime/scripts/install-ubuntu-snapshot.sh /build/install-ubuntu-snapshot.sh
ADD --checksum=sha256:6bac2a01979e210d9eac1d4d56747ec709ea60654744d66705dc3c36e7629e50 \
    https://archive.ubuntu.com/ubuntu/pool/main/c/ca-certificates/ca-certificates_20260601~24.04.1_all.deb \
    /build/ca-certificates.deb
RUN sh /build/install-ubuntu-snapshot.sh --ca-bootstrap /build/ca-certificates.deb --arch "${TARGETARCH}" \
      python3 tini xvfb openbox x11vnc xauth fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
      libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0t64 libgtk-3-0t64 \
      libnspr4 libnss3 libpango-1.0-0 libstdc++6 libudev1 libx11-6 libxcb1 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm /build/ca-certificates.deb

FROM ubuntu AS assets
ARG TARGETARCH
ARG APP_REVISION
COPY services/chatgpt-web-runtime/image-build-manifest.json /build/image-build-manifest.json
COPY services/chatgpt-web-runtime/scripts/install-image-assets.py /build/install-image-assets.py
COPY services/chatgpt-web-runtime/scripts/build-tunnel-assets.py /build/build-tunnel-assets.py
COPY services/chatgpt-web-runtime/scripts/tunnel-build-lock/ /build/tunnel-build-lock/
RUN python3 /build/install-image-assets.py --manifest /build/image-build-manifest.json \
    --arch "${TARGETARCH}" --revision "${APP_REVISION}" --output /assets \
    && test "$(/assets/bin/bun --version)" = '1.4.0'

FROM ubuntu AS dependencies
COPY --from=assets /assets/bin/bun /usr/local/bin/bun
WORKDIR /opt/cgw
COPY services/chatgpt-web-runtime/package.json services/chatgpt-web-runtime/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM ubuntu AS runtime
ARG APP_REVISION
LABEL org.opencontainers.image.title="9Router ChatGPT Web Runtime" \
      org.opencontainers.image.source="https://github.com/TheDemonTuan/9router" \
      org.opencontainers.image.revision="${APP_REVISION}" \
      org.opencontainers.image.version="6.1.3" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0"
RUN groupadd --gid 10001 cgw \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin cgw \
    && install -d -o 10001 -g 10001 -m 0700 /data /run/cgw /home/cgw \
    && install -d -o 10001 -g 10001 -m 0755 /opt/cgw-browser
COPY --from=assets /assets/bin/ /usr/local/bin/
COPY --from=assets /assets/share/licenses/ /usr/local/share/licenses/
WORKDIR /opt/cgw
COPY --from=dependencies /opt/cgw/node_modules/ ./node_modules/
# Deliberate allowlist; never COPY the app, .env, local account state or Codex home.
COPY services/chatgpt-web-runtime/package.json services/chatgpt-web-runtime/bun.lock services/chatgpt-web-runtime/tsconfig.json services/chatgpt-web-runtime/protocol.js services/chatgpt-web-runtime/session-transfer.js services/chatgpt-web-runtime/browser-request.js services/chatgpt-web-runtime/agent-request.js ./
COPY services/chatgpt-web-runtime/src/ ./src/
COPY services/chatgpt-web-runtime/scripts/ ./scripts/
COPY services/chatgpt-web-runtime/tests/ ./tests/
COPY services/chatgpt-web-runtime/LICENSE ./LICENSE
COPY services/chatgpt-web-runtime/LICENSES/ ./LICENSES/
COPY services/chatgpt-web-runtime/image-build-manifest.json ./image-build-manifest.json
COPY services/chatgpt-web-runtime/security/seccomp.json ./security/seccomp.json
ENV HOME=/home/cgw CGW_DATA_DIR=/data CGW_PORT=17841 CGW_CHROMIUM_EXECUTABLE=/opt/cgw-browser/155.0.8059.39/chrome \
    XDG_CACHE_HOME=/tmp/cgw-cache XDG_CONFIG_HOME=/tmp/cgw-config XDG_RUNTIME_DIR=/run/cgw \
    PATH=/usr/local/bin:/usr/bin:/bin
USER 10001:10001
EXPOSE 17841 5900
STOPSIGNAL SIGTERM
# Forward SIGTERM only to the runtime owner; it drains and settles children before exiting.
# Tini remains PID 1 and reaps orphaned grandchildren. Do not use -g to kill child groups early.
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/opt/cgw/scripts/image-entrypoint.sh"]
CMD ["bun", "src/server.ts"]
