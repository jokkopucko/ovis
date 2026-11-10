# Linking devices with an account

Signing in to an account lets one approval add a device to every PC of that account, and one tap
remove a lost device from all of them. The account only finds PCs and carries messages: who gets
into a PC is still decided by that PC's own device list (`devices.json`), as with
[pairing through the relay](relay.md#who-gets-in). This page is the contract between the PC
(`server/account/`), the apps and the account service. The code is in
[`shared/account-records.ts`](../shared/account-records.ts); tests use the in-memory service in
[`shared/account-service-fake.ts`](../shared/account-service-fake.ts).

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
   or device keys), a mailbox of signed records per PC, and admission requests.
8. **Tailscale is not membership.** A PC found on your Tailscale is added over SSH (Add a connection →
   SSH, [remote-pcs.md](remote-pcs.md)), and one an older Ovis added through the relay with a code that
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
is refused (`account_mismatch`). **Revoke all** clears the PC's account with its members; tombstones
stay.

Relay rows paired before the account existed and never linked (a PC that was off when the phone
moved its pairings over) are listed under `unlinked` in [`/api/account/status`](#pc-api) and shown
as "not covered by account removal". The client links them on its next connection. A browser paired
with a code on the PC's own address holds a cookie, not a key: it cannot be linked, stays outside
the account, and only **Revoke** on the PC removes it.

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
  shows the digits and asks y/n.
- **Remote approval:** a client connected through the relay with drive access whose row is an
  account member. It must **pick the new device's digits out of three** (two decoys the PC chose at
  random) before it can approve. A tap without looking picks right one time in three, and a wrong
  pick ends the request, so the person has to look again at a new comparison.
- On a PC that belongs to an account, a pairing code can be started only by the same people:
  directly on the PC (any window there with drive access, as before), or by a drive account member
  through the relay (`403 account_required` for any other relay device, `read_only` for a watch
  device). A PC in no account keeps letting any driving relay device start one, as before.
- **Every admission is announced** on every device connected to the PC: the new device's name and who
  approved it.

`GET /api/relay/pairings` lists the waiting requests: with their `digits` on the PC itself, and with
`choices` (three sets of digits, no `digits`) for an account member through the relay, which also
hears of every change as `remote-pairings` on its event stream; each entry also carries `key`, the
new device's P-256 key from its `PAIR_REQUEST`, bound by the commitment and the digits. That member
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

Such a comparison is shown only to the account's members through the relay (`remote-pairings`,
digits picked out of three, as always), never to the PC's own windows, and never approved by itself.
Anything else is refused before any prompt and not counted as a failed pairing. A PC takes at most 5
such joins a minute; refused requests do not count toward them. A request whose admission the PC has
not seen yet makes it pull its mailbox, at most once every 10 seconds, so a device that asks right
after posting its admission may be refused and asks again. The admissions the PC knows are kept per
account and relay identity, so they never carry over to another account or a new identity.

At most three requests wait for approval at once on a PC. A wrong pick ends that request and counts
as a failed pairing.

**Failed pairings are counted on two paths.** Pairing codes, and comparisons that ask to pair this
PC only, share the 20 failures in 10 minutes described under [Who gets in](relay.md#who-gets-in).
Comparisons that ask to join the account have their own 20, so a flood of account requests cannot
pause pairing by QR code or code.

## Negotiation

A client offers features in `HELLO`; a PC that supports them selects them in `WELCOME`, as with
`pair-sas`. An older PC selects none and the client says to update Ovis on that PC.

| feature | meaning |
|---|---|
| `account` | the PC has `/api/account/*` and applies records |
| `pair-intent-pc` | this comparison pairs this PC only |
| `pair-intent-account` | this comparison adds the device to the account |

A client offering `pair-sas` offers at most one intent; a PC selects an intent only together with
`pair-sas`, and only the one offered. A `HELLO` with both intents ends with `protocol_error`. A
comparison without a selected intent is `pair-intent-pc`.

The approval prompt says what is being approved: **pair this PC**, or **add to the account**; a
remote approver's app adds how many PCs that means from its own list of the account's PCs. The
intent travels inside the encrypted channel that the digits authenticate: a relay that changes it
must sit in the middle, and then the digits differ.

Either intent admits the device on this PC as a plain row. With `pair-intent-account` the new
device then links that row to the account itself (a `link` whose `old_key` is its `key`), and
the approver signs the `add` for it and delivers it to the account's other PCs. The intent decides
only what the prompt says and which failure count a comparison spends.

## PC API

All under `/api/account/`, JSON, `cache-control: no-store`. Every route needs drive access; through
the relay too. Mutations need the app's mutation guard, like the other routes.

`GET /api/account/status`

```json
{ "account": "acct_1" , "members": 3, "unlinked": ["6a1f0c9e2b7d4a10"], "removals": [<remove>, …], "adds": [<add>, …], "blocked": ["<key>", …], "enrolling": false, "mailbox": { "last_pull_at": "2026-11-05T01:02:03.000Z", "error": null } }
```

`account` is `null` before the first member. `unlinked` lists relay rows that are not members.
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

`POST /api/account/relay-account` `{ "account" }`: the account this PC asks its relay pass under while it
has no members ([relay.md](relay.md#relay-pass)): over a direct connection with drive access (the PC's own
screen, after it listed the PC), or through the relay only from a drive account member of that same
account (`account_required` otherwise). Kept in `relay/account.json`; a
name that is not an account id answers 400 `invalid_account`. Answers 204. Naming an account grants
nothing: the service gives a pass only when that account lists the PC.

`POST /api/account/link` `{ "record": <link> }`: the request's own device must be the record's
`device_id`, with `old_key` its current key, `server_id` this PC's. The row's key becomes `key` and it
becomes a member, in one write. `old_key` equal to `key` makes a row whose key already is the account
key a member. Answers `{ "device": <paired device> }`. The row's other sessions end (`auth_changed`):
they signed in with a key it no longer has. The linking session goes on, with no member's rights,
until it signs in again with the new key.

`POST /api/account/records` `{ "records": [<record>, …] }`: at most 32. Applies each in order and
answers every outcome, never failing the whole batch for one record:

```json
{ "results": [{ "id": "…", "outcome": "applied" }, { "id": "…", "outcome": "refused", "code": "tombstoned" }] }
```

Outcomes: `applied`, `unchanged` (an `add` for a key already present; a `remove` for a key already
removed and absent, or signed before this PC paired the key again) and `refused` with a code. A
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

1. On the new PC, Settings → Devices and PCs → Account (or the first-run welcome): press
   **Sign in and add this PC**. A PC in no account is added by that sign-in, in the same step: the
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
   the window it opened is closed (`POST /api/relay/link/close`) unless a wait is kept or the
   person pressed the button since. An entry already sent to the directory when the screen gave
   up cannot be taken back: the screen then says the PC may not have been listed, and the button
   lists it again. A sign-in that was already there when the screen opened lists nothing by itself
   and gets the offer; so does a sign-in again for the same account, one that ended before the PC
   answered, and one whose PC answered only after the minute. The sign-in never turns the relay
   on: with the relay off it lists nothing and offers **Turn on the relay and add this PC**, one
   press for both, which lists under that sign-in only. A device that only watches this PC
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
   opens it again after that. A wait that ran out by itself does not close the window
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

A wrong number ends that comparison; the person starts again from **Add** on the dashboard. A device without an account
pairs with a QR code or pairing code behind **Pair with a QR or code** on the sign-in screen.

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
  that pairing be (`unchanged`), so a late or replayed one cannot undo it. A row an `add` or a remote
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
  account removed), and clears its tombstone.
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
| `account_mismatch` | 409 | the record is for another account than this PC's |
| `record_invalid` | 400 | a record that does not parse, or a field out of range |
| `signature_invalid` | 400 | the signature does not hold over the signing bytes |
| `signer_not_member` | — | the signer is not a drive account member on this PC (a record outcome) |
| `tombstoned` | — | the key was removed through the account; only this PC can let it back in (a record outcome) |
| `link_not_owner` | 403 | a link for another device, another PC, or a key that is not the row's |
| `key_in_use` | 409 | a link to a key another row already has |
| `introduction_unknown_key` | 404 | an introduction for a key no account member added on this PC |
| `introduction_invalid` | 400 | an introduction's PC list does not parse, or a `server_id` does not derive from its key |
| `introduction_none` | 404 | no introduction waits for this device |
| `account_unavailable` | 503 | the tombstone file cannot be read; no account record applies |
| `enrolling` | — | the PC waits for its first member's enrollment; an add waits too (a record outcome) |
| `removal_pending` | — | the key is held: a waiting remove or an enrollment named it, or the waiting queue cannot be trusted (a record outcome) |

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
