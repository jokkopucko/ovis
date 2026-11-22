#!/bin/bash
# Simulate a changed host key: new ssh host keys in the running fixture container, then sshd reloads.
set -euo pipefail
name=ovis-phone-ssh-fixture
docker exec "$name" sh -c 'rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP "$(pgrep -o -x sshd)"'
for _ in $(seq 100); do
  docker exec "$name" sh -c 'ssh-keyscan -T 1 -t ed25519 127.0.0.1 2>/dev/null' | grep -q ssh-ed25519 && break
  sleep 0.1
done
echo "new host key fingerprints:"
docker exec "$name" sh -c 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done'
