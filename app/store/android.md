# Google Play: the closed test, then production

The owner's Play developer account is a personal one made after November 2023, so Google lets
the app reach production only after a **closed test with at least 12 testers who stay opted in
for 14 days in a row**. This page is everything for that first closed-test release: the build,
the upload key, the store listing, the App content answers, and the clicks in Play Console.

The first test build, 1.0 (1), had no push notifications. 1.0 (2) is the first with them: it is
built with `google-services.json` (FCM), and the data safety answers below cover its push token.

## 1. The upload key (the owner runs this, once)

Play App Signing keeps the key that signs the app on phones; you upload builds signed with your
own **upload key**. The key and its passwords never go into the repository or to anyone else; the
repository's `.gitignore` ignores `*.jks`, `*.keystore` and `upload.properties` wherever they are
put, in case one ends up inside the checkout.

If `~/.config/ovis-android/ovis-upload.jks` and `~/.config/ovis-android/upload.properties`
already exist on your PC, you have one: skip to [the build](#2-the-build). To see its
fingerprint (no password is shown): `keytool -list -v -keystore ~/.config/ovis-android/ovis-upload.jks`.

Otherwise make one:

```bash
mkdir -p ~/.config/ovis-android && chmod 700 ~/.config/ovis-android
keytool -genkeypair -v -storetype PKCS12 -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload -keystore ~/.config/ovis-android/ovis-upload.jks
# it asks for a password (use the same one for the key) and your name
```

Then write `~/.config/ovis-android/upload.properties` (an absolute `storeFile`; a relative one
is taken from `app/android/app`):

```properties
storeFile=/home/YOU/.config/ovis-android/ovis-upload.jks
storePassword=THE_PASSWORD
keyAlias=upload
keyPassword=THE_PASSWORD
```

```bash
chmod 600 ~/.config/ovis-android/upload.properties ~/.config/ovis-android/ovis-upload.jks
```

Keep a copy of the `.jks` file and the password in your password manager. If the upload key is
ever lost, Play Console can reset it (Setup > App signing > Request upload key reset), because
Play holds the app signing key.

## 2. The build

`app/android/app/build.gradle` signs a release with the upload key when
`OVIS_UPLOAD_PROPERTIES` names that file. A missing file or a missing entry fails a release
build with what is wrong, never a debug build. Build from `main` (after #1697 is merged, so the
test build has backups off and the error page reasons):

```bash
git switch main && git pull
bun install && (cd app && bun install)
cd app && bun run build:web && bunx cap sync android
cd android && OVIS_GOOGLE_SERVICES=~/.config/ovis-push/google-services.json \
  OVIS_UPLOAD_PROPERTIES=~/.config/ovis-android/upload.properties ./gradlew bundleRelease   # without OVIS_GOOGLE_SERVICES the bundle has no push
# app/android/app/build/outputs/bundle/release/app-release.aab
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab   # shows your upload key
```

| Field | Now | Rule |
|---|---|---|
| `applicationId` | `sh.ovis.app` | never changes once uploaded |
| `versionCode` | `3` | raise it by one for every upload, test tracks included (`defaultConfig` in `app/android/app/build.gradle`) |
| `versionName` | `1.0` | what people see; raise it for each public release |
| `targetSdkVersion` | 36 | Play asks new apps for a recent target |

## 3. Store listing

Default language: English (United States). A translation can be added later under Store
presence > Main store listing > Manage translations.

**App name** (30 at most): `Ovis for herdr`

**Short description** (80 at most):

> Your herdr coding agents and terminals, on your phone.

**Full description:**

> Ovis puts the herdr terminal multiplexer on your phone. See every coding agent running on your
> PC, such as Claude Code or Codex, read its conversation, answer its questions and type into its
> terminal.
>
> How it works:
> - Install Ovis on your PC (ovis.sh) and open it there.
> - In the app, scan the pairing QR code from Settings > Phone & devices on the PC, or type its
>   address.
> - The app connects only to your own PC: over Tailscale or your own network, or, once you turn it
>   on on the PC, through the Ovis relay, end-to-end encrypted.
>
> No account, no ads, no tracking. Try the demo on the first screen to look around without a PC.
>
> Ovis is open source: https://github.com/devswha/ovis

**Graphics** (in `app/store/android/`):

| Asset | File | Play's rule |
|---|---|---|
| App icon | `icon-512.png` | 512 x 512 PNG |
| Feature graphic | `feature-graphic.png` | 1024 x 500, no transparency |
| Phone screenshots | `screenshots/phone-*.png` | 2 to 8, 1080 x 1920 here (9:16) |

The screenshots are the app's own connect screen and its bundled demo, taken in an Android 16
emulator; no real PC or session is in them.

**Store settings:** category Tools; contact email: yours (Play shows it publicly); website
`https://ovis.sh`; privacy policy `https://ovis.sh/privacy/`.

## 4. App content answers (Policy > App content)

| Section | Answer |
|---|---|
| Privacy policy | `https://ovis.sh/privacy/` |
| App access | "All or some functionality is restricted". Instructions: *No account is needed. The app opens a computer that runs the Ovis server (open source, ovis.sh). Without one, tap "Try the demo" on the first screen: it shows the whole app with made-up agents and terminals, on the phone only.* No login details. |
| Ads | No, the app has no ads |
| Content rating | Category "All other app types" (utility). Every question No: no violence, sexual content, profanity, drugs, gambling; no user-to-user chat or sharing between users; no location sharing; no digital purchases. Expected rating: Everyone / PEGI 3 |
| Target audience | 18 and over only (a developer tool; the privacy policy says it is not for children) |
| News app | No |
| Government app | No |
| Financial features | None |
| Health | None |
| Advertising ID | No, the app does not use it |
| Data safety | below |

**Data safety** (as of 1.0 (2), with push; the Ovis relay in 1.0 (4) changes no answer). Google
counts as collected anything the app sends off the phone, wherever it goes, so what travels to the user's own PC counts too. Its
exception for data a user sends to their own storage needs an app that "never collects or
accesses" that data, and Ovis shows it, so it does not apply. Three routes leave the phone:

- **To the user's own PC**: everything the app shows and sends while it is open. For a PC paired
  through the Ovis relay it travels through the developer's `relay.ovis.sh`, end-to-end encrypted
  between the phone and the PC (`docs/relay.md`, Trust model): the relay sees each connection's
  PC relay ID (and, for the PC's own connection, its public key), its role, its address and when
  and how much passes, never the content, and keeps none of it (no logs, no storage; the
  address only rate-limits). The app such a PC opens in is static files from `app.ovis.sh`
  (Cloudflare Pages), which sees requests for those files: the phone's address and the PC's relay ID
  in the path. A file path or pane the page shows stays in the address's fragment, which the
  browser never sends. No code of the developer's runs on those requests (no Pages
  Functions) and the developer keeps no log of them. So for the encrypted content (the types in
  the table that the user sees and sends) the relay adds no type and no recipient: it still goes
  only to the user's PC. What the relay services do get, unencrypted, is checked against the
  form:
  - The PC's relay ID (`server_id`) names the user's PC, so it is a Device or other ID. The relay
    holds it only in memory for the life of a connection, but it is also in the `app.ovis.sh`
    page address, which passes through Cloudflare, so it is not counted as processed ephemerally.
    Device or other IDs is already declared (collected, required, App functionality), so the
    answer stands; the row below now names the relay ID.
  - The connecting address (IP) of the phone and the PC is used only to rate-limit connections,
    never to infer a location and never stored. Play has no IP data type of its own and asks for
    IP addresses to be declared by what they are used for; no location is derived from it, so it
    adds no Approximate location answer (the declared one comes from the usage counts).
  - The phone's relay key goes to the PC in place of a cookie, under Device or other IDs.
- **On to the developer, from the PC**: the Ovis server on the PC sends anonymous usage counts to
  the developer's telemetry Worker (`server/telemetry.ts`, `telemetry/worker.ts`). The client the
  phone opens tells the PC its settings (`TelemetryNotice` in
  `src/components/TelemetryControls.tsx`), and the PC puts the settings of the last browser or
  phone that told it into those counts. Details below.
- **To the developer's push relay, from the phone**: once alerts are turned on, the app registers
  its FCM push token with `push.ovis.sh` (`push-relay/`), which keeps it to forward the PC's
  end-to-end encrypted alerts through FCM.

Answers:

- *Does your app collect or share any of the required user data types?* **Yes.**
- *Is all of the user data collected by your app encrypted in transit?* **No** (a plain `http`
  address on a home network is allowed; over Tailscale, `https` and the Ovis relay it is
  encrypted; the usage counts go to the developer over `https`).
- *Do you provide a way for users to request that their data is deleted?* **No** (what goes to the
  PC is kept on the user's own computer; the usage counts hold no account or contact to find a
  person by).
- Data types, each **collected, not shared, not processed ephemerally**:

| Data type | What it is in Ovis | Required or optional | Purpose |
|---|---|---|---|
| Messages > Other in-app messages | the agent conversations the app shows and the prompts typed | required | App functionality |
| Photos and videos > Photos, Videos | pictures and videos the user attaches in the composer | optional, user-initiated | App functionality |
| Audio > Voice or sound recordings | dictation recorded with the composer's mic button; the PC passes it to the transcription provider set up there | optional, user-initiated | App functionality |
| Audio > Music files, Other audio files | audio files the user attaches in the composer | optional, user-initiated | App functionality |
| Files and docs | files the user attaches in the composer, and files opened in the file viewer | optional, user-initiated | App functionality |
| App activity > Other user-generated content | what is typed into terminals | required | App functionality |
| App activity > App interactions | the app settings the user chose (theme, font sizes, language, alert and voice options and the like), in the PC's usage counts to the developer | optional (can be turned off) | Analytics |
| Device or other IDs | the sign-in cookie a PC gives the phone when it is paired, or for a PC paired through the Ovis relay the public half of the key the phone makes for it (to the PC); that PC's relay ID, in the requests to the developer's `relay.ovis.sh` and `app.ovis.sh` that open it; the random ID the PC makes for its usage counts (to the developer); the phone's FCM push token, kept by the developer's push relay to forward the PC's encrypted alerts, only once alerts are turned on | required (cookie); optional (ID, push token) | App functionality (cookie, push token); Analytics (ID) |
| Location > Approximate location | the country (two letters) the developer's receiver reads from the address the usage counts come from; the address is not stored | optional (can be turned off) | Analytics |
| App info and performance > Diagnostics | connection traces the page reports to the PC for troubleshooting | required | Analytics |

The composer's attachment picker takes any file (`src/components/Composer.tsx`,
`uploadPaneImage` in `src/lib/api.ts`), so every file-like type above is listed as optional and
user-initiated: nothing is sent unless the user picks it. None of it is "shared": the PC is the
user's own, the transcription provider is one the user chose and is sent to on the user's own
action, and the developer's receiver, push relay, Ovis relay and `app.ovis.sh` run on
Cloudflare, and FCM carries the encrypted alerts, as service providers.

**The usage counts, in full** (with the push token above, the only data that reaches the
developer):

- **When**: one event when the server is installed and one per new version, plus one message per
  UTC day it is in use. Nothing goes out before the client has shown its one-line notice ("Ovis
  sends anonymous usage counts"), and the first event waits 10 minutes after that, so it can be
  turned off first.
- **On or off**: **on by default (opt-out)**. The switch is under Settings > About > Anonymous
  usage counts, in the PC's browser and in the app alike, next to the exact messages. The PC's
  owner can also block it with `OVIS_TELEMETRY=0` or `DO_NOT_TRACK=1`.
- **What they hold**: a random ID made on the PC, the Ovis version, the PC's operating system and
  CPU type, how Ovis was installed, the allowlisted settings snapshot of the last browser or phone
  that opened it (no free-form text, paths or account names), and the kinds of coding agents
  running (such as `claude`). The receiver adds the country and never stores the address. Never
  included: pane names, paths, terminal content, code or messages.

`https://ovis.sh/privacy/` (and `/ko/privacy/`) says the same.

## 5. Play Console, click by click (the owner)

1. **Create the app**: Play Console > Create app. App name `Ovis for herdr`, default language
   English (United States), App, Free. Tick the two declarations and Create app.
2. **App content**: Policy > App content. Fill every section with the answers in section 4.
3. **Store listing**: Grow users > Store presence > Main store listing. Paste the texts and
   upload the graphics from section 3. Store settings: category and contact details.
4. **Tester group**: at https://groups.google.com, Create group. Name `Ovis testers`, email
   for example `ovis-testers@googlegroups.com`. Who can join: Invited users only (or Anyone can
   ask). Add at least 12 people with Google accounts (more is safer: a tester who leaves breaks
   the 14 days for that seat).
5. **Closed testing track**: Test and release > Testing > Closed testing > Create track (or use
   the existing Closed testing - Alpha). Countries/regions: add yours (Korea, and others your
   testers live in). Testers: choose Google Groups, enter the group's email, add a feedback email
   or URL, Save.
6. **First release**: in that track, Create new release. App signing: accept Play App Signing
   (Google makes the app signing key). Upload `app-release.aab` (section 2). Release name
   `1.0 (1)`, release notes `First test build.` (for the push build: `1.0 (2)`,
   `Push notifications.`; then `1.0 (3)`, `The page stays above the navigation buttons.`)
   Next > Save > Go to overview > Send changes for review (Publishing overview).
7. **Invite**: once Google approves (hours to a few days), open the track's Testers tab and copy
   the opt-in link ("Join on the web"). Send it to the group. Each tester opens it, taps Become a
   tester, then installs Ovis from Play with the same Google account.
8. **14 days**: keep at least 12 testers opted in for 14 days in a row. Updates during the test
   are fine (raise `versionCode`).
9. **Production**: Dashboard > Apply for production. Google asks how you recruited testers, what
   feedback you got and what you changed; answer plainly. After approval, create a production
   release with the same AAB or a newer one.

## Later builds

- **Push (FCM)**, from 1.0 (2): built with `OVIS_GOOGLE_SERVICES` naming the Firebase project's
  `google-services.json` (without it the app builds with push unavailable). The phone's FCM token
  goes to the push relay, so "Device or other IDs" covers it (above), as does the privacy policy.
- **Ovis relay**, from 1.0 (4): the app opens a PC paired through `relay.ovis.sh` in the app
  served from `app.ovis.sh`. Both are named in the privacy policy; the Data safety answers above
  stay as they are (see the first route).
- Every new upload: raise `versionCode`, build as in section 2, upload to the track.
