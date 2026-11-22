#!/usr/bin/env bash
# A same-repository pull request goes to the self-hosted runners unless jobs already wait for them:
# the workflow token cannot list runners, so the Actions API's queued and running jobs stand in.
# A fork pull request always gets the GitHub-hosted image: its code must never reach the
# self-hosted runner. This script runs from the checked-out revision, which a fork pull request
# controls; the runner itself refuses fork code (scripts/self-hosted-runner/job-started.sh).
set -euo pipefail

hosted='"ubuntu-24.04"'
default_labels='["self-hosted","self-hosted-ovis"]'
event="${EVENT_NAME:-}"
requested="${REQUESTED_LABELS:-}"
configured="${CONFIGURED_LABELS:-}"
configured_from=CI_SELF_HOSTED_LABELS
if [[ ("$event" == pull_request || ("$event" == push && "${REF:-}" == refs/heads/*)) && -n "${LINUX_LABELS:-}" && -n "${LINUX_LABELS//[[:space:]]/}" ]]; then
  configured=$LINUX_LABELS
  configured_from=CI_LINUX_SELF_HOSTED_LABELS
fi
main_configured="${MAIN_LABELS:-}"
# a part takes about 8 min on our runners and 12.5 on a hosted one, so up to about 4 min of waiting still wins
queue_limit=240
offline_wait=60
live_job=3600

choose_labels() {
  local source="$1" value="$2" compact
  if ! compact=$(jq -ce 'if type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted") then . else error("invalid") end' <<<"$value" 2>/dev/null); then
    echo "::error::$source must be a JSON array of strings that contains \"self-hosted\", got: $value" >&2
    exit 1
  fi
  echo "Runner: self-hosted $compact (from $source)" >&2
  echo "linux=$compact"
}

# the labels of the pull requests' runners (run.sh registers them with self-hosted, Linux and X64):
# a job that asks only for labels among these can take one of them
pool_labels='["self-hosted","linux","x64","self-hosted-ovis"]'

# Only a whole answer is printed: pages a failed attempt got before failing would be counted twice.
# A refusal (HTTP 4xx: the token or the path) would answer the same again, so only a server error or
# no answer is asked again. All reads together have API_BUDGET seconds from the script's start, so the
# hosted fallback is printed well inside Detect changes' five minutes; each attempt is bounded by a
# minute or what is left, with timeout or gtimeout where there is one (stock macOS has neither: there
# an attempt is unbounded, and only the shared budget stops further ones).
API_BUDGET=240
bound=""
if command -v timeout >/dev/null 2>&1; then bound=timeout
elif command -v gtimeout >/dev/null 2>&1; then bound=gtimeout
fi
api() {
  local out errors left
  errors=$(mktemp)
  for _ in 1 2 3; do
    left=$((API_BUDGET - SECONDS))
    if [ "$left" -le 0 ]; then break; fi
    if [ "$left" -gt 60 ]; then left=60; fi
    if out=$(${bound:+$bound "$left"} gh api --paginate "$1" 2>"$errors"); then rm -f "$errors"; printf '%s\n' "$out"; return 0; fi
    cat "$errors" >&2
    if grep -q 'HTTP 4[0-9][0-9]' "$errors"; then break; fi
  done
  rm -f "$errors"
  return 1
}

# Prints "<longest wait> <live>": the seconds the longest-waiting queued job of the pool has waited for a
# runner (a day at most: GitHub drops it then), and how many jobs that can only run on the pool's
# label and started within the last hour are running. A job "in progress" for longer is a stale record
# (some stay so for days), not a runner; so is a run nothing has updated for a day, which is not read.
pool_jobs() {
  local ids id jobs counts wait live longest=0 running=0
  ids=$(for status in in_progress queued; do
    api "repos/$REPOSITORY/actions/runs?status=$status&per_page=100" | jq '.workflow_runs[] | select(now - (.updated_at | fromdateiso8601) < 86400) | .id' || exit 1
  done) || return 1
  for id in $ids; do
    jobs=$(api "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100") || return 1
    counts=$(jq -s -r -e --argjson pool "$pool_labels" --argjson live "$live_job" '[.[].jobs[]
      | select([.labels[] | ascii_downcase] | length > 0 and all(.[]; . as $x | $pool | index($x) != null))] as $ours
      | ([$ours[] | select(.status == "queued") | now - (.created_at | fromdateiso8601) | select(. < 86400)] | max // 0 | floor) as $wait
      | ([$ours[] | select(.status == "in_progress" and ([.labels[] | ascii_downcase] | index("self-hosted-ovis") != null)
          and now - (.started_at | fromdateiso8601) < $live)] | length) as $running
      | "\($wait) \($running)"' <<<"$jobs") || return 1
    read -r wait live <<<"$counts"
    if (( wait > longest )); then longest=$wait; fi
    running=$((running + live))
    if (( longest > queue_limit )); then break; fi
  done
  echo "$longest $running"
}

route_pull_request() {
  local counts waited running
  if ! counts=$(pool_jobs); then
    echo "::warning::could not read the self-hosted runners' jobs; using ubuntu-24.04" >&2
    echo "linux=$hosted"
    return
  fi
  read -r waited running <<<"$counts"
  if (( waited > queue_limit )); then
    echo "Runner: ubuntu-24.04 (a self-hosted job has waited ${waited}s for a runner, pull request)" >&2
    echo "linux=$hosted"
  elif (( running == 0 && waited > offline_wait )); then
    echo "Runner: ubuntu-24.04 (no self-hosted job is running and one has waited ${waited}s: no runner looks online, pull request)" >&2
    echo "linux=$hosted"
  else
    echo "Runner: self-hosted $default_labels (longest self-hosted wait ${waited}s, $running running, pull request)" >&2
    echo "linux=$default_labels"
  fi
}

route_linux() {
if [[ "${HOSTED_ONLY:-}" == true ]]; then
  echo "Runner: ubuntu-24.04 (called with hosted_only)" >&2
  echo "linux=$hosted"
elif [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  echo "Runner: ubuntu-24.04 (pull request from fork ${HEAD_REPO:-unknown})" >&2
  echo "linux=$hosted"
elif [[ -n "${requested//[[:space:]]/}" ]]; then
  choose_labels "workflow_dispatch input self_hosted_labels" "$requested"
elif [[ "${configured//[[:space:]]/}" == "$hosted" ]]; then
  echo "Runner: ubuntu-24.04 (from repository variable $configured_from)" >&2
  echo "linux=$hosted"
elif [[ "$event" == push && "${REF:-}" == refs/heads/main && -n "${main_configured//[[:space:]]/}" ]]; then
  if [[ "${main_configured//[[:space:]]/}" == "$hosted" ]]; then
    echo "Runner: ubuntu-24.04 (push to main, from repository variable CI_MAIN_SELF_HOSTED_LABELS)" >&2
    echo "linux=$hosted"
  else
    choose_labels "repository variable CI_MAIN_SELF_HOSTED_LABELS" "$main_configured"
  fi
elif [[ -n "${configured//[[:space:]]/}" ]]; then
  choose_labels "repository variable $configured_from" "$configured"
elif [[ "$event" == push ]]; then
  choose_labels "default for $event (CI_SELF_HOSTED_LABELS unset)" "$default_labels"
elif [[ "$event" == pull_request ]]; then
  route_pull_request
else
  echo "Runner: ubuntu-24.04 ($event, CI_SELF_HOSTED_LABELS unset)" >&2
  echo "linux=$hosted"
fi
}

line=$(route_linux)
echo "$line"
# Fast checks can stay on other runners while the Linux jobs go to the cloud VM runners (label ovis-vm):
# CI_FAST_SELF_HOSTED_LABELS applies only then, so a fork's Fast checks always follow its hosted Linux jobs.
linux=${line#linux=}
fast=$linux
fast_labels="${FAST_LABELS:-}"
if [[ ("$event" == pull_request || "$event" == push) && "$linux" == *'"ovis-vm"'* && -n "${fast_labels//[[:space:]]/}" ]]; then
  if chosen=$(jq -ce 'if type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted") then . else error("invalid") end' <<<"$fast_labels" 2>/dev/null); then
    echo "Fast checks: self-hosted $chosen (from repository variable CI_FAST_SELF_HOSTED_LABELS)" >&2
    fast=$chosen
  else
    echo "::warning::repository variable CI_FAST_SELF_HOSTED_LABELS must be a JSON array of strings that contains \"self-hosted\", got: $fast_labels; Fast checks follow the Linux jobs" >&2
  fi
fi
echo "fast=$fast"
