#!/usr/bin/env bash
# The hook kill tests (the isolated tests of scripts/self-hosted-runner.test.ts) in one throwaway, confined container of
# the image hook-test.Dockerfile builds.
# The container starts detached, prints its proofs of confinement first, and waits for a go file that this script
# writes only after `docker inspect` shows the confining settings; it bounds itself (timeouts inside it, --rm). This
# script signals nothing and removes nothing: a container still there at its end is reported by its name.
set -euo pipefail
usage="usage: hook-test-container.sh <image> <checkout with node_modules> <empty output directory>"
image=${1:?$usage}
src=$(cd "${2:?$usage}" && pwd)
out=$(cd "${3:?$usage}" && pwd)
name=ovis-hook-kill-tests
expected="0 fail;8 pass;"
gone() { [ -z "$(docker ps -a --filter "name=^/$name\$" --format '{{.Names}}')" ]; }
test -d "$src/node_modules" || { echo "STOP: $src has no node_modules: run bun install --frozen-lockfile --ignore-scripts there first"; exit 1; }
test -z "$(ls -A "$out")" || { echo "STOP: $out is not empty"; exit 1; }
gone || { echo "STOP: a container named $name exists already"; exit 1; }
chmod 0777 "$out"
host_ns=$(readlink /proc/self/ns/pid)
echo "host pidns: $host_ns"
cid=$(docker run -d --rm --init --name "$name" --user hooktest --network none \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 2048 \
  -v "$src:/src:ro" -v "$out:/out" --entrypoint bash "$image" -c '
exec >/out/log.txt 2>&1
(
set -eu
echo "init=$(cat /proc/1/comm)"
ns=$(readlink /proc/self/ns/pid) || { echo "STOP: readlink /proc/self/ns/pid failed"; exit 99; }
echo "pidns=$ns"
[[ $ns =~ ^pid:\[[0-9]+\]$ ]] || { echo "STOP: not a PID namespace link: $ns"; exit 99; }
[[ $ns != "pid:[4026531836]" ]] || { echo "STOP: this is the host initial PID namespace"; exit 99; }
[[ $(cat /proc/1/comm) == docker-init ]] || { echo "STOP: PID 1 is not docker-init"; exit 99; }
echo "docker.sock: $(ls -la /var/run/docker.sock 2>&1)"
[[ ! -e /var/run/docker.sock ]] || { echo "STOP: /var/run/docker.sock exists"; exit 99; }
echo "writable mounts:"; grep -E " rw[ ,]" /proc/self/mounts
echo "source mount:"; grep -E " /src " /proc/self/mounts
grep -E "Cap(Eff|Prm|Bnd)" /proc/self/status
echo "net: $(ls /sys/class/net | tr "\n" " ")"
[[ $(ls /sys/class/net) == lo ]] || { echo "STOP: a network interface other than lo"; exit 99; }
echo "PROOFS-DONE"
timeout 60 bash -c "until [ -e /out/go ]; do sleep 0.2; done" || { echo "STOP: no go file within 60 s"; exit 99; }
mkdir /home/hooktest/tmp /home/hooktest/src
timeout -k 5 120 find /src -mindepth 1 -maxdepth 1 ! -name .ci-cache -exec cp -R -t /home/hooktest/src {} +
test -f /home/hooktest/src/bunfig.toml
test -d /home/hooktest/src/node_modules
cd /home/hooktest/src
echo "tests started $(date -u +%FT%TZ)"
TMPDIR=/home/hooktest/tmp HERDR_TEST_MODE=unit timeout -k 5 300 bun test scripts/self-hosted-runner.test.ts -t "job-started hook"
)
echo $? >/out/status.tmp
mv /out/status.tmp /out/status
')
echo "container id: $cid"
cfg=$(docker inspect --format 'Privileged={{.HostConfig.Privileged}} CapDrop={{.HostConfig.CapDrop}} CapAdd={{.HostConfig.CapAdd}} NetworkMode={{.HostConfig.NetworkMode}} PidMode={{.HostConfig.PidMode}} SecurityOpt={{.HostConfig.SecurityOpt}}' "$cid")
echo "$cfg"
mounts=$(docker inspect --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} RW={{.RW}}{{"\n"}}{{end}}' "$cid" | sed '/^$/d' | LC_ALL=C sort)
echo "$mounts"
if [ "$cfg" != "Privileged=false CapDrop=[ALL] CapAdd=[] NetworkMode=none PidMode= SecurityOpt=[no-new-privileges]" ]; then echo "STOP: unexpected HostConfig: $cfg (the container ends itself within 60 s)"; exit 1; fi
want=$(printf '%s\n' "$out -> /out RW=true" "$src -> /src RW=false" | LC_ALL=C sort)
if [ "$mounts" != "$want" ]; then echo "STOP: unexpected mounts (the container ends itself within 60 s)"; exit 1; fi
# the container's own proofs, printed and checked here before any test starts: at most 120 polls of 0.5 s for them
for _ in $(seq 1 120); do
  if grep -q '^PROOFS-DONE$' "$out/log.txt" 2>/dev/null || [ -e "$out/status" ]; then break; fi
  sleep 0.5
done
echo "----- the container's proofs"; sed '/^PROOFS-DONE$/q' "$out/log.txt" 2>/dev/null || true; echo "----- end of the proofs"
grep -q '^PROOFS-DONE$' "$out/log.txt" 2>/dev/null || { echo "STOP: the container showed no proofs; it ends itself within 60 s"; exit 1; }
proofs=$(sed '/^PROOFS-DONE$/q' "$out/log.txt")
box_ns=$(printf '%s\n' "$proofs" | sed -n 's/^pidns=//p')
echo "host pidns: $host_ns; container pidns: $box_ns"
fail() { echo "STOP: $1; the tests do not start, and the container ends itself within 60 s"; exit 1; }
printf '%s\n' "$proofs" | grep -qx 'init=docker-init' || fail "PID 1 is not docker-init"
[[ $box_ns =~ ^pid:\[[0-9]+\]$ ]] || fail "no PID namespace shown"
[ "$box_ns" != 'pid:[4026531836]' ] || fail "the container is in the host's initial PID namespace"
[ "$box_ns" != "$host_ns" ] || fail "the container's PID namespace is this host's"
printf '%s\n' "$proofs" | grep -q '^docker.sock: .*No such file or directory' || fail "the docker socket may be there"
for cap in CapPrm CapEff CapBnd; do printf '%s\n' "$proofs" | grep -Eq "^$cap:[[:space:]]+0+\$" || fail "$cap is not empty"; done
printf '%s\n' "$proofs" | grep -Eq '^net: lo ?$' || fail "a network interface other than lo"
printf '%s\n' "$proofs" | grep -Eq ' /src [^ ]+ ro[ ,]' || fail "/src is not mounted read-only"
touch "$out/go"
echo "go given: every proof checked"
# the container's own bound is 60 + 120 + 300 s: wait for its status file, at most 600 polls of 1 s
for _ in $(seq 1 600); do [ -e "$out/status" ] && break; sleep 1; done
[ -e "$out/status" ] || { echo "STOP: no status from $name after 600 s; it ends itself, nothing was done to it"; exit 1; }
removed=no
for _ in $(seq 1 30); do if gone; then removed=yes; break; fi; sleep 1; done
echo "----- the container's log"; cat "$out/log.txt"; echo "----- end of the container's log"
status=$(cat "$out/status")
echo "container command exit status: $status"
[ "$removed" = yes ] || { echo "STOP: container $name still exists 30 s after its status; nothing was done to it"; exit 1; }
if grep -q '^STOP:' "$out/log.txt"; then echo "STOP: the container log has a line starting with STOP:"; exit 1; fi
[ "$status" = 0 ] || { echo "STOP: the container's command exited $status"; exit 1; }
counts=$( { grep -E '^ *[0-9]+ (pass|skip|fail|todo)$' "$out/log.txt" || true; } | sed -E 's/^ +//' | LC_ALL=C sort | tr '\n' ';')
if [ "$counts" != "$expected" ]; then echo "STOP: counts are '$counts', not '$expected': a skip means isolation was not established"; exit 1; fi
if grep -q 'kill tests skipped' "$out/log.txt"; then echo "STOP: the kill tests were skipped"; exit 1; fi
echo "hook kill tests passed: $counts"
