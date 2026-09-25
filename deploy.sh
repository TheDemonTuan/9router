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
HEADROOM_READY_TIMEOUT="${HEADROOM_READY_TIMEOUT:-60}"
TRAEFIK_CONFIG_NAME="${TRAEFIK_CONFIG_NAME-9router.yml}"


log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
stop_pull_heartbeat() {
  if [[ -n "${PULL_HEARTBEAT_PID:-}" ]]; then
    local pid="$PULL_HEARTBEAT_PID"
    PULL_HEARTBEAT_PID=""
    kill -TERM "$pid" 2>/dev/null || true
    pkill -TERM -P "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}
die() { stop_pull_heartbeat 2>/dev/null || true; log "ERROR: $*" >&2; exit 1; }

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


validate_traefik_config_name() {
  [[ "$TRAEFIK_CONFIG_NAME" =~ ^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(yml|yaml)$ && "$TRAEFIK_CONFIG_NAME" != *..* ]] ||
    die "Invalid TRAEFIK_CONFIG_NAME (expected a .yml/.yaml basename): $TRAEFIK_CONFIG_NAME"
}

validate_hosts() {
  python3 - "$API_HOST" "$DASHBOARD_HOST" "$DASHBOARD_ALIAS_HOST" <<'PY'
import ipaddress
import re
import sys

for name, host in zip(("API_HOST", "DASHBOARD_HOST", "DASHBOARD_ALIAS_HOST"), sys.argv[1:]):
    if name == "DASHBOARD_ALIAS_HOST" and not host:
        continue
    labels = host.split(".")
    if len(host) > 253 or not all(0 < len(label) <= 63 and
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label) for label in labels):
        sys.exit(f"Invalid DNS hostname in {name}")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        sys.exit(f"Invalid DNS hostname in {name}")
PY
}

resolve_traefik_dynamic_dir() {
  local mounts resolved
  [[ "$(docker inspect edge-traefik --format '{{.State.Running}}' 2>/dev/null)" == true ]] || die "edge-traefik is missing or stopped"
  mounts="$(docker inspect edge-traefik --format '{{json .Mounts}}')" || die "Cannot inspect edge-traefik mounts"
  resolved="$(python3 - "$mounts" <<'PY'
import json
import os
import sys

mounts = json.loads(sys.argv[1])
target = "/etc/traefik/dynamic"
matches = [mount for mount in mounts if mount.get("Destination") == target]
if len(matches) != 1 or matches[0].get("Type") != "bind":
    sys.exit("edge-traefik requires exactly one directory bind at " + target)
if any(mount.get("Destination", "").startswith(target + "/") for mount in mounts):
    sys.exit("edge-traefik has a nested mount hiding the generated route")
mount = matches[0]
source = mount.get("Source", "")
if (os.path.islink(source) or not os.path.isdir(source)
        or not os.stat(source).st_mode & 0o444 or not os.stat(source).st_mode & 0o222
        or not os.access(source, os.R_OK | os.W_OK)):
    sys.exit("edge-traefik dynamic bind source must be a readable, writable directory: " + source)
print(os.path.realpath(source))
PY
  )" || die "Cannot resolve Traefik dynamic directory"
  if [[ -n "${TRAEFIK_DYNAMIC_DIR:-}" ]]; then
    [[ -d "$TRAEFIK_DYNAMIC_DIR" && "$(realpath -- "$TRAEFIK_DYNAMIC_DIR")" == "$resolved" ]] ||
      die "TRAEFIK_DYNAMIC_DIR differs from edge-traefik bind source: $TRAEFIK_DYNAMIC_DIR"
  fi
  TRAEFIK_DYNAMIC_DIR="$resolved"
}

container_inventory() {
  local name="$1" found identity
  found="$(docker container ls -a --filter "name=^/$name$" --format '{{.Names}}')" || die "Cannot enumerate containers for $name"
  if [[ -z "$found" ]]; then
    printf 'absent\n'
    return 0
  fi
  [[ "$found" == "$name" ]] || die "Ambiguous container inventory for $name"
  identity="$(docker container inspect "$name" --format '{{.Id}}')" || die "Cannot inspect existing container $name"
  [[ -n "$identity" ]] || die "Empty container identity for $name"
  printf 'present\n'
}

verify_container_network() {
  local name="$1" attached="$2" state networks
  state="$(docker inspect "$name" --format '{{.State.Status}}')" || die "Cannot inspect $name state"
  networks="$(docker inspect "$name" --format '{{json .NetworkSettings.Networks}}')" || die "Cannot inspect $name networks"
  python3 - "$EDGE_NETWORK" "$networks" <<'PY' || die "$name is not configured on $EDGE_NETWORK"
import json
import sys

networks = json.loads(sys.argv[2])
if not isinstance(networks, dict) or sys.argv[1] not in networks:
    sys.exit(1)
PY
  if [[ "$state" == running ]]; then
    [[ $'\n'"$attached"$'\n' == *$'\n'"$name"$'\n'* ]] || die "$name is not attached to $EDGE_NETWORK"
  fi
}

preflight() {
  [[ "$(uname -s)" == Linux ]] || die "Deploy requires Linux Bash and coreutils"
  local executable
  for executable in bash python3 curl flock realpath stat timeout docker; do
    command -v "$executable" >/dev/null 2>&1 || die "Missing required executable: $executable"
  done
  docker compose version >/dev/null 2>&1 || die "Docker Compose is unavailable"
  [[ "${ROUTE_TIMEOUT:-30}" =~ ^[0-9]+$ ]] && (( 10#${ROUTE_TIMEOUT:-30} >= 2 )) || die "ROUTE_TIMEOUT must be an integer >= 2"
  validate_hosts || die "Invalid deployment hostname"
  validate_traefik_config_name
  resolve_traefik_dynamic_dir
  local attached
  attached="$(docker network inspect "$EDGE_NETWORK" --format '{{range .Containers}}{{println .Name}}{{end}}')" ||
    die "Missing edge network: $EDGE_NETWORK"
  [[ $'\n'"$attached"$'\n' == *$'\nedge-traefik\n'* ]] || die "edge-traefik is not attached to $EDGE_NETWORK"
  BLUE_PRESENT="$(container_inventory 9router-blue)" || die "Cannot establish blue container inventory"
  GREEN_PRESENT="$(container_inventory 9router-green)" || die "Cannot establish green container inventory"
  if [[ "$BLUE_PRESENT" == present ]]; then verify_container_network 9router-blue "$attached"; fi
  if [[ "$GREEN_PRESENT" == present ]]; then verify_container_network 9router-green "$attached"; fi
  local route="$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"
  local slot="" gen="" route_info
  if route_info="$(read_active_route_slot "$route")"; then
    read -r slot gen <<< "$route_info"
  else
    die "Unsupported generated route: $route"
  fi
  if [[ -z "$slot" ]] && { [[ -e "$ACTIVE_SLOT_FILE" || -L "$ACTIVE_SLOT_FILE" || -e "$DEPLOYED_IMAGE_FILE" || -L "$DEPLOYED_IMAGE_FILE" ]] ||
       [[ "$BLUE_PRESENT" == present || "$GREEN_PRESENT" == present ]]; }; then
    die "Missing generated route $route; restore a verified backup before deployment"
  fi
  if [[ -z "$slot" && "${1:-}" != status ]]; then
    [[ "$(probe_observed_slot 1 5 bootstrap)" == none ]] || die "Bootstrap requires public HTTP 404 without health identity"
  fi
  printf '%s\n' "$TRAEFIK_DYNAMIC_DIR"
}

probe_observed_slot() {
  local attempt="${1:-1}" max_time="${2:-5}" mode="${3:-route}"
  local temp_root=/tmp tmp status observed request_id
  if [[ "${TRAEFIK_DYNAMIC_DIR:-}" == / ]]; then return 1; fi
  if [[ "${TRAEFIK_DYNAMIC_DIR:-}" == /tmp ]]; then temp_root=/var/tmp; fi
  tmp="$(mktemp -d -p "$temp_root" 9router-probe.XXXXXXXX)" || return 1
  request_id="$(python3 -c 'import uuid; print(uuid.uuid4())')" || { rm -rf -- "$tmp"; return 1; }
  if ! status="$(curl --silent --show-error --connect-timeout 2 --max-time "$max_time" \
      -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
      --dump-header "$tmp/headers" --output "$tmp/body" --write-out '%{http_code}' \
      "https://${API_HOST}/api/health?deploy_probe=${request_id}-${attempt}")"; then
    rm -rf -- "$tmp"
    return 1
  fi
  if observed="$(python3 - "$status" "$tmp/headers" "$tmp/body" "$mode" <<'PY'
import json
import re
import sys

status, header_path, body_path, mode = sys.argv[1:]

def fail(reason):
    sys.exit("public route probe: " + reason)

headers = {}
try:
    with open(header_path, encoding="iso-8859-1") as source:
        for line in source:
            if line.startswith("HTTP/"):
                headers.clear()
            elif ":" in line:
                name, value = line.split(":", 1)
                headers.setdefault(name.strip().lower(), []).append(value.strip())
    for age in headers.get("age", []):
        if not age.isdecimal() or int(age) > 0:
            fail("cached response")
    if any(value.upper() in ("HIT", "STALE", "UPDATING", "REVALIDATED")
           for value in headers.get("cf-cache-status", [])):
        fail("cached response")

    def unique_pairs(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError("duplicate JSON key")
            result[name] = value
        return result

    with open(body_path, encoding="utf-8") as source:
        body = source.read()
    try:
        payload = json.loads(body, object_pairs_hook=unique_pairs)
    except json.JSONDecodeError:
        payload = None
    valid = (isinstance(payload, dict) and payload.get("ok") is True
             and payload.get("deployment_slot") in ("blue", "green"))
    if status == "404" and mode == "bootstrap" and not valid:
        print("none")
    elif status == "200" and valid:
        gen_headers = headers.get("x-9router-route-generation", [])
        if len(gen_headers) == 1:
            gen = gen_headers[0]
            if not re.fullmatch(r"[0-9a-fA-F]{32}", gen):
                fail("invalid route generation header")
            print(f"{payload['deployment_slot']} {gen.lower()}")
        elif not gen_headers and mode == "legacy":
            print(f"{payload['deployment_slot']} legacy")
        else:
            fail("missing or duplicate route generation header")
    else:
        fail("unexpected HTTP status or health identity")
except (OSError, UnicodeError, ValueError) as error:
    fail(str(error))
PY
  )"; then
    rm -rf -- "$tmp"
    printf '%s\n' "$observed"
  else
    rm -rf -- "$tmp"
    return 1
  fi
}

wait_route_slot() {
  local expected_slot="$1" expected_gen="${2:-}" timeout="${ROUTE_TIMEOUT:-30}" deadline attempt=0 streak=0 observed remaining expected mode
  [[ "$timeout" =~ ^[0-9]+$ ]] && (( 10#$timeout >= 2 )) || die "ROUTE_TIMEOUT must be an integer >= 2"
  if [[ "$expected_slot" == none ]]; then
    expected="none"
    mode="bootstrap"
  elif [[ "$expected_gen" == legacy ]]; then
    expected="$expected_slot legacy"
    mode="legacy"
  else
    [[ -n "$expected_gen" ]] || die "wait_route_slot requires generation for slot $expected_slot"
    expected="$expected_slot ${expected_gen,,}"
    mode="route"
  fi
  deadline=$((SECONDS + 10#$timeout))
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    remaining=$((deadline - SECONDS))
    if (( remaining > 5 )); then remaining=5; fi
    if observed="$(probe_observed_slot "$attempt" "$remaining" "$mode" 2>/dev/null)" && [[ "$observed" == "$expected" ]]; then
      streak=$((streak + 1))
      if (( streak == 2 )); then return 0; fi
    else
      streak=0
    fi
    sleep 1
  done
  return 1
}
read_active_route_slot() {

  python3 - "$1" "$TRAEFIK_DYNAMIC_DIR" <<'PY'
import os
import re
import stat
import sys

route, dynamic_dir = sys.argv[1:]

def fail(path, reason):
    sys.exit(f"{path}: {reason}")

for directory, dirs, files in os.walk(dynamic_dir, onerror=lambda error: fail(error.filename, str(error))):
    for name in dirs + files:
        path = os.path.join(directory, name)
        if os.path.islink(path):
            fail(path, "symlink in Traefik dynamic directory")
    for name in files:
        path = os.path.join(directory, name)
        if path == route or not name.lower().endswith((".yml", ".yaml", ".toml")):
            continue
        if not stat.S_ISREG(os.stat(path).st_mode):
            fail(path, "Traefik configuration must be a regular file")
        if not os.stat(path).st_mode & 0o444:
            fail(path, "unreadable Traefik configuration")
        try:
            with open(path, encoding="utf-8") as other:
                content = other.read()
        except (OSError, UnicodeError) as error:
            fail(path, f"unreadable Traefik configuration: {error}")
        for token in ("9router-service", "9router-api-router", "9router-dashboard-router", "9router-route-generation"):
            if token in content:
                fail(path, f"duplicate route token {token}")

return_slot = None
return_gen = None

if not os.path.exists(route):
    pass
else:
    if os.path.islink(route) or not os.path.isfile(route):
        fail(route, "generated route must be a regular file")
    if not os.stat(route).st_mode & 0o444:
        fail(route, "unreadable generated route")
    try:
        with open(route, encoding="utf-8") as generated:
            lines = generated.read().replace("\r\n", "\n").splitlines()
    except (OSError, UnicodeError) as error:
        fail(route, f"unreadable generated route: {error}")
    nodes = []
    stack = []
    for line in lines:
        if "\t" in line or re.match(r"^\s*(?:---|\.\.\.)(?:\s|$)", line) or re.search(r"(?:^|[\s:\[,{])[&*][\w-]+", line):
            fail(route, "unsupported YAML tab, document marker, anchor, or alias")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        while stack and nodes[stack[-1]][0] >= indent:
            stack.pop()
        parent = stack[-1] if stack else None
        nodes.append((indent, stripped, parent))
        stack.append(len(nodes) - 1)

    for key in ("http", "services", "9router-service", "loadBalancer", "servers"):
        if sum(bool(re.fullmatch(re.escape(key) + r"\s*:", text)) for _, text, _ in nodes) != 1:
            fail(route, f"expected exactly one {key} key")

    def children(parent, indentation, text):
        return [index for index, (depth, value, owner) in enumerate(nodes)
                if owner == parent and depth == indentation and re.fullmatch(text, value)]

    def one(parent, indentation, text):
        found = children(parent, indentation, text)
        if len(found) != 1:
            fail(route, f"expected exactly one {text} at indentation {indentation}")
        return found[0]

    http = one(None, 0, r"http:")
    services = one(http, 2, r"services:")
    service = one(services, 4, r"9router-service:")
    balancer = one(service, 6, r"loadBalancer:")
    servers = one(balancer, 8, r"servers:")
    urls = [index for index, (_, _, owner) in enumerate(nodes) if owner == servers]
    if len(urls) != 1 or nodes[urls[0]][0] != 10:
        fail(route, "expected exactly one generated backend URL")
    match = re.fullmatch(r'- url: "http://9router-(blue|green):20128"', nodes[urls[0]][1])
    if not match:
        fail(route, "unsupported generated backend URL")
    for index, (_, text, _) in enumerate(nodes):
        ancestor = index
        while ancestor is not None and ancestor != service:
            ancestor = nodes[ancestor][2]
        if ancestor == service and index != urls[0] and (re.search(r"\burl\s*:", text) or re.search(r"9router-(?:blue|green)", text)):
            fail(route, "extra backend in generated service")
    return_slot = match.group(1)

    mw_nodes = children(http, 2, r"middlewares:")
    if mw_nodes:
        middlewares = mw_nodes[0]
        gen_mws = children(middlewares, 4, r"9router-route-generation:")
        if gen_mws:
            gen_mw = gen_mws[0]
            headers = one(gen_mw, 6, r"headers:")
            custom_headers = one(headers, 8, r"customResponseHeaders:")
            gen_nodes = [index for index, (depth, value, owner) in enumerate(nodes)
                         if owner == custom_headers and depth == 10 and re.match(r"^X-9Router-Route-Generation:\s*", value)]
            if len(gen_nodes) != 1:
                fail(route, "expected exactly one X-9Router-Route-Generation header")
            gen_match = re.fullmatch(r'X-9Router-Route-Generation:\s*"?([0-9a-fA-F]{32})"?', nodes[gen_nodes[0]][1])
            if not gen_match:
                fail(route, "invalid generation token in generated route")
            return_gen = gen_match.group(1).lower()

if return_slot is not None:
    if return_gen is not None:
        print(f"{return_slot} {return_gen}")
    else:
        print(f"{return_slot} legacy")
PY
}

render_traefik_config() {
  local slot="$1"
  local dest="$2"
  local gen="${3:-${ROUTE_GENERATION:-}}"
  if [[ -z "$gen" ]]; then
    gen="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')" || return 1
  fi
  [[ "$gen" =~ ^[0-9a-fA-F]{32}$ ]] || die "Invalid route generation token: $gen"
  gen="${gen,,}"
  local tmp="${dest}.tmp.$$"
  [[ -d "$(dirname "$dest")" ]] || die "Traefik dynamic directory is missing: $(dirname "$dest")"

  local dashboard_rule="Host(\`${DASHBOARD_HOST}\`)"
  local internal_hosts_rule="Host(\`${DASHBOARD_HOST}\`) || Host(\`${API_HOST}\`)"
  if [[ -n "${DASHBOARD_ALIAS_HOST:-}" ]]; then
    dashboard_rule="Host(\`${DASHBOARD_HOST}\`) || Host(\`${DASHBOARD_ALIAS_HOST}\`)"
    internal_hosts_rule="Host(\`${DASHBOARD_HOST}\`) || Host(\`${DASHBOARD_ALIAS_HOST}\`) || Host(\`${API_HOST}\`)"
  fi

  cat <<EOF > "$tmp"
# Managed dynamically by 9router deploy.sh - DO NOT EDIT MANUALLY
http:
  middlewares:
    9router-route-generation:
      headers:
        customResponseHeaders:
          X-9Router-Route-Generation: "${gen}"

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
        - 9router-route-generation
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
        - 9router-route-generation
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
  chmod 644 "$tmp" || return 1
  NEW_ROUTE_INODE="$(stat -c '%d:%i' "$tmp")" || return 1
  NEW_ROUTE_GENERATION="$gen"
  mv -f "$tmp" "$dest"
}

wait_healthy() {
  local slot="$1" deadline=$((SECONDS + READY_TIMEOUT))
  while (( SECONDS < deadline )); do
    if direct_slot_healthy "$slot"; then
      log "Slot $slot is healthy with matching identity."
      return 0
    fi
    sleep 2
  done
  log "Slot $slot failed direct health identity within ${READY_TIMEOUT}s"
  return 1
}

wait_headroom_ready() {
  local timeout="${HEADROOM_READY_TIMEOUT}" deadline status
  if [[ ! "$timeout" =~ ^[0-9]+$ || "$timeout" -le 0 ]]; then
    die "HEADROOM_READY_TIMEOUT must be a positive integer: $timeout"
  fi
  deadline=$((SECONDS + timeout))
  log "Waiting for 9router-headroom readiness (timeout ${timeout}s)..."

  while (( SECONDS < deadline )); do
    status="$(docker inspect 9router-headroom --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      log "9router-headroom is healthy."
      return 0
    fi
    if [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]]; then
      docker logs --tail 50 9router-headroom >&2 2>/dev/null || true
      die "9router-headroom entered failed state: $status"
    fi
    sleep 1
  done

  docker logs --tail 50 9router-headroom >&2 2>/dev/null || true
  die "9router-headroom failed readiness within ${timeout}s (last status: ${status:-unknown})"
}

container_image() {
  local image
  image="$(docker inspect "9router-$1" --format '{{.Image}}' 2>/dev/null)" || return 1
  [[ -n "$image" ]] || return 1
  printf '%s\n' "$image"
}

write_metadata() {
  local dest="$SCRIPT_DIR/$1" value="$2" temp
  temp="$(mktemp "$SCRIPT_DIR/.$1.tmp.XXXXXXXX")" || return 1
  if ! printf '%s' "$value" > "$temp" || ! mv -f -- "$temp" "$dest"; then
    rm -f -- "$temp"
    return 1
  fi
}

sync_metadata() {
  local slot="$1" previous="$2" image="$3"
  write_metadata "$DEPLOYED_IMAGE_FILE" "$image" || die "Metadata image update failed; reconcile from configured YAML"
  if [[ -n "$previous" ]]; then
    write_metadata "$PREVIOUS_SLOT_FILE" "$previous" || die "Metadata previous-slot update failed; reconcile from configured YAML"
  else
    rm -f -- "$PREVIOUS_SLOT_FILE" || die "Metadata previous-slot removal failed; reconcile from configured YAML"
  fi
  write_metadata "$ACTIVE_SLOT_FILE" "$slot" || die "Metadata active-slot update failed; reconcile from configured YAML"
}

report_route_state() {
  local configured_slot=unknown configured_gen=unknown observed_slot=unknown observed_gen=unknown route_info probe_info
  if route_info="$(read_active_route_slot "$ROUTE_PATH" 2>/dev/null)"; then
    read -r configured_slot configured_gen <<< "$route_info"
    configured_slot="${configured_slot:-none}"
    configured_gen="${configured_gen:-none}"
  fi
  if probe_info="$(probe_observed_slot recovery 5 bootstrap 2>/dev/null)"; then
    if [[ "$probe_info" == none ]]; then
      observed_slot=none
      observed_gen=none
    else
      read -r observed_slot observed_gen <<< "$probe_info"
      observed_slot="${observed_slot:-unknown}"
      observed_gen="${observed_gen:-unknown}"
    fi
  fi
  log "Configured route slot: $configured_slot gen: $configured_gen; observed Traefik slot: $observed_slot gen: $observed_gen"
}

recover_pending_route() {
  local original_rc="$1" restore_tmp="" restored=false
  trap - EXIT INT TERM
  if [[ "${PENDING_ROUTE:-false}" == true ]]; then
    if [[ -n "$SNAPSHOT_PATH" ]]; then
      if restore_tmp="$(mktemp "$TRAEFIK_DYNAMIC_DIR/.9router-restore.XXXXXXXX")" &&
         cp -- "$SNAPSHOT_PATH" "$restore_tmp" && chmod 644 "$restore_tmp" && mv -f -- "$restore_tmp" "$ROUTE_PATH"; then
        restored=true
      else
        [[ -z "$restore_tmp" ]] || rm -f -- "$restore_tmp" || true
      fi
    elif [[ ! -e "$ROUTE_PATH" && ! -L "$ROUTE_PATH" ]]; then
      restored=true
    elif [[ -n "${NEW_ROUTE_INODE:-}" && "$(stat -c '%d:%i' "$ROUTE_PATH" 2>/dev/null)" == "$NEW_ROUTE_INODE" ]] &&
         rm -f -- "$ROUTE_PATH"; then
      restored=true
    fi
    if [[ "$restored" == true ]] && wait_route_slot "${ORIGINAL_ROUTE_SLOT:-none}" "${ORIGINAL_ROUTE_GEN:-}"; then
      log "Original route acknowledged after failure."
      [[ -z "$SNAPSHOT_PATH" ]] || rm -f -- "$SNAPSHOT_PATH" || true
    else
      log "ERROR: Original route not acknowledged; keep both containers and snapshot: ${SNAPSHOT_PATH:-none}"
      report_route_state
    fi
  fi
  (( original_rc != 0 )) || original_rc=1
  exit "$original_rc"
}

route_cutover() {
  local new_slot="$1" old_slot="$2"
  ROUTE_PATH="$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"
  ORIGINAL_ROUTE_SLOT="$old_slot"
  ORIGINAL_ROUTE_GEN=""
  SNAPSHOT_PATH=""
  NEW_ROUTE_INODE=""
  NEW_ROUTE_GENERATION=""
  if [[ -f "$ROUTE_PATH" ]]; then
    local orig_info
    if orig_info="$(read_active_route_slot "$ROUTE_PATH" 2>/dev/null)"; then
      read -r _ ORIGINAL_ROUTE_GEN <<< "$orig_info"
    fi
  fi
  if [[ -n "$old_slot" ]]; then
    SNAPSHOT_PATH="$(mktemp "$TRAEFIK_DYNAMIC_DIR/.9router-snapshot.XXXXXXXX")" || return 1
    cp -- "$ROUTE_PATH" "$SNAPSHOT_PATH" || { rm -f -- "$SNAPSHOT_PATH"; return 1; }
  fi
  PENDING_ROUTE=true
  trap 'recover_pending_route $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  render_traefik_config "$new_slot" "$ROUTE_PATH" || return 1
  wait_route_slot "$new_slot" "$NEW_ROUTE_GENERATION" || return 1
  PENDING_ROUTE=false
  trap - EXIT INT TERM
  [[ -z "$SNAPSHOT_PATH" ]] || rm -f -- "$SNAPSHOT_PATH" || log "Snapshot cleanup deferred: $SNAPSHOT_PATH"
}

reconcile_active_slot() {
  preflight mutation
  local route_info configured="" configured_gen="" previous="" image
  if route_info="$(read_active_route_slot "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME")"; then
    read -r configured configured_gen <<< "$route_info"
  else
    die "Cannot read configured route"
  fi
  if [[ -z "$configured" ]]; then
    log "Verified bootstrap; no route to reconcile."
    return 0
  fi
  wait_healthy "$configured" || die "Configured slot $configured failed direct health identity"
  image="$(container_image "$configured")" || die "Cannot inspect configured container image"
  if [[ -f "$PREVIOUS_SLOT_FILE" ]]; then
    previous="$(cat "$PREVIOUS_SLOT_FILE")"
    if [[ "$previous" == "$configured" || ( "$previous" != blue && "$previous" != green ) ]] ||
       ! docker inspect "9router-$previous" >/dev/null 2>&1; then
      previous=""
    fi
  fi
  route_cutover "$configured" "$configured"
  sync_metadata "$configured" "$previous" "$image"
  log "Reconciled mirrors from configured route: $configured"
}

direct_slot_healthy() {
  local slot="$1" mode="${2:-health}" container="9router-$1" hostname health
  hostname="$(docker inspect "$container" --format '{{.Config.Hostname}}' 2>/dev/null)" || return 1
  [[ -n "$hostname" ]] || return 1
  health="$(timeout 6 docker exec "$container" wget -T 5 -qO- http://127.0.0.1:20128/api/health 2>/dev/null)" || return 1
  python3 - "$slot" "$hostname" "$health" "$mode" <<'PY' >/dev/null
import json
import sys

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

try:
    payload = json.loads(sys.argv[3], object_pairs_hook=unique_pairs)
    identity = payload.get("instance_id")
    prefix = sys.argv[2] + "-"
    if (payload.get("ok") is not True or payload.get("deployment_slot") != sys.argv[1]
            or not isinstance(identity, str) or not identity.startswith(prefix)
            or not identity[len(prefix):].isdecimal() or int(identity[len(prefix):]) <= 0):
        sys.exit(1)
    if sys.argv[4] == "idle" and (payload.get("active_requests_known") is not True
            or type(payload.get("active_requests")) is not int or payload["active_requests"] != 0):
        sys.exit(1)
except (AttributeError, ValueError, TypeError):
    sys.exit(1)
PY
}

get_slot_drain_info() {
  local slot="$1" container="9router-$1" hostname health
  hostname="$(docker inspect "$container" --format '{{.Config.Hostname}}' 2>/dev/null)" || {
    printf 'UNKNOWN -1 -1 -1\n'
    return 1
  }
  [[ -n "$hostname" ]] || {
    printf 'UNKNOWN -1 -1 -1\n'
    return 1
  }
  health="$(timeout 6 docker exec "$container" wget -T 5 -qO- http://127.0.0.1:20128/api/health 2>/dev/null)" || {
    printf 'UNKNOWN -1 -1 -1\n'
    return 1
  }
  python3 - "$slot" "$hostname" "$health" <<'PY'
import json
import sys

slot, hostname, raw_health = sys.argv[1:4]

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

try:
    payload = json.loads(raw_health, object_pairs_hook=unique_pairs)
    prefix = hostname + "-"
    identity = payload.get("instance_id")
    if (payload.get("ok") is not True or payload.get("deployment_slot") != slot
            or not isinstance(identity, str) or not identity.startswith(prefix)
            or not identity[len(prefix):].isdecimal() or int(identity[len(prefix):]) <= 0):
        print("UNKNOWN -1 -1 -1")
        sys.exit(0)

    if payload.get("active_requests_known") is not True:
        print("UNKNOWN -1 -1 -1")
        sys.exit(0)

    active_req = payload.get("active_requests")
    if not isinstance(active_req, int) or active_req < 0:
        print("UNKNOWN -1 -1 -1")
        sys.exit(0)

    streams = payload.get("active_streams", -1)
    if not isinstance(streams, int) or streams < 0:
        streams = -1

    oldest_ms = payload.get("oldest_active_ms")
    if not isinstance(oldest_ms, int) or oldest_ms < 0:
        oldest_ms = -1

    if active_req == 0:
        print(f"IDLE 0 {streams} {oldest_ms}")
    else:
        print(f"ACTIVE {active_req} {streams} {oldest_ms}")
except Exception:
    print("UNKNOWN -1 -1 -1")
PY
}

slot_drain_state() {
  local info state
  info="$(get_slot_drain_info "$1")" || info="UNKNOWN -1 -1 -1"
  read -r state _ <<< "$info"
  printf '%s\n' "$state"
}

handoff_old_slot_to_drain() {
  local slot="$1"
  local fast_deadline=$((SECONDS + FAST_DRAIN_TIMEOUT))
  local info state count streams oldest_ms

  while (( SECONDS < fast_deadline )); do
    info="$(get_slot_drain_info "$slot")" || info="UNKNOWN -1 -1 -1"
    read -r state count streams oldest_ms <<< "$info"
    if [[ "$state" == IDLE ]]; then
      log "[drain] $slot idle"
      compose stop "9router-$slot" || log "WARN: failed to stop idle slot $slot"
      return 0
    fi
    sleep 1
  done

  info="$(get_slot_drain_info "$slot")" || info="UNKNOWN -1 -1 -1"
  read -r state count streams oldest_ms <<< "$info"
  case "$state" in
    IDLE)
      log "[drain] $slot idle"
      compose stop "9router-$slot" || log "WARN: failed to stop idle slot $slot"
      ;;
    ACTIVE)
      local diag=""
      if [[ "$oldest_ms" =~ ^[0-9]+$ && "$oldest_ms" -ge 0 ]]; then
        local oldest_s=$(( oldest_ms / 1000 ))
        diag=" (streams=${streams}, oldest=${oldest_s}s)"
      fi
      log "[drain] $slot active_requests=$count$diag; keeping container running for deferred drain"
      ;;
    *)
      log "[drain] $slot state unknown; leaving container untouched"
      ;;
  esac
}

cleanup_draining_slots() {
  local route_path="$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME"
  local route_info current="" current_gen=""
  if ! route_info="$(read_active_route_slot "$route_path" 2>/dev/null)"; then
    log "[cleaner] Cannot read active route from $route_path; skipping cleanup"
    return 0
  fi
  read -r current current_gen <<< "$route_info"
  if [[ "$current" != blue && "$current" != green ]]; then
    log "[cleaner] No active blue/green slot in route; skipping cleanup"
    return 0
  fi

  for slot in blue green; do
    [[ "$slot" != "$current" ]] || continue

    local container="9router-$slot"
    local c_state
    c_state="$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || true)"
    [[ "$c_state" == running ]] || continue

    local info state count streams oldest_ms
    info="$(get_slot_drain_info "$slot")" || info="UNKNOWN -1 -1 -1"
    read -r state count streams oldest_ms <<< "$info"

    case "$state" in
      IDLE)
        # Double check route and generation to prevent race with rollback or new deployment
        local recheck_info recheck_slot recheck_gen
        if ! recheck_info="$(read_active_route_slot "$route_path" 2>/dev/null)"; then
          log "[cleaner] Route re-read failed before stopping $slot; aborting stop"
          continue
        fi
        read -r recheck_slot recheck_gen <<< "$recheck_info"
        if [[ -n "${FAKE_GEN_CHANGE_RECHECK:-}" ]]; then
          recheck_gen="99999999999999999999999999999999"
        fi
        if [[ "$recheck_slot" != "$current" || "$recheck_gen" != "$current_gen" ]]; then
          log "[cleaner] Route changed ($current@$current_gen -> $recheck_slot@$recheck_gen); aborting stop for $slot"
          continue
        fi

        log "[cleaner] Slot $slot is idle (active_requests=0); stopping container"
        compose stop "$container" || log "WARN: [cleaner] failed to stop $container"
        ;;
      ACTIVE)
        local diag=""
        if [[ "$oldest_ms" =~ ^[0-9]+$ && "$oldest_ms" -gt 60000 ]]; then
          local oldest_m=$(( oldest_ms / 60000 ))
          diag=" (active for ${oldest_m}m, streams=${streams})"
        fi
        log "[cleaner] Slot $slot still draining (active_requests=$count)$diag"
        ;;
      UNKNOWN)
        log "[cleaner] WARN: cannot verify $slot drain state; leaving container untouched"
        ;;
    esac
  done
}

show_status() {
  local strict="${1:-false}" configured_slot=unknown configured_gen=unknown observed_slot=unknown observed_gen=unknown mirror=none
  local blue green directory=unknown reason="" prepared health_ok=false route_info probe_info
  if prepared="$(preflight status 2>&1)"; then
    directory="$prepared"
    TRAEFIK_DYNAMIC_DIR="$directory"
    if route_info="$(read_active_route_slot "$directory/$TRAEFIK_CONFIG_NAME" 2>/dev/null)"; then
      read -r configured_slot configured_gen <<< "$route_info"
      configured_slot="${configured_slot:-none}"
      configured_gen="${configured_gen:-none}"
    else
      configured_slot=unknown
      configured_gen=unknown
    fi
  else
    reason="preflight failed: ${prepared##*$'\n'}"
    directory="${TRAEFIK_DYNAMIC_DIR:-unknown}"
  fi
  if validate_hosts 2>/dev/null; then
    if probe_info="$(probe_observed_slot status 5 bootstrap 2>/dev/null)"; then
      if [[ "$probe_info" == none ]]; then
        observed_slot=none
        observed_gen=none
      else
        read -r observed_slot observed_gen <<< "$probe_info"
        observed_slot="${observed_slot:-unknown}"
        observed_gen="${observed_gen:-unknown}"
      fi
    else
      observed_slot=unknown
      observed_gen=unknown
    fi
  else
    reason="${reason:-invalid deployment hostname}"
  fi
  if [[ -f "$ACTIVE_SLOT_FILE" ]]; then mirror="$(cat "$ACTIVE_SLOT_FILE")"; fi
  blue="$(docker inspect 9router-blue --format '{{.State.Status}}' 2>/dev/null)" || blue=missing
  green="$(docker inspect 9router-green --format '{{.State.Status}}' 2>/dev/null)" || green=missing
  if [[ "$configured_slot" == blue && "$blue" == running ]] || [[ "$configured_slot" == green && "$green" == running ]]; then
    if direct_slot_healthy "$configured_slot"; then health_ok=true; fi
  fi
  printf 'Configured route slot: %s\n' "$configured_slot"
  printf 'Configured route generation: %s\n' "$configured_gen"
  printf 'Observed Traefik slot: %s\n' "$observed_slot"
  printf 'Observed Traefik generation: %s\n' "$observed_gen"
  printf 'Mirror .active-slot: %s\n' "$mirror"
  printf 'Blue container: %s\n' "$blue"
  printf 'Green container: %s\n' "$green"
  printf 'Traefik dynamic dir: %s\n' "$directory"

  for s in blue green; do
    local c_status
    if [[ "$s" == blue ]]; then c_status="$blue"; else c_status="$green"; fi
    printf '\n%s\n' "$s"
    if [[ "$c_status" != running ]]; then
      printf '  state: STANDBY / STOPPED\n'
      printf '  container: %s\n' "$c_status"
    elif [[ "$s" == "$configured_slot" ]]; then
      printf '  state: ACTIVE\n'
      printf '  container: running\n'
      local s_info s_st s_cnt s_str s_old
      s_info="$(get_slot_drain_info "$s" 2>/dev/null)" || s_info="UNKNOWN -1 -1 -1"
      read -r s_st s_cnt s_str s_old <<< "$s_info"
      if [[ "$s_cnt" -ge 0 ]]; then
        printf '  active_requests: %s\n' "$s_cnt"
      fi
    else
      local s_info s_st s_cnt s_str s_old
      s_info="$(get_slot_drain_info "$s" 2>/dev/null)" || s_info="UNKNOWN -1 -1 -1"
      read -r s_st s_cnt s_str s_old <<< "$s_info"
      if [[ "$s_st" == IDLE ]]; then
        printf '  state: STANDBY (idle)\n'
        printf '  container: running\n'
        printf '  active_requests: 0\n'
      elif [[ "$s_st" == ACTIVE ]]; then
        printf '  state: DRAINING\n'
        printf '  container: running\n'
        printf '  active_requests: %s\n' "$s_cnt"
        if [[ "$s_old" =~ ^[0-9]+$ && "$s_old" -ge 0 ]]; then
          local old_sec=$(( s_old / 1000 ))
          if (( old_sec >= 60 )); then
            printf '  oldest_active: %dm%ds\n' $(( old_sec / 60 )) $(( old_sec % 60 ))
          else
            printf '  oldest_active: %ds\n' "$old_sec"
          fi
        fi
      else
        printf '  state: DRAINING (unknown)\n'
        printf '  container: running\n'
      fi
    fi
  done
  printf '\n'

  if [[ -z "$reason" && ( "$configured_slot" == blue || "$configured_slot" == green ) &&
        "$configured_slot" == "$observed_slot" && "$configured_gen" == "$observed_gen" &&
        "$configured_gen" != none && "$configured_gen" != unknown &&
        "$configured_slot" == "$mirror" && "$health_ok" == true ]]; then
    printf 'Route state: HEALTHY\n'
  else
    printf 'Route state: MISMATCH\n'
    printf 'Reason: %s\n' "${reason:-configured/observed/mirror mismatch or direct health identity invalid}"
    [[ "$strict" == false ]]
  fi
}

do_rollback() {
  preflight mutation
  local route_info current="" current_gen="" target state old_state image observed
  if route_info="$(read_active_route_slot "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME")"; then
    read -r current current_gen <<< "$route_info"
  else
    die "Cannot read configured route"
  fi
  [[ "$current" == blue || "$current" == green ]] || die "Cannot rollback without a configured route"
  [[ -f "$PREVIOUS_SLOT_FILE" ]] || die "No previous slot recorded for rollback"
  target="$(cat "$PREVIOUS_SLOT_FILE")"
  [[ ( "$target" == blue || "$target" == green ) && "$target" != "$current" ]] || die "Invalid previous slot: $target"
  docker inspect "9router-$target" >/dev/null 2>&1 || die "Previous container is missing: 9router-$target"
  observed="$(probe_observed_slot rollback 5 2>/dev/null)" || observed=unknown
  log "Rollback configured=$current observed=$observed target=$target"
  state="$(docker inspect "9router-$target" --format '{{.State.Status}}')" || die "Cannot inspect previous container"
  if [[ "$state" != running ]]; then
    docker start "9router-$target" || die "Cannot start existing previous container"
  fi
  wait_healthy "$target" || die "Previous slot failed direct health identity"
  image="$(container_image "$target")" || die "Cannot inspect previous container image"
  old_state="$(docker inspect "9router-$current" --format '{{.State.Status}}' 2>/dev/null)" || old_state=missing
  route_cutover "$target" "$current"
  sync_metadata "$target" "$current" "$image"
  log "Rollback completed to $target"
  if [[ "$old_state" == running ]]; then
    handoff_old_slot_to_drain "$current"
  fi
}

run_diagnostics() {
  log "=== [DIAG] Docker disk/cache ==="
  docker system df -v 2>/dev/null || true

  log "=== [DIAG] Cached images for 9router ==="
  docker image ls --digests "ghcr.io/*" 2>/dev/null || true

  if [[ -n "${IMAGE_REF:-}" ]]; then
    if docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
      log "[DIAG] EXACT IMAGE CACHED: $IMAGE_REF"
      docker inspect "$IMAGE_REF" --format 'Size: {{.Size}} bytes, Created: {{.Created}}, Layers: {{len .RootFS.Layers}}' 2>/dev/null || true
    else
      log "[DIAG] EXACT IMAGE NOT CACHED: $IMAGE_REF"
      local manifest_summary
      manifest_summary="$(inspect_manifest_summary "$IMAGE_REF")"
      if [[ -n "$manifest_summary" ]]; then
        log "[DIAG] REMOTE MANIFEST: $manifest_summary"
      fi
    fi
  fi

  log "=== [DIAG] Docker daemon config ==="
  cat /etc/docker/daemon.json 2>/dev/null || true
  if [[ -f /etc/docker/daemon.json ]]; then
    local configured_dl
    configured_dl="$(python3 -c 'import json, sys; d=json.load(open(sys.argv[1])); print(d.get("max-concurrent-downloads", "unset (Docker default: 3)"))' /etc/docker/daemon.json 2>/dev/null || echo "parse error")"
    log "[DIAG] max-concurrent-downloads: $configured_dl"
  else
    log "[DIAG] /etc/docker/daemon.json absent (Docker default: 3)"
  fi

  log "=== [DIAG] Registry DNS & Nameservers ==="
  cat /etc/resolv.conf 2>/dev/null | grep -E '^nameserver' || true
  getent ahosts ghcr.io 2>/dev/null || true
  getent ahosts pkg-containers.githubusercontent.com 2>/dev/null || true

  log "=== [DIAG] IPv4 connectivity & latency ==="
  curl -4 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'ghcr ipv4: namelookup=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s code=%{http_code}\n' \
    https://ghcr.io/v2/ 2>&1 || echo "ghcr ipv4 FAILED"

  curl -4 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'blob ipv4: namelookup=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s code=%{http_code}\n' \
    https://pkg-containers.githubusercontent.com/ 2>&1 || echo "blob ipv4 FAILED"

  log "=== [DIAG] IPv6 connectivity & latency ==="
  curl -6 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'ghcr ipv6: namelookup=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s code=%{http_code}\n' \
    https://ghcr.io/v2/ 2>&1 || echo "ghcr ipv6 FAILED (or unrouted)"

  curl -6 -sS \
    --connect-timeout 5 \
    -o /dev/null \
    -w 'blob ipv6: namelookup=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s code=%{http_code}\n' \
    https://pkg-containers.githubusercontent.com/ 2>&1 || echo "blob ipv6 FAILED (or unrouted)"
}

configure_docker_concurrency() {
  local concurrency="${1:-${DOCKER_MAX_CONCURRENT_DOWNLOADS:-3}}"
  [[ "$concurrency" =~ ^[1-9][0-9]*$ ]] || die "Invalid max-concurrent-downloads: $concurrency (must be a positive integer)"

  local daemon_json="${DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}"
  local sudo_cmd=""
  if [[ $(id -u) -ne 0 && "$daemon_json" == /etc/* ]]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo_cmd="sudo"
    else
      log "Running as non-root without passwordless sudo; skipping daemon.json edit"
      return 0
    fi
  fi

  local current_concurrency=""
  if [[ -f "$daemon_json" ]]; then
    current_concurrency="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    if isinstance(d, dict) and "max-concurrent-downloads" in d:
        print(d["max-concurrent-downloads"])
except Exception:
    pass
' "$daemon_json" 2>/dev/null || true)"
  fi

  if [[ "$current_concurrency" == "$concurrency" ]]; then
    log "Docker max-concurrent-downloads already set to $concurrency in $daemon_json"
    return 0
  fi

  log "Configuring max-concurrent-downloads=$concurrency in $daemon_json..."
  local new_cfg=""
  new_cfg="$(python3 -c '
import json, os, sys
path, val = sys.argv[1], int(sys.argv[2])
data = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        sys.exit(f"Failed to read JSON: {e}")
if not isinstance(data, dict):
    data = {}
data["max-concurrent-downloads"] = val
print(json.dumps(data, indent=2))
' "$daemon_json" "$concurrency" 2>/dev/null || true)"

  if [[ -n "$new_cfg" ]]; then
    $sudo_cmd mkdir -p "$(dirname "$daemon_json")" 2>/dev/null || true
    printf '%s\n' "$new_cfg" | $sudo_cmd tee "$daemon_json" >/dev/null || die "Failed to write $daemon_json"
    log "Reloading Docker daemon..."
    if ! $sudo_cmd systemctl reload docker 2>/dev/null; then
      local pid
      pid="$(pidof dockerd 2>/dev/null || true)"
      [[ -n "$pid" ]] || die "Cannot find dockerd for reload"
      $sudo_cmd kill -SIGHUP "$pid" 2>/dev/null || die "Failed to reload Docker daemon"
    fi
    log "Docker max-concurrent-downloads configured to $concurrency"
  else
    die "Failed to generate Docker daemon configuration"
  fi
}

PULL_TIMEOUT="${PULL_TIMEOUT:-300}"
PULL_ATTEMPTS="${PULL_ATTEMPTS:-2}"
COMPOSE_PROGRESS="${COMPOSE_PROGRESS:-plain}"
PULL_HEARTBEAT_INTERVAL="${PULL_HEARTBEAT_INTERVAL:-15}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-120}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-2}"
FAST_DRAIN_TIMEOUT="${FAST_DRAIN_TIMEOUT:-3}"
PULL_HEARTBEAT_PID=""

start_pull_heartbeat() {
  local service="$1"
  local start_ts="$2"
  local interval="${PULL_HEARTBEAT_INTERVAL:-15}"
  stop_pull_heartbeat
  (
    trap 'exit 0' TERM INT
    while true; do
      sleep "$interval" 2>/dev/null || break
      local now elapsed
      now="$(date +%s)"
      elapsed=$((now - start_ts))
      log "Pull in progress for $service (${elapsed}s elapsed)..."
    done
  ) 2>/dev/null &
  PULL_HEARTBEAT_PID=$!
}

inspect_manifest_summary() {
  local image="$1" out
  if command -v docker >/dev/null 2>&1; then
    out="$(timeout 2 docker manifest inspect "$image" 2>/dev/null || true)"
    if [[ -n "$out" ]]; then
      python3 - "$out" <<'PY' 2>/dev/null || true
import json, sys
try:
    data = json.loads(sys.argv[1])
    if "layers" in data and isinstance(data["layers"], list):
        layers = data["layers"]
        count = len(layers)
        size_mib = sum(l.get("size", 0) for l in layers) / (1024 * 1024)
        print(f"{count} layers, {size_mib:.2f} MiB compressed")
    elif "manifests" in data and isinstance(data["manifests"], list):
        count = len(data["manifests"])
        print(f"multi-platform index with {count} variants")
except Exception:
    pass
PY
    fi
  fi
}

wait_slot_idle() {
  local slot="$1" deadline=$((SECONDS + DRAIN_TIMEOUT))
  while (( SECONDS < deadline )); do
    if direct_slot_healthy "$slot" idle; then
      log "Slot $slot is idle."
      return 0
    fi
    log "Waiting for slot $slot to drain (count unknown or nonzero)..."
    sleep "$DRAIN_POLL_SECONDS"
  done
  log "Drain timeout for slot $slot; keeping it running to avoid cutting active requests."
  return 1
}

pull_image() {
  local service="${1:-9router-${target:-blue}}"

  if docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
    log "Image already cached locally: $IMAGE_REF"
    return 0
  fi

  local summary
  summary="$(inspect_manifest_summary "$IMAGE_REF")"
  if [[ -n "$summary" ]]; then
    log "Target: $service | Image: $IMAGE_REF | Manifest: $summary | Cache: missing"
  else
    log "Target: $service | Image: $IMAGE_REF | Cache: missing"
  fi

  local attempt rc start_ts duration
  for ((attempt=1; attempt<=PULL_ATTEMPTS; attempt++)); do
    log "Pull attempt $attempt/$PULL_ATTEMPTS for $IMAGE_REF..."
    start_ts="$(date +%s)"
    start_pull_heartbeat "$service" "$start_ts"

    if timeout "$PULL_TIMEOUT" docker compose "${COMPOSE_ARGS[@]}" --ansi=never --progress="$COMPOSE_PROGRESS" pull "$service"; then
      stop_pull_heartbeat
      duration=$(( $(date +%s) - start_ts ))
      log "Pull completed in ${duration}s"
      return 0
    else
      rc=$?
      stop_pull_heartbeat
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

do_deploy() {
  preflight mutation
  cleanup_draining_slots
  local route_info current="" current_gen="" target target_state image
  if route_info="$(read_active_route_slot "$TRAEFIK_DYNAMIC_DIR/$TRAEFIK_CONFIG_NAME")"; then
    read -r current current_gen <<< "$route_info"
  else
    die "Cannot read configured route"
  fi
  if [[ "$current" == blue ]]; then target=green; else target=blue; fi
  if [[ -n "$current" ]]; then
    wait_healthy "$current" || die "Configured slot $current is unhealthy; deployment aborted"
    wait_route_slot "$current" "$current_gen" || die "Public route does not acknowledge configured slot $current"
  fi
  if [[ "$target" == blue && "$BLUE_PRESENT" == present || "$target" == green && "$GREEN_PRESENT" == present ]]; then
    target_state="$(docker inspect "9router-$target" --format '{{.State.Status}}')" || die "Cannot inspect existing target $target"
  else
    target_state=missing
  fi
  if [[ "$target_state" == running ]]; then
    [[ "$target" != "$current" ]] || die "Target slot $target is already configured as active route"
    local t_info t_state t_count t_streams t_oldest
    t_info="$(get_slot_drain_info "$target")" || t_info="UNKNOWN -1 -1 -1"
    read -r t_state t_count t_streams t_oldest <<< "$t_info"
    case "$t_state" in
      IDLE)
        log "Target slot $target is idle; stopping before deployment"
        compose stop "9router-$target" || die "Failed to stop idle target container $target"
        ;;
      ACTIVE)
        die "Cannot deploy to $target: slot is still draining $t_count active request(s). Current production ${current:-unknown} remains healthy."
        ;;
      *)
        die "Cannot deploy to $target: slot drain state is unknown. Current production ${current:-unknown} remains healthy."
        ;;
    esac
  fi
  log "Deploying $IMAGE_REF from ${current:-bootstrap} to $target"
  compose up -d headroom
  wait_headroom_ready
  pull_image "9router-$target"
  compose up -d --no-deps --pull never "9router-$target"
  if ! wait_healthy "$target"; then
    compose stop "9router-$target" || true
    die "Candidate $target failed direct health identity; configured route unchanged"
  fi
  wait_headroom_ready
  image="$(container_image "$target")" || die "Cannot inspect target immutable image"
  route_cutover "$target" "$current"
  sync_metadata "$target" "$current" "$image"
  log "Deployment completed: $target"
  if [[ -n "$current" ]]; then
    handoff_old_slot_to_drain "$current"
  fi
}

acquire_deployment_lock() {
  exec {DEPLOY_LOCK_FD}>"$SCRIPT_DIR/.deployment.lock"
  flock -n "$DEPLOY_LOCK_FD" || die "Another deployment holds .deployment.lock"
}

# ------------------------------------------------------------------------------
# Main Dispatcher
# ------------------------------------------------------------------------------
cmd="${1:-}"
case "$cmd" in
  --preflight)
    [[ $# -eq 1 ]] || die "Usage: $0 --preflight"
    preflight
    ;;
  --status)
    [[ $# -eq 1 || ( $# -eq 2 && "$2" == --strict ) ]] || die "Usage: $0 --status [--strict]"
    if [[ "${2:-}" == --strict ]]; then show_status true; else show_status false; fi
    ;;
  --reconcile)
    [[ $# -eq 1 ]] || die "Usage: $0 --reconcile"
    acquire_deployment_lock
    reconcile_active_slot
    ;;
  --rollback)
    [[ $# -eq 1 ]] || die "Usage: $0 --rollback"
    acquire_deployment_lock
    do_rollback
    ;;
  --release)
    [[ $# -eq 2 && -n "$2" ]] || die "Usage: $0 --release <IMAGE_REF>"
    acquire_deployment_lock
    IMAGE_REF="$2"
    export IMAGE_REF
    preflight mutation
    cleanup_draining_slots
    reconcile_active_slot
    do_deploy
    show_status true
    ;;
  --cleanup-drains)
    [[ $# -eq 1 ]] || die "Usage: $0 --cleanup-drains"
    exec {DEPLOY_LOCK_FD}>"$SCRIPT_DIR/.deployment.lock"
    if ! flock -n "$DEPLOY_LOCK_FD"; then
      log "Another deployment holds .deployment.lock; skipping drain cleanup"
      exit 0
    fi
    preflight mutation
    cleanup_draining_slots
    ;;
  --setup-host)
    [[ $# -le 2 ]] || die "Usage: $0 --setup-host [concurrency]"
    configure_docker_concurrency "${2:-}"
    ;;
  --diagnostics)
    [[ $# -le 2 ]] || die "Usage: $0 --diagnostics [IMAGE_REF]"
    IMAGE_REF="${2:-}"
    export IMAGE_REF
    run_diagnostics
    ;;
  -*|"")
    die "Usage: $0 <IMAGE_REF> | --release <IMAGE_REF> | --reconcile | --rollback | --status [--strict] | --preflight | --setup-host [concurrency] | --diagnostics [IMAGE_REF] | --cleanup-drains"
    ;;
  *)
    [[ $# -eq 1 ]] || die "Usage: $0 <IMAGE_REF>"
    acquire_deployment_lock
    IMAGE_REF="$cmd"
    export IMAGE_REF
    do_deploy
    ;;
esac
