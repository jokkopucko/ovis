# Ovis for the desktop (Electron)

A desktop app that carries everything Ovis needs: the Ovis server, [herdr-core](https://github.com/herdrdev/herdr-core)
(`hc`, which runs the terminals) and Bun (which runs the server). Nothing else has to be installed:
no herdr, no plugin, no Bun on the PATH. Linux, macOS and Windows (x64). On Windows the server's
herdr-core adapter listens on a named pipe named after its state folder (`server/herdr-core/pipe.ts`),
and hc runs its terminals on the ConPTY its release carries beside it (`conpty\`).

The Mac (`app/mac`) and Windows (`app/windows`) shells stay as they are; this app is separate.

## What it does

1. Starts the app's own hc core: `hc server start` with `HC_SESSION=ovis`, so it never shares a
   core with another hc client on the PC (the Herdr app uses the `default` session). Set
   `HC_SESSION` to use another one (`HC_SOCKET` is not passed on). The core runs apart from the app, as hc runs it for every client:
   quitting the app leaves the terminals running, and the next start finds them. So the core runs
   from a copy in `<user data>/bin/herdr-core`, not from the app (an AppImage's files go away with
   it, and an update replaces the app); a newer bundled hc replaces that copy with
   `hc update --from`, as hc's own installer does, and the terminals keep running. A copy newer than
   the bundled one (left by a newer app before a rollback) is kept, since hc does not go back.
2. Starts the Ovis server on the bundled Bun with `OVIS_RUNTIME=herdr-core`, `OVIS_HC_BIN` set to
   that hc, `HOST=127.0.0.1` and its own state folder (`<user data>/server`, or
   `OVIS_STATE_DIR`), and `OVIS_DESKTOP_APP=1`, so Settings → About says updates come with the app. The
   server is the same code the installer runs; the app only starts it.
3. Opens a window on the server's address. It keeps the port it had last time while that port is
   free, so the page keeps its storage (drafts, settings); otherwise it takes a free one.

Until the server answers, or when it stops, the window shows the connection screen
(`renderer/connect.html`): which step failed, the end of its output, **Try again** and
**Show logs**. The logs are in `<user data>/logs/ovis.log` (the run before in `ovis.log.1`),
with the app's update lines (why updates are off, a failed check or download).

The tray, the menu bar and the notification of a downloaded update speak the system's language
when the Ovis pages have it (Korean, Japanese, Chinese; `src/text.ts`), English otherwise.

- **Tray**: Open Ovis, Open in Browser, Keep Computer Awake, Restart Ovis Server, Restart to Update
  (once an update is downloaded, see [Updates](#updates)), Quit Ovis. Closing the window keeps Ovis running in the tray; Quit stops the server.
  On a Linux desktop without a tray (GNOME without an AppIndicator extension), starting the app
  again shows the window: only one copy runs.
- **Keep Computer Awake** (tray, off by default): **While an Agent Is Working** holds off system sleep
  while any of this PC's agents works, so phones and browsers keep reaching it; the display may still
  turn off (`powerSaveBlocker` with `prevent-app-suspension`). On battery only with **Also on
  Battery**. While it holds, the tray's menu and tooltip say so and how many agents work; it lets go
  within a few seconds of the last one stopping. The server says how many work in
  `desktop-activity.json` in its state folder (`server/desktop-activity.ts`); the choice is kept in
  `<user data>/awake.json`.
- **Links**: the server's own pages may open more Ovis windows; any other address opens in the
  default browser. A blank window a page opens for a sign-in sends its address to the default
  browser and closes. Only the microphone (dictation, never the camera), the clipboard,
  notifications and full screen are granted, and only to the server's own pages.
- **Open files**: the core and the server start through `/bin/bash`, which closes every descriptor
  Chromium left open before it becomes the program, so the core (which outlives the app) holds none
  of the app's files or sockets.
- **After a crash**: the app records the server as soon as it starts it (`<user data>/desktop.json`,
  with its start time). When the app was killed before it could stop it, the next start ends that
  server first, only when the process still runs this app's Bun on its server and started at the
  recorded time (a record without a start time is left alone), so two never share one state folder.

`<user data>` is Electron's: `~/.config/Ovis` on Linux, `~/Library/Application Support/Ovis` on macOS,
`%APPDATA%\Ovis` on Windows.

## Removing the app

The core outlives the app, but once the app is gone nothing could stop or update it, so removing
the app stops it (`herdr-core server stop` for the `ovis` session), with the terminals and agents
in it. Ovis's own data stays.

- **.deb**: the package's `prerm` (`linux/before-remove.sh`) stops it for the user who removed the
  package with `sudo` or `pkexec`; not on an upgrade, and never failing the removal. A removal by
  root alone (no `SUDO_UID` or `PKEXEC_UID`, as some software centres run it) leaves it running,
  and so does an app that ran with its data outside `~/.config/Ovis` (`XDG_CONFIG_HOME`,
  `--user-data-dir`): the script cannot know where that was.
- **AppImage** and **macOS** (dragging the app to the Trash) run nothing as they go. Stop the core
  first:

  ```sh
  HC_SESSION=ovis ~/.config/Ovis/bin/herdr-core server stop                                # Linux
  HC_SESSION=ovis ~/Library/Application\ Support/Ovis/bin/herdr-core server stop          # macOS
  ```

  An AppImage run unpacked (`APPIMAGE_EXTRACT_AND_RUN=1`, without FUSE) removes its unpacked
  folder in the temporary folder as it quits.

On Windows the installer replaces Ovis for Windows (`app/windows`, the one-file setup app), which has
no uninstaller of its own (`windows/installer.nsh` runs `windows/replace-old-setup.ps1`):
- This app's Start menu **Ovis** takes the place of that app's shortcut, and any other shortcut to it
  in the Start menu or on the desktop goes.
- Any open window of it, also one opened from a download, is closed. Only a file whose version
  information says it is Ovis for Windows counts; anything else is left alone. A shortcut the user
  deleted is not made again.
- Its sign-in start (the HKCU `Run` value `Ovis` that runs its copy in `%LOCALAPPDATA%\Programs\Ovis`
  with `--start`) is what starts herdr's server at sign-in for the Ovis plugin. So when herdr says the
  Ovis plugin is installed (`herdr plugin list`), the sign-in start and the copy stay, and herdr's server
  still starts at sign-in, with no window. Without the plugin both go. The installer log says which.
- Its own Remove is never run, because that also takes the Ovis server off the PC.
- herdr, the Ovis server it installed and their state stay as they are.

Uninstalling on Windows (Settings > Apps, or `Uninstall Ovis.exe`) stops the core, with the terminals
and agents in it (`herdr-core server stop` for the `ovis` session, at most 15 seconds, never failing
the uninstall): quitting leaves it running, but with the app gone nothing could stop or update it. It
also removes `%LOCALAPPDATA%\ovis-desktop-updater`, where electron-builder keeps a copy of the
installer for later updates (about 170 MB) and electron-updater its downloads. The old version's
uninstall that an update runs does neither. Ovis's own data in `%APPDATA%\Ovis` stays. A core started
under another `HC_SESSION` or from another `--user-data-dir` (the try-it setups below) is not found:
stop it by hand.

On Windows the core and the server start directly (Windows hands a child only the handles marked
inheritable), without a console window. Windows has no SIGTERM: stopping the server ends its
process at once, and a server left behind after a crash is found by its command line and start
time through CIM (`Get-CimInstance Win32_Process`) instead of `ps`.

## Updates

electron-updater, from a generic feed (a folder of files over https). A build updates itself only
when it has a feed:

| Setting | When | Effect |
| --- | --- | --- |
| `OVIS_UPDATE_FEED=https://…` | build | electron-builder writes the feed into the app (`app-update.yml`) and `latest*.yml` beside the installers, to upload there |
| `OVIS_UPDATE_URL=https://…` | run | checks that feed instead of the built-in one (a build without a feed stays off) |
| `OVIS_UPDATES=0` | run | no checks |

A development run never checks. The app checks after it starts and every hour (nothing pushes a
release to it), and downloads in the background. A version it already holds is not downloaded
again by the next check, unless the updater reported a failure since. An update whose file is
gone from the updater's folder (a later download that fails empties it) is no longer offered,
anywhere, until it is downloaded again. Once the app is on its way out for an update, it checks
no more.

On a Mac the update is offered only once Squirrel, the system's side of the updater, says it
holds it: the download alone is not enough there, and Squirrel can refuse it (an app run from
its disk image, a signature it does not accept). An error before that leaves nothing offered,
and the next check hands the download over again.

A downloaded update says so, in three places:

- **A system notification**, once per version: "Ovis X.Y.Z is ready" with "Restart to update."
  under it. Its click opens the window. Which version was announced is kept in
  `<user data>/update-notice.json`, so the next start does not say it again.
- **A line in the window**: "Ovis X.Y.Z is ready." with **Restart to Update**, on the row where
  the Ovis pages show their own release line (the server the app carries offers none). Its close
  button closes it for that version, in the app, so later starts keep it closed; the next
  version shows it again. The connection screen shows the line too, also once closed: an update
  may be what a server that cannot start needs. A window a page opens has no line.
- **Restart to Update** in the tray, as long as the update waits.

The line is drawn by the pages, from what the app's preload tells them (`ovisUpdate`): the
downloaded version and whether its line was closed. Only the connection screen and the server's
own pages are answered.

On Linux the AppImage replaces itself, so one kept in a folder the user cannot write (under
`/opt`, say) does not update itself: the log says why its updates are off. A .deb install
installs the new .deb with `apt-get install --no-remove` behind the system's password prompt
(pkexec, or sudo), only from **Restart to Update** (the tray's or the line's), never on a plain
quit, and cancelling the prompt keeps Ovis running as it was. On macOS an update needs a signed
app, and so does its notification.

Except for a .deb, Restart to Update stops the server before it installs, since the new copy
starts at once. An install that then cannot go ahead (the downloaded file gone meanwhile, an
installer that fails at once) starts Ovis again as it was.

## Build

On the OS and CPU the app is for (no cross builds), from this folder:

```sh
bun install
bun test                     # unit tests (no Electron needed)
bun run typecheck
bun run dist                 # stage, bundle, then dist/Ovis-<version>-<arch>.AppImage, or .dmg and .zip,
                             # or dist/Ovis-win-x64.exe (NSIS, per user, unsigned;
                             # installs to %LOCALAPPDATA%\Programs\ovis-desktop)
```

`bun scripts/build.ts stage` downloads herdr-core 0.1.17 and Bun 1.4.2 for this machine
(`scripts/runtimes.ts` pins their SHA-256; a mismatch stops the build), checks that each runs and
says its version, builds the client (`bun run build` at the repository root) and copies the server
with its production packages into `stage/`. Each build checks the cached downloads against their
pins again and unpacks them afresh. It also adds the release's Rust PTY host
(`scripts/pty-sidecar.ts install`, checked against the release manifest) when the release named
by `package.json` was built from this checkout's PTY host sources, as on a release tag; otherwise
the server uses Node for the few things that need a PTY host of its own, where the PC has Node. `bun run start` then runs the app from `stage/`
without packaging it. Nothing downloaded is committed.

To try it without touching your own hc core or Ovis state, give it a fresh user data folder and hc
session:

```sh
d=$(mktemp -d)
HC_SESSION=ovis-try XDG_RUNTIME_DIR=$d/run XDG_STATE_HOME=$d/state XDG_CONFIG_HOME=$d/config \
  ./dist/Ovis-*.AppImage --user-data-dir="$d/app"
# afterwards
HC_SESSION=ovis-try XDG_RUNTIME_DIR=$d/run XDG_STATE_HOME=$d/state XDG_CONFIG_HOME=$d/config stage/bin/herdr-core server stop
```

On macOS, `open -n dist/mac-arm64/Ovis.app --args --user-data-dir="$d/app"` with the same `HC_SESSION`.
On Windows (PowerShell), after `dist\Ovis-win-x64.exe` installed it to `%LOCALAPPDATA%\Programs\ovis-desktop`:

```powershell
$d = Join-Path $env:TEMP "ovis-try-$(Get-Random)"
$env:HC_SESSION = 'ovis-try'
& "$env:LOCALAPPDATA\Programs\ovis-desktop\Ovis.exe" --user-data-dir="$d\app"
# afterwards
& "$d\app\bin\herdr-core.exe" server stop
```

## End-to-end checks

`scripts/e2e.ts` checks a built app the way a new user meets it. The app runs in a temporary HOME
with its own PATH (no herdr, no hc), hc session and user data folder, on Linux on an Xvfb display
of its own (install `xvfb`), so the PC's own herdr, hc core and Ovis state are never touched:

```sh
bun scripts/e2e.ts dist/Ovis-*.AppImage       # Linux
bun scripts/e2e.ts dist/mac-arm64/Ovis.app    # macOS, from a logged-in desktop session
bun scripts/e2e.ts --update                   # Linux: packages 0.0.1 and 0.0.2 from stage/ and out/,
                                              # then updates the first from a local https feed
bun scripts/e2e.ts --update --from-tray       # the same, restarting from the tray with the line closed
```

It covers the first launch (connection screen, then Ovis), a terminal and an agent pane (a
stand-in `claude`) in the app's core, quit and relaunch (the terminals keep running, the address
stays), the tray's items, a killed app (the next start ends the server left behind) and, with
`--update`, the app's updates: an AppImage in a folder that cannot be written keeps them off; a
downloaded update's one notification and that notification's click, its line in the window and
on the connection screen, a later check that leaves the held version alone, the downloaded file
lost while the server stops for the install (Ovis starts again, and the next check brings the
update back), and Restart to Update from the line (with `--from-tray` the line is closed first,
stays closed, and the tray restarts). The app's main process is driven
through its inspector. Terminals are made and typed into through the server's API, and the window
is checked to list them. Tray items are pressed through their menu (enabled, with their handlers);
whether the desktop draws the tray icon is not checked. The notification is read as the app shows
it; whether the desktop draws it is not checked. The update feed uses a certificate made for the
run, which the app is told to accept, and `--update` packages with electron-builder's usual caches.

Screenshots, the app's output and `results.json` go to `--out` (by default a new temporary
folder, kept); the exit code is 0 when every check passed. A check that fails for a filed bug says
KNOWN with the issue and does not fail the run. Without `libfuse.so.2` the AppImage runs unpacked
(`APPIMAGE_EXTRACT_AND_RUN=1`). Every process the run starts carries its id in its environment;
cleanup ends those and nothing else.

## Licenses

The app ships Ovis's own `LICENSE` and `THIRD_PARTY_NOTICES.md` in `resources/ovis/`,
herdr-core's and Bun's license files in `resources/ovis/licenses/`, Electron's and
Chromium's as electron-builder adds them, and the bundled npm packages' in
`out/THIRD_PARTY_LICENSES.txt`. [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md#ovis-for-the-desktop)
lists them.
