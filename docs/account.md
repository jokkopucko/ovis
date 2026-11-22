# Linking devices with an account

Signing in to an account lets one approval add a device to every PC of that account, and one tap
remove a lost device from all of them. The account only finds PCs and carries messages: who gets
into a PC is still decided by that PC's own device list (`devices.json`), as with
[pairing through the relay](relay.md#who-gets-in). This page is the contract between the PC
(`server/account/`), the apps and the account service. The code is in
[`shared/account-records.ts`](../shared/account-records.ts); tests use the in-memory service in
[`shared/account-service-fake.ts`](../shared/account-service-fake.ts).

In the apps: the iPhone and Android apps open on the account's sign-in, and a first sign-in makes the
account ([Sign-in methods](#sign-in-methods)). A new device then joins the account's PCs with one
approval on a device already in it that drives the PC asked: the new device leads with **Get approved
on a device you already use**, the device in use asks **Add a new device?** and has its person pick the
number the new device shows, and the new device confirms **The numbers match**
([Who may admit a device](#who-may-admit-a-device)). The approver's signed `add` then reaches each PC
where it is a drive member ([rule 4](#rules)). The account's first device on a PC is approved on the PC
itself, or, on a PC in no account yet, scans the QR code it shows for the account and confirms
**Pair**, with nothing approved on the PC ([By QR code](#adding-a-pc)). A PC added over Tailscale or
SSH (Add a connection → Tailscale or Direct) is no account member ([rule 8](#rules)). The steps are
in [the guide](guide.md#through-an-account).

Nothing here changes how a device signs in: `AUTH` (`device-key`) and the mux frames stay as they
are ([Ovis Mux v1](relay.md#ovis-mux-v1)).

## Rules

1. **`devices.json` is the only authority.** The account service and the records it carries never
   admit a device by themselves. **Revoke** and **Revoke all** on the PC always work and always win.
2. **One account key per client.** A client (phone app, browser, the desktop app's view of other
   PCs) holds one ECDSA P-256 key for the account, made by WebCrypto as non-extractable and kept in
   its own IndexedDB database (`ovis-account`). On every PC of the account that key is the device's
   `relay_public_key`, and `AUTH` signs with it as with any device key.
3. **A PC holds no account key and signs nothing.** Only clients sign records. A coding agent that
   runs as the user on a PC therefore cannot add a device to the account's other PCs. The desktop
   app is both a PC and a client, so an agent on that machine could drive the app's key: that risk is
   known, and every admission is announced on every device so it shows.
4. **Records are signed one by one.** `add`, `remove` and `link` each carry their own signature;
   there is no chain, order or first record. A PC applies an `add` or `remove` only when its signer
   is a current account member with drive access in that PC's `devices.json`. A `link` needs no
   member: it comes over the linked row's own session, which is its authority.
5. **Removal is permanent until the PC says otherwise.** `remove` revokes the device and leaves a
   tombstone for its key. No account record clears a tombstone; only a pairing or revoke done on
   that PC does. A replayed `add` for a removed key is refused.
6. **A signer adds only keys it checked itself**, by comparing digits or from a QR code, never a key
   the account service handed it.
7. **The account service can hide records, never forge them.** It stores the PC directory
   (`server_id`, a name, the PC's relay public key and the relay it is reached through; no account
   or device keys), a mailbox of signed records per PC, and admission requests. First-link
   admission trusts it: while a code made to put a PC in an account lives, its word on a device's
   key lets that device in ([The account's word](#the-accounts-word)).
8. **Tailscale is not membership.** A PC found on your Tailscale is added over SSH (Add a connection →
   Tailscale, [remote-pcs.md](remote-pcs.md)), and one an older Ovis added through the relay with a code that
   PC handed over to your own Tailscale login is a paired device of that PC. Neither is an account member by itself: membership comes only from the
   rules here (a device linking its own pairing, or an approval by a member).

## Account members

A row of `devices.json` is an **account member** when it has `account` set. Rows come to be members
in three ways:

- `add`: a record signed by a member inserts the row, with `account`, `added_by` (the signer's
  device id on this PC) and the role in the record.
- `link`: a device already paired with this PC through the relay (by QR, code or comparing digits)
  proves its account key over its own session, and its row takes the account key and `account` in
  one write. This is how a PC gets its first member, so it needs no member before it.
- `enroll`: a member hands a PC it just brought into the account the account's removals and the
  `add` records for its other devices, in one batch ([Enrolling a PC](#enrolling-a-pc)). It is a
  batch of records, nothing more.

The row an `add` makes has a known id, so the new device can sign in without asking the PC first:
the first 16 hex digits of `SHA-256("ovis-account-device/1" || server_id || key)`, with `server_id`
as its 32 hex characters and `key` as the record's base64url text (`accountDeviceId` in
[`shared/account-records.ts`](../shared/account-records.ts)). `AUTH` is unchanged and signs with that
id. Rows made any other way keep random ids, and a device already on a PC keeps the id it has there
(an `add` for a key already present changes nothing): it knows that id from its pairing.

A PC belongs to at most one account: the account of its first member. A record for another account
is refused (`account_mismatch`). A PC in no account that its signed-in owner set up for one
([`relay-account`](#pc-api): `ovis add` names it before it shows its code, and so does adding the PC
from its own page) takes its first member from that account alone: a first link that names another
is refused the same way. **Revoke all** clears the PC's account with its members; tombstones
stay.

Relay rows paired before the account existed and never linked (a PC that was off when the phone
moved its pairings over) are listed under `unlinked` in [`/api/account/status`](#pc-api) and shown
as "not covered by account removal". The client links them on its next connection. A browser paired
with a code on the PC's own address holds a cookie, not a key: it cannot be linked, stays outside
the account, and only **Revoke** on the PC removes it.

### How a device joined

The PC records on a row how a `link` made it a member: `joined_by` in `devices.json`.

| value | when |
|---|---|
| `code` | the row paired with a code made for a PC in no account (the relay tab's QR code, or [a code made for an account](#a-code-made-for-an-account)) and linked into the account that code held it to, on a PC from before [the account's word](#the-accounts-word) was asked |
| `service` | the row linked while such a code lived, and the account service vouched for its key ([The account's word](#the-accounts-word)) |
| `word` | any other link that takes a row from no account into one, with no member behind it: a device that already drove this PC named the account itself (paired with a plain code, approved by its digits on this PC, or let in by a code a device outside the account started through the relay) |

The mark is set once, by the link that takes the row into its account, and a later link of the
row keeps it, whatever key or account it names. A restart keeps it. When two state folders are
merged, the account and key are chosen as before and the mark apart from them: `word` (or a
value the PC does not know) on either copy is kept, whichever account the row takes. Otherwise
the row takes the mark of the copy whose account it takes, or, where both copies are in the same
account, the other copy's when that one has none. A row that became a member before this has none, and neither has one
an account member's `add` or approval let in: neither is listed. An approval is a remote one, or
a code a member started through the relay while a member, and still a member when the code is
used (`member_approved_in` on the row names that account, with the member in `added_by`). It
counts only for a link into that same account: any other link is on the device's own word. A code
a device outside the account started names its starter in `added_by` and approves nothing, even
when the starter joins the account before the code is used. A value the PC
does not know is kept as it is and counts as `word`. Nothing changes who gets in: the mark only
shows the owner which members joined on their own word.

[`GET /api/account/status`](#pc-api) lists them under `own_word`, beside `unlinked`: a row is in
one of the two at most, so a device that links on its own word moves from `unlinked` to
`own_word` and stays there until it is removed. The PC's own `GET /api/health` tells its driving
owner both groups with their names (`account_devices`), and `ovis status` prints them when the
answer it gets without a token carries them: on a machine profile's owner socket, or over TCP when
the app lets the command in without one. It sends no token over TCP for them, and otherwise says
the groups are not shown, naming the token only when the app asks for it. Its first line counts relay devices only: a browser paired on the PC's
own address is outside the account too, and **Settings → Devices** lists it.

## Records

A record travels as JSON, with every field required and no other field allowed:

| field | `add` | `remove` | `link` | value |
|---|---|---|---|---|
| `v` | ✓ | ✓ | ✓ | `1` |
| `kind` | `add` | `remove` | `link` | |
| `account` | ✓ | ✓ | ✓ | the account's id: 1-64 of `A-Z a-z 0-9 _ -` |
| `key` | ✓ | ✓ | ✓ | the device's account key: P-256 SPKI, base64url without padding (91 bytes) |
| `label` | ✓ | | | the device's name, 1-48 characters, no control characters |
| `role` | ✓ | | | `drive` or `watch` |
| `server_id` | | | ✓ | the PC this link is for (32 lowercase hex) |
| `device_id` | | | ✓ | the row on that PC being linked (16 lowercase hex) |
| `old_key` | | | ✓ | that row's key before the link |
| `issued_at` | ✓ | ✓ | ✓ | when it was signed: ISO 8601 UTC with milliseconds (`toISOString()`) |
| `id` | ✓ | ✓ | ✓ | 16 random bytes, lowercase hex: the record's own id |
| `signer` | ✓ | ✓ | ✓ | the signer's account key, same encoding as `key` |
| `signature` | ✓ | ✓ | ✓ | ECDSA P-256 with SHA-256 over the signing bytes, IEEE P1363 (`r ‖ s`, 64 bytes), base64url |

A `link` is signed by the key it links to (`signer` equals `key`); an `add` is never signed by the
key it adds. A `remove` may be signed by the key it removes: that is how a device leaves the
account.

**Signing bytes.** The ASCII prefix `ovis-account/1`, then every field but `signature`, in the order
below, each as a 4-byte big-endian length followed by its UTF-8 bytes (`v` as the text `1`):

- `add`: `v kind account key label role issued_at id signer`
- `remove`: `v kind account key issued_at id signer`
- `link`: `v kind account key server_id device_id old_key issued_at id signer`

`AUTH` signs `ovis-relay-auth/1 ‖ nonce ‖ server_id` with the same kind of key. The two prefixes
differ at their sixth byte (`a` against `r`), so no record signature is a valid `AUTH` signature, and
no `AUTH` signature is a valid record. The digits' commitments and the server proof are hashes and
MACs, not signatures, so they cannot be confused with either.

**What a record cannot say.** An `add` names no PC: it is meant for every PC of the account, and a
PC that already has the key leaves its row as it is. A `link` names one PC and one row, so it is no
use on another. Nothing expires on `issued_at`; it only tells whether a `remove` was signed before this
PC itself paired the key again (`On the PC`), so a PC whose clock is minutes off can misjudge a
`remove` signed within those minutes.

## Who may admit a device

One rule for every way in: a pairing code, comparing digits, and joining through the account.

- **Approval on the PC itself:** a driving window opened directly on the PC (not a Portal visitor,
  not an open LAN window), or `bun scripts/plugin.ts pair --approve` in the PC's terminal, which
  shows the digits and asks for them: typing them (or their last three) approves, Enter by itself
  declines, and anything else is asked again.
- **Remote approval:** a client connected through the relay with drive access whose row is an
  account member. It must **pick the new device's digits out of three** (two decoys the PC chose at
  random) before it can approve. A tap without looking picks right one time in three, and a wrong
  pick ends the request, so the person has to look again at a new comparison.
- On a PC that belongs to an account, a pairing code can be started only by the same people:
  directly on the PC (any window there with drive access, as before), or by a drive account member
  through the relay (`403 account_required` for any other relay device, `read_only` for a watch
  device). A PC in no account keeps letting any driving relay device start one, as before.
- **A pairing code ends with the device that holds it.** A paired device holds a code it started
  (`POST /api/devices/pair/start`, through the relay or at the PC's own address) or was handed
  (`POST /api/relay/offer`, `POST /api/relay/code`). Revoking that device, on the PC or by an
  account `remove`, ends the code and the typed code bound to it: whoever the device passed the
  code to cannot pair after it is gone. A device revoked while its request for a code is on its
  way starts none and is handed none (`401 unauthorized`). A code the PC itself started is held
  by no device.
- **A code the PC's own terminal prints admits whoever scans it**, with no approval on the PC:
  `bun scripts/plugin.ts add` ends in one QR code, and a signed-in device that scans it links
  itself as the PC's first member, so the PC joins that device's account. The code is therefore
  made only by that command, shown only on a terminal and cleared from it (`--print` writes it
  as plain lines that stay, wherever the output goes), kept for 30 minutes at most, and the
  command says afterwards which account the PC joined and by which of that account's devices.
  Any other device the code let in is named and removed unless the person types keep, and when
  the PC ended in another account than the one the command signed in to, every device that came
  since the code was shown is removed ([A PC with no screen](relay.md#a-pc-with-no-screen)).
  `add --approve` keeps the approval in the terminal: no code, and the adding device's digits
  are compared there.
- **A pairing code admits whoever holds it**, with no approval on the PC: that is what a code is.
  On a PC that has no member yet, a signed-in device let in by a code links itself and so becomes
  the PC's first member: the PC joins that device's account
  ([Adding a PC](#adding-a-pc), "By QR code"). In Add a connection's relay tab, where the page has
  the Ovis account, that code is therefore shown only on its owner's press and as a QR code alone,
  and the page says afterwards which account the PC joined, whether it is the one that browser is
  signed in to, and which member of it added the PC; any other device that came meanwhile is named
  and asked about.
- **That QR code is for a PC in no account only.** On a PC that is in an account it would pair
  whoever scans it, from anywhere, with a PC that has members, with nobody approving: there a
  device joins by signing in to the account ([Joining through the account](#who-may-admit-a-device)).
  So the relay tab shows no QR code for such a PC, and the PC makes none: its offer is asked for
  with the header `x-ovis-no-account-only: 1` (`POST /api/relay/offer`), which a PC in an account
  answers `409 in_account`, starting no code and leaving the one pending as it was. On a PC in no
  account the offer carries a code of its own: the one pending when that was made the same way,
  else a fresh one, never a code another place started (which may be on a screen as digits). That
  code ends when the PC gets its first member, however it does (a `link` over any pairing, the
  one a sign-in on the PC opens included): left pending, it would admit one more device after the
  PC joined. It also ends, with every device that waits to link under it, when another account
  takes the place of the one named for the PC, and on **Reset relay identity**. An offer asked for without the header is what it was, on any PC: the first-run
  guide's QR code, the relay tab where the page has no account, a phone's **Use the relay** and
  `bun scripts/plugin.ts pair` keep it, without those guards, and a signed-in device that redeems
  such a code on a PC in no account links itself the same way. It never carries the code of an
  offer asked for with the header: with that code pending it starts a code of its own, which
  replaces it as every new code does.
- **And only for a PC that an account was named for.** The device that scans that QR code is taken
  into the account named for the PC ([`relay-account`](#pc-api): its signed-in owner added it on
  its own page, or ran `ovis add`), and into no other. So a PC with none named makes no such code:
  the offer with the header answers `409 no_account_named`, starting no code and leaving the one
  pending as it was. `GET /api/relay` says whether one is named (`account_named`), and the relay
  tab, where its button would be, says what names one ([Adding a PC](#adding-a-pc), "By QR code").
  The offer's answer names the account its code was made for (`account`), and a signed-in tab
  lists the PC in its own account beside the QR code only when that is the account.
  A device that waits to link on a PC with none named is refused `409 account_mismatch` and goes
  at once.
- **A device that pairs with that QR code's code waits to link.** The code of an offer asked for
  with `x-ovis-no-account-only` is redeemed through the relay only: sent to the PC's own address
  (`POST /api/devices/pair`) it pairs nobody, is answered `401 invalid_code` as a wrong code is,
  and spends none of its tries. Through the relay it makes no device. The device that pairs with it
  is in no list and on no disk, its sign-in answer names the `watch` role, and until it has linked
  itself into an account it makes two calls and no other: it reads its own account status
  (`GET /api/account/status`) and sends its link (`POST /api/account/link`). Everything else, a
  socket included, is answered `403 link_required` before any route runs, and it is told none of
  the PC's direct carriers. Its link makes it a device and the PC's first member in one write,
  which is when it is announced; the code then ends, as above, and any other device that still
  waited under it goes. A device that has not linked 30 seconds after it paired is gone: its
  sessions end (`auth_revoked`) and its key signs in no more. Nothing was written for it, so
  nothing is left of it. The code takes five such pairings, and a device that goes does not give
  its pairing back: with none left and no device waiting, the code has ended. Ending the code
  (**New code**, another tab, `POST /api/devices/pair/cancel`) takes the devices that wait under
  it, and removing a key on the PC (**Revoke**, **Revoke all**, an account's `remove`) takes the
  devices that wait with that key. A signed-in app joins as before: the account steps it takes
  after pairing are exactly those two calls.
- **A code can name the account it is for** ([A code made for an account](#a-code-made-for-an-account)):
  its devices wait to link in the same way, and only a link into that account makes one a device.
- **Every admission is announced** on every device connected to the PC: the new device's name and who
  approved it.

`GET /api/relay/pairings` lists the waiting requests: with their `digits` on the PC itself, and with
`choices` (three sets of digits, no `digits`) for an account member through the relay, which also
hears of every change as `remote-pairings` on its event stream; each entry also carries `key`, the
new device's P-256 key from its `PAIR_REQUEST`, bound by the commitment and the digits, and
`vouched: true` for another PC of the account ([Adding a PC of your account](#adding-a-pc-of-your-account)). That member
answers with `POST /api/relay/pairing` `{ "id", "decision", "digits" }`; `digits` is required to
approve, and a wrong pick answers 409 `wrong_digits` and ends the request. An approval answers
`{ "ok": true, "device_id" }`: the id the new device's row takes once its person confirms too,
`accountDeviceId(server_id, key)`, as every row a comparison makes.


**Joining through the account (design 5.3).** A comparison is otherwise taken only while the owner
has the pairing window open on the PC (a link without a code asked for in the last 10 minutes,
[relay.md](relay.md#who-gets-in)). A comparison with `pair-intent-account` is also taken without
it, only when all of these hold:

1. the PC belongs to an account;
2. that account's mailbox, pulled with the PC's server proof, holds an admission at most 10 minutes
   old naming exactly the key of this `PAIR_REQUEST`: the account service has seen this device
   signed in to the same account;
3. the PC has at least one drive account member to approve it.

Such a comparison is shown to the account's members through the relay (`remote-pairings`, digits
picked out of three, as always) and, so a one-PC owner is never stuck, to this PC's own window only
(`GET /api/relay/joins`, its screen, loopback and not forwarded): listed there without its digits and
without a pop-up, and approved only by the owner typing the six digits the new device shows
(`POST /api/relay/join`); one wrong entry ends that join. It is never approved by itself.
Anything else is refused before any prompt and not counted as a failed pairing. A PC takes at most 5
such joins a minute; refused requests do not count toward them. A request whose admission the PC has
not seen yet makes it pull its mailbox, at most once every 10 seconds, so a device that asks right
after posting its admission may be refused and asks again. The admissions the PC knows are kept per
account and relay identity, so they never carry over to another account or a new identity.

At most three requests wait for approval at once on a PC. A wrong pick ends that request and counts
as a failed pairing.

**Failed pairings are counted on three paths.** Pairing codes, and comparisons that ask to pair this
PC only, share the 20 failures in 10 minutes described under [Who gets in](relay.md#who-gets-in).
Comparisons that ask to join the account have their own 20, and so do other PCs of the account
vouched for ([Adding a PC of your account](#adding-a-pc-of-your-account)), so a flood of either
cannot pause pairing by QR code or code, or the other.

## A code made for an account

The call that makes a pairing code can name the account the PC is to join: `POST /api/relay/offer`
and `POST /api/relay/code` take the header

```
x-ovis-expect-account: <account id>      (1 to 64 of A-Z a-z 0-9 _ -)
```

from the callers they take today (drive access, on a direct connection). The code is the relay
tab's kind ([Who may admit a device](#who-may-admit-a-device)): made only while the PC is in no
account, redeemed through the relay only, five pairings, and a device that pairs with it waits to
link, makes its two calls and is gone after 30 seconds if it has not linked. One thing differs:
such a device is taken into the account the header named and into no other, whatever account was
named for the PC (`relay-account`). A link that names another account is refused 409
`account_mismatch`; the device goes at once. The code stays for the device of the right account
only while it can still pair one: with its five pairings spent, or its ten minutes over, it ends
as the last device that waits under it goes. A link into that account makes the device a member,
and the PC joins the account. "That account" is the account id in the device's link, which the
device signs with its own key: the PC checks the signature and that the id is the one the code
was made for.

The answers carry today's fields and two more:

```json
POST /api/relay/code  -> { "code": "ABCDE-FGHJK", "expires_at": "…", "server_id": "…", "expect_account": "acct_1", "pairing": { "id": "<32 hex>" } }
POST /api/relay/offer -> { "url": "https://app.ovis.sh/s/<server_id>/#offer=…", "expires_at": "…", "expect_account": "acct_1", "pairing": { "id": "<32 hex>" } }
```

`expect_account` repeats the account the call named; a PC from before this answers with neither
field, and a call without the header gets today's code. `pairing.id` names the code in every
answer of both calls, with the header or without. `POST /api/relay/code`
with the header makes a new code, as it does without. `POST /api/relay/offer` with the header
carries the code pending when that was made for the same account (the typed code's, say), with
the same `pairing.id`; otherwise it starts a code of its own. An offer without the header, the
relay tab's offer included, never carries such a code: it starts its own, which replaces it.

An offer other than the relay tab's can also say which code it is to carry, with the header

```
x-ovis-pairing: <pairing.id> | new
```

With an id it carries that code while it is the one pending and the offer can carry it;
otherwise it is refused 409 `pairing_gone`, starts no code and leaves the one pending as it was.
With `new` it always starts a fresh code. So a command that made a code to type shows that same
code as its QR code or none, and never shows or replaces a code that another command or a screen
made. Any other value is refused 400 `invalid_pairing`.

`POST /api/devices/pair/cancel` takes `{ "id": "<pairing.id>" }` beside `{ "code" }`: it ends the
code pending only when that is the code named (by both, when both are given), and answers
`cancelled: false` otherwise. A caller that names its own pairing ends that pairing and no other.

The refusals, in this order: 409 `relay_off` and `relay_offline` as ever; 400 `invalid_account`
when the header names no account id; 409 `in_account` when the PC is in an account; then 409
`code_unavailable` for a typed code on a relay that takes none, and 409 `pairing_gone` for an
offer whose `x-ovis-pairing` id is no longer the code pending. A device whose call waited (on
the relay, for a typed code) and that was removed meanwhile is refused 401 `unauthorized`, and one
made a device that only watches is refused 403 `read_only`. A refused call starts no code and
leaves the one pending as it was.

`POST /api/relay/offer/keep` `{ "id": "<pairing.id>" }` (the same callers and guard) answers the
status of the code with that id, whatever the relay's state. A body without an `id` answers 400
`invalid_body`; a device removed, or made one that only watches, while its request was on its way
is refused 401 `unauthorized` or 403 `read_only`, and the guard's own refusals stand. A valid
request answers 200:

```json
{ "state": "live", "id": "…", "expect_account": "acct_1", "expires_at": "…",
  "waiting": [{ "id": "…", "label": "…", "link": "asked" }],
  "turned_away": [{ "n": 1, "id": "…", "label": "…", "why": "account_mismatch", "link": "sent", "account": "acct_9" }],
  "service_retry_ms": 0 }
{ "state": "ended", "id": "…", "expect_account": "acct_1", "ended": { "why": "joined", "at": "…" }, "joined": { "device_id": "…", "label": "…" }, "turned_away": [] }
{ "state": "unknown" }
```

`live`: it is the code pending. Once its ten minutes are over it pairs no new device (they are
also counted on a clock that only moves forward, and once either clock says they are over they
stay over, so changing the PC's clock gives the code no time back), but a device
that paired with it in time still has its own 30 seconds to link, and the code reads `live` until
that device has linked or its time is over. `unknown`: this PC knows no such code; it keeps the
eight that ended last, in memory. `waiting` lists the devices that paired with it and have not
linked yet, with what their last link did: `not_sent`, `sent` (answered at once), `asked` (it waits
for the account service) or `service_unreachable` (the service did not answer for it).
`turned_away` is the code's whole history, oldest first: every device of it that went without
becoming a member, numbered from 1, with `why` (`account_mismatch` with the `account` its link
named, `unverified`, `link_timeout`, `link_refused` after five links, `code_ended`, `removed`) and
the `link` it had last. `service_retry_ms` says how long until this PC may ask the account service
again, 0 when it may now. `ended.why` is one of:

| `why` | when |
|---|---|
| `joined` | the PC joined an account; `joined` names the device when it was one of this code's |
| `overused` | its five pairings are spent and no device waits under it |
| `expired` | its ten minutes are over, and no device that paired with it in time waits to link |
| `replaced` | another code was made |
| `cancelled` | it was taken back (`POST /api/devices/pair/cancel`), or ended otherwise |
| `revoked` | a device that held it was revoked, or every device was (**Revoke all**) |
| `guessed` | five wrong codes |

A `label` is the device's own word, and no proof of whose device it is.

### The account's word

While a code made to put this PC in an account lives (the relay tab's QR code, or a code made for
an account), a link into an account passes only when that account vouched for the device: the
account service holds an admission at most 10 minutes old, by its own clock, for the link's `key`
at this PC, posted by a sign-in of the account the code is for (`POST /v1/admissions`). It is asked
about the key the device holds once linked, not the one it paired with. This holds for every link
made while such a code lives (past its ten minutes too, while a device that paired with it in time
still waits to link), from a device that already drove this PC too, and such a link is held
to that code's account as well (409 `account_mismatch` otherwise). A device that paired with such a code is held to
it until it links or goes, also once the code's ten minutes are over: its link is judged against the
account service and held to the account the code was made for.

- **The mark.** The offer of such a code carries `"admission": 1`, in the QR link and in the offer
  a typed code delivers; no other offer does. An app that knows it posts the device's admission
  first and pairs only once the post was answered. An app from before posts nothing: its link is
  refused as below, and it joins after it loads the app again and scans once more.
- **How the PC asks.** With its relay key, as for its mailbox: `POST /v1/pc/challenge`, then
  `POST /v1/pc/mailbox` naming that account with `ack: null`. It needs no member for it, and it
  reads, applies and acknowledges no record. Both calls have 5 seconds together. One read at a time,
  at least 10 seconds apart, and a link is judged by a read that started after it arrived. So a
  link waits 15 seconds at most, and a flood of links does not make the PC call the service more.
- **Which admissions count.** The ordinary ones (`admissions`) count for every such link. The
  quiet ones (`quiet_admissions`, which only an app's own sign-in can post) count only for the PC's first member, linked by a
  device that paired with that code. A device that already drove the PC, and a device that joins
  by comparing digits ([Joining through the account](#who-may-admit-a-device)), count the ordinary
  ones only.
- **Not vouched for:** 403 `unverified_device`. A device that waits to link goes at once, and its
  pairing stays spent; a device that already drove the PC keeps what it had. The code is not
  ended, so the account's own device still pairs with it.
- **No answer, or 429:** 503 `account_unavailable` with `retry-after` in seconds: when this PC may
  ask again. The device and the code stay, and the device sends the same link again after that
  time. A 429 that names a wait holds every read back that long, a minute at most; a link that no
  read can judge within its 15 seconds is answered at once, without a call. A 429 with no wait
  counts as the usual 10 seconds.
- **A code that ended or changed meanwhile:** a device that already drove the PC gets 409
  `pairing_ended` when the code alive as its link arrived is not the one alive when it is
  judged; nothing changes for it.
- **No account service.** A PC whose account service is turned off (`OVIS_ACCOUNT_SERVICE_URL=off`)
  makes no such code: the offer and the typed code with `x-ovis-expect-account`, and the relay
  tab's offer, answer 409 `account_service_off` and start nothing.

The row such a link writes is marked `service` ([How a device joined](#how-a-device-joined)).
While the account service is away no device joins this way; `ovis add --approve` still adds one.

## Negotiation

A client offers features in `HELLO`; a PC that supports them selects them in `WELCOME`, as with
`pair-sas`. An older PC selects none and the client says to update Ovis on that PC.

| feature | meaning |
|---|---|
| `account` | the PC has `/api/account/*` and applies records |
| `pair-intent-pc` | this comparison pairs this PC only |
| `pair-intent-account` | this comparison adds the device to the account |
| `pair-intent-pc-vouched` | another PC of the account pairs with this PC only, vouched for by an admission ([Adding a PC of your account](#adding-a-pc-of-your-account)) |

A client offering `pair-sas` offers at most one intent; a PC selects an intent only together with
`pair-sas`, and only the one offered. A `HELLO` with more than one intent ends with `protocol_error`. A
comparison without a selected intent is `pair-intent-pc`.

The approval prompt says what is being approved: **pair this PC**, or **add to the account**; a
remote approver's card (**Add a new device?**, **Check the number, then approve**) adds how many PCs
that means from its own list of the account's PCs. The
intent travels inside the encrypted channel that the digits authenticate: a relay that changes it
must sit in the middle, and then the digits differ.

Either intent admits the device on this PC as a plain row. With `pair-intent-account` the new
device then links that row to the account itself (a `link` whose `old_key` is its `key`), and
the approver signs the `add` for it and delivers it to the account's other PCs. The intent decides
only what the prompt says and which failure count a comparison spends.

## PC API

All under `/api/account/`, JSON, `cache-control: no-store`. Every route needs drive access; through
the relay too. Mutations need the app's mutation guard, like the other routes. A device that waits
to link ([Who may admit a device](#who-may-admit-a-device)) reaches its own status and its link,
and nothing else.

`GET /api/account/status`

```json
{ "account": "acct_1" , "members": 3, "unlinked": ["6a1f0c9e2b7d4a10"], "own_word": ["0d4c1b7a9e2f3c58"], "removals": [<remove>, …], "adds": [<add>, …], "blocked": ["<key>", …], "enrolling": false, "mailbox": { "last_pull_at": "2026-11-05T01:02:03.000Z", "error": null } }
```

`account` is `null` before the first member. `unlinked` lists relay rows that are not members.
`own_word` lists the members that joined on their own word ([How a device joined](#how-a-device-joined)).
`removals` lists the signed `remove`s behind this PC's tombstones for its account, as received (a
Revoke on the PC has none). `adds` lists the signed `add`s behind its rows, as received: the one
that made a row, or the approver's own for a row its remote approval made. `blocked` lists every key
an add cannot bring in here: every tombstone (signed or not), every key a waiting remove names, and
every key an enrollment held ([Enrolling a PC](#enrolling-a-pc)). `enrolling` is true while the PC
waits for its first member's enrollment. `blocked_all` is true when the PC holds every add back
(removal evidence was lost to a full queue, or its waiting records cannot be read): then `blocked`
may not name every key it keeps out, and a client enrolling another PC sends that PC no add and
`held_full`. A client trusts none of them before it checks it (below).
With `?fresh=1` the PC first pulls its mailbox (a pull that starts after the request), so a remove
waiting there is counted, and adds `fresh`: true only when that pull read the whole mailbox
without an error, for the PC's current account and relay identity. A PC whose account service is
turned off (`off`) has no mailbox and answers `fresh: true`; one whose address is unusable does not.
A device that waits to link reads one body, whatever the PC holds: `account` `null`, `members` 0,
`unlinked` its own id alone, every other list empty, `enrolling` and `blocked_all` false. No
mailbox is read for it, and `fresh` is ignored.

`POST /api/account/relay-account` `{ "account" }`: the account this PC asks its relay pass under while it
has no members ([relay.md](relay.md#relay-pass)): over a direct connection with drive access (the PC's own
screen, after it listed the PC), or through the relay only from a drive account member of that same
account (`account_required` otherwise). Kept in `relay/account.json`; a
name that is not an account id answers 400 `invalid_account`. Answers 204. Naming an account grants
nothing: the service gives a pass only when that account lists the PC.
While the PC has no member, it is also the account its first member comes from: a `link` that
names another account is refused 409 `account_mismatch`, whichever code its device paired with,
and the answer says to run `ovis add` on the PC again, which names the account its owner is
signed in to now. A device that waited to link goes with that refusal; a device that was paired
keeps what it had; the code is not ended, so the device of the named account still pairs with it.
Naming another account in place of the one named ends the relay tab's code and every device that
waits under it, so a waiting device scans the code shown after it. That code is also held to the
account named when it was made: a device that waits under it is taken into that account only, and
only while that account is the one named (a name that cannot be read is none).
A device that waits to link is taken into no other account, so with none named it is refused the
same way, and the relay tab's QR code is made only once one is named
([Who may admit a device](#who-may-admit-a-device)).
No answer through the relay names that account. Once a PC has a member, its members' account
decides, whatever was named.

`POST /api/account/link` `{ "record": <link> }`: the request's own device must be the record's
`device_id`, with `old_key` its current key, `server_id` this PC's. The row's key becomes `key` and it
becomes a member, in one write. `old_key` equal to `key` makes a row whose key already is the account
key a member. Answers `{ "device": <paired device> }`. The row's other sessions end (`auth_changed`):
they signed in with a key it no longer has. The linking session goes on, with no member's rights,
until it signs in again with the new key. A device that waits to link becomes a device by its
link: its row is written then, as a drive member. A key this PC removed itself (**Revoke**,
**Revoke all**) before the device paired comes back with it when it is the key the device paired
with. A key an account removed stays out: that link is refused `tombstoned`, as is a link that
would move the device to a removed key, nothing is written and the removal stands. A key removed
while the device waits takes the device with it. Such a device sends five links; the next is
answered `403 link_required`, and it is gone. A link it sent while it waited that is judged after
another of its links made it a member is answered `403 link_required` and changes nothing.

`POST /api/account/records` `{ "records": [<record>, …] }`: at most 32. Applies each in order and
answers every outcome, never failing the whole batch for one record:

```json
{ "results": [{ "id": "…", "outcome": "applied" }, { "id": "…", "outcome": "refused", "code": "tombstoned" }] }
```

Outcomes: `applied`, `unchanged` (an `add` for a key already present; a `remove` for a key already
removed and absent, or signed before this PC paired the key again when no other row holds the key)
and `refused` with a code. A
`remove` for a key this PC never had still leaves its tombstone, so the key cannot be added later.
A `remove` refused `signer_not_member` waits on the PC with the mailbox's own such records
(`account-pending.json`) and applies once its signer becomes a member there; when that queue cannot
take it, its outcome is `account_unavailable` instead, and the client sends it again. An `add` is
refused `enrolling` while the PC waits for its first member's enrollment, and `removal_pending`
while its key is held ([Enrolling a PC](#enrolling-a-pc)).

`POST /api/account/enroll` `{ "account": "acct_1", "records": [<remove or add>, …], "held": ["<key>", …], "held_full": false, "last": true }`:
what a member sends a PC it brought into the account, over the relay session of a device that is
already a member of `account` (it links itself first). At most 512 records and 4096 held keys;
`held_full` says there were more (every add is then refused from then on, until
`account-held.json` is removed; any member may send it); `last: false` says more
parts follow, or an earlier part had a remove the PC could not decide (the client then sends the
whole enrollment again on its next connection). Within one request, an add for the key of a remove
the PC could not keep is held back too. Same answer as `records`, in the order sent; the PC applies them in its own order
(below).

### Enrolling a PC

A link sent while the PC has no account starts its **enrollment barrier**
(`account-enrolling.json`, written before the link, naming the linking device): until that device's
last `enroll` part answers every remove (none `account_unavailable`), no `add` applies here from
`records` or the mailbox. One from the mailbox waits in `account-pending.json` and is tried again
after the enrollment. An `enroll` from any other member applies its removes, but its adds wait
like any other (`enrolling`), and it ends no wait, unless the device the barrier names is no longer
a drive member here (revoked, say): then any member's last part ends it. A
refused link leaves the barrier (with no account here no add applies anyway); the next first link
takes it over. The first link that succeeds keeps it, unless the PC has no account again (its
first member was revoked before enrolling it): then the next first link takes it over. There is no timeout: a client that never enrolls leaves the account's adds waiting,
and its devices join this PC by comparing digits instead.

The link of a device that waits to link ([Who may admit a device](#who-may-admit-a-device)) writes
its barrier later: once the link has passed every check, in the step that writes the row which
makes it a device, and before that row. A link of such a device that is refused, or that outlives
the device's 30 seconds, writes none.

An enrollment applies, whatever the order sent:

1. `held`: kept for good in `account-held.json` (at most 4096; past that every add is refused).
   These are keys the member found removed, or suspected, on the account's other PCs.
2. every `remove`, in the order signed; one whose signer is not a member here waits, as above;
3. the `add`s in rounds: an add whose signer another add of the batch lets in applies in the next
   round. After each round the PC tries its waiting records again, so a remove whose signer just
   became a member applies before the next round's adds;
4. then the barrier lifts, and the adds that waited for it are tried in turn.

A held key is also refused to a member's remote approval (the session ends `auth_failed`) and to a
`link` moving a row onto it (`removal_pending`); only a pairing approved on this PC lets it in.
At every step an `add` is refused `removal_pending` when its key or its signer is held: a waiting remove names it
(whatever that remove's signer, including one earlier in the same batch), an enrollment held it,
the waiting queue cannot be read, or waiting removes were ever pushed out of a full queue. A key already on a row is not affected (its
add is `unchanged`), so a pairing done on this PC settles it.

What a client keeps: on each connection to a PC of its account it reads that PC's `removals` and
keeps, verbatim, each one that verifies, is for its account and is signed by its own key or by a
device it approved itself (an `add` it signed), at most 256. A PC cannot make it keep a removal
signed by a key the PC made up, and it signs nothing for any of them.

What a client enrolls (`enrollPc` in [`src/lib/account/join.ts`](../src/lib/account/join.ts)): when
its link brings a PC that had no account into it, it first reads every other PC of the account it
is linked on (`?fresh=1`, at most 8 seconds each): their `blocked`, `removals` and `adds`. If
none of them answers it sends nothing and tries again on its next connection. When it reads no other
PC at all while the account's directory lists others, it sends no add either. A new PC from
before enrollments (its status has no `enrolling`) gets the removes through `records` and no add. A PC whose answer
is not `fresh` (its mailbox read failed, or it is from before enrollments) counts for its removals
only: while any such PC answers, the client sends the removals but no add. A PC whose read failed
also keeps the new PC's wait until a later connection finds it read whole; one from before
enrollments ends it (a passing failure leaves no lasting hold; only a PC that says `blocked_all`
makes the client send `held_full`): the account's devices
then ask that PC once each, as before. A new PC from before enrollments, which refuses removes in
`enroll`, gets them through `records` and no add. Then, over a
session signed in with the account key, one `enroll`, as signed:

- the `remove`s it signed itself and the ones it kept;
- the `add`s it signed itself and the ones those PCs list, except any for a key one of them keeps
  out or that any verified removal it saw names, whoever signed it. Such a device asks once by
  comparing digits instead. The new PC applies an add only when its signer is a member there, so a
  PC that lists adds signed by a key it made up lets nobody in;
- those keys as `held`, so no add that reaches the PC later lets them in either.

It signs nothing for any of it. It reads every record's outcome and sends again, on its next
connection to that PC, each one the PC did not answer or could not decide on, and any removal it
signed while the enrollment ran. Then each PC that answered introduces the new PC to every device
the enrollment let in ([Introductions](#introductions)), so those devices sign in there without
asking.

A removal that only PCs the client could not reach hold, and that the account service hides from
the new PC's mailbox, is missed: the removed device then comes back on the new PC, announced there
as any admission is. A client reading its other PCs first makes that need every PC holding the
removal to be off or unreachable.

### Adding a PC

How a person adds a PC to the account in the apps (WhatsApp's linked devices and Tailscale's
Tailnet Lock follow the same idea: an existing device approves once, and the server only carries
messages):

**By QR code.** On the new PC, Settings → Devices and PCs → Add a connection → Ovis relay →
**Phone QR code**, with the relay on and an account named for the PC: signing in on the PC's
own page and adding it there names one, and so does `ovis add`. A device that is signed in to that
account scans it: it is paired with its account key, links itself as the PC's first member, lists
the PC in the account's directory and enrolls it ([Enrolling a PC](#enrolling-a-pc)). Nothing is
typed and nothing is approved on the PC. Because the code admits whoever holds it
([Who may admit a device](#who-may-admit-a-device)), the page guards it:

- The QR code is for a PC in no account. On a PC that is in one the tab has no button and no QR
  code, and asks the PC for no code: it says which account the PC is in (the one this browser is
  signed in to, another one, or one it cannot tell while signed out) and that a device is added
  by signing in to that account on it and opening the PC there. A device the PC does not know yet
  is approved once, by a drive member of the PC picking its digits ([Introductions](#introductions)).
  The page reads the PC's account as the tab opens and again at the press, and
  the PC itself refuses the code (`409 in_account`), so a page that read it a moment too early
  shows no QR code either: the refusal makes it look at the PC at once, and the notice below
  takes the QR code's place.
- It is for a PC that an account was named for. On a PC with none named the tab has no button and
  no QR code either, and asks the PC for no code: where the button would be it says **Sign in
  above first; then this PC can show its QR code.** to a browser that is signed out, and **Add
  this PC to your account first; then it can show its QR code.** to one that is signed in. The PC
  says whether an account is named in its relay state (`account_named` of `GET /api/relay`, which
  the page reads again every 15 seconds while the relay is online), and it refuses the code
  itself (`409 no_account_named`). A press made on a relay state that said one was named when
  none is meets that refusal: the QR code comes down with no failure to read, and the page reads the relay
  state again at once, which brings the sentence.
- Nothing is asked of the PC before the press. The QR code comes down, and its six-digit code is
  ended on the PC (`POST /api/devices/pair/cancel` with that code), when the dialog closes or
  another tab opens, when the page goes (a reload, a closed tab or window: the request is sent to
  outlive the page), once the page was hidden for a minute, and 30 minutes after the press, by the
  clock, so a PC that slept does not keep it longer. **Show a new code** starts again. A browser
  that is killed, or loses the PC, sends nothing: the code then runs out by itself within its 10
  minutes. Two windows of one browser showing the QR code share its code: the one that ends it
  tells the other (a `BroadcastChannel`), which asks for a new one. A **New code** that cannot end
  the old code says that it may still work until it runs out.
- After **Keep it** the page watches the PC for 10 minutes more, to tell a later join; a device
  that pairs at the PC's own address meanwhile came by another code and is not asked about.
- The QR code is shown alone. No code to type is made for it (`POST /api/relay/code` is not sent):
  a typed code would have the same power, putting the PC in the account of whoever types it at
  app.ovis.sh, and is far easier to read off a screen, a recording or a clipboard than a QR code
  is to scan. Its six-digit code is its own, never one Phones and devices showed as digits, and
  **New code** ends it and asks for the offer again (no `POST /api/devices/pair/start`). A device
  without a camera pairs from Phones and devices → Without signing in, or the PC is added by signing in on it (below).
- While the QR code is up, and while a notice is, the page reads `GET /api/account/status` and the
  device list every 3 seconds. When the PC goes from no account to one, by a scan or any other
  way (the PC then also takes the code back), the QR code gives way to which account, by its
  id's first 12 characters, in one of three forms: **This PC is in your account** when it is the
  account this browser is signed in to, with **Done** first; **This PC joined another Ovis
  account (…), not the one this browser is signed in to (…)** when it is not; and, on a page that
  is not signed in, **This PC joined an Ovis account**, with a line that this browser cannot tell
  whether that account is yours until it signs in above, and a question the owner can answer
  without an account id: whether their own device just said that it added this PC. In the last
  two **Not me: revoke every device** comes first and the other button is **Keep it**: whoever
  scanned may be a stranger, and the name shown is the scanner's own. Revoking is, after a
  confirmation, `POST /api/devices/revoke-all`, which leaves the PC with no member and so in no
  account. Once the notice is answered the tab is the one of a PC in an account (first point).
- **Added by (the device)** names a member of that account only (`account` on its row, which the
  account's key signed): the newest member that came since the press, or without one the
  account's newest member on the PC (a device paired before that linked itself meanwhile). A
  device that only holds the code is never named as the one that added the PC; when no row is a
  member, nobody is named. The same rule as `ovis add` in a terminal.
- Every device that came since the press and is not a member of the PC's account is one nobody
  vouched for, through the relay or at the PC's own address. It is named and asked about, whether
  or not the PC joined an account: **Not me: remove it** first (`DELETE /api/devices/:id`), or
  **Keep it**. The page cannot know which code let a device in (one paired from Phones and
  devices meanwhile is asked about the same way), so the question says only that it paired while
  the QR code was up. One that came through the relay is asked about after 10 seconds, the time a
  signed-in device takes to link itself, counted from when the page first saw it and kept with
  the press, so a notice drawn again later does not start it over; until then the notice says it
  is being checked. With the PC still in no account the question says that the device is not
  signed in, and that keeping it and signing in on it adds the PC. One that paired at the PC's
  own address is asked about at once.
- A notice goes only by one of its buttons, and only once nobody is left unanswered: **Done** (and
  **Keep it** on an account) is not offered while a device is asked about or still in its 10
  seconds, and when pressed it reads the PC once more, after the code's end was answered, and
  stays for a device that came since the last read. **Not me: remove it** reads the PC the same
  way before its notice goes. A notice the dialog was closed over waits: Add a connection opens
  on its relay tab with it the next time Devices and PCs is opened, where the page has the
  account, and reads the PC again from the same press, so what changed meanwhile (the device
  signed in and put the PC in its account) is told then.
- A device that took the code just before it was ended links only seconds later. So the page goes
  on reading the PC after the QR code came down, also with the dialog or Settings closed
  (`src/lib/accountQrWatch.ts`): until the first read after the PC confirmed the code's end shows
  no new device, and for the code's 10 minutes when it did not confirm. What it finds is told the
  same way: Add a connection opens again on its relay tab when Devices and PCs is open, or the
  next time it is. After **Keep it** on a PC still in no account the page watches 10 minutes more
  for that device putting the PC in an account. A page that was reloaded or closed watches
  nothing and keeps no notice: the device list on Devices and PCs is then where a device is
  revoked.

Where Ovis's relay asks for a relay pass, a PC in no account is not online and shows no QR code
until someone signs in on it; the steps below are then the way.

**By signing in on the PC:**

1. On the new PC, Settings → Devices and PCs → Add a connection → Ovis relay: sign in, then press
   **Add this PC to my account** (a page without that tab keeps **Sign in and add this PC** in its
   Account card, which does both in one press). A PC in no account is then added: the
   PC lists itself in the account's directory (`PUT /v1/pcs`, its relay key and relay) and opens a
   pairing window with `POST /api/relay/link` and the header `x-ovis-local-only: 1`. The PC is
   added only by a press of a button that says so. The link page's one button reads
   **Sign in and add this PC** only where the sign-in does add it (a PC in no account, its relay
   on, a browser that drives it), else **Sign in**; its words follow the relay (read again every
   few seconds while the page shows), and what the button said at the press decides: a
   press of **Sign in** adds nothing, also when the relay was turned on since. A provider's own
   button (**Continue with GitHub**, on a service without the link page) and the desktop app's
   sign-in say nothing of adding, so they add nothing either. Such a sign-in gets the offer,
   **Add this PC to my account**, which lists and opens the window on a press. Only the sign-in
   that just finished on that screen adds the PC, once, within a minute of it, and only under its
   own account: the listing writes nothing when another sign-in, or none, is stored by the time it
   reads the stored one (another tab signed out and in), and the screen then shows the button. A
   listing that gets no answer within a minute is given up the same way, and so is one whose
   screen is closed meanwhile: nothing more is written for it, the PC is not told the account, and
   the window it opened is closed by its ID (`POST /api/relay/link/close`) unless a wait is kept or the
   person pressed the button since. Automatic cleanup never closes a newer window; on an older PC
   that does not return a window ID, it lets the window expire. An entry already sent to the directory
   when the screen gave up cannot be taken back: the screen then says the PC may not have been listed, and the button
   lists it again. A sign-in that was already there when the screen opened lists nothing by itself
   and gets the offer; so does a sign-in again for the same account, one that ended before the PC
   answered, and one whose PC answered only after the minute. The sign-in never turns the relay
   on: with the relay off it lists nothing and offers **Add this PC to my account**, which then turns
   the relay on too, one press for both, which lists under that sign-in only. A device that only watches this PC
   (`role: watch`) can list nothing: its sign-in adds nothing and it is shown no button; while
   what this browser may do cannot be read, nothing is listed without a press. A browser the PC
   refuses its account (`owner_only`: in only through an open device gate, or a Portal visitor) is
   offered none of this.
   What the window takes is decided on
   this PC only: it is never listed to account members (`remote-pairings`) or approved by one, even
   once the PC has members. The screen keeps the window open while it waits: it asks for the link again
   every 30 seconds while its page shows (that call writes nothing to the directory) and lists the PC anew
   every nine minutes, for 30 minutes a press or sign-in, then offers **Keep waiting**; **Stop waiting**
   ends it sooner and closes the window on the PC at once (`POST /api/relay/link/close`; an Ovis from
   before that route lets it run out), and once more when a reopen or listing that was on its way
   opens it again after that, provided the reopened window is still current. A relist that finds
   the PC already added also closes only the window it opened, even if the tab could not store a resume marker.
   A wait that ran out by itself does not close the window
   already open: it closes by itself, up to ten minutes later. A reloaded tab
   goes on waiting only for the same PC under the same sign-in. Once a device added the PC the screen says
   so, and that the account's other devices can open it only when the PC's status no longer says `enrolling`.
   The window is kept
   across a restart of the PC's server (an update) for the rest of its ten minutes, local-only as it
   was opened, and is closed by `POST /api/relay/link/close`, **Revoke all**,
   **Reset relay identity** or turning the relay off.
   A close declines the comparisons the PC was showing and one whose digits arrive after it, and is
   written to disk (as is a window that ran out). A close does not reach an Add-this-PC screen that
   is still waiting on the PC: that screen asks for its window again at its next reopen, which is an
   act of the PC's own page, so **Stop waiting** on it (or leaving that screen) is what ends the wait.
   A comparison approved before a close makes no device when the other side confirms after it.
   The PC has one pairing window: **Stop waiting**, and the close of a window a given-up listing
   opened, also end a code-less phone link opened meanwhile from **Add a connection**, and turn
   down a phone that was comparing digits through it: that link is asked for again before a phone
   can use it.
2. On any device already in the account, the dashboard lists the PC as new in the account, with
   **Add** on its row, for 10 minutes after the directory took it. **Add** opens the Add-a-PC sheet.
   The PC's key comes from the directory and is checked against its id, as for any PC there; the
   person then **types the six digits the new PC shows** (not a tap: the directory's name is
   anyone's), and approves on the PC. The PC's prompt says so (**… wants to add this PC to your
   account. Type 123 456 on …, or check that … shows the same number, then press Approve here**)
   instead of only asking to compare digits, since that device shows none: the request carries
   `local_only: true` in `relay-pairings`. The mark follows the PC's add-me window, not the asking
   device, so a phone that opens an ordinary link meanwhile gets the same words and compares.
3. The device is then the PC's first member: it links, and enrolls the PC
   ([Enrolling a PC](#enrolling-a-pc)), so the account's other devices are let in and introduced.

**In one press.** Step 2 is on by default on the PC ([how to turn it off](#turning-step-2-off)).
The account service's Step 2 switch must also be on. **Add this PC to my account** then adds the PC
with no other device and no digits, when the account service admits it: the browser on the PC's own page lists the PC
(`PUT /v1/pcs`, as above), then asks `POST /v1/pcs/{server_id}/admit`. The service admits only a
sign-in made in an app itself within the last 10 minutes with two-step sign-in set (unknown, as
for a Google sign-in that does not say, is not enough), within a daily cap of PC adds per account,
and writes who added it in the account's safety log. The one exception is an account's first PC:
an account never used (no PC listed, added or removed before, and no device key ever registered,
removed ones included, apart from one the admitting sign-in registered itself) admits its first PC in one press under any sign-in, since no other device
exists to protect or tell. The PC's own page registers no device key, so a new user's first press
meets it. The page then names the account it is signed
in to for the PC (`POST /api/account/relay-account`) and presses `POST /api/account/one-press`
`{ "account" }`. The PC takes it only from its owner here (a device through the relay gets
`owner_only`, as does a Portal visitor or an open LAN window, and a watching one `read_only`), only for
the account named for it (`409 account_mismatch` otherwise) and only while it is in no account
(`409 in_account`). It asks the account service itself, with its relay key's proof
(`POST /v1/pc/admission`, naming that account): an admission by any other account is never shown to
it, and an answer for another account binds nothing (`502 account_mismatch`). Then it binds
`account-pc.json` to the account (`service: true` on the binding) and reads the account's snapshot
at once, so the account's devices are let in as on any PC of the account. `404 no_admission` and
`503 account_unavailable` bind nothing. Any refusal, at the service or at the PC (an Ovis from
before this has no route), leaves the page on the wait above, unchanged. In this release the PC's
own Settings signs in with a code typed on another device, which the service does not count as an
app's own sign-in, so a press there still ends in that wait; it adds the PC in one press once the PC
page signs in on its own window.

**Sign in again from the wait.** When the service refuses the press for the sign-in itself
(`two_step_required`, `session_not_fresh` or `own_sign_in_required`) and the page signs in its own way
(the desktop app, the PC's own window), the wait offers **Sign in again** once. It signs in afresh
with the stored provider; the new sign-in is kept only for the same account and only while the wait
still runs (Stop waiting in any window of the PC ends it). The press is then made again inside that
wait: for the PC the wait listed (the PC's address must still answer for it, and nothing is listed
again), with exactly the sign-in just made, never one another tab stored meanwhile. A second refusal
leaves the plain wait, with no offer: the wait offers it once.

The account's other devices are told: the service sends them its usual push, and at the top of the
opened Ovis a notice names the new PC, with **I didn't add this**, which removes it from the
account's list at once (`DELETE /v1/pcs/{server_id}`); its close button only hides it. The overview
page shows neither: it lists the PC as any other, with no quick **Open** while it is new unless this
device paired with it by hand (then **Open** is the person's own tap). A PC added under the first-PC
exception is told, once, to the first devices that join the account after it (`admitted_before_you`
on its directory entry), however much later. For 24 hours (`new_until` on its directory entry) the
PC is marked new on them: it is never selected or opened by itself and no device signs in to it on
its own, while a press on it opens it as usual. The account service admits the PC before the PC is
asked, so a press the PC then refuses (it restarted, was put in another account meanwhile, or was
not this PC's own window) still told the account's other devices and marked the PC new; such a PC is
not in that account (in none, or in another one it joined meanwhile), and the page waits for the
digits as before, and its notice says what to do if nobody added it. A PC bound this way leaves the
account as soon as a snapshot read finds the account no longer lists it. Before recording the
`unlisted` clear, the PC ends account-only rows and removes membership from credentials whose
recorded origin proves they paired here. Those pairings keep their keys and roles, including
after an offline restart from either state folder. A pairing by code or digits counts as local
only when this PC approved the current key; one an account member device started or approved
does not qualify.
The sibling's old membership or signed add does not restore the cleared binding. An imported or
invalid origin does not qualify. Unlisting does not
lift a lock, block, freeze, Revoke or tombstone.

A wrong number ends that comparison; the person starts again from **Add** on the dashboard. A device without an account
pairs with a QR code or pairing code behind **Start without signing in** on the sign-in screen, which
leads to **Add a PC**.

### Adding a PC of your account

If this PC cannot read its account state, it refuses a PC add rather than assuming it is
outside an account. Try again in a moment. If the refusal persists, run `ovis recover` in a
terminal on this PC to inspect its local state. Do not delete its account files to retry:
they also record which devices must stay out.

The target-bound refusal is part of the **PC-add protocol**, not proof that every
client with a pairing code is a PC. On a bound non-Linux target, older clients and
clients that do not identify a PC add can still use legacy code pairing. Full
PC-to-PC key proof remains a follow-up. This limitation does not change the source
PC's refusal or the Tailscale tab's SSH connection.

**Add a connection → Ovis relay** on a PC (A) whose page is signed in, with A in that account, lists
the account's other PCs: **Connect** for one already in A's machine list,
**Add** for one that would pair, and "Update Ovis on that PC" or "Offline" with no button. **Add**
makes A's server a paired device of that PC (B), as **Add a PC through the relay** with a link does,
and A then lists B like any SSH PC, after a restart too. B's row is a plain drive row: A is never an
account member, holds no account key and signs nothing ([rule 3](#rules)).

A's page cannot reach a relay (its `connect-src` is itself and the account service), so A's server
does the relay work, and the page only vouches for it:

1. `POST /api/machines/relay/account/check` `{ "pcs": [{ "server_id", "server_public_key", "relay", "name" }] }`
   (at most 32) answers each PC's `state`: `ready`, `outdated` or `offline`. A's server opens a relay
   channel to each, offers `pair-sas` with `pair-intent-pc-vouched`, reads the PC's answer to `HELLO`
   and closes before `PAIR_REQUEST`: nothing is counted there and no key is kept.
2. **Add**: `POST /api/machines/relay/account/start` `{ "pc" }` checks the entry (its `server_id`
   must derive from `server_public_key`, its relay a `wss:` origin, not A itself, not already added),
   asks the PC as `check` does (409 `account_pc_outdated` for an older one: nothing is posted or
   sent to pair), and makes the P-256 key A would hold for B, in memory only. It answers
   `{ "ticket", "key", "label" }`. Until B admits that key, or for 10 minutes from when it was made,
   another Add of B gets the same key under a new ticket: after a cancelled or declined comparison B
   already read its admission, and B reads the account's admissions at most once every 10 seconds.
3. The page posts an admission naming that `key` at B (`POST /v1/admissions`, as a signed-in device
   that joins does): the account service has seen a device signed in to this account ask.
4. `POST /api/machines/relay/account/pair` `{ "ticket" }` compares digits with B through the relay
   with `pair-intent-pc-vouched`, and answers newline-delimited JSON: `{ "digits" }` once B took the
   request (the page shows them under "Approve on another device of your account"), then
   `{ "machine" }` once B admitted A and A saved it as `POST /api/machines/relay` does, or
   `{ "error": { "code", "message" } }`. Closing the request (Cancel, closing the sheet) ends the
   comparison on B and keeps nothing: the key is written only on B's `AUTH_OK`. A ticket is good for
   one comparison, for 10 minutes, and one comparison runs per key: another window's Add of B while
   one runs gets 409 `account_pc_busy`, so B is asked once. A cancel that lands in the moment between B's `AUTH_OK` and A
   saving the PC leaves B a row for a key A dropped: nobody can sign in with it, B lists it as
   "Ovis on <host>" (announced as every admission is), and **Revoke** on B removes it.

These routes are A's owner's, from a window direct to A that drives it: a device on the relay, a
Portal visitor and an open LAN window get 403 `owner_only`, a watching device `read_only`, so none
of them can have A pair itself with a PC they name. No person checks A's side of the comparison:
A dials B by B's own key, checked against B's id, so a relay cannot stand in for B. B's side is the
one a member checks, by picking the digits A's page shows.

On B, `pair-intent-pc-vouched` is taken only under the gates of [joining through the
account](#who-may-admit-a-device), whether or not B's pairing window is open: B belongs to an
account, its mailbox holds an admission at most 10 minutes old naming exactly the key of this
`PAIR_REQUEST`, and B has a drive account member to approve; it shares the 5 joins a minute.
Anything else is refused before any prompt and not counted. The comparison is shown only to the
account's members through the relay (`remote-pairings`, digits picked out of three), never to B's own
windows, as **pair this PC** (`intent: "pc"`) naming A's server ("Ovis on <host>"), marked
`vouched: true`, so the approver's app signs nothing for it (no `add`, no introduction) but still
shows who is asking (Who is asking, from `GET /v1/admissions`) and approves only when the account
service lists the admission for that key at B, as for an account join; signed out, it approves none.
An approver from before the mark reads a plain request for B alone and signs nothing either. B's row is `added_by` the approver,
with no `account`. Its failures (declined, a wrong pick, no answer in time) count on a path of their
own. An older B selects no such intent: A says to update Ovis there and sends nothing more.

### Introductions

A device just admitted on PC X learns the account's other PCs from the member that approved it,
through X, and then signs in to each as usual; each PC still decides by its own `devices.json`.

`POST /api/account/introduce` `{ "key", "pcs": [{ "server_id", "server_public_key", "relay", "name" }] }`:
from a drive account member (`account_required` otherwise), for a key X holds a row for that an
account member added (`added_by`, from an `add` or a remote approval; `introduction_unknown_key`
otherwise). A device paired with X by code or QR and linked there is not introduced: it compares
digits once with a PC it was not added to. `pcs` lists only PCs the member verified itself (QR, digits, or its own pairing), at
most 32: `server_id` must derive from `server_public_key`, `relay` is a `wss:` origin, `name` at
most 48 characters (`introduction_invalid` otherwise). X keeps it in `account-introductions.json`, for 30 days after the last one, merged by PC (a later
entry for the same PC replaces it, at most 32 PCs and 256 devices). Answers 204.

`GET /api/account/introduction`: over the new device's own signed-in session, watch access included
(the one account route that needs no drive access, since it reads only the caller's own
introduction); answers `{ "pcs" }` for its own key, or 404 `introduction_none`.

A PC saved only by an introduction is one this device never chose: the app never opens it by itself
(at a launch, or as the PC opened last) until the person opens it once, which marks it chosen.

Known risk (T10 in the design): a compromised X can show the new device other PCs' keys than the
member sent. It already holds X's sessions; what it gains is the new device trying those keys. Each
PC then still admits it only by its own `devices.json`, and a PC the device has never been added to
refuses it.

The directory's `public_key` is stored but cannot be forged: it is bound to `server_id`, and a client
derives the `server_id` from it again before using it. Its `relay` is only a route; comparing digits
is what authenticates the PC.


## On the PC

- Membership lives on the rows of `devices.json` (`account`, `added_by`); the PC's account is the
  account of its members. Tombstones live beside it, in `account-tombstones.json` (readable by your
  user only), each with the signed `remove`s that made it, as received, one per signer (at most
  8). A tombstone file that will not parse is not an empty one: account records are then
  refused (`account_unavailable`) until it is restored, and so are a code started through the relay
  and a remote approval; the mailbox collects nothing meanwhile, so no removal is acknowledged
  unapplied. Pairing on the PC itself and signing in are unchanged. A **Revoke** meanwhile writes its
  tombstone to `account-tombstones.pending.json`, which the PC reads too and folds back in once the
  main file can be read again.
- An `add` whose key is not a P-256 point is refused (`record_invalid`): the signature covers only
  the signer, and devices.json accepts no such key.
- A code an account member started through the relay makes that member the new row's `added_by`,
  and lets nobody in once the member is revoked or demoted.
- A `remove` writes its tombstone before it revokes the device; the device's relay connections
  close at once (`auth_revoked`). A `remove` signed before this PC itself paired the key again leaves
  that pairing be, so a late or replayed one cannot undo it; it still takes the key's other rows, such
  as a member row an `add` made (`applied`), and is `unchanged` when there are none. That `remove`
  writes no tombstone, as the key stays this PC's pairing: the rows it takes leave `devices.json`
  only. A row an `add` or a remote
  approval made goes, however late the `remove` arrives, and so does a row a `link` moved onto the
  key from another one (`link_moved_key`): this PC paired its former key, never this one. A `link`
  whose `old_key` is its `key` leaves the row a pairing of that key.
- **Revoke** and **Revoke all** on the PC leave a tombstone too, so no record brings the key back,
  even after the PC joins an account. An account `remove` for a key the PC revoked first takes over
  its tombstone.
- A pairing made on this PC (a code started on the PC, or a comparison approved here) clears that
  key's tombstone, after its row is written. A code started through the relay, or a comparison an
  account member approves remotely, is refused for a tombstoned key, except on a PC in no account:
  there a code started through the relay may let back a key the PC revoked itself (not one the
  account removed), and clears its tombstone. Through the relay tab's QR code, the link of the
  device that paired with it brings back a key the PC revoked itself, and not one the account
  removed.
- A stop between two such writes leaves a row and a tombstone for one key. On start the PC tells them
  apart by time: a row made before the key's removal is revoked, one made after it keeps its device
  and the tombstone goes. A row that is no pairing of its key here (an `add`, a remote approval, a
  `link` that moved it onto the key) is revoked whatever its time. Until then no such row signs in,
  signs or approves.
- Where two state dirs share one device list, their tombstones are merged too.
- **Reset relay identity** removes every relay device, members included, so the PC leaves the
  account; a client adds it again by pairing with its new identity, after the client's usual "this
  PC's identity changed" notice.
- `account-enrolling.json` and `account-held.json` that will not parse are not empty: every add is
  refused, and a link or enrollment answers `account_unavailable`, until they are restored or removed.
- A record refused only because its signer is not a member yet (a `remove` that arrived before its
  signer's own `add`), or an `add` held back ([Enrolling a PC](#enrolling-a-pc)), is kept in
  `account-pending.json` and tried again on every pull, a restart included, until it applies. At
  most 1000 wait: past that the oldest adds go first (a relayed remove makes room by dropping a
  waiting add), and if a remove has to go, every add is refused from then on (`account-held.json` says `full`; remove that file to lift it). A pending file that
  will not parse is not an empty one: adds are refused and the mailbox pulls nothing until it is
  restored.
- The PC collects its mailbox from `OVIS_ACCOUNT_SERVICE_URL` (https, or http on loopback only;
  `https://account.ovis.sh` when unset, none when `off`), only while it has members and a relay identity (one on disk counts, the relay on or off; none is ever made for it). An address
  it cannot use shows as the mailbox's error in `/api/account/status`.
- `/api/account/*` is refused to Portal visitors and open LAN windows (`owner_only`), and a `link`
  must start from the key its own session signed in with.
- Only a session that signed in with `AUTH` holds a proven key: one admitted with a code or by
  comparing digits sent its key but never signed with it, so it may not link, introduce or read an
  introduction until it signs in again. A member acts (approving, introducing, enrolling, starting a
  code) only from a session signed in with its row's current key.
- A code started through the relay records its starter as the new device's `added_by`, so the device
  counts as that starter's addition, not a pairing made on this PC.
- Every device that loses its access is announced on the machines event stream as
  `{ "type": "device-removed", "event_id", "device_id", "label", "removed_at", "by" }`, to streams with
  drive access only: `by` is `"pc"` for a revoke on the PC itself (Revoke all, a reset relay
  identity), the device that revoked it through the app, or the member that signed an account
  `remove`.
- `GET /api/devices` adds `account`, `account_key` (the member's `relay_public_key`, which is public)
  and `added_by` to account members' rows, for a caller with drive access only; a watching device
  sees none of them.
- `DELETE /api/devices/{id}` with the header `x-ovis-unless-account: {account}` removes the device
  only while it is no member of that account, and answers `409 account_member` when it is; the
  check and the removal are one step. `ovis add` removes a device its code let in this way, so one
  that linked itself to the account that signed in since the list was read stays. Membership is
  what the row says, which for an account's first member on a PC is that device's own claim
  ([What this does not protect against](#what-this-does-not-protect-against)).

### Turning Step 2 off

Phones paired before Step 2 keep their existing connection across upgrades and offline restarts,
subject to the PC's local denials. The old credential does not confer Step 2 authority before a
whole snapshot. If the account service disables Step 2, a listed PC gets `step2_off` on its snapshot
read. Account-joined phones wait until a whole snapshot succeeds again; a named recovery release
cannot override that wait.

A PC that was offline cannot know about a new account block until it contacts the service.
It reads its mailbox before reconciling the account list. If a **Not me** targets a legacy
device whose local pairing time cannot be trusted, the PC keeps the request until a reconciled
read can establish the order of both keys. On that PC, **Settings → Devices and PCs** shows
the pending request beside the device. Choose **Revoke** there to stop its access immediately.

Step 2 is on by default. Only the exact value `0` turns it off. An unset or empty value, `1`,
`false`, and all other values leave it on.

- **herdr plugin:** Set `OVIS_ACCOUNT_OPENS_ALL=0` in
  `~/.config/herdr/plugins/config/devswha.ovis/.env`, then restart only the Ovis plugin.
- **Desktop app:** There is no in-app switch yet. If you launch Ovis yourself, set
  `OVIS_ACCOUNT_OPENS_ALL=0` in the launch environment and restart Ovis from that environment.

### Confirmed on this PC

With Step 2 on, some acts are taken only when they are confirmed on this PC's own screen
(`server/account/local-confirm.ts`). The server puts the act on the screen; it is answered
there, once, within 2 minutes, and the approval is
used up by that one act and no other (an approval of one key approves no other key). Nothing
answers one but these two:

- The desktop app that started the server, over a socket it passes as `--desktop-owner-fd <n>`
  to a directly started `serve`: the server reads one JSON line per answer (`{"approve":"<id>"}`
  or `{"decline":"<id>"}`) and writes the open acts after every change. The argument is removed
  and the descriptor made close-on-exec before anything is spawned, so no child holds it. Linux
  only for now; elsewhere the descriptor gives no channel. The supervisor removes the argument
  and closes the descriptor without passing it on.
- The local confirm page, on a listener of its own on `127.0.0.1` whose port is only in
  `local-confirm.json` in the state folder (readable by your user only). It is opened only on
  Linux, where the kernel names the user behind a connection, and answers only that user, with no
  proxy header, a Host of exactly its address and, for an answer, its own Origin and the one-time
  value its page was given. On Windows neither path exists yet. Run `ovis confirm` on the PC to
  open it: as the user Ovis runs as, the command reads the port from that file (refusing a file
  or folder another account owns, or one it cannot make yours alone), prints `http://127.0.0.1:<port>/` and opens it in a browser
  where there is a desktop. It never opens an address the file names, only the one it builds.
  Strict mode in Settings → Devices points there after you ask to turn it on or off: nothing changes
  until the act is approved on that page, within its 2 minutes.

Every route of the server refuses these answers (`local_required`), through the relay, the access
token, a paired device, a loopback window or the bridge credential alike. A restart ends every
open confirm. What this does not prove: that a person sat there. A program that runs as your user
on this PC, a terminal that a driving device opened included, or anyone who logs in to this PC,
reaches the same screen as you do.

### Limits of this release

These limits apply while Step 2 is on, which is the default.

- **Lifting a block needs a two-step sign-in.** Only a device that is older than the block, and
  whose own sign-in has two-step sign-in set on the account, can lift a block from the app. A
  Google sign-in whose two-step state the account cannot see ("Two-step sign-in not confirmed")
  can block a device but cannot lift a block. If every device you still have is like that, lift
  the block on the PC itself: run `ovis recover` to list what stands there, then
  `ovis recover --lift <block id>` for the one to lift. `ovis recover` asks you to confirm in
  that terminal.
- **Strict mode and key confirmations are Linux only for now.** Turning strict mode on or off,
  and approving a new key on the PC's screen, need the PC's own screen, which this release has
  only on Linux. On macOS and Windows neither is available yet; pairing works as before.
- **A legacy pairing made with a clock more than a day ahead keeps its existing connection but
  cannot authorize Step 2 actions.** Correcting the clock does not give that old timestamp
  authority. Other phones and account reconciliation are unaffected. A clock fault in new Step 2
  state still makes the PC refuse account access until that state can be read safely.
- **A locked PC is driven only from the PC itself.** While strict mode is on, the PC takes its
  orders only from the desktop app that started it (its owner channel) or from the confirm page
  on its own screen. No other device, browser window, access token or relay connection can change
  what it lets in until strict mode is turned off there.

## Account service API

The service the apps and PCs call; a self-hosted install can point both at its own. Clients
authenticate with `Authorization: Bearer <access_token>` from [signing in](#signing-in); the PC never
signs in and proves its relay key instead. JSON bodies, errors as `{ "error": { "code", "message" } }`.

### Signing in

A sign-in only finds the account's PCs and rings its devices. It never admits a device anywhere:
that stays with each PC's `devices.json` ([Rules](#rules)).

OAuth's authorization code flow with PKCE, `S256` only:

1. `GET /v1/signin/{github|google|apple}?redirect_uri&state&code_challenge&code_challenge_method=S256[&response_mode][&link_token]`
   sends the browser to the provider's sign-in, then back to `redirect_uri` with `code` and
   `state`: in the fragment (`#code=…&state=…`) for `https://app.ovis.sh/`, always, so the code never
   reaches that host's request logs; in the query for the loopback redirect, which a local server
   reads (a server never sees a fragment); and for `ovis://account/callback` in the query, or the
   fragment with `response_mode=fragment`. Any other pairing answers 400 `invalid_request`. The
   `code` is good once, for 60 seconds.
2. `POST /v1/token` `{ "grant_type": "authorization_code", "code", "code_verifier", "redirect_uri" }`
   answers `{ "access_token", "refresh_token", "expires_in", "account", "provider" }`.
   `redirect_uri` must be the one the code was issued for, and `code_verifier` the one whose SHA-256
   (base64url) was `code_challenge`.
3. `POST /v1/token` `{ "grant_type": "refresh_token", "refresh_token" }` answers the same. Refresh
   tokens rotate: each is good once, and using one again ends every token of its sign-in (its
   family), as a leaked one would be.
4. On iOS, Sign in with Apple hands the app an identity token directly:
   `POST /v1/token` `{ "grant_type": "apple_id_token", "id_token", "nonce" }` answers the same. The
   app makes a fresh random `nonce` of 16-128 characters for each sign-in, gives Apple its SHA-256 in
   lowercase hex, and sends the plain `nonce` here. The service accepts the token only when Apple's
   signature holds (Apple's published keys), `iss` is `https://appleid.apple.com`, `aud` is the
   app's id, it was issued at most 10 minutes ago and has not expired, and its `nonce` claim is that
   hash. Each nonce is accepted once.
5. A PC without a browser signs in with GitHub's or Google's device flow (RFC 8628):
   `POST /v1/signin/{github|google}/device` answers `{ "device_code", "user_code", "verification_uri",
   "expires_in", "interval" }`; the person opens `verification_uri` elsewhere and types `user_code`.
   The PC polls `POST /v1/token` `{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
   "device_code" }` every `interval` seconds: 400 `authorization_pending` until the person approves,
   `slow_down` for a poll too soon (the interval grows by five seconds), `access_denied` if they
   refused, `expired_token` once it ran out; then the same answer as the other grants, once.
   A browser on a PC's own address signs in the same way, bound to a verifier: it starts with
   `{ "code_challenge", "code_challenge_method": "S256" }` (as in step 1, from 32 random bytes),
   the service answers with `"code_challenge_method": "S256"` added, and every poll carries
   `"code_verifier"`. A bound poll without that verifier, or with another, answers 400
   `invalid_grant` before GitHub is asked and without moving the interval, so the `device_code`
   alone redeems nothing. The page keeps the verifier in memory only, uses the service only when
   it named the method, links only to the provider's own device page (`https://github.com/login/device`,
   `https://www.google.com/device`), waits `Retry-After` on a
   429, and keeps no session from a sign-in cancelled meanwhile (it is stored under the same
   lock as a refresh or a sign-out).
   Where the service has the Ovis link page (`device_page` below), the page and `link` start with
   `POST /v1/signin/ovis/device` instead (the S256 challenge is required): the answer's `user_code`
   is the service's own (`XXXX-XXXX`), `verification_uri` is exactly `<service>/link`, and
   `verification_uri_complete` that page with `?code=` filled in, shown as a QR code. The person
   types or scans it on any device, chooses GitHub or Google there, signs in, and confirms on the
   page in the same browser; the polls are the same. A client refuses an answer naming any other
   page, and shows no QR code for a link carrying another code. Signing in this way adds no PC and
   no device: adding still needs an approval on a device already in the account. The start may
   carry `label` (1-48 characters, no control characters) and `os`, which the page's confirmation
   shows (Who is asking, below); a provider's own device start takes neither.
   The relay tab of Add a connection signs in this way too, from its own Sign in rather than Settings:
   it opens `verification_uri_complete` (else `verification_uri`) in a new tab, opened blank in the
   click so no popup blocker takes it (the desktop app hands it to the system browser), shows the code
   beside it, or the page's link and code alone when the tab was blocked, and stops polling when the
   sheet closes. Where the link page cannot start a sign-in it falls back to GitHub's device page.
   This PC's own window in a browser on the PC (`own_window` in `GET /api/health?scope=bridge`, and the
   page on exactly `http://127.0.0.1:` that port) signs in as an app instead, through step 1 with the
   loopback redirect `http://127.0.0.1:<port>/callback`: the PC serves that path as the app's page,
   which hands the return to the tab that started the sign-in over a `BroadcastChannel` of its origin,
   and that tab redeems it with the verifier it kept. Every other window keeps the device flow.
6. `POST /v1/signout` (Bearer) answers 204 and ends that sign-in's family.

`GET /v1/providers` (no sign-in) answers `{ "providers": ["github", "google"], "device": ["github",
"google"], "device_page": ["github", "google"] }`: the sign-ins this service is set up for, those of
them a PC's own page can start at the provider (step 5), and those its Ovis link page offers (an
empty or missing `device_page`: no link page). A provider that is not listed has no button anywhere; a client that cannot read the answer
keeps the sign-ins its build names (GitHub alone by default), so a Google button never leads to a
service that has no Google client.

Google asks for `openid` and nothing else, and the service keeps none of Google's tokens, and no
email or name, past the sign-in: it reads the identity token's `sub` (the account's key for that
Google user), checks `iss`, `aud` and `exp` (and, in the redirect sign-in, the `nonce` it sent; Google's
device flow carries none), and drops the rest.

#### Sign-in methods

Each provider is its own sign-in method: an account has at most one identity per provider, and a
sign-in with an identity no account has makes a new account. The service never joins two accounts
because their email addresses match (whoever controls an address at one provider would take the
account). A signed-in person adds another method on purpose, from Settings:

| request | body | answer |
|---|---|---|
| `GET /v1/identities` | | `{ "identities": [{ "provider", "added_at" }] }`: this account's sign-in methods. Nothing names the person behind one: the service keeps no email or GitHub login |
| `POST /v1/identities/link` | `{ "provider" }` | `{ "link_token", "expires_in" }`: good once, for 10 minutes, for this sign-in and that provider. The client starts a redirect sign-in (step 1) carrying it. 409 `identity_exists` when the account already has that provider; 403 `reauth_required` unless this sign-in was made in the last 10 minutes |
| `DELETE /v1/identities/{provider}` | | `204`: removes that method and ends the sign-ins made with it. 409 `last_identity` when it is the account's only one; 403 `reauth_required` unless this sign-in was made in the last 10 minutes |

A refresh keeps a sign-in's time: only signing in again makes it recent. On `reauth_required` the
client asks the person to sign in again, then repeats what they asked for.

A link takes effect only when its code is redeemed: `POST /v1/token` (`authorization_code`) with the
PKCE verifier and `Authorization: Bearer` of the same sign-in (refresh family) the link token was
issued to, not just the same account, which then
answers a session of that account with `provider` the added one. Starting a sign-in links nothing,
so a link token in someone else's sign-in URL, whose code never comes back to its owner, adds
nothing; a redemption without that sign-in's token answers 400 `invalid_grant`. A link token that
is unknown, spent, expired or for another provider sends the browser back with `error=invalid_link`
and never falls back to a plain sign-in. A linking sign-in whose identity already belongs to
another account answers 409 `identity_in_use` at redemption, and neither account changes. The
device flow (step 5) never links (400 `invalid_request` for a `link_token`): a device code can be
typed by someone it was phished from, so a PC's own page adds methods only through the desktop
app or another redirect sign-in. The client keeps the session the link answers with only when it
is for its own account, and ends the one it had (`POST /v1/signout`).

#### Deleting the account

| request | body | answer |
|---|---|---|
| `DELETE /v1/account` | | `204`: the account and everything the service keeps under it are gone. 403 `reauth_required` unless this sign-in was made in the last 10 minutes; 403 `web_sign_in_required` for a sign-in made with a device code or on the link page (a code can be typed for someone else's PC, so such a sign-in never ends the account), its refreshes included; 409 `subscription_active` while a subscription still renews; 502 `billing_failed` when the payment provider did not answer |

The service erases, in one write, the account's sign-in methods, every sign-in of it (with its push
subscription), its PC directory, the records and admissions still waiting for its PCs, its relay
slots and usage, its plan and its own limit counters. Nothing is kept and there is no grace period:
the same provider user later signs in to a new, empty account. A subscription cancelled at its
period end does not refuse the delete; the time left on it goes with the account.

Deleting revokes nothing on a PC (rule 1): `devices.json` still lists every device the account
brought in, so each stays paired, as one paired by QR code does, until it is revoked on that PC.
A device that should lose its access leaves the account first (**Remove this device from your
account**), while the account can still carry its `remove`. A PC of a deleted account keeps naming
that account in `devices.json`: its mailbox pulls find nothing, it gets no relay pass, and it joins
another account only once its rows of the deleted one are revoked there.

The client (`src/lib/account/deleteAccount.ts`) deletes for the sign-in the person acted on, never
one stored meanwhile, then forgets that sign-in and its account key; a pairing keeps its own copy
of the key. A delete that finds the sign-in already gone (another tab signed out, or the answer to an
earlier delete was lost and the service now refuses the sign-in) shows the signed-out page and keeps
the key: nothing here proves the account went, and a key kept too long costs nothing. It is offered behind a second press on the same button that says what goes and what
stays, wherever the sign-in is one the service lets delete: **Settings → Devices and PCs → Manage account**
in the desktop app, and **Devices → Account** in the hosted shell and the phone apps. A PC's own page
in a browser signs in with a device code or the link page, so its Account section offers no delete
and names those places instead. On `reauth_required` the desktop app signs in again and repeats the
delete; the phone apps sign in again in place with the same method and delete only when that is the
same account; a browser on the hosted shell is told to sign out and in again. A sign-in again is
stored only in the place of the sign-in being deleted, while that delete is still on: a sign-out or
another sign-in made meanwhile ends it.

The client makes `state` (at least 128 bits) and `code_verifier` (32 random bytes, base64url) fresh
for each sign-in, keeps them with that sign-in only, and drops a callback whose `state` is missing or
not the one it sent.

`redirect_uri` is compared exactly against three forms: `https://app.ovis.sh/`,
`ovis://account/callback`, and `http://127.0.0.1:<port>/callback` on any port (a loopback redirect
for the desktop app, RFC 8252). Anything else answers 400 `invalid_redirect_uri` before any
sign-in. The hosted shell is built with `https://account.ovis.sh` unless `OVIS_ACCOUNT_SERVICE_URL` names another https service (none when it is `off`), and its Content-Security-Policy lets it reach `https://account.ovis.sh` (`connect-src`), and no other account service yet. In a browser it offers sign-in only on `https://app.ovis.sh`, the one page the service sends a browser back to: the regional copy beside a relay, a preview or a local run offers none, and the phone app signs in through its own scheme anywhere. The PC's own pages may reach `https://account.ovis.sh` when `OVIS_ACCOUNT_SERVICE_URL` is unset, exactly the origin it names when it is https with a host name or IPv4 address, and no account service when it is `off` or not https.

The desktop app offers sign-in in **Settings → Phone & devices** with `https://account.ovis.sh`
unless `OVIS_ACCOUNT_SERVICE_URL` names another https service. `OVIS_ACCOUNT_SERVICE_URL=off`
turns the account off for the app and its server alike: no sign-in, no account origin in the
pages' policy, no mailbox. A browser on the PC's own address cannot take a redirect (the service
sends a sign-in back only to the three above, none of which is that address), so it signs in
with the device flow (step 5), in the same place, with the providers `GET /v1/providers` lists
under `device`: the PC writes
`<meta name="ovis-pc-account-service">` into its own shell with exactly the origin its policy
admits (none when the account is `off`), and the page offers the sign-in only on a secure page
(https, or `localhost`), where no one on the network could have rewritten the script that holds
the sign-in. The hosted shell keeps its redirect sign-in, and the desktop app its loopback one. Token errors are 400 `invalid_grant` (a wrong, spent or expired code, verifier, refresh
token or identity token) and 400 `unsupported_grant_type`; an access token that expired or was
signed out answers 401 `unauthorized` on every other request.

Clients:

| request | body | answer |
|---|---|---|
| `GET /v1/pcs` | | `{ "pcs": [{ "server_id", "label", "public_key", "relay", "added_at", "last_seen_at" }] }` |
| `PUT /v1/pcs/{server_id}` | `{ "label", "public_key", "relay" }` | `{ "pc": … }`: adds or renames a PC in the directory. 400 `server_key_mismatch` unless `public_key` (X25519, 64 hex) gives `server_id` (`deriveServerId`), 400 `invalid_relay` unless `relay` is a `wss:` origin |
| `DELETE /v1/pcs/{server_id}` | | `204` |
| `POST /v1/records` | `{ "server_ids": [...], "record" }` | `{ "queued": n }`: puts a signed record of the caller's account in that account's mailbox for each listed PC; the service checks only its shape and signature. 429 `mailbox_full` past 1000 records waiting for one PC |
| `GET /v1/admissions` | | `{ "admissions": [{ "key", "label", "server_id", "at", "os", "country", "city" }] }`: this account's admissions of the last 10 minutes, with who is asking (below). Before it signs an `add` for a device a PC showed it, the approving client checks that PC and key are listed here |
| `POST /v1/admissions` | `{ "server_id", "label", "key", "os"? }` | `{ "id" }`: the signed-in device says it waits at that PC with its account key (`key`); rings the account's other clients (push), and reaches that PC's mailbox for 10 minutes |
| `POST /v1/signout` | | `204`: ends this sign-in's tokens |

`DELETE /v1/pcs/{server_id}` is no lasting removal for a PC in use: a member device lists the PC
again on its next connection to it (`enrollOwned`), and so does the PC's own waiting Add this PC
screen. A PC the directory does not list gets no [relay pass](relay.md#relay-pass) (`not_listed`)
and none of the account's later records. So the apps offer it only in a PC's own Settings →
Devices and PCs, as **Remove from list**, and only for a PC the directory has not heard from for
two days (`unusedPc` in [`src/components/AccountPcs.tsx`](../src/components/AccountPcs.tsx): its
`last_seen_at`, or its `added_at` when it never pulled), with a confirm that says it revokes
nothing and that the PC is listed again if it is used again.

Push (the doorbell), per signed-in device:

| request | body | answer |
|---|---|---|
| `GET /v1/push/key` | | `{ "public_key" }`: the VAPID key to subscribe with |
| `PUT /v1/push` | `{ "endpoint", "keys": { "p256dh", "auth" } }` | `204`: this device's subscription, one per signed-in device (a new one replaces it) |
| `DELETE /v1/push` | | `204` |

The service rings the account's other subscribed devices when a PC joins the directory and on
`POST /v1/admissions`. Every ring is the same payload,
`{ "pane_id": null, "title": "Ovis", "body": "Your Ovis account has news", "tag": "ovis-account" }`,
with nothing about which device or PC: the app asks its PCs.

Limits: an account lists at most 100 PCs (409 `directory_full`), rings for admissions 10 times
and makes 600 requests in 10 minutes (429 `too_many_admissions`, 429 `rate_limited`), and holds at
most 1000 records waiting for one PC (429 `mailbox_full`). A 429 carries `Retry-After`.

The PC, by server proof:

| request | body | answer |
|---|---|---|
| `POST /v1/pc/challenge` | `{ "server_id", "public_key" }` | `{ "challenge_id", "frame" }` |
| `POST /v1/pc/mailbox` | `{ "server_id", "challenge_id", "proof", "account", "ack" }` | `{ "records": [{ "seq", "record" }], "more", "admissions": [{ "key", "label", "at" }] }`: `admissions` lists that account's admissions for this PC made in the last 10 minutes, on every pull until they age out |

`public_key` is the PC's relay key (64 hex); the service refuses it unless it gives `server_id`
(`deriveServerId`). `frame` is a `server_challenge` (`serverChallenge` in
[`shared/relay-server-proof.ts`](../shared/relay-server-proof.ts)) for the route `{ server_id, role:
"account", connection_id: challenge_id }`; `proof` is the PC's `server_proof` answer for that same
route. A challenge is good for 60 seconds and one answer. Anyone can list any `server_id` in their
directory, so mailboxes are kept per PC **and account**: the PC asks only for its own account's
(`account`), and another account's records can neither fill nor hide them. `last_seen_at` moves
only in that account's directory. `ack` is the highest `seq` the PC processed, whatever the
outcome, refused included (or `null`); the service deletes those records before answering, and
deletes any record after 30 days. The PC pulls when it starts and every five minutes while it
belongs to an account. It also pulls when a sign-in fails, since a member may have added that
device on another PC a moment ago, and then checks the sign-in once more. Such sign-ins start at
most one pull a minute (a pull that could not read the mailbox lets the next start 10 seconds after
it began), and each waits at most five seconds for it. A sign-in that still fails is refused with
the same `auth_failed`, so a device whose add reached the mailbox after that pull, or after another
failed sign-in spent it, is let in up to a minute later. An unknown id and a signature that does
not hold take the same way, so the delay does not tell which ids have a row; it does tell a PC in
an account (the refusal may wait for the pull) from one in none (it never does).

The `account` role keeps the two proofs apart: the relay verifies `control` and `data` only, so an
answer the PC gave the account service is no use to the relay, and a relay's challenge passed on by
the account service gets an answer the relay refuses.

### Who is asking

A device code can be phished: someone starts a sign-in on their own device and talks a person into
typing its code (RFC 8628 section 5.4). Signing in admits nothing by itself, but a device of the
account may then ask to join it, so every approval for a device the person cannot see says what it
is and roughly where it asked from:

- `os`: what the device says it runs, one of `ios`, `android`, `macos`, `windows`, `linux`,
  `chromeos`; anything else is kept as unknown (`null`). A browser sends it from its user agent
  (`src/lib/phone.ts` `deviceOs`), `link` from the PC's platform. With `label`, it is what the
  device says, so it tells a mistake apart, not a liar.
- `country` (ISO 3166-1 alpha-2) and `city`: where Cloudflare saw the request come from. Never the
  address. Unknown, Tor and a city without a country are `null`.

The service keeps these on the admission or link page request itself: they are served for that
row's ten minutes and deleted with it by the daily cleanup, so kept at most about a day. The
privacy policy ([ovis.sh/privacy](https://ovis.sh/privacy/#account)) lists them with everything
else the service stores.

The approval card (`AccountApprovalPrompt`) shows the admission's (`GET /v1/admissions`, the newest
one for this PC and key, read from the account service and not from the PC) as "iOS · Network near
Seoul, South Korea", or "Network location unknown", says that the name and system are what the
device says and the place is where its network connects from, and asks to approve only a request
the person started. Names are read as one plain line (no control or bidi characters, single spaces,
48 UTF-16 units: the form a signed `add` takes). Approval goes ahead only for the admission the card
showed: when the device asked again with another name, system or place, nothing is answered and the
card shows the new details first.
The link page's confirmation shows the PC's ("Asked by Desk (Linux), near Seoul, South Korea")
with "continue only if you started this on your own PC".

## Errors

| code | status | meaning |
|---|---|---|
| `account_required` | 403 | this needs a drive account member |
| `account_mismatch` | 409 | the record is for another account than this PC's; or, on a PC in no account, a first link names another account than the one its owner set it up for (`relay-account`), or comes from a device that waits to link while no account is named |
| `record_invalid` | 400 | a record that does not parse, or a field out of range |
| `signature_invalid` | 400 | the signature does not hold over the signing bytes |
| `signer_not_member` | — | the signer is not a drive account member on this PC (a record outcome) |
| `tombstoned` | — | the key was removed through the account; only this PC can let it back in (a record outcome) |
| `link_not_owner` | 403 | a link for another device, another PC, or a key that is not the row's |
| `link_required` | 403 | the device paired with a code made for a PC in no account and has not linked itself into an account: it reads its own account status and sends its link, and gets nothing else |
| `key_in_use` | 409 | a link to a key another row already has |
| `introduction_unknown_key` | 404 | an introduction for a key no account member added on this PC |
| `introduction_invalid` | 400 | an introduction's PC list does not parse, or a `server_id` does not derive from its key |
| `introduction_none` | 404 | no introduction waits for this device |
| `account_unavailable` | 503 | the tombstone file cannot be read; no account record applies |
| `enrolling` | — | the PC waits for its first member's enrollment; an add waits too (a record outcome) |
| `removal_pending` | — | the key is held: a waiting remove or an enrollment named it, or the waiting queue cannot be trusted (a record outcome) |
| `in_account` | 409 | `POST /api/relay/offer` with `x-ovis-no-account-only`: this PC is in an account, so it makes no QR code that would put it in one |
| `no_account_named` | 409 | `POST /api/relay/offer` with `x-ovis-no-account-only`: no account was named for this PC (`relay-account`), so it makes no QR code yet |

## What this does not protect against

- **A compromised PC in the middle of a remote approval** cannot swap the key on its own any more:
  the approver signs an `add` only for a key the account service lists as admitted at that PC
  (`GET /v1/admissions`), which only a device signed in to the account can post. A compromised PC
  together with a stolen sign-in still could.
- **A PC that stays off while the account service hides a removal** keeps the removed device until a
  client connects to it and hands over the record directly.
- **A removal no reachable PC holds.** When a client brings a PC into the account, a removal held
  only by PCs it cannot reach, and hidden by the account service, is missed (see what a client
  enrolls): the device comes back on that PC, announced there. A client relays the removals it kept
  only when it brings a PC into the account, not ones it learns later.
- **A client from before enrollments** links a new PC and never enrolls it: that PC's barrier stays,
  and the account's devices join it by comparing digits.
- **A coding agent on the desktop app's machine** can drive the app's account key (rule 3). The same
  holds for a sign-in made in a browser on a PC's own address: that page's script is the PC's, so a
  compromised PC can use the sign-in kept there. Its account key is linked to no PC (a browser
  paired with a code holds a cookie), so its signatures admit nobody.
- **A device that names an account it does not hold.** An account's first member on a PC links
  itself: its `link` is signed by the device's own key and names the account (rule 4). While a
  code made to put the PC in an account lives, the account must vouch for that key
  ([The account's word](#the-accounts-word)). `ovis status` lists the members that joined on their
  own word ([How a device joined](#how-a-device-joined)): review them there, and revoke any device
  you don't recognize.
- **A PC the directory names under a familiar name.** Whoever holds a sign-in to the account can
  list a PC of their own in the directory (device-code phishing, [Who is asking](#who-is-asking)). **Add** on
  its row in the relay tab pairs A with that PC, whose owner approves it there: A's machine list then
  holds a stranger's PC. It gets no access to A or to the account's PCs by that; what the person then
  types into its terminals goes to it. The prompt to approve shows on a device of the account only
  when the PC really is one of the account's: a request approved without that prompt is the sign.
- **A code a driving device has the PC itself start.** A device that drives (one the QR code of
  `ovis add` let in, say) can have the PC start a pairing code through its loopback address from
  a terminal pane, as the PC's own user: that code is held by no device, so it survives the
  device's removal.
- **Someone who gets a person to type their device code at GitHub** (device-code phishing, true of
  every RFC 8628 sign-in) gets a sign-in to that person's account: they can list, rename and remove
  its PCs in the directory, fill mailboxes, post admissions and spend the ring budget. They still
  cannot add a device to a PC: that takes a member's signature and the PC's own `devices.json`, and
  a join is still compared digit by digit on a device already linked. The page asks to enter a
  code only if this page showed it, and GitHub's page names the app (Ovis).

## Code

- [`shared/account-records.ts`](../shared/account-records.ts): record types, parsing, signing bytes,
  signing and verification.
- [`shared/account-service-fake.ts`](../shared/account-service-fake.ts): the account service API in
  memory, for tests.
- [`shared/account-list-entry.ts`](../shared/account-list-entry.ts): the entry format of a signed
  list ([account-list.md](account-list.md)). No released part of Ovis reads or writes it yet, and
  nothing on this page uses it.
