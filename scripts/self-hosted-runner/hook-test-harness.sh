#!/usr/bin/env bash
# Test harness of job-started.sh (scripts/self-hosted-runner.test.ts): the only place a test starts the hook,
# which may kill, and only after one of two guards has passed: before that it starts no hook and no parent of one
# (the container guard runs stat and readlink, and its orphan check one bash that reads a FIFO).
#   namespace: PID 1 of a PID namespace of its own, started as
#     unshare --user --map-root-user --pid --fork --mount-proc --kill-child bash hook-test-harness.sh <token> ...
#     It is PID 1, PID 1 of /proc carries the run's <token> (so /proc is this namespace's), and no other
#     process is visible: every pid it can name is one it started, and the kernel kills them all when it exits.
#   container: inside a throwaway container of an image that carries the marker below: hook-test.Dockerfile's,
#     which CI's hook-kill-tests.yml builds (the live runner image has none, so these tests never run in a live
#     runner's container), started as
#     python3 (PR_SET_CHILD_SUBREAPER on itself, then exec) bash hook-test-harness.sh container ...
#     The marker is there, root's and read-only, /.dockerenv is there, PID 1 is the container's init (tini or
#     docker-init), and the PID namespace is not the host's initial one (/proc/$$/ns/pid is not pid:[4026531836],
#     a constant of the kernel). The probe, which runs alone, also refuses when /proc shows any process that is
#     neither this harness nor one above it: another container's processes, as with --pid=container:<a live
#     runner>, or anything else. Then it proves that an orphan of its subtree comes to it, not to any process
#     above it: the hook's parent can only be a process of this subtree or this harness (a bash), never the
#     container's real Runner.Worker. It notes every process above it (pid and start time) and reports whether
#     all of them still run after the case.
# Any doubt exits 97, and the tests skip. The harness signals nothing: whether a process lives is read from /proc.
set -u

marker=/opt/runner-hooks/ovis-runner-image

# Builtins only, in this process: a subshell or a command started here would be a second process.
in_own_namespace() {
  local token=$1 arg found=0 args pids
  [[ $$ == 1 ]] || { why="not PID 1 of a new PID namespace (pid $$)"; return 1; }
  [[ ${#token} -ge 32 ]] || { why="no run token"; return 1; }
  mapfile -d '' args 2>/dev/null </proc/1/cmdline || { why="/proc/1/cmdline cannot be read"; return 1; }
  for arg in "${args[@]}"; do [[ $arg == "$token" ]] && found=$((found + 1)); done
  [[ $found == 1 ]] || { why="PID 1 of /proc does not carry this run's token: /proc is not this namespace's"; return 1; }
  pids=(/proc/[0-9]*)
  [[ ${pids[*]} == /proc/1 ]] || { why="other processes are visible (${#pids[@]})"; return 1; }
}

in_runner_container() {
  local init args ns
  [[ -f $marker && ! -L $marker && ! -w $marker && ! -w ${marker%/*} ]] || { why="no read-only marker of the runner image ($marker)"; return 1; }
  [[ $(stat -c %u "$marker" "${marker%/*}" 2>/dev/null) == $'0\n0' ]] || { why="$marker is not root's"; return 1; }
  [[ -f /.dockerenv ]] || { why="not in a docker container (/.dockerenv)"; return 1; }
  IFS= read -r init 2>/dev/null </proc/1/comm || { why="/proc/1/comm cannot be read"; return 1; }
  mapfile -d '' args 2>/dev/null </proc/1/cmdline || { why="/proc/1/cmdline cannot be read"; return 1; }
  [[ ($init == tini || $init == docker-init) && ${args[0]##*/} == "$init" ]] || { why="PID 1 is $init, not the container's init"; return 1; }
  [[ $$ != 1 ]] || { why="this harness is PID 1"; return 1; }
  ns=$(/bin/readlink "/proc/$$/ns/pid" 2>/dev/null) || { why="its PID namespace cannot be read"; return 1; }
  [[ $ns =~ ^pid:\[[0-9]+\]$ && $ns != 'pid:[4026531836]' ]] || { why="in the host's initial PID namespace ($ns)"; return 1; }
}

# The probe's own: every process /proc shows is this harness or one above it. Builtins only, so this check
# starts no process; the guard's stat and readlink have ended and been reaped before it.
alone_in_namespace() {
  local -A line_of_mine=()
  local pid=$$ stat entry
  while [[ $pid =~ ^[1-9][0-9]*$ ]]; do
    line_of_mine[$pid]=1
    IFS= read -r stat 2>/dev/null <"/proc/$pid/stat" || { why="/proc/$pid/stat cannot be read"; return 1; }
    stat=${stat##*) }
    stat=${stat#* }
    pid=${stat%% *}
  done
  for entry in /proc/[0-9]*; do
    [[ -n ${line_of_mine[${entry#/proc/}]-} ]] || { why="a process that is neither this harness nor above it is visible (pid ${entry#/proc/})"; return 1; }
  done
}

why=""
guard=${1-}
if [[ $guard == container ]]; then
  in_runner_container || { echo "not isolated: $why" >&2; exit 97; }
  if [[ ${2-} == probe ]]; then alone_in_namespace || { echo "not isolated: $why" >&2; exit 97; }; fi
else
  in_own_namespace "$guard" || { echo "not isolated: $why" >&2; exit 97; }
fi
parent=${2-} output=${3-}

# Sets ppid_of and start_of from /proc/<pid>/stat (fields 4 and 22, after the last ")")
stat_of() {
  local line
  IFS= read -r line 2>/dev/null <"/proc/$1/stat" || return 1
  line=${line##*) }
  read -r _ ppid_of _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ start_of _ <<<"$line"
}

# A block said is not yet a block that holds. After the hook's "this hook blocks (pid N)" line, it must be seen
# to go round its loop: a /bin/sleep child of pid N, then another one (so N has read its parent again and stayed),
# with N and its parent still running at every poll. The polls read /proc only; between two of them the harness
# waits on fd 5, the hold FIFO it alone writes and never does, for 0.1 s. At most 150 polls: 15 s of waits plus
# the reads and scheduling, not a strict bound, against the hook's 5 s loop. The end is the hook's own second
# sleep, never a silence; it shows the block held through one more read of its parent, not forever.
persists() {
  local hook_pid=$1 first="" children child comm polls=0
  while (( polls++ < 150 )); do
    [[ $(state "$hook_pid") == running && $(state "$pid") == running ]] || return 1
    children=""
    IFS= read -r children 2>/dev/null <"/proc/$hook_pid/task/$hook_pid/children"
    for child in $children; do
      IFS= read -r comm 2>/dev/null <"/proc/$child/comm" || continue
      [[ $comm == sleep ]] || continue
      if [[ -z $first ]]; then first=$child; elif [[ $child != "$first" ]]; then return 0; fi
    done
    read -r -t 0.1 _ <&5
  done
  return 1
}

# running or gone (a zombie is gone)
state() {
  local line
  IFS= read -r line 2>/dev/null <"/proc/$1/stat" || { echo gone; return; }
  line=${line##*) }
  if [[ ${line%% *} == Z ]]; then echo gone; else echo running; fi
}

above=()
pid=$$
while stat_of "$pid" && [[ $ppid_of =~ ^[1-9][0-9]*$ ]] && (( ${#above[@]} < 64 )); do
  pid=$ppid_of
  stat_of "$pid" && above+=("$pid:$start_of")
done

dir=$HARNESS_DIR
mkdir -p "$dir/exe" "$dir/decoys"
# The write end of $dir/hold stays with this harness alone: what reads it ends when the harness does.
mkfifo "$dir/hold"
exec 5<>"$dir/hold"

if [[ $guard == container ]]; then
  # An orphan of this subtree must come to this harness: one that would go to a process above it could
  # leave the hook a parent outside the subtree.
  ( "$BASH" -c 'read -r _ <"$0"' "$dir/hold" 5>&- & echo "$!" >"$dir/orphan" )
  IFS= read -r orphan <"$dir/orphan"
  stat_of "$orphan" && [[ $ppid_of == "$$" ]] || { echo "not isolated: an orphan of this harness went to ${ppid_of:-nobody}, not to it" >&2; exit 97; }
fi
if [[ $parent == probe ]]; then echo isolated; exit 0; fi

# Decoys that must outlive every case: another Runner.Worker that is not the hook's parent, and a look-alike name
cp "$BASH" "$dir/decoys/Runner.Worker"
cp "$BASH" "$dir/decoys/Runner.Worker2"
decoys=()
for decoy in Runner.Worker Runner.Worker2; do
  "$dir/decoys/$decoy" -c 'read -r _ <"$0"' "$dir/hold" </dev/null >/dev/null 2>&1 5>&- &
  decoys+=($!)
done

run='bash "$0"'
prefix=""
case $parent in
  worker) exe=Runner.Worker ;;
  nested) exe=Runner.Worker run='bash -c '\''bash "$0"; :'\'' "$0"' ;;
  renamed) exe=Runner.Worker prefix='printf systemd >"/proc/$$/comm" && ' ;;
  posing) exe=systemd prefix='printf Runner.Worker >"/proc/$$/comm" && ' ;;
  named:*) exe=${parent#named:} ;;
  gone) exe=parent ;;
  leaves) exe=systemd ;;
  *) echo "unknown parent: $parent" >&2; exit 2 ;;
esac
cp "$BASH" "$dir/exe/$exe"
if [[ $output == closed ]]; then
  # $1: a FIFO whose only reader is closed before the hook starts, so its first write raises SIGPIPE
  script="${prefix}mkfifo \"\$1\" && exec 4<>\"\$1\" 5>\"\$1\" 4<&- && $run >&5 2>&5; echo \"next step ran\""
elif [[ $parent == gone || $parent == leaves ]]; then
  script="$run & read -r _ <\"\$1\"; exit 0"
  mkfifo "$dir/fifo"
  if [[ $parent == gone ]]; then mkfifo "$GITHUB_EVENT_PATH"; fi
else
  script="$prefix$run; echo \"next step ran\""
fi
mkfifo "$dir/out"
PATH=$HOOK_PATH "$dir/exe/$exe" -c "$script" "$HOOK" "$dir/fifo" >"$dir/out" 2>&1 </dev/null 5>&- &
pid=$!
exec 3<"$dir/out"

parent_status=""
if [[ $parent == gone ]]; then
  exec 4>"$GITHUB_EVENT_PATH"
  : >"$dir/fifo"
  wait "$pid"
  parent_status=$?
  cat "$dir/event.json" >&4
  exec 4>&-
fi

blocks_line='this hook blocks \(pid ([0-9]+)\)'
hook=silent next=no
while :; do
  if IFS= read -r -t 20 line <&3; then
    printf '%s\n' "$line" >>"$dir/output"
    [[ $line == 'next step ran' ]] && next=ran
    if [[ $line =~ $blocks_line ]]; then
      if [[ $parent == leaves ]]; then
        : >"$dir/fifo"
        wait "$pid"
        parent_status=$?
      elif [[ $parent != gone ]]; then
        if persists "${BASH_REMATCH[1]}"; then hook=blocked; else hook=unproven; fi
        while IFS= read -r -t 0.1 line <&3; do
          printf '%s\n' "$line" >>"$dir/output"
          [[ $line == 'next step ran' ]] && next=ran
        done
        break
      fi
    fi
  else
    (( $? > 128 )) || hook=ended
    break
  fi
done

if [[ -n $parent_status ]]; then
  parent_report=$parent_status
elif [[ $hook == ended ]]; then
  wait "$pid"
  parent_report=$?
else
  parent_report=$(state "$pid")
fi
decoy_report=alive
for decoy in "${decoys[@]}"; do
  [[ $(state "$decoy") == running ]] || decoy_report=dead
done
above_report=alive
for entry in "${above[@]}"; do
  stat_of "${entry%%:*}" && [[ $start_of == "${entry#*:}" ]] || above_report=dead
done
echo "report parent=$parent_report hook=$hook next=$next decoys=$decoy_report above=$above_report"
