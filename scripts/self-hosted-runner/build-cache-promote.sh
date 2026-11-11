#!/usr/bin/env bash
# Moves the client builds that trusted jobs left in their slots' outboxes into the build cache
# (README "Build cache"). Runner containers get the cache read-only: a job only writes its own
# slot's outbox, `<key>.tar` and then `<key>.claim` (its GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT). This
# runs on the host, as the launcher's user, and takes a build only when GitHub says the slot is
# running a job of that run and the run is trusted: a push to the default branch, or a pull request
# from this repository that --writer opened and pushed. Every other outbox file is deleted.
#
# A slot runs one job per container, under the same runner name each time, and GitHub answers for
# the job the slot runs when it answers. So a claim is its container's: it is taken in only while the
# container that was the slot's when the claim was taken still is, only when the claim was written
# once that container had started, and only for a job that started once it had, on the runner
# registered under the slot's name now. A claim naming the run of the slot's next job, or of an
# earlier job GitHub still lists as running, is refused, and so is one an earlier container's job
# left behind.
#
# A build is filed under the run GitHub confirmed for its slot, entries/<run id>/<key>, and a job
# reads only its own run's directory (scripts/build-cache.ts). The key is the job's word for what it
# built, which nothing here can check: filed by the key alone, a trusted pull request's build under
# the key of a commit of main would be the one main's own run restores and tests.
#
# Usage: build-cache-promote.sh REPO CACHE_ROOT OUTBOXES WRITER MAX_MB SLOT_NAME...
#   CACHE_ROOT holds entries/ (the cache) and used/ (when each key was last restored), both written only
#   here; OUTBOXES holds a directory per runner, named after it; WRITER may be empty. A restore says it used an entry
#   with an empty outbox file used-<key>, of which only the name is read.
set -euo pipefail

REPO="$1" ROOT="$2" OUTBOXES="$3" WRITER="$4" MAX_MB="$5"
shift 5
ENTRIES="$ROOT/entries"
USED="$ROOT/used"
# a run id, as a claim may name one and as a run's directory under entries/ is named
RUN_ID='^[0-9]{1,20}$'

log() { echo "[build-cache] $*" >&2; }

# One GitHub call, with a deadline (one request that hangs must not stop the promotion of every slot):
# 3 when GitHub says what was asked for does not exist (a claim naming a made-up run), 2 for any other
# failure (a timeout, an error, a rate limit), which proves nothing either way.
ask() {
  local status=0
  timeout 20 gh api "$@" 2>"$REFUSED/.gh-error" || status=$?
  [ "$status" = 0 ] && return 0
  if grep -qE 'HTTP (404|422)' "$REFUSED/.gh-error" 2>/dev/null; then return 3; fi
  return 2
}

# Whether the runner named $1, whose container started at $4 (seconds since the epoch), is running a
# job of run $2 (attempt $3), and that run is trusted: 0 when it is; 1 when GitHub says the run is not
# trusted; 4 when it is a stale run of the writer's pull request (its head moved on); 3 when the claim
# is at fault (no job of that run on this slot's container, or no such run); 5 when the slot's runner
# is gone (its job ended meanwhile); 2 when GitHub did not answer.
trusted() {
  local name="$1" run="$2" attempt="$3" since="$4" jobs own runners runner info default pulls number pull
  jobs="$(ask "repos/$REPO/actions/runs/$run/attempts/$attempt/jobs?per_page=100")" || return $?
  jq -e --arg name "$name" 'any(.jobs[]; .runner_name == $name and .status == "in_progress")' >/dev/null <<<"$jobs" || { log "run $run has no job running on $name"; return 3; }
  # The name has had other containers, and GitHub goes on listing the job of one that was killed as
  # running, for minutes and sometimes for days: only a job that started once this container had is
  # its own. By the time, not by the runner alone: a container that registers over a dead one's
  # runner (config.sh --replace) keeps that runner's id. Nothing is allowed for the two clocks: run.sh
  # waits two seconds before every container of a slot, the first after a launcher start included
  # (the container before may have been killed with the launcher that started it), so a job of an
  # earlier container started at least that long before this one did, and an allowance would let it
  # in; a container's own job starts ten seconds or more after it (the runner registers first).
  own="$(jq -c --arg name "$name" --argjson since "$since" '[.jobs[] | select(.runner_name == $name and .status == "in_progress" and ((.started_at // "") | try fromdateiso8601 catch 0) >= $since)]' <<<"$jobs")"
  [ -n "$own" ] && [ "$own" != "[]" ] || { log "run $run's job on $name started before the slot's container did: it is an earlier container's"; return 3; }
  # And on the runner registered under the name now: a runner that ended its job is gone from
  # GitHub, so a job of an earlier registration is on another id.
  runners="$(ask "repos/$REPO/actions/runners" -X GET -f "name=$name" -f per_page=100)" || return 2
  runner="$(jq -r --arg name "$name" '[.runners[]? | select(.name == $name) | .id] | if length == 1 then .[0] else "" end' <<<"$runners")"
  [[ "$runner" =~ ^[0-9]+$ ]] || { log "no runner is registered as $name any more"; return 5; }
  jq -e --argjson runner "$runner" 'any(.[]; .runner_id == $runner)' >/dev/null <<<"$own" || { log "run $run's job on $name is on another runner than the one registered under that name now"; return 3; }
  info="$(ask "repos/$REPO/actions/runs/$run")" || return $?
  [ "$(jq -r '.head_repository.full_name // ""' <<<"$info")" = "$REPO" ] || { log "run $run is not from $REPO"; return 1; }
  case "$(jq -r '.event // ""' <<<"$info")" in
    push)
      default="$(ask "repos/$REPO" --jq .default_branch)" || return 2
      [ -n "$default" ] && [ "$(jq -r '.head_branch // ""' <<<"$info")" = "$default" ] || { log "run $run pushed another branch than $default"; return 1; }
      ;;
    pull_request)
      [ -n "$WRITER" ] || { log "run $run is a pull request, and no --build-cache-writer is set"; return 1; }
      [ "$(jq -r '.triggering_actor.login // ""' <<<"$info")" = "$WRITER" ] || { log "run $run was not started by $WRITER"; return 1; }
      pulls="$(jq -r '[.pull_requests[]?.number] | map(tostring) | join(" ")' <<<"$info")"
      [ -n "$pulls" ] || { log "run $run names no pull request"; return 1; }
      for number in $pulls; do
        case "$number" in ''|*[!0-9]*) return 1 ;; esac
        pull="$(ask "repos/$REPO/pulls/$number")" || return 2
        jq -e --arg writer "$WRITER" '.user.login == $writer' >/dev/null <<<"$pull" || { log "pull request $number of run $run is not $WRITER's"; return 1; }
        # the writer pushed again while this run's job ran: its next run on this slot is trusted
        jq -e --arg sha "$(jq -r '.head_sha // ""' <<<"$info")" '.head.sha == $sha' >/dev/null <<<"$pull" || { log "run $run is not at pull request $number's head"; return 4; }
      done
      ;;
    *) log "run $run is neither a push nor a pull request"; return 1 ;;
  esac
}

# A run's directory under entries/, made when it is not there: this user's own directory, never a
# link. Only this user writes entries/, so no job could have put one there; it is not followed all
# the same, since what it points at would be written, and evicted, as the cache is.
run_directory() {
  mkdir -m 0755 "$1" 2>/dev/null || true
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]
}

# Unpacks $1 (a tar of regular files and directories only) as the entry $2 of run $3, with the
# manifest readers check every file against. Fails, leaving nothing, on anything else.
admit() {
  local tar="$1" key="$2" dir="$ENTRIES/$3" staging types
  types="$(timeout 60 tar -tvf "$tar" | cut -c1 | sort -u | tr -d '\n')" || return 1
  case "$types" in ''|*[!d-]*) log "refused $key: the build holds something other than files and directories"; return 1 ;; esac
  # its own file of that name would be taken for the manifest
  if timeout 60 tar -tf "$tar" | grep -qxE '(\./)?\.manifest'; then log "refused $key: the build holds a .manifest of its own"; return 1; fi
  staging="$(mktemp -d "$ENTRIES/.new-XXXXXX")" || return 1
  if timeout 60 tar -xf "$tar" -C "$staging" --no-same-owner --no-same-permissions &&
    [ -z "$(find "$staging" -mindepth 1 ! -type f ! -type d -print -quit)" ] &&
    (cd "$staging" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$staging.manifest" &&
    [ ! -e "$staging/.manifest" ] && mv "$staging.manifest" "$staging/.manifest" &&
    chmod -R u+rwX,a+rX,go-w "$staging" &&
    run_directory "$dir" &&
    mv -T "$staging" "$dir/$key" 2>/dev/null; then
    return 0
  fi
  discard "$staging"
  rm -f "$staging.manifest"
  return 1
}

# Removes an entry or what is left of one. A build's directories keep the modes its job gave them,
# so one without the owner's write bit is given it first; and a removal that fails says so (unless
# $2 is "quietly") and ends no pass: every later slot's build is still judged.
discard() {
  chmod -R u+rwX "$1" 2>/dev/null || true
  rm -rf "$1" 2>/dev/null || [ "${2:-}" = quietly ] || log "could not remove $1"
}

# Every entry's path, one a line: entries/<run id>/<key>.
entries() {
  local dir entry
  for dir in "$ENTRIES"/*; do
    if [ ! -d "$dir" ] || [ -L "$dir" ] || ! [[ "${dir##*/}" =~ $RUN_ID ]]; then continue; fi
    for entry in "$dir"/*; do
      if [ -d "$entry" ] && [ ! -L "$entry" ]; then echo "$entry"; fi
    done
  done
}

# Whether some run's directory holds an entry for the key $1.
held() {
  local dir
  for dir in "$ENTRIES"/*; do
    if [[ "${dir##*/}" =~ $RUN_ID ]] && [ ! -L "$dir" ] && [ -d "$dir/$1" ]; then return 0; fi
  done
  return 1
}

# Keeps the most recently used entries within MAX_MB, whichever run they belong to.
evict() {
  local total=0 limit=$(( 10#$MAX_MB * 1024 * 1024 )) line size path used stamp dir
  # what an admission that was cut short, or an entry that could not be removed at once, left
  for path in "$ENTRIES"/.new-*; do
    if [ -L "$path" ]; then rm -f "$path"
    elif [ -n "$(find "$path" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then discard "$path"; fi
  done
  while read -r line; do
    path="${line#* }"
    size="$(du -sb "$path" | cut -f1)" || continue
    total=$((total + size))
    if [ "$total" -gt "$limit" ]; then discard "$path"; fi
  done < <(entries | while read -r path; do
    used="$(stat -c %Y "$path")"
    if [ -f "$USED/${path##*/}" ]; then stamp="$(stat -c %Y "$USED/${path##*/}")"; [ "$stamp" -gt "$used" ] && used="$stamp"; fi
    echo "$used $path"
  done | sort -rn)
  # a run whose entries are all gone leaves no directory behind, and a key no entry holds no stamp
  for dir in "$ENTRIES"/*; do
    if [[ "${dir##*/}" =~ $RUN_ID ]] && [ ! -L "$dir" ]; then rmdir "$dir" 2>/dev/null || true; fi
  done
  for stamp in "$USED"/*; do
    if [ -f "$stamp" ] && ! held "${stamp##*/}"; then rm -f "$stamp"; fi
  done
}

# The outboxes' files are moved into this host user's own directory before anything reads them, so
# the job cannot change them between a check and a read (a FIFO swapped in, say).
# Each claim gets a directory of its own there: what a job swapped in that this user cannot delete
# (a directory of the runners' user) stays behind for run.sh to remove, and blocks no later claim.
TAKEN="$OUTBOXES/.taken"
mkdir -p "$TAKEN" && chmod 0700 "$TAKEN"
take() { [ -f "$1" ] && [ ! -L "$1" ] && mv -T "$1" "$2" 2>/dev/null && [ -f "$2" ] && [ ! -L "$2" ]; }

# A refusal is remembered, so a job claiming again and again costs no GitHub calls (this user's token
# also registers the runners): its slot for ten minutes, whatever run the slot's next claims name, and,
# when GitHub said the run itself is not trusted, that run and attempt for a day. A claim naming a run
# with no job on its slot, or no run at all, marks only its slot (any slot can name any run); a stale
# run of the writer's pull request (pushed again meanwhile) only that run; an unanswered call nothing.
# An untrusted run's jobs never claim (build-cache.ts mayWrite), so one that does is abnormal, and a
# slot held off only builds without the cache.
REFUSED="$OUTBOXES/.refused"
mkdir -p "$REFUSED" && chmod 0700 "$REFUSED"
find "$REFUSED" -mindepth 1 -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null || true
refused_before() {
  [ -e "$REFUSED/run-$2-$3" ] || [ -n "$(find "$REFUSED" -maxdepth 1 -type f -name "slot-$1" -mmin -10 -print -quit 2>/dev/null)" ]
}

# What a launcher from before entries were kept per run filed by the key alone, entries/<key>, goes
# at once: a job of a commit from before still reads there, whichever run filed it, and would
# restore another run's build. From this launcher's first pass on, no run restores across runs.
# It is renamed first, to a name no job reads: that needs only entries/ itself, whoever owns what is
# inside, so an entry that cannot be removed is out of reach all the same and is not walked again
# every second (evict tries it again once it is over an hour old). One that cannot even be renamed
# is emptied where it is, and said once a day while it stays.
for path in "$ENTRIES"/*; do
  if [[ "${path##*/}" =~ ^[0-9a-f]{64}$ ]] && [ -d "$path" ] && [ ! -L "$path" ]; then
    if gone="$(mktemp -d "$ENTRIES/.new-gone-XXXXXX" 2>/dev/null)" && mv -T "$path" "$gone" 2>/dev/null; then discard "$gone"
    else
      rmdir "$gone" 2>/dev/null || true
      # entries/ itself cannot be written: what the entry holds goes all the same, its manifest with
      # it, so no job restores it; the empty directory that may stay costs nothing to pass over
      discard "$path" quietly
      if [ -e "$path" ] && [ ! -e "$REFUSED/stuck-${path##*/}" ]; then
        log "could not move $path away or remove it; emptied it as far as it goes"
        touch "$REFUSED/stuck-${path##*/}" 2>/dev/null || true
      fi
    fi
  fi
done

# The container that is the slot $1's now, as docker names it: its id and when it started, in
# milliseconds since the epoch. Nothing when the slot has none running, or when docker does not answer.
container() {
  local id running at started part=000
  read -r id running at < <(timeout 10 docker container inspect -f '{{.Id}} {{.State.Running}} {{.State.StartedAt}}' "$1" 2>/dev/null) || return 0
  [ "$running" = true ] || return 0
  started="$(jq -rn --arg at "$at" '$at | sub("\\.[0-9]+"; "") | fromdateiso8601' 2>/dev/null)" || return 0
  if [[ "$at" =~ \.([0-9]+)Z$ ]]; then part="${BASH_REMATCH[1]}000"; fi
  if [[ "$started" =~ ^[0-9]+$ ]]; then echo "$id $(( started * 1000 + 10#${part:0:3} ))"; fi
  return 0
}

# When the file $1 was last changed, in milliseconds since the epoch: the time the system keeps of
# its own, which whoever wrote the file cannot set back. Removing another name of the file (a hard
# link) sets it to now, so it is read before anything in the outbox is removed, and a file that has
# a second name is not taken at all. 0 when there is no such file.
changed() {
  local at
  at="$(LC_ALL=C stat -c %.3Z "$1" 2>/dev/null)" || at=0
  at="${at/./}"
  if [[ "$at" =~ ^[0-9]+$ ]]; then echo "$at"; else echo 0; fi
}

promoted=0
for name in "$@"; do
  outbox="$OUTBOXES/$name"
  [ -d "$outbox" ] || continue
  # One claim per outbox per pass (a job builds one commit): each costs GitHub calls on this user's
  # token, which also registers the runners, so the rest are deleted unread.
  judged=0
  for claim in "$outbox"/*.claim; do
    [ -e "$claim" ] || [ -L "$claim" ] || continue
    file="${claim##*/}" key="${file%.claim}" tar="$outbox/${file%.claim}.tar"
    run="" attempt=""
    if [ "$judged" = 1 ]; then
      rm -rf "$claim" "$tar" 2>/dev/null || true
      if [[ "$key" =~ ^[0-9a-f]{64}$ ]]; then mkdir "$outbox/judged-$key" 2>/dev/null || true; fi
      continue
    fi
    judged=1
    # Read before the claim is taken. What is in the outbox while this container is the slot's, its
    # job wrote: run.sh empties the outbox before it starts the slot's next container, and a claim or
    # a build last changed before this container started is an earlier job's all the same (their
    # times are read here, since taking a file changes its own).
    wrote="$(container "$name")"
    left=0
    if [ -n "$wrote" ] && { [ "$(changed "$claim")" -lt "${wrote#* }" ] || [ "$(changed "$tar")" -lt "${wrote#* }" ]; }; then left=1; fi
    work="$(mktemp -d "$TAKEN/XXXXXX")" || continue
    # only plain files, and small claims: a link could make this host user read or keep a file of its own.
    # And files with one name each: a job leaves no second name, and one would let a file's time be moved.
    if [[ "$key" =~ ^[0-9a-f]{64}$ ]] && take "$tar" "$work/build.tar" && take "$claim" "$work/claim" &&
      [ "$(stat -c %s "$work/claim")" -le 64 ] &&
      [ "$(stat -c %h "$work/claim")" = 1 ] && [ "$(stat -c %h "$work/build.tar")" = 1 ]; then
      read -r run attempt < "$work/claim" || true
    fi
    if [[ "$run" =~ $RUN_ID && "$attempt" =~ ^[0-9]{1,5}$ ]] && [ ! -e "$ENTRIES/$run/$key" ] &&
      [ "$(stat -c %s "$work/build.tar")" -le $(( 10#$MAX_MB * 1024 * 1024 )) ]; then
      if [ -z "$wrote" ]; then
        log "refused $key from $name: the slot has no container now, so GitHub cannot say whose build it is"
      elif [ "$left" = 1 ]; then
        log "refused $key from $name: it was written before the slot's container started, by an earlier job"
      elif refused_before "$name" "$run" "$attempt"; then
        log "refused $key from $name: run $run or this slot was refused before"
      else
        verdict=0
        trusted "$name" "$run" "$attempt" "$(( ${wrote#* } / 1000 ))" || verdict=$?
        # GitHub answered for the job the slot runs now: that is the claim's only while the container is the same
        if [ "$verdict" = 0 ] && [ "$(container "$name")" != "$wrote" ]; then verdict=5; fi
        case "$verdict" in
          0) if admit "$work/build.tar" "$key" "$run"; then log "cached $key from $name (run $run)"; promoted=1; fi ;;
          1) touch "$REFUSED/run-$run-$attempt" "$REFUSED/slot-$name" 2>/dev/null || true ;;
          3) touch "$REFUSED/slot-$name" 2>/dev/null || true ;;
          4) touch "$REFUSED/run-$run-$attempt" 2>/dev/null || true ;;
          5) log "refused $key from $name: the container that built it is no longer the slot's" ;;
          *) log "refused $key from $name: GitHub did not answer about run $run" ;;
        esac
      fi
    fi
    # whatever it is (a directory named like a claim included): it must not stop the other slots
    rm -rf "$claim" "$tar" "$work" 2>/dev/null || true
    # Only now, the entry in place or the build refused: the job that built it may let the others go.
    # A directory, which mkdir never makes through a link the job could have put at that name.
    if [[ "$key" =~ ^[0-9a-f]{64}$ ]]; then mkdir "$outbox/judged-$key" 2>/dev/null || true; fi
  done
  # After the claims, whose times are read above: a marker can be another name of a claim or of a
  # build (a hard link), and removing it changes that file's time.
  for used in "$outbox"/used-*; do
    [ -e "$used" ] || [ -L "$used" ] || continue
    key="${used##*/used-}"
    # The marker names a key, not the run whose entry was restored, and GitHub is not asked about
    # it: the key counts as used in every run that holds it. A stamp only moves eviction, so a job
    # naming keys it never restored keeps their entries longer, as it always could, and no more.
    if [[ "$key" =~ ^[0-9a-f]{64}$ ]] && held "$key"; then mkdir -p "$USED" && touch "$USED/$key"; fi
    rm -rf "$used" 2>/dev/null || true
  done
done
if [ "$promoted" = 1 ]; then evict; fi
