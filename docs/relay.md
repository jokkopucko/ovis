# The Ovis relay

[← User guide](guide.md#through-the-ovis-relay) · [Trust model](#trust-model) · [Connecting](#how-a-connection-is-made) · [Ovis Mux v1](#ovis-mux-v1) · [Errors](#errors-and-close-codes) · [Versions](#versions) · [Operations](#operations) · [Code](#code)

The Ovis relay lets a phone use Ovis on a PC from anywhere, with no Tailscale, port forwarding or
account. It's off until it's turned on in **Settings → Phone & devices** on the PC. Then the PC and
the phone each open a connection out to the relay, which joins the two. Everything they say to each
other is end-to-end encrypted: the relay passes it on, but it can't read it, change it or add to it.
The phone runs the same Ovis app a browser on the PC does, loaded from `app.ovis.sh` instead of from
the PC.

This page is the detail behind [Through the Ovis relay](guide.md#through-the-ovis-relay) in the
guide: what the relay and `app.ovis.sh` can see, who gets in, and the protocol the phone and the PC
speak. There are three parts:

- **The relay service**, [`relay/`](../relay/README.md), pairs a PC's WebSockets with a phone's and
  passes frames on as they came. `relay.ovis.sh` runs it on Cloudflare; anyone can run it with Bun.
- **The PC's side**, [`server/relay/`](../server/relay), keeps a connection to the relay while the
  relay is on, admits paired phones and runs their requests through the same code as a direct
  connection's.
- **The hosted app**, the client built with `bun run build:shell` and served at `app.ovis.sh`, holds
  the phone's key and reaches the PC through the relay.

## Trust model

### What the relay sees

For every connection, the relay sees the PC's relay ID (`server_id`: 32 hex characters worked out from
the PC's public key, made the first time the relay is turned on), that public key, whether the PC or a phone is connecting, the connecting
address, and when each frame passes and how big it is. From that it can tell which PC a phone uses,
when and for how long, and how much goes each way. The rhythm of the traffic shows too: a key typed
in a terminal goes out at once as a small frame, so the timing of keystrokes is visible, and so is
the size of what the PC sends back. Nothing is padded, and no cover traffic hides any of this.

`relay.ovis.sh` writes no logs and uses the address only to rate-limit connections. It keeps only
usage counters for capacity planning: per PC (under a hash of its relay ID), bytes each way, time
connected and sessions, kept three months; no content, address or device identity
([what it keeps](../relay/README.md#what-it-sees-and-keeps)). That is how
it's run, not something you can check from outside, so assume that whoever runs a relay, and the
network in front of it (Cloudflare, for `relay.ovis.sh`), can record everything above.

### What the relay can't do

- **Read the traffic.** The phone and the PC encrypt everything with the Noise protocol's NK pattern
  (`Noise_NK_25519_ChaChaPoly_SHA256`) in paseo's implementation
  ([`shared/vendor/paseo-e2ee/`](../shared/vendor/paseo-e2ee/README.md)), and both ends accept only
  its protected mode. The phone has the PC's public key from the QR code before it connects, so
  only the PC can complete the handshake.
- **Change, replay or slip in a message.** Every record is authenticated. A record the relay
  replays, reorders, truncates, duplicates or makes up closes the connection, and none of it reaches
  the app on either end ([`shared/relay-e2ee.spike.test.ts`](../shared/relay-e2ee.spike.test.ts)
  checks each case in both directions).
- **Pose as the PC.** A phone keeps the PC's public key from when it paired and refuses a PC that
  answers with another one.
- **Get in as a phone.** The PC admits a phone only with a pairing code, which travels inside the
  encrypted connection, or a signature made with that phone's own key ([Who gets in](#who-gets-in)).

What the relay can do is hold the traffic up: refuse connections, cut them or delay frames. The app
then reconnects by itself or says the relay can't be reached, and nothing you typed is sent again on
its own.

Nobody else can take the PC's place on the relay. Knowing a PC's `server_id` isn't enough: on every
socket it opens, the PC has to prove to the relay that it holds the secret key behind that ID
([step 1](#how-a-connection-is-made)), so a stranger can't push the PC off or catch its phones.

### The hosted app is a trust root

The encryption ends in the app on the phone, and that app comes from `app.ovis.sh`. It holds the
phone's key for each PC and shows everything the PC sends, so whoever controls what `app.ovis.sh`
serves (the maintainer, and Cloudflare Pages, which hosts it) could serve a version that copies both
somewhere else. No protocol protects against the end it runs in.

What keeps that in check:

- Only the Release workflow deploys it, from a release tag, never from a branch or a laptop. Each
  GitHub release carries that build as `dist-shell.tar.gz` with its SHA-256, so anyone can compare
  what `app.ovis.sh` serves with what the tag builds ([Releasing](development.md#releasing)). Your
  browser doesn't make that comparison for you.
- The app's own pages run scripts from `app.ovis.sh` only. Their Content-Security-Policy is the one
  the PC's own server sends, with only the relay's `wss:` connections, the account service (`https://account.ovis.sh`) and
  `blob:` media and frames added (`shellContentSecurityPolicy()` in [`server/static.ts`](../server/static.ts)). A rendered
  HTML page from the PC runs apart from them, in a sandboxed render host with the PC's own policy
  for rendered pages ([Files](#files)).
- The host sees requests for static files: the phone's address, and the PC's relay ID in the path
  (`/s/<server_id>/`). It never gets the pairing link's `#offer=` part, which browsers don't send, or
  any of the traffic, which goes to the relay. What a page shows is in the fragment too: the file a
  tab of its own or a raw file opens, the workspace, pane and file the app's address names, the pane
  a tapped alert opens (`/s/<server_id>/#read=…`, `#ws=…&pane=…&file=…`; a PC's own server keeps
  them in the query, [`src/lib/pageQuery.ts`](../src/lib/pageQuery.ts)). An address from an older
  build with them in the query still reaches the host with that page's load (in its request, and as
  the referrer of the files the page loads before the app starts); the app then moves them into
  the fragment, for that entry and any older one Back lands on. A PC's file the app shows is
  answered inside the phone by the app's service worker (`/s/<server_id>/~/api/…`), so its path
  never leaves the phone either, unless such a file address is copied out and opened in a browser
  without the app.

Once a phone has opened a PC, the app's service worker starts that PC's page from the copy of the
app it kept and fetches `app.ovis.sh`'s in the background for the next open
([`public/sw.js`](../public/sw.js)), so a reopen doesn't wait on the host. A new release, a fix
included, therefore reaches a phone on the open after the one that fetched it. A copy kept more
than a day ago is not opened first: the host is asked, the copy is used only when it doesn't
answer. A PC newer than the app reloads the page once onto the host's copy at once (`reloadPage` in
[`src/lib/relay/shell.tsx`](../src/lib/relay/shell.tsx)).

To take `app.ovis.sh` out of the picture, [host the app yourself](guide.md#running-your-own-relay).

### Who gets in

**Pairing.** While the relay is online, **Settings → Devices and PCs → Connect** on the PC shows a QR code
holding a link of the form `https://app.ovis.sh/s/<server_id>/#offer=<data>`. The data names the PC
(`server_id`), its public key, the relay's address, a pairing code and the PC's host name (at most 64
characters), which the phone lists the PC under
([`shared/relay-offer.ts`](../shared/relay-offer.ts)). It sits in the link's fragment, which
browsers never send to a server, and the app takes it off the address bar before anything else runs
([`src/lib/relay/boot.ts`](../src/lib/relay/boot.ts)). Since a PC's `server_id` is worked out from
its public key, a link whose key doesn't give its `server_id` can't be that PC's: the app refuses it
every time it's opened or pasted, before any connection, and saves or removes no key
(`forgedOffer` in [`src/lib/relay/shellState.ts`](../src/lib/relay/shellState.ts)). The code is the same kind the Devices group
shows: six digits, good for ten minutes, spent after five wrong tries. The PC makes at most 10
pairing codes in 10 minutes, and after 20 failed relay pairings in 10 minutes it takes none for the
next 10: a pairing tried then ends with `auth_failed`, and the phone shows **That pairing code no
longer works**.

**Pairing by comparing digits.** A phone can also pair without a code, from a link that holds the
PC's `server_id`, public key, relay and host name only (**Copy a link without a code** under the setup
guide's QR code; it holds nothing secret, though whoever carries the link can read the host name). Copying it opens a 10-minute window, as a Bluetooth device's pairing mode
does: outside it the PC refuses a comparison with `auth_failed` before any prompt, and does not count
it as a failed pairing, so nobody the owner did not invite can raise a prompt. Such a link may have come through a channel nobody vouches
for, so its key is not trusted on its own: a relay, or whoever handed the link over, could have put
its own key there and sit between the phone and the PC. Trust comes from two people looking at
two screens instead, as in Bluetooth's numeric comparison:

1. The phone offers the feature `pair-sas` in `HELLO`; a PC that supports it selects it in
   `WELCOME`. An older PC selects nothing, and the phone says to update Ovis on the PC. An older
   phone never offers it, and pairs with a code as before.
2. Both ends work out a **channel binding**: SHA-256 over `ovis-relay-channel-binding/1`, the PC's
   static key and the two Noise handshake messages, each length-prefixed
   (`channelBinding` in [`shared/relay-e2ee.ts`](../shared/relay-e2ee.ts)). The two ends of one
   handshake hold the same binding. A relay in the middle runs one handshake with the phone (with
   its own key) and another with the PC, so the two ends hold different ones: it cannot make the
   PC's handshake message, whose DH needs the PC's secret key, appear on the phone's side.
3. **Commit.** The phone picks 32 random bytes `Np` and sends `PAIR_REQUEST` with its label, its new
   device key and `commitment = SHA-256("ovis-relay-pair-commit/1" || binding || device key || Np)`.
4. **Challenge.** The PC answers `PAIR_CHALLENGE` with 32 random bytes `Nc` of its own.
5. **Reveal.** The phone sends `PAIR_REVEAL` with `Np`. The PC checks it against the commitment
   (in constant time) and ends the session with `auth_failed` if it does not hold.
6. **Compare.** Both show `SHA-256("ovis-relay-pair-digits/1" || binding || device key || Np || Nc)`,
   its first 8 bytes as a number modulo 10^6, as six digits. The PC shows them in every one of
   its own windows that may approve a phone (driving, direct, not a Portal visitor, not an open LAN
   window, which also gets 403 `owner_only` for the codeless link and the approval): **{name} wants to
   pair through the relay. Approve it only if its screen shows 123 456**, with Approve and Decline.
7. **Confirm and approve.** The phone sends `PAIR_CONFIRM` once its person taps **The numbers
   match**, and the PC's owner approves (`POST /api/relay/pairing`). Only both together make the
   device, the same record and key a pairing with a code makes, and `AUTH_OK` follows as usual.
   On a PC without a screen, `bun scripts/plugin.ts pair --approve` in its terminal shows each
   waiting phone with its digits and asks y/n: the PC's terminal is the PC itself.

The approval may also come from a phone already linked to the owner's account, connected through
the relay: it is shown three sets of digits and must pick the new device's
([Who may admit a device](account.md#who-may-admit-a-device)). Every device connected to the PC
hears of each admission, and of the account device that approved it.
   Neither the phone nor the PC can finish alone.

Why it holds: the phone is bound to `Np` before it sees `Nc`, and the PC chooses `Nc` before it sees
`Np`, so neither end, nor a relay that is both ends at once, can steer the digits. A relay that
passes the comparison on unchanged is refused at step 5, since the commitment is bound to the
phone's channel. A relay that runs a comparison of its own with each end gets the same six digits
on both screens once in a million tries. Not every try shows: the PC's digits are known to the
other end once `PAIR_CHALLENGE` arrives, so a peer may abandon a comparison before its reveal, and
then no prompt appears. Each abandoned comparison still counts as a failed relay pairing, so within
the 20 failures allowed in 10 minutes a relay gets about 20 tries, one in fifty thousand, before
relay pairing pauses. Without step 3, a relay could try handshakes until the digits matched; the
commitment is what stops that.

Limits: a comparison starts only inside the window opened by copying the link; both people have 90 seconds from `PAIR_REQUEST` (under the relay's 120-second idle close),
after which the session ends with `timeout` and the prompt goes. At most three phones wait for
approval at once; a fourth gets `auth_failed`. Every comparison that ends without a device
(declined, abandoned, timed out, a broken commitment, a wrong pick) counts as a failed relay
pairing. A comparison that pairs this PC only counts toward the same 20 failures in 10 minutes as
a wrong code, after which the PC takes no such pairing for 10 minutes. One that asks to join the
account (`pair-intent-account`) counts toward 20 of its own, so a flood of those cannot pause
pairing with a QR code or a code. A relay in the middle can spend both, so it gets about 40 tries
in 10 minutes, one in twenty-five thousand, before both pause.
**Revoke all** ends every comparison under way, an approved one included, and withdraws its prompt. The prompt lives in memory only. The relay learns nothing new: the comparison travels inside the
encrypted channel, so it sees only a few more frames and their sizes and timing.

The phone's screen asks **Does {name} show this number?** with **The numbers match** and **Cancel**,
then waits for the approval. A PC that declines, or does not approve in time, leaves the phone at
**{name} did not approve this phone**, with no key saved.

**Pairing with a typed code.** For a device with no camera pointed at the PC, **Show a code to
type** under the QR code shows ten characters, `XXXXX-XXXXX` (Crockford base32: no I, L, O or U;
O, I and L typed are read as 0, 1 and 1), and **Pair with a code** on app.ovis.sh takes them
(on its front page, or behind **Pair with a QR or code** on the sign-in screen when the account
service runs). The code finds the PC and hands the device the same offer the QR code carries, then the
device pairs with the six-digit code in it as a scanned QR code does: nothing else admits it
([`shared/relay-pair-code.ts`](../shared/relay-pair-code.ts),
[`server/relay/pair-code.ts`](../server/relay/pair-code.ts),
[`src/lib/relay/pairCode.ts`](../src/lib/relay/pairCode.ts)).

1. Its first three characters are a public **nameplate**: the PC holds a rendezvous for it on
   `relay.ovis.sh` (`/v1/pair`, [relay/README.md](../relay/README.md#what-it-answers)), and the
   device joins it. The PC proves its relay key for that nameplate before the relay lets it hold
   one, and sends its [relay pass](#relay-pass) there as on its other sockets. The other seven (35 bits) are the **password**, which never leaves either end.
2. The two run CPace ([draft-irtf-cfrg-cpace-21](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/),
   `CPACE-RISTR255-SHA512`, the PC as initiator) with the password, `CI = lv_cat("ovis-pair-code/1",
   nameplate)`, a fresh 16-byte `sid` per try and role labels as associated data. The device answers
   with its share and a confirmation (HKDF of the session key). The PC checks it in constant time and
   only then sends the offer, sealed with ChaCha20-Poly1305 under another key from the session key.
3. The device checks the offer as it checks a scanned link (its key must give its `server_id`, and
   it must carry a pairing code), then shows **Does {name}'s screen show this ID?** with the PC's full
   ID in eight groups of four. The PC shows its ID under the code. Only **It matches** goes on to
   pairing, through the PC's own page as a QR code does.

Why it holds: someone reading the frames, the relay included, cannot test guesses offline; each
guess takes a live exchange. The PC counts the tries itself: one is taken before its first message,
three end the code, and a correct one spends it (single use). With 35 bits and three tries a code,
an attacker who tried every one of ten million codes would get one in about a thousand. A relay
that plays the PC can test one guess against a device's confirmation without the PC counting it,
so the device runs exactly one exchange per tap and never retries with the code; even a right
guess gives it only an offer whose ID the person must match against the PC's screen.

Limits: minting a code starts a fresh six-digit code (under its 10 codes in 10 minutes) and lives as
long as it; the PC checks that code is still the pending one before it sends the offer, and tells a
device that knew the code it ran out otherwise. Wrong typed codes do not count toward the 20 failed
relay pairings that pause QR pairing. A code is a relay control like the QR code: made on the PC or
a direct connection, never through the relay (`local_required`) or by a Portal visitor. The PC
offers codes only on `relay.ovis.sh` (409 `code_unavailable` on a relay of its own), where the hosted
app looks for them. The relay sees the nameplate, when the two meet and how big the frames are.
CPace asks for the password's mapping to run in constant time; this one is JavaScript (noble), which
promises no such thing. The PC works out its first message before a device arrives and every try
hashes a fresh `sid`, so the relay cannot time it against an arrival or measure one input twice.

**Device keys.** Pairing makes a key pair on the phone for that one PC: ECDSA P-256, made by
WebCrypto as non-extractable, so no script, the app's own included, can read the private half out.
The phone keeps it in IndexedDB (`ovis-relay`), never in `localStorage`. The PC keeps only the public
half, as `relay_public_key` in its device list (`devices.json`). On every later connection the PC
sends 32 fresh random bytes, and the phone signs `ovis-relay-auth/1`, those bytes and the PC's
`server_id` with its key (`matchRelay` in [`server/devices.ts`](../server/devices.ts)). A signature
the relay saw is therefore no use later, or with another PC.

**What doesn't count through the relay.** The token, device cookies, a Tailscale login and being
"this computer": only the phone's key does. A request through the relay keeps only a short list of
headers ([below](#requests-through-the-mux)), never `Cookie`, `Authorization`, `Host`, `Origin` or
forwarding headers, and signing in with the token answers 403 `device_key_required`. A phone on the
relay can't start or stop the relay, show its QR code or reset its identity (403 `local_required`). A pairing
code admits whoever holds it. On a PC linked to an account, only a phone linked to that account
with drive access may start one through the relay; any other gets 403 `account_required`
(`read_only` for a watch device). On a PC in no account, any paired relay device that can type
may still start one under Devices, as before.

**Who controls the relay.** Start, stop, pairing offers and identity reset require drive access
and a direct connection to the PC. A Portal visitor may read the state but cannot change it:
the default watch visitor gets 403 `read_only`; even a visitor with a saved drive role gets
403 `owner_only`. The watch guard runs before the Portal owner guard
([`server/dispatch.ts:223-243`](../server/dispatch.ts#L223-L243)).
Settings shows a disabled switch, an explanation of the direct-owner requirement, no offer and
no reset. Open Ovis on the PC or at its direct address, using the owner's access token or a
paired device with drive access instead.
The hosted shell hides the group because mutations
over the relay answer 403 `local_required`. While the relay is off an offer answers 409
`relay_off`; while it is in error it answers 409 `relay_offline`, so wait for **Online** before pairing.

**A start that fails.** If a start fails before the PC's relay link exists, the switch stays
off and the panel shows **The relay did not start: …** with the reason and **Try again**. Nothing
retries that failed start automatically. A link that already exists stays on while retrying a
connection error.

**What it may do.** A phone paired through the relay gets the same access as a device paired with a
code: it can type into terminals and change settings. Every pairing, through the relay or not,
makes such a device, and the app has no way to make a paired device watch-only.

**The device gate.** Turning the relay on in an install with no token and no paired device closes
the device gate first, so from then on a new browser on the LAN or behind a proxy needs a pairing
code as well ([Access and safety](guide.md#access-and-safety)).

### A PC with no screen

A PC you reach only over SSH (a home server, a desktop in another room) links itself from its own
terminal, with the same two ways its Settings page offers and the same rules. In an installed
plugin, run the plugin's script as in [In a terminal](guide.md#in-a-terminal); from a checkout:

```bash
bun scripts/plugin.ts link            # sign in to your account, then approve the device that adds this PC
bun scripts/plugin.ts link --google   # the same, at Google's own device page (--github: GitHub's)
bun scripts/plugin.ts link --code     # a code to type and the relay QR code, renewed until Ctrl+C
```

Both turn the relay on first when it is off, and wait until it is online.

- **`link`** signs in the way a PC's own page does: it prints the Ovis sign-in page
  (`https://account.ovis.sh/link`), a code and a QR code of the page with the code filled in. On any
  device, open it, check the code, choose **Continue with GitHub** or **Continue with Google**, sign
  in, and confirm. An account service without that page, or `--github` / `--google`, uses the
  provider's own device page and its code instead. Signing in adds nothing by itself. Then it lists this PC in your
  account ([Adding a PC](account.md#adding-a-pc)) and waits. On a phone already in your account,
  tap **Add** on this PC; the terminal shows the request with its six digits
  (**… wants to join your account. Approve it only if its screen shows 123 456**) and asks
  y/N. That approval is this PC's own, as on its screen: the window it opens takes approvals from
  this PC only. Every nine minutes it lists the PC anew so the account's devices keep showing it as
  new; a renewal the account service does not take is tried again until it is, so the PC never
  stays off the list. It ends once the PC is in the account, and the sign-in ends with it: nothing
  of it is kept on the PC. With `OVIS_ACCOUNT_SERVICE_URL=off` it points to `--code` instead.
- **`link --code`** prints what **Connect a device** shows: the code to type at app.ovis.sh
  (**Pair with a code**), the relay pairing link as a QR code drawn in the terminal, and this PC's
  ID for the other device to compare. Both renew when they run out. When the relay mints no typed
  code (a relay that is not Ovis's own, or one that refuses it), it says why and shows the QR code
  alone, as Settings does. Ctrl+C, SIGTERM, SIGHUP (the terminal closing), or any error, takes both
  back (`POST /api/devices/pair/cancel` with `{ "code" }`, the six-digit code it showed, which ends
  that pending code and the typed code bound to it; a pairing started since, in Settings or on
  another device, stays). Redeeming them follows the usual admission rules.

**Which copy runs.** An in-app update (**Settings → Updates**) installs a new release beside the
plugin checkout and does not replace the checkout. `link` follows the release that runs, as
`phone-setup` does, from the first checkout that has it on. A checkout from before `link` prints
the usage line without it: reinstall the plugin (`herdr plugin install devswha/ovis`), which
replaces the checkout, then run it again. A server too old for it (no account routes) is named as
such: `link` says to update it rather than failing on the first request.

**Who counts as this PC.** `link` talks only to an Ovis on a loopback address, with the token the
plugin reads (`OVIS_TOKEN`), and refuses a server named by any other address. It cannot tell
where a loopback port leads: an SSH port forward (`ssh -L`) to another PC's `127.0.0.1:7317` looks
the same, and links that PC. That is the server's own rule too: without `OVIS_TOKEN`, every
connection from loopback counts as the PC itself, which includes any other user account on the PC
and anyone who can forward a port to it. On a PC that others log in to, set `OVIS_TOKEN`
([Access and safety](guide.md#access-and-safety)); `link` then needs it too.

### Ending access

- **Revoke**, under **Phone & devices** on the PC, closes that phone's relay connections at once:
  its terminal sockets close with code 1008, its requests are cancelled and the session ends with
  `auth_revoked`. The phone deletes its key for that PC and says it was removed.
- Turning the relay off closes every relay connection (terminal sockets with code 1001) and the PC's
  link to the relay. While it's off, the PC makes no connection to the relay at all.
- **Reset relay identity**, below the switch, gives the PC a new `server_id` and key pair and
  removes every phone paired through the relay. Use it when a QR code or pairing link may have been
  seen by someone else: with the PC's public key from it, they could try pairing codes, though they'd
  still need a valid one.
- A relay identity file that can't be read is never replaced silently, since a new identity cuts
  off every paired phone: the relay stays off (`identity_unreadable`) until **Reset relay identity**
  makes a new one. That includes an identity made by a prerelease build, from before the PC proved
  its key to the relay: reset it, then scan a new QR code on each phone. The identity lives in `relay/identity.json` under `OVIS_STATE_DIR`, readable by
  your user only.

**Serve-only installs.** `OVIS_TAILSCALE_SERVE_ONLY=1` says `tailscale serve` is the only way into
the PC. The relay would be another, so it can't be turned on there, no phone is admitted through
it, and the identity reset is refused.

## How a connection is made

1. **The PC connects.** With the relay on, the PC opens a control WebSocket to
   `wss://relay.ovis.sh/v1/ws?server_id=<id>&role=server&v=1&proof=1&public_key=<64 lowercase hex>`.
   The `server_id` is the first 16 bytes of
   `SHA256(UTF8("ovis-relay-server-id-v1") || public_key)`, encoded as 32 lowercase hex digits. Before the
   relay lets that socket, or any data socket below, take the PC's place, it sends a fresh
   challenge, and the PC answers with a code only its secret key can make (X25519 and
   HMAC-SHA256, tied to the `server_id`, the socket's role and its connection ID). The relay closes
   the socket with `4401` when the PC didn't offer the proof at all, when its key doesn't match the
   `server_id`, or when the answer is wrong. A challenge left unanswered for 10 seconds, or answered
   after that, also closes it with `4401`. At most 16 proofs may be pending per PC; a new one
   displaces the oldest with `1013`. The PC closes the socket itself with `4000` when the challenge
   it got is invalid or out of order. It retries these transient refusals with its usual backoff,
   including `4401` with `server proof timed out` or `invalid or expired server proof`.
   Only a control-socket `4401` with `server key does not match server_id` or `invalid server key`
   stops the PC retrying, and its relay status shows that error. A refused data
   socket only ends that phone's connection: the status stays online and gives no reason (`shared/relay-server-proof.ts`,
   [the relay's side](../relay/README.md#what-it-answers)). The PC then sends a keepalive every 10 seconds
   and counts the relay gone after 30 seconds without an answer. It reconnects after 1 second, then
   1 second longer each time up to 30 seconds, each wait varied by up to 20%
   ([`server/relay/link.ts`](../server/relay/link.ts)). Control messages are limited to 4096
   characters before parsing, with no control-message rate limit: arrivals and departures drive them.
   The challenge is `{"type":"server_challenge","public_key":"<ephemeral X25519 hex>","nonce":"<32 random bytes hex>"}`;
   the answer is `{"type":"server_proof","answer":"<HMAC-SHA256 hex>"}`. The MAC key is the raw
   X25519 shared secret, and the message is
   `nonce || UTF8(server_id + NUL + role + NUL + connection_id + NUL + "ovis-relay-server-proof-v1")`,
   with role `control`, `data` or `warm` and an empty connection ID for `control` (the generation for `warm`). The relay rejects an all-zero
   shared secret and compares the MAC in constant time. This proves the PC's secret possession to
   the relay; it does not authenticate the relay to the PC or replace the phone's Noise handshake.
2. **The phone connects.** The app opens the same address with `role=client`. The relay gives the
   connection a random ID and tells the PC, which opens a data WebSocket for it, and from then on the
   relay passes frames between the two sockets byte for byte
   ([what it answers](../relay/README.md#what-it-answers)). So that a phone does not wait for that
   socket to open and prove itself, a PC whose relay says it takes one (`"warm":"<generation>"` in
   `sync`, new for each control socket) keeps one data socket proven in advance
   (`role=server&warm=<generation>`), which goes with that control socket. The next phone takes it at once:
   the relay tells it `{"type":"bound","connection_id":"…"}` before the phone's first frame, tells
   the control socket nothing, and the PC opens the next one. A warm socket proves itself like any
   other and only carries what the phone and the PC encrypt end to end, so it changes nothing the
   relay can see or do.
   A phone takes one of eight answered-client slots only when the PC's data socket sends its first
   non-keepalive frame. Up to four unanswered phones may wait; a fifth displaces the oldest with
   `1013`. A waiting phone closes `1013` after 15 seconds in which the PC could answer, reset when
   its data socket attaches. While no PC is connected, it instead waits at most 30 seconds
   from its arrival or the PC leaving, keepalives or not, then closes `1013` with
   `the server is not connected`. That deadline survives a relay eviction. A PC returning in
   time gives it the full 15-second answer deadline again; answered clients have no such deadline.
   Lost buffered frames after a relay eviction close the phone `1012` when its data socket
   attaches or the phone sends again.
3. **Handshake.** The phone and the PC run the Noise NK handshake over those sockets, with the PC's
   public key from the QR code.
4. **Admission.** Inside the encrypted channel they speak Ovis Mux v1. The phone sends `HELLO`; the
   PC sends `WELCOME` with 32 fresh random bytes, its version and its limits as soon as its side of
   the handshake is done, without waiting for `HELLO`, so it reaches the phone one round trip
   sooner, unless a pairing window is open (then it answers `HELLO`, as older phones expect when they
   compare digits). That `WELCOME` is marked `provisional`: it offers version 1 with no features, it doesn't
   say the phone's `HELLO` was accepted, and the PC still checks that `HELLO` (version 1 offered, no
   required feature it can't select) and requires it before `PAIR` or `AUTH`. A `HELLO` that offers
   pairing by comparing digits gets a second, final `WELCOME` with what the PC selects, and a phone
   comparing digits waits for that one. The phone sends `PAIR`
   (the first time, with the code) or `AUTH` (later, with its signature), and the PC answers
   `AUTH_OK`. Nothing else is accepted before that. The phone saves a new PC's key only on
   `AUTH_OK`, so a link whose PC never admits it takes no PC's place on the phone. The PC closes a
   connection that has not signed in or paired within 15 seconds of opening its data socket;
   completing the protected handshake alone does not cancel that deadline. Verification already in progress gets at most 5 more seconds
   to finish and send its acknowledgment. Only signed-in sessions count in Settings: at most eight
   on the PC, with at most four for one device key. A fifth session for that device closes its oldest
   by sign-in order with `resource_exhausted`, not by the order their sockets opened.
5. **Requests.** Every request, event stream and WebSocket the app opens becomes a stream of the
   mux. The PC runs it through the same handler as a browser's request (`handleRequest` in
   [`server/dispatch.ts`](../server/dispatch.ts)), with the paired device as the one asking, so every
   permission check applies as before.

The phone gives up on a step after 10 seconds without an answer from the relay ("The relay could not
be reached"), 15 seconds without one from the PC ("… is offline"), or 10 seconds for the PC to
finish admitting it ("… did not finish connecting"). A connection that drops later comes back by
itself, after 1 second and then twice as long each time up to 30 seconds, and at once when the phone
is back online or the app back in front. Nothing is sent again: a request that was under way fails,
and text you typed waits as a draft, as after any disconnect.

## Ovis Mux v1

Ovis Mux v1 carries HTTP requests, event streams and WebSockets over the one encrypted channel:
[`shared/relay-mux.ts`](../shared/relay-mux.ts) has the frames,
[`shared/relay-mux-engine.ts`](../shared/relay-mux-engine.ts) the streams, flow control and
scheduling. Each mux frame is one encrypted message.

### Envelope

Every frame starts with 8 bytes, big-endian:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | version, always `1` (`RELAY_PROTOCOL`) |
| 1 | 1 | frame type |
| 2 | 2 | flags |
| 4 | 4 | stream ID: 0 for the session, odd numbers for the streams the phone opens |

A frame is at most 16,384 bytes, envelope included. Metadata is UTF-8 JSON with no duplicate keys;
bodies and WebSocket messages are raw bytes, never base64. An unknown type, an unknown flag or an
oversized frame ends the session before anything in it is parsed.

### Frames

| Type | Name | From | Carries |
| --- | --- | --- | --- |
| `0x01` | `HELLO` | phone | `protocol: "ovis-mux"`, the versions and features it offers (`relay-hints`, from 0.5.0, and `direct-carrier`, both answered in `AUTH_OK`) |
| `0x02` | `WELCOME` | PC | version 1, the limits, `nonce` (32 random bytes), `server_version`, `relay_protocol`, `min_supported_client`; `provisional` on the one sent before `HELLO` |
| `0x03` | `AUTH` | phone | `scheme: "device-key"`, `device_id`, `signature` (64 bytes, P-256 `r` and `s`, base64url) |
| `0x0A` | `PAIR` | phone | the six-digit `code`, a `label` of up to 64 characters, `public_key` (P-256 SPKI, base64url) |
| `0x0B` | `PAIR_REQUEST` | phone | with `pair-sas`: `label`, `public_key` and `commitment` (32 bytes, base64url) ([comparing digits](#who-gets-in)) |
| `0x0C` | `PAIR_CHALLENGE` | PC | `nonce`: the PC's 32 random bytes |
| `0x0D` | `PAIR_REVEAL` | phone | `nonce`: the 32 bytes the commitment was made with |
| `0x0E` | `PAIR_CONFIRM` | phone | `confirmed: true`: the person said both screens show the same digits |
| `0x04` | `AUTH_OK` | PC | `session_id`, `device_id`, `role` (`drive` or `watch`), and with `relay-hints` `relays`: up to two `wss:` origins, the one new connections should use first; with `direct-carrier` `direct`: up to four `ws://<private IPv4>:<port>` ([Direct on the same network](#direct-on-the-same-network)) |
| `0x05` | `SESSION_ERROR` | either | a `code` from [Errors](#errors-and-close-codes) and a short `message` |
| `0x06` | `GOAWAY` | either | `shutdown` or `id_exhausted`, the last stream ID taken, how long to drain (up to 5 seconds) |
| `0x07`, `0x08` | `PING`, `PONG` | either | a 64-bit number, echoed |
| `0x09` | `RECEIVED` | either | how many bytes have arrived so far (the receipt budget) |
| `0x10` | `HTTP_OPEN` | phone | method, path and query, headers, whether a body follows |
| `0x11` | `HTTP_ACCEPT` | PC | nothing: the PC takes the request body |
| `0x12` | `HTTP_HEADERS` | PC | status and headers |
| `0x13` | `HTTP_DATA` | either | body bytes |
| `0x14` | `HTTP_END` | either | the end of a body, with trailers; flag `STOPPED` ends one cut short after `HTTP_STOP_REQUEST` |
| `0x15` | `HTTP_STOP_REQUEST` | PC | stop sending the request body |
| `0x20` | `WS_OPEN` | phone | path and query, headers, subprotocols |
| `0x21` | `WS_ACCEPT` | PC | the subprotocol and headers |
| `0x22` | `WS_DATA` | either | a message or a piece of one; flags `START`, `END`, `TEXT` |
| `0x23` | `WS_CLOSE` | either | close code, reason, and `abort` for a close that doesn't wait |
| `0x30` | `CREDIT` | either | how many bytes of a stream have been read, which opens its window again |
| `0x31` | `RESET` | either | ends one stream with a code from [Errors](#errors-and-close-codes) |

### Requests through the mux

- **Headers.** A request keeps only `content-type`, `accept`, `range`, `if-none-match`,
  `if-modified-since`, `content-length`, `x-request-id`, `x-herdr-machine`, `x-herdr-update` and
  `last-event-id`; the PC drops any other. It gives every request the origin
  `https://relay.ovis.invalid`, marks it same-origin and asks for an unencoded body. A response keeps
  only `content-type`, `content-length`, `content-range`, `accept-ranges`, `etag`, `last-modified`,
  `cache-control`, `content-disposition`, `retry-after`, `x-request-id` and the security headers
  `content-security-policy`, `x-content-type-options`, `cross-origin-resource-policy` and
  `referrer-policy`, exactly as the handler set them, and `x-server-time` (the PC's clock as it
  answered a chat's read) to a phone that offered the `server-time-header` feature in HELLO: an
  older phone refuses a header it does not list. No cookie is ever set.
- **Bodies and event streams.** A request body may be up to 64 MiB. Responses stream as they're
  read, and an event stream such as the PC list's (`/api/machines/events`) is a response that stays
  open. A request gets the same time budget as on a direct connection: 60 seconds unless its route
  sets another, and none for the PC list's event stream.
- **WebSockets.** A message may be up to 1 MiB (a larger one closes the socket with 1009), and text
  has to be valid UTF-8 (or the socket closes with 1007). The terminal's own flow control works as
  on a direct connection: a terminal whose reader stops acknowledging output is closed with 4008, on
  its own socket only ([terminal flow control](terminal-flow-control.md)).

### Files

The browser fetches a picture, PDF or video on the page by itself, so the app can't send that
request through the relay as it does its own. Instead, each one gets an address inside the PC's own
scope, `/s/<server_id>/~/api/…`, which that PC's service worker answers
([`public/sw.js`](../public/sw.js); only the hosted app's build switches its relay part on):

- **With the service worker.** The worker hands the request, with its `Range` header, to a window
  of the same PC whose relay connection is open. That window fetches the file through the mux and
  streams the answer back with its status and the headers the mux keeps, security headers included,
  so a video can skip ahead. Nothing is cached. The worker adds a policy of its own to every file:
  it runs in a sandbox with no scripts, and a PDF, which the browser's viewer won't open in a
  sandbox, still gets the no-script policy. The app's address is shared by every PC it's paired
  with, so a file from one PC can't reach the others or the app's keys. The worker answers GET requests for three read-only
  routes only, `fs/file`, `fs/favicon` and `pane/conversation/image`, on this PC or on a remote PC
  behind it (`/api/machines/<id>/…`), from one list (`RELAY_RESOURCE_ROUTES` in
  [`shared/relay-mux.ts`](../shared/relay-mux.ts)). With no window of that PC connected, it answers
  503 ("Open this PC in Ovis to load its files."). It answers only this PC's own app window, as
  the PC's own server does through its `SameSite=Strict` cookie: a navigation by its referrer, any
  other request by the window that made it. Another site's frame or link, a typed address, another
  PC's page and a rendered page get 403, and every file it serves carries `frame-ancestors 'self'`
  and `X-Frame-Options: SAMEORIGIN`.
- **Without it.** Where no service worker that speaks this protocol controls the page, the app
  fetches the whole file through the relay and shows a `blob:` copy of at most 64 MiB
  (`RELAY_BLOB_LIMIT` in `src/lib/relay/resources.ts`). Text, source and Markdown files don't take this
  path: the viewer reads them through the mux and shows them as usual. Of the rest, only pictures,
  videos, sounds and PDFs open in place this way. Any other raw file, SVG pictures included, comes down as a download, since a
  `blob:` copy would run with the app's own address. For a larger file the viewer says "Too large
  to open on the phone - download on the PC". A download is handed over as
  `application/octet-stream`, so a web view that opens it in place doesn't run it.
- **Rendered HTML pages.** The app fetches the rendered page through the relay, at most 64 MiB, and
  posts it to a render host at `/s/<server_id>/~render` (`render.html` from
  [`scripts/shell-build.ts`](../scripts/shell-build.ts)), in a frame sandboxed with `allow-scripts`
  alone, which writes it into its own document. The host's Content-Security-Policy is the PC's
  policy for rendered pages (`pagePolicy(null)`), so the page's inline scripts run, while the
  sandbox's opaque origin keeps it away from the app, its device keys and the relay connection.
  As on a direct connection, the PC puts the page's own pictures, scripts and media into it, up to
  8 MiB each and 32 MiB in all (for a page of up to 8 MiB); a larger video or sound gets no address
  through the relay ([`server/file-routes.ts`](../server/file-routes.ts)), so it doesn't play.
- **Links.** In the hosted app, **Open in a new tab**, and **Copy link** in an installed app's
  window, give an address that opens the file in the app's reader for that PC
  (`/s/<server_id>/#read=…`, in the fragment, so the host never sees the file), which connects through the relay by itself. **Open raw file** opens
  that reader at the file's first line. The app never opens a `blob:` copy of a file as a page,
  which would run with the app's own origin.

### Flow control and scheduling

A phone has one connection to the PC, so the mux shares it out:

- **Credit per stream.** A side sends a stream's data only within its window: 320 KiB for an HTTP
  stream, 1 MiB for a WebSocket. The receiver opens the window again with `CREDIT` as the app reads,
  so a slow reader slows only its own stream.
- **Receipt budget.** A sender has at most 424 KiB of frames sent but not yet confirmed by
  `RECEIVED`: 408 KiB of ordinary traffic and 16 KiB of control frames. At most 384 KiB of the
  ordinary share is bulk, so 24 KiB always stays free for interactive frames. Bulk can still sit up
  to 384 KiB ahead of a terminal frame on the one ordered connection. That's about 31 ms at
  100 Mbit/s, and longer on a slow link, though the scheduler still puts interactive frames first.
- **Memory reserved.** Before it admits a stream, a session reserves that stream's receive window
  against one cap of 12 MiB for all its streams together, not 12 MiB per stream.
  The measurements behind these values are in `docs/relay-mux-limits.md`
  ([`shared/relay-mux.ts`](../shared/relay-mux.ts),
  [`shared/relay-mux-engine.ts`](../shared/relay-mux-engine.ts)).
- **Scheduling.** Control frames go first, at most 8 in a row while data waits. Interactive streams
  (WebSockets such as the terminal's `/ws`, and the PC list's event stream) and bulk streams
  (everything else) then take turns, four interactive frames to one bulk, round robin within each.
- **Queues.** A sender queues at most 4 MiB, and at most 3 MiB of that for streams other than
  terminals, so terminal output always has room.
- **Waiting requests.** When every stream slot is taken, the app's HTTP requests wait their turn in
  order, at most 64 of them, each for up to 30 seconds. A request past either limit fails with an
  error rather than hanging, and so does one cancelled while it waits. When the connection drops,
  every waiting request fails; none is sent again over the next connection, so a `POST` never runs
  twice ([`src/lib/relay/transport.ts`](../src/lib/relay/transport.ts)).

One limit can't be designed away: all of a phone's streams share its one connection. When that
connection stalls (a slow mobile network, an app sent to the background), all of that phone's
streams wait together. Other phones and the PC itself don't.

### Limits

| What | Limit | Past it |
| --- | --- | --- |
| Frame | 16,384 bytes | the session ends (`protocol_error`) |
| Streams open at once, per phone | 32, at most 8 of them WebSockets and 4 event streams | the new stream is refused (`refused`) |
| New streams | 32 a second, bursts of up to 64 | the session ends (`resource_exhausted`) |
| Frames | 4,096 a second, bursts of up to 8,192 | the session ends (`resource_exhausted`) |
| Sending past a stream's window | none allowed | the session ends (`flow_control_error`) |
| Request body | 64 MiB | `413` |
| WebSocket message | 1 MiB | the socket closes with `1009` |
| Queued to send | 4 MiB, at most 3 MiB of it outside terminals | that stream is reset (`resource_exhausted`) |
| Admission | `AUTH_OK` within 10 seconds | the session ends (`timeout`) |
| Keepalive | the PC sends `PING` after 20 seconds without traffic and waits 60 seconds for `PONG` | the session ends (`timeout`) |
| Request time | 60 seconds unless the route sets another, none for the PC list's event stream | the stream is reset (`upstream_lost`) |
| A reader that takes nothing | 30 seconds | the stream is reset (`slow_consumer`) |
| Closing a WebSocket | 5 seconds to finish | the socket is torn down |

The relay service has limits of its own (frame size, phones per PC, connections per address):
[relay/README.md](../relay/README.md#limits-and-close-codes).

## Errors and close codes

`SESSION_ERROR` ends the whole session:

| Code | When |
| --- | --- |
| `unsupported_version` | no mux version in common, or another envelope version |
| `unsupported_extension` | one side requires a feature the other lacks |
| `unsupported_transport` | the connection can't carry a full-size frame |
| `protocol_error` | a malformed frame, or one out of order, such as a request before `AUTH_OK` |
| `auth_failed` | a wrong, spent or expired pairing code, an unknown device or a bad signature, a pairing while the PC takes none after too many failures, and every admission on a serve-only PC; for a comparison of digits, a commitment that does not hold, three phones already waiting, or the owner declining |
| `auth_revoked` | the device was revoked |
| `auth_changed` | the device's role changed while it was connected; its terminal sockets close with 1008 and the app reconnects by itself with the new role. Renaming a device ends no session |
| `flow_control_error` | data past a stream's window |
| `resource_exhausted` | too many new streams or frames a second, or a queue over its limit |
| `timeout` | admission or a keepalive took too long, or a comparison of digits was not finished in 90 seconds |
| `internal_error` | something failed on the other side |

`RESET` ends one stream and leaves the others: `cancelled`, `refused` (over a stream limit, or the
session is closing), `bad_request`, `body_too_large`, `message_too_large`, `stream_protocol_error`,
`upstream_lost` (its time ran out or the PC's side went away), `slow_consumer`, `resource_exhausted`
and `internal_error`. `GOAWAY` takes no new streams: `shutdown` when the relay is turned off on the
PC, `id_exhausted` when a connection has used up its stream IDs.

WebSocket close codes the app can see through the relay:

| Code | Meaning |
| --- | --- |
| `1001` | the relay was turned off on the PC ("Relay stopped") |
| `1006` | the connection to the PC was lost; the app makes this code itself, as a browser does |
| `1007` | a text message that isn't valid UTF-8 |
| `1008` | the device was revoked ("Device access revoked") |
| `1009` | a message over 1 MiB |
| `4008` | a terminal's reader fell too far behind ([terminal flow control](terminal-flow-control.md)) |

The relay closes the PC's own sockets with `4401` when its proof is missing, its key doesn't match
the `server_id`, its answer is wrong or late, or its challenge goes unanswered for 10 seconds.
With 16 proofs already pending, the oldest closes `1013` to admit the newcomer. The PC closes a
socket itself with `4000` when the challenge is invalid or out of order. It retries after `1013`,
`4000` and transient or ambiguous `4401` refusals. Only control-socket `4401` reasons
`server key does not match server_id` and `invalid server key` stop retries
([step 1](#how-a-connection-is-made)). A phone does not receive the PC's proof close directly:
it can instead find the PC offline or lose its carrier with `1012`. Phones can also receive the
relay's own `1013` capacity or answer-deadline close.

The encryption closes its connection with `1008` when the other end won't use protected mode. On
the phone's side it closes with `4002` when the handshake fails and `4003` when a record fails its
check; on the PC's side a record that fails closes the connection with `1011` (in
[`shared/vendor/paseo-e2ee/secure-channel.ts`](../shared/vendor/paseo-e2ee/secure-channel.ts)). The
relay service's own close codes are in [relay/README.md](../relay/README.md#limits-and-close-codes).

What the app on the phone shows when a connection doesn't come up
([`src/lib/relay/shellState.ts`](../src/lib/relay/shellState.ts)):

| Screen | When |
| --- | --- |
| The relay could not be reached | no answer from the relay within 10 seconds, or the connection to it failed |
| … is offline | the relay answered, but the PC didn't within 15 seconds: its Ovis is stopped or not connected to the relay |
| … did not finish connecting | the PC answered, but admission didn't finish within 10 seconds |
| That pairing code no longer works | the code was wrong, spent or expired |
| … did not approve this phone | a pairing by comparing digits was declined on the PC, or not approved in time; no key is saved |
| This phone was removed from … | the device was revoked; the phone has deleted its key |
| … has a new identity | the PC's key isn't the one the phone paired with, or the saved key isn't the one the PC's `server_id` is worked out from |
| This link is not …'s | the link's key isn't the one its `server_id` is worked out from: refused before any connection every time it's opened, Forget or not, with only **Back**; nothing is saved or removed |
| This phone forgot … | **Forget this PC** on the new-identity screen removed the saved key; it pairs with nothing, so pairing again needs a new QR code from the PC itself. Forget never makes a forged link pairable: opened again, it is refused again |
| Update needed | the PC speaks another relay protocol or mux version |
| Update Ovis on … | the PC is older than the app supports ([Versions](#versions)) |
| This pairing link is damaged | the link's offer doesn't parse or names another PC than its path |

## Versions

The hosted app updates with every release, while each PC updates on its own schedule, so the two
can be apart.

- **Relay protocol.** `RELAY_PROTOCOL` in [`shared/relay-mux.ts`](../shared/relay-mux.ts), now 1, is
  the envelope's first byte and `WELCOME`'s `relay_protocol`. An app and a PC on different ones can't
  talk, and the app stops at **Update needed**. The relay service has a wire version of its own in
  its address (`v=1`) and closes a socket that asks for another with 1008.
- **Oldest PC.** The app connects to any PC from `MIN_SERVER_VERSION` in `shared/relay-mux.ts` on:
  0.4.21, the first release with the relay. An older PC gets **Update Ovis on …**: with
  **Update now**, which asks the PC to install the latest release through the relay, when the PC's
  install updates itself, and with the installer and plugin steps otherwise. Raise it only in a PR
  that makes the app need a newer PC, with a changelog line, and mark code kept for older PCs
  `// COMPAT(relay): added in <v>, remove after <v+2>`. A CI job that runs the app against the release
  tagged `MIN_SERVER_VERSION` and against the latest release returns once a release holds
  `server/relay/`; until then `bun scripts/relay-e2e-regression.ts --skew <tag>` runs that check
  by hand.
- **Newer PC.** A PC newer than the app means the app's cached copy is out of date: the app checks
  for a newer version of itself and reloads, once.

## Relay pass

Ovis's own relays (`relay.ovis.sh` and the regional ones) may let in only PCs whose owner has an
Ovis account. They check a **relay pass**, a short-lived token the account service signs for the PC
([relay/README.md](../relay/README.md#relay-pass) has the format and the relay's side). Only the PC
needs one: phones and browsers never sign in for the relay, pairing works as before, and the frames
stay end-to-end encrypted. Direct connections on the same network or Tailscale, SSH, and a relay you
run yourself need no account and no pass.

- **Getting one** (`server/relay/pass.ts`). While its relay is one of Ovis's, the PC proves its relay
  key to the account service (the `account` server proof, as for its mailbox) and asks
  `POST /v1/pc/relay-pass` for a pass under an account: the account of its members
  ([Linking devices with an account](account.md)), else the one its signed-in owner named with
  `POST /api/account/relay-account` after adding the PC to that account. A pass the relay refuses
  (`4402`, or `invalid`/`expired` in `sync`) is dropped and a new one asked for at once, at most once
  a minute. The service gives one only
  when that account lists the PC, so another account listing it neither charges nor blocks it.
  The request names the pass forms the PC reads (`pass_versions: [1, 2]`): the service signs a v2
  pass (one that can say new client sessions to the PC are not allowed) only for a PC that names
  it, and only once every relay runs a version that reads it. An older PC names none and gets v1.
  While passes are enforced and the PC's pass says `new` 0, a relay closes a client the PC has
  identified as a device new to it (named on its control socket with `new_session`) with `4403`
  (`no new sessions for this server`); its own devices and the clients already connected stay. The
  PC does not send `new_session` yet.
- **Keeping it.** The pass lasts 48 hours. The PC keeps it in `relay/pass.json` (readable by your user
  only), so a restart or an account service outage costs nothing while it holds, and asks for the
  next one after 12 hours, backing off (and honoring `Retry-After`) when the service does not answer.
  A new pass goes to the relay on the open control socket; nothing reconnects. The file names the
  account service the pass came from, and a pass from another one (a staging one) is never sent.
  While `OVIS_ACCOUNT_SERVICE_URL` cannot be used, the saved pass still holds until it runs out.
- **Sending it.** In the `x-ovis-relay-pass` header of every socket the PC opens to Ovis's relays,
  never in the address, and never to any other relay (`OVIS_RELAY_URL` naming your own). A pass only
  goes to the relays of the service that signed it. For testing only, `OVIS_RELAY_STAGING=1` with
  `OVIS_ACCOUNT_SERVICE_URL` naming Ovis's staging account service makes the relay `OVIS_RELAY_URL`
  names the only one the PC uses and sends the staging service's pass to
  ([relay/README.md](../relay/README.md#staging)); with any other service it does nothing.
- **When it is refused.** A relay that asks for a pass closes a PC socket without one `4402`. The PC
  then stops reconnecting until it gets a pass, and reconnects as soon as it does. `GET /api/relay`
  says where it stands in `pass`: `state` (`ok`, `no_account`, `not_listed`, `limit` or
  `unavailable`), what the relay last said of it (`relay`), and from when the relay will need it
  (`enforce_at`). `new_sessions: false` there means the pass in use says new client sessions to this
  PC are not allowed for the pass's lifetime (enforced by a later relay change), shown only while
  the relay says passes are on and this one holds (`relay` `ok`); it is absent otherwise. `pass` is absent on a relay that is not Ovis's, and with
  `OVIS_ACCOUNT_SERVICE_URL=off`. `error_code` says which of the reasons below it is.

## Why it is not online

Whenever `GET /api/relay` has an `error`, it also has an `error_code`, one of a fixed set, so an app
can put the reason in its own words (`error` stays English for logs) and know whether to wait or
ask the user to act (`RelayErrorCode` in [`shared/protocol.ts`](../shared/protocol.ts)):

| `error_code` | What happened | Tries again by itself |
|---|---|---|
| `start_failed` | the relay did not start | no: start it again |
| `identity_unreadable` | this PC's relay identity cannot be read (`blocked` says so too) | no |
| `relay_unreachable` | the relay did not answer, or the connection dropped | yes |
| `server_key_refused` | the relay refused this PC's key for good | no |
| `pass_required` | an Ovis relay needs a [relay pass](#relay-pass) and no account names this PC: sign in on it and add it | when a pass comes |
| `pass_not_listed` | the account this PC names does not list it: add it there | when a pass comes |
| `pass_limit` | that account has as many PCs on the Ovis relay as it may: remove one | when a pass comes |
| `pass_unavailable` | the account service has not given a pass yet | yes |
| `pass_refused` | the relay refused the pass this PC holds (a key it does not trust, a PC it revoked) | asks for another now and then |
| `pass_unsupported` | the relay needs a pass and this PC asks no account service for one (`OVIS_ACCOUNT_SERVICE_URL=off` or unusable, or a relay that is not Ovis's) | no: connect over the same Wi-Fi, Tailscale or another relay |

It is null while nothing is wrong, and absent from a server older than this field.

## Operations

The maintainer runs `relay.ovis.sh` and `app.ovis.sh` as a best effort, with no promise that either
is always up.

- **`relay.ovis.sh`** is a Cloudflare Worker with one Durable Object per PC. Only the Relay deploy
  workflow (`.github/workflows/relay-deploy.yml`), on GitHub-hosted runners, deploys it after a change
  to `relay/` or `shared/relay-server-proof.ts` reaches main
  and passes CI or when run by hand from main, and always with the maintainer's approval. A deploy
  drops every connection; PCs and phones reconnect by themselves, and nothing is sent again. Workers
  Logs are off and the relay stores only its usage counters
  ([relay/README.md](../relay/README.md#usage-counters)).
- **`app.ovis.sh`** is a Cloudflare Pages project. The Release workflow deploys it from each release
  tag, and [Releasing](development.md#releasing) has its one-time setup. A build of main can be
  deployed by hand to `preview.ovis-app.pages.dev` to try before a release; it never changes `app.ovis.sh`.
- To report abuse that goes through `relay.ovis.sh`, see [SECURITY.md](../SECURITY.md#the-ovis-relay).

A relay you run with Bun limits connections by default: 120 a minute from one address, 600 a minute
in all, 1024 sockets, 256 PCs, 256 typed-code pairing rooms (apart from the PCs', since anyone may
open one), 4096 addresses tracked at once and 64 open sockets per address (waiting, connected or
still upgrading). A new socket past the per-address cap gets `429` with
`Retry-After: 60`; sockets already open keep their place. Raise the limits with
`--per-address-per-minute`, `--global-per-minute`, `--max-sockets`, `--max-rooms`, `--max-pair-rooms`,
`--max-addresses` and `--max-sockets-per-address`, or `RELAY_PER_ADDRESS_PER_MINUTE`,
`RELAY_GLOBAL_PER_MINUTE`, `RELAY_MAX_SOCKETS`, `RELAY_MAX_ROOMS`, `RELAY_MAX_PAIR_ROOMS`, `RELAY_MAX_ADDRESSES` and
`RELAY_MAX_SOCKETS_PER_ADDRESS`. Behind a TLS proxy on the same machine every
connection comes from the proxy's address, so size the per-address limit for the whole deployment
and limit addresses at the proxy instead.

To run your own relay, or your own copy of the app, see
[Running your own relay](guide.md#running-your-own-relay) and
[relay/README.md](../relay/README.md#running-your-own).

## Regional relays

`relay.ovis.sh` runs on Cloudflare, which serves some networks from far away (from Korea, from Los
Angeles). Regional relay endpoints run the same relay (`relay/bun.ts` behind a TLS proxy) closer to
them; the list is `REGIONAL_RELAYS` in [`shared/relay-regions.ts`](../shared/relay-regions.ts), now
`relay-ap.ovis.sh` in Seoul.

- **The PC chooses.** A PC with no `OVIS_RELAY_URL` measures each relay's `/health` when the relay
  is turned on (the best of two round trips after a first one that opens the connection). A regional
  relay that answers in at most half the global relay's time, with both answering, is saved in
  `relay/region.json` under `OVIS_STATE_DIR` and kept from then on; with none saved, the PC measures
  again at every start, and a measurement that finishes after the relay was turned off is dropped.
  A PC with `OVIS_RELAY_URL` set uses that relay alone, unless it names one of Ovis's regional
  relays: that one is used with no measuring, and beside `relay.ovis.sh`, as below.
- **It stays on both.** The PC keeps its link to `relay.ovis.sh` and opens a second one, with the
  same key and proof, to the regional relay. New pairing QR codes and pairing links without a code
  name the regional relay while its link is online (the global one otherwise), and the relay status
  is the global link's. Signed-in sessions share one limit across both links (and the
  [direct carriers](#direct-on-the-same-network)): eight at once and four per device key.
- **It tells phones paired before.** A phone that offers `relay-hints` is told in `AUTH_OK` the
  relay new offers name, then `relay.ovis.sh`, and saves the first for that PC; the app uses it from
  the next time it opens that PC. This comes inside the encrypted channel from the PC the phone authenticated,
  so the relay cannot change it, and a phone only ever moves between Ovis's own relays: one saved
  with any other relay, and a named relay that is not Ovis's, are left as they are (`hintedRelay`
  in [`shared/relay-regions.ts`](../shared/relay-regions.ts)). An older phone or PC offers or takes
  no hints, and nothing changes for it.
- **The phone falls back.** A phone (or a PC that added this PC through the relay) whose saved relay
  is one of the regional ones and that cannot get through it (the relay does not answer, or the PC
  does not answer there) tries `relay.ovis.sh` at once, and keeps using the one that worked. A phone never falls back from any other relay, so a
  self-hosted one is never traded for Ovis's.

- **The app comes from nearby too.** Beside each regional relay a copy of the hosted app is served
  (`app-ap.ovis.sh` beside `relay-ap.ovis.sh`, `REGIONAL_APPS` in the same file). A browser that
  opens a pairing link on `app.ovis.sh` for a regional relay moves to that copy before the app's
  bundle loads (`regionalAppUrl`, run by the page's first script), and pairs there. Only a link
  with a pairing code moves: a phone keeps a PC's key in the address it paired on, so a PC saved on
  `app.ovis.sh` stays there, and a browser's list of PCs is then split between the two addresses
  (each lists the PCs paired on it). The iOS and Android apps stay on `app.ovis.sh`. The page moves
  only once the copy answers with the build `app.ovis.sh` serves, so a copy that is down or a
  release behind is never moved to. Each file of the copy is checked byte for byte against
  `app.ovis.sh` before it is served ([relay/README.md](../relay/README.md#a-regional-copy-of-the-app)),
  but the box still delivers the code that holds the phone's keys: whoever controls it is a trust
  root, as Cloudflare Pages is for `app.ovis.sh`
  ([The hosted app is a trust root](#the-hosted-app-is-a-trust-root)).

Which relay carries a connection changes nothing about its protection: the phone and the PC
encrypt end to end whichever relay passes the frames on, and each relay sees what
[What the relay sees](#what-the-relay-sees) says.

## Direct on the same network

While the relay is on, the PC also listens on its private IPv4 addresses (RFC 1918 and link-local,
port 7319, or another one when that is taken): the one its default route leaves from first, then the
others, leaving out container, VM and VPN adapters, at most four for the same channel without the relay
([`server/relay/direct.ts`](../server/relay/direct.ts)). It also listens on the PC's Tailscale IPv4
address (100.64.0.0/10) on the same port, when one is up: a Tailscale-range address on Tailscale's
own adapter (`tailscale0`, Windows' `Tailscale`), or on a macOS `utun` only when it is the address
`tailscale status` names (with one named, only that one); never one on a real adapter (an ISP's
shared address space) or another VPN's tunnel. It keeps one of the four
places. A phone that can reach one of them opens
it there instead of through `relay.ovis.sh`. A phone's app tries its direct carriers at once and opens
the relay beside them when none is up within 300 ms; a PC added through the relay tries the same
network, then Tailscale, within 1.5 s, then the relay (below). The iOS and Android apps open it through their OvisDirect
plugin ([native-app.md](native-app.md#direct-on-the-same-network)); a browser stays on the relay.

- **Same channel, same trust.** The listener speaks to a phone what the relay does (`/v1/ws`, an
  `assigned` frame, then the phone's Noise records) and hands the socket to the same session a
  relay data socket gets. The phone runs Noise against the PC key it pinned at pairing and signs in
  with its device key, as over the relay; a host at that address that is not the PC cannot finish
  the handshake, so an address is only a hint where to try. There is no TLS: Noise already proves
  the PC and protects the records. Someone on the network sees the records' sizes and timing.
- **Signing in only.** Nothing pairs there: a code or a comparison of digits sent on a direct
  carrier is refused with `auth_failed`, and the code stays unspent. Pairing stays on the relay.
- **Told inside the channel.** A phone that offers `direct-carrier` in `HELLO` is told in
  `AUTH_OK` `direct`: up to four `ws://<private IPv4>:<port>` addresses, checked on both ends. It
  comes from the PC the phone authenticated, so the relay cannot add an address. An older phone or
  PC offers or answers nothing, and nothing changes for it. The Tailscale address is named only to
  a phone that also offers `direct-tailnet` (an app whose plugin answers `features` with
  `tailnet: true`): an older phone would refuse the whole `AUTH_OK` over an address it does not take.
- **Bounded, and never locked out.** A socket that names an `Origin` (any browser page, on the network
  or not) is refused: the apps' sockets name none. A gate in front ([`direct-gate.ts`](../server/relay/direct-gate.ts))
  counts connections before reading a byte (8 per address, 128 in all) and gives a request head 5 s
  and 8 KiB; only a WebSocket upgrade of `/v1/ws` gets past it, to the carrier's own server on
  loopback. At most two clients that have not signed in per address, whose places only that
  address's clients take, and 64 in all. A client keeps its place for 1 s; after that a newer one
  from the same address may take it, and only once its upgrade has happened. A phone at an address of
  its own gets in unless dozens of hosts flood together; then it stays on the relay, where it falls
  back by itself; 5 s to finish the handshake and
  15 s to sign in, and no message larger than one protected mux frame. Signed-in sessions count
  against one set of limits whichever way they came (relay links and direct carriers together):
  eight at once and four per device key, whose oldest gives way once the new one is used (its first stream): until
  then it may be one of the app's racing carriers, which makes nothing give way, and past three of those for one
  device key the oldest of them does. With every place taken, a device already at its share still gets a racing
  carrier in (used, it replaces its own oldest), at most three past the limit in all. Peers outside private IPv4 are refused before upgrade, and on the Tailscale address
  every peer outside Tailscale's range (each listener takes only its own network's peers). Removing a device, stopping
  the relay, resetting its identity or turning direct connections off ends them.
- **The app moves on its own.** An app with a socket for it (`RelayTransport` `directSocket`)
  tries the PC's direct carriers first, two at a time (the plugins open no more), its first LAN and its
  Tailscale one first, all within 1.5 s, whenever it connects or
  reconnects. When none is up within 300 ms it opens the relay too and keeps whichever channel is
  admitted first; the other attempt is ended, and a channel it still admits is closed without
  being reported as a lost carrier. The reconnect of a planned switch (below) does not open the
  relay early: the carrier the probe just proved gets its whole 1.5 s first. While the relay carries it, it probes them (a socket, `assigned` and
  the Noise handshake to the pinned key, closed before `HELLO`, so the PC holds no session) after
  each admission (at most every 5 minutes, the next one due even across a reconnect), on `online`
  and when the page comes back to the foreground; once one proves to be the PC, no request is under
  way (uploads still being read included) and no WebSocket sent anything for 3 s, it closes the
  relay channel and the reconnect lands on that carrier, which nobody is told of as a lost carrier. A
  stream is never moved: the switch is a reconnect like any other. A failure before the PC answers
  falls back to the relay silently; a refusal by the PC (a removed device) is final as over the
  relay. The carriers are saved with the pairing for the next start. A browser has no such socket
  and always uses the relay.
- **Other PCs too.** A PC added through the relay ([remote-pcs.md](remote-pcs.md#through-the-relay))
  reaches it the same way from its own server: direct carriers first (same network before
  Tailscale), then the relay, probing earlier routes after admission, every 5 minutes at most and
  when its own addresses change or it wakes. It opens the session on the proven carrier before it
  closes the relay one, so the PC never shows as lost.
- **Said where it is.** While the relay is on, Settings → Devices and PCs → My devices shows "Same
  Wi-Fi direct connection on" (who can sign in there, and that it is on Tailscale too when it is)
  with its one switch, which turns both off. Each device paired with a relay key says there how it
  reaches the PC right now (**Same Wi-Fi, direct**, **Tailscale, direct**, the relay it uses, or
  **Offline** with when it was last seen and why), with the round trip of its session's keepalive:
  `GET /api/devices` adds `connection` to a device with a session up, and `?check=1` (**Check now**)
  measures every session first, for at most 3 s. The phone's **Your PCs** list probes each saved PC
  the way the app would connect (no session is opened) and shows the same line. `/api/health` names the
  listener to a client that got in (`direct_exposure`, a field of its own: a 0.4.x app takes any
  `lan_exposure` for an open server), and the app's banner says it in paired-only words. The open-server warning (`lanExposed`) is about the main listener
  only; starting the relay closes the pairing gate, so it never applies while this listener runs.
- **On unless turned off.** `POST /api/relay/direct` with `{ "on": false }` turns it off (kept in
  `relay/direct.json`; a file that cannot be read counts as off); `GET /api/relay` says whether it is on and where it listens. Addresses are
  read again every 30 s, and the listener follows them on the same port. On Windows the first
  bind of a network address shows Windows' own firewall prompt; declining it leaves the relay as
  the only way in.

## Code

| Path | What it does |
| --- | --- |
| [`relay/`](../relay/README.md) | the relay service: routing core, Cloudflare Worker, Bun server |
| [`server/relay/`](../server/relay) | the PC's side: identity, link to the relay, sessions, WebSockets over the mux, the switch and its routes |
| [`shared/relay-e2ee.ts`](../shared/relay-e2ee.ts) | the encryption, from paseo's code vendored in `shared/vendor/paseo-e2ee/` (never edited; `bun scripts/vendor-paseo.ts <commit>` updates it) |
| [`shared/relay-mux.ts`](../shared/relay-mux.ts), [`shared/relay-mux-engine.ts`](../shared/relay-mux-engine.ts) | Ovis Mux v1 |
| [`shared/relay-offer.ts`](../shared/relay-offer.ts) | the pairing link |
| [`shared/relay-pair-sas.ts`](../shared/relay-pair-sas.ts), [`server/relay/pairing-approvals.ts`](../server/relay/pairing-approvals.ts) | pairing by comparing digits: the commitment and digits, and the prompts waiting on the PC |
| [`src/lib/relay/`](../src/lib/relay) | the hosted app: channel, device key, transport, file loading and screens |
| [`public/sw.js`](../public/sw.js) | the service worker; in the hosted app it also answers file addresses through the relay |
| [`scripts/shell-build.ts`](../scripts/shell-build.ts) | the hosted app's build (`bun run build:shell`, into `dist-shell/`) |
