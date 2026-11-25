/**
 * The app's side of moving an account that was in use onto its signed list (docs/account-list.md, "An account that was
 * in use"; the rules are shared/account-list-migrate.ts): what this device hands the pure functions, and what it keeps
 * between the calls that make one move. The pure part takes no clock and no storage; everything here that reads either
 * says where from.
 *
 * - The PCs this device knows are its own record of them (seenPcs.ts), never the account service's directory alone,
 *   with what each PC answered IN THIS RUN of the app (PcAnswers, in memory only: an answer kept from an earlier run is
 *   none).
 * - Every time handed over is a duration: seconds by this device's clock between two of its own readings. In the QA
 *   twin build alone (QA_TWIN_APP) a person may turn the device's own waits down by a factor (migrationScale): the
 *   durations are multiplied, the pure constants never change, and a PC scales its own counters itself.
 * - The birth is signed once and kept before it is sent (KeptBirth), and sent as it is until the account service took it
 *   or refused it for good: a refusal that is final lets the device plan again, never sooner than an hour later, and
 *   without the key or the PC a `403 not_carried` named (MoveRefusal).
 */
import { heirOf, linkBytes, MIGRATION_RUNNING_SECONDS, MIGRATION_WITNESS_SECONDS, ownEvidence, type KnownPc, type LetIn, type MigrationSeals, type PcAnswer, type PcHow } from "../../../shared/account-list-migrate.ts";
import { isListHash, isListKeyEncoding } from "../../../shared/account-list-entry.ts";
import { namesFields, type ListNames, type ListState } from "../../../shared/account-list.ts";
import { epochKeyCommitment, LIST_WRAP_TEXT_LENGTH, newEpochKey, nextEpoch, sealFields, wrapToText, type EpochKey } from "../../../shared/account-list-seal.ts";
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import type { AccountList, AccountListView } from "./accountList.ts";
import type { AccountStore } from "./store.ts";
import type { PlacedWrap } from "./listAnswers.ts";
import { howOf, type SeenPcs } from "./seenPcs.ts";

/** The QA twin of the phone app: the one build in which a person may turn the waits of a move down. */
export const QA_TWIN_APP = "sh.ovis.app.previewqa";
/** Where the QA twin keeps the factor its own waits are turned down by: `localStorage[MIGRATION_QA_SCALE]`, a whole number from 1 to 86400. */
export const MIGRATION_QA_SCALE = "ovis-migrate-qa-scale";
/** The largest factor: a day of waiting then passes in a second. */
export const MIGRATION_QA_SCALE_MAX = 86400;

/**
 * By how much this device multiplies the durations it hands the move's pure functions: 1, unless this build is the QA
 * twin (`app`, the application id the native app says it is) and a person set the factor there. A released app, a
 * browser and the owner's preview app always wait the full time.
 */
export function migrationScale(app: string | null, set: string | null): number {
  if (app !== QA_TWIN_APP || set === null || !/^[1-9][0-9]{0,5}$/.test(set)) return 1;
  return Math.min(MIGRATION_QA_SCALE_MAX, Number(set));
}

/** The application id the phone app says it is (readAppId), for migrationScale; null in a browser, and until the app said. */
let appId: string | null = null;

/**
 * Asks the phone app which build it is (`HerdrShell.appId`): only the QA twin turns its waits down, and only the app
 * itself can say that it is that build. A browser, and an app that does not answer, stay at the full waits.
 */
export async function readAppId(native: { readonly has: (plugin: string, method: string) => boolean; readonly call: (plugin: string, method: string) => Promise<unknown> }): Promise<void> {
  appId = null;
  if (!native.has("HerdrShell", "appId")) return;
  try {
    const said = await native.call("HerdrShell", "appId");
    appId = isRecord(said) && typeof said.id === "string" ? said.id : null;
  } catch {
    appId = null;
  }
}

/** This page's factor (migrationScale): the QA twin's setting, read each time it is asked. */
export function pageScale(): number {
  let set: string | null = null;
  try { set = globalThis.localStorage?.getItem(MIGRATION_QA_SCALE) ?? null; } catch { set = null; }
  return migrationScale(appId, set);
}

/** The seconds from `from` to `to`, both by this device's clock, scaled; 0 for a clock that ran back. */
export function scaled(from: number, to: number, scale: number): number {
  return Math.max(0, to - from) * scale;
}

/** What the PCs of each account answered this device in this run of the app, by relay key: an answer, or null for a PC that cannot answer. Memory only. */
export interface PcAnswers {
  get(account: string, endpoint: string): PcAnswer | null | undefined;
  set(account: string, endpoint: string, answer: PcAnswer | null): void;
  /** How many answers were heard for the account, so a caller sees that something new came. */
  count(account: string): number;
}

export function pcAnswers(): PcAnswers {
  const heard = new Map<string, Map<string, PcAnswer | null>>();
  return {
    get: (account, endpoint) => heard.get(account)?.get(endpoint),
    set(account, endpoint, answer) {
      const of = heard.get(account) ?? new Map<string, PcAnswer | null>();
      of.set(endpoint, answer);
      heard.set(account, of);
    },
    count: (account) => heard.get(account)?.size ?? 0,
  };
}

/** The answers of this page: every session it opens to a PC of the account adds to them. */
export const pageAnswers = pcAnswers();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSpan = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const ENDPOINT = /^[0-9a-f]{64}$/;

/**
 * A PC's answer to a device of its account (`GET /api/account/list/witness`, Part F's F13), read for its form; null for
 * anything out of it. A row that is no duration is dropped, as the pure functions would drop it.
 */
export function pcAnswerOf(body: unknown): PcAnswer | null {
  if (!isRecord(body) || typeof body.account !== "string" || !(body.pinned === null || (typeof body.pinned === "string" && isListHash(body.pinned)))) return null;
  if (!Array.isArray(body.admits) || !Array.isArray(body.removed) || body.admits.length > 4096 || body.removed.length > 4096) return null;
  const admits: LetIn[] = [];
  for (const row of body.admits as readonly unknown[]) {
    if (!isRecord(row) || typeof row.key !== "string" || !isListKeyEncoding(row.key) || !isSpan(row.wall) || !isSpan(row.ran)) continue;
    admits.push({ key: row.key, wall: row.wall, ran: row.ran, idle: isSpan(row.idle) ? row.idle : null });
  }
  const removed = (body.removed as readonly unknown[]).filter((key): key is string => typeof key === "string" && isListKeyEncoding(key));
  return { account: body.account, pinned: body.pinned, admits, removed };
}

/** What this device's record says it did for a PC, as the pure part reads it: an invite the line's key proved for that PC, and the person's tap, counts as `added` (rulings-plain-invite.md, 5). */
export function pcHowOf(row: SeenPcs["pcs"][string] | undefined): PcHow {
  const how = howOf(row);
  return how === "invited" ? "added" : how;
}

/**
 * The PCs this device knows by its own record, as the move hands them over (KnownPc): what it did itself for each, for
 * how long it has held sessions with that relay key (scaled), and what the PC answered in this run. `letIn`: the relay
 * keys the account service's directory lists as let in; a PC outside it is left out (the service would refuse to carry
 * it, `403 not_carried`), and null leaves none out. `names`: what the directory calls a PC, sealed with its entry.
 */
export function knownPcs(given: {
  readonly account: string; readonly record: SeenPcs; readonly letIn: ReadonlySet<string> | null; readonly answers: PcAnswers;
  readonly names: (endpoint: string) => ListNames | null; readonly now: number; readonly scale: number; readonly skip?: ReadonlySet<string>;
}): KnownPc[] {
  const pcs: KnownPc[] = [];
  for (const [endpoint, row] of Object.entries(given.record.pcs)) {
    if (!ENDPOINT.test(endpoint) || (given.letIn !== null && !given.letIn.has(endpoint)) || given.skip?.has(endpoint) === true) continue;
    pcs.push({
      endpoint, how: pcHowOf(row), known: row.since === undefined ? null : scaled(row.since, given.now, given.scale),
      says: given.answers.get(given.account, endpoint) ?? null, names: given.names(endpoint),
    });
  }
  return pcs;
}

/**
 * The relay keys of the PCs this device knows by its own record (ownEvidence) that a move asks: those that have not
 * answered in this run, and with `again` those that did too, whose answer is the reason it waits or refuses.
 */
export function pcsToAsk(given: { readonly account: string; readonly record: SeenPcs; readonly answers: PcAnswers; readonly now: number; readonly scale: number; readonly again?: boolean }): string[] {
  return knownPcs({ ...given, letIn: null, names: () => null }).filter((pc) => (pc.says === null || given.again === true) && ownEvidence(pc)).map((pc) => pc.endpoint);
}

/** The sealing of a birth (MigrationSeals), with the epoch keys it made and the wraps of the epoch the birth opens, for the device's own encryption key. */
export function birthSeals(): { readonly seals: MigrationSeals; readonly keys: Map<number, EpochKey>; wraps(): PlacedWrap[] } {
  const keys = new Map<number, EpochKey>();
  let wraps: PlacedWrap[] = [];
  const current = (epoch: number): EpochKey => {
    const key = keys.get(epoch);
    if (key === undefined) throw new RangeError(`No key of epoch ${epoch} was made for this birth`);
    return key;
  };
  return {
    keys, wraps: () => wraps,
    seals: {
      async genesis(names) {
        const epoch = newEpochKey(0);
        keys.set(0, epoch);
        // entry 0 has no list id yet: its place is the empty list id, and so is its commitment's
        const opens = epochKeyCommitment({ list: "", epoch });
        return { opens, sealed: names === null ? null : { epoch: 0, bytes: await sealFields({ place: { list: "", seq: 0 }, epoch, commitment: opens, fields: namesFields(names) }) } };
      },
      async names(place, epoch, names) {
        return { epoch: epoch.epoch, bytes: await sealFields({ place, epoch: current(epoch.epoch), commitment: epoch.opens, fields: namesFields(names) }) };
      },
      async next(list, epoch, members) {
        const made = await nextEpoch({ list, current: current(epoch), members });
        keys.set(made.epoch.epoch, made.epoch);
        wraps = made.wraps.map((wrap) => ({ epoch: made.epoch.epoch, member: wrap.member, wrap: wrapToText(wrap.wrap) }));
        return { opens: made.commitment, link: made.link };
      },
    },
  };
}

/**
 * The D11.2 link of a member key to the key a sign-in registered, signed by both: what a birth and a carried device's
 * hand-over carry to the account service (`link`), over linkBytes.
 */
export async function signLink(given: { readonly account: string; readonly list: string; readonly member: { readonly key: string; readonly privateKey: CryptoKey }; readonly device: { readonly key: string; readonly privateKey: CryptoKey } }): Promise<{ readonly member: string; readonly device: string }> {
  const bytes = linkBytes({ account: given.account, list: given.list, key: given.member.key, device: given.device.key });
  const by = async (key: CryptoKey): Promise<string> => toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(bytes))));
  return { member: await by(given.member.privateKey), device: await by(given.device.privateKey) };
}

const RECORD_VERSION = 1;

/**
 * A birth this device signed and has not seen placed (Part F, F2): the one request, kept before it is sent and sent as
 * it is until the account service took it (201, or `409 list_exists` naming this very list) or refused it for good.
 * `signIn` is the key that signed entry 0, the key this device's sign-in registered; `carried` names whom the run
 * carries in, for the notice after the pin; `skip` the keys and PCs earlier final refusals named, which it leaves out.
 */
export interface KeptBirth {
  readonly list: string;
  readonly signIn: string;
  readonly member: string;
  readonly entry: string;
  readonly entries: readonly string[];
  readonly wraps: readonly PlacedWrap[];
  readonly link: { readonly member: string; readonly device: string } | null;
  readonly carried: { readonly devices: readonly string[]; readonly pcs: readonly string[] };
  readonly skip: { readonly keys: readonly string[]; readonly endpoints: readonly string[] };
  readonly enc: string;
  /** When it was signed, in seconds by this device's clock. */
  readonly at: number;
}

/**
 * What a final refusal of a birth left: when it came (seconds, this device's clock), and the keys and PCs a `403
 * not_carried` named, this one's and every earlier one's, which the next plan leaves out.
 */
export interface MoveRefusal {
  readonly at: number;
  readonly keys: readonly string[];
  readonly endpoints: readonly string[];
}

/**
 * The account's one place for a birth on this device (the `birth` record), as its one text, so a tab writes it only
 * over what it read (ListStore.swap): a birth kept to send, or one let go, with the refusal that let it go, if any. A
 * refusal and the end of the birth it refused are so one write.
 */
export function birthText(birth: KeptBirth): string {
  return JSON.stringify({ v: RECORD_VERSION, ...birth });
}

export function retiredText(list: string, refusal: MoveRefusal | null): string {
  return JSON.stringify({ v: RECORD_VERSION, retired: list, refusal });
}

const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every((text) => typeof text === "string");
const parsed = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
};

/** A kept birth as its record holds it; null for none, one let go, or one out of form. */
export function readBirth(value: unknown): KeptBirth | null {
  const read = parsed(value);
  if (!isRecord(read) || read.v !== RECORD_VERSION || "retired" in read) return null;
  const { list, signIn, member, entry, entries, wraps, link, carried, skip, enc, at } = read;
  if (typeof list !== "string" || !isListHash(list) || typeof signIn !== "string" || typeof member !== "string" || typeof entry !== "string" || typeof enc !== "string" || !isSpan(at)) return null;
  if (!texts(entries) || entries.length < 2 || !Array.isArray(wraps) || !wraps.every((wrap) => isRecord(wrap) && isSpan(wrap.epoch) && typeof wrap.member === "string" && typeof wrap.wrap === "string" && wrap.wrap.length === LIST_WRAP_TEXT_LENGTH)) return null;
  if (!(link === null || (isRecord(link) && typeof link.member === "string" && typeof link.device === "string"))) return null;
  if (!isRecord(carried) || !texts(carried.devices) || !texts(carried.pcs) || !isRecord(skip) || !texts(skip.keys) || !texts(skip.endpoints)) return null;
  return {
    list, signIn, member, entry, entries, wraps: wraps as PlacedWrap[], link: link === null ? null : { member: (link as { member: string }).member, device: (link as { device: string }).device },
    carried: { devices: carried.devices, pcs: carried.pcs }, skip: { keys: skip.keys, endpoints: skip.endpoints }, enc, at,
  };
}

/** A birth let go, as its record holds it: its list id and the final refusal that let it go, null where none did; null for no such record. */
export function readRetired(value: unknown): { readonly list: string; readonly refusal: MoveRefusal | null } | null {
  const read = parsed(value);
  if (!isRecord(read) || read.v !== RECORD_VERSION || typeof read.retired !== "string" || !isListHash(read.retired)) return null;
  const refusal = read.refusal;
  if (refusal === null) return { list: read.retired, refusal: null };
  if (!isRecord(refusal) || !isSpan(refusal.at) || !texts(refusal.keys) || !texts(refusal.endpoints)) return null;
  return { list: read.retired, refusal: { at: refusal.at, keys: refusal.keys, endpoints: refusal.endpoints } };
}

/** The most a device asks the account service for a birth while it waits on a final refusal: once an hour. */
export const MOVE_AGAIN_SECONDS = 3600;

/** The seconds from `from` to `to` by this device's clock; none at all where the clock moved back. */
export const elapsed = (from: number, to: number): number => Math.max(0, to - from);

/**
 * What a `403 not_carried` at `index` is about, in the birth it refused: entry 0's signer (index 0), or the key or the PC
 * the `carried` entry at that place names. The run carries the devices first, then the PCs, in the plan's order, so
 * `index - 1` is the place in it.
 */
export function notCarriedAt(birth: Pick<KeptBirth, "signIn" | "carried">, index: number | null): { readonly key: string } | { readonly endpoint: string } | null {
  if (index === null) return null;
  if (index === 0) return { key: birth.signIn };
  const place = index - 1;
  const key = birth.carried.devices[place];
  if (key !== undefined) return { key };
  const endpoint = birth.carried.pcs[place - birth.carried.devices.length];
  return endpoint === undefined ? null : { endpoint };
}

/**
 * The one-time notice after a move (R-G, F1): who made the list, and every device and PC it carried in, each with "Not
 * me". Kept until the person has seen it; `seen` once they have.
 */
export interface MoveNotice {
  readonly list: string;
  /** The key that signed entry 0 (the first device's sign-in key), and the key it handed over to. */
  readonly first: string;
  readonly devices: readonly string[];
  readonly pcs: readonly string[];
  readonly seen: boolean;
}

/**
 * The notice as a person reads it: who made the list (this device, or the device that stands in its place now) and
 * every device and PC it carried in that is still in, each by the key that stands for it now (standsFor), with its
 * name where this device can open it. This device itself is not among them.
 */
export interface MoveNoticeView {
  readonly list: string;
  readonly first: { readonly self: boolean; readonly key: string | null; readonly name: ListNames | null };
  readonly devices: readonly { readonly key: string; readonly name: ListNames | null }[];
  readonly pcs: readonly { readonly endpoint: string; readonly name: ListNames | null }[];
  /** Devices the move carried in that this device put out again, by the key they were carried in by: it blocked them itself (Not me). */
  readonly removed: readonly { readonly key: string; readonly name: ListNames | null }[];
}

export function noticeRecord(notice: MoveNotice): unknown {
  return { v: RECORD_VERSION, ...notice };
}

export function readNotice(value: unknown): MoveNotice | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION || typeof value.list !== "string" || !isListHash(value.list) || typeof value.first !== "string"
    || !texts(value.devices) || !texts(value.pcs) || typeof value.seen !== "boolean") return null;
  return { list: value.list, first: value.first, devices: value.devices, pcs: value.pcs, seen: value.seen };
}

/**
 * A carried device's hand-over that it signed and has not seen placed: the one signature for the head it was signed on
 * (X5), sent again as it is while the device's own copy shows that head. `refused_at`: the account service refused it
 * for good then (seconds, this device's clock): another is signed only on a new head, or an hour later.
 */
export interface KeptHandOver {
  readonly list: string;
  readonly signIn: string;
  /** The account key it hands the place to, and that key's encryption key: a hand-over kept for others is never sent (C2). */
  readonly member: string;
  readonly enc: string;
  readonly on: { readonly seq: number; readonly hash: string };
  readonly entry: string;
  readonly link: { readonly member: string; readonly device: string };
  readonly refused_at: number | null;
}

export function handOverRecord(kept: KeptHandOver): unknown {
  return { v: RECORD_VERSION, ...kept };
}

export function readHandOver(value: unknown): KeptHandOver | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION) return null;
  const { list, signIn, member, enc, on, entry, link, refused_at } = value;
  if (typeof list !== "string" || !isListHash(list) || typeof signIn !== "string" || typeof member !== "string" || typeof enc !== "string" || typeof entry !== "string") return null;
  if (!isRecord(on) || !isSpan(on.seq) || typeof on.hash !== "string" || !isListHash(on.hash)) return null;
  if (!isRecord(link) || typeof link.member !== "string" || typeof link.device !== "string" || !(refused_at === null || isSpan(refused_at))) return null;
  return { list, signIn, member, enc, on: { seq: on.seq, hash: on.hash }, entry, link: { member: link.member, device: link.device }, refused_at };
}

/** A request on a session with a PC, as the app's channel makes it. */
export type PcFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * What the PC behind a session answers a device of its account (`GET /api/account/list/witness`): null for a PC that
 * cannot answer (an Ovis from before this release, one in no account) or did not, which a move counts as silent.
 */
export async function askWitness(fetch: PcFetch): Promise<PcAnswer | null> {
  const said = await witnessOf(fetch);
  return said === "final" ? null : said;
}

/**
 * `askWitness`, telling a PC that will never answer this session apart from one that did not answer now: "final" for a
 * PC with no such route (404, an Ovis from before this release) or one that takes this session for no account's (403
 * `account_required`); null for anything a later ask may change (503 `witness_unavailable` as the PC starts, its 429,
 * a carrier lost on the way, an answer out of form).
 */
export async function witnessOf(fetch: PcFetch): Promise<PcAnswer | "final" | null> {
  try {
    const answer = await fetch("/api/account/list/witness", { method: "GET", headers: { "x-herdr-machine": "1" } });
    if (answer.ok) return pcAnswerOf(await answer.json());
    if (answer.status === 404) return "final";
    if (answer.status !== 403) return null;
    const body: unknown = await answer.json().catch(() => null);
    return isRecord(body) && isRecord(body.error) && body.error.code === "account_required" ? "final" : null;
  } catch {
    return null;
  }
}

/**
 * Whether where the device stands waits on what its PCs answer: the start of a move, a carried device's join, a refusal
 * of one, which clears when its cause does, or the check of a list a carried device follows against PCs silent at its join.
 */
export function waitsOnPcs(status: AccountListView["status"]): boolean {
  return (status.at === "none" && status.why === "moving" && status.move?.why !== "sending" && status.move?.why !== "paused")
    || (status.at === "not_in" && (status.why === "carried" || status.refused !== undefined))
    || (status.at === "following" && ((status.asks?.length ?? 0) > 0 || status.doubt !== undefined));
}

/**
 * Whether where the device stands turns on what PCs that already answered said, so that each such answer is asked for
 * again, not only the PCs that never answered: a start that waits on a key let in for less than a day, a join that
 * waits or refused, a doubt on the list a carried device follows, or a PC that has not agreed with it yet. An answer
 * kept from earlier says nothing of now.
 */
export function asksAgain(status: AccountListView["status"]): boolean {
  return (status.at === "none" && status.why === "moving" && status.move?.why !== "sending" && status.move?.why !== "paused" && status.move?.why !== "pcs_silent")
    || (status.at === "not_in" && (status.why === "carried" || status.refused !== undefined))
    || (status.at === "following" && (status.doubt !== undefined || (status.asks?.length ?? 0) > 0));
}

/**
 * A session the app opened to a PC of the account, for the move (Part F, F5 and F6): while the device waits on its PCs
 * this one is asked what it lets in, its answer kept for this run, and the list read again; and a device that follows
 * its moved list names it, with its vouch, to a PC that follows no list (`pinned` false: the PC took no
 * account-list-1). Nothing is said to any other PC, and nothing for an account that never moved.
 */
export async function onPcSession(given: {
  readonly list: Pick<AccountList, "view" | "naming" | "sync">; readonly answers: PcAnswers; readonly account: string; readonly fetch: PcFetch;
  readonly endpoint: string; readonly pinned: boolean; readonly session: string | null; readonly signIn: string | null;
  /** On a PC that follows a list, for a device that follows its own: the keys the move left that PC without (listCarriedPc.ts). */
  readonly carriedKeys?: () => Promise<unknown>;
}): Promise<void> {
  const { list, account, endpoint } = given;
  const began = list.view();
  if (began.account !== account || !ENDPOINT.test(endpoint)) return;
  if (waitsOnPcs(began.status)) {
    const said = await askWitness(given.fetch);
    // no answer here (a pairing's session, which a PC answers for its account's rows alone) takes no answer heard before
    if (said !== null || given.answers.get(account, endpoint) === undefined) given.answers.set(account, endpoint, said);
    if (said !== null) await list.sync().catch(() => undefined);
  }
  // where the device stands now, for the account this session was opened for: a device that this very answer let
  // move its account names its list on this session; one of another account signed in meanwhile names nothing here
  const view = list.view();
  if (view.account !== account || view.status.at !== "following" || view.status.standing !== "in") return;
  if (given.pinned) {
    await given.carriedKeys?.();
    return;
  }
  if (given.session === null || list.naming === undefined) return;
  const named = await list.naming({ account, session: given.session, endpoint, signIn: given.signIn });
  if (named === null) return;
  await nameListTo(given.fetch, named);
}

/** What a PC answered a naming (docs/account-list.md, "On the PC"): the list it follows, or why it follows none and for how long, in seconds. */
export type NamingAnswer = { readonly pinned: true; readonly list: string } | { readonly pinned: false; readonly why: string; readonly wait: number | null };

/**
 * Hands a PC the naming of the list, with its vouches, over the session `fetch` is of (POST /api/account/list/name), and
 * reads its answer: null for none that reads (a PC from before this release, one away), which is named again later.
 */
export async function nameListTo(fetch: PcFetch, named: NonNullable<Awaited<ReturnType<NonNullable<AccountList["naming"]>>>>): Promise<NamingAnswer | null> {
  try {
    const answer = await fetch("/api/account/list/name", {
      method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
      body: JSON.stringify({ naming: named.naming, ...(named.vouches.length === 0 ? {} : { vouches: named.vouches }) }),
    });
    const body: unknown = answer.ok ? await answer.json() : null;
    if (!isRecord(body)) return null;
    if (body.pinned === true && typeof body.list === "string") return { pinned: true, list: body.list };
    return body.pinned === false && typeof body.why === "string" ? { pinned: false, why: body.why, wait: isSpan(body.wait) ? body.wait : null } : null;
  } catch {
    return null;
  }
}

/**
 * The keys this device itself holds a block or a removal against (R-F), which it never carries into a list: every key a
 * Not me of it blocked, sent or not and whatever the service answered, the removals PCs showed it, and the `remove`s it
 * signed itself, of `account` alone.
 */
export async function ownRemovals(store: Pick<AccountStore, "get">, account: string): Promise<string[]> {
  const unsent = Object.values((await store.get("unsent_blocks")) ?? {}).filter((kept) => kept.account === account).flatMap((kept) => kept.records.map((record) => record.target));
  const blocks = [...unsent, ...(await store.get("own_blocks"))?.[account] ?? []];
  const removals = Object.values((await store.get("removals")) ?? {}).filter((record) => record.account === account).map((record) => record.key);
  // what this device's own Remove signed (join.ts rememberDevice), whether or not it has reached a PC yet
  const signed = Object.values((await store.get("devices")) ?? {}).filter((record) => record.kind === "remove" && record.account === account).map((record) => record.key);
  return [...new Set([...blocks, ...removals, ...signed])];
}

/** The keys the device that started a list has been in it by: entry 0's signer, and each key it handed its place on to. */
function starterKeys(state: ListState): string[] {
  const first = Object.entries(state.signers).find(([, row]) => row.seq === 0)?.[0];
  if (first === undefined) return [];
  const keys = [first];
  for (let heir = heirOf(state, first); heir !== null && !keys.includes(heir); heir = heirOf(state, heir)) keys.push(heir);
  return keys;
}

/** What a PC that answered says against a list a device follows (V4-6): the first that applies, with the PCs that say it. */
export interface ListDoubt {
  readonly why: "other_list" | "first_signer_removed" | "first_signer_unknown";
  readonly pcs: readonly string[];
}

/**
 * Whether a PC's answer agrees with the list a device follows: it follows that very list, or it follows none, has let
 * the device that started the list in by one of its keys for a day by both its counters, as joinVerdict asks of a
 * witness (a key named twice counts by its shorter stretch), and holds no removal against any of them.
 */
export function pcAgrees(state: ListState, says: PcAnswer): boolean {
  const starter = starterKeys(state);
  if (says.pinned !== null) return says.pinned === state.list;
  const day = (key: string): boolean => {
    const rows = says.admits.filter((row) => row.key === key);
    return rows.length > 0 && rows.every((row) => row.wall >= MIGRATION_WITNESS_SECONDS && row.ran >= MIGRATION_RUNNING_SECONDS);
  };
  return !starter.some((key) => says.removed.includes(key)) && starter.some(day);
}

/**
 * What the PCs a device knows by its own record said in this run against the list it followed after its own join, the
 * worst first (V4-6): one follows another list of the account (`other_list`); one that follows none holds a removal
 * against the device that started the list (`first_signer_removed`); or one that follows none, and was not among those
 * that agreed when the device joined (`agreed`), lets that device in by none of its keys (`first_signer_unknown`). Null
 * where none says anything of the kind. Only PCs that answered for the list's account count.
 */
export function listDoubt(state: ListState, pcs: readonly KnownPc[], agreed: readonly string[]): ListDoubt | null {
  const starter = starterKeys(state);
  const answered = pcs.flatMap((pc) => (pc.says !== null && pc.says.account === state.account && ownEvidence(pc) ? [{ endpoint: pc.endpoint, says: pc.says }] : []));
  const other = answered.filter(({ says }) => says.pinned !== null && says.pinned !== state.list);
  if (other.length > 0) return { why: "other_list", pcs: other.map(({ endpoint }) => endpoint) };
  const free = answered.filter(({ says }) => says.pinned === null);
  const removed = free.filter(({ says }) => starter.some((key) => says.removed.includes(key)));
  if (removed.length > 0) return { why: "first_signer_removed", pcs: removed.map(({ endpoint }) => endpoint) };
  const unknown = free.filter(({ endpoint, says }) => !agreed.includes(endpoint) && !says.admits.some((row) => starter.includes(row.key)));
  return unknown.length > 0 ? { why: "first_signer_unknown", pcs: unknown.map(({ endpoint }) => endpoint) } : null;
}

/**
 * A carried device's join of its list, kept while it checks the list against the PCs it knows (V4-6): the list, when it
 * joined (seconds, this device's clock), and the relay keys of the PCs that agreed then or since.
 */
export interface JoinedRecord {
  readonly list: string;
  readonly at: number;
  readonly agreed: readonly string[];
}

export function joinedRecord(joined: JoinedRecord): unknown {
  return { v: RECORD_VERSION, ...joined };
}

export function readJoined(value: unknown): JoinedRecord | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION || typeof value.list !== "string" || !isListHash(value.list) || !isSpan(value.at) || !texts(value.agreed)) return null;
  return { list: value.list, at: value.at, agreed: value.agreed };
}
