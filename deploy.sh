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
TRAEFIK_CONFIG_NAME="${TRAEFIK_CONFIG_NAME-9router.yml}"


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
         cp -- "$SNAPSHOT_PATH" "$restore_tmp" && mv -f -- "$restore_tmp" "$ROUTE_PATH"; then
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
  if [[ "$old_state" == running ]]; then
    wait_slot_idle "$current" || die "Rollback drain timed out; old container remains running"
    compose stop "9router-$current" || die "Rollback route acknowledged, but old container could not stop"
  fi
  log "Rollback completed to $target"
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

do_deploy() {
  preflight mutation
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
    wait_slot_idle "$target" || die "Target slot $target still has active or unknown requests"
  fi
  log "Deploying $IMAGE_REF from ${current:-bootstrap} to $target"
  compose up -d headroom
  pull_image
  compose up -d --no-deps --pull never "9router-$target"
  if ! wait_healthy "$target"; then
    compose stop "9router-$target" || true
    die "Candidate $target failed direct health identity; configured route unchanged"
  fi
  image="$(container_image "$target")" || die "Cannot inspect target immutable image"
  route_cutover "$target" "$current"
  sync_metadata "$target" "$current" "$image"
  if [[ -n "$current" ]]; then
    wait_slot_idle "$current" || die "Deployment route acknowledged but old slot remains running after drain timeout"
    compose stop "9router-$current" || die "Route acknowledged but old slot could not stop"
  fi
  log "Deployment completed: $target"
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
    reconcile_active_slot
    do_deploy
    show_status true
    ;;
  --setup-host)
    [[ $# -eq 1 ]] || die "Usage: $0 --setup-host"
    configure_docker_concurrency
    ;;
  --diagnostics)
    [[ $# -le 2 ]] || die "Usage: $0 --diagnostics [IMAGE_REF]"
    IMAGE_REF="${2:-}"
    export IMAGE_REF
    run_diagnostics
    ;;
  -*|"")
    die "Usage: $0 <IMAGE_REF> | --release <IMAGE_REF> | --reconcile | --rollback | --status [--strict] | --preflight"
    ;;
  *)
    [[ $# -eq 1 ]] || die "Usage: $0 <IMAGE_REF>"
    acquire_deployment_lock
    IMAGE_REF="$cmd"
    export IMAGE_REF
    do_deploy
    ;;
esac
