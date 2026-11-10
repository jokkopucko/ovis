#!/usr/bin/env bash
# Host launcher: keeps N ephemeral runner containers alive, one job per container.
#
# Usage: scripts/self-hosted-runner/run.sh [--repo OWNER/NAME] [--count N] [--labels self-hosted-ovis]
#          [--reserved N] [--reserved-labels self-hosted-ovis-main] [--env-file FILE] [--build] [--once]
#          [--cache-dir DIR [--cache-wait SECONDS] | --no-cache] [--build-cache DIR [--build-cache-mb N] [--build-cache-writer LOGIN]]
#          [--cpuset-cpus LIST]
#          [--work-tmpfs SIZE]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="herdr-ci-runner:local"

REPO=""
COUNT=1
LABELS="self-hosted-ovis"
RESERVED=0
RESERVED_LABELS="self-hosted-ovis-main"
ENV_FILE=""
BUILD=0
ONCE=0
CACHE=1
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ovis-ci-runner"
CACHE_WAIT=120
BUILD_CACHE=""
BUILD_CACHE_MB=2048
BUILD_CACHE_WRITER=""
# docker run's --cpuset-cpus for every container this launcher starts (README "Per-host limits")
CPUSET_ARGS=()
WORK_TMPFS=""

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --count) COUNT="${2:?--count needs a value}"; shift 2 ;;
    --labels) LABELS="${2:?--labels needs a value}"; shift 2 ;;
    --reserved) RESERVED="${2:?--reserved needs a value}"; shift 2 ;;
    --reserved-labels) RESERVED_LABELS="${2:?--reserved-labels needs a value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --once) ONCE=1; shift ;;
    --cache-dir) CACHE_DIR="${2:?--cache-dir needs a value}"; shift 2 ;;
    --cache-wait) CACHE_WAIT="${2:?--cache-wait needs a value}"; shift 2 ;;
    --no-cache) CACHE=0; shift ;;
    --build-cache) BUILD_CACHE="${2:?--build-cache needs a value}"; shift 2 ;;
    --build-cache-mb) BUILD_CACHE_MB="${2:?--build-cache-mb needs a value}"; shift 2 ;;
    --build-cache-writer) BUILD_CACHE_WRITER="${2:?--build-cache-writer needs a value}"; shift 2 ;;
    --cpuset-cpus) CPUSET_ARGS=(--cpuset-cpus "${2:?--cpuset-cpus needs a value}"); shift 2 ;;
    --work-tmpfs) WORK_TMPFS="${2:?--work-tmpfs needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$COUNT" in ''|*[!0-9]*|0) echo "--count must be a positive integer" >&2; exit 2 ;; esac
# The first --reserved slots of --count register with --reserved-labels instead of --labels, so jobs
# that ask for those labels (ci.yml's pushes to main, CI_MAIN_SELF_HOSTED_LABELS) find a runner that
# pull request jobs never take. They stay in this launcher's network namespace: same check.ts slots.
# at most four digits: a longer number could wrap around in shell arithmetic and pass as a small one
case "$RESERVED" in ''|*[!0-9]*|?????*) echo "--reserved must be a whole number up to --count" >&2; exit 2 ;; esac
if [ "$((10#$RESERVED))" -gt "$((10#$COUNT))" ]; then echo "--reserved must not exceed --count" >&2; exit 2; fi
case "$CACHE_WAIT" in ''|*[!0-9]*|?????*) echo "--cache-wait must be a whole number of seconds" >&2; exit 2 ;; esac
# 00 is zero too: past the digit check, as a number
case "$BUILD_CACHE_MB" in ''|*[!0-9]*|??????*) echo "--build-cache-mb must be a positive whole number of MiB" >&2; exit 2 ;; esac
if [ "$((10#$BUILD_CACHE_MB))" -eq 0 ]; then echo "--build-cache-mb must be a positive whole number of MiB" >&2; exit 2; fi
# a GitHub login: letters, digits and single hyphens
case "$BUILD_CACHE_WRITER" in *[!A-Za-z0-9-]*|-*|??????????????????????????????????????*) echo "--build-cache-writer must be a GitHub login" >&2; exit 2 ;; esac
# The job's checkout (/w) and /tmp in RAM: a job's files die with its container anyway, and on disk
# its browser profiles and installs are most of the host's writes. SIZE caps each mount; only what
# a job writes takes memory.
WORK_TMPFS_ARGS=()
if [ -n "$WORK_TMPFS" ]; then
  case "$WORK_TMPFS" in [1-9]*[mg]) ;; *) echo "--work-tmpfs must be a size like 4g or 4096m" >&2; exit 2 ;; esac
  case "${WORK_TMPFS%?}" in *[!0-9]*|??????*) echo "--work-tmpfs must be a size like 4g or 4096m" >&2; exit 2 ;; esac
  WORK_TMPFS_ARGS=(--tmpfs "/w:rw,exec,nosuid,size=$WORK_TMPFS,uid=1001,gid=1001,mode=0755"
    --tmpfs "/tmp:rw,exec,nosuid,size=$WORK_TMPFS,mode=1777")
fi
# What this host can take (CHECK_HOST_* in scripts/check.ts), for every runner container: read now,
# so a missing file stops the launcher instead of every container failing to start.
ENV_ARGS=()
if [ -n "$ENV_FILE" ]; then
  # a path starting with - (even "-" itself, which grep reads as stdin after --) is the file of that name
  case "$ENV_FILE" in -*) ENV_FILE="./$ENV_FILE" ;; esac
  [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || { echo "--env-file: cannot read $ENV_FILE" >&2; exit 2; }
  # Only CHECK_HOST_* numbers: docker copies a bare NAME line from this launcher's own environment
  # (GH_TOKEN, say) into every container, where any job could read it. A refused line is named by its
  # number only: its value may be a credential, and stderr ends up in the journal.
  status=0
  # -a: a NUL byte would make grep call the file binary and name no line; -- : a path may start with -
  bad="$(grep -anvE -e '^[[:space:]]*(#.*)?$|^CHECK_HOST_(MAX_RUNS|TEST_SHARDS|BROWSER_WORKERS|UNIT_WORKERS)=[0-9]+$' -- "$ENV_FILE")" || status=$?
  case "$status" in
    0) echo "--env-file: $ENV_FILE may hold only CHECK_HOST_*=<number> lines; refused line(s): $(printf '%s\n' "$bad" | cut -d: -f1 | paste -sd, -)" >&2
       exit 2 ;;
    1) ;; # every line is allowed
    *) echo "--env-file: could not read $ENV_FILE to check it" >&2; exit 2 ;;
  esac
  ENV_ARGS=(--env-file "$ENV_FILE")
fi

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
HOST="$(hostname -s)"
PREFIX="herdr-ci-${HOST}-"
# Every runner joins this container's network namespace, so the runners of this PC share one
# loopback: scripts/check.ts's slots (listening loopback ports) then bound the herdr-backed lanes
# of all of them together, as they bound the runs of one PC. Not the host's network: a job still
# cannot reach the host's own loopback services.
NETNS="${PREFIX}net"

if [ "$BUILD" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$SCRIPT_DIR"
fi
# A CPU list docker cannot give fails every container, and every slot would then ask for a token every
# few seconds: refuse it now, with one throwaway container, before anything starts.
if [ "${#CPUSET_ARGS[@]}" -gt 0 ] && ! docker run --rm "${CPUSET_ARGS[@]}" --network none --entrypoint true "$IMAGE" >/dev/null 2>&1; then
  echo "--cpuset-cpus ${CPUSET_ARGS[1]}: docker cannot run a container on those CPUs" >&2
  exit 2
fi

# Host caches (README "Host caches"): a bare mirror of the repository's branches and tags, and Bun's
# install cache for the default branch's bun.lock. Only this launcher writes them: the mirror from
# GitHub, the Bun cache from the downloads Bun checks against that lockfile. Every runner container
# gets them read-only at /cache, so no job can change what a later one checks out or installs.
MIRROR=""
BUN_CACHES=""
REPO_CACHE=""
CACHE_CONTAINER="${PREFIX}cache"
# Each repository has its own caches: a launcher moved to another --repo never hands its runners the
# old one's packages. GitHub's names never hold a slash or start with a dot.
case "$REPO" in
  .*|*/.*|*/*/*|*[!A-Za-z0-9._/-]*|*/|/*) [ "$CACHE" = 1 ] && echo "[cache] $REPO is not an OWNER/NAME this launcher can keep caches for: running without them" >&2; CACHE=0 ;;
  */*) ;;
  *) [ "$CACHE" = 1 ] && echo "[cache] $REPO is not an OWNER/NAME this launcher can keep caches for: running without them" >&2; CACHE=0 ;;
esac
if [ "$CACHE" = 1 ]; then
  # an unusable cache directory costs downloads, never the runners
  if REPO_CACHE="$(umask 022 && mkdir -p "$CACHE_DIR/$REPO" && cd "$CACHE_DIR/$REPO" && pwd -P)"; then
    MIRROR="$REPO_CACHE/git/repo.git"
    BUN_CACHES="$REPO_CACHE/bun"
  else
    echo "[cache] cannot use $CACHE_DIR/$REPO: running without host caches" >&2
    CACHE=0
  fi
fi
# The client build cache (README "Build cache"): the jobs of a run after the first restore its
# dist/ instead of building it (scripts/build-cache.ts). Runners read it only; a job's build goes to its
# slot's own outbox, and this launcher moves it in (build-cache-promote.sh) only for a trusted run,
# under that run (entries/<run id>/<key>), where only that run's jobs read.
BUILD_CACHE_ROOT=""
BUILD_CACHE_OUTBOXES=""
# which job of a run builds it: a volume of its own in RAM, capped, so a job filling it fills nothing else
BUILD_CACHE_LOCKS="${PREFIX}build-cache-locks"
if [ -n "$BUILD_CACHE" ]; then
  case "$REPO" in
    .*|*/.*|*/*/*|*[!A-Za-z0-9._/-]*|*/|/*) echo "[build-cache] $REPO is not an OWNER/NAME: running without it" >&2 ;;
    */*)
      # The cache (entries/, used/) only this user writes. Each slot's outbox the runners' user writes too:
      # on disk, not in RAM, as the job's own workspace is, so a job filling it costs what that already can.
      outboxes="${XDG_STATE_HOME:-$HOME/.local/state}/ovis-ci-runner/build-outbox/$REPO"
      if BUILD_CACHE_ROOT="$(umask 022 && mkdir -p "$BUILD_CACHE/$REPO/entries" "$BUILD_CACHE/$REPO/used" && cd "$BUILD_CACHE/$REPO" && pwd -P)" &&
        BUILD_CACHE_OUTBOXES="$(umask 022 && mkdir -p "$outboxes" && cd "$outboxes" && pwd -P)" &&
        docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=16m,mode=1777 "$BUILD_CACHE_LOCKS" >/dev/null; then
        :
      else
        echo "[build-cache] cannot use $BUILD_CACHE/$REPO, its outboxes or the $BUILD_CACHE_LOCKS volume: running without it" >&2
        BUILD_CACHE_ROOT=""
      fi ;;
    *) echo "[build-cache] $REPO is not an OWNER/NAME: running without it" >&2 ;;
  esac
fi

# Set when each runner starts: its slot's outbox, emptied of what an earlier job left. Emptied
# before the slot's next container exists: the promoter takes what is in the outbox while a
# container is the slot's for that container's job's (build-cache-promote.sh).
build_cache_args() {
  local outbox="$BUILD_CACHE_OUTBOXES/$1"
  BUILD_CACHE_ARGS=()
  [ -n "$BUILD_CACHE_ROOT" ] || return 0
  # a file the runners' user made in it is this user's to delete (sticky directory); a directory's contents
  # are that user's only, so a throwaway container of the image, as that user, empties what is left
  if [ -d "$outbox" ]; then
    find "$outbox" -mindepth 1 -maxdepth 1 ! -type d -delete 2>/dev/null || true
    # the promoter's own verdicts (build-cache-promote.sh)
    find "$outbox" -mindepth 1 -maxdepth 1 -type d -name 'judged-*' -user "$(id -u)" -empty -delete 2>/dev/null || true
    if [ -n "$(find "$outbox" -mindepth 1 -print -quit 2>/dev/null)" ]; then
      docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm --network none --security-opt no-new-privileges --cap-drop ALL --user 1001:1001 \
        -v "$outbox:/outbox" --entrypoint sh "$IMAGE" -c 'chmod -R u+rwX /outbox 2>/dev/null; find /outbox -mindepth 1 -delete' </dev/null >/dev/null 2>&1 || true
    fi
    # A file that is still there would be read as this runner's own claim or build: the runner starts
    # without the build cache, and its job builds. (A directory is no claim to the promoter, which
    # also refuses a file older than the runner's container.)
    if [ -n "$(find "$outbox" -mindepth 1 -maxdepth 1 ! -type d -print -quit 2>/dev/null)" ]; then
      echo "[$1] its build cache outbox could not be emptied: starting it without the build cache" >&2
      return 0
    fi
  fi
  mkdir -p "$outbox" && chmod 1777 "$outbox" || return 0
  BUILD_CACHE_ARGS=(-v "$BUILD_CACHE_ROOT/entries:/build-cache:ro" -v "$BUILD_CACHE_LOCKS:/build-cache-locks"
    -v "$outbox:/build-cache-outbox" -e OVIS_BUILD_CACHE_DIR=/build-cache -e OVIS_BUILD_CACHE_LOCKS=/build-cache-locks
    -e OVIS_BUILD_CACHE_OUTBOX=/build-cache-outbox ${BUILD_CACHE_WRITER:+-e "OVIS_BUILD_CACHE_WRITER=$BUILD_CACHE_WRITER"})
}

# What the promoter could not delete (a directory of the runners' user that a job swapped in): a
# throwaway container of the image, no network, allowed only past file permissions, removes it.
clean_taken() {
  [ -n "$(find "$BUILD_CACHE_OUTBOXES/.taken" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] || return 0
  docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm --network none --security-opt no-new-privileges --cap-drop ALL --cap-add DAC_OVERRIDE --user 0:0 \
    -v "$BUILD_CACHE_OUTBOXES/.taken:/taken" --entrypoint find "$IMAGE" /taken -mindepth 1 -delete </dev/null >/dev/null 2>&1 || true
}

# Every second: the trusted builds in the outboxes go into the cache. In its own process group, which cleanup stops.
promote_loop() {
  trap 'exit 143' TERM
  local names=() slot
  for slot in $(seq 1 "$COUNT"); do names+=("${PREFIX}${slot}"); done
  while true; do
    bash "$SCRIPT_DIR/build-cache-promote.sh" "$REPO" "$BUILD_CACHE_ROOT" "$BUILD_CACHE_OUTBOXES" "$BUILD_CACHE_WRITER" "$((10#$BUILD_CACHE_MB))" "${names[@]}" || true
    clean_taken
    # with --once too: until cleanup stops it, after the slots' containers end
    sleep 1
  done
}

# The cache loop runs in its own process: files here tell the launcher it warmed the caches, and it
# that the launcher is stopping. Made with the EXIT trap that removes it.
STATE_DIR=""
# Git over a saturated or stalled link: give up on a transfer slower than 1 KB/s for a minute, and on
# any command after its deadline, rather than hold every refresh (and, at start, every runner).
# timeout without --foreground runs git in a process group of its own and signals all of it at the
# deadline, transport helpers included. That group is outside the cache loop's, which cleanup stops:
# the trap passes the stop on, then waits for timeout, which kills a git that ignores it 5 s later,
# and kills what is left of the group, so the launcher outlives every part of it. A signal is handled between commands, so once `&` has started
# timeout, $! names it: before its setpgid the process itself, after it the whole group.
# A subshell, so its trap never replaces the caller's.
git_net() (
  limit="$1" status=0; shift
  # a no-op job first, so a stop before timeout starts never signals an older job's reused pid
  : &
  # every step may fail (set -e applies inside a trap too): wait reports timeout's status
  trap 'kill -TERM "$!" 2>/dev/null || true; kill -TERM -- "-$!" 2>/dev/null || true; wait "$!" || true
    kill -KILL -- "-$!" 2>/dev/null || true; exit 143' TERM
  GIT_TERMINAL_PROMPT=0 timeout -k 5 "$limit" \
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 "$@" &
  wait "$!" || status=$?
  # timeout ends with git; a transport helper that ignored the signal is still in its group
  kill -KILL -- "-$!" 2>/dev/null || true
  exit "$status"
)

# Sets DEFAULT_REF to the default branch GitHub names on this refresh, once the mirror holds it; it
# stays empty (and this fails) when GitHub's answer is missing, so no other branch is ever taken.
refresh_mirror() {
  local tmp head dir url="https://github.com/$REPO.git"
  DEFAULT_REF=""
  # a mirror of anything else (set up by hand, say) is not this repository's: start again
  if [ -d "$MIRROR/objects" ] && [ "$(git -C "$MIRROR" config remote.origin.url)" != "$url" ]; then
    echo "[cache] $MIRROR does not mirror $url: setting it up again" >&2
    rm -rf "$MIRROR" || return 1
  fi
  for dir in "$REPO_CACHE"/git/.new-*; do
    if [ -d "$dir" ] && [ -n "$(find "$dir" -maxdepth 0 -mmin +60)" ]; then rm -rf "$dir"; fi
  done
  if [ ! -d "$MIRROR/objects" ]; then
    # set up under another name, so a half-configured mirror never takes the real one's
    mkdir -p "$REPO_CACHE/git" && tmp="$(mktemp -d "$REPO_CACHE/git/.new-XXXXXX")" || return 1
    # gc.pruneExpire never: a job reads objects from the mirror without copying them, so an object
    # of a deleted or force-pushed branch must stay while a job may still need it
    if ! { git -c init.defaultBranch=main init -q --bare "$tmp" &&
      git -C "$tmp" config remote.origin.url "$url" &&
      git -C "$tmp" config remote.origin.fetch '+refs/heads/*:refs/heads/*' &&
      git -C "$tmp" config --add remote.origin.fetch '+refs/tags/*:refs/tags/*' &&
      git -C "$tmp" config gc.pruneExpire never &&
      git -C "$tmp" config gc.auto 0 &&
      git -C "$tmp" config maintenance.auto false &&
      git -C "$tmp" config fetch.unpackLimit 1 &&
      chmod 0755 "$tmp" && mv -T "$tmp" "$MIRROR"; }; then
      rm -rf "$tmp"
      [ -d "$MIRROR/objects" ] || return 1
    fi
  fi
  # no pull request refs: only this repository's own branches and tags
  git_net 900 -C "$MIRROR" fetch --quiet --prune --no-write-fetch-head origin || return 1
  # The default branch, whose bun.lock alone the Bun cache follows: asked of GitHub every time, never
  # taken from the mirror's own HEAD (a new mirror's names main, whatever the repository's is).
  # Into a file, not a pipe: git_net runs right under this shell, which a stop then waits for.
  git_net 120 -C "$MIRROR" ls-remote --symref origin HEAD > "$STATE_DIR/default-branch" || return 1
  head="$(sed -n 's|^ref: \(refs/heads/[^[:space:]]*\)[[:space:]]*HEAD$|\1|p' "$STATE_DIR/default-branch")"
  case "$head" in refs/heads/?*) ;; *) return 1 ;; esac
  git -C "$MIRROR" rev-parse --verify -q "$head^{commit}" >/dev/null || return 1
  if [ "$(git -C "$MIRROR" symbolic-ref -q HEAD)" != "$head" ]; then
    git -C "$MIRROR" symbolic-ref HEAD "$head" || return 1
  fi
  # With automatic maintenance off, every fetch adds a pack (fetch.unpackLimit 1): join them now and
  # then, keeping every object (--keep-unreachable), so none a job still reads goes away.
  if [ "$(find "$MIRROR/objects/pack" -name '*.pack' | wc -l)" -gt 50 ]; then
    git -C "$MIRROR" repack -q -a -d --keep-unreachable || return 1
  fi
  DEFAULT_REF="$head"
}

# One directory per bun.lock (named after its blob), and `current` pointing at the default branch's
# (DEFAULT_REF, which refresh_mirror has just confirmed).
refresh_bun_cache() {
  local lock commit version tmp failed old dir status
  [ -n "$DEFAULT_REF" ] || return 1
  lock="$(git -C "$MIRROR" rev-parse --verify -q "$DEFAULT_REF:bun.lock")" || return 0
  commit="$(git -C "$MIRROR" rev-parse --verify -q "$DEFAULT_REF^{commit}")" || return 1
  version="$BUN_CACHES/$lock"
  failed="$BUN_CACHES/.failed-$lock"
  mkdir -p "$BUN_CACHES" || return 1
  if [ ! -d "$version" ]; then
    # a build that failed is retried after 30 minutes, not every refresh: each try downloads it all
    [ -n "$(find "$failed" -mmin -30 2>/dev/null)" ] && return 1
    tmp="$(mktemp -d "$BUN_CACHES/.new-XXXXXX")" || return 1
    docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
    # The runner's hardening, the host user's files, no package scripts, and only what the lockfile
    # pins: --frozen-lockfile refuses to resolve anything else and Bun checks every download's
    # integrity against it. Not in the runners' network namespace: their check.ts slots are theirs.
    # --foreground keeps it in this process group, which the launcher's exit stops whole; --init gives
    # the container a PID 1 that passes the deadline's SIGTERM on (a bare PID 1 ignores it), and -k
    # ends the client if it still waits. Whatever ended it, docker rm -f below ends the container.
    status=0
    timeout --foreground -k 5 900 docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm --init \
      --name "$CACHE_CONTAINER" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --pids-limit 8192 \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp \
      -e BUN_INSTALL_CACHE_DIR=/cache/bun \
      -e COMMIT="$commit" \
      -v "$MIRROR:/cache/git/repo.git:ro" \
      -v "$tmp:/cache/bun" \
      --entrypoint bash \
      "$IMAGE" -c 'set -e
        git clone -q --shared --no-checkout /cache/git/repo.git /tmp/src
        cd /tmp/src
        git checkout -q --detach "$COMMIT"
        bun install --frozen-lockfile --ignore-scripts' </dev/null >/dev/null || status=$?
    if [ "$status" != 0 ]; then
      docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
      rm -rf "$tmp"
      # Every failure waits 30 minutes (a crash or the OOM killer as well): only the launcher's own
      # stop is no reason to wait before the next start's build.
      if [ ! -e "$STATE_DIR/stopping" ]; then touch "$failed"; fi
      return 1
    fi
    rm -f "$failed"
    # mktemp's 0700, or a package's own modes, would keep the runner's own user out
    chmod -R a+rX "$tmp"
    # another launcher may have finished the same lockfile first
    mv -T "$tmp" "$version" 2>/dev/null || rm -rf "$tmp"
  fi
  old="$(readlink "$BUN_CACHES/current" 2>/dev/null || true)"
  if [ "$old" != "$lock" ]; then
    # its mtime now says when it was replaced
    if [ -n "$old" ] && [ -d "$BUN_CACHES/$old" ]; then touch "$BUN_CACHES/$old"; fi
    ln -sfn "$lock" "$BUN_CACHES/.current-new" && mv -T "$BUN_CACHES/.current-new" "$BUN_CACHES/current"
  fi
  # A replaced version stays an hour, so a job copying it when it was replaced finishes first.
  for dir in "$BUN_CACHES"/* "$BUN_CACHES"/.new-*; do
    [ -d "$dir" ] && [ ! -L "$dir" ] && [ "${dir##*/}" != "$lock" ] || continue
    if [ -n "$(find "$dir" -maxdepth 0 -mmin +60)" ]; then rm -rf "$dir"; fi
  done
  find "$BUN_CACHES" -maxdepth 1 -name '.failed-*' -mmin +60 -delete 2>/dev/null || true
}

# git and Docker write with the umask: the runner containers read the caches as another user.
# The Bun cache is built only after this refresh confirmed the default branch: never from a stale or
# initial HEAD. On a stop, the trap waits for the command running now (bash runs it after that
# command ends), so the launcher's own wait outlives every git and docker client of the refresh.
refresh_caches() (
  umask 022
  trap 'exit 143' TERM
  if ! refresh_mirror; then
    echo "[cache] could not refresh the git mirror $MIRROR from github.com/$REPO, or GitHub named no default branch it holds" >&2
  elif ! refresh_bun_cache; then
    echo "[cache] could not build the Bun cache in $BUN_CACHES for the default branch's bun.lock" >&2
  fi
  return 0
)

# The first refresh says when it is done, so runners can start with warm caches; then one a minute.
cache_loop() {
  trap 'exit 143' TERM
  refresh_caches
  : > "$STATE_DIR/warm"
  [ "$ONCE" = 1 ] && return 0
  while true; do
    # a schedule, not a wait: one small fetch a minute keeps the mirror near GitHub
    sleep 60
    refresh_caches
  done
}

# Set when each runner starts, so a cache that appeared since is used.
cache_args() {
  CACHE_ARGS=()
  [ "$CACHE" = 1 ] || return 0
  CACHE_ARGS=(-v "$REPO_CACHE:/cache:ro")
  # actions/checkout and every other git command of the job read objects from the mirror first and
  # fetch only what it lacks; an object is named by its hash, so the head checked out is the same
  if [ -d "$MIRROR/objects" ]; then
    CACHE_ARGS+=(-e GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/git/repo.git/objects)
  fi
}

start_netns() {
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$NETNS" 2>/dev/null || true)"
  [ "$running" = true ] && return
  # only a stopped one is in the way; a missing one leaves nothing to remove
  if [ "$running" = false ]; then docker rm "$NETNS" >/dev/null 2>&1 || true; fi
  docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} -d --rm \
    --name "$NETNS" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --entrypoint sleep \
    "$IMAGE" infinity >/dev/null ||
    # two slot loops restarting it at once: the other one's start wins, and a runner that still
    # finds no namespace fails to start, and its loop tries again
    echo "[$NETNS] could not start the shared network namespace container" >&2
}

slot_loop() {
  local slot="$1" name token container_status running labels="$LABELS"
  name="${PREFIX}${slot}"
  if [ "$slot" -le "$((10#$RESERVED))" ]; then labels="$RESERVED_LABELS"; fi
  delay=30
  while true; do
    # A container of this slot that an earlier launcher started may still run its job: a new one would
    # register the same runner name (--replace) and take that job's registration, so wait for it to end.
    # One that is not running (created, or stopped without --rm's removal) would hold the name forever.
    while running="$(docker container inspect -f '{{.State.Running}}' "$name" 2>/dev/null)"; do
      [ "$running" = true ] && { sleep 5; continue; }
      echo "[$name] removing a container left in this slot's name that is not running" >&2
      docker rm -f "$name" >/dev/null 2>&1 || true
      break
    done
    if ! token="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)"; then
      echo "[$name] could not fetch a registration token; retrying in ${delay}s" >&2
      [ "$ONCE" = 1 ] && return 1
      sleep "$delay"
      # every slot asks, and GitHub limits these POSTs per hour: a fixed 30 s keeps the account
      # over that limit for as long as it lasts, so back off to 10 minutes
      delay=$(( delay * 2 > 600 ? 600 : delay * 2 ))
      continue
    fi
    delay=30
    # No docker socket, no host mount but the read-only caches, no privileges. tini is already the entrypoint.
    # No core dumps: with the host's relative core_pattern ("core") a crash writes one into the
    # checkout, which scripts/check.ts then counts as a source change of the run.
    # The token goes in on stdin (entrypoint.sh), so it is never in the container's environment.
    # a runner started after the namespace container went away would have no network
    start_netns
    cache_args
    build_cache_args "$name"
    if printf '%s\n' "$token" | docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm -i \
      --name "$name" \
      --network "container:$NETNS" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --pids-limit 8192 \
      --shm-size 2g \
      --ulimit core=0 \
      -e RUNNER_URL="https://github.com/$REPO" \
      -e RUNNER_NAME="$name" \
      -e RUNNER_LABELS="$labels" \
      ${CACHE_ARGS[@]+"${CACHE_ARGS[@]}"} \
      ${BUILD_CACHE_ARGS[@]+"${BUILD_CACHE_ARGS[@]}"} \
      ${WORK_TMPFS_ARGS[@]+"${WORK_TMPFS_ARGS[@]}"} \
      ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
      "$IMAGE"; then
      container_status=0
    else
      container_status=$?
      echo "[$name] container exited with status $container_status" >&2
    fi
    token=""
    [ "$ONCE" = 1 ] && return "$container_status"
    sleep 2
  done
}

PIDS=()
CACHE_PID=""
PROMOTE_PID=""
cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  trap '' INT TERM
  echo "stopping runner slots..." >&2
  # the whole refresh, git and the Bun cache build included: none may outlive the launcher
  if [ -n "$STATE_DIR" ]; then : > "$STATE_DIR/stopping"; fi
  if [ -n "$CACHE_PID" ]; then kill -TERM -- "-$CACHE_PID" 2>/dev/null || true; fi
  if [ -n "$PROMOTE_PID" ]; then kill -TERM -- "-$PROMOTE_PID" 2>/dev/null || true; fi
  docker stop -t 5 "$CACHE_CONTAINER" >/dev/null 2>&1 || true
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for slot in $(seq 1 "$COUNT"); do
    docker stop -t 30 "${PREFIX}${slot}" >/dev/null 2>&1 || true
  done
  # the runners, and the cache loop with every git and docker client it started
  wait 2>/dev/null || true
  # a build client killed while its container still ran left the container behind
  docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
  docker stop -t 5 "$NETNS" >/dev/null 2>&1 || true
  # Remove any runner of this host that is still registered.
  ids="$(gh api "repos/$REPO/actions/runners" --paginate \
    --jq ".runners[] | select(.name | startswith(\"$PREFIX\")) | .id" 2>/dev/null || true)"
  for id in $ids; do
    gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null 2>&1 || true
  done
  if [ -n "$STATE_DIR" ]; then rm -rf "$STATE_DIR"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$CACHE" = 1 ]; then
  STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ovis-ci-runner.XXXXXX")"
  # in a process group of its own (job control on for this one start), so cleanup stops it whole
  set -m
  cache_loop &
  CACHE_PID="$!"
  set +m
  # The first runners wait for warm caches, up to --cache-wait: a refresh that hangs or fails costs
  # downloads, never the runners. Short naps, so a stop signal is handled at once.
  deadline=$((SECONDS + 10#$CACHE_WAIT))
  while [ ! -e "$STATE_DIR/warm" ] && kill -0 "$CACHE_PID" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.1
  done
  if [ ! -e "$STATE_DIR/warm" ]; then
    echo "[cache] the caches are not ready after ${CACHE_WAIT}s: starting the runners without waiting for them" >&2
  fi
fi

if [ -n "$BUILD_CACHE_ROOT" ]; then
  # what an earlier launcher's promoter left
  clean_taken
  set -m
  promote_loop &
  PROMOTE_PID="$!"
  set +m
fi

start_netns
for slot in $(seq 1 "$COUNT"); do
  slot_loop "$slot" &
  PIDS+=("$!")
done

if [ "$ONCE" = 1 ]; then
  rc=0
  for pid in "${PIDS[@]}"; do
    wait "$pid" || rc=$?
  done
  exit "$rc"
fi

# Slot loops run until a signal arrives; `wait` is interrupted by the traps.
wait
