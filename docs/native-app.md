# Native app plan

Status: Phase 1 step 2 built for iOS (checked in a simulator) and Android (checked in an emulator),
2026-10-19. To run them, see [The app (app/)](#the-app-app) and
[The Android app](#the-android-app). Step 3, the push relay, is built in
[`push-relay/`](../push-relay/README.md) with its tests, 2026-10-23, for iOS (APNs) and Android
(FCM), and deployed at `push.ovis.sh` on 2026-10-24, where its APNs and FCM credentials passed
their authentication tests. Steps 4 and 5, the client's push through the app and the iOS
Notification Service Extension, are built, 2026-10-24 (see [Push in the app](#push-in-the-app));
a push received on a real device is still to be checked. iOS 1.0 (build 2) is in App Review.

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
   (build 2) was submitted for review on 2026-10-24, to be released by hand once approved.

## Phase 2 and later

- Live Activity for a running agent, home-screen widgets (both need Swift, and pushes through
  the same relay).
- Android pushes. The relay's FCM route, the app's receiving module
  ([`ovis-push`](../app/android/ovis-push/README.md)) and the client's subscribe through it (step 4)
  are built, and the relay is deployed with its FCM credentials. A release build needs
  `google-services.json` from the Firebase project (see that README). The Android app itself exists
  already (see [The Android app](#the-android-app)): the maintainer tests on a Galaxy, not an
  iPhone.
- Speed: measure what is slow before changing anything; bundling the UI in the app is off the
  table while the PC serves it.

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

- `app/web`: the app's own pages. `index.html` is the connect screen: an address field, Scan QR
  code, the PCs opened before, and Try the demo. `error.html` is shown when a PC cannot be
  reached or answers with an HTTP error (a 502 from `tailscale serve` while Ovis is stopped), with the
  reason, Try again and Change PC. Both are in English and Korean: an element's
  `data-ko` attribute holds its Korean text, put in when the phone's first language is Korean
  (`localize()` in `shell.js`; `error.html` carries its own copy, as it stands alone on Android).
  The iOS app lists `ko` in `CFBundleLocalizations`, without which its web view reports English
  to every page, the client included.
- A PC joins the list of PCs only once a page of it has loaded, so an address that never
  answered, or answered with an HTTP error, is not kept.
- A PC paired over the Ovis relay opens from its pairing link, scanned or pasted:
  `https://app.ovis.sh/s/<server_id>/#offer=...` (`relayLink()` in `shell.js`). Only the hosted
  shell's origin may carry an offer: one on any other origin is refused on the connect screen,
  as is an offer that names another PC than its path. The app opens the link as the WebView's
  first page, like any PC (the offer stays in the fragment through
  `instanceDescriptor().serverURL` on iOS, a 2026-10-30 Simulator spike, and through the start
  path on Android), and the hosted shell pairs from there. Every relay PC shares that origin, so
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
  with `OVIS_APP_URL=https://<host> bun run build:web`.
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
  for a Tailscale address that Tailscale may be off on the phone (WebKit alone waits a minute or
  more, which is what a phone with Tailscale off sees for a `.ts.net` address, and while that
  connection hangs it did not paint the error page either). When a Tailscale address fails to
  load, `error.html` (on Android too) adds the same note. A redirect of the address being opened
  to another origin is handled as on Android (see [The Android app](#the-android-app)), where
  Capacitor would send another host to Safari.
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
  logo drafts; `app/assets/ovis-sheep.png` is the sheep alone. The connect screen shows the
  logo, the sheep beside the word Ovis (`app/web/ovis-logo.png`). The PNGs in `app/assets` are
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
  open too. Tapping one opens the app, not yet the pane as a browser's does.
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
  each entry into another origin for its bridge, and the PC's own links stay in the WebView anyway.
  Opening or leaving a PC starts the activity again, so the next page is a first load and the
  old WebView goes with the old activity.
- `onPause` flushes WebView cookies. Without it, a pairing made a moment before the app was
  swiped away was lost: the next start asked for pairing again.
- `HerdrShellPlugin` and `PCStore` (SharedPreferences) mirror the iOS plugin and store. As on
  iOS, a pairing link stays in memory until a PC page loads.
- Capacitor injects its bridge only into the PC's origin, so `error.html`, served from the app
  alone, gets none. `MainActivity` hands that page a small `HerdrErrorPage` JavaScript interface
  for Try again and Change PC. For the same reason `error.html` carries its own style and
  script, which `app/scripts/build-web.ts` inlines.
- The manifest allows cleartext http to any host (see the connect screen's warning above).
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
  those features, they sit on the app's dark background (`colors.xml`), as does Android 12's own
  launch screen (`windowSplashScreenBackground`).
- With 3-button navigation the page stays clear of the buttons, at the bottom or, on a phone in
  landscape, at the side. On a WebView that gives the page its safe areas itself (140 and later),
  Capacitor's SystemBars lets the page draw under the system bars and leaves the room to the CSS,
  and the client's message box and key bar sit partly into the bottom safe area (the room an
  iPhone's home indicator leaves), so the buttons covered them on a Galaxy. The client's layout
  pads its sides for a side bar itself. `MainActivity` keeps the WebView clear of the bars'
  tappable part (`WindowInsetsCompat.Type.tappableElement()`, which a pinned taskbar on a large
  screen has too), and the strip beside it shows the window's background: the page's
  `theme-color` once the page has sent it, the app's dark background before. A gesture bar has no
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
  Anything else, such as a sign-in page, another site or a loop, gets no bridge and is not saved,
  and the error page names where the address led. After five PCs in a row made this way, the next
  redirect ends on the error page too. Once the first page shows, Capacitor decides on redirects
  as before: one could then come from a link to a page that is not the PC's (another port on its
  host), which must not choose the PC.
- `file_paths.xml` shares only the app's external Pictures folder, where Capacitor puts a photo
  taken for a file input.
- `build-web.ts` leaves out the client build's `.gz` and `.br` sidecars. The app reads files
  itself, and Android's asset merger takes `x.js` and `x.js.gz` for one asset.

Build and install, on a PC with the Android SDK and JDK 21:

```bash
bun install && cd app && bun install
bun run build:web && bunx cap sync android
cd android && ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug
# app/android/app/build/outputs/apk/debug/app-debug.apk
```

For Google Play, `./gradlew bundleRelease` makes `app/build/outputs/bundle/release/app-release.aab`.
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
