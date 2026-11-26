# App Store: TestFlight, then review

Everything for the first App Store release of the iOS app that does not need the owner's Apple
login: what the project already sets, the clicks in Apple's sites, the listing, the privacy and
age answers, and the review notes. Screenshots are in `app/store/ios/`.

The first release has no push notifications (they need an APNs key and the Notification Service
Extension, a later build; see [Later builds](#later-builds)).

## 1. What the project sets

| Setting | Value | Where |
|---|---|---|
| Bundle ID | `sh.ovis.app` | `PRODUCT_BUNDLE_IDENTIFIER`, `app/ios/App/App.xcodeproj` |
| Version | `1.0.3` | `MARKETING_VERSION`, in the project's build settings, which the app and its extension share (not a target's General tab) |
| Build | `12` | `CURRENT_PROJECT_VERSION`, in the project's build settings too; raise it by one for every upload, TestFlight included |
| Devices | iPhone and iPad | `TARGETED_DEVICE_FAMILY = "1,2"`, so the listing needs iPad screenshots too |
| Minimum iOS | 15.0 | `IPHONEOS_DEPLOYMENT_TARGET` |
| Signing | Automatic, no team yet | the owner picks the team in Xcode (section 3) |
| Camera text | "Scan the QR code your PC shows under Settings → Devices and PCs → Add a connection." (Korean in `ko.lproj/InfoPlist.strings`) | `NSCameraUsageDescription`, `Info.plist` |
| Microphone text | "Dictate messages and commands to your agents with voice input." | `NSMicrophoneUsageDescription`, `Info.plist` |
| Speech recognition text | "Turn what you say into text for your agents when no OpenAI key is set." | `NSSpeechRecognitionUsageDescription`, `Info.plist` |
| Export compliance | no non-exempt encryption (only Apple's HTTPS) | `ITSAppUsesNonExemptEncryption = false`, so uploads skip the question |
| Privacy manifest | no tracking; product interaction, device ID and coarse location collected for analytics, linked to the PC's install ID, not tracking (the PC's usage counts, section 5); user ID collected for app functionality, linked, not tracking (the account sign-in, section 5); UserDefaults for the app's own settings (reason `CA92.1`) | `app/ios/App/App/PrivacyInfo.xcprivacy` |

## 2. Apple's sites, click by click (the owner)

1. **App ID**: developer.apple.com > Account > Certificates, Identifiers & Profiles > Identifiers
   > + > App IDs > App. Description `Ovis`, Bundle ID Explicit `sh.ovis.app`. No capabilities
   for now (Push Notifications comes with the push build). Continue, Register.
2. **App record**: appstoreconnect.apple.com > Apps > + > New App. Platform iOS, Name
   `Ovis for herdr` (if Apple says the name is taken, try `Ovis - herdr on your phone`), Primary
   language English (U.S.), Bundle ID `sh.ovis.app`, SKU `ovis-ios`, User access Full Access.
3. **API key** (only if uploads should run from the command line instead of Xcode): App Store
   Connect > Users and Access > Integrations > App Store Connect API > Team Keys > +, name
   `ovis-upload`, access App Manager. Download the `.p8` once and keep it with the Key ID and
   Issuer ID in your password manager; it never goes into the repository. Xcode's own upload
   needs no key.

## 3. Build and upload (the owner, on his Mac with Xcode)

The last upload is version 1.0.3 build 12, built from the tag `v0.5.11` (`ba4d41e3`) with that release's shell,
uploaded on 2026-11-27 and in internal TestFlight testing only (not submitted for review). The App Store has version
1.0.2 build 11, built from main at `d30527fd` (the app opens on the account sign-in, #4256, with the privacy manifest
of #4273), approved and on sale since 2026-11-20; build 10, from `0c4f0673`, came before it. Check App Store Connect before uploading in case a later build has already been uploaded. The App and OvisNotifications targets inherit the same project-level
build number in Debug and Release.

The app carries the hosted shell of a release ([The shell inside the app](../../docs/native-app.md#the-shell-inside-the-app-ios)),
and Xcode archives `sh.ovis.app` only with one: the tag's `dist-shell.tar.gz`, checked against the SHA-256 the release
published with it, never a shell built on this Mac, and never none. Build from the same tag, as the Android app is
(`app/store/android.md`), so the native code and the shell it serves are one release's:

```bash
tag=v0.5.10   # the release whose shell the app carries
git switch --detach "$tag"
sh app/ios/check.sh                                     # the app's Swift tests, which no CI job runs
bun install && (cd app && bun install)
dir="$(mktemp -d)"
gh release download "$tag" --pattern 'dist-shell.tar.gz*' --dir "$dir"
cd app && OVIS_APP_SHELL_ARCHIVE="$dir/dist-shell.tar.gz" OVIS_APP_SHELL_SHA256="$(cut -d ' ' -f 1 "$dir/dist-shell.tar.gz.sha256")" \
  OVIS_APP_SHELL_TAG="$tag" bun run sync                # build:web, then cap sync ios
bun run open                                            # Xcode
```

In Xcode: target App > Signing & Capabilities > Team: your team (Automatically manage signing
stays on). Destination Any iOS Device (arm64). Product > Archive. When the Organizer opens:
Distribute App > App Store Connect > Upload, keep the defaults, Upload.

The build shows under App Store Connect > the app > TestFlight after Apple processes it (minutes
to an hour). Internal testing (you and up to 100 people on your team) needs no review; external
testers need a short beta review.

## 4. Store listing (App Store Connect > the app > App Store > iOS App 1.0)

**Name** (30 at most): `Ovis for herdr`

**Subtitle** (30 at most): `herdr agents on your phone`

**Promotional text** (170 at most):

> See and steer the coding agents on your PC from your phone: read their conversations, answer
> their questions, type into their terminals.

**Description:**

> Ovis puts the herdr terminal multiplexer on your phone. See every coding agent running on your
> PC, read its conversation, answer its questions and type into its terminal.
>
> How it works:
> - Install Ovis on your PC (ovis.sh) and open it there.
> - In the app, scan the pairing QR code from Settings > Devices and PCs > Add a connection on the
>   PC, or type its address.
> - The app connects only to your own PC: over Tailscale or your own network, or, once you turn it
>   on on the PC, through the Ovis relay, end-to-end encrypted.
>
> Sign in with GitHub, Google or Apple, or start without an account. No ads, no tracking.
>
> Ovis is open source: https://github.com/devswha/ovis

**Keywords** (100 at most): `herdr,terminal,multiplexer,coding agent,ai agent,remote,developer,shell,cli,tailscale`

| Field | Value |
|---|---|
| Support URL | `https://ovis.sh/support/` |
| Marketing URL | `https://ovis.sh` |
| Privacy policy URL | `https://ovis.sh/privacy/` |
| Category | Developer Tools; secondary Productivity |
| Copyright | `2026 devswha` |
| Price | Free |

A Korean localization can be added later (App Store Connect > the app > App Information >
Localizable Information).

**Screenshots** (in `app/store/ios/`, from the iOS simulator: the connect screen and the
bundled demo, no real PC). The connect screens in them predate the hosted Connect a PC screen and its
look: take them again from a current build before the next upload.

| Display | Files | Size | Simulator |
|---|---|---|---|
| iPhone 6.9" | `iphone-1-connect.png`, `iphone-2-chat.png`, `iphone-3-workspaces.png` | 1320 x 2868 | iPhone 18 Pro Max, iOS 27 |
| iPad 13" | `ipad-1-connect.png`, `ipad-2-chat.png` | 2064 x 2752 | iPad Pro 13-inch (M5), iOS 27 |

App Store Connect scales these down for the smaller displays it asks about. All are RGB PNGs
without transparency, with the status bar set to 9:41.

## 5. App Privacy (App Store Connect > the app > App Privacy)

Apple counts data as collected when it leaves the device "in a way that allows you and/or your
third-party partners to access it". What the app shows and sends goes only to a computer the
user runs, so it is not collected in Apple's sense. That holds through the Ovis relay too, on
the terms of its trust model (`docs/relay.md`, Trust model): a PC paired that way is reached
through the developer's `relay.ovis.sh` (or its regional endpoint `relay-ap.ovis.sh`), end-to-end
encrypted between the phone and the PC, so
the relay cannot read the content, and it keeps no logs and stores nothing. The encryption ends
in the app the phone runs for that PC, which is code the developer serves from `app.ovis.sh`
(Cloudflare Pages): it holds the phone's key and shows what the PC sends, so it protects the
content from the relay, not from that code. That code is open source, built by the Release
workflow from each tag and published with its SHA-256, and sends the content only to the PC.
`app.ovis.sh` sees requests for its static files (the phone's address and the PC's relay ID; a
file path or pane the page shows stays in the address's fragment, which is never sent); no code
of the developer's runs on them and the developer keeps no log of them.
One route does reach the developer: the app tells the PC the settings chosen in it
(`TelemetryNotice` in
`src/components/TelemetryControls.tsx`), and the Ovis server on the PC puts the settings of the
last browser or phone that opened it into its anonymous usage counts, which it sends to the
developer's telemetry Worker (`server/telemetry.ts`, stored by `telemetry/worker.ts`). They are on
by default (opt-out), start only after the client has shown its notice, and stop when turned off
under Settings > About > Anonymous usage counts (in the app or on the PC), or with
`OVIS_TELEMETRY=0` on the PC. They hold a random ID made on the PC, the Ovis version (and the one an update replaced, left out of an update still owed across an off and on or made while off, and of a new state's first message; other updates name it), the
terminal runtime it serves (herdr or herdr-core), the PC's
operating system, CPU and install method, the allowlisted settings snapshot (no free-form text,
paths or account names), the kinds of coding agents running, the kinds of screen the app was opened on and how they reached
the PC, how many prompt answers were sent and alerts delivered and tapped, once a day has ended how often the
app's buttons were used that day (fixed names, each count a rough range, narrow and wide screens apart, for a few actions whether by button, menu, shortcut or palette,
and the list of which of these controls were shown, never what was typed or which pane), and the country the receiver reads from the PC's address (the address is not stored).
A second route reaches the developer only once the user signs in (signing in is optional): the
app signs in with the developer's account service, `account.ovis.sh` (`docs/account.md`), which
keeps a random account ID and, for each sign-in method added, a one-way hash of that provider's
ID for the user (never the email, name or the provider's tokens); one-way hashes of each signed-in
device's tokens and the push subscription it registered; for each PC added, its name, relay ID and
public key; and, for a join or link-page request, the device's name and public key and the country
and city Cloudflare saw it come from, deleted within about a day, so an approval can show roughly
where it came from (`https://ovis.sh/privacy/#account` lists it all). The device and PC names the user types and the system a device reports (such as iOS or Linux) are
labels for the approval card, not personal info or a device identifier, so they add no data type. Delete account (Devices >
Account) erases it at once, as App Review asks of an app that lets people make an account.

Get Started > *Do you or your third-party partners collect data from this app?* **Yes, we collect
data from this app.** Then declare:

| Data type | Use | Linked to the user | Tracking |
|---|---|---|---|
| Usage Data > Product Interaction (the settings chosen in the app, daily use, how often its buttons are used, whether by button, menu, shortcut or palette, and which of them were shown) | Analytics | Yes | No |
| Identifiers > Device ID (the random install ID the PC makes; once signed in, the account service's device push subscriptions and PC relay IDs and keys) | Analytics, App Functionality | Yes | No |
| Location > Coarse Location (the country, two letters, of the usage counts; once signed in, the country and city of a join or link-page request) | Analytics, App Functionality | Yes | No |
| Identifiers > User ID (the random account ID, only when signed in) | App Functionality | Yes | No |

The usage counts count as linked: Apple's definition covers data tied to a device-level identifier, and the
receiver stores them with the PC's persistent install ID (random, with no account, name or contact
behind it). None is used for tracking: nothing is combined with other companies' data or shared
with data brokers or advertisers. What the account service keeps is
linked to the account. The privacy manifest lists the same four types with the same purposes, and
`https://ovis.sh/privacy/` describes both routes in full. Privacy policy URL:
`https://ovis.sh/privacy/`.

## 6. Age rating (App Information > Age Rating > Edit)

Every content question: None. Contests: No. Gambling: No. Loot boxes: No. User-generated content
shared with other users: No. Messaging or chat with other users: No. **Unrestricted web access:
Yes**: the connect screen takes any http or https address and opens it in the app's web view, so
a user can open any website, which is what Apple's definition covers ("users can navigate to any
webpage within the app"). Apple then rates the app **16+**. (Only links inside the opened page
that lead elsewhere go to Safari.) If a lower rating ever matters, the app would first have to
refuse addresses that are not an Ovis server, which is an app change, not a form answer.

## 7. App Review information (version page > App Review Information)

- Sign-in required: **No** (signing in is optional, and the demo below needs no account).
- Contact: your name, phone and email.
- Notes:

> Ovis is the phone app for Ovis, an open-source program people run on their own computer to
> watch and control their coding agents and terminals (https://ovis.sh). The app connects only
> to the user's own computer, directly or through the end-to-end encrypted Ovis relay that
> computer turns on. Signing in is optional. To review the whole app without a computer: on the
> first screen, Connect a PC, tap the Tailscale tab, type demo in the address field and tap Connect. With
> no internet the app shows its own screen instead ("Can't connect to the internet"): type demo in
> its address field and tap Connect. Either way it runs the full
> interface with made-up agents and terminals, entirely on the phone. "Scan QR code" uses the camera only to read the
> pairing code a computer shows. The app uses the microphone for voice input the user chooses:
> turning Voice input on in Settings briefly opens it to ask for access; the mic button or the
> keyboard shortcut starts dictation.

## 8. Release checklist

- [ ] App ID `sh.ovis.app` registered (section 2.1)
- [ ] App record made (2.2)
- [ ] Team set in Xcode, build number raised if this is not the first upload
- [ ] Archive uploaded, build processed, tried in TestFlight on a phone
- [ ] Listing texts, URLs, category, screenshots (iPhone and iPad) filled in
- [ ] App Privacy published (the three types in section 5)
- [ ] Age rating answered
- [ ] Review notes and contact filled in
- [ ] Build selected on the version page > Add for Review > Submit

Apple may ask about guideline 4.2 (an app that is "mostly a website"). The first screen, Connect a PC,
is the hosted page at `app.ovis.sh`, the one a browser shows too, so the answer is what the app does
natively that no website can:

- its own connect screen for when there is no internet, carried in the app: open a PC by its address,
  scan its QR code, and list, open, forget and manage the PCs this phone saved;
- an SSH client: it adds a PC over SSH from the phone, checks and pins its host key, and keeps the
  phone's own SSH key on the device (the setup, Manage and removal screens are the app's);
- the QR scanner (the camera reads a PC's pairing code);
- push notifications through the app (`OvisPush`; live once the APNs key and the Notification Service
  Extension ship, see [Later builds](#later-builds));
- direct connections to a PC on the same network (`OvisDirect`), which a page cannot open;
- the bridge the PC's pages use for all of these, and the bundled demo, which runs the whole interface
  offline.

If Apple still objects to a hosted first screen, the fallback plan is a build made with
`OVIS_APP_HOME=bundled bun run build:web`: its first screen is the app's own connect screen again, with
the relay sign-in, Tailscale and SSH tabs, and nothing else changes.

## Later builds

- **Push (APNs)**: an APNs auth key (developer.apple.com > Keys > + > Apple Push Notifications
  service) for the relay, the Push Notifications capability on `sh.ovis.app`, and the
  Notification Service Extension target. The App Privacy answer changes then: the device's push
  token goes to the push relay ("Device ID", app functionality, linked, as the relay keeps it per
  device, not tracking), and so does the privacy manifest.
- Every upload: raise `CURRENT_PROJECT_VERSION`; raise `MARKETING_VERSION` for each public
  release. Both are the project's build settings, so the app and its extension keep one version
  ([docs/native-app.md](../../docs/native-app.md#the-app-app)).
