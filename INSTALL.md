# Installing Ovis (guide for coding agents)

Follow these steps in order to install Ovis for a user. Run each command and check its output
before moving on. Every step says what success looks like. Stop and ask the user whenever a step says
**Ask**.

Ovis is a browser and phone client for [herdr](https://github.com/herdrdev/herdr). It adds a
web server on port `7317` and never replaces herdr, its sessions or the user's own terminal.

## Rules

- Bind to `127.0.0.1` (the default) unless the user asks for remote access. Anyone who can reach an
  ungated server can type into the user's terminals. Never bind to `0.0.0.0` or a LAN address, or
  put it behind a proxy other people can reach, without a token (`OVIS_TOKEN`). A `tailscale
  serve` address may go without one only when the user confirms every device in their tailnet is
  their own.
- Never print, log or commit the token. Write it only to the config file named below and tell the
  user where it is.
- Do not install herdr or Bun yourself unless the user agrees. Say which one is missing and how to
  install it. Ovis does not use Node, so never install it for Ovis.
- Do not stop or restart the user's herdr server (`herdr server stop`). Restarting Ovis is fine.

## 1. Check prerequisites

```bash
bun --version        # need 1.4 or newer
herdr --version      # need 0.9.0 or newer
herdr status server  # the herdr server must be running
git --version
```

- A missing tool: **Ask** the user before installing it. Bun: `curl -fsSL https://bun.sh/install | bash`.
  herdr: <https://herdr.dev>.
- herdr not running: ask the user to start `herdr` in a terminal, then check again.
- Node is not needed. On Linux and macOS, terminals run on the Rust PTY host that each release ships
  (`bin/ovis-pty-sidecar`, installed by the plugin's build and checked against the release's SHA-256).
  Where it is missing or fails its startup check, panes are mirrored instead of attached, and the
  server's log says why and how to get one.
- Supported platforms: Linux x64 and arm64, macOS, Windows x64. Windows uses the [screen mirror](docs/remote-pcs.md#windows-pcs) and has no Rust PTY host. No compiler or Python is needed: the terminal
  host is prebuilt for Linux and macOS. Other platforms (Alpine, 32-bit ARM) have no build.

## 2. Choose the install method

| Method | When | Updates |
| --- | --- | --- |
| **A. herdr plugin** (default) | The user wants it to start with herdr | In-app: Settings → About |
| **B. Source checkout** | The user wants to develop it, or asks for a clone | In-app, while the checkout stays on a clean `main` |
| **C. One-line installer** | The user agrees to install what is missing (herdr and Bun), to let Tailscale serve the app, and, where herdr is not running, to have herdr started at login (and at boot, with lingering) | In-app, like A |

Use A unless the user says otherwise. C is A plus the prerequisites and step 5 in one command,
`curl -fsSL https://ovis.sh/install.sh | sh`: it installs herdr for the user only (no sudo) when it
is missing, and the release's compiled server into `~/.local/share/ovis` (taken only once the
release's signed `ovis-server.json` verifies against the key the installer pins and each file has the
size and SHA-256 it names; nothing there changes when a check fails), with no Bun or Node. It links a
small plugin folder that runs that binary into herdr, starts it when herdr
runs, and, when Tailscale runs on the PC, serves the app to the tailnet (`tailscale serve`) and
prints the address as a QR code. It changes the user's Tailscale configuration, so it needs the
same **Ask** as step 5. Where herdr is not running (C just installed it, or it is stopped), C starts
herdr's server headless, and the app with it, and sets up what starts herdr again. On a Linux PC used
without a desktop, that is the user service `ovis-herdr` (`systemctl --user`), only where lingering is
on or can be turned on without a password (`loginctl enable-linger`; it records that it did in
`~/.local/share/ovis/lingering`), so herdr starts at boot and runs after a logout. A desktop is told
from the session it runs in and from the machine (an enabled display manager, or a graphical session
of the user's), so a desktop PC set up over SSH gets no service. On a Mac, at the screen or over SSH,
it is the `sh.ovis.herdr-server` LaunchAgent, at login, which launchd runs inside the user's login
session. Where lingering is not on, on a Linux desktop, without a service manager, or with
`--no-service` (`OVIS_NO_SERVICE=1`), it starts herdr once (it outlives a logout) and sets up nothing.
A later run removes the service an earlier one set up where none is wanted now (lingering turned off
since, `--no-service`, a desktop) without stopping herdr, and the closing lines say so; `--no-service`
leaves a Mac's LaunchAgent, which the Mac app shares, and says how to remove it. That is a service and possibly lingering for the user's
account: say so when you **Ask**, and pass `--no-service` if the user does not want them. The service
never stops herdr, and a herdr that runs is left as it is. It ends by saying what runs and what starts
it again, `ovis status` to see it and `ovis stop` to stop it.

To add the PC to the user's Ovis account in the same line, with no terminal, pass the account's id
(the user reads it from `ovis status` on a PC already in the account, or **Settings → Manage account**).
Never guess the id, and do not sign in for the user. The run takes the install plus up to 10 minutes
of waiting for the user, and the sign-in address and code it prints are needed while it waits: a
command run in the foreground of a tool call shows its output only when it ends, and may be cut off
before. So start it in the background with its output in a file:

```bash
log=~/ovis-install.log
nohup sh -c 'curl -fsSL https://ovis.sh/install.sh | sh -s -- --add --account <id>; echo "install-exit=$?"' >"$log" 2>&1 </dev/null &
```

Then read the file every few seconds (`tail -n 30 ~/ovis-install.log`). As soon as it shows
`1. On any device, open: <address>` and `2. Enter this code: <code>` (or `Opening your browser at:`
on a PC with a desktop), give the user that address and code at once: they sign in there with GitHub
or Google, then press **Add** for this PC in Ovis on a device of that account. Keep reading until the
file ends with `install-exit=<n>`, for at most 15 minutes: `install-exit=0` means the PC was added
(`Added. Open (this PC) from My PCs.`), anything else means it was not, and the lines above it say why.
After `install-exit=0` the user sees the PC in **My PCs** on their devices, and the installer's last
lines say what runs (`Ovis runs now at …`). To confirm it yourself, run `ovis status --json` on the PC:
`account` is the account's id (compare it with the one the user gave you), and `relay.connected` turns
`true` once its relay is online, within seconds (the PC is in the account either way).

**Set up a PC from an agent.** The way with nothing for the user to relay is an invite: the user makes
one on a device signed in to their account (one line, `ovis-join:1:…`, which works once, for 15
minutes) and gives it to you with the account's id. The line is a key: put it in a file only the user
can read, with your file tool, never in a command line (that shows in the process list) or a log. Then
run the one line for the PC's system, in the background with its output in a file, as above:

```bash
curl -fsSL https://ovis.sh/install.sh | sh -s -- --join-file ~/ovis-invite.txt --account <id>
```

```powershell
& ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -JoinFile $HOME\ovis-invite.txt -Account <id>
```

The PC joins with no sign-in. An invite made to add the PC at once ends within seconds; any other waits
up to 10 minutes for **Add**: when the file says `press Add for <name>`, tell the user to press it on a
device of that account. The file ends with `install-exit=0` once the PC is in the account (`this PC
is in the Ovis account the invite is for`), and `ovis status --json` confirms it as above; anything
else means it did not join, and the last `Ovis:` line says why (a used or expired invite needs a new
one). `OVIS_JOIN=<line>` gives the line where arguments cannot be given; `--join <line>` works too but
puts it in the process list. Without `--account` the installer asks at a terminal whether the
invite's account is the user's; where nobody can answer (no terminal, as from your tool) it refuses
before installing anything and names the flag to add. Never guess the id.

Running it again keeps what is there (`nothing to do` for a version already installed); two runs at once
take turns through an install lock in `~/.local/share/ovis`: a waiter breaks the lock once the holder's pid no
longer runs, one breaker at a time. A release
from before the compiled server, a branch in `OVIS_REF`, an install from source already on the PC, or
`OVIS_FROM_SOURCE=1` install from source as before ([one rule](#binary-or-source)) (Bun and herdr's plugin checkout, with the release's Rust PTY host). `OVIS_RELEASES_URL` (an https:// address, or a `file://` folder) points
it at another place for releases; plain http is refused. On a first install it prints a link
for a GitHub star, unless the account gh is signed in to has starred the repository already. It
asks whether to give one only at a terminal, and goes on by itself after 20 seconds: do not answer
the question, and do not star the repository for the user.

On a Linux or macOS PC that has herdr-core (`hc`, the core the Herdr desktop app runs on) and no herdr,
C installs neither herdr nor the plugin. It installs Bun when missing, puts Ovis in its own checkout
(`~/.local/share/ovis/app`, built as herdr builds the plugin), writes `OVIS_RUNTIME=herdr-core` and
the hc it found (`OVIS_HC_BIN`) to `~/.config/ovis/env`, and starts it with `bun ~/.local/share/ovis/app/scripts/plugin.ts start` from a
user service that starts it again at login: `ovis.service` (`systemctl --user`) on Linux, the
`sh.ovis.server` LaunchAgent on macOS. Without systemd it starts Ovis once and says how to start it
again. `OVIS_RUNTIME=herdr` or `OVIS_RUNTIME=herdr-core` before `sh` picks the runtime instead.
Where the herdr plugin already runs Ovis, it does not add a second one: it says to set
`OVIS_RUNTIME=herdr-core` in the plugin's own settings instead. Updates work as for the plugin.

On Windows x64, use `irm https://ovis.sh/install.ps1 | iex` in PowerShell.
It requires Git for Windows and installs missing herdr and Bun for the user, without Node or WSL.
It starts the plugin when herdr runs. Phone access stays optional: use the **Phone setup** action.
On Windows it starts on herdr even where herdr-core is installed; **Settings → About → Terminals**
then switches to the Herdr app's terminals (herdr-core).
`OVIS_REF` selects a branch or tag for testing; otherwise it installs the latest release.

Where herdr is not running, the Windows installer starts herdr's server with no window, and the app
with it, in the user's signed-in desktop: through a one-shot task of the user's own, with ordinary
rights and no stored password, removed once herdr runs, so herdr outlives the SSH session or the
agent's command that ran the installer. It also sets herdr to start at the user's sign-in: the value
`Ovis` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, the one the Ovis app for Windows
sets, shown in Task Manager's Startup apps (it runs `%LOCALAPPDATA%\ovis\start-herdr.ps1` in a
hidden Windows PowerShell, which may show a window for a moment). It installs no Windows service,
leaves no task behind and asks for no administrator. A value `Ovis` it did not write (the Ovis app's
among them) is left as it is. Signing out of Windows ends that herdr with every terminal in it (lock
the PC instead), and nothing starts it before the next sign-in. Run over SSH with nobody of the
account signed in at the PC, it starts nothing (herdr starts at the next sign-in) unless given
`-Headless` (`OVIS_HEADLESS=1`): herdr then runs without a desktop until the PC restarts, where
programs in its terminals cannot use the desktop and Codex commands that need their sandbox's own
desktop can fail, so ask the user first. `-NoService` (`OVIS_NO_SERVICE=1`) starts herdr once and
sets up no sign-in start; a later run with it removes the one an earlier run set up. Say so when you
**Ask**, and pass `-NoService` if the user does not want it. Nothing stops herdr, and a herdr that
runs is left as it is. `irm | iex` passes no arguments: give them as
`& ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -NoService`, or as the variables.

To add a Windows PC to the user's Ovis account in the same run, with no terminal, pass the account's
id as for `install.sh` (the user reads it from `ovis status` on a PC already in the account, or
**Settings → Manage account**; never guess it, and do not sign in for the user):
`& ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -Add -Account <id>`, or
`$env:OVIS_ADD_ACCOUNT = '<id>'` before `irm https://ovis.sh/install.ps1 | iex`. It runs
`ovis add --account <id>` with no input, on a release whose add checks that account (0.5.10 and
later), and fails when the PC was not added. It waits up to 10 minutes for the user, and the sign-in
address and code it prints are needed while it waits, so start it in the background with its output
in a file (your tool's own background run, where it ends what its commands start):

```powershell
$env:OVIS_ADD_ACCOUNT = '<id>'
Start-Process powershell -WindowStyle Hidden -RedirectStandardOutput "$HOME\ovis-install.log" -RedirectStandardError "$HOME\ovis-install.err" -ArgumentList '-NoProfile -Command try { irm https://ovis.sh/install.ps1 | iex; Write-Output install-exit=0 } catch { Write-Output $_; Write-Output install-exit=1 }'
```

(One string for `-ArgumentList`, with no double quotes in it: Windows PowerShell joins a list unquoted, and the
command line would lose them.)

Then read `~\ovis-install.log` every few seconds, give the user the address and code as soon as it
shows `1. On any device, open: <address>` and `2. Enter this code: <code>`, and keep reading until it
ends with `install-exit=<n>`, for at most 15 minutes: `install-exit=0` means the PC was added, and
`ovis status --json` on it then names the account (`account`) and says when its relay is online
(`relay.connected`). `-Add` alone runs `ovis add` at a terminal, where the user answers it.

With an invite the user made on a device of their account (one line, `ovis-join:1:…`, single use, 15
minutes), the PC joins with no sign-in: put the line in a file only the user can read, with your file
tool (never in a command line or a log), and pass `-JoinFile <file> -Account <id>`:
`& ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -JoinFile $HOME\ovis-invite.txt -Account <id>`.
The background recipe above runs `irm … | iex`, which takes no arguments: there, set
`$env:OVIS_JOIN = Get-Content -Raw "$HOME\ovis-invite.txt"` beside `$env:OVIS_ADD_ACCOUNT`, and
afterwards `Remove-Item Env:\OVIS_JOIN` in your own session (the installer takes it out of its own). It runs `ovis join` once Ovis runs, with the line in its
environment only, and fails unless the PC joined, its last `Ovis:` line saying why (a used or expired
invite needs a new one). An invite that needs **Add** waits up to 10 minutes: when the log says
`press Add for <name>`, tell the user to press it. `-Join <line>` works too, but a command line that
holds the line shows in the process list. Without `-Account` the join runs only at a terminal, where it
asks the user whether the invite's account is theirs; where nobody can answer (no terminal, as from your
tool) the installer refuses before installing anything and names `-Account <id>`. `-Help` lists the
options.

## 3A. Install as a herdr plugin

```bash
herdr plugin install devswha/ovis --yes
```

herdr clones the repository and runs `scripts/plugin-launch.ts install`, which downloads the release's compiled
server for this version (`ovis-server-<platform>` and the built client, `ovis-dist.tar.gz`), checks the signature
of the release's `ovis-server.json` against the key the repository pins and each file's size and SHA-256, and moves
it into `.ovis/server` in the plugin's checkout in one rename; every plugin command then runs that binary while it
still verifies, so a first start needs no network. This takes about a minute.

<a id="binary-or-source"></a>**Binary or source.** Ovis builds from source instead (`bun install`, `bun run build`,
and `scripts/plugin.ts` run by Bun) when `OVIS_FROM_SOURCE=1` is set (a developer checkout; `install.sh` and
`install.ps1` set it for herdr when `OVIS_REF` names a branch or a commit), and it says so in one line. Otherwise:
- the plugin's launcher and `install.ps1` fall back to source only when this version's release has no
  `ovis-server.json` at all (GitHub answers 404, or a `file://` folder has none: every release up to v0.5.3). Anything
  else fails: a server error, a network failure, or a manifest that is there but fails its signature, version, size or
  SHA-256 check;
- `install.sh` today falls back to source when its manifest probe fails with any HTTP error, not only 404: the source
  of the same tag, from GitHub over TLS. The update work (todo 7 of the relay-fleet plan) narrows it to 404 only. A
  manifest that is there and fails a check fails, as above;
- the plugin's launcher takes the release's binary only when the checkout's `server/` and `shared/` are the git trees
  the signed manifest names: a branch, or main between releases, runs its own sources;
- over an install of the release's binary, `install.sh` builds no source: asked for one (`OVIS_FROM_SOURCE=1`, a
  branch, or a tag without the binary), it stops before installing anything and says how to remove the binary first;
  when the latest release cannot be checked, it leaves the installed Ovis as it is.

- Success: the command exits 0 and `herdr plugin list` shows `devswha.ovis`.
- The first build step is a check that prints, in one line, what is missing (`bun`, or a version
  too old) and how to fix it. `bun` not found means herdr runs build commands
  with **its own** environment: make sure it is on the `PATH` of the shell that started herdr
  (Bun installs to `~/.bun/bin`), ask the user to restart herdr from that shell, then retry.
- On Windows, the plugin launcher reads the current user PATH and Bun's user-local directory,
  so installing Bun while herdr is running does not require restarting herdr.
- "installing over a locally linked plugin is refused": run `herdr plugin unlink devswha.ovis`
  first.
- Installed before the rename, the plugin is `devswha.herdr-web-ui`. The one-line installer moves
  it: it stops that plugin's server, installs `devswha.ovis`, copies the `env` and `.env` files
  from `herdr plugin config-dir devswha.herdr-web-ui` to the new id's config dir (unless that one
  has its own), then uninstalls the old id. By hand, do the same in that order.

Start it now. Otherwise it starts the next time herdr starts:

```bash
herdr plugin action invoke devswha.ovis.start
```

On Windows, the start and stop action IDs are `devswha.ovis.start-windows` and
`devswha.ovis.stop-windows`. The menu titles are the same on every platform.

The command only queues the action and prints herdr's JSON acknowledgement; the action's own output
(`Ovis listening at http://127.0.0.1:7317`, and possibly `no token set: ...`, expected for a
local-only install) goes to the plugin log (`herdr plugin log list`). Check it with step 4.

Plugin settings do **not** come from the user's shell. They go in an `env` file (no dot):

```bash
CONFIG_DIR="$(herdr plugin config-dir devswha.ovis)"
echo "$CONFIG_DIR/env"
```

The file holds `KEY=value` lines. A plugin checkout from 0.3.25 on also reads `.env` there (the name
herdr's plugin docs use), and `.env` wins where both set a key. An older checkout reads only `env`,
and in-app updates do not replace the checkout: reinstall the plugin (see [Update](#update)) before
relying on `.env`. The plugin path comes from `herdr plugin list`, since herdr 0.9.4 moved plugin
checkouts. Run:

```bash
root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "devswha.ovis")?.plugin_root ?? "")')
bun "$root/scripts/plugin.ts" status
```

This prints the files it read. After editing, restart the plugin:

```bash
herdr plugin action invoke devswha.ovis.stop
herdr plugin action invoke devswha.ovis.start
```

## 3B. Install from source

```bash
git clone https://github.com/devswha/ovis.git
cd ovis
bun install
bun run start
```

`bun run start` runs in the foreground. Start it in a separate herdr pane, or under the user's
service manager, so it keeps running. Settings are environment variables on that command.
`bun run server` and `bun run dev` are development commands and do not update themselves.

A checkout has no Rust PTY host until one is put in `bin/`: on a release tag,
`bun scripts/pty-sidecar.ts install` fetches that release's, checked; on any branch,
`cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml` builds one (a checkout of main
whose `crates/pty-sidecar` changed since the release gets one from the next daily beta's
`pty-sidecar-<tree>` prerelease). Without one, terminals are mirrored, and the server's log says so.

On Linux and macOS, a service manager may start with a smaller `PATH` than an interactive shell.
Use the existing launcher so Bun, Node and agents installed in `~/.local/bin` are discoverable.
For example, a systemd unit's `[Service]` section can use:

```ini
WorkingDirectory=/absolute/path/to/ovis
ExecStart=/bin/sh /absolute/path/to/ovis/scripts/with-bun.sh run start
```

Run the service as the user who installed the agents, with that user's `HOME`. The launcher adds
the usual user-local directories after the existing `PATH`, preserving its command choices.
If an installed agent such as Grok is missing from the new-session picker, check the service's
`PATH`: the picker hides agents the server cannot find. Restart the web UI after changing the
service configuration.

## 4. Verify

```bash
curl -s http://127.0.0.1:7317/api/health
```

Success is JSON with `"ok":true` and a `herdr` object, for example
`{"ok":true,"herdr":{"version":"0.9.0","protocol":...},"auth":{"required":false,...},...}`.

- Connection refused: the server is not running. For the plugin, run the `status` action. Command
  logs are listed by `herdr plugin log list`; the server's own log is `server.log` in the plugin's
  state directory. Port `7317` in use: set `PORT` (see [Configuration](#configuration)) and restart.
- An error mentioning the herdr socket: herdr is not running, or it uses a named session. For a
  named session, set `HERDR_SOCKET=~/.config/herdr/sessions/<name>/herdr.sock`. The plugin follows
  herdr's session automatically (herdr passes it `HERDR_SOCKET_PATH`); a `HERDR_SOCKET` in the plugin
  config overrides that.

Tell the user to open <http://127.0.0.1:7317>.

## 5. Optional: phone or remote access

**Ask** the user first. This exposes their terminals over the network. Then serve it over HTTPS.
Without HTTPS, a phone can view the app but cannot install it or receive alerts. With Tailscale:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7317
```

Or run the one-line installer (method C) again, which installs nothing when the app is there, or
`bun scripts/plugin.ts phone` from a source checkout: it runs that command on the first
free HTTPS port (only on `OVIS_TAILSCALE_HTTPS_PORT` when the user set one, for a user who
keeps 443 for something else) when Tailscale runs and does not serve the app yet, says how to undo it, and prints the
address as a QR code. **Settings → Phone & devices** in the app shows this step's state: the address that already works as a QR
code, or the exact command still to run. Who gets in:

- The user's own Tailscale devices get in as the user: `tailscale serve` states the login, and the
  server compares it with this PC's. Nothing to configure. Other people's logins are refused, and
  tagged devices (no person's login) need pairing. If the user's own phone is asked to pair anyway,
  `OVIS_TAILSCALE_SERVE_ONLY=1` lets it in without a code on a tailnet one login owns
  ([Access and safety](docs/guide.md#access-and-safety)).
- Any other device (someone else's, or a LAN or public address) is paired: **Settings → Phone & devices**
  on the PC shows a six-digit code and a QR code; the device enters it once. On a headless PC with
  no browser, find the plugin path with `herdr plugin list` (herdr 0.9.4 moved plugin checkouts),
  then run:

  ```bash
  root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "devswha.ovis")?.plugin_root ?? "")')
  bun "$root/scripts/plugin.ts" pair
  ```

  This prints the code in the terminal. Do this with the user present; never read a code aloud into
  a log.
- A token (`OVIS_TOKEN`) is for scripts and proxies. Only when the user asks for one, create it
  without printing it. For the plugin:

   ```bash
   CONFIG_ENV="$(herdr plugin config-dir devswha.ovis)/env"
   touch "$CONFIG_ENV" && chmod 600 "$CONFIG_ENV"
   printf 'OVIS_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$CONFIG_ENV"
   ```

   For a source install, write the same line to a file only the user can read (for example
   `~/.config/ovis/token.env`, mode `600`) and start with
   `env $(cat ~/.config/ovis/token.env) bun run start`. Restart Ovis either way.

Tell the user the HTTPS address. Until a device is paired, and with no token set, a LAN or proxied
address is open to anyone who reaches it, as before; the server warns on startup. A token sent over
plain `http://` is readable by anyone on the network path: prefer HTTPS (Tailscale or a
TLS-terminating proxy) for any address others can reach.

Other PCs over SSH are added in Ovis (Settings → Remote PCs → **Add PC**), not by an install step here.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `7317` | HTTP and WebSocket port |
| `OVIS_TOKEN` | unset | Token for scripts and proxies. Once set, every client that is not a paired device or the user's own Tailscale login needs it, this PC included |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | herdr socket. The plugin follows herdr's session (herdr passes `HERDR_SOCKET_PATH`); a `HERDR_SOCKET` set in the plugin config wins |
| `OVIS_AUTO_UPDATE` | `0` | `1` installs new versions automatically |
| `OVIS_STATE_DIR` | `~/.config/ovis` | Push keys, device subscriptions, PC registrations, update builds. Keep it across reinstalls. |

The old `HERDR_WEB_*` names still work. The [user guide](docs/guide.md#configuration) lists the rest.

## Update

- Settings → **About** → **Update and restart** when a new release (`vX.Y.Z`) is out. It works for
  both install methods. The new
  version is built separately and the app restarts only if the build and health check pass.
- Plugin alternative: `herdr plugin install devswha/ovis --yes` again. It replaces the
  checkout; restart the plugin afterwards.
- Source alternative: `git pull` on `main`, then restart `bun run start`. The in-app updater only
  offers published releases (`vX.Y.Z` tags); `main` can be ahead of the latest release.

## Uninstall

```bash
# an install from before the rename runs, or is registered, under its old id until the installer moves it
herdr plugin action invoke devswha.ovis.stop || herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin uninstall devswha.ovis || herdr plugin uninstall devswha.herdr-web-ui
```

Where the one-line installer started herdr, also remove its service, without stopping herdr (it may
hold the user's agents), and turn lingering off only where the installer turned it on:

```bash
systemctl --user disable ovis-herdr; rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ovis-herdr.service"; systemctl --user daemon-reload   # Linux
launchctl disable gui/$(id -u)/sh.ovis.herdr-server; rm -f ~/Library/LaunchAgents/sh.ovis.herdr-server.plist   # macOS
if [ -f ~/.local/share/ovis/lingering ]; then loginctl disable-linger && rm ~/.local/share/ovis/lingering; fi
```

A herdr the service started ends at the user's next logout once lingering is off. Ask before turning
lingering off: something else on the PC may rely on it. `launchctl disable` leaves the label listed as
disabled in launchd's per-user overrides, which is harmless.

An install on herdr-core (no herdr) has no plugin: stop it and remove its service and checkout.

```bash
bun ~/.local/share/ovis/app/scripts/plugin.ts stop
systemctl --user disable --now ovis && rm ~/.config/systemd/user/ovis.service   # Linux
launchctl bootout gui/$(id -u)/sh.ovis.server; rm ~/Library/LaunchAgents/sh.ovis.server.plist   # macOS
rm -rf ~/.local/share/ovis/app
```

On Windows the actions are `devswha.ovis.stop-windows` and the uninstall the same. Where the
installer set herdr to start at sign-in, remove that too, and only that (the Ovis app's **Remove**
removes its own); herdr keeps running:

```powershell
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ("$((Get-ItemProperty $run -Name Ovis -ErrorAction SilentlyContinue).Ovis)" -like '*\ovis\start-herdr.ps1"') { Remove-ItemProperty $run -Name Ovis }
Remove-Item "$env:LOCALAPPDATA\ovis\start-herdr.ps1" -ErrorAction SilentlyContinue
```

Uninstall removes herdr's managed checkout. It does not touch `~/.config/ovis` (push
subscriptions, saved PCs, update builds). Check whether the plugin config directory (it holds the
token) is still there. Delete either one only if the user asks.
