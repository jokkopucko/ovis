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
  the PC's own server sends, with only the relay's `wss:` connections and `blob:` media and frames
  added (`shellContentSecurityPolicy()` in [`server/static.ts`](../server/static.ts)). A rendered
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

To take `app.ovis.sh` out of the picture, [host the app yourself](guide.md#running-your-own-relay).

### Who gets in

**Pairing.** While the relay is online, **Settings → Phone & devices** on the PC shows a QR code
holding a link of the form `https://app.ovis.sh/s/<server_id>/#offer=<data>`. The data names the PC
(`server_id`), its public key, the relay's address and a pairing code
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
relay can't start or stop the relay, show its QR code or reset its identity (403 `local_required`); like any paired
device that can type, it can still start a pairing code under Devices.

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
   with role `control` or `data` and an empty control connection ID. The relay rejects an all-zero
   shared secret and compares the MAC in constant time. This proves the PC's secret possession to
   the relay; it does not authenticate the relay to the PC or replace the phone's Noise handshake.
2. **The phone connects.** The app opens the same address with `role=client`. The relay gives the
   connection a random ID and tells the PC, which opens a data WebSocket for it, and from then on the
   relay passes frames between the two sockets byte for byte
   ([what it answers](../relay/README.md#what-it-answers)).
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
4. **Admission.** Inside the encrypted channel they speak Ovis Mux v1. The phone sends `HELLO`, the
   PC answers `WELCOME` with 32 fresh random bytes, its version and its limits, the phone sends `PAIR`
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
| `0x01` | `HELLO` | phone | `protocol: "ovis-mux"`, the versions and features it offers |
| `0x02` | `WELCOME` | PC | version 1, the limits, `nonce` (32 random bytes), `server_version`, `relay_protocol`, `min_supported_client` |
| `0x03` | `AUTH` | phone | `scheme: "device-key"`, `device_id`, `signature` (64 bytes, P-256 `r` and `s`, base64url) |
| `0x0A` | `PAIR` | phone | the six-digit `code`, a `label` of up to 64 characters, `public_key` (P-256 SPKI, base64url) |
| `0x04` | `AUTH_OK` | PC | `session_id`, `device_id`, `role` (`drive` or `watch`) |
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
  `referrer-policy`, exactly as the handler set them. No cookie is ever set.
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
| `auth_failed` | a wrong, spent or expired pairing code, an unknown device or a bad signature, a pairing while the PC takes none after too many failures, and every admission on a serve-only PC |
| `auth_revoked` | the device was revoked |
| `auth_changed` | the device's role changed while it was connected; its terminal sockets close with 1008 and the app reconnects by itself with the new role. Renaming a device ends no session |
| `flow_control_error` | data past a stream's window |
| `resource_exhausted` | too many new streams or frames a second, or a queue over its limit |
| `timeout` | admission or a keepalive took too long |
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
in all, 1024 sockets, 256 PCs, 4096 addresses tracked at once and 64 open sockets per address
(waiting, connected or still upgrading). A new socket past the per-address cap gets `429` with
`Retry-After: 60`; sockets already open keep their place. Raise the limits with
`--per-address-per-minute`, `--global-per-minute`, `--max-sockets`, `--max-rooms`,
`--max-addresses` and `--max-sockets-per-address`, or `RELAY_PER_ADDRESS_PER_MINUTE`,
`RELAY_GLOBAL_PER_MINUTE`, `RELAY_MAX_SOCKETS`, `RELAY_MAX_ROOMS`, `RELAY_MAX_ADDRESSES` and
`RELAY_MAX_SOCKETS_PER_ADDRESS`. Behind a TLS proxy on the same machine every
connection comes from the proxy's address, so size the per-address limit for the whole deployment
and limit addresses at the proxy instead.

To run your own relay, or your own copy of the app, see
[Running your own relay](guide.md#running-your-own-relay) and
[relay/README.md](../relay/README.md#running-your-own).

## Code

| Path | What it does |
| --- | --- |
| [`relay/`](../relay/README.md) | the relay service: routing core, Cloudflare Worker, Bun server |
| [`server/relay/`](../server/relay) | the PC's side: identity, link to the relay, sessions, WebSockets over the mux, the switch and its routes |
| [`shared/relay-e2ee.ts`](../shared/relay-e2ee.ts) | the encryption, from paseo's code vendored in `shared/vendor/paseo-e2ee/` (never edited; `bun scripts/vendor-paseo.ts <commit>` updates it) |
| [`shared/relay-mux.ts`](../shared/relay-mux.ts), [`shared/relay-mux-engine.ts`](../shared/relay-mux-engine.ts) | Ovis Mux v1 |
| [`shared/relay-offer.ts`](../shared/relay-offer.ts) | the pairing link |
| [`src/lib/relay/`](../src/lib/relay) | the hosted app: channel, device key, transport, file loading and screens |
| [`public/sw.js`](../public/sw.js) | the service worker; in the hosted app it also answers file addresses through the relay |
| [`scripts/shell-build.ts`](../scripts/shell-build.ts) | the hosted app's build (`bun run build:shell`, into `dist-shell/`) |
