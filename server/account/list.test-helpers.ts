/**
 * A test account's signed list at the fake account service: members that sign real entries and place them through
 * the service's own routes, so a PC under test reads what a real account would hold.
 */
import { entryFromText, entryHash, entryToText, signEntry, type EntryBody } from "../../shared/account-list-entry.ts";
import { epochKeyCommitment, generateStoredEncryptionKey, LIST_EPOCH_LINK_BYTES, newEpochKey, nextEpoch, readStoredEncryptionKey, sealFields, wrapEpochKey, wrapToText, type EpochKey, type MemberEncryptionKey } from "../../shared/account-list-seal.ts";
import { newInvite } from "../../shared/account-list-join.ts";
import { cardBinding, kindBody, namesFields, signCard, type ListKind, type ListNames, type ListRole } from "../../shared/account-list.ts";
import type { ListPlace } from "../../shared/account-list-signers.ts";
import { exportAccountKey } from "../../shared/account-records.ts";
import type { FakeAccountService } from "../../shared/account-service-fake.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";

const SERVICE = "https://account.test";

/** A device of the test account: its member key, which signs, and its encryption key, which opens the wraps made to it. */
export interface ListMember {
  readonly key: string;
  readonly keys: CryptoKeyPair;
  readonly enc: string;
  readonly encKey: MemberEncryptionKey;
}

export async function listMember(keys?: CryptoKeyPair): Promise<ListMember> {
  const pair = keys ?? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const encKey = await readStoredEncryptionKey((await generateStoredEncryptionKey()).secret);
  return { key: await exportAccountKey(pair.publicKey), keys: pair, enc: encKey.key, encKey };
}

/** The device claims its member key at the account service with a fresh sign-in of its own: the second lock of the entry that lets it in. */
export async function claimKey(service: FakeAccountService, account: string, list: string, device: ListMember): Promise<string> {
  const card = await memberCard(device, list);
  const claimed = await service.fetch(new Request(`${SERVICE}/v2/lists/${list}/claims`, { method: "POST",
    headers: { authorization: `Bearer ${service.issueToken(account, { twoStep: true })}` }, body: JSON.stringify({ key: device.key, enc: device.enc, card }) }));
  if (!claimed.ok) throw new Error(`The claim was not taken: ${claimed.status} ${await claimed.text()}`);
  return card;
}

/** A device's card for `list`, as the entry that lets it in carries it. */
export function memberCard(member: ListMember, list: string): Promise<string> {
  return signCard({ key: member.key, enc: member.enc, list, endpoint: null, invite: null }, member.keys.privateKey);
}

/** The test account's list as its members write it: what they sign follows the last entry they placed or made. */
export class TestList {
  private constructor(readonly service: FakeAccountService, readonly account: string, readonly id: string, readonly first: ListMember, private head: ListPlace, private readonly token: string, private clock: () => number,
    private current: EpochKey) {}

  /** The key to the names of the current epoch (0 until `nextEpoch`), which every member the tests add is given a wrap of. */
  get epochKey(): EpochKey { return this.current; }

  /**
   * The first member opens the next epoch (as after a removal), with the link to the key before; nothing is wrapped
   * to anybody here. `link: "broken"`: the entry carries a link that opens nothing, as a member that wrote a wrong one.
   */
  async nextEpoch(link: "good" | "broken" = "good"): Promise<void> {
    const next = await nextEpoch({ list: this.id, current: this.current, members: [] });
    const written = link === "good" ? next.link : Uint8Array.of(next.link[0]!, ...crypto.getRandomValues(new Uint8Array(LIST_EPOCH_LINK_BYTES - 1)));
    await this.placeTexts([await this.sign({ kind: "epoch", epoch: this.current.epoch, opens: next.commitment, link: written })]);
    this.current = next.epoch;
  }

  /** A wrap of the names' key for the encryption key `enc`, as a placement carries it. */
  async wrapFor(enc: string): Promise<{ epoch: number; member: string; wrap: string }> {
    const wrap = await wrapEpochKey({ list: this.id, epoch: this.epochKey, member: enc });
    if (wrap === null) throw new Error("That is no encryption key");
    return { epoch: this.epochKey.epoch, member: enc, wrap: wrapToText(wrap) };
  }

  /** Takes the head the account service holds: after an entry somebody else placed (the PC under test), the members sign after it. */
  refresh(): void {
    const held = this.service.accountList(this.account);
    if (held !== null) this.head = held.head;
  }

  /** A new list for `account`: its first device makes entry 0 and the account service takes it. */
  static async start(service: FakeAccountService, account: string, first?: ListMember, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<TestList> {
    const member = first ?? await listMember();
    const token = service.issueToken(account, { twoStep: true });
    const epochKey = newEpochKey(0);
    const body = kindBody({ issued_at: now(), list: "", prev: "", seq: 0, signer: member.key },
      { kind: "genesis", account, enc: member.enc, opens: epochKeyCommitment({ list: "", epoch: epochKey }), sealed: null });
    const text = entryToText(await signEntry(body, member.keys.privateKey));
    const answer = await service.fetch(new Request(`${SERVICE}/v2/lists`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ entry: text }) }));
    if (answer.status !== 201) throw new Error(`The genesis was not taken: ${answer.status} ${await answer.text()}`);
    const list = (await answer.json() as { list: string }).list;
    return new TestList(service, account, list, member, { seq: 0, hash: list }, token, now, epochKey);
  }

  get place(): ListPlace { return this.head; }

  /**
   * An entry of `kind` signed by `signer`: its text. Nothing is placed. Without `after` it follows the last entry this
   * list made, and is the last one from then on; with `after` it follows that place and the list's own head stays, so a
   * test can sign beside the log (an entry the service only shows, another history).
   */
  async sign(kind: ListKind, signer: ListMember = this.first, after?: ListPlace, issuedAt?: number): Promise<string> {
    const place = after ?? this.head;
    const body = kindBody({ issued_at: issuedAt ?? this.clock(), list: this.id, prev: place.hash, seq: place.seq + 1, signer: signer.key }, kind);
    const text = entryToText(await signEntry(body, signer.keys.privateKey));
    if (after === undefined) this.head = { seq: place.seq + 1, hash: entryHash(entryFromText(text).body) };
    return text;
  }

  /**
   * An entry of a kind this build does not know, as a member with a newer Ovis writes one after the last entry: a
   * reader of this build is behind from it on. Nothing is placed (the fake is of this build too, and places none): a
   * test has the service show it (tamperList `inject`). `after`: the entry it follows, the last one by default.
   */
  async signLater(signer: ListMember = this.first, after: ListPlace = this.head): Promise<string> {
    const place = after;
    const body = { issued_at: this.clock(), list: this.id, prev: place.hash, seq: place.seq + 1, signer: signer.key, own: [], kind: "later_kind", v: 2 } as unknown as EntryBody;
    return entryToText(await signEntry(body, signer.keys.privateKey));
  }

  /**
   * Another history from entry 0, which is a fork to whoever is shown it: the first device lets in a device nobody
   * saw, and that device signs on it. (The first entry alone would be what a member signed and left behind when
   * another entry got its place, which raises no alarm.) Nothing is placed, and the list's own head stays.
   */
  async forkFromStart(): Promise<{ readonly texts: readonly [string, string]; readonly device: ListMember }> {
    const device = await listMember();
    const first = await this.sign({ kind: "device", key: device.key, power: "full", role: "drive", until: null, enc: device.enc, card: await memberCard(device, this.id), sealed: null, rotates: false },
      this.first, { seq: 0, hash: this.id });
    const lived = await this.sign({ kind: "remove", ends: device.key }, device, { seq: 1, hash: entryHash(entryFromText(first).body) });
    return { texts: [first, lived], device };
  }

  /** Places texts at the account service as one batch, from a sign-in of the account. */
  async placeTexts(texts: readonly string[], wraps: readonly { epoch: number; member: string; wrap: string }[] = []): Promise<void> {
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/entries`, { method: "POST", headers: { authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ entries: texts, ...(wraps.length > 0 ? { wraps } : {}) }) }));
    if (!answer.ok) throw new Error(`The entries were not placed: ${answer.status} ${await answer.text()}`);
  }

  /**
   * A member lets a device in: the device claims its key with a sign-in of its own (the second lock), the member signs and
   * places. `names`: sealed into the entry under the current epoch's key, as a member that holds it seals a device's name.
   */
  async addDevice(device: ListMember, options: { role?: ListRole; until?: number | null; by?: ListMember; power?: "full" | "bound"; names?: ListNames } = {}): Promise<string> {
    const card = await claimKey(this.service, this.account, this.id, device);
    const sealed = options.names === undefined ? null : { epoch: this.epochKey.epoch, bytes: await sealFields({ place: { list: this.id, seq: this.head.seq + 1 }, epoch: this.epochKey,
      commitment: epochKeyCommitment({ list: this.id, epoch: this.epochKey }), fields: namesFields(options.names) }) };
    const text = await this.sign({ kind: "device", key: device.key, power: options.power ?? "full", role: options.role ?? "drive", until: options.until ?? null, enc: device.enc, card, sealed, rotates: false }, options.by);
    await this.placeTexts([text]);
    return text;
  }

  /** A member adds the PC at `endpoint` from the keys and card that PC posted itself (the second lock). */
  async addPostedPc(endpoint: string, by?: ListMember): Promise<string> {
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts`, { headers: { authorization: `Bearer ${this.token}` } }));
    const posts = (await answer.json() as { posts: { endpoint: string; key: string; enc: string; card: string }[] }).posts;
    const post = posts.find((candidate) => candidate.endpoint === endpoint);
    if (!post) throw new Error("The PC posted no keys");
    const text = await this.sign({ kind: "pc", key: post.key, endpoint, enc: post.enc, card: post.card, sealed: null }, by);
    // with the key to the names, as a member that adds a PC gives it
    await this.placeTexts([text], [await this.wrapFor(post.enc)]);
    return text;
  }

  /**
   * The adder's side of the number it compares with a PC that posted (the account service only carries it): `commit`
   * opens the attempt with a commitment to a fresh nonce, `reveal` takes the PC's nonce and gives the adder's away, and
   * answers the six digits the adder's screen shows; null while the PC has not answered.
   */
  async compare(endpoint: string, adder: ListMember = this.first): Promise<{ readonly commit: () => Promise<void>; readonly reveal: () => Promise<string | null> }> {
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts`, { headers: { authorization: `Bearer ${this.token}` } }));
    const post = (await answer.json() as { posts: { endpoint: string; key: string; enc: string }[] }).posts.find((candidate) => candidate.endpoint === endpoint);
    if (!post) throw new Error("The PC posted no keys");
    const binding = cardBinding({ key: post.key, enc: post.enc, list: this.id, endpoint, invite: null });
    const nonce = randomPairNonce();
    const commitment = toBase64Url(pairCommitment(binding, adder.key, nonce));
    const send = async (reveal?: string): Promise<{ nonce: string | null } | null> => {
      const sent = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts/${endpoint}/attempt`, { method: "POST", headers: { authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ key: post.key, adder: adder.key, commitment, ...(reveal === undefined ? {} : { reveal }) }) }));
      if (sent.status === 409) return null;
      if (!sent.ok) throw new Error(`The attempt was not taken: ${sent.status} ${await sent.text()}`);
      return (await sent.json() as { attempt: { nonce: string | null } }).attempt;
    };
    return {
      commit: async () => { if (await send() === null) throw new Error("The attempt was not opened"); },
      reveal: async () => {
        const open = await send(toBase64Url(nonce));
        return open === null || open.nonce === null ? null : pairDigits(binding, adder.key, nonce, fromBase64Url(open.nonce));
      },
    };
  }

  /**
   * A member makes an invite for a PC: its key at the account service (POST /v1/pc-invites), the `invite` entry in the
   * list with the names' key wrapped to it, and the line that carries its private key, as a PC is handed it.
   */
  async invite(options: { auto: boolean; uses?: number; by?: ListMember }): Promise<{ readonly key: string; readonly line: string }> {
    const made = await newInvite(SERVICE, this.account, this.id);
    const taken = await this.service.fetch(new Request(`${SERVICE}/v1/pc-invites`, { method: "POST", headers: { authorization: `Bearer ${this.token}` }, body: JSON.stringify({ invite_key: made.key, auto: options.auto }) }));
    if (!taken.ok) throw new Error(`The invite was not taken: ${taken.status} ${await taken.text()}`);
    const text = await this.sign({ kind: "invite", key: made.key, exp: this.clock() + 15 * 60, uses: options.uses ?? 1, auto: options.auto, sealed: null }, options.by);
    await this.placeTexts([text], options.auto ? [await this.wrapFor(made.key)] : []);
    return made;
  }

  /** A member puts a key out. */
  async remove(key: string, by?: ListMember): Promise<string> {
    const text = await this.sign({ kind: "remove", ends: key }, by);
    await this.placeTexts([text]);
    return text;
  }
}
