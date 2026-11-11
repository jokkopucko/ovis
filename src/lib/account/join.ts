/**
 * Joining the account from this client (docs/account.md, "Account members", "Introductions"):
 * linking a pairing it already has, taking the introduction to the account's other PCs after a
 * remote approval, and, on the approving client, signing the new device in everywhere else. Every
 * call goes through the PC's own session (`fetch` is that PC's transport), so the PC sees which of
 * its devices is asking.
 */
import { ACCOUNT_ENROLL_MAX, AccountRecordError, accountDeviceId, isAccountKey, newRecordId, readAccountRecord, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord, LinkRecord, RemoveRecord } from "../../../shared/account-records.ts";
import { isWssOrigin } from "../../../shared/relay-offer.ts";
import type { RemotePairingRequest } from "../../../shared/protocol.ts";
import type { RelayDevice, RelayDeviceStore } from "../relay/device.ts";
import { keyIdOf } from "../relay/shellState.ts";
import type { AccountService, Admission } from "./service.ts";
import type { AccountKey, AccountStore } from "./store.ts";

export type PcFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The PC refused an account request; `code` is its error code, never its words. */
export class AccountPcError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`The PC answered ${status} (${code})`);
    this.name = "AccountPcError";
  }
}

async function refusal(response: Response): Promise<AccountPcError> {
  let code = "http_error";
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    if (typeof body.error?.code === "string" && /^[a-z_]{1,40}$/.test(body.error.code)) code = body.error.code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return new AccountPcError(response.status, code);
}

export async function post(fetch: PcFetch, path: string, body: unknown): Promise<Response> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  if (!response.ok) throw await refusal(response);
  return response;
}

export interface PcAccountStatus {
  /** the account this PC belongs to; null before its first member */
  readonly account: string | null;
  /** its relay rows that are not members */
  readonly unlinked: readonly string[];
  /** the signed `remove`s behind its tombstones, as it says: unchecked until keepRemovals verifies them */
  readonly removals: readonly unknown[];
  /** the signed `add`s behind its account rows, as it says: unchecked until enrollPc verifies them */
  readonly adds: readonly unknown[];
  /** every key it keeps out, signed removal or not, as it says */
  readonly blocked: readonly string[];
  /** with `fresh`: it read its whole mailbox just now, so no removal waits unread there */
  readonly fresh?: boolean;
  /** it holds every add back: it lost removal evidence, so `blocked` may not name every key it keeps out */
  readonly blockedAll?: boolean;
  /** it waits for its first member's enrollment; absent from an Ovis from before enrollments */
  readonly enrolling?: boolean;
}

/** `fresh`: the PC reads its mailbox first, so a removal waiting there is counted (docs/account.md, "PC API"). */
export async function pcAccountStatus(fetch: PcFetch, options: { fresh?: boolean } = {}): Promise<PcAccountStatus> {
  const response = await fetch(options.fresh ? "/api/account/status?fresh=1" : "/api/account/status");
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { account?: unknown; unlinked?: unknown; removals?: unknown; adds?: unknown; blocked?: unknown };
  const unlinked = Array.isArray(body.unlinked) ? body.unlinked.filter((id): id is string => typeof id === "string") : [];
  return {
    account: typeof body.account === "string" ? body.account : null, unlinked,
    removals: Array.isArray(body.removals) ? body.removals : [], adds: Array.isArray(body.adds) ? body.adds : [],
    blocked: Array.isArray(body.blocked) ? body.blocked.filter(isAccountKey) : [],
    // an Ovis from before enrollments sends no `fresh` at all
    ...(options.fresh && "fresh" in body ? { fresh: (body as { fresh?: unknown }).fresh === true } : {}),
    ...((body as { blocked_all?: unknown }).blocked_all === true ? { blockedAll: true } : {}),
    ...(typeof (body as { enrolling?: unknown }).enrolling === "boolean" ? { enrolling: (body as { enrolling: boolean }).enrolling } : {}),
  };
}

/** Whether this device's row on the PC should be linked to `account` now. */
export function needsLink(status: PcAccountStatus, device: RelayDevice, account: string): boolean {
  if (device.device_id === null) return false;
  // a PC of another account keeps this pairing as it is: the account cannot reach it
  if (status.account !== null && status.account !== account) return false;
  return status.account === null || status.unlinked.includes(device.device_id);
}

/**
 * Makes this device's row on the PC an account member: a `link` signed by the account key proves
 * both keys, and the PC swaps the row's key in one write. The device then signs in with the
 * account key there, so the saved pairing takes it too.
 */
export async function linkThisDevice(options: { fetch: PcFetch; device: RelayDevice; key: AccountKey; account: string; store: RelayDeviceStore; now?: () => number }): Promise<RelayDevice> {
  const { device, key } = options;
  if (device.device_id === null) throw new TypeError("Only a device the PC admitted can be linked");
  const record: LinkRecord = await signAccountRecord({
    v: 1, kind: "link", account: options.account, key: key.public_spki, server_id: device.server_id, device_id: device.device_id,
    old_key: device.public_spki, issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: key.public_spki,
  }, key.private_key);
  // kept before sending: if the answer is lost after the PC swapped the key, the next sign-in tries this one
  await options.store.update(device.server_id, (current) => current === undefined ? device : { ...current, pending_key: { private_key: key.private_key, public_spki: key.public_spki } });
  await post(options.fetch, "/api/account/link", { record });
  return options.store.update(device.server_id, (current) => {
    // only the pairing the link was signed for takes the key: one changed meanwhile is left as it is
    if (current === undefined || current.device_id !== device.device_id || current.public_spki !== device.public_spki || current.server_public_key !== device.server_public_key) {
      throw new TypeError("This PC's pairing changed while it was being linked");
    }
    const { pending_key: _sent, ...rest } = current;
    return { ...rest, private_key: key.private_key, public_spki: key.public_spki, account: options.account };
  });
}

export interface IntroducedPc { readonly server_id: string; readonly server_public_key: string; readonly relay: string; readonly name: string }

/** At most this many PCs come in one introduction (docs/account.md, "Introductions"). */
export const INTRODUCTION_MAX = 32;

/** Only an introduction whose id is its key's (server/relay/identity.ts) and whose relay is a wss origin. */
function parseIntroduced(value: unknown): IntroducedPc | null {
  if (typeof value !== "object" || value === null) return null;
  const pc = value as Record<string, unknown>;
  if (typeof pc.server_id !== "string" || typeof pc.server_public_key !== "string" || typeof pc.relay !== "string" || typeof pc.name !== "string") return null;
  if (keyIdOf(pc.server_public_key) !== pc.server_id || !isWssOrigin(pc.relay) || pc.name.length > 48) return null;
  return { server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.name };
}

/**
 * After a remote approval on PC X: the account's other PCs as the approver checked them, saved so
 * this device signs in to each with the account key and the id the `add` gave it there. A PC this
 * device already has is left as it is. X passes the list on, so only PCs on X's own relay are kept:
 * a list that names another relay would route this device through one X chose. Returns the PCs saved.
 */
export async function takeIntroduction(options: { fetch: PcFetch; key: AccountKey; label: string; store: RelayDeviceStore; relay: string }): Promise<RelayDevice[]> {
  const response = await options.fetch("/api/account/introduction");
  if (response.status === 404) return [];
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { pcs?: unknown };
  const pcs = (Array.isArray(body.pcs) ? body.pcs.slice(0, INTRODUCTION_MAX) : []).map(parseIntroduced)
    .filter((pc): pc is IntroducedPc => pc !== null && pc.relay === options.relay);
  const saved: RelayDevice[] = [];
  for (const pc of pcs) {
    if (await options.store.get(pc.server_id) !== undefined) continue;
    saved.push(await options.store.update(pc.server_id, (current) => current ?? {
      server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.name,
      device_id: accountDeviceId(pc.server_id, options.key.public_spki), private_key: options.key.private_key, public_spki: options.key.public_spki, label: options.label,
      introduced_at: Date.now(),
    }));
  }
  return saved;
}

/** The account service saw no device of this account ask to join at this PC with that key. */
export class UnverifiedJoinError extends Error {
  readonly code = "unverified_device";
  constructor() {
    super("Could not verify this device");
    this.name = "UnverifiedJoinError";
  }
}

/** The device asking changed what it says (or where it asks from) after the approval card was drawn. */
export class AdmissionChangedError extends Error {
  constructor() {
    super("The device asked again with other details");
    this.name = "AdmissionChangedError";
  }
}

const sameAdmission = (a: Admission, b: Admission): boolean => a.key === b.key && a.server_id === b.server_id
  && a.at === b.at && a.label === b.label && a.os === b.os && a.country === b.country && a.city === b.city;

/** What breaks a same-millisecond tie: the details themselves, so the pick never depends on listing order. */
const tieKey = (admission: Admission): string => [admission.label, admission.os, admission.country, admission.city].join("\u0000");

/** An admission counts for this long after the device rang (docs/account.md, "Joining through the account"). */
export const ADMISSION_MS = 10 * 60_000;

/**
 * A member's answer to a device asking through PC X. A request to join the account is approved,
 * and the device added everywhere, only when the account service itself (not X) saw a device of
 * this account ring at X with that key in the last 10 minutes: a PC that shows another key than
 * the one that rang is refused, and declined on X. Another PC of the account vouched for (`vouched`)
 * is checked the same way and then only answered on X: nothing is signed for it. Any other request
 * for X alone is just answered on X.
 */
export async function approveJoin(options: {
  request: RemotePairingRequest; digits: string; through: string; service: AccountService;
  decide: (decision: "approve" | "decline", digits?: string) => Promise<void>;
  /** with the admission that vouched for the device: its name is the one the device gave the account service, not the PC's */
  admit: (admission: Admission) => Promise<unknown>; now?: () => number;
  /** the admission the card showed, null when it showed none: approval goes ahead only for exactly that one */
  shown?: Admission | null;
}): Promise<void> {
  const { request } = options;
  if (request.intent !== "account" && request.vouched !== true) { await options.decide("approve", options.digits); return; }
  const vouched = vouchedAdmission(await options.service.recentAdmissions(), options.through, request.key, (options.now ?? Date.now)());
  if (vouched === undefined) {
    await options.decide("decline");
    throw new UnverifiedJoinError();
  }
  // the device asked again with another name, system or place since the card was drawn: nothing is
  // answered, and the card shows the new details before anyone approves them
  if (options.shown !== undefined && (options.shown === null || !sameAdmission(options.shown, vouched))) throw new AdmissionChangedError();
  await options.decide("approve", options.digits);
  // a PC vouched for joins X alone: no add, no introduction
  if (request.intent === "account") await options.admit(vouched);
}

/**
 * The newest admission of `key` at PC `through` from the last ADMISSION_MS, whatever order the
 * account service lists them in: the one the approval card shows and the one an approval rests on.
 */
export function vouchedAdmission(admissions: readonly Admission[], through: string, key: string, now: number): Admission | undefined {
  let newest: Admission | undefined;
  for (const admission of admissions) {
    const at = Date.parse(admission.at);
    if (admission.server_id !== through || admission.key !== key || !(now - at <= ADMISSION_MS)) continue;
    const newestAt = newest === undefined ? -Infinity : Date.parse(newest.at);
    if (newest === undefined || at > newestAt || (at === newestAt && tieKey(admission) > tieKey(newest))) newest = admission;
  }
  return newest;
}

/** How long the approver waits for PC X to let the new device in once both sides said yes. */
export const ADMITTED_MS = 120_000;
const ADMITTED_POLL_MS = 2_000;

/**
 * On the approving client, once this client approved on PC X: first the introduction to the PCs
 * this client checked itself, handed to X, which X takes only once the new device's row exists
 * (the new device confirmed too); only then an `add` for its key, put in the mailbox of every other
 * PC of the account. A device that never finishes joining X reaches no other PC.
 */
export async function admitToAccount(options: {
  fetch: PcFetch; service: AccountService; key: AccountKey; account: string;
  joining: { key: string; label: string }; through: string; paired: readonly RelayDevice[]; directory: readonly string[]; now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** where the add waits for the PCs the account service did not take it for; none, and a refusal throws */
  store?: AccountStore;
}): Promise<AddRecord> {
  const now = options.now ?? Date.now;
  // fixed wait: the pause between tries of a poll bounded by ADMITTED_MS
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const pcs = options.paired
    .filter((device) => device.device_id !== null && device.server_id !== options.through && device.public_spki === options.key.public_spki && keyIdOf(device.server_public_key) === device.server_id)
    .slice(0, INTRODUCTION_MAX)
    .map((device) => ({ server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay, name: (device.name ?? device.server_id.slice(0, 8)).slice(0, 48) }));
  const deadline = now() + ADMITTED_MS;
  for (;;) {
    try { await post(options.fetch, "/api/account/introduce", { key: options.joining.key, pcs }); break; }
    catch (error) {
      // no row for that key on X yet: the new device has not confirmed its digits
      if (!(error instanceof AccountPcError) || error.code !== "introduction_unknown_key" || now() > deadline) throw error;
      await wait(ADMITTED_POLL_MS);
    }
  }
  const add: AddRecord = await signAccountRecord({
    v: 1, kind: "add", account: options.account, key: options.joining.key, label: options.joining.label, role: "drive",
    issued_at: new Date(now()).toISOString(), id: newRecordId(), signer: options.key.public_spki,
  }, options.key.private_key);
  // X keeps it on the row it made, so a client enrolling a later PC finds it there (docs/account.md, "PC API")
  try { await post(options.fetch, "/api/account/records", { records: [add] }); } catch (error) {
    console.warn("Ovis: the PC that let the device in did not keep its add", error instanceof Error ? error.name : error);
  }
  const others = options.directory.filter((serverId) => serverId !== options.through);
  if (!options.store) {
    for (let start = 0; start < others.length; start += 32) await options.service.postRecord(others.slice(start, start + 32), add);
    return add;
  }
  // X already let the device in: kept before it is sent, so a refusal or a lost answer is sent again;
  // and, in the same write, as a device this client checked itself, which a PC it enrolls later gets too
  await options.store.updateMany(["adds", "devices"], (current) => ({
    adds: { ...current.adds, [add.id]: { account: options.account, record: add, to: others } },
    devices: withDevice(current.devices, add),
  }));
  await sendQueuedAdds({ service: options.service, store: options.store, account: options.account });
  return add;
}

type KnownDevices = Readonly<Record<string, AddRecord | RemoveRecord>>;

/** `known` with `record` for its key, unless a record signed later is there (a removal wins a tie). */
function withDevice(known: KnownDevices | undefined, record: AddRecord | RemoveRecord): KnownDevices {
  const current = known?.[record.key];
  const later = current !== undefined && (current.issued_at > record.issued_at || (current.issued_at === record.issued_at && current.kind === "remove"));
  return later ? known! : { ...known, [record.key]: record };
}

/**
 * Keeps a record this client signed for a device of the account, which enrollPc hands a PC this
 * client brings into the account: one entry per key, the later signed one.
 */
export async function rememberDevice(store: AccountStore, record: AddRecord | RemoveRecord): Promise<void> {
  await store.update("devices", (current) => withDevice(current, record));
}

/** At most this many removals of other members are kept to relay (keepRemovals). */
export const KEPT_REMOVALS_MAX = 256;

/**
 * Keeps, verbatim, the signed `remove`s a PC of the account lists (its status' `removals`) that this
 * client can check: each must verify, be for `account`, and be signed by this client's own key, by a
 * device this client approved itself (an `add` it signed), or by one it removed, before that removal,
 * so a PC cannot fill it with removals signed by keys it made up. Nothing is signed for them: enrollPc relays them as they are (#2956).
 */
export async function keepRemovals(options: { store: AccountStore; account: string; removals: readonly unknown[] }): Promise<void> {
  const own = (await options.store.key()).public_spki;
  const known = (await options.store.get("devices")) ?? {};
  const vouched = (record: RemoveRecord) => {
    if (record.signer === own) return true;
    const mine = known[record.signer];
    return mine !== undefined && mine.account === options.account && (mine.kind === "add" || record.issued_at < mine.issued_at);
  };
  const checked: RemoveRecord[] = [];
  // read past the cap, so records that do not check cannot crowd out ones that do
  for (const value of options.removals.slice(0, KEPT_REMOVALS_MAX * 4)) {
    let record;
    try { record = await readAccountRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) continue;
      throw error;
    }
    if (record?.kind === "remove" && record.account === options.account && vouched(record)) checked.push(record);
  }
  if (checked.length === 0) return;
  await options.store.update("removals", (current) => {
    const next = { ...current };
    // a record id already kept keeps its first record
    for (const record of checked) if (next[record.id] === undefined && Object.keys(next).length < KEPT_REMOVALS_MAX) next[record.id] = record;
    return next;
  });
}

/** Marks a PC this client is about to link while it had no account: enrollPc hands it the account's devices. */
export async function planEnroll(store: AccountStore, serverId: string, account: string): Promise<void> {
  await store.update("enrolls", (current) => ({ ...current, [serverId]: { account, done: [] } }));
}

/** A refusal that says nothing final about the record: the PC could not read its tombstones, so it is sent again. */
const UNDECIDED = new Set(["account_unavailable", "enrolling"]);

/** Another PC of the account this client is paired with, over a session signed in with the account key there. */
export interface AccountPeer { readonly serverId: string; readonly fetch: PcFetch; readonly assertOwned?: () => Promise<void> }

/** How long an enrollment waits for another PC of the account to say what it keeps out, before it counts that PC as not checked. */
export const PEER_STATUS_MS = 8_000;
/** Keys one enrollment holds at most (server/account/holds.ts ACCOUNT_HELD_MAX). */
const HELD_MAX = 4096;

/** `promise`, or a refusal once it has not settled within `ms`: what it then answers is dropped. */
export function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // fixed wait: a deadline for a PC that does not answer, not a pause
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The PC did not answer in time")), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function verified(values: readonly unknown[], account: string): Promise<(AddRecord | RemoveRecord)[]> {
  const records: (AddRecord | RemoveRecord)[] = [];
  for (const value of values) {
    let record;
    try { record = await readAccountRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) continue;
      throw error;
    }
    if (record !== null && record.kind !== "link" && record.account === account) records.push(record);
  }
  return records;
}

/** What an enrollment did: the PCs of the account it read first, and the devices it let in. */
export interface Enrollment { readonly finished: boolean; readonly checked: number; readonly of: number; readonly admitted: readonly string[] }

/**
 * Hands a planned PC (planEnroll) the account's devices (docs/account.md, "Enrolling a PC"). It
 * first reads every other PC of the account it can reach (`others`): what each keeps out
 * (`blocked`), its signed removals and its signed adds. Then, in one enrollment, which also ends
 * the PC's wait for this client:
 * - the removes this client signed and the ones it kept (keepRemovals), as signed;
 * - the adds this client signed and the ones those PCs list, as signed, except any for a key that
 *   one of them keeps out or that any removal it saw names, whoever signed it (fail closed: that
 *   device asks once by comparing digits); a PC applies an add only when its signer is a member there;
 * - those keys, as `held`, so no later add lets them in there either.
 * Nothing is signed for any of it. When `others` is not empty and none answered, nothing is sent
 * and the plan waits for the next connection. Then each PC that answered introduces `pc` to the
 * devices let in, so they sign in there. `finished` once nothing is left to send.
 */
export async function enrollPc(options: {
  fetch: PcFetch; store: AccountStore; account: string; serverId: string; others?: readonly AccountPeer[]; pc?: IntroducedPc; assertOwned?: () => Promise<void>;
  /** how many other PCs the account's directory lists: some this client cannot read keep its adds home */
  listed?: number;
  /** the new PC is from before enrollments (its status has no `enrolling`): removes only, through records */
  legacyTarget?: boolean;
}): Promise<Enrollment> {
  const others = options.others ?? [];
  const planned = (await options.store.get("enrolls"))?.[options.serverId];
  if (planned === undefined || planned.account !== options.account) return { finished: true, checked: 0, of: others.length, admitted: [] };
  // enrolled already: only introductions some PCs did not take are left
  if (planned.introduce !== undefined) return { finished: await introduceLeft(options, others), checked: 0, of: others.length, admitted: planned.introduce.keys };
  const answered: AccountPeer[] = [];
  const seen: PcAccountStatus[] = [];
  /** PCs that cannot say they read their whole mailbox (from before enrollments, or whose read failed): their removals are relayed, and no add goes */
  let legacy = 0;
  let unvouched = 0;
  await Promise.all(others.map(async (peer) => {
    try {
      const status = await within(PEER_STATUS_MS, pcAccountStatus(peer.fetch, { fresh: true }));
      if (status.account !== options.account) return;
      // from before enrollments: its removals count, but it cannot vouch for its mailbox
      if (status.fresh === undefined) { legacy++; seen.push(status); return; }
      // a PC whose mailbox read failed or stopped short may hold a removal it does not list yet: its removals
      // go, no add does, and the new PC keeps its wait until a later connection finds that PC read whole
      if (status.fresh !== true) { unvouched++; seen.push(status); return; }
      answered.push(peer);
      seen.push(status);
    } catch (error) { console.warn("Ovis: a PC of the account was not checked before the enrollment", error instanceof Error ? error.name : error); }
  }));
  if (others.length > 0 && answered.length === 0 && legacy === 0 && unvouched === 0) return { finished: false, checked: 0, of: others.length, admitted: [] };
  await keepRemovals({ store: options.store, account: options.account, removals: seen.flatMap((status) => status.removals) });
  const collected = await verified(seen.flatMap((status) => [...status.removals, ...status.adds]), options.account);
  /** the removals to send: this client's own and the ones it kept, not answered yet */
  const pending = (devices: KnownDevices | undefined, kept: Readonly<Record<string, RemoveRecord>> | undefined) => [
    ...Object.values(devices ?? {}).filter((record): record is RemoveRecord => record.kind === "remove"),
    ...Object.values(kept ?? {}),
  ].filter((record, index, all) => record.account === options.account && !planned.done.includes(record.id) && all.findIndex((other) => other.id === record.id) === index)
    // in the order they were signed: a removal of a member then comes after the removals that member signed before it
    .sort((a, b) => a.issued_at < b.issued_at ? -1 : a.issued_at > b.issued_at ? 1 : 0);
  const known = await options.store.get("devices");
  const kept = await options.store.get("removals");
  const removes = pending(known, kept);
  const held = new Set([
    ...seen.flatMap((status) => status.blocked),
    ...collected.filter((record) => record.kind === "remove").map((record) => record.key),
    ...Object.values(known ?? {}).filter((record) => record.kind === "remove" && record.account === options.account).map((record) => record.key),
    ...Object.values(kept ?? {}).map((record) => record.key),
  ]);
  // a PC that lost removal evidence may keep out a key it cannot name: then no add goes, and the new PC holds every one
  // only older PCs answered: no add goes, as before enrollments, and the account's devices ask this PC once each
  // a PC that cannot vouch for what it keeps out (older, or its mailbox read failed): while one answers, no add goes
  // the directory lists PCs this client has no way to read: one of them may hold a removal it never saw
  const unread = others.length === 0 && (options.listed ?? 0) > 0;
  const blind = seen.some((status) => status.blockedAll === true) || legacy > 0 || unvouched > 0 || unread;
  const adds = blind ? [] : [...Object.values(known ?? {}), ...collected]
    .filter((record): record is AddRecord => record.kind === "add" && record.account === options.account && !held.has(record.key) && !planned.done.includes(record.id))
    .filter((record, index, all) => all.findIndex((other) => other.id === record.id) === index);
  if (options.legacyTarget) return enrollLegacy({ ...options, removes });
  const records: (AddRecord | RemoveRecord)[] = [...removes, ...adds];
  const done: string[] = [];
  const admitted: string[] = [...planned.admitted ?? []];
  // an unvouched PC keeps the new PC waiting: this enrollment is sent, but not as the last part
  let sent = unvouched === 0;
  // through the enrollment, which also ends the PC's wait for this client: sent even with nothing in it
  // the removes go first and the PC ends its wait only with the last part, so a long enrollment lets nothing in early
  for (let start = 0; start === 0 || start < records.length; start += ACCOUNT_ENROLL_MAX) {
    const batch = records.slice(start, start + ACCOUNT_ENROLL_MAX);
    // only a PC that lost removal evidence for good latches every add off; one that could not read its mailbox this time
    // (or is older) only keeps this enrollment's adds home, so a passing failure never spreads a permanent hold
    const first = start === 0 ? { held: [...held].slice(0, HELD_MAX), ...(held.size > HELD_MAX || seen.some((status) => status.blockedAll === true) ? { held_full: true } : {}) } : {};
    // a part with a remove the PC could not decide keeps its wait: this enrollment is sent again on the next connection
    let response: Response;
    try { response = await post(options.fetch, "/api/account/enroll", { account: options.account, records: batch, last: sent && start + ACCOUNT_ENROLL_MAX >= records.length, ...first }); } catch (error) {
      // an Ovis from before enrollments takes adds only there: the removes go through records, as they did, and no add
      if (!(error instanceof AccountPcError) || error.code !== "record_invalid") throw error;
      return enrollLegacy({ ...options, removes });
    }
    const answer = await response.json() as { results?: unknown };
    const results = Array.isArray(answer.results) ? answer.results as { id?: unknown; outcome?: unknown; code?: unknown }[] : [];
    for (const record of batch) {
      const result = results.find((entry) => entry.id === record.id);
      const final = result?.outcome === "applied" || result?.outcome === "unchanged" || (result?.outcome === "refused" && !UNDECIDED.has(String(result.code)));
      if (final) done.push(record.id);
      else sent = false;
      if (record.kind === "add" && (result?.outcome === "applied" || result?.outcome === "unchanged")) admitted.push(record.key);
    }
  }
  let finished = false;
  // checked in the same write that ends the plan: a record signed meanwhile (another tab) keeps it for the next call
  await options.store.updateMany(["enrolls", "devices", "removals"], (current) => {
    const entry = current.enrolls?.[options.serverId];
    if (current.enrolls === undefined || entry === undefined || entry.account !== options.account) return current;
    finished = sent && pending(current.devices, current.removals).every((record) => done.includes(record.id));
    const rest = { ...current.enrolls };
    // enrolled: the plan stays only for the introductions, until every PC that answered took them
    const pc = options.pc;
    // with the devices an earlier, unfinished attempt let in
    const keys = [...new Set([...entry.admitted ?? [], ...admitted])];
    if (finished && pc !== undefined && keys.length > 0 && answered.length > 0) rest[options.serverId] = { account: entry.account, done: [], introduce: { keys, pc, to: answered.map((peer) => peer.serverId) } };
    else if (finished) delete rest[options.serverId];
    else rest[options.serverId] = { ...entry, done: [...entry.done, ...done], admitted: keys };
    return { devices: current.devices, removals: current.removals, enrolls: Object.keys(rest).length === 0 ? undefined : rest };
  });
  if (finished) finished = await introduceLeft(options, answered);
  return { finished, checked: answered.length, of: others.length, admitted };
}

/**
 * Sends the introductions a plan still holds through each of `peers` it names, and drops each PC that
 * took them all (a device a PC does not know is skipped there). True once none is left.
 */
async function introduceLeft(options: { store: AccountStore; serverId: string; assertOwned?: () => Promise<void> }, peers: readonly AccountPeer[]): Promise<boolean> {
  const { store, serverId, assertOwned } = options;
  const left = (await store.get("enrolls"))?.[serverId]?.introduce;
  if (left === undefined) return true;
  const took: string[] = [];
  for (const peer of peers.filter((candidate) => left.to.includes(candidate.serverId))) {
    if (await introduce(peer, left.keys, left.pc)) took.push(peer.serverId);
  }
  let none = false;
  await assertOwned?.();
  await store.update("enrolls", (current) => {
    const entry = current?.[serverId];
    if (current === undefined || entry?.introduce === undefined) { none = true; return current; }
    const to = entry.introduce.to.filter((id) => !took.includes(id));
    const rest = { ...current };
    none = to.length === 0;
    if (none) delete rest[serverId];
    else rest[serverId] = { ...entry, introduce: { ...entry.introduce, to } };
    return Object.keys(rest).length === 0 ? undefined : rest;
  });
  return none;
}

/** A new PC from before enrollments: the removes as they were sent then, through records, and no add. */
async function enrollLegacy(options: { fetch: PcFetch; store: AccountStore; account: string; serverId: string; others?: readonly AccountPeer[]; removes: readonly RemoveRecord[] }): Promise<Enrollment> {
  const done: string[] = [];
  let sent = true;
  for (let start = 0; start < options.removes.length; start += 32) {
    const batch = options.removes.slice(start, start + 32);
    const answer = await (await post(options.fetch, "/api/account/records", { records: batch })).json() as { results?: unknown };
    const results = Array.isArray(answer.results) ? answer.results as { id?: unknown; outcome?: unknown; code?: unknown }[] : [];
    for (const record of batch) {
      const result = results.find((entry) => entry.id === record.id);
      if (result?.outcome === "applied" || result?.outcome === "unchanged" || (result?.outcome === "refused" && !UNDECIDED.has(String(result.code)))) done.push(record.id);
      else sent = false;
    }
  }
  let finished = false;
  // checked in the same write that ends the plan: a removal signed meanwhile keeps it for the next call
  await options.store.updateMany(["enrolls", "devices", "removals"], (current) => {
    const entry = current.enrolls?.[options.serverId];
    if (current.enrolls === undefined || entry === undefined) return current;
    const signed = [...Object.values(current.devices ?? {}).filter((record): record is RemoveRecord => record.kind === "remove"), ...Object.values(current.removals ?? {})]
      .filter((record) => record.account === options.account && !entry.done.includes(record.id));
    finished = sent && signed.every((record) => done.includes(record.id));
    const rest = { ...current.enrolls };
    if (finished) delete rest[options.serverId];
    else rest[options.serverId] = { ...entry, done: [...entry.done, ...done] };
    return { devices: current.devices, removals: current.removals, enrolls: Object.keys(rest).length === 0 ? undefined : rest };
  });
  return { finished, checked: 0, of: options.others?.length ?? 0, admitted: [] };
}

/**
 * PC `peer` tells the devices just let in about the new PC (docs/account.md, "Introductions"); a
 * device it does not know is skipped. True when it answered for every one, so nothing is left to send.
 */
async function introduce(peer: AccountPeer, keys: readonly string[], pc: IntroducedPc): Promise<boolean> {
  let all = true;
  for (const key of keys) {
    try { await post(peer.fetch, "/api/account/introduce", { key, pcs: [pc] }); } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      await peer.assertOwned?.();
      if (error instanceof AccountPcError && error.code === "introduction_unknown_key") continue;
      console.warn("Ovis: a PC did not introduce the new PC yet", error instanceof AccountPcError ? error.code : error instanceof Error ? error.name : error);
      all = false;
    }
  }
  return all;
}

/**
 * What a connection to a PC of the account does for a PC this client planned to enroll (planEnroll):
 * once the PC says it belongs to the account (the link went through), enrollPc. `fetch` is a session
 * signed in with the account key there. The PC's status gives this client no record to sign.
 */
export async function enrollOnPc(options: { fetch: PcFetch; store: AccountStore; account: string; serverId: string; others?: readonly AccountPeer[]; pc?: IntroducedPc; listed?: number; assertOwned?: () => Promise<void> }): Promise<Enrollment | null> {
  const status = await pcAccountStatus(options.fetch);
  if (status.account !== options.account) return null;
  return enrollPc({ ...options, legacyTarget: status.enrolling === undefined });
}

/** How long a kept add is sent again: the account service's mailbox keeps a record no longer. */
export const QUEUED_ADD_MS = 30 * 24 * 60 * 60_000;

/**
 * Sends the adds this device signed that some PCs' mailboxes have not taken (admitToAccount), and
 * forgets each PC the account service took it for. A refusal or a failure keeps the rest for the
 * next try; one of another account waits for its sign-in, and one older than the mailbox keeps a record is dropped.
 */
export async function sendQueuedAdds(options: { service: AccountService; store: AccountStore; account: string; now?: () => number }): Promise<void> {
  const now = (options.now ?? Date.now)();
  const queued = Object.values((await options.store.get("adds")) ?? {});
  for (const entry of queued) {
    const sent: string[] = [];
    if (entry.account === options.account && now - Date.parse(entry.record.issued_at) <= QUEUED_ADD_MS) {
      for (let start = 0; start < entry.to.length; start += 32) {
        const batch = entry.to.slice(start, start + 32);
        try { await options.service.postRecord(batch, entry.record); sent.push(...batch); }
        catch (error) { console.warn("Ovis: an approved device's add is kept for the next try", error instanceof Error ? error.name : error); }
      }
    }
    const keep = now - Date.parse(entry.record.issued_at) <= QUEUED_ADD_MS;
    await options.store.update("adds", (current) => {
      const rest = { ...current };
      const left = (rest[entry.record.id]?.to ?? []).filter((serverId) => !sent.includes(serverId));
      if (!keep || left.length === 0) delete rest[entry.record.id];
      else rest[entry.record.id] = { ...entry, to: left };
      return Object.keys(rest).length === 0 ? undefined : rest;
    });
  }
}

