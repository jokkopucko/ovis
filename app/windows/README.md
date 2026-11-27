# Ovis for Windows

The one-click setup for a Windows PC, downloaded from https://ovis.sh as `Ovis.exe` (and, once it is
listed, from the Microsoft Store). The phone apps need the Ovis server running on the computer; this
app sets that up without PowerShell or a terminal and shows the QR code the phone app scans. It is the
Windows twin of [Ovis for Mac](../mac/README.md).

It is a small WinForms app on .NET Framework 4.8, which every Windows 10 (1903 and later) and 11 PC
already has, so `Ovis.exe` is one file of about 60 KB with nothing else to install. It has no code of
its own for installing: everything goes through what a terminal user runs, so the two never drift
apart.

| Button | What runs |
| --- | --- |
| **Install** | `irm https://ovis.sh/install.ps1 \| iex` in Windows PowerShell, with `OVIS_NO_OPEN=1` and an empty stdin. Then herdr's server is set to start at sign-in (below) and started. Where herdr was not running, install.ps1 starts it itself and writes the same Run value, `Ovis`, running its own `%LOCALAPPDATA%\ovis\start-herdr.ps1`; the app then sets that value to its own copy, so there is one sign-in start, and finds herdr running. install.ps1 never replaces a value it did not write, the app's included. |
| **Install Git** | Shown instead of Install while Git for Windows is missing (install.ps1 needs it): `winget install --id Git.Git`, which asks for administrator approval, or **Download Git** for https://git-scm.com/download/win. |
| Status (on open) | `herdr plugin list --json` finds the plugin, `scripts/plugin.ts status` gives its address and the version that runs, and `GET /api/access` gives the phone address, drawn as a QR code (with the server's token when it asks for one, read from the plugin's `env`/`.env`; a token it cannot find is named, not taken for a missing Tailscale). |
| **Update** | Shown instead of Start when the server is older than the app, under the old id, or of a version nothing reports. Under the old id: its `plugin.ts stop`, told herdr's state dir for the plugin (`HERDR_PLUGIN_STATE_DIR`, as herdr runs its actions: a release from before 0.4.13 run without it finds no server, even one that outlived herdr), then install.ps1, which stops it the same way and moves it to the new id with its settings and token. Otherwise: the plugin's `stop`, then `herdr plugin install devswha/ovis --ref <tag> --yes`, herdr's reinstall, which keeps the plugin's config and state; the tag is the newest release `git ls-remote` lists, never older than the app, so a server that updated itself past the app is not taken back. Then the server starts and herdr is set to start at sign-in, as for Install. A herdr older than the server needs is named instead, with `herdr update` to run. |
| **Make the phone address** | `scripts/plugin.ts phone`, the installer's Tailscale step. |
| **Restart** / **Start** | The plugin's `stop-windows` and `start-windows` actions, or `herdr server` when herdr is not running. |
| **Remove** | The guide's Uninstall steps (`stop-windows`, `herdr plugin uninstall`, `tailscale serve … off`), then the sign-in start and the Start menu entry are removed. |

Releases up to 0.4.13 install the plugin as `devswha.herdr-web-ui`; the app finds it under either id, and offers
Update for the old one. A running server's version is only what it reports itself (`current_version` of
`GET /api/updates`, with the token from the plugin's `env`/`.env` when it has one); a stopped one's is the `version:`
line of `plugin.ts status` (the release its next start runs). herdr's list stays at the version first installed while
Settings → Updates runs newer releases, so it is never taken for the version that runs: a stopped server known only by
it is offered Start, and a running one that does not say is offered Update with "cannot read its version". The update
installs the newest release, so it never goes back. A running server that reports no version and runs without the
update supervisor (`managed: false`, which is also how one the plugin just started answers until its supervisor
reports) is not offered Update: the plugin's reinstall would not replace it. One that reports its version is compared
by it as any other. The old id's move pins install.ps1 to that newest release through `OVIS_REF`, so a ref the PC
inherited cannot take it back. When the installer or herdr's reinstall fails, the server that ran before starts again
the way herdr starts it (its start-windows action, or herdr's server), so it keeps its active release. A linked
checkout or a fork is never moved or reinstalled, and a build without a version (0.0.0, a local build) compares none.

Every program it runs has a time limit (two minutes; the installer 45, winget 30, the phone step 5). Past it,
the program and what it started are ended, except herdr and anything under it. The QR encoder's MIT notice
(`NOTICE.txt`) is embedded in `Ovis.exe`, shown from its **Licences** link, and shipped in the MSIX.

## Starting at sign-in

herdr runs the app from its startup hook, and a headless `herdr server` runs startup hooks like the
TUI's server does, so a user who never opens a terminal still gets the app. A later `herdr` in a
terminal attaches to that same server.

- `Ovis.exe` copies itself to `%LOCALAPPDATA%\Programs\Ovis\Ovis.exe`, adds an **Ovis** entry to the
  Start menu, and adds a value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` that runs
  that copy with `--start`. That needs no administrator, unlike a Task Scheduler sign-in trigger, and
  it shows in Task Manager's Startup apps and in Settings → Apps → Startup, where the user can turn it
  off. The Startup folder would do the same with a shortcut file; the Run value is one registry value
  that Remove deletes.
- The Store package declares a startup task (`windows.startupTask`) instead, which Windows turns on the
  first time Ovis is opened.

Either way `Ovis.exe --start` opens no window: it starts `herdr server` with no console window when the
Ovis server is installed and herdr is not running, and does nothing otherwise, so after Remove the
Store package's startup task starts nothing.

What it never does:
- It never stops herdr: Remove leaves it running, and Restart restarts only the Ovis server. That herdr
  may hold the user's agents, and stopping it would end them.
- It installs nothing system-wide and asks for no administrator password; install.ps1 installs for the
  user only. Only **Install Git** goes through winget, which asks.

## Build

On Windows with the .NET SDK and the Windows SDK (a GitHub `windows-latest` runner has both):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File app/windows/build.ps1 -Version 0.4.14
```

The output is `app/windows/build/Ovis.exe` and `app/windows/build/Ovis.msix`; the icon and the Store
tiles are drawn from `app/mac/Resources/AppIcon-1024.png`. `dotnet build app/windows/Ovis.csproj`
alone compiles it on any OS (the reference assemblies come from NuGet), for a compile check.

To try `Ovis.msix` on a PC, sign it with a certificate whose subject is the manifest's publisher (the
build's local identity is `CN=Ovis Local`), trust that certificate in `TrustedPeople`, and install it
with `Add-AppxPackage`.

## How the Store package runs herdr

A packaged app's own writes to `AppData` and `HKCU` are redirected into the package, and processes it
starts would run inside the package too, where herdr, Bun and the plugin would be hidden from the
user's terminal and a Store update would end the herdr server with every agent in it. So every program
the app runs is started through `cmd.exe` with the desktop app breakaway policy
(`PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY`, `PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE`):
cmd starts inside the package and everything it starts runs outside, as from a terminal. The app itself
writes nothing outside the package, so it needs no `unvirtualizedResources`; its capabilities are
`runFullTrust` and `internetClient`. `Ovis.exe` from ovis.sh runs the same code with no package around
it.

## Releases

After the Release workflow publishes `vX.Y.Z`, its `windows-app` job runs
[windows-app.yml](../../.github/workflows/windows-app.yml) on a GitHub-hosted Windows runner: it checks
out the tag, runs `build.ps1` with the version `X.Y.Z`, and attaches `Ovis.exe` (and `Ovis.msix`, below)
to the release. A pull request that changes the app builds both and keeps them as the run's artifact.

`https://ovis.sh/Ovis.exe` redirects to
`https://github.com/devswha/ovis/releases/latest/download/Ovis.exe`. Release publishes without marking
the release latest; the Windows and Mac jobs each mark it latest once it has both `Ovis.exe` and
`Ovis.dmg` (only when its tag is the newest `v*` tag), so neither download lands on a release without
its file. [release-attach.sh](release-attach.sh) swaps the files in all or nothing, so a release's files always
come from one build: every new file goes up under a temporary name, each old one steps aside, and the old
ones are deleted only once every new one has its name. A failed or cancelled run undoes or finishes the swap.
If the runner itself dies mid-swap, the release can be left without `Ovis.exe` until the next run, which
repairs it first: **run the Windows app workflow again for that tag.** Each file's label on the release names
the commit it was built from.

To give a release its files later, run **Actions → Windows app → Run workflow** on `main` with the tag,
or `gh workflow run windows-app.yml --ref main -f tag=vX.Y.Z`. A release ships what its tag holds, so a
tag from before app/windows gets nothing and the run says so. Only as a maintainer's exception, the
`app_ref` input names a full commit on main to build the app from, and the files' label records it.

`Ovis.exe` is not signed, so the first time it is opened from a download Windows shows Microsoft
Defender SmartScreen's **Windows protected your PC** (*Microsoft Defender SmartScreen prevented an
unrecognized app from starting*); **More info** shows *Publisher: Unknown publisher* and a **Run anyway**
button. The Store package has no such step: the Store signs it.

## Microsoft Store

The Store signs the package it distributes, so `Ovis.msix` is uploaded unsigned. Its identity has to
match the app reserved in Partner Center: in the app's **Product management → Product identity**, copy

| Partner Center | Repository variable (Settings → Secrets and variables → Actions → Variables) | Manifest |
| --- | --- | --- |
| Package/Identity/Name | `OVIS_MSIX_NAME` | `Identity Name` |
| Package/Identity/Publisher (`CN=…`) | `OVIS_MSIX_PUBLISHER` | `Identity Publisher` |
| Package/Properties/PublisherDisplayName | `OVIS_MSIX_PUBLISHER_DISPLAY_NAME` | `PublisherDisplayName` |

With all three set, each release gets an `Ovis.msix` to upload in a Partner Center submission; without
them the job notes it and attaches `Ovis.exe` alone.

The listing must say what the app installs, at the start of its description (Store Policies 10.2.4):
herdr, Bun and the Ovis server from https://ovis.sh/install.ps1, and Git for Windows from winget when it
is missing. The Store Policies forbid downloading and running a remote script "in a manner that is not
consistent with the described functionality" (10.2.2) and offering "secondary software that ... does
not enhance the functionality of your product" (10.2.3); this app's whole described function is that
install, which is what keeps it inside both rules, but certification decides. `runFullTrust` is a
restricted capability: the submission's notes should say it runs the user's own installer and herdr.
