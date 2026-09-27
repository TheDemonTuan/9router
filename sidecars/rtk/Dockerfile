FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS download
ARG TARGETARCH
COPY sidecars/rtk/upstream.json /tmp/upstream.json
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in amd64|arm64) ;; *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1;; esac; \
    asset="$(bun -p "JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).assets['$TARGETARCH'].file")"; \
    checksum="$(bun -p "JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).assets['$TARGETARCH'].sha256")"; \
    version="$(bun -p "JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).version")"; \
    commit="$(bun -p "JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).sourceCommit")"; \
    curl -fLSs --retry 3 "https://github.com/rtk-ai/rtk/releases/download/v${version}/${asset}" -o /tmp/rtk.tar.gz; \
    echo "$checksum  /tmp/rtk.tar.gz" | sha256sum -c -; \
    tar -tzf /tmp/rtk.tar.gz | grep -x 'rtk'; \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin rtk; \
    chmod 755 /usr/local/bin/rtk; \
    mkdir -p /usr/share/licenses/rtk; \
    curl -fLSs --retry 3 "https://raw.githubusercontent.com/rtk-ai/rtk/${commit}/LICENSE" -o /usr/share/licenses/rtk/LICENSE; \
    RTK_TELEMETRY_DISABLED=1 RTK_RECALL=0 RTK_TEE=0 /usr/local/bin/rtk --version; \
    printf 'file:1:hello\n' | RTK_TELEMETRY_DISABLED=1 RTK_RECALL=0 RTK_TEE=0 /usr/local/bin/rtk pipe --filter grep

FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73
COPY --from=download /usr/local/bin/rtk /usr/local/bin/rtk
COPY --from=download /usr/share/licenses/rtk/LICENSE /usr/share/licenses/rtk/LICENSE
COPY sidecars/rtk/server.mjs sidecars/rtk/upstream.json /app/sidecars/rtk/
COPY open-sse/config/rtkConfig.js /app/open-sse/config/rtkConfig.js
WORKDIR /app
ENV HOME=/tmp RTK_TELEMETRY_DISABLED=1 RTK_RECALL=0 RTK_TEE=0 NO_COLOR=1
USER 1000:1000
CMD ["bun", "/app/sidecars/rtk/server.mjs"]
