# The signed list: an entry

A PC reads the list of its account and checks it. One that a person pinned to the list lets its
account's devices in by the list alone; any other decides nothing by it, and its account works as it
did, with records signed one by one and no chain
([The account's signed list on a PC](account.md#the-accounts-signed-list-on-a-pc)). A device keeps
a copy of its account's list where the account service keeps lists for that account
([On a device](#on-a-device)).

An owner's devices and machines share one signed list. Every member keeps a copy and checks every
entry by itself; the account service stores entries and must never be able to write one that
members accept. This page says how one entry is written, signed, hashed and chained, and how a
member checks it. Who may sign an entry (the signers) is checked on top of this and is not part of
this page. The code is [`shared/account-list-entry.ts`](../shared/account-list-entry.ts); the
vectors are in [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope).
What each kind of entry means, and the state the entries build, is under [The kinds](#the-kinds);
the code for that is [`shared/account-list.ts`](../shared/account-list.ts). How a member keeps its
copy up to date against a service that may lie is under [Following a list](#following-a-list).
The page ends with the [join line](#the-join-line), the one line a machine is given to join an
account, and with how [an invite is a key](#an-invite-is-a-key).

## The form

An entry is two byte strings, a **body** and a **signature**. The body is what is signed, hashed,
stored and sent; nobody re-encodes an entry, so two members never differ over its bytes. A body is
never read or written through JSON.

```
body  = "ovis-list/1" field field ...       at most 8192 bytes in all
field = len(name) name len(value) value     len(x) = the number of bytes of x, as 4 bytes, big-endian
name  = 1 to 32 bytes: the first is a-z, each other is a-z or _
value = 0 or more bytes
```

- Names ascend strictly, compared byte by byte: no name comes twice, and a name that is the start
  of another comes before it.
- The body ends exactly after its last field. A body cut inside a length, a name or a value, or
  with bytes after its last field, has not this form.
- 8192 bytes is the one size limit of an entry: no member takes a longer body.

Seven fields are in every entry, three more may be, and every other field belongs to the entry's
kind: for such a field only the name is checked, never the value.

| name | in | value |
|---|---|---|
| `issued_at` | every entry | when it was signed, by the signer's clock: seconds since 1970-01-01 UTC, a number |
| `kind` | every entry | 1 to 32 bytes in the form of a name |
| `list` | every entry | the list id; empty in entry 0 |
| `prev` | every entry | the hash of the entry before; empty in entry 0 |
| `seq` | every entry | the entry's place, counted from 0, a number |
| `signer` | every entry | the signer's key |
| `v` | every entry | the level that first defined this kind in this form, a number from 1 |
| `adds`, `power` | together or not at all | a key that becomes a signer, and its power: `full` or `bound` |
| `ends` | or absent | a key that stops being a signer |

- A **key** is a P-256 public key: 122 characters of `A-Z a-z 0-9 - _`, the base64url (no
  padding) of 91 bytes, in its one spelling (decoding and encoding again gives the same 122
  characters). The 91 bytes are `3059301306072a8648ce3d020106082a8648ce3d03010703420004` (hex)
  and the point's X and Y. Keys are compared as these 122 bytes. A point that is not on the curve
  (X or Y not below p, or Y² not X³ - 3X + b mod p) is a key in form that signs nothing.
- A **number** is 1 to 15 digits `0-9`, with no sign and no leading zero (zero is `0`).
- A **hash** is 64 characters `0-9a-f`.

A body lacks the form when one of the seven fields is missing, when a value is not in the form the
table names (`v` `0`, a `power` that is neither `full` nor `bound`, an `adds` or `ends` that is no
key, a `list` or `prev` that is neither a hash nor empty), or when `adds` stands without `power`
or `power` without `adds`. Whether a key may stand in `adds` or `ends` is not a question of form.

## The signature, the hash and the list id

- The **signature** is ECDSA P-256 with SHA-256 over the body, under `signer`: `r || s`, 64 bytes.
  Any `r` and `s` from 1 to n-1 that verify count, an `s` above n/2 included. A `signer` whose
  point is not on the curve verifies nothing; the library judges that, like the range of `r` and
  `s`, before it asks the runtime, so that no runtime's way of refusing a key decides. What the
  runtime then throws, and a runtime with no WebCrypto at all (a page on plain http at a LAN
  address), is a fault, never a verdict on the entry.
- The **entry hash** is SHA-256 over `ovis-list-entry/1` and the body, as a hash. It covers the
  body only, so two entries are the same entry when their hashes are equal, whatever their
  signatures. Where `r || s` verifies, `r || n-s` verifies too, and anyone can write it without
  the key, so one body can come with two signatures and as two texts: nothing may identify an
  entry by its signature bytes or its text, only by its entry hash.
- The **list id** is the hash of entry 0.

## On the wire and in files

An entry is one text: the base64url of its body, `.`, and the base64url of its signature, each
without padding in its one spelling, and nothing else; the signature part is 86 characters. Inside
JSON it is a JSON string. A text with no dot or a second dot, an empty part, a character outside
`A-Z a-z 0-9 - _` (padding, white space, a trailing newline), a signature part of another length,
or a second spelling of either part is refused. The body it carries is then checked as above.

## When an entry holds

Entry n holds when, in this order:

1. its body has the form above;
2. its `seq` is n; for entry 0, `list` and `prev` are empty and it carries no `adds` and no `ends`;
   for a later entry, `list` is the list id and `prev` is the hash of entry n-1;
3. its signature verifies.

The check needs the list id and the entry before, and nothing else. A member that was given a list
id (by an offer or a join line) takes as entry 0 only the entry with that hash. An entry that does
not hold stops the member with the code of the first check that fails:

| code | when |
|---|---|
| `entry_malformed` | 1: the body, the text or the signature's 64 bytes have not the form |
| `chain_broken` | 2: a wrong `seq`, `prev` or `list`, an entry of another list, an entry 0 with a `list`, a `prev`, `adds` or `ends` |
| `signature_invalid` | 3: the signature does not verify: a changed byte, a signature by another key, an `r` or `s` outside 1 to n-1, a `signer` whose point is not on the curve |
| `list_mismatch` | an entry 0 that holds but is not the one with the list id the member was given |

## Levels

A level is a number from 1; a build of level L reads every form of levels 1 to L. Each kind writes
in `v` the level that first defined it in that form. Level 1 is nine kinds, each written with `v`
1: `genesis`, `device`, `pc`, `invite`, `join`, `remove`, `carried`, `card` and `epoch`.

## The kinds

The members of a list are **devices** (a phone, a desktop app, a browser) and **PCs**. Every member
has a signing key; a PC is also known by its relay key, the key a device already holds it to when
it connects. An **invite** is a key too. Who may sign an entry is the signers' rule, from `adds`,
`power` and `ends` alone: a signer of power `full` adds and ends any key, one of power `bound` ends
only itself, and a key that was ever a signer is never added again. The kind says what the entry
means on top of that.

| kind | signed by | carries | it means |
|---|---|---|---|
| `genesis` | the first device, as entry 0 | `account`, `enc`, `epoch_opens`; names | the list starts for that account; its signer is the first device, `full`, with role `drive`; epoch 0 is open |
| `device` | a `full` signer | `adds` and `power`; `card`, `enc`, `role`, and `until` or not; names | the key in `adds` is a device with that power and role. With power `full` its role is `drive` and it has no `until` |
| `pc` | a `full` signer | `adds` with power `full`; `card`, `enc`, `endpoint`; names | a person added the PC at that relay key; the key in `adds` is its signing key |
| `invite` | a `full` signer | `adds` with power `bound`; `auto`, `exp`, `uses`; names | the key in `adds` is an invite |
| `join` | an invite's key | `card`, `enc`, `endpoint`, `pc`; names | the PC at that relay key joins by itself; `pc` is its signing key, which is no signer |
| `remove` | see below | `ends`, or `endpoint` | the key, or the PC at that relay key, is out |
| `carried` | the first signer, right after entry 0 | `adds` with power `full`, `role` `drive`; or `endpoint`; names | a device, or a PC, that was in the account before it had a list |
| `card` | a device with no encryption key yet | `enc` | the device names its encryption key |
| `epoch` | a `full` signer | `epoch`, `epoch_link`, `epoch_opens` | the epoch after the current one is open |

"names" is the two fields `sealed` and `epoch`, which come together or not at all: an entry whose
writer holds no key to seal its names with carries neither, and counts all the same.

| field | value |
|---|---|
| `account` | the account's id: 1 to 64 of `A-Z a-z 0-9 _ -` |
| `auto` | `1` for an invite a PC joins with by itself, `0` for one that needs a person to add the PC |
| `card` | a [card](#a-card)'s signature: 86 characters of base64url, `r \|\| s` |
| `enc` | an encryption key: [a key](#the-form) whose point is on the curve |
| `endpoint` | a PC's relay key: 64 of `0-9a-f` |
| `epoch` | a number: the epoch whose key sealed this entry's names; in an `epoch` entry, the epoch that is current where it stands |
| `epoch_link` | 61 bytes: the key of the current epoch, under the key of the epoch the entry opens |
| `epoch_opens` | a hash: the commitment to the key of the epoch the entry opens (epoch 0 in a `genesis`) |
| `exp` | a number, at most `issued_at` + 604800 (7 days after the entry was signed): the invite lets no PC in once a `full` signer has signed an entry at a later time. The account service also judges it against its own clock |
| `pc` | a PC's signing key: a key whose point is on the curve |
| `role` | `drive` (types into terminals) or `watch` (only reads them) |
| `sealed` | the entry's [names](#what-is-sealed), sealed: at least 47 bytes |
| `until` | a number, only with power `bound`: a PC lets the device in only before this second, by the PC's own clock |
| `uses` | a number from 1 to 256: how many PCs may join with the invite |

An entry is of its kind only with exactly those fields, each in its form, and with `adds` and `ends`
only where the table has them. One exception: a `device` may carry `ends` when it names the entry's
own signer, which so hands its place to the key in `adds` in one entry. Anything else is not of its
kind and has no effect of it (`entry_invalid`); its `adds` and `ends` have applied all the same, so
the key it adds is a signer with no name: it may sign what its power allows, and it opens nothing
and is no device and no PC.

What the kinds add to the signers' rule:

- **A PC that a person added is a signer of power `full`**, so a person at that PC can allow a
  device, add a PC and remove a member. It is in while its key is a signer: the entry that ends the
  key puts the PC out, whatever its kind. Its relay key alone does not put it out (`ends_needed`),
  since that would leave its key a signer.
- **Only a `bound` device watches or has an `until`.** A device of power `full` adds whom it likes,
  so a role or an hour would hold it to nothing: a `device` with power `full` and role `watch`, or
  with an `until`, is not of its kind.
- **A PC that joined by an invite is no signer.** A `join` counts only when its signer is an open
  invite with `auto` `1`. Such a PC lets devices in and can allow nobody. An invite with `auto` `0`
  lets no PC in by itself (`invite_not_auto`): the PC asks with its line, and a member's `pc` adds
  it.
- **An invite is open** while its key is a signer, whoever placed it is one, fewer PCs joined with
  it than `uses`, and its time is not over. Otherwise its join takes the first name that applies:
  `invite_unknown`, `invite_revoked`, `invite_void`, `invite_spent`, `invite_expired`.
- **An invite's time is over by the list's own time, and by no reader's clock.** The list's time is
  the latest `issued_at` among the entries that a `full` signer signed and that were not passed
  over. Once it lies after an invite's `exp`, a `join` by that invite has no effect
  (`invite_expired`), whoever places it and whenever. A `join`'s own `issued_at` says nothing: its
  signer is the invite. So whoever finds an old line cannot join with it once any member has
  signed anything since, even where the service places what it is given. A `full` signer that is
  awake past an unused invite's `exp` puts it out (`remove` with `ends`): until one does, the
  holder of the line still reads the names sealed before.
- **A relay key comes in once** (`endpoint_reused`), also after its PC was put out. One row waits
  for more: a carried PC that is still in gets its keys from a person's `pc` at its relay key, and
  never from an invite's `join`. **A PC's key comes in once**, at one relay key: a key that any PC
  ever had here names no other PC, device or invite (`key_reused`). A person's `pc` makes its
  fresh key a `full` signer in that same entry; the `pc` key of an invite's `join` is never one,
  and a key that is or was a signer cannot stand there (`key_reused`).
- **`remove` with `endpoint`** puts out a PC whose key is no signer (one that joined or was
  carried), and only a `full` signer's does (`signer_not_allowed`, then `already_out`). Where the
  key of a PC that joined was made a signer afterwards, the PC goes with its key like one a person
  added: `ends_needed` for its relay key, and the `ends` of the key puts the PC out.
- **`carried`** counts only from the first signer (`signer_not_allowed` from anyone else) and only
  right after entry 0: once a signer has signed anything that is no `carried` that counted, nobody
  is carried in (`carried_late`). It has no card and gives power `full`, so it is how the device
  that starts a list for an account that was in use names who was in it, and no way in afterwards,
  for the first signer or for whoever holds the service. A carried device has no encryption key
  until its own `card` names one, once (`enc_set` after that). A PC that was in the account
  follows such a list only when every device it carries in is one that PC already lets in, all of
  them or none.
- **Names are sealed under the current epoch.** An entry whose `epoch` is another has no effect
  (`epoch_other`): under an earlier key a member that was put out could read the names, and under a
  later one nobody can. Only an `epoch` entry of a `full` signer opens the next epoch, and only when
  it names the current one, so of two members that open it at once one does. A removal opens none
  by itself: whoever puts a member out places an `epoch` entry after the `remove`, and a member
  that signs itself out leaves that to one that stays.
- **A writer seals nothing under an epoch that somebody who is out can read.** It seals under the
  current epoch only when the entry that opened it stands after the last entry that put out a
  device, a PC, or an invite with `auto` `1` (revoked, or void with whoever placed it), and after
  the `join` that took such an invite's last use (the holder of that line held the key too); and
  only while no device that is in is past its `until` and no such invite that is in and still has
  a use is past its `exp`, by the writer's clock. One of those is first put out and the next epoch
  opened after its `remove`. An invite that is out already is not asked for its `exp`: it went out
  with its own end or its placer's, and got no key after that. Otherwise the writer writes its
  entry with no names. This is the writer's rule (`sealEpoch`), which no writer works out for itself; an entry
  that breaks it still counts.
- **A member judges an entry by no clock of its own but for one thing.** A device with `until` is
  let in only before that second by each PC's own clock, which never reads before the list's own
  time or the time that PC last saved (`listClock`); it stays a signer of its power after it, and
  so can still end itself.

How a member writes follows from this. An entry names the entry before it, so a member knows what
becomes of its own entry on its footing before anybody else sees it. It signs an entry only when
that entry counts on its own state (`signListEntry`): it builds the entry, takes it as every member
will, and signs nothing that would be passed over or have no effect. So no member's own entry
leaves a signer with no name.

Two more rules are for writers alone. The account service holds every writer to them, and a member
counts an entry that breaks one all the same:

- **Nobody opens an epoch at will.** A member writes an `epoch` only after an entry that put
  somebody who may hold the current epoch's key out, or took the last use of an invite that a PC
  joins with by itself, at or after the entry that opened that epoch (`signListEntry` refuses any
  other: `epoch_not_needed`). After a removal that is the very next entry, in one batch: the
  `remove`, or several, then one `epoch`. A time that is over calls for no epoch by itself: where
  a device at its `until` or such an invite past its `exp` is still in, nothing is sealed
  (`sealEpoch` says null), and an `epoch` is refused all the same (`epoch_no_use`), since one
  opened while that key is in would be followed by another, and another. That key is put out
  first (`lapsedRemovals` gives the entries), and the epoch follows its `remove` in the same
  batch. So an entry that did not get its place, an add say, is signed again on the new
  head and sealed under the same epoch as before: the service kept nothing of the request that did
  not place, the key wrapped for the newcomer included. Should an add be given up for good, a wrap
  for that key exists only at a service that lied about keeping nothing, and it opens names, never
  a way in.
- **An invite a PC joins with by itself is made for one PC**, with `uses` `1`, for as long as the
  account service keeps invites of its own beside the list: a PC first redeems the invite with the
  service, which takes each invite once, so a second PC under one invite is refused there (`403
  not_redeemed`) whatever `uses` says.

What stays true all the same, and what to do about it:

- **A signer with no name can exist**, where an entry by a `full` signer added a key and had no
  effect of its kind: the signers' rule applies `adds` whatever the kind. It opens nothing and is
  no device and no PC, and it signs what its power allows. Every member lists such signers
  (`listView`), so that a person sees one and ends it.
- **A key that lets nobody in any more can still sign.** An invite that is spent, void or over its
  time, and a `bound` device past its `until`, stay signers of power `bound` until they are ended:
  an entry of theirs has no effect and still takes the next place in the list. The account service
  counts what such a key places and stops it.
- **A device that hands its place to a new key** is out with its old key, and the invites it
  placed are void with it: it places them again.
- **Nothing proves an encryption key.** A card says that the holder of a signing key named this
  `enc`; nobody checks that anybody holds its private half. A wrong one costs that member the
  names, and nothing else.
- **The holder of an `auto` line can name a relay key that is not its own in a `join`**, and a
  service that is not honest places it. It gives no way into that PC: a device holds a PC to its
  relay key, which the holder cannot answer for. It costs the PC that relay key in this list (a
  relay key comes in once) and shows the holder the names. The PC comes back as a new PC, with a
  new relay identity and a new add.
- **A level above 1 must give a `bound` key's entry of a higher `v` no effect that lets anybody
  in.** A member of a lower level applies its `ends`, does nothing of its kind, and is not behind
  for it: only a `full` signer's entry that it cannot read makes it so.

A member that reads an entry whose `v` is above its level applies `adds` and `ends` and nothing of
the kind, and from an entry of a `full` signer that it cannot read it is behind: it lets nobody new
in, and still applies every removal. Besides removals, the one thing it takes in is the keys that
a person's `pc` gives a carried PC that is in, and only where that `pc` passes every check it
passes for a member that reads everything. The reason is a sequence: a carried PC is in; the member
falls behind; a `pc` gives that PC its keys; the key is ended. Without the keys the member could
not tell which PC that end means, and would hold a PC that every other member had put out. Nobody
new comes in by this, and no PC moves to another relay key.

**A member that is behind signs nobody in.** What counts on its own state need not count for a
member that reads everything, since it knows nothing of who came in after it fell behind. So while
it is behind it writes a removal (`remove`) and the `epoch` after one, and nothing else:
`signListEntry`, `signListEntries` and `joinEntry` refuse every other entry (`not_written`, reason
`behind`), a PC's own `join` among them. An app shows that it needs an update, a PC that Ovis on
it does. It lets nobody in while it is behind already; it writes nobody in either. The epoch it
opens after a removal is wrapped to the members it knows (`wrapKeys` of its own state), and to no
invite: it takes no `join` in, so it cannot tell whether an invite was spent since, and the account
service refuses a whole request, the removal with it, for one wrap to a key that is out. So a
member that came in after it fell behind, and a PC that joins with an open invite, get that
epoch's key from a member that reads everything, and have no names until then.

One thing a member that is behind cannot follow: which keys PCs that joined after it fell behind
have. A `pc` that names such a key for a carried PC has no effect for a member that reads
everything (`key_reused`), and the member that is behind takes it. No member writes such an entry
through the functions above: one that reads everything is refused for the key, one that is behind
for being behind. It takes a `full` signer that signs outside them, which is a member that turned
against the list and could remove anybody anyway; its entry can leave a member that is behind
holding that carried PC after the others put it out by its relay key, until that member is
updated and replays.

### A card

A newcomer has no say in the list before it is in it. So it states what nobody else may choose for
it under its own signature, and the entry that lets it in carries that signature in `card`:

```
bytes = "ovis-list-card/1" and the fields enc, key and list, for a PC endpoint, and for a PC that joins by an invite invite, in the form of a body's fields
```

- `key` is the newcomer's signing key (the `adds` of a `device` or `pc`, the `pc` of a `join`),
  `enc` its encryption key, `list` the list id, `endpoint` the PC's relay key, and `invite` the key
  of the invite that signs the `join`.
- The signature is `key`'s, ECDSA P-256 with SHA-256 over those bytes, checked as an entry's is.
- A `device`, `pc` or `join` whose card is not that of its key, for its `enc`, this list, its
  `endpoint` and its invite, has no effect (`card_invalid`). So nobody can name a key that never
  asked to join, give a member an encryption key that is not its own, move a card to another list,
  or take the card a PC made for a person to add it and join that PC by an invite instead.
- A device that was carried in was not there to sign a card: its `card` entry, signed with its own
  key, says the same.
- When a person adds a PC by comparing a number on two screens, the number is bound to the card:
  its binding is SHA-256 over the card's bytes, and the digits come from that binding and a nonce
  from each end, each fixed before it sees the other's, as pairing by comparing digits does
  ([Relay](relay.md)). Digits of the hash alone
  would prove nothing: whoever carries the card between the two could try keys until one fits.

### What is sealed

A member's name and OS word are not needed to decide who is in, so they are not in the clear: the
entry carries them in `sealed`, encrypted under the key of an epoch, which the members share and
the account service never has. How they are sealed and how members share the keys is under
[Names the service cannot read](#names-the-service-cannot-read). No rule above reads `sealed` beyond its length, or needs a key: so a member that was
given no key to the names, or a wrong one, lets in and puts out exactly whom every other member
does, and so does the account service.

What is sealed is fields in the form of a body's fields: `label`, and `os` when the OS is known.
`label` is a name: 1 to 48 UTF-16 units, no control character, no unpaired surrogate, and of white
space only single spaces inside it. `os` is one of `ios`, `android`, `macos`, `windows`, `linux`,
`chromeos`. A reader takes an OS word it does not know as none and passes by a field it does not
know, so a later build may say more; a field named `pad`, which fills a sealed text up to a fixed
size, is such a field and no name.

An **epoch** is the time one such key is in use. Entry 0 opens epoch 0, and each `epoch` entry
opens the next. What opens an epoch says two things of it in the clear: `epoch_opens`, a commitment
to its key, so that a member takes a key for that epoch from nobody unless it gives this
commitment; and `epoch_link`, the key before under the new one, so that a member given the current
key reads the names of every earlier epoch.

In the clear are the keys, the relay key of each PC, each role and `until`, each invite's `exp`,
`uses` and `auto`, and the epochs' numbers: the account service sees how many devices and PCs an
account has and when each came and went, and not what they are called.

### The state

A member's state is plain data that JSON holds: the signers' state, and beside it

| part | named by | holds |
|---|---|---|
| `account` | | the account the list is of, as entry 0 names it |
| `full_at` | | the list's own time: the latest `issued_at` of an entry a `full` signer signed that was not passed over |
| `carrying` | | whether a `carried` still counts |
| `signers` | key | each signer's row, with `as`: `device`, `pc`, `invite`, or none |
| `devices` | key | `role`, `until`, `enc` (none for a carried device that has not named it), `carried` |
| `pcs` | relay key | `how` (`added`, `joined` or `carried`), `key`, `enc`, `seq`, `invite`, `removed` |
| `pc_keys` | key | the relay key of the PC that has or had this key |
| `invites` | key | `exp`, `uses`, `joins`, `auto` |
| `epoch`, `epochs` | number | the current epoch's number; for each epoch `opens`, `link` (none for epoch 0) and `seq`, the place of the entry that opened it |

Nothing is ever deleted. A device or an invite is in while its key is a signer, and a PC while its
`removed` is empty. A PC lets a device in while the device is in and, when it has an `until`, before
that second, as what its `role` says. The key of an epoch is wrapped to the encryption key of each
device and PC that is in, and to the own key of each open invite with `auto` `1`, so that a PC
which joins with nobody else awake can read the names and seal its own (a member that is behind
wraps to no invite, as said above). Whoever wraps leaves out a
device past its `until` and an invite past its `exp`, by its own clock, so that an old line or a
borrowed browser is given no later key; that clock chooses only whom a key is wrapped to, and lets
nobody in and puts nobody out. A member that stopped for a replay answers for nobody until it has
replayed: it lets no device in, holds no PC, lists nothing, takes no invite for open and wraps to
nobody.

A saved state is trusted exactly as far as the member's own storage is. Reading it back checks
that it has its form and agrees with itself (a state whose footing is entry 0 still takes a
`carried`, for one: no entry has closed that), which catches a state that was damaged, not one that
somebody who can write the store wrote with care. A member that starts replays the entries it
kept and holds what the replay gives.

Every entry that holds comes to one of these, the same for every member of one level and for the
account service:

| outcome | when |
|---|---|
| `passed_over` | the signers' rule passes it over: nothing in it applies (`signer_unknown`, `signer_not_allowed`, `key_reused`, `already_out`; a `join` takes its invite's name) |
| `stops` | a member that is behind cannot place it, and takes nothing until it replays (`needs_replay`) |
| `cannot_read` | its `v` is above the member's level: `adds` and `ends` have applied, the kind does nothing |
| `no_effect` | `adds` and `ends` have applied, and the kind does nothing, by the first of: `entry_invalid`; `epoch_other`; what the list holds (`invite_unknown`, `invite_revoked`, `invite_void`, `invite_spent`, `invite_expired`, `invite_not_auto`, `signer_not_allowed`, `already_out`, `ends_needed`, `endpoint_reused`, `key_reused`, `enc_set`, `carried_late`); `card_invalid` |
| `counts` | the kind's rule counts it |

### Reading the log with an invite

A machine that holds a join line is no member yet and still has to read the log. It proves that it
holds the invite: `ovis-list-read/1` and the fields `after` (the place its page follows, or empty
for the start), `at` (when it was made), `key` (the invite's key) and `list`, in the form of a
body's fields, signed with the invite's key and written as one text like an entry. The account
service checks the form (`proof_malformed`), then the signature (`signature_invalid`), then what
the list holds of that invite, and judges `at` and the invite's `exp` by its own clock. A line
signs only such a proof with its own key and list in it, and none that this check would call
malformed.

## Names the service cannot read

The account service stores the list and must not read the names in it: a device's label, a PC's
address, an operating system. A kind puts those fields into one field, `sealed`, encrypted under
the list's current **epoch key**, and every member holds that key **wrapped** to an encryption key
of its own. The service keeps the wraps beside the list and can open none of them.

Nothing of this section is part of when an entry holds, and who is a member never depends on it: a
wrap or a sealed field that does not open hides a name, and nothing else. Which fields a kind seals
and what it calls the clear fields named below belongs to the kinds. The code is
[`shared/account-list-seal.ts`](../shared/account-list-seal.ts); the vectors are in
[`shared/account-list-vectors/seal/`](../shared/account-list-vectors/seal).

```
number(n) = n as 8 bytes, big-endian            a seq or an epoch: 0 to 999999999999999
id(list)  = the 32 bytes the list id spells     for entry 0, which has no list id yet: 32 zero bytes
key(k)    = the 91 bytes a key spells
HKDF(secret, info, n) = HKDF with SHA-256, a salt of 32 zero bytes, n bytes out
GCM(key, nonce, data, text) = AES-256-GCM, a 12-byte nonce: the ciphertext, then the 16-byte tag
```

A wrap, a link and a sealed field each start with a version byte, `0x01`. A new version byte comes
with new tag strings (`ovis-list-wrap/2` and so on), so no bytes of one version open as another's.

### The keys

- A member's **encryption key** is a P-256 key used for ECDH, written as a key. A device makes it
  in WebCrypto so that it cannot be exported and keeps it in IndexedDB. A PC keeps its private key
  in a file, as the base64url of the 138-byte PKCS8 form a join line's secret has.
- An **epoch key** is 32 random bytes. Epochs count from 0: entry 0 opens epoch 0, and after a
  member is removed an entry opens the next. An entry with a `sealed` field says in clear which
  epoch it is sealed under.
- The **commitment** to an epoch key is
  `SHA-256("ovis-list-epoch-key/1" || id(list) || number(epoch) || key)`, as a hash. The entry that
  opens an epoch carries it in clear, under its signature. A member takes an epoch key, from a
  wrap or from a link, only when it gives the commitment the list holds for that epoch. Without
  this the service, which can wrap any key to any member, could hand a new member a key of its own
  and read what that member seals.
- The commitment to the key of epoch 0 stands in entry 0, whose hash is the list id, so no list id
  can be part of it: there `id(list)` is 32 zero bytes, and the commitment binds its own tag, the
  epoch number 0 and the key. What binds it to its list is entry 0 itself: the list id is the hash
  of the body that carries it. Every later commitment binds the list id too.

### A wrap

An epoch key for one member, made by any member that holds the key. It is stored at the service,
never in the list.

```
wrap   = 0x01 X Y GCM(k, n, no data, epoch key)       113 bytes: 1 + 32 + 32 + 32 + 16
X Y    = the point of a P-256 key made for this wrap alone (the ephemeral key)
k n    = HKDF(shared, "ovis-list-wrap/1" || id(list) || number(epoch) || key(member) || key(ephemeral), 44)
shared = the X of ECDH between the ephemeral key and the member's key, 32 bytes
```

`k` is the first 32 bytes and `n` the last 12. On the wire a wrap is 151 characters of base64url
without padding, in its one spelling. A wrap of another length, with another first byte, or whose
point is not on the curve has not the form.

### A link

Each epoch key also encrypts the one before, so a member given the current key reads every earlier
epoch. The entry that opens epoch e carries the link to epoch e-1 beside its commitment.

```
link = 0x01 nonce GCM(HKDF(key of e, "ovis-list-epoch-link/1", 32), nonce, data, key of e-1)      61 bytes
data = "ovis-list-epoch-link/1" || id(list) || number(e)
```

A member walks back one link at a time and checks each key against its commitment. One walk opens
at most 1024 links; a longer history is walked on from the last key reached. The key the walk
starts from is checked against the commitment of its own epoch too.

### A sealed field

```
sealed    = 0x01 nonce GCM(HKDF(epoch key, "ovis-list-seal/1", 32), nonce, data, plaintext)
data      = "ovis-list-seal/1" || id(list) || number(seq) || number(epoch)
plaintext = "ovis-list-sealed/1" field field ...
```

- `list`, `seq` and the epoch are the entry's own, so a sealed field opens only at the place it
  was sealed for: that list, that `seq`, that epoch. It is bound to the place, not to one entry.
  When two entries are written for one place (two members reach for the same `seq`), the sealed
  field of either opens in the other. Which body stands at a place is said by the entry's
  signature and the chain, which cover the bytes of `sealed` like every other field.
- The plaintext's fields have the form of an entry's fields: lengths of 4 bytes, names ascending.
  A sealed field is the plaintext and 29 bytes, and at most 8192 bytes.
- A writer fills the plaintext up to 256 bytes, or to the next multiple of 256 when it is longer,
  with one more field, `pad`, of zero bytes. So a sealed field is 285 bytes whatever short names
  it holds. `pad` is no name of any kind: no kind writes it, and a reader drops it whatever it
  holds. A reader also reads a plaintext that is not filled.
- A member seals only under a key that gives the commitment the list holds for its epoch, the
  same check as when it took the key.
- The nonce is 12 random bytes. It is never made from `seq`: a member whose entry n lost its place
  signs another entry n, with other fields, and a nonce made from `seq` would come twice under one
  key.
- The bound of one epoch key counts sealings, not entries: every time any member seals a field
  under that key, for an entry that got its place, for one that lost it to another member's, and
  for every new try. Among n sealings under one key the chance that two nonces are equal is under
  n² / 2^97, and it stays under 2^-32 up to 2^32 sealings. For a sense of the size: the account
  service takes at most 16384 entries into one list; with every one of them sealed under one key
  and a thousand sealings for each, the chance is under 2^-49.
- The epoch key never encrypts by itself: fields and links each use a key of their own made from it.
- An epoch key belongs to one list and one epoch. It is never used for another list or made the
  key of another epoch. The library holds both ends of that for a link: it makes none between two
  epochs of one key, and a link that opens to the very key it was opened with gives no key
  (`other_key`). Whoever was put out holds the key before, and would read on under the next number.
- Entry 0 opens epoch 0, so its names are sealed under epoch 0 and no other. A writer seals none
  under another, and for a reader a field of entry 0 under another epoch has not the form (`form`),
  whatever its bytes are.

### Who seals, and when

The library sees no list, so these are rules for the member that writes an entry.

- A member seals only under the list's current epoch, and only when the entry that opened that
  epoch comes after the last entry that took a key out of those the epoch key is wrapped to: an
  entry that ends a device's, a PC's or an invite's key (a revoked invite too), or that removes a
  PC by its address. Otherwise it seals nothing and writes its entry without names. Sealed under
  any other key, the names would be read by a member already removed.
- So after a removal nothing is sealed until a member that stays has opened the next epoch. The
  remover places both entries in one request. Where it cannot (a device that signs itself out
  cannot make the key for those that stay), the entries written meanwhile carry no names.
- An epoch that the member being removed opened itself just before its removal does not count: its
  opening entry comes before the removal, and that member holds its key. A member that stays
  opens another.
- What remains: a member from which the service withholds the removal itself does not know of it
  and still seals under the old key, which the removed member holds. Nothing in the list stops a
  service from withholding entries; the harm is bounded to the names written by members that have
  not yet seen the removal.

### A removal, an addition

- After a removal a member that stays makes the next epoch key, puts its commitment and its link
  into the entry that opens the epoch, and gives the service a wrap for every member that stays,
  in the same request. What was sealed before stays readable to the removed member, its own
  removal included; its key and its old wraps open nothing sealed under the new key.
- Every attempt to open an epoch makes a new key. A key whose wraps went out in a request that did
  not place its entry is never used again: by the next attempt the members that stay may be
  others.
- A member that adds another wraps the current epoch key to it, in the request that places the
  entry. If that request does not place the entry, the member signs the entry again on the new
  head and goes on under the current epoch; it opens no epoch for that. The service keeps nothing
  of a request that does not place, the wrap included. If the addition is given up for good, a
  wrap for a key that never became a member's exists only at a service that kept it against this
  rule: it opens names, until the next removal moves the epoch, and never a way in.
- A member whose encryption key is not a point of the curve gets no wrap; the removal or the
  addition goes on without it.

### What the service still learns

The service reads no name. It does see, of every list:

- which entries carry names and under which epoch, and when each epoch opens;
- the length of each sealed field, which is the length of its plaintext and 29 bytes. Filled, a
  plaintext is 256 bytes unless its names are long: then the service learns in which multiple of
  256 bytes they end;
- the encryption key of every member, which key each wrap of each epoch is for, and so which
  member has no wrap;
- everything an entry says in clear.

### What does not open

Opening never fails with an error. It gives the key or the fields, or one of these, and the device
or PC is then shown without its name:

| why | when |
|---|---|
| `missing` | no wrap, link, key or sealed field was given |
| `form` | a wrong length, another first byte, a point not on the curve, a plaintext that is no fields, a place that is none (a list id with seq 0, none with a later seq, entry 0 under another epoch than 0) |
| `refused` | in form, but the tag does not hold: another member's wrap, another list, seq or epoch, another key, a changed byte |
| `other_key` | a wrap or a link that opens, to a key that is not the one the list commits to, or a link that opens to the key it was opened with. The name is hidden like any other, and the member also says so, because this is no lost or stale wrap. From a wrap it means the account service gave a wrong key: the service stores the wraps, and this is a sign of tampering. From a link it means the member that signed the entry which opened that epoch wrote a wrong link: the link is in the signed list, not the service's to change |
| `bound` | the walk back opened as many links as one walk may |
| `unavailable` | the runtime could not do it (no WebCrypto on a page on plain http): a fault of the place, not a verdict on the bytes |

## Following a list

A member (a device or a PC) keeps its own copy of the list and lets in whom its copy says. The
account service only stores the log, and it may be wrong, late or lying: it can withhold entries,
answer with an old part of the log, or show two members two different histories. So nothing below
takes the service's word for who is in. The code is
[`shared/account-list-follower.ts`](../shared/account-list-follower.ts); it has no I/O, no storage
and no clock of its own: a caller hands it the saved text, a page, the hour (seconds since 1970)
and what happened, and gets back the new copy, what changed and what to do next. Every entry is
taken by the rules above, and none of them is changed here.

### The pin

A member follows exactly one list id for an account, and the id never comes from the account
service's word. Where it came from is the member's **pin**, and it says what the list must show
before the member acts on it:

| pin | who | the list id came from | the member is in when |
|---|---|---|---|
| `genesis` | a device | the entry 0 it made itself, once the service took it | entry 0 is signed by its own key |
| `allowed` | a device | the member that allowed it, with that member's head (`seq`, `hash`) | the log reaches that very entry, and its key is a device |
| `carried` | a device | an account in use before it had a list; a PC the device had paired with names the same id | its key was carried in |
| `added` | a PC | what a person compared, scanned or sent at that PC, or a join line | its relay key is in the list with its own signing key |
| `migrated` | a PC | an account in use before it had a list; `admitted` is the keys checked for it before the pin: entry 0's signer and every key the list carries in | entry 0's signer and every device that was carried in are among `admitted` |

- **A pin is one-way.** A member that has saved a copy is pinned: no page, no hint and no second
  pin changes its list id. Only a person's reset at the member, which deletes its save, takes the
  pin off. A save that does not read is still a pin.
- Entry 0 must be a `genesis` with the pinned list id and the member's own account, signed by whom
  the pin asks for. An entry 0 of another list, of another account or by another signer is
  `not_my_list`. One that is no entry at all, or whose signature does not verify, is `refused` like
  any entry that does not hold: in each of these cases nothing of it is kept. A `genesis` of a level
  the build cannot read, signed by whom the pin asks for, is `needs_newer_client`, and of that one
  the member keeps the text (below).
- Before it is in, a member lets nobody in and shows no PC, though it holds entries.
- A member whose entry 0 only a later level reads keeps that entry's text and stops there, as at
  any entry its build cannot place: it reads no more until an update. The text is saved with its
  pin (`stop`), so that the build that reads it goes on from it.
- A device that was allowed takes, at the place of the head it was handed, no other entry: a log
  with another entry there is not the list it was let into.
- A PC that was `migrated` never widens, all or nothing. A list whose first signer is not among
  `admitted` is `not_my_list`. A list that carries in a device that is not among them is one it
  follows none of: a carried key is a `full` signer, so it could add whom it likes. Such a PC lets
  nobody in.
- What a pin asks for is read at the key the member came in by. Whether a device is in is read at
  the key that stands in its place now: a device that handed its place on to another key of its own
  (a `device` entry that ends its signer) is in while that key is, and out once an entry ends it.

### A page

A member asks for the entries after a place it holds and gets a **page**: the entries, and the
head (`seq`, `hash`) of whoever answers. The entries are taken as above; then the head is held
against the copy. A member is caught up only when it holds the entry at the head's place and that
entry has the head's hash, so a head that the entries do not reach never counts. What a member
holds after a read does not depend on where the pages were cut.

| verdict | when | then |
|---|---|---|
| `caught_up` | it holds every entry up to the head | from the account service this is a full read |
| `more` | it took what was shown and the head lies further | ask for the next part at once |
| `asks_after` | another continuation above its footing | ask again from the footing, once in a read |
| `spent` | the read made its 128 requests and there was more to ask | what it took is kept; go on at the next read, and ask a peer meanwhile |
| `withheld` | the head lies past what was shown, and nothing new was shown | wait for the next read |
| `older` | the head is an earlier place of its own history, and no entry was shown | nothing changes |
| `refused` | an entry does not hold, or the page is out of form (also a head that lies before the entries it shows) | what held before it is kept |
| `stuck` | another history at or under its footing, with no member's signature shown for it | nothing of it is taken |
| `fork` | the same, signed by a member, and not [what its writer left behind](#two-histories) | the alarm is set |
| `needs_newer_client` | it stopped at an entry its build cannot place | it answers for nobody until an update |
| `not_my_list` | another list or account than it is pinned to | nothing changes |

- No page makes a copy shorter under its footing, and none takes out a member that no signer's
  entry put out. So an old part of the log served again undoes no removal.
- A copy holds at most 20480 entries, and at most 16 past its footing: an honest log has none
  there, since each is an entry that no signer signed. Such entries let nobody in, are told to no
  other member, and give way to what a member signs. A member stops for a newer client only at an
  entry it holds every entry before: one that stands past those 16 it never comes to.
- A read ends by itself, whatever its pages say: it makes at most 128 requests, and goes back to
  its footing once. What is left is asked at the member's next read, from where this one came to.
- A page costs one check for each entry it shows, at most 256. Only a history that a member did
  sign, shown under the footing, makes a member check its own history again, and that ends the
  read. Reads by the clock are spaced by the rules below; a member spaces by itself the reads that
  somebody else can start: one on the doorbell, and a page a peer sends unasked.
- With each page a member is told whom it lets in or shows now and did not before, and whom it did
  before and does not now. When the member itself stops, is put out or no longer holds what its
  pin asks for, that is everybody it held.
- A head the service names beside something else (a PC's mailbox answer) is only a hint to read,
  and only the service's: what another member says of where it stands is never a full read.
  One that equals the member's own head, the last entry it holds, counts as a full read; one behind
  that changes nothing,
  and neither does a service that names no list: that is no hint, never the word that the list is
  gone.

### Two histories

`stuck` costs nothing to cause: a head with a made-up hash is enough. So it changes nothing and
raises no alarm; the member just takes nothing from that answer.

A **fork** is proven. When an answer shows another history under the footing, the member looks for
the place where the two part: first at the place the answer's head names, then from earlier places,
twice as far back each time, and once it has seen an entry both hold, half way between that and
where they are known to have parted. So it finds the place in about twice as many requests as the
history has doublings (some 30 for the longest list), whatever the size of the pages. At that
place it replays its own history up to there with the shown entries after it. If a key that was a
signer there signed on the other history, two histories are each backed by a member. An entry by a
key that was no signer at that place, the account service's own included, proves nothing, and
neither does a signer's name on an entry it did not sign.

**What a member left behind is no fork.** A member signs twice at one place honestly: its entries
did not get their place, because another member's got it first or the answer was lost, and it
signed them again on the new head. The account service holds every post it did not place and can
show it later. So there is no alarm when, from the place where the two part, the entries a member
signed on the other history are at most 16 (one post), all by one signer, the first of them at
that very place, and that signer has an entry of its own in this member's history at or after that
place: it went on over what this member holds, and nobody else signed on what it left behind. Such
entries are `refused` like any entry that does not continue the member's history, and nothing
changes. Where a page ends inside them, the member asks for what follows and judges both together,
so the cut of a page never decides. Anything else is a fork: an entry there by any other member,
more by that signer than one post holds, a signer that never signed again in this member's
history, or entries that stand on one no signer signed.

A member with the alarm:

- keeps its own history and never takes the other one;
- still takes what continues its own history, so a removal still reaches it;
- lets in no device and shows no PC that it did not hold when the alarm rose;
- keeps the alarm over a restart, with the place where the two histories part (`seq`) and the key
  that signed the entry of the other one that it was shown (`by`).

**What the alarm says.** That this member was shown two versions of the list. It accuses nobody:
`by` is the key that signed what was shown, which may be an honest member's (an entry that a
member that was shown it as placed still holds, while the rest of the account went on elsewhere).
Whoever holds both versions chooses whom to show which, and that is first of all the account
service, which keeps every signed post. A key that was ever a signer can sign a second version at
will: a device or a PC of the account, a browser that was allowed for a day, an invite's key, and
one that was removed since, for a place before its removal. Nobody gets in by an alarm: it only
stops a member from letting in anyone new.

**What stays out of sight.** Two versions that each hold nothing but what one and the same member
posted from the place they part raise no alarm on either side, for as long as nobody else signs on
either. The first entry by any other member raises it on the member that is shown it. And a member
that was shown as the list an entry that never got its place holds it for good: it takes nothing
of the list from there on, and gets the alarm when it is shown the list.

**What a person does.** The alarm does not go away by anything the log or the service says. On each
member that has it, a person resets the list there and pins again: a device is allowed again from
a device or PC of the account, and a PC is added again at the PC. A member that was reset reads the
list from entry 0 and holds whatever version it is then shown and can check, which need not be the
one the person's other devices hold. So they go one member at a time:

1. Reset one member, and look at the devices and PCs it shows afterwards.
2. If one of them is not theirs, it has to go out of the version THAT member holds. A removal
   signed on another version does nothing there. So they remove it at that member itself where it
   may sign (a device, or a PC that a person added), or from a device that shows the very same
   devices and PCs.
3. They check that it is gone at that member before they reset the next one.
4. If it does not go, or two of their members still show different devices and PCs, they stop: the
   members are still on two versions, and resetting more of them only moves more of them onto a
   version they have not checked.

### Two members meet

When a device and a PC are connected, each tells the other its list id and its **footing**, the
last entry a member signed in its copy. Comparing gives `same`, `behind` (it asks the other for
entries), `ahead` (the other asks), `differs` (the other holds another entry at a place this member
holds: it asks for that entry) or `not_my_list` (another list id: nothing is asked, nothing
changes).

The answer is a page of the other member's own entries up to its footing, and it is taken exactly
as a page from the account service, except that it is no full read. So a removal the service
withholds from a PC reaches it from any device that has it. Two members whose histories parted both
ask, and each judges what the other shows: where members signed on both, both get the alarm; where
one of them holds only what its writer left behind, that one gets it. Two members that met stand at
the same entry or one of them has the alarm, but for [what stays out of sight](#two-histories).

### What a PC decides

A PC decides from its copy alone, never from an answer of the service and never from how old the
copy is. A service that is away or withholds takes out no device the PC holds.

- **A device opens a session** when the PC is in, the device's key is in and, where it has an
  `until`, before that second by the PC's clock. It opens as its `role`. Otherwise the refusal is
  the first of: the PC itself is `waiting`, `stopped` or `out`; `never_added`; `removed`; `frozen`
  (the alarm); `expired`.
- **The PC's clock never counts for less than it showed before**, nor for less than the list's own
  time (`listClock`). Each page and each hint is taken at the hour the clock shows, and the copy
  keeps the latest (`seen_at`). With the account service away no page comes, so a PC also notes the
  hour when it starts and whenever it reads its clock to decide (`withClock`), and decides on the
  copy that gives. A clock that was set back then lets no device in past its `until`. Over a restart
  a PC holds the hour of its last save and no later one, so it saves that copy before it acts on a
  decision that turned on the clock. A decision never counts the clock for less than the copy it
  is handed holds, and no more than that: an hour that was read and not noted, or noted and not
  kept, is lost, and a clock set back after it lets the device in again.
- **A PC is a member** when its signing key belongs to a relay key that is in.
- **A device shows** the PCs that are in. The account service's directory only says how to reach
  them.

### When a member reads

| member | reads |
|---|---|
| a PC | every 300 seconds; every 30 while a session is open |
| a device | every 30 seconds while its app is in front, and when it is rung |

The time runs from when the last read began, also one that failed, so a service that is away is not
asked faster. Before it lets a new session in, a PC whose last full read is older than 30 seconds
reads first, and the session waits at most 5 seconds; then the PC decides on its copy as it is. A
member that is out, or that needs a newer client, reads no more.

### The save

A member saves its copy as one text: JSON in one form (each object's members in ascending order of
name, no white space).

| member | value |
|---|---|
| `v` | `1`: the version of the save's own members |
| `account`, `list` | the account's id and the list id it is pinned to |
| `me` | `key`, its signing key, and `endpoint`, a PC's relay key (`null` for a device) |
| `pin` | `how`, and with it `seq` and `hash` (`allowed`) or `admitted` (`migrated`, in ascending order) |
| `entries` | every entry it took, from entry 0, each as its text |
| `footing` | the place (`seq`, `hash`) of the last entry a member signed; `null` before entry 0 |
| `level` | the [level](#levels) of the build that saved |
| `state` | [the state](#the-state) those entries gave that build; `null` before entry 0 |
| `stop` | the text of the entry it stopped at for a newer client (entry 0's, for a member that holds no entry), or `null` |
| `read_at` | when it last held everything the account service showed, or `null` |
| `seen_at` | the latest hour its own clock showed when it took a page or a hint or noted the hour, or `null` |
| `alarm` | `null`, or `code` (`fork`), `source`, `seq`, `by`, `at`, and the `devices` and `pcs` it held then |
| `sum` | SHA-256 over `ovis-list-save/1` and the text of the same object without `sum`, as a hash |

It holds nothing secret.

**The entries are what a save holds as true; its state is only what they gave the build that
saved.** A member that starts replays its entries from entry 0, checks each as when it first took
it, and holds the state the replay gives. Where that is not what was saved, the save is
**rebuilt**: the member goes on with the replayed state, notes it once and saves again. `rebuilt`
says exactly that the member now writes its save as another text than the one it read. That happens when a
later build holds other things in a state or judges an entry by a later rule, and when the saved
state was changed. So no update of the app or of a PC makes a member start over, and no state
reads that the entries do not give. The replay never gives a shorter history than the saved one:
it must reach the saved `footing`, with the very entry there.

A build reads its own `v` and every earlier one, each by replay. A save reads whole or not at all:

| refusal | when |
|---|---|
| `form` | no JSON, a member missing, extra or out of form, or not the one form |
| `version` | a later build's save: a later `v`, or entries that only a later level can place |
| `sum` | the text is not the one that was written |
| `broken` | the entries do not hold: one does not verify or does not continue the one before it, they end before the saved footing or show another entry there, entry 0 is not the pinned list's, is of another account or is not signed by whom the pin asks for, the entry at the place an `allowed` pin names is another, or the stopped entry is not the next one |

The sum finds a damaged file. It does not stop whoever can write the member's store, who holds the
member's private key too. A save that does not read is still a pin: only a person's reset at the
member starts it over.

## The join line

A machine joins an account by an invite. The device that makes the invite shows one line, once, and
the machine is given that line. The code is
[`shared/account-list-join.ts`](../shared/account-list-join.ts); the vectors are in
[`shared/account-list-vectors/join/`](../shared/account-list-vectors/join).

```
line = "ovis-join:1:" base64url(json)       at most 1024 characters in all
json = {"v":1,"service":S,"account":A,"list":L,"secret":K}
```

| member | value |
|---|---|
| `v` | the number `1` |
| `service` | the account service's origin, as the URL standard serializes the origin of an `https` URL: `https://host` or `https://host:port`, the host in lower case, with no default port, path, query, fragment or user. A text is in this form when parsing it as a URL and serializing that URL's origin gives the same text back |
| `account` | the id of the account the invite is for: 1 to 64 of `A-Z a-z 0-9 _ -`. It is not secret: a machine shows it and asks before it joins |
| `list` | the list id, or the empty text while the account has no list |
| `secret` | the invite's P-256 private key: the base64url (184 characters) of its PKCS8 in one fixed form of 138 bytes, which holds the public point too |

- The line has one form. The JSON is those five members in that order, written as `JSON.stringify`
  writes them, with no white space; the base64url has no padding and is in its one spelling. A
  reader writes the line again from what it read and refuses a line that differs (`not_one_form`).
- A reader refuses with the code `line_malformed` and one reason. For a line that is not in its
  form: `prefix`, `length`, `base64url`, `json`, `members`, `version`, `service`, `account`, `list`,
  `secret`, `scalar` (a private value not from 1 to n-1) or `not_one_form`. For a line in its form
  that the reader's caller must not act on: `other_service` or `needs_lists`. The line carries a
  private key, so no refusal holds any part of it.
- **A line's `service` is never a destination.** A reader is told the account service its caller
  already uses (the build's, or the one the PC is set to: production, staging or a self-hosted one)
  and takes only a line whose `service` is that service's origin; any other is refused
  (`other_service`) before anything is sent anywhere. The two are compared as text, after the
  caller's own is parsed as a URL and its origin serialized: the scheme, the host and the port
  count, and a path does not. So a line somebody else made cannot send a machine's proof or its
  listing to an origin of their choosing. What `service` is for, then: it binds the line to one
  service, so that a line made for one (staging, say) is no line at another, and it is the service
  whose entries the list's `invite` and `join` will be placed at.
- **A caller that does not follow lists is given no line that names a list** (`needs_lists`): the
  list id says the account has a signed list, and joining it on the service's word alone would undo
  what the list is for.
- A line that reads gives the service, the account, the list id (or none) and the invite's public
  key as [a key](#the-form). It gives no private key. It signs three things and nothing a caller
  composes: the message a machine redeems an invite with ([An invite is a key](#an-invite-is-a-key)),
  for the line's own account; a `join` entry of its own key on its own list that adds no key and
  ends none, which a PC builds from its own keys and never from what it was sent; and the proof by
  which its holder reads its own list ([Reading the log with an invite](#reading-the-log-with-an-invite)).
  And it holds the secret once more as a key that only agrees on a shared secret (ECDH), which
  opens what was encrypted to the invite's key. Neither can be exported.
- No released build wrote a line before the account was in it, so there is one form and one
  version. A line without `account` is refused (`members`).

## An invite is a key

An invite is a P-256 key pair. The code is
[`shared/account-list-invite.ts`](../shared/account-list-invite.ts); the vectors are in
[`shared/account-list-vectors/invite/`](../shared/account-list-vectors/invite).

- The **device** makes the key pair, gives the account service the public key alone, as
  [a key](#the-form), and writes the line. It keeps nothing: the line is the only copy of the
  private key.
- The **account service** stores the public key and never sees the private key or the line. So it
  cannot use an invite, and it cannot sign for one. This is about what an invite is worth, not
  about who is in an account: until an account has a signed list, the service admits a PC on its
  own word, with an invite or without one.
- The **machine** that joins proves it holds the line: it signs these bytes with the line's private
  key, and sends the invite's public key and the signature.

```
bytes = "ovis-invite-redeem/1" len(account) account len(server_id) server_id
        len(public_key) public_key len(challenge_id) challenge_id
len(x) = the number of bytes of x, as 4 bytes, big-endian
```

| value | |
|---|---|
| `account` | the account's id, as in the line |
| `server_id` | the machine's id: 32 of `0-9a-f` |
| `public_key` | the machine's relay key: 64 of `0-9a-f` |
| `challenge_id` | the id of the account service's challenge that the machine's own proof answers in the same request: 32 of `0-9a-f` |

- The signature is ECDSA P-256 with SHA-256 over those bytes, `r || s`, sent as 86 characters of
  base64url with no padding, in its one spelling. It is checked as an entry's signature is: any `r`
  and `s` from 1 to n-1 that verify count, and a key whose point is not on the curve verifies
  nothing.
- The service finds the invite by its public key and checks the signature with the account that
  invite belongs to. The bytes name the account, the machine and one challenge, which the service
  uses up, so a signature that was seen once joins nothing else.
- What the service learns at a redeem: the invite's public key (which it has), the signature, and
  the machine's id, relay key and challenge id, which the machine's own proof gives it too. A
  redeem signature counts nowhere else: no entry and no other proof starts with its bytes.
- These are values and lengths with no names, as in the other proofs a device or a machine signs
  for the account service; an entry's body has named fields.

A device whose sign-in is older than ten minutes proves its registered key when it makes an invite,
as it does when it adds a PC ([Linking devices with an account](account.md#rules)). What it signs
names the invite's public key, so a proof made for one invite registers no other:

```
bytes = "ovis-pc-add/1" len(purpose) purpose len(account) account len("") "" len(invite_key) invite_key
        len(challenge_id) challenge_id len(challenge) challenge
```

`purpose` is `invite`, or `invite-auto` for an invite a machine joins with by itself; the empty
value stands where a PC's id stands in the other proofs of this form, and `invite_key`, the
invite's public key as [a key](#the-form), where a listing id does. `challenge` is the text the
account service gave, as its UTF-8 bytes. Half of a surrogate pair alone has no such bytes (it
would be written as U+FFFD, the bytes of another text), so a challenge that holds one is refused.

**What a line signs for a PC's card** (`lineProofBytes`, `lineChallenge`). A line can also say
that one particular PC joins one particular list with it. It signs a message of its own:

```
"ovis-list-line/1" || account || server_id || the PC's relay key || challenge
                      each of the four after its length, 4 bytes big-endian

challenge = the first 32 hex digits of
            SHA-256( "ovis-list-join/1" || list id, as its text || the binding of the PC's card )
```

The card is the PC's own for that list, with its relay key and no invite named, and its binding is
SHA-256 over the card's bytes ([A card](#a-card)). So the signature names the account, the PC's id
and relay key, the list, and the very keys the PC asks to be added with. The line works the
message out from the card it is given: nobody hands it a challenge to sign. It is no redeem
message, and that matters. A redeem signature is over a challenge the account service chooses, so
if the two were one message, an account service that lies could hand a PC the challenge of a card
of its own to redeem with, and hold the line's word for keys the PC never had. With a tag of its
own, nothing else the invite's key signs stands in for it, and it redeems nothing. The vectors are
`invite/line-challenge.json` and `invite/line-proof.json`: every reader (the PC, the app, the
account service) builds and checks the message with these functions (`verifyLineProof`).

## On a device

The hosted app, in a browser at app.ovis.sh and in the phone apps, keeps its own copy of its
account's list, checks every entry of it itself, and starts the list for an account that has
nobody in it yet. The code is [`src/lib/account/accountList.ts`](../src/lib/account/accountList.ts)
and the `list*.ts` files beside it; it takes every entry through
[`shared/account-list-follower.ts`](../shared/account-list-follower.ts) and decides nothing of its
own about who is in.

Three things bound what this does today:

- **Only for an account the account service keeps lists for** (the service's switch). For any other
  account the app asks one question when it reads a sign-in, `GET /v2/lists/mine`, and is answered
  as for an unknown route (`404`). It keeps the time of that answer and asks again a day later at
  the earliest, however often the app starts and whichever page asks. It makes no key and sends
  nothing else.
- **Only a device that is in the list goes by it.** For such a device the account's PCs are the
  ones the list holds, and it lets a device in and puts a PC out by entries it signs
  ([PCs of a list account](#pcs-of-a-list-account), [Letting a device in](#letting-a-device-in)).
  A device of an account with no list, and one that waits to be let into a list, go by the account
  service's directory, as [Linking devices with an account](account.md) says.
- **A PC's own page follows no list.** It lists the account's PCs by the directory, as before.

### Its keys

- **The member key is the account key** ([rule 2](account.md#rules)): the ECDSA P-256 key the device
  already has, which WebCrypto made so that it cannot be exported. It signs the device's entries
  and its card. A sign-in that ends and a token that is refreshed leave it as it is.
- **The encryption key** is a second key, ECDH P-256, made on first need, also so that it cannot be
  exported. Epoch keys are [wrapped](#a-wrap) to it. It is kept beside the account key and
  forgotten with it: a device that has a new account key is a new member, and names a new
  encryption key.
- **The card** ([A card](#a-card)) is the device's signature, with its member key, over its two
  public keys and the list id: what it hands whoever lets it in.

Both private keys are stored as the key objects they are, in the IndexedDB database `ovis-account`.
No code of the app can read their bytes, and neither can anything else that runs in the page.

### What it keeps

In an IndexedDB database of its own, `ovis-account-list`, by account:

| record | holds |
|---|---|
| `copy` | the device's copy as the follower saves it: one text with every entry from entry 0, the state they give, and why the device follows this list id |
| `wraps` | the wraps of the epoch keys, as text, that opened to the key the list commits to |
| `genesis` | an entry 0 that this device signed and has not yet found in its copy, to send again as it is |
| `shadow` | what the copy and the directory differed in |
| `asked` | when the account service last said that it keeps no list for the account |
| `dropped` | the ids of the entries 0 this device signed and gave up for good |
| `offer` | the place in a list that a member who let this device in handed it, until the log shows it |
| `times` | when the copy was last read in full, and the floor of the device's clock, for the list it names |
| `seen` | for each PC that is new to this device, the place of its entry and when the device first held it |

- **No key is in it.** An epoch key is never stored: each page opens the wraps again with the
  device's encryption key and holds the keys in memory. So what is kept is text and numbers, and a
  name is in it only sealed.
- **It is a database of its own** because `ovis-account` has one version that pages of older builds
  still open, and because a copy grows with the list while the records beside the account key are
  read on every request.
- **It is read strictly.** A `copy` that does not read (a changed byte, another form, entries that
  do not hold) is reported as `damaged` and kept as it is; one that a later build of the app wrote
  is reported as `newer_save`, which asks for a newer app, and kept too. Either way the device then
  follows nothing and puts nothing in its place, since a device that lost its copy must not take the
  account service's word for a new one. Only a person's reset forgets it. A `copy` that was saved
  under another account key is dropped: with a new key the device is another member. A `copy` whose
  entries hold and give another state than the one saved with them (a save of another build, after
  an update) is no damage: the entries are the truth, and the device writes the copy again as this
  build writes it.
- **What protects it is the app's origin**, as for the account key. A PC's own page is served at
  the PC's address, another origin with a storage of its own. A page rendered from a PC's file
  runs in a frame with no origin of the app's ([relay.md](relay.md), "Rendered HTML pages"), a web
  page in the side panel has its own origin, and the service worker opens neither database.
  Whoever can change the script the app's origin serves can use the keys, here as before.
- **A sign-in that ends** (a sign-out, a sign-in the service ended) forgets the wraps and a genesis
  that was not seen placed, as it forgets the names of the account's PCs: nothing left on the
  device opens a name, and the names a page had open go from what it shows. The copy stays, since
  the device is still a member with the key it has: a later sign-in takes up where this one stood,
  and asks the account service for the wraps again. A read that ends after another sign-in was
  stored, or none, shows nothing of the account it began with.
- Leaving the account and deleting it forget everything kept for it, and end the read under way
  for it rather than wait for it: that read writes and shows nothing after.

### Starting the list

A device makes entry 0 itself: a `genesis` under its member key that names the account and its
encryption key, opens epoch 0 by the commitment to a new key, and seals the device's own name under
that key. It signs through the kinds' own writer (`signGenesis`), which signs entry 0 only when it
starts a list a member follows. It wraps the key to itself, sends the entry and that one wrap
(`POST /v2/lists`), and forgets the key: the wrap is what is left of it.

It does so by itself only when all of these hold, asked in this order at each read:

1. the account service says the account may have a list and has none (`GET /v2/lists/mine` answers
   `list: null`);
2. the device has saved no copy for the account, not even one that does not read;
3. the sign-in is new: made at most nine minutes ago, by the device's clock. A device that signed
   an entry 0 while its sign-in was new, and has not seen it placed, is not asked this again;
4. what the page stores lasts: it runs inside the app, or the browser already says that it keeps
   this site's data (`navigator.storage.persisted()`; the browser is never asked to, which prompts
   in some). A list whose one member lost its keys lets nobody in, so a browser tab whose data may
   be cleared waits for another device to start the list, and the account goes on without one;
5. the key this sign-in registered with the account service is the first in the account's order:
   no device registered a key for the account before it;
6. the device holds no pairing that is linked to the account;
7. the sign-in is an app's own (`GET /v1/session`);
8. the account's directory lists no PC, confirmed or not.

So a list starts by itself for a new account whose first device is this one, and for no account
that was in use: such an account has devices and PCs that entry 0 could not account for, and
bringing them into a list is not built yet. Setting `localStorage["ovis-account-list-genesis"]` to
`always` in the app's page starts a list whatever 3, 4, 5, 6 and 8 say (who was in the account is then
not in the list), and `never` starts none; both are for testing.

- **A genesis is kept before it is sent, and sent again as it is.** A lost answer or a closed page
  never makes a second one: the device finds the entry it kept, and once the account service names
  a list it reads entry 0 and sees whether it is its own. It sends the entry again at its next
  reads, also when the sign-in is more than nine minutes old by then; the proof below goes with it
  once the account service asks for one. Two tabs take turns, so one of them signs
  it and the other finds it; in a browser without Web Locks both may sign one, and the account
  service takes one of the two.
- **Entry 0 is dated by the device's own clock**, whatever the account service says the time is: a
  member signs no time on the service's word. The service takes no entry dated more than ten
  minutes ahead of its own clock, and where it refuses entry 0 for that the device says that its
  clock looks wrong (`clock`).
- **An entry 0 that is given up is given up for good.** One that the service refuses as an entry
  was not placed and never will be as it is, and one that lost to another device's is not the
  account's. The device forgets it, writes its id down (`dropped`), signs another at its next read
  where it still may, and never follows the list of an entry it gave up, whoever names it later
  and after a reload too.
- **One list per account.** Of two devices that start at once the account service takes one
  (`409 list_exists` for the other). The other device reads entry 0 of the list the service then
  names, sees that it is not signed with its own key, and follows none of it: it is in no list
  until a member lets it in.
- **An old sign-in proves itself with its registered key** instead of signing in again, as for
  adding a PC ([In one press](account.md#adding-a-pc)): the purpose is `list-genesis`, with the
  list id where a PC's id stands and no listing. By itself a device signs an entry 0 only from a
  new sign-in, which needs no proof; it sends the proof only with an entry 0 that it signed then
  and sends again later.

### What a device writes after entry 0

So far a device writes entry 0, the entry that lets another device in
([Letting a device in](#letting-a-device-in)) and the entries that put a member out
([Putting a member out](#putting-a-member-out)). The rules its writer keeps, for every entry:

- **Only through the kinds' writer** (`signListEntry`, `signListEntries`), which builds an entry on
  the device's own footing and signs it only when it would count there. An entry that would not
  count is not signed: the device reads the list again and tries anew.
- **Names are sealed only where `sealEpoch` says so**, on the device's state, by the list's clock
  (`listClock`). The device never decides for itself under which epoch it seals.
- **It never writes a member without a name because the list was left untidy.** `sealEpoch` says
  no after a removal, and also while an invite that a PC joins with by itself is past its `exp`
  unused, or a device that is in is past its `until`: whoever holds such a key still has the
  current epoch's key. The device then sends one request: a `remove` for every such key, one
  `epoch`, then the entry with its names sealed under the epoch that request opens, and the new
  key wrapped to everybody who is in after the whole of it, the newcomer included. With one such
  key left in, the names are refused. Only when the account's requests are spent does the tidying
  go first by itself (it is counted on its signer alone), and the entry after it.
- **It opens an epoch only after a removal.** The account service takes an `epoch` entry only
  where `sealEpoch` says no right before it (`epoch_not_needed` otherwise), and for an invite or a
  device whose time is over only directly after its `remove` (`epoch_no_use`). A device never
  opens one for any other reason, and after a request that was not placed it makes the next
  epoch's key anew: none of that request's wraps were kept.
- **It judges time by its own clock and dates an entry by it**: its clock, held against the floor
  it saved and the list's own time (`memberClock`). The account service's clock decides nothing
  and is never signed. The service judges by its own, so its answer and the device's can differ:
  `epoch_not_needed`, `epoch_stale`, `epoch_no_use` and `issued_at_ahead` then end the write with
  nothing else signed, and the device says that its clock looks wrong.
- **One signature per place.** A request that was signed goes again as it is while the device's
  own copy shows the head it was signed on; another is signed only after the copy shows a new
  head. One request holds 16 entries at most.
- **What the service answers a placement** besides taking it: `409 head_moved` (read; sign again
  only on a head that did move), `503 list_rebuilding` and `409 try_again` (the same request
  again, the same signatures), `429 entry_budget` (wait as long as it says), and
  `503 list_stopped`, which is told in these words and never as a
  removal: "The account service cannot change the list right now. To remove a device, use Revoke
  on each PC."
- **A device of power `full` that is in front does that tidying by itself** when it sees such an
  invite or device, at the list's own pace, without waiting for somebody's next act.
- An invite past its `exp` is shown as expired, never as open.
- **An invite that a PC joins with by itself is for one PC.** It is one key pair for two things,
  the invite the account service keeps (`POST /v1/pc-invites`) and the list's `invite` entry, and
  the service lets one PC join with it whatever the entry's `uses` say. So the device writes
  `uses` 1 and offers no other number.

### Letting a device in

A new device of the account is let into the list by a device that is in it. The person does what
they do today ([Who may admit a device](account.md#who-may-admit-a-device)): the new device asks
through a PC, a device in use shows **Add a new device?**, the person picks the number the new
device shows, and the new device confirms. What the list adds is under that.

**The new device, before anybody lets it in.** It is signed in, the account service names a list,
and entry 0 of it is not its own. It then claims its own key at the account service
(`POST /v2/lists/{list}/claims`): its member key, its encryption key and its card for that list.
The service places no entry for a key without such a claim by a sign-in of the account, at most
ten minutes old, so the device makes the claim again every four minutes while it waits. A sign-in
older than ten minutes proves itself with its registered key (purpose `list-claim`, over the list
id and the claimed key); one that registered none signs in again.

**The device that lets it in.** Once the PC took the number (it checks the digits, as today), and
once the PC holds the new device's row (the new device confirmed its own digits: until then the
PC answers `404 introduction_unknown_key` to an introduction with nothing in it, which is what
the device asks with), and only then:

1. It reads the list, so that it signs on what the log holds now. The write belongs to the account
   the approval was begun under and to the list of this first read: a sign-in another tab changed
   meanwhile ends it with nothing signed, and never leads to the way of an account with no list.
   Whether the device goes by a list at all is read from what it holds itself (the copy in its
   own store): with none, the approval goes as before lists, at once, and waits for no answer
   about lists. With one, the device never takes the ways from before lists, whatever its
   standing: put out, stopped, alarmed or unread each say so before anything goes to the PC.
2. It takes the newcomer's card from the claims the service lists
   (`GET /v2/lists/{list}/claims`), for the key whose digits were compared. The key comes from
   the comparing, never from that answer; the card proves itself, and an entry whose card is not
   that key's is not signed.
3. It signs a `device` entry for that key, power `full` and role `drive`, with the name the new
   device gave sealed under the current epoch, through the kinds' writer. Where an invite's or a
   device's time is over, the tidying comes first in the same request
   ([What a device writes after entry 0](#what-a-device-writes-after-entry-0)).
4. It places the request with the epoch key wrapped to the newcomer
   (`POST /v2/lists/{list}/entries`).
5. It reads the list again. The newcomer is in when the device's own copy shows the entry at its
   place, whatever the service answered to the placement, and still holds the newcomer's key as
   in: where another member put it out meanwhile, nothing more is signed for it.

**One signature per place.** A request is kept in the device's own store, under the account, the
member key and the head it was signed on, before it is sent. While the device's copy shows that
head, that request is the only one that goes: from this call or a later one (**Try again**), from
this page or another, whatever is asked for by then. Two pages that sign at one head keep one
request, the first, and the other page's signature is never sent. The page that lost the place
never takes the first request for its own result: where that request is another change's, it sends
nothing and says that the earlier change waits; where it is the same change's, the request goes
again as one kept from before, and the list then says whether the change is in. So no change is
ever reported done on the entry of another. The request is let go only
when the account service's own refusal proved that it placed nothing, and a request kept from
before that is placed or let go makes way for what was asked: it is signed on the head that
follows. **A request that waits is its own change's to send again, never another's**: it goes
again by Try again on its card or when the same change is tried again. Any other change first
reads the log: the head moved, and the kept request is over; the head did not move, and while the
kept request is younger than ten minutes the other change is refused with **An earlier change is
still waiting: try it again or cancel it first**, and the card of the earlier change is shown,
with **Try again** and **Cancel**. Past ten minutes, or at Cancel, it is let go and the other
change is signed: an attempt its writer left behind is no fork. So an Allow that stalled is never
placed, later, by an unrelated Remove. **Cancel reads the log first**, past the device's own head: a request that was placed after all
is not called cancelled (an approval is then finished), and one whose outcome cannot be read is
not let go, so the card stays. A kept request dated after the device's clock as it reads now (the
clock was set back) has no age to go by and holds no other change back. **A card acts on the request it was shown for**: it holds
that request's account, list, signer, head and hash, and its Try again and its Cancel do nothing
to a request that took its place since. The card of a change that waits is put up wherever
another change was refused for it: inside an opened PC and on the start screen alike. Within one call the request goes again, with the same signatures, three
times at most, while the device's own copy shows the head it was signed on: while the service
says it is rebuilding the list (`503 list_rebuilding`) or asks for the request again, after an
answer that never came, and while the log does not show the entry. Another entry is signed only
after the device's own copy shows a new head (`409 head_moved`, and the read that follows shows
it), four times at most. Only an answer that proves that nothing was placed is taken as that: the
service's own refusals below 500. After an answer that never came, a 5xx (a gateway may answer one
after the service placed the entry) or a 200 that does not read, the device reads the log past its
own head, whatever head the service names, before it says anything: the entry is there, or the
request goes again, or, where the log cannot be read either, it says that it is **not known yet**
whether the device is in the account. It never says "added to this PC only" for that. A placement
waits thirty seconds for its answer, and the read of the claims as long.

**What a change is bound to.** The account, the list and this device's member key, from the press
on: what the caller names, and for what it leaves out, what the first read shows. Every read, every
try and every Try again holds all three against the writer, and a difference ends the change with
nothing signed (`changed`): a sign-in that another tab changed, another list, another member key.
A change can also be called off (a signal): the write checks it before it signs, before it keeps
the request and before each time it sends it.

**Whose clock.** Two clocks, two jobs. What is *signed* (the time an entry is dated, whose time
is over and so whether a removal and a new epoch go first, what is sealed and wrapped) goes by the
device's own clock as it is now, held against the list's own time and nothing else. The latest
time the device saved (its floor) is not used for it: a floor that a date set ahead once pushed
forward would otherwise sign the removal of a key whose time is not over, and a removal cannot be
undone. The floor is for what can be undone: whom the device lets in, refuses and shows as over.
A device whose clock reads more than ten minutes under its own floor cannot tell which of the two
is wrong: it signs nobody out for a time that is over. That is the write loop's own rule and no
caller's: one function there asks whose time is over, for every request that opens an epoch (an
Allow, an Add, a Remove, a Revoke), and gives none to such a device. So its Remove puts out the PC
that was asked for and nobody else, and where names cannot be sealed without a clean-up, no epoch
is opened and the newcomer comes in with no name until a later writer seals one. The writer
carries both clocks: `clock` signs, and `shown` (held against the floor too) is for what a screen
shows as over and what a press admits. The account service's clock decides nothing
and is never signed. Where the service refuses a request for its time or its epoch, the device
signs nothing else and says that its clock looks wrong.

**No request over sixteen entries.** The request that lets a device in holds the removal of
everybody who is over their time, the epoch and the device. Where more are over their time than
fit beside those two, they go out first, sixteen removals a request, four such requests at most,
and the device's request follows on the head they leave. What a caller asks to follow the entry in
the same request (the `remove` of the invite a PC joined by, with that PC's entry) is carried by
every branch of the writer, named or not, with an epoch or without, and its places are kept free
within the sixteen.

**A device that is behind.** Once a member of a later level has written, this build lets nobody in
on what it holds (the kinds refuse the entry, `behind`): the request is not sent, and the device
says to update Ovis on it. It still removes.

It gives up, and says why, where the service holds no claim of that key, where the list put that
key out before (a key that is out never comes back), where the list took as many additions as it
takes for now (with the wait the service named), where the service cannot change the list, and
where the device itself may not write: it follows a list and is not in it with power `full`, was
shown another history, stopped at an entry this build cannot place, or cannot read its copy. That
last one is never taken for "the account has no list": nothing of the ways from before lists is
signed for the newcomer then.

**The place handed over.** The device that let the newcomer in hands it the list id and the place
of the newcomer's own entry (`seq` and hash), in the introduction it leaves with the PC
([Introductions](account.md#introductions)): `POST /api/account/introduce` carries `list`:
`{ "id", "seq", "hash" }`, and `GET /api/account/introduction` gives it to the new device over
its own session. The PC only carries it. The new device reads it with the introduction, over the
session that signed in with its account key, for a minute after the approval (a Forget of the
pairing ends that), and then follows that list when the log shows its own key let in at that place or
before it: an entry that lets it in only after the place it was handed is not what the member
vouched for. The copy is saved before the place is forgotten, so a save that fails keeps the
place. A log that ends before that place, or shows another entry there, is followed by nobody:
the device keeps the place it was handed and reads again at its own pace. Being handed a place
ends the search for one and says nothing more: the new device says **In your account** only once
its own copy shows it in. While it still waits to be let into the list, it asks again at every
open of a PC it is paired with, so an Allow that went through later than its first asking still
reaches it. So a new device takes
the list from a member, through the one PC it compared digits with, and never from the account
service. A device that follows a list takes no place from anybody. A PC that does not carry the
place yet (it keeps the introduction's PCs and drops what else it is sent) hands the new device
none: that device then stays let in at that PC alone, waiting, and is in the list without
following it until a PC carries its place.

**The PC.** The device that let the newcomer in also hands the PC the list's new entries, so that
the PC need not wait for its next read: it says where it stands
(`POST /api/account/list/head`), and where the PC stands earlier in the same history, hands it
the entries after that place (`POST /api/account/list/page`), 256 a call. Where the PC asks for
an earlier place (`asks`), that page goes next, eight calls at most. The hand-over counts as
done only when the PC says it stands at the newcomer's entry or past it, at a place of the
device's own history: the same number with another entry at it is another history. A page the PC
refused or took in part is none, whatever place its answer names, and the PC then reads the
account service as ever. Only pages of the list the hand-over began for are sent. Entries prove
themselves. A PC that follows no list a person named answers 404, and nothing is handed.

**Where the list does not take the newcomer**, the device signs nothing else for it: no `add` for
the account's other PCs, and no PC is introduced. The new device stays let in at that PC alone, and
the device in use says so on a card, **{device} was added to {pc} only**, with why and **Try
again**.

**An account with no list, and a device that is in none**, do exactly what they did: the `add`
and the introduction of [Introductions](account.md#introductions), and nothing of the above.

### Putting a member out

The code is [`src/lib/account/listRemoveDevice.ts`](../src/lib/account/listRemoveDevice.ts) and
[`listLeave.ts`](../src/lib/account/listLeave.ts); the screen is Manage account's **Devices**
([`ListDevices.tsx`](../src/components/ListDevices.tsx)).

**Manage account's Devices**, for a device that follows its account's list and is in it, are the
list's devices instead of the rows the PC here pairs: each by the name this device opens
(**Unnamed device** where it opens none), this device as **This device**, a device that only
watches as **View only**, a borrowed browser as **Borrowed browser, until** its hour, and a key
the list holds that no kind made anything (a signer with no name) as **Unknown key**. A device of
power `full` offers **Remove** on every row but its own; this device's own row keeps
**Disconnect**, which is a leave (below). An account with no list, and a device that is in none,
see the rows they always did.

**Remove** asks once. The question names what came in through that device: every device, key with
no name and PC that it let in, added, or whose invite it placed, and whatever those let in in turn,
in the order they came in, also through a member that is out already (whoever it let in may still
be in); only what is still in is named. This device and what came in through it are never among them, and
neither is what was in the account before the list: a PC carried in came in through nobody, also
after a later `pc` entry gave it its keys (its first admission counts, read from the `carried`
entries after entry 0). A device is followed through every key it held: what it let in under a key
it later handed on counts. Each is a box to tick, and none is ticked at
first, with one line: **If {name} was stolen, tick what you did not add yourself.** A lost phone
often let in the person's own PCs, while a stolen one may have let in the thief's devices. Where a
PC is ticked, a line says **These PCs will need to be added again.**: a PC put out comes back only
as a new PC. The invites the device placed are not named: they are void once its key is ended.

**The request**, one for all of it, through the kinds' writer on the device's own state: a
`remove` that ends each key (for a PC, what `pcRemoval` gives: its key or its relay key, and the
invite it joined with while that invite is open), and where it opens the epoch, the writer adds
the `remove` of whatever is over its time (an invite past its `exp`, a device past its `until`) in
the room that is left, then one `epoch`, its key wrapped to everybody who is in after the whole of
it (`signedWithEpoch`: no other code asks the kinds whose time is over). The removal asked for and its epoch
always fit in the service's 16 entries; what is over its time and does not fit is tidied later. A
device that holds no key of the current epoch places the removals alone, and a device that stays
opens the epoch when it tidies. A removal longer than one request goes in parts, the epoch with the
last; where a later part is refused, the person is told how many went ("{done} of {total} were
removed. Try again for the rest."). A member is out when this device's own copy shows its removal
at its place, whatever the service answered; the request is read and signed again four times at
most after `409 head_moved` or an epoch the service judged otherwise, and sent again three times at
most while the list is rebuilding (one signature per place: while the device's own copy shows the
head the request was signed on, the same request goes again, and a new one is signed only on a new
head). `list_stopped` is told in the words above; a request that got no answer while the log could
not be read is "not known yet", never "not removed"; a refusal for the entry's time says the
device's clock looks wrong; a copy that cannot be written to says so, with no retry offered; a
request this device signed for another change (an Allow) that still waits at this head is "An
earlier change is still waiting: try it again or cancel it first", with nothing signed, and that
change's card is put up; a device that handed its place to a new key while the question was open
(a `device` entry that rotates) is not passed by as out: nothing is signed, and the dialog says
"{name} moved to a new key since you asked. Nothing was removed: press Remove again to remove it.",
a second press removing the key it holds now, followed through every hand-over since (where only
something ticked moved, the words say so); any other failure is "could not be removed. Try
again.", with nothing shown as done. A removal that stops after a part that put the device out
keeps its question up (also Not me's, whose notice goes with the device) with how much went.

**Each change has a name of its own.** A request a device signed and has not seen placed is kept
for its change: `remove:<key>:<digest>` and `not-me:<key>:<digest>` (the digest of the sorted keys
and PCs the request ends, so another choice of ticks is another change), `sign-out-all`, `leave`,
`tidy`. It goes again only
for that same change, and a person's act is never sent, nor reported done, on a request kept for
another one. The clean-up is nobody's own change: a request kept for `tidy` never refuses a
person's act. Whatever change comes next sends those very bytes again (never a new signature),
waits for their outcome, and then signs its own on the head that follows.

**A write belongs to what it began with.** A removal is begun for one account, one list and the
member key this device is in it with, as the page showed them; after every read of the list it
holds the writer against them, and where another sign-in (another tab's), another list or another
key stands there, it ends with nothing more signed. **Whose time is over is judged by this
device's own clock as it is now**, held against the list's own time only: never the floor it
saved, never the account service's. A service whose clock runs ahead, or a floor that a date set
ahead once pushed forward, cannot make a member put a borrowed browser out before its hour. A
device whose clock reads more than ten minutes under its own floor puts nobody out for a time that
is over: the removal the person asked for goes alone with its epoch.

**A key that is out never comes back.** Nothing signs it in again: an Allow of that key is
refused (`removed`), and the device comes back only with a new key.

**A device that hands its place to a new key** (a `device` entry that ends the key that signs it)
is the same device: no new-device notice is raised for it, and the devices list shows it as "Moved
to a new key on {day}", with its Remove as for any device. A device whose own key was handed on by
an entry it did not make (its key signed it elsewhere) says "This device's place in your account was
handed to a new key ({name}). If you did not do this, remove that device from another of your
devices."

**The new-device notice** of an account whose list this device is in comes from the device's own
copy: **{device} was allowed into your account by {approver}.**, for every device another member
let in since this device last looked (on its first look nothing is told: whoever was in before is no
news), with the device's role where it has one. The approver is the device or PC whose key signed
the entry; one the list has put out since is "a device that is no longer in your account". **Not me** asks Remove's question with every item ticked, since the person does not know
the device and what it added is suspect; each can be left out. **Dismiss** closes the notice for
good. What the device has seen is kept per account in the page's storage
(`ovis-list-device-notices`), for the member key that looked: a device that signs in again with a
new key looks for the first time. A close is merged with what the storage holds when it is made,
so two tabs that close two notices keep both. Only a device that may remove anybody is told. On such an account the
PCs' notices of an admission are not shown; an account with no list keeps them, with their blocks.

**Sign out every device**, on an account whose list this device is in, first puts every other
device out of the list, in one request with the epoch after it, and only then signs every browser
and app out, as before. A device that is only signed out still holds its account key, and that key
opens a PC that follows the list. The question names the devices that go, and the press passes on
those, and the list and the key it was drawn with, and no others: the list is read again before the
removal is signed, after a sign-in again in the app, and when the browser comes back from one, and a
device the question did not name ends it with nobody signed out ("{names} came into your account
since you asked. Nobody was signed out: ask again."). Right before the sign-out is sent, this
device's own read of the log must still show no other device in that the question did not name;
one that came in meanwhile is asked about, with how many left first ("{done} of {total} other
devices left your account, then {names} came in since you asked. Ask again to go on."), and nothing
is sent. A list store that cannot be read stops it too. Where the list does not take the removal,
nobody is signed out and the question says so; where only part of it went, it says how much.
(Holding the sign-out itself to the head that was read needs the account service: a follow-up.) This device stays in the list with its key and its copy,
signed out as before; signed out, the list opens no PC with that key, and signed in again on it,
it is in the list at once, with no Allow.

**Signing out and leaving.** Disconnect, Sign out and Sign out every device carry what their
question showed (the account, and the list and this device's key in it): where the sign-in stored by
then is another account's, or the list or the key is another (another tab), nothing is signed or
ended ("Your sign-in changed while this was asked. Nothing was removed."). A device that is in its
account's list signs a `remove` of its own key first, while its sign-in still stands (any power may
end its own key), and opens no epoch: the next epoch's key would be its own to know, so a device
that stays opens it. The removal counts only once the device's own read of the log shows it out,
whatever the service answered; where no read is possible after it (the sign-in may end with it), the
outcome is not known, the device finishes here and says so ("This device signed out." / "This device
left the account." followed by "Whether your account still lists it is not known yet: check its
devices from another device."). Then it forgets its account key, its encryption key with it, the
sign-in and its copy of the list. Signing in again makes a new key, which a member allows anew. One
account key serves every account the device signs in to: where another account's saved copy is
pinned to it and does not show it out, the keys stay and only this sign-in and this account's copy
go (the copies and the keys live in two databases, so that look is made right before the clear). The
copy is forgotten only while it is pinned to the key that left, compared with the very copy dropped.
A leave forgets its pairings by their row, so one another tab made with that PC meanwhile stays. A
sign-out goes on where the list did not take the removal, and says so: "This device signed out, but
your account still lists it. Remove it from another device." (or the words for `list_stopped`); the
key is forgotten on this device all the same. Delete account follows the same rule: where another
account's list still holds the key, the keys stay and only the deleted account's sign-in goes. A
browser that reads itself out of an account while another account's list holds its key can never be
let in there by that key (a key per account is a follow-up), and says so: "This browser was removed
from this account and cannot be added again while it is signed in to {account} here. Sign out of
that account in this browser first, or use another browser." A list store that does not answer is no word that the
device keeps no list: the sign-out then forgets nothing it cannot see and says "This device signed
out, but it could not read what it keeps of your account's list, so your account may still list it." A pairing this device made at a PC keeps its own copy of the key, as at every sign-out, so
that PC may still open through it until the device is removed from another device. A leave stops
there instead, with nothing done. A leave whose removal counted finishes on the device by itself
when what comes after needs a sign-in the account service ended with the removal. A device that
keeps a copy of its account's list goes by that copy at a sign-out even before the page has read it
(the directory may not answer): it never takes the path of a device in no list. Forgetting checks,
in the same transaction, that the sign-in and the key are still the ones the device was a member
with: a sign-in and a key that took their place, and their copy, stay. A device that keeps no copy
of the account's list signs out as it always did.

**A device the list shows out**, by another member's `remove`, forgets the same: its account key,
its sign-in and its copy, and says "This device was removed from your account. To use it again,
sign in and allow it from another device." A device that keeps a copy reads its list before the
account's directory each time a sign-in is read, so a removal it missed while it was away reaches it
even where the directory no longer answers that sign-in.

**Tidying by itself.** After each read that reached the account service, a device of power `full`
that is in the list opens the next epoch where nobody could seal under the current one, and the
writer puts out with it each device at or past its `until` and each invite that a PC joins with by
itself, still has a use and is past its `exp` (the kinds layer's `lapsedRemovals`; a plain invite
holds no key and lets nobody in, and is left alone), by its own clock as it is now and judged again
on the state it signs on; where nothing is over its time (another member put itself out), it opens
the epoch alone. A device more than ten minutes under its own floor does none of it. It says
nothing on screen, and tries each place of the list once per page, whatever the service answers.

### PCs of a list account

For a device that follows its account's list and is in it, the account's PCs are the PCs that list
holds. The code is [`src/lib/account/listPcs.ts`](../src/lib/account/listPcs.ts),
[`listRemove.ts`](../src/lib/account/listRemove.ts) and
[`listWrite.ts`](../src/lib/account/listWrite.ts).

**What is listed.** My PCs, the PCs in Settings and the sidebar's account PCs show a row for every
PC the list holds, under the name the list seals; a name this device cannot open is shown as the
start of the PC's id, never as the account service's word for it. The directory
(`GET /v1/pcs`) is read as before and says only how to reach a PC:

| from the directory | counts when |
|---|---|
| the relay of a PC | the row's relay key is the very key the list holds |
| when the PC was last there (`last_seen_at`) | the same; it only says whether the row reads as offline |

A PC the list holds with no route in the directory keeps its row, on My PCs too, under its signed
name: it reads as off, and nothing opens from it.
What the directory says of a list PC being new, or added before this device joined, is not read. A
pairing this device made with a PC stays a row of its own, whatever either says.

**A PC that only the directory names stays on the screen**, after the list's own, with **Not in
your account's list yet** on its row. A person never loses a PC from view: a PC on an Ovis from
before lists cannot be in one, and a PC added while the account service kept no list is not in
it yet. Such a row is the directory's as it is. Nothing opens it by itself, a start of the app
does not ask to join it, and no notice tells of it; a tap opens it the way from before
([Linking devices with an account](account.md)). **It takes a press at every open.** The press on
a link to the PC is kept for the page it leads to, and that page takes it once
([`pcTap.ts`](../src/lib/relay/pcTap.ts)); a reload, a tab the browser restored and a page the
phone app reopened as it started find none, and put up the sheet whose press opens the PC.

**A device that cannot read its list** lists the directory's PCs, every one marked the same way
and none opened by itself, under one line that says so: **This device cannot read your account's
list. Update the app.** where only a newer app reads it (a later build saved the copy, or the list
holds an entry this build cannot place), and **This device cannot read your account's list. Sign
out and in again on this device, then allow it from another device.** where what it saved does
not read: a new key and an Allow is the one safe way back, and there is no reset button.

The list is read before the account's PCs are first drawn on a device that keeps a copy of one, so
no row is drawn as the account's own by the account service's word alone, not even for a moment.

**A page that has not read its list yet is in a state of its own, never "no list".** A device that
holds a saved copy is in it on every page until a read of that copy ends there: the page was just
loaded, or its read failed. A store that cannot even be asked counts as holding a copy. In that
state every row is the directory's and marked, nothing opens or asks by itself (My PCs, the
sidebar, the notices), and **Remove** and **I didn't add this** wait for the read; where none
ends they refuse (**This device cannot change your account's list right now.**) and never take the
directory's removal. The start screen says **This device has not read your account's list yet. It
keeps trying.**, and the read is tried again at every refresh. A round is not lost for a store
that takes no write: the small records beside the copy (the round's times, the epoch keys it
opened, when it first saw a PC) are kept in memory then, and a round that fails past the saved
copy leaves the page on that copy, shown as a list the account service was not reached for.

**What opens by itself.** A PC the list holds, that the directory gives a route for, and that is
not new to this device; never a PC the list does not hold. The sidebar of a PC's page adds none
of those by itself either. That the account service ever saw the PC is not asked: the entry is what
makes it the account's. The sign-in is the one of
[What a pinned PC asks of the app](#what-a-pinned-pc-asks-of-the-app).

**New to this device.** A PC is new to a device for a day from when the device first held the
entry that brought the PC in, by the device's own clock, unless the device signed that entry
itself or the PC was in before the device was. So a phone that was off for a week is told of a PC
added meanwhile when it comes back, and has its day to answer. While a PC is new it opens only by
hand, its row says **New PC**, and the device shows the notice it shows today, **New PC added to
your account: {name}**, with **Added from {device}.** where it can read the name of the device
that signed the entry, and **I didn't add this**.

**I didn't add this**, and **Remove** in Settings, put the PC out by entries this device signs,
in one request: what `pcRemoval` of the kinds gives (the `remove` that fits how the PC came in,
and that of the invite it joined by while that invite still lets a PC in), with them a `remove`
for every key whose time is over, then the `epoch` entry, and the new epoch's key wrapped to
everybody who stays. The account service removes nothing for it and asks for no new sign-in. The
PC is out once the device's own copy shows the last entry at its place, as for an Allow, with the
same tries. A device that holds no key of the current epoch signs the removal alone. A PC that is
out never comes back with its key: it joins again only as a new PC.

- **The removal belongs to the row that was pressed**: its account, its list, this device's member
  key and the PC's relay key, taken when the question is asked and held against the device's
  writer after every read. Where another tab's sign-in changed one of them, nothing is signed and
  the removal says that it failed. A PC that another member put out while the question was up is
  found out already, by the list: nothing of it goes to the account service's directory.
- **One request holds 16 entries at most.** The PC's own removal and the epoch always go; of the
  keys whose time is over, as many as fit beside them, and the rest waits for a later writer.
- **A pairing this device made with the PC itself stays.** The PC leaves the account; the key of a
  pairing made at the PC still opens it, as the question before the removal says, and only Forget
  takes that key from the device. A device that goes by its account's list forgets no pairing on
  **Remove**, also for a row that the account service alone names.
- **A PC the list holds with no route** reads as off in Settings, where it can be removed, and has
  a row in the sidebar that says it cannot be reached. Settings draws its rows again when the list
  moves.

**A pairing that was only opened lists nothing.** Opening a saved pairing used to list the PC in
the directory and enroll it where an enrollment was planned. On an account with a list, the
account service refuses that listing, and a PC comes into the account by an entry. So for a saved
pairing on such an account the app sends no listing and starts no enrollment, sends no link to a
PC that is in no account, and says nothing at the row: the pairing opens the PC as before. This
holds for a device that follows the list and for one that waits to be let in, and while the
account service has not answered whether the account has a list: those writes wait for a read
that tells. Where that answer is missing the link only waits: nothing is taken from what the
pairing's row says of the account. A new pairing made from **Add** is not changed by this.

**A PC that lets devices in by the list alone** answers a link `409 list_followed` and writes
nothing. A pairing made at such a PC is whole without the link: the app keeps it as the device's
own, calls it neither a failed pairing nor a failed enrollment, and a member's Allow is what
brings the device into the account there.

### Adding a PC

A device that is in the list adds a PC to it by a `pc` entry it signs with the PC's own card. Two
ways, both by a person who is at the PC. The code is
[`src/lib/account/listAdd.ts`](../src/lib/account/listAdd.ts) and
[`listNamed.ts`](../src/lib/account/listNamed.ts).

**With a number on both screens** (the card **Add this PC to your account?**). The PC asked to be
added (`ovis add`, or **Add this PC** in its own window): it listed itself and posted its keys and
its card for the list (`POST /v2/pc/list/keys`).

1. The device reads the posts (`GET /v2/lists/{list}/posts`) and keeps only a post whose card is
   that key's own, for the list this device follows and for the very relay key the post stands
   under. For any other post it shows nothing and starts nothing, and the card adds nothing for
   it: on an account with a list it never falls back to the admission of the directory alone.
2. **Add** on the card works out the number, from the card's binding (the kinds' `cardBinding`)
   with the exchange of `shared/relay-pair-sas.ts`: the device commits to a
   nonce of its own (`POST .../posts/{endpoint}/attempt`), waits for the PC's nonce, then reveals
   its own. It commits before it has seen the PC's nonce and reveals only after, so neither end
   and nobody between them can steer the number. The account service only carries the messages.
3. The card shows the six digits with **Check that the PC shows this number and confirm it there,
   then Add**. The person confirms at the PC first; that is what lets the PC follow this list. A
   number lives two minutes from the earliest the PC can have answered (the last read of the posts
   that did not show its answer yet), never from when its answer came, and the press of **Add**
   checks that again. The whole wait ends at its deadline (thirty seconds): the commitment, each
   read of the posts and the reveal end by then, answered or not, and an answer that comes later
   counts for nothing.
4. **Add** beside the number: the account admits the PC (`POST /v1/pcs/{id}/admit`; the service
   places a `pc` entry only for a PC an own sign-in admitted), and the device signs the `pc` entry
   with exactly the card the number came from, the name the PC gave itself sealed, and the epoch
   key wrapped to the PC's encryption key, signed by the very member key the number was worked
   out with (another key, after another page replaced this device's membership, signs nothing).
   **Not the same** adds nothing.

One card, or one dialog, asks for three numbers at most: a number that was not the same, ran out,
or got no answer counts. After the third it says **Too many tries for this PC. Start again on the
PC in a few minutes.** and offers only **No** (or **Close**). On an account with a list, the card
never falls back to the admission of the account's directory alone: a post that is gone, or a
device that cannot write the list, is said as such. Whether the account has a list is the device's
own knowledge, never the directory's: a copy it holds (also one this page has not read yet, which it
then reads for the next press), or a list the account service names that this device is not in
yet. A listing whose window ended (`409 listing_expired`) turns the card to "This request ran out",
as on an account with no list. Once the account admitted the PC and the list did not take its
entry, the card stays, whatever the directory lists, and says **{name} is not in your account's list
yet. Try again.**: **Try again** goes again with the same card and member key (the request kept
for it is sent again, or signed anew on a new head), and nothing is admitted a second time. The
page holds the card and what it places from before the admission, so a read of the account's PCs
while the entry goes out does not take it away; **No** on such a card removes the admitted PC from
the account. The
record of the Add is written before the card or the dialog goes.

A number that is shown proves nothing by itself: only the two confirmations do, each for its own
end. The PC's yes says that the adder is the device in the person's hand; the device's Add says
that the card it holds is the card of the PC in front of the person.

**By the PC's QR code.** A scan pairs the device with the PC over an end-to-end session, so the
card is taken from that session and no number is compared. In place of the link, the device names
its list to the PC (`POST /api/account/list/named` `{ account, list }`), checks the card the PC
answers with (its own, for this list and the relay key this session is bound to), has the account
admit the PC, signs the `pc` entry, and asks the PC again, four times at most, until it says it
read the entry. The person's Cancel is checked before the admission, before signing, before the
request is kept and before every send. The PC's word that it read its entry spends nothing by
itself: the device reads its own copy from the log, and only where that copy holds the PC is the
pairing that named the list spent. Its row goes then, by that very row inside the delete (a newer
pairing another page saved meanwhile stays), and the PC is opened as any PC of the list, with the
key the list holds for the device. An entry the copy holds and the PC has not read yet (`placed`)
spends nothing: the pairing stays the device's own, nothing is opened over its session, and the
PC opens from its row once it took the list. An entry whose placement is not known (no answer and
no read of the log since) is handled the same way, after a read of the device's own copy: never as
a refusal. So is a session that drops at a later ask, once the entry is placed; and where the PC
says it read an entry and the device's copy cannot be read to tell, that is not known yet, never
"not in the list". A refusal at a later ask is said as the PC's refusal. A device that cannot write a list
its account has (it waits to be let in, or its copy does not read; a page that has not read its
list yet reads it first) sends no link from before either: the pairing stays its own and nothing
is opened over it. A PC with no such call (it follows no list, or is from before lists) gets the link, as
before; so does one whose pairing's session answers the first ask with `403 link_required` (a PC
from before this call lets only the status and the link through that session).

**A PC the account names that the list does not hold yet.** Such a PC keeps its row, marked **Not
in your account's list yet** ([PCs of a list account](#pcs-of-a-list-account)). In Settings, on a
device that may write the list, the row offers **Add** when the PC posted its keys for the list,
which a PC that runs a build with lists does by itself: the same number, confirmed at the PC, then
**Add**, with no admission asked for, since the account lists the PC already. A PC that posted
nothing runs a build from before lists, and its row says **Update Ovis on this PC**. A device that
only watches, or one that may not write the list, is offered neither.

Either way the entry is signed through the one write loop of
[Letting a device in](#letting-a-device-in), for the account and the list the card was shown for.

### Invites

A device that may write the list makes an invite for one PC
([`src/lib/account/listInvite.ts`](../src/lib/account/listInvite.ts)), in the Mac app under **Add
PC → Ovis relay → Invite a PC**. By default the PC that joins with the invite asks, and a device
of the account presses **Add** for it. With **Let the PC join by itself** on, the PC joins with
nobody asked, for a PC an agent sets up; the line under the switch then says so: **Anyone who gets
this line in the next 15 minutes can add a PC to your account without asking you.**

1. The device makes a key pair and writes the join line from it (`newInvite`). The line is the
   only copy of the private key: it is shown once, on the device that made it, and never stored.
2. The account service gets the public key (`POST /v1/pc-invites` `{ invite_key, auto }`), which
   is what a PC redeems; the answer's `account` must be the device's own, or no line is shown.
3. The device signs an `invite` entry for that key: `uses` 1, `exp` fourteen minutes from its own
   clock as it reads now (never the account service's, nor the list's time or a floor it saved),
   under the service's fifteen. A device whose clock reads behind the list's own time by more than
   that makes nothing and places nothing: **This device's clock is behind. Check its date and
   time, then make the invite again.**
   For an invite a PC joins with by itself the current epoch's key is wrapped to the invite's key,
   so the PC that joins reads the list's names.
4. Only when the device's own copy shows the entry is the line shown, with the minutes left and
   the one line an agent runs on the PC: the one-line installer, then `ovis join --invite-file
   ~/ovis-invite.txt --account <the account's id>` (the installer takes no invite itself). Where the service or the list refuses, nothing is shown, the service's invite is ended
   again, and the key pair is gone. Where the entry went out and whether it was placed is not
   known (no answer and no read of the log since, or a request the service kept asking for
   again), nothing is ended and the line is not dropped: the page keeps it in memory for its life
   (also when the invites panel leaves the screen; never stored), says **It is not known yet
   whether the invite was made**, and the next **Make an invite** settles the kept request
   against the log first. The line is shown if the list holds the entry; otherwise the
   service's invite is ended and a new invite is made.

A sign-in older than ten minutes proves its registered key for that very invite, to the service's
invite and to the entry alike (`ovis-pc-add/1`, purpose `invite` or `invite-auto`, the invite's
key where a listing id stands otherwise).

The list's invites are listed under it: **Expires in N min** while open, then **Expired**,
**Used**, **Revoked** or **Ended**, for an hour after their end. **Used** is an invite a PC joined
with, or one whose removal the device's copy shows in one request with a `pc` entry (right after
it, by the same member at the same second: a person's Add of the PC that joined with it);
**Revoked** a removal this device revoked, or one on its own before the invite's time was over;
**Ended** any other end (its placer left, it went with a PC's removal). Whichever page ends an
invite in the list (a Revoke, the Add of the PC that joined with it, also by the number) ends the
account service's invite too: by the id this device kept when it made it (beside its pages, with
the invite's public key and never the line), or, for an invite another device made, by the
service's list of the account's invites where that names the key (`GET /v1/pc-invites` is
documented without it today). **Revoke**
signs a `remove` of the invite's key; where the kinds call for the
next epoch after it (an invite a PC joins with by itself held the epoch's key), the same request
opens it. A device whose clock reads more than ten minutes under the time it saved signs the
removal alone. An invite past its `exp` is never shown as open, by the device's clock held
against the latest time it saved and the list's own time: setting the clock back opens nothing
again.

**The PC that joined with an invite that waits for Add** shows on the card of a PC that asks, as
**Add this PC to your account? (joined with your invite)**, and its **Add** needs no number
([`listInvited.ts`](../src/lib/account/listInvited.ts)). The account service says which PC used an
invite, and that is only its word. So the device goes by what the service cannot make: the PC's
post carries the invite's public key and the line's own proof (`invite`, `invite_proof`): the
line's signature over `lineProofBytes` for this account, the PC's id, this list and the PC's very
card (see "What a line signs for a PC's card" above), checked with `verifyLineProof`. A redeem
signature of the line is never taken for it: the account service chooses a redeem's challenge, so
it could have the line sign the challenge of a card of its own. The device offers the one-press Add only where that proof holds, the card
holds for this list and that relay key, and its own copy of the list holds the invite as open,
placed by a member, waiting for Add, not past its `exp`. Add has the account admit the PC, signs
its `pc` entry and ends the invite's key in the same request (in every branch of the write, an
epoch opened for the entry included). The press is for the card that was shown: its very keys,
card and invite, signed by the member key at the press; a post that changed since is drawn again
for a press of its own. The invite is judged again on the state each signature is made on, so one
that ran out, was revoked or lost its placer meanwhile signs nothing ("This request ran out"). The
Add is done only once the device's own copy holds the PC by that card and the invite's end: where
another Add placed the PC meanwhile, the invite's removal goes alone. Where the account admitted
the PC and the list did not take the entry, the card stays with **Try again**, as for the number.
The `invited` record is written before the card goes. A PC added by the number whose post carries
the line's proof for that very card gets its invite ended beside its entry (only while the
invite is still open: the number decides there). The card is drawn again when the list, the posts or the account's
PCs change, when the page comes back to the front, and at the invite's end, and it says nothing
of a sign-in code. On an account with a list, a card never falls back to the directory's
admission alone. Any other post is a PC that asks, and gets the number.

What that proves and what it does not: whoever holds the line can put a PC of theirs on the card,
under a name they choose, for the invite's fifteen minutes, and the press is the person's check
of that name. A lying account service cannot: it never has the line. An invite a PC joins with by
itself needs no card at all.

The PC posts `invite` and `invite_proof` with its keys when it joined by a line that waits for a
person, and the repository's account service fake carries them. The one-press Add is offered only
where a post carries them: for a PC, or an account service, that does not, a PC that joined with
such an invite is added with the number, like any PC that asks.

### What a pinned PC asks of the app

A PC that follows a list a person named (a pinned PC) lets a device of the account in by the key
the list holds for it, the account key, and no longer by the key a sign-in registered.

- **Every sign-in that is no pairing offers `account-list-1`**, beside `account-opens-all-1`. It is
  required only when the device comes with the key the list holds.
- **A PC the device's list holds** is opened with the account key, under the device id that key
  gives for that PC, with `account-list-1` required. A PC that does not select it follows no
  list: the device comes once more the way from before, with the key its sign-in registered, and
  only while its list still holds that PC.
- **`account_list_required`** is the PC's answer to a device that offered the feature and came
  with another key. The device reads its list at once, and comes again with the account key if
  the list holds the device, whether or not its copy names that PC: a PC that follows the
  device's list lets in the keys that list holds, and one that follows another list refuses the
  key. A page that has not read its sign-in yet (a PC's own page opens a saved pairing first)
  reads it before it looks for that key. A device that is in no list is led to the join: it asks
  to be let in, and nothing says it was removed. **A pairing of a device that has no list to
  answer with** (no account on this device, or an account that keeps no list) reads that answer
  as it reads `auth_failed`: the PC holds that pairing no more, the person is told so, and no
  join is asked.
- **A PC that pins under an open session** ends that session as a row that changed
  (`auth_changed`). The transport comes back by itself, is answered `account_list_required`, and
  the app opens the PC again with the account key. Nothing typed is sent by this: what was typed
  and not sent waits as after any disconnect. The one retry with the other key is each sign-in's
  own: a PC that pins after it was opened the way from before is asked once more.
- **A session opened with the list key goes on only while the list allows it.** Reconnecting by
  itself is opening by itself. When this device's own copy holds that PC no more, the app ends
  the session and says **{name} was removed from your account**; when it holds this device no
  more, the app ends the session and leads to the join, or says that the device's time is over.
  A copy that is not one to go by now (not read, stopped, shown two histories) ends nothing.
- **A list key the PC refuses** (`auth_failed`) means the device is not in that PC's list: the
  join again, and no word of a removal.
- **A device whose own time is over.** A device the list holds only until a time (`until`) is
  refused by the PC from that second on, and its open session ends `auth_revoked`. Where the
  device's own copy shows that its time is past, by the time it shows by (its own clock held
  against the latest time it saved and the list's own), the app says **This device's time in your
  account is over**, forgets nothing and asks for no join by itself: nobody removed it. A clock
  set back after that time ran out changes nothing of this.
- **A PC the list removed** takes no link into that account (`409 list_removed`). The app says
  **{name} was removed from your account**, that it comes back only as a new PC after **Reset
  relay identity** on it, and offers no retry. A pairing that was not made for the account alone
  (no mark) is told the same, on its own screen, and stands: nothing of it is forgotten.

### Joining through a pinned PC

A new device that asks to join its account through a pinned PC is let in by an entry of the list,
never by a pairing of that PC's own ([A PC allows a device into the
list](account.md#a-pc-allows-a-device-into-the-list)). The app's half is in
`shared/relay-channel.ts` (`listCard`, `listPlace`) and `src/lib/relay/shell.tsx`.

- **The device brings its card.** A device that waits to be let into its account's list, its
  claim of its key standing, offers `account-list-allow-1` with a join of the account. Whether the
  claim stands is read for that join: the app reads its list first (which makes the claim again
  where it is due), and brings the card only where that read shows the claim for the sign-in and
  the key the join signs with. A view drawn before the page slept, or before its first read,
  decides nothing. To a PC that selects the feature, and to no other, its `PAIR_REQUEST` carries
  `list_enc` and `list_card`.
- **It stops early at another list.** The PC's `PAIR_CHALLENGE` names the list it follows. Where
  that is not the list the card is for, the attempt ends before any digits are shown.
- **Its person says the numbers match.** A member signs the device in on that word, so such a
  join is never confirmed by itself: the number waits for **The numbers match**, also on the sheet
  a PC's own page put up for a join and for a challenge that names who approves (`approve_on`),
  which confirm any other join at once.
- **It is handed its place.** The `AUTH_OK` of a join the PC allowed names the list and the place
  of the entry that let the device in. The device takes a place only from a PC that took its
  card, and only in the list the card names; it follows the list from there by its own read of
  the log ([The place handed over](#letting-a-device-in)). A PC that took the card and names no
  place is refused (`auth_failed`, `list_refused`) before anything is saved. No pairing is saved:
  that session serves nothing else, so the app closes it at once and opens the PC anew with the
  key the list holds. The place is the account's the card was made for, and is kept for that account
  alone, whatever sign-in is stored when the answer lands: a sign-in that ended meanwhile, or one of
  another account another tab made, leads to the front page, the PC is never opened with another
  account's key, and a sign-in to the card's account again takes the place up: the device follows
  the list from there without asking to join again.
- **How long it waits.** The comparison's 90 seconds, and then as long as the PC keeps the join
  open for its entry after both sides said yes (90 seconds, the PC's `LIST_ALLOW_MS`: its own
  window's signing, or the half minute it waits for a member's entry and its last read). That is
  longer than the relay keeps a socket that sent nothing (two minutes), so while it waits the app
  sends the relay's own keepalive every minute. The relay answers it itself, and no PC sees it.
- **When no entry lets it in**, the PC ends the join `auth_failed` and names the cause, which the
  app says in words of its own: no sign-in of the account claimed the key (sign in again on this
  device), the entry could not be placed in time (ask again), a device of the account approved
  and the PC did not see the entry in its copy in time (`list_not_in`: the entry may be placed
  and have reached the PC too late, so the words say what the PC saw and no more), Ovis on the PC
  is older than the list (update it, or approve on another device), or anything else.
- **A member that approves on such a PC signs only for a device that confirmed.** The PC signs
  nothing on a member's approval and lets the device in only by an entry, which the approver
  signs. So for a join the PC marks `list` (or on a session for which it selected
  `account-list-1`), the card holds **Approve** until the PC says that the new device's person
  pressed **The numbers match** there (`confirmed`), and says so: **First press “The numbers
  match” on {device}**. A join on such a PC that brought no card is a pairing of that PC's own,
  which no device is ever told was confirmed: its card says **Approve {device} on {pc}'s own
  screen**. A device that gives up before that is nobody's member. Nothing is
  approved either where the approver cannot write its list, and the card says why. Then the
  approval, and right after it the device's entry: signed, placed, and handed to the PC as a
  page where the PC takes one from this session; where it takes none it reads the entry from the
  account service, which it asks every three seconds for half a minute from the approval. Where
  the list does not take the device after the approval, the request is gone from the PC: a card
  says why (**{device} is not in your account**: such a PC made no pairing of its own, so the
  card never says that the device was added to it only), and **Try again** signs it in; a device
  the PC turned away meanwhile (`list_not_in`) asks again. The introduction is tried once, names
  the device's place as on any other PC (formats E6; such a PC drops it), and whatever such a PC
  refuses it for holds back nothing: the `add` for the account's other PCs goes out as ever. On any
  other PC the approval comes first, and the entry once the PC holds the device's row; the account,
  list and member key it signs under are fixed by its first read, before the wait for that row.
- **Nothing more for a device put out meanwhile.** On either PC, before the introduction that
  names the account's PCs and again before the `add` is signed, the approver's own copy, as it
  holds it then, must still have the new device in, in the list and under the member key the
  approval began with. Otherwise nothing more is sent, and the card says why (removed, or the
  sign-in changed).

### Which list it follows

Never the one the account service names, on that word alone. A device follows a list only when

- entry 0 with that id is a `genesis` of its own account, signed with its own member key (it
  started the list, in this page or another), or
- a member that let it in handed it the list id and its own place in it, and the log shows this
  device's key let in, up to that very entry ([Letting a device in](#letting-a-device-in)).

A device that follows a list keeps to it. A service that names another list for the account
changes nothing the device holds, and the device says so (`other_list`). A service that names none
is no hint and no alarm, as the follower has it. Either way the device goes on reading its own
list by its id, so that an entry which puts somebody out still reaches it.

A device that follows none asks for entry 0 of the list the service names, and for nothing else of
it. It is `not_in` that list, for one of three reasons: the entry is that list's and is not its
own (`not_mine`: it waits to be let in, keeps its claim of its own key standing, and does not ask
for the entry again while the service names that list); the service did not show the entry with that id (`unread`: it asks again in five
minutes, and keeps a genesis it signed); or the entry is in a form this build cannot read
(`needs_newer_client`).

### Catching up

A read asks which list and which head the account has (`GET /v2/lists/mine`). A head that is the
copy's own ends the read. Otherwise the device asks for the entries after its own head
(`GET /v2/lists/{list}/log`), takes each page as the follower says, asks on until the follower has
no more to ask, and saves the copy. Then it opens the names: with the wraps it kept, and while the
current epoch's key is not among them, with the wraps the account service holds for its encryption
key (`GET /v2/lists/{list}/wraps`), asked for at most every five minutes for one copy.

It reads:

- at once when a sign-in is read, once that sign-in's key is registered;
- every 30 seconds while the app is in front, and never by the clock while it is not;
- when the app comes to the front, at once if its last read began 30 seconds ago or more. That is
  also how a ring of the account's doorbell reaches a page that was not in front;
- every five minutes in front while the account may have a list and has none, or the device is
  in none;
- by the clock and by the app coming to the front, never twice within five seconds, whatever
  answers. A read that a part of the app asks for itself (a sign-in that was just read) begins at
  once, and one asked for while another is under way begins when that one ends;
- one read at a time for an account among the tabs of a browser. Each request ends after 30
  seconds, each page of the log with 30 seconds of its own, and a round asks for no further page
  once it has read for 30 seconds.

**Every page is saved as it is taken**, before the next is asked for. A round that ends early (a
page that does not come, the 30 seconds, the follower's 128 pages) keeps what it took, and the
next round goes on from there, five seconds later while the app is in front. So a device that is
n entries behind has the list after at most n / 256 rounds that each got one page, whatever is cut
in between. A round whose first page does not come counts as one that did not reach the service.

**A save never goes over a newer one.** The copy is written only over the very text this page
read, in one IndexedDB transaction; where another page saved meanwhile, nothing is written and the
round reads what is saved now and takes its pages again, three times at most. That holds in a
browser without Web Locks too, and it is what keeps an alarm one page saved from being written
over by another. The time of the last full read and the floor of the clock move with every round
that reached the service: they are kept in a small record of their own (`times`), so such a round
does not write a long copy again, and a page loaded again takes the later of the two.

An account service that is away, slow, or off its switch again leaves the copy as it is: the
device shows what it saved, and says that it did not reach the service.

Each of these requests is sent once, and whatever it is answered is that request's answer and no
more: a `401` neither refreshes the device's tokens nor ends its sign-in, as it does for the
requests a person's own act makes. The app asks them by itself, on a clock, also of a service that
has no such routes, and what that service says of a route it does not know must not sign anybody
out. Only `404` to `GET /v2/lists/mine` says that the service keeps no list for the account.

How often the device asks while it gets no list:

- after that `404`, once a day at most for the account, counted from when the answer came (the
  time is kept on the device, so a new page or a new start of the app asks nothing in between);
- after a round that did not reach the service (no answer, or any other refusal), in 5 minutes,
  then 15, then an hour, then every 6 hours, until one round reaches it. That holds for a device
  that follows a list too, for which a `404` is the service being away, and for a round in which
  the service named another list or none and did not answer for the device's own log;
- never while signed out.

### Meeting a PC

From the moment the app owns an authenticated session with a PC that selected the account's list
for it (it is pinned to its list, [Two members meet](#two-members-meet)), whatever screen shows
(Ready, an update the PC needs, the PC's own pages), the device and the PC say where they stand,
and each hands the other what it lacks (`listGossip.ts`, over `POST /api/account/list/head` and
`POST /api/account/list/page`):

- at once, at every new carrier of the session (each is a new session at the PC, whose selected
  features are known before anyone is told the carrier is up), whenever the device's own copy moves
  its head, and every five minutes while the session is up. So a removal this device places
  reaches the open PC at once, and one the account service withholds from a PC reaches it the next
  time any device of the account that holds it opens that PC;
- the device says its footing; what the PC answers of its own entries (`page`) is taken by the
  device's follower as a page from a peer (`takeFromPeer`: never a full read, saved under the
  account's lock as a round saves, and installed only while the sign-in it was begun under is the
  stored one); what the PC asks for (`asks`) is handed over, once an exchange, following every
  place the PC asks for next: a later one where it took a page in part, an earlier one where it
  looks for where two histories part, until it asks for a place it was handed already. Where the PC
  asks for a place past the footing it names beside it (an entry no member signed stands above its
  footing, which the service may have shown it), the device hands from that footing, so a stranger's
  entry keeps no removal from the PC. Entries are handed only to a PC this device's copy holds or
  held; one that merely names the list's id is told where the device stands and handed nothing;
- the session belongs to the account, the list and the member key its list key was taken for (a
  session opened with the list key), or else of its first exchange: while the page's list is
  another one (another account signed in on this browser in another tab, or this device back with
  another key), the PC is told nothing of it, the app says nothing of that PC by it (no "removed
  from the account"), and once that list is back the exchanges go on. This is looked at before
  every call and after every answer: an exchange under way when the page's list changes stops
  there, and takes or hands nothing more. So does one under way when its session is no longer the
  app's, when the device stops comparing with that PC, or when a new carrier comes up: its call is
  called off, and what a late answer brings is neither taken nor followed. The PC, for its part,
  asks for entries from its footing, never from an entry no member signed above it;
- where the device needs the PC's entries after another place (the PC holds more, another entry at
  a place the device holds, or the device looks for where two histories part), it asks for them in
  the head call (`asks`), and judges what comes back. The PC answers that read only to a key its
  list lets in. Two histories that members signed raise the alarm on both sides; one that holds
  only what its writer left behind raises it on the side that is shown the other;
- at most 24 of the two calls a minute of one PC and the key it let the device in by, and a
  `429`'s wait, kept for that PC and key in the browser's storage, so every tab and every
  reopening of the PC draws on the same budget (the PC counts 30 by that key, in memory); a wait
  lasts no longer than the PC asked for, whatever the wall clock does, and is armed in pieces of
  five minutes at most. Where the browser's storage takes no write, the page goes by its own record
  until it does. What a minute's calls or a `429` did not finish (the device's read, or the PC's
  next asked place) goes on as soon as the budget has room again, from where it got to, while the
  device stands where it stood;
- one answer is read up to 512 KiB and for 10 seconds, an error's body included; a longer or a
  slower one ends the exchange;
- a page whose save fails is acted on from memory all the same (a removal stands at once), is not
  said to be taken, and the next round writes it first. Where another tab saved meanwhile, what this
  tab verified (the entries, an alarm) is taken into what that tab saved before anything is shown,
  from the last entry a member signed in it: entries no member signed above it, which the service may
  have shown that tab, give way to what this tab verified.

**A PC the list puts out while it is open.** The device ends its own use of it at once (the PC's
pages go, the session is no longer the app's, and an exchange of that use under way stops), and
over the session it still has makes one attempt of three seconds at most to hand that PC its
removal, then closes the session: it waits within those seconds for a carrier that is down, draws
on what is left of the PC's own 30 calls of the minute, takes nothing from that PC (a PC known to be
out raises no alarm here), and hands nothing where the page's list never held that PC, or stands
for another account, list or member key by the time the carrier is back. The attempt can fail: the
carrier stays down, the PC does not answer in time, or the minute's calls are spent. The PC then
learns of its removal only from the account service, or from a member that hands it over at a later
session; where the service withholds it too, the PC does not know it is out until then.

**An alarm ends every write.** From the moment the device's copy holds an alarm, in this tab or as
another tab of the device saved it, nothing it signs is kept or sent: an Allow that was waiting for
a claim, a change that was waiting for an answer, a request kept from before.

Nothing is asked of a PC that follows no list (it did not select the list for the session), and
nothing by a device that follows none: an account with no list sends no request and no frame it
did not send before. Entries prove themselves, so neither side is trusted for who is in.

### What the device says is wrong

Each of these is a state the app can show. None takes anybody out of the copy, and none lets
anybody in.

| state | when |
|---|---|
| `fork` | the account service, or a PC this device met, showed another history that a member signed. Kept with the copy until a person resets it; from then on the device shows only whom it held when it was found, and signs nothing |
| `stuck` | the account service shows another history under what the device holds, which no member signed |
| `other_list` | the account service names another list for the account than the one the device follows |
| `refused` | the log holds an entry that does not hold: a changed byte, a broken chain |
| `unsigned` | the log holds an entry that no member signed. The account service places none, so it wrote this one |
| `wrong_key` | the account service handed the device a key to the names that is not the one the list commits to. The key is not kept |
| `needs_newer_client` | the list holds an entry this build cannot place |

A name that does not open for another reason (no wrap yet, a wrap that was spoiled on the way) is
a device or a PC without a name, and no state: it is no evidence of anything.

**The alarm on the screen.** A device whose copy holds `fork` says so in a part of its own at the
top of Manage account's lists, and in one line on My PCs that points there: **Two different
histories of your account's list were seen**. It names no device or PC as the cause. It says that
the devices and PCs already in keep working and that this device lets nobody new in while it
shows, and it gives the way back of [What a person does](#two-histories), one device or PC at a
time: reset one (a device: Sign out, sign in again and be allowed from another device or PC, then
remove its old listing there; a PC: Revoke all, then add it again), look at what it shows and
remove what is not the person's at that same device or PC, check it is gone there before the next,
and stop where two of them still differ. A device is reset by Sign out, not Disconnect: Disconnect
signs the device's own removal first, which the alarm refuses, so it never finishes while the alarm
stands, while Sign out signs nothing, ends the sign-in and forgets the key and the copy. The old key
stays in the list until a member that shows no alarm removes it, as the one that let the device in
again can; the message after that sign-out says so in the same order. A pinned PC says the same in its own words, in `reason` of
`GET /api/account/list` and in the account's status, which `ovis status --json` shows as
`list.reason`.

### What the app reads

One object per page (`accountList`), which the rest of the app asks instead of the account service
once it goes by the list:

- `view()`: the account, where the device stands (`off`, `none` with why no list was started,
  `not_in` with why, `damaged`, `newer_save`, or `following` with the list id, the head, whether the device is in,
  and what is wrong), whether the last read reached the account service, and the devices and PCs
  that are in, in the order they came in. A device has its key, power, role and `until`; a PC its
  relay key, the id that key gives, how it came in and whether a person at it can allow a device;
  each with its name where it opens. Nobody is listed unless the device follows the list and is in
  it.
  A PC also has the place of its entry, the key that signed it, and from when it is new to this
  device.
- `holdsPc(relay key)` and `pcOfKey(signing key)`: whether that PC is in the list. `follows(account)`:
  whether the device keeps a copy of a list of that account, from its own store alone.
- `adopt(place)`: takes the place a member handed this device. `writer()`: what an entry is signed
  on (the device's state, its keys, the epoch keys it holds), or none for a device that may not
  sign. A device of power `bound` has one only for the removal of its own key
  (`writer({ self: true })`), which the signers' rules let any signer write. `gossip()` and `pageAfter(place, limit)`: where the device stands, and its entries after a
  place, for another member. `compare(head)` and `takeFromPeer(page, read)`: how the device
  stands against a PC's head, and a page that PC handed it ([Meeting a PC](#meeting-a-pc)).
- `subscribe`, `sync` (one read now), `due` (when the next read is due), `forget` (a person's reset).

### Compared with the directory

After each read of the directory and each change of the list, a device that is in the list holds
the two against each other, for the record: what it lists and opens is the list's
([PCs of a list account](#pcs-of-a-list-account)). It counts the PCs both name, those only the
directory lists (with whether the PC itself has pulled the account's mailbox), and those only the
list holds. It keeps how many comparisons it made, how many differed and the last one, on the
device alone, and writes one line to the console when the difference changes, with counts and no
name, id or key.

## An account that was in use

An account that has devices and PCs before it has a list is moved onto one by the first of its
devices that can: it starts the list and carries the others in. This is the one moment a list is
made from what the account service says, so nothing here takes the service's word. The code is
[`shared/account-list-migrate.ts`](../shared/account-list-migrate.ts); it has no I/O, no storage,
nothing random and no clock, and it writes every entry through the kinds' own writer.

**The keys such a list is born with are the keys the devices' sign-ins registered** with the
account service, since those are the keys the account's PCs let in before the list. Entry 0 is
signed by the first device's sign-in key, not by its account key; the run of `carried` entries
follows; and the first device ends the run with a `device` entry that hands its place to its
account key (it adds that key with the device's own card and ends the sign-in key), then opens
the next epoch. Every device that was carried in does the same when it next runs. A PC that
follows the list lets in whatever key the list holds as a device that is in: a carried sign-in key
until its hand-over, the account key after. So an app from before the list goes on opening such a
PC with the key it has, and each device ends up in the list under a key that outlives its sign-in.

**The birth is one request.** Entry 0, the whole run, the hand-over and the `epoch` entry are
placed together or not at all (`signMigration` signs them once, and the device sends those very
entries until the service has taken them). Until then the account has no list in any sense, and
the first device follows nothing. An honest log therefore never holds a part of a birth: a member
that is shown one (the run is not over, or the `epoch` entry that ends the birth is missing)
waits, says so, and signs nothing on it.

**Three rules keep the service's word out:**

1. A list is named to a PC only by a device the PC knows, inside its own session with that PC, and
   only a list whose first signer that PC knows too.
2. A device follows a list it did not make only when the PCs it knows say who started it.
3. The first device carries a key in only where every PC it knows lets that key in.

### A day, by a PC's own two clocks

A PC counts a key only when it has let it in **for a day by its wall clock, and has itself been
running for six hours with the key let in** (`MIGRATION_WITNESS_SECONDS`,
`MIGRATION_RUNNING_SECONDS`). The wall clock is held against the latest time the PC ever saved, so
it never runs back; the running time is the PC's own count. A clock that jumps when a PC with no
battery clock starts so makes nothing a day old, and a PC that is used two hours a day gets there
in three days. Nothing else measures the day: not the list's own time, not an entry's `issued_at`,
not a time the service says. A PC answers with durations (`LetIn`: `wall`, `ran`, and `idle`
since the key was last used), never with times, so no two machines' clocks are compared. A key
named twice counts by its shorter stretch, and a row with no time recorded counts from the moment
the PC began to record.

A device knows a PC by its own record when it did something itself for that PC (`PcHow`: it
paired with it at the PC, pressed Add for it, added it over SSH, or is that PC's own window), or
when it has held sessions with that relay key for seven days (`MIGRATION_KNOWN_SECONDS`,
`ownEvidence`). The account service's directory alone is no such record. Only the first kind
(`addedItself`) lets a member sign that PC's `pc` entry, which makes the PC a `full` signer, with
no question: never the directory, however long, and never what a PC says of itself. A PC nobody
did anything for stays an endpoint with no key, which follows the list and signs nothing, until a
person compares the number at it.

### What the first device carries in

`migrationPlan` takes what the device knows: the account's devices as the service lists them; the
removed keys as the service lists them, with every key the device itself holds a block or a removal
against, sent or not; and for each PC whether the device knows it by its own record and what that
PC answered over a session: its account, the list it follows if any, the keys it lets in with how
long it has, and the keys it holds a removal against.

- A device key is carried in only when the service lists it as let in, nobody (the service, this
  device, any PC that answered) holds a removal against it, and **every** PC the device knows by
  its own record, that answered, has let it in for a day. No single PC adds a key: one the service
  planted on one PC, or named itself, is left out (`unwitnessed`); so is one a PC put out and the
  service lists again (`removed_at_pc`).
- A key that every such PC lets in, one of them for less than a day, holds the start back
  (`too_new`, with the seconds left). Nobody presses anything: the device asks again. So does a
  device the service lists as one no PC lets in yet (it signed in this morning), for a day from
  the device's first try; after that it is left out (`not_eligible`).
- **A PC that does not answer is no yes.** While a PC the device knows is silent it starts nothing
  (`pcs_silent`); three days after its first try (`MIGRATION_ANSWER_SECONDS`) it goes by those
  that answered, at least one. An answer counts only when it was given in this run of the app.
- The device's own sign-in key is held to the same (`self_unlisted`, `self_removed`,
  `self_unwitnessed`), and with no PC it knows by its own record that answered it starts nothing
  (`no_witness`).
- A PC is carried in when the device knows it by its own record, answered or not. Any other
  (`unknown_pc`) is added later by a `pc` entry.
- At most 64 are carried in (`MIGRATION_CARRIED_MAX`), devices first. A sign-in that nobody uses
  any more is told apart before that: the service lists it as not let in, or a PC no longer lets
  it in (a PC drops a row it saw no sign-in of for 60 days). Where an account still has more, the
  devices a PC saw in use last are kept and the rest is left out (`over_limit`).

A device that was left out asks to be let in as a new device does. `signMigration` refuses the
whole birth, before it signs or seals anything, when a key the plan names is no key whose point is
on the curve or is the device's own (`key_invalid`): the kinds read only the spelling of a carried
key, so that check is made here, and by every PC.

### A device that was carried in

`devicePlace` says where a device stands in such a list, from the list alone: `first`, `carried`,
`member`, `out` or `absent`. That is how a device that was off learns what became of it.

A carried device does not follow the list on the service's word. `joinVerdict` asks the PCs it
knows by its own record, each over a session to that PC's own relay key: **every** one that answers
must agree. A PC that follows a list agrees when it is this very list; a PC that follows none
agrees when it has let the key that signed entry 0 in for a day and holds no removal against it. A
silent PC is no yes: the device waits for every PC it knows (`pcs_silent`), and goes by those that
answered only after three days. So a list the service started with a key of its own, carrying the
person's real keys, is refused by every device it shows it to (`first_signer_unknown`). A refusal
names the PCs it is about: for `other_list` the way out is that PC's (it is removed from the
account, or reset), and the refusal clears when the PC is gone or agrees. A device that refuses
says so, never names that list to anybody, and asks to be let in as a new device does. It follows
no list that carries a key off the curve (`carried_off_curve`).

Then it hands its place to its member key (`signRotation`): one `device` entry signed by its
sign-in key. `standsFor` gives, for a key, the key the same device is in by now, and `rekeys` the
rows that moved between two states: a PC moves such a row instead of announcing a new device.

### A vouch: the link (`ovis-list-link/1`), with both signatures

A PC lets a device in by the key its present sign-in registered, and the list holds the device by
its member key. A device whose sign-in has changed since the move joins the two with its **link**,
one statement with two signatures:

```
bytes  = "ovis-list-link/1" || len(account) || account || len(list) || list || len(key) || key || len(device) || device
         len(x) = the byte length of x in 4 bytes, big-endian; each value as UTF-8
member = ECDSA P-256 / SHA-256 by `key`, r || s, 86 base64url characters
device = the same, by `device`, over the same bytes
handed to a PC as { "key", "device", "link": { "member", "device" } }
```

`device` is the registered sign-in key; `key` is the member key the same device is in the list by.
It is the statement the account service keeps to know which sign-in is which member, and to a PC
it is a vouch: the sign-in key says the member key is its device's, and the member key agrees. A
device signs one only for its own member key while that key is in (`signVouch`), anyone may carry
it, and `heldVouches` keeps those in which both signatures hold. Either alone proves nothing: any
key can name a sign-in key that is not its own, and a sign-in key that names a member key could
otherwise hang a removal a PC holds against it on that member (`heldOut`), so a device the PC put
out would put any other out, the one that started the list among them.

### Naming the list to a PC (`ovis-list-name/1`)

A PC that is in an account and follows no list learns its list from a device, inside that device's
end-to-end session with it, with no press and no person:

```
bytes     = writeFieldsUnder("ovis-list-name/1", [account, endpoint, key, list, session])   named fields, as a body's
signature = ECDSA P-256 / SHA-256 by `key`, r || s, 86 base64url characters
travels as { "list", "key", "signature" }
```

`key` is the key the list holds the device by (its account key, or its sign-in key before its
hand-over), `session` the key the session is signed in with, `endpoint` the PC's relay key. A
device says it only for a list it follows and is a `full` device of (`signNaming`); the PC checks
the signature against its own account, its own relay key and the key this session is signed in
with (`heldNaming`). It is bound to that key, not to one session: it holds in every session of
that key at that PC, and for nobody else.

`pinVerdict` then decides, on the log the PC read with its own proof and with nothing pinned yet.
A device is **known at this PC** when a key the PC has let in THROUGH THE ACCOUNT for a day is one
the list holds that device by, or one the list shows handed over to its key, or one that vouches
for its key. A pairing made at the PC is no such key: the PC cannot tell an owner's pairing from a
guest's. The PC follows only when both hold:

1. the session is signed in with such a key of the naming device itself, and the list holds the
   naming key as a device of power `full` that is in (a session carries no other device's naming);
2. the device that started the list, entry 0's signer, is known at this PC too; or it is out of
   the list by now, and the PC can place every signer that is in: it knows the signer's own
   device, or somebody it knows let the signer in, through however many hands, without the first
   signer among them. The phone that started a list may be replaced; what it let in must not
   outlast it unseen. A device that was carried in and that this PC does not know, a PC whose keys
   the first device added, and an open invite it placed cannot be placed. A device this PC put out
   itself is no obstacle (it stays out here), and stands behind nobody it let in.

So a list made by a key this PC never let in is never followed here while that key is in, whoever
names it: not on the word of a device that was fooled into it, not on the word of a guest, and not
on the service's. Once such a key has removed itself and left only devices this PC knows, the PC
follows: nobody is in who was not the person's, and what it cost is names, since the key that
started the list held the first epoch's key.
And a PC that was off, or took this release long after its account moved, follows the next time a
device it knows opens it, with nobody at it and no record of what it once let in.

| refusal | when | then |
|---|---|---|
| `stopped` | it cannot place an entry of the list | it needs a newer Ovis |
| `other_account`, `other_list` | the log it read is not of its account, or not of the list that was named | nothing |
| `carried_off_curve` | the list carries in a key that is no point of the curve | nothing; no honest device signs one |
| `removed` | it holds a removal against the session's key, a key the naming device has been in the list by, or a key that vouches for it | nothing: what it put out names nothing |
| `session_unknown` | the session's key is none it lets in through the account | nothing |
| `session_new` | it lets that key in, for less than a day by its two clocks | it is asked again; it says nothing |
| `not_member` | the list does not hold the naming key as a `full` device that is in | nothing |
| `session_other_device` | the session's key is not the naming device's own | nothing |
| `first_signer_removed`, `first_signer_unknown`, `first_signer_new` | it holds a removal against the device that started the list; it does not know that device; it has for less than a day | nothing; nothing; it is asked again |
| `run_open` | what it read is the beginning of a birth | it is asked again |

The first that applies names the refusal. Nothing here is one-way: a PC that does not follow goes
on as before the list and is asked again at the next naming. On a yes it pins with the follower's
`migrated` pin, whose `admitted` is entry 0's signer and every carried key.

The PC asks nothing of the other keys the list was born with; that was asked by the first device
of the PCs it knows. A removal the PC holds against a device that is neither the naming one nor
the one that started the list is no reason not to follow: that device stays out at this PC after
the pin, by whichever key it is in and whichever sign-in key vouches for it (`heldOut`), so
neither a hand-over nor the pin undoes a removal.

### On the PC (as built)

- **The witness.** A device asks each PC it knows `GET /api/account/list/witness` in its own
  session and gets the PC's `{ account, pinned, admits, removed }` (docs/account.md, "How long a key
  has been let in").
- **The naming.** `POST /api/account/list/name { naming: { list, key, signature }, vouches? }` from
  the device's own session, signed in with its key (at most 16 vouches, and 30 calls a minute for
  a key with the other session calls of the list). The PC keeps a vouch only between a device of
  that list and a key it lets in through its account or holds a removal against, so links between
  made-up keys take no place (`account-list-vouches.json`, at most 4 lists and 64 vouches a list;
  the other lists' go at the pin, and the file goes with the binding and at an identity reset).
  The cap never refuses a link whose sign-in key the PC holds a removal against: such a link keeps
  a device out, and there are no more of them than the PC's own removals. Any other link past the
  cap only says who is known here: a naming that would rest on one is refused (`lists_full`), and
  after the pin it is left out with a line in the log, never dropped unsaid. It
  reads that list's log with its own proof, at most once a list each 30 seconds, and follows only
  on a read that reached the head the service shows. It asks `pinVerdict` with its own record and
  the vouches it kept and was handed now. It answers `{ pinned: true, list }` or `{ pinned: false,
  why, wait }`, `why` one of the refusals above or `naming_invalid`, `named_here`, `not_read`,
  `lists_full`, `unavailable`, `wait` in seconds of its own clock. A PC that follows a list answers
  `{ pinned: true, list }` with the list it follows, whatever was named: the device compares it.
- **The account service's links.** Before it pins, the PC reads every link the account service
  keeps for that list (`POST /v2/pc/list/links`, page after page), checks both signatures of each
  itself, and keeps those that say something here, beside the vouches: no links read, no pin yet.
  After the pin it reads them again at each read of the log while it holds a removal of its own,
  so a device it put out by a sign-in key stays out by its member key whether or not it ever
  handed that link. What is left: a service that withholds a link. On a yes it saves its copy, pinned
  as `migrated`, and pins once the answer is out: the pin ends every session of the account's rows
  with `auth_changed`, the naming one among them, and its final `WELCOME` then names the list.
- **After the pin** a device that hands its place on keeps its row, a removal of the PC's own
  follows the device (`heldOut`), and a carried key that never handed over is let in only while the
  account service's snapshot names it (docs/account.md, "What a pinned PC does").
- **Keys for a PC carried in as an endpoint.** It follows the list and lets its devices in, and
  lets nobody in itself. A device the list holds to drive with full power asks it in its session,
  `POST /api/account/list/card`, for `{ key, enc, card, endpoint, list }`; the PC posts its keys at
  the account service in that call, and takes for itself only the `pc` entry that very device signs
  (handed over `POST /api/account/list/page`, or read from the service). A device signs one with no
  question only when it did something itself for that PC (`addedItself`). With nobody's evidence,
  `ovis add` at the PC gives it its keys by the number, from the adder the person confirmed. An entry
  with its keys that another device signed, and another key at its relay key, give it nothing to
  sign with, and it says so.

### What is left

- **A key that stood for a day, unnoticed, on one PC the first device asks can be carried in, and
  is then a full member of the list.** The first device waits three days for every PC it knows to
  answer; a PC that stays silent that long does not keep such a key out. A key let in at a PC is
  already a terminal on that PC. With such a key on a PC the service can also start a list of its
  own and have it followed there, on that PC and no other. This outlasts the breach: it is undone
  PC by PC, at the PC, and by starting the account over.
- A device a PC has let in through the account for a day (a borrowed browser among them) names any
  list to that PC by vouching for its first signer. It is the same residual, on that PC.
- The service can keep an account from moving, hide a device from the first one (it is then let
  in as a new device), and keep the lists of two devices that started at once: nobody is in either
  who was not in before, a device that asks a PC of the other list refuses and says which PC, and
  it is undone at that PC.
- A PC that was off from before the move until after the device that started the list left the
  account follows all the same when it knows everybody who is in, or who let them in. It does not
  while a device that was carried in, and that it does not let in, is still in the list: that
  device hands over and vouches, or is removed, and the PC follows.
- A carried device whose PCs no longer hold the first signer's key (that sign-in has changed, and
  no PC it knows follows the list yet) does not follow by itself: it asks to be let in.
- Nobody signs a removal because the account service lists a key as gone or blocked. A carried key
  that never handed over is let in by a PC that follows the list only while the snapshot also
  names it, which is local and undone when the snapshot names it again.

### In the app

The app does all of this by itself, behind the account service's migrate switch, and asks the
person to press nothing ([`src/lib/account/listMigrate.ts`](../src/lib/account/listMigrate.ts),
[`accountList.ts`](../src/lib/account/accountList.ts)). An account the switch does not name, and an
account with no list, is asked and told exactly what it was before; a list that was not born by a
move is never named to any PC.

- **What a device knows.** Its PCs are its own record of them (`seenPcs.ts`: since when it held
  sessions with each relay key, and what it did itself for it); `invited` counts as `added`. Each
  PC's answer (`GET /api/account/list/witness` on a session) is kept in memory for this run of the
  app only. While the device waits on its PCs, every session the app opens to one asks it, and the
  PCs its record knows that have not answered are asked over a session of their own (a saved
  pairing, or through the account with this sign-in's key, and once more with the key its list holds
  where the PC lets the account's devices in by the list alone), each at most once in ten minutes. A
  PC that cannot be reached, or runs an Ovis that cannot answer, is silent.
- **The start.** When `GET /v2/lists/mine` says `migrate` and the account is not new, a device whose
  storage lasts (as for a genesis) plans from `GET /v1/devices`, the directory's PCs that are listed
  as let in (a PC outside it is left out, as the service would refuse it), its record, this run's
  answers, and the keys it holds a block or a removal against itself (every key a Not me of it
  blocked, whatever the service answered, and the removals it signed). It notes its first try
  (`tried`) and waits while the plan says so. Each carried device's entry seals the name its sign-in
  registered (`GET /v1/devices`' `label`, where it sent one). It signs the birth once, keeps it in
  its own store and sends it (`POST /v2/lists` with `entries`, the wraps of epoch 1 to itself, and
  the link of its account key to its sign-in key) as it is until a 201 or its own list back in a
  `409 list_exists`, or until the account service names that list. While a block of its own on a key
  the birth carries has no answer from the account service, the birth waits: a frozen sign-in is
  never carried. Where a key it blocked is carried in all the same (a block the service refused for
  good, or a service that placed the birth anyway), the device's first write in the list it made
  removes it (`not-me:<key>:<digest>`, kept and sent again like any write), and it signs nothing
  else there before that is placed. The birth's own final refusal (a 400 or a 413 of its body, a
  `403 not_carried`) drops it; the next plan comes an hour later at the soonest and leaves out the
  key or the PC a `403 not_carried` named (its `index`: entry 0 is 0, then the devices, then the
  PCs, in the plan's order). A refusal of the caller (a frozen sign-in, a route the service hides)
  keeps it. Only a `409 list_exists` naming another list gives its list up for good, and a birth
  kept for another list than the one the device follows is let go. It follows the list pinned under
  the sign-in key that signed entry 0.
- **A carried device.** A device that is not in the list the account service names reads its first
  two entries, in one request (`limit=2`), on every account: entry 1's kind is the only word on
  whether a move carried it in. A list whose entry 1 is `carried` is read whole without being kept.
  Where the device's sign-in key was carried in, it asks `joinVerdict` with its record and this
  run's answers; on a yes it pins as `carried`, saves the copy and, while no PC it knows says
  against the list and its copy holds no fork alarm, hands its place to its account key
  (`signRotation`, with the D11.2 link, one kept request per head). On a no that does not wait it
  says why, names the PCs, and asks to be let in as any new device does; it asks again at every
  round, so the refusal clears when its cause does. Until its hand-over is placed it signs in to a
  PC of the list with its sign-in key, the key the list holds it by (R-E), never the way from
  before.
- **After a carried device joins** it keeps the PCs that agreed then or since (one agrees when it
  follows the list, or has let the device that started it in for a day by both its counters), and
  for three days asks the others again. Where a PC it knows says that it follows another list of the
  account, holds a removal against the device that started the list, or (one that did not agree at
  the join) lets that device in by none of its keys, it says so, names the list to no PC any more,
  and offers the reset of its copy of the list (V4-6). After the reset it follows nothing, says why
  while a PC says it, and asks to be let in as a new device does: a member's Allow hands it its own
  place.
- **A saved copy** is the device's own when it was pinned under its account key, or under a
  sign-in key of its own that the list shows handed over to it, or under its sign-in key of now
  while the list still holds that key.
- **Sessions.** A device that follows its moved list names it (`POST /api/account/list/name`, the
  naming by the key the list holds it by, with the vouch of the sign-in key the session signed in
  with) to every PC of the account that takes no `account-list-1`: one its directory lists, or one
  its own record knows. It says nothing of the move to any other PC. On a PC that does, a PC the
  move left with no keys gets them from a member that did something itself for that PC: it takes the
  PC's card over the session (`POST /api/account/list/card`), checks it for this list and that relay
  key, signs the `pc` entry and hands the PC the page. Any other member leaves it to the number at
  the PC.
- **What the person sees.** Once, after the pin, who made the list and every device and PC it
  brought in that is still in, never the device itself, and each device it put out again because
  this device said Not me to it. Each PC has Not me, which removes it from the list after a
  question; a device's Not me, and that of the device that made the list where it is another, is the
  devices list's Remove. A carried device that refused the list says why. Nothing else.
- **The QA twin** (`sh.ovis.app.previewqa`, which says so through `HerdrShell.appId`) multiplies
  the durations the device hands over (`known`, `tried`) by `localStorage["ovis-migrate-qa-scale"]`
  (1 to 86400). No other build reads it, and the pure constants never change; a PC scales its own
  two counters itself.

## The vectors

Each file of [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope) is
one JSON object: `name`; `given_list`, only when the member was given a list id; `keys`, the test
keys (base64url `pkcs8` and `spki`, each named `TEST-ONLY-...`: never use them outside tests);
`entries`, in order, each with `fields` (the body's fields as text, for a reader), `body` and
`signature` (base64url), `text` (the entry on the wire, which is what a reader reads) and `hash`;
and `expect`: either `state` (`{ list, head: { seq, hash }, first_signer }` after the last entry)
or `stops` (`{ seq, code }`: the place of the entry that does not hold and its code). Every `text`
that reads is `body`, `.`, `signature`; the `wire-` vectors carry a `text` that does not read,
beside the entry it was made from. ECDSA signatures are random, so a vector fixes the body, the
hash and one signature to verify; nobody is asked to reproduce a signature. Two implementations
agree on this page when both give every vector's `expect`.

Each file of [`shared/account-list-vectors/join/`](../shared/account-list-vectors/join) has `name`,
`keys`, a `line` and `expect`: either what the line reads to (`service`, `account`, `list`, which is
`null` for an account with no list, and `key`) or `stops` (`{ code, reason }`). A `reader`
(`{ service, follows_lists }`) says what the reader is told of its caller; without one the caller
uses `https://accounts.ovis.test` and follows lists. Each `redeem` file of
[`shared/account-list-vectors/invite/`](../shared/account-list-vectors/invite) has `name`, `keys`,
the `line`, the `key` the signature is checked under (the key the line reads to, but for the two
files that change it, which name that one as `key_of_line`), the `redeem` values, a `signature`,
and `expect.verifies`; every file whose values are in form (all but `redeem-server-id-uppercase`)
has their `bytes` (base64url) and `bytes_hex`. Each `make-proof` file has the `make` values, their
`bytes`, the device's key as `device_key`, and a `signature` by it. `line-challenge` has a `list`,
a PC's `card`, the card's `binding_hex` and the `challenge`; `line-proof` has those with the
`account`, the PC's `server_id`, the message's `bytes_hex`, the invite's `key` and its `signature`.

Each file of [`shared/account-list-vectors/kinds/`](../shared/account-list-vectors/kinds) is a list
from entry 0: `name`, `level` (the member's), `keys`, `entries` as above (`sealed` is shown as
base64url), and `expect`: either `outcomes` (what became of each entry after entry 0, as
`counts`, `cannot_read`, or the outcome and its name) with the whole `state` after the last entry,
or `stops`. A list that no member follows has `stops` alone; a member that stopped after entries
it took (at one that does not hold, or at one it cannot place) has `stops` with the `outcomes` and
the `state` of what it kept. [`card/`](../shared/account-list-vectors/card) holds cards (`card`,
its `bytes` where it is in form, a `signature`, `expect.holds`) and [`names/`](../shared/account-list-vectors/names)
holds names (`fields`, each a name and its value as base64url, and `expect.names`, which is `null`
for fields that give none; `written` says that a writer writes exactly those fields for those
names).

Each file of [`shared/account-list-vectors/save/`](../shared/account-list-vectors/save) is one
[save](#the-save): `name`, `about`, `keys`, the `save` text, `now` (the member's clock for
`opens`) and `expect`: either `reads` (`account`, `list`, `me`, `pin`, the copy's `head` and
`footing`, whether it was `rebuilt`, its `standing` (`waiting`, `in`, `out` or `stopped`), whether it
holds a `stop`, the `seq` and `by` of its `alarm`, `read_at`, `seen_at`, and `opens`: for each
named key the role it opens a session as, or the refusal) or `refused` (the refusal). A save that reads and was not rebuilt is written back
to the same text; one that was rebuilt is written as the build that read it writes it.

Each file of [`shared/account-list-vectors/migrate/`](../shared/account-list-vectors/migrate) has
`name`, `keys` and one of three cases. `pc`: `entries` (a list from entry 0, each as its one text),
`endpoint` (the PC's relay key), `session` (the key the session is signed in with), `naming` (what
the device said, as it travels), `vouches` (as they travel: the test first keeps those that hold),
`witness` (what the PC holds: `account`, `rows` as `{ key, wall, ran }`, `removed`) and `expect`, the verdict: `{ pin: true, admitted }` or `{ pin: false, why,
waits, wait }`. `device`: `known` (what the first device knows: `account`, `self`, `member`,
`devices`, `removed`, and `pcs` with `how`, `known` and what each `says`), `tried` and `expect`:
`{ start: true, plan }` or `{ start: false, why, wait }`. `join`: `entries`, the device's `keys`,
the `pcs` it asked, `tried`, and `expect`: `{ pin: true }` or `{ pin: false, why, waits, wait, pcs }`. There is
one for each answer of each of the three.

### The vectors of seal/

Each file of [`shared/account-list-vectors/seal/`](../shared/account-list-vectors/seal) is one JSON
object with a `name`, an optional `note`, one of `wrap`, `link` and `sealed`, and `expect`.

- `wrap`: `list`, `epoch`, `commitment`, `member` (a name in `keys`, the test keys as above) and
  `text`, the wrap on the wire. A `text` that does not read has not the form.
- `link`: `list`, `from` (`epoch` and its `key`, 64 hex digits), `commitment` (of the epoch before)
  and `bytes` (base64url).
- `sealed`: `list` (empty for entry 0), `seq`, `epoch` (`epoch` and its `key`) and `bytes`.
- `expect` is `{ key }` (the epoch key that comes out, 64 hex digits), `{ fields }` (the names and
  their values, as text, without `pad`) or `{ why }`, one of the codes above.

Wraps, links and sealed fields are made with random bytes, so a vector fixes one to open; nobody is
asked to make the same bytes again. Two vectors fix what a reader refuses although the bytes
open: `link-same-key` (a link to the very key it was opened with) and `sealed-entry-0-epoch-1`
(entry 0 under another epoch than 0); a reader that only opens takes both. The `-made-elsewhere` vectors were written by a second
implementation, which also reads every vector in the tests with readers of its own (its base64url,
its field form, its key prefix). The `-made-in-python` vectors (a wrap, a wrap of epoch 0 with its
commitment, a link and a filled sealed field) were written once by a Python script that shares no
code with either, using `hashlib` and the `cryptography` library; the same script read every other
vector and gave its `expect`. Devices use WebCrypto with a key that
cannot be exported, so [`scripts/account-list-seal-browser-qa.ts`](../scripts/account-list-seal-browser-qa.ts)
reads every vector in a real browser too.

## The list routes in tests

The account service stores and serves the list; a member trusts none of its answers for who is in.
Tests reach the service's list routes (`/v2`) through the in-memory service in
[`shared/account-service-fake.ts`](../shared/account-service-fake.ts), on the same accounts,
sign-ins and PCs as its `/v1` routes. It runs this page's library on every entry it is asked to
place, as the service does, so a test fails where a client relies on something the service would
refuse. The tests in
[`shared/account-service-fake.list.test.ts`](../shared/account-service-fake.list.test.ts) show
every route in use.

- **The switch.** `listAccounts` stands for the service's `OVIS_LIST_ACCOUNTS`: account ids
  separated by commas, or `*` for every account. It is empty by default, and then every `/v2` route
  answers `404 not_found` as an unknown one and the mailbox's `with_list` says `list: null`. A test
  sets it first. `listMigrateAccounts` stands for `OVIS_LIST_MIGRATE_ACCOUNTS`, read the same way:
  the accounts that may move onto a list by the one-request birth. `GET /v2/lists/mine` says
  `migrate: true` for them while they have no list.
- **Devices** call by bearer: `POST /v2/lists` (entry 0, or a birth), `GET /v2/lists/mine`, and
  under `/v2/lists/{list}/`: `GET log?after=&limit=`, `GET wraps?member=`, `PUT wraps`,
  `POST entries`, `POST claims`, `GET claims`, `GET posts`, `POST links`,
  `POST posts/{endpoint}/attempt`. A write takes an app's own sign-in
  that no block freezes. A genesis, a claim and a batch that places an `invite` also take a sign-in
  made in the last ten minutes, or an older one with a key proof: a challenge of
  `POST /v1/pcs/challenge` (with `opensAll` on), signed by the key that sign-in registered over
  `pcAddSigningBytes` (`shared/account-records.ts`). The purpose is `list-genesis` with the list id
  in the place of the server_id and no listing; `list-claim` with the list id and the claimed key
  as the listing; or, sent as `key_proof` beside the batch, the invite's make proof
  (`inviteMakeBytes`: `invite` or `invite-auto`, no server_id, the invite's key as the listing).
- **PCs** prove their relay key in the body of each call (a challenge of `POST /v1/pc/challenge`
  answered with the role `account`, one per call): `POST /v2/pc/list`, `/v2/pc/list/log`,
  `/v2/pc/list/wraps`, `/v2/pc/list/wraps/put`, `/v2/pc/list/entries`, `/v2/pc/list/keys` and
  `/v2/pc/list/attempt`. A
  mailbox pull with `with_list: true` also gets the list's id and head, and `list: null` unless the
  account is on the switch, has a list, and lists that PC confirmed: so `null` tells a test no
  more than that, never that the account has no list.
- **The number a person compares** when adding a PC rides on the PC's post: the adder opens an
  attempt with its key and commitment, the PC answers it with its nonce once, the adder reveals.
  The fake only carries them, as the service does. Openings are counted per PC endpoint and
  account, six in ten minutes, whichever post or keys they were for; only a call that opens one
  counts.
- **A PC that joined by a plain invite's line** posts `invite` and `invite_proof` with its keys: the
  line's proof for the card it posts (`lineProofBytes`, under `ovis-list-line/1`, checked with
  `verifyLineProof` of `shared/account-list-invite.ts`; a redeem signature is never one). Both or
  neither (`400 invalid_request`); an invite the list does not hold open is
  `409 invite_not_in_list`; a proof that does not verify is `400 invite_proof_invalid`.
  `GET posts` shows both on that post only, and a later post without them clears them. The
  account's devices check the proof themselves.
- **A PC completes its listing** (`POST /v1/pc/complete`) when the listing is current and
  confirmed and has evidence of its own: completed already, a mailbox pull of that PC since the
  listing was made, a digit admission, or a one-press admission it took. So a PC of an account
  that has a list, which takes no admission (`list_add`), completes on its own pull.
- **What a placement checks**, in order, nothing stored on a refusal: every text in its form, and
  the first at the head (`409 head_moved` names the head; a batch already in the log text for text
  is `200` with `placed: 0`); then entry by entry, that it holds and counts for the library
  (`entry_refused` with its `outcome` and `reason`), and what only the service judges: no entry
  dated more than ten minutes ahead of its clock (`issued_at_ahead`, the genesis too), no `carried`
  yet, one `invite` a batch and only from a sign-in, a `join` before its invite's `exp` and only
  from the PC it names, an `epoch` only when a key went out since the current one opened
  (`epoch_not_needed`, `epoch_no_use`), no names until such an epoch is open (`epoch_stale`), the
  list's size; then the second lock (a `device` needs a live claim of its key; a `pc` a live post of
  its keys by a PC that an own sign-in listed or let in, a device code's listing does not do; a
  `join` that very PC's redeem of that very invite and such a listing; each used up by the entry),
  the wraps, the invite's sign-in, and the budget of additions (per ten minutes and per day). Two
  writers at one head: one is placed. A removal (`remove` entries with at most one `epoch` last, at
  the head, from a sign-in that may write, its first entry signed by a signer of the list) spends
  that signer's own counter instead of the account's requests; a replay never does.
- **A link** says which registered sign-in key (the one `registerSessionKey` registered for that
  sign-in) is which member key: `{ member, device }`, the member key's and the registered key's
  signatures over the library's `linkBytes` (`shared/account-list-migrate.ts`). It rides on a
  genesis, on a claim (kept with the claim and written when that key's `device` entry is placed,
  while the sign-in still holds the key), or on `POST links` for a device that is in. A bare
  86-character text is `400 link_unsigned`; any other half that does not verify is
  `400 link_invalid`. A member key has one link and a registered key has one: a registered key
  linked to another device that is in is `409 link_taken`, a link to a key that is out gives way.
- **What a list adds to a placement** (S2): an `invite` has `uses` 1 (`uses_one`) and makes the
  service's own invite of that key, ending at its `exp` (`exp_too_late` past fifteen minutes, or
  past the end of an invite of that key and kind made first, which it takes as it is); a key an
  invite or a device had is `409 invite_key_used`, a sixth open invite `409 invites_full`, an auto
  invite past the day's one-press adds `429 pc_add_cap`. A `remove` that ends a device signs out
  the sign-in whose registered key is linked to it (or that registered the member key itself) and
  marks that key removed; one that ends an invite revokes its unused service invite. A registered
  key that is itself entry 0's or a carried member key is its own link until it hands over (a link
  the table holds for either key comes first): it stands up the snapshot's chain, its sign-in may
  store wraps, and a removal of it signs that sign-in out (any registered key that is the ended key
  is, unless that sign-in is linked to a device the batch leaves in). A registered key that is
  itself a key of the list that is in is taken wherever a link is (`link_taken` on `POST links`;
  a claim's or a hand-over's link
  to it is not written, and the entry is placed all the same). A later
  hand-over (one `device` entry that rotates its signer, signed by the key the calling sign-in
  registered, where that signer is a device carried in) needs no claim, is outside the budget and
  may carry `link` (any other batch with a `link` is `400 invalid_request` after its second lock);
  any other such entry needs its claim.
- **Wraps with no entry** (`PUT wraps`, `/v2/pc/list/wraps/put`) are stored for the current epoch
  and its wrap keys only, never over one that stands (`stored` counts the new ones): from a
  sign-in that stands for a device the list lets in now (`403 not_linked` otherwise), or a PC in
  the list.
- **The birth** (`POST /v2/lists` with `entries`, Part F's F10b as the service built it): entry 0
  as D1 reads it, then `409 list_exists` with the list before anything of the run (a birth sent
  again gets its own list back), then `carried_not_open` at index 1 for an account that is not on
  the migrate switch, then `first_signer` for an entry 0 not signed by the key the calling sign-in
  registered, then `403 not_carried` at index 0 for a first signer Step 2 does not let in today.
  The run is read in order, each entry's shape before the library's verdict: 0 to 64
  `carried`, one `device` that rotates entry 0's signer, one `epoch`, nothing after
  (`birth_shape` at the first entry out of place, or one past the end for a run that stops short).
  Each `carried` is a key a live, unfrozen own sign-in registered that Step 2 lets in today, or a
  PC of the account no device code listed (`403 not_carried`). The writer, entry 0's signer and
  every carried key and PC are read again in the write. All placed or none; wraps for epoch 1. An
  `index` is the entry's place in the log: entry 0 is 0.
- **For an account that has a list** (its list, whatever the switch says): the snapshot also lets in
  at once a registered key linked to a device another member let in, while a member up the chain
  of who let it in passes Step 2's rules; a PC redeems only an invite the list holds as open
  (`409 invite_not_in_list`); and a PC's take of a one-press admission is `409 list_add`.
- **A PC with no standing** (neither listed by the account nor a row in the list) gets `404` from
  the placing route before its batch is read: it learns nothing of the list there.
- **Listing a new PC** (`PUT /v1/pcs/{server_id}`) in an account that has a list takes an own
  sign-in made in the last ten minutes, or its key proof with the purpose `list`, whatever Step 2
  and `listProofRequired` say: that listing is what the `pc` lock counts.
- **Limits** are in `listLimits`, which a test may lower to reach `list_full`, `entry_budget` or a
  PC's calls a minute.
- `accountList(account)` gives what the service holds, no lie applied: the list id, every entry's
  text, the head, the service's own state of the list, every stored wrap, the claims and posts
  that still lock, and the links.

### Making the service lie

A member must come to no harm from anything the service says, so the fake lies when a test asks
it to: `tamperList(list, lie)` adds a lie and `untamperList(list)` ends them all. Nothing lies by
default, and a lie changes only what is served or refused: the log the fake holds stays as placed.
`reader` (`{ token }` for a device's sign-in, `{ server_id }` for a PC) lies to that reader alone,
and to everyone when it is left out.

| lie | what is served | what a test proves with it |
|---|---|---|
| `inject` | these texts after the log, the head moved to the last | an entry of a key that is no member is passed over and lets nobody in |
| `wraps` | these wraps in place of the stored ones | a wrap of a key of the service's own is refused against `epoch_opens` |
| `withholdAfter` | the log up to that seq, its head with it | a removal that never arrives (one reader), or an old prefix replayed (every reader): a member never goes back |
| `head` | that head in every answer | a head the log does not reach shows the tail withheld; an old head changes nothing |
| `fork` | these texts in place of the log from the first one's seq on | two readers each hold a valid history at the same seq, which only comparing heads parts |
| `pages` | pages that end after these seqs | a reader joins the same log wherever the pages are cut |
| `answerList` | another list under this list's id | its entry 0 is not the list the member pinned (`list_mismatch`) |
| `listId` | that id as the account's list, the log unchanged | the id is a hint: a member pins it only from another member |
| `flipEntry`, `flipWrap` | one byte flipped in that entry's body or that wrap | the entry no longer holds; the wrap does not open |
| `headMoved` | `409 head_moved` for every placement | a writer stops after its own bound and says so |
| `dropWraps` | a placed batch's entries without its wraps | a member with no wrap sees no names and is let in all the same |
| `rebuilding` | `503 list_rebuilding` (retry-after 1) to placements, a PC's reads whose only right is its row in the list, the links and wrap uploads, a redeem and the snapshot | the client sends the same request again (a PC with a new challenge and proof: each call spends one); a PC keeps the devices it read last |
| `stopped` | `503 list_stopped` to the same calls but the snapshot, which answers `200` by Step 2's rules and adds nobody for the list | the client shows that the service cannot change the list |

`withholdAfter` on a list that a birth made serves a part of that birth: entry 0 and some
`carried`, or everything but the `epoch`. Two lies are about an account rather than a list:
`tamperAccount(account, lie)` sets them and `untamperAccount(account)` ends them.

| lie | what happens | what a test proves with it |
|---|---|---|
| `withholdAnswer` | a genesis, a birth or a placement is stored and `fetch` rejects as on a lost connection | the client asks again and learns from `list_exists`, or `placed: 0`, what was stored |
| `eligibleAgain` | these registered keys are listed eligible in the snapshot, removed or not | a PC from before the list trusts it; one that follows the list does not |

`forgeBirth(account, { keys?, endpoints? })` stores a birth of the fake's own as the account's list:
a genesis by a key of its own, a `carried` for each key (by default every registered key that is
not removed) and endpoint, a hand-over to another key of its own and its `epoch`. A device or PC
that holds the account's list to who started it refuses it.
