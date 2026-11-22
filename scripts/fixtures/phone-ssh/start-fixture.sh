#!/bin/bash
# Runs as `fixture`: herdr's default session, a workspace whose pane runs the stand-in `claude`,
# and the Ovis server on the container's loopback (no OVIS_TOKEN: it registers a bridge descriptor).
set -euo pipefail
export HOME=/home/fixture USER=fixture SHELL=/bin/bash PATH=/usr/local/bin:/usr/bin:/bin
cd "$HOME"
mkdir -p logs demo-project

wait_for() { # <what> <test command...>: up to 30 s
  local what=$1; shift
  for _ in $(seq 300); do "$@" && return 0; sleep 0.1; done
  echo "start-fixture: $what did not come up" >&2; return 1
}

setsid herdr server >logs/herdr.log 2>&1 < /dev/null &
wait_for "herdr socket" test -S "$HOME/.config/herdr/herdr.sock"
wait_for "herdr api" herdr workspace list >/dev/null 2>&1

printf 'first line\nlast line without a newline' > demo-project/a.txt

created=$(herdr workspace create --cwd "$HOME/demo-project" --label phone-ssh-demo --no-focus)
echo "$created" > logs/workspace.json
pane=$(python3 -c 'import json,sys
d=json.load(sys.stdin)
def find(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=="pane_id" and isinstance(v,str): return v
            r=find(v)
            if r: return r
    elif isinstance(o,list):
        for v in o:
            r=find(v)
            if r: return r
print(find(d) or "")' <<<"$created")
[ -n "$pane" ] || { echo "start-fixture: no pane id in: $created" >&2; exit 1; }
echo "$pane" > logs/agent-pane-id
herdr pane run "$pane" claude >/dev/null

cd /opt/ovis
HOST=127.0.0.1 PORT=7317 setsid bun server/index.ts >"$HOME/logs/ovis.log" 2>&1 < /dev/null &
wait_for "ovis server" curl -fsS -o /dev/null http://127.0.0.1:7317/api/health
echo "start-fixture: herdr, stand-in claude (pane $pane) and Ovis on 127.0.0.1:7317 are up"
