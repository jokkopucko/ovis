#!/usr/bin/env bash
# The iOS app paired through the Ovis relay in the iOS Simulator on the test MacBook Air (`ssh eamac`,
# never the MacBook Pro): todo 21's scenario as a script. Run on this PC from a checkout:
#
#   bash scripts/relay-ios-sim.sh [evidence-dir]
#
# This PC: dist-shell/ served as Pages serves it (scripts/pages-static.ts), the Bun relay
# (relay/bun.ts) and a PC (createServer on the isolated herdr test session, a mkdtemp state dir),
# all on 127.0.0.1, with `tailscale serve` giving the shell and the relay HTTPS/WSS addresses on
# two free ports for this run only. The PC's relay is that wss: address, as in production: no seam.
#
# eamac: a fresh clone in /tmp from a git bundle of HEAD (nothing is pushed), the app built with
# OVIS_APP_URL naming this run's shell and signed to run locally (CODE_SIGN_IDENTITY=-: an unsigned
# build cannot store the relay device key, WebKit's IndexedDB put of a CryptoKey fails with
# DataCloneError), its own new Simulator, and WebDriverAgent built in that clone. This PC drives
# WebDriverAgent through an ssh tunnel: it pastes the pairing link on the connect screen, taps Open,
# then Pair, and opens the workspace list.
#
# Nothing waits by sleeping. Each step waits for the event that brings the next screen, read from a
# FIFO with a deadline: the local stack reports OFFER (the PC synced), SHELL (the shell's first
# screen asked for the mark it draws beside its heading), PAIRED (the PC enrolled the phone) and
# WORKSPACES (the PC sent the app's socket a snapshot naming this run's workspace); eamac reports BUILT and WDA (from
# WebDriverAgent's own "ServerURLHere" line) and LOADED (Capacitor's "WebView loaded" on the app's
# console). After an event, one WebDriverAgent query finds the element.
#
# Everything is undone on exit: the Simulator deleted, the /tmp clone removed, the serve entries
# turned off (and checked gone), the tunnel and the local servers stopped.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
evidence="${1:-${UI_EVIDENCE_DIR:-}}"
[ -n "$evidence" ] && mkdir -p "$evidence"
run="$(mktemp -d)"
host="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
serve_ports=()
stack_pid=""
remote=""
remote_pid=""
tunnel=""

say() { printf '[relay-ios-sim] %s\n' "$*" >&2; }

# How long a stopped child gets after TERM before KILL; how long eamac's own cleanup may take.
stop_seconds="${RELAY_IOS_SIM_STOP_SECONDS:-10}"
remote_cleanup_seconds="${RELAY_IOS_SIM_REMOTE_CLEANUP_SECONDS:-180}"

# Stops child $1: TERM, and KILL once $2 seconds pass without it exiting. The deadline is a timer
# that fires once; the wait returns as soon as the child exits. Never fails.
stop_child() {
  local pid="$1" grace="$2" timer
  kill -TERM "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null; return 0; }
  ( trap 'kill "$nap" 2>/dev/null; exit 0' TERM; sleep "$grace" & nap=$!; wait "$nap"; kill -KILL "$pid" 2>/dev/null ) &
  timer=$!
  wait "$pid" 2>/dev/null
  kill -TERM "$timer" 2>/dev/null; wait "$timer" 2>/dev/null
  return 0
}

# Runs on every exit, failure or not. Each step is bounded and does not depend on the one before:
# the run's own processes are stopped before anything waits on them, so a remote half that is
# blocked anywhere (on the build, on WebDriverAgent's readiness) cannot hold the rest up.
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  say "cleanup (exit $code)"
  [ -n "$tunnel" ] && { timeout 30 ssh -S "$run/tunnel" -O exit eamac >/dev/null 2>&1 || true; }
  # the ssh carrying eamac's half: stopped, not asked, as that half may not be reading its stdin
  [ -n "$remote_pid" ] && stop_child "$remote_pid" "$stop_seconds"
  if [ -n "$remote" ]; then
    if ! timeout "$remote_cleanup_seconds" ssh -o BatchMode=yes eamac "bash -s -- $(printf '%q' "$remote")" <<'EOF'
r="$1"
udid="$(cat "$r/udid" 2>/dev/null || true)"
pkill -f "$r/remote.sh" 2>/dev/null || true
pkill -f "$r/wdadd" 2>/dev/null || true
[ -n "$udid" ] && { pkill -f "simctl launch --console-pty --terminate-running-process $udid" 2>/dev/null || true; }
rm -rf "$r"
if test ! -e "$r"; then echo "eamac: $r removed"; else echo "eamac: $r is still there"; fi
if [ -n "$udid" ]; then
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  if xcrun simctl delete "$udid"; then echo "eamac: Simulator $udid deleted"; else echo "eamac: Simulator $udid not deleted"; fi
fi
EOF
    then say "eamac's cleanup did not finish within $remote_cleanup_seconds s"; code=1; fi
  fi
  [ -n "$stack_pid" ] && { stop_child "$stack_pid" "$stop_seconds"; say "local stack stopped"; }
  for port in "${serve_ports[@]}"; do timeout 30 tailscale serve --https="$port" off >/dev/null 2>&1 || true; done
  if [ "${#serve_ports[@]}" -gt 0 ]; then
    local left
    left="$(timeout 30 tailscale serve status --json | jq -r '.TCP // {} | keys[]')"
    for port in "${serve_ports[@]}"; do
      if grep -qx "$port" <<<"$left"; then say "serve port $port is still on"; code=1; else say "tailscale serve :$port off"; fi
    done
  fi
  [ -n "$evidence" ] && [ -f "$run/stack.log" ] && { cp "$run/stack.log" "$evidence/task-23-ios-stack.log" || true; }
  rm -rf "$run"
  say "cleanup complete (exit $code)"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Reads lines from fd $1 until one starts with $2, for at most $3 seconds; prints that line.
# `read -t` blocks on the FIFO until a line arrives or the time is up: nothing is polled.
await_event() {
  local fd="$1" name="$2" until=$((SECONDS + $3)) line
  while true; do
    local left=$((until - SECONDS))
    [ "$left" -gt 0 ] || { say "no $name within $3 s"; return 1; }
    IFS= read -r -t "$left" -u "$fd" line || { say "no $name within $3 s"; return 1; }
    case "$line" in "$name"|"$name "*) printf '%s\n' "$line"; return 0;; ENDED*) say "eamac: $line"; return 1;; esac
  done
}

local_port() { bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true);'; }
serve_port() {
  local taken port
  taken="$(tailscale serve status --json | jq -r '.TCP // {} | keys[]')"
  for port in $(seq 18930 18999); do
    if ! grep -qx "$port" <<<"$taken" && [[ ! " ${serve_ports[*]} " == *" $port "* ]]; then echo "$port"; return; fi
  done
  return 1
}

[ -f "$repo/dist-shell/index.html" ] || (cd "$repo" && bun run build:shell)
shell_local="$(local_port)"
relay_local="$(local_port)"
wda_local="$(local_port)"
shell_https="$(serve_port)"; serve_ports+=("$shell_https")
relay_https="$(serve_port)"; serve_ports+=("$relay_https")
app_url="https://$host:$shell_https"
relay_url="wss://$host:$relay_https"
tailscale serve --bg --https="$shell_https" "http://127.0.0.1:$shell_local" >/dev/null
tailscale serve --bg --https="$relay_https" "http://127.0.0.1:$relay_local" >/dev/null
say "shell $app_url -> 127.0.0.1:$shell_local; relay $relay_url -> 127.0.0.1:$relay_local"

# fd 3: the local stack's events; fd 4: eamac's; fd 5: what eamac waits on before it stops WebDriverAgent.
# Opened read-write, so neither side's open blocks and no EOF arrives while the run holds them.
mkfifo "$run/stack.events" "$run/remote.events" "$run/remote.in"
exec 3<>"$run/stack.events" 4<>"$run/remote.events" 5<>"$run/remote.in"

cat >"$run/stack.ts" <<'EOF'
const repo = process.env["REPO"]!;
await import(`${repo}/scripts/test-herdr.ts`);
const { appendFileSync, mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { startBunRelay } = await import(`${repo}/relay/bun.ts`) as typeof import("../relay/bun.ts");
const { loadPagesSite, pagesResponse } = await import(`${repo}/scripts/pages-static.ts`) as typeof import("./pages-static.ts");
const { createServer } = await import(`${repo}/server/index.ts`) as typeof import("../server/index.ts");
const { RelayService } = await import(`${repo}/server/relay/service.ts`) as typeof import("../server/relay/service.ts");
const { workspaceClose, workspaceCreate } = await import(`${repo}/server/herdr/client.ts`) as typeof import("../server/herdr/client.ts");
const event = (line: string): void => { console.log(line); appendFileSync(process.env["EVENTS"]!, `${line}\n`); };
const relay = startBunRelay({ hostname: "127.0.0.1", port: Number(process.env["RELAY_LOCAL"]) });
const pages = loadPagesSite(join(repo, "dist-shell"));
// RelayShell draws its mark (/icons/icon-192.png?v=sheep1) in the same commit as its heading: the app's
// web view, which has no service worker and reads no manifest icons, asks for it once the first screen is up
let shellSeen = false;
const site = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env["SHELL_LOCAL"]), async fetch(request) {
  const url = new URL(request.url);
  const response = await pagesResponse(pages, request);
  if (!shellSeen && url.pathname === "/icons/icon-192.png" && url.searchParams.get("v") === "sheep1" && response.ok) { shellSeen = true; event("SHELL"); }
  return response;
} });
const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-ios-sim-"));
const workspace = await workspaceCreate({ cwd: stateDir, label: "relay-ios-sim" });
const synced = Promise.withResolvers<void>();
const service = new RelayService({ stateDir, relay: process.env["RELAY_URL"]!, app: process.env["APP_URL"]!, connect: (url) => {
  const socket = new WebSocket(url);
  socket.addEventListener("message", (message) => { if (typeof message.data === "string" && message.data.includes('"sync"')) synced.resolve(); });
  return socket;
} });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service });
const base = `http://127.0.0.1:${app.port}`;
const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
const devices = app.context.services.devices;
const pairRelay = devices.pairRelay.bind(devices);
devices.pairRelay = (...args) => { const paired = pairRelay(...args); if (paired) event(`PAIRED ${paired.device.id}`); return paired; };
// the snapshot the PC sends the phone's app socket, naming this run's workspace: the app has what its
// workspace list shows (a relay session takes these handlers when it opens, after this)
const sockets = app.context.services.core.socketHandlers;
const open = sockets.open.bind(sockets);
let listed = false;
sockets.open = (peer) => {
  const send = peer.send.bind(peer);
  peer.send = ((data: unknown, ...rest: unknown[]) => {
    if (!listed && typeof data === "string" && data.includes('"type":"snapshot"') && data.includes('"relay-ios-sim"')) { listed = true; event("WORKSPACES"); }
    return (send as (...args: unknown[]) => unknown)(data, ...rest);
  }) as typeof peer.send;
  return open(peer);
};
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await service.shutdown(); app.stop(); await relay.stop(); site.stop(true);
  await workspaceClose(workspace.workspace.workspace_id).catch(() => undefined);
  rmSync(stateDir, { recursive: true, force: true });
  console.log("STOPPED");
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const started = await post("/start");
if (started.status !== 200) throw new Error(`relay start: ${started.status} ${await started.text()}`);
await synced.promise;
console.log(`SYNCED ${process.env["RELAY_URL"]}`);
event(`OFFER ${(await (await post("/offer")).json() as { url: string }).url}`);
await new Promise(() => {});
EOF
REPO="$repo" EVENTS="$run/stack.events" SHELL_LOCAL="$shell_local" RELAY_LOCAL="$relay_local" APP_URL="$app_url" RELAY_URL="$relay_url" \
  bun "$run/stack.ts" >"$run/stack.log" 2>&1 &
stack_pid=$!
offer_line="$(await_event 3 OFFER 120)" || { cat "$run/stack.log"; say "the local stack did not come up"; exit 1; }
offer="${offer_line#OFFER }"
case "$offer" in "$app_url"/s/*'#offer='*) ;; *) say "the offer is not on this run's shell: $offer"; exit 1;; esac
say "PC synced with the relay; offer ${offer%%#*}#offer=…"

git -C "$repo" bundle create "$run/ovis.bundle" HEAD >/dev/null 2>&1
remote="$(ssh -o BatchMode=yes eamac 'mktemp -d /tmp/ovis-relay-ios.XXXXXX')"
cat >"$run/remote.sh" <<'EOF'
# eamac's half: events on stdout, progress on stderr; it holds WebDriverAgent until a line on stdin.
set -euo pipefail
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
r="$1"; app_url="$2"
cd "$r"
git -c advice.detachedHead=false clone -q ovis.bundle ovis
cd ovis
bun install --frozen-lockfile >/dev/null
(cd app && bun install --frozen-lockfile >/dev/null && OVIS_APP_URL="$app_url" bun run build:web >/dev/null && npx cap sync ios >/dev/null) >&2
grep -q "APP_ORIGIN = \"$app_url\"" app/ios/App/App/public/shell.js
# this test build only: Capacitor's console lines ("WebView loaded"), which the shipped config keeps off
python3 - app/ios/App/App/capacitor.config.json <<'PY'
import json, sys
path = sys.argv[1]
config = json.load(open(path))
config["loggingBehavior"] = "debug"
json.dump(config, open(path, "w"), indent=2)
PY
udid="$(xcrun simctl create "ovis-relay-ios-$(basename "$r")" "iPhone 18 Pro" com.apple.CoreSimulator.SimRuntime.iOS-27-0)"
echo "$udid" >"$r/udid"
xcrun simctl bootstatus "$udid" -b >/dev/null
echo "eamac: Simulator $udid booted" >&2
xcodebuild -quiet -project app/ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination "id=$udid" -derivedDataPath "$r/dd" CODE_SIGN_IDENTITY=- build >"$r/build.log" 2>&1 || { tail -40 "$r/build.log" >&2; echo "ENDED app build failed"; exit 1; }
xcrun simctl install "$udid" "$r/dd/Build/Products/Debug-iphonesimulator/App.app"
codesign -dv "$r/dd/Build/Products/Debug-iphonesimulator/App.app" 2>&1 | grep -E '^Signature=' >&2 || true
echo "BUILT $udid"

# WebDriverAgent v16.15.3, pinned to its commit: fetched by that exact id and checked before it builds
wda_commit=02cb92f0e93c8b021443bcbb8eeb80932c113220
git init -q "$r/wda"
git -C "$r/wda" fetch -q --depth 1 https://github.com/appium/WebDriverAgent "$wda_commit"
git -C "$r/wda" -c advice.detachedHead=false checkout -q FETCH_HEAD
[ "$(git -C "$r/wda" rev-parse HEAD)" = "$wda_commit" ] || { echo "ENDED WebDriverAgent is not commit $wda_commit"; exit 1; }
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
mkfifo "$r/wda.ready"
# WebDriverAgent prints ServerURLHere once it listens: awk reports that line (or the end of the run
# without it) on a FIFO and keeps writing the log
TEST_RUNNER_USE_PORT="$port" xcodebuild -project "$r/wda/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
  -destination "id=$udid" -derivedDataPath "$r/wdadd" test 2>&1 \
  | awk -v logfile="$r/wda.log" -v ready="$r/wda.ready" '{ print > logfile; fflush(logfile) } !done && /ServerURLHere->/ { print "READY" > ready; close(ready); done = 1 } END { if (!done) { print "ENDED" > ready; close(ready) } }' &
read -r state <"$r/wda.ready"
[ "$state" = READY ] || { tail -40 "$r/wda.log" >&2; echo "ENDED WebDriverAgent did not start"; exit 1; }
echo "WDA $port"
# on "launch": the app with its console attached; Capacitor prints "WebView loaded" as each page finishes
while read -r command; do
  case "$command" in
    launch) xcrun simctl launch --console-pty --terminate-running-process "$udid" sh.ovis.app -AppleLanguages "(en)" -AppleLocale en_US 2>&1 \
      | awk -v logfile="$r/app.log" '{ print > logfile; fflush(logfile) } /WebView loaded/ { print "LOADED"; fflush() }' & ;;
    *) break;;
  esac
done
pkill -f "$r/wdadd" || true
xcrun simctl terminate "$udid" sh.ovis.app 2>/dev/null || true
EOF
scp -q "$run/ovis.bundle" "$run/remote.sh" "eamac:$remote/"
say "eamac: fresh clone in $remote"
ssh -o BatchMode=yes eamac "bash $(printf '%q ' "$remote/remote.sh" "$remote" "$app_url")" <&5 >&4 &
remote_pid=$!

udid="$(await_event 4 BUILT "${RELAY_IOS_SIM_BUILD_SECONDS:-1800}" | cut -d' ' -f2)"
say "eamac: app built signed to run locally and installed on Simulator $udid"
wda_port="$(await_event 4 WDA "${RELAY_IOS_SIM_WDA_SECONDS:-1200}" | cut -d' ' -f2)"
# -f returns once the forward listens
ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -M -S "$run/tunnel" -L "$wda_local:127.0.0.1:$wda_port" eamac
tunnel=1
wda="http://127.0.0.1:$wda_local"
say "WebDriverAgent on eamac:$wda_port, here as $wda"

json() { curl -sf --max-time 120 -H 'content-type: application/json' "$@"; }
element_of() { python3 -c 'import json,sys; v=json.load(sys.stdin)["value"]; print(v.get("ELEMENT") or v.get("element-6066-11e4-a52e-4f735466ecf0") or "")'; }
# One query, after the event that brought the screen; on a miss, what is on screen, and the run fails.
find() {
  local answer element
  answer="$(curl -s --max-time 120 -H 'content-type: application/json' -X POST "$wda/session/$session/element" -d "$1")"
  element="$(printf '%s' "$answer" | element_of 2>/dev/null || true)"
  if [ -z "$element" ]; then
    say "not on screen: $2; WebDriverAgent answered: ${answer:0:600}; the screen holds:"
    curl -s --max-time 60 "$wda/session/$session/source?format=description" | cut -c1-8000 >&2 || true
    return 1
  fi
  printf '%s\n' "$element"
}
shot() { ssh -o BatchMode=yes eamac "xcrun simctl io $(printf '%q' "$udid") screenshot $(printf '%q' "$remote/$1")" >/dev/null 2>&1; }

# eamac launches the app with its console attached and reports LOADED once the bundled connect page loaded
launch() {
  echo launch >&5
  await_event 4 LOADED 120 >/dev/null || { ssh -o BatchMode=yes eamac "tail -n 30 $(printf '%q' "$remote/app.log")" >&2; return 1; }
}
attach() {
  curl -s --max-time 300 -H 'content-type: application/json' -X POST "$wda/session" -d '{"capabilities":{"alwaysMatch":{"bundleId":"sh.ovis.app","forceAppLaunch":false}}}'
}
# The first accessibility query after the app's install starts accessibility for it and answers
# before the web content is in the tree. That query is made once, a request that returns when the
# start is done; the app is then launched again (the same launch, a new process), and every query
# after that sees a loaded page whole: checked on eamac across four relaunches.
launch
warm="$(attach | python3 -c 'import json,sys; d = json.load(sys.stdin); print(d.get("sessionId") or d["value"]["sessionId"])')"
curl -s --max-time 300 "$wda/session/$warm/source" >/dev/null
launch
answer="$(attach)"
session="$(python3 -c 'import json,sys; d = json.loads(sys.argv[1]); print(d.get("sessionId") or d["value"]["sessionId"])' "$answer")" || { say "no WebDriverAgent session: $answer"; exit 1; }
say "WebDriverAgent session $session: ${answer:0:300}"
field="$(find '{"using":"class chain","value":"**/XCUIElementTypeTextField"}' "the connect screen's address field")"
json -X POST "$wda/session/$session/element/$field/click" -d '{}' >/dev/null
json -X POST "$wda/session/$session/element/$field/value" -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$offer")" >/dev/null
open="$(find '{"using":"predicate string","value":"type == \"XCUIElementTypeButton\" AND label IN {\"Open\", \"열기\"}"}' "the Open button")"
json -X POST "$wda/session/$session/element/$open/click" -d '{}' >/dev/null
await_event 3 SHELL 120 >/dev/null
find '{"using":"predicate string","value":"label BEGINSWITH \"Pair with\" OR label ENDSWITH \"페어링할까요?\""}' "the hosted shell's pairing question" >/dev/null
shot ios-confirm.png
say "the app opened the pairing link on its connect screen: the shell asks to pair"
pair="$(find '{"using":"predicate string","value":"type == \"XCUIElementTypeButton\" AND label IN {\"Pair\", \"페어링\"}"}' "the Pair button")"
json -X POST "$wda/session/$session/element/$pair/click" -d '{}' >/dev/null
device="$(await_event 3 PAIRED 120 | cut -d' ' -f2)"
say "PC enrolled $device through the relay"
await_event 3 WORKSPACES 120 >/dev/null
drawer="$(find '{"using":"predicate string","value":"type == \"XCUIElementTypeButton\" AND label == \"Open workspace list\""}' "the app over the relay")"
json -X POST "$wda/session/$session/element/$drawer/click" -d '{}' >/dev/null
find '{"using":"predicate string","value":"label CONTAINS \"relay-ios-sim\""}' "the PC's relay-ios-sim workspace in the app" >/dev/null
shot ios-app.png
say "paired through the relay; the app lists the PC's relay-ios-sim workspace"
json -X DELETE "$wda/session/$session" >/dev/null || true

if [ -n "$evidence" ]; then
  scp -q "eamac:$remote/ios-confirm.png" "$evidence/task-23-ios-confirm.png"
  scp -q "eamac:$remote/ios-app.png" "$evidence/task-23-ios-app.png"
fi
say "PASS relay iOS Simulator"
