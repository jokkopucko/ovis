# SSH PCs in the iOS app: plan

Not built yet. The Android app adds a PC over SSH (docs/native-app.md, PCs over SSH); this is what the
iOS twin needs, so a later change starts from decisions rather than research. Size: 9 to 12 days for
one person who knows the iOS shell, plus 2 for the first install from the phone.

## What stays the same as on Android

The model carries over unchanged, and so does the PC's side: nothing in `server/` or `shared/` changes.

- The phone connects to the PC's sshd and opens a direct-tcpip channel to the PC's own Ovis on its
  127.0.0.1, found through the bridge descriptors in `~/.config/herdr-web-ui/bridges/` (the
  `DISCOVER` command of `SshLink.java`, which can be copied as it is). Ovis lets a request from its
  own loopback in as its own PC's: no token is typed or kept.
- The WebView loads the PC from a listener on the phone's loopback, one per PC, kept at the same
  address so the page's origin (drafts, storage, its service worker) stays put.
- A gate cookie, HttpOnly, set by the app, keeps other apps on the phone out of that listener.
- Host keys: confirm the SHA-256 fingerprint once, fail closed on any change, forget only on purpose
  (`SshHostKeys.java` is 40 lines to port, and `SshHostKeysTest` lists the cases).
- The phone's own key, a password used once to register it, a pasted key; the error kinds and their
  words (`SshFailure`, `SshWords`, `app/web/error.html`, which the iOS app already shows); Manage on
  the connect screen (`app/web/connect.js` only needs the plugin's methods under the same names).
- No background connection: iOS suspends the app's sockets, and the connection is made again when the
  app comes back, as the Android app does without a foreground service. A draft is never re-sent.

## Library: SwiftNIO SSH

[apple/swift-nio-ssh](https://github.com/apple/swift-nio-ssh), Apache-2.0, maintained by Apple's
SwiftNIO team. It has client sessions, direct-tcpip child channels, ed25519 and ECDSA P-256/384/521
user keys, curve25519 key exchange and AES-GCM, and its cryptography comes from swift-crypto, which on
Apple platforms is CryptoKit.

- It has no RSA, on purpose. A pasted RSA key (still common in `~/.ssh/id_rsa`) needs either
  [Citadel](https://github.com/orlandos-nl/Citadel) (MIT, a client built on SwiftNIO SSH that adds
  RSA user keys and OpenSSH key parsing) or a small RSA signer of our own (one write-up of that:
  [Adding RSA support to swift-nio-ssh](https://lograker.app/blog/swift-nio-ssh-rsa-support)).
  Recommendation: start with Citadel for its OpenSSH private-key parser (bcrypt-encrypted keys
  included), and keep the session code on SwiftNIO SSH's own API so Citadel can be dropped later.
- Half-closure must be turned on for the child channels (`allowRemoteHalfClosure`), or the HTTP
  proxying behaves oddly; the library's README says so.
- Host keys come to a `NIOSSHClientServerAuthenticationDelegate`, where the rule above goes.

## Keys: Keychain, and the Secure Enclave for the phone's own key

- The phone's own key can live in the **Secure Enclave**, better than on Android: CryptoKit's
  `SecureEnclave.P256.Signing.PrivateKey`, handed to SwiftNIO SSH as
  `NIOSSHPrivateKey(secureEnclaveP256Key:)`, signs as an `ecdsa-sha2-nistp256` key that every OpenSSH
  since 5.7 accepts, and its private half never leaves the chip (described in
  [SSH keys in the Secure Enclave, without an agent](https://lograker.app/blog/secure-enclave-ssh-keys-without-an-agent)).
  Its access control is `.privateKeyUsage` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
  without Face ID per signature (a reconnect must not ask). Its `dataRepresentation` handle goes to
  the Keychain, never synced. The Secure Enclave has no ed25519, so the iOS phone key's line starts
  with `ecdsa-sha2-nistp256`, not `ssh-ed25519` as on Android.
- A pasted key and its passphrase go to the Keychain as generic passwords with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (not in iCloud Keychain, not in backups). A password
  is never stored.
- Save the handle before the key line goes to the PC, and drop it if that fails: the other order can
  leave a PC trusting a key that no longer exists.

## The loopback listener

- `Network.framework`'s `NWListener` on 127.0.0.1. iOS gives the loopback interface 127.0.0.1 alone,
  so where Android uses 127.0.0.n per PC, iOS uses one port per PC (a fixed one, saved with the PC).
  Cookies do not separate ports, so the gate cookie's name carries the PC's port
  (`ovis_ssh_gate_<port>`), and no two PCs may share a cookie name otherwise; the page's storage is
  per origin, port included.
- `WKURLSchemeHandler` with a custom scheme is not an option: a service worker and WebSockets do not
  go through it.
- The listener stops while the app is in the background. On `sceneWillEnterForeground` it listens
  again and the SSH connection is checked (a keepalive with a deadline) and made again before the page
  asks, as `SshTunnel.wake` does.
- The app already has `NSLocalNetworkUsageDescription` (direct connections on the same network); an
  SSH PC on the LAN uses the same permission.

## App Review and App Store Connect

- **Review notes**: "Adds a PC the user already reaches over SSH: the app connects from the phone to
  the user's own server, with the user's own key, and shows the Ovis web app that runs there. No
  server of ours is involved. The demo mode (Try the demo on the first screen) shows the app without
  any server." Guideline 2.1 needs a way to review it: keep the demo, and offer a reviewer a test
  server only if they ask (a disposable container like `scripts/fixtures/phone-ssh`, never a real PC).
- **Remote access apps**: guideline 4.2.7 is about remote desktop clients; an SSH client that shows a
  web app the user's own server serves is within what SSH clients in the store (Termius, Blink, Prompt)
  do. Say so in the notes.
- **Encryption export**: the app now declares `ITSAppUsesNonExemptEncryption = false`. SwiftNIO SSH's
  algorithms come from CryptoKit on iOS, which keeps the app within "encryption in Apple's operating
  system" as long as nothing else (Citadel's RSA, a bundled BoringSSL) brings its own. If Citadel's RSA
  signer is used, it does: re-answer the questions in App Store Connect for that build (the app then
  uses standard algorithms itself, which is exempt under the mass-market rules but changes the answer),
  following Apple's [Complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).
  The owner decides this answer; it is not a code change.
- **Privacy nutrition label**: nothing new is collected; the keys and host keys stay on the phone.
- Ship it as its own update, separate from any build in review.

## Order of work (about 9 to 12 days)

1. Spike, 1 day: SwiftNIO SSH client, host-key delegate, one direct-tcpip channel to the fixture's
   Ovis, ed25519 key, from the simulator to `scripts/fixtures/phone-ssh/up.sh`.
2. Key store, 2 days: Secure Enclave phone key and its line, Keychain for pasted keys, OpenSSH key
   parsing (Citadel), unit tests over the same `ssh-test-keys` files as Android's.
3. Listener and tunnel, 2 days: `NWListener`, gate cookie, the lifetime rules of `SshTunnel` (made
   when needed, made again after it ended, a stop never retried, nothing re-sent), with their tests
   ported from `SshTunnelTest` (clock and dialer injected).
4. Setup screen, 1.5 days: SwiftUI over the same steps and words (`SshSetupActivity`, `SshWords`).
5. Plugin and connect screen, 1 day: `OvisSsh` with Android's methods (`add`, `list`, `setUp`,
   `rename`, `phoneKey`, `copy`, `forgetHostKey`, `remove`); `connect.js` then works as it is.
6. Error page and reconnect on return, 1 day.
7. QA on a real iPhone and the fixture, review notes, 1.5 to 3.5 days.
8. First install from the phone, 2 days: the same installer command as Android's
   (`SshLink.INSTALLER_RUN`), with the app kept in front while it runs.
