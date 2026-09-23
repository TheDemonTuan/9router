#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/traefik"
cp "$repo_root/deploy.sh" "$tmp/deploy.sh"
chmod +x "$tmp/deploy.sh"

cat > "$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${CURL_LOG:?}"
if grep -q 'http://9router-blue:20128' "${TRAEFIK_DYNAMIC_DIR:?}/9router.yml" 2>/dev/null; then
  printf '%s\n' '{"ok":true,"instance_id":"instance-blue","active_requests":0,"active_requests_known":true,"active_responses":0,"active_responses_known":true}'
else
  printf '%s\n' '{"ok":true,"instance_id":"instance-green","active_requests":0,"active_requests_known":true,"active_responses":0,"active_responses_known":true}'
fi
CURL
chmod +x "$tmp/bin/curl"

cat > "$tmp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
log_file="${DOCKER_LOG:?}"
printf '%s\n' "$*" >> "$log_file"

case "${1:-}" in
  network)
    exit 0
    ;;
  inspect)
    if [[ "${DOCKER_TARGET_RUNNING:-false}" == true ]]; then
      printf 'true\n'
      exit 0
    fi
    exit 1
    ;;
  exec)
    case "${2:-}" in
      9router-green)
        printf '%s\n' '{"ok":true,"instance_id":"instance-green","active_requests":1,"active_requests_known":true,"active_responses":1,"active_responses_known":true,"oldest_active_request_ms":93000}'
        ;;
      9router-blue)
        printf '%s\n' '{"ok":true,"instance_id":"instance-blue","active_requests":0,"active_requests_known":true,"active_responses":0,"active_responses_known":true}'
        ;;
    esac
    ;;
  image)
    exit 0
    ;;
  compose)
    exit 0
    ;;
  logs)
    exit 0
    ;;
esac
DOCKER
chmod +x "$tmp/bin/docker"

export PATH="$tmp/bin:$PATH"
export DOCKER_LOG="$tmp/docker.log"
export CURL_LOG="$tmp/curl.log"
export COMPOSE_FILE="$tmp/compose.yml"
export TRAEFIK_DYNAMIC_DIR="$tmp/traefik"
export API_HOST=api.test
export CUTOVER_PROBE_URL=http://api.test/api/health
export CUTOVER_PROBE_ATTEMPTS=2
export CUTOVER_PROBE_SUCCESSES=1
export READY_TIMEOUT=2
export DRAIN_TIMEOUT=1
export DRAIN_POLL_SECONDS=1

printf 'green' > "$tmp/.active-slot"
printf 'blue' > "$tmp/.previous-slot"
printf 'old-image' > "$tmp/.deployed-image"

before_state="$(cat "$tmp/.active-slot")|$(cat "$tmp/.previous-slot")|$(cat "$tmp/.deployed-image")"
(
  cd "$tmp"
  ./deploy.sh --reconcile
)

test "$(cat "$tmp/.active-slot")|$(cat "$tmp/.previous-slot")|$(cat "$tmp/.deployed-image")" = "$before_state"
grep -q 'http://9router-green:20128' "$tmp/traefik/9router.yml"
! grep -q 'http://9router-blue:20128' "$tmp/traefik/9router.yml"
grep -q -- 'compose -f ' "$tmp/docker.log"
grep -q -- '9router-green' "$tmp/docker.log"

if (cd "$tmp" && ./deploy.sh new-image) >"$tmp/deploy.log" 2>&1; then
  :
else
  echo 'expected verified cutover to succeed despite cleanup timeout' >&2
  cat "$tmp/deploy.log" >&2
  exit 1
fi

grep -q 'active_requests=1, known=true' "$tmp/deploy.log"
grep -q 'DRAIN_CLEANUP_PENDING' "$tmp/deploy.log"
! grep -q 'compose .* stop 9router-green' "$tmp/docker.log"
grep -q 'http://9router-blue:20128' "$tmp/traefik/9router.yml"
test "$(cat "$tmp/.active-slot")" = blue
grep -q '^cutover=verified$' "$tmp/.deployment-result"
grep -q '^cleanup=pending$' "$tmp/.deployment-result"

rm -f "$tmp/.active-slot" "$tmp/.deployed-image"
printf 'stale-slot' > "$tmp/.previous-slot"
if (cd "$tmp" && ./deploy.sh bootstrap-image) >"$tmp/bootstrap.log" 2>&1; then
  :
else
  echo 'expected bootstrap deployment to succeed without an old slot' >&2
  exit 1
fi

test "$(cat "$tmp/.active-slot")" = blue
! test -e "$tmp/.previous-slot"
grep -q 'Initial deployment complete; no previous slot to drain.' "$tmp/bootstrap.log"
! grep -q 'Stopping idle container' "$tmp/bootstrap.log"

echo 'deploy reconcile, bootstrap, and verified-cutover cleanup safety passed'
