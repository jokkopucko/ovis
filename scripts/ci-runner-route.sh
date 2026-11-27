#!/usr/bin/env bash
# A same-repository pull request goes to the self-hosted runners unless jobs already wait for them:
# the workflow token cannot list runners, so the Actions API's queued and running jobs stand in.
# A fork pull request always gets the GitHub-hosted image: its code must never reach the
# self-hosted runner. This script runs from the checked-out revision, which a fork pull request
# controls; the runner itself refuses fork code (scripts/self-hosted-runner/job-started.sh).
# The Rust PTY host job has runners of its own (rust=, route_rust below).
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
# The Rust PTY host job asks for a label only the runners whose image has the Rust toolchain carry (one slot each
# on the hosts that run them, scripts/self-hosted-runner/README.md "Routing jobs to it"). It takes about a minute on
# either side, and GitHub's hosted queue holds it for seconds: once one has waited a minute for those runners (busy),
# the next run's goes hosted. The workflow token cannot list runners, so whether one is online at all comes from the
# repository variable CI_RUST_RUNNER_SEEN: the epoch seconds at which scripts/self-hosted-runner/rust-heartbeat.sh,
# run every minute with an admin token, last saw one online. Unset, not a number or older than rust_seen_limit sends
# the job hosted before it queues, so a run never waits for runners that are all gone.
rust_label=self-hosted-ovis-rust
rust_labels="[\"self-hosted\",\"$rust_label\"]"
rust_queue_limit=60
rust_seen_limit=300
# a heartbeat this far ahead of the route's clock is not believed (the two clocks differ by seconds)
rust_seen_ahead=120
# Fast checks and Integration tests may prefer the fastest machine's own label (CI_FAST_SELF_HOSTED_LABELS,
# CI_INTEGRATION_SELF_HOSTED_LABELS; "prefer" below): they take about half as long there, so a wait of up to two minutes
# for it still wins, and a longer one sends them to the Linux jobs' runners.
prefer_queue_limit=120

# One label list the self-hosted runners can take, compacted, or nothing.
label_list() {
  jq -sce 'if length == 1 and (.[0] | type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted")) then .[0] else error("invalid") end' <<<"$1" 2>/dev/null
}
# the preferred label lists the jobs read counts: [] when unset, not a label list or the pool's own labels
fast_prefer=$(label_list "${FAST_LABELS:-}") && [[ "$fast_prefer" != "$default_labels" ]] || fast_prefer='[]'
integration_prefer=$(label_list "${INTEGRATION_LABELS:-}") && [[ "$integration_prefer" != "$default_labels" ]] || integration_prefer='[]'

# Prints "<output>=<labels>"; the output is linux unless a third argument names another.
choose_labels() {
  local source="$1" value="$2" output="${3:-linux}" compact
  if ! compact=$(jq -ce 'if type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted") then . else error("invalid") end' <<<"$value" 2>/dev/null); then
    echo "::error::$source must be a JSON array of strings that contains \"self-hosted\", got: $value" >&2
    exit 1
  fi
  echo "Runner: self-hosted $compact (from $source)" >&2
  echo "$output=$compact"
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

# Prints "<longest wait> <live> <longest Rust wait> <winvm taken>": the seconds the longest-waiting queued job of
# the pool has waited for a runner (a day at most: GitHub drops it then), how many jobs that can only run on the
# pool's label and started within the last hour are running, the seconds the longest-waiting queued job that
# asks for the Rust runners' label has waited, and how many jobs that name winvm's label are queued, or started
# within the last hour and running. A job "in progress" for longer is a stale record (some stay so for days), not
# a runner; so is a run nothing has updated for a day, which is not read. One read serves all three routes. Then, for
# the preferred labels of Fast checks and of Integration tests, "<longest wait> <live>" of the jobs that ask for all
# of them (0 0 when none are set).
pool_jobs() {
  local ids id jobs counts wait live rust win fw fl iw il longest=0 running=0 rust_longest=0 winvm_taken=0 fast_wait=0 fast_live=0 integration_wait=0 integration_live=0
  ids=$(for status in in_progress queued; do
    api "repos/$REPOSITORY/actions/runs?status=$status&per_page=100" | jq '.workflow_runs[] | select(now - (.updated_at | fromdateiso8601) < 86400) | .id' || exit 1
  done) || return 1
  for id in $ids; do
    jobs=$(api "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100") || return 1
    counts=$(jq -s -r -e --argjson pool "$pool_labels" --argjson live "$live_job" --arg rust "$rust_label" --argjson fast "$fast_prefer" --argjson integration "$integration_prefer" '# a missing time counts as now: no wait, and a running job that is live
      def age(t): if t == null then 0 else now - (t | fromdateiso8601) end;
      # the longest wait and the live count of the jobs that ask for a label of $want other than self-hosted: the
      # label of that machine alone, which only its runners carry
      def preferred($all; $want): ([$want[] | ascii_downcase] - ["self-hosted"] - $pool) as $own | if ($own | length) == 0 then "0 0" else
        [$all[] | select([.labels[] | ascii_downcase] as $has | any($own[]; . as $x | $has | index($x) != null))] as $mine
        | "\([$mine[] | select(.status == "queued") | age(.created_at) | select(. < 86400)] | max // 0 | floor) \([$mine[] | select(.status == "in_progress" and age(.started_at) < $live)] | length)" end;
      [.[].jobs[]] as $all
      | [$all[] | select([.labels[] | ascii_downcase] | length > 0 and all(.[]; . as $x | $pool | index($x) != null))] as $ours
      | ([$ours[] | select(.status == "queued") | age(.created_at) | select(. < 86400)] | max // 0 | floor) as $wait
      | ([$ours[] | select(.status == "in_progress" and ([.labels[] | ascii_downcase] | index("self-hosted-ovis") != null)
          and age(.started_at) < $live)] | length) as $running
      | ([$all[] | select(.status == "queued" and ([.labels[] | ascii_downcase] | index($rust) != null))
          | age(.created_at) | select(. < 86400)] | max // 0 | floor) as $rust_wait
      | ([$all[] | select([.labels[] | ascii_downcase] | index("self-hosted-ovis-win") != null)
          | select(.status == "queued" or (.status == "in_progress" and age(.started_at) < $live))] | length) as $win
      | "\($wait) \($running) \($rust_wait) \($win) \(preferred($all; $fast)) \(preferred($all; $integration))"' <<<"$jobs") || return 1
    read -r wait live rust win fw fl iw il <<<"$counts"
    if (( wait > longest )); then longest=$wait; fi
    if (( rust > rust_longest )); then rust_longest=$rust; fi
    running=$((running + live))
    winvm_taken=$((winvm_taken + win))
    if (( fw > fast_wait )); then fast_wait=$fw; fi
    if (( iw > integration_wait )); then integration_wait=$iw; fi
    fast_live=$((fast_live + fl))
    integration_live=$((integration_live + il))
    # the Rust route reads the scan only when opted in and the Windows route only while winvm waits; otherwise the
    # Linux route's answer is enough to stop
    if (( longest > queue_limit )) && { [[ "${RUST_SELF_HOSTED:-}" != true ]] || (( rust_longest > rust_queue_limit )); } \
      && { [[ -n "$winvm_why" ]] || (( winvm_taken > 0 )); } \
      && { [[ "$fast_prefer" == '[]' ]] || (( fast_wait > prefer_queue_limit )); } \
      && { [[ "$integration_prefer" == '[]' ]] || (( integration_wait > prefer_queue_limit )); }; then break; fi
  done
  echo "$longest $running $rust_longest $winvm_taken $fast_wait $fast_live $integration_wait $integration_live"
}

# pool_jobs once for the three routes, the Linux and Rust ones each in a subshell: its answer, or "failed". Without a
# temporary file each route reads the jobs itself, as a run with only one route needing them always did.
pool_file=$(mktemp 2>/dev/null) || pool_file=""
trap '[ -z "$pool_file" ] || rm -f "$pool_file"' EXIT
pool_counts() {
  [ -n "$pool_file" ] || { pool_jobs; return; }
  if [ ! -s "$pool_file" ]; then pool_jobs > "$pool_file" || echo failed > "$pool_file"; fi
  # only a whole answer counts: a cache the disk would not take (empty, cut short) is a failed read
  local counts
  counts=$(cat "$pool_file")
  [[ "$counts" =~ ^[0-9]+(\ [0-9]+){7}$ ]] && echo "$counts"
}

route_pull_request() {
  local counts waited running
  if ! counts=$(pool_counts); then
    echo "::warning::could not read the self-hosted runners' jobs; using ubuntu-24.04" >&2
    echo "linux=$hosted"
    return
  fi
  read -r waited running _ <<<"$counts"
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

# The Rust PTY host job: hosted unless the repository variable CI_RUST_SELF_HOSTED is "true" (an opt-in: unset,
# empty or "false" is the hosted image, as before the Rust runners existed), and hosted wherever the Linux jobs are by
# a rule (hosted_only, a fork, CI_SELF_HOSTED_LABELS naming the hosted image, an event other than a pull request or a
# push) whatever it says. Opted in, the job goes to the Rust runners while their heartbeat is fresh and none of
# their jobs has waited too long.
route_rust() {
  local opted_in="${RUST_SELF_HOSTED:-}" configured_all="${CONFIGURED_LABELS:-}" seen="${RUST_SEEN:-}" now="${ROUTE_NOW:-$(date +%s)}" counts waited
  if [[ "${HOSTED_ONLY:-}" == true ]]; then
    echo "Rust PTY host: ubuntu-24.04 (called with hosted_only)" >&2
    echo "rust=$hosted"
  elif [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
    echo "Rust PTY host: ubuntu-24.04 (pull request from fork ${HEAD_REPO:-unknown})" >&2
    echo "rust=$hosted"
  elif [[ "${configured_all//[[:space:]]/}" == "$hosted" ]]; then
    echo "Rust PTY host: ubuntu-24.04 (from repository variable CI_SELF_HOSTED_LABELS)" >&2
    echo "rust=$hosted"
  elif [[ "$event" != pull_request && "$event" != push ]]; then
    echo "Rust PTY host: ubuntu-24.04 ($event)" >&2
    echo "rust=$hosted"
  elif [[ "$opted_in" != true ]]; then
    if [[ -n "$opted_in" && "$opted_in" != false ]]; then
      echo "::error::repository variable CI_RUST_SELF_HOSTED may only be \"true\" or \"false\" (or unset), got: $opted_in" >&2
      exit 1
    fi
    echo "Rust PTY host: ubuntu-24.04 (CI_RUST_SELF_HOSTED is not \"true\")" >&2
    echo "rust=$hosted"
  elif ! [[ "$seen" =~ ^[0-9]{1,12}$ ]]; then
    echo "Rust PTY host: ubuntu-24.04 (the Rust runners' heartbeat CI_RUST_RUNNER_SEEN is unset or not a number)" >&2
    echo "rust=$hosted"
  elif (( now - 10#$seen > rust_seen_limit )); then
    echo "Rust PTY host: ubuntu-24.04 (no Rust runner seen online for $(( now - 10#$seen ))s)" >&2
    echo "rust=$hosted"
  elif (( 10#$seen - now > rust_seen_ahead )); then
    echo "Rust PTY host: ubuntu-24.04 (the Rust runners' heartbeat is $(( 10#$seen - now ))s ahead of this clock)" >&2
    echo "rust=$hosted"
  elif ! counts=$(pool_counts); then
    echo "::warning::could not read the self-hosted runners' jobs; the Rust PTY host uses ubuntu-24.04" >&2
    echo "rust=$hosted"
  else
    read -r _ _ waited _ <<<"$counts"
    if (( waited > rust_queue_limit )); then
      echo "Rust PTY host: ubuntu-24.04 (a job has waited ${waited}s for the Rust runners)" >&2
      echo "rust=$hosted"
    else
      echo "Rust PTY host: self-hosted $rust_labels (longest wait for the Rust runners ${waited}s)" >&2
      echo "rust=$rust_labels"
    fi
  fi
}

# Native Windows install: winvm, the Windows 11 VM on the maintainer's PC, while its launcher says its one runner
# waits for a job (scripts/self-hosted-runner/winvm-runner.sh writes the Unix time into the repository variable
# CI_WINVM_READY every minute while it listens, and 0 once a job starts or it stops). Anything else gets
# windows-latest: hosted_only, a fork pull request, an event other than a pull request or a push (WINVM_READY is
# empty for a workflow that calls ci.yml), a draft pull request (its job fails at its first step without running a
# test, and on winvm that would spend the VM's whole round), a mark that is missing or older than three minutes, and a job of winvm's
# label already queued or running (winvm runs one job a round; a second would wait for the next round, or forever
# when the launcher stops after the first) or a jobs list the API does not give. winvm_why is decided before the
# routes read the jobs, so their one read knows whether winvm's jobs matter: empty while they do.
windows_hosted='"windows-latest"'
windows_labels='["self-hosted","self-hosted-ovis-win"]'
ready="${WINVM_READY:-}"
now=$(date +%s)
winvm_why=""
if [[ "${HOSTED_ONLY:-}" == true ]]; then
  winvm_why="called with hosted_only"
elif [[ ("$event" == pull_request || "$event" == pull_request_target) && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  winvm_why="pull request from fork ${HEAD_REPO:-unknown}"
elif [[ "$event" != pull_request && "$event" != push ]]; then
  winvm_why="${event:-no event}"
elif [[ "${PR_DRAFT:-}" == true ]]; then
  winvm_why="a draft pull request, whose job runs no test"
elif ! [[ "$ready" =~ ^[1-9][0-9]{0,11}$ ]]; then
  winvm_why="winvm's runner is not waiting for a job (CI_WINVM_READY ${ready:-unset})"
elif (( now - ready > 180 || ready - now > 60 )); then
  winvm_why="winvm's runner last said it was waiting $((now - ready))s ago"
fi

line=$(route_linux)
rust_line=$(route_rust)
echo "$line"
# Fast checks and Integration tests: the Linux jobs' runners, or the labels of a repository variable naming the
# fastest machine's own runners (scripts/self-hosted-runner/README.md), which only a same-repository pull request or a
# push whose Linux jobs take the shared pool ($default_labels) uses (never a fork's or a hosted_only run's: those are
# hosted; never main's reserved runners or the VM runners, which keep their own), and only while that machine's queue
# is short: once a job asking for its label has waited more than prefer_queue_limit, or one has waited a minute and
# none of theirs runs, the job follows the Linux jobs. A job already sent there waits for that machine.
# Prints the labels; <name> <variable> <value> <field of the jobs read: its longest wait, then its live count>.
prefer() {
  local name="$1" variable="$2" value="$3" field="$4" chosen counts wait live
  local -a all
  if [[ -z "${value//[[:space:]]/}" || ("$event" != pull_request && "$event" != push) || "$linux" != "$default_labels" ]]; then echo "$linux"; return; fi
  if ! chosen=$(label_list "$value"); then
    echo "::warning::repository variable $variable must be a JSON array of strings that contains \"self-hosted\", got: $value; $name follow the Linux jobs" >&2
    echo "$linux"; return
  fi
  if [[ "$chosen" == "$linux" ]]; then echo "$linux"; return; fi
  if ! counts=$(pool_counts); then
    echo "::warning::could not read the self-hosted runners' jobs; $name follow the Linux jobs" >&2
    echo "$linux"; return
  fi
  read -r -a all <<<"$counts"
  wait=${all[$field]} live=${all[$field + 1]}
  if (( wait > prefer_queue_limit )); then
    echo "$name: self-hosted $linux (a job of $variable has waited ${wait}s)" >&2
    echo "$linux"
  elif (( live == 0 && wait > offline_wait )); then
    echo "$name: self-hosted $linux (a job of $variable has waited ${wait}s and none of theirs is running)" >&2
    echo "$linux"
  else
    echo "$name: self-hosted $chosen (from repository variable $variable, longest wait ${wait}s)" >&2
    echo "$chosen"
  fi
}

# The cloud VM runners (label ovis-vm) keep Fast checks' own rule: CI_FAST_SELF_HOSTED_LABELS applies as it is, without
# the queue check, so a fork's Fast checks always follow its hosted Linux jobs.
linux=${line#linux=}
fast_labels="${FAST_LABELS:-}"
if [[ ("$event" == pull_request || "$event" == push) && "$linux" == *'"ovis-vm"'* && -n "${fast_labels//[[:space:]]/}" ]]; then
  fast=$linux
  if chosen=$(label_list "$fast_labels"); then
    echo "Fast checks: self-hosted $chosen (from repository variable CI_FAST_SELF_HOSTED_LABELS)" >&2
    fast=$chosen
  else
    echo "::warning::repository variable CI_FAST_SELF_HOSTED_LABELS must be a JSON array of strings that contains \"self-hosted\", got: $fast_labels; Fast checks follow the Linux jobs" >&2
  fi
else
  fast=$(prefer "Fast checks" CI_FAST_SELF_HOSTED_LABELS "$fast_labels" 4)
fi
echo "fast=$fast"
echo "$rust_line"
echo "integration=$(prefer "Integration tests" CI_INTEGRATION_SELF_HOSTED_LABELS "${INTEGRATION_LABELS:-}" 6)"

if [[ -n "$winvm_why" ]]; then
  why=$winvm_why
elif ! counts=$(pool_counts); then
  why="could not read the jobs of winvm's label"
elif read -r _ _ _ taken _ <<<"$counts"; (( taken > 0 )); then
  # the read stops at the first run that settles every route, so this is how many it saw, at least one
  why="$taken job(s) of winvm's label already queued or running"
# the read may have taken minutes: the mark is checked again against the clock now
elif now=$(date +%s); (( now - ready > 180 || ready - now > 60 )); then
  why="winvm's runner last said it was waiting $((now - ready))s ago"
else
  echo "Windows: self-hosted $windows_labels (winvm's runner said it was waiting $((now - ready))s ago)" >&2
  echo "windows=$windows_labels"
  exit 0
fi
echo "Windows: windows-latest ($why)" >&2
echo "windows=$windows_hosted"
