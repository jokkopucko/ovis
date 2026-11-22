#!/bin/bash
# Build and start the disposable phone-ssh fixture container (see claude-standin.py for the agent).
#   ssh -p 2290 fixture@127.0.0.1   password: phone-ssh-test-only   (host loopback only)
#   Ovis inside listens on the container's 127.0.0.1:7317: reach it with ssh -L.
# PHONE_SSH_WORK names the scratch folder (default ~/.cache/ovis-tmp/phone-ssh). up-bare.sh starts
# a second one with neither herdr nor Ovis, for the first install from the phone.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
name=ovis-phone-ssh-fixture
image=ovis-phone-ssh-fixture:local
work=${PHONE_SSH_WORK:-$HOME/.cache/ovis-tmp/phone-ssh}
ctx=$work/ctx
mkdir -p "$work/tmp" "$ctx/bin"
export TMPDIR=$work/tmp

if [ ! -f "$repo/dist/index.html" ]; then
  echo "up: dist/ missing, running bun run build"
  (cd "$repo" && bun run build)
fi

# the host's `herdr` may be a guard wrapper script around the real binary
herdr_bin=$(command -v herdr)
[ -x "$(dirname "$herdr_bin")/herdr-real" ] && herdr_bin=$(dirname "$herdr_bin")/herdr-real
install -m 755 "$herdr_bin" "$ctx/bin/herdr"
install -m 755 "$(readlink -f "$(command -v bun)")" "$ctx/bin/bun"
install -m 644 "$here/Dockerfile" "$here/sshd_config" "$here/claude-standin.py" "$here/entrypoint.sh" "$here/start-fixture.sh" "$ctx/"
rsync -a --delete \
  --exclude=/.git --exclude=/app --exclude=/docs --exclude=/evidence --exclude=/site --exclude=/ovis-site \
  --exclude=/crates --exclude=/scripts/fixtures/phone-ssh --exclude=node_modules/.cache --exclude='.env*' \
  "$repo/" "$ctx/ovis/"

cpuset=()
# the build is kept to the CPUs a heavy slot gives (OVIS_HEAVY_CPUS) only when one is given
[ -n "${OVIS_HEAVY_CPUS:-}" ] && docker build --help 2>/dev/null | grep -q -- --cpuset-cpus && cpuset=(--cpuset-cpus "$OVIS_HEAVY_CPUS")
docker build "${cpuset[@]}" -t "$image" "$ctx"

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --init --name "$name" -p 127.0.0.1:2290:22 "$image" >/dev/null

for _ in $(seq 600); do
  logs=$(docker logs "$name" 2>&1 || true)
  # ready once the stand-in is up and sshd answers (start-fixture.sh runs before entrypoint.sh starts sshd)
  if grep -q "start-fixture: herdr, stand-in claude" <<<"$logs" && docker exec "$name" sh -c 'ssh-keyscan -T 1 -t ed25519 127.0.0.1 2>/dev/null' | grep -q ssh-ed25519; then
    echo "$logs" | grep "start-fixture:"
    docker ps --filter "name=^${name}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then break; fi
  sleep 0.1
done
echo "up: fixture did not come up; container logs:" >&2
docker logs "$name" >&2 || true
exit 1
