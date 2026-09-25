#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat > "$tmp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
slot_file="$FAKE_STATE/${2:-}"
case "${1:-}" in
  container)
    if [[ "${2:-}" == ls ]]; then
      [[ "${FAKE_INVENTORY_ERROR:-}" != 1 ]] || exit 1
      name="${5#name=^/}"
      name="${name%\$}"
      [[ ! -f "$FAKE_STATE/$name" ]] || printf '%s\n' "$name"
    elif [[ "${2:-}" == inspect ]]; then
      [[ "${FAKE_INSPECT_ERROR:-}" != "${3:-}" ]] || exit 1
      [[ -f "$FAKE_STATE/${3:-}" ]] || exit 1
      printf '%s\n' "fake-container-id"
    else
      exit 1
    fi
    ;;
  inspect)
    if [[ "${2:-}" == edge-traefik ]]; then
      case "${4:-}" in
        '{{.State.Running}}') printf '%s\n' "${FAKE_TRAEFIK_RUNNING:-true}" ;;
        '{{json .Mounts}}')
          printf '[{"Type":"%s","Destination":"/etc/traefik/dynamic","Source":"%s","RW":false}' "${FAKE_MOUNT_TYPE:-bind}" "$FAKE_MOUNT_SOURCE"
          if [[ "${FAKE_NESTED:-}" == 1 ]]; then printf ',{"Type":"bind","Destination":"/etc/traefik/dynamic/9router.yml","Source":"%s","RW":true}' "$FAKE_MOUNT_SOURCE"; fi
          printf ']\n'
          ;;
        *) exit 1 ;;
      esac
      exit 0
    fi
    [[ -f "$slot_file" ]] || exit 1
    IFS='|' read -r state image hostname < "$slot_file"
    case "${4:-}" in
      '{{.State.Status}}') printf '%s\n' "$state" ;;
      '{{.Config.Hostname}}') printf '%s\n' "$hostname" ;;
      '{{.Image}}') printf '%s\n' "$image" ;;
      '{{json .NetworkSettings.Networks}}')
        if [[ "${FAKE_DETACH_SLOT:-}" == "${2:-}" ]]; then printf '{}\n'; else printf '{"%s":{}}\n' "${EDGE_NETWORK:-edge-9router}"; fi
        ;;
    esac
    ;;
  network)
    [[ "${FAKE_NETWORK:-}" != missing ]] || exit 1
    if [[ "${FAKE_NETWORK:-}" != detached ]]; then printf 'edge-traefik\n'; fi
    for file in "$FAKE_STATE"/9router-*; do
      [[ -f "$file" ]] || continue
      IFS='|' read -r state image hostname < "$file"
      if [[ "$state" == running && "${FAKE_DETACH_SLOT:-}" != "${file##*/}" ]]; then printf '%s\n' "${file##*/}"; fi
    done
    ;;
  compose)
    [[ "${2:-}" == version ]] && exit 0
    if [[ "$*" == *' up '* ]]; then
      name="${!#}"
      [[ "$name" == 9router-blue || "$name" == 9router-green ]] || exit 1
      if [[ "$name" == 9router-* ]]; then
        printf 'running|sha256:%s-new|fake-%s\n' "${name#9router-}" "${name#9router-}" > "$FAKE_STATE/$name"
      fi
    elif [[ "$*" == *' stop '* ]]; then
      name="${!#}"
      IFS='|' read -r state image hostname < "$FAKE_STATE/$name"
      printf 'exited|%s|%s\n' "$image" "$hostname" > "$FAKE_STATE/$name"
    elif [[ "$*" == *' pull '* ]]; then
      if [[ "${FAKE_PULL_TIMEOUT:-}" == 1 ]]; then
        sleep 5
        exit 0
      fi
      if [[ -n "${FAKE_PULL_FAIL_COUNT:-}" ]]; then
        fails_left="$FAKE_PULL_FAIL_COUNT"
        if [[ -f "$FAKE_STATE/pull_fails_left" ]]; then
          fails_left="$(cat "$FAKE_STATE/pull_fails_left")"
        fi
        if (( fails_left > 0 )); then
          printf '%s' "$((fails_left - 1))" > "$FAKE_STATE/pull_fails_left"
          exit 1
        fi
      fi
      exit 0
    fi
    ;;
  image)
    if [[ "${2:-}" == inspect && "${FAKE_UNCACHED_IMAGE:-}" == "${3:-}" ]]; then
      exit 1
    fi
    exit 0
    ;;
  start)
    name="$2"
    IFS='|' read -r state image hostname < "$FAKE_STATE/$name"
    printf 'running|%s|%s\n' "$image" "$hostname" > "$FAKE_STATE/$name"
    ;;
  exec)
    name="$2"
    IFS='|' read -r state image hostname < "$FAKE_STATE/$name"
    [[ "$state" == running ]] || exit 1
    slot="${name#9router-}"
    if [[ "${FAKE_BAD_HEALTH_SLOT:-}" == "$slot" ]]; then printf '{invalid'; exit 0; fi
    reported="$slot"
    if [[ "${FAKE_WRONG_SLOT:-}" == "$slot" ]]; then
      if [[ "$slot" == blue ]]; then reported=green; else reported=blue; fi
    fi
    count=0 known=true
    if [[ -f "$FAKE_STATE/${slot}_count" ]]; then
      count="$(cat "$FAKE_STATE/${slot}_count")"
      if [[ "$count" == "null" ]]; then count=null; known=false; fi
    elif [[ "${FAKE_UNKNOWN_DRAIN_SLOT:-}" == "$slot" ]]; then
      count=null; known=false
    elif [[ "${FAKE_BUSY_SLOT:-}" == "$slot" ]]; then
      count=1
    fi
    streams=0 non_stream=0 oldest=null
    if [[ "$count" != null && "$count" -gt 0 ]]; then
      streams=1; non_stream=$((count - 1)); oldest=87000
    fi
    printf '{"ok":true,"deployment_slot":"%s","instance_id":"%s-123","active_requests":%s,"active_requests_known":%s,"active_streams":%s,"active_non_stream":%s,"oldest_active_ms":%s}\n' "$reported" "$hostname" "$count" "$known" "$streams" "$non_stream" "$oldest"
    ;;
  logs) exit 0 ;;
  *) exit 1 ;;
esac
DOCKER

cat > "$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *'--silent --show-error --connect-timeout 2'* ]]
[[ "$*" == *'Cache-Control: no-cache'* && "$*" == *'Pragma: no-cache'* ]]
[[ "$*" == *"https://${API_HOST}/api/health?deploy_probe="* ]]
[[ " $* " != *' -L '* && " $* " != *' -k '* ]]
header="" body="" max_time=""
while (( $# )); do
  case "$1" in
    --dump-header) header="$2"; shift 2 ;;
    --output) body="$2"; shift 2 ;;
    --max-time) max_time="$2"; shift 2 ;;
    --connect-timeout|--write-out|-H) shift 2 ;;
    *) shift ;;
  esac
done
[[ "$max_time" =~ ^[1-5]$ ]]
counter=0
[[ ! -f "$FAKE_CURL_COUNTER" ]] || counter="$(cat "$FAKE_CURL_COUNTER")"
counter=$((counter + 1))
printf '%s' "$counter" > "$FAKE_CURL_COUNTER"
if [[ -n "${FAKE_HOLD_MARKER:-}" && ! -e "$FAKE_HOLD_MARKER" ]]; then
  : > "$FAKE_HOLD_MARKER"
  for ((hold=0; hold<100; hold++)); do
    [[ ! -e "$FAKE_HOLD_RELEASE" ]] || break
    sleep 0.1
  done
  [[ -e "$FAKE_HOLD_RELEASE" ]] || exit 1
fi
mode="${FAKE_CURL_MODE:-}"
if [[ -n "${FAKE_CURL_SEQUENCE:-}" ]]; then mode="$(sed -n "${counter}p" "$FAKE_CURL_SEQUENCE")"; fi

disk_slot=none
disk_gen=""
if [[ -f "$FAKE_ROUTE_FILE" ]]; then
  disk_slot="$(sed -n 's/^[[:space:]]*- url: "http:\/\/9router-\(blue\|green\):20128".*/\1/p' "$FAKE_ROUTE_FILE")"
  disk_slot="${disk_slot:-none}"
  disk_gen="$(sed -n 's/^[[:space:]]*X-9Router-Route-Generation:[[:space:]]*"\?\([0-9a-fA-F]\{32\}\)"\?.*/\1/p' "$FAKE_ROUTE_FILE")"
fi

if [[ ! -f "$FAKE_LOADED_SLOT" || ! -f "$FAKE_LOADED_GENERATION" ]]; then
  loaded_slot="$disk_slot"
  loaded_gen="$disk_gen"
  printf '%s' "$loaded_slot" > "$FAKE_LOADED_SLOT"
  printf '%s' "$loaded_gen" > "$FAKE_LOADED_GENERATION"
else
  loaded_slot="$(cat "$FAKE_LOADED_SLOT")"
  loaded_gen="$(cat "$FAKE_LOADED_GENERATION")"
fi

if [[ -z "$mode" ]]; then
  if [[ "$loaded_slot" != "$disk_slot" && "$counter" -ge "${FAKE_RELOAD_AFTER:-0}" ]]; then
    loaded_slot="$disk_slot"
    loaded_gen="$disk_gen"
    printf '%s' "$loaded_slot" > "$FAKE_LOADED_SLOT"
    printf '%s' "$loaded_gen" > "$FAKE_LOADED_GENERATION"
  elif [[ "$loaded_slot" == "$disk_slot" && "$loaded_gen" != "$disk_gen" ]]; then
    reload_gen_target="${FAKE_RELOAD_GEN_AFTER:-0}"
    if [[ "$counter" -ge "$reload_gen_target" ]]; then
      loaded_gen="$disk_gen"
      printf '%s' "$loaded_gen" > "$FAKE_LOADED_GENERATION"
    fi
  fi
  mode="$loaded_slot"
  gen="$loaded_gen"
else
  if [[ "$mode" == *" "* ]]; then
    gen="${mode#* }"
    mode="${mode%% *}"
  else
    gen="${disk_gen:-$loaded_gen}"
  fi
fi

case "$mode" in
  blue|green) status=200; payload="{\"ok\":true,\"deployment_slot\":\"$mode\"}" ;;
  none) status=404; payload='not found'; gen="" ;;
  duplicate) status=200; payload='{"ok":true,"deployment_slot":"green","deployment_slot":"blue"}' ;;
  cached|cf-hit) status=200; payload='{"ok":true,"deployment_slot":"green"}' ;;
  *) status=403; payload='denied'; gen="" ;;
esac
printf 'HTTP/2 %s\r\n' "$status" > "$header"
[[ "$mode" != cached ]] || printf 'Age: 2\r\n' >> "$header"
[[ "$mode" != cf-hit ]] || printf 'CF-Cache-Status: HIT\r\n' >> "$header"
if [[ -n "$gen" ]]; then
  printf 'X-9Router-Route-Generation: %s\r\n' "$gen" >> "$header"
fi
printf '\r\n' >> "$header"
printf '%s' "$payload" > "$body"
printf '%s' "$status"
CURL
cat > "$tmp/bin/mv" <<'MV'
#!/usr/bin/env bash
set -euo pipefail
dest="${!#}"
source="${@: -2:1}"
if [[ "${FAKE_FAIL_METADATA:-}" == 1 && "$dest" == "$FAKE_CASE_DIR/.deployed-image" ]]; then
  exit 1
fi
/usr/bin/mv "$@"
if [[ "${FAKE_SIGNAL_AFTER_WRITE:-}" == 1 && "$dest" == "$FAKE_ROUTE_FILE" && "$(cat "$dest")" == *'http://9router-green:20128'* ]]; then
  kill -TERM "$PPID"
fi
MV
cat > "$tmp/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_SYSTEMCTL_FAIL:-}" == 1 ]]; then
  exit 1
fi
printf '%s\n' "$*" >> "${FAKE_SYSTEMCTL_LOG:-/dev/null}"
SYSTEMCTL
cat > "$tmp/bin/pidof" <<'PIDOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_PIDOF_FAIL:-}" == 1 ]]; then
  exit 1
fi
printf '99999\n'
PIDOF
chmod +x "$tmp/bin/docker" "$tmp/bin/curl" "$tmp/bin/mv" "$tmp/bin/systemctl" "$tmp/bin/pidof"

new_case() {
  case_dir="$(mktemp -d "$tmp/case.XXXXXXXX")"
  mkdir -p "$case_dir/dynamic" "$case_dir/state"
  cp "$repo_root/deploy.sh" "$case_dir/deploy.sh"
  chmod +x "$case_dir/deploy.sh"
  export PATH="$tmp/bin:$PATH" API_HOST=9router-api.example.test
  export TRAEFIK_DYNAMIC_DIR="$case_dir/dynamic" FAKE_MOUNT_SOURCE="$case_dir/dynamic"
  export FAKE_STATE="$case_dir/state" FAKE_DOCKER_LOG="$case_dir/docker.log" FAKE_CASE_DIR="$case_dir"
  export FAKE_CURL_COUNTER="$case_dir/curl.count" FAKE_ROUTE_FILE="$case_dir/dynamic/9router.yml"
  export FAKE_LOADED_SLOT="$case_dir/loaded.slot" FAKE_LOADED_GENERATION="$case_dir/loaded.gen"
  export FAKE_SYSTEMCTL_LOG="$case_dir/systemctl.log"
  export READY_TIMEOUT=2 DRAIN_TIMEOUT=1 DRAIN_POLL_SECONDS=1 ROUTE_TIMEOUT=8 FAST_DRAIN_TIMEOUT=1
  unset FAKE_CURL_MODE FAKE_CURL_SEQUENCE FAKE_RELOAD_AFTER FAKE_RELOAD_GEN_AFTER FAKE_BAD_HEALTH_SLOT FAKE_WRONG_SLOT FAKE_UNKNOWN_DRAIN_SLOT FAKE_BUSY_SLOT FAKE_MOUNT_TYPE FAKE_NETWORK FAKE_DETACH_SLOT FAKE_NESTED FAKE_TRAEFIK_RUNNING FAKE_FAIL_METADATA FAKE_SIGNAL_AFTER_WRITE FAKE_HOLD_MARKER FAKE_HOLD_RELEASE FAKE_INVENTORY_ERROR FAKE_INSPECT_ERROR FAKE_UNCACHED_IMAGE ROUTE_GENERATION FAKE_PULL_FAIL_COUNT FAKE_PULL_TIMEOUT FAKE_SYSTEMCTL_FAIL FAKE_PIDOF_FAIL PULL_TIMEOUT PULL_ATTEMPTS PULL_HEARTBEAT_INTERVAL
  printf none > "$FAKE_LOADED_SLOT"
  printf none > "$FAKE_LOADED_GENERATION"
}
route_legacy() {
  local slot="$1"
  cat > "$case_dir/dynamic/9router.yml" <<YAML
http:
  services:
    9router-service:
      loadBalancer:
        servers:
          - url: "http://9router-$slot:20128"
YAML
}
seed_legacy() {
  local slot="$1"
  route_legacy "$slot"
  printf '%s' "$slot" > "$FAKE_LOADED_SLOT"
  printf none > "$FAKE_LOADED_GENERATION"
  printf 'running|sha256:%s-old|fake-%s\n' "$slot" "$slot" > "$FAKE_STATE/9router-$slot"
  printf '%s' "$slot" > "$case_dir/.active-slot"
  printf 'sha256:%s-old' "$slot" > "$case_dir/.deployed-image"
}
route() {
  local slot="$1" gen="${2:-00000000000000000000000000000001}"
  cat > "$case_dir/dynamic/9router.yml" <<YAML
http:
  middlewares:
    9router-route-generation:
      headers:
        customResponseHeaders:
          X-9Router-Route-Generation: "$gen"
  services:
    9router-service:
      loadBalancer:
        servers:
          - url: "http://9router-$slot:20128"
YAML
}
seed() {
  local slot="$1" gen="${2:-00000000000000000000000000000001}"
  route "$slot" "$gen"
  printf '%s' "$slot" > "$FAKE_LOADED_SLOT"
  printf '%s' "$gen" > "$FAKE_LOADED_GENERATION"
  printf 'running|sha256:%s-old|fake-%s\n' "$slot" "$slot" > "$FAKE_STATE/9router-$slot"
  printf '%s' "$slot" > "$case_dir/.active-slot"
  printf 'sha256:%s-old' "$slot" > "$case_dir/.deployed-image"
}
run() { (cd "$case_dir" && ./deploy.sh "$@"); }
fail() {
  if output="$(run "$@" 2>&1)"; then
    printf 'unexpected success: %s\n' "$*" >&2
    exit 1
  fi
}
slot_on_disk() {
  sed -n 's/^[[:space:]]*- url: "http:\/\/9router-\(blue\|green\):20128".*/\1/p' "$FAKE_ROUTE_FILE"
}
generation_on_disk() {
  sed -n 's/^[[:space:]]*X-9Router-Route-Generation:[[:space:]]*"\?\([0-9a-fA-F]\{32\}\)"\?.*/\1/p' "$FAKE_ROUTE_FILE"
}
assert_route() {
  [[ "$(slot_on_disk)" == "$1" ]]
  [[ "$(cat "$case_dir/.active-slot")" == "$2" ]]
}

# Preflight rejects ambiguous grammar, duplicate dynamic configs, mount/network failures, FIFO.
new_case; seed blue
run --preflight
printf '          - url: "http://9router-blue:20128"\n' >> "$case_dir/dynamic/9router.yml"
fail --preflight
route blue
printf '# 9router-service\n' > "$case_dir/dynamic/other.yml"
fail --preflight
rm "$case_dir/dynamic/other.yml"
printf '# 9router-route-generation\n' > "$case_dir/dynamic/other.yml"
fail --preflight
rm "$case_dir/dynamic/other.yml"
mkfifo "$case_dir/dynamic/other.yml"
fail --preflight
rm "$case_dir/dynamic/other.yml"
FAKE_MOUNT_TYPE=volume fail --preflight
FAKE_NETWORK=detached fail --preflight
TRAEFIK_CONFIG_NAME='../bad.yml' fail --preflight
TRAEFIK_DYNAMIC_DIR="$case_dir/elsewhere" fail --preflight

# Configured YAML wins over stale metadata; active container never recreated.
new_case; seed green
printf blue > "$case_dir/.active-slot"
run --reconcile
assert_route green green
[[ "$(cat "$case_dir/.deployed-image")" == sha256:green-old ]]
[[ "$(cat "$FAKE_DOCKER_LOG")" != *'up -d --no-deps'* ]]

# Public ACK is independent of disk; failed cutover restores exact original bytes.
new_case; seed blue
cp "$case_dir/dynamic/9router.yml" "$case_dir/original"
export FAKE_RELOAD_AFTER=999
fail image-new
assert_route blue blue
cmp -s "$case_dir/original" "$case_dir/dynamic/9router.yml"
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]

# Delayed reload, two consecutive ACKs; metadata follows ACK, then idle old stops.
new_case; seed blue
export FAKE_RELOAD_AFTER=7
run --release image-new
assert_route green green
[[ "$(stat -c '%a' "$FAKE_ROUTE_FILE")" == 644 ]] # Traefik has no DAC_OVERRIDE and must read the generated route.
[[ "$(cat "$case_dir/.deployed-image")" == sha256:green-new ]]
[[ "$(cat "$FAKE_STATE/9router-blue")" == exited* ]]
[[ "$(cat "$FAKE_CURL_COUNTER")" -ge 8 ]]

# Five-second delayed reload still needs two matching public observations.
new_case; seed blue
export FAKE_RELOAD_AFTER=8
run image-new
assert_route green green
[[ "$(cat "$FAKE_CURL_COUNTER")" -ge 9 ]]

# A mismatch between ACKs resets the streak; only CLI reconcile exercises it.
new_case; seed blue
printf '%s\n' blue green blue blue > "$case_dir/probe-sequence"
export FAKE_CURL_SEQUENCE="$case_dir/probe-sequence"
run --reconcile
assert_route blue blue
[[ "$(cat "$FAKE_CURL_COUNTER")" == 4 ]]

# Reconcile same slot with delayed reload: must accept G2 and reject G1.
new_case; seed blue 11111111111111111111111111111111
export FAKE_RELOAD_GEN_AFTER=6
run --reconcile
assert_route blue blue
g2="$(generation_on_disk)"
[[ "$g2" != 11111111111111111111111111111111 ]]
[[ "$(cat "$FAKE_LOADED_GENERATION")" == "$g2" ]]
[[ "$(cat "$FAKE_CURL_COUNTER")" -ge 7 ]]

# Streak reset when generation mismatches during wait_route_slot.
new_case; seed blue 11111111111111111111111111111111
export ROUTE_GENERATION="22222222222222222222222222222222"
printf '%s\n' \
  "blue 22222222222222222222222222222222" \
  "blue 11111111111111111111111111111111" \
  "blue 22222222222222222222222222222222" \
  "blue 22222222222222222222222222222222" > "$case_dir/probe-sequence"
export FAKE_CURL_SEQUENCE="$case_dir/probe-sequence"
run --reconcile
assert_route blue blue
[[ "$(cat "$FAKE_CURL_COUNTER")" == 4 ]]

# Traefik restart re-reads route from disk
new_case; seed blue 11111111111111111111111111111111
rm -f "$FAKE_LOADED_SLOT" "$FAKE_LOADED_GENERATION"
[[ "$(run --status --strict)" == *'Route state: HEALTHY'* ]]
[[ "$(cat "$FAKE_LOADED_SLOT")" == blue ]]
[[ "$(cat "$FAKE_LOADED_GENERATION")" == 11111111111111111111111111111111 ]]

# Snapshot restore preserves exact original generation after failed cutover.
new_case; seed blue 11111111111111111111111111111111
export FAKE_RELOAD_AFTER=999
fail image-new
assert_route blue blue
[[ "$(generation_on_disk)" == 11111111111111111111111111111111 ]]
[[ "$(cat "$FAKE_LOADED_GENERATION")" == 11111111111111111111111111111111 ]]

# Reconcile after crash between YAML write and metadata: never restores stale mirror.
new_case; seed blue
route green
printf green > "$FAKE_LOADED_SLOT"
printf 'running|sha256:green-new|fake-green\n' > "$FAKE_STATE/9router-green"
run --reconcile
assert_route green green
[[ "$(cat "$case_dir/.deployed-image")" == sha256:green-new ]]

# Rollback rescues unhealthy current using stopped existing target, not compose recreate.
new_case; seed blue
printf 'exited|sha256:green-old|fake-green\n' > "$FAKE_STATE/9router-green"
printf green > "$case_dir/.previous-slot"
printf 'exited|sha256:blue-old|fake-blue\n' > "$FAKE_STATE/9router-blue"
printf '%s\n' green green green > "$case_dir/probe-sequence"
export FAKE_CURL_SEQUENCE="$case_dir/probe-sequence"
export FAKE_BAD_HEALTH_SLOT=blue
run --rollback
assert_route green green
[[ "$(cat "$case_dir/.deployed-image")" == sha256:green-old ]]
[[ "$(cat "$FAKE_DOCKER_LOG")" == *'start 9router-green'* ]]
[[ "$(cat "$FAKE_DOCKER_LOG")" != *'up -d --no-deps'* ]]

# Unknown drain leaves old slot untouched after ACK; deploy succeeds and mirror tracks route.
new_case; seed blue
export FAKE_UNKNOWN_DRAIN_SLOT=blue
run image-new
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]

# A running broken old slot is never stopped when drain count is unknown, but rollback succeeds.
new_case; seed blue
printf 'exited|sha256:green-old|fake-green\n' > "$FAKE_STATE/9router-green"
printf green > "$case_dir/.previous-slot"
export FAKE_UNKNOWN_DRAIN_SLOT=blue
run --rollback
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]

# Bootstrap requires public 404; failed target ACK removes only generated route.
new_case
FAKE_CURL_MODE=denied fail --preflight
unset FAKE_CURL_MODE
export FAKE_RELOAD_AFTER=999
fail image-new
[[ ! -e "$case_dir/dynamic/9router.yml" ]]
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
[[ ! -e "$case_dir/.active-slot" ]]

# Missing YAML with surviving container is never guessed from mirrors.
new_case
printf 'running|sha256:blue-old|fake-blue\n' > "$FAKE_STATE/9router-blue"
fail --reconcile
[[ ! -e "$case_dir/dynamic/9router.yml" ]]

# Docker inventory/inspection errors never prove an empty bootstrap.
new_case
FAKE_INVENTORY_ERROR=1 fail --preflight
printf 'running|sha256:blue-old|fake-blue\n' > "$FAKE_STATE/9router-blue"
FAKE_INSPECT_ERROR=9router-blue fail --preflight
rm "$FAKE_STATE/9router-blue"
ln -s "$case_dir/missing-slot" "$case_dir/.active-slot"
fail --preflight
rm "$case_dir/.active-slot"

# Strict status reports mismatch without modifying route or mirror.
new_case; seed blue
printf green > "$FAKE_LOADED_SLOT"
export FAKE_RELOAD_AFTER=999
fail --status --strict
status="$(run --status)"
[[ "$status" == *'Route state: MISMATCH'* ]]
assert_route blue blue

# An exited idle slot remains configured on the external network; no live endpoint is required.
new_case; seed blue
printf 'exited|sha256:green-old|fake-green\n' > "$FAKE_STATE/9router-green"
[[ "$(run --status --strict)" == *'Route state: HEALTHY'* ]]
run --preflight

# Parser rejects absent and conflicting backends; platform checks reject hidden mounts.
new_case; seed blue
cat > "$FAKE_ROUTE_FILE" <<'YAML'
http:
  services:
    9router-service:
      loadBalancer:
        servers:
YAML
fail --preflight
route blue
printf '          - url: "http://9router-green:20128"\n' >> "$FAKE_ROUTE_FILE"
fail --preflight
route blue
FAKE_NESTED=1 fail --preflight
printf file > "$case_dir/not-directory"
FAKE_MOUNT_SOURCE="$case_dir/not-directory" fail --preflight

# Invalid direct health identity and public cache/JSON responses block recreation.
new_case; seed blue
export FAKE_WRONG_SLOT=blue
fail image-new
assert_route blue blue
[[ ! -e "$FAKE_STATE/9router-green" ]]
new_case; seed blue
export FAKE_BAD_HEALTH_SLOT=blue
fail image-new
assert_route blue blue
new_case; seed blue
for mode in cached cf-hit duplicate denied; do
  FAKE_CURL_MODE="$mode" fail image-new
  assert_route blue blue
  [[ ! -e "$FAKE_STATE/9router-green" ]]
done

# Running target with active requests cannot be recreated during next deploy.
new_case; seed blue
printf 'running|sha256:green-old|fake-green\n' > "$FAKE_STATE/9router-green"
export FAKE_BUSY_SLOT=green
fail image-new
assert_route blue blue
[[ "$(cat "$FAKE_STATE/9router-green")" == 'running|sha256:green-old|fake-green' ]]

# Bootstrap ACK succeeds only after 404 and removes stale previous metadata.
new_case
printf stale > "$case_dir/.previous-slot"
run image-new
assert_route blue blue
[[ ! -e "$case_dir/.previous-slot" ]]
[[ "$(cat "$case_dir/.deployed-image")" == sha256:blue-new ]]

# Rollback target ACK failure restores original route; both containers survive.
new_case; seed blue
printf 'exited|sha256:green-old|fake-green\n' > "$FAKE_STATE/9router-green"
printf green > "$case_dir/.previous-slot"
export FAKE_RELOAD_AFTER=999
fail --rollback
assert_route blue blue
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]

# Metadata failure after target ACK never rolls route back or drains old slot.
new_case; seed blue
export FAKE_FAIL_METADATA=1
fail image-new
assert_route green blue
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
[[ "$(cat "$case_dir/.deployed-image")" == sha256:blue-old ]]
unset FAKE_FAIL_METADATA
run --reconcile
assert_route green green
[[ "$(cat "$case_dir/.deployed-image")" == sha256:green-new ]]

# SIGTERM after YAML rename triggers byte-for-byte restoration, no metadata writes.
new_case; seed blue
cp "$FAKE_ROUTE_FILE" "$case_dir/original"
export FAKE_SIGNAL_AFTER_WRITE=1
fail image-new
cmp -s "$case_dir/original" "$FAKE_ROUTE_FILE"
assert_route blue blue
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]

# A failed restore ACK remains an error and retains snapshot for manual recovery.
new_case; seed blue
printf '%s\n' blue blue denied denied denied denied denied denied denied denied denied denied denied denied denied denied denied denied denied denied > "$case_dir/probe-sequence"
export FAKE_CURL_SEQUENCE="$case_dir/probe-sequence"
fail image-new
assert_route blue blue
snapshots=("$case_dir"/dynamic/.9router-snapshot.*)
[[ -f "${snapshots[0]}" ]]

# Nonblocking lock covers the complete reconcile path.
new_case; seed blue
export FAKE_HOLD_MARKER="$case_dir/entered" FAKE_HOLD_RELEASE="$case_dir/release"
run --reconcile > "$case_dir/first.log" 2>&1 & first=$!
for ((attempt=0; attempt<50; attempt++)); do
  [[ ! -e "$FAKE_HOLD_MARKER" ]] || break
  sleep 0.1
done
[[ -e "$FAKE_HOLD_MARKER" ]]
fail --reconcile
[[ "$output" == *'.deployment.lock'* ]]
: > "$FAKE_HOLD_RELEASE"
wait "$first"

# Strict status reports unknown/cache/network mismatches without repair.
new_case; seed blue
for mode in cached duplicate; do
  FAKE_CURL_MODE="$mode" fail --status --strict
  assert_route blue blue
done
FAKE_NETWORK=detached fail --status --strict

new_case; seed blue
FAKE_WRONG_SLOT=blue fail --status --strict
API_HOST='https://invalid.example.test/path' fail --preflight
DASHBOARD_ALIAS_HOST='bad/alias' fail --preflight
assert_route blue blue

# Deploy with only an app slot and Traefik; no sidecar service is available.
new_case; seed blue
run image-new
assert_route green green
[[ "$(cat "$case_dir/.deployed-image")" == sha256:green-new ]]
[[ "$(cat "$FAKE_STATE/9router-blue")" == exited* ]]

# Legacy YAML route without generation is supported in preflight and migrated by reconcile/release.
new_case; seed_legacy blue
run --preflight
fail --status --strict
run --reconcile
assert_route blue blue
[[ -n "$(generation_on_disk)" ]]
[[ "$(cat "$case_dir/.deployed-image")" == sha256:blue-old ]]

# Deploy uses docker compose pull with target service and plain progress without ANSI when image is uncached
new_case; seed blue
export FAKE_UNCACHED_IMAGE="image-new"
run image-new
assert_route green green
[[ "$(cat "$case_dir/docker.log")" == *'compose -f docker-compose.prod.yml --ansi=never --progress=plain pull 9router-green'* ]]
unset FAKE_UNCACHED_IMAGE

# Pull fails on attempt 1, retries and succeeds on attempt 2; target slot green is correct
new_case; seed blue
export FAKE_UNCACHED_IMAGE="image-new"
export FAKE_PULL_FAIL_COUNT=1
run image-new
assert_route green green
pull_attempts="$(grep -c 'compose.*pull 9router-green' "$case_dir/docker.log" || true)"
[[ "$pull_attempts" -eq 2 ]]
unset FAKE_UNCACHED_IMAGE FAKE_PULL_FAIL_COUNT

# Pull fails on attempt 1, retries and succeeds on attempt 2; target slot blue is correct
new_case; seed green
export FAKE_UNCACHED_IMAGE="image-new"
export FAKE_PULL_FAIL_COUNT=1
run image-new
assert_route blue blue
pull_attempts="$(grep -c 'compose.*pull 9router-blue' "$case_dir/docker.log" || true)"
[[ "$pull_attempts" -eq 2 ]]
unset FAKE_UNCACHED_IMAGE FAKE_PULL_FAIL_COUNT

# Pull timeout aborts deployment cleanly without leaving orphan heartbeat processes
new_case; seed blue
export FAKE_UNCACHED_IMAGE="image-new"
export FAKE_PULL_TIMEOUT=1
export PULL_TIMEOUT=1
export PULL_ATTEMPTS=1
export PULL_HEARTBEAT_INTERVAL=1
timeout_out="$(run image-new 2>&1 || true)"
[[ "$timeout_out" == *"Pull attempt 1 timed out after 1s"* ]]
[[ "$timeout_out" == *"Unable to pull image: image-new"* ]]
unset FAKE_UNCACHED_IMAGE FAKE_PULL_TIMEOUT PULL_TIMEOUT PULL_ATTEMPTS PULL_HEARTBEAT_INTERVAL

# Heartbeat process is terminated cleanly by stop_pull_heartbeat
(
  # shellcheck disable=SC1090
  source <(sed '/^cmd=/,$d' "$repo_root/deploy.sh")
  PULL_HEARTBEAT_INTERVAL=1
  start_pull_heartbeat "9router-blue" "$(date +%s)"
  hb_pid="$PULL_HEARTBEAT_PID"
  [[ -n "$hb_pid" ]]
  kill -0 "$hb_pid" 2>/dev/null
  stop_pull_heartbeat
  [[ -z "$PULL_HEARTBEAT_PID" ]]
  sleep 0.2
  ! kill -0 "$hb_pid" 2>/dev/null
)

# Host concurrency setup defaults to 3 and accepts custom concurrency
new_case; seed blue
export DOCKER_DAEMON_JSON="$case_dir/daemon.json"
run --setup-host
[[ "$(cat "$case_dir/daemon.json")" == *'"max-concurrent-downloads": 3'* ]]
[[ "$(cat "$case_dir/systemctl.log")" == *'reload docker'* ]]
run --setup-host 2
[[ "$(cat "$case_dir/daemon.json")" == *'"max-concurrent-downloads": 2'* ]]
unset DOCKER_DAEMON_JSON

# Host concurrency setup fails when daemon.json cannot be written
new_case; seed blue
mkdir -p "$case_dir/readonly_dir"
chmod 555 "$case_dir/readonly_dir"
export DOCKER_DAEMON_JSON="$case_dir/readonly_dir/daemon.json"
fail --setup-host
chmod 755 "$case_dir/readonly_dir"
unset DOCKER_DAEMON_JSON

# Host concurrency setup fails when docker daemon reload fails and dockerd is missing
new_case; seed blue
export DOCKER_DAEMON_JSON="$case_dir/daemon.json"
export FAKE_SYSTEMCTL_FAIL=1
export FAKE_PIDOF_FAIL=1
fail --setup-host 4
unset DOCKER_DAEMON_JSON FAKE_SYSTEMCTL_FAIL FAKE_PIDOF_FAIL

# ==============================================================================
# Deferred Drain and Cleaner Lifecycle Scenarios (Phase 15)
# ==============================================================================

# Scenario 1: Old slot active=0 -> cutover -> stops old slot quickly -> deploy success
new_case; seed blue
printf '0' > "$FAKE_STATE/blue_count"
run image-new
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == exited* ]]
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]

# Scenario 2: Old slot active=1 (SSE) -> cutover -> deploy success -> old slot remains running
new_case; seed blue
printf '1' > "$FAKE_STATE/blue_count"
run image-new
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]

# Scenario 3: Cleaner later sees active=0 -> stops old slot, keeps active slot untouched
printf '0' > "$FAKE_STATE/blue_count"
run --cleanup-drains
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == exited* ]]
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]

# Scenario 4: Active requests unknown -> keep old slot running -> deploy and cleaner both succeed
new_case; seed blue
printf 'null' > "$FAKE_STATE/blue_count"
run image-new
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
run --cleanup-drains
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]

# Scenario 5: Rollback while old slot is draining -> cleaner does NOT stop the rolled-back slot
new_case; seed blue
printf '1' > "$FAKE_STATE/blue_count"
run image-new
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
run --rollback
assert_route blue blue
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
printf '0' > "$FAKE_STATE/blue_count"
run --cleanup-drains
assert_route blue blue
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]

# Scenario 6: Next deploy when target is still active/draining -> fails fast without recreating target; current stays healthy
new_case; seed blue
printf '1' > "$FAKE_STATE/blue_count"
run image-new
assert_route green green
printf '2' > "$FAKE_STATE/blue_count"
fail image-v3
[[ "$output" == *"Cannot deploy to blue: slot is still draining 2 active request(s)"* ]]
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]

# Scenario 7: Client disconnect -> active count drops to 0 -> cleaner stops old slot
new_case; seed blue
printf '1' > "$FAKE_STATE/blue_count"
run image-new
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]
printf '0' > "$FAKE_STATE/blue_count"
run --cleanup-drains
[[ "$(cat "$FAKE_STATE/9router-blue")" == exited* ]]
[[ "$(cat "$FAKE_STATE/9router-green")" == running* ]]

# Scenario 8: Long-lived SSE does not block or fail workflow
new_case; seed blue
printf '1' > "$FAKE_STATE/blue_count"
FAST_DRAIN_TIMEOUT=1 DRAIN_TIMEOUT=120 run image-new
assert_route green green
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]

# Scenario 9: Route generation change during cleanup -> aborts container stop
new_case; seed blue
printf '1' > "$FAKE_STATE/blue_count"
run image-new
assert_route green green
printf '0' > "$FAKE_STATE/blue_count"
cleaner_out="$(FAKE_GEN_CHANGE_RECHECK=1 run --cleanup-drains 2>&1)"
[[ "$cleaner_out" == *"Route changed"* ]]
[[ "$(cat "$FAKE_STATE/9router-blue")" == running* ]]

# Scenario 10: Concurrent cleaner during deployment lock exits cleanly without interfering
new_case; seed blue
exec 8>"$case_dir/.deployment.lock"
flock -x 8
cleaner_lock_out="$(run --cleanup-drains 2>&1)"
[[ "$cleaner_lock_out" == *"Another deployment holds .deployment.lock; skipping drain cleanup"* ]]
flock -u 8
exec 8>&-

printf 'CLI preflight, ACK, rollback, reconcile, bootstrap and drain scenarios passed\n'
