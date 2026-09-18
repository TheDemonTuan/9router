#!/usr/bin/env bash
# ==============================================================================
# 9router Production Blue/Green Deployment Script
# Zero-downtime cutover via Traefik File Provider and Docker Compose
# Split-Domain Hardening: Admin Dashboard (Cloudflare Access) vs Public Hardened API
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="docker-compose.prod.yml"
ACTIVE_SLOT_FILE=".active-slot"
PREVIOUS_SLOT_FILE=".previous-slot"
DEPLOYED_IMAGE_FILE=".deployed-image"

# Load environment overrides if present
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

DASHBOARD_HOST="${DASHBOARD_HOST:-9router.tuannguyenviet.site}"
DASHBOARD_ALIAS_HOST="${DASHBOARD_ALIAS_HOST:-9router-admin.tuannguyenviet.site}"
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
  cat <<EOF > "$tmp"
# Managed dynamically by 9router deploy.sh - DO NOT EDIT MANUALLY
http:
  routers:
    # 1. Deny internal endpoints across all domains
    9router-deny-internal:
      rule: "(Host(\`${DASHBOARD_HOST}\`) || Host(\`${DASHBOARD_ALIAS_HOST}\`) || Host(\`${API_HOST}\`)) && PathPrefix(\`/internal\`)"
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

    # 5. Dashboard Domain (${DASHBOARD_HOST} / ${DASHBOARD_ALIAS_HOST})
    # Protected by Cloudflare Access at Edge
    9router-dashboard-router:
      rule: "Host(\`${DASHBOARD_HOST}\`) || Host(\`${DASHBOARD_ALIAS_HOST}\`)"
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
  printf 'Dashboard Host   : %s (alias: %s)\n' "$DASHBOARD_HOST" "$DASHBOARD_ALIAS_HOST"
  printf 'API Host         : %s\n' "$API_HOST"
  printf 'Traefik config   : %s/%s\n' "$TRAEFIK_DYNAMIC_DIR" "$TRAEFIK_CONFIG_NAME"
  printf '\nContainer states:\n'
  docker compose -f "$COMPOSE_FILE" ps
}

do_rollback() {
  [[ -f "$PREVIOUS_SLOT_FILE" ]] || die "No previous slot recorded for rollback."
  local prev_slot
  prev_slot="$(cat "$PREVIOUS_SLOT_FILE")"
  local active_slot
  active_slot="$(cat "$ACTIVE_SLOT_FILE" 2>/dev/null || echo "blue")"
  [[ "$prev_slot" == "blue" || "$prev_slot" == "green" ]] || die "Invalid previous slot: $prev_slot"

  log "Initiating rollback to slot: $prev_slot"
  docker compose -f "$COMPOSE_FILE" up -d "9router-$prev_slot"
  wait_healthy "$prev_slot" || die "Previous slot failed healthcheck. Rollback aborted."

  render_traefik_config "$prev_slot" "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"
  printf '%s' "$prev_slot" > "$ACTIVE_SLOT_FILE"
  printf '%s' "$active_slot" > "$PREVIOUS_SLOT_FILE"
  log "Route successfully rolled back to slot: $prev_slot"

  log "Draining active slot ($active_slot) for 5 seconds..."
  sleep 5
  docker compose -f "$COMPOSE_FILE" stop "9router-$active_slot" || true
  log "Rollback completed."
}

# ------------------------------------------------------------------------------
# Main Dispatcher
# ------------------------------------------------------------------------------
cmd="${1:-}"

if [[ "$cmd" == "--status" ]]; then
  show_status
  exit 0
fi

if [[ "$cmd" == "--rollback" ]]; then
  do_rollback
  exit 0
fi

IMAGE_REF="${1:-}"
if [[ -z "$IMAGE_REF" ]]; then
  if [[ -f "$DEPLOYED_IMAGE_FILE" ]]; then
    IMAGE_REF="$(cat "$DEPLOYED_IMAGE_FILE")"
  else
    die "Usage: $0 <IMAGE_REF> | --rollback | --status"
  fi
fi
export IMAGE_REF

CURRENT_SLOT="green"
if [[ -f "$ACTIVE_SLOT_FILE" ]]; then
  CURRENT_SLOT="$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")"
fi

if [[ "$CURRENT_SLOT" == "blue" ]]; then
  TARGET_SLOT="green"
else
  TARGET_SLOT="blue"
fi

log "Starting deployment:"
log "  Image          : $IMAGE_REF"
log "  Current slot   : $CURRENT_SLOT"
log "  Target slot    : $TARGET_SLOT"
log "  Dashboard Host : $DASHBOARD_HOST ($DASHBOARD_ALIAS_HOST)"
log "  API Host       : $API_HOST"
log "  Traefik config : $TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"

ensure_network

# Start headroom helper service if not already up
docker compose -f "$COMPOSE_FILE" up -d headroom

# Pull and start target slot
export IMAGE_REF
log "Pulling target image..."
docker compose -f "$COMPOSE_FILE" pull "9router-$TARGET_SLOT"

log "Starting target container: 9router-$TARGET_SLOT"
docker compose -f "$COMPOSE_FILE" up -d --no-deps "9router-$TARGET_SLOT"

# Healthcheck candidate slot
if ! wait_healthy "$TARGET_SLOT"; then
  log "ABORT: Target slot $TARGET_SLOT unhealthy! Keeping $CURRENT_SLOT live."
  docker compose -f "$COMPOSE_FILE" stop "9router-$TARGET_SLOT" || true
  exit 1
fi

# Switch Traefik route atomically
log "Switching Traefik dynamic route to $TARGET_SLOT..."
render_traefik_config "$TARGET_SLOT" "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"

# Update state files
printf '%s' "$TARGET_SLOT" > "$ACTIVE_SLOT_FILE"
printf '%s' "$CURRENT_SLOT" > "$PREVIOUS_SLOT_FILE"
printf '%s' "$IMAGE_REF" > "$DEPLOYED_IMAGE_FILE"
log "Route updated. Active slot is now: $TARGET_SLOT"

# Graceful drain then stop idle slot
log "Draining old slot ($CURRENT_SLOT) for 5 seconds..."
sleep 5
if [[ "$CURRENT_SLOT" == "blue" || "$CURRENT_SLOT" == "green" ]]; then
  if [[ "$CURRENT_SLOT" != "$TARGET_SLOT" ]]; then
    log "Stopping idle container: 9router-$CURRENT_SLOT"
    docker compose -f "$COMPOSE_FILE" stop "9router-$CURRENT_SLOT" || true
  fi
fi

log "Deployment to $TARGET_SLOT completed successfully!"
