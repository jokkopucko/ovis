# Development

Setup, the checks and what a change needs are in [CONTRIBUTING.md](../CONTRIBUTING.md). This file holds
what no code or test in the repository shows: how a release is cut, the settings made once outside
the repository (the signing key, the hosted shell's deploy, the growth snapshot's secrets), and the
rules for changing a stored format.

## Releasing

On the maintainer's PC, where every merge goes through `pr-merge`, a release freezes the other
merges once its PR is open: `pr-merge --freeze "X.Y.Z release" <release PR>`. Only the release PR
merges until the Release run succeeds, which ends the freeze by itself (`pr-merge --unfreeze` when
the release is put off).

1. Open a release PR that bumps `version` in `package.json` and `herdr-plugin.toml`,
   runs `bun scripts/changelog-fold.ts X.Y.Z [YYYY-MM-DD]` (it moves the `Unreleased` notes in
   [CHANGELOG.md](../CHANGELOG.md) and the [changelog.d/](../changelog.d/README.md) fragments under
   the new version, dated today in local time by default, links each fragment's PR and deletes the
   fragments; then add the `by @login` credits; a fragment merged later must be moved into the
   version by hand, since the release workflow refuses while one is left), and tells the release
   in [release-summaries.json](../release-summaries.json) the way a game's patch notes do: under
   the version, for each language in `SUMMARY_LANGUAGES` (`shared/update.ts`: `en`, `ko`, `ja` and `zh`), the lists `new`, `improved` and `fixed` (a list with nothing to say is left out), the same number of
   lines in every language. From 0.5.0 the notes are short: at most five lines in a list, each one
   plain sentence of at most 70 characters in English (about as short in the other languages),
   naming the change most people will notice first. A change that does not make the cut stays in
   the changelog section, so no line joins two changes to fit it in. It is what an install shows
   before and after the update, with the changelog section folded under it, so a line names what
   changes for the people who use the app and leaves out PR numbers and internals. The unit suite and the release workflow fail without every language.
   The GitHub release is written from the same files by `scripts/release-notes.ts`: the
   English lists under New features, Improvements and Bug fixes, then the version's whole
   changelog section folded under **Full changelog**.
   When the release guards (below) say so, the same PR raises `REMOTE_BUNDLE_VERSION` in
   `shared/machines.ts`, and after deploying the telemetry Worker
   ([telemetry/README.md](../telemetry/README.md#deploy)) commits `telemetry/deployed.json` written by
   `bun scripts/release-guards.ts --worker-deployed`.
   A release that changes the HTTP or WebSocket contract in `server/` or `shared/` runs the oldest client the
   phone apps carry against it first ([The phone app's client](#the-phone-apps-client)).
2. Merge it after CI passes.
3. If it raised `REMOTE_BUNDLE_VERSION` to N, push the tag `remote-vN` on the merged commit and wait
   for the **Remote PC bundles** workflow to publish it ([remote PCs](remote-pcs.md)); the Release
   run refuses until its manifest and archives can be downloaded, not only tagged. Merge nothing
   that touches `server/`, `shared/`, `bun.lock` or `patches/` until the Release run is done: the
   Release run would then ask for a follow-up PR that raises the number again and a new tag.
4. Run **Actions → Release → Run workflow**, select `main`, and enter `X.Y.Z` without `v`.
   The CLI equivalent is `gh workflow run release.yml --ref main -f version=X.Y.Z`.
   Tick **revalidate** (`-f revalidate=true`) to run the whole CI in the Release run even when
   main's own CI run already passed the commit. Run it once main's CI run of the release commit is
   green and validation takes about four minutes (Fast checks alone); run earlier, it waits for that
   run first.

The workflow validates metadata, then requires the same unit, integration and browser checks
as PRs to have passed on the exact `main` commit selected when the run starts. Only after that
does it create the tag and GitHub release. A failed validation creates neither.

The push to `main` already ran those checks on that commit, so the Release run does not run all of
them a second time when main's run is green (`.github/workflows/release-validate.yml`). Its first
job asks `scripts/release-ci-reuse.ts`, which says yes only when all of this holds:

- there is exactly one push run of `ci.yml` on `main` for that commit, in this repository (a pull
  request's run, a manual run and a fork's run never count);
- it completed with success, on its first attempt or after one rerun;
- every job of `ci.yml` is in it and passed: a failed, cancelled, skipped or missing job is a no,
  whatever ci.yml's three required checks say.

A run still going is waited for, at most 40 minutes (main's run takes 15 to 30) and only while
none of its jobs has ended without passing. Anything else is a no at once: no run for the commit,
a run that waits behind another run of `main`, a third attempt. An answer from GitHub that cannot
be read is asked for twice more, five seconds apart, and is a no after the third. On a no the
Release run runs the whole CI itself, as it did before, and with **revalidate** it always does.

A release that takes main's run still runs Fast checks itself, always on GitHub's runner (**Fast
checks (GitHub-hosted)**, the steps of `ci.yml`'s Fast checks). Main's run ran them on the
self-hosted PC, where some unit tests skip themselves: the runner's container has no `pwsh`, no
`setfacl` and no process of another user. Run again on GitHub's runner, those tests gate every
release, and so does any other test that container comes to skip. The job starts with the question
about main's run, not after its answer, so its minutes do not come on top of a wait. When the
answer is no, `ci.yml` runs Fast checks of its own and this job's outcome is not read: it may fail
without failing the run.

The **Verdict** job then names what validated the commit: `ci` when the whole CI passed in the
Release run, or `main-run-<id>` when main's run was verified and Fast checks passed in the Release
run. The publish job refuses to tag without that name: a job that was skipped, failed or cancelled
can stop a release but never pass one. The run's summary says which it was and why.

A release validated by main's run (`main-run-<id>`) is made of these checks of its commit:

| Check | Ran in | On |
| --- | --- | --- |
| Version, notes, unused tag, release guards for the whole tree (preflight) | the Release run | GitHub's runner, or the self-hosted PC when `CI_SELF_HOSTED_LABELS` holds labels |
| Fast checks | the Release run, and main's run | GitHub's runner, and the self-hosted PC |
| Rust PTY host build, with the crate's tests and the PtySession checks on the built Linux binaries | the Release run | GitHub's runners |
| Integration tests, both Browser regression jobs | main's run | the self-hosted PC, unless the runner variables keep `main` on GitHub's ([self-hosted runner](../scripts/self-hosted-runner/README.md)) |
| herdr-core live contract | main's run | GitHub's runner, unless `CI_HC_LIVE_LABELS` moves it to the self-hosted PC |
| Native Windows install, Native macOS session identity | main's run | GitHub's runners |
| Rust PTY host | main's run | GitHub's runners, or the self-hosted Rust slots once `CI_RUST_SELF_HOSTED` is `true` |

Main's Integration tests and Browser regression jobs did not each build the client they tested:
on the self-hosted PC they restore `dist/` from the runners' build cache, from the entry of that
commit, which the first job of the same run to build it wrote (Fast checks, as a rule). The cache
keeps a build under the run whose job handed it in, and a job reads only its own run's entries, so
the `dist/` they tested was built by main's run, never by another run (a pull request's, say). An
entry is named after the commit and everything else the build reads, and a restore checks every
file's SHA-256
(`scripts/build-cache.ts`, [the runner's README](../scripts/self-hosted-runner/README.md#build-cache)).
A release validated in its own run (`ci`) never reads that cache: every job of it builds.

Nothing is tagged unless the Verdict job passed. When a Release run stops there, or ends without
having created the tag for any other reason, run Release again with **revalidate**: that run
validates the commit by itself and takes nothing from main's run.

**Actions → Release validation → Run workflow** from `main` (`gh workflow run
release-validate.yml --ref main`) is a dry run of that decision for main's newest commit. It
tags and publishes nothing. Run it once main's CI run of that commit is green to see a release
take it and run Fast checks on GitHub's runner; when the answer is no, or with
`-f revalidate=true`, it runs the whole CI as a release would.

Beside the checks it builds the Rust PTY host (**Rust PTY host binaries**, `.github/workflows/pty-sidecar.yml`):
static Linux x64 and arm64 binaries, a universal macOS one, `ovis-pty-sidecar.json` (the version,
the `crates/pty-sidecar` git tree they were built from, and each file's SHA-256) and `SHA256SUMS`,
all attached when the release is created, so no tag is seen without them. `bun
scripts/pty-sidecar.ts install` (herdr's plugin build, each update installed from the app, and
`install.sh`) puts the binary for its PC in `bin/ovis-pty-sidecar` only when the release's crate
tree matches the checkout and the SHA-256 matches (a checkout whose crate tree no release has takes the
daily beta's `pty-sidecar-<tree>` prerelease); otherwise that install mirrors its panes and says how to
build one.
A release without them gets them from **Actions → Attach the Rust PTY host** with its tag.

It also builds the server as one compiled binary per platform (`server-binary`, on the same runners as the
rest of the release, `bun scripts/build-server.ts release`): `ovis-server-linux-x64`, `-linux-arm64`,
`-darwin-arm64`, `-darwin-x64` and `-windows-x64.exe`, and the built client the installers unpack beside the binary,
`ovis-dist.tar.gz` (from `bun run build`), with `ovis-server.json` (the version, the git trees of `server/` and
`shared/`, each file's SHA-256 and size, and those of the Rust PTY hosts). The server manifest stays at schema 1,
with exactly `schema`, `version`, `sources`, `assets`, `dist`, `pty`; the keeper changes neither its bytes nor its
sums. The release also carries `ovis-server.SHA256SUMS` and `ovis-server.json.sig`, an Ed25519
signature over the manifest's exact bytes. `server-binary-sign` signs on GitHub's runner: beside the key run only Bun,
installed by the SHA-pinned `oven-sh/setup-bun`, and `scripts/server-manifest.ts`, which uses Node's built-ins; none
of the repository's dependencies is installed there. `sign` refuses a key whose public half is not `RELEASE_PUBLIC_KEY`,
committed in `scripts/server-manifest.ts`; the job then verifies the folder for the version being released against
that committed key. `server-binary-attest` attests the files, and `publish` verifies them again for that version
against the committed key, never one a job reports, and attaches each by name, refusing a folder that holds anything
else; the PTY hosts it attaches must be byte for byte the ones the manifest signed. A different key put into the secret fails the release at `sign`. The signature vouches for whatever `server-binary` built.

The same step and key separately sign `ovis-acp-keeper-server.json` as `ovis-acp-keeper-server.json.sig`.
It contains `schema: 1`, `version`, `serverSha256` (of the exact signed `ovis-server.json`), and `assets`.
Each of `linux-x64`, `linux-arm64` and `darwin-universal` names its `file`, `sha256` and byte `size`.
Publish regenerates this document from the binaries it will attach and compares the bytes before creating
the release. Older installers never read the companion. New ones skip only the keeper if the companion,
signature or binary is missing, damaged or for another server; a bad main manifest still fails the install.

`bun scripts/build-server.ts verify <dir> --expect-version <X.Y.Z>` checks a downloaded set against the committed key
(`--public-key <base64>` names another, for a test's own release), and stops at the first part that fails, with one
line naming it (exit 1):
- the folder holds exactly the five binaries, the client archive, the manifest, its signature and the sums file;
- the signature over the manifest's bytes (both the signature and the key in standard base64, nothing around them);
- the manifest in its canonical form: exactly its fields, the five platforms and the client archive, no duplicate key;
- the version, when `--expect-version` is given;
- each file's SHA-256 and size (a mismatch names its platform, or the client), and the sums file, which is required and
  must list exactly the manifest's sums. The sums file adds no trust of its own: it is checked against the signed manifest.

A signature alone does not stop a downgrade: an older release signed by the same key verifies too. Every consumer (the
installers, the updater, a fleet machine: todos 6, 7, 28 and 59 of the relay-fleet plan) passes the version it asked
for, as the release job does. The installers do it now: `install.sh` and `install.ps1` pin the committed key on one
line each (`RELEASE_PUBLIC_KEY=` and `$releasePublicKey =`, held equal to `scripts/server-manifest.ts` by its test),
and `scripts/plugin-launch.ts` takes it from that file. Each checks the manifest's signature first, then its schema
(`"schema": 1`, the first field, so a reader can tell a later shape from this one) and version, then each file's
size and SHA-256, and only then moves the release into place, in one rename (two on Windows, where a run cut off
between them is put back by the next), holding an install lock (`.install.lock`, made by an atomic mkdir with the
holder's pid; a waiter breaks it once the holder's pid no longer runs, one breaker at a time, so two installs at once
take turns; `install.sh` releases it in one rename, while `install.ps1` and the plugin's installer still remove it in
place, where three or more installs started at the same instant leave a narrow race, a follow-up). When to build
from source instead is [one rule](../INSTALL.md#binary-or-source). Their tests run a copy whose key line names a key made for
the test, or pass that key as `installServer`'s option, which the launcher never does: the shipped scripts read no
key from anywhere else. `OVIS_RELEASES_URL` (https://, or a `file://` folder laid out as GitHub's
`<url>/v<version>/<file>`) points them at another place, checked against the same key. Remote PC bundles and the desktop app carry the same binary with what runs beside it
(`scripts/server-artifact.ts`), and no server sources. The builds are reproducible with the same Bun: CI pins Bun 1.4.4,
so CI's hashes differ from ones built with another Bun.

### The server binary's signing key

The private key is the secret `OVIS_SERVER_SIGNING_KEY` of the GitHub environment `release-signing`, whose
deployment branches are `main` alone. Only a workflow run for `main` whose job names that environment can read
it, and only `server-binary-sign` does: it is not a repository secret, and `production` (the deploy jobs'
environment) never holds it. Without the environment or its secret, `server-binary-sign` fails with an error naming
the secret, and `publish`, which needs it, does not run: no tag and no release are made, and nothing is published
unsigned. In a fork the job is skipped, and so is `publish`.

The committed key (`RELEASE_PUBLIC_KEY`, `C8+dOD0g…`) is the public half of the key the owner already made: the
secret holds its private half, and nothing below runs again for it. Only a new key pair (a lost or replaced key) runs
these steps, on a Linux or macOS PC the owner trusts (`keygen` refuses to run on Windows, where a file mode does not
keep the key to its owner), and then also commits the printed public key in `scripts/server-manifest.ts`
(`RELEASE_PUBLIC_KEY`), `install.sh` (`RELEASE_PUBLIC_KEY=`) and `install.ps1` (`$releasePublicKey =`), before a
release: `sign` refuses any other key, and installs that took the old key need a release under it to move on:
1. `bun scripts/build-server.ts keygen <folder>` writes `<folder>/ovis-server-signing-key.pem` (readable by them
   alone) and prints only the public key.
2. Create the environment `release-signing` with deployment branches limited to `main` (Settings → Environments →
   New environment; Deployment branches and tags: Selected branches and tags, add `main`).
3. `gh secret set OVIS_SERVER_SIGNING_KEY --env release-signing --repo devswha/ovis < <folder>/ovis-server-signing-key.pem`
   (the key is read from the file, never typed on a command line).
4. Keep an offline copy, delete the file, and keep the public key: installs and updates check against it. It is
   `RELEASE_PUBLIC_KEY` in `scripts/server-manifest.ts` and the key line of `install.sh` and `install.ps1`. Once a
   release pins it in the binary, replacing the key strands the installs that took it, so losing the private key means
   no further verified update reaches them.

Then the Release run attaches the signed Ovis for Mac `Ovis.dmg` to the release, or skips that with a notice while the
signing secrets are unset ([app/mac/README.md](../app/mac/README.md#releases)), and Ovis for Windows'
`Ovis.exe` ([app/windows/README.md](../app/windows/README.md#releases)); the release becomes GitHub's
latest only once it has both. A red `mac-dmg` or `windows-app` job leaves the release published: run
**Actions → Mac app** or **Actions → Windows app** for its tag instead of releasing again.

The **Desktop app** job (`.github/workflows/desktop.yml`) builds the desktop app
([app/electron](../app/electron/README.md)) from the tag, each on its own OS and CPU, under names
without the version, so `releases/latest/download/<name>` always gives the newest:
`Ovis-linux-x64.deb`, `Ovis-linux-arm64.deb` (the download for Ubuntu and Debian),
`Ovis-linux-x64.AppImage`, `Ovis-linux-arm64.AppImage`, `Ovis-mac-arm64.dmg`, `Ovis-mac-x64.dmg`, and
`Ovis-mac-arm64.zip`, `Ovis-mac-x64.zip` (what a Mac app updates from), and `Ovis-win-x64.exe` (a
per-user NSIS installer; signed only once the repository variable `DESKTOP_WIN_SIGN` is `true`, with
the `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` secrets), with their `.blockmap` files.
The AppImage carries the static AppImage runtime (electron-builder's `toolsets.appimage`), so it
needs no libfuse2, only the fuse3 a desktop has; without FUSE at all it runs with
`APPIMAGE_EXTRACT_AND_RUN=1`. Its version is the tag's: the build
stops unless `package.json` says the same. It attaches them with the update feed: `latest-linux.yml`,
`latest-linux-arm64.yml`, `latest.yml` for Windows and one `latest-mac.yml` for both Macs (the two Mac
builds' feeds merged by `bun app/electron/scripts/build.ts merge-feed`). The app is built to update from
`https://github.com/devswha/ovis/releases/latest/download` (electron-updater's generic provider), so
an installed app sees a version once it is GitHub's latest, the same moment `ovis.sh/Ovis.dmg` and
`ovis.sh/Ovis.exe` move (that `Ovis.exe` is still the Windows setup app, `windows-app.yml`). The
AppImage, the Mac app and the Windows app update themselves; a deb is updated by installing the new
one.
The Macs' files are unsigned, and a Mac app updates itself only when signed, until the repository
variable `DESKTOP_MAC_SIGN` is `true`: then the build signs and notarizes with the same
`MAC_*` secrets as Ovis for Mac ([app/electron](../app/electron/README.md)'s signing, with
`OVIS_REQUIRE_NOTARIZATION=1`) and fails if one is missing or the dmg is not notarized. The `mac-dmg` and `windows-app` jobs
wait for `desktop`, so the release becomes latest only with the desktop files in it; a red `desktop`
job leaves the release published but holds them back: **Re-run failed jobs** on the Release run
builds and attaches it again (`--clobber`), then runs them. **Actions → Desktop app** from `main`
with a tag does the same for one release alone, and refuses the latest release, whose feed installed
apps read (fix that one with a new patch release); without a tag it only builds, as it does every
day on `main` and for a pull request that changes `desktop.yml` itself. A pull request that changes the app
runs `desktop-check.yml`: the app's unit tests, its type check and its build on Linux x64 and Windows x64.
The macOS and Linux arm64 builds are not made for it, so one that broke shows in the next daily run, or in
the release's own `desktop` job when a release is cut before that run: after a change to the app's macOS
packaging, run **Actions → Desktop app** from `main` without a tag before releasing. That run shows that
each target builds and that its tests pass there; only a tagged run checks the files by their exact names.
A release build skips the app's unit tests, which its pull requests ran on Linux and Windows.
Do not push release tags by hand: installed updaters read Git tags directly, so a tag is
visible to them even without a GitHub release. Existing tags cannot be reused; fix a
published version with a new patch release. If publishing fails after a tag was created,
verify that tag's commit and repair its GitHub release rather than moving the tag.

The hosted shell is then built and deployed in three jobs, so the Cloudflare token never shares a
job with the build's dependencies. `shell-build` (no environment, no secrets, no Actions cache
restored) checks out the release tag, fails unless the tag points at the commit this
release published, builds the shell (`bun run build:shell`), fails if `dist-shell/` lacks
`index.html` or `build.json`, and uploads `dist-shell.tar.gz` and `dist-shell.tar.gz.sha256`,
passing the tarball's SHA-256 on as a job output. `shell-deploy`, on a GitHub-hosted runner with
read-only repository access, checks nothing out and runs no repository code: it sets up Bun, checks
the downloaded tarball against that SHA-256, refuses it if it holds a link, a special file, a path
outside it, a `_worker.js`, a `functions/` or a `_routes.json` (Pages would run or route those as
server code next to the token), unpacks it, installs wrangler from this commit's
`.github/deploy-tools/package.json` and `bun.lock` with `bun install --frozen-lockfile
--ignore-scripts`, runs that binary as `wrangler pages deploy dist-shell --project-name ovis-app
--branch main --no-bundle` (the token reaches that step alone), and waits until `https://app.ovis.sh/build.json`
answers 2xx with the tag's commit as its `revision`. The `shell-attach` job, the only one that may
write, then attaches the tarball and its SHA-256 to the release, so anyone can compare what app.ovis.sh
serves with what the tag builds; it runs only after a deploy that did not fail. Nothing else deploys
app.ovis.sh: never from a branch or a developer machine. Until the owner setup below is done the
deploy passes with a notice naming the missing secrets, the tarball is still attached, and app.ovis.sh
stays as it was.

To move the deploy to another wrangler, change the version in `.github/deploy-tools/package.json`,
run `bun install` in that directory and commit both files; the deploy jobs refuse a lockfile that
does not match the manifest.

One-time owner setup for the shell deploy:

1. In Cloudflare, create the Pages project `ovis-app` (direct upload, production branch `main`) and
   give it the custom domain `app.ovis.sh`. Keep its production branch `main`: the shell preview
   deploys to the branch `preview` and stays off app.ovis.sh only while `preview` is not the
   production branch.
2. Create an API token that may edit Cloudflare Pages for that account, and add it with the account
   ID as the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` of the GitHub environment
   `production` (not repository secrets).
3. Give the `production` environment the maintainer as a required reviewer: every deploy waits for
   an approval on the Release run.
4. Keep the account on the Workers Paid plan (the relay needs it) and set a billing alert at
   $20 a month.

To try the relay from a phone before a release, without Tailscale, deploy main to the Pages preview:
**Actions → Shell preview → Run workflow** on `main`, approve the `production` environment, then open
<https://preview.ovis-app.pages.dev>. The workflow (`.github/workflows/shell-preview.yml`, run by hand
only) has the same two-job split as the release: `shell-build` builds the shell from main without
secrets and fails if `dist-shell/` lacks `index.html` or `build.json`; `shell-deploy` checks the
tarball's SHA-256, deploys it with the locked wrangler and `--branch preview` (never `main`, so
app.ovis.sh keeps the release's build) and waits until the preview's `build.json` names main's commit.
Run the PC's Ovis from the same main with `OVIS_RELAY_APP_URL=https://preview.ovis-app.pages.dev`, so its QR codes open the preview
instead of app.ovis.sh. It uses the same secrets and approval as the release deploy.

Remote-PC runtime bundles are published by a `remote-vN` tag, and an app release requires the bundle
that matches its server (step 3). See [remote PCs](remote-pcs.md).

`scripts/release-guards.ts` fails a release PR (CI's Fast checks) and the Release run when the bundle's
inputs changed since the published `remote-vN` without a raised `REMOTE_BUNDLE_VERSION`, when the raised
one is not published yet (Release only), when `telemetry/worker.ts` or `shared/telemetry.ts` changed
since the deploy recorded in `telemetry/deployed.json` ([telemetry/README.md](../telemetry/README.md#deploy)),
or when the step 1 metadata is incomplete. In CI only the change that bumps the version is checked;
PRs merged before the Release run pass, and the Release run checks the whole tree again.

## The phone app's client

The store apps carry their own copy of the client ([native-app.md](native-app.md#the-app-carries-its-client)):
an app on a phone runs the client of the build it was installed from until the store updates it, whatever
release its PCs run. Store builds are cut from a release tag's verified shell (the release's
`dist-shell.tar.gz` and its SHA-256), never from a branch.

- **A PC keeps working with every app build that is not below the floor.** The floor is
  `MIN_SUPPORTED_CLIENT_VERSION` in [`server/relay/client-floor.ts`](../server/relay/client-floor.ts), sent as
  `min_supported_client` in the relay `WELCOME` (through the relay and on the direct carrier alike). The app's own
  copy below it shows **Update the app** for that PC, with its store's page; a hosted page reloads onto the
  newer hosted copy as before.
- **The HTTP and WebSocket contract in `server/` and `shared/` changes additively**: a route, field, frame or
  feature may be added; one an app build at or above the floor uses is not removed, renamed or given another
  meaning.
- **The floor rises only to a client an app build carries that has been live on both stores for at least
  14 days.** [`server/relay/store-app-versions.json`](../server/relay/store-app-versions.json) lists the builds
  live on each store: version, build, the day it went live and the release whose client it carries (`null` for a
  build that loads the hosted shell). Add a line when a build goes live and keep the older ones;
  `server/relay/client-floor.test.ts` fails a floor raised beyond what it allows. Raise the floor in a PR of its
  own, with a changelog line.
- **A release that changes the contract runs the oldest supported client against itself**:
  `bun scripts/relay-client-skew-regression.ts [<tag>]` builds the shell of the tag (by default the oldest client a
  store build carries at or above the floor; while none carries one, the latest release) and opens this checkout's
  PC through the relay in a browser: it pairs, attaches a terminal, types and reads the output. It is the reverse of
  `relay-e2e-regression.ts --skew`, which runs this client against an older PC. The browser lane runs it on every
  change that reaches it; a checkout without the tag fetches it from the public repository.

## Growth snapshot

GitHub shows a repository's traffic (views, clones, referring sites, popular pages) for the last 14
days only. `.github/workflows/growth-snapshot.yml` saves it every Monday, with the stars and the day
each was given (never who gave it), through `scripts/growth-snapshot.ts`. Anyone signed in to
GitHub can download the artifacts of a public repository, so the workflow encrypts the snapshot
before it uploads it, and its log shows totals only.

It needs two repository secrets (Settings → Secrets and variables → Actions); without them the run
says so and ends green:

- `GROWTH_METRICS_TOKEN`: a fine-grained personal access token for devswha/ovis only, with
  the repository permissions **Administration: Read-only** (the traffic endpoints need it) and
  **Metadata: Read-only**. Such a token expires within a year: put the expiry date in the token's
  name. An expired or wrong token turns the run red (exit 1 for no access to the repository, exit
  2 when every traffic endpoint is refused, exit 3 when a stargazer page fails), and GitHub emails
  the failure.
- `GROWTH_SNAPSHOT_KEY`: the encryption password, for example from `openssl rand -base64 32`.
  Keep a copy outside GitHub: without it the artifacts cannot be read.

Artifacts are kept 90 days. To read one:

```sh
gh run download <run-id> -R devswha/ovis -n growth-snapshot-<run-id>
GROWTH_SNAPSHOT_KEY=… openssl enc -d -aes-256-cbc -pbkdf2 -pass env:GROWTH_SNAPSHOT_KEY -in growth.tar.gz.enc | tar xzf -
```

which gives `growth/snapshot-<day>.json` and `growth/stars-by-day.csv`. The same script runs
locally from the repository root with your own `gh` sign-in:
`bun scripts/growth-snapshot.ts --out <dir>`. Exit 0 allows individual traffic errors in the JSON;
exit 2 still writes both files when every traffic endpoint fails. Exit 3 writes neither file,
including no traffic-only snapshot, and preserves any previous output unchanged. This takes
precedence over exit 2 if both stars and traffic fail. Exit 1 covers usage, repository access and
output errors. Both files are staged before publication; a CSV write or replacement failure
does not publish new JSON. No failed run reaches encryption or upload in the workflow. Installs and
daily actives by country come from the telemetry database instead:
run `bunx wrangler login` from `telemetry/` once, then
`bun scripts/telemetry-report.ts --out <file.md>` from the repository root
([telemetry/README.md](../telemetry/README.md#reading-the-counts)).

## Stored-format changes

These rules bind the next PR that changes the structure of a store this app owns: a browser record
(an `ovis:` key in `localStorage`, such as `ovis:settings` or `ovis:themes`) or a bridge document in the
state directory (`preferences.json`, `devices.json` and the others beside them). Renaming, moving,
splitting or re-encoding a field, or changing what a stored value means, is structural. So is adding a field to a record an older
writer rewrites whole: an old tab's next unrelated save writes the record back without the field
it does not know, and erases it. Only an addition an older writer cannot erase, such as a value
kept in its own key or document, is not structural and needs none of this.

Most stores carry no schema version today. What follows is what the format-changing PR has to
bring, not a description of what every store already does. The `revision` in `preferences.json`
orders writes; it is not a schema version and says nothing about whether a reader understands
the document. The layout check in [`server/session-history.ts`](../server/session-history.ts)
validates a native agent transcript the bridge only reads; it is not a bridge-store migration and
no precedent for one.

The PR description names the store's owner (the key or file, and the module that writes it), the
old and the new shape, which releases read and which write each shape (and what the oldest reader
still running does with the new one), and the HTTP or WebSocket contract that carries the store,
or that none does. Then the change keeps these rules:

- **Tabs already open keep their old code.** An old tab that saves an unrelated setting after the
  new code wrote must not erase the new shape. Already in place for the theme pair: it lives in
  its own key, and the main record keeps the legacy mirrors an old sanitizer reads (`saveSettings`
  in [`src/lib/settings.ts`](../src/lib/settings.ts), old code pinned in
  [`settings.legacy-fixture.ts`](../src/lib/settings.legacy-fixture.ts)).
- **Migrate passively.** A browser that reads an old shared document derives the new shape into
  its own state and advances its baseline to it. It never sends a corrective PUT that writes its
  interpretation back, and a value it cannot read stays the other browsers'. Already in place for
  the theme sides (`takePreferences` in [`src/lib/preferencesSync.ts`](../src/lib/preferencesSync.ts)).
- **Never write over data too new to read.** A reader that finds a structural version it does not
  know keeps the bytes as they are and refuses to write that store. It does not treat the unknown
  version as absent, and does not sanitize the document to defaults and save them over it.
- **Devices fail closed.** A `devices.json` that is damaged or too new keeps the gate closed and
  the registry unwritable. It is never a first installation or an empty registry, and nothing
  reopens pairing. [`server/devices.ts`](../server/devices.ts) already does this for a damaged
  file (`error`, `gated`, `assertWritable`); a too-new version must take the same path.
- **Rollback restores code, not data.** The update supervisor restores the previous release when
  a candidate bridge fails its startup health check
  ([`server/supervisor.ts`](../server/supervisor.ts), [app updates](app-updates.md#boundaries)).
  Both releases share one state directory, so this does not undo a rewrite the candidate already
  made, and a later manual downgrade meets the new shape too. Make old readers safe before the new
  shape is written: ship the reading side or the too-new refusal in a release before the one that
  writes, or keep writing a shape the previous release reads.

The PR's tests, on `mkdtempSync` state directories or a stand-in `localStorage` and event-driven,
cover: an old-shape fixture loading into the new shape; an old tab's unrelated save after the new
code wrote; old and new readers and writers side by side, each keeping the other's values with no
corrective write; a too-new document read without being written (its bytes unchanged after a
write is refused, and for devices the gate still closed); and a failed activation, where the
previous release serves again and reads, or refuses, what the candidate left on disk.
