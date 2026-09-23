#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/traefik"
cp "$repo_root/deploy.sh" "$tmp/deploy.sh"
chmod +x "$tmp/deploy.sh"

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
    exit 1
    ;;
  exec)
    case "${2:-}" in
      9router-green)
        printf '%s\n' '{"ok":true,"active_requests":null,"active_requests_known":false}'
        ;;
      9router-blue)
        printf '%s\n' '{"ok":true,"active_requests":0,"active_requests_known":true}'
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
export COMPOSE_FILE="$tmp/compose.yml"
export TRAEFIK_DYNAMIC_DIR="$tmp/traefik"
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
  echo 'expected unknown drain to fail closed' >&2
  exit 1
fi

grep -q 'active_requests=unknown, known=false' "$tmp/deploy.log"
grep -q 'Deployment left old slot running after drain timeout' "$tmp/deploy.log"
! grep -q 'compose .* stop 9router-green' "$tmp/docker.log"
grep -q 'http://9router-blue:20128' "$tmp/traefik/9router.yml"
test "$(cat "$tmp/.active-slot")" = blue

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

echo 'deploy reconcile, bootstrap, and unknown-drain safety passed'
