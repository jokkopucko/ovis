# Self-hosted CI runner

An ephemeral Docker GitHub Actions runner for this repository's Linux CI/CD jobs. Each container registers, runs exactly one job and exits; the launcher then starts a fresh one. The image includes Bun, Node 22, checksum-pinned herdr, Playwright Chromium and its system libraries, ffmpeg, git, `gh`, curl, jq, unzip and xz-utils, with no sudo. Jobs detect it with `RUNNER_ENVIRONMENT=self-hosted`.

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
limit. The container still has a pids limit of 8192, and `--ulimit core=0`: a crash never leaves a
core file in the checkout, where `scripts/check.ts` would count it as a source change.

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
listens on, with more ports for admission and for the queue of waiting runs
([Checks](../../docs/development.md#checks)). The runner containers of a PC used to share one
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
leaves them, and the next one uses them; one started with a lower `--count` leaves those of the
slots above it, for `docker network rm`.) Docker takes each network's addresses from its address
pools (the P620 made twenty networks beside its own); a slot whose network cannot be made starts
no runner, says so in the journal and tries again. The slots themselves are lock
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
The image's `BUN_VERSION` must match the default in `.github/actions/setup-ci/action.yml`, and
`PLAYWRIGHT_VERSION` must match the lockfile.

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
(default 2048, about 50 builds) bounds it, least recently used first. Measured (four builds of one
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
default label. A same-repository pull request goes there only while at most
`CI_SELF_HOSTED_CAPACITY` (default 10) minus its four Linux jobs are queued or running on that label,
and GitHub-hosted otherwise. Set the capacity to the number of `self-hosted-ovis` runners you keep
online. The repository variable overrides the choice:

```sh
gh variable set CI_SELF_HOSTED_LABELS --body '"ubuntu-24.04"'   # PC offline: everything GitHub-hosted
gh variable set CI_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis"]'   # every pull request, pages.yml and release.yml too
gh variable delete CI_SELF_HOSTED_LABELS   # back to the default
gh variable set CI_SELF_HOSTED_CAPACITY --body 10   # self-hosted-ovis runners online
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
`~/.local/share/ovis-ci-runner`): four slots let one CI run's four Linux jobs start together, and
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

Memory, not CPU, bounds it. Measured there with three runners and `ci.yml`'s values, the CPU stayed
over 90% idle while Browser regression (other scripts) held 2-4 GiB with one script's spike to
9.3 GiB, Browser regression (ui-regression) 2.6-4.5 GiB and Integration tests 1.6-2.7 GiB; the
host peaked at 14.6 of 30 GiB; Fast checks peaked at 0.6 GiB. Those jobs (all but Fast checks)
run at most `CHECK_HOST_MAX_RUNS` at once, however many runners wait for a slot, so the other
runners hold only Fast checks and the setup steps before a slot. More browser workers raise that
spike: with ten, Browser regression (other scripts) reached 14 GiB for about 20 s (its 90th
percentile stayed near 5.4 GiB) while the host peaked at 20.4 GiB, so the P620 ran eight. With
four slot jobs and twelve runners busy, the host stayed under 17.2 GiB; a fifth slot job at about
4 GiB puts it near 21 GiB, about 9 GiB below the total, which holds one browser spike at eight
workers (about 5-7 GiB above that job's usual 2-4 GiB) but not two at once.

A manual run can override the variable with the `self_hosted_labels` workflow_dispatch input. Fork PRs always use `ubuntu-24.04`; Windows/macOS jobs, `remote-bundles.yml` and `windows-install.yml` stay GitHub-hosted.

## Security model

This is a public repository. A fork PR's run uses the fork's workflow files and `scripts/ci-runner-route.sh`, so it can choose `runs-on` itself. The runner therefore enforces the boundary: `job-started.sh` runs before every job (`ACTIONS_RUNNER_HOOK_JOB_STARTED`, set in the image, outside the workflow's control) and refuses any job whose event names another head repository (a fork pull request, a deleted head repository, a `workflow_run` of a fork). It fails closed: any exit before it explicitly allows the job, an error of its own included (a missing or unreadable event file, broken JSON, an unset variable), refuses it, and the refusal kills the worker before it logs anything, with SIGPIPE and termination signals ignored, so a closed output cannot stop it halfway. A failing hook alone is not enough: runner v2.338 marks only its "Set up runner" step failed and still runs the job's `if: always()` and `if: failure()` steps. So the hook SIGKILLs the job's `Runner.Worker` before it returns; the job then ends as failed within seconds with no step run and an empty log, and the refusal is written to the container's output (`journalctl --user -u ovis-ci-runner`). Both were checked on a live runner with a refused job: the old exit-only hook ran the `always()` and `failure()` steps, the killing hook ran none. Fork PR runs also need maintainer approval (repository setting: all outside collaborators); never approve one that changes `runs-on`. Containers are ephemeral (`--ephemeral`, `--rm`), unprivileged (`--cap-drop ALL`, `no-new-privileges`, no `--privileged`), have no host mounts but the read-only host caches and no Docker socket, and the image has no sudo. The registration token reaches the container on stdin, never through its environment, so a job cannot read it from `/proc/1/environ`.

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
