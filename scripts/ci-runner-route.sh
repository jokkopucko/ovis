#!/usr/bin/env bash
# Picks the runner for ci.yml's Linux jobs and prints `linux=<json>` for $GITHUB_OUTPUT.
# A fork pull request always gets the GitHub-hosted image: its code must never reach the
# self-hosted runner. Otherwise the workflow_dispatch input wins over the repository variable
# CI_SELF_HOSTED_LABELS. With neither, a push goes to the maintainer PC's runners
# (scripts/self-hosted-runner/, label self-hosted-ovis), a same-repository pull request goes there
# only while they have room for its Linux jobs and to ubuntu-24.04 otherwise, and any other event
# stays on ubuntu-24.04. "Room" is counted from the Actions API, since the workflow token cannot
# list runners: CI_SELF_HOSTED_CAPACITY (default 10) minus the queued and running jobs of every
# workflow that could take those runners must leave at least the jobs one run needs. When that count
# fails, the pull request stays hosted. Setting the variable to labels sends every pull request to
# them, and the value "ubuntu-24.04" (a JSON string, which pages.yml and
# release.yml also accept) keeps every job hosted while that PC is offline. A push to main takes the
# repository variable CI_MAIN_SELF_HOSTED_LABELS over CI_SELF_HOSTED_LABELS when it is set, so main's
# runs go to runners pull requests never use (run.sh --reserved); "ubuntu-24.04" there keeps only
# main hosted, and deleting it puts main back on the shared runners. This script runs from the
# checked-out revision, which a fork pull request controls; the runner itself refuses fork code
# (scripts/self-hosted-runner/job-started.sh).
set -euo pipefail

hosted='"ubuntu-24.04"'
default_labels='["self-hosted","self-hosted-ovis"]'
event="${EVENT_NAME:-}"
requested="${REQUESTED_LABELS:-}"
configured="${CONFIGURED_LABELS:-}"
main_configured="${MAIN_LABELS:-}"
capacity="${SELF_HOSTED_CAPACITY:-}"
# the ci.yml jobs that run on the chosen Linux runner when it is self-hosted (Browser regression
# has one shard there): Fast checks, Integration and both Browser regression jobs
linux_jobs=4

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

# Prints how many unfinished jobs of queued or running workflow runs could take one of those
# runners, stopping once the count passes $1 (one API call per run adds up while many runs wait);
# fails when the API does.
busy_jobs() {
  local limit="$1" ids id jobs n total=0
  ids=$(for status in in_progress queued; do
    gh api --paginate "repos/$REPOSITORY/actions/runs?status=$status&per_page=100" | jq '.workflow_runs[].id' || exit 1
  done) || return 1
  for id in $ids; do
    jobs=$(gh api --paginate "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100") || return 1
    n=$(jq -s -e --argjson pool "$pool_labels" '[.[].jobs[] | select(.status != "completed")
      | [.labels[] | ascii_downcase] | select(index("self-hosted") != null and all(.[]; . as $x | $pool | index($x) != null))]
      | length' <<<"$jobs") || return 1
    total=$((total + n))
    if (( total > limit )); then break; fi
  done
  echo "$total"
}

route_pull_request() {
  local busy
  if [[ -z "${capacity//[[:space:]]/}" ]]; then
    capacity=10
  elif ! [[ "$capacity" =~ ^[0-9]{1,4}$ ]]; then
    echo "::error::repository variable CI_SELF_HOSTED_CAPACITY must be a whole number, got: $capacity" >&2
    exit 1
  fi
  capacity=$((10#$capacity))
  if ! busy=$(busy_jobs $((capacity - linux_jobs))); then
    echo "::warning::could not count the self-hosted runners' jobs; using ubuntu-24.04" >&2
    echo "linux=$hosted"
  elif (( capacity - busy >= linux_jobs )); then
    echo "Runner: self-hosted $default_labels ($busy of $capacity busy, pull request)" >&2
    echo "linux=$default_labels"
  else
    echo "Runner: ubuntu-24.04 (at least $busy of $capacity self-hosted busy, pull request)" >&2
    echo "linux=$hosted"
  fi
}

if [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  echo "Runner: ubuntu-24.04 (pull request from fork ${HEAD_REPO:-unknown})" >&2
  echo "linux=$hosted"
elif [[ -n "${requested//[[:space:]]/}" ]]; then
  choose_labels "workflow_dispatch input self_hosted_labels" "$requested"
elif [[ "${configured//[[:space:]]/}" == "$hosted" ]]; then
  echo "Runner: ubuntu-24.04 (from repository variable CI_SELF_HOSTED_LABELS)" >&2
  echo "linux=$hosted"
elif [[ "$event" == push && "${REF:-}" == refs/heads/main && -n "${main_configured//[[:space:]]/}" ]]; then
  if [[ "${main_configured//[[:space:]]/}" == "$hosted" ]]; then
    echo "Runner: ubuntu-24.04 (push to main, from repository variable CI_MAIN_SELF_HOSTED_LABELS)" >&2
    echo "linux=$hosted"
  else
    choose_labels "repository variable CI_MAIN_SELF_HOSTED_LABELS" "$main_configured"
  fi
elif [[ -n "${configured//[[:space:]]/}" ]]; then
  choose_labels "repository variable CI_SELF_HOSTED_LABELS" "$configured"
elif [[ "$event" == push ]]; then
  choose_labels "default for $event (CI_SELF_HOSTED_LABELS unset)" "$default_labels"
elif [[ "$event" == pull_request ]]; then
  route_pull_request
else
  echo "Runner: ubuntu-24.04 ($event, CI_SELF_HOSTED_LABELS unset)" >&2
  echo "linux=$hosted"
fi
