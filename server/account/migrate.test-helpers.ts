/**
 * An account that was in use moving onto its signed list, for a PC under test (docs/account-list.md, "An account that
 * was in use"): devices that are signed in with a sign-in key and hold an account key, and the list the first of them
 * makes in one request, placed whole at the account service fake (F10b), or made up by a service that lies.
 */
import { epochKeyCommitment, generateStoredEncryptionKey, newEpochKey, nextEpoch, readStoredEncryptionKey, sealFields, wrapEpochKey, wrapToText, type EpochKey } from "../../shared/account-list-seal.ts";
import { cardBinding, namesFields, signCard, signListEntry, type ListKind, type ListSigner, type ListState } from "../../shared/account-list.ts";
import type { ListPlace } from "../../shared/account-list-signers.ts";
import { signMigration, signNaming, signRotation, signVouch, type MigratingDevice, type MigrationPlan, type MigrationSeals, type SignedNaming, type SignedVouch } from "../../shared/account-list-migrate.ts";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import type { FakeAccountService } from "../../shared/account-service-fake.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { bounded, type relayConnection } from "../relay/test-helpers.ts";
import { MIGRATE_TIME_SCALE_ENV } from "./migrate-time.ts";

const SERVICE = "https://account.test";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** A device of the account: its sign-in key, which the PCs let in today, and its account key, which the list goes on with. */
export interface MigratingPhone extends MigratingDevice {
  readonly label: string;
  readonly signInPair: CryptoKeyPair;
  readonly memberPair: CryptoKeyPair;
}

export async function migratingDevice(label: string): Promise<MigratingPhone> {
  const signInPair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  const memberPair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  const enc = (await readStoredEncryptionKey((await generateStoredEncryptionKey()).secret)).key;
  return {
    label, signInPair, memberPair, enc, names: { label, os: "ios" },
    signIn: { key: await exportAccountKey(signInPair.publicKey), privateKey: signInPair.privateKey },
    member: { key: await exportAccountKey(memberPair.publicKey), privateKey: memberPair.privateKey },
  };
}

/** The same device after it signed in again: a new sign-in key, the same account key. */
export async function signedInAgain(device: MigratingPhone): Promise<MigratingPhone> {
  const signInPair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { ...device, signInPair, signIn: { key: await exportAccountKey(signInPair.publicKey), privateKey: signInPair.privateKey } };
}

/** What a relay sign-in with one of a device's keys needs: the pair, and the account id the PC knows that key by. */
export function asSignIn(serverId: string, device: MigratingPhone, which: "signIn" | "member" = "signIn") {
  const pair = which === "signIn" ? device.signInPair : device.memberPair;
  const key = which === "signIn" ? device.signIn.key : device.member.key;
  return { keys: pair, publicKey: key, id: accountDeviceId(serverId, key) };
}

/**
 * Makes a server with the staging factor `scale` in force, or none, whatever the runner's own environment holds: the
 * server reads it once, when it is made.
 */
export function scaled<T>(scale: number | undefined, make: () => T): T {
  const was = process.env[MIGRATE_TIME_SCALE_ENV];
  const restore = () => { if (was === undefined) delete process.env[MIGRATE_TIME_SCALE_ENV]; else process.env[MIGRATE_TIME_SCALE_ENV] = was; };
  if (scale === undefined) delete process.env[MIGRATE_TIME_SCALE_ENV]; else process.env[MIGRATE_TIME_SCALE_ENV] = String(scale);
  let made: T;
  try { made = make(); } catch (error) { restore(); throw error; }
  // a server made after an await is made once that promise settles: the factor stands until then
  if (made instanceof Promise) return made.finally(restore) as T;
  restore();
  return made;
}

/**
 * What a sign-in comes to: the role the PC lets the device in as, or null for a refusal the PC said (a SESSION_ERROR).
 * A sign-in that broke in any other way (a handshake that timed out, a transport that closed) fails the test.
 */
export async function signInOutcome(link: Awaited<ReturnType<typeof relayConnection>>, device: ReturnType<typeof asSignIn>): Promise<"drive" | "watch" | null> {
  try { return (await link.auth(device)).role; } catch (error) {
    const said = await bounded(link.serverError, 2000).catch(() => null);
    if (said === null) throw error;
    return null;
  }
}

/** The first device's side of sealing, with real epoch keys: the keys it made, and the wraps of the next epoch the birth carries. */
function sealer(): MigrationSeals & { readonly keys: ReadonlyMap<number, EpochKey>; readonly wraps: { epoch: number; member: string; wrap: string }[] } {
  const keys = new Map<number, EpochKey>();
  const wraps: { epoch: number; member: string; wrap: string }[] = [];
  const current = (epoch: number): EpochKey => {
    const key = keys.get(epoch);
    if (key === undefined) throw new Error(`no key of epoch ${epoch}`);
    return key;
  };
  return {
    keys, wraps,
    async genesis(given) {
      const epoch = newEpochKey(0);
      keys.set(0, epoch);
      const opens = epochKeyCommitment({ list: "", epoch });
      return { opens, sealed: given === null ? null : { epoch: 0, bytes: await sealFields({ place: { list: "", seq: 0 }, epoch, commitment: opens, fields: namesFields(given) }) } };
    },
    async names(place, epoch, given) {
      return { epoch: epoch.epoch, bytes: await sealFields({ place, epoch: current(epoch.epoch), commitment: epoch.opens, fields: namesFields(given) }) };
    },
    async next(list, epoch, members) {
      const made = await nextEpoch({ list, current: current(epoch), members });
      keys.set(made.epoch.epoch, made.epoch);
      wraps.push(...made.wraps.map(({ member, wrap }) => ({ epoch: made.epoch.epoch, member, wrap: wrapToText(wrap) })));
      return { opens: made.commitment, link: made.link };
    },
  };
}

/** The plan of a birth: these devices' sign-in keys carried in, devices first, then these PCs as endpoints with no key. */
export function birthPlan(devices: readonly MigratingPhone[], pcs: readonly string[] = []): Pick<MigrationPlan, "devices" | "pcs"> {
  return { devices: devices.map((one) => ({ key: one.signIn.key, names: one.names })), pcs: pcs.map((endpoint) => ({ endpoint, names: null })) };
}

/** The sign-ins of the account's devices at the fake account service, by each key of the device: what places an entry the device signed. */
const signIns = new WeakMap<FakeAccountService, Map<string, string>>();

/**
 * The device signs in to the account at the account service and registers its sign-in key (POST /v1/devices): the key
 * the account's PCs let it in by, and the one its entries are placed under. A device that signs in again is told so.
 */
export function signIn(service: FakeAccountService, account: string, device: MigratingPhone): string {
  const token = service.issueToken(account, { twoStep: true });
  service.registerSessionKey(token, device.signIn.key, device.label);
  const tokens = signIns.get(service) ?? new Map<string, string>();
  signIns.set(service, tokens);
  tokens.set(device.signIn.key, token);
  tokens.set(device.member.key, token);
  return token;
}

function tokenOf(service: FakeAccountService, key: string): string {
  const token = signIns.get(service)?.get(key);
  if (token === undefined) throw new Error("That key is no signed-in device's");
  return token;
}

/** Where an entry a member signs goes: placed at the account service, or only held by the test (a member hands it over itself, or the service shows it as a lie). */
export type Placing = "place" | "hold";

/** A list born by migration, as the account service shows it: every entry a member signed, and what a member holds after the last. */
export class MigratedList {
  private constructor(private readonly service: FakeAccountService, readonly account: string, readonly id: string, readonly texts: string[], private held: ListState,
    private readonly clock: () => number, private readonly epochs: ReadonlyMap<number, EpochKey>, private placed: number) {}

  /** The first device's one request (F10b), placed whole at the account service by its own sign-in. */
  static async born(service: FakeAccountService, account: string, first: MigratingPhone, plan: Pick<MigrationPlan, "devices" | "pcs">, clock: () => number): Promise<MigratedList> {
    const seals = sealer();
    const made = await signMigration(account, plan, first, clock(), seals);
    const texts = made.entries.map((entry) => entry.text);
    const link = await signVouch(made.state, first);
    const answer = await service.fetch(new Request(`${SERVICE}/v2/lists`, { method: "POST", headers: { authorization: `Bearer ${tokenOf(service, first.signIn.key)}` },
      body: JSON.stringify({ entry: texts[0], entries: texts.slice(1), wraps: seals.wraps, ...(link === null ? {} : { link: link.link }) }) }));
    if (answer.status !== 201) throw new Error(`The birth was not taken: ${answer.status} ${await answer.text()}`);
    return new MigratedList(service, account, made.list, texts, made.state, clock, seals.keys, texts.length);
  }

  /**
   * A birth the account service made up and shows, which it would never take from a device: entry 0 placed as an
   * ordinary genesis, the rest of the run served after it (tamperList `inject`), as a service that lies shows it.
   */
  static async forged(service: FakeAccountService, account: string, first: MigratingPhone, plan: Pick<MigrationPlan, "devices" | "pcs">, clock: () => number): Promise<MigratedList> {
    const seals = sealer();
    const made = await signMigration(account, plan, first, clock(), seals);
    const texts = made.entries.map((entry) => entry.text);
    const answer = await service.fetch(new Request(`${SERVICE}/v2/lists`, { method: "POST", headers: { authorization: `Bearer ${service.issueToken(account, { twoStep: true })}` }, body: JSON.stringify({ entry: texts[0] }) }));
    if (answer.status !== 201) throw new Error(`The genesis was not taken: ${answer.status} ${await answer.text()}`);
    const list = new MigratedList(service, account, made.list, texts, made.state, clock, seals.keys, 1);
    list.serve();
    return list;
  }

  get state(): ListState { return this.held; }
  get head(): ListPlace { return { seq: this.held.footing.seq, hash: this.held.footing.hash }; }

  /**
   * An entry of `kind` signed by `signer` after the last one: placed at the account service by the sign-in of the device
   * that signer is, with a wrap of the names' key for each encryption key it adds; or only held (`hold`), for a member to
   * hand over itself or the service to show as a lie (serve).
   */
  async append(kind: ListKind, signer: ListSigner, how: Placing = "place"): Promise<string> {
    const written = await signListEntry(this.held, kind, signer, this.clock());
    this.texts.push(written.text);
    this.held = written.state;
    if (how === "place") await this.place([written.text], kind.kind === "pc" || kind.kind === "device" ? [kind.enc] : [], tokenOf(this.service, signer.key));
    return written.text;
  }

  /** A carried device hands its place to its account key, as it does once it follows the list: placed by its own sign-in, claim-free (F10b). */
  async handOver(device: MigratingPhone, how: Placing = "place"): Promise<string> {
    const written = await signRotation(this.held, device, this.clock(), null);
    this.texts.push(written.text);
    this.held = written.state;
    if (how === "place") await this.place([written.text], [device.enc], tokenOf(this.service, device.signIn.key));
    return written.text;
  }

  /** A member adds the PC at `endpoint` from the keys that PC posted (the second lock), with its card as posted. */
  async addPostedPc(endpoint: string, by: ListSigner, how: Placing = "place"): Promise<string> {
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts`, { headers: { authorization: `Bearer ${this.service.issueToken(this.account, { twoStep: true })}` } }));
    const post = (await answer.json() as { posts: { endpoint: string; key: string; enc: string; card: string }[] }).posts.find((one) => one.endpoint === endpoint);
    if (!post) throw new Error("The PC posted no keys");
    return await this.append({ kind: "pc", key: post.key, endpoint, enc: post.enc, card: post.card, sealed: null }, by, how);
  }

  /** A new device claims its member key with a sign-in of its own (the second lock of the entry that lets it in): its card for this list. */
  async claim(device: MigratingPhone): Promise<string> {
    const card = await signCard({ key: device.member.key, enc: device.enc, list: this.id, endpoint: null, invite: null }, device.member.privateKey);
    const claimed = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/claims`, { method: "POST",
      headers: { authorization: `Bearer ${this.service.issueToken(this.account, { twoStep: true })}` }, body: JSON.stringify({ key: device.member.key, enc: device.enc, card }) }));
    if (!claimed.ok) throw new Error(`The claim was not taken: ${claimed.status} ${await claimed.text()}`);
    return card;
  }

  /** The device links its present sign-in key to the key the list holds it by, at the account service (D11.2), as an app does after a new sign-in. */
  async link(device: MigratingPhone): Promise<void> {
    const vouch = await signVouch(this.held, device);
    if (vouch === null) throw new Error("That device links nothing");
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/links`, { method: "POST", headers: { authorization: `Bearer ${tokenOf(this.service, device.signIn.key)}` },
      body: JSON.stringify({ key: device.member.key, link: vouch.link }) }));
    if (!answer.ok) throw new Error(`The link was not taken: ${answer.status} ${await answer.text()}`);
  }

  /** A member puts a key out. */
  remove(key: string, by: ListSigner, how: Placing = "place"): Promise<string> { return this.append({ kind: "remove", ends: key }, by, how); }

  private async place(texts: readonly string[], encs: readonly string[], token: string): Promise<void> {
    const epoch = this.epochs.get(this.held.epoch);
    const wraps = [];
    for (const member of encs) {
      const wrap = epoch === undefined ? null : await wrapEpochKey({ list: this.id, epoch, member });
      if (wrap !== null && epoch !== undefined) wraps.push({ epoch: epoch.epoch, member, wrap: wrapToText(wrap) });
    }
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/entries`, { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ entries: texts, ...(wraps.length > 0 ? { wraps } : {}) }) }));
    if (!answer.ok) throw new Error(`The entries were not placed: ${answer.status} ${await answer.text()}`);
    this.placed = this.texts.length;
  }

  /** A device names this list to the PC at `endpoint`, in a session signed in with `session`, by the key the list holds it by. */
  async naming(device: MigratingPhone, session: string, endpoint: string, which: "signIn" | "member" = "member"): Promise<SignedNaming> {
    const signed = await signNaming(this.held, { member: which === "member" ? device.member : device.signIn, session, endpoint });
    if (signed === null) throw new Error("That device names nothing");
    return signed;
  }

  /** The link of a device's present sign-in key to its account key, as it hands it to a PC. */
  async vouch(device: MigratingPhone): Promise<SignedVouch> {
    const signed = await signVouch(this.held, device);
    if (signed === null) throw new Error("That device vouches for nothing");
    return signed;
  }

  /**
   * The adder's side of the number it compares with a PC that posted its keys (B7; the account service only carries
   * it): `commit` opens the attempt, `reveal` takes the PC's nonce and answers the six digits the adder's screen shows,
   * null while the PC has not answered.
   */
  async compare(endpoint: string, adder: ListSigner): Promise<{ readonly commit: () => Promise<void>; readonly reveal: () => Promise<string | null> }> {
    const token = this.service.issueToken(this.account, { twoStep: true });
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts`, { headers: { authorization: `Bearer ${token}` } }));
    const post = (await answer.json() as { posts: { endpoint: string; key: string; enc: string }[] }).posts.find((candidate) => candidate.endpoint === endpoint);
    if (!post) throw new Error("The PC posted no keys");
    const binding = cardBinding({ key: post.key, enc: post.enc, list: this.id, endpoint, invite: null });
    const nonce = randomPairNonce();
    const commitment = toBase64Url(pairCommitment(binding, adder.key, nonce));
    const send = async (reveal?: string): Promise<{ nonce: string | null } | null> => {
      const sent = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts/${endpoint}/attempt`, { method: "POST", headers: { authorization: `Bearer ${token}` },
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

  /** The account service shows every entry the test holds: what it placed, and after it, served as if placed, what it did not. */
  serve(): void {
    this.service.untamperList(this.id);
    if (this.texts.length > this.placed) this.service.tamperList(this.id, { inject: this.texts.slice(this.placed) });
  }
}
