#!/bin/sh
# The trial join (scripts/join/README.md): one pasted line runs this script from a kit, on a Linux machine whose account
# runs classic herdr. It looks (reading only), chooses the herdr session, says in English and Korean what it lets the
# devices of the person's Ovis account do and waits for yes, fetches the kit's programs and checks each against the
# kit's SHA256SUMS, installs them in a folder of their own, starts a separate trial Ovis server (`ovis-server serve` on
# 127.0.0.1, with its own state folder, identity and port) as a service of this account, and adds the machine to the
# person's Ovis account with today's `add` (a sign-in code, then a QR code a phone of the account scans). herdr is never
# installed, started, stopped or updated, and an Ovis this machine already runs is never read, copied or changed.
#
#   sh join.sh --kit <address> --sums <sha256 of SHA256SUMS> --relay <wss://...> --account <https://...>
#              --app <https://...> --trial [--session <name>] [--port <n>] [--yes]
#   sh join.sh --uninstall      removes the trial's unit, server and folder (nothing taken from its receipt), says what it
#                               did, leaves herdr alone
#
# Exit codes: 2 usage, 14 install or service failure, 16 kit verification, 17 platform, 20 no herdr session of this
# account, 21 no session chosen, 22 not confirmed, 23 herdr too old, 24 terminals do not attach, 25 herdr-core only,
# 26 the chosen session does not answer (the join, or the trial server), 28 run as root, 29 the kit's server is not the
# machine profile, 30 installed but not added, 31 a join without --trial, 32 the program of the chosen session's herdr
# server cannot be read from its process, 33 the trial's state folder resolves into an Ovis default folder, 34 the
# pairing gate is not closed after the add (finished, or not finished with the server kept), 35 the kit's server refuses to start here (in its own
# words, which name the folder or setting), 36 the trial server refuses the chosen session's herdr socket (it names the
# folder another account could change), 37 the add did not finish while the trial server names an Ovis account it did not name before (removed,
# on a run again too, unless on a run again its account before the add could not be read: then 39), 38 the add returned and the trial server names an Ovis account this run did not sign in to (kept,
# with its pairing gate closed; also after an add that did not finish, in the account it named before), 39 the add did not finish and the trial server's account could not be read, after the add or, on a run again,
# before it (stopped, the install kept for the undo). A HUP ends it as INT and TERM do (129).
set -u
umask 077

# HOME and the trial folder canonical once, before anything is looked up or written: /proc/<pid>/exe and pwd -P are
# canonical, and every "is this our server?" check compares with these paths (a HOME reached through a link, /home ->
# /var/home, or written with a doubled or trailing slash, would miss them all). herdr's sockets are the exception: they
# keep the spelling herdr bound them by, so j_choose also looks under the HOME as given. The trial folder by its parent
# only: the folder itself being a link is refused (j_no_links)
# only a resolver that succeeds is heard: one that prints and then fails (BusyBox's realpath on some paths) adds nothing
j_canonical() {
  j_c=$(realpath -m -- "$1" 2>/dev/null) || j_c=$(readlink -m -- "$1" 2>/dev/null) || j_c=$1
  printf '%s' "$j_c"
}
j_stage=""
j_self_dir=$(dirname "$0")
case $j_self_dir in "${TMPDIR:-/tmp}"/tmp.* | /tmp/tmp.*) [ "$(ls -A "$j_self_dir" 2>/dev/null)" = join.sh ] || j_self_dir="" ;; *) j_self_dir="" ;; esac
j_cleanup() {
  [ -z "$j_stage" ] || rm -rf "$j_stage"
  [ -z "$j_self_dir" ] || rm -rf "$j_self_dir"
}
trap j_cleanup EXIT
trap 'j_cleanup; exit 130' INT
trap 'j_cleanup; exit 143' TERM
trap 'j_cleanup; exit 129' HUP
# HOME set and not empty: checked on its own line, since a failed ${HOME:?} inside $(...) ends only that subshell
: "${HOME:?HOME is not set}"
# a HOME holding a line break or another control character, anywhere in it (the value as given: $(...) below would drop
# a line break at its end): the folders made below are listed one per line, and the trial server's settings file holds
# one setting per line, so it is refused before anything is made
case $HOME in *[[:cntrl:]]*) printf 'Ovis: HOME holds a line break or another control character, which the trial cannot use; nothing was changed\n' >&2; exit 2 ;; esac
j_home_given=$HOME
HOME=$(j_canonical "$HOME")
export HOME
J_HOME="$(j_canonical "$HOME/.local/share")/ovis-machine"
J_UNIT=ovis-machine.service
# the port the trial server never takes: an ordinary Ovis listens there by default
J_RESERVED=" 7317 "
J_PORTS="17690 17691 17692 17693 17694 17695 17696 17697 17698 17699"
J_TAB=$(printf '\t')
J_NL='
'

say() { printf '%s\n' "$*"; }
refuse() {
  [ -z "$j_stage" ] || rm -rf "$j_stage"
  printf 'Ovis: %s\n' "$2" >&2
  exit "$1"
}
j_pause() { sleep "$1" 2>/dev/null || sleep 1; }
j_sha256() { sha256sum "$1" | cut -c1-64; }
# j_quote <word>: the word as a shell reads it back, single-quoted when it holds anything but plain characters
j_quote() { case $1 in *[!A-Za-z0-9_./~:=@%+-]* | '') printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;; *) printf '%s' "$1" ;; esac; }
j_undo_line() { printf 'sh %s --uninstall' "$(j_quote "$J_HOME/join.sh")"; }

j_note() { printf '%s %s\n' "$1" "$2" >>"$J_HOME/receipt"; }
j_listed() { [ -f "$J_HOME/receipt" ] && grep -qxF "$1 $2" "$J_HOME/receipt"; }
# j_put <file> <mode>: stdin into <file> by one rename (a file or link at the temporary name is removed first)
j_put() { rm -f "$1.new" && cat >"$1.new" && chmod "$2" "$1.new" && mv -f "$1.new" "$1"; }
j_missing_dirs() {
  out='' p=$1
  while [ ! -d "$p" ]; do out="$p$J_NL$out"; p=$(dirname "$p"); done
  printf '%s' "$out"
}

j_systemd_user() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

# j_servers: the pids of this install's background server, one per line: processes of this account whose program is
# the trial's bin/ovis-server (also once replaced on disk) and whose command line is exactly `<it> serve`. A pid file is
# not read: one that is gone, or names another process, neither hides the server nor points at anything else. Nothing
# that is not found here is ever signalled (the undo, every rollback and `ovis-machine stop` use this one rule).
# The programs of all processes are read in one listing (ls -l of every /proc/<pid>/exe, which shows only this account's
# own); only the few whose program is the trial's are then looked at one by one.
j_servers() {
  j_uid=$(id -u)
  # QUOTING_STYLE=literal and LC_ALL=C: GNU ls prints the names as they are whatever the login sets (busybox ls ignores
  # both)
  for j_proc in $(QUOTING_STYLE=literal LC_ALL=C ls -l /proc/[0-9]*/exe 2>/dev/null | J_T="$J_HOME/bin/ovis-server" awk '{
      i = index($0, " -> "); if (i == 0) next
      t = substr($0, i + 4); if (t != ENVIRON["J_T"] && t != ENVIRON["J_T"] " (deleted)") next
      l = substr($0, 1, i - 1); sub(/^.* \/proc\//, "/proc/", l); sub(/\/exe$/, "", l); print l }'); do
    case $(readlink "$j_proc/exe" 2>/dev/null) in "$J_HOME/bin/ovis-server" | "$J_HOME/bin/ovis-server (deleted)") ;; *) continue ;; esac
    [ "$(stat -c %u "$j_proc" 2>/dev/null)" = "$j_uid" ] || continue
    [ "$({ tr '\000' '\n' <"$j_proc/cmdline"; } 2>/dev/null)" = "$J_HOME/bin/ovis-server${J_NL}serve" ] || continue
    printf '%s\n' "${j_proc#/proc/}"
  done
}
j_stop_background() {
  pid=$(j_servers)
  [ -z "$pid" ] || kill -TERM $pid 2>/dev/null
  j_until=$(($(date +%s) + 10))
  while [ -n "$(j_servers)" ] && [ "$(date +%s)" -lt "$j_until" ]; do j_pause 0.2; done
  pid=$(j_servers)
  [ -z "$pid" ] || kill -KILL $pid 2>/dev/null
  j_until=$(($(date +%s) + 2))
  while [ -n "$(j_servers)" ] && [ "$(date +%s)" -lt "$j_until" ]; do j_pause 0.2; done
  pid=$(j_servers | tr '\n' ' ')
  pid=${pid% }
  [ -z "$pid" ]
}
# j_halt: the one fail-safe stop of the trial server, used by every path that stops it: its service disabled and stopped
# (it would start again at the next login, or at boot with lingering), or its background server stopped. True only once
# seen: is-active reads inactive or failed, is-enabled no longer reads enabled, and no background server of it runs
j_halt() {
  if [ -f "$(j_unit_path)" ]; then
    systemctl --user disable --now "$J_UNIT" >/dev/null 2>&1
    case $(systemctl --user is-active "$J_UNIT" 2>/dev/null) in inactive | failed) ;; *) return 1 ;; esac
    # only a known state that is not enabled counts: a failed call or no answer could not confirm it
    case $(systemctl --user is-enabled "$J_UNIT" 2>/dev/null) in disabled | masked | masked-runtime | not-found | static | indirect | generated | transient) ;; *) return 1 ;; esac
  fi
  j_stop_background
}
# j_local [-f] <port> <path>: a request to a server's TCP port on this machine, with no curl config file of the login's
# (-q, curl's first argument), never through a proxy the login names.
# The machine profile answers only its liveness there; everything else it says to its local owner (j_owner)
j_local() {
  fail=""
  [ "$1" != -f ] || { fail=-f; shift; }
  curl -q -sS $fail --noproxy '*' --connect-timeout 3 --max-time 5 "http://127.0.0.1:$1$2" 2>/dev/null
}
# j_owner [-f] <socket> <path>: a request to a machine profile's local owner, on `serve.sock` in its state folder (only
# this account can connect there), as the profile takes it: Host exactly localhost, no Origin, no forwarding header, no
# curl config file of the login's (-q), never through a proxy. Nothing when no socket is there
j_owner() {
  fail=""
  [ "$1" != -f ] || { fail=-f; shift; }
  [ -S "$1" ] || return 1
  curl -q -sS $fail --noproxy '*' --connect-timeout 3 --max-time 5 --unix-socket "$1" "http://localhost$2" 2>/dev/null
}
j_refusal() { tail -c +"$(($2 + 1))" "$1" 2>/dev/null | grep -m 1 'so no server was started'; }
j_reason() { printf '%s' "$1" | grep -Eo '"reason"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | sed -n '1s/^"reason"[[:space:]]*:[[:space:]]*"//; 1s/"$//p'; }
# j_whole <body>: true when <body> is one whole JSON object: it starts with { and ends with }, around blanks (j_b: it,
# without them). A body cut off (a timeout, a dropped connection) fails this, whatever it holds so far
j_whole() {
  j_b=${1#"${1%%[![:space:]]*}"}
  j_b=${j_b%"${j_b##*[![:space:]]}"}
  case $j_b in '{'*'}') return 0 ;; esac
  return 1
}
# j_read [-f] <path>: a read from the trial server, on its owner socket; over its TCP port only under the plain-server
# test switch with no socket there (the plain server has none). Its answer only when curl ended well (exit 0) and the
# body is one whole JSON object (j_whole); otherwise nothing, and false
j_read() {
  fail=""
  [ "$1" != -f ] || { fail=-f; shift; }
  if [ "$j_plain_ok" = 1 ] && [ ! -S "$j_state/serve.sock" ]; then j_body=$(j_local $fail "$j_port" "$1"); else j_body=$(j_owner $fail "$j_state/serve.sock" "$1"); fi || return 1
  j_whole "$j_body" || return 1
  printf '%s' "$j_body"
}

# The trial's unit, at the one path the join writes it: the folder the user manager reads units from (its own
# XDG_CONFIG_HOME, else ~/.config). Its first line is the join's marker, which the undo checks before touching it.
j_unit_path() {
  j_manager_config=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^XDG_CONFIG_HOME=//p' | sed -n 1p)
  case $j_manager_config in /*) ;; *) j_manager_config=$HOME/.config ;; esac
  printf '%s/systemd/user/%s' "$j_manager_config" "$J_UNIT"
}
J_MARK="# Written by the Ovis trial join for $J_HOME"

# j_receipt_ok: the receipt only says that a join happened and where its trial folder is; what the undo removes it takes
# from fixed places, never from the receipt. Refused (nothing removed): a receipt or trial folder that is a link, a
# trial folder that is not the fixed one, a unit line other than the fixed unit path, a linger line for another user,
# and a unit at the fixed path that is a link or lacks the join's marker.
j_receipt_ok() {
  [ -f "$J_HOME/receipt" ] && [ ! -L "$J_HOME/receipt" ] && [ ! -L "$J_HOME" ] || return 1
  [ "$(sed -n 's/^home //p' "$J_HOME/receipt")" = "$J_HOME" ] || return 1
  unit_path=$(j_unit_path)
  while IFS= read -r line; do
    kind=${line%% *} path=${line#* }
    case $kind in
      home | file) ;;
      dir) case "$J_HOME/" in "$path"/*) ;; *) case "$unit_path" in "$path"/*) ;; *) [ "$path" = "$(dirname "$unit_path")/default.target.wants" ] || return 1 ;; esac ;; esac ;;
      unit) [ "$path" = "$unit_path" ] || return 1 ;;
      linger) [ "$path" = "$(id -un)" ] || return 1 ;;
      *) return 1 ;;
    esac
  done <"$J_HOME/receipt"
  if [ -e "$unit_path" ] || [ -L "$unit_path" ]; then
    [ ! -L "$unit_path" ] && [ "$(head -n 1 "$unit_path")" = "$J_MARK" ] || return 1
  fi
  return 0
}

# j_remove: the trial's unit (only at its fixed path, only with the join's marker), its background server, lingering
# when the receipt says the join turned it on, the trial folder itself, and then the folders the join made on the way to
# it or to the unit (~/.local/share, ~/.config/systemd/user, ...), deepest first, each only when it is empty (rmdir).
# Lingering that could not be turned off is left in j_linger_left. Returns 2, having removed nothing, when j_receipt_ok
# refuses.
j_remove() {
  [ -f "$J_HOME/receipt" ] || return 0
  j_receipt_ok || return 2
  unit_path=$(j_unit_path)
  # the unit present: its service manager must answer, and the service must be seen inactive after the stop; otherwise
  # it may run on (from su or sudo the user's bus is not reached), and nothing is removed
  if [ -f "$unit_path" ]; then
    systemctl --user show-environment >/dev/null 2>&1 || return 4
    j_halt || return 4
  else
    j_halt || return 1
  fi
  j_made=$(sed -n '1!G;h;$p' "$J_HOME/receipt" | sed -n 's/^dir //p')
  if [ -f "$unit_path" ]; then rm -f -- "$unit_path"; systemctl --user daemon-reload >/dev/null 2>&1; fi
  # the unit as j_start_systemd writes it first, left there when that write or the run ended before its rename: only a
  # file that starts with the join's marker
  j_new="$(dirname "$unit_path")/.$J_UNIT.new"
  if [ -f "$j_new" ] && [ ! -L "$j_new" ] && [ "$(head -n 1 "$j_new" 2>/dev/null)" = "$J_MARK" ]; then rm -f -- "$j_new"; fi
  j_linger_left=""
  for j_who in $(sed -n 's/^linger //p' "$J_HOME/receipt"); do
    loginctl disable-linger "$j_who" >/dev/null 2>&1 || j_linger_left=$j_who
  done
  rm -rf -- "$J_HOME"
  [ ! -e "$J_HOME" ] || return 3
  printf '%s\n' "$j_made" | while IFS= read -r p; do [ -z "$p" ] || rmdir -- "$p" 2>/dev/null; done
  return 0
}
# j_account_of <account status>: `null` when the trial server names no account, `=<id>` for the account <id> it names
# (so an account whose id is the text null is never taken for none), or nothing (no answer) unless the answer is one
# whole JSON object whose first field is the account, as the server writes it ({"account":null,...} or
# {"account":"<id>",...})
j_account_of() {
  j_whole "$1" || return 0
  case $j_b in
    '{"account":null}' | '{"account":null,'*) printf null ;;
    '{"account":"'*) printf '%s' "$j_b" | sed -n 's/^{"account":"\([^"][^"]*\)"[,}].*/=\1/p' ;;
  esac
}
# j_short <account>: an account as j_account_of gives it, shown as the plugin's add shows it (scripts/plugin-link.ts
# shortId): control characters dropped, the first 12 characters of its id
j_short() { printf '%s' "${1#=}" | tr -d '[:cntrl:]' | cut -c1-12; }
# j_account_read: sets j_got to the trial server's account as j_account_of gives it, read up to five times a second
# apart, as the pairing gate is (j_gate_closed): one failed read (the server just restarted, say) is not taken for an
# answer. Empty only when no try answered. A first try that got no answer is said, once: the tries can take a while
j_account_read() {
  j_try=0
  while [ "$j_try" -lt 5 ]; do
    j_got=$(j_account_of "$(j_read -f /api/account/status)")
    [ -z "$j_got" ] || break
    j_try=$((j_try + 1))
    [ "$j_try" != 1 ] || say "Reading the trial server's account again (no answer yet; up to 5 tries)..."
    [ "$j_try" -ge 5 ] || j_pause 1
  done
}
j_rollback() { [ "$j_fresh" = 1 ] && j_remove; }
j_rolled_back() {
  # a run again that ends before it stopped the earlier install has changed nothing of it, which is left running
  if [ "${1:-}" != all ] && [ "$j_fresh" = 0 ] && [ "$j_touched" = 0 ]; then printf 'nothing was changed'; return; fi
  j_rc=keep
  if [ "${1:-}" = all ] || [ "$j_fresh" = 1 ]; then j_remove; j_rc=$?; fi
  if [ "$j_rc" = 0 ]; then
    if [ -n "${j_linger_left:-}" ]; then printf 'nothing was kept but lingering for %s, which could not be turned off: turn it off with  loginctl disable-linger %s' "$j_linger_left" "$j_linger_left"
    else printf 'nothing was kept'; fi
  elif [ "$j_rc" = 3 ]; then
    printf 'the trial server was stopped, but %s could not be removed entirely (left there: %s...): look at it, then remove it yourself (rm -rf %s)' "$J_HOME" "$(find "$J_HOME" 2>/dev/null | sed -n '2,4p' | tr '\n' ' ')" "$(j_quote "$J_HOME")"
  else
    if j_halt; then printf 'the install stays, stopped (undo: %s)' "$(j_undo_line)"
    else printf 'the install stays, and whether its server stopped could not be confirmed (undo: %s)' "$(j_undo_line)"; fi
  fi
}

# --- the look: reading only, as this account ---
# One TAB-separated line `<engine> <session> <socket> <program>` for each herdr and herdr-core session whose socket this
# account owns and something listens on; <program> is the executable of the process listening there, empty when it
# cannot be read. Then `bin <engine> <path>` for each engine's program found in the usual folders. No socket is
# connected to and no engine command is run.
J_DETECT=$(cat <<'EOF'
inode() {
  [ -S "$1" ] && [ -O "$1" ] || return 1
  [ -r /proc/net/unix ] || { echo -; return 0; }
  awk -v p="$1" '$4 == "00010000" && length($0) > length(p) && substr($0, length($0) - length(p)) == " " p { print $7; f = 1; exit } END { exit !f }' /proc/net/unix
}
holder() {
  [ "$1" != - ] || return 0
  for p in /proc/[0-9]*; do
    [ -O "$p" ] || continue
    exe=$(readlink "$p/exe" 2>/dev/null) || continue
    exe=${exe% (deleted)}
    case ${exe##*/} in $2*) ;; *) continue ;; esac
    for fd in "$p"/fd/*; do
      [ "$(readlink "$fd" 2>/dev/null)" = "socket:[$1]" ] || continue
      [ -x "$exe" ] && printf '%s' "$exe"
      return 0
    done
  done
}
plain() { case $1 in '' | *[!A-Za-z0-9_.-]* | . | ..) return 1 ;; esac; }
emit() { ino=$(inode "$3") && printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(holder "$ino" "$4")"; }
hroot=${XDG_CONFIG_HOME:-}
case $hroot in /*) ;; *) hroot=$HOME/.config ;; esac
hroot=$hroot/herdr
emit herdr default "$hroot/herdr.sock" herdr
for s in "$hroot"/sessions/*/herdr.sock; do
  name=${s%/herdr.sock}
  name=${name##*/}
  plain "$name" && [ "$name" != default ] && emit herdr "$name" "$s" herdr
done
run=${XDG_RUNTIME_DIR:-}
[ -n "$run" ] || { [ -d "/run/user/$(id -u)" ] && run=/run/user/$(id -u); }
for s in ${run:+"$run"/herdr-core/*.sock}; do
  name=${s##*/}
  name=${name%.sock}
  plain "$name" && emit herdr-core "$name" "$s" herdr-core
done
state=${XDG_STATE_HOME:-}
case $state in /*) ;; *) state=$HOME/.local/state ;; esac
for s in "$state"/herdr-core/*/*.sock; do
  name=${s##*/}
  name=${name%.sock}
  [ "${s%/*}" = "$state/herdr-core/$name" ] && plain "$name" && emit herdr-core "$name" "$s" herdr-core
done
for dir in "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin "$HOME/.cargo/bin" "$HOME/.nix-profile/bin" /usr/bin; do
  if [ -f "$dir/herdr" ] && [ -x "$dir/herdr" ]; then printf 'bin herdr %s\n' "$dir/herdr"; break; fi
done
exit 0
EOF
)

j_tty() { (: </dev/tty) 2>/dev/null; }
j_ask() {
  j_answer=""
  printf '%s' "$1"
  IFS= read -r j_answer </dev/tty || j_answer=""
  printf '\n'
}

j_choose() {
  # /proc/net/unix names a socket as it was bound: under the canonical HOME and, where it differs, under the HOME as
  # given (a herdr started as /home/u, the link to /var/home/u); one socket is bound by one spelling, so shows once
  j_seen=$({ sh -c "$J_DETECT"; [ "$j_home_given" = "$HOME" ] || HOME=$j_home_given sh -c "$J_DETECT"; } 2>/dev/null | awk '!seen[$0]++')
  j_found=$(printf '%s\n' "$j_seen" | grep "^herdr$J_TAB")
  j_cores=$(printf '%s\n' "$j_seen" | sed -n "s/^herdr-core$J_TAB\\([^$J_TAB]*\\)$J_TAB.*/\\1/p" | tr '\n' ' ' | sed 's/ $//')
  j_bin=$(printf '%s\n' "$j_seen" | sed -n 's/^bin herdr //p' | sed -n 1p)
  if [ -z "$j_found" ]; then
    [ -z "$j_cores" ] || refuse 25 "this machine runs herdr-core only (session $j_cores); this trial is for classic herdr: start a herdr session, then run the line again; nothing was changed"
    [ -z "$j_bin" ] || refuse 20 "herdr is installed here but no herdr session of this account runs: start herdr, then run the line again; nothing was changed"
    refuse 20 "herdr does not run here; install it with: curl -fsSL https://herdr.dev/install.sh | sh  (then start it and run the line again); nothing was changed"
  fi
  j_pick=$(printf '%s\n' "$j_found" | while IFS=$J_TAB read -r e s sock bin; do
    [ -z "$j_want_session" ] || [ "$s" = "$j_want_session" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$e" "$s" "$sock" "$bin"
  done)
  j_running=$(printf '%s\n' "$j_found" | cut -f2 | tr '\n' ',' | sed 's/,$//; s/,/, /g')
  [ -n "$j_pick" ] || refuse 21 "no running herdr session is named $j_want_session; running here: $j_running; nothing was changed"
  j_count=$(printf '%s\n' "$j_pick" | grep -c .)
  if [ "$j_count" -gt 1 ]; then
    j_tty || refuse 21 "several herdr sessions run here ($j_running) and there is no terminal to ask on: choose one with --session <name>; nothing was changed"
    printf '\n  Several herdr sessions run on this machine. Which one may Ovis use?\n  이 머신에서 herdr 세션이 여러 개 실행 중입니다. Ovis가 쓸 세션을 고르세요.\n\n'
    i=0
    printf '%s\n' "$j_pick" | while IFS=$J_TAB read -r e s sock bin; do
      i=$((i + 1))
      if [ "$s" = default ]; then mark="   <- the unnamed default session / 기본 세션"; else mark=""; fi
      printf '    %s) session %s%s\n' "$i" "$s" "$mark"
    done
    j_ask "  Number / 번호: "
    case $j_answer in '' | *[!0-9]*) j_answer=0 ;; esac
    [ "$j_answer" -ge 1 ] && [ "$j_answer" -le "$j_count" ] || refuse 21 "no session was chosen; nothing was changed"
    j_pick=$(printf '%s\n' "$j_pick" | sed -n "${j_answer}p")
  fi
  j_session=$(printf '%s\n' "$j_pick" | cut -f2)
  # the socket as found (herdr's own config folder, which its status reads, follows from it) and canonical, as every other
  # path the trial server is given: the same socket, whichever spelling found it
  j_found=$(printf '%s\n' "$j_pick" | cut -f3)
  j_socket=$(j_canonical "$j_found")
  # the program of the session's own server; only where it cannot be read, the first one in the usual folders
  # the program of the process that listens on that socket (/proc/<pid>/exe), never a herdr found on PATH or in the
  # usual folders: a machine may hold several herdr programs, and only the session's own one attaches its terminals
  j_herdr=$(printf '%s\n' "$j_pick" | cut -f4)
}

# The session's herdr speaks protocol 22 or newer, asked as herdr's own status does it: `herdr [--session <name>]
# status server` as this account. It reads the running server's answer; nothing is started or changed.
j_herdr_version() {
  [ -n "$j_herdr" ] || refuse 32 "the program of the herdr server that listens on $j_socket cannot be read from its process; nothing was changed"
  if [ "$j_session" = default ]; then set -- status server; else set -- --session "$j_session" status server; fi
  j_root=${j_found%/herdr.sock}
  [ "$j_session" = default ] || j_root=${j_root%/sessions/*}
  j_root=${j_root%/herdr}
  j_status=$(XDG_CONFIG_HOME=$j_root "$j_herdr" "$@" 2>/dev/null </dev/null)
  j_protocol=$(printf '%s\n' "$j_status" | sed -n 's/^private_protocol: *\([0-9][0-9]*\)$/\1/p' | sed -n 1p)
  j_have=$(printf '%s\n' "$j_status" | sed -n 's/^version: *\([^ ]*\)$/\1/p' | sed -n 1p)
  [ -n "$j_protocol" ] || refuse 26 "herdr session $j_session does not answer (it may have stopped): start it, then run the line again; nothing was changed"
  [ "$j_protocol" -ge 22 ] || refuse 23 "Ovis needs herdr 0.9 or newer (protocol 22); this herdr is ${j_have:-unknown} (protocol $j_protocol). Update it yourself (herdr update), restart it, and run the line again; nothing was changed"
}

# An Ovis server this account already runs (the herdr plugin's, an install's), read from process command lines only:
# its pid in $j_own, or empty. Nothing of it is read beyond that, and nothing changes.
j_own_ovis() {
  j_own=""
  for p in /proc/[0-9]*; do
    [ -O "$p" ] || continue
    cmd=$({ tr '\000' ' ' <"$p/cmdline"; } 2>/dev/null) || continue
    case $cmd in *"$J_HOME/"*) continue ;; esac
    case $cmd in *server/index.ts* | *server/managed.ts* | *"ovis-server serve"* | *"ovis-server managed"* | *"ovis-server supervisor"*) j_own=${p#/proc/}; return 0 ;; esac
  done
}

j_listening() {
  if command -v ss >/dev/null 2>&1; then ss -Hltn 2>/dev/null | awk '{ n = split($4, a, ":"); print a[n] }'
  else awk 'NR > 1 && $4 == "0A" { split($2, a, ":"); print a[2] }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | while read -r hex; do printf '%d\n' "0x$hex"; done
  fi
}
# j_stop_line: the command that stops the trial server for good where the join could not: under systemd its service
# disabled as well as stopped (a stop alone leaves it to start again at the next login or boot)
j_stop_line() {
  if [ "$j_services" = systemd-user ]; then printf 'systemctl --user disable --now %s' "$J_UNIT"
  else printf '%s stop' "$(j_quote "$J_HOME/bin/ovis-machine")"; fi
}
j_choose_port() {
  j_old_port=$(sed -n 's/^port //p' "$J_HOME/trial" 2>/dev/null)
  j_port=$j_old_port
  [ -z "$j_want_port" ] || j_port=$j_want_port
  if [ -z "$j_port" ]; then
    taken=" $(j_listening | tr '\n' ' ') "
    for p in $J_PORTS; do case $taken in *" $p "*) ;; *) j_port=$p; break ;; esac; done
    [ -n "$j_port" ] || refuse 14 "ports $J_PORTS are all in use here: choose a free one with --port <n>; nothing was changed"
  fi
  case $J_RESERVED in *" $j_port "*) refuse 2 "port $j_port is kept for another Ovis: choose another with --port <n>; nothing was changed" ;; esac
  # any port but the one an earlier run's trial server holds is looked at now, before that server is stopped: a run again
  # must not stop and disable a working trial server for a port it then cannot take
  [ "$j_port" = "$j_old_port" ] || ! j_port_taken "$j_port" || refuse 14 "port $j_port is already in use here (another program listens on it): choose a free one with --port <n>; nothing was changed"
}
j_port_taken() { j_listening | grep -qx "$1"; }
# j_port_exe <port>: the program of the process that listens on <port>, from /proc: the socket's inode in /proc/net/tcp*,
# the process whose fd holds it, its exe. Empty when none is found (or it is another user's process).
j_port_exe() {
  hex=$(printf ':%04X' "$1")
  inode=$(awk -v h="$hex" 'NR > 1 && $4 == "0A" && substr($2, length($2) - 4) == h { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)
  [ -n "$inode" ] || return 0
  fd=$(find /proc/[0-9]*/fd -lname "socket:\[$inode\]" 2>/dev/null | sed -n 1p)
  [ -n "$fd" ] || return 0
  fd=${fd#/proc/}
  readlink "/proc/${fd%%/*}/exe" 2>/dev/null
}

# Says what the devices of the person's account will be able to do, and waits for yes: --yes, else the word typed at
# the terminal. Anything else ends the run here, with nothing changed.
j_consent() {
  j_host=$(hostname 2>/dev/null || uname -n)
  j_user=$(id -un)
  j_linger_en="" j_linger_ko=""
  # read as j_start_systemd reads it, which turns lingering on only after an explicit "no" from a loginctl that exits 0:
  # an unreadable state is promised nothing here, and the start then says it left lingering as it is
  j_linger_now=$(command -v loginctl >/dev/null 2>&1 && loginctl show-user "$j_user" -p Linger --value 2>/dev/null) || j_linger_now=""
  if [ "$j_services" = systemd-user ] && [ "$j_linger_now" = no ]; then
    j_linger_en="
  It will try to turn lingering on for the user \"$j_user\", so the trial server keeps running after logout;
  if that is refused, it says so, and the trial server stops when \"$j_user\" logs out."
    j_linger_ko="
  사용자 \"$j_user\"에게 lingering을 켜 보려고 합니다(로그아웃한 뒤에도 체험용 서버가 계속 실행되도록).
  켜지지 않으면 그렇다고 알려 주며, 그때는 사용자 \"$j_user\"가 로그아웃하면 체험용 서버가 멈춥니다."
  fi
  if [ "$j_services" = systemd-user ]; then
    j_how_en="as a systemd user service ($J_UNIT)"
    j_how_ko="systemd 사용자 서비스($J_UNIT)로"
  else
    j_how_en="as a background program (no service manager answers here; run the line again after a reboot)"
    j_how_ko="백그라운드 프로그램으로(여기에는 서비스 관리자가 없어 재부팅 뒤에는 이 줄을 다시 실행해야 합니다)"
  fi
  if [ -n "$j_own" ]; then
    j_own_en="This machine already runs its own Ovis (process $j_own). The trial server is separate from it, with its own
  identity, state folder and port; that Ovis is not touched and takes no part in this trial."
    j_own_ko="이 머신에는 이미 Ovis가 실행 중입니다(프로세스 $j_own). 체험용 서버는 그것과 별개로 자기 신원·상태 폴더·포트를
  씁니다. 기존 Ovis는 건드리지 않으며 이 체험에 참여하지 않습니다."
  else
    j_own_en="The trial server has its own identity, state folder and port, apart from any other Ovis on this machine."
    j_own_ko="체험용 서버는 이 머신의 다른 Ovis와 별개로 자기 신원·상태 폴더·포트를 씁니다."
  fi
  if [ "$j_plain_ok" = 1 ]; then
    j_listen_en="  TEST SWITCH (OVIS_JOIN_TEST_PLAIN_SERVER=1): this is the plain Ovis server, not the machine profile.
  Besides 127.0.0.1 port $j_port, once the relay is on it also listens on this machine's home-network and
  Tailscale addresses, where devices of your Ovis account can reach it directly."
    j_listen_ko="  테스트 스위치(OVIS_JOIN_TEST_PLAIN_SERVER=1): 머신 프로필이 아닌 일반 Ovis 서버입니다.
  릴레이가 켜지면 127.0.0.1 포트 $j_port 외에 이 머신의 홈 네트워크 주소와 Tailscale 주소에서도 연결을 받으며,
  내 Ovis 계정의 기기가 그곳으로 직접 닿을 수 있습니다."
  else
    j_listen_en="  It listens on 127.0.0.1 port $j_port only: nothing else on your network can reach it, and your devices
  reach it through the relay below."
    j_listen_ko="  127.0.0.1 포트 $j_port 에서만 연결을 받습니다: 네트워크의 다른 기기는 직접 닿을 수 없고,
  내 기기들은 아래 릴레이를 거쳐 닿습니다."
  fi
  j_ca_en="" j_ca_ko=""
  case ${NODE_EXTRA_CA_CERTS:-} in
    /*)
      j_ca_en="
  It also trusts the certificate authority that your login names: NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS"
      j_ca_ko="
  로그인 환경이 지정한 인증 기관도 신뢰합니다: NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS" ;;
  esac
  j_undo=$(j_undo_line)
  cat <<EOF

  Ovis trial: add this machine ($j_host) to your Ovis account, as the user "$j_user" on this machine.

  This installs a trial Ovis server in $J_HOME and starts it $j_how_en.
$j_listen_en
  It is a trial server: it talks only to these TEST services:
    app:              $j_app
    account service:  $j_account
    relay:            $j_relay$j_ca_en
  "Your Ovis account" here is the account you sign in to on that test account service; your real Ovis
  account and the machines in it are not touched.
  $j_own_en
  Then it adds this machine to your Ovis account: you sign in with a code, then a phone of your account
  scans the QR code shown here.

  The devices you approve in your Ovis account will be able to use this machine as the user "$j_user":
  - SEE and TYPE IN every terminal of the herdr session "$j_session" of "$j_user", including the terminals running there now.
    Typing in a terminal runs any command as "$j_user".
  - START new terminals there, and CLOSE the terminals, tabs and workspaces of that session
    (what runs in them ends), and remove git worktrees that Ovis shows (its folder goes, unsaved changes too).
  - READ AND CHANGE the files "$j_user" can reach on this machine: read any file "$j_user" can read,
    edit the text files "$j_user" can write, and save files and images sent from Ovis (into a .ovis folder).
  - run plugin actions and install agents on it (an agent's installer downloads and runs as "$j_user").
  A terminal that is open elsewhere (another Ovis on this machine) may show as busy until it is let go.
  Nothing is installed, updated or restarted of herdr.$j_linger_en
  Undo at any time:  $j_undo
  This undoes the join, not what was changed on this machine through it.

  Ovis 체험: 이 머신($j_host)을 이 머신의 사용자 "$j_user"로 내 Ovis 계정에 추가합니다.

  $J_HOME 에 체험용 Ovis 서버를 설치하고, $j_how_ko 시작합니다.
$j_listen_ko
  체험용 서버이며, 다음 테스트 서비스에만 연결됩니다:
    앱:            $j_app
    계정 서비스:   $j_account
    릴레이:        $j_relay$j_ca_ko
  여기서 "내 Ovis 계정"은 이 테스트 계정 서비스에서 로그인하는 계정입니다. 실제 Ovis 계정과 그 안의 머신은
  건드리지 않습니다.
  $j_own_ko
  그다음 이 머신을 내 Ovis 계정에 추가합니다: 코드로 로그인한 뒤, 계정에 있는 휴대폰으로 여기 보이는 QR 코드를 스캔합니다.

  내 Ovis 계정에서 승인한 기기는 이 머신을 사용자 "$j_user"로 쓸 수 있게 됩니다:
  - 사용자 "$j_user"의 herdr 세션 "$j_session"(지금 켜져 있는 터미널 포함)의 모든 터미널을 보고 입력하기.
    터미널에 입력하면 사용자 "$j_user" 권한으로 어떤 명령이든 실행됩니다.
  - 그곳에 새 터미널 열기, 그 세션의 터미널·탭·워크스페이스 닫기(그 안에서 돌던 것은 끝납니다),
    Ovis에 보이는 git 워크트리 지우기(폴더째 지워지며 저장하지 않은 변경도 사라집니다).
  - "$j_user"가 이 머신에서 닿을 수 있는 파일을 읽고 바꾸기: "$j_user"가 읽을 수 있는 파일을 읽고,
    쓸 수 있는 텍스트 파일을 고치고, Ovis에서 보낸 파일과 이미지를 (.ovis 폴더에) 저장하기.
  - 이 머신에서 플러그인 동작을 실행하고 에이전트를 설치하기(에이전트 설치 프로그램은 사용자 "$j_user" 권한으로 내려받아 실행됩니다).
  다른 곳(이 머신의 다른 Ovis)에서 열려 있는 터미널은 그쪽이 놓을 때까지 사용 중으로 보일 수 있습니다.
  herdr는 설치·업데이트·재시작하지 않습니다.$j_linger_ko
  되돌리기:  $j_undo
  이것은 참여를 되돌릴 뿐, 그동안 이 머신에서 바뀐 것은 되돌리지 않습니다.

EOF
  if [ "$j_yes" = 1 ]; then
    say "  yes (given with --yes)"
    return 0
  fi
  j_tty || refuse 22 "there is no terminal to answer on: run the line in a terminal, or add --yes to agree; nothing was changed"
  j_ask "  Type yes to go on / 계속하려면 yes 를 입력하세요: "
  [ "$j_answer" = yes ] || refuse 22 "the answer was not yes; nothing was changed"
}

# --- the kit: every file fetched into the stage and checked against SHA256SUMS by its exact name ---
J_KIT_FILES="bin/ovis-server bin/bin/ovis-pty-sidecar bin/bin/ovis-pty-sidecar.json join.sh"
# j_kit_sum <name>: the SHA-256 SHA256SUMS lists for exactly that name, else nothing
j_kit_sum() { awk -v n="$1" 'NF == 2 && $2 == n { print $1; exit }' "$j_stage/SHA256SUMS"; }
j_fetch() { curl -q -fsSL --proto '=https,file' --max-time 600 "$j_kit/$1" -o "$2" 2>/dev/null; }
# j_kit_list: SHA256SUMS fetched and checked, and the test kit's marker, before the question (the consent depends on
# whether the test switches count); the kit's programs come after the yes (j_kit_fetch)
J_TEST_KIT=TEST-KIT
j_test_kit=0
j_kit_list() {
  j_stage=$(mktemp -d 2>/dev/null) || refuse 14 "no temporary folder can be made; nothing was changed"
  j_fetch SHA256SUMS "$j_stage/SHA256SUMS" || refuse 16 "SHA256SUMS could not be fetched from $j_kit: check the address and the network; nothing was changed"
  [ "$(j_sha256 "$j_stage/SHA256SUMS")" = "$j_sums" ] || refuse 16 "the kit's SHA256SUMS is not the one this line is for: get the line again from whoever gave it to you; nothing was changed"
  # exactly the kit's four listed files (and TEST-KIT, in a kit made for the tests), each once, each `<64 hex digits>
  # <name>`: another line, an unknown name, a repeated name or a missing one is refused before any other file is
  # fetched. Over https only these names are ever fetched, so a file the server holds beside them is never read
  j_count=$(grep -c '' "$j_stage/SHA256SUMS")
  [ "$j_count" = 4 ] || { [ "$j_count" = 5 ] && [ -n "$(j_kit_sum "$J_TEST_KIT")" ]; } || refuse 16 "SHA256SUMS does not list exactly the kit's four files; nothing was changed"
  for name in $J_KIT_FILES; do
    [ -n "$(j_kit_sum "$name")" ] || refuse 16 "the kit is missing $name; nothing was changed"
  done
  while IFS= read -r line; do
    printf '%s\n' "$line" | grep -Eqx '[0-9a-f]{64}  [A-Za-z0-9._/-]+' || refuse 16 "SHA256SUMS holds a line that is not '<sha256>  <file>'; nothing was changed"
    name=${line#*  }
    case " $J_KIT_FILES $J_TEST_KIT " in *" $name "*) ;; *) refuse 16 "the kit holds a file it should not ($name); nothing was changed" ;; esac
    [ "$(awk -v n="$name" '$2 == n { c++ } END { print c + 0 }' "$j_stage/SHA256SUMS")" = 1 ] || refuse 16 "SHA256SUMS lists $name more than once; nothing was changed"
  done <"$j_stage/SHA256SUMS"
  # a kit served as a folder: nothing in it beside its listed files
  case $j_kit in
    file://*)
      j_dir=${j_kit#file://}
      [ -d "$j_dir" ] && (cd "$j_dir") 2>/dev/null || refuse 16 "the kit folder $j_dir cannot be read (a file:// address takes the folder's plain path, not a percent-encoded one); nothing was changed"
      extra=$(cd "$j_dir" 2>/dev/null && find . -type f -o -type l | sed 's|^\./||' | while IFS= read -r f; do
        case " $J_KIT_FILES $J_TEST_KIT SHA256SUMS " in *" $f "*) ;; *) printf '%s\n' "$f" ;; esac
      done | sed -n 1p)
      [ -z "$extra" ] || refuse 16 "the kit holds a file it should not ($extra); nothing was changed"
      ;;
  esac
  # a kit made for the join's tests (kit.ts make --test-kit) carries TEST-KIT, listed and matching; a pasted line cannot
  # make one, since the line pins SHA256SUMS
  want=$(j_kit_sum "$J_TEST_KIT")
  if [ -n "$want" ]; then
    j_fetch "$J_TEST_KIT" "$j_stage/$J_TEST_KIT" && [ "$(j_sha256 "$j_stage/$J_TEST_KIT")" = "$want" ] || refuse 16 "$J_TEST_KIT differs from the kit's SHA256SUMS; nothing was changed"
    j_test_kit=1
  fi
}
j_kit_fetch() {
  mkdir -p "$j_stage/bin/bin" || refuse 14 "the temporary folder cannot be filled; nothing was changed"
  for name in $J_KIT_FILES; do
    want=$(j_kit_sum "$name")
    [ -n "$want" ] || refuse 16 "the kit is missing $name; nothing was changed"
    j_fetch "$name" "$j_stage/$name" || refuse 16 "$name could not be fetched from $j_kit; nothing was changed"
    [ "$(j_sha256 "$j_stage/$name")" = "$want" ] || refuse 16 "$name differs from the kit's SHA256SUMS; nothing was changed"
  done
  chmod 755 "$j_stage/bin/ovis-server" "$j_stage/bin/bin/ovis-pty-sidecar"
}

# --- the trial server's command and environment: built in this one place, from an argv and NAME=value lines; the
# unit, the background start and the trial's own command all take them from here ---
# Not set, and cleared in the unit: OVIS_TOKEN, HOST, OVIS_MANAGED, OVIS_AUTO_UPDATE, OVIS_REMOTE. One addition:
# OVIS_HERDR_BIN, the session's own
# herdr program, which the server attaches terminals with (server/core/terminal-process.ts:632) when herdr is not on
# the login's PATH.
j_service() {
  j_shell=$(getent passwd "$j_user" 2>/dev/null | cut -d: -f7)
  [ -n "$j_shell" ] || j_shell=${SHELL:-/bin/sh}
  j_trial_env="$J_PROFILE_ENV
$J_PREVIEW_ENV
PORT=$j_port
OVIS_STATE_DIR=$j_state
OVIS_RUNTIME=herdr
HERDR_SOCKET=$j_socket
OVIS_HERDR_BIN=$j_herdr
OVIS_RELAY_URL=$j_relay
OVIS_ACCOUNT_SERVICE_URL=$j_account
OVIS_RELAY_APP_URL=$j_app
OVIS_TELEMETRY=0"
  # a certificate authority the login names for the test services (a private test CA), carried as it is
  case ${NODE_EXTRA_CA_CERTS:-} in /*) j_trial_env="$j_trial_env${J_NL}NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS" ;; esac
  j_env="$j_trial_env
HOME=$HOME
SHELL=$j_shell
PATH=$PATH"
  for name in XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR; do
    eval "value=\${$name:-}"
    [ -z "$value" ] || j_env="$j_env${J_NL}$name=$value"
  done
  # one line per name in server.env, read the same by systemd and by serve.sh: no value may hold a newline
  for value in "$j_port" "$J_HOME" "$j_socket" "$j_herdr" "$j_relay" "$j_account" "$j_app" "$HOME" "$j_shell" "$PATH" "${NODE_EXTRA_CA_CERTS:-}" \
    "${XDG_CONFIG_HOME:-}" "${XDG_STATE_HOME:-}" "${XDG_DATA_HOME:-}" "${XDG_CACHE_HOME:-}" "${XDG_RUNTIME_DIR:-}"; do
    # nor a quote or backslash: serve.sh takes a line as it is, but other readers of server.env (the proof session's
    # rehearsal, a systemd EnvironmentFile=) read those themselves
    case $value in *"$J_NL"* | *'"'* | *"'"* | *'\'*) return 1 ;; esac
  done
  return 0
}
# a unit's quoting of one word (systemd.syntax): backslashes and double quotes escaped, % and $ doubled
j_unit_word() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g; s/\$/$$/g')"; }

# The server's environment as ONE file, server.env: one NAME=value per line, no quotes, no comments. serve.sh starts
# the server from it (the unit runs serve.sh, as the background start does; systemd does not read it), the trial's own command takes its settings from it, and the proof
# session's rehearsal starts the server from it.
j_write_files() {
  j_listed file "$J_HOME/server.env" || j_note file "$J_HOME/server.env"
  printf '%s\n' "$j_env" | j_put "$J_HOME/server.env" 600 || return 1
  # the plugin's own config file holds the same settings: the plugin reads its config files over its environment
  printf '%s\n' "$j_trial_env" | j_put "$J_HOME/config/env" 600 || return 1
  printf '%s\n' "port $j_port" "service $j_services" "session $j_session" "socket $j_socket" "herdr $j_herdr" | j_put "$J_HOME/trial" 600 || return 1
  j_put "$J_HOME/serve.sh" 700 <<'EOF' || return 1
#!/bin/sh
# the trial server, from its unit or in the background, with exactly the environment of server.env
D=$(cd "$(dirname "$0")" && pwd -P) || exit 2
set --
while IFS= read -r kv; do set -- "$@" "$kv"; done <"$D/server.env"
exec env -i "$@" "$D/bin/ovis-server" serve
EOF
  j_put "$J_HOME/bin/ovis-machine" 755 <<'EOF'
#!/bin/sh
# ovis-machine: the trial Ovis server's own command. add and status are the plugin's (ovis-server plugin), run against
# the trial server's state, config and port; stop and start go to its service. Another Ovis here is never reached.
L=$(cd "$(dirname "$0")/.." && pwd -L) || exit 2
# the join never makes a link in its folder: with one there (or the folder itself a link), nothing is read, written or
# signalled through it
if [ -L "$L" ]; then link=$L; else link=$(find "$L" -type l 2>/dev/null | sed -n 1p); fi
if [ -n "$link" ]; then
  printf 'Ovis: %s is a link, and the trial'"'"'s folder %s never holds one; nothing was changed, stopped or started\n' "$link" "$L" >&2
  printf '%s 는 링크입니다. 체험용 서버의 폴더(%s)에는 링크가 있을 수 없습니다. 아무것도 바꾸거나 멈추거나 시작하지 않았습니다.\n' "$link" "$L" >&2
  exit 14
fi
D=$(cd "$L" && pwd -P) || exit 2
# a clean environment: only these names of the login pass, so an OVIS_TOKEN, PORT or HOST exported there cannot reach
# the plugin's commands; the trial's own settings come from its config/env below
# the clean run is marked by a first argument of its own, not by anything a login could export
if [ "${1:-}" = --ovis-machine-clean ]; then
  shift
else
  # the kept NAME=value words are appended after the arguments, each one quoted whole; then the arguments are moved
  # behind them, so that env gets: the kept words, sh, this script, the arguments
  n=$#
  for name in LANG LC_ALL LC_CTYPE XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do
    eval "isset=\${$name+x} value=\${$name-}"
    [ -z "$isset" ] || set -- "$@" "$name=$value"
  done
  set -- "$@" sh "$0" --ovis-machine-clean
  i=0
  while [ "$i" -lt "$n" ]; do set -- "$@" "$1"; shift; i=$((i + 1)); done
  exec env -i HOME="$HOME" PATH="$PATH" SHELL="${SHELL:-/bin/sh}" TERM="${TERM:-dumb}" "$@"
fi
# the plugin's config and state folders are the trial's own: unset, it would read the env files of another Ovis plugin
# here (scripts/plugin.ts:72-76), and those files win over this process's environment (:172)
export HERDR_PLUGIN_STATE_DIR="$D/plugin-state" HERDR_PLUGIN_CONFIG_DIR="$D/config"
# the plugin's words name the command to run again by this: the trial's own command, by its absolute path
export OVIS_CLI_NAME="$D/bin/ovis-machine"
# the trial server's own settings, from the file it is started with
while IFS= read -r kv; do
  case ${kv%%=*} in PORT | OVIS_STATE_DIR | OVIS_PROFILE | OVIS_PREVIEW | OVIS_RUNTIME | HERDR_SOCKET | OVIS_RELAY_URL | OVIS_ACCOUNT_SERVICE_URL | OVIS_RELAY_APP_URL | OVIS_TELEMETRY | NODE_EXTRA_CA_CERTS) export "$kv" ;; esac
done <"$D/server.env"
service=$(sed -n 's/^service //p' "$D/trial")
case ${1:-status} in
  stop)
    if [ "$service" = systemd-user ]; then exec systemctl --user stop ovis-machine.service; fi
    # the background server is found and stopped as the undo does it (join.sh j_servers, j_stop_background)
    exec sh "$D/join.sh" --stop
    ;;
  start)
    if [ "$service" = systemd-user ]; then exec systemctl --user start ovis-machine.service; fi
    # running or not, found as stop and the undo find it (join.sh j_servers), not by its pid file
    if sh "$D/join.sh" --running; then echo "The trial Ovis server is running."; exit 0; fi
    setsid nohup sh "$D/serve.sh" >>"$D/logs/server.log" 2>&1 </dev/null &
    echo $! >"$D/run/server.pid"
    echo "The trial Ovis server is starting."
    ;;
  *) exec "$D/bin/ovis-server" plugin "$@" ;;
esac
EOF
}

j_start_systemd() {
  printf '%s\n' "$(j_missing_dirs "$j_unit_dir")" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    j_listed dir "$p" || j_note dir "$p"
    mkdir -m 700 "$p" || exit 1
  done || return 1
  # written as j_put writes: whatever is at that name first goes, a link included
  rm -f "$j_unit_dir/.$J_UNIT.new" || return 1
  {
    printf '%s\n' "$J_MARK"
    printf '[Unit]\nDescription=Ovis trial server (%s)\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\n' "$(printf '%s' "$J_HOME" | sed 's/%/%%/g')"
    # serve.sh, as the background start runs it: env -i with exactly server.env, so nothing of the user manager's own
    # environment reaches the server; it execs the server, which stays the unit's main process
    printf 'ExecStart='
    printf '%s\n' "/bin/sh${J_NL}$J_HOME/serve.sh" | while IFS= read -r word; do printf '%s ' "$(j_unit_word "$word")"; done
    j_unit_log=$(printf '%s' "$J_HOME/logs/server.log" | sed 's/%/%%/g')
    printf '\nStandardOutput=append:%s\nStandardError=append:%s\n' "$j_unit_log" "$j_unit_log"
    printf 'Restart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n'
  } >"$j_unit_dir/.$J_UNIT.new" || return 1
  j_listed unit "$j_unit_dir/$J_UNIT" || j_note unit "$j_unit_dir/$J_UNIT"
  mv -f "$j_unit_dir/.$J_UNIT.new" "$j_unit_dir/$J_UNIT" || return 1
# `systemctl enable` makes this folder for its link when it does not exist yet
  [ -d "$j_unit_dir/default.target.wants" ] || j_listed dir "$j_unit_dir/default.target.wants" || j_note dir "$j_unit_dir/default.target.wants"
  systemctl --user daemon-reload && systemctl --user enable "$J_UNIT" >/dev/null 2>&1 && systemctl --user restart "$J_UNIT" || return 1
  # lingering is turned on only after an explicit "no" (and the intent noted first, so an interruption right after
  # enable-linger still turns it off on rollback); an unknown state is left as it is, and nothing is noted
  # a reading counts only when loginctl exits 0: a failing one that still prints "no" is unknown
  j_linger=$(command -v loginctl >/dev/null 2>&1 && loginctl show-user "$j_user" -p Linger --value 2>/dev/null) || j_linger=""
  if [ "$j_linger" != yes ] && [ "$j_linger" != no ]; then
    say "Lingering was left as it is (its state could not be read): the trial server may stop when $j_user logs out."
  elif [ "$j_linger" = no ]; then
    j_note linger "$j_user"
    if loginctl enable-linger "$j_user" >/dev/null 2>&1; then
      say "Lingering is on for $j_user now, so the trial server runs without a login; the undo turns it off again."
    else
      say "Lingering could not be turned on: the trial server stops when $j_user logs out."
    fi
  fi
  return 0
}

j_start_background() {
  say "No service manager answers here (a container?): the trial server runs in the background and does not start again after a reboot; run the line again then."
  setsid nohup sh "$J_HOME/serve.sh" >>"$J_HOME/logs/server.log" 2>&1 </dev/null &
  echo $! >"$J_HOME/run/server.pid"
}

# j_probe_is: $probe is still the kit's server this join started for that check, as j_servers tells the trial server:
# of this account, its program the kit's server in the temporary folder, its command line `<that program> serve`. Its
# pid comes from $! and is never read again, but once the probe has ended (and the shell has reaped it) the pid may
# belong to another process: a pid that is not the probe is never signalled
j_probe_is() {
  [ -n "${probe:-}" ] || return 1
  [ "$(stat -c %u "/proc/$probe" 2>/dev/null)" = "$(id -u)" ] || return 1
  [ "$(readlink "/proc/$probe/exe" 2>/dev/null)" = "$(j_canonical "$j_stage/bin/ovis-server")" ] || return 1
  [ "$({ tr '\000' '\n' <"/proc/$probe/cmdline"; } 2>/dev/null)" = "$j_stage/bin/ovis-server${J_NL}serve" ]
}
# j_probe_state: sets j_run to what /proc/<pid>/stat says of $probe (so it holds without ps): running (a child of this
# shell that has not ended), ended (a zombie child of this shell, or no process with that pid: `wait` returns at once
# on either), or unknown (a process with that pid that /proc does not show as this shell's child: its stat could not
# be read, or /proc is another PID namespace's). The state and the parent are the first two fields after the program's
# name, which is in parentheses and may itself hold spaces or parentheses
j_probe_state() {
  j_run=ended
  if j_stat=$(cat "/proc/$probe/stat" 2>/dev/null); then
    j_stat=${j_stat##*") "}
    j_state=${j_stat%% *}
    j_stat=${j_stat#* }
    if [ "${j_stat%% *}" = "$$" ]; then
      [ "$j_state" = Z ] || j_run=running
      return 0
    fi
  fi
  ! kill -0 "$probe" 2>/dev/null || j_run=unknown
}
j_probe_running() { j_probe_state; [ "$j_run" = running ]; }
# j_look <pid> [program]: how to look at a process the join could not stop or could not tell, before stopping it by
# hand: stop it only if its program is <program>, else the kit's server of the check (a pid is never given with a
# command that signals it)
j_look() {
  if [ -n "${2:-}" ]; then printf 'look at it first: ps -o pid,user,args -p %s, or ls -l /proc/%s/exe, which shows its program; stop it only if that is %s' "$1" "$1" "$2"
  else printf 'look at it first: ps -o pid,user,args -p %s, or ls -l /proc/%s/exe, which shows its program ("(deleted)" once its temporary folder is gone); stop it only if it is the kit'"'"'s ovis-server serve' "$1" "$1"; fi
}
j_look_ko() {
  if [ -n "${2:-}" ]; then printf '먼저 확인하세요: ps -o pid,user,args -p %s 또는 ls -l /proc/%s/exe (그 프로그램을 보여 줍니다). 그 프로그램이 %s 일 때만 멈추세요' "$1" "$1" "$2"
  else printf '먼저 확인하세요: ps -o pid,user,args -p %s 또는 ls -l /proc/%s/exe (그 프로그램을 보여 주며, 임시 폴더가 지워졌으면 "(deleted)"가 붙습니다). 키트의 ovis-server serve 일 때만 멈추세요' "$1" "$1"; fi
}
j_probe_how() {
  if [ -z "$j_signalled" ]; then
    j_how="was not signalled, as the join could not tell that it is still the kit's server"
    j_how_ko="아직 키트의 서버인지 알 수 없어 신호를 보내지 않았습니다"
  elif [ "$j_run" = running ]; then
    j_how="did not end after $j_signalled" j_how_ko="보낸 신호($j_signalled) 뒤에도 끝나지 않았습니다"
  else
    j_how="could not be seen to end after $j_signalled" j_how_ko="보낸 신호($j_signalled) 뒤에 끝났는지 확인하지 못했습니다"
  fi
}
# j_probe_stop: ends the check of the kit's server, bounded, on every path (its end and an interruption): up to 1 s for a
# probe just started to become the kit's server (env execs it); then, only while it is the probe (j_probe_is), TERM, up
# to 5 s for it to end (it may ignore TERM), and KILL, which it cannot; then up to 2 s for it to be seen ended. `wait`
# runs only on a child seen ended (j_probe_state), where it returns at once: every wait here is bounded. False, with
# nothing waited for, when it was not seen ended then, running or unknown (j_run); one that is not the probe is never
# signalled, and j_signalled names what it was sent: TERM, TERM and KILL, or nothing. True once it has ended
j_probe_stop() {
  j_i=0
  j_signalled=""
  while ! j_probe_is && j_probe_running && [ "$j_i" -lt 5 ]; do j_pause 0.2; j_i=$((j_i + 1)); done
  if j_probe_is; then
    j_signalled=TERM
    kill -TERM "$probe" 2>/dev/null
    j_i=0
    while j_probe_is && [ "$j_i" -lt 25 ]; do j_pause 0.2; j_i=$((j_i + 1)); done
    if j_probe_is; then j_signalled="TERM and KILL"; kill -KILL "$probe" 2>/dev/null; fi
  fi
  j_i=0
  while j_probe_state; [ "$j_run" != ended ] && [ "$j_i" -lt 10 ]; do j_pause 0.2; j_i=$((j_i + 1)); done
  [ "$j_run" = ended ] || return 1
  wait "$probe" 2>/dev/null
  return 0
}
# The interlock, before anything is installed: the kit's server runs once from the temporary folder, with a home, a
# state folder and a herdr socket of that folder (so it writes nothing of this machine's and reaches no herdr), on a
# free port, and is stopped again. A server whose health names no machine profile is the plain server, which must not
# stay on this machine (it registers itself as the session's bridge and listens on the home network): refused.
# The state folder is not made here: the server makes it itself (the machine profile starts only on a folder that is
# absent, empty or already its own), and the health is read on the owner socket the profile makes there.
j_probe_profile() {
  [ "$j_plain_ok" != 1 ] || return 0
  probe_port=""
  taken=" $j_port $(j_listening | tr '\n' ' ') "
  for p in $J_PORTS; do case $taken in *" $p "*) ;; *) probe_port=$p; break ;; esac; done
  [ -n "$probe_port" ] || refuse 14 "ports $J_PORTS are all in use here; nothing was changed"
  mkdir -p "$j_stage/probe/home" || refuse 14 "the temporary folder cannot be filled; nothing was changed"
  probe_sock=$j_stage/probe/state/serve.sock
  # shellcheck disable=SC2086 # J_PROFILE_ENV and J_PREVIEW_ENV are one NAME=value word each
  env -i HOME="$j_stage/probe/home" PATH="$PATH" SHELL=/bin/sh $J_PROFILE_ENV $J_PREVIEW_ENV PORT="$probe_port" OVIS_STATE_DIR="$j_stage/probe/state" \
    OVIS_RUNTIME=herdr HERDR_SOCKET="$j_stage/probe/no-herdr.sock" OVIS_RELAY_URL="$j_relay" OVIS_ACCOUNT_SERVICE_URL="$j_account" \
    OVIS_RELAY_APP_URL="$j_app" OVIS_TELEMETRY=0 "$j_stage/bin/ovis-server" serve >"$j_stage/probe/log" 2>&1 </dev/null &
  probe=$!
  deadline=$(($(date +%s) + 60))
  answer=""
  while [ -z "$answer" ] && kill -0 "$probe" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
    # its port answering says it is up; its health, whatever its status (a server whose engine is not there answers it
    # with an error status, and its body still says whether it is the machine profile), comes from its owner socket.
    # The machine profile serves that socket before its port answers: a server whose port answers with no socket in its
    # state folder is not the machine profile, and nothing it says on its port is taken as its health
    if [ -n "$(j_local "$probe_port" /api/health)" ]; then
      if [ -S "$probe_sock" ]; then answer=$(j_owner "$probe_sock" /api/health); else answer="no owner socket"; fi
    fi
    [ -n "$answer" ] || j_pause 0.3
  done
  # a server that does not end is not left to run on unseen: the join stops here and names it
  if ! j_probe_stop; then
    j_probe_how
    printf 'Ovis: 확인용으로 한 번 실행한 이 키트의 서버(pid %s)는 %s. %s. 아무것도 바꾸지 않았습니다.\n' "$probe" "$j_how_ko" "$(j_look_ko "$probe")" >&2
    refuse 14 "this kit's server, started once for its check (pid $probe), $j_how; $(j_look "$probe"); nothing was changed"
  fi
  probe=""
  if [ -z "$answer" ]; then
    refusal=$(j_refusal "$j_stage/probe/log" 0)
    [ -z "$refusal" ] || refuse 35 "this kit's server, checked in a temporary folder under $(dirname "$j_stage"), refused to start: \"$refusal\" Run the line again with TMPDIR set to a folder only you can write; nothing was changed"
    tail -n 5 "$j_stage/probe/log" 2>/dev/null | sed 's/^/  server: /' >&2
    refuse 24 "this kit's server did not start here (no answer within 60 s; its last words are above); nothing was changed"
  fi
  printf '%s' "$answer" | grep -Eq "$J_PROFILE_HEALTH" \
    || refuse 29 "this kit's server is not built for a machine (its answer names no machine profile); nothing was changed: ask for a kit built for a machine"
}

# j_no_links: the join never makes a link in the trial folder, so a link there (or the folder itself a link) was put
# there by someone else, and anything written, read or signalled through it could reach another file or process. Run
# first by the join (a run again too) and the undo, as ovis-machine runs it first: refused before anything else, exit 14.
j_no_links() {
  if [ -L "$J_HOME" ]; then j_link=$J_HOME
  elif [ -d "$J_HOME" ]; then j_link=$(find "$J_HOME" -type l 2>/dev/null | sed -n 1p)
  else j_link=""; fi
  [ -z "$j_link" ] && return 0
  printf 'Ovis: %s is a link, and the trial'"'"'s folder %s never holds one; nothing was changed, stopped or removed: look at it, then remove %s yourself\n' "$j_link" "$J_HOME" "$J_HOME" >&2
  printf '%s 는 링크입니다. 체험용 서버의 폴더(%s)에는 링크가 있을 수 없습니다. 아무것도 바꾸거나 멈추거나 지우지 않았습니다: 확인한 뒤 %s 를 직접 지우세요.\n' "$j_link" "$J_HOME" "$J_HOME" >&2
  exit 14
}

j_stop_mode() {
  j_no_links
  if [ -z "$(j_servers)" ]; then say "The trial Ovis server is not running."; exit 0; fi
  j_stop_background || { printf 'The trial Ovis server (pid %s) did not end; it may still be running.\n' "$pid" >&2; exit 1; }
  say "The trial Ovis server is stopped."
  exit 0
}

j_uninstall() {
  j_no_links
  if [ ! -f "$J_HOME/receipt" ]; then
    say "The Ovis trial is not installed for $(id -un) on this machine (no receipt in $J_HOME); nothing was changed."
    say "이 머신의 $(id -un) 계정에는 Ovis 체험이 설치되어 있지 않습니다. 아무것도 바꾸지 않았습니다."
    exit 0
  fi
  service=""
  # the trial's record is read only when it is not a link
  [ -L "$J_HOME/trial" ] || service=$(sed -n 's/^service //p' "$J_HOME/trial" 2>/dev/null)
  # whether the trial server was in an Ovis account: its own answer on its owner socket, while it still runs (j_no_links
  # has refused any link in the trial folder)
  # an answer counts only when curl ended well and it is whole (j_account_of), as for the join's own reads
  status=$(j_owner -f "$J_HOME/state/serve.sock" /api/account/status) || status=""
  account_was=$(j_account_of "$status")
  case $account_was in '') account=unknown ;; null) account=none ;; *) account=listed ;; esac
  account_id=$(j_short "$account_was")
  linger=$(sed -n 's/^linger //p' "$J_HOME/receipt")
  j_remove
  case $? in
    0) ;;
    4) refuse 14 "the service manager of $(id -un) could not be reached, or $J_UNIT did not stop; nothing was removed: run the undo again from a login of $(id -un) (not through su or sudo)" ;;
    2) refuse 14 "$J_HOME/receipt, or the unit $(j_unit_path), was not written by this join as it is now; nothing was removed or stopped: look at both, then remove what is yours yourself" ;;
    3) refuse 14 "the trial server was stopped and its service removed, but its folder $J_HOME could not be removed entirely (left there: $(find "$J_HOME" 2>/dev/null | sed -n '2,4p' | tr '\n' ' ')...): remove what is left yourself" ;;
    *)
      printf 'Ovis: 체험용 서버(pid %s)가 끝나지 않아 아무것도 지우지 않았습니다. %s. 그다음 되돌리기를 다시 실행하세요.\n' "$pid" "$(j_look_ko "$pid" "$J_HOME/bin/ovis-server")" >&2
      refuse 14 "the trial server (pid $pid) did not end; nothing was removed: $(j_look "$pid" "$J_HOME/bin/ovis-server"), then run the undo again" ;;
  esac
  j_linger_ko=""
  if [ -n "$j_linger_left" ]; then j_linger_ko=" $j_linger_left 계정의 lingering은 끄지 못했습니다: loginctl disable-linger $j_linger_left 로 직접 끄세요."
  elif [ -n "$linger" ]; then j_linger_ko=" $linger 계정의 lingering도 다시 껐습니다."; fi
  say "Removed the Ovis trial from this machine:"
  if [ "$service" = systemd-user ]; then say "- stopped the trial server and removed its service ($J_UNIT)"; else say "- stopped the trial server (it ran in the background)"; fi
  say "- removed its folder $J_HOME: its programs, its identity and its state"
  if [ -n "$j_linger_left" ]; then say "- could not turn lingering off for $j_linger_left: turn it off with  loginctl disable-linger $j_linger_left"
  elif [ -n "$linger" ]; then say "- turned lingering off again for $linger"; fi
  say "herdr and its terminals were left as they were."
  case $account in
    listed) say "This machine was in the Ovis account $account_id. The account's list may still name it, and nothing on this machine can take it off that list today: the Ovis guide says how such an entry goes (docs/guide.md, section \"Through an account\")." ;;
    none) say "The trial server had not finished joining an Ovis account (no device had scanned its QR code). If the add said this machine is listed in your account, the account's list may still name it: the Ovis guide says how such an entry goes (docs/guide.md, section \"Through an account\")." ;;
    *) say "Whether your Ovis account names this machine could not be asked (the trial server did not answer). The account's list may still name it: the Ovis guide says how such an entry goes (docs/guide.md, section \"Through an account\")." ;;
  esac
  say ""
  say "이 머신에서 Ovis 체험을 지웠습니다: 체험용 서버를 멈추고 그 서비스와 폴더($J_HOME: 프로그램, 신원, 상태)를 지웠습니다.${j_linger_ko}"
  say "herdr와 그 터미널은 그대로 두었습니다."
  case $account in
    listed) say "이 머신은 Ovis 계정 $account_id 에 들어 있었습니다. 계정의 목록에는 아직 남아 있을 수 있으며, 지금은 이 머신에서 목록에서 뺄 방법이 없습니다. 그런 항목이 어떻게 되는지는 Ovis 안내서에 있습니다(docs/guide.md, \"Through an account\" 절)." ;;
    none) say "체험용 서버는 Ovis 계정에 다 들어가지 않았습니다(QR 코드를 스캔한 기기가 없음). 추가 중에 이 머신이 계정 목록에 올랐다고 나왔다면 목록에는 아직 남아 있을 수 있습니다. 그런 항목이 어떻게 되는지는 Ovis 안내서에 있습니다(docs/guide.md, \"Through an account\" 절)." ;;
    *) say "내 Ovis 계정 목록에 이 머신이 있는지는 확인하지 못했습니다(체험용 서버가 답하지 않음). 목록에는 아직 남아 있을 수 있습니다. 그런 항목이 어떻게 되는지는 Ovis 안내서에 있습니다(docs/guide.md, \"Through an account\" 절)." ;;
  esac
  exit 0
}

J_PROFILE_ENV=OVIS_PROFILE=machine
# the machine profile is a preview (server/preview.ts): a server refuses to start it without this beside it
J_PREVIEW_ENV=OVIS_PREVIEW=fleet
J_PROFILE_HEALTH='"machine_profile"[[:space:]]*:[[:space:]]*[{]'
# the start of its health's reason when it will not use the selected herdr socket: a folder on the socket's path that
# another account could change, which the rest of the reason names (server/machine-profile.ts unsafeSocket)
J_HERDR_REFUSED="The selected herdr socket cannot be used safely by this account"
# A TEST SWITCH for containers only, never offered to a person: a kit whose server is the plain one (built from a commit
# without the machine profile) is let through instead of refused.
# the test switches, honoured only for a kit made for the tests (j_kit_list)
j_plain_ok=0
j_add_done=0

j_kit="" j_sums="" j_relay="" j_account="" j_app="" j_want_session="" j_want_port="" j_yes=0 j_mode=join j_trial=0
J_USAGE="usage: sh join.sh --kit <https:// or file:// address> --sums <sha256 of SHA256SUMS> --relay <wss://...> --account <https://...> --app <https://...> --trial [--session <name>] [--port <n>] [--yes] | sh join.sh --uninstall"
while [ $# -gt 0 ]; do
  case $1 in
    --kit | --sums | --relay | --account | --app | --session | --port)
      [ $# -ge 2 ] || refuse 2 "$1 takes a value; $J_USAGE"
      case $1 in
        --kit) j_kit=$2 ;; --sums) j_sums=$2 ;; --relay) j_relay=$2 ;; --account) j_account=$2 ;; --app) j_app=$2 ;;
        --session) j_want_session=$2 ;; --port) j_want_port=$2 ;;
      esac
      shift 2
      ;;
    --yes) j_yes=1; shift ;;
    --trial) j_trial=1; shift ;;
    --uninstall) j_mode=uninstall; shift ;;
    --stop) j_mode=stop; shift ;;
    --running) j_mode=running; shift ;;
    *) refuse 2 "does not know '$1'; $J_USAGE" ;;
  esac
done

# a trial kit joins only when the line says --trial: a later join of the product reuses an Ovis already on the machine,
# which here would add that Ovis to the TEST account. The undo needs no --trial
if [ "$j_mode" = join ] && [ "$j_trial" != 1 ]; then
  printf 'Ovis: this kit is a trial kit: run it with --trial (the line you were given carries it); nothing was changed\n' >&2
  printf '이 키트는 체험용입니다: --trial 을 붙여 실행하세요(받은 줄에 들어 있습니다). 아무것도 바꾸지 않았습니다.\n' >&2
  exit 31
fi
[ "$(id -u)" != 0 ] || refuse 28 "run this as the account that runs herdr, not as root; nothing was changed"
[ "$j_mode" != uninstall ] || j_uninstall
[ "$j_mode" != stop ] || j_stop_mode
if [ "$j_mode" = running ]; then j_no_links; [ -n "$(j_servers)" ]; exit; fi
j_no_links

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) ;;
  *) refuse 17 "this trial kit runs on Linux x64 only; this is $(uname -s) $(uname -m); nothing was changed" ;;
esac
while :; do case $j_kit in */) j_kit=${j_kit%/} ;; *) break ;; esac; done
case $j_kit in https://?* | file:///*) ;; *) refuse 2 "--kit takes an https:// address or a file:// folder; $J_USAGE" ;; esac
printf '%s\n' "$j_sums" | grep -Eqx '[0-9a-f]{64}' || refuse 2 "--sums takes the SHA-256 of the kit's SHA256SUMS (64 hex digits); $J_USAGE"
case $j_relay in wss://?*) ;; *) refuse 2 "--relay takes the wss:// address of the test relay; $J_USAGE" ;; esac
case $j_account in https://?*) ;; *) refuse 2 "--account takes the https:// address of the test account service; $J_USAGE" ;; esac
case $j_app in https://?*) ;; *) refuse 2 "--app takes the https:// address of the test app; $J_USAGE" ;; esac
case $j_want_session in '' | default) ;; *[!A-Za-z0-9_.-]* | . | ..) refuse 2 "--session takes the name of a running herdr session (default for the unnamed one)" ;; esac
case $j_want_port in '') ;; *[!0-9]* | 0*) refuse 2 "--port takes a port number (digits, no leading zero)" ;; *) [ "$j_want_port" -ge 1024 ] && [ "$j_want_port" -le 65535 ] || refuse 2 "--port takes a port from 1024 to 65535" ;; esac
for tool in curl sha256sum mktemp awk; do command -v "$tool" >/dev/null 2>&1 || refuse 14 "$tool is needed here and was not found; nothing was changed"; done

j_fresh=1
[ -f "$J_HOME/receipt" ] && j_fresh=0
# j_touched: a run again has begun to change the earlier install (its server stopped first); j_add_began: the add has
# been started, so a device may have put this machine in an account
j_touched=0 j_add_began=0
# a folder is taken as an earlier join's only when its receipt and unit check out as the undo checks them
if [ "$j_fresh" = 0 ]; then j_receipt_ok; else [ ! -e "$J_HOME" ]; fi \
  || refuse 14 "$J_HOME exists but was not made by this join: move it away, then run the line again; nothing was changed"

j_user=$(id -un)
if j_systemd_user; then
  j_services=systemd-user
  # the folder the user manager reads units from: its own XDG_CONFIG_HOME, else ~/.config
  j_manager_config=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^XDG_CONFIG_HOME=//p' | sed -n 1p)
  case $j_manager_config in /*) ;; *) j_manager_config=$HOME/.config ;; esac
  j_unit_dir=$j_manager_config/systemd/user
  if [ -e "$j_unit_dir/$J_UNIT" ] && ! j_listed unit "$j_unit_dir/$J_UNIT"; then
    refuse 14 "a service $J_UNIT exists that this join did not write; nothing was changed"
  fi
else
  j_services=background
fi

j_choose
j_herdr_version
j_own_ovis
j_choose_port
j_kit_list
if [ "${OVIS_JOIN_TEST_PLAIN_SERVER:-}" = 1 ] || [ "${OVIS_JOIN_TEST_ADD_DONE:-}" = 1 ]; then
  if [ "$j_test_kit" = 1 ]; then
    [ "${OVIS_JOIN_TEST_PLAIN_SERVER:-}" != 1 ] || j_plain_ok=1
    [ "${OVIS_JOIN_TEST_ADD_DONE:-}" != 1 ] || [ "$j_plain_ok" != 1 ] || j_add_done=1
  else
    say "OVIS_JOIN_TEST_PLAIN_SERVER or OVIS_JOIN_TEST_ADD_DONE is set, but this kit was not made for tests (it carries no TEST-KIT): both are ignored."
  fi
fi
j_consent
# from the yes on, Ctrl+C, TERM or HUP rolls back as a refusal does, and says what is left (the undo line, if anything
# is). After a HUP there may be no terminal left: the roll back comes first, and a write that fails changes nothing.
# A second Ctrl+C or TERM is ignored, as a HUP is: the roll back is bounded, and cut midway it would leave a folder
# without its receipt
j_interrupted() {
  trap '' INT TERM HUP PIPE
  if [ -n "${probe:-}" ]; then
    if ! j_probe_stop; then
      j_probe_how
      printf 'Ovis: 중단되었습니다. 확인용으로 한 번 실행한 이 키트의 서버(pid %s)는 %s. %s.\n' "$probe" "$j_how_ko" "$(j_look_ko "$probe")" >&2
      printf 'Ovis: interrupted; the check of the kit'"'"'s server (pid %s) %s; %s\n' "$probe" "$j_how" "$(j_look "$probe")" >&2
      exit "$1"
    fi
    probe=""
  fi
  printf 'Ovis: interrupted; %s\n' "$(j_rolled_back)" >&2
  # from the add on, a device may have put this machine in an account, whose list nothing here reaches (as the undo says)
  if [ "$j_add_began" = 1 ]; then
    printf '%s\n' "If the add already listed this machine, your account may still show it; see docs/guide.md \"Through an account\"." >&2
    printf '%s\n' "추가 중에 이 머신이 계정 목록에 올라갔다면 목록에 남아 있을 수 있습니다. docs/guide.md \"Through an account\"를 보세요." >&2
  fi
  exit "$1"
}
trap 'j_interrupted 130' INT
trap 'j_interrupted 143' TERM
trap 'j_interrupted 129' HUP

j_kit_fetch
j_probe_profile
# the trial's state folder never resolves (through any link) to an Ovis default folder or into one: a server started on
# such a folder answers with that Ovis's relay key, and that Ovis loses its relay link. The machine profile refuses this
# itself (server/machine-profile.ts claimServerState); this is the second lock, before anything is written or stopped
j_state=$J_HOME/state
for j_default in "${XDG_CONFIG_HOME:-$HOME/.config}/ovis" "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-web-ui" "$HOME/.config/ovis" "$HOME/.config/herdr-web-ui"; do
  j_default_real=$(realpath -m -- "$j_default" 2>/dev/null || printf '%s' "$j_default")
  case "$(realpath -m -- "$j_state" 2>/dev/null || printf '%s' "$j_state")/" in
    "$j_default_real"/*)
      printf 'Ovis: the trial'"'"'s state folder %s leads into the folder of an Ovis of this machine (%s); nothing was changed: move it away, then run the line again\n' "$j_state" "$j_default" >&2
      printf '체험용 서버의 상태 폴더 %s 가 이 머신의 Ovis 폴더(%s)로 이어집니다. 아무것도 바꾸지 않았습니다: 그 폴더를 옮긴 뒤 이 줄을 다시 실행하세요.\n' "$j_state" "$j_default" >&2
      exit 33 ;;
  esac
done

if [ "$j_fresh" = 1 ]; then
  made=$(j_missing_dirs "$(dirname "$J_HOME")")
  # the folders and the receipt that lists them are made with Ctrl+C, TERM and HUP held: an end in between would leave a
  # folder no receipt lists, which the roll back cannot see and a run again refuses. The commands that make them ignore
  # the signal; the first one is noted here and acted on once the receipt lists them. The lists are read from a here-
  # document, not a pipe, so no process that feeds them can be ended by the signal
  j_held=""
  trap 'j_held=${j_held:-130}' INT
  trap 'j_held=${j_held:-143}' TERM
  trap 'j_held=${j_held:-129}' HUP
  ( trap '' INT TERM HUP; while IFS= read -r p; do [ -n "$p" ] || continue; mkdir -m 700 "$p" || exit 1; done ) <<EOF \
    || refuse 14 "a parent of $J_HOME cannot be made; nothing was changed"
$made
EOF
  ( trap '' INT TERM HUP; mkdir -m 700 "$J_HOME" && : >"$J_HOME/receipt" ) || refuse 14 "$J_HOME cannot be made; nothing was changed"
  j_note home "$J_HOME"
  # in this shell: j_note is printf, so nothing here starts a process
  while IFS= read -r p; do [ -n "$p" ] && j_note dir "$p"; done <<EOF
$made
EOF
  trap 'j_interrupted 130' INT
  trap 'j_interrupted 143' TERM
  trap 'j_interrupted 129' HUP
  [ -z "$j_held" ] || j_interrupted "$j_held"
else
  j_touched=1
  j_halt || refuse 14 "the trial server of the previous run could not be seen stopped and its service disabled: stop it, then run the line again"
  ! j_port_taken "$j_port" || refuse 14 "port $j_port is in use by another program, so the trial server, now stopped, cannot take it again: free it or choose another with --port <n>, then run the line again"
fi
j_put "$J_HOME/join.sh" 700 <"$j_stage/join.sh" || { j_rollback; refuse 14 "the undo command cannot be written into $J_HOME"; }
# not the state folder: the trial server makes it at its first start (the machine profile starts only on a folder that
# is absent, empty or already its own), and nothing of the join is ever written in it
mkdir -p "$J_HOME/bin/bin" "$J_HOME/config" "$J_HOME/plugin-state" "$J_HOME/run" "$J_HOME/logs" \
  || { j_rollback; refuse 14 "$J_HOME cannot be filled"; }
for name in bin/ovis-server bin/bin/ovis-pty-sidecar bin/bin/ovis-pty-sidecar.json; do
  case $name in *.json) mode=600 ;; *) mode=755 ;; esac
  # the copy's SHA-256 (sha256sum, checked for above; not cmp, which some minimal systems lack), read from stdin so its
  # path cannot change the output, against the sum SHA256SUMS lists for it, which is never empty: a sha256sum that
  # fails gives nothing, which matches no sum
  j_put "$J_HOME/$name" "$mode" <"$j_stage/$name" && [ "$(sha256sum <"$J_HOME/$name" | cut -c1-64)" = "$(j_kit_sum "$name")" ] \
    || { j_rollback; refuse 14 "the kit's programs cannot be copied into $J_HOME"; }
done
rm -rf "$j_stage"
j_stage=""
j_service || refuse 2 "a path or setting of this machine holds a line break, a quote or a backslash, which the trial server's settings file cannot hold; $(j_rolled_back)"
j_write_files || { j_rollback; refuse 14 "the trial server's files cannot be written into $J_HOME"; }


# in braces: a redirection fails before 2>/dev/null applies, so a missing log's error is silenced only this way
j_log_from=$({ wc -c <"$J_HOME/logs/server.log"; } 2>/dev/null) || j_log_from=0
if [ "$j_services" = systemd-user ]; then
  j_start_systemd || refuse 14 "systemctl --user could not start $J_UNIT; $(j_rolled_back)"
else
  j_start_background
fi

j_deadline=$(($(date +%s) + 90))
j_terminals=none
while :; do
  # its port says it is alive (the machine profile answers only that there)
  health=$(j_local -f "$j_port" /api/health)
  if [ -z "$health" ]; then
    j_refused=$(j_refusal "$J_HOME/logs/server.log" "$j_log_from")
    [ -z "$j_refused" ] || { j_terminals=refused; break; }
  fi
  # an answer counts only from the trial's own process: the program listening on the port is its ovis-server
  if [ -n "$health" ] && [ "$(j_port_exe "$j_port")" != "$J_HOME/bin/ovis-server" ]; then j_terminals=foreign; break; fi
  # the interlock: a server whose port answers with no owner socket in its state folder (the machine profile serves that
  # socket before its port answers), or whose health does not name the machine profile, is the plain server, which must
  # not stay
  if [ -n "$health" ] && [ "$j_plain_ok" != 1 ] && [ ! -S "$j_state/serve.sock" ]; then j_terminals=plain; break; fi
  # what it says beyond its liveness, from its owner socket
  [ -z "$health" ] || health=$(j_read -f /api/health)
  if [ -n "$health" ] && [ "$j_plain_ok" != 1 ]; then
    printf '%s' "$health" | grep -Eq "$J_PROFILE_HEALTH" || { j_terminals=plain; break; }
  fi
  case $health in *'"terminal_attach":true'*) j_terminals=live; break ;; *'"terminal_attach":false'*) j_terminals=mirrored ;; esac
  # its engine down, and why: the herdr socket refused (a folder another account could change, which waiting does not
  # change), or herdr not answering it (yet)
  j_why=$(j_reason "$health")
  case $j_why in "$J_HERDR_REFUSED"*) j_terminals=herdr-refused; break ;; ?*) j_terminals=herdr-down ;; esac
  [ "$(date +%s)" -lt "$j_deadline" ] || break
  j_pause 0.5
done
case $j_terminals in
  live) say "The trial server answers on 127.0.0.1:$j_port and attaches the terminals of herdr session $j_session." ;;
  plain) refuse 29 "this kit's server is not built for a machine (its answer names no machine profile); $(j_rolled_back): ask for a kit built for a machine" ;;
  foreign) refuse 14 "another program answers on 127.0.0.1:$j_port, not the trial server; $(j_rolled_back)" ;;
  mirrored) refuse 24 "the trial server answers but does not attach terminals (its terminal host did not start); $(j_rolled_back)" ;;
  refused) refuse 35 "the trial server refused to start here, in its words: \"$j_refused\"; $(j_rolled_back)" ;;
  herdr-refused) refuse 36 "the trial server will not use herdr session $j_session, in its words: \"$j_why\". Remove group and other write from the folder it names (chmod go-w <folder>), or run herdr where only you can write, then run the line again; $(j_rolled_back)" ;;
  herdr-down) refuse 26 "the trial server runs, but herdr session $j_session did not answer it within 90 s (\"$j_why\"); $(j_rolled_back)" ;;
  *) refuse 24 "the trial server did not answer on 127.0.0.1:$j_port within 90 s; $(j_rolled_back)" ;;
esac

say ""
say "Add this machine to your account / 이 머신을 내 계정에 추가"
j_added=0
# a test kit only: OVIS_JOIN_TEST_ADD_DONE=1 counts the add as done without a device (the gate check after it is the test)
# Ctrl+C during the add ends the add only (it ends its code or its QR code itself): the join then goes on as after an
# add that did not finish (below): removed when the trial server names an account it did not name before (exit 37), kept
# in the account it named before (38) or read as none (30) only with its pairing gate closed, else stopped (exit 34, or
# 39 when its account could not be read after the add, or before it on a run again). From the add's return on, Ctrl+C rolls back again
# the trial server's account before the add: exit 0 only when it named none before and one after, as after a sign-in
# of this run (an add that finds the machine already in an account returns without a sign-in); even then the account
# is named, never called yours. Empty when no try answered: unknown, never taken for none
j_account_read
j_before=$j_got
j_add_began=1
trap ':' INT
if [ "$j_add_done" = 1 ]; then j_added=1; else "$J_HOME/bin/ovis-machine" add && j_added=1; fi
trap 'j_interrupted 130' INT
say ""
# j_gate_closed: with the relay on (the add turns it on, even when it then fails), the pairing gate must be closed: no
# device gets in without the account's approval. Read a few times: one failed read must not stop a working server for a
# gate nobody saw open. True when it reads closed, or under the plain-server test switch when the health names none.
j_gate_closed() {
  say "Reading the trial server's pairing gate..."
  j_gate=""
  for j_try in 1 2 3 4 5; do
    j_gate=$(j_read /api/health | grep -Eo '"pairing_gate"[[:space:]]*:[[:space:]]*"[a-z]*"' | sed 's/.*"\([a-z]*\)"$/\1/')
    [ -z "$j_gate" ] || break
    j_pause 1
  done
  [ "$j_gate" != closed ] || return 0
  if [ "$j_plain_ok" = 1 ] && [ -z "$j_gate" ]; then
    say "Test switch: this server's health names no pairing gate, so the gate was not checked."
    return 0
  fi
  return 1
}
# j_gate_open <done|returned|unfinished>: the gate not closed fails closed: the server is stopped first, and said stopped
# only once seen stopped; exit 34. After an add that put it in an account (done) that account is named, never called
# yours; otherwise nothing is said about an account
j_gate_open() {
  if [ -n "$j_gate" ]; then
    j_why_en="the trial server's pairing gate is $j_gate, not closed: devices could pair with it without your account's approval"
    j_why_ko="체험용 서버의 페어링 관문이 닫혀 있지 않아($j_gate)"
  else
    j_why_en="the trial server's pairing gate could not be read (no answer in 5 tries), so it may be open"
    j_why_ko="체험용 서버의 페어링 관문을 읽지 못해(5번 시도, 열려 있을 수 있음)"
  fi
  case $1 in
    done) j_lead_en="The machine is in the Ovis account $(j_short "$j_after") now, but" j_lead_ko="기기가 지금 Ovis 계정 $(j_short "$j_after") 에 들어 있지만" ;;
    returned) j_lead_en="The add returned, and" j_lead_ko="추가는 끝났고" ;;
    *) j_lead_en="The add did not finish, and" j_lead_ko="추가가 끝나지 않았고" ;;
  esac
  if j_halt; then
    say "$j_lead_en $j_why_en, so the trial server was stopped. Undo the join: $(j_undo_line)"
    say "$j_lead_ko $j_why_ko 체험용 서버를 멈췄습니다. 모두 되돌리려면: $(j_undo_line)"
  else
    say "$j_lead_en $j_why_en, and the trial server could not be seen stopped: stop it now: $(j_stop_line)"
    say "$j_lead_ko $j_why_ko 체험용 서버가 멈춘 것을 확인하지 못했습니다. 지금 멈추세요: $(j_stop_line)"
  fi
  exit 34
}
# j_in_account <account> <why, English> <why, Korean>: the machine is kept in an account no sign-in of this run is known to
# have put it in: named, never "your", with the undo line; exit 38. Its pairing gate was read closed first
j_in_account() {
  say "The trial Ovis server runs, and this machine is in the Ovis account $(j_short "$1"): $2. If that is not your account, undo the join: $(j_undo_line)"
  say "체험용 Ovis 서버는 실행 중이며 이 머신은 Ovis 계정 $(j_short "$1") 에 들어 있습니다: $3. 내 계정이 아니면 되돌리세요: $(j_undo_line)"
  exit 38
}
if [ "$j_added" = 1 ]; then
  j_account_read
  j_after=$j_got
  j_mine=0
  [ "$j_before" != null ] || [ -z "$j_after" ] || [ "$j_after" = null ] || j_mine=1
  if [ "$j_mine" = 1 ]; then j_gate_closed || j_gate_open done; else j_gate_closed || j_gate_open returned; fi
  if [ "$j_mine" = 1 ]; then
    # named, not called yours: a pairing that raced this run's add looks the same from here
    say "Done: this machine runs the trial Ovis server and is in the Ovis account $(j_short "$j_after") now; on your phone, open it under PCs or Overview in the Ovis app. If that is not your account, undo the join: $(j_undo_line)"
    say "완료: 이 머신에서 체험용 Ovis 서버가 실행 중이며 지금 Ovis 계정 $(j_short "$j_after") 에 들어 있습니다. 휴대폰의 Ovis 앱에서 PC 또는 개요를 열고 이 머신을 고르세요. 내 계정이 아니면 되돌리세요: $(j_undo_line)"
    exit 0
  fi
  if [ -n "$j_after" ] && [ "$j_after" != null ]; then
    if [ "$j_before" = "$j_after" ]; then j_in_account "$j_after" "it was in that account before this run" "이번 실행 전부터 그 계정에 들어 있었습니다"
    else j_in_account "$j_after" "the join could not confirm that a sign-in of this run put it there" "이번 실행의 로그인으로 들어갔는지 확인하지 못했습니다"; fi
  fi
  if [ "$j_after" = null ]; then j_none_en="the trial Ovis server names no account" j_none_ko="체험용 Ovis 서버가 계정을 밝히지 않아"
  else j_none_en="the trial Ovis server's account could not be read" j_none_ko="체험용 Ovis 서버의 계정을 읽지 못해"; fi
  say "The add returned, but $j_none_en, so it could not tell whether the machine is listed in your Ovis account; check with:  $J_HOME/bin/ovis-machine status"
  say "Undo the whole join with:  $(j_undo_line)"
  say "추가는 끝났지만 $j_none_ko, 이 머신이 내 Ovis 계정 목록에 올라 있는지 알 수 없습니다. $J_HOME/bin/ovis-machine status 로 확인하거나 되돌리세요."
  exit 30
fi
# where the machine stands after an add that did not finish (its return is the path above), from the trial server itself
# (this machine's own, on its owner socket): an account it names means a device paired with it through an add that did
# not finish: removed, on a run again too (exit 37), unless it is the account named before this run's add (kept, exit 38)
# or, on a run again, the account before the add could not be read (stopped and kept, exit 39). No account (null):
# "could not tell", with the server kept for `ovis-machine add` while its pairing gate is closed. No answer: stopped
# first, the install kept for the undo (exit 39)
# j_kept_stopped <what could not be read>: exit 39: the trial server is stopped first, and the install kept for the undo
j_kept_stopped() {
  if j_halt; then refuse 39 "$1, so the trial server was stopped; the install stays for the undo: $(j_undo_line)"
  else refuse 39 "$1; the trial server could not be seen stopped: stop it now: $(j_stop_line)"; fi
}
j_account_read
j_named=$j_got
case $j_named in
  '') j_kept_stopped "the add did not finish, and the trial server's account could not be read" ;;
  null)
    # kept only with its pairing gate closed: the add may have turned the relay on before it ended
    j_gate_closed || j_gate_open unfinished
    say "The trial Ovis server runs on this machine, but it could not tell whether the machine is listed in your Ovis account; check with:  $J_HOME/bin/ovis-machine status"
    say "Add it with:  $J_HOME/bin/ovis-machine add      (or undo the whole join: $(j_undo_line))"
    say "체험용 Ovis 서버는 실행 중이지만, 이 머신이 내 Ovis 계정 목록에 올라 있는지 알 수 없습니다. $J_HOME/bin/ovis-machine status 로 확인하고, 위 명령으로 추가하거나 되돌리세요."
    ;;
  "$j_before")
    # the account it named before this run's add, unchanged: the earlier install is kept as after an add that returned
    # in an account it already had (exit 38), only with its pairing gate closed
    j_gate_closed || j_gate_open unfinished
    j_in_account "$j_named" "it was in that account before this run, and this run's add did not finish" "이번 실행 전부터 그 계정에 들어 있었고, 이번 실행의 추가는 끝나지 않았습니다"
    ;;
  *)
    # a run again whose read before the add got no answer: the account named now may be the one this install was in
    # before, and nothing says otherwise, so it is stopped and kept, never removed (exit 39). Only a read that answered
    # null proves that removing loses no account's machine, just an identity in no account
    if [ "$j_fresh" = 0 ] && [ -z "$j_before" ]; then
      say "체험용 서버가 지금 Ovis 계정 $(j_short "$j_named") 을 밝히지만, 추가 전에는 계정을 읽지 못해 이 설치가 전부터 그 계정에 들어 있었는지 알 수 없어, 설치를 지우지 않고 체험용 서버를 멈춥니다(되돌리기: $(j_undo_line))."
      j_kept_stopped "the add did not finish; the trial server names the Ovis account $(j_short "$j_named") now, but its account could not be read before this run's add (5 tries), so the join cannot tell whether this install was in that account before"
    fi
    # the add failed while a device's pairing put the trial server in an account it did not name before this run's add
    # (none, or another, or on a fresh install one that could not be read): which account, the join cannot confirm (the
    # add's own words above say what it saw), so neither the server nor its install stays
    say "체험용 서버가 Ovis 계정($(j_short "$j_named"))에 들어갔지만 추가가 끝나지 않아, 그 계정이 내 계정인지 확인할 수 없습니다. 체험용 서버를 멈추고 되돌립니다."
    say "That account's list may still name this machine, and nothing on this machine can take it off that list today: the Ovis guide says how such an entry goes (docs/guide.md, section \"Through an account\")."
    say "그 계정의 목록에는 이 머신이 아직 남아 있을 수 있으며, 지금은 이 머신에서 목록에서 뺄 방법이 없습니다. 그런 항목이 어떻게 되는지는 Ovis 안내서에 있습니다(docs/guide.md, \"Through an account\" 절)."
    refuse 37 "the add did not finish, but the trial server names an Ovis account ($(j_short "$j_named")), which the join cannot confirm is the one you signed in to (the add's words above say what it saw), so neither the trial server nor its install stays; $(j_rolled_back all)"
    ;;
esac
exit 30
