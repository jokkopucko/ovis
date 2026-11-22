# ovis-push: Android push through FCM

The Android half of the phone app's push (docs/native-app.md, "Notifications"). The PC's
`server/push.ts` sends Web Push as it does to a browser; the push relay (`push-relay/`) hands
each push to Firebase Cloud Messaging (FCM) as a data message holding the PC's ciphertext; this
module receives it, decrypts it with keys only the phone holds, and shows it. Neither the relay
nor Google can read a push.

## What is here

| File | Does |
|---|---|
| `OvisPushPlugin` | the `OvisPush` Capacitor plugin the client calls: `checkPermissions()`, `requestPermissions()`, `subscribe()`, `getSubscription()`, `unsubscribe()` |
| `OvisMessagingService` | receives FCM data messages, decrypts the `ovis` field, shows the notification (the fallback line "herdr needs you" when it cannot); a pane's alert taps through to that pane on the PC whose endpoint it came to (`MainActivity.openAlert`) |
| `WebPushDecrypt`, `PushKeys` | RFC 8291 / RFC 8188 (`aes128gcm`) decryption and the phone's P-256 keys, tested against RFC 8291's own example |
| `PushStore` | the keys, each PC's relay endpoint and the alert proof, in the app's private preferences |
| `AlertProof` | tells this app's own alert taps from another app's intent (`MainActivity` is exported): only the app's own PendingIntents carry the proof `PushStore` keeps |
| `OvisPushInitializer` | a startup provider that registers the plugin with the app's `BridgeActivity` |

The module is wired in from `app/android/settings.gradle`, which adds it to `:app`, and its
manifest merges into the app's (the service, the provider, `POST_NOTIFICATIONS`). That keeps
`app/android/app/build.gradle`, `AndroidManifest.xml` and `MainActivity.java` as they are while
PR #1697 changes them; once it is merged, the dependency and the plugin registration can move
into those files the usual way and the two hooks go.

## The client's side

From a PC page (Capacitor's bridge is there), the plugin answers like a browser's push manager:

```js
// applicationServerKey: the PC's VAPID public key (GET /api/push), as for pushManager.subscribe
const { subscription } = await Capacitor.nativePromise("OvisPush", "subscribe", { applicationServerKey });
// { endpoint: "https://push.ovis.sh/v1/push/<id>", expirationTime: null, keys: { p256dh, auth } }
```

That object goes to the PC exactly as a browser's `PushSubscription.toJSON()` does; the client
does this in `src/lib/push.ts`, and reads the permission from `checkPermissions()` and
`requestPermissions()` (`{ notifications }`, Capacitor's permission states) where a browser has
`Notification.permission`. Before Android 13 those answer whether the app's notifications are on,
as there is no permission to ask. The iOS app's plugin answers the same calls
(`app/ios/App/App/OvisPushPlugin.swift`). `subscribe()` asks for notifications on
Android 13 and later, gets the FCM token, and registers it with the relay once per PC, with that
PC's key, which the relay pins to the endpoint from the start. A new FCM token or a new PC key
makes a new endpoint at the next `subscribe()`; the old one answers 404 or 410 to the PC, which
drops it. Errors carry a code: `unavailable` (no Firebase in this build), `permission`,
`no_pc`, `invalid_key`, `failed`.

## Setting it up (the owner)

1. **Firebase project**: console.firebase.google.com > Add project (any name, for example
   `ovis`), Google Analytics off.
2. **Android app in it**: Project overview > Add app > Android. Package name `sh.ovis.app`,
   nickname `Ovis`. No SHA-1 is needed for FCM. Download `google-services.json`.
3. **Put it in the build**: copy it to `app/android/app/google-services.json`. That path is
   ignored by git; never commit it. (Or keep it anywhere and set `OVIS_GOOGLE_SERVICES` to its
   path when building.) `ovis-push/build.gradle` reads it and gives Firebase what the
   google-services Gradle plugin would, so no plugin is needed. Without the file the app builds
   and runs with push unavailable. `google-services.example.json` shows the shape with fake
   values.
4. **Relay credentials**: Firebase console > Project settings > Service accounts > Generate new
   private key. That JSON is a secret: it goes only into the relay, as
   `wrangler secret put FCM_SERVICE_ACCOUNT < key.json` (push-relay/README.md), then delete
   the downloaded file.
5. **Relay address**: the app registers with `https://push.ovis.sh`
   (`res/values/strings.xml`, `ovis_push_relay`); a self-hosted relay goes there.

## Privacy

The phone's FCM token goes to the relay, which keeps it to forward pushes (push-relay/README.md,
"What it keeps"). That changes the store answers when this ships: Google Play's data safety form
gets "Device or other IDs: collected, for app functionality, not shared", and the privacy policy
says the same. Firebase's own automatic token is off until a PC subscribes
(`firebase_messaging_auto_init_enabled`), so a phone that never turns alerts on never contacts
FCM.

## Tests

`./gradlew :ovis-push:testDebugUnitTest` in `app/android`: decryption of RFC 8291's example, a
changed ciphertext and other keys refused, and generated keys whose halves match.
