#!/bin/sh
# Ovis in one line, from a PC that may have none of it yet:
#
#   curl -fsSL https://ovis.sh/install.sh | sh
#
# 1. Installs what is missing, for this user only and without sudo: herdr (its own installer, into
#    ~/.local/bin), and the release's compiled server into ~/.local/share/ovis: ovis-server for this
#    platform and the built client (ovis-dist.tar.gz), taken only once the release's ovis-server.json
#    carries a valid signature by the key pinned below (RELEASE_PUBLIC_KEY) and each file has the size
#    and SHA-256 it names, then made the one that runs by a single rename (install_binary). No Bun or
#    Node is installed or needed. Terminals run on the release's Rust PTY host, checked against its
#    SHA-256; where it cannot run, they are mirrored.
# 2. Installs Ovis as a herdr plugin (a small plugin folder, ~/.local/share/ovis/plugin, that herdr
#    links and that runs the binary), so it starts with herdr, and starts it now when herdr is running.
#
# A release from before the compiled server, a branch (OVIS_REF), an install from source that is
# already here, or OVIS_FROM_SOURCE=1 keep the earlier way instead: Bun (its own installer, into
# ~/.bun), herdr's plugin checkout built from source, which Settings → Updates keeps current, and Node
# 22 (the official build, checked against its published SHA-256) only where the Rust PTY host cannot
# be installed.
# 3. When Tailscale runs on this PC, serves the app to your tailnet (`tailscale serve`, on the first
#    free HTTPS port, or only the one OVIS_TAILSCALE_HTTPS_PORT names) and prints the address
#    a phone opens as a QR code (scripts/plugin.ts phone).
# 4. On a first install, mentions a GitHub star once. When the gh CLI is signed in and has not
#    starred the repository, it asks at the terminal, for 20 seconds, and stars only on "y"; it
#    never stars by itself.
#
# It also puts an `ovis` command into ~/.local/bin, which runs the installed Ovis's own command line
# (scripts/plugin.ts): `ovis add` adds this PC to your Ovis account from its terminal, `ovis pair` shows
# a pairing code, `ovis status` says whether the app runs. To end the install with `ovis add`:
#
#   curl -fsSL https://ovis.sh/install.sh | sh -s -- --add
#
# That step needs a terminal to sign in and answer at; without one the installer says what to run.
#
# On a PC with herdr-core (hc, the core the Herdr app runs on) and no herdr, steps 1 and 2 are instead:
# the compiled server alone (from source: Bun, and Ovis in its own checkout, ~/.local/share/ovis/app),
# started on herdr-core (OVIS_RUNTIME=herdr-core) as a user service that starts again at login
# (systemd's on Linux, launchd's on macOS).
#
#   OVIS_REF=<branch or tag>   install that ref instead of the latest release (a branch: from source)
#   OVIS_RELEASES_URL=<https:// address or file:// folder>   where releases are downloaded from,
#     laid out as GitHub's (<url>/v<version>/<file>); the pinned key checks the server, its client and the
#     Rust PTY host from any of them the same
#   OVIS_FROM_SOURCE=1   install from source as before the compiled server
#   OVIS_RUNTIME=herdr|herdr-core   pick the runtime instead of going by what is installed
#   OVIS_TAILSCALE_HTTPS_PORT=<port>   serve the app on that HTTPS port only, keeping 443 free
#   OVIS_ADD=1   the same as --add, for where the installer's arguments cannot be given
set -eu

REPO="devswha/ovis"
PLUGIN="devswha.ovis"
LEGACY_PLUGIN="devswha.herdr-web-ui"
BIN_DIR="$HOME/.local/bin"
NODE_DIR="$HOME/.local/share/ovis/node"
LEGACY_NODE_DIR="$HOME/.local/share/herdr-web-ui/node"
APP_DIR="$HOME/.local/share/ovis/app"
SERVICE="ovis"
AGENT_LABEL="sh.ovis.server"
# Official digests from nodejs.org/dist/v22.23.2/SHASUMS256.txt, as scripts/build-remote-bundle.ts pins them
NODE_VERSION="v22.23.2"
# the second line of the `ovis` launcher this installer writes: a file of that name without it is not ours
LAUNCHER_MARK="# ovis launcher, written by install.sh"
USAGE="usage: curl -fsSL https://ovis.sh/install.sh | sh -s -- [--add]"
OVIS_HOME="$HOME/.local/share/ovis"
# The public half of the key every release's ovis-server.json is signed with: scripts/server-manifest.ts
# RELEASE_PUBLIC_KEY, which the release jobs check against too. Nothing else can stand in for it.
RELEASE_PUBLIC_KEY="C8+dOD0gpFHoy008ZqHO89vXutaLqlt5uWyIh250OiY="
# RFC 8032's Ed25519 test vector 2 (the message "r"): a signature checker is used only once it accepts this
# and refuses the same signature over another message, so one that says yes to everything is never trusted
VECTOR_KEY="PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="
VECTOR_SIG="kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA=="
INSTALL_LOCK_WAIT_SECONDS=600

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

open_app() {
  [ "$new_install" = 1 ] || return 0
  if [ "${binary:-0}" = 1 ]; then
    origin=$(ovis_cli status </dev/null | awk '$1 == "running" { print $2 }')
  else
    origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
  fi
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

# JavaScript, with no single quote in it, since the launcher keeps it in one. It finds what
# scripts/plugin.ts finds, the same way:
# - the settings: the shell's own, then the plugin's `env` and `.env` files (KEY=value lines, read and
#   never run; `.env` wins, and a file wins over the shell), each with its names from before the rename
#   (readEnvFile, mergeEnvLayers). The files are in HERDR_PLUGIN_CONFIG_DIR, else the folder herdr
#   names for the plugin, else ~/.config/ovis;
# - the release: updates/<the first 16 of sha256("<checkout>:<port>")>/current.json and no other
#   folder, taken only while it names the checkout's commit and a release-* folder of its own
#   (updateStateDir, activePluginScript). Another port's folder, or another checkout's at the same
#   commit, is some other server's release.
release_js() {
  cat <<'EOF'
  const { createHash } = await import("node:crypto");
  const { existsSync, readFileSync, readdirSync, realpathSync, statSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { basename, dirname, join, resolve, sep } = await import("node:path");
  const root = process.argv[1];
  let found = root;
  try {
    const FILES = ["env", ".env"];
    const IDS = ["devswha.ovis", "devswha.herdr-web-ui"];
    const holds = (dir) => FILES.some((name) => existsSync(join(dir, name)));
    const own = (parent) => existsSync(join(parent, "ovis")) || !existsSync(join(parent, "herdr-web-ui")) ? join(parent, "ovis") : join(parent, "herdr-web-ui");
    const asked = () => {
      const herdr = Bun.which("herdr");
      if (herdr === null) return null;
      for (const id of IDS) {
        try {
          const run = Bun.spawnSync([herdr, "plugin", "config-dir", id], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3000 });
          const dir = run.exitCode === 0 ? run.stdout.toString().trim() : "";
          if (dir !== "" && holds(dir)) return dir;
        } catch { return null; }
      }
      return null;
    };
    let config = process.env.HERDR_PLUGIN_CONFIG_DIR ?? asked() ?? own(join(homedir(), ".config"));
    // the new id has no settings yet: scripts/plugin.ts copies the old id there and reads them
    if (basename(config) === IDS[0] && !holds(config)) config = join(dirname(config), IDS[1]);
    const read = (file) => {
      const vars = {};
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["\x27]|["\x27]$/g, "");
      }
      return vars;
    };
    const env = {};
    for (const layer of [process.env, ...FILES.map((name) => join(config, name)).filter((file) => existsSync(file)).map(read)]) {
      const named = { ...layer };
      for (const [name, value] of Object.entries(layer)) {
        if (!name.startsWith("HERDR_WEB_") || value === undefined) continue;
        const next = name === "HERDR_WEB_UI_REF" ? "OVIS_REF" : "OVIS_" + name.slice("HERDR_WEB_".length);
        if (named[next] === undefined) named[next] = value;
      }
      Object.assign(env, named);
    }
    const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
    const same = (left, right) => { try { return readFileSync(left).equals(readFileSync(right)); } catch { return false; } };
    const COPIES = ["devices.json", "preferences.json", "muted-panes.json", "preferences-id.json", "state-merge.json", "state-merge-devices-incomplete.json"];
    // the dir under the old name holds state of its own: more than the bridge registry and the merge copies
    const ownState = (legacy, next) => {
      try {
        if (!isDir(legacy)) return false;
        const entries = readdirSync(legacy);
        if (entries.length === 0 || isDir(next) && realpathSync(legacy) === realpathSync(next)) return false;
        return !entries.every((entry) => entry === "bridges" || entry === "state-merge-backups" || COPIES.includes(entry) && same(join(legacy, entry), join(next, entry)));
      } catch { return false; }
    };
    const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const state = env.OVIS_STATE_DIR || (ownState(join(base, "herdr-web-ui"), join(base, "ovis")) ? join(base, "herdr-web-ui") : join(base, "ovis"));
    const saved = () => {
      try {
        const port = Number(readFileSync(join(state, "plugin-port"), "utf8").trim());
        return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
      } catch { return null; }
    };
    const port = (env.PORT ?? "") !== "" ? Number(env.PORT) : saved() ?? 7317;
    const updates = join(resolve(state), "updates", createHash("sha256").update(`${resolve(root)}:${port}`).digest("hex").slice(0, 16));
    const current = JSON.parse(readFileSync(join(updates, "current.json"), "utf8"));
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3000 });
    if (head.exitCode === 0 && current.source_revision === head.stdout.toString().trim() && typeof current.directory === "string") {
      const directory = realpathSync(current.directory);
      const file = join(directory, "scripts", "plugin.ts");
      if (dirname(directory) === realpathSync(updates) && basename(directory).startsWith("release-") && existsSync(file) && realpathSync(file).startsWith(directory + sep)) found = directory;
    }
  } catch {}
  console.log(found);
EOF
}

# herdr's checkout stays at the version first installed, so one from before `link` cannot hand on at
# all: for it the launcher finds the release that runs, as running_code does below (release_js, which
# the launcher carries), and runs that; where that one has no `link` either, it says to update.
launcher_text() {
  printf '%s\n' '#!/bin/sh' "$LAUNCHER_MARK"
  cat <<'EOF'
# Runs the installed Ovis's command line (scripts/plugin.ts): ovis add, ovis pair, ovis status.
set -eu
# the release's compiled server, as install.sh installs it: it needs no Bun. On herdr-core it gets the
# settings and state dirs its service gives it.
ovis_home="$HOME/.local/share/ovis"
if [ -x "$ovis_home/bin/ovis-server" ]; then
  if [ "$(cat "$ovis_home/runtime" 2>/dev/null || true)" = herdr-core ]; then
    if [ -z "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then
      HERDR_PLUGIN_CONFIG_DIR="$HOME/.config/ovis"
      [ -d "$HERDR_PLUGIN_CONFIG_DIR" ] || [ ! -d "$HOME/.config/herdr-web-ui" ] || HERDR_PLUGIN_CONFIG_DIR="$HOME/.config/herdr-web-ui"
      export HERDR_PLUGIN_CONFIG_DIR
    fi
    if [ -z "${HERDR_PLUGIN_STATE_DIR:-}" ]; then
      HERDR_PLUGIN_STATE_DIR="$HOME/.local/state/ovis"
      [ -d "$HERDR_PLUGIN_STATE_DIR" ] || [ ! -d "$HOME/.local/state/herdr-web-ui" ] || HERDR_PLUGIN_STATE_DIR="$HOME/.local/state/herdr-web-ui"
      export HERDR_PLUGIN_STATE_DIR
    fi
  fi
  # herdr where the installer puts it, for a shell whose PATH lacks it: the plugin finds its config dir through herdr
  PATH="$PATH:$HOME/.local/bin"
  export PATH
  exec "$ovis_home/bin/ovis-server" plugin "$@"
fi
EOF
  # shellcheck disable=SC2016 # the launcher's own words
  printf '%s\n' '# JavaScript: prints the folder of the release that runs for the checkout it is given (install.sh, release_js)' "release_js='"
  release_js
  printf '%s\n' "'"
  cat <<'EOF'
# where the installer puts herdr and Bun, for a shell whose PATH has neither
PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin"
export PATH
command -v bun >/dev/null 2>&1 || { echo "ovis: needs Bun, which is not on the PATH. Run the installer again: curl -fsSL https://ovis.sh/install.sh | sh" >&2; exit 1; }
root=""
app="$HOME/.local/share/ovis/app"
if command -v herdr >/dev/null 2>&1; then
  plugins=$(herdr plugin list --json 2>/dev/null </dev/null) || plugins=""
  for id in devswha.ovis devswha.herdr-web-ui; do
    root=$(printf '%s' "$plugins" | bun -e 'try { const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === process.argv[1])?.plugin_root ?? "") } catch { console.log("") }' "$id" 2>/dev/null) || root=""
    [ -z "$root" ] || break
  done
fi
if [ -z "$root" ] && [ -f "$app/scripts/plugin.ts" ]; then
  root=$app
  if [ -z "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then
    HERDR_PLUGIN_CONFIG_DIR="$HOME/.config/ovis"
    [ -d "$HERDR_PLUGIN_CONFIG_DIR" ] || [ ! -d "$HOME/.config/herdr-web-ui" ] || HERDR_PLUGIN_CONFIG_DIR="$HOME/.config/herdr-web-ui"
    export HERDR_PLUGIN_CONFIG_DIR
  fi
  if [ -z "${HERDR_PLUGIN_STATE_DIR:-}" ]; then
    HERDR_PLUGIN_STATE_DIR="$HOME/.local/state/ovis"
    [ -d "$HERDR_PLUGIN_STATE_DIR" ] || [ ! -d "$HOME/.local/state/herdr-web-ui" ] || HERDR_PLUGIN_STATE_DIR="$HOME/.local/state/herdr-web-ui"
    export HERDR_PLUGIN_STATE_DIR
  fi
fi
if [ -z "$root" ] || [ ! -f "$root/scripts/plugin.ts" ]; then
  echo "ovis: Ovis is not installed on this PC. Install it with: curl -fsSL https://ovis.sh/install.sh | sh" >&2
  exit 1
fi
code=$root
case "${1:-}" in
  add | login | link)
    if ! grep -qs '"link"' "$root/scripts/plugin.ts"; then
      # a checkout from before link: Settings → Updates runs newer releases from the app's state dir
      code=$(bun -e "$release_js" "$root" 2>/dev/null </dev/null) || code=$root
      [ -n "$code" ] || code=$root
    fi
    if grep -qs COMMAND_ALIASES "$code/scripts/plugin.ts"; then
      :
    elif grep -qs '"link"' "$code/scripts/plugin.ts"; then
      shift
      set -- link "$@"
    else
      echo "ovis: this Ovis is from before it could add a PC to an account. Update it in Settings → Updates, then run this again" >&2
      exit 1
    fi
    ;;
  tui)
    # a checkout from before ovis tui: the release Settings → Updates installed may know it
    if ! grep -qs '"tui"' "$root/scripts/plugin.ts"; then
      code=$(bun -e "$release_js" "$root" 2>/dev/null </dev/null) || code=$root
      [ -n "$code" ] || code=$root
      if ! grep -qs '"tui"' "$code/scripts/plugin.ts"; then
        echo "ovis: this Ovis is from before ovis tui. Update it in Settings → Updates, then run this again" >&2
        exit 1
      fi
    fi
    ;;
esac
exec bun "$code/scripts/plugin.ts" "$@"
EOF
}

find_other_ovis() {
  other_ovis=""
  other_ovis_hidden=0
  other_saved_ifs=$IFS
  IFS=:
  set -f
  for other_dir in ${original_path:-}; do
    # shellcheck disable=SC3013 # -ef: the same folder under another spelling; dash, bash and busybox have it
    if [ "$other_dir" = "$BIN_DIR" ] || [ "$other_dir" -ef "$BIN_DIR" ]; then
      other_ovis_hidden=1
    elif [ -n "$other_dir" ] && [ -f "$other_dir/ovis" ] && [ -x "$other_dir/ovis" ]; then
      other_ovis="$other_dir/ovis"
      break
    fi
  done
  set +f
  IFS=$other_saved_ifs
  [ -n "$other_ovis" ] || other_ovis_hidden=0
}

# A file of that name the installer did not write (no mark on its second line, or a link) is someone's
# own: it stays, and the installer says so. So does another ovis elsewhere on the PATH: where BIN_DIR
# comes first, a new launcher would take its name, so none is written; where it comes first, the
# launcher is written and the installer says which one the name runs, and that it is the launcher's once
# BIN_DIR comes first (a profile that puts ~/.local/bin first does that at the next login).
write_launcher() {
  launcher="$BIN_DIR/ovis"
  launcher_ours=0
  launcher_there=0
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if [ -L "$launcher" ] || [ ! -f "$launcher" ] || [ "$(sed -n 2p "$launcher" 2>/dev/null || true)" != "$LAUNCHER_MARK" ]; then
      say "$launcher is there already and is not this installer's, so it is left as it is and no ovis command was installed"
      return 0
    fi
    launcher_there=1
  fi
  find_other_ovis
  if [ -n "$other_ovis" ] && [ "$other_ovis_hidden" = 1 ] && [ "$launcher_there" = 0 ]; then
    say "$other_ovis is another ovis on your PATH, and $BIN_DIR comes before it there: an ovis command of this installer's would take its name, so none was installed"
    return 0
  fi
  # written beside it under a name of its own (mktemp never follows a link or reuses a file that is
  # there) and moved over it: an interrupted run leaves no half-written command
  launcher_new=""
  if mkdir -p "$BIN_DIR" 2>/dev/null && launcher_new=$(mktemp "$BIN_DIR/.ovis.XXXXXX" 2>/dev/null) \
    && launcher_text >"$launcher_new" && chmod 755 "$launcher_new" && mv -f "$launcher_new" "$launcher"; then
    launcher_ours=1
  else
    [ -z "$launcher_new" ] || rm -f "$launcher_new" 2>/dev/null || true
    say "could not write $launcher, so no ovis command was installed"
    return 0
  fi
  if [ -n "$other_ovis" ] && [ "$other_ovis_hidden" = 1 ]; then
    say "$other_ovis is another ovis on your PATH: $launcher, this installer's, comes before it there"
  elif [ -n "$other_ovis" ]; then
    say "ovis on your PATH runs $other_ovis, another program: this installer's is $launcher, which takes the name once $BIN_DIR comes before it on your PATH"
  fi
}

# A path as a command line takes it: as it is, or in single quotes where it holds a space or anything
# else a shell reads (a home directory called "John Smith").
quoted() {
  case $1 in
    *[!A-Za-z0-9_./+:@%,=-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

ovis_command() {
  if [ "$launcher_ours" != 1 ] && [ "${binary:-0}" = 1 ]; then
    printf '%s plugin' "$(quoted "$OVIS_HOME/bin/ovis-server")"
  elif [ "$launcher_ours" != 1 ]; then
    printf 'bun %s' "$(quoted "${add_code:-${code:-$root}}/scripts/plugin.ts")"
  elif [ "$(PATH="${original_path:-}"; command -v ovis 2>/dev/null || true)" = "$BIN_DIR/ovis" ]; then
    printf '%s' "ovis"
  else
    quoted "$BIN_DIR/ovis"
  fi
}

find_add_name() {
  if [ "${binary:-0}" = 1 ]; then
    add_code=$OVIS_HOME
    add_name=add
    return 0
  fi
  add_code=$root
  grep -qs '"link"' "$root/scripts/plugin.ts" || add_code=${code:-$root}
  if grep -qs 'COMMAND_ALIASES' "$add_code/scripts/plugin.ts"; then
    add_name=add
  elif grep -qs '"link"' "$add_code/scripts/plugin.ts"; then
    add_name=link
  else
    add_name=""
  fi
}

# Whether the add step that would run tells a line typed ahead from an answer. A release up to v0.5.2
# asks about a device with [y/N] and takes the next line the terminal hands it, so a "y" and Enter
# typed during the minutes of its sign-in would approve the first device that asks: nothing this
# installer discards before the add starts covers those. The reader that takes a line only when it
# was typed under the request shown, and approves only with that request's own digits, is `answerOf`
# (scripts/plugin-link.ts), a name only releases with that reader have.
add_reads_answers() {
  [ "${binary:-0}" != 1 ] || return 0
  grep -qs 'export function answerOf' "${code:-$root}/scripts/plugin-link.ts"
}

add_command() {
  if [ "$launcher_ours" = 1 ]; then
    printf '%s' "$(ovis_command) add"
  else
    printf '%s' "$(ovis_command) $add_name"
  fi
}

# Whether this install holds the terminal's foreground: a background job that read from the terminal
# would be stopped by it (SIGTTIN) until someone brought it forward.
in_foreground() {
  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'exit 1 unless POSIX::tcgetpgrp(0) == POSIX::getpgrp()' </dev/tty >/dev/null 2>&1
  else
    foreground_ids=$(ps -o tpgid= -o pgid= -p $$ 2>/dev/null) || return 1
    set -- $foreground_ids
    [ $# = 2 ] && [ "$1" = "$2" ]
  fi
}

# Discards what is typed at the terminal and not read yet: lines typed while the installer worked, or
# pasted after its command, would otherwise be read by the add step as the answer to what it asks
# later (a "y" and Enter would approve the next device that asks). With perl, as the star question
# does it; else with stty and dd: with no line editing and no waiting, a read takes what is there
# and ends when nothing is. Fails where neither can, and the caller then reads nothing from the terminal.
discard_typed() {
  if command -v perl >/dev/null 2>&1; then
    # tcflush is "0 but true", undef on failure
    perl -MPOSIX -e 'POSIX::tcflush(0, POSIX::TCIFLUSH) or exit 1' </dev/tty >/dev/null 2>&1
    return
  fi
  command -v stty >/dev/null 2>&1 && command -v dd >/dev/null 2>&1 || return 1
  typed_settings=$(stty -g </dev/tty 2>/dev/null) || return 1
  stty -icanon min 0 time 0 </dev/tty 2>/dev/null || return 1
  typed_discarded=0
  dd bs=4096 of=/dev/null </dev/tty 2>/dev/null || typed_discarded=1
  stty "$typed_settings" </dev/tty 2>/dev/null || return 1
  return "$typed_discarded"
}

# It signs in and asks questions, so it runs only with someone to answer: at a terminal that shows what it
# prints and can be read from (under `curl | sh` stdin is the script, so the answers come from /dev/tty
# itself), and never under OVIS_NO_OPEN, which an install run for someone else sets (the app's own SSH
# installer), and only in the terminal's foreground: the add reads its answer there, and a background
# job that did would be stopped. What was typed at the terminal before the add starts is discarded first
# (discard_typed), and where it cannot be, the add does not run: nothing typed for something else
# answers it. Nor does it run on a release whose add step would take a line typed ahead for its answer
# (add_reads_answers; $add_old says so): the closing lines then say to update first.
# Who counts as this PC is said before it starts, while the token can still be set first ($token_said).
add_pc() {
  add_result=none
  token_said=0
  add_waits=0
  add_old=0
  find_add_name
  [ "$add" = 1 ] || return 0
  [ -n "$add_name" ] || return 0
  if ! add_reads_answers; then
    add_old=1
    return 0
  fi
  if ! { if [ "${binary:-0}" = 1 ]; then ovis_cli status; else bun "$root/scripts/plugin.ts" status; fi; } </dev/null 2>/dev/null | grep -q '^running'; then
    add_waits=1
    return 0
  fi
  [ "$terminal" = 1 ] && [ -z "${OVIS_NO_OPEN:-${HERDR_WEB_NO_OPEN:-}}" ] || return 0
  (exec 3<>/dev/tty) 2>/dev/null || return 0
  in_foreground || return 0
  trap ':' INT
  # what is typed from here on is the add step's own to tell from an answer (scripts/plugin-link.ts)
  if ! discard_typed; then
    trap - INT
    return 0
  fi
  echo
  token_line
  token_said=1
  add_result=done
  if [ "${binary:-0}" = 1 ]; then
    ovis_cli "$add_name" </dev/tty || add_result=failed
  else
    bun "$add_code/scripts/plugin.ts" "$add_name" </dev/tty || add_result=failed
  fi
  trap - INT
}

# Who counts as this PC while it has no token: said before the PC is added, by whichever adds it.
token_line() {
  say "on a PC other people log in to, set OVIS_TOKEN first: without it any local user counts as this PC ($(link "https://github.com/$REPO/blob/main/docs/relay.md#a-pc-with-no-screen"))"
}

closing_lines() {
  echo
  if [ "$add_result" = done ]; then
    :
  elif [ -z "$add_name" ]; then
    say "this Ovis is from before it could add a PC to an account from its terminal: update it in Settings → Updates, then run this installer again"
  elif [ "$add" = 1 ] && [ "${add_old:-0}" = 1 ]; then
    say "this Ovis release would take a line typed ahead as its answer about the device that adds this PC, so the installer does not start that step for it. Update Ovis in Settings → Updates, then run in a terminal on this PC: $(add_command)"
  elif [ "$add" = 1 ] && [ "${add_waits:-0}" = 1 ]; then
    say "the app is not running yet, so this PC was not added to your Ovis account. Once it runs, run in a terminal on this PC: $(add_command)"
  elif [ "$add" = 1 ] && [ "$add_result" = none ]; then
    say "to add this PC to your Ovis account, run in a terminal on this PC: $(add_command)"
  else
    say "to add this PC to your Ovis account: $(add_command)"
  fi
  [ "${token_said:-0}" = 1 ] || token_line
}

# kills a process and everything it started (ps -A -o pid= -o ppid= reads the same on Linux and macOS)
kill_tree() {
  for kill_child in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v parent="$1" '$2 == parent { print $1 }'); do
    kill_tree "$kill_child"
  done
  kill -KILL "$1" 2>/dev/null || true
}

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

# the published SHA-256 of the official Node build for $platform, in $node_sha
node_sha_for() {
  case "$platform" in
    linux-x64) node_sha=b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a ;;
    linux-arm64) node_sha=013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30 ;;
    darwin-x64) node_sha=58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026 ;;
    darwin-arm64) node_sha=61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6 ;;
  esac
}

install_node() {
  node_sha_for
  say "installing Node $NODE_VERSION into $NODE_DIR"
  # it runs as a condition, where set -e does nothing: each step says itself when it fails
  tmp=$(mktemp -d) || return 1
  archive="$tmp/node.tar.gz"
  curl -fsSL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$platform.tar.gz" -o "$archive" || { rm -rf "$tmp"; return 1; }
  [ "$(sha256 "$archive")" = "$node_sha" ] || { rm -rf "$tmp"; say "the Node download does not match its published SHA-256; nothing was installed"; return 1; }
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
# first there and overrode the user's own Node (#596).
# An older release finds Node on the PATH only, so our Node is linked for it as before, the one from
# before the rename too: where it needs one ($2 = needed: no Rust PTY host) and the user's PATH has no
# Node 18 or newer, or always once herdr's build said its own PATH has none ($2 = installed), since
# herdr's PATH need not be the user's (nvm in .bashrc).
node_link() {
  if grep -qs 'share/ovis/node' "$1/server/pty/sidecar.ts"; then
    [ -L "$BIN_DIR/node" ] || return 0
    case "$(readlink "$BIN_DIR/node")" in
      "$NODE_DIR/bin/node" | "$LEGACY_NODE_DIR/bin/node")
        rm -f "$BIN_DIR/node"
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
# in the app's state dir and runs it from there (server/updater.ts, current.json).
running_code() {
  running_found=$(bun -e "$(release_js)" "$1" 2>/dev/null </dev/null) || running_found=""
  printf '%s\n' "${running_found:-$1}"
}

# Where releases come from, in $releases: OVIS_RELEASES_URL (an https:// address, or a file:// folder for
# tests), else GitHub's downloads; each version's files are in <releases>/v<version>/. Plain http, or
# anything else, is refused before anything is downloaded.
releases_base() {
  releases=${OVIS_RELEASES_URL:-https://github.com/$REPO/releases/download}
  while :; do case "$releases" in */) releases=${releases%/} ;; *) break ;; esac; done
  case "$releases" in
    https://?* | file:///*) ;;
    *) fail "OVIS_RELEASES_URL must be an https:// address or a file:// folder (file:///path); $releases is neither" ;;
  esac
}

# fetch <url> <file> <most bytes>: curl over https (a redirect to anything else is refused) or from a
# file:// folder, stopped past the size it is given. Its exit code is curl's: 63 for a file too large.
fetch() {
  curl -fsSL --proto '=https,file' --proto-redir '=https' --max-filesize "$3" --retry 3 -o "$2" "$1" </dev/null
}

# A signature checker: <checker> <public key, base64> <message file> <signature file, one base64 line>.
# openssl (3.0 or newer: Ed25519 over raw bytes) builds the key from its 32 bytes behind the SPKI prefix
# of an Ed25519 key, MCowBQYDK2VwAyEA in base64; node does the same with its crypto module.
verify_openssl() {
  printf '%s\n%s\n%s\n' '-----BEGIN PUBLIC KEY-----' "MCowBQYDK2VwAyEA$1" '-----END PUBLIC KEY-----' >"$verify_dir/key.pem"
  openssl base64 -d -A -in "$3" -out "$verify_dir/signature.bin" 2>/dev/null || return 1
  openssl pkeyutl -verify -pubin -inkey "$verify_dir/key.pem" -rawin -in "$2" -sigfile "$verify_dir/signature.bin" >/dev/null 2>&1
}
verify_node() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  "$node_bin" -e 'const c = require("crypto"), f = require("fs"); const key = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(process.argv[1], "base64")]), format: "der", type: "spki" }); process.exit(c.verify(null, f.readFileSync(process.argv[2]), key, Buffer.from(f.readFileSync(process.argv[3], "utf8").trim(), "base64")) ? 0 : 1)' "$1" "$2" "$3" </dev/null >/dev/null 2>&1
}
# Whether checker $1 tells RFC 8032's vector from the same signature over another message
checker_works() {
  printf r >"$verify_dir/vector-good"
  printf s >"$verify_dir/vector-bad"
  printf '%s\n' "$VECTOR_SIG" >"$verify_dir/vector.sig"
  "$1" "$VECTOR_KEY" "$verify_dir/vector-good" "$verify_dir/vector.sig" && ! "$1" "$VECTOR_KEY" "$verify_dir/vector-bad" "$verify_dir/vector.sig"
}
# The signature checker for this run, in $checker and $checker_name: openssl where it can, else the
# node on the PATH, else the official Node build fetched into the run's own folder (checked against its
# published SHA-256, and deleted with that folder: nothing of it stays installed).
pick_checker() {
  checker=""
  if command -v openssl >/dev/null 2>&1 && checker_works verify_openssl; then
    checker=verify_openssl
    checker_name=openssl
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
    if checker_works verify_node; then
      checker=verify_node
      checker_name=node
      return 0
    fi
  fi
  node_sha_for
  node_archive="$verify_dir/node.tar.gz"
  fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$platform.tar.gz" "$node_archive" 200000000 || return 1
  [ "$(sha256 "$node_archive")" = "$node_sha" ] || return 1
  tar -xzf "$node_archive" -C "$verify_dir" "node-$NODE_VERSION-$platform/bin/node" || return 1
  node_bin="$verify_dir/node-$NODE_VERSION-$platform/bin/node"
  checker_works verify_node || return 1
  checker=verify_node
  checker_name="Node $NODE_VERSION, fetched for this check"
}

# The entry for $2 (a platform, or dist for the client) in the checked manifest $1, as scripts/server-manifest.ts
# writes it (two-space JSON, which the signature vouches for byte for byte): $entry_file, $entry_sha, $entry_size.
manifest_entry() {
  # by section: the PTY hosts' keys repeat platform names
  case "$2" in
    dist) entry=$(sed -n '/^  "dist": {$/,/^  }/p' "$1") ;;
    pty-*) entry=$(sed -n '/^  "pty": {$/,/^  }/p' "$1" | sed -n "/^    \"${2#pty-}\": {\$/,/^    }/p") ;;
    *) entry=$(sed -n '/^  "assets": {$/,/^  }/p' "$1" | sed -n "/^    \"$2\": {\$/,/^    }/p") ;;
  esac
  entry_file=$(printf '%s\n' "$entry" | sed -n 's/^ *"file": "\([^"]*\)",$/\1/p')
  entry_sha=$(printf '%s\n' "$entry" | sed -n 's/^ *"sha256": "\([0-9a-f]\{64\}\)",$/\1/p')
  entry_size=$(printf '%s\n' "$entry" | sed -n 's/^ *"size": \([0-9]\{1,15\}\)$/\1/p')
}

refuse() {
  [ -z "${stage:-}" ] || rm -rf "$stage"
  fail "$*; nothing was changed"
}

# take <name> <file in stage> <section of the manifest>: the release's file, downloaded into the stage
# and kept only with the name, size and SHA-256 the checked manifest gives it
take() {
  manifest_entry "$stage/ovis-server.json" "$3"
  [ "$entry_file" = "$1" ] && [ -n "$entry_sha" ] && [ -n "$entry_size" ] || refuse "ovis-server.json names no $1 with its SHA-256 and size"
  take_status=0
  fetch "$at/$1" "$stage/$2" "$entry_size" || take_status=$?
  [ "$take_status" != 63 ] || refuse "$1 is larger than the $entry_size bytes ovis-server.json names"
  [ "$take_status" = 0 ] || refuse "could not download $at/$1 (curl exit $take_status)"
  got_size=$(wc -c <"$stage/$2" | tr -d ' ')
  [ "$got_size" -le "$entry_size" ] || refuse "$1 is larger than the $entry_size bytes ovis-server.json names"
  [ "$got_size" = "$entry_size" ] || refuse "$1 is $got_size bytes, not the $entry_size ovis-server.json names"
  got_sha=$(sha256 "$stage/$2")
  [ "$got_sha" = "$entry_sha" ] || refuse "$1 does not match its SHA-256 in ovis-server.json (got $got_sha)"
}

# The release's Rust PTY host into $stage/bin, only the one the signed ovis-server.json names (its SHA-256 and size
# there, never another file's word for it), tried here; the record beside it is what the server checks before it
# runs it (server/pty/host.ts). Without one that runs, terminals are mirrored: nothing here fails the install.
binary_pty_host() {
  case "$platform" in
    linux-x64 | linux-arm64) pty_asset=$platform ;;
    darwin-*) pty_asset=darwin-universal ;;
    *) return 0 ;;
  esac
  manifest_entry "$stage/ovis-server.json" "pty-$pty_asset"
  pty_file=$entry_file pty_sha=$entry_sha pty_size=$entry_size
  if [ "$pty_file" != "ovis-pty-sidecar-$pty_asset" ] || [ -z "$pty_sha" ] || [ -z "$pty_size" ]; then
    say "the signed ovis-server.json names no Rust PTY host for $platform, so terminals are mirrored"
    return 0
  fi
  mkdir -p "$stage/bin"
  if ! fetch "$at/$pty_file" "$stage/bin/ovis-pty-sidecar" "$pty_size" || [ "$(wc -c <"$stage/bin/ovis-pty-sidecar" | tr -d ' ')" != "$pty_size" ] ||
    [ "$(sha256 "$stage/bin/ovis-pty-sidecar")" != "$pty_sha" ]; then
    rm -rf "$stage/bin"
    say "the Rust PTY host did not download or does not match its SHA-256 and size in ovis-server.json, so it is not run and terminals are mirrored"
    return 0
  fi
  chmod 755 "$stage/bin/ovis-pty-sidecar"
  if ! rust_host_runs "$stage/bin/ovis-pty-sidecar"; then
    rm -rf "$stage/bin"
    say "the Rust PTY host does not run on this PC, so terminals are mirrored"
    return 0
  fi
  printf '{"sha256":"%s","version":"%s"}\n' "$pty_sha" "$version" >"$stage/bin/ovis-pty-sidecar.json"
}

# One install at a time in OVIS_HOME: $OVIS_HOME/.install.lock, a folder whose pid file, created only where none is,
# holds this shell's pid. Released on every exit, a signal's included; only kill -9 leaves it, stale.
install_lock() {
  lock="$OVIS_HOME/.install.lock"
  mkdir -p "$OVIS_HOME"
  lock_waited=0
  # The claim is the pid file, created only where none is (noclobber opens it O_EXCL in the shell itself): mkdir's
  # exit alone does not exclude, as some mkdir commands report success to two callers at once (uutils coreutils)
  while ! { mkdir "$lock" 2>/dev/null; (set -C; printf '%s\n' "$$" >"$lock/pid") 2>/dev/null; }; do
    if (set -C; printf '%s\n' "$$" >"$lock.break") 2>/dev/null; then
      lock_holder=$(cat "$lock/pid" 2>/dev/null || true)
      lock_stale=0
      if [ -n "$lock_holder" ] && ! kill -0 "$lock_holder" 2>/dev/null; then
        lock_stale=1
      elif [ -z "$lock_holder" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
        lock_stale=1
      fi
      # removed only while it still holds the record judged stale: a fresh holder's lock is never taken
      if [ "$lock_stale" = 1 ] && [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$lock_holder" ]; then install_lock_drop || true; fi
      rm -rf "$lock.break" 2>/dev/null || true
      [ -e "$lock" ] || continue
    elif [ -n "$(find "$lock.break" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      rm -rf "$lock.break" 2>/dev/null || true
    fi
    if [ "$lock_waited" -ge "$INSTALL_LOCK_WAIT_SECONDS" ]; then
      fail "another install is running in $OVIS_HOME (pid $(cat "$lock/pid" 2>/dev/null || echo unknown)); run this again once it ends. Nothing was changed"
    fi
    [ "$lock_waited" != 0 ] || say "another install is running in $OVIS_HOME; waiting for it"
    sleep 1
    lock_waited=$((lock_waited + 1))
  done
  trap 'install_unlock' EXIT
  trap 'install_unlock; exit 129' HUP
  trap 'install_unlock; exit 130' INT
  trap 'install_unlock; exit 143' TERM
  # a run cut off between its lock's rename and its removal left that folder: the holder removes it, before its own
  # rename may need the same name. A run releasing its lock may be removing the same folder at that moment, and
  # busybox rm then fails on what the other removed (No such file or directory): neither removal has to succeed, as
  # whatever is left is the next holder's to remove
  rm -rf "$lock".gone-* 2>/dev/null || true
}
install_unlock() {
  if [ -n "${lock:-}" ] && [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$$" ]; then install_lock_drop; fi
  trap - EXIT HUP INT TERM
}
# rm -rf in place unlinks the pid a moment before the folder: a waiter could claim the lock in that moment (its pid
# file is created wherever none is), and the folder it holds would then not be removed (Directory not empty), failing
# the run that let it go
install_lock_drop() {
  mv "$lock" "$lock.gone-$$" && { rm -rf "$lock.gone-$$" 2>/dev/null || true; }
}

# Whether the release of $version runs in OVIS_HOME already: its manifest there names it, and the binary
# has the SHA-256 that manifest gives it
binary_current() {
  [ "$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$OVIS_HOME/bin/ovis-server.json" 2>/dev/null)" = "$version" ] || return 1
  manifest_entry "$OVIS_HOME/bin/ovis-server.json" "$platform"
  [ -n "$entry_sha" ] && [ -f "$OVIS_HOME/bin/ovis-server" ] && [ "$(sha256 "$OVIS_HOME/bin/ovis-server")" = "$entry_sha" ] &&
    [ -f "$OVIS_HOME/bin/dist/index.html" ]
}

# In order, and nothing in OVIS_HOME changes before the last step: the manifest and its signature, checked
# against RELEASE_PUBLIC_KEY and for this very version (a valid signature alone would let an older release
# through); the binary and the client archive, each with the size and SHA-256 the manifest names; the
# archive's listing, only plain files and folders inside it; then releases/<version>-<id> takes its name
# and bin, a link to it, is swapped by one rename.
install_binary() {
  version=$1
  binary_changed=0
  releases_base
  at="$releases/v$version"
  if [ -e "$OVIS_HOME/bin" ] && [ ! -L "$OVIS_HOME/bin" ]; then
    fail "$OVIS_HOME/bin is there and is not this installer's link; move it away and run this again. Nothing was changed"
  fi
  if binary_current; then
    say "Ovis $version is installed already in $OVIS_HOME; nothing to do"
    return 0
  fi
  install_lock
  if binary_current; then
    install_unlock
    say "Ovis $version is installed already in $OVIS_HOME; nothing to do"
    return 0
  fi
  mkdir -p "$OVIS_HOME/releases"
  rm -rf "$OVIS_HOME"/releases/.stage-* "$OVIS_HOME"/.bin-*
  stage=$(mktemp -d "$OVIS_HOME/releases/.stage-XXXXXX") || fail "could not make a folder in $OVIS_HOME/releases"
  verify_dir="$stage/.check"
  mkdir "$verify_dir"
  fetch "$at/ovis-server.json" "$stage/ovis-server.json" 65536 || refuse "could not download $at/ovis-server.json"
  fetch "$at/ovis-server.json.sig" "$stage/ovis-server.json.sig" 1024 || refuse "could not download $at/ovis-server.json.sig"
  [ "$(wc -l <"$stage/ovis-server.json.sig" | tr -d ' ')" = 1 ] && grep -Eqx '[A-Za-z0-9+/]{86}==' "$stage/ovis-server.json.sig" \
    || refuse "ovis-server.json.sig is not one line of base64 holding a signature"
  pick_checker || refuse "found no way to check the release's signature here (openssl 3, or Node), and could not fetch Node for it"
  "$checker" "$RELEASE_PUBLIC_KEY" "$stage/ovis-server.json" "$stage/ovis-server.json.sig" \
    || refuse "ovis-server.json.sig is not a valid signature of the release's ovis-server.json by the key $RELEASE_PUBLIC_KEY"
  manifest_version=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$stage/ovis-server.json")
  [ "$manifest_version" = "$version" ] || refuse "ovis-server.json is for version $manifest_version, not $version"
  grep -qx '  "schema": 1,' "$stage/ovis-server.json" || refuse "ovis-server.json is of a schema this installer does not know; a newer install.sh reads it"
  say "checked the signature with $checker_name"
  take "ovis-server-$platform" ovis-server "$platform"
  take ovis-dist.tar.gz ovis-dist.tar.gz dist
  chmod 755 "$stage/ovis-server"
  dist_names=$(tar -tzf "$stage/ovis-dist.tar.gz" 2>/dev/null) || refuse "could not read ovis-dist.tar.gz"
  if printf '%s\n' "$dist_names" | grep -Eq '^/|(^|/)\.\.(/|$)'; then refuse "ovis-dist.tar.gz holds a path outside its folder"; fi
  dist_list=$(tar -tzvf "$stage/ovis-dist.tar.gz" 2>/dev/null) || refuse "could not read ovis-dist.tar.gz"
  if printf '%s\n' "$dist_list" | grep -q '^[^-d]'; then refuse "ovis-dist.tar.gz holds something other than files and folders"; fi
  mkdir "$stage/dist"
  tar -xzf "$stage/ovis-dist.tar.gz" -C "$stage/dist" --no-same-owner 2>/dev/null || refuse "could not unpack ovis-dist.tar.gz"
  [ -z "$(find "$stage/dist" ! -type f ! -type d)" ] || refuse "ovis-dist.tar.gz unpacked something other than files and folders"
  [ -f "$stage/dist/index.html" ] || refuse "ovis-dist.tar.gz holds no index.html"
  rm -f "$stage/ovis-dist.tar.gz"
  binary_pty_host
  rm -rf "$verify_dir"
  release_name="$version-${stage##*.stage-}"
  mv "$stage" "$OVIS_HOME/releases/$release_name" || refuse "could not move the checked release into place"
  stage=""
  # the release bin names now: a server started from it may still run, so it stays until the next install
  previous="$OVIS_HOME/$(readlink "$OVIS_HOME/bin" 2>/dev/null || true)"
  link="$OVIS_HOME/.bin-$$"
  ln -s "releases/$release_name" "$link" || fail "could not link $OVIS_HOME/bin; nothing was changed"
  # one rename over the old link: -T (GNU) and -h (BSD) keep mv from moving the link into the folder bin names
  if [ "$os" = darwin ]; then swap_flag=-fh; else swap_flag=-fT; fi
  mv "$swap_flag" "$link" "$OVIS_HOME/bin" || { rm -f "$link"; fail "could not swap $OVIS_HOME/bin; nothing was changed"; }
  for old in "$OVIS_HOME"/releases/*; do
    case "$old" in "$OVIS_HOME/releases/$release_name" | "$previous") ;; *) rm -rf "$old" ;; esac
  done
  install_unlock
  binary_changed=1
  say "installed Ovis $version (ovis-server-$platform, checked against the signed ovis-server.json) in $OVIS_HOME"
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

core_dirs() {
  settings_dir="$HOME/.config/ovis"
  [ -d "$settings_dir" ] || [ ! -d "$HOME/.config/herdr-web-ui" ] || settings_dir="$HOME/.config/herdr-web-ui"
  state_dir="$HOME/.local/state/ovis"
  [ -d "$state_dir" ] || [ ! -d "$HOME/.local/state/herdr-web-ui" ] || state_dir="$HOME/.local/state/herdr-web-ui"
}

saved_setting() {
  core_dirs
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$settings_dir/env" "$settings_dir/.env" 2>/dev/null \
    | tail -n 1 | sed -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//"
}

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

pick_runtime() {
  case "${OVIS_RUNTIME:-}" in
    herdr) runtime=herdr; return 0 ;;
    herdr-core) runtime=herdr-core ;;
    "")
      if [ -d "$APP_DIR/.git" ] || [ "$(cat "$OVIS_HOME/runtime" 2>/dev/null || true)" = herdr-core ]; then
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
# as the token in it needs.
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

core_service() {
  # one line each in the unit: a newline in a value would start a directive of its own
  case "$PATH$settings_dir$state_dir$APP_DIR$OVIS_HOME" in *'
'*) fail "a newline in PATH or HOME cannot go into a service file; remove it and run this again" ;; esac
  bun_bin=${1:-$(command -v bun)}
  service_entry=${2:-$APP_DIR/scripts/plugin.ts}
  start_line="HERDR_PLUGIN_CONFIG_DIR=$settings_dir HERDR_PLUGIN_STATE_DIR=$state_dir ${1:-bun} $service_entry start"
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
  <key>ProgramArguments</key><array><string>$(xml_text "$bun_bin")</string><string>$(xml_text "$service_entry")</string><string>start</string></array>
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
ExecStart="$(unit_text "$bun_bin" exec)" "$(unit_text "$service_entry" exec)" start
ExecStop="$(unit_text "$bun_bin" exec)" "$(unit_text "$service_entry" exec)" stop
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

ref_not_moved() {
  [ -n "${OVIS_REF:-${HERDR_WEB_UI_REF:-}}" ] || return 0
  # What git answers, by the rule scripts/plugin-launch.ts (checkoutCommit) and install.ps1 read the installed commit
  # by: a checkout's top level has its commit; a folder inside another repository (--show-prefix names its path there:
  # git would read that repository's commit, not the plugin's) or one git says is no repository has none; anything else
  # is git failing, which is said with git's first line (untranslated: LC_ALL=C). Only git's stdout is the prefix and
  # the commit: a warning it prints on stderr while it succeeds is neither. With no checkout to read (herdr did not name
  # the plugin's root), git -C "" would read the current directory's. With no file for git's stderr (mktemp failed), the
  # commit is still read, git's stderr discarded, and git's failures, which can no longer be told apart, are not said.
  ref_not_moved_at=""
  if [ -n "$1" ]; then
    ref_not_moved_err=$(mktemp 2>/dev/null) || ref_not_moved_err=""
    if ref_not_moved_git=$(LC_ALL=C git -C "$1" rev-parse --show-prefix 2>"${ref_not_moved_err:-/dev/null}" </dev/null); then
      if [ -z "$ref_not_moved_git" ]; then
        if ref_not_moved_git=$(LC_ALL=C git -C "$1" rev-parse --short=12 HEAD 2>"${ref_not_moved_err:-/dev/null}" </dev/null); then
          ref_not_moved_at="the installed checkout is at commit $ref_not_moved_git; "
        elif [ -n "$ref_not_moved_err" ]; then
          ref_not_moved_at="git could not read the installed checkout's commit ($(sed -n 1p "$ref_not_moved_err")); "
        fi
      fi
    elif [ -n "$ref_not_moved_err" ] && ! grep -q "not a git repository" "$ref_not_moved_err"; then
      ref_not_moved_at="git could not read the installed checkout's commit ($(sed -n 1p "$ref_not_moved_err")); "
    fi
    [ -z "$ref_not_moved_err" ] || rm -f "$ref_not_moved_err"
  fi
  say "${ref_not_moved_at}OVIS_REF does not move an installed Ovis (INSTALL.md, Update)"
}

# Ovis on herdr-core, without herdr or its plugin: its own checkout in APP_DIR, built from source after
# herdr-plugin.toml's pre-flight step, as scripts/plugin-launch.ts builds sources (the Rust PTY host aside:
# herdr-core's terminals need none), its settings, its service, and a start now.
install_core() {
  if [ -d "$APP_DIR/.git" ]; then
    say "already installed in $APP_DIR, on herdr-core; Settings → Updates keeps it current"
    ref_not_moved "$APP_DIR"
  elif [ -e "$APP_DIR" ]; then
    fail "$APP_DIR is there but is not an Ovis checkout; move it away and run this again"
  else
    ref=${OVIS_REF:-${HERDR_WEB_UI_REF:-$(latest_release)}}
    [ -n "$ref" ] || fail "could not look up the latest release on github.com. Check the connection and run this again."
    say "found herdr-core ($core), so Ovis runs on it: no herdr or herdr plugin needed"
    say "installing Ovis $ref into $APP_DIR (about a minute)"
    rm -rf "$APP_DIR.new"
    mkdir -p "$(dirname "$APP_DIR")"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" "https://github.com/$REPO.git" "$APP_DIR.new" </dev/null \
      || { rm -rf "$APP_DIR.new"; fail "could not download Ovis $ref from github.com. Check the connection and run this again."; }
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
  core_settings
  HERDR_PLUGIN_CONFIG_DIR=$settings_dir
  HERDR_PLUGIN_STATE_DIR=$state_dir
  export HERDR_PLUGIN_CONFIG_DIR HERDR_PLUGIN_STATE_DIR
  code=$(running_code "$root")
  core_service
  bun "$root/scripts/plugin.ts" start </dev/null \
    || say "Ovis did not start; what it said is above. Start it again with: $start_line"
}

install_plugin() {
  ref=""
  move=1
  if ! herdr plugin list 2>/dev/null | grep -q "$PLUGIN "; then
    need git
    ref=${OVIS_REF:-${HERDR_WEB_UI_REF:-$(latest_release)}}
    [ -n "$ref" ] || fail "could not look up the latest release on github.com. Check the connection and run this again."
    case "$(ref_plugin_id "$ref")" in
      "$LEGACY_PLUGIN") PLUGIN=$LEGACY_PLUGIN ;;
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
    ref_not_moved "$(plugin_root "$PLUGIN")"
  else
    say "installing the herdr plugin at $ref (herdr clones and builds it: about a minute)"
    # a branch builds its own sources: the plugin's launcher (scripts/plugin-launch.ts) would otherwise run the
    # release binary of the branch's package.json version; a release tag takes its binary, or its sources without one
    plugin_source=${OVIS_FROM_SOURCE:-}
    case "$ref" in v[0-9]*.[0-9]*.[0-9]*) ;; *) plugin_source=1 ;; esac
    # herdr previews the whole manifest first; on success its last word is enough, on failure all of it
    log=$(mktemp)
    installed=0
    if OVIS_FROM_SOURCE=$plugin_source herdr plugin install "$REPO" --ref "$ref" --yes </dev/null >"$log" 2>&1; then
      installed=1
    elif grep -q "Ovis needs Node 18 or newer" "$log" && ( install_node ); then
      # a release from before the Rust PTY host was the default still asks for Node in its first build
      # step, on herdr's PATH
      node_link "" installed
      OVIS_FROM_SOURCE=$plugin_source herdr plugin install "$REPO" --ref "$ref" --yes </dev/null >"$log" 2>&1 && installed=1
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
  needs_node=""
  if ! rust_host_runs "$code/bin/ovis-pty-sidecar"; then
    needs_node=needed
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

# old_shape_valid <manifest>: the release's ovis-server.json.sig is a valid signature of it by RELEASE_PUBLIC_KEY, and
# it names $version (a checker needs a folder of its own: made and removed here)
old_shape_valid() {
  verify_dir=$(mktemp -d) || return 1
  old_ok=1
  if fetch "$releases/$ref/ovis-server.json.sig" "$verify_dir/manifest.sig" 1024 2>/dev/null &&
    grep -Eqx '[A-Za-z0-9+/]{86}==' "$verify_dir/manifest.sig" && pick_checker &&
    "$checker" "$RELEASE_PUBLIC_KEY" "$1" "$verify_dir/manifest.sig" &&
    [ "$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$1")" = "$version" ]; then
    old_ok=0
  fi
  rm -rf "$verify_dir"
  verify_dir=""
  return "$old_ok"
}

# A source install asked for over the release's binary would find the plugin this installer linked "already
# installed", build nothing and report a start that never came: say before anything is installed how to move instead.
refuse_source_over_binary() {
  fail "$1, but Ovis is installed here as the release's binary ($OVIS_HOME). To move it to source, remove that first: ovis stop; herdr plugin uninstall $PLUGIN; rm -rf $OVIS_HOME/bin $OVIS_HOME/releases $OVIS_HOME/plugin; then run this again"
}

pick_install() {
  binary=0
  ref=${OVIS_REF:-${HERDR_WEB_UI_REF:-}}
  binary_home=0
  [ ! -e "$OVIS_HOME/bin/ovis-server" ] || binary_home=1
  if [ "${OVIS_FROM_SOURCE:-}" = 1 ]; then
    [ "$binary_home" = 0 ] || refuse_source_over_binary "OVIS_FROM_SOURCE=1 asks for a source install"
    return 0
  fi
  [ ! -d "$APP_DIR/.git" ] || return 0
  if command -v herdr >/dev/null 2>&1 && herdr plugin list 2>/dev/null </dev/null | grep -q -e "$PLUGIN " -e "$LEGACY_PLUGIN "; then
    [ -f "$OVIS_HOME/plugin/herdr-plugin.toml" ] || return 0
  fi
  releases_base
  if [ -z "$ref" ]; then
    case "$releases" in
      file://*) ref=$(find "${releases#file://}" -mindepth 1 -maxdepth 1 -type d -name 'v*' 2>/dev/null | sed -n 's|.*/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1) ;;
      *) need git; ref=$(latest_release) ;;
    esac
    [ -n "$ref" ] || fail "could not find the latest release in $releases. Check the connection and run this again."
  fi
  case "$ref" in
    v[0-9]*.[0-9]*.[0-9]*) version=${ref#v} ;;
    *)
      [ "$binary_home" = 0 ] || refuse_source_over_binary "OVIS_REF=$ref asks for a source install of a branch"
      return 0
      ;;
  esac
  probe=$(mktemp) || fail "could not make a temporary file"
  probe_status=0
  fetch "$releases/$ref/ovis-server.json" "$probe" 65536 2>/dev/null || probe_status=$?
  old_shape=0
  if [ "$probe_status" = 0 ] && ! grep -q '^  "schema": ' "$probe"; then
    # a manifest without a schema is of the shape releases had before this installer (todo 5's): signed, for this
    # version, it ships no compiled server this installer runs, as a release without one; the signature comes first
    old_shape_valid "$probe" || { rm -f "$probe"; fail "$releases/$ref/ovis-server.json is not signed by the key $RELEASE_PUBLIC_KEY for version $version; nothing was changed"; }
    old_shape=1 probe_status=37
  fi
  rm -f "$probe"
  case "$probe_status" in
    0) binary=1 ;;
    # any HTTP error (curl -f's 22) or no such file (37) reads as a release from before the compiled server: the source
    # of the same tag over TLS. Todo 7 (the updater) narrows this to 404 only, as scripts/plugin-launch.ts has it
    22 | 37)
      [ "$old_shape" = 0 ] || say "Ovis $ref's signed ovis-server.json has the shape from before this installer"
      if [ "$binary_home" = 1 ]; then
        [ -z "${OVIS_REF:-${HERDR_WEB_UI_REF:-}}" ] || refuse_source_over_binary "Ovis $ref ships no compiled server, so it would be a source install"
        say "could not check the release $ref ($releases, curl exit $probe_status); the installed Ovis stays as it is, nothing was changed"
        exit 0
      fi
      say "Ovis $ref ships no compiled server, so it is installed from source"
      ;;
    *) fail "could not reach $releases/$ref (curl exit $probe_status). Check the connection and run this again." ;;
  esac
}

# The platform of the binary to install: the machine's, also from a Rosetta shell on an arm64 Mac, where
# uname -m says x86_64
binary_platform() {
  if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
  platform="$os-$arch"
}

ovis_cli() {
  if [ "${binary:-0}" = 1 ]; then "$OVIS_HOME/bin/ovis-server" plugin "$@"; else bun "$code/scripts/plugin.ts" "$@"; fi
}

write_plugin() {
  mkdir -p "$OVIS_HOME/plugin"
  cat >"$OVIS_HOME/plugin/.run.sh.new" <<'EOF'
#!/bin/sh
# herdr's way into the Ovis that install.sh installed: the release's server, as `ovis-server plugin <command>`
exec "$(cd "$(dirname "$0")" && pwd -P)/../bin/ovis-server" plugin "$@"
EOF
  {
    printf 'id = "%s"\nname = "Ovis"\nversion = "%s"\nmin_herdr_version = "0.9.0"\n' "$PLUGIN" "$version"
    printf '%s\n' 'description = "Ovis, the browser and phone client for herdr, installed by install.sh as the release'\''s compiled server"' 'platforms = ["linux", "macos"]' ''
    printf '%s\n' '[[startup]]' 'command = ["sh", "run.sh", "start"]' ''
    for action in start:Start stop:Stop status:status; do
      case "${action#*:}" in status) title="Ovis status" ;; *) title="${action#*:} Ovis" ;; esac
      printf '[[actions]]\nid = "%s"\ntitle = "%s"\ncontexts = ["workspace"]\ncommand = ["sh", "run.sh", "%s"]\n\n' "${action%%:*}" "$title" "${action%%:*}"
    done
    printf '%s\n' '[[panes]]' 'id = "phone"' 'title = "Phone setup"' 'placement = "zoomed"' 'command = ["sh", "run.sh", "phone-setup"]' ''
    printf '%s\n' '[[actions]]' 'id = "phone"' 'title = "Phone setup"' 'contexts = ["workspace"]'
    printf 'command = ["herdr", "plugin", "pane", "open", "--plugin", "%s", "--entrypoint", "phone", "--placement", "zoomed", "--focus"]\n' "$PLUGIN"
  } >"$OVIS_HOME/plugin/.herdr-plugin.toml.new"
  chmod 755 "$OVIS_HOME/plugin/.run.sh.new"
  mv -f "$OVIS_HOME/plugin/.run.sh.new" "$OVIS_HOME/plugin/run.sh"
  mv -f "$OVIS_HOME/plugin/.herdr-plugin.toml.new" "$OVIS_HOME/plugin/herdr-plugin.toml"
}

install_plugin_binary() {
  install_binary "$version"
  write_plugin
  root=$OVIS_HOME
  code=$OVIS_HOME
  if ! herdr plugin list 2>/dev/null </dev/null | grep -q "$PLUGIN "; then
    log=$(mktemp)
    if herdr plugin link "$OVIS_HOME/plugin" </dev/null >"$log" 2>&1; then
      rm -f "$log"
      new_install=1
    else
      cat "$log" >&2
      rm -f "$log"
      fail "herdr could not link the plugin in $OVIS_HOME/plugin; its output is above"
    fi
  fi
  if herdr status server --json 2>/dev/null </dev/null | grep -q '"running":true'; then
    [ "$binary_changed" = 0 ] || ovis_cli stop </dev/null >/dev/null 2>&1 || true
    herdr plugin action invoke "$PLUGIN.start" >/dev/null </dev/null
    tries=0
    until ovis_cli status </dev/null 2>/dev/null | grep -q '^running'; do
      tries=$((tries + 1))
      [ "$tries" -lt 25 ] || { say "did not start within 25 s; see: herdr plugin log list"; break; }
      sleep 1
    done
  else
    say "herdr is not running, so neither is the app yet: it starts with herdr. Run: herdr"
  fi
}

install_core_binary() {
  say "found herdr-core ($core), so Ovis runs on it: no herdr or herdr plugin needed"
  install_binary "$version"
  printf '%s\n' herdr-core >"$OVIS_HOME/runtime"
  root=$OVIS_HOME
  code=$OVIS_HOME
  core_settings
  HERDR_PLUGIN_CONFIG_DIR=$settings_dir
  HERDR_PLUGIN_STATE_DIR=$state_dir
  export HERDR_PLUGIN_CONFIG_DIR HERDR_PLUGIN_STATE_DIR
  if [ "$binary_changed" = 1 ]; then ovis_cli stop </dev/null >/dev/null 2>&1 || true; fi
  core_service "$OVIS_HOME/bin/ovis-server" plugin
  [ "$binary_changed" = 0 ] || new_install=1
  ovis_cli start </dev/null || say "Ovis did not start; what it said is above. Start it again with: $start_line"
}

main() {
  # before anything is installed: a misspelt option must not install without what it asked for
  add=0
  [ "${OVIS_ADD:-}" != 1 ] || add=1
  for option in "$@"; do
    case "$option" in
      --add) add=1 ;;
      *) fail "does not know the option '$option'. $USAGE" ;;
    esac
  done
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
  need tar

  original_path="$PATH"
  installed_here=""
  new_install=0
  PATH="$BIN_DIR:$HOME/.bun/bin:$NODE_DIR/bin:$LEGACY_NODE_DIR/bin:$PATH"
  export PATH

  pick_install
  [ "$binary" = 1 ] || need git
  pick_runtime
  if [ "$runtime" = herdr ]; then
    if [ -d "$APP_DIR/.git" ]; then
      say "Ovis also runs on herdr-core from $APP_DIR (an earlier install); to keep only the plugin, stop that one: bun $APP_DIR/scripts/plugin.ts stop, and remove its service. The ovis command runs the plugin"
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

  if [ "$binary" = 1 ]; then
    binary_platform
  elif command -v bun >/dev/null 2>&1; then
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
  [ "$binary" = 1 ] || server_arch

  if [ "$runtime" = herdr-core ]; then
    if [ "$binary" = 1 ]; then install_core_binary; else install_core; fi
  elif [ "$binary" = 1 ]; then
    install_plugin_binary
  else
    install_plugin
  fi
  write_launcher

  echo
  if [ "$binary" = 1 ]; then
    ovis_cli phone </dev/null || true
  elif grep -q '"phone"' "$code/scripts/plugin.ts" 2>/dev/null; then
    bun "$code/scripts/plugin.ts" phone </dev/null || true
  else
    origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
    url=""
    [ -z "$origin" ] || url=$(curl -fsS --max-time 5 "$origin/api/access" 2>/dev/null | bun -e 'try { console.log(JSON.parse(await Bun.stdin.text()).tailscale?.serving_url ?? "") } catch { console.log("") }')
    [ -z "$origin" ] || say "on this PC: $(link "$origin")"
    if [ -n "$url" ]; then
      say "on your phone: $(link "$url")"
      if [ -d "$code/node_modules/qrcode-generator" ]; then
        # shellcheck disable=SC2016 # JavaScript, not shell
        (cd "$code" && bun -e 'const { default: qr } = await import("qrcode-generator"); const c = qr(0, "M"); c.addData(process.argv[1]); c.make(); console.log(c.createASCII(1, 1))' "$url") || true
      fi
    else
      say "no phone address yet, and this version cannot set one up: update it in Settings → Updates, then run this again"
    fi
  fi

  open_app
  add_pc

  case ":$original_path:" in
    *":$BIN_DIR:"*) ;;
    *)
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

  closing_lines

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
