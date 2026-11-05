# Ovis for the desktop (Electron)

A desktop app that carries everything Ovis needs: the Ovis server, [herdr-core](https://github.com/herdrdev/herdr-core)
(`hc`, which runs the terminals) and Bun (which runs the server). Nothing else has to be installed:
no herdr, no plugin, no Bun on the PATH. Linux and macOS for now; Windows waits for hc's named
pipe support in the server (`server/herdr-core/runtime.ts`).

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
   `OVIS_STATE_DIR`). The server is the same code the installer runs; the app only starts it.
3. Opens a window on the server's address. It keeps the port it had last time while that port is
   free, so the page keeps its storage (drafts, settings); otherwise it takes a free one.

Until the server answers, or when it stops, the window shows the connection screen
(`renderer/connect.html`): which step failed, the end of its output, **Try again** and
**Show logs**. The logs are in `<user data>/logs/ovis.log` (the run before in `ovis.log.1`).

- **Tray**: Open Ovis, Open in Browser, Restart Ovis Server, Restart to Update (once an update is
  downloaded), Quit Ovis. Closing the window keeps Ovis running in the tray; Quit stops the server.
  On a Linux desktop without a tray (GNOME without an AppIndicator extension), starting the app
  again shows the window: only one copy runs.
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

`<user data>` is Electron's: `~/.config/Ovis` on Linux, `~/Library/Application Support/Ovis` on macOS.

## Updates

electron-updater, from a generic feed (a folder of files over https). A build updates itself only
when it has a feed:

| Setting | When | Effect |
| --- | --- | --- |
| `OVIS_UPDATE_FEED=https://…` | build | electron-builder writes the feed into the app (`app-update.yml`) and `latest*.yml` beside the installers, to upload there |
| `OVIS_UPDATE_URL=https://…` | run | checks that feed instead |
| `OVIS_UPDATES=0` | run | no checks |

A development run never checks, and on Linux only the AppImage updates itself. The app checks after
it starts and every 6 hours, downloads in the background, and offers **Restart to Update** in the
tray. On macOS an update needs a signed app.

## Build

On the OS and CPU the app is for (no cross builds), from this folder:

```sh
bun install
bun test                     # unit tests (no Electron needed)
bun run typecheck
bun run dist                 # stage, bundle, then dist/Ovis-<version>-<arch>.AppImage, or .dmg and .zip
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

## Licenses

The app ships Ovis's own `LICENSE` and `THIRD_PARTY_NOTICES.md` in `resources/ovis/`,
herdr-core's and Bun's license files in `resources/ovis/licenses/`, Electron's and
Chromium's as electron-builder adds them, and the bundled npm packages' in
`out/THIRD_PARTY_LICENSES.txt`. [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md#ovis-for-the-desktop)
lists them.
