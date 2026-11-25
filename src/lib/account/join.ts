/**
 * Every call goes through the PC's own session (`fetch` is that PC's transport), so the PC sees which of
 * its devices is asking.
 */
import { ACCOUNT_ENROLL_MAX, AccountRecordError, accountDeviceId, isAccountKeyEncoding, newRecordId, readAccountRecord, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord, LinkRecord, RemoveRecord } from "../../../shared/account-records.ts";
import { isWssOrigin } from "../../../shared/relay-offer.ts";
import type { RemotePairingRequest } from "../../../shared/protocol.ts";
import type { RelayDevice, RelayDeviceStore } from "../relay/device.ts";
import { keyIdOf } from "../relay/shellState.ts";
import { isListHash } from "../../../shared/account-list-entry.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList, AccountListView, ListOffer, ListWriter } from "./accountList.ts";
import { allowDevice, type AllowOutcome, type AllowRefusal, type AllowScope } from "./listAllow.ts";
import { holdsList } from "./listWrite.ts";
import type { AccountService, Admission } from "./service.ts";
import { vouchedPcName, type MemberPcEvidence } from "./vouched-pc.ts";
import type { AccountKey, AccountStore } from "./store.ts";

export type PcFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The PC refused an account request; `code` is its error code, never its words; `retryAfterMs`: the wait its `retry-after` named. */
export class AccountPcError extends Error {
  /** `firstLink`: the PC turned a marked pairing's first link away, and ended its row (firstLinkRefusal) */
  constructor(readonly status: number, readonly code: string, readonly retryAfterMs: number | null = null, readonly firstLink = false) {
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
  const seconds = Number(response.headers.get("retry-after") ?? Number.NaN);
  return new AccountPcError(response.status, code, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null);
}

export async function post(fetch: PcFetch, path: string, body: unknown): Promise<Response> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  if (!response.ok) throw await refusal(response);
  return response;
}

export interface PcAccountStatus {
  readonly pcAddFromAccount?: true | "unavailable";
  readonly account: string | null;
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
  /** it follows its account's list with no key of its own in it (it came in as the account moved): its add by the list gives it one */
  readonly needsKeys?: true;
  /** its account stopped listing it: only an add made at the PC brings it into one again, so a device sends it no link */
  readonly pcAddRequired?: true;
}

/** `fresh`: the PC reads its mailbox first, so a removal waiting there is counted (docs/account.md, "PC API"). */
export async function pcAccountStatus(fetch: PcFetch, options: { fresh?: boolean } = {}): Promise<PcAccountStatus> {
  const response = await fetch(options.fresh ? "/api/account/status?fresh=1" : "/api/account/status");
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { account?: unknown; unlinked?: unknown; removals?: unknown; adds?: unknown; blocked?: unknown };
  const unlinked = Array.isArray(body.unlinked) ? body.unlinked.filter((id): id is string => typeof id === "string") : [];
  return {
    account: typeof body.account === "string" ? body.account : null, unlinked,
    ...("pc_add_from_account" in body && (body.pc_add_from_account === true || body.pc_add_from_account === "unavailable")
      ? { pcAddFromAccount: body.pc_add_from_account } : {}),
    removals: Array.isArray(body.removals) ? body.removals : [], adds: Array.isArray(body.adds) ? body.adds : [],
    blocked: Array.isArray(body.blocked) ? body.blocked.filter(isAccountKeyEncoding) : [],
    // an Ovis from before enrollments sends no `fresh` at all
    ...(options.fresh && "fresh" in body ? { fresh: (body as { fresh?: unknown }).fresh === true } : {}),
    ...((body as { blocked_all?: unknown }).blocked_all === true ? { blockedAll: true } : {}),
    ...(typeof (body as { enrolling?: unknown }).enrolling === "boolean" ? { enrolling: (body as { enrolling: boolean }).enrolling } : {}),
    ...((body as { pc_add_required?: unknown }).pc_add_required === true ? { pcAddRequired: true as const } : {}),
    ...((body as { list?: { needs_keys?: unknown } | null }).list?.needs_keys === true ? { needsKeys: true as const } : {}),
  };
}

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

export const INTRODUCTION_MAX = 32;

/** Only an introduction whose id is its key's (server/relay/identity.ts) and whose relay is a wss origin. */
function parseIntroduced(value: unknown): IntroducedPc | null {
  if (typeof value !== "object" || value === null) return null;
  const pc = value as Record<string, unknown>;
  if (typeof pc.server_id !== "string" || typeof pc.server_public_key !== "string" || typeof pc.relay !== "string" || typeof pc.name !== "string") return null;
  if (keyIdOf(pc.server_public_key) !== pc.server_id || !isWssOrigin(pc.relay) || pc.name.length > 48) return null;
  return { server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.name };
}

/** The place in the account's signed list that the member who let a device in hands it, as an introduction carries it; null for none, or one out of form. */
function parseOffer(value: unknown): ListOffer | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, seq, hash } = value as Record<string, unknown>;
  return typeof id === "string" && isListHash(id) && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 1 && typeof hash === "string" && isListHash(hash) ? { list: id, seq, hash } : null;
}

/**
 * After a remote approval on PC X: the account's other PCs as the approver checked them, saved so
 * this device signs in to each with the account key and the id the `add` gave it there. A PC this
 * device already has is left as it is. X passes the list on, so only PCs on X's own relay are kept:
 * a list that names another relay would route this device through one X chose. Returns the PCs saved.
 */
export async function takeIntroduction(options: {
  fetch: PcFetch; key: AccountKey; label: string; store: RelayDeviceStore; relay: string;
  /** The place in the account's list that the member who let this device in left with the introduction, where it left one. */
  onList?: (offer: ListOffer) => void | Promise<void>;
}): Promise<RelayDevice[]> {
  const response = await options.fetch("/api/account/introduction");
  if (response.status === 404) return [];
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { pcs?: unknown; list?: unknown };
  const offer = options.onList === undefined ? null : parseOffer(body.list);
  if (offer !== null) await options.onList?.(offer);
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
  request: RemotePairingRequest; digits?: string | undefined; through: string; service: AccountService;
  pc?: MemberPcEvidence; shownPc?: string | null;
  decide: (decision: "approve" | "decline", digits?: string) => Promise<void>;
  /** with the admission that vouched for the device: its name is the one the device gave the account service, not the PC's */
  admit: (admission: Admission) => Promise<unknown>; now?: () => number;
  /** the admission the card showed, null when it showed none: approval goes ahead only for exactly that one */
  shown?: Admission | null;
  /**
   * For a join of the account through a PC that lets devices in by the account's signed list: runs once the
   * admission was checked and before anything is approved. A throw approves nothing, and the request stays to be
   * answered again.
   */
  before?: (admission: Admission) => Promise<void>;
}): Promise<void> {
  const { request } = options;
  if (request.vouched !== true && !options.digits) throw new UnverifiedJoinError();
  if (request.intent !== "account" && request.vouched !== true) { await options.decide("approve", options.digits); return; }
  const vouched = vouchedAdmission(await options.service.recentAdmissions(), options.through, request.key, (options.now ?? Date.now)());
  if (vouched === undefined) {
    await options.decide("decline");
    throw new UnverifiedJoinError();
  }
  // the device asked again with another name, system or place since the card was drawn: nothing is
  // answered, and the card shows the new details before anyone approves them
  if (options.shown !== undefined && (options.shown === null || !sameAdmission(options.shown, vouched))) throw new AdmissionChangedError();
  if (request.vouched === true) {
    if (request.intent !== "pc" || !options.pc || !options.shownPc || options.digits !== undefined || await vouchedPcName(options.service, { ...request, through: options.through }, options.pc) !== options.shownPc) {
      await options.decide("decline");
      throw new UnverifiedJoinError();
    }
    await options.decide("approve");
    return;
  }
  await options.before?.(vouched);
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
  store?: AccountStore;
  /**
   * For an account whose signed list this device holds: lets the new device into the list (listAllow.ts) and answers
   * its place there, which the introduction carries to it. It runs only once X holds the new device's row, so nobody
   * who did not confirm at X is signed into the list; until then X is asked with nothing to introduce.
   */
  allow?: () => Promise<ListOffer | null>;
  /**
   * The account's signed list holds the new device already, by this device's own copy, and X lets devices in by that
   * list: X keeps no row a member added for it, so the introduction is tried once, and whatever X refuses it for
   * does not hold the `add` for the account's other PCs back.
   */
  inList?: boolean;
  /**
   * For a device the list let in: throws unless this device's own copy, as it holds it now, still has the new device
   * in. Asked before the introduction that names the account's PCs and again before the `add` is signed, so nothing is
   * sent for a device another member put out while this approval waited on X.
   */
  holds?: () => void;
  /**
   * The place the list let the new device in at, where this device placed it already (on a PC that lets devices in by
   * the list): the introduction names it in that case too (formats E6), and a PC that follows the list drops it.
   */
  place?: ListOffer;
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
    if (options.allow === undefined) options.holds?.();
    const placed = options.allow === undefined && options.place !== undefined ? { list: { id: options.place.list, seq: options.place.seq, hash: options.place.hash } } : {};
    try { await post(options.fetch, "/api/account/introduce", { key: options.joining.key, pcs: options.allow === undefined ? pcs : [], ...placed }); break; }
    catch (error) {
      // X lets devices in by the list: it keeps no row a member added, and takes an introduction only from a device of its
      // own. The list holds the device already, so neither a refusal nor a request that failed holds the `add` back
      if (options.inList === true) {
        console.warn("Ovis: the PC that let the device in by the list took no introduction", error instanceof AccountPcError ? error.code : error instanceof Error ? error.name : error);
        break;
      }
      if (!(error instanceof AccountPcError)) throw error;
      // no row for that key on X yet: the new device has not confirmed its digits
      if (error.code !== "introduction_unknown_key") throw error;
      if (now() > deadline) throw error;
      await wait(ADMITTED_POLL_MS);
    }
  }
  if (options.allow !== undefined) {
    // the new device confirmed at X: now the list, and the introduction with the place it was let in at
    const offer = await options.allow();
    options.holds?.();
    await post(options.fetch, "/api/account/introduce", { key: options.joining.key, pcs, ...(offer === null ? {} : { list: { id: offer.list, seq: offer.seq, hash: offer.hash } }) });
  }
  options.holds?.();
  const add: AddRecord = await signAccountRecord({
    v: 1, kind: "add", account: options.account, key: options.joining.key, label: options.joining.label, role: "drive",
    issued_at: new Date(now()).toISOString(), id: newRecordId(), signer: options.key.public_spki,
  }, options.key.private_key);
  options.holds?.();
  // X keeps it on the row it made, so a client enrolling a later PC finds it there (docs/account.md, "PC API")
  try { await post(options.fetch, "/api/account/records", { records: [add] }); } catch (error) {
    console.warn("Ovis: the PC that let the device in did not keep its add", error instanceof Error ? error.name : error);
  }
  // and once more before it goes to the account's other PCs: a removal read while X took it stops it here
  options.holds?.();
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

/** A member let a device in on a PC, and the account's signed list did not take it: `why` says what the list or the account service answered. */
export class ListAllowError extends Error {
  /** `placed`: the list took the device before this was found, and what stopped is what was to follow its entry. */
  constructor(readonly why: AllowRefusal, readonly retryAfterMs: number | null, readonly placed = false) {
    super(`The device was not let into the account's list (${why})`);
    this.name = "ListAllowError";
  }
}

/**
 * The step of an approval that lets the device into the account's signed list, before the introduction: null where
 * this device follows no list or is not in it with power `full`, and then nothing is signed and the approval goes
 * on as for an account with no list. Otherwise the place to hand the new device, or a ListAllowError.
 */
export async function allowIntoList(list: AccountList | null, joining: { key: string; label: string; os: Admission["os"] }, options: { wait?: (ms: number) => Promise<void>; account?: string; scope?: AllowScope } = {}): Promise<ListOffer | null> {
  if (list === null) return null;
  const outcome: AllowOutcome = await allowDevice(list, joining, options);
  if (outcome.allowed) return outcome.offer;
  if (outcome.why === "no_list") return null;
  throw new ListAllowError(outcome.why, outcome.retryAfterMs);
}

/**
 * What a member does once the PC it approved on let the new device in. For an account whose signed list this device
 * is a full member of, the list comes first: the device signs the newcomer in (allowIntoList), and only then goes
 * on as ever (admitToAccount), with its place in the list in the introduction and the new entries handed to the PC.
 * Where the list does not take the newcomer, nothing else is signed for it and a ListAllowError says why: the
 * device stays let in at that PC alone. For any other account, and a device that is in no list, exactly
 * admitToAccount.
 */
export async function admitWithList(list: AccountList | null, options: Omit<Parameters<typeof admitToAccount>[0], "allow"> & {
  joining: { key: string; label: string; os: Admission["os"] };
  /** what the approval is bound to, kept by the card for every Try again (listAllow.ts AllowScope): the list and the member key of its first read */
  scope?: AllowScope;
}): Promise<AddRecord> {
  // Whether this device goes by a list is read from what it holds itself: the view this page drew, or the copy in its
  // own store. With neither it has no list to write to, and the approval goes as before lists, at once: it waits for
  // no answer of the account service's about lists, and nothing that fails there holds it back.
  const drawn = list?.view();
  const follows = list !== null && ((drawn !== undefined && drawn.account === options.account && holdsList(drawn)) || await list.follows(options.account).catch(() => false));
  if (list === null || !follows) {
    // a Try again of an approval that began with a list never takes the way from before lists: its list is gone from here
    if (options.scope?.list !== undefined) throw new ListAllowError("changed", null);
    return admitToAccount(options);
  }
  // The approval belongs to the account it was begun under. A page whose list is another account's by now (a sign-in
  // changed in another tab) signs nothing: neither into that list, nor by the way of an account with no list.
  const view = await list.sync();
  if (view.account !== options.account) throw new ListAllowError("changed", null);
  // what stops this device from writing is said before anything goes to the PC
  const began = beganOn(list, view, options.scope);
  // bound from this read on, before the wait for the PC's row: a key another tab puts on this device meanwhile signs nothing
  const scope: AllowScope = options.scope ?? { account: options.account };
  scope.list ??= began.list;
  scope.key ??= began.signer;
  let offer: ListOffer | null = null;
  const add = await admitToAccount({ ...options, allow: async () => {
    offer = await allowIntoList(list, options.joining, { account: options.account, scope, ...(options.wait === undefined ? {} : { wait: options.wait }) });
    // an account that turns out to have no list for this device to write (it lost its copy meanwhile) admits nobody the old way from here
    if (offer === null) throw new ListAllowError("blocked", null);
    return offer;
  }, holds: () => { holdsStill(list, began, options.joining.key, options.key.public_spki); } });
  const placed = offer as ListOffer | null;
  if (placed === null) return add;
  await handListToPc(options.fetch, list, { seq: placed.seq, hash: placed.hash }).then((handed) => {
    if (!handed) console.info("Ovis: the PC was not handed the list's new entries over this session; it reads them from the account service");
  }, (error: unknown) => { console.warn("Ovis: the PC was not handed the list's new entries", error instanceof Error ? error.name : error); });
  return add;
}

/**
 * What stops this device from writing its list, said before anything is signed or sent: the account service is away,
 * or the device's own copy stands in its way (it was put out, it is stopped, alarmed, or does not read).
 */
function mayWrite(list: AccountList, view: AccountListView): ListWriter {
  const writer = list.writer();
  if (writer === null) throw new ListAllowError(holdsList(view) && view.status.at === "following" && view.status.standing === "in" && view.status.trouble === null && !view.reached ? "unreached" : "blocked", null);
  if (!view.reached) throw new ListAllowError("unreached", null);
  return writer;
}

/** What an approval into the list is bound to from its first read on: the account, the list and the member key that signs for it. */
interface Began { readonly account: string; readonly list: string; readonly signer: string }

/** mayWrite, and what the approval is bound to from here on: what `scope` holds from an earlier try, else this read's. */
function beganOn(list: AccountList, view: AccountListView, scope?: AllowScope): Began {
  const writer = mayWrite(list, view);
  return { account: writer.account, list: scope?.list ?? writer.list, signer: scope?.key ?? writer.keys.key };
}

/**
 * Throws unless this device's own copy, as it holds it now, still has `key` in: in the list and under the member key
 * the approval began with, which is also the key the `add` would be signed by (`signer`). Asked before anything more
 * is sent for the new device after the list let it in, so a device another member put out meanwhile gets nothing.
 */
function holdsStill(list: AccountList, began: Began, key: string, signer: string): void {
  const view = list.view();
  const writer = list.writer();
  // asked only once the list took the device: what stops here is what was to follow its entry
  if (view.account !== began.account || view.status.at !== "following" || view.status.list !== began.list || signer !== began.signer
    || (writer !== null && (writer.list !== began.list || writer.keys.key !== began.signer))) throw new ListAllowError("changed", null, true);
  if (writer === null) throw new ListAllowError("blocked", null, true);
  if (!view.devices.some((device) => device.key === key)) throw new ListAllowError("removed", null);
}

/** A member pressed Approve for a join into the list before the new device's person said that the numbers match: nothing was approved or signed. */
export class NotConfirmedError extends Error {
  constructor() {
    super("The new device has not confirmed its digits yet");
    this.name = "NotConfirmedError";
  }
}

/**
 * What a member signs for a join on a PC that lets its account's devices in by the list alone (docs/account.md, "A
 * PC allows a device into the list"): such a PC signs nothing on a member's approval and lets the device in only by
 * an entry of the list, so the member signs that entry and hands it to the PC over the session. The PC tells the
 * device its place itself, in its AUTH_OK; nothing is introduced for it.
 *
 * The device that asks is not checked against a row of the PC's here, as an account with an unpinned PC is
 * (admitToAccount): a pinned PC makes no row before the list holds the key. Its caller signs only for a join the PC
 * says the new device confirmed (approveForAccount).
 *
 * Answers the place of the entry, or throws ListAllowError. A device that holds no list of the account cannot let
 * anybody into such a PC (`changed`).
 */
export async function allowOnPinnedPc(list: AccountList | null, options: {
  fetch: PcFetch; account: string; joining: { key: string; label: string; os: Admission["os"] }; wait?: (ms: number) => Promise<void>;
  /** what the approval is bound to across every Try again (listAllow.ts AllowScope) */
  scope?: AllowScope;
}): Promise<ListOffer> {
  const view = list === null ? null : await list.sync();
  if (list === null || view === null || view.account !== options.account || !holdsList(view)) throw new ListAllowError("changed", null);
  const offer = await allowIntoList(list, options.joining, { account: options.account, ...(options.scope === undefined ? {} : { scope: options.scope }), ...(options.wait === undefined ? {} : { wait: options.wait }) });
  if (offer === null) throw new ListAllowError("changed", null);
  await handListToPc(options.fetch, list, { seq: offer.seq, hash: offer.hash }).then((handed) => {
    if (!handed) console.info("Ovis: the PC was not handed the new device's entry over this session; it reads it from the account service");
  }, (error: unknown) => { console.warn("Ovis: the PC was not handed the new device's entry", error instanceof Error ? error.name : error); });
  return offer;
}

/**
 * One press of Approve on the card of a device that asks through PC X, from the check of its admission to what is
 * left to say afterwards (approveJoin, and what follows it for an account join).
 *
 * On a PC that lets its account's devices in by the list alone (the join is marked `list`, or X selected the list
 * for this session), the member signs only for a device whose person said that the numbers match: until X says so
 * (`confirmed`) nothing is approved and nothing signed (NotConfirmedError), so a device that gives up before that is
 * nobody's member. Nor is anything approved where this device cannot write the list (ListAllowError). Then the
 * approval, and right after it the device's entry, signed, placed and handed to X (allowOnPinnedPc), which waits
 * half a minute for it; then the `add` for the account's other PCs as ever.
 *
 * On any other PC the approval comes first and the list after it, once X holds the device's row (admitWithList).
 *
 * Either way, where the list does not take the device after the approval, its request is gone from X: `onStalled`
 * is told why, with a `retry` that tries the list again, and told null once the device is in.
 */
export async function approveForAccount(options: {
  request: RemotePairingRequest; digits: string; through: string; service: AccountService;
  /** the admission the card showed, null when it showed none (approveJoin) */
  shown?: Admission | null;
  decide: (decision: "approve" | "decline", digits?: string) => Promise<void>;
  /** the session to X this approval runs on, and whether X selected the list for it */
  pc: { fetch: PcFetch; followsList: boolean };
  /** the account the card was drawn under, its key on this device, and the page's copy of its list */
  account: string; key: Promise<AccountKey> | AccountKey; list: AccountList | null;
  paired: () => Promise<readonly RelayDevice[]>; directory: () => Promise<readonly string[]>; store?: AccountStore;
  /**
   * `pairedAtPc`: X let the device in by a pairing of its own, so it is in at X whatever the list says; false on a PC
   * that lets devices in by the list alone, where it is in nowhere that the list does not hold it. `placed`: the list
   * took the device, and what stopped is what was to follow its entry (the introduction, the `add`).
   */
  onStalled: (stalled: { label: string; why: AllowRefusal; retryAfterMs: number | null; pairedAtPc: boolean; placed: boolean; retry: () => Promise<void> } | null) => void | Promise<void>;
  wait?: (ms: number) => Promise<void>; now?: () => number;
}): Promise<void> {
  const { request, pc } = options;
  const pinned = request.intent === "account" && (request.list === true || pc.followsList);
  const joiningOf = (admission: Admission) => ({ key: request.key, label: admission.label, os: admission.os });
  const more = { ...(options.wait === undefined ? {} : { wait: options.wait }), ...(options.now === undefined ? {} : { now: options.now }) };
  /** On such a PC: the account, list and member key the approval began with, from the check before it on */
  let began: Began | null = null;
  /** What every try of the list is bound to, Try again included (listAllow.ts AllowScope): the account, and the list and member key of the first read */
  const scope: AllowScope = { account: options.account };
  await approveJoin({
    request, digits: options.digits, through: options.through, service: options.service, decide: options.decide,
    ...(options.shown === undefined ? {} : { shown: options.shown }), ...(options.now === undefined ? {} : { now: options.now }),
    ...(pinned ? { before: async () => {
      if (request.confirmed !== true) throw new NotConfirmedError();
      const view = options.list === null ? null : await options.list.sync();
      if (options.list === null || view === null || view.account !== options.account || !holdsList(view)) throw new ListAllowError("changed", null);
      began = beganOn(options.list, view);
      scope.list = began.list;
      scope.key = began.signer;
    } } : {}),
    admit: async (admission) => {
      const base = async () => ({
        fetch: pc.fetch, service: options.service, key: await options.key, account: options.account, joining: joiningOf(admission), through: options.through,
        paired: await options.paired(), directory: await options.directory(), ...(options.store === undefined ? {} : { store: options.store }), ...more,
      });
      const attempt = async (): Promise<void> => {
        try {
          if (pinned) {
            const place = await allowOnPinnedPc(options.list, { fetch: pc.fetch, account: options.account, joining: joiningOf(admission), scope, ...(options.wait === undefined ? {} : { wait: options.wait }) });
            // the list holds the device: the card that said otherwise goes, whatever the rest answers
            await options.onStalled(null);
            const rest = await base();
            const { list } = options;
            const bound = began;
            if (list === null || bound === null) throw new ListAllowError("changed", null);
            await admitToAccount({ ...rest, inList: true, place, holds: () => { holdsStill(list, bound, rest.joining.key, rest.key.public_spki); } });
            return;
          }
          await admitWithList(options.list, { ...await base(), scope });
          await options.onStalled(null);
        } catch (error) {
          // anything else failed after the list took the device (the introduction, the account's other PCs): the
          // card, which says that the list did not take it, goes, and the failure is the caller's to say
          if (!(error instanceof ListAllowError)) { await options.onStalled(null); throw error; }
          await options.onStalled({ label: admission.label, why: error.why, retryAfterMs: error.retryAfterMs, pairedAtPc: !pinned, placed: error.placed, retry: attempt });
        }
      };
      await attempt();
    },
  });
}

/** The most entries one call hands a PC. */
const PEER_PAGE_MAX = 256;
/** The most calls one hand-over makes after the first: a PC that keeps asking for another place is left to its own read. */
const PEER_ROUNDS = 8;

/**
 * Hands the PC this device is on the entries of the list that it does not hold yet, over the session, so that it
 * need not wait for its next read of the account service (docs/account-list.md, "Letting a device in"). It says
 * where it stands, sends the entries after the place the PC stands at, and where the PC asks for an earlier place,
 * sends from there, PEER_ROUNDS times at most. Entries prove themselves: the PC checks each one.
 *
 * True only when the PC says that it stands at `reach` or past it (the place of the entry this hand-over is for):
 * a page it took in part, or refused, is no hand-over. False for a PC that follows no list, another list, or that
 * does not answer in this form.
 */
export async function handListToPc(fetch: PcFetch, list: AccountList, reach?: ListPlace): Promise<boolean> {
  const mine = list.gossip();
  if (mine === null || mine.place === null) return false;
  const target = reach ?? mine.place;
  let theirs: { list?: unknown; place?: unknown };
  try {
    theirs = await (await post(fetch, "/api/account/list/head", mine)).json() as { list?: unknown; place?: unknown };
  } catch (error) {
    if (error instanceof AccountPcError) return false;
    throw error;
  }
  if (theirs.list !== mine.list) return false;
  // A place the PC names counts only where it is a place of this device's own history: the same number with another
  // entry at it is another history, and no proof that the PC holds the entry this hand-over is for.
  const seqOf = (place: unknown): number | null | undefined => {
    if (place === null) return null;
    const { seq, hash } = (place ?? {}) as { seq?: unknown; hash?: unknown };
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return undefined;
    return list.placeAt(seq)?.hash === hash ? seq : undefined;
  };
  let after = seqOf(theirs.place);
  if (after === undefined) return false;
  for (let rounds = 0; rounds < PEER_ROUNDS; rounds += 1) {
    if (after !== null && after >= target.seq) return true;
    const page = list.pageAfter(after, PEER_PAGE_MAX);
    // the page is of the list this hand-over began for: a copy replaced meanwhile hands nothing over this session
    if (page === null || page.entries.length === 0 || page.list !== mine.list) return false;
    let said: { verdict?: unknown; list?: unknown; place?: unknown; asks?: unknown };
    try {
      said = await (await post(fetch, "/api/account/list/page", page)).json() as typeof said;
    } catch (error) {
      if (error instanceof AccountPcError) return false;
      throw error;
    }
    // the PC wants an earlier place of the list first: that page goes next
    const asks = said.asks as { list?: unknown; after?: unknown } | undefined;
    const wanted = asks === undefined || asks === null ? undefined : asks.list === mine.list ? (asks.after === null ? null : typeof asks.after === "number" && Number.isSafeInteger(asks.after) && asks.after >= 0 ? asks.after : undefined) : undefined;
    if (asks !== undefined && asks !== null) {
      if (wanted === undefined || (wanted !== null && after !== null && wanted >= after)) return false;
      after = wanted;
      continue;
    }
    // a page the PC did not take is not handed, whatever place its answer names
    if (said.verdict !== "caught_up" && said.verdict !== "more" && said.verdict !== "older") return false;
    // where the PC stands now, as it says; a PC that does not say counts for what this page reached only when it took it whole
    const stands = said.place === undefined ? null : seqOf(said.place);
    if (stands === undefined) return false;
    const next: number | undefined = stands === undefined || stands === null ? (said.verdict === "caught_up" || said.verdict === "more" ? (after ?? -1) + page.entries.length : undefined) : stands;
    if (next === undefined || (after !== null && next <= after)) return false;
    after = next;
  }
  return after !== null && after >= target.seq;
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

export async function planEnroll(store: AccountStore, serverId: string, account: string): Promise<void> {
  await store.update("enrolls", (current) => ({ ...current, [serverId]: { account, done: [] } }));
}

/** A refusal that says nothing final about the record: the PC could not read its tombstones, so it is sent again. */
const UNDECIDED = new Set(["account_unavailable", "enrolling"]);

/** Another PC of the account this client is paired with, over a session signed in with the account key there. */
export interface AccountPeer { readonly serverId: string; readonly fetch: PcFetch; readonly assertOwned?: () => Promise<void> }

/** How long an enrollment waits for another PC of the account to say what it keeps out, before it counts that PC as not checked. */
export const PEER_STATUS_MS = 8_000;
const HELD_MAX = 4096;

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
    const pc = options.pc;
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
 * took them all (a device a PC does not know is skipped there).
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
 * device it does not know is skipped.
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

