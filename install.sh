#!/bin/sh
# Ovis in one line, from a PC that may have none of it yet:
#
#   curl -fsSL https://ovis.sh/install.sh | sh
#
# 1. Installs what is missing, for this user only and without sudo: herdr (its own installer, into
#    ~/.local/bin) and Bun (its own installer, into ~/.bun). Terminals run on the release's Rust PTY
#    host, checked against its SHA-256; only when that cannot be installed, Node 22 (the official
#    build, checked against its published SHA-256, into ~/.local/share/ovis/node) runs them instead.
# 2. Installs Ovis as a herdr plugin, so it starts with herdr and Settings → Updates keeps it
#    current, and starts it now when herdr is running.
# 3. When Tailscale runs on this PC, serves the app to your tailnet (`tailscale serve`, on the first
#    free HTTPS port, or only the one OVIS_TAILSCALE_HTTPS_PORT names) and prints the address
#    a phone opens as a QR code (scripts/plugin.ts phone).
# 4. On a first install, mentions a GitHub star once. When the gh CLI is signed in and has not
#    starred the repository, it asks at the terminal, for 20 seconds, and stars only on "y"; it
#    never stars by itself.
#
#
# On a PC with herdr-core (hc, the core the Herdr app runs on) and no herdr, steps 1 and 2 are instead:
# Bun only, and Ovis in its own checkout (~/.local/share/ovis/app), built as herdr builds the plugin and
# started on herdr-core (OVIS_RUNTIME=herdr-core) as a user service that starts again at login
# (systemd's on Linux, launchd's on macOS). Settings → Updates keeps it current too.
#
# Run it again at any time: what is already there is kept, and step 3 is repeated.
#   OVIS_REF=<branch or tag>   install that ref instead of the latest release
#   OVIS_RUNTIME=herdr|herdr-core   pick the runtime instead of going by what is installed
#   OVIS_TAILSCALE_HTTPS_PORT=<port>   serve the app on that HTTPS port only, keeping 443 free
set -eu

REPO="devswha/ovis"
PLUGIN="devswha.ovis"
# the id before the rename: an install under it moves to PLUGIN, keeping its config
LEGACY_PLUGIN="devswha.herdr-web-ui"
BIN_DIR="$HOME/.local/bin"
NODE_DIR="$HOME/.local/share/ovis/node"
# where an install from before the rename put it
LEGACY_NODE_DIR="$HOME/.local/share/herdr-web-ui/node"
# Ovis on herdr-core: its checkout, and the user service that starts it at login
APP_DIR="$HOME/.local/share/ovis/app"
SERVICE="ovis"
AGENT_LABEL="sh.ovis.server"
# Official digests from nodejs.org/dist/v22.23.2/SHASUMS256.txt, as scripts/build-remote-bundle.ts pins them
NODE_VERSION="v22.23.2"

say() { printf '%s\n' "Ovis: $*"; }

# shellcheck disable=SC2016 # JavaScript, not shell
plugin_root() { herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === process.argv[1])?.plugin_root ?? "")' "$1"; }

# herdr keeps a plugin's config by its id: the old id's env files (the token among them) go to
# the new id's dir unless it has its own, with their owner-only mode
adopt_legacy_config() {
  old=$(herdr plugin config-dir "$LEGACY_PLUGIN" 2>/dev/null </dev/null) || return 0
  new=$(herdr plugin config-dir "$PLUGIN" 2>/dev/null </dev/null) || return 0
  [ ! -e "$new/env" ] && [ ! -e "$new/.env" ] || return 0
  for name in env .env; do
    [ -e "$old/$name" ] || continue
    mkdir -p "$new"
    cp -p "$old/$name" "$new/$name"
  done
}
# a clickable address in a terminal (OSC 8); $terminal is set once, since $(link …) runs in a pipe
# shellcheck disable=SC1003 # the backslashes end OSC 8 escapes (ESC \\), no quote is escaped
link() { if [ "$terminal" = 1 ]; then printf '\033]8;;%s\033\\%s\033]8;;\033\\' "$1" "$1"; else printf '%s' "$1"; fi; }
fail() { printf '%s\n' "Ovis: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs '$1', which is not installed. Install it and run this again."; }
# The highest vX.Y.Z tag, as the updater picks it: a new install gets what existing ones run,
# never the commits merged to main since the last release.
latest_release() {
  git ls-remote --tags --refs "https://github.com/$REPO.git" 'v*' 2>/dev/null |
    sed -n 's|.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' |
    sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1
}
# The plugin id a ref installs under, or nothing when it cannot be told. Releases before the rename
# (0.4.13 and older) name the old id. Its manifest says so; raw.githubusercontent.com can be blocked
# where github.com is not, and then a release tag's version tells it.
ref_plugin_id() {
  ref_id=$(curl -fsSL --max-time 10 "https://raw.githubusercontent.com/$REPO/$1/herdr-plugin.toml" 2>/dev/null </dev/null |
    sed -n '/^id *=/{s/^id *= *"\([^"]*\)".*/\1/p;q;}') || ref_id=""
  if [ -z "$ref_id" ] && printf '%s\n' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    if at_least 0.4.14 "${1#v}"; then ref_id=$PLUGIN; else ref_id=$LEGACY_PLUGIN; fi
  fi
  printf '%s' "$ref_id"
}
# at_least 1.4.0 1.10.2: is the second dotted version the first or newer
at_least() {
  awk -v want="$1" -v have="$2" 'BEGIN { split(want, w, "."); split(have, h, ".");
    for (i = 1; i <= 3; i++) { if (h[i] + 0 > w[i] + 0) exit 0; if (h[i] + 0 < w[i] + 0) exit 1 } exit 0 }'
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print $1 }'; }

# gh api, given 10 seconds: a gh that does not answer must not hold up an install that is done.
# The watcher looks once a second, so it is gone soon after gh is; a gh that ignores TERM is killed.
gh_api() {
  gh api --hostname github.com "$@" </dev/null &
  gh_pid=$!
  (
    waited=0
    while [ "$waited" -lt 10 ]; do sleep 1; kill -0 "$gh_pid" 2>/dev/null || exit 0; waited=$((waited + 1)); done
    kill -TERM "$gh_pid" 2>/dev/null || exit 0
    sleep 2
    kill -KILL "$gh_pid" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  watch_pid=$!
  gh_status=0
  wait "$gh_pid" || gh_status=$?
  kill "$watch_pid" 2>/dev/null || true
  wait "$watch_pid" 2>/dev/null || true
  return "$gh_status"
}
# Whether the account the gh CLI is signed in to has starred the repository, by the status GitHub
# answers with: yes (204), no (404), or unknown (no gh, no sign-in, no answer, or any other status).
starred() {
  command -v gh >/dev/null 2>&1 || { echo unknown; return 0; }
  # into a file, not a pipe: a gh that left a child holding its output would hold a pipe's reader
  # past the deadline, where a file is read once gh_api has returned
  answer=$(mktemp 2>/dev/null) || { echo unknown; return 0; }
  gh_api --include "user/starred/$REPO" >"$answer" 2>/dev/null || true
  status=$(sed -n '1s/^HTTP[^ ]* \([0-9][0-9][0-9]\).*/\1/p' "$answer" 2>/dev/null || true)
  rm -f "$answer"
  case "$status" in
    204) echo yes ;;
    404) echo no ;;
    *) echo unknown ;;
  esac
}
# Asks once, and stars only on "y". Only at a terminal: a script that runs this has nobody to
# answer. A terminal can have nobody at it either (an agent's), so the question waits 20 seconds
# and then goes on; POSIX read cannot give up, bash's can. Under `curl | sh` stdin is the script,
# so the answer is read from the terminal itself.
offer_star() {
  [ "$terminal" = 1 ] && [ -z "${CI:-}" ] || return 0
  command -v bash >/dev/null 2>&1 || return 0
  # perl is what checks the terminal is this install's to ask at, and empties what was typed before
  command -v perl >/dev/null 2>&1 || return 0
  (exec </dev/tty) 2>/dev/null || return 0
  # Only in the foreground: a background job that reached for the terminal would be stopped, with no
  # 20 seconds to end that. Then what was typed before the question is not an answer to it: it is
  # discarded, and when it cannot be, there is no question (tcflush is "0 but true", undef on failure).
  perl -MPOSIX -e 'exit 1 unless POSIX::tcgetpgrp(0) == POSIX::getpgrp(); POSIX::tcflush(0, POSIX::TCIFLUSH) or exit 1' </dev/tty >/dev/null 2>&1 || return 0
  # the question and its answer go through the terminal itself, not stdout: under `curl | sh` stdin
  # is the script, and a stdout sent elsewhere must not leave the question unseen where it is read
  # the install is done: leaving the question with Ctrl-C is an answer, not a failure. The trap
  # comes before the question: a Ctrl-C the moment it shows must not end the script with 130
  trap 'echo; exit 0' INT
  printf '%s' "Ovis: star it now with the GitHub account gh is signed in to? [y/N] " >/dev/tty 2>/dev/null || { trap - INT; return 0; }
  # shellcheck disable=SC2016 # bash's variable, not this shell's
  answer=$(bash -c 'read -r -t 20 answer </dev/tty && printf %s "$answer"' 2>/dev/null) || { answer=""; echo; }
  trap - INT
  case "$answer" in
    y | Y | yes | Yes | YES) ;;
    *) return 0 ;;
  esac
  if gh_api --method PUT "user/starred/$REPO" >/dev/null 2>&1; then
    say "starred. Thank you!"
  else
    say "gh could not star it; the page above can"
  fi
}

# After a first install, on a PC with a desktop: opens the app in the browser, which is where its
# Install button is. Over SSH, or with no desktop, it says how to reach the app instead of opening
# one nobody sees. Nothing here can fail the install, and nothing reads stdin.
open_app() {
  [ "$new_install" = 1 ] || return 0
  origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
  [ -n "$origin" ] || return 0
  hostport=${origin#*://}
  hostport=${hostport%%/*}
  host=${hostport%:*}
  case "$hostport" in *:*) port=${hostport##*:} ;; *) port=80 ;; esac
  loopback=0
  case "$host" in 127.0.0.1 | localhost) loopback=1 ;; esac
  opener=""
  if [ -z "${CI:-}" ] && [ -z "${OVIS_NO_OPEN:-${HERDR_WEB_NO_OPEN:-}}" ] && [ -z "${SSH_CONNECTION:-}" ] && [ -z "${SSH_TTY:-}" ] && [ "$loopback" = 1 ]; then
    if [ "$os" = darwin ]; then
      ! command -v open >/dev/null 2>&1 || opener=open
    elif [ -n "${BROWSER:-}" ] && command -v "$BROWSER" >/dev/null 2>&1; then
      opener=$BROWSER
    elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
      opener=xdg-open
    fi
  fi
  echo
  if [ -n "$opener" ]; then
    "$opener" "$origin" </dev/null >/dev/null 2>&1 &
    say "opened $origin in your browser: click Install in the address bar to add the app"
  elif [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
    say "from your own PC, tunnel to this one and open the app there: ssh -L $port:127.0.0.1:$port <this-pc>"
    say "the phone address above also opens it"
  elif [ "$loopback" = 1 ]; then
    say "open $origin in your browser and click Install in the address bar to add the app"
  else
    say "open $origin in your browser"
  fi
}

# kills a process and everything it started (ps -A -o pid= -o ppid= reads the same on Linux and macOS)
kill_tree() {
  for kill_child in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v parent="$1" '$2 == parent { print $1 }'); do
    kill_tree "$kill_child"
  done
  kill -KILL "$1" 2>/dev/null || true
}

# runs "$@" for at most $1 seconds: past that it is killed with all it started (and fails), so a
# command that hangs cannot hold the install. The watcher looks once a second, as gh_api's does.
bounded() {
  bounded_limit=$1
  shift
  "$@" &
  bounded_pid=$!
  (
    waited=0
    while [ "$waited" -lt "$bounded_limit" ]; do sleep 1; kill -0 "$bounded_pid" 2>/dev/null || exit 0; waited=$((waited + 1)); done
    # past the bound: the kill of the tree is not cut short by the stop below, and says it timed out, so a
    # command that still exits 0 meanwhile (a host waiting on the child killed first) is not taken as finished
    trap '' TERM
    kill_tree "$bounded_pid"
    exit 124
  ) >/dev/null 2>&1 &
  bounded_watch=$!
  bounded_status=0
  wait "$bounded_pid" || bounded_status=$?
  kill "$bounded_watch" 2>/dev/null || true
  bounded_watched=0
  wait "$bounded_watch" 2>/dev/null || bounded_watched=$?
  [ "$bounded_watched" = 124 ] && bounded_status=124
  return "$bounded_status"
}

# the server's own check of the Rust PTY host (server/pty/host.ts), with its deadlines: its usage
# line with exit 2, then a pty; a host that hangs on either counts as one that does not run here
rust_host_runs() {
  [ -x "$1" ] || return 1
  probe_err=$(mktemp) || return 1
  probe_status=0
  bounded 3 "$1" </dev/null >/dev/null 2>"$probe_err" || probe_status=$?
  probe_first=$(sed -n 1p "$probe_err" 2>/dev/null)
  rm -f "$probe_err"
  [ "$probe_status" = 2 ] || return 1
  case "$probe_first" in "pty-sidecar: usage:"*) ;; *) return 1 ;; esac
  bounded 3 "$1" 1 1 true </dev/null >/dev/null 2>&1
}

install_node() {
  case "$platform" in
    linux-x64) node_sha=b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a ;;
    linux-arm64) node_sha=013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30 ;;
    darwin-x64) node_sha=58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026 ;;
    darwin-arm64) node_sha=61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6 ;;
  esac
  say "installing Node $NODE_VERSION into $NODE_DIR"
  # it runs as a condition, where set -e does nothing: each step says itself when it fails
  tmp=$(mktemp -d) || return 1
  archive="$tmp/node.tar.gz"
  curl -fsSL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$platform.tar.gz" -o "$archive" || { rm -rf "$tmp"; return 1; }
  [ "$(sha256 "$archive")" = "$node_sha" ] || { rm -rf "$tmp"; say "the Node download does not match its published SHA-256; nothing was installed"; return 1; }
  # unpacked beside the old one and swapped in only once it holds a node: a failed unpack leaves an
  # existing install as it was
  mkdir -p "$tmp/node" || { rm -rf "$tmp"; return 1; }
  tar -xzf "$archive" -C "$tmp/node" --strip-components=1 || { rm -rf "$tmp"; return 1; }
  [ -x "$tmp/node/bin/node" ] || { rm -rf "$tmp"; say "the Node download holds no bin/node; nothing was installed"; return 1; }
  mkdir -p "$(dirname "$NODE_DIR")" || { rm -rf "$tmp"; return 1; }
  rm -rf "$NODE_DIR.old"
  if [ -e "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.old" || { rm -rf "$tmp"; return 1; }; fi
  mv "$tmp/node" "$NODE_DIR" || { [ ! -e "$NODE_DIR.old" ] || mv "$NODE_DIR.old" "$NODE_DIR"; rm -rf "$tmp"; return 1; }
  rm -rf "$NODE_DIR.old" "$tmp"
}

# The architecture the server runs on: that of the Bun that runs it. Bun's installer picks arm64 on
# an arm64 Mac even from a Rosetta shell, where uname -m says x86_64, so the Node install_node
# downloads and node_fits accepts follow Bun, not uname.
server_arch() {
  # into a file, not $( ): a bun that left a child holding its output would hold a pipe's reader
  # past the bound, where a file is read once bounded has returned (as in starred)
  server_file=$(mktemp 2>/dev/null) || return 0
  bounded 5 bun -p process.arch </dev/null >"$server_file" 2>/dev/null || true
  # all of it, not a first line: a preload that prints before Bun's answer must not stand in for it
  server=$(cat "$server_file" 2>/dev/null || true)
  rm -f "$server_file"
  case "$server" in
    x64 | arm64) arch=$server; platform="$os-$arch" ;;
  esac
}

# Whether the node $1 (a path, or a name on PATH) is one the Node sidecar takes (server/pty/sidecar.ts
# isRealNode): Node 18 or newer, not Bun, built for the server's architecture ($arch, server_arch).
# Bounded, as the server's probe is: a node that keeps running (a NODE_OPTIONS preload) cannot hold
# the install.
node_fits() {
  # into a file for the same reason as server_arch's
  fit_file=$(mktemp 2>/dev/null) || return 1
  fit_status=0
  bounded 3 "$1" -p '(process.versions.bun ? "bun" : process.versions.node.split(".")[0]) + " " + process.arch' </dev/null >"$fit_file" 2>/dev/null || fit_status=$?
  fit=$(cat "$fit_file" 2>/dev/null || true)
  rm -f "$fit_file"
  [ "$fit_status" = 0 ] || return 1
  fit_major=${fit%% *}
  case "$fit_major" in '' | *[!0-9]*) return 1 ;; esac
  [ "$fit_major" -ge 18 ] && [ "${fit#* }" = "$arch" ]
}

# The Node install_node puts in NODE_DIR stays out of the user's PATH: linked into BIN_DIR, it went
# first there and overrode the user's own Node (#596). A release whose server looks for it in
# NODE_DIR itself (server/pty/sidecar.ts, in the code at $1) needs no link, so a link of ours goes
# and anything else there stays. An older release finds Node on the PATH only, so our Node is linked
# for it as before, the one from before the rename too: where it needs one ($2 = needed: no Rust PTY
# host) and the user's PATH has no Node 18 or newer, or always once herdr's build said its own PATH
# has none ($2 = installed), since herdr's PATH need not be the user's (nvm in .bashrc).
node_link() {
  if grep -qs 'share/ovis/node' "$1/server/pty/sidecar.ts"; then
    [ -L "$BIN_DIR/node" ] || return 0
    case "$(readlink "$BIN_DIR/node")" in
      "$NODE_DIR/bin/node" | "$LEGACY_NODE_DIR/bin/node")
        rm -f "$BIN_DIR/node"
        # it may have been the only node on the user's PATH, so say so
        say "removed $BIN_DIR/node, the link to Ovis's own Node that an earlier install made: Ovis finds that Node itself now, and your shells use your own Node (install one if you need node outside Ovis)"
        ;;
    esac
  elif [ ! -e "$BIN_DIR/node" ] && [ ! -L "$BIN_DIR/node" ]; then
    case "${2:-}" in
      installed) ;;
      needed)
        # only node runs on the user's PATH: sed may not be on it
        user_version=$(PATH="${original_path:-}"; export PATH; node --version 2>/dev/null) || user_version=""
        user_major=$(printf '%s\n' "$user_version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
        [ "${user_major:-0}" -lt 18 ] || return 0
        ;;
      *) return 0 ;;
    esac
    for private in "$NODE_DIR" "$LEGACY_NODE_DIR"; do
      [ -x "$private/bin/node" ] || continue
      if mkdir -p "$BIN_DIR" && ln -s "$private/bin/node" "$BIN_DIR/node"; then
        installed_here="$installed_here node"
      else
        say "could not link Node into $BIN_DIR, so this release's panes are mirrored until it is updated"
      fi
      return 0
    done
  fi
}

# herdr's checkout stays at the version first installed: Settings → Updates builds each newer release
# in the app's state dir and runs it from there (server/updater.ts, current.json). The directory of the
# code that runs now, so the phone step is the running version's, not the first install's.
running_code() {
  state="${OVIS_STATE_DIR:-${HERDR_WEB_STATE_DIR:-}}"
  if [ -z "$state" ]; then
    state="${XDG_CONFIG_HOME:-$HOME/.config}/ovis"
    # an install whose server has not run since the rename still has its state under the old name
    [ -d "$state" ] || state="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-web-ui"
  fi
  head=$(git -C "$1" rev-parse HEAD 2>/dev/null || true)
  # shellcheck disable=SC2016 # JavaScript, not shell
  bun -e '
    const [root, state, head] = process.argv.slice(1);
    const { readdirSync, readFileSync } = await import("node:fs");
    let found = root;
    try {
      for (const name of readdirSync(`${state}/updates`)) {
        try {
          const saved = JSON.parse(readFileSync(`${state}/updates/${name}/current.json`, "utf8"));
          if (saved.source_revision === head && String(saved.directory).startsWith(`${state}/updates/${name}/release-`)) found = saved.directory;
        } catch {}
      }
    } catch {}
    console.log(found);
  ' "$1" "$state" "$head"
}

# Whether $1 is herdr-core: it exits 0 from `--version` within 5 s and its first line is `hc <version>`.
# Only `--version` is run: any other hc command starts a core, and other programs are called hc too.
is_core() {
  [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
  # into a file for the same reason as server_arch's
  core_file=$(mktemp 2>/dev/null) || return 1
  core_status=0
  bounded 5 "$1" --version </dev/null >"$core_file" 2>/dev/null || core_status=$?
  core_answer=$(sed -n '1s/^hc [0-9][0-9]*\.[0-9][0-9.]*.*/yes/p' "$core_file" 2>/dev/null || true)
  rm -f "$core_file"
  [ "$core_status" = 0 ] && [ "$core_answer" = yes ]
}

# The folders of Ovis on herdr-core, in $settings_dir and $state_dir: under the Ovis name, or the name
# before the rename while only that one exists (as scripts/plugin.ts picks them).
core_dirs() {
  settings_dir="$HOME/.config/ovis"
  [ -d "$settings_dir" ] || [ ! -d "$HOME/.config/herdr-web-ui" ] || settings_dir="$HOME/.config/herdr-web-ui"
  state_dir="$HOME/.local/state/ovis"
  [ -d "$state_dir" ] || [ ! -d "$HOME/.local/state/herdr-web-ui" ] || state_dir="$HOME/.local/state/herdr-web-ui"
}

# The value the settings files give $1, .env's over env's and unquoted, as scripts/plugin.ts reads them.
saved_setting() {
  core_dirs
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$settings_dir/env" "$settings_dir/.env" 2>/dev/null \
    | tail -n 1 | sed -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//"
}

# The herdr-core (hc) on this PC, in $core, looked for as the server looks (server/herdr-core/discovery.ts):
# OVIS_HC_BIN, the one an earlier run saved, the PATH, then the usual install places, herdr-core before
# hc in each.
find_core() {
  core=""
  for core_candidate in "${OVIS_HC_BIN:-}" "$(saved_setting OVIS_HC_BIN)" "$(command -v herdr-core 2>/dev/null || true)" "$(command -v hc 2>/dev/null || true)"; do
    if is_core "$core_candidate"; then core=$core_candidate; return 0; fi
  done
  for core_dir in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.local/share/mise/shims" "$HOME/.nix-profile/bin" "$HOME/.cargo/bin"; do
    for core_name in herdr-core hc; do
      if is_core "$core_dir/$core_name"; then core="$core_dir/$core_name"; return 0; fi
    done
  done
  return 1
}

# The runtime to install for, in $runtime: OVIS_RUNTIME when set; else herdr-core where an earlier run
# installed Ovis on it, or where there is no herdr but herdr-core answers; else herdr, installed if
# missing. herdr-core needs an hc that answers, and no herdr plugin already running Ovis here: one
# Ovis per PC, and the plugin's own settings are where it moves to herdr-core.
pick_runtime() {
  case "${OVIS_RUNTIME:-}" in
    herdr) runtime=herdr; return 0 ;;
    herdr-core) runtime=herdr-core ;;
    "")
      if [ -d "$APP_DIR/.git" ]; then
        runtime=herdr-core
      elif ! command -v herdr >/dev/null 2>&1 && find_core; then
        runtime=herdr-core
      else
        runtime=herdr
        return 0
      fi
      ;;
    *) fail "OVIS_RUNTIME=$OVIS_RUNTIME is not a runtime Ovis knows: use herdr or herdr-core" ;;
  esac
  [ -n "${core:-}" ] || find_core \
    || fail "Ovis here runs on herdr-core (OVIS_RUNTIME, or the install in $APP_DIR), but no herdr-core (hc) answers on this PC. Install it (https://herdr.dev/core), or set OVIS_HC_BIN to it, and run this again."
  if command -v herdr >/dev/null 2>&1 && herdr plugin list 2>/dev/null | grep -q -e "$PLUGIN " -e "$LEGACY_PLUGIN "; then
    fail "Ovis already runs here as a herdr plugin. To show herdr-core's terminals with it, put OVIS_RUNTIME=herdr-core in the .env file in the folder 'herdr plugin config-dir $PLUGIN' prints and restart it (Stop and Start Ovis); or remove the plugin first (herdr plugin uninstall $PLUGIN)."
  fi
}

# The settings file of Ovis on herdr-core (core_dirs), which its service hands scripts/plugin.ts as
# HERDR_PLUGIN_CONFIG_DIR, so a herdr plugin's settings found later are not read in its place; owner-only,
# as the token in it needs. The installer owns two lines, written anew each run in place of any either
# file had (under their names from before the rename too): OVIS_RUNTIME=herdr-core, and OVIS_HC_BIN, the hc find_core checked (a release before the
# server's own search runs only that or `hc` on the PATH). It adds the hc session the installer ran with
# (HC_SESSION, HC_SOCKET), which a service would not otherwise have, unless a file names one.
core_settings() {
  core_dirs
  mkdir -p "$settings_dir"
  for settings_file in "$settings_dir/env" "$settings_dir/.env"; do
    grep -Eqs '^[[:space:]]*(OVIS_RUNTIME|OVIS_HC_BIN|HERDR_WEB_RUNTIME|HERDR_WEB_HC_BIN)[[:space:]]*=' "$settings_file" || continue
    if grep -Es '^[[:space:]]*(OVIS_RUNTIME|HERDR_WEB_RUNTIME)[[:space:]]*=' "$settings_file" | grep -qv '=[[:space:]]*["'\'']*herdr-core["'\'']*[[:space:]]*$'; then
      say "$settings_file named another runtime; Ovis runs on herdr-core now"
    fi
    # a copy with the file's own mode, then moved over it: an interrupted run leaves the file whole
    cp -p "$settings_file" "$settings_file.new" || fail "could not write $settings_file"
    grep -Ev '^[[:space:]]*(OVIS_RUNTIME|OVIS_HC_BIN|HERDR_WEB_RUNTIME|HERDR_WEB_HC_BIN)[[:space:]]*=' "$settings_file" >"$settings_file.new" || true
    mv -f "$settings_file.new" "$settings_file" || fail "could not write $settings_file"
  done
  # a last line without its newline would run into the new one
  if [ -s "$settings_dir/env" ] && [ -n "$(tail -c 1 "$settings_dir/env")" ]; then echo >>"$settings_dir/env"; fi
  (umask 077 && printf '%s\n' "OVIS_RUNTIME=herdr-core" >>"$settings_dir/env")
  [ -z "${core:-}" ] || printf '%s\n' "OVIS_HC_BIN=$core" >>"$settings_dir/env"
  for settings_name in HC_SESSION HC_SOCKET; do
    eval "settings_value=\${${settings_name}:-}"
    [ -n "$settings_value" ] || continue
    ! grep -qs "^[[:space:]]*${settings_name}[[:space:]]*=" "$settings_dir/env" "$settings_dir/.env" || continue
    printf '%s=%s\n' "$settings_name" "$settings_value" >>"$settings_dir/env"
  done
}

# A value for a plist <string>, with &, < and > as XML entities.
xml_text() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# A value inside a double-quoted systemd unit word: \ and " escaped, % (its specifier sign) doubled, and
# for an Exec line ($2 = exec) $ doubled too, since systemd expands $NAME there.
unit_text() {
  if [ "${2:-}" = exec ]; then
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g'
  else
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'
  fi
}

# Registers the user service that runs `scripts/plugin.ts start` at login, with core_settings' dirs:
# launchd's on macOS, systemd's on Linux. That start runs the server in the background and records it, as the plugin's start does,
# so `plugin.ts stop` and `status` work on it as on the plugin's. Where there is neither, it says how
# to start the app by hand.
core_service() {
  # one line each in the unit: a newline in a value would start a directive of its own
  case "$PATH$settings_dir$state_dir$APP_DIR" in *'
'*) fail "a newline in PATH or HOME cannot go into a service file; remove it and run this again" ;; esac
  bun_bin=$(command -v bun)
  start_line="HERDR_PLUGIN_CONFIG_DIR=$settings_dir HERDR_PLUGIN_STATE_DIR=$state_dir bun $APP_DIR/scripts/plugin.ts start"
  if [ "$os" = darwin ]; then
    agent="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
    mkdir -p "$(dirname "$agent")" "$HOME/Library/Logs/Ovis"
    # AbandonProcessGroup: the server the start leaves running is not launchd's to end when the start exits
    cat >"$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key><array><string>$(xml_text "$bun_bin")</string><string>$(xml_text "$APP_DIR/scripts/plugin.ts")</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(xml_text "$PATH")</string>
    <key>HERDR_PLUGIN_CONFIG_DIR</key><string>$(xml_text "$settings_dir")</string>
    <key>HERDR_PLUGIN_STATE_DIR</key><string>$(xml_text "$state_dir")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$(xml_text "$HOME/Library/Logs/Ovis/start.log")</string>
  <key>StandardErrorPath</key><string>$(xml_text "$HOME/Library/Logs/Ovis/start.log")</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$(id -u)" "$agent" >/dev/null 2>&1; then
      say "Ovis starts at login (launchd: $agent)"
    else
      say "launchd did not take $agent, so Ovis does not start by itself at login; start it with: $start_line"
    fi
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE.service"
    mkdir -p "$(dirname "$unit")"
    # oneshot that stays active: the server the start leaves running stays in the unit, and stop ends it
    cat >"$unit" <<EOF
[Unit]
Description=Ovis on herdr-core

[Service]
Type=oneshot
RemainAfterExit=yes
Environment="PATH=$(unit_text "$PATH")"
Environment="HERDR_PLUGIN_CONFIG_DIR=$(unit_text "$settings_dir")"
Environment="HERDR_PLUGIN_STATE_DIR=$(unit_text "$state_dir")"
ExecStart="$(unit_text "$bun_bin" exec)" "$(unit_text "$APP_DIR/scripts/plugin.ts" exec)" start
ExecStop="$(unit_text "$bun_bin" exec)" "$(unit_text "$APP_DIR/scripts/plugin.ts" exec)" stop
TimeoutStartSec=120

[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload </dev/null >/dev/null 2>&1 && systemctl --user enable --now "$SERVICE.service" </dev/null >/dev/null 2>&1; then
      say "Ovis starts at login (systemd: systemctl --user status $SERVICE)"
      if loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '=no$'; then
        say "to keep it running while nobody is logged in to this PC, run: loginctl enable-linger $(id -un)"
      fi
    else
      say "systemd did not take $unit, so Ovis does not start by itself at login; start it with: $start_line"
    fi
  else
    say "this PC has no user service manager (systemd), so Ovis does not start by itself after a restart; start it with: $start_line"
  fi
}

# Ovis on herdr-core, without herdr or its plugin: its own checkout in APP_DIR, built with herdr-plugin.toml's
# [[build]] steps as herdr builds the plugin (the Rust PTY host aside: herdr-core's terminals need none),
# its settings, its service, and a start now.
install_core() {
  if [ -d "$APP_DIR/.git" ]; then
    say "already installed in $APP_DIR, on herdr-core; Settings → Updates keeps it current"
  elif [ -e "$APP_DIR" ]; then
    fail "$APP_DIR is there but is not an Ovis checkout; move it away and run this again"
  else
    ref=${OVIS_REF:-${HERDR_WEB_UI_REF:-$(latest_release)}}
    [ -n "$ref" ] || fail "could not look up the latest release on github.com. Check the connection and run this again."
    say "found herdr-core ($core), so Ovis runs on it: no herdr or herdr plugin needed"
    say "installing Ovis $ref into $APP_DIR (about a minute)"
    # built beside it and moved in once built, so a failed or cut-short run leaves no half-built app to keep
    rm -rf "$APP_DIR.new"
    mkdir -p "$(dirname "$APP_DIR")"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" "https://github.com/$REPO.git" "$APP_DIR.new" </dev/null \
      || { rm -rf "$APP_DIR.new"; fail "could not download Ovis $ref from github.com. Check the connection and run this again."; }
    # on a branch named main at that release: Settings → Updates updates a source checkout from main only,
    # and takes a detached one only as herdr's plugin checkout (server/updater.ts sourceBlock)
    git -C "$APP_DIR.new" checkout --quiet -B main </dev/null || { rm -rf "$APP_DIR.new"; fail "could not set up the checkout in $APP_DIR.new"; }
    log=$(mktemp)
    if ! (cd "$APP_DIR.new" && sh scripts/preflight.sh && sh scripts/with-bun.sh install && sh scripts/with-bun.sh run build) </dev/null >"$log" 2>&1; then
      cat "$log" >&2
      rm -rf "$log" "$APP_DIR.new"
      fail "could not build Ovis $ref; its output is above"
    fi
    rm -f "$log"
    mv "$APP_DIR.new" "$APP_DIR"
    new_install=1
  fi
  root=$APP_DIR
  code=$(running_code "$root")
  core_settings
  # every scripts/plugin.ts this run starts (the start below, the phone step, open_app) reads what the service does
  HERDR_PLUGIN_CONFIG_DIR=$settings_dir
  HERDR_PLUGIN_STATE_DIR=$state_dir
  export HERDR_PLUGIN_CONFIG_DIR HERDR_PLUGIN_STATE_DIR
  core_service
  bun "$root/scripts/plugin.ts" start </dev/null \
    || say "Ovis did not start; what it said is above. Start it again with: $start_line"
}

# Ovis as a herdr plugin: installed (or moved from its id before the rename) by herdr, with the Rust
# PTY host or Node for its terminals, and started now when herdr runs.
install_plugin() {
  # The ref to install is settled before anything moves: a release from before the rename still
  # names the plugin by its old id, and installing it cannot move an install to the new one
  ref=""
  move=1
  if ! herdr plugin list 2>/dev/null | grep -q "$PLUGIN "; then
    need git
    ref=${OVIS_REF:-${HERDR_WEB_UI_REF:-$(latest_release)}}
    [ -n "$ref" ] || fail "could not look up the latest release on github.com. Check the connection and run this again."
    case "$(ref_plugin_id "$ref")" in
      # that release installs, runs and updates under the old id: the move waits for a release
      # that names the new one, which Settings → Updates or this script brings
      "$LEGACY_PLUGIN") PLUGIN=$LEGACY_PLUGIN ;;
      # a branch whose manifest cannot be read: an install under the old id is left running, since
      # the ref may not be able to move it
      "") move=0 ;;
    esac
  fi

  legacy_root=""
  if [ "$move" = 0 ] && herdr plugin list 2>/dev/null | grep -q "$LEGACY_PLUGIN "; then
    say "could not read the plugin id at $ref, so the install under $LEGACY_PLUGIN is left as it is; run this again to move it"
  elif [ "$PLUGIN" != "$LEGACY_PLUGIN" ] && herdr plugin list 2>/dev/null | grep -q "$LEGACY_PLUGIN "; then
    legacy_root=$(plugin_root "$LEGACY_PLUGIN")
    say "moving the installed plugin to its Ovis id; its settings and token come along"
    # stopped first: removed with its server up, the old checkout would keep serving, and the new
    # id's start would find the port answering and leave it
    if [ -n "$legacy_root" ] && ! bun "$legacy_root/scripts/plugin.ts" stop </dev/null >/dev/null 2>&1; then
      fail "could not stop the server of the old id, so nothing was moved. Stop it (herdr plugin action invoke $LEGACY_PLUGIN.stop, or restart herdr), then run this again."
    fi
  fi

  if herdr plugin list 2>/dev/null | grep -q "$PLUGIN "; then
    say "already installed as a herdr plugin; Settings → Updates keeps it current"
  else
    say "installing the herdr plugin at $ref (herdr clones and builds it: about a minute)"
    # herdr previews the whole manifest first; on success its last word is enough, on failure all of it
    log=$(mktemp)
    installed=0
    if herdr plugin install "$REPO" --ref "$ref" --yes </dev/null >"$log" 2>&1; then
      installed=1
    elif grep -q "Ovis needs Node 18 or newer" "$log" && ( install_node ); then
      # a release from before the Rust PTY host was the default still asks for Node in its first build
      # step, on herdr's PATH
      node_link "" installed
      herdr plugin install "$REPO" --ref "$ref" --yes </dev/null >"$log" 2>&1 && installed=1
    fi
    if [ "$installed" = 1 ]; then
      grep '^Installed ' "$log" || true
      rm -f "$log"
      new_install=1
    else
      cat "$log" >&2
      rm -f "$log"
      fail "herdr could not install the plugin; its output is above"
    fi
  fi

  root=$(plugin_root "$PLUGIN")
  # the id unknown before the install: the ref may have named the old one
  if [ -z "$root" ] && [ "$move" = 0 ]; then
    PLUGIN=$LEGACY_PLUGIN
    root=$(plugin_root "$PLUGIN")
  fi
  [ -n "$root" ] || fail "herdr does not list the plugin after installing it; see: herdr plugin list"

  if [ "$PLUGIN" != "$LEGACY_PLUGIN" ] && [ "$move" = 1 ] && herdr plugin list 2>/dev/null | grep -q "$LEGACY_PLUGIN "; then
    adopt_legacy_config
    herdr plugin uninstall "$LEGACY_PLUGIN" </dev/null >/dev/null || fail "could not remove the plugin's old id; run: herdr plugin uninstall $LEGACY_PLUGIN"
  fi

  # the Rust PTY host of the release that runs, checked against its SHA-256: herdr's build step and
  # Settings → Updates fetch it too, so this is for an install from before it shipped, or one whose
  # download failed. Without it, terminals use the Node sidecar where there is Node, or a mirror.
  code=$(running_code "$root")
  [ ! -f "$code/scripts/pty-sidecar.ts" ] || (cd "$code" && bun scripts/pty-sidecar.ts install </dev/null) || true
  # Node only where terminals would otherwise have no PTY host: a release without the Rust host (one
  # from before it, or a branch), or one whose host failed its checks here
  needs_node=""
  if ! rust_host_runs "$code/bin/ovis-pty-sidecar"; then
    needs_node=needed
    # the app's own Node first, as the server looks (server/pty/sidecar.ts realNode), then the PATH's.
    # Optional now: a Node that cannot be installed leaves the panes mirrored, never the install unfinished
    if ! node_fits "$NODE_DIR/bin/node" && ! node_fits "$LEGACY_NODE_DIR/bin/node" && ! node_fits node && ! ( install_node ); then
      say "could not install Node, so this PC's panes are mirrored until the Rust PTY host can be installed (run this again later)"
    fi
  fi
  node_link "$code" "$needs_node"

  if herdr status server --json 2>/dev/null | grep -q '"running":true'; then
    # the action only queues the start (its output goes to herdr's plugin log), so wait for it here
    herdr plugin action invoke "$PLUGIN.start" >/dev/null </dev/null
    tries=0
    until bun "$root/scripts/plugin.ts" status </dev/null | grep -q '^running'; do
      tries=$((tries + 1))
      [ "$tries" -lt 25 ] || {
        say "did not start within 25 s; see: herdr plugin log list"
        # the start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal
        # shellcheck disable=SC2016 # JavaScript, not shell
        herdr plugin log list 2>/dev/null </dev/null | bun -e 'const logs = JSON.parse(await Bun.stdin.text()).result.logs.filter((log) => log.plugin_id === process.argv[1] && log.stderr); if (logs.length > 0) console.error(logs.at(-1).stderr.trim())' "$PLUGIN" || true
        break
      }
      sleep 1
    done
  else
    say "herdr is not running, so neither is the app yet: it starts with herdr. Run: herdr"
  fi
}

main() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "runs on Linux and macOS; this is $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "runs on x64 and arm64; this is $(uname -m)" ;;
  esac
  platform="$os-$arch"
  terminal=0
  [ ! -t 1 ] || terminal=1
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "the terminal addon has no build for musl (Alpine); use a glibc distribution"
  fi
  need curl
  need git
  need tar

  original_path="$PATH"
  installed_here=""
  new_install=0
  PATH="$BIN_DIR:$HOME/.bun/bin:$NODE_DIR/bin:$LEGACY_NODE_DIR/bin:$PATH"
  export PATH

  pick_runtime
  if [ "$runtime" = herdr ]; then
    if [ -d "$APP_DIR/.git" ]; then
      say "Ovis also runs on herdr-core from $APP_DIR (an earlier install); to keep only the plugin, stop that one: bun $APP_DIR/scripts/plugin.ts stop, and remove its service"
    fi
    if ! command -v herdr >/dev/null 2>&1; then
      say "installing herdr (https://herdr.dev) into $BIN_DIR"
      curl -fsSL https://herdr.dev/install.sh | sh
      command -v herdr >/dev/null 2>&1 || fail "herdr did not install; see https://herdr.dev/docs/install/"
      installed_here="$installed_here herdr"
    fi
    herdr_version=$(herdr --version 2>/dev/null | awk '{ print $2 }')
    at_least 0.9.0 "${herdr_version:-0}" \
      || fail "needs herdr 0.9.0 or newer; this is ${herdr_version:-unknown}. Update it (https://herdr.dev/docs/install/), restart herdr, and run this again."
  fi

  if command -v bun >/dev/null 2>&1; then
    bun_version=$(bun --version)
    if ! at_least 1.4.0 "$bun_version"; then
      say "updating Bun $bun_version to the latest"
      bun upgrade </dev/null || fail "could not update Bun $bun_version; update it to 1.4 or newer and run this again"
    fi
  else
    need unzip
    say "installing Bun (https://bun.sh) into ~/.bun"
    curl -fsSL https://bun.sh/install | bash
    command -v bun >/dev/null 2>&1 || fail "Bun did not install; see https://bun.sh"
    # Bun's installer adds ~/.bun/bin to a shell's rc file only when it can tell which shell, and
    # herdr runs the app with the PATH it was started with: next to herdr, it is found either way
    mkdir -p "$BIN_DIR"
    [ -e "$BIN_DIR/bun" ] || ln -s "$HOME/.bun/bin/bun" "$BIN_DIR/bun"
    installed_here="$installed_here bun"
  fi
  server_arch

  if [ "$runtime" = herdr-core ]; then install_core; else install_plugin; fi

  echo
  if grep -q '"phone"' "$code/scripts/plugin.ts" 2>/dev/null; then
    bun "$code/scripts/plugin.ts" phone </dev/null || true
  else
    # a release from before the phone step: the address the running app already knows, as a QR code
    origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
    url=""
    [ -z "$origin" ] || url=$(curl -fsS --max-time 5 "$origin/api/access" 2>/dev/null | bun -e 'try { console.log(JSON.parse(await Bun.stdin.text()).tailscale?.serving_url ?? "") } catch { console.log("") }')
    [ -z "$origin" ] || say "on this PC: $(link "$origin")"
    if [ -n "$url" ]; then
      say "on your phone: $(link "$url")"
      # the app's own QR library, there since 0.3.11 for Settings → Phone
      if [ -d "$code/node_modules/qrcode-generator" ]; then
        # shellcheck disable=SC2016 # JavaScript, not shell
        (cd "$code" && bun -e 'const { default: qr } = await import("qrcode-generator"); const c = qr(0, "M"); c.addData(process.argv[1]); c.make(); console.log(c.createASCII(1, 1))' "$url") || true
      fi
    else
      say "no phone address yet, and this version cannot set one up: update it in Settings → Updates, then run this again"
    fi
  fi

  open_app

  case ":$original_path:" in
    *":$BIN_DIR:"*) ;;
    *)
      # on herdr-core the service runs with the PATH this install had, so no shell needs it
      if [ -z "$installed_here" ] || [ "$runtime" = herdr-core ]; then
        :
      elif grep -qs '\.local/bin' "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"; then
        echo
        say "installed$installed_here into $BIN_DIR. Open a new terminal before running herdr, so it finds them."
      else
        echo
        say "installed$installed_here into $BIN_DIR, which your shell does not put on its PATH. Add it, for example:"
        # shellcheck disable=SC2016 # the line to paste, $HOME and $PATH unexpanded
        printf '    echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.profile\n'
        say "and start herdr from a new terminal, so it and the app find them."
      fi
      ;;
  esac

  # once, on the first install, and not to someone who already starred it; a rerun for the phone
  # address stays quiet. Last, so that leaving the question unanswered loses nothing above it.
  if [ "$new_install" = 1 ]; then
    star=$(starred)
    if [ "$star" != yes ]; then
      echo
      say "if it helps you, a GitHub star helps other herdr users find it: $(link "https://github.com/$REPO")"
      [ "$star" != no ] || offer_star
    fi
  fi
}

# the whole script is read before anything runs: under `curl | sh`, a command that reads stdin
# must not swallow the rest of it
main "$@"
