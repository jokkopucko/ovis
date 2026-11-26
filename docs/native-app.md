# Native app plan

Status: Phase 1 step 2 built for iOS (checked in a simulator) and Android (checked in an emulator),
2026-10-19. To run them, see [The app (app/)](#the-app-app) and
[The Android app](#the-android-app). Step 3, the push relay, is built in
[`push-relay/`](../push-relay/README.md) with its tests, 2026-10-23, for iOS (APNs) and Android
(FCM), and deployed at `push.ovis.sh` on 2026-10-24, where its APNs and FCM credentials passed
their authentication tests. Steps 4 and 5, the client's push through the app and the iOS
Notification Service Extension, are built, 2026-10-24 (see [Push in the app](#push-in-the-app));
a push received on a real device is still to be checked. iOS 1.0 (build 8) is on the App Store
since 2026-11-15 (<https://apps.apple.com/app/id6824664162>), and Android 1.0.1 (8) on Google Play.

Ovis ships as a store app for iOS first, Android later. The goal is reach: the app is
found in the App Store and installs in one tap, where the web app needs "Add to Home Screen". It
also opens the door to features a home-screen web app cannot have.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Stack | Capacitor | The UI stays the one React client. iOS terminal apps built in Swift or React Native (Blink, Hermit, PocketTunnel, Fressh) still draw the terminal in a WebView, so a rewrite would not change the core. React Native would rewrite every screen. |
| Where the code lives | `app/` in this repo | The app and the web client change together. App builds are not a required check. |
| Who serves the UI | The PC, as today | The UI and the server ship together, so they never disagree on the wire contract. The app holds only the native shell, the connect screen and the demo. |
| Notifications | In the first release, through an APNs relay | A WKWebView app gets no Web Push, so the app needs Apple's push service, and only a key held by the project can sign for it. |
| Notification privacy | End-to-end encrypted | The relay only forwards what it cannot read, as the telemetry Worker never reads what it does not need. |
| Builds | Xcode on the macbook | See the iOS QA notes; Capacitor needs a Mac for iOS. |

## How it fits

```
PC: Ovis server ──UI, API, WebSocket──▶ app WebView (the same client as the browser)
PC: server/push.ts ──encrypted push──▶ relay (Cloudflare Worker) ──▶ APNs (iOS) / FCM (Android) ──▶ app
```

### The app

- A native connect screen: scan the pairing QR or type the address, then load the PC's UI in the
  WebView. Pairing works as in a browser: the device keeps its HttpOnly cookie in the WebView's
  persistent store.
- A demo mode built from `site/demo`, for someone with no PC set up yet and for App Review,
  whose reviewers have no herdr PC.
- Native pieces the web client reaches through the Capacitor bridge: push registration first,
  then haptics, share, Face ID as needed.

### Notifications

The relay looks to `server/push.ts` like one more browser push service, so the PC keeps its
whole alert policy (the wait before an alert, no alert while a window is in use, per-device
choices) and changes little:

1. The app registers with APNs and gets a device token.
2. For each PC, the app sends the token and that PC's VAPID public key (`GET /api/push`, the key
   a browser passes to `pushManager.subscribe`) to the relay, which returns an endpoint URL
   holding an opaque ID for them (`https://push.ovis.sh/v1/push/<id>`). The token itself never
   leaves the relay. The app keeps that endpoint for the PC rather than registering again at
   every launch.
3. The app makes a P-256 key pair and an auth secret, keeps the private half in the keychain
   shared with its Notification Service Extension, and hands `{ endpoint, keys }` to the web
   client, which subscribes with it in place of `pushManager.subscribe`.
4. The PC encrypts each alert for those keys (RFC 8291, as today) and signs it with its VAPID key
   (RFC 8292). The relay pins the key given at registration to the endpoint and refuses any
   other, so knowing an endpoint is not enough to send to a phone. It also rate-limits per
   endpoint and per phone, and limits registrations.
5. The relay wraps the ciphertext in a `mutable-content` APNs push. The Notification Service
   Extension (a small Swift target) decrypts it and shows the title and body. A push it cannot
   decrypt shows a generic "herdr needs you" line.
6. APNs telling the relay a token is gone becomes a 410 to the PC, which already deletes a gone
   subscription.

The relay's code lives in this repo next to `telemetry/`, in
[`push-relay/`](../push-relay/README.md), open so anyone can run their own, and keeps no logs,
like the telemetry Worker. It answers at `push.ovis.sh`. Its APNs key is a secret of the
project's Cloudflare account (`APNS_KEY`).

Android takes the same steps through Firebase Cloud Messaging, in the same Worker: the app
registers its FCM token (`{ "service": "fcm", "token", "vapid_key" }`), the relay sends the
ciphertext in an FCM data message, which the app's
[`ovis-push`](../app/android/ovis-push/README.md) module decrypts, and FCM calling a token gone or
invalid becomes a 410 as well. One service calling a token gone never deletes the other's endpoints. The
relay's FCM credentials are a service account key of the app's Firebase project, the secret
`FCM_SERVICE_ACCOUNT`; without it the relay takes no FCM token.

## Phase 1: first store release

1. Spike on the macbook: does a page loaded from the PC's address get the Capacitor bridge?
   Done 2026-10-19, see [Spike results](#spike-results-2026-10-19): it does, and the PC's
   page must be the WebView's first page, not one a bundled page navigates to.
2. `app/`: Capacitor project, connect screen, QR scan, demo mode. Built 2026-10-19, see
   [The app (app/)](#the-app-app). QR scanning still needs a physical iPhone (the simulator
   has no camera).
3. Relay Worker with tests (VAPID pinning, rate limit, gone tokens). Built 2026-10-23 in
   [`push-relay/`](../push-relay/README.md), at `push.ovis.sh`. Deployed 2026-10-24 with its D1
   database, APNs and FCM credentials, which passed their authentication tests; a push received
   on a real device is still to be checked (`push-relay/test-push.ts`).
4. `src/lib/push.ts`: subscribe through the native bridge inside the app. Built 2026-10-24, on
   iOS and Android alike, see [Push in the app](#push-in-the-app).
5. Notification Service Extension that decrypts. Built 2026-10-24 (`OvisNotifications`), see
   [Push in the app](#push-in-the-app).
6. App Store listing, privacy answers, review notes pointing at the demo mode. Version 1.0
   (build 8) was submitted for review on 2026-11-08 and released on the App Store on 2026-11-15.

## Phase 2 and later

- Live Activity for a running agent, home-screen widgets (both need Swift, and pushes through
  the same relay).
- Android pushes. The relay's FCM route, the app's receiving module
  ([`ovis-push`](../app/android/ovis-push/README.md)) and the client's subscribe through it (step 4)
  are built, and the relay is deployed with its FCM credentials. A release build needs
  `google-services.json` from the Firebase project (see that README). The Android app itself exists
  already (see [The Android app](#the-android-app)): the maintainer tests on a Galaxy, not an
  iPhone.
- Speed: measure what is slow before changing anything. The PC still serves its own UI at its own
  address; the hosted shell (relay PCs, home) is carried in the Android app since 2026-11-24 (see
  [The bundled shell](#the-bundled-shell-android)) and in the iOS app (see
  [The shell inside the app](#the-shell-inside-the-app-ios)).

## Spike results (2026-10-19)

Run on the EA MacBook (macOS 27.0.1, Xcode 27.0) in an iPhone 18 Pro Simulator on iOS 27.0, with
Capacitor 8.5.3 and `@capacitor/device` 8.0.3, in a throwaway app outside the repo. The page
under test was the demo build of the client (`bun scripts/demo-build.ts`), served from this PC's
Tailscale address over `http`, and over `https` through `tailscale serve`. Each page posted its
own measurements back to that server. Times are simulator runs, not a phone.

- **The bridge reaches the PC's page.** It works for a page the bundled page reached with
  `location.replace` (its host listed in `server.allowNavigation`) and for a page set as
  `server.url`, over `http` and `https`. In both cases `Capacitor.isNativePlatform()` was true
  and `Device.getInfo()` answered. The spike allowed plain `http://` with `NSAllowsArbitraryLoads`.
  The app allows it with the narrower `NSAllowsArbitraryLoadsInWebContent` and
  `NSAllowsLocalNetworking`.
- **The app has no service worker.** In the app's WKWebView, `navigator.serviceWorker` is missing
  even on `https`, where `isSecureContext` is true. Safari on the same simulator registers one at
  the same URL. The worker does register once `ios.limitsNavigationsToAppBoundDomains` is set and
  the host is listed in `WKAppBoundDomains`. But then a host missing from that Info.plist list
  (10 at most) does not load at all: the Tailscale IP gave a blank view. Users' PC addresses are
  not known at build time, so the app runs without the worker.
- **Navigating from the bundled page costs about 1.5 s.** The PC's page loaded quickly, but its
  first script ran 1487-1514 ms after navigation start, against 42 ms in Safari. This happened
  in Debug and Release builds alike, and JavaScript speed was the same in both. Loaded as the
  WebView's first page (`server.url`), the same page ran its first script at 51-62 ms.

| Real client, from launch | First paint in the page | Launch to painted client |
|---|---|---|
| App, PC page as the first page (`server.url`) | 262-304 ms | 4.7-4.8 s |
| Safari | 284-336 ms | 4.9-5.3 s |
| App, bundled page navigating to the PC | 1629-2044 ms | 6.6-7.5 s |

The simulator starting the app or Safari takes most of the launch time. No run, Safari's
included, had the client's service worker in control, so the table compares page loads with
the browser's HTTP cache only.

What this changes:

- The connect screen must not reach the PC by navigating from JavaScript. It saves the address
  natively, and the app opens it as the WebView's first page. Capacitor 8.5.3 leaves room for
  that: `CAPBridgeViewController.instanceDescriptor()` is `open`, and the descriptor's `serverURL`
  is what `server.url` sets. A subclass can fill it from the saved address. This is the same
  path `server.url` takes, so the "live reload only" warning is about a URL fixed at build time.
  `app/` builds that subclass (see [The app (app/)](#the-app-app)).
- Inside the app the client has no service worker: no offline shell, and push only through the
  native route. `src/pwa.ts` and `src/lib/push.ts` already check for `navigator.serviceWorker`
  (`pushSupported()`), so the client runs without it. Step 4 adds the native route beside them.
- Not tested in the spike: keyboard and IME in the app, and a physical iPhone. The pairing
  cookie surviving a restart was checked later, with `app/`.

To repeat it:

1. Build the demo client into a directory.
2. Serve it from a small Bun server on the Tailscale IP, plus a loopback port behind
   `tailscale serve --bg --https=<port>`.
3. Make the app with `npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/device`,
   `npx cap add ios`, then build and install it with `xcodebuild -sdk iphonesimulator` and
   `xcrun simctl install`.
4. Launch with `xcrun simctl launch` (Safari: `xcrun simctl openurl`) after recording the Mac's
   clock. The page reports `Date.now()` and its navigation timing once `#root` has painted.

## The app (app/)

What is there:

- `app/web`: the app's own pages, in the hosted Connect a PC screen's look (the Codex theme's colours, light or dark as
  the phone is, and the hosted page's type, radii, buttons and rows: `shell.css` copies the values from `src/styles.css`
  and `src/components/RelayShell.css` / `RelayAddPc.css` and names each source; `pretendard.css`, which
  `build-web.ts` writes, points the hosted typeface at the font files the bundled demo already carries). `index.html`
  holds two layouts and `connect.js` takes one by the build (`APP_HOME` in `shell.js`):
  - In a hosted-home build (the default) the page is no first screen: it stands in when home does not load and takes
    what only the app can do (see [The first screen](#the-first-screen)). It is one column of what works with no
    internet. As the fallback it says "Can't connect to the internet" with Try again (`goHome`), the sheep dimmed;
    then Connect by address, one field that takes any PC's address as the Tailscale tab's field and Add by address did
    (the public-http warning, `demo` for the bundled demo, and on Android, while Tailscale is off and a Tailscale
    address is typed or listed, one line with Open Tailscale); Scan a QR code (a Tailscale QR or a PC's QR still opens
    on a home network); Connect over SSH, a row whose field takes `user@host` and opens the SSH setup (only in an app
    that announces `OvisSsh`); the PCs an SSH PC knows; and every PC this phone saved, relay scopes (by name, else the
    start of the id), Tailscale, plain addresses and SSH, in one list, each opening as before, with Forget, and Manage
    on an SSH PC. No sign-in and no relay tab: both need the internet and the hosted page. Opened to manage an SSH PC
    (Change PC where one did not open) it opens that PC's Manage (the one last opened, else the only SSH PC), with
    "‹ Back" to home.
  - In a bundled-home build (`OVIS_APP_HOME=bundled`, or `OVIS_APP_ACCOUNT=0`) it is the first screen, Connect a PC with
    the desktop's Add a connection tabs in its order, picked without a history entry (the phone's Back leaves the app):
    Ovis relay (the default; the sign-ins the account service names at `/v1/providers`, a press opens the hosted app
    on that sign-in, `#sign-in=<provider>`, and Scan the QR on the PC's screen), Tailscale (the PCs this phone opened
    at a Tailscale address, with Connect, a Tailscale address and Scan a QR code; on Android, while no interface holds
    a Tailscale address, one line and Open Tailscale alone) and SSH (SSH's `user@host` first, which opens the SSH setup
    filled in, only in an app that announces the `OvisSsh` plugin; Add by address, a text link to a field for a PC's
    https address; then the PCs added over SSH, and those opened before at any other address, each with Forget, an SSH
    PC with Manage, and one saved unreadable with Forget alone). The relay and Tailscale tabs list their own PCs opened
    before. A build with `OVIS_APP_ACCOUNT=0` has no relay tab and opens on Tailscale.

  In both, the PC a page was opened from to choose another is marked In use now, and "‹ <PC>" goes back to it. The
  address `demo` opens the bundled demo, which has no button of its own: the store review notes (app/store) send
  reviewers there. `error.html` is shown when a PC cannot be reached or answers with an HTTP error (a 502 from
  `tailscale serve` while Ovis is stopped), with the reason, Try again and Change PC, in the same look; it stands alone
  on Android, so `build-web.ts` puts `shell.css` and the sheep into it. When the phone's own connection failed, as its
  platform says (Android's WebView error `net::ERR_INTERNET_DISCONNECTED`, the iPhone's `NSURLErrorNotConnectedToInternet`,
  passed as the failure's kind `offline`, `Home.failureKind`), it says "Can't connect to the internet" with Try again and
  Change PC, and nothing about the PC. A raw `net::ERR_…` is never shown: the common ones are said in words, any other
  as "could not be opened". A failure of the hosted app itself (the current PC is its origin, `app` in the page's state)
  is "Can't reach Ovis", never "this PC". Every page sets its `theme-color` to its own
  colour, light or dark (`barsFor` in `shell.js`, copied into `error.html`), which both apps' bars follow; a PC still
  opens on the dark one until its page gives its own. The native parts around them take the same colours, light or dark
  as the phone is: the covers ("Opening…", Try again, Change PC: `MainActivity.showOpening` with `res/values*/colors.xml`,
  `HerdrBridgeViewController.showOpening`), the web view before a page paints (Android's window background,
  iOS's `instanceDescriptor().backgroundColor`), Android 12's launch screen and the SSH setup screen
  (`SshSetupActivity`, `SshSetupView`). The iOS launch image (`Splash.imageset`) is unchanged. Both are in English and Korean, the Korean in 해요체 and in the
  hosted page's words for the same things: an element's `data-ko` attribute holds its Korean text, put in when the
  phone's first language is Korean (`localize()` in `shell.js`; `error.html` carries its own copy, as it stands alone
  on Android). The iOS app lists `ko` in `CFBundleLocalizations`, without which its web view reports English to every
  page, the client included.
- A PC joins the list of PCs only once a page of it has loaded, so an address that never
  answered, or answered with an HTTP error, is not kept.
- On Android an address typed, scanned or picked from the list is first asked whether it is Ovis
  (`PCStore.check`, through the `check` option of `HerdrShell.open`): its
  `/api/health?scope=bridge`, which every Ovis since 0.1 answers with `ok` and `auth`, or the
  hosted app's `<meta name="ovis-shell">` on that answer or on its page. It is "not Ovis" only when
  its page loads while its `/api/health` answers 200 or 404 with something else. A redirect (a
  sign-in in front of the PC) and an answer that does not tell (401, 403 or 429 from a proxy or WAF,
  502 from `tailscale serve` while Ovis is stopped) are left to the WebView, as before. For up to 20 seconds the connect screen says what it
  opens, with Cancel; an address that is not Ovis, refuses, is not found or does not answer stays
  on the connect screen with why (`openFailure()` in `shell.js`). A relay link and the account's
  front page open without it. The iOS app opens at once, as before.
- A PC paired over the Ovis relay opens from its pairing link, scanned or pasted:
  `https://app.ovis.sh/s/<server_id>/#offer=...` (`relayLink()` in `shell.js`). Only the hosted
  shell's origin may carry an offer: one on any other origin is refused on the connect screen,
  as is an offer that names another PC than its path. The app opens the link as the WebView's
  first page, like any PC (the offer stays in the fragment through
  `instanceDescriptor().serverURL` on iOS, a 2026-10-30 Simulator spike, and through the start
  path on Android), and the hosted shell pairs from there. The QR code of a PC already in an
  account, `https://app.ovis.sh/s/<server_id>/#sign-in=<provider>`, opens the same way with its
  fragment kept: the hosted shell signs in with that provider (the app's own sheet), then joins
  the PC as a device of the account. Every relay PC shares that origin, so
  the app saves it by its scope (`https://app.ovis.sh/s/<server_id>/`) and labels it with the
  offer's `name`; a PC opened at its own address is still saved by its origin, and lists saved
  before keep their entries as they are. The allowed host (iOS) and the bridge's origin
  (Android) follow the PC opened, so a relay PC gets the shell's origin and nothing else.
  A page belongs to a relay PC only within its scope as a browser would load it: a path with a
  `.` or `..` segment (plain or percent-encoded), an encoded `/` or a `\` is refused, so
  `<scope>../<other server_id>/` cannot pass for this PC (`PCStore.cleanPath` on Android,
  `ScopePath.swift` on iOS; on a Mac, `swiftc app/ios/App/App/ScopePath.swift
  app/ios/ScopePathCheck/main.swift -o /tmp/check && /tmp/check` runs its checks).
  `error.html` says when the relay could not be reached. A test build points at another shell
  with `OVIS_APP_URL=https://<host> bun run build:web`. The native code then takes that origin
  from the same run (`app/scripts/hosted-origin.ts`): Android's `BuildConfig.APP_ORIGIN` and iOS's
  `OvisAppOrigin` (Info.plist), each `https://app.ovis.sh` otherwise; its host may hold only
  letters, digits, dots and hyphens. A build whose copied pages name another origin than that
  fails, so `bun run build:web` for one platform cannot leave the other packaging mismatched pages:
  Gradle's `checkHostedOrigin` before any asset merge, and the App target's "Check the hosted
  origin" phase (`app/ios/check-hosted-origin.sh`). Android's verified app link stays on
  `app.ovis.sh`.
- Both apps allow plain http to any host, as Android cannot limit cleartext to address ranges.
  Before opening plain http to an address outside a tailnet, a home network and the phone (one not
  in the list of PCs yet), the connect screen warns that the pairing code and everything typed
  would cross the internet unencrypted, and opens it on a second try (`publicHttp()` in
  `shell.js`).
- Capacitor's own log is off (`loggingBehavior` in `capacitor.config.json`, and
  `setLoggingEnabled(false)` on Android): it writes the first page's address, a pairing link's
  code included, and on Android every plugin call's arguments. Debug builds keep the web
  inspector.
- `app/scripts/build-web.ts` (`bun run build:web` in `app/`) puts those pages and the demo,
  built from this checkout's client, into `app/www` for Capacitor to copy.
- `app/ios/App/App/HerdrBridgeViewController.swift`: a Capacitor view controller that opens the
  chosen PC as the WebView's first page (`instanceDescriptor().serverURL`). It also lets the
  PC's whole host stay in the app and shows `error.html` when the first load fails. Until the
  PC answers, a native cover says which PC is opening and offers Change PC; when a PC
  sends no answer within 20 seconds, the cover itself says so, with Try again and Change PC, and
  for a Tailscale address that Tailscale may be off on the phone, or for a public server that it
  may be down or out of the phone's reach (WebKit alone waits a minute or
  more, which is what a phone with Tailscale off sees for a `.ts.net` address, and while that
  connection hangs it did not paint the error page either). A PC that answered is never cut off
  (`OpeningWatch`): the cover stays until the client is up (its root no longer holds index.html's
  loading spinner), with a bar filled from the web view's `estimatedProgress` (it never goes back
  and stops at 95 %); after 5 s it says the connection is slow, with Try again. iOS has no count
  of the bytes received, and `estimatedProgress` holds still while one large file arrives (about
  40 % through the client's script at 10 KB/s), so iOS never claims a stall as Android does, and a
  TLS handshake still under way at 20 s counts as no answer. When a Tailscale address fails to
  load, `error.html` (on Android too) adds the same note. A redirect of the address being opened
  to another origin is handled as on Android (see [The Android app](#the-android-app)), where
  Capacitor would send another host to Safari, except a sign-in in front of the PC: on iOS one
  that does not answer as Ovis still ends on the error page.
  WebKit has no public mark for a redirect, so until the first page commits,
  `NavigationFailureProxy` takes any main-frame action to another origin that comes while the
  main frame's navigation has not committed for one. Its question to `/api/health` is a
  `URLSession` request, which App Transport Security keeps to https and local names (`localhost`,
  `.local`, a one-word name): a redirect to plain http on a tailnet address or name ends on the
  error page, which names the address to open directly (the web view itself may load it). The
  `HerdrShell` plugin (`HerdrShellPlugin.swift`) opens, forgets and leaves PCs. Opening or
  leaving one builds a fresh view controller, so the next page is again a first load, and the old
  one goes with its web view. `@capacitor/barcode-scanner` kept every old one alive (its scanner
  manager holds the view controller, which holds the bridge and the plugin), so
  `app/patches` makes that manager for each scan instead of keeping it.
  `HerdrBridgeViewController` also hides WebKit's form accessory bar (the up and down arrows and the check mark over the
  keyboard), as `@capacitor/keyboard`'s `hideFormAccessoryBar` would, without that plugin or its
  patch of WebKit's private content view: its web view is a `WKWebView` subclass whose
  `inputAccessoryView` is nil, which WebKit asks for since iOS 13. The client has its own key bar,
  and a page cannot remove WebKit's.
- On iOS the status bar's icons follow the page, as the bars do on Android (see
  [The Android app](#the-android-app)): a document-start script tells the app the page's
  `<meta name="theme-color">`, once the document is read and whenever it changes, and
  `HerdrBridgeViewController` shows dark icons on a light colour and light ones on a dark colour, at
  the luminance Android draws the line at (`Bars` in `app/ios/OvisHomeCore`, `swift test` there). A
  page with no readable colour (anything but `#rrggbb`) keeps the app's own light icons, the
  `SystemBars` style of `capacitor.config.json`. While a native cover is over the page, the cover's
  own colour decides. A new document starts with nothing said: until it has read its colour, the
  web view's own background colour decides, which is what shows before a page paints; a load
  that has not replaced the page yet changes nothing. Before this the icons were light on every PC
  and on the hosted app whatever the theme, so white on white in a light one; only the app's own
  pages set them, through `SystemBars`.
- In the client, `src/lib/nativeApp.ts` notices the app through `window.Capacitor`, as the app
  injects it; the browser build carries no Capacitor code. Inside the app:
  - Settings → Phone & devices has a Change PC row, and so does the pairing screen (a PC that
    asks for pairing would otherwise leave the app no way out).
  - The app counts as installed, so Install app is not offered.
  - Alerts are pushed through the app (see [Push in the app](#push-in-the-app)).
- The app is called Ovis (Latin for sheep, the herd herdr tends). Other apps in both stores are
  already named Ovis, so the store listing can say "Ovis for herdr". The project owns `ovis.sh`,
  so the bundle ID and Android application ID are `sh.ovis.app`.
- The icon is a cream sheep with closed eyes on a navy tile (`#2E3A59`), cut from the Figma
  logo drafts; `app/assets/ovis-sheep.png` is the sheep alone. The app's own pages show the
  sheep (`app/web/ovis-sheep.svg`), as the hosted screens do; `app/web/ovis-logo.png`, the sheep beside the word Ovis,
  is the Mac app's connect screen's (app/electron). The PNGs in `app/assets` are
  the sources for both platforms' icons and splash screens. After changing them, run
  `npx @capacitor/assets generate --ios --android --iconBackgroundColor '#2E3A59' --splashBackgroundColor '#12100e'`
  in `app/`, and put back `AndroidManifest.xml` if the tool reformatted it.

Build and run it on a Mac with Xcode:

```bash
bun install                 # in the repo: the demo build needs the client's packages
cd app && bun install
bun run sync                # build:web, then cap sync ios
bun run open                # opens ios/App/App.xcodeproj in Xcode
```

In Xcode, pick a simulator and press Run. For a physical iPhone:

1. Under the App target → Signing & Capabilities, choose your team. Change the bundle ID if
   Xcode says it is taken.
2. Connect the iPhone, or pair it over Wi-Fi under Window → Devices and Simulators. Turn on
   Developer Mode on the phone when it asks, then pick it as the run destination and press Run.

The app and its Notification Service Extension share one version: Xcode and App Store Connect flag
an extension whose version or build number differs from its app's. `MARKETING_VERSION` (the version
people see) and `CURRENT_PROJECT_VERSION` (the build number) are set once, in the build settings
of the App project rather than of a target, and both targets take them from there. Raise
`CURRENT_PROJECT_VERSION` for every upload. Version and Build in a target's General tab set
them on that target alone, so change them under the project's Build Settings instead.

What was checked on 2026-10-19 (iPhone 18 Pro Simulator, iOS 27.0, a Debug build), against a
server on an isolated herdr session:

- The first launch shows the connect screen. Opening the server's address loads the client as
  a first load (Capacitor logs "Loading app at http://…").
- With the server's gate closed, a pairing link (`…/?pair=CODE`, what the PC's QR code holds)
  typed into the connect screen paired the app; the PC listed it as a device. After the app was
  quit and started again, it opened the client without asking again.
- Settings → Phone & devices shows Change PC only in the app; a desktop browser at the same
  address does not have it. Change PC, from Settings, the pairing screen or the demo, goes back
  to the connect screen with the PCs kept.
- Try the demo opens the bundled demo with no server.
- A closed port shows `error.html` with the system's reason ("서버에 연결할 수 없습니다.").

The simulator had no touch input from a script: the Mac's Accessibility access is not granted
to ssh, and Homebrew refuses idb's tap. The checks drove the pages through Web Inspector
instead: `ios_webkit_debug_proxy` on the simulator's `webinspectord_sim.socket`, then
`Runtime.evaluate` through WebKit's `Target.sendMessageToTarget`. Buttons were clicked and forms
submitted from JavaScript. A QA server must be pointed at a test herdr session on purpose.
`bun run check run … bun run server` is not enough: check.ts drops `HERDR_SOCKET` for its
tests, and the server then falls back to the default session, the user's. Preloading
`scripts/test-herdr.ts` (`bun --preload <file that imports it> server/index.ts`, with
`HERDR_TEST_SESSION` and `OVIS_STATE_DIR` set) gives the server the test session.

Still open:

- **A plain `http://` PC loads about 1.9 s slower than an `https` one, in Safari too.**
  Measured on 2026-10-20 by wall clock, from the moment the server got the page's request to
  the page's first script, on one Mac's clock: 1.9 s over `http` (an IP or a MagicDNS name
  alike) and 44 ms over `https` through `tailscale serve`, in the app and in the simulator's
  Mobile Safari alike; a macOS `WKWebView` took 220 ms and 11 ms. Navigation timing hides the
  wait (it starts after it), which is why an earlier note had Safari at 100 ms. It is WebKit's
  plain-http path, not the app: it is not App Transport Security, not the https-first upgrade
  (no TLS attempt reached the port, and serving 443 changed nothing), and not Safe Browsing
  (`isFraudulentWebsiteWarningEnabled = false` changed nothing). The connect screen suggests
  https, on iOS only: Android has no such delay.
- Not tried: QR scanning (needs a camera), keyboard and IME in the app, a physical iPhone,
  Release signing.

### The first screen

With no PC to open, the app opens the hosted app's Connect a PC screen, `<hosted origin>/#pcs`, called
home here: on a first launch, after Change PC or Forget, and from a PC's Connect a PC (choosing, which
keeps that PC to go back to). A saved PC still opens directly at every start. Home opens as a PC's first
page does, so it has the bridge, but it is not made the current PC: nothing is written until a PC is
picked. The app's own page (`app/web/index.html`) stands in when home does not load. The decisions are
pure functions, `Home.java` (`HomeTest`) and `app/ios/OvisHomeCore` (`swift test` there on a Mac);
`MainActivity` and `HerdrBridgeViewController` only carry them out.

What opens (`Home.screen`), first match:

| When | Screen |
|---|---|
| Something waits that only the app's own page takes (a pairing link from outside the app, an SSH PC whose address another app holds, an SSH PC to manage) and no PC is to open | the app's own page |
| The demo was asked for (`HerdrShell.openDemo`, or `demo` typed where an address goes) | the bundled demo |
| A PC is current and the person is not choosing another | that PC |
| Home failed in this process and was not tried again, or the build has `OVIS_APP_HOME=bundled` | the app's own page |
| Otherwise | home |

While home is up (`Home.on`):

| State | Event | What happens |
|---|---|---|
| loading (cover: "Opening Ovis…", no Change PC) | the hosted app drew its own screen (`Home.drawn`) | the cover lifts: shown |
| loading | the main frame failed, answered with an HTTP error, or was redirected to another origin | fallback |
| loading | 8 s in front with no answer, or 20 s once a page had answered without becoming the hosted screen | fallback |
| shown | a main-frame load failed, whenever (a PC's row pressed with the network gone, a later document that broke off) | fallback |
| loading, shown | the web view arrived at a relay PC's page (`/s/<server_id>/…`, the page's own link) while the current PC is still the one home opened over | the hosted app becomes the current PC and choosing ends; that PC is saved by its scope once its page loaded; from here on the rules of a PC's page hold |
| loading, shown | a PC picked through `HerdrShell.open` (Tailscale, SSH, an address) | that PC opens, as before |
| loading, shown | the app is told to open something else (a PC picked, a notification tapped, Try again): left | nothing the page still does counts, and its clock stops |
| loading, shown (iOS) | the page's web content process died | home once more from the start, cover and clock; a second death before it came up: fallback |
| fallback, left | anything that still arrives | nothing |

Home is up only when its page is the hosted app's and has drawn: it carries `<meta name="ovis-shell">`
(the released front page and the next both do) and its `#root` holds what the client rendered, no longer
index.html's loading spinner. An empty 200 or another page of that origin never lifts the cover, so the
clock runs on to the fallback. Only time in front counts against it (`Home.Clock`): nothing is added
while the app is behind another, though its timer may run on there. In an Android build that carries the
shell ([The bundled shell](#the-bundled-shell-android)) home is the app's own copy at the same address: it
waits on no network, so it gets no 8 seconds for an answer, and once the 20 seconds a PC gets are up its
cover lifts over whatever it shows (`Home.timedOut(…, bundled)`, `Home.clockRanOut`) instead of the app's own
page taking its place; a main-frame failure there still gives way to the app's own page.

Fallback: the flag `homeFailed` is set, in memory only, and the app's own page comes up in a new web
view (the old one goes, so a load that finishes late cannot take the person off what they type). The page
reads `fallback` from `HerdrShell.getState` and says "Can't connect to the internet" at its top, with
Try again, which calls `HerdrShell.goHome` (in a hosted-home build the page is the one column of what works offline,
[above](#the-app-app)). Nothing else leads back to home by itself, so an offline phone
stays on that page: the flag is cleared only by Try again, by a sign-in pressed there (below), or once a
PC's page has loaded, after which the next Connect a PC tries home again. An app started again tries
home. On iOS, in a hosted-home build, the app's own page is watched too (`Home.ownPageCover`,
`Home.ownPageStalled`): until the page answers that it is up, a native cover says "Opening Ovis…" with
Try again once a second and a half has passed, and the web view is built again after 6 s, then 12, 24
and 48, so the page that stands in can never itself be a dark screen with nothing on it. That was seen in
a just-created simulator on a starved Mac: every web view committed its page and its content process
then ran nothing more, home first and the app's own page after it, with the app's main thread idle.

The hosted app's front page asked for by its address is an attempt at home, not a PC (`Home.homeStart`):
the sign-in buttons of the app's own page (a bundled-home build's tabs; the column has none) open
`<hosted origin>/#sign-in=<provider>`, and the hosted origin typed or scanned opens `/#pcs`, through `HerdrShell.open`, which in a hosted-home build starts home at that fragment, keeps
the current PC and falls back like any other attempt. A PC's page there (`/s/<server_id>/…`) still opens
as a PC.

Change PC where an SSH PC did not open (the cover's, error.html's) leads to the app's own page with that
PC's Manage open (on the SSH tab in a bundled-home build), not to home: error.html sends the person to Manage
there (Forget host key, Set up again), which the hosted screen has not. An SSH PC's tunnel failing while the person chooses another way does not put
its error page over home or the app's own page: only over that PC's own page (`Home.pcShown`). The same
rule keeps a page that is not a PC's from the current PC's push subscription on iOS (Android keys it by
the page's own origin).

Back (`Home.back`, the phone's Back on Android; `getState`'s `back` tells a page where its own back
control leads, `"current"`, `"home"` or `""`): the page's own history first; with nothing behind it, home
opened while choosing goes back to the current PC (`backToCurrent`); the app's own page goes back to the
PC it was opened over when one is still current (a pairing link it refused), else to home when home
handed over to it; the demo is left for the screen it was opened over, the current PC kept; otherwise Back
leaves the app. The app's own page while choosing goes back to the PC at once, as it always did. An app
killed while choosing opens the current PC at its next start, as before: choosing is kept in memory only.

`HerdrShell` gained `goHome` and `openDemo` on both platforms, and `getState` the fields `home` (the
page asking is home), `fallback`, `back` and `manage`. On home, `open` takes `https://demo/`, what the
word `demo` becomes in the hosted screen's address field, as the bundled demo; the app's own page asks
`openDemo` itself where it stands in for home. `openSshSetup`, and `OvisSsh.add` called by the hosted
app's own page (the released front page does), bring the SSH setup up over home itself (see [PCs over
SSH](#pcs-over-ssh)): Back or Cancel there is home again as it was, and the current PC is untouched. A pairing link tapped outside the app (Android) still waits for the app's own page, which
checks it and opens its PC.

`HerdrShell.appId` (Android) answers `{ id }`, the application id the build was made as. The client reads it once
for one thing: only the QA twin (`sh.ovis.app.previewqa`) may turn the waits of moving an account onto its signed list
down ([account-list.md](account-list.md), "In the app"); every other build, a browser and an app that does not answer
wait the full time.

`HerdrShell.identify` (both platforms) lets a PC's own page say which PC it is: its relay ID, as its own
`/api/health` gives it to that page (`web_ui.server_id`, authenticated only; `""` once a health read names none, which
drops the one kept), and its name (64 characters at most, counted as grapheme clusters on both platforms,
`Home.capped`). The app keeps them (`ids`, and the name only where it keeps none) for the saved PC it shows, and only
when the page loaded now is on that PC's own address (`Home.identifiedKey`): never for a relay PC's scope or the
hosted app, never for another saved PC; iOS reads and writes them on the main thread, as it writes names elsewhere.
`getState` hands `ids` to the app's own pages alone (the hosted app's origin and the bundled page, `Home.shownIds`),
so home's My PCs lists a PC saved by the relay and by its Tailscale address, over SSH or at another address as one row.
That is for the eye alone: a row with a relay way opens by the relay, never by a saved address. A PC's page reads no
other PC's ID. A saved PC gains its ID the next time its page loads in an app with `identify`; an older entry has none
until then and stays a row of its own. Any frame of a PC's page can call `identify` (on iOS Capacitor takes posts
from any frame; on an Android WebView without `WEB_MESSAGE_LISTENER` every frame has the bridge), as it can `open` and
`forget`: a frame that claims a wrong ID only puts that address on another PC's row, which it cannot open or rename.

Known limits: the bridge's reach is what it is for every PC's page (on iOS by host and into subframes;
on an Android WebView without `WEB_MESSAGE_LISTENER` every frame), and home adds no new kind of caller. On
iOS the hosted page has to draw the way back from home while choosing (`backToCurrent`); a hosted page
that does not leaves none. On Android a renderer that dies under home is Capacitor's to handle, as under
any page.

`OVIS_APP_HOME=bundled bun run build:web` builds an app whose first screen is its own page, as before
home existed (`BuildConfig.HOME_HOSTED`, `OvisAppHome` in Info.plist, through the files
`app/scripts/hosted-origin.ts` writes). The pages carry the value too (`APP_HOME` in `shell.js`), and the
packaging checks that compare the hosted origin compare it as well, so the pages of one build are not
packaged with the first screen of another. A build with `OVIS_APP_ACCOUNT=0` takes that too unless it sets
`OVIS_APP_HOME=hosted`.

### The shell inside the app (iOS)

A build made with `OVIS_APP_SHELL=bundled` (the default without `OVIS_APP_URL`, so what a store build is) carries the
hosted app's files, the shell, and serves them itself: nothing of the shell is loaded from the network. `bun run build:web`
packs a release's verified archive, a folder or a build of the checkout into `app/bundled-shell` (`packShell` in
`app/scripts/bundled-shell.ts`, the one copy both apps carry, [The bundled shell](#the-bundled-shell-android)):
`shell/`, the files, `shell-policy.json`, the two policies read from that copy's own `_headers`, and
`shell-provenance.json`, where it came from. The App target's "Carry the shell" phase copies that folder into the app
(`app/ios/carry-shell.sh`; no folder reference in the project, as a hosted build has no such folder). A build made with
`OVIS_APP_SHELL=hosted` (the default with `OVIS_APP_URL`: the owner's preview app, the QA twin) loads the shell from
that origin as every build did before.

- **Where.** WebKit gives an app no http or https address of its own, so the shell is at the hosted origin's host on the
  app's scheme: `capacitor://app.ovis.sh` (`Home.shellOrigin`; `PCStore.shellOrigin` is what every gate compares a page
  with, and in a hosted build it is the hosted origin itself). The app's own pages (`app/web`) stay at
  `capacitor://localhost`. The two are told apart by their host, which a page cannot choose (`Home.bundledPage`,
  `Home.shellFrame`), compared as it is written and with no port: to WebKit `capacitor://APP.ovis.sh` is another origin,
  with storage of its own. That is another origin than `https://app.ovis.sh`, so what the hosted app kept there (the
  sign-in, this phone's device keys, its pairings) is out of the shell's reach: a person who updates signs in once
  more, and pairs a PC paired without an account again. Nothing of the old origin's storage is deleted.
- **Serving** (`ShellHost.swift`; `ShellRoute` and `ShellAnswer` in `OvisHomeCore`, where each answer's status, type
  and policy are decided and tested). A request for the shell's host is answered as the hosted app's host answers the
  same path (`shellRedirects` and `shellHeaders` in `scripts/shell-build.ts`): `/` and everything under `/s/<id>/` is
  the page; `/s/<id>/~render` is the render host's document, never the page, and only in a frame (asked for as the
  page the web view shows itself, it is a 404); `/s/<id>/manifest.webmanifest` is the manifest; a file is served by
  its path under its own Content-Type; a path with no file is the page, except under `assets/`, where it is a 404;
  `sw.js`, `_headers`, `_redirects`, `.well-known/`, the two documents by their own names, a path with an escape or
  a `.`/`..` segment, and Capacitor's own `/_capacitor_file_` and `/_capacitor_http_interceptor_` are 404 (the web
  view has no service worker; the last two would read the app's files and fetch any address for a page). Every answer
  carries the shell's policy as a `Content-Security-Policy` header, the render host's answer its own instead
  (`sandbox allow-scripts; default-src 'none'; …`): a `<meta>` cannot carry `sandbox` or `frame-ancestors`, so it is a
  header or nothing. A shell whose policies are missing is not served, nor one whose render policy does not take a
  page's origin away: it must hold `sandbox`, and no `allow-same-origin` in it (`ShellRoute.sandboxed`). A file that
  is there and cannot be read fails the request.
- **The app's own host answers only its own pages.** Capacitor answers `capacitor://localhost` with the file at its
  pages' folder plus the request's path once decoded, typed by its extension and with no policy, and with any file of
  the phone under `/_capacitor_file_`. So `capacitor://localhost/..%2Fbundled-shell%2Fshell%2Frender.html` would be the
  render host as a page of the app's own pages' origin: a PC's page could frame it, hand it a page to draw, and run
  script there. Two things keep that from being so. A request for that host goes on to Capacitor only for a path of
  the app's own pages (`Home.ownPagePath`: no `.` or `..` segment once decoded, no encoded `/` or `\`, none of
  Capacitor's `/_capacitor_…` paths, which the app does not use); anything else is a 404 under `sandbox; default-src
  'none'`. And in the app the shell's two documents are not HTML files: `carry-shell.sh` names them
  `index.shellpage` and `render.shellpage` (`ShellRoute.pageFile`, `renderFile`), which only `ShellHost` answers as
  pages, so by any other way they are bytes of no type.
- **Why it stands in front of Capacitor's handler, and how that is checked.** Capacitor registers one handler for the
  app's scheme, sends only a Content-Type, has no setting for headers, its view controller's `loadView` is final, and
  the package is a built framework that a patch does not reach. `ShellHost.origin` exchanges that handler's
  `webView(_:start:)` for one that answers the shell's host itself and passes the app's own host on to Capacitor; any
  other host on the scheme gets nothing. Each web view is checked before it loads anything (`ShellHost.verify`, from
  `capacitorDidLoad`): what answers the app's scheme in it must be Capacitor's own class and no subclass, and that
  class's entry point the one put there (`Home.handlerCheck`). If not, nothing is the shell from then on: that web
  view loads nothing, no page gets what a shell page may ask, and the app opens on its own page. The web views after
  it are not refused in their turn, as there is no shell left for them to answer. The same holds from the first start
  when the exchange cannot be made or the build's shell or policies are missing (`ShellHost.unavailable`). In each
  case the app's own page says "Ovis's own screens did not open here" (`Home.shellStuck`). The alternative, should the
  exchange ever break: give Capacitor another scheme for the app's own pages (`descriptor.urlScheme`) and register a
  handler of the app's own for `capacitor`, which needs no exchange but moves the app's own pages to another origin.
- **What the client is told.** At the start of every main-frame document of the shell, before its first script,
  `window.__ovisAppShell = { bundled: true, platform: "ios", appVersion, build }` (`Home.appShellScript`, a
  `WKUserScript`; frozen and not writable). Only there: a PC's own page is that PC's copy of the client, and the app's
  own pages and the demo are not the shell. The main frame only: the render host is a document of the shell's origin
  in a frame, and nothing a rendered page reads or writes there counts for anything. The object grants nothing; what a
  page may ask of the app is decided by where it was loaded from. A hosted build says nothing.
- **Keys.** A relay PC is saved by its scope where its page is, `capacitor://app.ovis.sh/s/<server_id>/`, and the
  shell as the current PC by `capacitor://app.ovis.sh`, which is what the shell's My PCs compares with its own origin.
  The app's own pages name the shell by the hosted origin on both platforms, so `getState` gives them those keys as
  addresses on the hosted origin (`Home.hostedForm`), and `open` and `forget` take either form (`Home.shellForm`): a
  pairing link, a sign-in or a QR code written for `https://app.ovis.sh` opens as that page inside the app.
- **The hosted origin never loads** in such a build (`Home.hostedHost`, `Home.pcOrigin`). No web address at the hosted
  origin's host is a PC, whatever its scheme, port or spelling (`http://app.ovis.sh`, another port, a trailing dot,
  another case): `open` refuses it, and no main-frame navigation to it goes through in any of the app's web views, a
  redirect included (`NavigationFailureProxy`, and `HerdrShell.shouldOverrideLoad` for the web views no PC opened).
  Behind such an address is the network's copy of the shell, with the keys the update set aside. A shell page's own
  link to the hosted origin is turned to its page inside the app instead, and a PC's scope named without its slash
  gets it (`Home.shellNavigation`).
- **Home** is the shell's own first screen, `capacitor://app.ovis.sh/#pcs`, with the cover until the client drew. No
  clock gives up on it and nothing is loaded in its place (`Home.timedOut` with `inApp`). A cover that stays offers
  Try again (5 seconds in once the page answered, 20 when it has not) and, once home has not drawn for 8 seconds in
  front (`Home.ownPageOffer`), "Open the connect page": the app's own page, from the app's files, so a shell that
  never draws (a start-up error on an old iOS, files missing from the app) still leaves a way to a PC. That page
  says the app's own screens did not open until the shell draws again or is asked for again.
- **What a page may ask** (`BridgeGate.decide` in `OvisHomeCore`, which `DirectCallGate` carries out in front of
  Capacitor's handler; tested for both kinds of build) is what it could ask in a hosted build, page kind by page kind:

  | Gate | Hosted build | Shell inside the app |
  |---|---|---|
  | `OvisDirect`, every method | main frame of `https://app.ovis.sh` | main frame of `capacitor://app.ovis.sh` |
  | `OvisSsh`, every method (`BridgeGate`, `OvisSshPlugin.fromAppPage`) | main frame of `capacitor://localhost` | the same; the shell is on that scheme and is refused by its host |
  | `OvisSsh.add` handing over to the setup sheet, `HerdrShell.openSshSetup` (`SshPcs.setupOpener`) | the app's own pages and `https://app.ovis.sh` | the app's own pages and `capacitor://app.ovis.sh` |
  | `HerdrShell.forget` of an SSH PC, `disconnect` leading to an SSH PC's Manage | the app's own pages | the app's own pages, by their host (`Home.bundledPage`) |
  | `getState`'s `ids` (`Home.shownIds`) | the app's own pages and `https://app.ovis.sh` | the app's own pages and `capacitor://app.ovis.sh` |
  | `HerdrShell.identify` (`Home.identifiedKey`) | a saved PC's own address, never the hosted app or a relay scope | the same, never the shell or a relay scope there |
  | `OvisPush` (`shownPc`) | the PC whose page is on screen, by its key | the same; a relay PC's key is its scope inside the app |
  | A message to the bridge from a frame inside a page | dropped for every plugin | dropped for every plugin |

  The last row was "carried out for every plugin but `OvisDirect` and `OvisSsh`" in every build before this one, the
  store's included: a page drawn in a frame (a dev server's page in the web panel, a file's page with its scripts on)
  could post to Capacitor's handler and have `HerdrShell.open`, `forget` or `disconnect`, `OvisPush.subscribe` or
  `OvisAuth.authenticate` carried out. Capacitor puts its own script in the main frame alone, so no page of the client
  ever called from a frame. The gates that decide by the page asking read the origin of the frame that sent the call
  (`DirectCallGate.sender`), not the web view's address, which during a load is already the next page's.
- **After the update** (`PCStore.settleShell`, at each start): what the app saved at the hosted origin's host leaves
  the list, the hosted app as the PC a sign-in opened and every relay PC's scope there, with `current` and `last` when
  they name one. Those entries are kept aside (`herdr.hosted.saved`, `.names`, `.ids` in UserDefaults), not deleted,
  for a later step that may read the old origin's keys. A PC opened at its own address keeps its entry, name, relay ID
  and place: a Tailscale or home network address, any other, an SSH PC's address on this phone. Its page and its
  cookie are its own origin's. When anything was set aside, the next screen says so once
  (`ShellMovedViewController`, `Home.movedNotice`: English, Korean, Japanese, Chinese by the phone's first language):
  "Sign in again to get your PCs back", that a PC paired without an account needs pairing again, when some are left
  that the PCs opened by an address, Tailscale or SSH are still there, and, when a PC set aside sends this phone
  alerts, where those stop (below). Its one button opens the shell's first screen, where the sign-in is, over a PC
  that is still current. A build that loads the shell from the network, installed over one that served it (the QA twin
  switches), does the reverse: what was set aside is back in the list, and the entries on the app's scheme are kept
  aside in their turn (`herdr.inapp.*`) until a build that serves the shell runs again.
- **Push.** An endpoint is kept by the PC's key (`ovis.push.endpoint.<key>`), so a hosted build's endpoints for relay
  PCs stay under their old keys, unread and not deleted, and a PC signed in to or paired again registers a new one
  under its new key. The PC keeps pushing to the old endpoint for the device it knew, which the phone still shows,
  until that device is removed on the PC (Settings → Devices and PCs) or the relay retires the endpoint; until then an
  alert for a pane can arrive by both, the later one replacing the earlier (the same thread). The app cannot stop
  them itself: every alert is encrypted for the phone's one key, whichever pairing it is for, and an alert that
  arrived cannot be held back without an entitlement Apple grants for it. So the notice says it, in one line: old
  alerts may keep coming or come twice, and stop once the phone's old entry is removed on the PC.
- **Building.** `OVIS_APP_SHELL` reaches the app as `OvisAppShell` in Info.plist (`hosted-origin.xcconfig`, `bundled`
  unless the run wrote `hosted`). The App target's "Check the hosted origin" phase (`check-hosted-origin.sh`) fails a
  bundled build whose `app/bundled-shell` is not a whole shell (the shell's own page with every `/assets/` file it
  starts with, the render host's file, both policies in the form `packShell` writes them, the render host's with a
  `sandbox` that holds no `allow-same-origin`), a hosted one where that folder is still there, a bundled one whose hosted origin is `localhost` (the
  app's own pages' host), and an archive (Product > Archive, what an App Store upload is made from) of `sh.ovis.app`
  that would load the shell from the network or whose shell is not a release's (`shell-provenance.json`: `release`, a
  tag and a SHA-256, as Gradle asks of the Android store app). A test build with another bundle ID may stay hosted
  and carry any shell. The "Carry the shell" phase does nothing while Xcode indexes (`ACTION` `indexbuild`), which
  runs it beside a build of the same products folder.
- **Checks.** No CI job builds the iOS app or runs its Swift tests. `sh app/ios/check.sh` on a Mac runs them (the
  three packages' `swift test`, and the `ScopePath` and `OpeningWatch` checks; any of them failing ends it with an
  error, which `scripts/app-shell.test.ts` holds it to with stand-ins for `swift` and `swiftc`) and is a step of an upload
  (`app/store/ios.md`). What the tests cannot see, that a real web view's answers carry the policies and that the
  handler is the one checked, is a simulator run by hand for now; a job that builds the app and asks each route for
  its headers is owed.

### Push in the app

The app's web view has no service worker, so a PC's alerts reach it through the app, as
[Notifications](#notifications) plans. Where a browser has `Notification.permission` and
`pushManager.subscribe`, the client asks the app's `OvisPush` plugin, and hands the PC what the
plugin returns, shaped like a browser's `PushSubscription.toJSON()`: `server/push.ts` takes it as
one more browser's and is unchanged.

- `src/lib/push.ts` and `src/lib/notifications.ts` use the plugin when the app announces it
  (`hasNativePlugin` in `src/lib/nativeApp.ts`, from Capacitor's plugin headers). An app built
  before the plugin has none, and the client keeps in-app alerts as before; on iOS a call to a
  plugin the app lacks would never settle.
- Turning alerts on asks for notifications (the phone's own prompt), then subscribes, and the PC
  sends its confirmation push, as in a browser. The app shows an alert that arrives while it is
  open too. On Android, tapping a pane's alert opens the PC that sent it on that pane's chat, as a
  browser's does: the PC names the endpoint it pushed to and its relay ID inside the encrypted alert
  (`shared/push.ts`), and the app finds the saved PC by them (`PCStore.alertLink`). A tap for the
  PC already open selects the pane in its page without reloading the page (over a reader or a file
  page, or before that page is up, the alert's address opens instead). An alert for another
  saved PC opens that PC, as switching PC does, without asking: unsent text the open page kept in
  memory alone (the panes of a PC whose server names no herdr lifetime) is not lost but waits in
  Recover unsent text for that PC and pane, never sent. An alert too long to carry the endpoint and relay
  ID is sent without them, and its tap just opens the app, as does an alert from an older PC or
  from one the phone no longer keeps. A tap for the open PC only brings the app forward when that
  PC's page is from an Ovis older than this hand-over and is served over plain http, where a page
  has no service worker. On iOS a tap still only opens the app.
- The plugin is `app/ios/App/App/OvisPushPlugin.swift` on iOS and
  [`app/android/ovis-push`](../app/android/ovis-push/README.md) on Android, with the same calls:
  `checkPermissions()` and `requestPermissions()` (`{ notifications }`, Capacitor's permission
  states), `subscribe({ applicationServerKey })`, `getSubscription()` and `unsubscribe()`.
  `subscribe` gets the device token (APNs, or FCM on Android) and registers it with the relay
  once for each PC, with that PC's key, keeping the endpoint with the token and key it was made
  for: a new token or key makes a new one. When the PC answers that the endpoint is retired (the
  relay dropped it), the client has the app forget it and register again.
- The keys: one P-256 key pair and auth secret per phone, made by the app on first use. On iOS
  they are in a keychain group shared with the extension (`sh.ovis.app.push`) and readable once
  the phone has been unlocked after a restart, so an alert that arrives while it is locked still
  decrypts.
- `OvisNotifications`, the Notification Service Extension (`app/ios/App/OvisNotifications`,
  bundle ID `sh.ovis.app.notifications`), decrypts the push's `ovis` field and shows the PC's
  title and body. A newer alert for the same pane replaces the older one, as the service worker's
  tag does. An alert it cannot decrypt shows "herdr needs you" (in Korean when the phone's first
  language is Korean).
- The decryption and the keychain code are a local Swift package, `app/ios/OvisPushCore`, used
  by the app and the extension. `swift test` there on a Mac checks it against RFC 8291's own
  example.
- The relay's address is the App target's `OVIS_PUSH_RELAY` build setting
  (`https://push.ovis.sh`), passed on as `OvisPushRelay` in its Info.plist; a self-hosted relay
  goes there.
- Signing: both targets carry the keychain group, and the app the Push Notifications entitlement
  (`aps-environment`). A device build needs a team whose App IDs for `sh.ovis.app` and
  `sh.ovis.app.notifications` have those capabilities, which Xcode's automatic signing adds. The
  app tells the relay which APNs environment its token belongs to from its provisioning profile
  (a development build's is `sandbox`; App Store and TestFlight builds carry none and are
  `production`).
- Privacy: the APNs token goes to the relay, which keeps it to forward pushes. The App Store
  privacy answers (step 6) should say so, as the Android README says for Google Play.

## The Android app

The same `app/` pages and client run in Capacitor's Android shell (`app/android`). The native
pieces are the Java twins of the iOS ones, in `app/android/app/src/main/java/sh/ovis/app`:

- `MainActivity` builds Capacitor's config at runtime when a PC is chosen. It sets
  `setServerUrl` to the PC's bare origin (a pairing link's path and query come in through
  `setStartPath`) and `setErrorPath("error.html")`. It sets no `allowNavigation`: Capacitor turns
  each entry into another origin for its bridge, and the PC's own pages stay in the WebView anyway.
  A main-frame link to any other origin (scheme, host and port; the default port counts as none)
  opens in the phone's browser, even on the PC's own host: Capacitor compares scheme and host only,
  so another server on that host (a dev server's port) would otherwise replace Ovis in the WebView
  (`PCStore.sameOrigin`). A sign-in's steps and the redirects of the first load are judged before it.
  Opening or leaving a PC starts the activity again, so the next page is a first load and the
  old WebView goes with the old activity. Just before, the page shown hears `ovis-page-leaving`
  (waited for up to a second): the client leaves the pane state it keeps in memory alone (for a PC
  whose server names no herdr lifetime, or typed before that PC's herdr was proven) in storage, and
  that PC's next page takes it once and puts
  its text in Recover unsent text, never back into a pane: nothing proves the herdr it comes back to
  is the one it was typed under, and a replaced herdr gives the same pane IDs to other programs
  (`src/lib/paneLifetime.ts`, `carry`). Held input older than a day is dropped, as it is from an
  open page. A terminal line that looks like a key and a secret prompt's input are never written
  down (#2532), and unsaved edits in the file editor are not carried, so they still go with the
  page, as does an edit that storage refused. A page served directly by a PC on an Ovis release
  before this one has no hand-over listener, so what it held in memory alone is not carried: on any
  release, an edit its storage refused, and from 0.4.19 also text typed while that PC's herdr was not
  proven (before its first snapshot, or for a PC, such as a remote one on an older bridge, that names
  no herdr lifetime); its stored drafts stay in storage, as before.
- Until the PC's page shows, a native cover over the WebView says which PC is opening and offers
  Change PC, as on iOS. When the PC's page has not answered after 20 seconds (`PCStore.ANSWER_SECONDS`,
  counted from Open on the connect screen when it checked the address first, with at least 5 s left
  for the page) the app stops the load and shows `error.html`, which says the PC did not answer:
  for a home network or tailnet address, that such an address does not open over mobile data or
  another Wi-Fi; for a public server, that it may be down or out of the phone's reach. Chromium
  alone waits about two minutes. Bytes still arriving before that answer (a slow TLS handshake)
  put the limit off until 5 s pass with none, for at most 60 s, so a server that completes its
  handshake and never responds still gets the error page ("accepted the connection but sent no
  page"). A PC whose page has answered is never cut off (`OpeningWatch`, from the WebView's
  committed response and the app's received bytes, `TrafficStats`): after 5 s the cover says the
  connection is slow and how much has arrived, and after 20 s with nothing more it offers Keep
  waiting and Try again. Once the PC has answered, the cover stays until the client is up (its
  root no longer holds index.html's loading spinner; a page with no root, such as a sign-in, lifts
  it when shown) and shows a bar: filled by the bytes received against the sizes of the page and
  the files it starts with (a HEAD of each from the page, so with the page's own encoding and
  cookies), indeterminate when any of them gives no Content-Length; it never goes back and stops at
  95 % until the client is up. The page's files are content-hashed and cached a year, so once an
  open has finished a second one fetches only index.html (1.6 s at 10 KB/s, against 126 s for the
  first); a new release names new files, and each PC's origin keeps its own copy. On a 10 KB/s link the first paint needs
  about 90 KB and a usable client about 1.1 MB (measured on main, 2026-11-14). The first page
  of a PC saved by its origin is checked once more (`PCStore.check`, with the WebView's cookies):
  one that answers but not as Ovis is not kept and gives way to `error.html`, which has Change PC,
  so a PC saved before that check (or one whose port another server took) never traps the app.
- `onPause` flushes WebView cookies. Without it, a pairing made a moment before the app was
  swiped away was lost: the next start asked for pairing again.
- Back goes to the page first. The page keeps a history entry for everything open over it (a
  sheet, a dialog, a menu, the workspace list: `src/lib/sheetHistory.ts`) and for each pane it
  moved to, so `MainActivity` keeps an `OnBackPressedCallback` on while the WebView's history has
  an entry of the same place behind the page shown (the PC's pages, or the app's own before a PC
  is chosen: `PCStore.pageTakesBack`, told again on every `doUpdateVisitedHistory`), and its Back
  is `goBack()`: the page closes what is open, or shows the pane before, and the demo goes back to
  the connect screen. With no such entry (the first page with nothing open, a sign-in in front of
  the PC, `error.html`) the callback is off and Back is the system's: it leaves the app, with
  Android's own predictive-back animation, and no second press is asked for. Before this every
  Back left the app, whatever was open. The iOS app has no Back: the edge swipe is the page's (it
  opens the workspace list), and WKWebView's back-forward swipe stays off.
- `HerdrShellPlugin` and `PCStore` (SharedPreferences) mirror the iOS plugin and store. As on
  iOS, a pairing link stays in memory until a PC page loads.
- Capacitor injects its bridge only into the PC's origin, so `error.html`, served from the app
  alone, gets none. `MainActivity` hands that page a small `HerdrErrorPage` JavaScript interface
  for Try again and Change PC. For the same reason `error.html` carries its own style and
  script, which `app/scripts/build-web.ts` inlines.
- The manifest allows cleartext http to any host (see the connect screen's warning above).
- The WebView has no download handler and no Web Share, so a download link does nothing there.
  Download in the chat's image viewer hands the picture's bytes, read by the page (relay pictures
  through the relay), to `SaveImagePlugin` (`OvisSave`), which writes them to Downloads through
  MediaStore with no storage permission, as Chrome saves a download. Android 8 and 9 give an app
  that without the storage permission, so there it opens the share sheet with the picture instead.
  An app built before the plugin makes the viewer say it couldn't save. Download in the file
  viewer takes the same way for a file of any type (`saveFile`): the page reads the file through
  its transport and hands its bytes over, up to the plugin's 20 MB (a larger file is not offered:
  the viewer says to download it on the PC). An app without `saveFile` makes the viewer ask for
  an update.
- A PC's link on the hosted shell tapped outside the app (a message, the camera app reading the
  PC's QR code) opens in the app: the manifest's `autoVerify` intent-filter takes
  `https://app.ovis.sh/s/`, which Android verifies against
  `https://app.ovis.sh/.well-known/assetlinks.json` (written by `scripts/shell-build.ts` with Play's
  app signing certificate and the upload certificate, so it is live once a release deploys the
  hosted shell). `MainActivity` takes only a link to a PC's scope (`PCStore.appLink`); one to
  another page of the hosted shell leaves the open page alone. A view of a PC (a file's `#read=`, a
  pane's `#pane=` or an older `?pane=`) opens that PC at that view when the app has it saved, and
  otherwise leaves the open page alone too. A link to pair from (the scope alone, with its
  `#offer=`, or with a provider's `#sign-in=`) is kept in memory (`PCStore.link`) for the connect screen, which takes it once (`HerdrShellPlugin.takeLink`, which an activity showing a PC never answers, as its
  page has the bridge too) and opens it as a scanned QR code, so `relayLink()` checks the offer the
  same way. A link handed back when the app is restored or started from Recents is not opened again. Until the link is verified, Android opens such links in the
  browser as before. The hosted shell also serves `apple-app-site-association` for the iOS app,
  which still needs the Associated Domains capability (`applinks:app.ovis.sh`) and a handler.
  `minSdkVersion` is 26 (Android 8), which the QR scanner's library needs. The merged manifest
  asks for INTERNET, ACCESS_NETWORK_STATE, CAMERA (the QR scanner) and androidx's own
  `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
- Backups are off (`allowBackup="false"`, and `data_extraction_rules.xml` for a move to a new
  phone on Android 12 and later): the WebView's store holds each PC's device cookie, so a restored
  copy would be signed in without pairing.
- `error.html` shows the reason: WebView's (`net::ERR_CONNECTION_REFUSED`) or the HTTP status.
  `MainActivity` takes it from its own `BridgeWebViewClient`, as Capacitor's listeners get none.
  On a WebView without `WEB_MESSAGE_LISTENER` there is no `HerdrErrorPage`, so the page's
  buttons go to `/_ovis/retry` and `/_ovis/change-pc` on the app's origin, which `MainActivity`
  catches; the page then does not name the PC.
- The status and navigation bars take the page's `theme-color` (the client keeps it at its top
  bar's color), with icons that stand out on it: a document-start script sends it to an
  `OvisBars` listener open to the app's and the PC's origins. Until then, and on a WebView without
  those features, they sit on the app's own page's colour (`ovis_page` in `colors.xml`, white, or
  `#181818` in `values-night`), as do the web view before a page paints, Android 12's own launch
  screen (`windowSplashScreenBackground`) and the native cover; while the cover is up the bars keep
  its colour, and the page's `theme-color` takes over once it lifts.
- With 3-button navigation the page stays clear of the buttons, at the bottom or, on a phone in
  landscape, at the side. On a WebView that gives the page its safe areas itself (140 and later),
  Capacitor's SystemBars lets the page draw under the system bars and leaves the room to the CSS,
  and the client's message box and key bar sit partly into the bottom safe area (the room an
  iPhone's home indicator leaves), so the buttons covered them on a Galaxy. The client's layout
  pads its sides for a side bar itself. `MainActivity` keeps the WebView clear of the bars'
  tappable part (`WindowInsetsCompat.Type.tappableElement()`, which a pinned taskbar on a large
  screen has too), and the strip beside it shows the window's background: the page's
  `theme-color` once the page has sent it, the app's own page's colour before. A gesture bar has no
  tappable part, so the page still draws under it. A docked keyboard covers a bottom bar, and
  SystemBars keeps the page above both. A floating keyboard takes no bottom inset, so on WebView
  144 and later the bar is kept clear under it; before 144 SystemBars passes the page no bottom
  inset while any keyboard shows, and the page sits under the bar then, as it did before. On an
  older WebView SystemBars keeps the page out from under the bars itself, and this changes
  nothing.
- A link to the PC's host over the other scheme (http for an https PC) opens in the browser: it is
  another origin, which gets no bridge.
- A redirect is not a link. Capacitor would hand a redirect to another host or scheme to the
  browser (Firefox opened the PC for testers whose default browser it was), and a page on another
  port would have no bridge. So until the first page shows (`onPageCommitVisible`), `MainActivity`
  holds a redirect of the address being opened to another origin back and asks that origin's
  `/api/health?scope=bridge`, which Ovis answers to anyone (`PCStore.ovisOrigin`, following up
  to five redirects of that request and giving up after about ten seconds in all; a slow name
  lookup, which Android cannot cut short, can add a few). An origin that answers as Ovis
  (http to https, an IP address to the PC's name, another port) becomes the PC and opens again as
  the first page, with the bridge: it gets nothing the address's own page would not have had.
  Anything else is taken for a sign-in in front of the PC, such as Cloudflare Access or another
  authenticating proxy: it loads in the WebView without the bridge, is never saved and never
  becomes the PC. Until a page of the PC loads, `MainActivity` keeps main-frame http and https
  navigations (the sign-in's pages, its identity provider's, the way back to the PC) in the
  WebView rather than the browser, so the sign-in's cookie lands in the WebView's store, which
  `onPause` flushes. A redirect over public plain http or from https to http
  (`PCStore.refusedHop`), there or at any later step of the sign-in, ends on the error page,
  which names where it led; the way back to the PC's own address is never refused. This check is
  best effort: a form's POST to such an address is held in `shouldInterceptRequest` before it is
  sent, but a 307 or 308 redirect of a POST is followed by the WebView without asking either
  callback, so a sign-in server that redirects its POST to plain http is not caught. So does a sign-in on a
  WebView without `WEB_MESSAGE_LISTENER`, where Capacitor's bridge is a JavaScript interface any
  page could call. An identity provider that refuses embedded web views (Google sign-in answers
  `disallowed_useragent`) still fails there, and a sign-in kept in a session cookie (one with no
  expiry) is asked for again whenever the app starts over, as Capacitor's cookie plugin clears
  session cookies then; Cloudflare Access's cookie has an expiry. After five PCs in a row made this way, the next redirect ends on the error page too. Once the first page shows, Capacitor decides on redirects
  as before: one could then come from a link to a page that is not the PC's (another port on its
  host), which must not choose the PC.
- `file_paths.xml` shares only the app's external Pictures folder, where Capacitor puts a photo
  taken for a file input.
- `build-web.ts` leaves out the client build's `.gz` and `.br` sidecars. The app reads files
  itself, and Android's asset merger takes `x.js` and `x.js.gz` for one asset.

Build and install, on a PC with the Android SDK and JDK 21:

```bash
bun install && cd app && bun install
bun run build:web && bunx cap sync android   # OVIS_APP_SHELL_DIR=<dist-shell> to carry a given shell
cd android && ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug
# app/android/app/build/outputs/apk/debug/app-debug.apk
```

`bun run build:web` builds the shell the app carries from this checkout (about 20 s) unless
`OVIS_APP_SHELL_DIR` names one; with `OVIS_APP_URL` (a preview) it loads the shell from the network
instead ([The bundled shell](#the-bundled-shell-android)).

For Google Play, `./gradlew bundleRelease` makes `app/build/outputs/bundle/release/app-release.aab`,
which Gradle refuses to make from a build that loads the shell from the network.
It is signed with the upload key when `OVIS_UPLOAD_PROPERTIES` names a properties file holding
`storeFile`, `storePassword`, `keyAlias` and `keyPassword` (a relative `storeFile` is taken from
`app/android/app`; a file that is missing or lacks one of them fails a release build, naming
what is wrong, and never a debug build); the key and that file stay outside
the repository (the maintainer's are in `~/.config/ovis-android`, mode 700). Without it the bundle
is unsigned. Raise `versionCode` in `app/build.gradle` for every upload.

To put the APK on a phone in the tailnet, use `tailscale file cp app-debug.apk <phone>:`, then
open it from the phone's Tailscale app. With USB, `adb install -r app-debug.apk` works too. A
debug APK asks to allow installs from that source.

What was checked on 2026-10-19, on an Android 16 (API 36) emulator against a server on an
isolated herdr session. Taps and typing were real touches through `adb shell input`; the pages
were read through the WebView's DevTools socket (`webview_devtools_remote_<pid>`):

- The first start shows the connect screen. Typing the server's address and tapping Open loads
  the client with Capacitor's bridge (`getPlatform()` is `android`).
- With the gate closed, the pairing screen shows Change PC. A pairing link typed into the
  connect screen paired the app. After Home, a force stop and a new start, the client opened
  without asking again.
- Settings → Phone & devices shows Change PC; tapping it returns to the connect screen with the
  PC kept.
- Try the demo opens the bundled demo; all 14 of its requests stayed on `https://localhost`.
- A closed port shows `error.html` naming the PC. Try again after the port opened requested
  `/?pair=123456`, and opening the PC again afterwards requested `/`.
- No http delay on Android. The client's first script ran 10-60 ms after its HTML arrived, over
  `http` (first script at 322-584 ms) and `https` (463-874 ms) alike. Most of that time is the
  emulator's network.

Still open on Android:

- QR scanning and IME were not tried in the emulator; a physical phone should check them.

### The bundled shell (Android)

The Android app carries the hosted shell (`dist-shell`: home's Connect a PC and My PCs, and every relay PC's
page) and answers it from its assets at the hosted origin itself, `BuildConfig.APP_ORIGIN`
(`https://app.ovis.sh`, or a test build's `OVIS_APP_URL`), with no network. The origin string stays, so a
person who updates from a build that loaded the shell from there keeps that origin's storage: the account's
sign-in and keys (IndexedDB `ovis-account`, `ovis-relay`) and the pairings. Decided 2026-11-24 for both store
apps; the iOS app moves to an origin of its own ([The shell inside the app](#the-shell-inside-the-app-ios)).

Build (`app/scripts/bundled-shell.ts`, called by `build-web.ts`):

- `OVIS_APP_SHELL` is `bundled` or `hosted`. Unset, a build of the production origin (no `OVIS_APP_URL`, what a
  store build is) is `bundled`, and a build with `OVIS_APP_URL` (the owner's preview app, the QA twin) is
  `hosted`: the shell from the network at that origin, exactly as before. `BuildConfig.SHELL_BUNDLED` carries
  the choice (`appShell=hosted` in `hosted-origin.properties`); Gradle refuses `assembleRelease`,
  `bundleRelease` and the like of a hosted build whose application ID is the store's, and any app bundle of
  one, so a hosted shell is never uploaded.
- Which shell is carried: a release's (`OVIS_APP_SHELL_ARCHIVE`, the tag's `dist-shell.tar.gz`, unpacked only
  once its SHA-256 is `OVIS_APP_SHELL_SHA256` and only as plain files and folders, with `OVIS_APP_SHELL_TAG`), a
  folder (`OVIS_APP_SHELL_DIR`), or, with neither, one built from this checkout (`vite build --mode shell`), as
  the demo is. `shell-provenance.json` beside the copy says which (`release` with its tag and SHA-256, `folder`
  or `checkout`, and the copy's build.json revision), and Gradle packages the store app (its application ID in a
  release build, or any app bundle) only from a `release` whose `index.html` finds every `/assets/` file it starts
  with; a debug build from the checkout stays possible. It goes to `app/bundled-shell/shell/`, cleared first, written once for every platform outside `app/www`, so
  `bunx cap sync` leaves it alone and the app's own origin (`https://localhost`) never serves it; the Android
  build adds it as an assets folder of its own (`build.gradle`). The `.gz`/`.br` sidecars, `_headers`,
  `_redirects` and `.well-known/` stay out. The two policies come from that copy's own `_headers`
  (`shell-policy.json` beside it), which `scripts/shell-build.ts` writes from `shellPolicies()`: a test
  reads them back from `shellHeaders()`, so the app and Pages cannot send different ones. The copy fails the
  build over 64 MB or under 14 MB (31 MB on 2026-11-24: `SHELL_BUDGET_BYTES`, `SHELL_FLOOR_BYTES`), or when a
  file its `index.html` starts with is missing (a partial unpack would open blank). It is not shared with the bundled demo: 427
  files are the same bytes, but under other names (a 10-character hash against 8), so sharing would need a
  name map in the app for 9 MB of the APK's +13.4 MB.
- Gradle's `checkHostedOrigin` fails a bundled build whose folder holds no shell or no readable policies (both
  strings, the render one with its sandbox), and a hosted one that still holds a shell from another run.

Serving (`BundledShell.java`, `MainActivity`):

- The activity opens the hosted origin as it always did: `server.url` is that origin, so Capacitor's bridge
  origin rules, its document-start bridge script and every plugin's and page's gate that reads
  `getServerUrl()`, the bridge's host or `APP_ORIGIN` decide as with the shell from the network, and the app's
  own pages keep their own origin (`https://localhost`: `error.html`, its `HerdrErrorPage` listener and
  `/_ovis/retry`, the connect page, the demo). Only the answers change: `shouldInterceptRequest` (the
  activity's client, and a client of its own set from `HerdrShellPlugin.load`, before Capacitor loads the
  first page, which it otherwise asked for through Capacitor's own client and so over the network) and the
  `ServiceWorkerController` client (Capacitor's is turned off for it) answer every request to that origin
  from the copy, never Capacitor's local server, which would take the network for it. Whether a request is on
  that origin is read from its parts (scheme, host, port), never by parsing its whole URL again: a URL
  `java.net.URI` refuses (WebView keeps `|^{}` and a backtick in a query and `[]` in a path as they are) once
  counted as another origin and reached the network; `MainActivity`'s main-frame origin check reads the parts
  too. Pages' routes (`BundledShell.route`): `/s/<id>/manifest.webmanifest` the shell's manifest,
  `/s/<id>/~render` `render.html` with the render host's policy alone, anything else under `/s/` the shell
  (`/s/<id>` too: an answer cannot redirect), a file of the shell where there is one, a 404 for a missing
  hashed asset under `/assets/`, and the shell for any other address. Only GET and HEAD; Capacitor's own
  paths (`/_capacitor_file_/`, `/_capacitor_content_/`, its HTTP interceptor) are a 404 there, as the client
  asks for none of them; a path a browser would not load as written is a 404. Every answer carries the shell's
  policy (`~render` the render host's alone), `X-Content-Type-Options: nosniff` and `no-cache`.
- Every `sw.js` (`/sw.js`, `/s/<id>/sw.js`) answers a worker that retires: it takes the old worker's place
  at once, unregisters itself and deletes the caches but `ovis-files-v1` (the client's fonts), with no fetch
  handler meanwhile. A worker the network's copy registered then goes at its next update check rather than
  serve that copy for a day, and one that copy registers again while it runs once goes the same way.
- The first bundled start after the shell came from the network (`BundledShell.needsBoot`, kept in the
  preferences `ovis-bundled-shell`) opens the boot page first, `/_ovis/boot`, outside every PC's scope, which
  no worker controls: it unregisters every worker of the origin and deletes their caches (not
  `ovis-files-v1`), tells `OvisBoot` (a listener only that start has, heard only from that page's main frame and
  dropped once heard), and replaces itself with the page asked for, carried in its fragment and only on that
  origin. So a worker of the network's copy, whose kept shell (a day old at most) would otherwise answer the
  first page of a relay PC, never serves it once. Storage is untouched: `WebStorage.deleteAllData` would take
  the keys with it. It goes on with the page's whole address on its own origin (`location.replace(asked.href)`,
  so a path such as `//host/x` stays a path). A clean-up that fails or takes over 3 s is tried once more; after a
  second failure it never goes on to a PC's page (`/s/`), which a worker left behind could answer, but to the
  front page, which no worker controls, and the next start tries again. A build that loads the shell from the
  network marks it needed again. The boot page stands in for the client's own first-load rule ("open `/` first",
  #4557): it runs before whatever the first page is (home, a saved relay PC, a link or an alert that opens a
  PC's page), so the client finds nothing left to retire and reloads nothing.
- The bundled shell's pages, on the hosted origin and in the main frame alone, get `window.__ovisAppShell = {
  bundled: true, platform: "android", appVersion, build }` (frozen; `versionName` and `versionCode`) at document
  start, before their own scripts. Never a frame, a PC's own page (its own origin), the render host (its sandbox
  has no origin), the app's own pages or the demo; a hosted build injects nothing. The client reads it to register no worker, never
  reload for a newer hosted copy, and compare its own version with the PC's floor. Its "Update the app" button is a
  `target=_blank` link to the Play page, which the WebView takes as a main-frame link to another origin: `MainActivity`
  hands it to the system (the Play app, else the browser), never opening it in the WebView.
- A build that carries the shell and cannot serve it never loads it from the network: a WebView without
  document-start scripts or message listeners, or a copy without its index page or readable policies, opens the
  app's own `error.html` at `https://localhost` saying why ("update Android System WebView", or reinstall the
  app); its Change PC leads to the app's own page (Tailscale, SSH, an address), as home's fallback does.

What was checked on 2026-11-24 (Android 16 emulator, WebView 133, the QA twin `sh.ovis.app.previewqa`): a
hosted build (14) loaded `https://app.ovis.sh`, wrote a marker and a non-extractable ECDSA key into IndexedDB,
and opened a relay PC's scope, whose worker kept the hosted shell; the bundled build (15), installed over it
with the network off, opened that scope with the bundled script, no worker and no shell cache, the marker
there and the key signing, `window.__ovisAppShell` set, the policy enforced on the page (an inserted inline or
`data:` script refused) and on `~render` (an opaque origin with no bridge, no fetch and no storage). With the
network on, no request to the hosted origin reached it. Each gated plugin call answered the same from the
app's own page, `error.html`, home and a relay PC's page in both builds.

### PCs over SSH

The Android and iOS apps can add a PC the person already reaches over SSH: **SSH** under **Add a PC** on
the connect screen (the iPhone's: [The iPhone's SSH](#the-iphones-ssh) below). The phone talks to the PC's sshd itself (ConnectBot's `sshlib`, BSD-3-Clause), with no Ovis
relay, no account and no port open but SSH. A user guide is [ssh-from-phone.md](ssh-from-phone.md);
the iOS plan is [ios-ssh-plan.md](ios-ssh-plan.md). Nothing in `server/` or `shared/` changes: the PC
runs the Ovis it already has.

Only the app's own pages add an SSH PC (`OvisSshPlugin.fromAppPage`); a PC's page, the hosted app's included,
never gets that. The hosted app's SSH tab takes `user@host` in the phone app all the same: it calls
`HerdrShell.openSshSetup`, which brings the SSH setup screen (Android's `SshSetupActivity`, the iPhone's sheet) up
over that page with the login filled in (`SshPcs.login`; `MainActivity.openSshSetup`, `OvisSshPlugin.presentSetup`).
The page gets nothing back but that the screen came up: the person adds the PC there, the keys staying on the
native side, and Back or Cancel returns to the page as it was, nothing loaded again (Android's
`SshSetupOverPageTest`); a PC added opens. An app without that method, and a browser, offer no SSH on the hosted
page.

How a page gets there (`app/android/app/src/main/java/sh/ovis/app/Ssh*.java`, `OvisSshPlugin`):

- Each SSH PC is saved under a loopback origin of its own on the phone,
  `http://127.0.0.<n>:47317` (`SshPcs.freeOrigin`, n from 2, never one a removed PC had until all
  253 were handed out; Remove also deletes that origin's web storage), so its cookies, storage, drafts
  and service worker stay apart from every other PC's and stay put across restarts. `SshTunnel` listens
  there; each connection the WebView makes becomes an SSH direct-tcpip channel to the PC's own Ovis
  on its 127.0.0.1. That Ovis sees a request from its own loopback with no proxy headers and lets it
  in as its own PC's (`server/access.ts`, `local`): no token is typed or kept.
- The PC's Ovis is found as the PC flow finds it (`server/remote-host.ts`): the live bridge
  descriptors in `~/.config/herdr-web-ui/bridges/`, herdr's default session first, never a
  bridge-only server another PC's Ovis started (`managed_remote`). One installed but stopped is
  started through its launcher (the herdr plugin, `ovis.service`, the launchd agent); a plugin whose
  herdr is not running gets a headless `herdr server`, as `server/pc-install.ts` does.
- Other apps on the phone can reach its loopback too, so the first request on each connection must
  carry the tunnel's gate cookie (`ovis_ssh_gate`, 256 random bits, new each time the tunnel
  starts, HttpOnly, SameSite=Strict, on that origin only), which the app hands `CookieManager` only
  once the tunnel holds the address; anything else gets 403 and nothing reaches the PC, and the gate is
  taken out of the request before it goes on. An address another app took first is never opened: the
  connect screen says so instead (`OvisSshPlugin.listen`, `ssh-port`), as the page that would answer
  there would be that app's, with the app's bridge. Capacitor makes the WebView's cookies the process's
  `CookieHandler`, which its native HTTP plugin would carry to any address a page with the bridge
  asks for; `MainActivity` unsets it, as nothing in the app uses it. `OvisSsh` answers the app's own
  pages only, never a PC's.
- Lifetime (`SshTunnel`, each rule checked in `SshTunnelTest` with the clock, the SSH side and the
  closer injected): the SSH connection is made when a request needs it, once for a whole burst, outside
  the tunnel's lock, and again after it ended (the app in the background, a network change, which
  `SshTunnels` watches and answers by dropping every connection), asking nothing. A request is passed on
  once, with `Connection: close` (a WebSocket's upgrade excepted), so the WebView never re-sends it on a
  reused connection, and one the PC side ends before answering gets 503 rather than silence: what was
  typed stays a draft in the page. A failure answers the page's burst at once for 2 s (by the monotonic
  clock), then is tried again; looking the PC's Ovis up again happens one request at a time, and its
  failure drops the connection into that window. A stop (the host key changed, the key refused, a key
  the phone can no longer open) is never tried again until the PC is set up again. Coming back to the
  app pings a connection that exists and makes a new one before the page asks; a PC with none is not
  signed in to. A link is closed off the caller's thread, as sshlib's close can wait on a dead network,
  and a link closed meanwhile (sshlib's IllegalStateException) is a failure, never a crash.
- No foreground service. Without one the connection ends some time after the app leaves the screen
  and is made again on return, which takes about a second on a LAN; a foreground service would keep
  it at the cost of a permanent notification and Play's `specialUse` declaration with a video, for
  nothing the person sees.

Keys and host keys (`SshPcs`, `SshVault`, `SshKeys`, `SshHostKeys`; `SshPcsTest`, `SshKeysTest`,
`SshHostKeysTest`):

- The phone's own ed25519 key is made on first use. Its seed is sealed with AES-GCM under a
  256-bit key that lives in the Android Keystore and never leaves it (`SshVault`); only the public
  line leaves the app (`ssh-ed25519 … ovis-phone:<model>`). Android's Keystore cannot hold an
  ed25519 key on every phone, hence a sealed software key. A seed the phone can no longer open
  (`key-lost`) is never replaced quietly: setting the PC up again makes a new one.
- A pasted private key and its passphrase are sealed the same way. Pasting one sits under
  **Advanced** on the setup screen: a private key on the clipboard passes other apps, so the first
  choices are the phone's own key (its public line copied or shared) and the password once. The app reads OpenSSH keys
  (bcrypt-encrypted or not) and PEM keys (`RSA`/`EC PRIVATE KEY`, encrypted or not); ed25519, RSA
  and ECDSA; it refuses DSA, and says how to convert PKCS#8 (`ssh-keygen -p -f key`) and PuTTY
  keys. A paste is read before anything goes to the network, so a wrong passphrase is told at once.
- A password is used once, to add the phone's key to `~/.ssh/authorized_keys` there; the key is
  then proven by signing in with it, and the password is never stored. Keyboard-interactive gets the
  password only for a single password prompt, never for a one-time code.
- Host keys: nothing is sent to a host whose key the person has not confirmed (its SHA-256
  fingerprint, as `ssh-keygen -lf` prints it). A saved key is pinned with its algorithm; any other
  key, or a saved key that cannot be read, fails closed with no way past it but **Forget host key**
  under Manage, after which opening the PC shows the new fingerprint to confirm.
- Backups stay off (`allowBackup="false"`), so none of it reaches a Google backup either.

Manage (`app/web/connect.js`): an SSH PC in Your PCs has Manage instead of Forget: rename, show
the phone's key line again (with Copy and Share), set up again (another way to sign in, another key, the
phone's key registered again; the PC keeps its origin), forget its host key, and remove it, which can
also take the phone's key out of the PC's `authorized_keys`: only the lines whose key field is that
key, the file's mode kept, and only when no other saved PC may sign in to the same account with it
(the same user on the same host name or behind the same host key).

Errors: the setup screen says each failure in words with what to do (`SshWords`, strings in
`res/values/ssh_strings.xml` and `values-ko`). For an SSH PC that is open, the tunnel's failure
goes to `error.html` with its kind (`ssh-<kind>` in `PCStore.failureKind`) and the one command that
fixes it on the PC (`PCStore.failureCommand`, shown to copy): the host key changed, the key refused,
the PC out of reach, Ovis not installed (the install command) or not started (its launcher's
command). The tunnel's 503 carries `X-Ovis-Ssh: <kind>`, so `MainActivity` keeps that reason rather
than the bare status, and a stop while the page is up takes the page to `error.html` too.

#### The iPhone's SSH

The iOS app does the same with the same screens, words, kinds and commands, in Swift
(`app/ios/OvisSshCore`, a local Swift package over [SwiftNIO SSH](https://github.com/apple/swift-nio-ssh),
Apache-2.0, whose cryptography is CryptoKit; `app/ios/App/App/OvisSshPlugin.swift`, `SshSetupView.swift`,
`SshWords.swift`). `swift test` in `app/ios/OvisSshCore` on a Mac runs its tests (no CI job runs them yet: a macOS job for them is a
follow-up), over
the Android app's `ssh-test-keys`; `SshFixtureTests` also runs against a real sshd when `OVIS_SSH_FIXTURE`
names one (a throwaway `sshd -D -f <config>` run as yourself is enough). Where it differs:

- iOS gives the loopback interface 127.0.0.1 alone, so each PC gets a port of its own,
  `http://127.0.0.1:<47320 to 47619>` (`SshPcs.freeOrigin`, never one a removed PC had until all 300 were
  handed out). Cookies do not separate ports, so the gate cookie is named for the port
  (`ovis_ssh_gate_<port>`), and the tunnel also refuses a request another origin's page makes (an `Origin`
  that is not its own, or `Sec-Fetch-Site` other than `same-origin` or `none`): another SSH PC's page, on
  its own port, is same-site and would carry the cookie. The app never opens or navigates to 127.0.0.1 at a port
  no SSH PC listens on, the tunnel refuses a redirect there, and a WebKit content rule list
  (`OvisSsh.loopbackRules`, made again as SSH PCs come and go, before each web view) blocks every other load from
  127.0.0.1 there, a picture or a script a page asks for included. `Sec-Fetch-Site` comes with iOS 16.4, so SSH is
  offered from iOS 16.4 on (`OvisSsh.supported`; the plugin is not registered before it).
- The gate is 256 random bits made when the PC is set up and kept sealed with it, as WKWebView's cookie store
  is set asynchronously: it is put there (HttpOnly, SameSite=Strict, on that origin only) before the PC's
  page loads (`HerdrBridgeViewController.reopen` → `OvisSsh.prepare`).
- Secrets are sealed with AES-GCM under a 256-bit key in the Keychain, this device only
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synced or backed up). The phone's own key is
  ed25519, as on Android (its line `ssh-ed25519 … ovis-phone:<model>`).
- Capacitor's iOS bridge lets any page call any plugin, so `DirectCallGate` drops every `OvisSsh` call
  that does not come from the main frame of the app's own bundled pages (`capacitor://localhost`), and the
  plugin refuses one that comes through while a PC's page is up.
- Pasted keys: OpenSSH ed25519 and ECDSA keys, with a passphrase (bcrypt_pbkdf, aes-ctr) or without, and
  PEM ECDSA keys. SwiftNIO SSH has no RSA, so an RSA key is refused with words that say so (the Android app
  takes it). Signing in with a password uses SSH's `password` method only, not keyboard-interactive.
- iOS suspends the app's sockets in the background: on return each tunnel listens again and pings its
  connection (`SceneDelegate.sceneWillEnterForeground`), and a network change (`NWPathMonitor`) drops
  every connection; the next request makes a new one, asking nothing.
- Android's `FLAG_SECURE` has no iOS counterpart: the setup screen can be screenshotted.

#### Tailscale SSH and the PCs a PC knows (both apps)

- **Tailscale SSH, no key** (`auth` "tailscale"): the phone offers SSH's `none` method, which Tailscale SSH accepts
  for a login its policy allows. In check mode it holds the sign-in and sends a user-auth banner,
  "# To authenticate, visit: https://login.tailscale.com/a/…"; the setup screen shows that link (`checkLink`, only
  `https://login.tailscale.com/`) with Open the link, and waits up to ten minutes. A reconnect has nobody to approve
  it: the tunnel fails with `tailscale-check` and the link as its command, and `error.html` offers Open the link and
  Try again. A login the policy does not cover is held silently by Tailscale (its own ssh waits the same), so the
  screen waits until its deadline. The host key is still confirmed and pinned as for any SSH PC.
- **The PCs a PC knows**: `OvisSsh.known` asks an SSH PC's own Ovis, over its tunnel's SSH connection as from its
  loopback (`local` access, which `/api/machines/ssh-candidates` and `/api/machines` answer), and the connect
  screen lists `knownLogins` (`app/web/shell.js`) on the SSH tab with Add: ssh config hosts by user@hostname (an alias
  alone means nothing on the phone), Tailscale PCs as the first PC's user, and that PC's SSH PCs by target; those
  already on the phone are left out. Only an SSH PC is asked: a relay or Tailscale-address PC gives the phone no
  connection of its own to ask over.

First install from the phone: where the account has no Ovis, the setup screen offers to install it.
The PC flow's remote bundle (`scripts/build-remote-bundle.ts`) cannot serve the phone: it starts a
bridge-only server, whose token only the PC that installed it has, with no app of its own to open.
The phone drives the PC flow's other path instead, the official installer as one SSH command
(`SshLink.INSTALLER_RUN`, the same command shape as `installerRun` in `server/pc-install.ts`, with
its checks for curl, git, tar and unzip, a writable home and 1 GB free), then starts Ovis and opens it.
Measured on the bare fixture (`up-bare.sh`: Ubuntu 24.04 with SSH, curl, git, tar and unzip, no herdr
and no Ovis), driven by `SshFixtureTest.installsOvisWhereThereIsNone` from the emulator: release v0.5.3
ships no compiled server, so the installer installs from source: herdr, Bun and the herdr plugin's
checkout, built there. It downloaded 361 MB, left 916 MB in the home folder (the plugin checkout 750 MB,
Bun's cache 474 MB of it) and took 31.5 s from the tap to Ovis answering on this PC's link; a home
connection at 50 Mbit/s needs about a minute more for the download. A release with the compiled server
needs far less. The installer's from-source path needs `unzip`, which the PC flow's checks
(`server/pc-install.ts`) do not look for either: a machine without it fails there after herdr is
installed, while the phone's own check says so first.

Tests: the JVM tests above run with `./gradlew :app:testDebugUnitTest`.
`scripts/fixtures/phone-ssh/emulator-run.sh [--bare]` is the emulator run: it starts the disposable
fixture (sshd, herdr, Ovis and a stand-in agent in Docker), authorizes the test-only keys, starts an
emulator when none runs, and runs the instrumented `SshFixtureTest` (the real Keystore, every key
format signing in, the host-key rule, the password-once registration and its removal, the tunnel's
gate and stop) and `SshSetupFlowTest` (the setup screen with a pasted, passphrase-protected key);
`--bare` adds the first install on a fixture with neither herdr nor Ovis.

Size: the debug APK is 55,906,488 bytes (53.3 MB). The SSH library (sshlib, Tink, the Kyber KEM) adds 1.03 MB to the
release APK (measured for the prototype: 47,906,469 bytes against 46,874,305, minify off as before); the
app's own SSH classes are 138 KB of bytecode.

Not tried yet: a real phone (only the emulator, Android 15 with Google APIs), a real Wi-Fi to mobile data switch, push alerts
from an SSH PC (they come from the PC's own Ovis, so they should work, unchecked), a PC whose Ovis
has `OVIS_TOKEN` set (its sign-in page shows), a named herdr session, Windows, jump hosts and
`~/.ssh/config` aliases. The PC's Ovis menu names an SSH PC "local", as Ovis sees itself; and an
sshd session cut by a dropped network stays on the PC until its TCP keepalive (or `ClientAlive`)
ends it.

## Through the Ovis relay

A PC can also be reached through the [Ovis relay](relay.md), which is off by default and end-to-end
encrypted ([how to use it](guide.md#through-the-ovis-relay)). Its pairing QR code holds a link to
the hosted app, `https://app.ovis.sh/s/<server_id>/#offer=…`, not the PC's own address. Scanned or
pasted into the connect screen, that link opens the hosted app's pairing screen in the app; an
offer on any other origin is refused there. Each relay PC is saved by its scope URL, older entries
saved by origin keep working, and a page counts as that PC's only inside its scope ([The app
(app/)](#the-app-app) has the details). Scanned with the phone's camera instead, the code opens the
hosted app in the phone's browser.

Files load as in a browser without a service worker ([relay files](relay.md#files)), since the
app's web view has none ([Spike results](#spike-results-2026-10-19)): each picture, PDF or video
loads whole, up to 64 MiB, before it shows, so a video can't skip ahead while it loads.

### Direct on the same network

A page on https cannot open the PC's plain `ws://` direct carrier ([relay.md](relay.md#direct-on-the-same-network)),
so the apps' `OvisDirect` plugin opens it for the hosted app (`app/ios/App/App/OvisDirectPlugin.swift`,
`app/android/app/src/main/java/sh/ovis/app/OvisDirectPlugin.java`, `src/lib/relay/directSocket.ts`):

- It answers only the main frame of `https://app.ovis.sh`: on iOS `DirectCallGate` stands in front of
  Capacitor's message handler, which lets any frame call; on Android Capacitor's own origin rule and
  main-frame check apply, and the plugin refuses without the WebView's message listener.
- It opens only `ws://<10/8, 172.16/12, 192.168/16, 169.254/16 or Tailscale's 100.64/10 address>:<port>/v1/ws?v=1`,
  at most two at once, and closes them when a new page loads. Noise inside the channel proves the PC.
  Its `features` call answers `{ tailnet: true }`, so the page asks the PC for its Tailscale address
  only in an app that opens it; an app built before that has no `features` and stays on home-network
  addresses. A Tailscale address needs no Local Network permission (Tailscale is a VPN on the phone).
- Frames cross the bridge as `{ id, kind, data }` (binary as base64), in order; the page acknowledges
  what it took, and a socket with more than 4 MiB or 16,384 messages unacknowledged is closed (1009).
- iOS asks for Local Network access the first time (`NSLocalNetworkUsageDescription`); declined, the
  app stays on the relay. The simulator does not model that prompt: check it on a real iPhone.
  Android needs no permission while `targetSdkVersion` is below 37; at 37 add
  `ACCESS_LOCAL_NETWORK`. Android has no WebSocket library, so `DirectSocket.java` is a small
  `ws://` client of its own.

## The app carries its client

Decided 2026-11-24: the store apps (Android and iOS) carry the whole client, the hosted shell
(`dist-shell`), and no longer load it from `https://app.ovis.sh`, which stays for browsers and the
installed web app. Android keeps the origin `https://app.ovis.sh`, served from its own files; iOS
moves to one of its own. A test build that loads a preview shell from the network stays, and is
never uploaded to a store. Store builds are cut from a release tag's verified shell.

The app and the client agree on one contract:

- The app sets, at document start and before any page script, on every page it serves from its own
  files: `window.__ovisAppShell = { bundled: true, platform: "android" | "ios", appVersion: "<versionName>", build: <versionCode> }`
  (Android `addDocumentStartJavaScript`, iOS a `WKUserScript` at document start). Only the app's own
  origin gets it, never a PC's page (an address, Tailscale, an SSH PC's loopback origin), which runs
  that PC's own client. A build that loads the hosted or a preview shell sets nothing.
- [`src/lib/appShell.ts`](../src/lib/appShell.ts) is the one place that reads it. Where it is absent
  nothing changes. Where it says `bundled: true` the client:
  - registers no service worker, and the first time it finds the ones a hosted build left (one per
    PC's scope, any of which would open a PC's page from the hosted copy it kept), unregisters them,
    deletes their caches and loads a page one of them served once more; IndexedDB and web storage,
    which hold the pairings, stay (`retireServiceWorkers` in `src/lib/shellMode.ts`, `src/pwa.ts`);
  - never reloads for a newer copy: a PC newer than the client opens in it, and the app-updated line
    offers no reload (`src/lib/relay/updateFlow.ts`, `src/lib/updateNotes.ts`);
  - is held to the oldest client the PC supports, `min_supported_client` in the relay `WELCOME`:
    below it, that PC shows **Update the app** with one button to the store page for `platform`,
    opened outside the app, and Back to the other PCs, which still open;
  - counts its own origin as the app's where the hosted one was compared (the direct carrier's
    plugin call, `directPageAllowed` in `src/lib/relay/directSocket.ts`; the plugin's own gate still
    decides).
- The demo is the page its own build marks (`window.__ovisDemo`, set by `site/demo/transport.ts`,
  read by `src/lib/demo.ts`), not one at a `capacitor:` address: on iOS the app's own copy is at one
  too. Settings' Change PC calls only a marked page the demo, and the header's route mark leaves out
  only the app's demo.
- Only the relay and the direct carrier name the floor: both speak Ovis Mux, whose `WELCOME` carries
  it. A PC added by address, Tailscale or SSH loads its own client from the PC, so the two never
  differ and nothing is compared.
- The iOS copy's fetches and sockets carry `Origin: capacitor://app.ovis.sh`. Nothing on a PC or a
  relay accepts the hosted origin by name, so nothing accepts this one either, and nothing had to
  change: the relay reads no `Origin`; through it the PC gives every request its own origin
  (`relayHeaders`); the direct carrier takes only a socket that names no origin, the plugin's; a
  PC's own HTTP and WebSocket take only their own origin. Tests pin each for both origins and
  `capacitor://localhost`, and a PC from 0.5.9 behaves the same.

What a PC supports, and when the floor may rise: [The phone app's client](development.md#the-phone-apps-client).

## Risks and open questions

- App Review guideline 4.2 (a web wrapper): the native connect flow, push and the demo mode are
  the answer. Expect at least one round trip.
- Capacitor documents `server.url` as meant for live reload, not production. The spike found
  that a loader page costs about 1.5 s per launch, so the app sets the same `serverURL` at
  runtime through a `CAPBridgeViewController` subclass instead (`app/`).
- WKWebView keyboard and IME behaviour can differ from Safari's; the iOS keyboard regressions
  need a run inside the app.
- A plain `http://` PC address (LAN or a Tailscale IP without `tailscale serve`) needs an App
  Transport Security exception that review must accept. `https` through `tailscale serve` needs
  none.
- Several PCs: the app should list them, as the remote PCs feature does in the browser.
- The relay's domain is `push.ovis.sh` (decided 2026-10-23). The app is Ovis, with the ID
  `sh.ovis.app`.
- The macbook is shared with other sessions (a ChatGPT CUA was running on 2026-10-18): check it
  is free before booting a simulator there.
