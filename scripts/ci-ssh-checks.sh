#!/usr/bin/env bash
# The SSH checks of remote-bundles.yml on a built Linux bundle (remote-bundles/), one part a step: the ssh job of a
# tag or a manual run, and bundle-linux of a pull request, which runs them on the bundle it already built.
set -euo pipefail

case "${1:-}" in
  server)
    # the self-hosted image already ships sshd (and has no sudo); a hosted runner installs it
    if [ -x /usr/sbin/sshd ] && [ -d /run/sshd ]; then
      echo "sshd is already installed"
    else
      sudo bash scripts/ci-bounded-retry.sh 300 bash -c 'apt-get update && apt-get install -y openssh-server' && sudo mkdir -p /run/sshd
    fi
    ;;
  integration)
    # password mode creates an account and starts sshd as root; without sudo (the self-hosted image) the
    # key-only flow runs, with sshd as the runner user on a port of its own. Only a self-hosted runner
    # may go without sudo or Docker: a hosted one that lost either fails, since release needs this job (#3829)
    if [ "${RUNNER_ENVIRONMENT:-}" != self-hosted ]; then sudo -n true; fi
    if sudo -n true 2>/dev/null; then export SSH_TEST_PASSWORD=1; fi
    bun run scripts/ssh-integration.ts
    ;;
  password)
    if [ "${RUNNER_ENVIRONMENT:-}" != self-hosted ]; then docker info >/dev/null; fi
    if docker info >/dev/null 2>&1; then bun run scripts/ssh-password-docker.ts; else echo "::notice::no Docker here, password flow skipped"; fi
    ;;
  *)
    echo "usage: $0 server|integration|password" >&2
    exit 2
    ;;
esac
