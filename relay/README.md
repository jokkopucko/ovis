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

The PC proves every socket it opens (control and data): its query also carries
`proof=1&public_key=<64 lowercase hex>`, its static X25519 public key, and its `server_id` must be
the first 16 bytes of `SHA256(UTF8("ovis-relay-server-id-v1") || public_key)` as 32 lowercase hex
digits. The relay's first frame is then
`{"type":"server_challenge","public_key":"<ephemeral X25519 hex>","nonce":"<32 random bytes hex>"}`,
and the PC's first frame must be `{"type":"server_proof","answer":"<HMAC-SHA256 hex>"}`, keyed with
the X25519 shared secret over `nonce || UTF8(server_id + NUL + role + NUL + connection_id + NUL +
"ovis-relay-server-proof-v1")` (role `control` or `data`, an empty connection id for control);
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
- The control socket hears `{"type":"sync","connection_ids":[...]}` when it opens (the clients
  still waiting for a data socket), `{"type":"connected","connection_id":"..."}` when a client
  arrives and `{"type":"disconnected","connection_id":"..."}` when one leaves. The PC answers
  `connected` (or `sync`) by opening the client's data socket. Anything else the PC sends on the
  control socket is dropped.
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
| connections from all addresses | 600 a minute | `429`, `Retry-After: 60` |
| total sockets (Bun, including pending upgrades/proofs) | 1024 | `503`, `Retry-After: 60` |
| rooms (Bun, including pending upgrades) | 256 | `503`, `Retry-After: 60` |
| open sockets per address (Bun, waiting, connected or upgrading) | 64 | `429`, `Retry-After: 60`; open sockets are never closed for it |
| address buckets (Bun) | 4096 | a new address gets `429` until an idle bucket expires |

| Code | Meaning |
|---|---|
| `1001` | to a data socket: its client left. To any socket: idle, or a data socket for a client that is gone |
| `1008` | to a control socket: a newer control socket for the same `server_id` replaced it. Also an unknown wire version, or a second data socket for one client |
| `1009` | a frame over 64 KiB |
| `1012` | to a client: its data socket (the PC's side) went away, or the relay lost the frames it held (a Durable Object evicted mid-wait, noticed when the data socket attaches or the client sends again; each such close is counted in the room's `heldFramesLost`); reconnect |
| `1013` | a limit above; try again later |
| `4401` | to a PC socket: proof missing, a key that does not derive the `server_id`, or a wrong or late answer |

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
large they are, and the connecting address (as the key of the per-address rate limiter only). It
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
(`[[migrations]]`) and the two rate limiters (`[[ratelimits]]`, whose `namespace_id` only has to
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
| `--max-addresses` | `RELAY_MAX_ADDRESSES` | 4096 |
| `--max-sockets-per-address` | `RELAY_MAX_SOCKETS_PER_ADDRESS` | 64 |

Flags override environment. Values must be positive safe integers; zero, infinity, fractions
and missing flag values fail startup. `startBunRelay({ limits: { maxSockets: 2048, ... } })`
accepts the same budgets as camel-case options (`perAddressPerMinute`, `globalPerMinute`,
`maxSockets`, `maxRooms`, `maxAddresses`, `maxSocketsPerAddress`). Programmatic options do not read environment.
`startBunRelay({ limiters })` can replace just the rate limiters; room/socket caps still hold.
Admission reserves both caps synchronously before upgrade, rolls back failed upgrades and
reclaims a room when its last pending/open socket leaves. `/health` remains available at capacity.
All per-room and per-frame limits apply on both adapters.

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
