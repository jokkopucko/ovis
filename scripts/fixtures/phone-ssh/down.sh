#!/bin/bash
# Stop and remove the phone-ssh fixture containers, the bare one too (the images are kept for a fast
# next up.sh).
set -euo pipefail
for name in ovis-phone-ssh-fixture ovis-phone-ssh-bare; do
  docker rm -f "$name" >/dev/null 2>&1 || true
done
echo "docker ps -a --filter name=ovis-phone-ssh:"
docker ps -a --filter "name=ovis-phone-ssh"
