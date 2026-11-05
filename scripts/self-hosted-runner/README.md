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

A slot that cannot fetch a registration token retries after 30 s, doubling up to 10 minutes: GitHub
limits these requests per hour, and eight slots retrying every 30 s keep the account over that limit,
which blocks every other API call too. After the repository is renamed, restart the launcher with
`--repo OWNER/NEW-NAME`: the token request follows GitHub's redirect, but runner registration does
not, and every container exits with a 404.

`--once` exits nonzero if registration-token retrieval or any container fails. Its exit status
reports launcher/container execution, not the GitHub Actions job's conclusion.

Runner containers have no CPU or total-memory quota and can use available host resources.
They all join the network namespace of one idle container, `herdr-ci-<host>-net`, which the
launcher starts first and stops last. The runners therefore share a loopback, and with it
`scripts/check.ts`'s slots: the herdr-backed CI lanes of every runner on the PC count against one
`CHECK_MAX_RUNS` and wait for a slot, instead of each runner believing it has the PC to itself.
The namespace is not the host's: a job still cannot reach a service on the host's loopback. The
`--shm-size 2g` Docker setting sizes `/dev/shm` for browser scratch space; it is not a total RAM
limit. The container still has a pids limit of 8192.

## Prepared tools and caches

Self-hosted jobs verify the image's Bun version, requested Node major and herdr checksum instead
of downloading tools. Both browser lanes use the installed project's Playwright revision to find
Chromium under `/opt/playwright-browsers`; a missing browser fails with rebuild guidance, not a
download fallback. Rebuild with `--build` after changing the tool pins or Playwright in `bun.lock`.
The image's `BUN_VERSION` must match the default in `.github/actions/setup-ci/action.yml`, and
`PLAYWRIGHT_VERSION` must match the lockfile.

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
`CI_SELF_HOSTED_LABELS='"ubuntu-24.04"'` still keeps main's jobs GitHub-hosted too. The reserved slots stay in the launcher's network
namespace: they take runners away from pull requests, not load, and main's herdr-backed jobs still
share `check.ts`'s slots (`CHECK_HOST_MAX_RUNS`) with theirs, so they can wait there for one.

On the maintainer PC the launcher runs as the systemd user unit `ovis-ci-runner.service`
(`run.sh --repo devswha/ovis --count 4 --labels self-hosted-ovis` from a copy of this directory in
`~/.local/share/ovis-ci-runner`): four slots let one CI run's four Linux jobs start together, and
`check.ts`'s shared slots cap its herdr-backed lanes at `ci.yml`'s `CHECK_MAX_RUNS`. Copy the directory again and
restart the unit after changing these files.

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

Every runner of a host must read the same file, since they share the slots. Keep it outside this
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

The host caches cannot carry one job's code into another's: runners mount them read-only, and only
the launcher writes them, the mirror from GitHub and the Bun cache from downloads checked against
the default branch's lockfile. A git object is named by its hash, so the mirror cannot change the
commit a job checks out; Bun does not check a cached package again, which is why only that
lockfile, never a job, fills the Bun cache. A job's copy of it is its own.
