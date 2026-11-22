#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_URL:?RUNNER_URL is required}"
# The registration token arrives on stdin, never in the environment: a container's initial
# environment stays readable in /proc/1/environ by every process of the same user, jobs included.
IFS= read -r RUNNER_TOKEN || true
: "${RUNNER_TOKEN:?a registration token is required on stdin}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted-ovis}"

# --disableupdate: a runner older than GitHub's latest release otherwise downloads the update after it
# is handed a job, and GitHub cancels that job about 3.5 minutes later with no runner and no step.
# The image's RUNNER_VERSION is what keeps it current (README "Runner version").
./config.sh --unattended --ephemeral --disableupdate \
  --url "$RUNNER_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work /w \
  --replace

unset RUNNER_TOKEN
exec ./run.sh </dev/null
