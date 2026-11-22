# The signed list: an entry

No released part of Ovis reads or writes this format yet: the account as it works today signs its
records one by one, with no chain ([Linking devices with an account](account.md#rules)).

An owner's devices and machines share one signed list. Every member keeps a copy and checks every
entry by itself; the account service stores entries and must never be able to write one that
members accept. This page says how one entry is written, signed, hashed and chained, and how a
member checks it. Who may sign an entry (the signers) is checked on top of this and is not part of
this page. The code is [`shared/account-list-entry.ts`](../shared/account-list-entry.ts); the
vectors are in [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope).

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
in `v` the level that first defined it in that form. Level 1 is five kinds, each written with `v`
1: `genesis`, `device`, `invite`, `join` and `remove`. What each kind carries and means is not part
of this page.

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
