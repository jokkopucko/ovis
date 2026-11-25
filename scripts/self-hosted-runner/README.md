# Self-hosted CI runner

An ephemeral Docker GitHub Actions runner for this repository's Linux CI/CD jobs. Each container registers, runs exactly one job and exits; the launcher then starts a fresh one. The image includes Bun, Node 22, checksum-pinned herdr, a pinned Rust toolchain (rustup's minimal profile, with gcc to link), Playwright Chromium and its system libraries, ffmpeg, git, `gh`, curl, jq, unzip, xz-utils, OpenSSH (client and server), iproute2 (`ss`), tmux and procps (`ps`), with no sudo. Jobs detect it with `RUNNER_ENVIRONMENT=self-hosted`.

## Prerequisites

- Docker on a Linux x64 host.
- `gh` logged in as a repository admin (needed to create registration tokens and delete runners).

## Run

```sh
scripts/self-hosted-runner/run.sh                         # 1 slot, repo from the current checkout
scripts/self-hosted-runner/run.sh --count 3
scripts/self-hosted-runner/run.sh --repo OWNER/NAME --labels self-hosted-ovis --build
scripts/self-hosted-runner/run.sh --count 8 --reserved 2  # slots 1-2 take only main's pushes
scripts/self-hosted-runner/run.sh --once                  # one container per slot, then exit
```

The image `herdr-ci-runner:local` is built when missing or with `--build`. Ctrl+C stops the containers and deletes any runner of this host (`herdr-ci-<host>-*`) still registered.

A slot whose container is still running (one an earlier launcher started, say, still in its job)
waits for it to end before it starts the next: the new runner would register the same name
(`--replace`) and take the running job's registration. So a launcher can be restarted under running
jobs by killing its main process alone (`kill -KILL`; its stop trap would stop every container), after
which systemd starts it again and each slot moves over once its job ends. That relies on the unit's
`KillMode=mixed`: systemd then SIGKILLs the old launcher's slot loops and `docker run` clients, which
leaves their containers running. With `KillMode=control-group` they would get SIGTERM, which the
clients pass on to their containers, ending the jobs. A container that holds a slot's name without
running (created, or stopped) is removed, so it never holds the slot. Restart with the same `--count`: a container in a
slot above the new count is no one's to wait for, and the new launcher's stop removes its runner. A
launcher started with `--build-cache` serves the jobs it took over too, once its first cache refresh is
done (up to `--cache-wait`). Do not move this way from a launcher that kept its runners in one
network namespace to one that keeps the [check slots](#check-slots) in a volume: the old containers
count their runs on the shared loopback and the new ones in the files, so up to twice the run limit
runs until the old jobs end. Restart that one with `systemctl --user restart`, at idle slots.

A slot that cannot fetch a registration token retries after 30 s, doubling up to 10 minutes: GitHub
limits these requests per hour, and eight slots retrying every 30 s keep the account over that limit,
which blocks every other API call too. After the repository is renamed, restart the launcher with
`--repo OWNER/NEW-NAME`: the token request follows GitHub's redirect, but runner registration does
not, and every container exits with a 404.

`--once` exits nonzero if registration-token retrieval or any container fails. Its exit status
reports launcher/container execution, not the GitHub Actions job's conclusion.

Runner containers have no CPU or total-memory quota and can use available host resources.
Each slot has a docker network of its own (`herdr-ci-<host>-<slot>-net`), with its runner container
alone on it, so a job reaches nothing another job listens on, and none reaches a service on the
host's loopback. What the runners share is `scripts/check.ts`'s slots, in a volume all of them mount:
the herdr-backed CI lanes of every runner on the PC count against one `CHECK_MAX_RUNS` and wait for
a slot, instead of each runner believing it has the PC to itself ([Check slots](#check-slots)). The
`--shm-size 2g` Docker setting sizes `/dev/shm` for browser scratch space; it is not a total RAM
limit. The container still has a pids limit of 8192, and `--ulimit core=0:1`: a crash never leaves a
core file in the checkout, where `scripts/check.ts` would count it as a source change. The hard limit
of 1 byte lets `server/pty/host.test.ts` lower a crashing command's limit to 1 byte, for which the
kernel writes no core file and starts no piped `core_pattern` handler either; at 0 that test skips.

Each slot's network is a /28 of one block, `10.213.0.0/16`, never a range docker picks. Left to
itself, docker takes 172.17-31.x/16 ranges and then 192.168.x/20 ones: on a host whose 172 ranges
were used up, a runner network made at boot, before the LAN's route was there, got 192.168.0.0/20
and put its bridge on 192.168.0.1, the LAN router's address, and the host was offline until that
network was removed. So the launcher removes and makes no network while the kernel has no route
to the internet (`ip -4 route get 1.1.1.1`, which follows policy routing and a VPN's split
default): the slot says so in the journal and tries again. Slot N takes the block's Nth /28, or the
next one that no route or address of the host overlaps at that moment (`ip -4 route show table
all`, `ip -4 addr`) and that docker does not refuse as overlapping another of its networks; after
16 refusals its next try goes on from where it stopped. A route broader than /8 counts as a
default, not a network (a full-tunnel VPN's /1 pair or four /2s): a runner network inside it takes
those few addresses from it, as it does from a default route; /8 and narrower count. A slot's
network that is there already is kept when its only IPv4 range is a /28 of the block; any other
(one from a launcher before the block, say) is removed and made again before the slot's next
container, unless a container is on it: then the slot leaves it, says so in the journal and tries
again. Limits: a network that is kept is not checked against the host's routes again, so if the
host later joins a network inside the block, set `OVIS_CI_NETWORK_BLOCK` to another block. A host
that routes all of both 10.0.0.0/8 and 172.16.0.0/16 has no block it may use: its slots say so and
start no runner (192.168.0.0/16 stays refused, as home networks are there). A host with no IPv4
route to the internet at all (IPv6 only, or a proxy only), or without `ip`, starts no runner
either: its slots report "no default route yet". Every launcher on a host must run this `run.sh`:
a host may run several, and a copy installed under another name keeps letting docker pick its
ranges until it is replaced too, by this `run.sh` with that copy's own `PREFIX` line. The block
is private, outside docker's own pools, and rarely a home or office network. On a host where it is
one, set `OVIS_CI_NETWORK_BLOCK` in the launcher's environment (the unit's `Environment=`) to
another network address from /8 to /24 inside `10.0.0.0/8`, or inside `172.16.0.0/16` on a host
that routes all of 10.0.0.0/8 (a VPN); the launcher refuses anything else.

`--work-tmpfs SIZE` (say `4g`) puts each container's work folder (`/w`, the checkout) and `/tmp` in
RAM, each capped at SIZE. A job's files end with its container anyway; on disk, its checkout, Bun
cache copy and browser profiles are most of what a busy host writes. Only what a job writes takes
memory (about 1-1.5 GB for the busiest jobs measured), and it is freed when the container exits.
The caps are not reserved, but they are not a memory limit either: pick SIZE so that
`--count` x 2 x SIZE stays below the host's free RAM (18 runners at `4g` can hold up to 144 GB).
Below about 1g the checkout plus the seeded Bun cache no longer fits, and seeding falls back to
downloading every package.

## Check slots

`scripts/check.ts` lets a few herdr-backed runs share a PC, each in a slot: a loopback port the run
listens on, with more ports for admission and for the queue of waiting runs. The runner containers of a PC used to share one
network namespace so that those ports bounded the lanes of all of them. They shared every other
loopback port with it. A job's tests keep Ovis servers on `127.0.0.1` with no token, and a request
from the loopback drives such a server: a job on one slot could find the server of a job on
another (the port is in the system's range), type into a pane of that job's test herdr session,
and so run commands in that job's container. From there it could read what that job reads, and
hand in a build cache claim from that container, which every check of [Build cache](#build-cache)
accepts. Two test files bind a server with no token to every address, which a container on the
same docker network reaches as well.

So each slot has a docker network of its own, made when the slot first starts a container and
removed at the launcher's stop, and docker keeps its networks apart. (A launcher that was killed
leaves them, and the next one uses each that is a /28 of the block and makes the others again;
one started with a lower `--count` leaves those of the slots above it, for `docker network rm`.) Each network is a /28 of the runner networks' block
([Run](#run)); a slot whose network cannot be made starts no runner, says so in the journal and
tries again. The slots themselves are lock
files, one for each port (`41737` to `41770`), in the Docker volume `herdr-ci-<host>-check-slots`
(RAM, 1 MiB), which every runner container mounts at `/check-slots` and learns of in
`CHECK_SLOTS_DIR`. A run holds a file with `flock`, which the kernel grants to one holder and takes
back when that holder is gone, however it ended, as it does a listening port; the holder writes in
the file what a port's holder answers (its pid and checkout, or its place in the queue). So the
limit, the queue's order and the names in "the N-run limit is reached" are what they were. The
volume's directory is root's and closed to everyone else, and the files are made by root (in
`herdr-ci-<host>-check-slots`, an idle container with no network and no capability that also keeps
the volume mounted between jobs): a job can lock a file and write in it, and can neither remove
nor replace one. A job that holds every file keeps the others waiting, as one that listened on
every port did; none can free a slot another job holds. What a job wrote in a file stays when the
job is gone, and counts for nothing: a file is read only while a run holds it, and a run that finds
no room in the volume for its own answer empties every file no run holds and writes again.
`check.ts` creates no file: where one is missing, the run fails rather than count only its own
container, and the launcher starts no runner while it cannot make them (a volume of that name that
is not in RAM, or whose directory is not root's alone, must be removed first).

A run that sets `CHECK_LOCK_PORT` keeps its ports: a lock range of its own was never the PC's.
GitHub's own runners and a developer's PC set no `CHECK_SLOTS_DIR`, and take ports as before. The
merge pass's local gate runs in containers of its own, outside these slots, as before.

The job's side comes with the commit a run checks out. A `check.ts` from before this change takes
loopback ports, which are its own container's here: it would count only itself, and nothing would
bound such jobs but the number of runners. So the launcher hands it a run limit it stops on. The
env file's `CHECK_HOST_MAX_RUNS` reaches a job as `CHECK_SLOTS_MAX_RUNS`, which only a `check.ts`
that takes its slots in the volume reads, and `CHECK_HOST_MAX_RUNS` itself is a sentence in every
container. A herdr-backed lane of a commit from before ends at once, before it starts any herdr,
with `CHECK_MAX_RUNS must be a whole number from 1 to 8, not "taken from /check-slots on this
runner, ...: merge main into the branch and push"`; its Fast checks take no slot and run. A pull
request's run checks out its merge with main, so a new push has the new `check.ts` without a
rebase; only a re-run of a run from before, or a branch that does not take main in (a release
branch), meets the sentence, and that one runs on GitHub's runners (`CI_SELF_HOSTED_LABELS`,
[below](#routing-jobs-to-it)) or takes the change in. A commit from before the env file existed
(October 2026) reads neither variable: its lanes run, each counting only its own container.

## Prepared tools and caches

Self-hosted jobs verify the image's Bun version, requested Node major and herdr checksum instead
of downloading tools. Both browser lanes use the installed project's Playwright revision to find
Chromium under `/opt/playwright-browsers`; a missing browser fails with rebuild guidance, not a
download fallback. Rebuild with `--build` after changing the tool pins or Playwright in `bun.lock`.
The image's `BUN_VERSION` must match the default in `.github/actions/setup-ci/action.yml`,
`RUST_VERSION` must match `EXPECTED_RUST_VERSION` in `scripts/ci-preinstalled-tools.sh` (the Rust PTY
host job checks it), and `PLAYWRIGHT_VERSION` must match the lockfile. The toolchain is root's under
`/opt/rustup` and `/opt/cargo`; a job's crate downloads go to its own `~/.cargo` and end with its
container. No host cache holds them: measured on hosthatch in the image, the whole crate graph's
download, release build and tests take about 7 s from nothing (GitHub's image: 18-22 s).

### Runner version

Runners register with `--disableupdate`, so `RUNNER_VERSION` in the Dockerfile decides the
actions/runner version. Without it, a runner older than GitHub's latest release starts the update
only after it is handed a job, and GitHub cancels that job about 3.5 minutes later with no runner
name and no step (seen with 2.338.0 once 2.338.2 was out: every container downloaded the update).
GitHub stops sending jobs to a runner more than 30 days behind a release, so raise
`RUNNER_VERSION` and `RUNNER_SHA256` (the `linux-x64` SHA in the release notes) when actions/runner
releases, then rebuild with `--build`.

Bun dependencies are installed from `bun.lock`, with the local install-cache directory at
`.ci-cache/bun` retained inside the checkout. Only hosted jobs restore and save that directory as
a remote dependency cache: on the measured connection, transferring the archive took 37–43s.
Self-hosted jobs start it from the host's copy instead (Host caches, below). Hosted
browser caches use `.ci-cache/playwright`; self-hosted jobs skip that remote cache because the
browser is already in the image. Workspace-relative archives avoid restoring home-directory paths
from a different checkout depth (GitHub's workspace versus `/w`).

## Host caches

Every job used to fetch the same bytes: about 45 MB of git objects for its shallow checkout,
105 MB of packages for `bun install`, and another 45 MB for Fast checks' tag fetch. Twenty runners
on one ~100 Mbit/s line saturated it, and a Fast checks job ran out of its 10 minutes in checkout
and that fetch. So the launcher keeps two caches on the host, per repository in
`<--cache-dir>/OWNER/NAME` (default `~/.cache/ovis-ci-runner/OWNER/NAME`), and mounts that
directory read-only at `/cache` in every runner container:

- `git/repo.git`, a bare mirror of the repository's branches and tags (no pull request refs),
  fetched from GitHub before the first runner starts and every minute after. Runners get
  `GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/git/repo.git/objects`, so `actions/checkout` and every
  other git command of a job read objects from the mirror and fetch only what it lacks: a pull
  request's new commits. Measured: checkout 44.7 MB to 0.01 MB, the tag fetch 44.9 MB to 0.06 MB.
  A job's checkout then holds only the objects the mirror lacks, so a step that clears the `GIT_*`
  variables cannot read that checkout's history. Git never collects the mirror's objects on its
  own (a job may still read one of a deleted or force-pushed branch); past 50 packs the launcher
  joins them, keeping every object. A mirror whose origin is not this repository is set up again.
- `bun/<blob of bun.lock>`, Bun's install cache for the default branch's lockfile, with `current`
  pointing at it. The default branch is the one GitHub names on that refresh (`ls-remote --symref
  origin HEAD`), and only once the mirror holds it: a refresh that fails or gets no answer builds
  nothing, never from the mirror's own HEAD. It is built when that lockfile changes, in a throwaway container of the runner
  image with the runners' hardening, as the host user, from a checkout of the mirror:
  `bun install --frozen-lockfile --ignore-scripts`, which resolves nothing beyond the lockfile,
  checks every download's integrity against it and runs no package script. A failed build (a
  crash or the OOM killer included) is retried after 30 minutes; one the launcher's own stop ended
  is not counted. Bun cannot install from a read-only cache, so setup-ci
  (`scripts/ci-seed-bun-cache.sh`) copies `current` into the job's `.ci-cache/bun`, under that name
  only once complete; `bun install --frozen-lockfile` then downloads only what the job's own
  lockfile adds. Measured: 105 MB in 11s to nothing in about 3s. A replaced version stays an
  hour after it was replaced, for jobs copying it at that moment.

A cache the launcher cannot refresh (GitHub or the registry unreachable or stalled) only means more
downloads: runners still start, jobs fetch what the caches lack, and the journal says
`[cache] ...`. The first runners wait for the first refresh up to `--cache-wait` seconds (default
120), then start without it. Git gives up on a transfer slower than 1 KB/s for a minute and on any
fetch after 15 minutes, and the Bun cache build is stopped after 15 minutes. On a stop, the launcher
waits for the refresh's git and docker clients (one that ignores SIGTERM is killed 5 s later) and
removes the build container before it exits. A cache directory the
launcher cannot use runs the runners without caches. `--no-cache` turns both off. Artifact uploads and the actions' own archives (about 8 MB a job)
still use the network.

## Build cache

Fast checks, Integration tests and both Browser regression jobs each run `bun run build` on the same
commit: about 60 CPU seconds apiece on the P620. `run.sh --build-cache DIR --build-cache-writer LOGIN`
lets the first of them build it and the others restore its `dist/` in a fraction of a second
(`scripts/build-cache.ts`). Point it at RAM (`/dev/shm/ovis-build-cache`); `--build-cache-mb`
(default 2048, about 50 builds) bounds it, least recently used first. Under SELinux the launcher labels
the cache and each slot's outbox `container_file_t` as it starts (new files keep their directory's
label), or runs without the cache when it cannot. A label set this way lasts until the next
`restorecon` or full relabel, so on such a host put the cache in a directory a `semanage fcontext`
rule labels `container_file_t` (on disk it is read through the page cache, as fast as `/dev/shm`),
and give the outboxes (`~/.local/state/ovis-ci-runner/build-outbox`) such a rule too. Measured (four builds of one
commit, as one run's jobs do): 246-266 CPU s without it, 53-70 CPU s with it; four started at once
build once.

Every runner container gets `DIR/OWNER/NAME/entries` (the cache) **read-only** at `/build-cache`, the
Docker volume `herdr-ci-<host>-build-cache-locks` (a 16 MiB tmpfs: which job builds a key, the others
wait for it) and its slot's own outbox, on disk under `~/.local/state/ovis-ci-runner/build-outbox/`. A
job that built a commit leaves `<key>.tar` and `<key>.claim` (its run) in that outbox, and the launcher
(`build-cache-promote.sh`, every second) takes it in only when GitHub says that runner is running a
job of that run and the run is trusted: a push to the default branch, or a pull request from this
repository that `--build-cache-writer` opened and started. Without the flag only pushes write. A
slot runs one job per container under the same runner name, and GitHub answers for the job the
slot runs when it answers, so a claim is also tied to the container whose job wrote it. The build
is taken in only while the container docker names for the slot is the one it named when the claim
was taken, and only for a job that started once that container had (to the second, with nothing
allowed for the two clocks: `run.sh` waits two seconds before every container of a slot, the first
after a launcher start included, since the container before may have been killed with the launcher
that started it; and a container's own job starts ten or more after it), on the runner registered
under the slot's name now. GitHub goes on listing the job
of a container that was killed as running, for minutes and sometimes for days, and the container
after it registers over the dead one's runner and keeps its id, so the start time is what tells
that job from the container's own. `run.sh` empties a slot's outbox before it starts the slot's next
container, so a claim naming the run of the slot's next job, or of an earlier one, is refused. Were
the outbox not emptied, what an earlier job left would be read as the next one's: a claim or a
build last changed before the slot's container started is refused (the system's own time of the
change, which a job cannot set back; removing another name of a file sets it to now, so the times
are read before anything in the outbox is removed, and a file with a second name is not taken), and
a runner whose outbox still holds a file starts without the build cache. The
launcher unpacks only files and directories and writes the sha256 of each into the entry's
`.manifest`; a restore refuses an entry with a link, a missing, changed or extra file. Every other
outbox file is deleted. One claim per outbox is judged per pass, and a refusal is remembered (the
run and attempt for a day, the slot for ten minutes), so a job claiming over and over costs no
GitHub calls on the launcher's token, which also registers the runners. A restore says it used an entry with an empty `used-<key>` in its own
outbox, which the launcher stamps into `used/` (never written through a directory other jobs share).
Pull request runs and pushes to main read it; the CI a Release run runs itself and manual runs
always build, and a run whose build the launcher would refuse (another author's pull request, say)
builds at once instead of waiting on the lock. A release validated by main's push run instead
([Releasing](../../docs/development.md#releasing)) ran no Integration or Browser job of its own: it
took that run's, which tested a `dist/` restored from here, built by a job of that same run.

An entry is named after the commit, Bun's version, the variables Vite reads and any `.env` file; a
checkout with uncommitted changes, or with ignored files where Vite reads, never uses it. The
key does not hash `node_modules`: it takes it to be what `bun install --frozen-lockfile` makes of the
commit's `bun.lock` and patches, as in every CI job, so a hand-edited `node_modules` is not one to use it with.

An entry belongs to the run that built it. The launcher files a build as `entries/<run id>/<key>`,
under the run GitHub confirmed for the slot that handed it in, and a job reads only
`/build-cache/<its GITHUB_RUN_ID>/<key>`: a run restores only what a job of the same run built (a
rerun keeps its run id, so it restores what its earlier attempt built). The key is the job's own word
for what it built, which the launcher cannot check. Filed by the key alone, a build that a trusted
pull request run handed in under the key of a new commit of main, before main's own run had built
it, would be the `dist/` main's Integration and Browser jobs restore and test, and since a release
can be validated by main's run, the one behind that release; agents open pull requests as the
writer, and CI runs before any review. Sharing a build between runs was never the purpose, the jobs
of one run are. The lock is the run's as well (`.lock-<key>-<run id>`), so two runs of one commit (a
pull request opened again, a draft made ready) do not wait for each other's build. A restore's
`used-<key>` names no run: it stamps `used/<key>` when some run's directory holds that key, for all
of them, which only moves eviction. Eviction keeps the most recently used entries of all runs
within `--build-cache-mb` and removes a run's directory once it is empty.

The job's side (`scripts/build-cache.ts`) comes with the commit a run checks out; the launcher's
(`run.sh`, `build-cache-promote.sh`) is the copy installed on the PC ([below](#routing-jobs-to-it)),
which is updated by hand. While only one of the two keeps entries per run, nothing is restored and
every job builds. A launcher from before files a build by its key alone, where no job of a newer
commit reads; the job's log then says the build `was not filed under this run but by its key alone`.
A job of a commit from before reads by the key alone, where the launcher no longer files. Neither is
a failure and neither wait runs out: the job that built gets its verdict as before, and the jobs of
its run that waited for it build once it releases the lock, together, about one build later than
without the cache (those of a commit from before one after another, as they always did when a build
was not taken in). So copy this directory again when a change here moves where entries are filed
(the copy alone switches the promoter, [below](#routing-jobs-to-it)); runs of commits that have the
change restore again from then on. What the earlier launcher left as `entries/<key>` the new one
moves out of the names a job reads and removes in its first pass: a job of a commit from before
would still read it there, whichever run had filed it. One it cannot remove stays under a
`.new-gone-` name, which no job reads, and is tried again by an eviction once it is over an hour
old; one it cannot even move is emptied where it is, and logged once a day while it stays.

## Routing jobs to it

`ci.yml`'s Linux jobs of a push go to `["self-hosted","self-hosted-ovis"]` by default, the launcher's
default label. A same-repository pull request goes there too, and GitHub-hosted only when a job has
waited more than four minutes for that label, or more than a minute while none of its jobs runs (no
runner looks online). There is no runner count to keep up to date: a host that takes no more work
simply leaves jobs queued, and the next run overflows. Detect changes, which makes that choice, runs on
the same label unless `CI_LIGHT_LABELS` names others, so with every runner gone a run waits there:
then set `CI_SELF_HOSTED_LABELS` to `"ubuntu-24.04"`, and `CI_LIGHT_LABELS` too when it holds labels. The repository variable overrides the choice:

```sh
gh variable set CI_SELF_HOSTED_LABELS --body '"ubuntu-24.04"'   # PC offline: everything GitHub-hosted
gh variable set CI_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis"]'   # every pull request and release.yml too
gh variable delete CI_SELF_HOSTED_LABELS   # back to the default
```

Pushes to main can have runners of their own, so a merge's CI never queues behind pull request runs.
`run.sh --reserved N` registers the first N of its `--count` slots with `--reserved-labels` (default
`self-hosted-ovis-main`) instead of `--labels`, and the repository variable
`CI_MAIN_SELF_HOSTED_LABELS`, when set, routes a push to main over `CI_SELF_HOSTED_LABELS`:

```sh
gh variable set CI_MAIN_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis-main"]'   # main on the reserved slots
gh variable set CI_MAIN_SELF_HOSTED_LABELS --body '"ubuntu-24.04"'   # main alone GitHub-hosted
gh variable delete CI_MAIN_SELF_HOSTED_LABELS   # main back on the pull requests' runners
```

Only a push to main asks for `self-hosted-ovis-main` (or a manual run whose `self_hosted_labels` names
it). Pull requests ask for `self-hosted-ovis`, which the reserved slots lack, so they never take one:
keep such a label in any `CI_SELF_HOSTED_LABELS` you set, since `["self-hosted"]` alone would let them.
A job waits for a runner that has every label it asks for, and only the P620 runs reserved slots (the
maintainer PC's unit below has none): while the variable names the reserved labels and none of those
runners is online, main's Linux jobs wait, so delete the variable when the P620 goes offline.
`CI_SELF_HOSTED_LABELS='"ubuntu-24.04"'` still keeps main's jobs GitHub-hosted too. The reserved slots mount the check
slots of every other runner: they take runners away from pull requests, not load, and main's herdr-backed jobs still
share `check.ts`'s slots (`CHECK_HOST_MAX_RUNS`) with theirs, so they can wait there for one.

On the maintainer PC the launcher runs as the systemd user unit `ovis-ci-runner.service`
(`run.sh --repo devswha/ovis --count 4 --labels self-hosted-ovis` from a copy of this directory in
`~/.local/share/ovis-ci-runner`): four slots start four of one CI run's six Linux jobs together, and
`check.ts`'s shared slots cap its herdr-backed lanes at `ci.yml`'s `CHECK_MAX_RUNS`. Copy the directory again
after changing these files, on every host whose launcher runs with `--build-cache`. For a change to
`build-cache-promote.sh` the copy is all it takes: the launcher starts the promoter from that
directory every second, so the next pass is the new one. A change to `run.sh` takes a restart of
the unit, and a restart stops every slot's container, which cancels the jobs in flight: restart
when the slots are idle. Replace the files by rename (`rsync -a` does), not in place: a pass under
way keeps the script it started with, as does the running `run.sh`. Jobs run the
repository's `scripts/build-cache.ts` against the installed `build-cache-promote.sh`: after a change
to where the build cache's entries are filed, no job restores a build until the copy is the new one
([Build cache](#build-cache)).

### The fastest machine's own label (Fast checks, Integration tests, herdr-core live contract)

The hosts differ: the P620 runs Fast checks and Integration tests in about half the time of the slower PC, so these
two jobs can prefer it. Give that host's runners a label of its own beside the pool's (they still take every pool job),
then name it in the job's repository variable:

```sh
# on the P620: its launcher's --labels gets a second label (a comma, no space), then restart the unit when it is idle
run.sh --repo devswha/ovis --count 6 --reserved 2 --labels self-hosted-ovis,self-hosted-ovis-p620 ...
gh variable set CI_FAST_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis-p620"]'
gh variable set CI_INTEGRATION_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis-p620"]'
gh variable set CI_FAST_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis"]'   # Fast checks back on the pool
gh variable delete CI_INTEGRATION_SELF_HOSTED_LABELS   # Integration tests back on the pool
```

`scripts/ci-runner-route.sh` uses them only while the Linux jobs take the shared pool (`["self-hosted","self-hosted-ovis"]`)
in a same-repository pull request or a push (a fork, `hosted_only`, every other event, main's reserved runners and the
VM runners stay where the Linux jobs go), and only while that label's queue is short: once a job asking for it has
waited more than two minutes, or one has waited a minute while none of its jobs runs (the host looks offline), the job
goes to the Linux jobs' runners instead. Its counts come from the same Actions read as the other routes. The P620 also
runs agent lanes and QA, so a busy P620 lengthens that queue and the jobs move back to the pool by themselves. A job
already sent to the host waits for it, so when the host goes offline for long, set the variables back to the pool's
labels (or delete them), as for `CI_MAIN_SELF_HOSTED_LABELS`. A value equal to the pool's labels means no preference.
On the cloud VM runners (`ovis-vm`) `CI_FAST_SELF_HOSTED_LABELS` keeps its own rule below, without the queue check.

herdr-core live contract runs GitHub-hosted by default: it finished there faster (about 310 s) than on the self-hosted
PCs (about 330 s) and took a pool slot in every run. `gh variable set CI_HC_LIVE_LABELS --body '["self-hosted","self-hosted-ovis"]'`
moves it back to the pool (a fork's run stays hosted whatever it says); `gh variable delete CI_HC_LIVE_LABELS` returns it.

### The Rust PTY host job

`ci.yml`'s Rust PTY host job asks for `["self-hosted","self-hosted-ovis-rust"]`. Only a slot that a
launcher registers with that label takes it, so a host whose image predates the Rust toolchain never
does: a host serves it with one slot of its own, the launcher's reserved slot, on top of its others:

```sh
run.sh ... --count 3 --reserved 1 --reserved-labels self-hosted-ovis-rust   # was --count 2: slot 1 takes the Rust job alone
```

The job takes about a minute, and in GitHub's hosted queue it waited two seconds in most runs (49 pull
request runs to 2026-11-21: median 2 s, two waits of 14 and 23 minutes), so a slot of its own is what makes
it as quick here: in the shared pool the same runs' jobs waited 8 to 55 s at the median per host and 3 to 6
minutes at the 90th percentile, behind Integration tests and the browser parts. HostHatch and old-desktop
run one each. Rebuild the
image with the toolchain (`--build`) before you add the label. The job goes to these slots only once the
repository variable `CI_RUST_SELF_HOSTED` is `true`; unset (the default), empty or `false` keeps it on
`ubuntu-24.04` as before the slots existed. Any other value fails Detect changes in the runs that read it,
a same-repository pull request or a push to a branch; forks, `hosted_only` (the Release's), manual runs and
every run while `CI_SELF_HOSTED_LABELS` names the hosted image stay hosted without reading it, so a typo
never stops a release:

```sh
gh variable set CI_RUST_SELF_HOSTED --body true   # the Rust job on the Rust slots
gh variable delete CI_RUST_SELF_HOSTED            # back to ubuntu-24.04
```

Opted in, `scripts/ci-runner-route.sh` still keeps forks, `hosted_only` and manual runs on `ubuntu-24.04`,
and sends the job there too while `CI_SELF_HOSTED_LABELS` names the hosted image, while no Rust slot has
been seen online for five minutes, and once a job of these slots has waited more than a minute (both busy).

The workflow token cannot list runners, so "seen online" is the repository variable `CI_RUST_RUNNER_SEEN`:
the epoch seconds at which `rust-heartbeat.sh` last found a runner with the label online. It runs every
minute on the maintainer PC with an admin `gh`, beside the Mac's heartbeat, as a systemd user timer:

```ini
# ~/.config/systemd/user/ovis-rust-heartbeat.service
[Unit]
Description=Ovis Rust runners' heartbeat (CI_RUST_RUNNER_SEEN)
[Service]
Type=oneshot
ExecStart=/bin/bash %h/.local/share/ovis-ci-runner/rust-heartbeat.sh

# ~/.config/systemd/user/ovis-rust-heartbeat.timer
[Unit]
Description=Ovis Rust runners' heartbeat every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
```

With both Rust slots gone, or the maintainer PC off, the value ages and every later run's job goes
hosted before it queues. One window stays open: a run routed in the five minutes before the value aged
still waits for the slots, and GitHub never moves a queued job, so that run's Rust PTY host job (not a
required check) waits until a Rust slot is back, or until GitHub drops it after a day. Cancel that run, wait
until it has completed (a re-run of a run still cancelling is refused), and run it again in full; its Detect
changes then sends the job hosted:

```sh
# after the heartbeat has aged (five minutes)
gh run cancel <run id> && gh run watch <run id> >/dev/null && gh run rerun <run id>
```

On main a push run left so holds the next push's run behind it (one concurrency group), and a release
cannot reuse it, so cancel and re-run it the same way. Turning the opt-in off (`gh variable delete
CI_RUST_SELF_HOSTED`) sends every later run's job hosted at once.

## Per-host limits

`ci.yml` sets the self-hosted values for a 32-core PC, and a workflow cannot read its runner's
environment to choose others. A host that can take more says so in an env file (`NAME=value` per
line) that `run.sh --env-file FILE` hands to every runner container; `scripts/check.ts` lets these
replace the workflow's values for the run, and a host without the file keeps `ci.yml`'s:

| Host variable | Replaces | Used by |
| --- | --- | --- |
| `CHECK_HOST_MAX_RUNS` | `CHECK_MAX_RUNS` (1 to 8) | herdr-backed lanes of every runner of the host |
| `CHECK_HOST_TEST_SHARDS` | `HERDR_TEST_SHARDS` | Integration tests |
| `CHECK_HOST_BROWSER_WORKERS` | `BROWSER_WORKERS` | both browser jobs (capped at their script count) |
| `CHECK_HOST_UNIT_WORKERS` | `UNIT_TEST_WORKERS` | Fast checks |

`run.sh --cpuset-cpus LIST` (docker run's own option, `0-95` say) keeps every container it starts on
those CPUs, the runners and the cache builds alike, so work beside them keeps the rest. A list docker
cannot give is refused at start (exit 2), before any slot asks for a registration token.

`run.sh --cgroup-parent SLICE` (docker run's own option) starts every container it starts, and the
image build's steps, under that cgroup instead of docker's own: with docker's systemd cgroup driver
on cgroup v2 (`docker info` says `systemd` and `2`), a system slice such as
`ovis-ci.slice`, which sits under `ovis.slice`. Give that top slice a low CPU weight
(`/etc/systemd/system/ovis.slice` with `[Slice]` and `CPUWeight=20`, then `systemctl daemon-reload`)
and the jobs run at full speed while the CPU is free, but yield to the PC's own sessions (weight 100)
when both want it. Weights compare siblings only, so the weight goes on the top-level slice. A parent
docker cannot use is refused at start, like a CPU list.

Every runner of a host must read the same file, since they share the slots. The launcher hands
`CHECK_HOST_MAX_RUNS` on as `CHECK_SLOTS_MAX_RUNS` ([Check slots](#check-slots)); the file keeps the
name. Keep it outside this
directory (`~/.config/ovis-ci-runner/host.env`), so copying the directory again leaves it alone.
The launcher refuses any line but a comment, a blank or `CHECK_HOST_<name>=<number>`: a bare `NAME`
line would make Docker copy that variable from the launcher's own environment (`GH_TOKEN`, say)
into every job. Write the number unquoted. Keep
`CHECK_HOST_TEST_SHARDS` at 9 or less: check.ts sizes the herdr socket paths for nine shards.

The ThinkStation P620 (64 cores / 128 threads, 30 GiB) ran `--count 12 --env-file
%h/.config/ovis-ci-runner/host.env` with:

```sh
CHECK_HOST_MAX_RUNS=5
CHECK_HOST_TEST_SHARDS=6
CHECK_HOST_BROWSER_WORKERS=8
CHECK_HOST_UNIT_WORKERS=8
```

After two hardware resets under that load (a data fabric sync flood), it runs `--count 8 --reserved 2`
(six runners for pull requests, two for main's pushes) with `CHECK_HOST_MAX_RUNS=3`,
`CHECK_HOST_TEST_SHARDS=4`, `CHECK_HOST_BROWSER_WORKERS=5` and `CHECK_HOST_UNIT_WORKERS=5` until its
memory is checked.

Memory, not CPU, bounded it then. Measured there with three runners and `ci.yml`'s values, the CPU
stayed over 90% idle while Browser regression (other scripts) held 2-4 GiB with one script's spike to
9.3 GiB, Browser regression (ui-regression) 2.6-4.5 GiB and Integration tests 1.6-2.7 GiB; the
host peaked at 14.6 of 30 GiB; Fast checks peaked at 0.6 GiB. More browser workers raise that
spike: with ten, Browser regression (other scripts) reached 14 GiB for about 20 s, so the P620 ran
eight, and a fifth slot job left about 9 GiB of the 30, room for one browser spike but not two.

The P620 has 184 GiB now. A second host runs pull requests' runners with `CHECK_HOST_MAX_RUNS=3`.
Every herdr-backed job takes one check slot of its host: Integration tests, Browser regression
(ui-regression) and each of the three parts of Browser regression (other scripts), five per run, and
a host runs at most `CHECK_HOST_MAX_RUNS` of them at once, however many runners wait for a slot, so
the other runners hold only Fast checks and the setup steps before a slot (on the host with three
slots, a run's parts waited 146 to 278 s for one in two of four runs). Measured on 2026-11-17 on
this pull request's runs, with six workers per part: one part peaked at 5.6 to 10.2 GiB (the one job
of six workers before the split peaked at 9.2 GiB), the three parts of one run at 15.2 to 19.0 GiB
together, and the hosts' available memory never fell below 79.9 GiB on the P620 or 77.8 GiB on the
second host, so two runs' spikes at once fit on either.

A manual run can override the variable with the `self_hosted_labels` workflow_dispatch input. Fork PRs always use `ubuntu-24.04`; Windows/macOS jobs, `remote-bundles.yml` and `windows-install.yml` stay GitHub-hosted, except the `macos-15` jobs that hold no secret (`ci.yml`'s Native macOS session identity job, and for pull requests from this repository the `macos-15` entries of `remote-bundles.yml` and `pty-sidecar.yml`), which follow the repository variable `CI_MAC_LABELS` to the self-hosted Mac when it is set ([docs](../../docs/development.md)).

## Offering a runner only when there is room

A registered runner is an offer: GitHub hands it any job whose labels it matches, so a host that is
already busy keeps taking work. `run.sh --offer-when-room` makes a slot wait until this host has room
before it fetches a registration token and starts its runner:

- no other runner of this host in the same pool is idle (a pool is a repository and a label set: an
  idle runner of another repository never takes this one's jobs, whatever its labels; both pull
  request pools and a launcher copy's own runners count: the host's containers are `herdr-ci-<host>-*`, and a runner counts as idle until a
  `Runner.Worker` process is in it, one still registering included), so the host offers at most one
  idle runner per pool;
- no job started on this host in the last 30 s and no runner of it started in the last 30 s (both
  delays exist because pressure rises after a job begins, not when it is handed out);
- CPU and memory pressure are under the host's thresholds, if it sets any.

Slots started with `--reserved` skip the gate: main's jobs start at once. Without the flag nothing
changes, and `--count` is still the hard maximum.

The two thresholds live in the host's env file beside the other `CHECK_HOST_*` values, whole numbers,
in percent of `/proc/pressure/cpu` and `/proc/pressure/memory` "some avg10":

```sh
CHECK_HOST_OFFER_CPU_PSI=25
CHECK_HOST_OFFER_MEMORY_PSI=10
```

Leave one out and that half of the pressure condition does not exist; leave both out and the gate
keeps the first two conditions only. A kernel without `/proc/pressure` (PSI off) skips the pressure
condition with one line in the launcher's log. A gate that waits says so once per reason, not every
poll.

The gate is not a limit on jobs: a host's `--count` still has to fit its `CHECK_HOST_MAX_RUNS` (at most
8, the most herdr-backed lanes `scripts/check.ts` admits), and the two thresholds are what a person
tunes to keep a loaded host out of the pool.

## Cloud VM runners

`vm-runner.sh` turns a 4-vCPU cloud VM without systemd (a Cursor cloud agent's VM, say) into a runner of this
repository with the same image, guard and per-job fresh container as above, for when this PC's cores are needed
elsewhere:

```sh
vm-runner.sh setup                                  # docker.io, dockerd, the image built from main, the firewall
gh api -X POST repos/devswha/ovis/actions/runners/registration-token --jq .token \
  | ssh vm 'vm-runner.sh register vm-NAME ovis-vm'  # once; the token goes in on stdin and is used once
vm-runner.sh supervise                              # forever: one container per job (run.sh --once)
```

- Registration is not ephemeral: the VM keeps the runner's credential (a root-owned docker volume) and each job's
  container gets a copy. The runner reads it as the same user the job's steps run as, so **a job can read its runner's
  credential** and could register a look-alike runner that takes later jobs of this repository. Only this repository's
  own branches run here (the guard below), so that takes code already in this repository; this PC's runners differ in
  holding a fresh registration per job. Remove the runner (`gh api -X DELETE repos/devswha/ovis/actions/runners/ID`)
  when the VM goes, and re-register to rotate the credential.
- The firewall is not optional: such VMs listen on every address with services of their own (an unauthenticated
  Docker API on 2375 among them). `vm-runner.sh` drops all traffic from the job containers to the VM itself and to
  private and link-local ranges; a job reaches the internet and the resolver only.
- Fork PRs never run here, as on every runner of this image (`job-started.sh`).
- **Fast checks**: on these VMs (Linux 6.12, 4 vCPUs) Fast checks fails until the coarse-file-clock and SIGTERM fixes
  of #3808 are on main. Until then keep it on this PC's runners while the rest moves:
  `gh variable set CI_FAST_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis"]'`. It applies only while
  the Linux jobs go to `ovis-vm` (never to a fork's run); delete it once #3808 is in to move Fast checks too.
- Routing: `gh variable set CI_LINUX_SELF_HOSTED_LABELS --body '["self-hosted","ovis-vm"]'` moves ci.yml's Linux jobs
  of pull requests and branch pushes to them (main keeps `CI_MAIN_SELF_HOSTED_LABELS`; tag pushes, manual runs and
  relay-deploy's call to ci.yml keep `CI_SELF_HOSTED_LABELS`; pages.yml's and release-validate's calls are always hosted). With `ovis-vm` the browser scripts run as five jobs. A manual run takes
  `self_hosted_labels`. `gh variable delete CI_LINUX_SELF_HOSTED_LABELS` moves them back.
- The VM's per-host caps (`CHECK_HOST_*`, 3 browser workers, 3 test shards) keep a job inside 4 vCPUs. A VM that
  sleeps or drops mid-job loses that job (GitHub fails it once the runner stops answering); keep the VMs awake.

## Security model

This is a public repository. A fork PR's run uses the fork's workflow files and `scripts/ci-runner-route.sh`, so it can choose `runs-on` itself. The runner therefore enforces the boundary: `job-started.sh` runs before every job (`ACTIONS_RUNNER_HOOK_JOB_STARTED`, set in the image, outside the workflow's control) and refuses any job whose event names another head repository (a fork pull request, a deleted head repository, a `workflow_run` of a fork), or a `pull_request*` or `workflow_run` event that names none. It fails closed: any exit before it explicitly allows the job, an error of its own included (a missing or unreadable event file, broken JSON, an unset variable), refuses it, with SIGPIPE and termination signals ignored, so a closed output cannot stop the refusal halfway. A failing hook alone is not enough: runner v2.338 marks only its "Set up runner" step failed and still runs the job's `if: always()` and `if: failure()` steps (checked on a live runner: the old exit-only hook ran them). So a refusal SIGKILLs the job's `Runner.Worker`, and nothing else within one limit: the runner starts the hook as the worker's direct child, and the hook kills its own parent only when these checks prove that parent the worker. The limit: after the hook's last read of its parent, the worker could exit, be reaped and have its pid handed to a new process before the kill; a shell cannot close that window, as `kill` takes a number. It is still the hook's parent (an orphaned hook's parent is whatever adopted it, which may be a user's systemd manager), its executable is `Runner.Worker` (on Linux by `/proc/<pid>/exe` and its name; on macOS only by the path `ps -o comm=` prints, which any executable file named `Runner.Worker` satisfies), it runs as the hook's user, and its start time is unchanged (on Linux, no later than the hook's). Right before the kill the hook reads that start time and its own parent again; it does not read the executable, name or user again. The job then ends as failed within seconds with no step run and an empty log (checked on a live runner with the earlier hook, which found the worker by its name); as the job's log goes with the worker, the refusal is written to the container's output too (`journalctl --user -u ovis-ci-runner`). When any check fails, the hook kills nothing: it writes the refusal with its own pid and blocks in its step, so no later step starts, until the parent it started under is gone; then it ends by itself. The runner starts the hook directly from the worker, so that parent is the worker, and once it is gone no step can run. A limit the hook cannot close: were a process ever started between the worker and the hook, and did it exit while the worker lives, the worker would finish the step itself and the job's `always()` and `failure()` steps could run, since the hook's parent is then not the proven worker. A cancel or the job's timeout then ends the job without another step, by runner v2.338.2's source (not yet seen on a live runner): the hook's step runs under `always()`, so a cancel leaves the worker in it, and the runner kills the worker itself once the cancel timeout (at least 45 seconds) has passed. A blocked refusal means the hook could not prove its parent the worker, which on these runners points at the runner itself: look at it before its next job. Do not end a blocked hook yourself: while its worker lives, the hook's end would fail its step and run the job's `always()` and `failure()` steps. Cancel the job; nothing else is needed, as the runner then ends the worker and the hook ends once its worker is gone. The hook's tests reach a refusal only where it cannot kill a process they did not start: in a PID namespace of their own, or in a throwaway container of an image that carries the marker `/opt/runner-hooks/ovis-runner-image` (this image has none, so they never run in a live runner's container); anywhere else they skip, and only the test of a job the hook allows runs. CI runs them, its refusals and its kill alike, on every pull request and every push to main in the check "Hook kill tests (container)" (`.github/workflows/hook-kill-tests.yml`, on GitHub's hosted `ubuntu-24.04`): a container of `hook-test.Dockerfile`'s image, which is not this image, started confined (`--init --network none --cap-drop ALL --security-opt no-new-privileges`, the source read-only), whose isolation is printed and checked before any test starts, and which fails on any skip. In that container a blocked hook and its fake parent are left running when the harness returns; they are the harness's own, in the container's own PID namespace, and they end with the container. A person runs them the same way: `docker build -t <image> -f scripts/self-hosted-runner/hook-test.Dockerfile scripts/self-hosted-runner`, then `bun install --frozen-lockfile --ignore-scripts` in a checkout, then `bash scripts/self-hosted-runner/hook-test-container.sh <image> <checkout> <empty directory>`. Fork PR runs also need maintainer approval (repository setting: all outside collaborators); never approve one that changes `runs-on`. Containers are ephemeral (`--ephemeral`, `--rm`), unprivileged (`--cap-drop ALL`, `no-new-privileges`, no `--privileged`), have no host mounts but the read-only host caches and no Docker socket, and the image has no sudo. The registration token reaches the container on stdin, never through its environment, so a job cannot read it from `/proc/1/environ`.

No job reaches another over the network: each slot's container is alone on its docker network, so
the servers a job's tests keep on its loopback, and the two they bind to every address, answer
only that job ([Check slots](#check-slots)). That rests on docker keeping its bridge networks
apart, which it does with its own packet filter rules; a daemon run with `"iptables": false` writes
none, and must not run these runners. Two jobs both write in the check slots volume (and, with
`--build-cache`, in its locks volume, below): lock files they cannot remove or replace, 1 MiB in
all. A job that holds them makes the others' herdr-backed lanes wait and then fail, and one that
keeps them full makes them fail at once, for as long as it runs: a run that finds no room empties
every file no run holds, so what a job wrote takes no room once the job is gone. What it writes
there is read only as a pid, a checkout's name and a time, which the other jobs' logs then show,
and can at worst send another job's lane away as a second run of its own checkout. All of that a
job could do before, on the ports.

The host caches cannot carry one job's code into another's: runners mount them read-only, and only
the launcher writes them, the mirror from GitHub and the Bun cache from downloads checked against
the default branch's lockfile. A git object is named by its hash, so the mirror cannot change the
commit a job checks out; Bun does not check a cached package again, which is why only that
lockfile, never a job, fills the Bun cache. A job's copy of it is its own. The build cache (with
`--build-cache`) is read-only to jobs as well: only the launcher writes it, from the builds of runs
GitHub names as trusted (above), each under the run that built it, which is the only run whose jobs
restore it: a trusted run's build never reaches another run, main's included. A job can write its
own outbox (on disk, as its workspace is) and the 16 MiB locks volume, so at worst it makes the jobs
waiting on a key wait up to five minutes and build themselves.

Anyone who holds a runner registration token can register a runner under any label, and that runner
then takes the jobs that ask for the label, with the run's token: every job of a run can write the run's
artifacts, and any job of a main run can write an Actions cache that later runs restore. So
`scripts/privileged-jobs-workflow.test.ts` holds the workflows to one rule set:

- A privileged job (a write permission, `id-token: write` included; an environment; or a secret it
  references) names a hosted label from a fixed list literally, never a self-hosted label or a variable,
  input, job output or matrix value that could carry one, whatever the routing variables above say; it uses
  only reviewed actions at their exact references, and restores no Actions cache.
- A whole-run run is GitHub-hosted and cacheless as a whole. These are every run with a privileged job that
  takes an artifact (download-artifact, deploy-pages), since any job of the run could have written it: the
  Release (with the CI it runs itself, called with `hosted_only: true`), and the desktop, Windows app, PTY
  host, beta, remote bundle and hosted-shell preview workflows; and every Pages run, found by any of four
  signs: a job that can write Pages, a job in the `github-pages` environment, a job holding `id-token: write`
  with a secret, or the deploy and upload actions. Pages' build, `current` and deploy jobs name `ubuntu-24.04`,
  and its manual validation calls `ci.yml` with `hosted_only: true`, which puts every job of that call on a
  hosted label and turns its caches off; `ci.yml`'s own runs and relay-deploy's call leave it unset.
- Every other privileged job is held to the first rule only. A push to a `gh-pages` branch by a job with
  `contents: write` shows none of the four Pages signs: the first rule keeps that job hosted, and if it takes
  an artifact its whole run is hosted.

The test fails closed on any other form: a listed label written literally, the `hosted_only` prefix under a
call that passes `hosted_only: true`, setup-ci's `cache: none` (or its `hosted_only` form), cache steps whose
condition has `!inputs.hosted_only` as a top-level `&&` term, setup-bun's `no-cache: true`, setup-node's
`package-manager-cache: false`, and reviewed actions at their exact references. Every job-level and step-level
`if` of a covered job, and every `if` of every workflow and of setup-ci, is refused when it still holds `${{` or
`}}` after one whole-value wrapper is stripped: GitHub reads such a condition as a string, always true. The
inputs of reviewed actions are read without regard to case, as the runner reads them, and inputs that differ
only in case are refused; a download with a token, from another repository, by run id or by artifact ids is
refused. It also fails on a workflow or action file GitHub loads that does not end in
`.yml`, on a symlink in `.github/workflows` or `.github/actions`, on a job that calls a workflow it cannot read
(another repository's), on a key it reads written in another case, two keys (or two workflow files) that
differ only in case, a key with a character outside ASCII, and on a runner label or action reference other
than its exact listed form; a character outside ASCII inside an expression counts as a secret reference. A
trial on 2026-11-17 observed why: GitHub refuses structural keys in another case, and matrix axes or job ids
that differ only in case, but reads a matrix include key `OS` as the axis `os` (a job then waited for a
`self-hosted` runner), and matches expression contexts and hosted labels without regard to case; the test
resolves matrix axes the same way and refuses the rest itself. A permission value other than `read`, `none`
or `read-all` counts as write. Actions are recognised by owner/repo, with `.` and empty path pieces dropped,
in any case.

Stated limits. A Pages run is missed when no job of its workflow, or of a workflow it calls, shows any of the
four signs, and a run is whole-run only when one of its privileged jobs takes an artifact through a reviewed
action. The first rule sees a secret only by its reference: a credential that reaches a job another way
(through an artifact, from `vars.*`, fetched at run time) is not seen as one, and such a job is held only by
the other signs it shows. A job that only gates another (a check, `current`, the CI a release reuses from
main's push run) can falsify its own result and so decide whether a publishing job runs, never what it
publishes; the Release's reuse of main's run reads only that run's conclusions and takes nothing from it.
The test reads runner labels, actions and their inputs, not shell commands or scripts.
The hosted labels on the list are the ones the covered jobs use: `ubuntu-24.04`, `ubuntu-24.04-arm`,
`windows-latest`, `windows-2025`, `macos-15`, `macos-15-intel` and `macos-latest`. For `ubuntu-24.04` the
boundary is observed: a job that asks only for it (or for `ubuntu-latest`, which no job uses) ran on
GitHub's own runners even while a self-registered runner carrying that label was online and idle, and
only a job that also asked for `self-hosted` reached such a runner. That was observed by a trial on
2026-11-17 (14 of 14 jobs); it is not documented by GitHub. The other six labels are assumed to behave
the same.

### Every job and its runner

Every job of `.github/workflows` as of this change (2026-11-17). LIGHT is the light runner expression (a
fork's pull request gets `ubuntu-24.04`; otherwise main takes `CI_MAIN_SELF_HOSTED_LABELS`, then
`CI_LIGHT_LABELS`, `CI_SELF_HOSTED_LABELS`, `["self-hosted","self-hosted-ovis"]`); ROUTE is
`scripts/ci-runner-route.sh`'s output; MAC is the macOS job's expression (`CI_MAC_LABELS` in ci.yml's own
runs, else `macos-15`); MACPR is the matrix form (`CI_MAC_LABELS` for the `macos-15` entry of a pull request
from this repository, else the entry's own label); HO is the `hosted_only` prefix, taken in `pages.yml`'s and
`release-validate.yml`'s calls. Write permissions without "(workflow)" are the
job's own; a call's jobs are listed under its workflow. No test reads this table; the test above holds
the rules.

| workflow | job | runs-on at this head | hosted? | write permissions / environment / secrets | cache restores |
| --- | --- | --- | --- | --- | --- |
| beta.yml | pick | `ubuntu-24.04` | yes | - | none |
| beta.yml | host-build | calls `pty-sidecar.yml` | (its jobs) | id-token, attestations write | (its jobs) |
| beta.yml | host-publish | `ubuntu-24.04` | yes | contents write | none |
| beta.yml | tag | `ubuntu-24.04` | yes | contents write | none |
| beta.yml | desktop | matrix: ubuntu-24.04, ubuntu-24.04-arm, macos-15 | yes | secrets MAC_NOTARY_KEY_P8, MAC_DEVELOPER_ID_P12, MAC_DEVELOPER_ID_P12_PASSWORD, MAC_NOTARY_KEY_ID, MAC_NOTARY_ISSUER | none |
| beta.yml | desktop-publish | `ubuntu-24.04` | yes | contents write | none |
| ci.yml | changes | HO ubuntu-24.04, else LIGHT | yes under hosted_only; else no: self-hosted unless a fork PR | - | none |
| ci.yml | windows-install | `windows-latest` | yes | - | setup-ci save, none under hosted_only |
| ci.yml | macos-session | HO macos-15, else MAC | yes under hosted_only; else yes unless CI_MAC_LABELS is set | - | setup-ci save, none under hosted_only |
| ci.yml | rust-pty-host | HO ubuntu-24.04, else ROUTE rust | yes under hosted_only; else as routed: hosted unless CI_RUST_SELF_HOSTED is true | - | setup-ci save, none under hosted_only |
| ci.yml | herdr-core-live | HO ubuntu-24.04, else a fork PR ubuntu-24.04, else CI_HC_LIVE_LABELS or ubuntu-24.04 | yes, unless CI_HC_LIVE_LABELS is set (never for a fork PR) | - | setup-ci restore, none under hosted_only; actions/cache (Cache hc, off under hosted_only) |
| ci.yml | fast | HO ubuntu-24.04, else ROUTE fast | yes under hosted_only; else as routed: self-hosted or hosted | - | setup-ci save, none under hosted_only |
| ci.yml | integration | HO ubuntu-24.04, else ROUTE integration | yes under hosted_only; else as routed: self-hosted or hosted | - | setup-ci save, none under hosted_only |
| ci.yml | browser-main | HO ubuntu-24.04, else ROUTE linux | yes under hosted_only; else as routed: self-hosted or hosted | - | setup-ci save, none under hosted_only; actions/cache (Cache Playwright browser, hosted runners, off under hosted_only) |
| ci.yml | browser-other | HO ubuntu-24.04, else ROUTE linux | yes under hosted_only; else as routed: self-hosted or hosted | - | setup-ci save, none under hosted_only; actions/cache (Cache Playwright browser, hosted runners, off under hosted_only) |
| ci.yml | integration-browser | HO ubuntu-24.04, else LIGHT | yes under hosted_only; else no: self-hosted unless a fork PR | - | none |
| desktop.yml | build | matrix: ubuntu-24.04, ubuntu-24.04-arm, macos-15, macos-15-intel, windows-2025 | yes | secrets MAC_NOTARY_KEY_P8, MAC_DEVELOPER_ID_P12, MAC_DEVELOPER_ID_P12_PASSWORD, MAC_NOTARY_KEY_ID, MAC_NOTARY_ISSUER, WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD | none |
| desktop.yml | feed | `ubuntu-24.04` | yes | - | none |
| desktop.yml | attach | `ubuntu-24.04` | yes | contents write | none |
| growth-snapshot.yml | snapshot | `ubuntu-24.04` | yes | secrets GROWTH_METRICS_TOKEN, GROWTH_SNAPSHOT_KEY | none |
| hook-kill-tests.yml | hook-kill-tests | `ubuntu-24.04` | yes | - | setup-ci restore |
| mac-dmg.yml | gate | `ubuntu-24.04` | yes | secrets MAC_DEVELOPER_ID_P12, MAC_DEVELOPER_ID_P12_PASSWORD, MAC_NOTARY_KEY_P8, MAC_NOTARY_KEY_ID, MAC_NOTARY_ISSUER | none |
| mac-dmg.yml | dmg | `macos-latest` | yes | contents write; secrets MAC_DEVELOPER_ID_P12, MAC_DEVELOPER_ID_P12_PASSWORD, MAC_NOTARY_KEY_P8, MAC_NOTARY_KEY_ID, MAC_NOTARY_ISSUER | none |
| omp-question-compat.yml | native-questions | `ubuntu-24.04` | yes | - | setup-ci restore |
| ovis-tui.yml | check | `ubuntu-24.04` | yes | - | none |
| pages.yml | validate | calls `ci.yml` with hosted_only: true | (its jobs) | - | (its jobs) |
| pages.yml | build | `ubuntu-24.04` | yes | - | none |
| pages.yml | current | `ubuntu-24.04` | yes | - | none |
| pages.yml | deploy | `ubuntu-24.04` | yes | pages, id-token write; environment github-pages | none |
| pr-title.yml | title | LIGHT | no: self-hosted unless a fork PR | - | none |
| pty-sidecar-attach.yml | gate | `ubuntu-24.04` | yes | - | none |
| pty-sidecar-attach.yml | build | calls `pty-sidecar.yml` | (its jobs) | id-token, attestations write | (its jobs) |
| pty-sidecar-attach.yml | attach | `ubuntu-24.04` | yes | contents write | none |
| pty-sidecar.yml | build | MACPR over matrix: ubuntu-24.04, ubuntu-24.04-arm, macos-15 | yes unless a same-repository pull request while CI_MAC_LABELS is set | - | none |
| pty-sidecar.yml | manifest | `ubuntu-24.04` | yes | - | none |
| pty-sidecar.yml | attest | `ubuntu-24.04` | yes | id-token, attestations write | none |
| relay-deploy.yml | validate | calls `ci.yml` | (its jobs) | - | (its jobs) |
| relay-deploy.yml | deploy | `ubuntu-24.04` | yes | environment production; secrets: a deploy token and an account id for the host it deploys to | none |
| release-validate.yml | reuse | `ubuntu-24.04` | yes | - | none |
| release-validate.yml | fast | `ubuntu-24.04` | yes | - | none |
| release-validate.yml | ci | calls `ci.yml` with hosted_only: true | (its jobs) | - | (its jobs) |
| release-validate.yml | verdict | `ubuntu-24.04` | yes | - | none |
| release.yml | preflight | `ubuntu-24.04` | yes | - | none |
| release.yml | validate | calls `release-validate.yml` | (its jobs) | - | (its jobs) |
| release.yml | pty-sidecar | calls `pty-sidecar.yml` | (its jobs) | id-token, attestations write | (its jobs) |
| release.yml | server-binary | `ubuntu-24.04` | yes | - | none |
| release.yml | server-binary-sign | `ubuntu-24.04` | yes | environment release-signing; secrets OVIS_SERVER_SIGNING_KEY | none |
| release.yml | server-binary-attest | `ubuntu-24.04` | yes | id-token, attestations write | none |
| release.yml | publish | `ubuntu-24.04` | yes | contents write | none |
| release.yml | shell-build | `ubuntu-24.04` | yes | - | none |
| release.yml | shell-deploy | `ubuntu-24.04` | yes | environment production; secrets: a deploy token and an account id for the host it deploys to | none |
| release.yml | shell-attach | `ubuntu-24.04` | yes | contents write | none |
| release.yml | windows-app | calls `windows-app.yml` | (its jobs) | contents write | (its jobs) |
| release.yml | desktop | calls `desktop.yml` | (its jobs) | contents write; passes 7 secrets | (its jobs) |
| release.yml | mac-dmg | calls `mac-dmg.yml` | (its jobs) | contents write; passes secrets: inherit | (its jobs) |
| remote-bundles-platforms.yml | bundle | MACPR over matrix: ubuntu-24.04-arm, macos-15, macos-15-intel | yes unless a same-repository pull request while CI_MAC_LABELS is set | - | none |
| remote-bundles.yml | bundle | MACPR over matrix: ubuntu-24.04, ubuntu-24.04-arm, macos-15, macos-15-intel | yes: it no longer runs for a pull request | - | none |
| remote-bundles.yml | bundle-linux | `ubuntu-24.04` | yes | - | none |
| remote-bundles.yml | bundle-windows | `ubuntu-24.04` | yes | - | none |
| remote-bundles.yml | smoke-windows | `windows-latest` | yes | - | none |
| remote-bundles.yml | ssh | `ubuntu-24.04` | yes | - | none |
| remote-bundles.yml | release | `ubuntu-24.04` | yes | contents write | none |
| shell-preview.yml | shell-build | `ubuntu-24.04` | yes | - | none |
| shell-preview.yml | shell-deploy | `ubuntu-24.04` | yes | environment production; secrets: a deploy token and an account id for the host it deploys to | none |
| windows-app.yml | gate | `ubuntu-24.04` | yes | - | none |
| windows-app.yml | build | `windows-latest` | yes | - | none |
| windows-app.yml | attach | `ubuntu-24.04` | yes | contents write | none |
| windows-install.yml | install | `windows-latest` | yes | - | none |
| windows-terminal-qa.yml | qa | `windows-latest` | yes | - | setup-ci save; actions/cache (Cache Playwright browser) |

### Mac runner

`<runner-name>` (labels `self-hosted, macOS, ARM64, self-hosted-ovis-mac`) is a plain GitHub
Actions runner on the maintainer's test MacBook Air (`ssh eamac`), not this directory's Docker
launcher: a runner directory (`<runner>` below) run by a LaunchAgent of that Mac's user (`<label>`,
from the runner's `./svc.sh install`). A fork can name it in `runs-on` as it can name the Linux
runners, so it runs the same `job-started.sh`, with the same refusals: macOS has no `/proc`, so
there the hook proves its parent the job's `Runner.Worker` with `/bin/ps` (its parent now, the path
it was started from, its user and its start time; right before the kill, the start time and its
parent again, not the path or the user) and writes the
refusal to the system log (`logger -t ovis-runner-guard`) instead of a container's output. The
runner starts it with the macOS `/bin/bash` 3.2 and its `jq` (`/usr/bin/jq`); CI's Native macOS
session identity job runs the test of a job it allows there: on macOS's own bash and jq, only the
allow path runs in CI. The `ps` path's refusal and kill run in the Linux container of the check
"Hook kill tests (container)" (Security model), through Linux's procps `ps`. It lets a job through only when its event names no other head repository: a `push`,
`workflow_dispatch`, `schedule`, `repository_dispatch`, `merge_group` or comment event runs code
from this repository (a fork's push runs in the fork), and a `pull_request`,
`pull_request_review` or `pull_request_review_comment` event only when its payload names this
repository as its head. It refuses `pull_request_target` from a fork too, though that event runs
the base branch's workflow, since such a workflow may check out the fork's head; and a
`workflow_run` whose triggering run came from a fork, as it may use that run's artifacts. Each of
these is refused when its payload names no head repository, and a job with no event name always.

- The Mac runs two runners side by side (two remote bundle jobs together took 53 s each against 49 s
  alone, with no thermal limit over five minutes), each in its own directory with its own LaunchAgent,
  `.env` and hook. Their `.path` puts a `cargo` and `rustup` with the `aarch64-apple-darwin` and
  `x86_64-apple-darwin` targets first, for `remote-bundles.yml` and `pty-sidecar.yml`.
- Install: copy the file to `<runner>/hooks/job-started.sh` (mode 755) and set
  `ACTIONS_RUNNER_HOOK_JOB_STARTED=<runner>/hooks/job-started.sh` (an absolute path) in the
  runner's `.env`. The runner reads `.env` at its start (restart the LaunchAgent after changing
  it: `launchctl kickstart -k gui/$(id -u)/<label>`, while no job runs) and the hook file at
  every job.
- Check: the `.env` line, the file's `shasum -a 256` against this one, and a same-repository
  job's "Set up runner" step, which shows `Runner guard: <event> from devswha/ovis`. Do not run
  the hook by hand to see a refusal: refusals are tested in isolation (Security model).
- A blocked refusal on the Mac (its system log says the parent was not proven) holds its job in
  that step. Cancel the job and do nothing else: the runner ends the worker at least 45 seconds
  after the cancel, and the hook then ends by itself. Do not end the hook: while the worker lives,
  its end would fail its step and run the job's `always()` and `failure()` steps.
- Undo: restore the `.env` and hook file kept before the install, then restart the LaunchAgent.

Fork runs still wait for a maintainer's approval (above); the hook is the second lock, the one a
fork's own workflow cannot change.

### Windows runner (winvm)

`ovis-winvm` (labels `self-hosted, self-hosted-ovis-win` only: `--no-default-labels`, so no job
that asks for any Windows runner lands there) runs CI's Native Windows install in winvm, the
Windows 11 VM on the maintainer's PC (`ssh winvm`, the `winvm` command and its lease: the repo's
AGENTS.md). `winvm-runner.sh` runs on the PC as the user unit `ovis-winvm-runner` and runs one job
per round, one copy at a time (a lock file beside its cache; `--once` refuses to start while the
unit runs):

1. It takes the winvm lease (`ci-winvm-runner`) and keeps it while it runs. A lane holding the VM
   keeps the runner off; a lane that wants the VM stops the unit, which frees it (step 5).
2. It fences the VM: `winvm-fence.ps1`, sent over ssh, stops each other repository's runner
   service kept in the snapshot as soon as it is not in a job, and answers `FENCE <services left>
   <workers>`. Sent with `-IncludeOwn`, it also ends this runner's idle listener and counts this
   runner's own job, which can outlive the ssh that watched it. Only on `FENCE 0 0` from a
   successful ssh, when no runner can take a job or is in one, does it `winvm reset` and
   `winvm start` (about 2 minutes, which starts those services again): every job starts from the
   snapshot. A VM that does not answer, or a job still running after an hour, is never reset: the
   round gives up and tries again later. A fence that stopped a service has changed the VM, so from
   then on the stop resets it or keeps the lease (step 5). Right after the reset it fences again,
   so those services stay stopped for the whole round: none takes a job between an offer and this
   runner's job, which the hook would then wait for (the lease already keeps the VM this round's).
3. It copies the newest `actions/runner` package (cached on the PC), `winvm-runner.ps1`,
   `winvm-job-started.ps1` and `winvm-fence.ps1` into `C:\ProgramData\winvm\ovis-runner`, hands a registration token
   over ssh's stdin to a file the VM script reads and deletes (it reaches `config.cmd` in
   `ACTIONS_RUNNER_INPUT_TOKEN`, which the runner reads and clears, never in a command line), and
   starts `winvm-runner.ps1` in
   the VM's desktop session through `Invoke-InSession.ps1`, as Windows checks that depend on an
   interactive session need. It registers an ephemeral runner (`--ephemeral --disableupdate`)
   and runs it until its one job ends.
4. While that runner listens and no other runner in the VM is in a job, the launcher writes the
   Unix time into the repository variable `CI_WINVM_READY` every minute; a job's start writes 0. `scripts/ci-runner-route.sh` sends
   the job of a same-repository pull request or a push there only while that mark is under three
   minutes old and no job of winvm's label is queued or running (the Actions jobs API, which the
   route reads for the Linux jobs too), and `windows-latest` otherwise, so the check runs, under
   its name, on every code pull request whether winvm is up, busy or leased. Two routes that read
   the API before the first one's Windows job exists can both pick winvm; the second job gets
   the next round, also when the launcher stops (step 5).
5. An idle runner is recycled after 100 minutes (`Invoke-InSession` ends its task after two
   hours); a session that does not listen within 10 minutes is ended and its round fails. A stop
   waits for a job in progress. For an idle runner it clears the mark, waits for a job a route sent
   before, then deletes the registration, which GitHub refuses while the runner is in a job, and
   ends the VM's listener. Before it ends, the launcher waits until 8.5 minutes have passed since
   winvm was last offered (a route takes a mark up to three minutes old, and Detect changes, which
   routes, ends within five), so every route that read that offer has queued its job, then reads
   the queue (three tries). A job queued for the label, or a queue it cannot read, gets another round,
   three at most; after that it exits nonzero and says to cancel and re-run that run. Then, if a
   round touched the VM, it fences, resets and starts it, and releases the lease. Ownership is the
   run's own record, not a read of `winvm status`. When the VM cannot be fenced within 10 minutes,
   the reset fails or the release fails, it keeps what it holds and exits nonzero (`winvm status`
   shows `ci-winvm-runner`): `winvm reset && winvm start && winvm release` once no job runs there.
   It also exits nonzero when it cannot read whether its runner is still registered, and `--once`
   when its round failed (a session that ended with an error, not by the drain).

`winvm-job-started.ps1` is the runner's `ACTIONS_RUNNER_HOOK_JOB_STARTED`: the Windows
counterpart of `job-started.sh`, with the same verdict on the event payload (a fork's code is
refused). Any error before the verdict refuses too. A refusal ends the job's `Runner.Worker`, the
nearest ancestor of that name that started before the hook; while none is found or the kill
fails, the hook kills nothing and blocks, trying again every 5 seconds, so no further step of
the job runs. A job it allows then runs `winvm-fence.ps1` until it answers `FENCE 0 0`: every
other runner service is stopped, one in a job as soon as that job ends, so none takes a job
beside ours (the next reset starts them again; the launcher already stopped them after its reset,
so this only matters when one was started by hand). After three minutes without that the job fails
and says to re-run all jobs of the run, whose new route takes `windows-latest`. The fence reads
the workers again right before each service's stop, so a service that took a job while another
stopped keeps it; one that takes a job in the milliseconds between that read and its stop is
stopped with that job.

Install on the PC (`winvm` on PATH, `gh` logged in as a repository admin):

```ini
# ~/.config/systemd/user/ovis-winvm-runner.service
[Unit]
Description=winvm's ephemeral runner for Native Windows install (devswha/ovis)
[Service]
ExecStart=%h/workspace/ovis/scripts/self-hosted-runner/winvm-runner.sh
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# the launcher alone gets the stop: it drains the runner, then resets and releases the VM
KillMode=mixed
# the drain (8.5 min), a job (10), three more rounds (about 17 each), the fence (10) and a reset (2)
TimeoutStopSec=90min
Restart=on-failure
[Install]
WantedBy=default.target
```

`systemctl --user enable --now ovis-winvm-runner`; `journalctl --user -u ovis-winvm-runner`
shows each round. `winvm-runner.sh --once` runs one round in a terminal. Undo: stop and disable
the unit and delete `CI_WINVM_READY` (`gh variable delete CI_WINVM_READY`); the job then always
takes `windows-latest`.
