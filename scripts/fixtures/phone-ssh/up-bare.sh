#!/bin/bash
# Start the bare phone-ssh fixture: SSH on 127.0.0.1:2291 (fixture / phone-ssh-test-only), with
# neither herdr nor Ovis, so the phone's first install (SshLink.install) runs the official installer
# there from the start. A new container each time: every run installs from nothing.
# down.sh stops it too.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=ovis-phone-ssh-bare
image=ovis-phone-ssh-bare:local
work=${PHONE_SSH_WORK:-$HOME/.cache/ovis-tmp/phone-ssh}
ctx=$work/ctx-bare
mkdir -p "$work/tmp" "$ctx"
export TMPDIR=$work/tmp
install -m 644 "$here/Dockerfile.bare" "$ctx/Dockerfile"
install -m 644 "$here/sshd_config" "$ctx/"

cpuset=()
# the build is kept to the CPUs a heavy slot gives (OVIS_HEAVY_CPUS) only when one is given
[ -n "${OVIS_HEAVY_CPUS:-}" ] && docker build --help 2>/dev/null | grep -q -- --cpuset-cpus && cpuset=(--cpuset-cpus "$OVIS_HEAVY_CPUS")
docker build "${cpuset[@]}" -t "$image" "$ctx"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --init --name "$name" -p 127.0.0.1:2291:22 "$image" >/dev/null

for _ in $(seq 100); do
  if docker exec "$name" sh -c 'ssh-keyscan -T 1 -t ed25519 127.0.0.1 2>/dev/null' | grep -q ssh-ed25519; then
    docker ps --filter "name=^${name}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
    exit 0
  fi
  sleep 0.1
done
echo "up-bare: sshd did not come up; container logs:" >&2
docker logs "$name" >&2 || true
exit 1
