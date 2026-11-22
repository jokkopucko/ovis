# Ovis for Mac

Ovis on a Mac, downloaded from https://ovis.sh as `Ovis.dmg`. Once the Ovis server runs, the app
opens Ovis in its own window, as a native app. Until then, or when the server stops, the window shows
the one-click setup instead: it installs the server without a terminal and shows the QR code the
phone app scans.

It is a small SwiftUI app with no code of its own for installing: everything goes through what a
terminal user runs, so the two never drift apart.

## The Ovis window

The window is a WKWebView on the server's own address (`http://127.0.0.1:<port>`, from
`scripts/plugin.ts status`). The server lets a loopback request in without pairing, and the page's
cookies and drafts stay in the app's own WebKit store, apart from any browser's.

- **Ovis → Phone Setup…** opens the setup and the phone's QR code in a window of their own. After
  an Install from the app it opens by itself. **File → Open in Browser** opens the page as it is in
  the default browser, and **View → Reload** (Cmd+R) loads it again. No menu item takes a Cmd+Shift
  letter: those are the page's own shortcuts.
- The server's own pages stay in the app: a link that opens a new tab of it (a file) opens another
  Ovis window. A link to any other address goes to the default browser, and a file dropped where the
  page takes none is not opened in its place.
- Ovis's own downloads go to Downloads; a download from a site in a web panel opens in the default
  browser, which asks as it does for any site. A file field opens the file panel. The microphone
  (dictation) is the app's: macOS asks once, with the text in `Info.plist`, and a signed build
  carries the hardened runtime's `com.apple.security.device.audio-input` entitlement
  (`Ovis.entitlements`).
- The app checks the server every 3 seconds (`/api/health?scope=bridge`, which leaves herdr alone,
  and only Ovis's own answer counts, never through a redirect). A running page reconnects by itself when the server is back
  within about 15 seconds, keeping what was open in it, and says itself when the server it meets was
  updated; a page that did not load, or whose code never started, loads again once the server
  answers. When the server is still gone after about 15 seconds, the window shows the setup's Start
  (the page and what was open in it go), and it goes back to Ovis by itself once the server runs
  again, however it was started.
- When the server comes back on another port (7317 was taken), the window follows it. The page's
  storage belongs to its port, so the app reads the unsent drafts (the chat's draft, the terminal's
  held input, held messages) from the page it leaves and writes them into the new one before its
  code starts, over the older copies an earlier visit left there (unless a window the page opened is
  still open on that port: then they only fill gaps). Nothing is sent; the old port keeps its copy.
  Drafts move only between this Mac's own loopback addresses (`Resources/carry-drafts.js`); one that
  does not fit in the new page's storage stays in the app and is written on the next try.
- Another app's link (a site in a web panel can make one) asks before it opens that app, as Safari
  does, and only the Ovis page itself opens app windows.
- **Browser for links** (Settings → Chat → Files, the default browser unless chosen): the page's
  web links (`kind` link in `src/lib/externalLink.ts`) open in the app chosen there, from the apps
  LaunchServices opens https with, or agent-browser when its program is on the Mac (headed, in a
  session `ovis-links` of its own). The page reaches it through the `ovisBrowsers` bridge
  (`LinkBrowsers.swift`), from the Ovis page's own main frame only, and names an app by its id. When
  the chosen app is gone or cannot open the link, the default browser opens it.
- The user agent ends like Safari's, then `OvisMac/<version>`: the terminal's Korean input
  (xterm.js's Hangul handling in `patches/`) goes by "Safari", and the page treats the app as
  installed (`src/lib/nativeApp.ts`).
- A WKWebView has no web notifications or Web Push: the page's alerts setting reports them as
  unsupported here. macOS notifications from the app itself are a later step.

## Setup

| Button | What runs |
| --- | --- |
| **Install** | `install.sh`, downloaded fresh from https://ovis.sh/install.sh over HTTPS (following only a redirect to ovis.sh or herdrweb.dev, where it is served from), with `OVIS_NO_OPEN=1` and an empty stdin. Then a LaunchAgent, `~/Library/LaunchAgents/sh.ovis.herdr-server.plist`, runs `herdr server` at login. |
| Status (on open) | `herdr plugin list --json` finds the plugin, `scripts/plugin.ts status` gives its address, and `GET /api/access` gives the phone address, drawn as a QR code. The app asks only a loopback address, never through a redirect, and draws the code only for Tailscale's HTTPS name of this Mac (`https://<name>.ts.net`). |
| **Make the phone address** | `scripts/plugin.ts phone`, the installer's Tailscale step, from the code the server runs now. Settings → Updates runs newer releases from the state dir while herdr's checkout stays at the first one, so the app reads it from the processes: `plugin.ts status` names the launcher (`server/managed.ts` of this checkout), whose supervisor runs the bridge (`server/index.ts`) in the code's dir. When that cannot be read, or the dir is neither the checkout nor a `release-*` dir with its own `plugin.ts`, the checkout's runs. When it fails, the window shows its output. |
| **Restart** / **Start** | The plugin's `stop` and `start`, or the LaunchAgent when herdr is not running. herdr set up from a terminal has no LaunchAgent: Start then runs herdr for this login only and makes no login item. |
| **Remove** | The guide's Uninstall steps (`stop`, `herdr plugin uninstall`, `tailscale serve … off` for the HTTPS port Tailscale serves the app on, found with `tailscale serve status` when the server is down), then the LaunchAgent is disabled and deleted. A step that fails stops there and shows why; Try again goes on from it. |

Why a LaunchAgent: herdr runs the app from its startup hook, and a headless `herdr server` runs
startup hooks like the TUI's server does. A user who never opens a terminal still gets the app,
and a later `herdr` in a terminal attaches to that same server. herdr's output goes to
`~/Library/Logs/Ovis/herdr-server.log`; past 10 MB the app moves it to `herdr-server.log.1` when it
opens or starts herdr.

What it never does:
- It never boots out a loaded LaunchAgent, and Remove never stops herdr. That herdr may hold the
  user's agents, and stopping it would end them.
- It installs nothing system-wide and asks for no administrator password. install.sh installs for
  the user only.
- It is not in the Mac App Store: the App Store sandbox cannot install herdr, Bun or Node.

## Build

On a Mac with Xcode (the maintainer's test Mac, `ssh eamac`):

```sh
app/mac/build.sh                     # ad hoc signed, for a local try
(cd app/mac && swift test)           # the unit tests; no CI job runs them
OVIS_SIGN_IDENTITY="Developer ID Application: … (5987KT43TJ)" \
OVIS_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_<id>.p8 \
OVIS_NOTARY_KEY_ID=<id> OVIS_NOTARY_ISSUER=<issuer> \
app/mac/build.sh                     # signed, notarized and stapled, for ovis.sh
```

The output is `app/mac/build/Ovis.app` and `app/mac/build/Ovis.dmg`, a universal (arm64 and x86_64)
build for macOS 13 or newer. Only the Apple account holder can create a Developer ID Application
certificate; the API key can notarize with it.

To try it on a Mac without touching its user's herdr, give it an empty home. Foundation reads
`CFFIXED_USER_HOME`, and the LaunchAgent passes `HOME` on to herdr:

```sh
h=$(mktemp -d /tmp/ovish.XXXX)
open -n --env CFFIXED_USER_HOME="$h" --env HOME="$h" app/mac/build/Ovis.app
```

The LaunchAgent's label is the same for every home, so remove it after such a test:
`launchctl bootout gui/$(id -u)/sh.ovis.herdr-server`, then `HOME="$h" herdr server stop`.

## Releases

Every release gets a signed, notarized `Ovis.dmg` with no hand work. After the Release workflow
publishes `vX.Y.Z`, its `mac-dmg` job runs [mac-dmg.yml](../../.github/workflows/mac-dmg.yml) on a
GitHub-hosted Mac: it checks out the tag, imports the Developer ID into a temporary keychain, runs
`build.sh` with the version `X.Y.Z`, notarizes and staples the DMG, and attaches it to the release
as `Ovis.dmg`.

The site's Mac download button, `https://ovis.sh/Ovis.dmg`, redirects to
`https://github.com/devswha/ovis/releases/latest/download/Ovis.dmg`. So that it never lands on a
release without a DMG, Release publishes without marking the release latest, and this job marks it
latest once the DMG is attached (only when its tag is the newest `v*` tag).

The job needs these repository secrets (Settings → Secrets and variables → Actions):

| Secret | What it holds |
| --- | --- |
| `MAC_DEVELOPER_ID_P12` | The "Developer ID Application" certificate with its private key, exported from Keychain Access as a `.p12`, base64 encoded (`base64 -i developer-id.p12 \| pbcopy`). |
| `MAC_DEVELOPER_ID_P12_PASSWORD` | The password the `.p12` was exported with. |
| `MAC_NOTARY_KEY_P8` | An App Store Connect API key (`AuthKey_<id>.p8`, Users and Access → Integrations, Developer access), base64 encoded. |
| `MAC_NOTARY_KEY_ID` | That key's ID. |
| `MAC_NOTARY_ISSUER` | The issuer ID shown above the keys on the same page. |

Without all five the job skips with a notice naming the missing ones, and the release itself still
succeeds, but the previous release stays latest until it gets its DMG. To give a release its DMG
later (after setting the secrets, or when the job failed), run **Actions → Mac app → Run workflow** on `main` with the tag, or
`gh workflow run mac-dmg.yml --ref main -f tag=vX.Y.Z`. It replaces an `Ovis.dmg` already there.
