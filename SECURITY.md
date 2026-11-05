# Security

Ovis gives a browser the terminals of the PC it runs on. Anyone who gets past its access
check can type into them, so a flaw in who gets in is as serious as it gets here.

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/devswha/ovis/security/advisories/new).
Do not open a public issue, pull request or discussion about it.

Include what you can of:

- the version (Settings, under Updates, opens with `Running vX.Y.Z (commit)`) and, for a remote PC, its OS;
- how the server was reached (localhost, SSH tunnel, `tailscale serve`, LAN, reverse proxy, the Ovis
  relay) and how the client signed in (this PC, Tailscale login, paired device, a device key through
  the relay, token, Portal's own sign-in);
- the steps to reproduce, and what an attacker needs beforehand;
- the impact, with evidence from your own setup. Leave out real tokens, pairing codes and cookies.

This is a project with one maintainer, so there is no guaranteed response time. Fixes ship as a new
patch release with a GitHub security advisory, crediting you unless you prefer otherwise. Please keep
the details private until that release is out.

## Supported versions

Only the latest `vX.Y.Z` release gets fixes. Installs update to it from **Settings → About** (or
by themselves with `OVIS_AUTO_UPDATE=1`). A fix in the remote-PC runtime ships as a new
`remote-vN` bundle together with the release that uses it. A fix in the relay service reaches
`relay.ovis.sh` with its next deploy from CI, and one in the hosted app reaches `app.ovis.sh` with
the next release.

## Scope

In scope, for example:

- getting in without a matching token, a paired device, the PC's own Tailscale login, a local
  connection or a visitor Portal's own sign-in vouches for with its proof (`server/access.ts`,
  `server/auth.ts`, `server/portal.ts`), including through a proxy or forged headers; and a visitor
  Portal let in using the app's own controls to leave access behind, such as pairing a device,
  subscribing to push alerts, controlling the relay or issuing a link. Relay mutations answer
  403 `read_only` for default watch visitors, then 403 `owner_only` for Portal visitors with
  a saved drive role: the watch guard precedes the owner guard
  ([`server/dispatch.ts:223-243`](server/dispatch.ts#L223-L243)).
  A watch-only Portal visitor that can type, send
  keys, resize, read files or perform a write action is also in scope;
- pairing codes, device cookies and revocation (`server/devices.ts`); a revoked or observe-only
  device that can still type, send keys or resize;
- reading files, transcripts or screens outside what the app shows a signed-in client;
- script injection in the web client (chat Markdown, file viewer, prompt cards, push payloads);
- the remote-PC path: SSH, the bridge bundle's checksums and the relay (`server/ssh.ts`,
  `server/remote-bundle.ts`, `server/machine-api.ts`, `server/machine-relay.ts`);
- updates installing anything other than a published release (`server/updater.ts`,
  `server/supervisor.ts`, `install.sh`);
- sign-ins the subscription usage strip reads (`server/usage.ts`) leaving the server's PC other than
  to their own provider;
- push keys and subscriptions (`server/push.ts`);
- the Ovis relay path: anything that lets the relay, whoever runs it or anyone else read, change,
  replay or inject traffic between a phone and the PC, or get in through the relay without a paired
  device's key, anyone taking a PC's place on the relay without that PC's secret key, and a revoke or relay identity reset that leaves a phone connected. That covers
  `shared/relay-server-proof.ts`, `shared/relay-e2ee.ts` and the paseo code it wraps (`shared/vendor/paseo-e2ee/`),
  `shared/relay-mux.ts`, `shared/relay-mux-engine.ts`, `server/relay/`, the relay parts of
  `server/devices.ts` and `server/access.ts`, and the relay service itself (`relay/`,
  `relay.ovis.sh`);
- the hosted app at `app.ovis.sh` (`src/lib/relay/`, `scripts/shell-build.ts`): script injection,
  anything that lets a file shown from one PC reach a device key or another PC's connection, and
  `app.ovis.sh` serving anything other than the app built from a release tag.

Out of scope, as documented in [Access and safety](docs/guide.md#access-and-safety):

- getting into a server that is still ungated by design: bound off loopback or behind a proxy, with
  no token set and no device ever paired, and not behind a proxy on a PC whose Tailscale login is
  known. It is open to anyone who reaches it, and the server warns about it on startup. Getting past
  the gate once a token is set or a device is paired is in scope;
- anything reached through `tailscale funnel`, which is unsupported;
- what the Ovis relay sees by design: which PC (`server_id`) a phone connects to, the PC's public
  key and admission challenge and answer, when, from which address, and the timing and size of
  every encrypted message, keystroke timing included
  ([the relay's trust model](docs/relay.md#trust-model)), and the relay or its host dropping,
  delaying or refusing connections;
- people you gave drive access to (a driving paired device, the token, your tailnet login, or an
  explicitly elevated Portal invitation) using it, including through a terminal: reading the
  server's environment or state files, or keeping a way in after their access ends;
- vulnerabilities in herdr, the agents, Tailscale or the browser themselves: report those upstream.

Test only on PCs and accounts you own.

## The Ovis relay

Every PC control and data socket proves possession of its static X25519 secret before admission.
Its `server_id` is the first 16 bytes of the domain-separated SHA-256 hash of its public key;
the proof is an HMAC-SHA256 over a fresh nonce and the socket's route, keyed by an ephemeral
X25519 exchange ([wire format](docs/relay.md#how-a-connection-is-made)). This admission proof is
separate from phone-to-PC Noise encryption and device authentication.

Missing, invalid, expired or timed-out PC proofs close `4401`; it is not always a permanent
identity failure. The PC retries transient refusals with backoff and stops only on a control
`4401` naming `server key does not match server_id` or `invalid server key`. An invalid first
challenge closes locally with retryable `4000`. A 17th pending proof displaces the oldest with
`1013`. Only clients the PC has answered occupy the eight client slots; at most four unanswered
clients wait, with oldest-first eviction and a 15-second answer deadline while the PC can answer.
While no PC is connected, an unanswered client waits at most 30 seconds from its arrival or the
PC leaving, even with keepalives and across relay evictions. A PC returning in time gives it
the full 15-second answer deadline again. These client limits close `1013`; lost buffered frames
after eviction close `1012`.

To report abuse that goes through `relay.ovis.sh`, such as traffic that isn't Ovis's or a flood of
connections for one PC, write to devswha@gmail.com with the `server_id` involved and when it
happened. The `server_id` is the 32 hex characters after `/s/` in an `app.ovis.sh` link, or after
`server_id=` in the relay's address. The relay keeps no logs, only per-PC usage counters (bytes, time
connected, sessions), and can't read the traffic, so that is all there is to go on. A flaw in the relay itself is a vulnerability: report it privately as above.
