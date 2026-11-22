#!/bin/bash
# Container entry (root): start the fixture user's herdr, stand-in agent and Ovis server, then sshd.
set -euo pipefail
mkdir -p /run/sshd
runuser -u fixture -- /opt/phone-ssh/start-fixture.sh
# sshd in the foreground (-e: log to stderr, seen in `docker logs`); rekey.sh restarts it by
# sending SIGHUP, which re-execs sshd with the new host keys
exec /usr/sbin/sshd -D -e
