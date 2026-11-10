# Ovis relay

The meeting point for a PC running Ovis and a phone or browser that cannot reach it directly, at
`relay.ovis.sh`. Both sides dial out to the relay, which pairs their WebSockets by the PC's
`server_id` and passes frames between them as they came. The frames are end-to-end encrypted
between the device and the PC, so the relay carries ciphertext it has no key for.

One routing core (`core.ts`) runs in two places: a Cloudflare Worker with one Durable Object per
`server_id` (`worker.ts`, deployed as `relay.ovis.sh`), and a plain Bun server (`bun.ts`) for the
tests and for anyone running their own.

## What it answers

`GET /health`: `200 ok`.

`GET /v1/ws?server_id=<32 lowercase hex>&role=...&v=1`, a WebSocket upgrade. `v` is the wire
version; any version other than `1` (or none) is accepted and then closed with `1008`, so an
outdated peer learns why. A malformed `server_id`, `role` or `connection_id` is `400` before any
upgrade, and a request that is not an upgrade is `426`.

| Socket | Query | Who |
|---|---|---|
| control | `role=server` | the PC, one per `server_id` |
| client | `role=client` | a phone or browser; the relay picks its `connection_id` |
| data | `role=server&connection_id=<id>` | the PC, one per client |
| warm | `role=server&warm=<generation>` | the PC, at most one: a data socket opened before its client arrives |

`GET /v1/pair?nameplate=<3 Crockford base32>&role=host|guest&v=1`, a WebSocket upgrade: the
rendezvous for pairing with a typed code (`pair-room.ts`, [docs/relay.md](../docs/relay.md#who-gets-in), "Pairing with a typed code").
The PC holds a nameplate (`host`, one per nameplate, else `4409`; at most 11 minutes). A host that
adds its PC's key (`&server_id=<id>&public_key=<64 hex>`) answers a server challenge for it first
(role `pair-host`, `connection_id` the nameplate; `4401` otherwise) and holds the nameplate only
once it has; while it proves, another host gets `4409` and a device `4404`. A device
joins it (`guest`: `4404` with no host, `1013` while another guest is there, past 12 guests in the
room's life or within 2 seconds of the last). Each guest gets a random attempt id the host hears in
`{"type":"guest","attempt"}` and `{"type":"gone","attempt"}`; a guest's binary frames reach the
host prefixed with that id, and the host's must start with the current guest's id, which is
stripped (a stale one goes nowhere). `{"type":"drop","attempt"}` ends that guest. Frames are at
most 4096 bytes; a guest has 30 seconds. The relay reads none of the exchange and keeps no limit
the PC relies on.

The PC proves every socket it opens (control and data): its query also carries
`proof=1&public_key=<64 lowercase hex>`, its static X25519 public key, and its `server_id` must be
the first 16 bytes of `SHA256(UTF8("ovis-relay-server-id-v1") || public_key)` as 32 lowercase hex
digits. The relay's first frame is then
`{"type":"server_challenge","public_key":"<ephemeral X25519 hex>","nonce":"<32 random bytes hex>"}`,
and the PC's first frame must be `{"type":"server_proof","answer":"<HMAC-SHA256 hex>"}`, keyed with
the X25519 shared secret over `nonce || UTF8(server_id + NUL + role + NUL + connection_id + NUL +
"ovis-relay-server-proof-v1")` (role `control`, `data` or `warm`; the connection id is empty for
control and the generation for warm);
`shared/relay-server-proof.ts` has both sides. The relay compares the answer in constant time and
refuses an all-zero shared secret. Until it answers, the socket is no part of the room: it hears no
client and replaces nothing. A missing proof, a key that does not derive the `server_id`, a wrong,
replayed or late answer (10 s) closes it `4401`, so knowing a `server_id` (it is in every offer,
and a revoked device keeps it) is not enough to take the PC's place. At most 16 PC sockets of one
`server_id` wait to answer at once; a 17th closes the oldest `1013`, so pushing the PC's own socket
out takes 16 arrivals within its one round trip.

The PC retries transient refusals, including `4401` with `server proof timed out` or the
ambiguous `invalid or expired server proof`, with its normal backoff. Only a control-socket
`4401` with `server key does not match server_id` or `invalid server key` stops retries and
reports the reason in relay status. An invalid or out-of-order first challenge is closed by
the PC with `4000` and retried. Refusing a data socket does not stop the control link.

- A client's first frame is `{"type":"assigned","connection_id":"<32 hex>"}`, its random 128-bit id.
- The control socket hears `{"type":"sync","connection_ids":[...],"warm":"<32 hex>"}` when it opens
  (the clients still waiting for a data socket; `warm` says this relay takes a warm socket and
  names this control socket's generation, new for each one),
  `{"type":"connected","connection_id":"..."}` when a client arrives and
  `{"type":"disconnected","connection_id":"..."}` when one leaves. The PC answers `connected` (or
  `sync`) by opening the client's data socket. The PC may send `{"type":"relay_pass","pass":"..."}`
  ("Relay pass" below) and `{"type":"new_session","connection_id":"..."}` ("New sessions" below);
  anything else the PC sends on the control socket is dropped.
- Warm socket: so that a client does not wait for the PC to open and prove a socket, the PC may
  keep one proven `warm` socket ready, opened with the generation its control socket's `sync` named.
  A client arriving while that control socket is connected takes it at once: the warm socket hears `{"type":"bound","connection_id":"..."}` before any of
  that client's frames and is its data socket from then on, and the control socket hears no
  `connected` for it. The PC then opens the next one. A newer warm socket replaces an older one
  (`1008`); one no client has taken, proven or still proving, closes `1001` when its control socket
  is replaced or gone, and one whose generation is not the connected control socket's closes `1001`
  once proven. Anything else a warm socket
  sends before it is taken is dropped.
- A client holds one of the PC's slots once the PC has answered it, that is once its data socket
  has sent a frame. Until then it is waiting: with the PC connected, it is closed `1013` 15 s after
  the PC could have answered (from its data socket attaching, or from the client or the PC
  arriving, whichever is later), keepalives or not. While no PC is connected it waits 30 s for one
  (from its arrival, or from the PC leaving), then closes `1013`, keepalives or not; a PC that
  comes back in time gives it the full 15 s again. A client past the waiting limit pushes the oldest
  waiting one out, so holding the waiting places takes 4 arrivals within one phone's handshake.
- From then on, every frame from the client goes to its data socket and back, text as text and
  binary as binary, byte for byte. Frames a client sends before its data socket attaches are held
  and handed over in order when it does.
- Keepalive: a socket that sends exactly `{"type":"ping"}` gets `{"type":"pong"}` back, and nothing
  is passed on. The PC sends it on its control socket every 10 s and counts the relay gone after
  30 s without an answer. On Cloudflare the runtime answers it (`setWebSocketAutoResponse`)
  without waking the Durable Object, so an idle PC costs nothing.

## Relay pass

A relay may let in only PCs that hold a relay pass (`relay/pass.ts`, `shared/relay-pass.ts`): a
short-lived token the Ovis account service signs for a PC that proved its relay key to it and that a
signed-in account lists. Phones and browsers never need one, and the frames stay end-to-end encrypted
whatever the pass says. The setting is off unless the relay's operator turns it on; a relay you run
yourself stays open.

**Keep it off on Ovis's relays for now.** Nothing issues passes yet and no PC sends one: turning on
`grace` would only add a notice, but `enforce` would refuse every PC. It stays `off` until the
account service issues passes, and PCs fetch and renew them, and send them with their typed-code
pairing hosts, in a release most PCs run.

- **The pass.** `ovp1.<payload>.<signature>`, base64url. The payload is JSON with exactly `v` (1),
  `kid`, `aud` (`ovis-relay`), `sid` (the PC's `server_id`), `iat` and `exp` (seconds; 48 hours
  apart, and a relay refuses one good for longer); the signature is Ed25519 over `ovis-relay-pass/1.` followed by the payload's text. It names
  no account. A v2 payload has the same fields with `v` 2 and one more, `new`: 1 when new client
  sessions to the PC are allowed, 0 when they are not for the pass's lifetime; a v1 pass allows
  them. The prefix stays `ovp1.`: the signature covers the payload, `v` and `new` included. The
  relay accepts both forms; what `new` does is under "New sessions" below.
- **Sending it.** The PC puts it in the `x-ovis-relay-pass` header of every PC socket's upgrade
  (control, data, warm), never in the URL. A pass alone opens nothing: the socket still answers the
  server challenge for that `server_id`'s key, so a copied pass is no use without the PC's secret key.
- **Checking it.** Once per socket, before any room: its shape, a known `kid`, `sid` equal to the
  socket's `server_id`, `iat` at most 5 minutes ahead and `exp` at most 5 minutes behind, then the
  signature. Never per frame. On Cloudflare the Worker checks it and hands only the result to the
  Durable Object.
- **Limits for a PC with a pass.** Every socket counts against its address's budget first. Once that
  is spent (others behind the same NAT, an office's, say), a PC socket whose pass holds still gets in
  on a budget of its own, keyed by its `server_id`. Only then is the pass checked before admission:
  first everything but the signature (a pass for another PC, or one that cannot hold, is refused for
  nothing), then the signature, which takes one of the address's pass checks (30 a minute) and one
  place of the backstop's, so forged passes cost a bounded number of signature checks (about 150 us
  each). It is relief at best, never a guarantee: on Cloudflare these limits count per location and
  approximately, someone behind the same address can spend its pass checks, and a copied pass (no
  use without the PC's key) can spend that PC's own budget. A PC then stands where it would without
  its pass: on its address's budget.
- **The room.** A proven PC socket's pass authorizes its room until the pass expires; the expiry is
  kept in the Durable Object's storage, so it outlives an eviction. The PC renews it on its proven
  control socket with `{"type":"relay_pass","pass":"..."}`, which only ever moves the expiry later; a
  relay without passes drops that frame like any other.
- **New sessions.** The account service issues a pass with `new` 0 to a PC whose account is past
  its limits (a relay data limit, say). The room keeps what the pass that authorizes it says: the
  one that runs out last, which is the one issued last, so a later renewal with `new` 1 lifts it at
  once; of two passes issued the same second (the same expiry), the one with `new` 0 holds, in
  whichever order they are proven. Only the PC can tell a device new to it from one it knows: the
  relay sees no device, and the frames are end-to-end encrypted. So every client gets in as before,
  and once the PC has identified a client as a device new to it, it says so on its control socket
  with `{"type":"new_session","connection_id":"..."}`. While enforced and the room's pass says
  `new` 0, the relay then closes that client `4403` (`no new sessions for this server`), whether it
  arrived before or after the PC; otherwise it drops the frame. The PC's own devices, reconnecting
  or not, its other clients and its own sockets stay, and a client the PC has not identified hears
  nothing of the pass. `off` and `grace` let every client in whatever the pass says. An Ovis PC
  names a client once a pairing on its session would make a device new to it (a code that holds, or
  a comparison both people confirmed, with a key none of its devices holds), and only while `sync`
  says passes are enforced ([docs/relay.md](../docs/relay.md#relay-pass)). The relay refuses only
  whom the PC names, so the pass the PC holds decides: a room still holding an older pass refuses
  nobody by itself. Where the PC refuses a device on a pass the room does not hold yet (a renewal
  still on its way, a control socket reconnecting), the relay drops the frame and the PC closes the
  client's data socket itself 2 s later; the client then hears `1012` (`server gone`), not `4403`.
  Since a renewal within a minute of the one before on the same socket is dropped unanswered, the
  PC sends a later one only once that minute has passed, so the room holds the PC's latest pass
  about a minute after it changed at the latest.
- **What a PC and a relay of different versions do.** `relay_pass.mode` and `new_session` are both
  additions an older side ignores, so the relay and the app deploy in either order and nothing
  breaks. A PC from before it names clients never sends `new_session`: this relay refuses nobody
  for new sessions on its behalf, whatever its pass says. A PC that names clients on a relay from
  before `mode` reads the relay as enforcing only past its `enforce_at`: in `enforce` with no date
  or one still ahead it names nobody, and the limit is not applied; on a relay that does not know
  `new_session` at all the frame is dropped and the PC refuses the device by itself (the 2 s close
  above). So deploy this relay before passes are switched to `enforce`, and before the release
  whose PCs name clients.
- **Modes**, from `RELAY_PASS_MODE` (`--pass-mode`): `off` (the default) lets every PC in as
  before. `grace` lets every PC in, and adds `"relay_pass":{"state","enforce_at","mode"}` to the control
  socket's `sync` (`state` `ok`, `missing`, `invalid` or `expired`; `mode` the configured one, `grace` or
  `enforce`, from which with `enforce_at` a PC knows whether passes are enforced now) and, while the room has no pass
  that holds, to a client's `assigned` (`missing`), so the app can say so; older PCs read neither.
  `enforce` closes a PC socket without a pass that holds `4402` (on Cloudflare in the Worker, before
  any Durable Object), and a room whose pass ran out closes its PC sockets `4402` (its clients with
  them), warm sockets first, so each hears why. A frame that arrives after the room's pass ran out goes
  nowhere: the room's PC sockets close first, without waiting for the sweep. `grace` turns into
  `enforce` at `RELAY_PASS_ENFORCE_AT` (`--pass-enforce-at`, an ISO 8601 UTC instant such as
  `2027-01-01T00:00:00Z`), and the room wakes then. `RELAY_PASS_KEYS` (`--pass-keys`) is `kid:hex[,kid:hex]`, the Ed25519 public keys;
  `RELAY_PASS_REVOKED` (`--pass-revoked`) lists `server_id`s refused whatever their pass. An unknown
  mode is `off`, with a log line. Other settings that do not parse stop the Bun relay from starting;
  the Worker logs them and runs with passes off, so it never stops routing.
- **Typed-code pairing hosts.** A `/v1/pair` host offers the PC's key and sends the pass in the same
  header. The pass is checked as a PC socket's is, for the `server_id` of that key, and the host
  proves the key for its nameplate before it holds it, so a pass alone holds no nameplate and a proof
  opens no other nameplate or PC socket. While enforced, a host without a pass that holds for the key
  it offers (or offering none) closes `4402`, on Cloudflare in the Worker; a device that types a code
  never needs one. A host keeps its nameplate only while that holds: once enforcement begins, or its
  pass runs out (5 minutes allowed for clocks), it closes `4402` with its device, at the alarm set for
  that moment or at the next frame or arrival in the room, whichever comes first; once the relay
  revokes its PC or no longer trusts its pass's key, at the next frame, arrival or alarm that the new
  settings reach: after a deploy, a Durable Object may run the previous version and its settings for
  a few minutes, and a host admitted by a version older than this check names no pass key or PC. Any
  revocation in the settings closes it the same way (nothing on it says which PC was revoked); a key
  removed from the settings cannot be matched against one, so without a revocation it is held to its
  pass's expiry and its 11-minute deadline. The PC then opens the nameplate again with the pass it
  holds now.
- **Storage.** With passes off, and for pairing rooms always, the Durable Object never reads its
  storage.

## Limits and close codes

| Limit | Value | Past it |
|---|---|---|
| frame size | 64 KiB (Ovis frames stay under about 22 KiB) | that socket closes `1009` |
| clients the PC has answered, per `server_id` | 8 | the new client closes `1013` |
| clients the PC has not answered yet, per `server_id` | 4 | the oldest of them closes `1013` |
| a client the PC has not answered, with the PC connected | 15 s | the client closes `1013` |
| a client waiting while no PC is connected | 30 s | the client closes `1013` |
| a PC socket answering its challenge | 10 s, 16 at once per `server_id` | `4401`; past 16 the oldest closes `1013` |
| frames held for a waiting client | 200 frames or 1 MiB, whichever comes first | the client closes `1013` |
| idle | 120 s without a frame or keepalive | the socket closes `1001` |
| connections per address | Cloudflare Worker: 30 a minute; Bun: 120 a minute | `429`, `Retry-After: 60` |
| connections per PC whose relay pass holds, once its address's budget is spent (passes on) | Cloudflare Worker: 30 a minute; Bun: as per address | `429`, `Retry-After: 60` |
| relay passes checked per address past its own budget | Cloudflare Worker: 30 a minute; Bun: as per address | `429`, `Retry-After: 60` |
| connections from all addresses | 600 a minute | `429`, `Retry-After: 60` |
| total sockets (Bun, including pending upgrades/proofs) | 1024 | `503`, `Retry-After: 60` |
| rooms (Bun, including pending upgrades) | 256 | `503`, `Retry-After: 60` |
| open sockets per address (Bun, waiting, connected or upgrading) | 64 | `429`, `Retry-After: 60`; open sockets are never closed for it |
| address buckets (Bun) | 4096 | a new address gets `429` until an idle bucket expires |

| Code | Meaning |
|---|---|
| `1001` | to a data socket: its client left. To a warm socket: no control socket (any more), or a newer one replaced it. To any socket: idle, or a data socket for a client that is gone |
| `1008` | to a control socket: a newer control socket for the same `server_id` replaced it. To a warm socket: a newer warm socket replaced it. Also an unknown wire version, or a second data socket for one client |
| `1009` | a frame over 64 KiB |
| `1012` | to a client: its data socket (the PC's side) went away, or the relay lost the frames it held (a Durable Object evicted mid-wait, noticed when the data socket attaches or the client sends again; each such close is counted in the room's `heldFramesLost`); reconnect |
| `1013` | a limit above; try again later |
| `4401` | to a PC socket, or a pairing host that offers a key: proof missing, a key that does not derive the `server_id`, or a wrong or late answer |
| `4402` | to a PC socket or a pairing host: no relay pass that holds while the relay asks for one (`relay pass required`, `relay pass expired`, `relay pass invalid`) |
| `4403` | to a client the PC identified as a device new to it, while passes are enforced and the PC's pass allows no new sessions (account limits; `no new sessions for this server`). Its other clients stay |

A socket that closes itself has its close answered at once, with its own code when that is `1000`
or `3000`-`4999` (`1000` otherwise, such as for `1001` or `1005`), and its partner is closed as above. On Cloudflare the
runtime does not answer the close of a socket taken with `acceptWebSocket` (hibernation) by itself,
whatever `web_socket_auto_reply_to_close` says for other sockets. Measured with the compatibility
date in `wrangler.toml`, on relay.ovis.sh and on workerd 2026-10-23, a relay that left it to the
runtime sent no Close frame, and the connection dropped about 10 s later. So the room answers it.

The newest proven control socket wins rather than the first, because an older one may be half-open after
the PC's network moved; the PC reconnects within its backoff either way. The rate limits are
Cloudflare's Rate Limiting bindings (`wrangler.toml`), counted per Cloudflare location and
approximate; the per-address limit is asked first, so one address over its limit never uses up
the backstop every PC shares. On Cloudflare the idle check runs from a Durable Object alarm. A
socket is never closed sooner than 120 s after its last frame or keepalive. After the Durable
Object was evicted, the relay knows only a last-seen time each socket saves at most every 30 s,
and counts from 30 s after it, so such a socket closes at most 150 s after its last frame.

## What it sees and keeps

It sees, per socket: the `server_id`, the role, the `connection_id`, the PC's public key and its
answer to the challenge, when frames pass and how
large they are, and the connecting address (as the key of the per-address rate limiters only). It
does not see what a frame says: frames are encrypted end to end, and the relay neither parses nor
logs them.

It keeps usage counters and nothing else. Who each socket is lives in memory and, on Cloudflare, in
the socket's own attachment, which is gone with the socket. A client's frames are held in memory
only until its data socket attaches. The Durable Object's SQLite storage stays empty (it holds the
idle alarm only), Workers Logs are off (`[observability] enabled = false`), and nothing writes a
log line. A relay restart or a Cloudflare deploy drops every socket; the PC reconnects and
announces itself again, and clients reconnect.

### Usage counters

For capacity planning, the Cloudflare relay counts how much each PC uses it. When a PC's control
socket or a phone's socket closes, and every 5 minutes while it stays open, it writes one data
point to the `ovis_relay_usage` Workers Analytics Engine dataset (`USAGE` in `wrangler.toml`):

| Field | Holds |
|---|---|
| `index1` | the PC's usage key: the first 32 hex digits of `SHA256(UTF8("ovis-relay-usage-v1:" + server_id))`, not the `server_id` itself |
| `blob1` | `pc` (the PC's control socket) or `device` (a phone or browser, both directions of its pair) |
| `double1`, `double2` | bytes from the device to the PC, and from the PC to the device (frames passed on; keepalives not counted) |
| `double3` | seconds connected |
| `double4` | `1` when the socket closed with this point (one session), `0` for a 5-minute point |

A device's time counts from the PC's first answer, and its bytes from its first frame; a phone the
PC never answered is no session and writes nothing. The relay tells devices apart only by their random per-connection `connection_id`,
which is not written: a point says "a device of this PC", never which one. No frame content,
address, public key or `connection_id` is written. The counts live in the socket's attachment
until they are written, so an eviction loses none; a deploy or a reset of the Durable Object, which
drops the sockets without their close, loses at most the last 5 minutes of each. Analytics Engine keeps each point three months
and then drops it. The Bun server counts nothing.

Only the Cloudflare account that runs the relay can read them, through the Analytics Engine SQL API
with a token that has Account Analytics Read:

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data "
    SELECT toStartOfDay(timestamp) AS day, index1 AS pc, blob1 AS side,
      SUM(_sample_interval * double1) AS bytes_up, SUM(_sample_interval * double2) AS bytes_down,
      SUM(_sample_interval * double3) / 60 AS minutes, SUM(_sample_interval * double4) AS sessions
    FROM ovis_relay_usage WHERE timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY day, pc, side ORDER BY day, pc, side FORMAT JSON"
```

## Deploy

`relay.ovis.sh` is deployed from CI only, never from a laptop: the Relay deploy workflow
(`.github/workflows/relay-deploy.yml`) runs on a push to main that touches `relay/` (or `shared/relay-server-proof.ts`, which the Worker imports) once CI passes,
and by hand from main. It runs `bun test ./relay`, then `bunx wrangler@4.156.0 deploy` in `relay/` with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then asks `https://relay.ovis.sh/health` up to
5 times, 5 s apart (20 s each), and fails only when none of the answers is a 2xx.
A deploy drops every socket; the PC and clients reconnect. Without the two secrets the job passes
with a notice naming the missing one and deploys nothing. It needs the `ovis.sh` zone on the deploying
account: the route in `wrangler.toml` makes `relay.ovis.sh` a custom domain of the Worker, and
`workers_dev = false` leaves no second address. The deploy creates the Durable Object class
(`[[migrations]]`) and the rate limiters (`[[ratelimits]]`, whose `namespace_id` only has to
be unique among the account's limiters). The Worker itself has no secrets.

One-time setup by the owner:

1. Put the account on the Workers Paid plan (Durable Objects need it) and set a billing alert at
   $20 a month.
2. Add the `ovis.sh` zone to that account; the first deploy attaches `relay.ovis.sh` to it as the
   Worker's custom domain.
3. Create an API token that can edit Workers (Workers Scripts: Edit, plus the zone's Workers
   Routes and DNS for the custom domain) and note the account ID.
4. In GitHub, create the `production` environment (Settings > Environments) with the maintainer as
   a required reviewer, and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets of
   that environment. The reviewer is configured in GitHub, not in the workflow.

A release guard like the Worker one in `scripts/release-guards.ts` is added only when the relay's
wire version changes (`v=1`); there is none in v1. To check the bundle without deploying:

```sh
cd relay
bunx wrangler@4.156.0 deploy --dry-run --outdir /tmp/relay-dist
```

### Staging

`[env.staging]` in `wrangler.toml` is a copy of the relay for end-to-end checks of passes and pairing
before a change reaches `relay.ovis.sh`: the Worker `ovis-relay-staging`, at its workers.dev address
only (`routes = []`: an environment inherits the routes above otherwise), with Durable Objects,
limiters and a usage dataset (`ovis_relay_usage_staging`) of its own, and passes enforced. CI never deploys it; it is deployed by
hand, and that deploy never touches `relay.ovis.sh`:

```sh
cd relay
bunx wrangler@4.156.0 deploy --env staging
```

Put the staging account service's public key in `RELAY_PASS_KEYS` under `[env.staging.vars]` first:
without one the Worker logs `relay.pass.settings_invalid` and lets every PC in. A test PC reaches it
with `OVIS_RELAY_URL=wss://ovis-relay-staging.<workers.dev subdomain>.workers.dev`,
`OVIS_ACCOUNT_SERVICE_URL=https://account-staging.devswha.workers.dev` (Ovis's staging account
service) and `OVIS_RELAY_STAGING=1`: the PC then uses that relay alone (no regional one beside it),
asks the staging service for its pass and sends it there and nowhere else. With any other account
service the setting does nothing but log `relay.staging.ignored`, and a pass only ever goes to the
relays of the service that signed it (the production one's to Ovis's production relays).

## Running your own

Either deploy the Worker to your own Cloudflare account (change `name` and the route in
`wrangler.toml`), or run the Bun server anywhere Bun runs:

```sh
bun relay/bun.ts --port 8787 --hostname 127.0.0.1
```

It listens on plain HTTP, so put it behind a TLS proxy (Caddy, nginx, `tailscale serve`) and give
the PC and devices the `wss://` address. Bun enables in-memory token buckets by default,
with a 120/address/minute and 600/global/minute budget. They start full and
refill continuously (bursts of 120 and 600 respectively); they are process-local, whereas
Cloudflare's approximate counters are per location. An address refusal does not spend global
tokens. Idle address buckets expire after a minute; active buckets are never evicted to admit
new addresses. Restarting the process clears the budgets.

The address is the TCP peer, never an untrusted forwarding header. Behind a local TLS proxy,
all users share that proxy's address bucket and its open-socket cap, so size both for the whole
deployment. Set
its budget for that deployment and also limit
real client addresses at the trusted proxy; do not simply trust `X-Forwarded-For` from callers.
The global cap remains a backstop.

| Flag | Environment | Default |
|---|---|---|
| `--per-address-per-minute` | `RELAY_PER_ADDRESS_PER_MINUTE` | 120 |
| `--global-per-minute` | `RELAY_GLOBAL_PER_MINUTE` | 600 |
| `--max-sockets` | `RELAY_MAX_SOCKETS` | 1024 |
| `--max-rooms` | `RELAY_MAX_ROOMS` | 256 |
| `--max-pair-rooms` | `RELAY_MAX_PAIR_ROOMS` | 256 (pairing rooms for typed codes, apart from PCs' rooms) |
| `--max-addresses` | `RELAY_MAX_ADDRESSES` | 4096 |
| `--max-sockets-per-address` | `RELAY_MAX_SOCKETS_PER_ADDRESS` | 64 |

Flags override environment. Values must be positive safe integers; zero, infinity, fractions
and missing flag values fail startup. `startBunRelay({ limits: { maxSockets: 2048, ... } })`
accepts the same budgets as camel-case options (`perAddressPerMinute`, `globalPerMinute`,
`maxSockets`, `maxRooms`, `maxPairRooms`, `maxAddresses`, `maxSocketsPerAddress`). Programmatic options do not read environment.
`startBunRelay({ limiters })` can replace just the rate limiters; room/socket caps still hold.
Admission reserves both caps synchronously before upgrade, rolls back failed upgrades and
reclaims a room when its last pending/open socket leaves. `/health` remains available at capacity.
All per-room and per-frame limits apply on both adapters.

## A regional copy of the app

A relay box can also serve a copy of the hosted app for its region, as `app-ap.ovis.sh` does
beside `relay-ap.ovis.sh` (`REGIONAL_APPS` in `shared/relay-regions.ts`):

1. A DNS record for the copy's address that points at the box directly (not through a CDN that
   routes the region elsewhere).
2. The Caddy site, printed from the same rules the Pages build writes (`_redirects`, `_headers`):
   `bun scripts/shell-caddy.ts app-ap.ovis.sh >> /etc/caddy/Caddyfile`.
3. `bun relay/shell-mirror.ts --dir /opt/ovis-shell`, run every few minutes (a systemd timer) as a user
   that owns only that folder. Each run reads the commit `app.ovis.sh` serves from its
   `build.json`, finds the GitHub release built from it, checks its `dist-shell.tar.gz` against the
   SHA-256 published with it and its `build.json` against the commit, compares every file with
   the same file fetched from `app.ovis.sh`, and swaps `current` to it only if `app.ovis.sh` still
   serves that commit. It refuses a tarball with links, special files or paths outside it. A box
   that serves the app delivers code that holds phones' keys, so keep it to that and the relay,
   and keep `/opt/ovis-shell` writable by the mirror's user alone.

## Tests

`bun test ./relay` from the repository root. `bun.test.ts` runs the Bun relay on a free port and
drives real WebSockets through it: pairing, holding and its limits, close codes, the client caps,
oversized frames, byte-for-byte forwarding and a fake rate limiter. `worker.test.ts` runs the
Worker and the Durable Object over a fake Durable Object state, including an eviction between
frames, the idle alarm and the limiters. In CI they run with the unit tests in Fast checks
(`scripts/ci-tests.ts`), as does the typecheck.

`bun relay/load-smoke.ts --pcs 200 --clients 4` starts the Bun relay, connects 200 PCs with 4
clients each, sends 50 random frames each way per client and prints frames sent and received;
it exits 1 unless every frame arrived intact and in order. `--url ws://host:port` points it at a
running relay instead. The local load smoke sizes its budgets to the requested load rather than
disabling production limits; provision matching budgets when using `--url`.
