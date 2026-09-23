#!/usr/bin/env bash
# ==============================================================================
# 9router Production Blue/Green Deployment Script
# Zero-downtime cutover via Traefik File Provider and Docker Compose
# Split-Domain Hardening: Admin Dashboard (Cloudflare Access) vs Public Hardened API
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
CHATGPT_WEB_COMPOSE_FILE="${CHATGPT_WEB_COMPOSE_FILE:-}"
ACTIVE_SLOT_FILE=".active-slot"
PREVIOUS_SLOT_FILE=".previous-slot"
DEPLOYED_IMAGE_FILE=".deployed-image"

# Load environment overrides if present
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

DASHBOARD_HOST="${DASHBOARD_HOST:-9router-admin.tuannguyenviet.site}"
DASHBOARD_ALIAS_HOST="${DASHBOARD_ALIAS_HOST:-}"
API_HOST="${API_HOST:-9router-api.tuannguyenviet.site}"
EDGE_NETWORK="${EDGE_NETWORK:-edge-9router}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"
TRAEFIK_CONFIG_NAME="${TRAEFIK_CONFIG_NAME:-9router.yml}"

# Auto-detect Traefik dynamic configuration directory
if [[ -z "${TRAEFIK_DYNAMIC_DIR:-}" ]]; then
  if docker inspect edge-traefik >/dev/null 2>&1; then
    _detected="$(docker inspect edge-traefik --format '{{range .Mounts}}{{if eq .Destination "/etc/traefik/dynamic"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
    if [[ -n "$_detected" && -d "$_detected" ]]; then
      TRAEFIK_DYNAMIC_DIR="$_detected"
    fi
  fi
  if [[ -z "${TRAEFIK_DYNAMIC_DIR:-}" ]]; then
    if [[ -d "/opt/platform/edge/dynamic" ]]; then
      TRAEFIK_DYNAMIC_DIR="/opt/platform/edge/dynamic"
    elif [[ -d "/opt/edge/dynamic" ]]; then
      TRAEFIK_DYNAMIC_DIR="/opt/edge/dynamic"
    fi
  fi
fi
TRAEFIK_DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/opt/platform/edge/dynamic}"

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [[ -z "$CHATGPT_WEB_COMPOSE_FILE" && -n "${CHATGPT_WEB_SOCKET_GID:-}" ]]; then
  CHATGPT_WEB_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.chatgpt-web.yml"
fi
if [[ -n "$CHATGPT_WEB_COMPOSE_FILE" ]]; then
  [[ -f "$CHATGPT_WEB_COMPOSE_FILE" ]] || die "ChatGPT Web compose override not found: $CHATGPT_WEB_COMPOSE_FILE"
  [[ "${CHATGPT_WEB_SOCKET_GID:-}" =~ ^[0-9]+$ ]] || die "CHATGPT_WEB_SOCKET_GID must be numeric when ChatGPT Web bridge is enabled"
  CHATGPT_WEB_SOCKET_ROOT="${CHATGPT_WEB_SOCKET_ROOT:-/run/9router-chatgpt-web}"
  [[ -d "$CHATGPT_WEB_SOCKET_ROOT" ]] || die "ChatGPT Web socket root is missing: $CHATGPT_WEB_SOCKET_ROOT"
  [[ ! -L "$CHATGPT_WEB_SOCKET_ROOT" ]] || die "ChatGPT Web socket root must not be a symlink: $CHATGPT_WEB_SOCKET_ROOT"
  CHATGPT_WEB_SOCKET_PATH="$(find "$CHATGPT_WEB_SOCKET_ROOT" -maxdepth 1 -type s -print -quit 2>/dev/null || true)"
  [[ -n "$CHATGPT_WEB_SOCKET_PATH" ]] || die "ChatGPT Web socket is missing under: $CHATGPT_WEB_SOCKET_ROOT"
  [[ "$(stat -c '%a' "$CHATGPT_WEB_SOCKET_PATH")" == "660" ]] || die "ChatGPT Web socket must have mode 0660: $CHATGPT_WEB_SOCKET_PATH"
  [[ "$(stat -c '%g' "$CHATGPT_WEB_SOCKET_PATH")" == "$CHATGPT_WEB_SOCKET_GID" ]] || die "ChatGPT Web socket GID does not match CHATGPT_WEB_SOCKET_GID: $CHATGPT_WEB_SOCKET_PATH"
  COMPOSE_ARGS+=(-f "$CHATGPT_WEB_COMPOSE_FILE")
fi
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

ensure_network() {
  if ! docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
    log "Creating edge network: $EDGE_NETWORK"
    docker network create "$EDGE_NETWORK"
  fi
  for proxy_container in edge-traefik traefik; do
    if docker inspect "$proxy_container" >/dev/null 2>&1; then
      docker network connect "$EDGE_NETWORK" "$proxy_container" 2>/dev/null || true
    fi
  done
}

render_traefik_config() {
  local slot="$1"
  local dest="$2"
  local tmp="${dest}.tmp.$$"
  mkdir -p "$(dirname "$dest")"

  local dashboard_rule="Host(\`${DASHBOARD_HOST}\`)"
  local internal_hosts_rule="Host(\`${DASHBOARD_HOST}\`) || Host(\`${API_HOST}\`)"
  if [[ -n "${DASHBOARD_ALIAS_HOST:-}" ]]; then
    dashboard_rule="Host(\`${DASHBOARD_HOST}\`) || Host(\`${DASHBOARD_ALIAS_HOST}\`)"
    internal_hosts_rule="Host(\`${DASHBOARD_HOST}\`) || Host(\`${DASHBOARD_ALIAS_HOST}\`) || Host(\`${API_HOST}\`)"
  fi

  cat <<EOF > "$tmp"
# Managed dynamically by 9router deploy.sh - DO NOT EDIT MANUALLY
http:
  routers:
    # 1. Deny internal endpoints across all domains
    9router-deny-internal:
      rule: "(${internal_hosts_rule}) && PathPrefix(\`/internal\`)"
      entryPoints:
        - web
      priority: 1000
      middlewares:
        - deny-internal
      service: 9router-service

    # 2. Hardening on API Domain (${API_HOST}):
    # Deny all admin UI, settings, and management APIs from the unauthenticated API domain
    9router-api-deny-admin:
      rule: "Host(\`${API_HOST}\`) && (Path(\`/\`) || PathPrefix(\`/dashboard\`) || PathPrefix(\`/settings\`) || PathPrefix(\`/login\`) || PathPrefix(\`/api/settings\`) || PathPrefix(\`/api/keys\`) || PathPrefix(\`/api/providers\`) || PathPrefix(\`/api/provider-nodes\`) || PathPrefix(\`/api/proxy-pools\`) || PathPrefix(\`/api/combos\`) || PathPrefix(\`/api/usage\`) || PathPrefix(\`/api/oauth\`) || PathPrefix(\`/api/cloud\`) || PathPrefix(\`/api/media-providers\`) || PathPrefix(\`/api/pricing\`) || PathPrefix(\`/api/tags\`) || PathPrefix(\`/api/cli-tools\`) || PathPrefix(\`/api/mcp\`) || PathPrefix(\`/api/translator\`) || PathPrefix(\`/api/tunnel\`) || PathPrefix(\`/api/auth\`) || PathPrefix(\`/api/shutdown\`) || PathPrefix(\`/api/version\`))"
      entryPoints:
        - web
      priority: 900
      middlewares:
        - deny-internal
      service: 9router-service

    # 3. Allowed LLM endpoints on API domain
    9router-api-router:
      rule: "Host(\`${API_HOST}\`) && (PathPrefix(\`/v1\`) || PathPrefix(\`/api/v1\`) || PathPrefix(\`/v1beta\`) || PathPrefix(\`/api/v1beta\`) || PathPrefix(\`/chat\`) || PathPrefix(\`/responses\`) || PathPrefix(\`/models\`) || PathPrefix(\`/codex\`) || Path(\`/api/health\`))"
      entryPoints:
        - web
      priority: 500
      middlewares:
        - tunnel-only
        - public-api-rate-limit
        - security-headers
      service: 9router-service

    # 4. Fallback on API domain: deny anything else
    9router-api-fallback:
      rule: "Host(\`${API_HOST}\`)"
      entryPoints:
        - web
      priority: 400
      middlewares:
        - deny-internal
      service: 9router-service

    # 5. Dashboard Domain (${DASHBOARD_HOST})
    # Protected by Cloudflare Access at Edge
    9router-dashboard-router:
      rule: "${dashboard_rule}"
      entryPoints:
        - web
      priority: 100
      middlewares:
        - tunnel-only
        - security-headers
      service: 9router-service

  services:
    9router-service:
      loadBalancer:
        passHostHeader: true
        responseForwarding:
          flushInterval: "100ms"
        servers:
          - url: "http://9router-${slot}:20128"
        healthCheck:
          path: "/api/health"
          interval: "5s"
          timeout: "2s"
EOF
  mv -f "$tmp" "$dest"
}

wait_healthy() {
  local slot="$1"
  local container="9router-${slot}"
  local start_time
  start_time="$(date +%s)"
  log "Polling health check for $container on /api/health (timeout: ${READY_TIMEOUT}s)..."

  while true; do
    if docker exec "$container" wget -qO- http://127.0.0.1:20128/api/health 2>/dev/null | grep -q '"ok":true'; then
      log "Slot $slot ($container) is HEALTHY."
      return 0
    fi

    local current_time
    current_time="$(date +%s)"
    if (( current_time - start_time >= READY_TIMEOUT )); then
      log "ERROR: Health check timed out after ${READY_TIMEOUT}s for $container"
      docker logs --tail 30 "$container" || true
      return 1
    fi
    sleep 2
  done
}

reconcile_active_slot() {
  [[ -f "$ACTIVE_SLOT_FILE" ]] || die "Cannot reconcile: missing $ACTIVE_SLOT_FILE"
  [[ -f "$DEPLOYED_IMAGE_FILE" ]] || die "Cannot reconcile: missing $DEPLOYED_IMAGE_FILE"

  local active_slot
  active_slot="$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")"
  [[ "$active_slot" == "blue" || "$active_slot" == "green" ]] || die "Cannot reconcile: invalid active slot: $active_slot"

  IMAGE_REF="$(tr -d '[:space:]' < "$DEPLOYED_IMAGE_FILE")"
  [[ -n "$IMAGE_REF" ]] || die "Cannot reconcile: empty $DEPLOYED_IMAGE_FILE"
  export IMAGE_REF

  log "Reconciling active slot: $active_slot"
  ensure_network
  compose up -d --no-deps --pull never "9router-$active_slot"
  wait_healthy "$active_slot" || die "Active slot $active_slot failed healthcheck during reconcile"
  render_traefik_config "$active_slot" "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"
  log "Reconciled Traefik route and active slot: $active_slot"
}

show_status() {
  local active
  active="$(cat "$ACTIVE_SLOT_FILE" 2>/dev/null || echo "none")"
  local previous
  previous="$(cat "$PREVIOUS_SLOT_FILE" 2>/dev/null || echo "none")"
  local img
  img="$(cat "$DEPLOYED_IMAGE_FILE" 2>/dev/null || echo "none")"
  printf '=== 9router Deployment Status ===\n'
  printf 'Active slot      : %s\n' "$active"
  printf 'Previous slot    : %s\n' "$previous"
  printf 'Deployed image   : %s\n' "$img"
  if [[ -n "$DASHBOARD_ALIAS_HOST" ]]; then
    printf 'Dashboard Host   : %s (alias: %s)\n' "$DASHBOARD_HOST" "$DASHBOARD_ALIAS_HOST"
  else
    printf 'Dashboard Host   : %s\n' "$DASHBOARD_HOST"
  fi
  printf 'API Host         : %s\n' "$API_HOST"
  printf 'Traefik config   : %s/%s\n' "$TRAEFIK_DYNAMIC_DIR" "$TRAEFIK_CONFIG_NAME"
  printf '\nContainer states:\n'
  compose ps
}

do_rollback() {
  [[ -f "$PREVIOUS_SLOT_FILE" ]] || die "No previous slot recorded for rollback."
  local prev_slot
  prev_slot="$(cat "$PREVIOUS_SLOT_FILE")"
  local active_slot
  active_slot="$(cat "$ACTIVE_SLOT_FILE" 2>/dev/null || echo "blue")"
  [[ "$prev_slot" == "blue" || "$prev_slot" == "green" ]] || die "Invalid previous slot: $prev_slot"

  log "Initiating rollback to slot: $prev_slot"
  compose up -d "9router-$prev_slot"
  wait_healthy "$prev_slot" || die "Previous slot failed healthcheck. Rollback aborted."

  render_traefik_config "$prev_slot" "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"
  printf '%s' "$prev_slot" > "$ACTIVE_SLOT_FILE"
  printf '%s' "$active_slot" > "$PREVIOUS_SLOT_FILE"
  log "Route successfully rolled back to slot: $prev_slot"

  log "Draining active slot ($active_slot)..."
  if ! wait_slot_idle "$active_slot"; then
    die "Rollback drain timed out; active slot remains running."
  fi
  compose stop "9router-$active_slot" || true
  log "Rollback completed."
}

run_diagnostics() {
  log "=== [DIAG] Docker disk/cache ==="
  docker system df -v 2>/dev/null || true

  log "=== [DIAG] Cached images for 9router ==="
  docker image ls --digests "ghcr.io/*" 2>/dev/null || true

  if docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
    log "[DIAG] EXACT IMAGE CACHED: $IMAGE_REF"
  else
    log "[DIAG] EXACT IMAGE NOT CACHED: $IMAGE_REF"
  fi

  log "=== [DIAG] Docker daemon config ==="
  cat /etc/docker/daemon.json 2>/dev/null || true

  log "=== [DIAG] Registry DNS ==="
  getent ahosts ghcr.io 2>/dev/null || true
  getent ahosts pkg-containers.githubusercontent.com 2>/dev/null || true

  log "=== [DIAG] IPv4 connectivity ==="
  curl -4 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'ghcr ipv4: connect=%{time_connect}s total=%{time_total}s code=%{http_code}\n' \
    https://ghcr.io/v2/ 2>&1 || echo "ghcr ipv4 FAILED"

  curl -4 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'blob ipv4: connect=%{time_connect}s total=%{time_total}s code=%{http_code}\n' \
    https://pkg-containers.githubusercontent.com/ 2>&1 || echo "blob ipv4 FAILED"

  log "=== [DIAG] IPv6 connectivity ==="
  curl -6 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'ghcr ipv6: connect=%{time_connect}s total=%{time_total}s code=%{http_code}\n' \
    https://ghcr.io/v2/ 2>&1 || echo "ghcr ipv6 FAILED"

  curl -6 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'blob ipv6: connect=%{time_connect}s total=%{time_total}s code=%{http_code}\n' \
    https://pkg-containers.githubusercontent.com/ 2>&1 || echo "blob ipv6 FAILED"
}

configure_docker_concurrency() {
  local daemon_json="/etc/docker/daemon.json"
  local sudo_cmd=""
  if [[ $(id -u) -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo_cmd="sudo"
    else
      log "Running as non-root without passwordless sudo; skipping daemon.json edit"
      return 0
    fi
  fi

  if grep -q '"max-concurrent-downloads"[[:space:]]*:[[:space:]]*1' "$daemon_json" 2>/dev/null; then
    log "Docker max-concurrent-downloads already set to 1"
    return 0
  fi

  log "Testing max-concurrent-downloads=1 in $daemon_json..."
  local new_cfg=""
  if [[ -f "$daemon_json" ]]; then
    if command -v jq >/dev/null 2>&1; then
      new_cfg="$($sudo_cmd jq '. + {"max-concurrent-downloads": 1}' "$daemon_json" 2>/dev/null || true)"
    elif command -v python3 >/dev/null 2>&1; then
      new_cfg="$($sudo_cmd python3 -c 'import json; d = json.load(open("'"$daemon_json"'")); d["max-concurrent-downloads"]=1; print(json.dumps(d, indent=2))' 2>/dev/null || true)"
    fi
  else
    $sudo_cmd mkdir -p /etc/docker 2>/dev/null || true
    new_cfg='{
  "max-concurrent-downloads": 1
}'
  fi

  if [[ -n "$new_cfg" ]]; then
    printf '%s\n' "$new_cfg" | $sudo_cmd tee "$daemon_json" >/dev/null 2>&1 || true
    log "Reloading Docker daemon..."
    $sudo_cmd systemctl reload docker >/dev/null 2>&1 || $sudo_cmd kill -SIGHUP "$(pidof dockerd 2>/dev/null || true)" >/dev/null 2>&1 || true
  fi
}

PULL_TIMEOUT="${PULL_TIMEOUT:-300}"
PULL_ATTEMPTS="${PULL_ATTEMPTS:-2}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-120}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-2}"

wait_slot_idle() {
  local slot="$1"
  local deadline=$((SECONDS + DRAIN_TIMEOUT))
  local container="9router-$slot"
  while (( SECONDS < deadline )); do
    local health active known
    health="$(docker exec "$container" wget -qO- http://127.0.0.1:20128/api/health 2>/dev/null || true)"
    active="$(printf '%s' "$health" | sed -n 's/.*"active_requests"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
    known="$(printf '%s' "$health" | sed -n 's/.*"active_requests_known"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p')"
    if [[ "$known" == "true" && "$active" == "0" ]]; then
      log "Slot $slot is idle."
      return 0
    fi
    log "Waiting for slot $slot to drain (active_requests=${active:-unknown}, known=${known:-unknown})..."
    sleep "$DRAIN_POLL_SECONDS"
  done
  log "Drain timeout for slot $slot; keeping it running to avoid cutting active requests."
  return 1
}

pull_image() {
  if docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
    log "Image already cached locally: $IMAGE_REF"
    return 0
  fi

  local attempt rc start_ts duration
  for ((attempt=1; attempt<=PULL_ATTEMPTS; attempt++)); do
    log "Pull attempt $attempt/$PULL_ATTEMPTS for $IMAGE_REF..."
    start_ts="$(date +%s)"
    if timeout "$PULL_TIMEOUT" docker pull "$IMAGE_REF"; then
      duration=$(( $(date +%s) - start_ts ))
      log "Pull completed in ${duration}s"
      return 0
    else
      rc=$?
    fi

    if [[ "$rc" -eq 124 ]]; then
      log "Pull attempt $attempt timed out after ${PULL_TIMEOUT}s"
    else
      log "Pull attempt $attempt failed with exit code $rc"
    fi
    (( attempt < PULL_ATTEMPTS )) && sleep $((attempt * 5))
  done

  die "Unable to pull image: $IMAGE_REF"
}

# ------------------------------------------------------------------------------
# Main Dispatcher
# ------------------------------------------------------------------------------
cmd="${1:-}"

if [[ "$cmd" == "--status" ]]; then
  show_status
  exit 0
fi

if [[ "$cmd" == "--reconcile" ]]; then
  reconcile_active_slot
  exit 0
fi

if [[ "$cmd" == "--rollback" ]]; then
  do_rollback
  exit 0
fi

if [[ "$cmd" == "--setup-host" ]]; then
  configure_docker_concurrency
  exit 0
fi

if [[ "$cmd" == "--diagnostics" ]]; then
  IMAGE_REF="${2:-}"
  export IMAGE_REF
  run_diagnostics
  exit 0
fi

IMAGE_REF="${1:-}"
if [[ -z "$IMAGE_REF" ]]; then
  if [[ -f "$DEPLOYED_IMAGE_FILE" ]]; then
    IMAGE_REF="$(cat "$DEPLOYED_IMAGE_FILE")"
  else
      die "Usage: $0 <IMAGE_REF> | --reconcile | --rollback | --status | --setup-host | --diagnostics"
  fi
fi
export IMAGE_REF

CURRENT_SLOT=""
HAS_CURRENT_SLOT=false
if [[ -f "$ACTIVE_SLOT_FILE" ]]; then
  CURRENT_SLOT="$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")"
  [[ "$CURRENT_SLOT" == "blue" || "$CURRENT_SLOT" == "green" ]] || die "Invalid active slot: $CURRENT_SLOT"
  HAS_CURRENT_SLOT=true
fi

if [[ "$CURRENT_SLOT" == "blue" ]]; then
  TARGET_SLOT="green"
else
  TARGET_SLOT="blue"
fi

log "Starting deployment:"
log "  Image          : $IMAGE_REF"
log "  Current slot   : ${CURRENT_SLOT:-none}"
log "  Target slot    : $TARGET_SLOT"
if [[ -n "$DASHBOARD_ALIAS_HOST" ]]; then
  log "  Dashboard Host : $DASHBOARD_HOST ($DASHBOARD_ALIAS_HOST)"
else
  log "  Dashboard Host : $DASHBOARD_HOST"
fi
log "  API Host       : $API_HOST"
log "  Traefik config : $TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"

ensure_network

# Start headroom helper service if not already up
compose up -d headroom

# Pull and start target slot
export IMAGE_REF
pull_image

log "Starting target container: 9router-$TARGET_SLOT"
compose up -d --no-deps --pull never "9router-$TARGET_SLOT"

# Healthcheck candidate slot
if ! wait_healthy "$TARGET_SLOT"; then
  log "ABORT: Target slot $TARGET_SLOT unhealthy! Keeping ${CURRENT_SLOT:-no existing slot} live."
  compose stop "9router-$TARGET_SLOT" || true
  exit 1
fi

# Switch Traefik route atomically
log "Switching Traefik dynamic route to $TARGET_SLOT..."
render_traefik_config "$TARGET_SLOT" "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"

# Update state files
printf '%s' "$TARGET_SLOT" > "$ACTIVE_SLOT_FILE"
if [[ "$HAS_CURRENT_SLOT" == true ]]; then
  printf '%s' "$CURRENT_SLOT" > "$PREVIOUS_SLOT_FILE"
else
  # A bootstrap deploy has no valid rollback target; discard stale metadata.
  rm -f "$PREVIOUS_SLOT_FILE"
fi
printf '%s' "$IMAGE_REF" > "$DEPLOYED_IMAGE_FILE"
log "Route updated. Active slot is now: $TARGET_SLOT"

# Graceful drain then stop idle slot. Bootstrap has no old container to drain.
if [[ "$HAS_CURRENT_SLOT" != true ]]; then
  log "Initial deployment complete; no previous slot to drain."
elif ! wait_slot_idle "$CURRENT_SLOT"; then
  log "Deployment left old slot running after drain timeout; no active SSE was cut."
  exit 1
elif [[ "$CURRENT_SLOT" != "$TARGET_SLOT" ]]; then
  log "Stopping idle container: 9router-$CURRENT_SLOT"
  compose stop "9router-$CURRENT_SLOT" || true
fi

log "Deployment to $TARGET_SLOT completed successfully!"
