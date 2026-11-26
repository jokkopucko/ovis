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
   `relay_public_key`, and `AUTH` signs with it as with any device key. Where the account service
   keeps a [signed list](account-list.md#on-a-device) for the account, the same key signs the
   device's entries in it; nothing on this page decides by that list yet.
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
- **`bun scripts/plugin.ts add` shows no code that admits a device, but its sign-in code names the
  account.** Whoever signs in with that code (or its QR code) first names the account the PC may join,
  until that sign-in ends. So before anything is listed the command names the account that signed
  in by the start of its id, says where to compare it, and lists what that account calls its PCs (its
  own word, which a decoy account can copy); the person at the PC types yes, or the command
  checks it against `--account`, which is the only way where no one can type at it. Only then does
  it list the PC, and a device of that account, signed in with a sign-in of its own made in the last
  10 minutes or proved with that sign-in's key ([In one press](#adding-a-pc)), adds it by pressing **Add** on the PC's card: the account's one-press admission
  ([In one press](#adding-a-pc)), which the PC takes on its own key's proof. An admission by any other
  account never binds it ([A PC with no screen](relay.md#a-pc-with-no-screen)).
- **A code the PC's own terminal prints admits whoever scans it**, with no approval on the PC:
  `bun scripts/plugin.ts add --qr` ends in one QR code, and a signed-in device that scans it links
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
answers with `POST /api/relay/pairing` `{ "id", "decision", "digits" }` (except for a proven PC below); `digits` is required to
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
3. the PC has at least one drive account member to approve it, or it has none yet (a first join).

Such a comparison is shown to the account's members through the relay (`remote-pairings`, digits
picked out of three, as always) and, so a one-PC owner is never stuck, to this PC's own window only
(`GET /api/relay/joins`, its screen, loopback and not forwarded, refused while the PC is locked):
without its digits, one join at a time on a card that window shows by itself, whose field never takes
the focus on its own, and approved only by the owner typing the six digits the new device shows
(`POST /api/relay/join`); one wrong entry ends that join. **Not now** only hides the card in that
window: the join lapses at its own deadline. It is never approved by itself. `ovis approve` in the
PC's terminal (the same loopback, unforwarded request, with `x-herdr-machine` from the same origin)
reads the same list and asks the same way: no digits shown, all six typed, one wrong entry ends that
join, Enter by itself leaves it waiting, a locked or strict PC refuses and the command says so, and an
input that is not a terminal approves nothing. On a machine several people log in to, set an access
token: without one, any local OS account counts as this PC's own window and could approve a join
(it would still need the six digits the asking device shows).

A first join (a PC added in one press, its owner's first phone) has nobody else to approve it: this PC's
own window alone shows it, as a card with the digits to compare and Allow / Decline (`POST /api/relay/join`
with a `decision`), and no member that joins meanwhile may decide it. Its `PAIR_CHALLENGE` carries
`approve_on` (`mac`, `windows`, `linux` or `pc`), so the phone says which PC to press Allow on. On a PC
with no screen, its terminal stands in for that window: `ovis approve` lists a first join with the device's
name, the account its admission came from and when it asked, never with its digits, and lets it in only
when the six digits the device shows are typed there (`POST /api/relay/join` with `digits`, compared as
for a members join: one wrong entry ends that join, and the device may ask again). `ovis add` asks the same
way right after it added the PC ([A PC with no screen](relay.md#a-pc-with-no-screen)). That is the
authority of the own window's Allow, not a new one: the request comes from a shell on this PC that reaches
its loopback, unforwarded, as the owner (with the access token where there is one), which is what makes a
window this PC's own, and it carries the digits only the asking device shows. The terminal asks for them
typed where the window asks for a tap: nothing is approved there without them, an input that is not a
terminal approves nothing, and no flag takes them. The asking device still needs a fresh admission in
this PC's account (condition 2 above), so nobody away from this PC gains anything. A PC vouched
for still needs a member. A key that a QR or code pairing waits with on this PC's screen shows in the same place in
the PC's own window, with its fingerprint and one button, Confirm on this PC (`POST /api/account/confirm-page`, own
window only): the server opens the local confirm page in a browser on this PC's desktop, as `ovis confirm` does, so
the page's port stays in no answer. The page, with its same-user check, or the desktop app still decides it; no route
of the server approves it. With no desktop to open it on, the window says to run `ovis confirm`.
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
| `pair-pc-proof` | required with the vouched intent for a member tap; B can journal the join and verify A’s server identity in this SAS session. B selects the vouched intent only when this is offered too, so an older A that offers the intent alone reads B as a PC to update, and its `PAIR_REQUEST` is still refused |
| `account-list-1` | the PC lets its account's devices in by the account's signed list alone ([How an app signs in to a pinned PC](#how-an-app-signs-in-to-a-pinned-pc)) |
| `account-list-allow-1` | with `pair-intent-account`: this PC follows the account's signed list, and takes the device's card with its `PAIR_REQUEST` ([A PC allows a device into the list](#a-pc-allows-a-device-into-the-list)) |

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
`waiting_for_add` is true while this PC's own window or CLI (`ovis add`, `ovis join`) asked for its
one-press admission (`POST /api/account/one-press`) in the last 30 seconds and the service had none
yet, or did not answer, and the PC is in no account: something here waits for **Add** on a device of
the account. It is a yes or no only, never the account asked for. It lives in memory, so a restart
ends it until the next ask. On a PC pinned to its account's signed list the answer also carries
`list` ([What a pinned PC does](#what-a-pinned-pc-does), "It says so").

A PC that cannot read its own account state answers this call, as every other, 403 `strict`. To
this PC's own window and CLI the refusal also carries `reason`: what it could not read (the file,
the folder). `ovis status --json` shows it as `problem`.
A device that waits to link reads one body, whatever the PC holds: `account` `null`, `members` 0,
`unlinked` its own id alone, every other list empty, `enrolling` and `blocked_all` false. No
mailbox is read for it, and `fresh` is ignored.

`POST /api/account/pc-proof` `{}`: `{ "server_id", "challenge_id", "proof" }`, this PC's own fresh
answer to an account service challenge (`role` `account`, as for its mailbox), which Add this PC and
`ovis login` send beside their `PUT /v1/pcs/{server_id}` at once: it is spent by that PUT and lapses
after a minute. Only this PC's own window or CLI gets one (403 `owner_only` otherwise, as
`one-press`); 503 `account_unavailable` when the service gave no challenge. The way back into an
account after `ovis logout` is so a sign-in on the PC itself.

`GET /api/account/list`: how this PC follows
[its account's signed list](#the-accounts-signed-list-on-a-pc), for this PC's own window and CLI
alone (403 `owner_only` otherwise); 404 with Step 2 off.

```json
{ "account": "acct_1", "list": "<list id>", "pinned": false, "pinned_list": null, "want": null, "standing": "in", "head": { "seq": 12, "hash": "<64 hex>" }, "devices": 3, "pcs": 2, "alarm": null, "last_read_at": "2026-11-24T01:02:03.000Z", "last_verdict": "caught_up", "differences": 0, "keys": "ready", "posted_until": null, "error": null, "reason": null, "behind": false }
```

`list` is `null` while the PC reads none. `pinned` says whether the PC lets its account's devices in
by the list alone, and `want` is the list a person at this PC named for it
([How a PC pins a list](#how-a-pc-pins-a-list)). `standing` is where the PC itself is in the list: `waiting` until
an entry adds it, `in`, `out` once one removed it, `stopped` at an entry this build cannot read.
`devices` and `pcs` count who is in. `alarm` is `fork` once the PC was shown two histories that
members signed. `last_read_at` is when its copy last held everything the service showed, and
`last_verdict` what came of the service's last word (`caught_up`, `same` for a head it already
holds, `none` when the service named no list, or why nothing was taken: `withheld`, `older`,
`stuck`, `fork`, `not_my_list`, `needs_newer_client`, `refused` with the entry's refusal).
`differences` counts what the list would have decided otherwise since this start, credentials and
devices alike (see `account.list.differs` below). `keys` is `ready`,
or `unreadable` for a keys file that will not read. `posted_until` is until when the account
service holds this PC's keys for a member to add it. `behind` is true once a member wrote an
entry this Ovis is too old to read: the PC goes on letting in whoever the list holds and putting
out whoever it removes, and signs nobody in until Ovis on it is updated. No answer holds a key.

`POST /api/account/list/pin` `{ "list" }`: a person at this PC names the list of its account, by its
id (64 of `0-9a-f`). This PC's own window and CLI alone (403 `owner_only` otherwise). It answers as
`GET /api/account/list`, after one read of that list. The PC pins the list once the list holds an
entry for the PC's own key, at this call or at a later read. 400 `invalid_list`; 409
`not_in_account` on a PC in no account; 409 `pinned` on a PC pinned to another list; 409
`list_removed` for an account whose list removed this PC; 503 `unavailable` when the PC's copy or
its keys cannot be read or written.

`POST /api/account/list/head` `{ "list", "place", "asks"? }`: a device tells this PC where it stands in the
account's signed list (`place` is the last entry a member signed in its copy, `{ "seq", "hash" }`, or
`null` before it read any), and reads where the PC stands: `{ "list", "place", "page"?, "asks"? }`.
`page` is there when the device stands at an earlier place of the PC's own history: the PC's
entries after that place, 256 at most, as `{ "list", "after", "entries", "head" }`. A device that
wants the PC's entries after another place sends that read as `asks`, `{ "list", "after" }` (`after`
null for entry 0): where the PC holds another entry at a place the device holds, or while it looks
for where two histories part. The PC then answers that read in `page`, whatever its own comparison
gives, as any member answers a read: its own entries up to its last signed one, with or without an
alarm. It answers the read only to a key its list lets in at that moment: any other signed-in row
(a pairing of this PC's own) gets the plain exchange, as if it had sent no read. A read is left out
when there is none; `asks: null` is out of form. `asks` in the answer is there when the device stands further, or at another entry:
`{ "list", "after" }`, the place the PC wants the device's entries after: never past the footing it
states beside it (an entry no member signed above its footing, which the service may have shown it,
is not counted as held), but where it goes on inside another history the device showed it, which may
reach past its footing. The place it asks for is the place it keeps: the page that answers it is
taken as the read's continuation. For another list than the
PC's, in `list` or in the device's `asks`: the PC's own `list` and `place` and nothing else. `POST /api/account/list/page` `{ "list", "after", "entries", "head" }`: the device hands
the PC entries, 256 at most, with the head they lead to; the PC takes them as it takes the account
service's pages, each entry on its own signature, and answers `{ "verdict", "asks"?, "list",
"place" }`: what came of them (`caught_up`, `more`, `asks_after` for an entry kept beside the list
that no member signed, `refused`, `stuck`, `fork`), the place it wants next from that device when
it needs an earlier one, and where it stands then. Any signed-in device may call both, one that
only watches and one in its join hold too; nothing is taken on its word. One device makes 30 of
these calls a minute (429 `rate_limited`, `retry-after`), counted under the key the PC let it in by,
whatever sessions it opens (this PC's own window and its direct clients share one count), by a clock
that only moves forward, and charged before the body is read; no caller is refused because others
called. The count lives in memory: a PC that starts again counts afresh. A page whose first entry follows no entry this PC holds, and that this PC did not ask that
device for, is refused before any of it is checked (409 `not_continued`): ask where it stands first.
On a PC that follows no list a person named, both answer every caller as before this list (403
`read_only` to a device that only watches, `account_route_denied` to an account row). 503 `not_saved`: the entries were
verified and acted on, and the PC could not save them; hand them again later. 404 `not_found` on a
PC that follows no list a person named, also for a call that began before this PC left its list
and ends after; 409 `not_my_list` for a page of another list; 400 `invalid_head`, `invalid_page`.

`POST /api/account/list/named` `{ "account", "list" }`: a device that waits to link (it paired with a
code made for the account) names the account's signed list in the place of its link
([A device that scans the PC's QR code](#a-device-that-scans-the-pcs-qr-code)). `{ "state":
"waiting", "standing", "key", "enc", "card" }` with the PC's card for that list, or `{ "state":
"added", "account" }` once the PC joined by an entry that device's key signed. Refused as a link is
(403 `link_required`, 409 `account_mismatch`, 403 `unverified_device`, 409 `pairing_ended`, 409
`list_removed`, 503 `account_unavailable` with `retry-after`), and 409 `other_adder`, 400
`invalid_list`, 404 on a PC that follows no list. A naming is the row's from the moment it arrives:
another list named by the same row meanwhile, or after, is refused 409 `pairing_ended` and spends
none of the row's tries; the same naming asked again waits for the first one's answer, and is
answered from the PC's last read of the list for 5 seconds (one read at the account service per
pairing in that time). A row that named a list sends no `link` after it (409 `list_named`): it is
added by that list or not at all.

`POST /api/account/list/add` `{ "account" }`: a person at this PC adds it to an account that keeps a
signed list ([A PC is added to the list](#a-pc-is-added-to-the-list)). This PC's own window and CLI
alone (403 `owner_only` otherwise), for the account named for this PC (409 `account_mismatch`), on a
PC in no account (409 `in_account`) that the account's list did not remove (409 `list_removed`). It
posts the PC's card and answers where the add stands; asked again while an add runs, it goes on with
that one. `GET /api/account/list/add` answers the same; the PC takes the adding device's next message
from the account service every 3 seconds while the add runs, asked or not. 503 `account_unavailable` while the account
service does not say whether the account keeps a list: nothing was started.

```json
{ "state": "number", "run": "0123456789abcdef", "account": "acct_1", "list": "<list id>", "digits": "482913", "until": "2026-11-24T01:04:03.000Z" }
```

`run` names this add to whoever started it. A poll with `?run=<id>`, and a confirm or a cancel with
`"run"`, are for that run alone: when another add took its place they answer `{ "state":
"replaced" }`, tell nothing of the other and change nothing.

`state` is `no_list` (the account keeps none: add the PC in one press), `waiting` (the card is
posted and no number shows), `number` (`digits` are on this PC's screen until `until`), `confirmed`
(the person said yes; the PC waits for its entry), `added`, `ended` with `why` (`timeout`,
`attempts` after three numbers, `cancelled`, or why the PC joins no list), or `none` when no add was
started since this start. While it is `waiting`, `number` or `confirmed`, `waiting_for_add` in
`GET /api/account/status` is true.

`POST /api/account/list/add/confirm` `{ "digits", "run"? }`: the person at this PC says the adding
device shows the same number, and which. It confirms only the number this PC shows at that moment.
Any other is answered 409 `wrong_number`: that number is shown no more, the answer names none, and
the device has to ask again. An add that is confirmed answers its state only to the number it was
confirmed with. `POST /api/account/list/add/cancel` `{ "run"? }`: the numbers differ, or the person
gave it up; the add ends and joins nothing, also when it was confirmed, and also when its read of
the list is out at that moment: the cancel, and the add's ten minutes, are asked at the binding's
write itself.

`POST /api/account/list/join` `{ "account", "list", "invite", "proof"? }`: `ovis join` with an
invite's line that names the account's list ([A PC joins the list with an invite](#a-pc-joins-the-list-with-an-invite)).
This PC's own window and CLI alone. `invite` is the invite's public key. Without `proof` it answers
`{ "state": "prove", "card": { "key", "enc", "endpoint", "list" } }`: this PC's own card for that
list, unsigned, which the line signs its proof for (`signLineProof`, the message `ovis-list-line/1`
of [account-list.md](account-list.md): this account, this PC's id, its relay key and the challenge of
that card). With that proof as `proof` it reads the list once and answers `{ "state": "waiting" }`
(the PC's card is posted, with `invite` and `invite_proof` beside it, renewals too, so a device of
the account can check by itself that the line's holder joined this PC) or `{ "state": "added",
"account" }`; 409 `line_unproven` for anything else, a redeem signature of the line included,
whatever challenge it signed. A list id alone names no list. For a join the
PC makes by itself, three calls with `"invite"`, the invite's public key: `…/join/prepare` answers
`{ "state": "prepared", "list", "seq", "enc", "seal", "wraps" }` (the place the join takes, the PC's
encryption key, the epoch its names are sealed under, and the wraps the service holds for the
invite), or `{ "state": "prove", "card" }` on a PC that is in its account or in the list already:
getting ready binds nothing, and such a PC joins only by the line's proof for its card, through
`…/join`; `…/join/body` `{ …, "seq", "sealed"? }` answers `{ "state": "body", "body" }`, the body the
PC built; `…/join/place` `{ …, "entry", "wraps"? }` places the entry of that body and answers as
`…/join`. `{ "state": "again" }` from any of them: the list moved, so prepare again. 409 with the
refusal's name where the PC joins no list (`list_removed`, `other_account`, `pinned`, `line_unproven`,
`invite_unknown`, `invite_revoked`, `invite_void`, `invite_spent`, `invite_expired`,
`invite_plain`, `invite_uses`, `not_written`, `refused`, or `behind`: Ovis on this PC is older
than what a member wrote into the list, and a PC that is behind does not write itself in); 503
`not_read` or `unavailable`.

`POST /api/account/relay-account` `{ "account" }` (or `{ "account": null }`, over a direct connection
only and only on a PC in no account (409 `in_account` otherwise), which forgets the one named: `ovis
join` puts back what it found): the account this PC asks its relay pass under while it
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

- The QR code is for a PC in no account. On a PC that is in one the tab has no button, and asks the
  PC for no code: it says which account the PC is in (the one this browser is signed in to,
  another one, or one it cannot tell while signed out), and while the relay is online shows a QR
  code of another kind, the PC's own page in the hosted app (`https://app.ovis.sh/s/<server_id>/`,
  with `#sign-in=<provider>` when the account is this browser's own, naming how it signed in). It
  carries no code, key or token, so it admits nobody by itself: the Ovis app (Android opens it as
  an app link) or the phone's browser signs in to that account, comes back to the PC's page and
  asks to join the PC as any device of the account does. A device the PC does not know yet is
  approved once, by a drive member of the PC picking its digits ([Introductions](#introductions)).
  A browser's sign-in comes back on the front page alone; the PC's ID rides in that sign-in's own
  pending record (`pc`, beside its PKCE state), and the front page goes on to that PC's page only
  when that very sign-in succeeded, before any launch. A sign-in that ends on the page itself (the
  app's sheet) joins once the account's PCs are read.
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
  is to scan. Its six-digit code is its own, never one the Tailscale tab or Pair with a code showed as digits, and
  **New code** ends it and asks for the offer again (no `POST /api/devices/pair/start`). A device
  without a camera pairs with the code under the relay tab's Pair with a code, or the PC is added by signing in on it (below).
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
   PC lists itself in the account's directory (`PUT /v1/pcs`, its relay key and relay, and as `os` the
   system the browser runs, which the account's devices show while a listing a sign-in code made asks
   to join; `ovis add` sends the PC's platform) and opens a
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
2. On any device already in the account, Add a PC lists the PC as new in the account, with
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
sign-in made in an app itself (`own_sign_in_required` for a device code's) that is fresh, or proved
with its key: made within the last 10 minutes, or older with a key proof (below; 403
`session_not_fresh` without one), within a daily cap of PC adds per account (429
`pc_add_cap`), and writes who added it in the account's safety log. It no longer asks for two-step
sign-in, which most providers' sign-ins never say: an admission by a sign-in without it is kept as
exempt, and a device that joins the account later is told of it (`admitted_before_you`). An account
service from before that answers 403 `two_step_required` for a used account (one with a PC listed,
added or removed before, or a device key ever registered, apart from one the admitting sign-in
registered itself).
The page then names the account it is signed
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

**Fresh, or proved with the sign-in's key.** Adding a PC asks for a sign-in from the last 10 minutes,
or an older one that proves the key it registered with the service right after it was made (one key
per sign-in, apart from the account key, made by WebCrypto as non-extractable and kept in this app's
IndexedDB: `signin_key`, `src/lib/account/signInKey.ts`). The service asks it of the admit, a confirm
(`PUT /v1/pcs/{server_id}` with `confirm: true`) and, where Step 2 is on, a `PUT` that lists a PC the
account does not list yet (it holds a listing to that only once it turns that rule on; until then it
judges a proof only when one is sent, and an old sign-in's listing without one goes through as
before); upkeep of a listed PC and a device code's listing ask nothing.

Only the phone app and app.ovis.sh register such a key, for a sign-in made there outside a pairing;
there a sign-in this device made more than nine minutes ago by its own clock, or one saved before that
time was kept, proves its key by itself on an add a person presses: the card's **Add** (the admit) and
**Add and pair** (the listing, and the enrollment of the pairing it just made; opening a saved pairing
signs nothing). On a PC's own window, in the desktop app, and for a sign-in made from a pairing screen
there is no such key, and an old sign-in is asked to **Sign in again**, as before. The proof: the app
asks `POST /v1/pcs/challenge` (`{}`) for `{ challenge_id, challenge, expires_in: 120 }`, a challenge
for this sign-in alone that any use spends, and sends `key_proof: { challenge_id, signature }`, the
key's ECDSA P-256 / SHA-256 signature (raw r then s, base64url) over `ovis-pc-add/1` and six fields,
each a 4-byte big-endian length and its UTF-8 bytes: the purpose (`admit` or `list`), the account,
the PC's `server_id`, the listing ID (the PC's current one in `GET /v1/pcs?include=unconfirmed`, `""`
when the account lists none), the challenge ID and the challenge (`shared/account-records.ts`
`pcAddSigningBytes`). A fresh sign-in sends none. One proof per press: a service without the route
(404, one from before key proofs) gets none, a refusal of the field (400 `invalid_request`, the
admit's body of such a service) is told as `session_not_fresh`, and a signature the service does not
take is judged by the sign-in's age alone; each ends in **Sign in again**, as before. A listing sent
again after no answer whose challenge was spent on the way (400 `challenge_invalid`) gets a new proof
once. Where the listing itself is refused for the sign-in, the same offer stands in place: **Add this
PC to my account** says to sign in again and offers it on the PC's own window and the desktop app,
then presses again with the new sign-in, and a phone's **Add and pair** shows its sign-in screen and
goes on with the same pairing after it. The proof binds the add to this browser profile, not to a
person: a copied access or refresh token alone adds no PC, but a script running in the app's page, or
a copy of the whole browser profile, still can.

**Add on another device.** The admit also confirms a listing a device code made (unconfirmed until
then), so the same admission adds a PC that signed in on the link page. Every device of the account
whose sign-in is its own shows such a PC's card, **Add this PC to your account?**, with the name the
PC gave itself, who is asking under it (the system its listing named and where the service saw that
listing come from, `asking_os`, `asking_country` and `asking_city`: "Linux · Seoul, South Korea", only
what is known), when it was listed and, for a listing that asks to join, the minutes left (at most
10). That window is the service's (`asking_until`, 10 minutes from the sign-in code that listed the
PC), and never longer than 10 minutes from the listing. Once it passed, or the admit answers 409
`listing_expired`, the card says **This request ran out. To add this PC, start again on the PC.**,
with **No** alone. An unconfirmed PC no window applies to (`asking_until` null: one a sign-in code
listed while Step 2 was off, which may be a PC in use, or a service that names none) keeps the card
as it was: **Add** and **No** for 10 minutes from its listing, then **Remove from my account**.
**Add** reads the listing again and admits nothing when it is no longer the one on the card, then
asks `POST /v1/pcs/{server_id}/admit` (with the key proof above when the sign-in is old), with **Sign
in again** for `session_not_fresh` and `own_sign_in_required`, after which the add goes on; a 409
`listing_changed`, or a `session_not_fresh` after which the listing reads as replaced (a proof signs
the listing it read), reads the listing again and shows the one there now. The admit names the PC, not the listing, so a
listing that replaces the card's in the moment between that read and the admit is admitted in its
place; it is a listing of the same PC (its id derives from the PC's key), whose name may differ. An
admit bound to the listing is the account service's to add. The card keeps a closed new-PC notice
under the admission's time as the service answered it, which the directory's row repeats. **No**
removes the listing, from a sign-in of any age: ending a listing that asks to join cuts nobody off (a
service from before key proofs asks a fresh sign-in, and **No** then offers **Sign in again**). `ovis add` on that
PC waits for that admission and takes it as above ([A PC with no screen](relay.md#a-pc-with-no-screen)).
A PC's own page that signed in on the link page does not take it: its digit wait goes on, and the
admission ends unused after its 10 minutes (the listing stays confirmed).

**Sign in again from the wait.** When the service refuses the press for the sign-in itself
(`session_not_fresh`: an old sign-in with no key to prove, or a service from before key proofs; or
`own_sign_in_required`) and the page signs in its own way
(the desktop app, the PC's own window), the wait offers **Sign in again** once. A sign-in without
two-step (`two_step_required`) gets no such offer, since the same sign-in again is refused again:
the wait says so, and that the PC is added from another device of the account (which shows a number
to approve at the PC) or by scanning the PC's QR code, or in one press once two-step is on. It signs in afresh
with the stored provider; the new sign-in is kept only for the same account and only while the wait
still runs (Stop waiting in any window of the PC ends it). The press is then made again inside that
wait: for the PC the wait listed (the PC's address must still answer for it, and nothing is listed
again), with exactly the sign-in just made, never one another tab stored meanwhile. A second refusal
leaves the wait with no offer (it offers it once) and says why that press added nothing.

The account's other devices are told: the service sends them its usual push, and at the top of the
opened Ovis a notice names the new PC (only on a device that first signed in to the account before the
PC was added, by that first sign-in's `signed_in_at`, kept on the device: a device that joins later finds it already
in the account, and a later sign-in, such as Sign in again to remove the PC, keeps it told), with **I didn't add this**, which removes it from the
account's list at once (`DELETE /v1/pcs/{server_id}`); its close button only hides it. The overview
page shows neither: it lists the PC as any other, with no quick **Open** while it is new unless this
device paired with it by hand (then **Open** is the person's own tap). A PC added under the first-PC
exception is told, once, to the first devices that join the account after it (`admitted_before_you`
on its directory entry), however much later. For 24 hours (`new_until` on its directory entry) the
PC is marked new on them: it is never selected or opened by itself and no device signs in to it on
its own. A load or a reload of its own page (where a tap on its row in My PCs leads) only puts up
its join sheet. So does a launch that picks it, asking it nothing, when this device may sign in to
it by the account's key; otherwise the launch asks to join it at once, as before. The press on that
sheet (**Ask to join**) signs in with this device's registered key first, as a load does once the
24 hours are over, so a PC that already let this device in from the account's list opens at once; a
press made before the page has read the account's PCs waits for that read. When that is refused or cannot be tried (no key
registered here, a PC that does not list this key or no longer admits it, one from before that way
in), the same press sends the join request once, with no second press, and the join's screens
follow as before; nothing tries the account's way again by itself. That join is the one a press
sent before: the PC judges it as any other, so a key the account removed is never let back in, and
a key the PC revoked comes back only when someone approves it on the PC's own window. A load past
the 24 hours whose sign-in by the account's key the PC refuses outright (`auth_failed`: it holds
no row for that key, as for a key the account service does not count as the account's yet, such as
a sign-in without two-step) puts up the same join sheet, and nothing says the PC removed this
device, unless this device held a session with that PC under the account before
([What a device remembers of its PCs](#what-a-device-remembers-of-its-pcs)). Only then does the
page say **This device was removed from (the PC). Ask again to join it.**, and its **Ask again**
asks that PC to let it join at once, as a launch does, rather than opening it by the account's key
again. A hold the PC
answers is waited out, as for any such sign-in. The account service admits the PC before the PC is
asked, so a press the PC then refuses (it restarted, was put in another account meanwhile, or was
not this PC's own window) still told the account's other devices and marked the PC new; such a PC is
not in that account (in none, or in another one it joined meanwhile), and the page waits for the
digits as before, and its notice says what to do if nobody added it. A PC bound this way leaves the
account as soon as a snapshot read finds the account no longer lists it, or its scoped completion
receipt says the admitted listing was replaced. A bare relisting is not a new admission. The PC
keeps the admission's `listing_id` in its binding and checks it with the service before a snapshot
can release account rows and before granting a new account-only relay session. A positive answer
stands for 60 seconds from when it was asked for, on a clock that only moves forward and on the PC's
wall clock (either one outside the 60 seconds ends it), so a burst of sign-ins asks once and a
removal refuses new sign-ins within a minute. A failed or negative answer is never kept, and a later
check that brings no yes ends an earlier yes for the same listing. A sign-in's `AUTH_OK` is
committed only while the answer it was let in by still stands; one that waited longer in the queue
ends with `timeout`, and the device asks again. A snapshot read asks for itself once its last page
is here and checked and its blocks are applied, the first read after one press included, and commits
only while that answer stands; a read it refuses has still denied what its pages denied. Only a
completion answer that names a strict UTC time counts as a yes, and one asked for before a later
check failed is not kept. With no new sign-in, the PC checks at its normal
five-minute mailbox poll, which is also when sessions already open end. An unavailable service, or
one that has not answered a sign-in within 4 seconds, cannot authorize a new account-only connection
and clears nothing: the device is refused with `account_unreachable` and says that the PC could not
reach the account service. A client that did not offer `account-listing-errors-1` in HELLO gets
`internal_error` instead, which forgets no key; so does one that knows none of the account codes
while its row waits for a first read the service cannot give.

While no whole read can be applied (an outage, or a listing the service does not confirm), the
binding stays, and after one hour without one every row that stands on the account alone waits for
the next read, its sessions closed: the account's listed rows, and the account's members kept in
`devices.json` (a signed `add`, a member's remote approval), those made after the hour ended too. A
pairing made at this PC is no such row and keeps working.

After a start, every `devices.json` row whose key was not approved on this PC's screen waits for
the first whole read, since a block may have been signed while the PC was off. A read that reached
its last page with every block applied, but could let nothing more in because the listing was not
confirmed, ends that wait for a pairing that is this PC's own (the ones a PC keeps when it leaves
its account) and that nothing holds back; what such a row may do for the account, and every other
row, waits on for a read that commits. With no read reaching its last page (the service down), they
wait as before.

A sign-in whose row only waits for a read (after a start, or once the hour has ended) is put off,
never refused as a removed device's: `held` with `catching_up`, or `internal_error` to a client from
before the account codes. So is, on a PC in an account that follows no signed list, a sign-in it
refuses with no receipt (a key it holds no row for, or an id with a row and a proof that does not
hold: the answer tells nobody which ids have a row) while no read of the account that began after
that id first asked here has finished (the read its sign-in starts was slower than the 5 seconds it
waits, failed, or could not start within its minute): it may be a device the account let in that
this PC has not read yet. It is `held` with `catching_up` to a client that knows the account codes,
which asks again and gets in by the row a read brings, only while a read can come (not with the
account service off, nor while the PC's waiting records do not read) and for 3 minutes from the
id's first ask at most. A read here is a pull that read the account's rows whole (or the service
reads none, `step2_off`): one whose snapshot did not commit is none. Once such a read finished
without the key, or after those 3 minutes, it is
refused (`auth_failed`) as before until a read brings its row or the PC forgets the id (10 minutes;
it remembers 512 ids, and answers a new one as before while they are all live), and so is every
unknown key from another client, on a PC that fails closed and on a PC in no account. This changes
what such a PC answers, never whom it lets in. A join a member approves from afar is asked about like a sign-in before
any device is written. A member in `devices.json` that paired its key with a code of this PC and
kept it through its link keeps its access through the hour; what it may do for the account waits.

One press binds only when the admission names its listing (502 `listing_unnamed` otherwise). A
binding made before 0.5.10 names none, and pins one from one of two sources. The completion receipt
the PC kept from its bind, when the service still confirms that listing; the receipt is kept until
the service takes it or answers 409 `listing_changed`. With no receipt, the service's own word: a
mailbox answer asked `with_listing_id` says beside `listing_id` whether that listing stands on a
one-press admission this PC took (`listing_admitted`). `true` beside a well-formed listing pins it,
and it is then confirmed through `/v1/pc/complete` as every pinned listing is, so a PC added in one
press on 0.5.9 stays in its account after the update with no add. `false`, beside a listing (a
device listed the PC again with no press at the PC) or beside none, or a receipt the service
refuses: the PC leaves the account as for an unlisting. Anything else says nothing and is never a
no: the field missing (an account service from before it), a call that fails, an answer that does
not parse, `true` beside no listing. Then the binding neither pins nor clears and is asked about
again at the next sign-in or pull; meanwhile a device that stands on the account alone is refused
`account_unreachable`, and a pairing made at this PC opens it. An admission as such is no evidence,
since a device of the account can list the PC again and admit it with no press at the PC; nor is
the account's current listing, which the PC's own mailbox pull would let it complete. While a PC
that left this way, or that
its account stopped listing, is owed its add at the PC (`pc_add_required`), a device that proves a
key the PC knew as that account's is refused with `account_readd_required` (when it offered the
feature) and keeps its key: **Add this PC to your account again**. That key is one a whole read
numbered, for the row the account's list made of it, or the key of a `devices.json` row that left
with the account (the journal's last entry of that row, `remove` with `unlisted`), and never one
removed here or by the account. It is read when the sign-in is answered, so the device whose own
sign-in made the PC ask and leave hears it too. Nobody else is told why. Before recording the
`unlisted` clear, the PC ends account-only rows and removes membership from credentials whose
recorded origin proves they paired here. Those pairings keep their keys and roles, including
after an offline restart from either state folder. A pairing by code or digits counts as local
only when this PC approved the current key; one an account member device started or approved
does not qualify. A phone that paired with this PC's first-link code and linked with the key that
code admitted counts as local too: it keeps that key and its role, and only its membership ends.
The sibling's old membership or signed add does not restore the cleared binding. An imported or
invalid origin does not qualify. Unlisting does not
lift a lock, block, freeze, Revoke or tombstone.

A wrong number ends that comparison; the person starts again from **Add** in Add a PC. A device without an account
pairs with a QR code, or with **Pair with a code** in the **Ovis relay** tab of the front page's
**Connect a PC**.

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

The sidebar of a PC (A) whose page is signed in, with A in that account, lists the account's other
PCs that A has not added yet, and adds one that would pair on its own ("Update Ovis on that PC" or
"Offline" for one that would not); **Add a connection → Ovis relay** lists no PCs. Only a member of
B approves such an add: a device of the account paired at B, not one that only opens B through the
account. A B with none refuses it before asking anyone, and A's row says that only a device of the
account paired with B can let another PC in there. An add
makes A's server a paired device of that PC (B), as **Add a PC through the relay** with a link does,
and A then lists B like any SSH PC, after a restart too. B's row is a plain watch row: A is never an
account member, holds no account key and signs nothing ([rule 3](#rules)), and it only watches B.
That row stands for every device of A at once, so B could not revoke or block one of them that comes
through A: B lets A read, never drive, until A tells B which device asks (a later change). A row made
before this keeps its role.

A's page cannot reach a relay (its `connect-src` is itself and the account service), so A's server
does the relay work, and the page only vouches for it:

1. `POST /api/machines/relay/account/check` `{ "pcs": [{ "server_id", "server_public_key", "relay", "name" }] }`
   (at most 32) answers each PC's `state`: `ready`, `outdated`, `offline` (the relay assigned the
   connection and no PC answered in time) or `unreachable` (anything else kept the answer away: the
   relay unreachable from A or turning A away, a PC that began and did not finish; the page says
   **Can't reach the PC**, never that it is switched off). A's server opens a relay
   channel to each, offers `pair-sas` with `pair-intent-pc-vouched` and `pair-pc-proof`, reads the PC's answer to `HELLO`
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
4. `POST /api/machines/relay/account/pair` `{ "ticket" }` proves A’s identity to B through the relay.
   It answers newline-delimited JSON: `{ "waiting": true }` after A sends its proof, then
   `{ "machine" }` once B admitted A and A saved it as `POST /api/machines/relay` does, or
   `{ "error": { "code", "message" } }`. Closing the request (Cancel, closing the sheet) ends the
   comparison on B and keeps nothing: the key is written only on B's `AUTH_OK`. A ticket is good for
   one comparison, for 10 minutes, and one comparison runs per key: another window's Add of B while
   one runs gets 409 `account_pc_busy`, so B is asked once. A cancel that lands in the moment between B's `AUTH_OK` and A
   saving the PC leaves B a row for a key A dropped: nobody can sign in with it, B lists it as
   the name the member checked (announced as every admission is), and **Revoke** on B removes it.

These routes are A's owner's, from a device that drives A: a window direct to A, or a device paired
with A over the relay (the hosted shell at app.ovis.sh and the phone app reach A only that way). The
admission comes from that device's own account sign-in, and a member still allows the named PC on B. A
Portal visitor and an open LAN window get 403 `owner_only`, a watching device `read_only`, so none
of them can have A pair itself with a PC they name.

A passes the same routes of a PC it lists on to it (`POST /api/machines/<B's id>/machines/relay/account/{check,start,pair}`,
`pair`'s lines as they come, held up to 200 seconds), from the devices it takes its own routes from
(`owner_only` and `read_only` as above). B answers them as any device that watches it: 403
`read_only`, as it refuses every other write that comes through A. A device adds PCs to B by
connecting to B itself.

A pins B’s relay key as before. In the negotiated vouched session A includes its X25519 public key
(hex `server_key`) alongside the per-pair P-256 key and SAS commitment in `PAIR_REQUEST`. B derives
the source server ID from the X25519 key and reserves the only vouched slot on B. Its
`PAIR_CHALLENGE.server_challenge` is a fresh serialized `server_challenge`. A answers in
`PAIR_REVEAL.server_proof` with the existing X25519/HMAC server proof, under role `vouched-pc`,
derived source ID, and the base64url Noise channel binding as `connection_id`. B consumes its
expected answer on the first reveal and separately verifies the SAS commitment. Neither a replay nor
a key supplied without proof produces a prompt. A confirms its side automatically; no digits appear.

B checks its account, current member standing, key denials, and a fresh admission naming this
P-256 key at B. A verified request counts towards the shared five joins per minute. Its
`remote-pairings` entry has `intent: "pc"`, `vouched: true`, `choices: []`, and the
`proven_server_id`; neither this ID nor the displayed name is taken from the admission. The
member’s app uses its own authenticated `GET /v1/pcs` and local completed pairing in that account:
the listed key, local pinned key, and proven ID must agree, and the service must have seen this PC
pull this account’s mailbox (a valid `last_seen_at`). A new (`new_until`), unconfirmed,
introduction-only, missing or unreadable listing offers **Deny** only. **Allow** re-reads the
listing and admission under the same sign-in, then posts `{id, decision: "approve", proven_server_id,
pc_label}` to B. The label is the name the member saw in the directory. The live member’s answer
applies only to that pending request and identity. No account add is signed. B journals the WATCH
row before publishing its usual paired-device notification; **Revoke** removes it. An older A,
B without proof support or the journal, or a digit answer from an older approver cannot admit a PC
this way. All other comparison paths still require their original digits.

### Adding a PC over SSH

From this PC's own window, signed in to the account this PC is in, Add PC over SSH can also add
the other PC (B) to that account (from Linux, macOS or Windows; B runs Linux or macOS, and a Windows
B adds itself with its number). SSH only says which machine and OS user was reached; the account's one-press admission
decides which account B may join. There, Add a connection's Ovis relay tab lists the PCs this PC can
reach (its Tailscale login's PCs and its ssh config hosts); Add opens Add PC over SSH with that host.
A row says **In your account** only for a PC that took its place there: the directory's `completed_at`
(it completed its add) or `last_seen_at` (it pulled the account's mailbox, which a PC in no account
never does). A PC only listed or admitted (an add stopped at the sign-in, say) keeps Add; one saved
here already is added on that same entry (`machine_id`), not saved a second time. Settings → Devices
and PCs words the account's PCs the same way: **In your account** once joined, **Waiting to be
added** before.

- **SSH.** Public keys only (the user's SSH config, key files and agent): no password or
  keyboard-interactive login, and no reconnect key of this app's is used or enrolled. B's host key
  must be known or confirmed in the dialog; a changed key is refused.
- **B's own Ovis only.** The job lands only on an Ovis registered by B's user that is not a bridge
  this app started (`managed_remote: false`, proved over its own credential); a bridge-only PC is
  refused, and a PC without Ovis is offered the official installer (`install_ovis`). Nothing is
  installed or started in its place.
- **Inspect.** B's registration names its recovery socket (`recover_socket`). It is forwarded over
  the job's connection into the connection's private folder; on Windows, whose ssh shares no
  connection, each request goes on an ssh of its own instead (`ssh -W` to that socket, which needs
  OpenSSH 9.4 or newer there), so nothing listens for it on the adding PC. `account_add_inspect` returns B's
  ID, public key, advertised relay, label and account. The ID must derive from the key. That socket answers every
  recovery act of B's owner, so the adding PC only ever sends `account_add_inspect` and `account_add_take` on it
  (`server/account-add-channel.ts`), and closes the forward once take answers, on any error, and after ten minutes.
  A take that got no answer (the connection dropped while B waited for its relay) is followed by one more inspect on
  a forward of its own: B in the account answers as added (`unanswered: true`, its relay not known); with no answer
  to that either, `409 take_unanswered`, and the window says B may have been added and to connect again to check,
  never that it was not added.
- **List and admit.** The window lists B (`PUT /v1/pcs/:id`) unless already listed, then admits it
  (`POST /v1/pcs/:id/admit`) with the same stored sign-in. The service applies its usual rules:
  an own sign-in, fresh or proved with its key ([In one press](#adding-a-pc)), and two-step unless the
  account was never used. On `two_step_required` the window says to add B with the number on its Ovis
  page. On `session_not_fresh` (this PC's own window registers no key, so an old sign-in is refused) or
  `own_sign_in_required` it offers **Sign in again** in place, the page's own sign-in as the Settings
  account section starts it; once signed in, the add goes on with exactly that sign-in over the same
  connection, or, when that connection ended meanwhile, over a new one to the same PC; a new connection
  whose inspect names another PC than the first adds nothing and says so.
- **Take.** `POST /api/account/ssh-add` `{job_id, server_id}`, this PC's own window only. This PC
  sends B only its own binding's account (`account_add_take`) over the same connection, while the
  job's PC keeps the generation it had at inspect. B names itself for that account and takes the
  admission on its own proof (`POST /v1/pc/admission`), as one press does. B already in that
  account answers as added (the window still sends it the take when inspect found it there, so the
  relay step below runs); B in another account binds nothing. A listing or an admission alone
  never shows as added.
- **Relay.** B is opened through its relay, which an Ovis installed over SSH never had turned on, so
  B names the account again (a relay pass refused while B was unlisted is asked for again; a failed
  write takes nothing back from the bind), turns the relay on as its own Settings switch does
  (`RelayService.start`: saved as on, and a device gate still open closes) when it is off, and waits
  up to 30 seconds for it to come online, as `ovis add` does. It turns it on when the take bound it,
  and, for a B already in the account, only when its switch was never set (`relay/state.json`
  absent): a relay its owner turned off stays off. Nothing else is turned on. A B that left the
  account, or whose relay identity was reset, while it waited answers `not_listed` or
  `identity_changed`. The take answers `{ account, relay: { phase, blocked } }`, and `POST
  /api/account/ssh-add` passes it on (`relay: null` from an Ovis from before this). The window says
  added only with `phase: "online"`; with a relay not online yet it says so and to run `ovis status`
  there; for a B already in the account with its relay off, that its relay is turned off there; with
  `relay: null`, that B is in the account and to update Ovis there to check its relay. A take that
  binds nothing turns nothing on.
- **Complete.** B asks its admission `with_listing_id` and, once bound, records its add complete
  (`POST /v1/pc/complete` with a proof scoped to that account and listing). The receipt is kept on disk
  and sent again after each pull until the service has it, so the directory's `completed_at` shows B
  added rather than only listed. The own-window one press does the same.

#### Adding a PC over SSH to an account that keeps a list

When this PC (A) follows its account's signed list, pinned and as a PC a person added (its own list
key signs with full power), the add over SSH puts B in that list, and B follows it; no account
service admission binds B, and no number is compared. The window's steps are the ones above (inspect,
list and admit with its own sign-in, `POST /api/account/ssh-add`); the rest happens on A:

1. A asks whether it may sign for the list now (pinned, in, its key a `full` signer, no alarm, not
   behind). If not, `409 list_cannot_add` and nothing goes to B: the window says to add B with the
   number `ovis add` shows on it. A PC that follows no list sends the take with no list, which B on a
   list account refuses `list_add`, and the window says the same.
2. A sends `account_add_take` `{ account, server_id, list, adder }` over the same connection: `list`
   is the list A is pinned to, `adder` A's own list key. On B's owner socket, over the person's own
   SSH session, this take is the act at B that names the list: the account service names nothing to
   B. B joins by that list only with an entry signed by `adder`.
3. B, in no account, names itself for the account, reads the list with its own proof, and while the
   list does not hold it answers `{ "state": "waiting", "standing", "key", "enc", "card" }`: its list
   key, its encryption key and its card for that list. It posts the same keys at the account service
   (`POST /v2/pc/list/keys`, the second lock of the entry). The forward stays open for this answer.
4. A checks that card itself: it is B's key's own for that list and the relay key A read at the inspect
   over the same SSH session (never one B's answer names); otherwise `409 list_not_added` and nothing
   is signed. A B whose `standing` is not `waiting` gets nothing signed either: `out` (the list put it
   out) is `409 list_removed`, `stopped` (its Ovis cannot read the list) `409 that_pc_behind`. Then A signs a `pc` entry with its own list key for exactly that card, its name sealed
   under the current epoch with the key wrapped to B's encryption key when A holds it, and places it
   with its own proof (`POST /v2/pc/list/entries`) through its Allow's keeper: one signed request per
   place, kept beside the copy (`account-list-allow.json`) across calls and a restart. A lost answer, a
   read-back that fails and the window's Add again send that very request again while A's copy shows
   the head it was signed on; another is signed only on a new head. B is in once A's own copy shows
   the entry.
5. A sends the same take again (up to five times, a second apart). B finds its entry signed by
   `adder`, carrying exactly the keys it posted at its own relay key, joins the account by the list
   (its place written already pinned, as for `ovis add`), owes its completion as any PC that joined
   by its list, turns its relay on as above, and answers `{ account, relay, list_joined: true }`
   (`list_joined` only when B did not follow that list before this take). The binding is written only
   while B's relay identity and its count of denials (Revoke all, a reset) are the ones the take
   began with, checked in the step that writes it; after the relay wait B must still follow that very
   list. An entry another key signed
   is refused `other_adder`, one with other keys `other_keys`, and B names no list.
6. A says added only once B answered that it joined and A's own copy of that very list, read again,
   holds B. B says it
   joined and A's copy does not show it: `409 take_unanswered`. A's answer to the window carries
   `list_joined: true` when B joined the list by this add, so a B that was in the account before its
   list is told apart from one the list held already. The window keeps `ssh` in its record of its PCs
   only after such a confirmed add (B was in no account, or joined the list now), never before the
   take and never for a refusal; a reply for another account or PC is "may have been added".

B already in the account from before its list names the list only once the list holds its entry
signed by `adder`: until then it reads the list on a copy that is no one's, posts its keys, and
answers `waiting`, so no later read of its own pins it on another key's entry. B already pinned to
that list answers as added at once, and A signs nothing for a B its copy already holds.

Where a run stops, the window says so, and running the add again goes on from there:

| code | where it stopped | Add again |
|---|---|---|
| `that_pc_old` | B's Ovis refuses a take that names a list: nothing is posted or signed | after Ovis there is updated |
| `list_not_added` | B posted its keys, and no entry of it is in the list (its card did not hold, or the account service refused the entry: it asks B's own post and a listing an own sign-in made or let in, so a B the window did not list is refused `not_posted`) | B posts again and A signs on the head it reads then |
| `list_unbound` | the entry is in the list, and B has not taken it (five takes found it waiting), or whether it took it could not be confirmed (a take after the placement was lost or refused): never "not added" while B is in the list | B finds the entry at the first take and joins; A signs nothing more |
| `revoked` | **Revoke all** (or a reset) ran on B while its join read the list: nothing is bound | as it was |
| `take_unanswered` | the entry may be in the list (no answer from the account service), B said it joined and A's copy does not show it, or the first take's answer was lost (nothing signed) | A sends the kept request again, or finds the entry |
| `that_pc_error` | B's Ovis answered the take with an error of its own and no code (a log it cannot read, say): its words go to A's log | as it was |
| `that_pc_behind` | B's Ovis cannot read the list it was named: nothing is signed | after Ovis there is updated |
| `list_budget` | the account service takes no more additions to the list for now (`429 entry_budget`) | later |

With no list (A not pinned), every step is the one above, byte for byte: the inspect and the take go
over the socket as `{"act":"account_add_inspect"}` and `{"act":"account_add_take","account":…,"server_id":…}`,
exactly as before. A take that names a list whose answer is lost is never followed by a second
inspect: B being in the account (by one press before the list, say) says nothing of the list.

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

Where the account keeps a [signed list](#the-accounts-signed-list-on-a-pc) and X does not follow
it, the member also names the place of the new device's entry: `introduce` takes `"list": { "id",
"seq", "hash" }` (the list's id, and the place and hash of that entry), X keeps the latest one with
the introduction, checking its form only (`introduction_invalid` otherwise), and `introduction`
answers `{ "pcs", "list" }`. The device reads the list up to that place itself; X's word adds
nothing to it. A PC that follows the list tells the device its place in `AUTH_OK` instead
([A PC allows a device into the list](#a-pc-allows-a-device-into-the-list)), keeps no `list` and
answers none: a device learns its place one way, never both.

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
- A join (`device-paired`) waits on the PC, in `join-notices.json` beside `devices.json`, until a window sees it:
  the PC's own window and each device that was here before the join open their machines event stream on the joins
  nobody has seen yet (the newest three, within a week, of devices still here), never the new device's own; a
  device paired later, a window the open LAN let in and any other window hear none. `POST /api/devices/joins/seen
  { "event_id" }` from one of those windows that may drive the PC marks it seen for all (any other gets 404), and
  every open stream is told `{ "type": "device-paired-seen", "event_id" }`. A watching window hides a join for
  itself, in its own browser storage.
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

### The account's signed list on a PC

An account may have a [signed list](account-list.md) of its devices and PCs: every entry is signed by
a member, and a member checks each one itself. The account service stores the list and decides which
accounts have one. A PC follows the list in one of two ways.

**A PC that is not pinned only reads the list.** It lets no device in and puts none out by it:
devices get in by the snapshot the account service sends, exactly as above. The list it reads is the
one the service names, which is the service's word. Every PC starts like this, and every PC of an
account with no list stays like this.

**A pinned PC lets its account's devices in by the list alone.** From then on the account service
stores and carries the list and decides nothing: it cannot add a device, cannot bind the PC to an
account, and cannot take the PC out of its account or shut out a device the PC holds. What it can
still do is said under [what the service still can](#what-the-account-service-still-can).

#### Reading

- With each mailbox pull a PC in an account asks the service for the list's head (`with_list`). When
  the head is not the one it holds, it reads the log (`POST /v2/pc/list/log`) with a proof of its
  relay key, as for its mailbox, and checks every entry: the chain, each signature, and who may sign.
  What does not hold is not taken.
- A PC that holds a list also reads its log by its own clock, every five minutes, whatever the
  mailbox says: a mailbox that names no list, or does not answer, hides no entry. A PC whose account
  never had a list asks for no log.
- The list id is the account service's word. One of which the PC has verified no entry gives way to
  the id the service names next; one of which it has verified an entry stays, and another id is
  reported (`not_my_list`).
- The copy is saved in `account-list.json` in the state folder (readable by your user only). It holds
  the entries and what they add up to, and nothing secret. It belongs to one relay identity and one
  joining of the account. A restart goes on from the saved copy, which the PC holds before the
  service has answered anything. A read that was on its way when the PC left its account writes
  nothing and posts nothing.
- The copy keeps the latest hour the PC's clock showed. A decision that turned on the hour (a device
  past its time) is saved before it is acted on, so a clock set back after a restart counts for no
  less.
- The PC has two keys of its own for the list, in `account-list-keys.json` (readable by your user
  only): one that signs and one that the names of the list are encrypted to. They are made for the
  PC's relay identity and go with it: **Reset relay identity** removes them, and the PC it becomes
  makes new ones. They are never logged and never sent. One Ovis at a time makes them (a lock file
  beside the keys file), and every Ovis uses the pair it then reads from disk: several servers on
  one state folder end with one pair. Keys whose making began before a reset are not written after
  it. A keys file that will not read is not
  replaced by itself; the PC says so in `GET /api/account/list` and reads no list until the file is
  restored or the relay identity is reset.
- While the list does not hold the PC, the PC posts its two public keys and its
  [card](account-list.md#a-card) to the account service (`POST /v2/pc/list/keys`, with the same
  proof), so that a member can add it. A post lasts ten minutes and is renewed, with each mailbox
  pull and by the PC's own clock.
- A PC that is not pinned writes one line to its log, `account.list.differs`, where the list would
  decide otherwise than the snapshot (a device only one of them lets in, a device the list lets in
  only to watch or only until a time that has passed, a PC the list does not hold), with what each
  decided and no key or name. Each difference is written once per start. `of` says what differs. `credential`: a
  key only one of the two holds, which may be one phone under two keys (the snapshot names a phone
  by the key of its sign-in, the list by its member key, and the PC knows no link between the two).
  `device`: a key both hold that the list would let in otherwise, or the PC's own place in the list.

#### How a PC pins a list

A PC pins a list when both of these hold, and never on the account service's word:

1. **A person at this PC named the list.** There are four ways, each begun at this PC's own window
   or CLI:
   - a number this PC and the device that adds it both show, which the person says are the same
     ([A PC is added to the list](#a-pc-is-added-to-the-list));
   - the line of an invite, which names the list, given to `ovis join` after the person confirmed
     the account ([A PC joins the list with an invite](#a-pc-joins-the-list-with-an-invite));
   - the QR code this PC showed, scanned by a device of the account, which names the list over the
     pairing that code made ([A device that scans the PC's QR
     code](#a-device-that-scans-the-pcs-qr-code));
   - the list's id (`POST /api/account/list/pin` `{ "list" }`), on a PC already in the account;
   - over SSH from another PC of the account that follows the list, on this PC's owner socket: the
     take names the list and the key whose entry adds this PC ([Adding a PC over SSH to an account
     that keeps a list](#adding-a-pc-over-ssh-to-an-account-that-keeps-a-list)).
   Nothing is pinned by naming it. Until the PC is pinned, naming another list replaces the first.
2. **That list holds an entry that adds this PC's own signing key at its own relay key**: a `pc`
   entry a member signed, or a `join` entry of an invite a member placed.

A PC in no account joins its account by the list: its place in the account is written already
pinned, once the PC has read the list with its own proof and found its entry. At no moment does
such a PC let a device in on the account service's word. For an account that keeps a list, one
press, and an add over SSH whose take names no list, are refused `list_add`: the account service's
admission binds no PC to it. Whether an account keeps a list is asked of the account service, so a service that says it
keeps none still has a PC added in one press, to follow the snapshot as before; the account's
devices then hold no entry for that PC. A device that pairs with the PC itself (a QR code, digits
approved at the PC) and sends its `link` still brings the PC into its account as before, with no
pin; a device that follows its account's list names the list over that pairing instead
([A device that scans the PC's QR code](#a-device-that-scans-the-pcs-qr-code)).

**Do not pin a PC that older apps use**: an app from before this release opens a PC through the
account with the key of its sign-in, which a pinned PC lets in no more
([How an app signs in](#how-an-app-signs-in-to-a-pinned-pc)), so such an app is shut out of the PC
until it is updated. The app signs in with its list key from this release on
([What a pinned PC asks of the app](account-list.md#what-a-pinned-pc-asks-of-the-app)). One press
never pins: the list it would follow would be the one the service names.

The pin is one-way. It ends only by an act at the PC that ends its place in the account (**Revoke
all**, **Reset relay identity**), or by an entry of the list that removes this PC. Nothing the
account service says ends it.

A pin outlives the PC's own settings: started with Step 2 turned off here
([Turning Step 2 off](#turning-step-2-off)), a pinned PC still follows its list, and says so in its
log. So does the word that the list removed this PC: with Step 2 turned off, nothing links the PC
back into that account under the relay identity it had. Where a PC has two state folders (the old
and the new name of one), **a pin is never taken from the other folder**: the list knows this PC by
the keys in the folder that pinned, and that folder holds the copy and what it owes. A folder whose
other folder holds a pin it does not hold itself is closed: it lets only this PC itself in, writes
nothing on that start (no file of either folder changes, and nothing is merged between them), and
says which folder holds the pin (to this PC's own window, and in `ovis
status --json` as `problem`). Use Ovis from that folder. The folder that holds the pin goes on as it
was. A folder of another PC (another relay identity) changes nothing here. A copy made for other
keys than this folder holds is dropped, and the list is read again with the PC's own. A removal of the PC by its list that
either folder holds stands in both, whatever the other holds for the same binding.

The pin is kept with the PC's place in its account (`account-pc.json`), not with its copy of the
list. While that file holds a pin, or that the list removed this PC, it is written as version 2:
an Ovis from before the list reads version 1 alone, so a PC put back on such a release refuses the
file and lets nobody of the account in, where it would otherwise drop the pin in silence and go by
the account service's word again. A file with neither is version 1, as before.

Two Ovis servers can run on one state folder, so what one holds in memory may be older than the
file. Every write of `account-pc.json`, the other folder's included, is one turn under a lock file
beside it (`account-pc.json.lock`): take the lock, read the file, reconcile, write. A pin the file
holds, and its alarm, are never lost; a clear the file holds is never lost, and a binding it holds
cleared never comes back from memory; a write about something else leaves the file's binding as it
is; the account service's word clears no binding the file holds pinned; a number given for an
admission is one the file had not given. A write waits half a second for the lock and takes over
one that is ten seconds old; a lock that cannot be deleted ends the write with an error after that
wait, and hangs nothing. A server also takes in what the file holds before it acts on an unlisting
and every five seconds, so a second server decides as a pinned PC, or as one that left its account,
within seconds of the first one's write. Looking costs no read while the file is the one this
server last read or wrote, and tells nobody of a change that is neither the binding nor the pin
(a listing another server recorded cancels no approval that waits here). A file that is there and
cannot be read, or does not read as this PC's account state, ends the write with an error: only a
file that is not there counts as no document. Nothing is written without the lock.

A server that learns of a pin this way does what the server that pinned does: it ends its sessions
under an account's id with `auth_changed` and decides by the list. A server that follows no list
(it was started with Step 2 turned off, before the pin) looks at the file every five seconds too,
and then closes its account part: no session and no sign-in under an account's id, no account
record, and its account status says why. Pairings this PC made itself under ids of their own go on
there. Starting that Ovis again makes it follow the list.

**An older Ovis that is already running.** A release from before the list that is started on a
pinned PC's folder refuses the file. One that was already running when the PC pinned still holds
the version-1 document in memory, and its next write puts that document over the pin. So stop every
older Ovis on this PC before the PC joins a list.

A pinned PC whose `account-list.json` is gone is still pinned: it reads its list again from
the start, and lets no device of its account in until that read shows the PC in the list. What it
had seen removed stays out, whatever the service shows then. An `account-list.json` that is there
and will not read is not replaced by what the service shows: the PC lets no device of its account
in, and says why in `GET /api/account/list`, until the file is restored, or removed and Ovis started
again. On a PC that is not pinned the file is only a copy, and one that will not read is read again.

#### What a pinned PC does

- **Its account devices are the list's.** A device signs in with the key the list holds for it
  (`AUTH` as `accountDeviceId(server_id, key)`), and is let in as the role its entry says, `drive`
  or `watch`, and only before its `until` by this PC's clock. A session open at that second closes.
  Every account device that the snapshot had let in and the list does not hold goes at the pin.
- **A device the list lets in after the pin still waits its ten seconds** and is announced on every
  older device, as a device the snapshot let in was. The devices the list held at the pin wait for
  none: a person at this PC has just taken that list as the account's.
- **A device that hands its place on keeps its row.** In a list an account that was in use moved
  onto ([account-list.md](account-list.md), "An account that was in use"), each device is carried in
  by the key of its sign-in and hands its place to its account key by an entry of its own. This PC
  moves that device's row to the new key, with its name, its age and its admission: no new hold and
  no notice, as it is the same device (a hold it is still in goes on). Its session under the old key ends with `auth_changed`, and it
  signs in again with the other. The old key is no removal: nothing is kept against it.
- **A removal of this PC's own follows the device.** A device this PC holds a removal against (a
  Revoke here, a signed removal or block it applied) stays out by whichever key the list holds it
  by, and by the key a sign-in key it put out vouched for (`heldOut`). A device the list removes
  is kept as removed here by every key it has been in the list by. A device this PC put out by a
  sign-in key it took after the move stays out by its account key too: the PC reads the account's
  links from the account service before it pins and while it holds a removal (each signed by both
  keys). Not covered: a service that withholds that link.
- **A carried key that never handed over** (an app from before the list, still on the sign-in it
  was carried in by) is let in only while the account service's last whole snapshot of this run
  names it too. It is local and undone by the same word: no device signs a removal because the
  service lists a key as gone. After a start the PC waits for one whole read before it lets such a
  key in, as for the rows the snapshot made before the list.
- **A session opened through the account is the list's to answer for, and nothing else's.** Its id
  is `accountDeviceId(server_id, key)`, the only id an app that opens the PC through its account
  knows. Such a session is let in when this PC's copy of the list holds that key as a device that
  is in; as the role the list gives it; until the list's `until`; and not while an alarm holds the
  key back or the copy cannot be read. A row of this PC's own devices under that same id gives it
  nothing more and nothing else, whoever wrote it and whenever: a member's `add` from before the
  pin, a join a member or this PC allowed by digits. After the pin such a row counts only while the
  list holds its key. That is asked in one place, where a session takes its device, so it holds
  for every way such a row comes to a session: a sign-in, a pairing confirmed on this PC's screen
  that reuses the row, a comparison by digits. The list is asked only of a key the session proved.
- **A pairing made at the PC is the PC's own business.** A pairing by code has an id of its own,
  and under that id the device signs in as it did, with the role the PC gave it: the list's `watch`
  and `until` do not reach it; removing the key from the list does. The same key also opens under
  its account id, as the list says.
- **A device the list put out is out for good.** Its sessions close, and the PC keeps the removal
  as it keeps a member's signed `remove`: every row of that key goes, a pairing this PC made itself
  included, and nothing brings that key back, a pairing at this PC included: a list's removal is
  the same kind as an account's removal before it. The device comes back as a new one, with a new
  key: it signs in again, which makes a new key, and is allowed into the list again, or is paired
  by a person at this PC.
- **Before a session opens, the PC reads the list** when its last full read is older than 30
  seconds, and the sign-in waits for that for 5 seconds at most, counted once from its start; then
  the PC decides on its copy as it is. That holds for every sign-in, a device this PC paired itself included. With a session open
  the PC reads every 30 seconds, otherwise every 5 minutes.
- **When the account service is away, the PC lets in the devices its copy holds**, for as long as
  that lasts and after a restart too. The wait for a whole read of the account service (after a
  start, and after an hour without one) does not apply to a device the list lets in, also one this
  PC had taken in on a member's word before it pinned.
- **Two histories that members signed raise an alarm** (`alarm: "fork"` in `GET /api/account/list`).
  From then on the PC lets in only the devices it held when the alarm rose, and still takes every
  removal. Nothing clears the alarm but an act at the PC that unpins it. The alarm is kept with the
  pin (`account-pc.json`): a PC whose copy of the list is lost reads one history again, which says
  nothing of whom the alarm held back, so it then lets no device of its list in until it is
  unpinned.
- **A device's time (`until`) has a timer of its own.** Its session closes at that second, not at
  the next tick and not behind a read of the account service. The hour that showed it is saved
  before the PC acts on it, so a restart with the clock set back does not let the device in again.
- **A removal is enforced whether or not the disk takes it.** When the copy cannot be saved, the
  PC still puts out what the entry removed, says so (`error` in `GET /api/account/list`), and
  offers the copy to the disk again every few seconds. A page a device handed over is answered as
  not saved until then.
- **A removal is acted on as soon as its page is checked.** Each page of a read reaches the copy
  the PC decides on, and closes the sessions it ends, before the next request goes out: a service
  that answers the next page slowly holds back nothing it already showed. A page a member hands
  over waits for no request at all, only for a page that is being checked (milliseconds). What
  the list removed is kept as removed also when the same read then stops at an entry this Ovis is
  too old to place.
- **What the PC denied and could not save does not come back by a restart.** Before a pinned PC
  acts on a denial, it writes a mark beside the copy (`account-list-owed.json`) that names the
  denial itself: the key a removal put out and the place of that entry, or the key whose time
  passed, that time and the hour the PC's clock showed. The mark is removed only once the write
  that makes it unnecessary is on disk: the copy that reaches the removal and shows the key out,
  and the removal's own record, written in that run; the copy that holds an hour at or past the time. At a start the
  mark is read first, and without the copy (also when the copy is gone). While it stands, the
  keys it names are refused, whatever the copy says. A PC that starts on a copy that does not
  reach a removal the mark names lets no device of its list in until a read has reached that
  place; a head the PC already held discharges nothing. It does not stay closed to everybody:
  once a read has reached the head the account service shows, the others are let in again, and
  the keys the mark names stay out (a page the PC refused, a tail the service withholds and a read
  that ran out of its requests are no such read). A removal the mark names keeps every row of that
  key out, a pairing this PC made itself under an id of its own too, as the removal's record does
  once it is written; a time that passed concerns the list's rows alone. A denial that still stands after an hour is said in the status. An
  ordinary restart, with the copy saved, lets the list's devices in with the service away as
  before. Left open: a disk that takes no write at all, the mark included, and a stop before it
  does.
- **A PC the list removed leaves its account**, as one its account stopped listing did before: its
  account devices go, and the pairings it made itself stay. What the list removed before it removed
  the PC is put out first, in the same read: a removed device keeps no pairing of this PC's own. It
  keeps that it was removed
  (`account-pc.json`), and joins that account again on no path (a press, an add by the list, an
  invite, an add over SSH and a device's link are refused `list_removed`) until **Reset relay
  identity** makes it a new PC, which is added as one. `ovis add` at a terminal offers both as one
  step: **This PC was removed from this Ovis account. … Add it again as a new PC?** A typed `yes`
  resets the relay identity, lists the new PC and goes on with the add; anything else changes
  nothing. The reset names the relay identity the question was about (`POST
  /api/relay/reset-identity` `{ "removed": { "account", "server_id" } }`), and resets that one
  alone, while the PC is still in no account (409 `identity_changed`, `not_removed`, `in_account`):
  a yes to an old question, typed after the PC was reset and added again, or after it joined another
  account with the same relay identity, resets nothing. It is asked before the reset begins and again
  in the turn that resets, from the binding's file under its lock, so a join that lands while the
  relay closes is seen too. Nothing does this by itself, and no run without a terminal does it: a removed PC never
  comes back unless a person at it says so. The key the list removed stays out for good.
- **Another PC of the account** ([Adding a PC of your account](#adding-a-pc-of-your-account)) is
  taken as one only when the list holds its relay key, asked when its comparison begins and again
  in the turn that writes its row.
- **Who may let a device in from afar.** A member of this PC's own devices approves a join only
  while the list holds its key to drive with full power, read from the copy at that moment: what
  may add a device to the list may approve a join. A row the list does not hold approves nobody.
- Devices paired with this PC itself by a code keep their pairing and their role: that is this PC's
  own doing. A join by comparing digits is still decided by a person, and makes a row under the
  account's id for the key. The session it was compared on opens nothing by that row: it ends
  (`account_list_required` to a client that offered `account-list-1`, else `auth_failed`), and the
  device gets in by a sign-in once the list holds that key.
- **Another PC of the account** that is vouched for is the list's to answer for by its relay
  key. Its row records the relay key the join proved (`vouched_pc`), and on a pinned PC it is let
  in, to watch, while the list holds that relay key as a PC that is in: at its comparison and at
  every later sign-in. Its session ends when the list removes that PC, and it signs in no more. A
  row of such a PC from before this was recorded names no PC and opens nothing on a pinned PC.
- **It says so.** For a pinned PC, `GET /api/account/status` carries `list`: `pinned_list` (the
  list's id; `GET /api/account/list` has it under the same name, also when the PC holds no copy it
  can read), `standing` (where the PC stands in it) and `reason`, one sentence a person can act on when
  the PC lets no device of its account in, or nobody new: its copy cannot be read; an alarm (with
  what to do); a lost copy with an alarm; stopped at an entry this Ovis is too old to read ("Update
  Ovis on this PC"); reading the list again after its copy was lost; started with a change it had
  acted on and not saved. `GET /api/account/list` carries the same `reason`, and `ovis status
  --json` both (`list`). Null while the PC follows its list as usual.

#### A PC is added to the list

A device of the account adds a PC by signing a `pc` entry for the PC's key. Two things must be
sure: that the key the device signs is this PC's, and that the list this PC pins is that account's.
The account service carries the messages between the two, so neither may rest on its word. A number
that both screens show settles both, each by its own confirmation:

1. **The PC posts its card** (`POST /v2/pc/list/keys`): its two public keys, with its own signature
   over them, its relay key and the id of the list the account service named to it. That id is only
   the service's word so far.
2. **The device commits** (`POST /v2/lists/{list}/posts/{endpoint}/attempt`): it picks a nonce and
   sends only a commitment to it, with its own key.
3. **The PC answers with a nonce of its own** (`POST /v2/pc/list/attempt`), picked before it has
   seen the device's. It answers one commitment once, and at most three commitments in one add.
4. **The device reveals its nonce.** The PC checks that it opens the commitment; only then is there
   a number. Both show six digits made from the PC's card, the device's key and the two nonces
   (`shared/relay-pair-sas.ts`, bound to the hash of the card).
5. **The person compares them, and says so at the PC**: **The numbers match** in the PC's own
   window, `yes` at `ovis add` in a terminal, or `ovis add --confirm <the number>` where nobody can
   type at that command. Only this names the list. The yes carries the number, and confirms only
   the number on the PC's screen at that moment; a yes to any other number ends the one that shows.
6. **The person presses Add on the device.** That says the key on the card is this PC's: the device
   signs the `pc` entry and places it.
7. **The PC joins** once it reads, in the list the person confirmed, the entry that adds it,
   signed by the device whose number the person confirmed. An entry another member signed joins
   nothing (`other_adder`).

A service that stands in the middle cannot make both screens show one number: whatever it changes
(the card, the list, the device's key) changes the digits on one side, and it had to commit before
it saw the PC's nonce, so it gets one try in a million, and each try is a number on the PC's screen.
A service that names the PC a list of its own, and adds the PC there with a key of its own, shows
the PC a number that no device of the account shows; nobody says yes to it, and the PC joins
nothing. The person's yes at the PC is what makes this hold: without it the service's own list
would be as good as the account's.

- A number lasts 120 seconds from the PC's answer. A new commitment replaces it: the PC never shows
  two, and a yes typed under the old one confirms nothing.
- An add lasts 10 minutes, confirmed or not: an entry that arrives after them joins nothing. The
  PC asks the account service for the device's next message, and after the yes reads its list, every
  3 seconds while the add runs, by itself: a window that confirmed and was then hidden or closed, or a
  terminal gone, does not hold the add up (a read by its own window or `ovis add` within those 3
  seconds asks nothing more). Both lifetimes are counted by a clock that only moves forward, so
  setting the PC's clock back gives neither more time.
- `ovis add` that stops (Ctrl+C, an error) gives its add up at the PC: a yes confirmed before joins
  nothing once the command is gone.
- **No** at the PC (Enter at `ovis add`) ends the add. Nothing is joined, whatever the list then
  holds.
- After the yes the PC shows no further number, and reads the list until its entry is there. The
  ten minutes and a No are asked again at the binding's write itself: a read of the list that was
  out when either came binds nothing, and a poll that was out answers no commitment. An add whose
  PC is in by then (its first copy reached the disk late) ends `added`, not `timeout`.
- A PC that comes into its account another way while its add runs (a device's `link`) is pinned by
  the add on the same rules: only the entry the confirmed adder signed counts, and nothing of the
  add is kept as a want once it ended. `ovis add` toward an account with no list makes no list keys.
- Two Ovis servers on one state folder that join at once: the binding the file holds when the
  second writes stands. The second goes by that binding and the copy the first saved, writes
  nothing over it, and says it joined only once that copy shows the PC in.
- An account with no list is added as before, in one press. A PC asks the account service whether
  the account keeps a list (`POST /v2/pc/list`); while that goes unanswered it waits, and binds
  nothing. An account that made its list since the PC last asked takes it in one press no more: the
  account service refuses the take (`409 list_add`), and the PC forgets what it had heard.

`ovis add` does all of it at a terminal: it lists the PC, shows the number with the question, and
finishes when the PC is in the account. Where nobody can type (a script, a coding agent) it prints
the number and the exact command that confirms it, `ovis add --confirm <the number>`, and confirms
nothing itself; an agent adds a PC in one step with an invite instead.

**Add this PC to my account** in the PC's own window goes the same way
([`src/lib/account/addThisPc.ts`](../src/lib/account/addThisPc.ts) `addByList`): it lists the PC,
names it the account, then asks the PC to start this add (`POST /api/account/list/add`) before any
one press. Only where the PC says the account keeps no list (`no_list`, or a PC that follows none:
403, 404, 405) does the one press follow, as before. With an add under way the screen waits as a
pressed one does; the number and **The numbers match** come in the window's own prompt. The wait
asks the PC where its add stands: an add that ended (the numbers differed, three numbers, a refusal)
ends the wait and says why, and one whose ten minutes ran out is started again while the wait's
30 minutes run. **Stop waiting** gives the add up by its `run`. A 503 `account_unavailable` started
nothing and tries no one press: the screen says the account service could not be reached, and the
button asks again; `account_mismatch` and `list_removed` say their own sentences.

#### A PC joins the list with an invite

The line of an invite names the account's list (`shared/account-list-join.ts`). The person at the
PC confirms the account before anything is sent, so the line is what names the list here, and no
number is compared. The line never leaves `ovis join`: not to this PC's server, not into a file.

- **An invite a person adds a PC with.** The PC redeems the invite. `ovis join` then shows the PC
  that it holds the line: the PC hands over its own card for the list, and the line signs its proof
  for that card (`ovis-list-line/1`: this account, this PC, that list, those keys). It is a message
  of its own, never a redeem signature, whose challenge an account service chooses. Only then does
  the PC post its card, with the invite and that proof beside it, and wait: a device of the account
  checks the proof itself before it offers **Add** for a PC that joined with its invite, and **Add**
  signs the `pc` entry. The PC joins once it reads that entry, in a list that holds the invite
  (`POST /api/account/list/join`).
- **An invite a PC joins with by itself.** Nobody else has to be awake. The PC redeems the invite,
  reads the list, and builds its own `join` entry from its own keys, with a card it signs for this
  list, its relay key and that invite. `ovis join` signs that body with the line's key, which signs
  nothing but the join of its own key on its own list, and hands it back; the PC places only the
  entry whose body it built (`POST /v2/pc/list/entries`, with its proof), then joins once its own
  copy shows it. The names' key, which the account wrapped for the invite, is opened by the line
  and wrapped again for the PC, and the PC's name is sealed under it.
- A PC joins by itself only with an invite the list holds as open, made for that purpose, and for
  one PC (`uses` 1): one that lets several PCs in is refused `invite_uses`, and one a person adds a
  PC with `invite_plain`.
- Getting ready to join binds nothing. A PC the list holds already (an earlier run's join that
  placed, or a device's Add), or one in its account already, writes no join: `ovis join` has the
  line sign its proof for the PC's card instead, and the PC joins by that, as with an invite a person
  adds a PC with.
- **When it is in.** A PC that joined by its list tells the account service its add is complete
  (`POST /v1/pc/complete`), once, so the account's page stops showing it as only listed. The listing
  that names is the one its own mailbox pull names, never an admission: an account with a list takes
  none. What it owes is on disk from the join on (`account-completion.json`, until a pull names the
  listing, then as the receipt), so a PC that stops before its first pull sends it after its next
  start; a binding that ended meanwhile owes nothing. Nothing waits for it. Only a final refusal of
  it drops it, and nothing else: the list says the PC is in, not the listing. A 429, a lapsed proof
  (401), a timeout or a 5xx keep it for the next pull.
- A PC that joined by itself is in the list and signs for nothing: it lets no device in
  ([A PC allows a device into the list](#a-pc-allows-a-device-into-the-list)).
- A line that names no list adds a PC nowhere in an account that keeps one (`list_add`): the
  account service's word is not taken. A line that names a list is refused before anything is sent
  on an Ovis that follows none.
- A list that moved between the PC's body and its placement is read again, and the join built and
  signed again.

#### A device that scans the PC's QR code

`ovis add --qr` shows a QR code that carries a code made for the account. A device that scans it
pairs with the PC over a channel that code keys, which the account service is no part of. So no
number is compared: what the device says over that pairing is the device's own word, and the card
the PC answers with is the PC's own.

- The device sends `POST /api/account/list/named` `{ "account", "list" }` in the place of its
  `link`. Every rule of a link holds for it: the code was made for that account, the PC is in no
  account, and the account service vouches for the device's key
  ([The account's word](#the-accounts-word)). A device that fails one is turned away as its link
  would be. So scanning the code brings a PC nowhere that a link would not.
- The PC answers `{ "state": "waiting", "key", "enc", "card" }`, its card for that list, and posts
  the same card to the account service. The device checks the card, signs the `pc` entry with the
  key it paired with, and places it.
- The device calls again. The PC reads the list and joins when the list holds its entry **and the
  key that paired signed it**: `{ "state": "added" }`. An entry another key signed is refused
  `other_adder`. The PC writes no member for the pairing: its devices are the list's.
- A device names one list. A second list from the same pairing is refused `pairing_ended`, also
  while the first naming is still asked about, and spends none of its tries. Its first naming is
  one of its five tries, as a link is; asking again where it stands is not.
- Once it named a list, the pairing has no other way in: a `link` it sends after is refused
  `list_named`, and it stays a pairing that waits until that list holds the PC by its key. Ending
  the naming is ending the pairing (scan the code again).
- Whoever can read the PC's QR code, and is a device the account service vouches for, can add the
  PC to a list that names that account. That is what the QR code is: keep it to yourself, as
  before.

#### A PC allows a device into the list

A device joins an account that has a list by an entry a member signed. A PC that a person added to
the list is such a member, so a person at that PC can let a new device in: the PC signs the
device's entry with its own list key. This is the join by comparing digits
([Joining through the account](#who-may-admit-a-device)), decided as before in the PC's own window
or by the digits typed at `ovis approve`; what changes is what the approval writes.

- **The PC says whether it takes a card.** It selects the feature `account-list-allow-1` for a join
  while it is pinned to its list, is in it, its copy is usable and no alarm stands. A PC that
  follows no list does not select it, and the join is then the PC's own pairing, as before.
- **The device sends its card.** With the feature selected, its `PAIR_REQUEST` carries `list_enc`,
  its encryption key, and `list_card`, its [card](account-list.md#a-card) for the list: its own
  signature over its key, that encryption key and the list id. `public_key` is the key the list
  will hold for it. A PC that did not select the feature ignores both, whatever form they have: an
  app that sends them to a PC with no list pairs there as it always did. A PC that selected it
  refuses members out of their form (`protocol_error`). `PAIR_CHALLENGE` then names the list the
  PC follows (`list`), so the device can stop when its card names another.
- **The person decides as before**: the digits compared in the PC's own window, or typed at
  `ovis approve`. Nothing is signed before both sides said the digits match. `GET
  /api/relay/joins` marks such a join `list`, and `ovis approve` then says that the approval was
  received, not that the device is let in: it is in once its entry is in the list. On a PC whose
  Ovis is behind the list the join is marked `list_behind` too, and `ovis approve` says that the
  device was not let in and that Ovis on this PC needs an update. On a PC that joined by an invite,
  which signs for nobody, it is marked `list_not_signer`, and `ovis approve` says that the device was
  not let in and to allow it on another device of the account. On a PC that came into the list as its
  account moved and holds no key of its own in it yet, it is marked `list_needs_keys`, and `ovis approve`
  says so, and that `ovis add` on this PC gives it its keys. A join of a key this PC itself keeps out (a
  block here, which closes the PC to every key newer than its target, whatever the list holds) is
  marked `list_held`, and `ovis approve` says that the device is not let in here until that block is
  lifted, and where. A PC that follows no list marks a first or members join of such a key
  `list_held` the same way, and a device approved here anyway hears `list_held_here`, not that
  nobody approved it. A join into the account on a pinned
  PC from an app that knows no join into a list (it did not offer `account-list-allow-1`: an Ovis older
  than 0.5.10) is marked `list_unknown`: nothing lets it in here, so `ovis approve`, and `ovis add`'s
  wait for a first device, ask nothing for it and say to update Ovis on that device and ask again.
  The PC's own window shows it with the same words and no Allow or number field, and
  `POST /api/relay/join` answers an approval of it `409 list_unknown` and leaves it waiting (a
  decline still ends it, first join or not). A member's approval from another device
  (`POST /api/relay/pairing`) is refused the same way, the right digits included: the waiting
  list marks such a join `list_unknown`, and the member's card says to update Ovis on that
  device instead of offering Approve.
- **The PC signs only for a person at this PC**: an approval from its own window or its local
  command. An approval from another browser that drives the PC, and a member's approval from afar,
  sign nothing here. A PC that joined by an invite is in the list and signs for nothing either.
- **The PC signs and places the entry.** A `device` entry with full power and the role `drive`,
  written through the list's own writer, which signs nothing that would not count: a card that is
  not that key's for this list is never signed over. It is signed by this PC's own clock as it
  reads now, never an hour the account service names, and never the hour the PC saved: that one
  lets in and refuses, and decides nothing that is signed. That clock is held against the list's
  own time alone: an entry is never dated before the one it follows. The device's name is sealed
  under the list's key, and that key
  is wrapped to the device, when the PC holds it; without it the device is let in all the same and
  reads no names yet. The PC sends the entry to the account service (`POST /v2/pc/list/entries`,
  with its proof), which places it only while a sign-in of the account has claimed that key: a PC
  alone, or whoever drives it, lets in no device the account's owner did not sign in on. What this
  PC itself holds against the key, its own place in the account, and whether its copy as it stands
  then still lets it sign (no alarm, nothing it is too old to read) are asked again before each
  submission, and once more when the PC's proof to the service is made (a request of its own),
  right before the entry leaves this PC.
- **The device is in when the log shows the entry**, never on the service's answer. Its row on
  this PC waits for no join hold, also when a read made that row a moment before. Its `AUTH_OK`
  names the list and the place of that entry (`list`: `id`, `seq`, `hash`), over the session whose
  digits were compared: the device takes the list id from there and reads the list up to that
  place. That session serves nothing else (403 `sign_in_required` for every call), whichever row
  this PC holds for that id and whatever role that row carries (the list answered for the key; a
  row of this PC's own under the account's id gives it nothing, here as at a sign-in): the key was
  sent with the comparison and never signed with, and the device signs in with it. A key this PC already holds by a pairing under an id of its own gets
  its receipt the same way, over that pairing's row, and then signs in with its list key over that
  row; the answer names the account's id for the key.
- **When the entry does not go in**, the join ends as any join that was not let in (`auth_failed`),
  and nothing is written in its place: no pairing of this PC's own stands in for the list. The
  refusal's `message` says which cause it was: `list_not_claimed` (no sign-in of the account
  claimed the key), `list_service_away` or `list_head_lost` (it could not be placed in time),
  `list_not_in` (a member allowed it and no entry reached this PC), `list_pc_behind` (Ovis on this
  PC is older than what a member wrote into the list, so the PC signs nobody in until it is
  updated; a device of the account can still allow the newcomer), `list_not_signer` (this PC joined
  by an invite and signs nobody into the list: a device of the account allows the newcomer),
  `list_needs_keys` (this PC came in as its account moved, with no key of its own in the list yet:
  the same, and `ovis add` on it gives it its keys), `list_held_here` (this PC itself keeps that key
  out, by a block here: the device may be in the list and opens the account's other PCs, and opens
  this one once the block is lifted), else `list_refused`. One entry
  is signed for one place: the same signed entry is sent again while this PC's copy shows the same
  head (a lost answer, a 5xx answer that says nothing of the entry, a read that failed, a service
  that asks to try again or is reading the list again, after the time its `retry-after` names),
  and another is signed only once the copy shows a new head. An answer that does not say whether
  the entry was placed is no refusal: the log is read before the device is answered. Four tries in
  all. The signed request is kept beside the copy (`account-list-allow.json`, mode 0600) until the
  copy is past the head it was signed on: another Allow at that head, of the same device or of
  another, and one after a restart send those very bytes first and sign nothing else there. An
  entry that cannot be kept is not sent. Any other refusal ends it at once, and the kept request
  with it, since the service itself said that it placed nothing: a budget, a service that changes
  the list for nobody (`list_stopped`), a key this PC itself keeps out.
- **A kept request that goes wrong heals by itself.** A file that does not read signs nobody new in
  (`not_written`, `kept_unreadable`) while this PC's copy stands at the head at which it found the
  file so; once its verified head moved past that, the place whatever it held was signed for is
  taken, and the file goes. A kept request of a device this PC has since come to hold back is never
  sent, and holds its place from another device's Allow (`place_kept`) for ten minutes from when it
  was kept, or until the person at this PC declines a join of that device (its own window's
  Decline). Meanwhile `reason` of `GET /api/account/list` and the `list` of `GET
  /api/account/status` (so `ovis status --json`) say why this PC lets no new device in: for a
  kept entry, that an Allow waits behind an earlier one, and until when.
- **A join a member device allows** is let in only when an entry of the list lets the device in:
  the PC signs nothing on a member's approval. The member signs only after the new device
  confirmed its digits, so a device that gives up before that is nobody's member: a waiting join
  says `confirmed: true` in `GET /api/relay/pairings` (and the `remote-pairings` event is sent
  again) once the new device's person said the digits match. Only a join marked `list` has that
  member and that second event: a pairing of the PC's own is told and answered as it always was.
  An approval from afar that comes before it is refused, 409 `not_confirmed`, and the join waits as
  it did. The member then approves, signs the entry, places it and may hand it to the PC. From the
  moment the approval and the confirm are both in, the PC waits 30 seconds for the entry to be in
  its copy: it asks the account service every 3 seconds, takes a page a device hands over at once,
  and at the end asks the service once more, with a read begun when the 30 seconds are over (one
  that was out before then is let end first), and then answers as above. That wait holds back no
  read and no page.
- **Which device may allow.** A device signed in to this PC with the key the list holds for it
  sees the joins into the list that wait here (`GET /api/relay/pairings`, each marked `list`, and
  the `remote-pairings` event, which its own socket carries beside this PC's roster once it turned
  machine events on) and decides one (`POST /api/relay/pairing`, with the digits the new
  device shows) only when the list holds it **to drive, with full power**: what may add a device
  to the list may approve its join. A device the list holds to watch, or with bound power, gets 403
  `list_cannot_allow` from both. The right is read from this PC's copy of the list at each call, so
  a device the list removed a moment ago has none. On a PC that follows no list a device the
  account let in reads no waiting joins and hears none, as before (403 `account_route_denied`).
  The event stream asks again at every telling, and when the list changes what it lets in,
  for a member of this PC's own devices too: a device that subscribed while it had the right
  (before this PC pinned its list, say) and has it no more is told once that nothing waits, and
  nothing after. Such a device sees and decides a first join
  too, and never a join that brought no card (that is this PC's own pairing, which only this PC
  and a member of its own devices decide) nor one asked under this PC's own add-me screen.
- A join that brings no card is the PC's own pairing, as before. On a pinned PC its row has the
  account's id for the key, so it opens the PC only once the list holds that key: a new device of
  an account that keeps a list joins a pinned PC with its card.

#### How an app signs in to a pinned PC

- **The feature `account-list-1`.** A pinned PC selects it in `WELCOME` for a client that offers it
  in `HELLO`; a PC that is not pinned does not have it. A client that signs in with the key the list
  holds for it requires the feature (`required_features`), so on a PC that follows no list it is
  refused `unsupported_extension`, as for any feature the PC lacks, and falls back to the ways above.
- **A sign-in the pinned PC has no row for**, from a client that offered the feature and did not
  require it, is refused `account_list_required`: the client came with another key (the key of its
  sign-in, as apps did before), reads its list and signs in again with its list key. The refusal
  says nothing of the device, only that this PC follows a list. A client that did not offer the
  feature is refused `auth_failed`, as ever, and so is one that required it and is in no list.
- **The `WELCOME` names the list.** With `account-list-1` selected, the final `WELCOME` also carries
  `list`, the id of the list this PC follows: an app signs in by the key that list holds for it
  toward any PC that says it follows the app's list, whether or not the app's copy names that PC.
  A PC that follows no list sends what it always sent.
- **At the moment a PC pins**, the sessions of the account devices it held until then, and every
  session open under the account's id for a key (a row a member's `add` or a join by digits made),
  end with `auth_changed`, the code for a row that changed under a session, not `auth_revoked`: each app
  signs in again by itself, with its list key, and an open terminal comes back as after any
  reconnect. Nothing typed while the session was down is sent by itself.
- A device this PC paired itself signs in as it did.

#### What the account service's word does on a pinned PC

| The service says | A PC that is not pinned | A pinned PC |
|---|---|---|
| a device is in the account (the snapshot's `devices`) | lets it in | nothing |
| a device was removed (the snapshot's `removed`) | puts it out | nothing: only an entry of the list does |
| this PC is not the account's (`not_listed`, a listing replaced or changed) | leaves the account | stays in it |
| Step 2 is off (`step2_off`) | account devices wait | nothing |
| nothing, for an hour | account devices wait for a whole read | nothing |
| the account admitted this PC ([one press](#adding-a-pc), [over SSH](#adding-a-pc-over-ssh)) | joins that account, unless the account keeps a list (`list_add`) | refused: it is in its account, and one whose list removed it never takes it back |
| a device asked to join (an admission) | a person may allow it, by its digits | the same |
| the list has a new head, or names another list | reads | reads its own list, and no other |

A member's signed word that came through the service is judged as before, where it takes away:
a signed `remove` and a signed block apply. Where it adds, it does not: a signed `add` and a device's
`link` are refused `list_followed`, and the device keeps the pairing it has.

#### What the account service still can

- **Withhold.** A removal the service does not show reaches the PC only from another source. The PC
  takes entries any device hands it over its session, since entries prove themselves
  (`POST /api/account/list/head`, `POST /api/account/list/page`): a device says where it stands,
  the PC says where it stands, and the device hands the PC the entries after that place. So a
  removal one device holds reaches every PC that device opens, whatever the service shows: at once
  over a session that is open when the device places it, and at the start of every later session
  ([Meeting a PC](account-list.md#meeting-a-pc)). Until a device that holds it opens the PC, a
  removed device still opens a pinned PC that has not been shown its removal. The other way round,
  a PC hands a device the entries the service withholds from that device, and two histories that
  members signed raise the alarm on both sides once they meet.
- **Deny.** It can answer nothing, and it can keep a new device or a new PC from being added.
- **See.** It sees how many devices and PCs an account has and when each came and went, and not what
  they are called.

A device paired with this PC before it pinned, and a join a person allowed by its digits, are this
PC's own rows and outside the list. So are the members' older signed blocks, which still freeze by
the order the service numbers devices in: a block can shut devices out, and nothing here lets one in.

### How long a key has been let in

A PC in an account keeps a record of how long it has let each of the account's keys in:
`account-witness.json` in the state folder (readable by your user only). Moving an account that was
in use onto its signed list ([account-list.md](account-list.md), "An account that was in use")
counts a key only where a PC has let it in for a day: the first device asks its PCs, and a PC asks
its own record before it follows a list a device names to it. Nothing else decides by it.

- It holds the account, the PC's relay identity, when it was last written, and per key two counts
  of seconds and the day the key was last used here. No name, no secret, no moment a key came in.
- **Whose keys.** The rows the account's list of devices let in on this PC, once a row is out of
  its ten-second hold. A pairing made at the PC is never in it: the PC cannot tell an owner's
  pairing from a guest's. A key enters with both counts at nothing. A row that stops standing
  (the account no longer names it, a removal, a block, 60 days unused) leaves the record at once,
  and starts at nothing if it is let in again. A row that only waits, for the read after a start
  or while the account service is away, stays in the record and counts no time meanwhile (unless a
  person at this PC let that row in for the wait, as `ovis recover` does: then it counts). Time in
  which the rows could not be read counts for no key.
- **Two counts, no clock readings compared.** `ran` is the time the PC itself ran with the key let
  in. `wall` is the time by the clock, which also counts while the PC is off. The record takes the
  time every four minutes and when the server stops. While the PC runs, `wall` grows by no more
  than the time it ran and a minute, so a clock set forward adds a minute at most, and one set back takes
  nothing away. Across a restart `wall` grows by the time since the last write, a day at most, and
  `ran` does not grow. What was not written at a crash is lost, which only delays.
- **It goes with the account and the relay identity.** A file written for another account or
  another relay identity is not taken over, and a PC that leaves its account deletes it. A file
  that does not read starts the record anew.
- **What a device of the account is told.** `GET /api/account/list/witness`, over the session of a
  device of this PC's account (a row the account let in, or a pairing of the account's member) or
  from its own window, answers `{ account, pinned, admits: [{ key, wall, ran, idle }], removed }`:
  the keys the account's rows let in to drive right now, each with both counts in seconds and how
  long ago its row was last used here (by the day), and the keys this PC holds a removal against,
  never why. A row that waits for a whole read lets nobody in and is not told. The counts are those
  of the record's last step, which runs on its own timer; how long ago a key was used is read at
  the answer. A caller asks at most 30 times a minute (`429 rate_limited`). A PC in its account
  whose rows cannot be read now answers `503 witness_unavailable`. A device outside the
  account is refused (`403 account_required`), a PC in no account answers `409 not_in_account`.
- **A staging run.** `OVIS_LIST_MIGRATE_TIME_SCALE` (a whole number from 1 to 86400) multiplies the
  counts this PC hands over, to a device and to its own check of a naming, so a day passes in a
  minute at 1440. It is ignored while the account service is `https://account.ovis.sh`. While it is
  in force `GET /api/account/status` and `ovis status --json` say `migrate_time_scale`.

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

### Recovery at the PC

Needs Step 2, which is on unless `OVIS_ACCOUNT_OPENS_ALL=0`. Run `ovis recover` in a terminal on
this PC, as the user who runs Ovis. On Windows the command is not available.

- `ovis recover --restamp` shows which timestamps this PC wrote too far ahead and asks you to
  confirm. It queues the repair without changing device or account records. Restart Ovis as
  the command directs to apply it. Past timestamps and removals are kept. If a repair was
  interrupted and another write changed a timestamp, Ovis stays closed. Run the command again
  to review and confirm keeping the independently changed times, then restart to finish rollback.

### Limits of this release

These limits apply while Step 2 is on, which is the default.

- **A PC's `WELCOME` tells which list it follows** to whoever opens a channel to it and offers
  `account-list-1`, before any sign-in: whoever can reach two PCs learns that they follow one list.
- **A PC that came to follow its list as its account moved, and lost its copy of the list**
  (`account-list.json`), makes the copy again from the list's start as a PC that was added, and lets
  no device of the account in until it gets keys of its own: run `ovis add` on that PC and compare
  the number with a device of the account. Its own window and `ovis status --json` say so.

- **Lifting a block needs a two-step sign-in.** Only a device that is older than the block, and
  whose own sign-in has two-step sign-in set on the account, can lift a block from the app. A
  Google sign-in whose two-step state the account cannot see (its notices say only "Google
  sign-in") can block a device but cannot lift a block. If every device you still have is like that, lift
  the block on the PC itself: run `ovis recover` to list what stands there, then
  `ovis recover --lift <block id>` for the one to lift. `ovis recover` asks you to confirm in
  that terminal.
- **Strict mode and key confirmations are Linux only for now.** Turning strict mode on or off,
  and approving a new key on the PC's screen, need the PC's own screen, which this release has
  only on Linux. On macOS and Windows neither is available yet; pairing works as before.
- **A legacy pairing made with a clock more than a day ahead keeps its existing connection but
  cannot authorize Step 2 actions.** Correcting the clock does not give that old timestamp
  authority. Other phones and account reconciliation are unaffected. A clock fault in new Step 2
  state still makes the PC refuse account access until that state can be read safely. For a
  future time this PC wrote in Step 2, run `ovis recover --restamp` on this PC and restart Ovis
  after confirming the repair.
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
| `PUT /v1/pcs/{server_id}` | `{ "label", "public_key", "relay", "challenge_id"?, "proof"? }` | `{ "pc": … }`: adds or renames a PC in the directory. 400 `server_key_mismatch` unless `public_key` (X25519, 64 hex) gives `server_id` (`deriveServerId`), 400 `invalid_relay` unless `relay` is a `wss:` origin. For 30 days after the PC left the account (`POST /v1/pcs/{server_id}/leave`, sent by `ovis logout` with the PC's proof), 409 `pc_left` with `left_at` unless the body carries the PC's own fresh proof (`/api/account/pc-proof`; 401 `proof_invalid` when it fails), which lists it again and ends the mark. The app then says **Sign in on this PC to add it again** |
| `DELETE /v1/pcs/{server_id}` | | `204` |
| `POST /v1/records` | `{ "server_ids": [...], "record" }` | `{ "queued": n }`: puts a signed record of the caller's account in that account's mailbox for each listed PC; the service checks only its shape and signature. 429 `mailbox_full` past 1000 records waiting for one PC |
| `GET /v1/admissions` | | `{ "admissions": [{ "key", "label", "server_id", "at", "os", "country", "city" }] }`: this account's admissions of the last 10 minutes, with who is asking (below). Before it signs an `add` for a device a PC showed it, the approving client checks that PC and key are listed here |
| `POST /v1/admissions` | `{ "server_id", "label", "key", "os"? }` | `{ "id" }`: the signed-in device says it waits at that PC with its account key (`key`); rings the account's other clients (push), and reaches that PC's mailbox for 10 minutes |
| `POST /v1/signout` | | `204`: ends this sign-in's tokens |
| `POST /v1/signout/all` | `{}` | `204`: ends every sign-in of the account, this one and device codes' included, and the codes not yet redeemed; rings the account's other clients. The PCs and registered device keys stay. 403 `reauth_required` unless this sign-in was made in the last 10 minutes; 403 `web_sign_in_required` for a device code's sign-in. Manage account offers it as **Sign out every device**: on `reauth_required` the phone app signs in again in place and goes on, and a browser signs in again by redirect, whose return goes on for the same account only |

`DELETE /v1/pcs/{server_id}` removes the PC from the account for good, however it was added. The PC
leaves the account at its next read of the account service: its snapshot is refused `not_listed`,
or, when a device listed it again meanwhile, its mailbox names another listing than the one its
account rows were let in under (a PC bound by a device's link keeps that listing's ID from its first
whole read; one bound in one press asks about the listing it was admitted in). A device lists the PC
only after its link is answered, so for ten minutes after a link bound it, or until its listing is
named, a missing listing is no removal (`listing_due` in the binding). A link-bound PC lets more of
the account in only when the mailbox call of that same pull, or of that same read, named the listing
it keeps: with no mailbox answer or none named, the read still denies what its pages deny, drops the
listed devices its snapshot names as removed, and widens nothing. An answer counts only for the
binding and account it was asked for. Leaving ends the
account's rows and keeps the pairings made at the PC ([Adding a PC](#adding-a-pc)). From then on the PC says so
(`pc_add_required` in `GET /api/account/status`) and takes a first link only under a code it issued
itself (its own window, `ovis add`), or from a device whose digits its own screen approved since it
left (for a removal recorded by an older version: since this version first read it); one press at
the PC brings it back too. A device it kept paired opens it as before and sends
it no link, and a code that device asked for joins it to no account. When that device scans the
code the PC issued itself, it pairs again with the key it already has there: its link brings the PC
into the account, and the new row takes the place of the pairing it had (same key, a row that
drives and is in no account), whose sessions end `auth_changed` with no removal told. An app whose
new row the PC ends before its link passed opens the PC again with the record it had before the
scan.
No app lists a PC again by opening it: only the enrollment that brings a PC into the account writes
its directory entry. A PC the directory does not list gets no [relay pass](relay.md#relay-pass)
(`not_listed`) and none of the account's later records. The apps offer the removal in Settings →
Devices and PCs → Manage account, as **Remove**, only for a PC the directory has not heard from for
15 minutes (`offlinePc` in [`src/components/AccountManage.tsx`](../src/components/AccountManage.tsx)),
on any page that has the sheet: a PC's own page, the hosted app and the phone apps. A confirm says
the PC leaves the account once it is online again and is added again at the PC. A PC the account's
signed list holds has **Remove** whether it is on or off, through the same confirm and the same
fresh sign-in: once its removal is in the list it does not come back by itself, so the confirm says
it comes back to the account only as a new PC, added again on that PC. Such a row leaves by the
list or not at all: where this device no longer follows the list when the confirm is pressed,
nothing is removed (never through the directory, which would leave the PC in the list) and the
confirm says to try again in a moment.

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
| `POST /v1/pc/mailbox` | `{ "server_id", "challenge_id", "proof", "account", "ack" }` | `{ "records": [{ "seq", "record" }], "more", "admissions": [{ "key", "label", "at" }] }`: `admissions` lists that account's admissions for this PC made in the last 10 minutes, on every pull until they age out. Asked `with_listing_id: true`, it also answers `listing_id` (the listing it holds this PC under, null for none it confirms) and `listing_admitted` (whether that listing stands on a one-press admission this PC took; a service from before the field omits it) |

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

### PC invites

A device signed in to the account can make an **invite** for a new PC, which joins with `ovis join`
([relay.md](relay.md#a-pc-with-no-screen)) and no sign-in of its own. An invite is a key: the device
makes a P-256 key pair, gives the account service the public key alone (`invite_key`), and shows the
signed list's join line, which carries the private key (`shared/account-list-join.ts`:
`ovis-join:1:` and the base64url of `{"v":1,"service","account","list","secret"}`; `list` is empty
while the account has no signed member list). The service never holds anything that redeems an
invite. It works once, for 15 minutes, and an account holds at most five open. Whoever gets the line
can list a PC in the account for its devices to add, so a client acts only on a line whose `service`
is its own account service, shows the account and gets a typed yes (or a matching `--account`)
before it redeems it. The PC proves it holds the line by signing, with its private key,
`ovis-invite-redeem/1` and then the account, its `server_id`, its relay key and the id of the
challenge its own proof answers in the same request, each length-prefixed
(`shared/account-list-invite.ts` `signInviteRedeem`): a captured signature redeems nothing else.

| request | body | answer |
|---|---|---|
| `POST /v1/pc-invites` | `{ "invite_key", "auto"?, "key_proof"? }` | `{ "id", "account", "expires_at", "auto" }`: an own sign-in's; the device shows its line only after this answer, and only for its own account. A key is an invite once (409 `invite_key_used`). An auto invite is refused here with 429 `pc_add_cap` (and `retry-after`) while the account's daily one-press adds are used up. `auto` makes an invite whose PC is admitted at once, with no Add. `key_proof` (`{ "challenge_id", "signature" }`, from `POST /v1/pcs/challenge`, signed with this sign-in's device key) is needed only for a sign-in older than 10 minutes. 403 `own_sign_in_required`, 403 `session_not_fresh`, 400 `challenge_invalid`, 403 `frozen`, 409 `invites_full`, 429 `rate_limited`, 404 `not_found` (invites are off for the account), 400 `invalid_request` |
| `POST /v1/pc-invites/redeem` | `{ "invite_key", "invite_signature", "server_id", "public_key", "relay", "label", "os"?, "challenge_id", "proof" }` | `{ "account", "listing_id", "auto", "card_until", "admission_until" }`: no bearer; `card_until` is when a plain invite's card stops offering Add, `admission_until` when an auto invite's admission stops waiting (ISO, the other null), the same for every rerun; the PC's proof answers a `POST /v1/pc/challenge` (`role` `account`, `connection_id` the challenge id, as for its mailbox), and `invite_signature` is checked against the invite's row (its account, never one the request names). One 400 `invite_invalid` for every dead, unknown or malformed invite and every signature that does not verify; a request that carries anything else (an `invite` line) is 400 `invalid_request`. Also 400 `invalid_request`, `server_key_mismatch`, `invalid_relay`, `invalid_label`, 401 `proof_invalid`, 409 `list_endpoint`, `directory_full`, `try_again`, 429 `pc_add_cap` (auto only, with `retry-after`; the invite stays open), 429 `rate_limited`, 404 `not_found`. The same PC and key asking again within the 15 minutes, while its listing is current, get the same answer |
| `GET /v1/pc-invites` | | `{ "invites": [{ "id", "made_at", "expires_at", "auto", "device_no", "device_label", "yours", "used_at", "used_by": null \| { "server_id", "listing_id", "label", "os", "country", "city" } }] }`: open invites, and used ones for a day after their use. No line or key |
| `DELETE /v1/pc-invites/{id}` | | 204, also for one revoked or expired; 409 `invite_used` once a PC used it (remove that PC instead); 404 `not_found` |

After a plain invite's redeem, the PC's card (**Add this PC to your account?**) offers Add for 10
minutes, and the PC asks `POST /v1/pc/admission` for it as after `ovis add`: 404 `no_admission`
until a device presses Add, 409 `listing_expired` after the 10 minutes (the PC answers its own
one-press ask with `listing_expired` then, and `ovis join` stops waiting); a new invite opens the
card again. An auto invite's admission is there at once, for 10 minutes. An invite lives with the
sign-in that made it: once that ends (a sign-out, a removed device or method, the account deleted),
an unused invite redeems nothing (`invite_invalid`), and an auto admission not yet taken ends too
(`no_admission`; the listing stays confirmed, and a rerun answers it with `admission_until` null). A
PC that gives up leaves by its own proof (`POST /v1/pcs/{server_id}/leave`), which answers 204
whether or not it was listed.

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
with "continue only if you started this on your own PC". A PC's listing that asks to join carries
them too (`asking_os`, `asking_country`, `asking_city` on an unconfirmed PC of `GET /v1/pcs`; the
system is the one its `PUT` named in `os`), and its card shows them under the PC's name as "Linux ·
Seoul, South Korea", leaving out what is unknown ([Adding a PC](#adding-a-pc), "Add on another device").

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
| `key_in_use` | 409 | a link to a key another row already has; not the first link of a device that paired again with a code made for a PC in no account and kept its key, which replaces the row it had |
| `introduction_unknown_key` | 404 | an introduction for a key no account member added on this PC |
| `introduction_invalid` | 400 | an introduction's PC list does not parse, or a `server_id` does not derive from its key |
| `introduction_none` | 404 | no introduction waits for this device |
| `account_unavailable` | 503 | the tombstone file cannot be read; no account record applies |
| `enrolling` | — | the PC waits for its first member's enrollment; an add waits too (a record outcome) |
| `removal_pending` | — | the key is held: a waiting remove or an enrollment named it, or the waiting queue cannot be trusted (a record outcome) |
| `list_cannot_allow` | 403 | this device is in the account's list, but the list holds it to watch or with bound power: only a device that may add devices to the list lets one in |
| `not_confirmed` | 409 | `POST /api/relay/pairing`: the join brings a card for the account's list and its device has not confirmed its digits yet; the join waits as it did, and is approved once `confirmed` shows |
| `list_followed` | 409 | this PC lets its account's devices in by the account's signed list alone: a `link` makes no member, and an `add` adds nobody (also a record outcome) |
| `list_removed` | 409 | the account's signed list removed this PC: it joins that account again only as a new PC, after **Reset relay identity** |
| `list_add` | 409 | `POST /api/account/one-press`, an add over SSH from a PC that does not follow the list: the account keeps a signed list, and takes a PC by that list alone (`ovis add` at the PC, `ovis join` with an invite that names the list, or an add over SSH from a PC that follows it) |
| `list_cannot_add` | 409 | `POST /api/account/ssh-add`: this PC follows its account's list but cannot sign another PC into it now (it joined by an invite, an alarm, an Ovis too old for the list, its keys) |
| `list_not_added` | 409 | `POST /api/account/ssh-add`: the entry that adds that PC was not placed (its card does not fit, or the account service refused it, `not_posted` included) |
| `list_unbound` | 409 | `POST /api/account/ssh-add`: the entry that adds that PC is in the list, and that PC has not taken it yet: adding it again finishes |
| `list_budget` | 409 | `POST /api/account/ssh-add`: the account service takes no more additions to the list for now; add that PC again later |
| `other_keys` | 409 | an add over SSH: the list holds this PC by an entry with other keys than the ones it posted, so it follows no list by that add |
| `that_pc_old` | 409 | `POST /api/account/ssh-add`: the other PC's Ovis cannot be named a list over SSH (it refuses the field as one it does not know): update Ovis there |
| `that_pc_behind` | 409 | `POST /api/account/ssh-add`: the other PC's Ovis cannot read the account's list: update Ovis there |
| `that_pc_error` | 409 | `POST /api/account/ssh-add`: the other PC's Ovis answered the take with an error of its own and no code: try again |
| `in_account` | 409 | `POST /api/relay/offer` with `x-ovis-no-account-only`: this PC is in an account, so it makes no QR code that would put it in one |
| `listing_expired` | 409 | `POST /api/account/one-press`: the listing a plain invite made is past its card's 10 minutes, so no Add can come for it; a new invite opens it again |
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
  list a PC of their own in the directory (device-code phishing, [Who is asking](#who-is-asking)). Its row in
  the sidebar pairs A with that PC, whose owner approves it there: A's machine list then
  holds a stranger's PC. It gets no access to A or to the account's PCs by that; what the person then
  types into its terminals goes to it. The prompt to approve shows on a device of the account only
  when the PC really is one of the account's: a request approved without that prompt is the sign.
- **A code a driving device has the PC itself start.** A device that drives (one the QR code of
  `ovis add` let in, say) can have the PC start a pairing code through its loopback address from
  a terminal pane, as the PC's own user: that code is held by no device, so it survives the
  device's removal.
- **A script in the app's page, or a copy of the whole browser profile.** Past ten minutes a sign-in
  adds a PC only with its own key's proof ([In one press](#adding-a-pc)), so a copied access or
  refresh token alone adds none. The key is the app's non-extractable WebCrypto key in its
  IndexedDB: a script running in the app's page, or a copy of the whole browser profile, can still
  sign with it.
- **Someone who gets a person to type their device code at GitHub** (device-code phishing, true of
  every RFC 8628 sign-in) gets a sign-in to that person's account: they can list, rename and remove
  its PCs in the directory, fill mailboxes, post admissions and spend the ring budget. They still
  cannot add a device to a PC: that takes a member's signature and the PC's own `devices.json`, and
  a join is still compared digit by digit on a device already linked. The page asks to enter a
  code only if this page showed it, and GitHub's page names the app (Ovis).

## What a device remembers of its PCs

The app keeps, on the device and for each account it was signed in to, a record of the PCs it has
held sessions with. It decides one thing in the app: whether a PC that refuses this device's
sign-in by the account's key outright removed this device (it let it in before) or never let it in
([Adding a PC](#adding-a-pc)). Otherwise it only records, so that it has a history by the time
something else decides by it.

- **A row per PC, by the PC's relay key** (64 hex), the key the end-to-end channel is bound to.
  Never by what the account service's directory says: a PC whose relay identity was reset is
  another row.
- **`since` and `last`**: when the PC first let this device in, and when it last did, in seconds
  by the device's clock. `since` is written once and never moved. A session the PC refused, or
  one that only reached the relay, writes nothing.
- **`how`**: what this device did itself for that PC that the account service could not have
  faked. `paired`: it paired with it at the PC (a code typed on this device, the digits, a code
  for this device alone). `added`: a QR code of that PC was scanned for the account, or the
  person pressed Add for it where a number was compared on both screens (the card's Add with the
  number, on an account with a signed list). `ssh`: this device added it over SSH. `window`: the
  page is that PC's own window. `invited`: the PC joined with an invite of the account, which the
  invite's own line proved for that PC's card, and the person pressed Add; it is written before
  the card goes. `none`: everything else, also one press of **Add** on the card of a PC that
  asked, where no number is compared: the service could have listed a PC of its own at that
  moment. It moves from `none` to one of the others, never back and never between them. The act
  is written for the account the pairing was confirmed for, whoever signed in since. A value this
  build does not know (a later build wrote it) is kept as it is, through every write, and counts
  as `none` for any decision.
- It is kept in the browser's storage under `ovis:seen-pcs:<account>`, the newest 256 PCs for an
  account. Signing out keeps it: it is the device's memory, not the account's. Removing a PC from
  the account on this device forgets its row. Cleared site data loses the record, which only
  shortens the history.

The code is [`src/lib/account/seenPcs.ts`](../src/lib/account/seenPcs.ts).

## Code

- [`shared/account-records.ts`](../shared/account-records.ts): record types, parsing, signing bytes,
  signing and verification.
- [`src/lib/account/accountList.ts`](../src/lib/account/accountList.ts): a device's own copy of the
  account's signed list ([account-list.md](account-list.md#on-a-device)).
- [`src/lib/account/listPcs.ts`](../src/lib/account/listPcs.ts): the account's PCs as that list
  holds them, for a device that is in it
  ([account-list.md](account-list.md#pcs-of-a-list-account)).
- [`shared/account-service-fake.ts`](../shared/account-service-fake.ts): the account service API in
  memory, for tests, the signed list's routes included
  ([account-list.md](account-list.md#the-list-routes-in-tests)).
- [`shared/account-list-entry.ts`](../shared/account-list-entry.ts): the entry format of a signed
  list ([account-list.md](account-list.md)).
- [`server/account/list-follow.ts`](../server/account/list-follow.ts) and
  [`server/account/list-keys.ts`](../server/account/list-keys.ts): the PC reading its account's
  signed list, and the PC's own keys for it
  ([The account's signed list on a PC](#the-accounts-signed-list-on-a-pc)).
