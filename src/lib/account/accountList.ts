/**
 * This device and its account's signed list (docs/account-list.md, "On a device"): it keeps its own verified copy,
 * starts the list for an account that has nobody in it yet, and catches up on what the account service stores.
 *
 * The account service's answers are entries this device checks itself, or hints that only say what to read. Which
 * list is the account's is never the service's to say: this device follows a list only when entry 0 of that id is
 * a genesis of its account under its own account key, which nobody else can sign, or when a member that let it in
 * handed it the list id with its own place in it, and the log shows this device's key let in up to that very place.
 *
 * Nothing in the app decides by this copy yet: My PCs and what opens by itself still go by the account service.
 * What the two differ in is recorded (listShadow.ts).
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { listClock, type ListNames, type ListRole, type ListState } from "../../../shared/account-list.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import { entryFromText, entryHash, isListHash, ListEntryError, readBody, type SignerPower } from "../../../shared/account-list-entry.ts";
import {
  followStep, gossipHead, heardHead, pcOfKey, pinList, READ_PAGES_MAX, readSave, servePage, shownDevices, shownPcs, standing, startRead, takePage, writeSave,
  type FollowerCopy, type FollowerSelf, type FollowRead, type FollowVerdict, type ListHead, type ListPage as PeerPage, type SaveRefusal, type Standing,
} from "../../../shared/account-list-follower.ts";
import { LIST_WRAP_TEXT_LENGTH, type EpochKey } from "../../../shared/account-list-seal.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { standsFor } from "../../../shared/account-list-migrate.ts";
import { makeGenesis, type Genesis } from "./listGenesis.ts";
import { deviceCard, deviceListKeys, type DeviceListKeys } from "./listKeys.ts";
import { namesAt, openEpochs, readWraps, wrapsRecord, type OpenedEpochs } from "./listNames.ts";
import type { ListHint, ListWrap } from "./listAnswers.ts";
import { indexedListStore, listLock, type ListLock, type ListStore } from "./listStore.ts";
import { keepShadow, shadowOf, type ShadowRecord } from "./listShadow.ts";
import { inMacApp, inNativeApp } from "../nativeApp.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, PC_ADD_FRESH_MS, sameSignIn, SignedOutError, type AccountService, type DirectoryPc } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

/**
 * What stands between this device's copy and an honest log, the worst first. Each is a state a screen can show; none
 * of them takes anybody out of the copy.
 *
 * - `fork`: two histories of the list, each signed by a member. It stays until a person resets this device's copy.
 * - `stuck`: the account service shows another history under what this device already holds.
 * - `other_list`: the account service names another list for the account than the one this device follows.
 * - `refused`: the log holds an entry that no member would take.
 * - `unsigned`: the log holds an entry that no member signed. The account service places none, so it wrote this one.
 * - `wrong_key`: the account service handed this device a key to the names that is not the list's.
 * - `needs_newer_client`: the list holds an entry this build cannot place.
 */
export type ListTrouble = "fork" | "stuck" | "other_list" | "refused" | "unsigned" | "wrong_key" | "needs_newer_client";

/**
 * Why this device does not start a list for an account that may have one and has none.
 *
 * - `not_new`: this sign-in was made more than nine minutes ago: an account that was in use is not given a list this way.
 * - `not_first_device`: the account service numbered this sign-in's key other than first, or not yet at all.
 * - `has_pcs`: the account lists a PC, or this device holds a pairing linked to the account.
 * - `not_own_sign_in`, `frozen`, `session_not_fresh`: the account service takes no list from this sign-in.
 * - `refused`: the account service refused the entry itself.
 * - `clock`: it refused the entry for its time: this device's clock looks wrong.
 * - `storage`: what this page stores may be cleared by the browser at any time, and a list whose one member lost
 *   its keys lets nobody in: another device starts it.
 * - `switched_off`: this page was told to start none.
 */
export type NoGenesis = "not_new" | "not_first_device" | "has_pcs" | "not_own_sign_in" | "frozen" | "session_not_fresh" | "refused" | "clock" | "storage" | "switched_off";

/**
 * Where a device's claim of its own key stands, while it waits to be let in.
 *
 * - `claimed`: the account service took it, less than ten minutes ago.
 * - `unclaimed`: none was made yet, or the account service was not reached.
 * - `not_own_sign_in`, `frozen`, `session_not_fresh`: the account service takes no claim from this sign-in. A sign-in
 *   older than ten minutes with no registered key signs in again.
 * - `refused`: the account service refused the claim itself.
 */
export type ListClaimState = "claimed" | "unclaimed" | "not_own_sign_in" | "frozen" | "session_not_fresh" | "refused";

/** What a device that holds no copy is at. */
type Without =
  /** Not signed in, the account service keeps no list for this account, or it has not been reached yet. */
  | { readonly at: "off" }
  /** The account may have a list, has none, and this device starts none. */
  | { readonly at: "none"; readonly why: NoGenesis }
  /**
   * The account service names a list that this device does not follow, and it reads no more of it than entry 0.
   * - `not_mine`: entry 0 is that list's and is not this device's own: it is in no list until a member lets it in.
   * - `unread`: the account service did not show the entry 0 of the list it names. It is asked again.
   * - `needs_newer_client`: entry 0 is in a form this build cannot read.
   * `claim`: whether the account service holds this device's claim of its own key for that list, without which no
   * member's entry for the key is placed.
   */
  | { readonly at: "not_in"; readonly list: string; readonly why: "not_mine" | "unread" | "needs_newer_client"; readonly claim: ListClaimState };

export type AccountListStatus =
  | Without
  /** What this device saved does not read. It is kept as it is, and nothing takes its place by itself. */
  | { readonly at: "damaged"; readonly why: Exclude<SaveRefusal, "version"> }
  /** What this device saved was written by a later build of the app, which this one cannot read: it needs a newer app. Kept as it is. */
  | { readonly at: "newer_save" }
  /** `head`: the place of the last entry of the copy. `read_at`: when it last held all the account service showed, in seconds. */
  | { readonly at: "following"; readonly list: string; readonly standing: Standing; readonly head: number; readonly read_at: number | null; readonly trouble: ListTrouble | null };

/** A device of the account, as the verified list says. `name` is null where this device cannot open it. */
export interface ListedDevice {
  readonly key: string;
  readonly self: boolean;
  readonly power: SignerPower;
  readonly role: ListRole;
  readonly until: number | null;
  readonly carried: boolean;
  readonly name: ListNames | null;
  /**
   * For a device that is in by a key it handed its place on to (a `device` entry that ended the key that signed it):
   * when, in seconds, by that entry's own time. The same device, which a screen shows as moved to a new key.
   */
  readonly moved?: number;
}

/** A PC of the account, as the verified list says, by its relay key; `server_id` is the id that key gives. */
export interface ListedPc {
  readonly endpoint: string;
  readonly server_id: string;
  readonly how: "added" | "joined" | "carried";
  /** A person at it can allow a device. */
  readonly allows: boolean;
  readonly name: ListNames | null;
  /** The place of the entry that brought it in. */
  readonly seq: number;
  /** The key that signed that entry: a device, a PC, or the invite the PC joined with by itself. */
  readonly by: string | null;
  /**
   * When this device first held that entry, in seconds by its own clock, for a PC that came in after this device did
   * and that it did not sign for itself: such a PC is new to this device from then on, however long ago it was added.
   * Null for any other PC.
   */
  readonly new_at: number | null;
}

/**
 * The devices and PCs that are in, in the order they came in: none unless this device follows the list and is in it.
 * `reached`: the last round got the account service's answers; without them the view is what this device saved.
 */
export interface AccountListView {
  readonly account: string | null;
  readonly status: AccountListStatus;
  readonly reached: boolean;
  readonly devices: readonly ListedDevice[];
  readonly pcs: readonly ListedPc[];
  /**
   * This device's own key was handed on to another key by an entry this device did not make (its key signed it
   * elsewhere): the list goes by `to` now, and this device signs nothing by its own key any more.
   */
  readonly handedAway?: { readonly to: string };
}

export type GenesisMode = "first-device" | "always" | "never";

/**
 * The developer's switch: `localStorage["ovis-account-list-genesis"]` set to `always` starts a list for an account
 * that already has PCs or other devices (they are not carried into it), and `never` starts none.
 */
export const GENESIS_SWITCH = "ovis-account-list-genesis";

export function genesisSwitch(): GenesisMode {
  try {
    const set = globalThis.localStorage?.getItem(GENESIS_SWITCH);
    return set === "always" || set === "never" ? set : "first-device";
  } catch { return "first-device"; }
}

export interface AccountListOptions {
  readonly service: AccountService;
  readonly accountStore: AccountStore;
  readonly listStore?: ListStore;
  readonly lock?: ListLock;
  /** This device's clock, in ms. */
  readonly now?: () => number;
  /** This device's name and OS, which a genesis seals; null seals none. */
  readonly names?: () => ListNames | null;
  /** How many of the PCs this device saved are linked to the account. */
  readonly linkedPcs?: (account: string) => Promise<number>;
  readonly genesis?: () => GenesisMode;
  /** Whether what this page stores lasts (storageLasts): a device starts a list by itself only where it does. */
  readonly durable?: () => Promise<boolean>;
}

/**
 * Whether what this page stores lasts: inside the app, or where the browser already says that it keeps this site's
 * data. The browser is never asked to keep it (that prompts in some): a tab whose data may go waits for another device.
 */
export async function storageLasts(): Promise<boolean> {
  if (inNativeApp() || inMacApp()) return true;
  try { return await globalThis.navigator?.storage?.persisted?.() === true; } catch { return false; }
}

/** A device asks again this often, in seconds, while the account has no list or it is in none. */
export const NO_LIST_SECONDS = 300;
/**
 * How long the account service's word that it keeps no list for an account stands, in seconds: the device asks no
 * more often than this, whatever page asks and however often the app starts.
 */
export const OFF_SECONDS = 24 * 60 * 60;
/**
 * How long a device waits, in seconds, after one, two, three and more rounds in a row that did not reach the account
 * service: a service that is away or has no such routes is not asked every five minutes for good.
 */
export const UNREACHED_SECONDS: readonly number[] = [300, 900, 3600, 6 * 3600];
/** A claim lasts ten minutes at the account service: a device that waits to be let in makes it again once it is this old, in seconds. */
export const CLAIM_RENEW_SECONDS = 240;
/** A request of a round ends after this long. Each page of the log has this long of its own. */
const ROUND_MS = 30_000;
/**
 * A round asks for no further page of the log once it has read for this long: it holds the lock that another tab's
 * round waits for. Every page it took by then is saved, and the next round goes on from there.
 */
const READ_MS = 30_000;
/** How often one round loads the copy again after another page saved one under it. */
const SAVE_TRIES = 3;

/** Another page saved the account's copy while this one worked on the copy it had read: this one's is not written. */
class StaleCopyError extends Error {
  constructor() {
    super("Another page saved the list meanwhile");
    this.name = "StaleCopyError";
  }
}

const RECORD_VERSION = 1;
const OFF: AccountListView = { account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A genesis this device signed and has not seen in its saved copy, with the key it was signed with. */
type PendingGenesis = Genesis & { readonly key: string };

/** The hash of an entry's text, or null for a text that is no entry. */
function hashOf(text: string | undefined): string | null {
  if (text === undefined) return null;
  try {
    return entryHash(entryFromText(text).body);
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
}

/** When the account service said that it keeps no list for the account, in seconds, as this device kept it; null for no such record. */
function readOff(value: unknown): number | null {
  return isRecord(value) && value.v === RECORD_VERSION && typeof value.off_at === "number" && Number.isSafeInteger(value.off_at) && value.off_at >= 0 ? value.off_at : null;
}

/** The place a member handed this device, as it kept it; null for no such record. */
/** When this device first held the entry of each PC that is new to it, by relay key: the entry's place and the time in seconds. */
type SeenPcs = Readonly<Record<string, readonly [number, number]>>;

function readSeen(value: unknown, list: string): SeenPcs {
  if (!isRecord(value) || value.v !== RECORD_VERSION || value.list !== list || !isRecord(value.pcs)) return {};
  const seen: Record<string, readonly [number, number]> = {};
  for (const [endpoint, at] of Object.entries(value.pcs)) {
    if (Array.isArray(at) && at.length === 2 && Number.isSafeInteger(at[0]) && Number.isSafeInteger(at[1])) seen[endpoint] = [at[0] as number, at[1] as number];
  }
  return seen;
}

/** The key that signed the entry at `seq`, or null for an entry that does not read. */
function signerAt(entries: readonly string[], seq: number): string | null {
  const text = entries[seq];
  if (text === undefined) return null;
  try {
    return readBody(entryFromText(text).body).signer;
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
}

function readOffer(value: unknown): ListOffer | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION) return null;
  const { list, seq, hash } = value;
  return typeof list === "string" && isListHash(list) && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 1 && typeof hash === "string" && isListHash(hash) ? { list, seq, hash } : null;
}

/** The ids of the entries 0 this device signed and gave up for good: the account has another list, or the account service refused them. */
function readDropped(value: unknown): string[] {
  return isRecord(value) && value.v === RECORD_VERSION && Array.isArray(value.lists) ? value.lists.filter((list): list is string => typeof list === "string" && isListHash(list)) : [];
}

function readPending(value: unknown, keys: DeviceListKeys): PendingGenesis | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION) return null;
  const { key, enc, list, entry, wrap } = value;
  if (key !== keys.key || enc !== keys.enc.key || typeof list !== "string" || !isListHash(list) || typeof entry !== "string" || typeof wrap !== "string" || wrap.length !== LIST_WRAP_TEXT_LENGTH) return null;
  return hashOf(entry) === list ? { key, enc, list, entry, wrap } : null;
}

/** The account service's own refusal of a request, as against no answer or a refresh that failed. */
const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);

/**
 * The account service gave no answer this round can use: it is away, slow, refused, or sent something out of form,
 * a body that is no JSON (cut off on the way) included. What the device saved stands then.
 */
function unreached(error: unknown): boolean {
  return error instanceof AccountServiceError || error instanceof AccountServiceUnreachableError || error instanceof SyntaxError
    || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));
}

function troubleOf(verdict: FollowVerdict): ListTrouble | null {
  switch (verdict) {
    case "fork": return "fork";
    case "stuck": return "stuck";
    case "not_my_list": return "other_list";
    case "refused": return "refused";
    case "needs_newer_client": return "needs_newer_client";
    default: return null;
  }
}

const WORST: readonly ListTrouble[] = ["fork", "stuck", "other_list", "refused", "unsigned", "wrong_key", "needs_newer_client"];
const worst = (troubles: readonly (ListTrouble | null)[]): ListTrouble | null => WORST.find((trouble) => troubles.includes(trouble)) ?? null;

/**
 * Whether two copies of one list hold the same entries, stop and alarm: they then differ in nothing but when they were
 * last read in full and the floor of the clock, which are kept in a record of their own (`times`). Each entry names
 * the one before it by its hash, so the same last entry at the same place is the same history, and the state is what
 * the entries give.
 */
function sameHistory(a: FollowerCopy, b: FollowerCopy): boolean {
  return a.list === b.list && a.entries.length === b.entries.length && a.entries.at(-1) === b.entries.at(-1) && a.stop === b.stop
    && (a.state === null) === (b.state === null) && JSON.stringify(a.alarm) === JSON.stringify(b.alarm);
}

/** When a copy of `list` was last read in full and the floor of its clock, as kept beside the copy; null for no such record. */
function readTimes(value: unknown, list: string): { readonly read_at: number | null; readonly seen_at: number | null } | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION || value.list !== list) return null;
  const time = (at: unknown): number | null | undefined => at === null ? null : typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : undefined;
  const [read_at, seen_at] = [time(value.read_at), time(value.seen_at)];
  return read_at === undefined || seen_at === undefined ? null : { read_at, seen_at };
}

const later = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : Math.max(a, b);

/** How far under the latest time it saved a device's clock may read before it signs nobody out for a time that is over. */
const ADRIFT_SECONDS = 600;

/** A kept request (KeptRequest) as its record holds it; null for none, one out of form, or one that was let go. */
function readKept(value: unknown): KeptRequest | null {
  if (typeof value !== "string") return null;
  let read: unknown;
  try { read = JSON.parse(value); } catch { return null; }
  if (!isRecord(read) || read.v !== RECORD_VERSION || read.let_go === true) return null;
  const place = (at: unknown): { seq: number; hash: string } | null => isRecord(at) && typeof at.seq === "number" && Number.isSafeInteger(at.seq) && at.seq >= 0 && typeof at.hash === "string" && isListHash(at.hash) ? { seq: at.seq, hash: at.hash } : null;
  const [on, last] = [place(read.on), place(read.place)];
  const { list, key, entries, wraps } = read;
  if (typeof list !== "string" || !isListHash(list) || typeof key !== "string" || on === null || last === null) return null;
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every((text) => typeof text === "string") || !Array.isArray(wraps)) return null;
  if (!wraps.every((wrap) => isRecord(wrap) && typeof wrap.epoch === "number" && typeof wrap.member === "string" && typeof wrap.wrap === "string")) return null;
  return { list, key, on, entries: entries as string[], wraps: wraps as KeptRequest["wraps"], place: last, for: typeof read.for === "string" ? read.for : null, at: typeof read.at === "number" && Number.isSafeInteger(read.at) ? read.at : 0 };
}

/** Whether a kept request was signed by `writer`'s key on the very head `writer` holds. */
const sameHead = (kept: KeptRequest, writer: ListWriter): boolean =>
  kept.list === writer.list && kept.key === writer.keys.key && kept.on.seq === writer.state.footing.seq && kept.on.hash === writer.state.footing.hash;

/** One account's list in this page's memory. */
interface Held {
  readonly account: string;
  readonly copy: FollowerCopy | null;
  /** The text the copy was saved as, by which this page sees that another page wrote since. */
  readonly saved: string | null;
  /** What the last read said is wrong: it stands until a read ends otherwise. */
  readonly trouble: ListTrouble | null;
  /** Where the device is while it holds no copy. */
  readonly without: Without;
  /** The round that gave this did not get the device's own log read: it counts as one that did not reach the account service. */
  readonly unread?: true;
  /** The round that gave this took pages of the log and left some: the next one goes on at once. */
  readonly behind?: true;
}

/**
 * What a copy holds, whatever the hour it was saved at: its list, how many entries, the last one, its stop and its
 * alarm. The names and the wraps go by this, not by the saved text, which changes with every round's times.
 */
const historyOf = (copy: FollowerCopy): string => JSON.stringify([copy.list, copy.entries.length, copy.entries.at(-1) ?? null, copy.stop, copy.alarm]);

/** The members of one history (historyOf) with their names as far as they opened: they change only with the entries or with the wraps this device holds. */
interface Named {
  readonly history: string;
  /** The current epoch's key opened: there is no wrap left to ask for. */
  readonly complete: boolean;
  readonly devices: readonly ListedDevice[];
  readonly pcs: readonly ListedPc[];
  /** The epoch keys that opened, in memory for as long as the page holds this copy. */
  readonly keys: ReadonlyMap<number, EpochKey>;
}

/**
 * What a device signs an entry on (listAllow.ts): its own state as the log last showed it, its keys, the epoch keys it
 * holds, and the two times it needs. Only for a device that follows the list, is in it with power `full`, and was
 * shown no other history.
 */
export interface ListWriter {
  readonly account: string;
  readonly list: string;
  readonly state: ListState;
  readonly keys: DeviceListKeys;
  readonly epochs: ReadonlyMap<number, EpochKey>;
  /**
   * The time by which the device signs: whose time is over, and whether names may be sealed, in seconds. Its own clock,
   * never less than the list's own time, and never the latest time it saved (`shown`) nor the account service's.
   */
  readonly clock: number;
  /** The time an entry is dated, in seconds: the device's own clock. */
  readonly issued_at: number;
  /**
   * The time by which this device shows whose time is over and judges what a press admits, in seconds: its own clock,
   * never less than the latest time it saved and the list's own time. It signs nothing: `clock` alone does.
   */
  readonly shown: number;
  /**
   * This device's clock reads more than ten minutes under the latest time it saved. It cannot tell which of the two
   * is wrong, so it signs nobody out for a time that is over (no clean-up removal); what a person asked for goes on.
   */
  readonly adrift: boolean;
  readonly service: AccountService;
}

/**
 * A request this device signed for a place of its list and has not seen placed. It is the one signature for that
 * place: kept in the device's own store before it is sent, and sent again, by this page or another, by this call or
 * a later one, until the device's own copy shows a new head or the account service proved that it placed nothing.
 */
export interface KeptRequest {
  readonly list: string;
  /** The member key that signed it. */
  readonly key: string;
  /** The head it was signed on. */
  readonly on: { readonly seq: number; readonly hash: string };
  readonly entries: readonly string[];
  readonly wraps: readonly { readonly epoch: number; readonly member: string; readonly wrap: string }[];
  /** The place of its last entry. */
  readonly place: { readonly seq: number; readonly hash: string };
  /** What it was signed for (WriteOptions.operation); null where the writer named nothing. */
  readonly for: string | null;
  /** When it was kept, in seconds, by this device's clock. */
  readonly at: number;
}

/** A request that waits, as a card names it: which account's, and the list, signer, head and place it was signed for, with no entry of it. */
export type WaitingRequest = Pick<KeptRequest, "list" | "key" | "on" | "place" | "for" | "at"> & { readonly account: string };

/** Whether what waits now is the very request a card was shown for. */
export const sameWaiting = (one: WaitingRequest | null, other: WaitingRequest | null): boolean => one !== null && other !== null
  && one.account === other.account && one.list === other.list && one.key === other.key && one.on.seq === other.on.seq && one.on.hash === other.on.hash && one.place.hash === other.place.hash;

/** A place in a list as a member hands it to a device it let in: the list id and the member's own head. */
export interface ListOffer {
  readonly list: string;
  readonly seq: number;
  readonly hash: string;
}

/** A round that reached the account service: what it may still ask with. */
interface Asking { readonly bound: AccountService; readonly signal: AbortSignal }

export interface AccountList {
  /**
   * One round for the sign-in stored now: reads what is saved, asks the account service, takes what it shows, saves,
   * and resolves to the view after it. Asked while a round is under way, it waits for that one and runs one more,
   * since the sign-in may have changed under it. An account service that is away, slow or lying is a state of the
   * view; only a sign-in that ended throws (SignedOutError).
   */
  sync(options?: { /** read the log past this device's head whatever head the account service names: after a write whose outcome only the log says */ readonly read?: boolean }): Promise<AccountListView>;
  /**
   * Whether this device keeps a copy of a list of the account, read from its own store alone: it then goes by that
   * list, before the account service said anything and whatever it says.
   */
  follows(account: string): Promise<boolean>;
  /** The request this device signed on the head `writer` holds and has not seen placed (KeptRequest); null where it kept none for that head. */
  kept(writer: ListWriter): Promise<KeptRequest | null>;
  /**
   * Keeps `request` as the one signed on `writer`'s head, before it is sent, and answers the request that stands for
   * that head: this one, or the one another page kept first, which is then the one to send.
   */
  keep(writer: ListWriter, request: Pick<KeptRequest, "entries" | "wraps" | "place" | "for">): Promise<KeptRequest>;
  /** Lets `request` go: the account service proved that it placed nothing of it, or its time ran out, so another may be signed on that head. */
  unkeep(account: string, request: KeptRequest): Promise<void>;
  /** The request kept for the head this device holds now, if one still waits: what it is for, when it was kept (seconds, this device's clock), and what names it. */
  waiting(): Promise<WaitingRequest | null>;
  /**
   * Lets `request` go, at the person's word (Cancel on the card that was shown for it): another change may then be
   * signed on that head. A request that waits in its place by now, signed for another change, is left as it is.
   *
   * The log is read first, past this device's head: `placed`, the request's entry is in the list, and there was
   * nothing to cancel; `unread`, the log could not be read, so whether it was placed is not known and nothing is let
   * go; `gone`, it waits no more (let go now, or the head moved under it, or it was another's by now).
   */
  cancel(request: WaitingRequest): Promise<"gone" | "placed" | "unread">;
  view(): AccountListView;
  /**
   * The time by which this device shows whose time is over and judges what a press admits, in seconds: its own clock,
   * never less than the latest time it saved and the list's own time (ListWriter.shown); its own clock where it holds
   * no list. A date set back after a time ran out shows nobody as in again. It signs nothing.
   */
  shown(): number;
  /** Hears each view that differs from the one before. */
  subscribe(listener: (view: AccountListView) => void): () => void;
  /** Whether the PC with this relay key (64 hex) is in the list as this device holds it. */
  holdsPc(endpoint: string): boolean;
  /** The relay key of the PC that signs with this key, when that PC is in the list as this device holds it; null otherwise. */
  pcOfKey(key: string): string | null;
  /** When the next round is due, in ms by this device's clock, given whether the app is in front; null for not by the clock. */
  due(inFront: boolean): number | null;
  /**
   * Holds the view against the account service's directory, read for `account`, and keeps what they differ in
   * (listShadow.ts); null where there is nothing to compare. `opens`: the ids of the PCs the app would open by itself.
   */
  shadow(account: string, directory: readonly DirectoryPc[], opens?: ReadonlySet<string>): Promise<ShadowRecord | null>;
  /**
   * The sign-in ended, and the device is still a member with the key it has: forgets what opens the account's names
   * (the wraps, and a genesis that was not seen placed). The copy stays, so that a later sign-in takes up where this
   * one stood and no older log passes for the list. The wraps are asked for again then.
   */
  dropNames(account: string): Promise<void>;
  /**
   * A person's reset, or the device left the account: forgets everything kept for the account. With `member`, only
   * where the saved copy is pinned to that member key, compared with the very copy that is dropped: a copy that a
   * member which took this one's place keeps (another tab signed in again) stays, and so does one that does not read.
   */
  forget(account: string, member?: string): Promise<void>;
  /**
   * The other account than `account` whose saved copy of its list is pinned to this member key and does not show it
   * out (that account's list still holds this device by it), or null for none. A copy that does not read counts as
   * holding it.
   */
  pinnedElsewhere(account: string, key: string): Promise<string | null>;
  /**
   * A member that let this device in handed it this place, over the PC the device compared digits with. It is kept
   * as an offer, and a round follows: the device follows that list only once the log shows its own key let in up to
   * that very entry, and until then it follows nothing. A device that follows a list already takes no offer.
   * `account`: the account the place was handed for (the join's own). A sign-in that ended meanwhile keeps the offer for
   * that account, and the first round of a sign-in to it takes it up; without it, the offer is the stored sign-in's.
   */
  adopt(offer: ListOffer, account?: string): Promise<AccountListView>;
  /**
   * What this device signs an entry on, or null: it follows no list, is not in it with power `full`, or was shown
   * another history. `self`: for the removal of this device's own key, which a device of any power may sign (a
   * borrowed browser that signs out): only the power is not asked, and the kinds refuse whatever else it would sign.
   */
  writer(options?: { readonly self?: boolean }): ListWriter | null;
  /** The place of the entry at `seq` in this device's copy, or null where the copy does not reach it. */
  placeAt(seq: number): ListPlace | null;
  /** Whether this device's copy holds that entry at that place: its own entry is in its copy only once the log showed it. */
  holdsEntry(place: ListPlace): boolean;
  /** Where this device stands, to tell another member: the list id and the last entry a member signed in its copy; null while it follows none. */
  gossip(): ListHead | null;
  /** This device's entries after a place, for another member to take: at most `limit`, up to the last one a member signed; null while it follows none. */
  pageAfter(after: number | null, limit: number): PeerPage | null;
}

export function accountList(options: AccountListOptions): AccountList {
  const { service, accountStore } = options;
  const store = options.listStore ?? indexedListStore;
  const lock = options.lock ?? listLock;
  const now = options.now ?? Date.now;
  const seconds = (): number => Math.floor(now() / 1000);
  const listeners = new Set<(view: AccountListView) => void>();
  let held: Held | null = null;
  let named: Named | null = null;
  /** The account whose wraps, at the last time they were asked for, held a key that is not the list's. */
  let wrongKey: string | null = null;
  /** The copy the wraps were last asked for, and when: they are asked for again for another copy, or after NO_LIST_SECONDS. */
  let wrapsAsked: { readonly history: string; readonly at: number } | null = null;
  let shown: AccountListView = OFF;
  let askedAt: number | null = null;
  /** The account the pacing below is counted for. */
  let pacedFor: string | null = null;
  /** The next read of the list reads its log whatever head the account service names (sync's `read`). */
  let readAsked = false;
  /** The last round took pages of the log and left some: the next one is due at once. */
  let behind = false;
  /** The round under way and what ends it. */
  let roundStop: { readonly account: string; readonly stop: AbortController } | null = null;
  /** Rounds in a row that did not reach the account service. */
  let misses = 0;
  /** When the account service last said that it keeps no list for the account in view, in seconds; null otherwise. */
  let offAt: number | null = null;
  /** The list this device last claimed its key for, and when, in seconds. */
  let claimedAt: { readonly account: string; readonly list: string; readonly key: string; readonly at: number } | null = null;
  /** The keys and the sign-in of the last round, for a writer. */
  let ctx: { readonly account: string; readonly keys: DeviceListKeys; readonly bound: AccountService } | null = null;
  let running: Promise<AccountListView> | null = null;
  /** The one round that follows the round under way, for whoever asked meanwhile: the sign-in may have changed under it. */
  let queued: Promise<AccountListView> | null = null;

  const publish = (view: AccountListView): AccountListView => {
    const same = JSON.stringify(view) === JSON.stringify(shown);
    shown = view;
    if (!same) for (const listener of listeners) listener(view);
    return view;
  };

  /** The saved copy as this page holds it: read again only when another page wrote since. */
  const load = async (account: string, keys: DeviceListKeys, saved: unknown): Promise<Held | SaveRefusal> => {
    const fresh: Held = { account, copy: null, saved: null, trouble: null, without: held?.account === account ? held.without : { at: "off" } };
    if (saved === undefined) return fresh;
    if (typeof saved !== "string") return "form";
    // the copy this page holds, while it is the one saved and this device's key is the one it was pinned under
    if (held !== null && held.account === account && held.saved === saved && held.copy !== null && held.copy.me.key === keys.key) {
      // with what another page kept beside the copy since: its last full read, and the floor of its clock
      const beside = readTimes(await store.get("times", account), held.copy.list);
      const [read_at, seen_at] = [later(held.copy.read_at, beside?.read_at ?? null), later(held.copy.seen_at, beside?.seen_at ?? null)];
      return read_at === held.copy.read_at && seen_at === held.copy.seen_at ? held : { ...held, copy: { ...held.copy, read_at, seen_at } };
    }
    const read = await readSave(saved);
    if (!read.read) return read.why;
    // saved under another account key: this device has a new one since, and is another member
    if (read.copy.me.key !== keys.key || read.copy.me.endpoint !== null) {
      // what goes is the very copy that was read: one another page saved since, under the key of now, stays
      if (!await store.drop(account, saved)) throw new StaleCopyError();
      return fresh;
    }
    if (read.copy.account !== account) return "broken";
    // the entries gave another state than the one saved with them (another build's, as after an update): the copy is
    // written again as this build writes it, once
    const text = read.rebuilt ? writeSave(read.copy) : saved;
    if (read.rebuilt) {
      if (!await store.swap("copy", account, saved, text)) throw new StaleCopyError();
      console.info("Ovis: the account's list was read again from its entries, and saved as this build saves it");
    }
    // with the later of what the copy says and what was kept beside it since, of its last full read and its clock's floor
    const times = readTimes(await store.get("times", account), read.copy.list);
    const copy: FollowerCopy = times === null ? read.copy : { ...read.copy, read_at: later(read.copy.read_at, times.read_at), seen_at: later(read.copy.seen_at, times.seen_at) };
    return { ...fresh, copy, saved: text };
  };

  /**
   * Saves a copy that differs from the one this page read in its entries, its stop or its alarm. It is written only
   * over the very text this page read (`before`): where another page saved meanwhile, nothing is written and the
   * round reads again (StaleCopyError), so no page's save goes over a newer one, or over an alarm.
   *
   * The time of its last full read and the floor of its clock move with every round that reached the account
   * service. They go into a small record of their own, so that such a round does not write a long copy again.
   */
  /**
   * A small record kept beside the copy (the round's times, the epoch keys it opened, when it first saw a PC): where
   * the store does not take it (a full disk), the round goes on with what it holds in memory. None of them is what
   * the device goes by: without them it asks again, or counts a PC as new for longer. The copy itself is never
   * written this way.
   */
  const beside = async (what: string, write: () => Promise<unknown>): Promise<void> => {
    try { await write(); } catch (error) {
      console.warn(`Ovis: ${what} could not be saved beside the account's list; the round goes on without`, error instanceof Error ? error.name : error);
    }
  };

  const save = async (before: { readonly copy: FollowerCopy | null; readonly saved: string | null }, copy: FollowerCopy): Promise<string> => {
    if (before.copy !== null && before.saved !== null && sameHistory(before.copy, copy)) {
      if (before.copy.read_at !== copy.read_at || before.copy.seen_at !== copy.seen_at) {
        // never back: another page may have read later
        const kept = readTimes(await store.get("times", copy.account), copy.list);
        await beside("its times", () => store.set("times", copy.account, { v: RECORD_VERSION, list: copy.list, read_at: later(kept?.read_at ?? null, copy.read_at), seen_at: later(kept?.seen_at ?? null, copy.seen_at) }));
      }
      return before.saved;
    }
    const text = writeSave(copy);
    if (text === before.saved) return text;
    if (!await store.swap("copy", copy.account, before.saved ?? undefined, text)) throw new StaleCopyError();
    return text;
  };

  /** `signed`: this device signed an entry 0 that it has not seen placed, while its sign-in was new: it is sent again however old the sign-in is by then. */
  const mayStart = async (bound: AccountService, session: AccountSession, signed: boolean, signal: AbortSignal): Promise<NoGenesis | null> => {
    const mode = (options.genesis ?? genesisSwitch)();
    if (mode === "never") return "switched_off";
    if (mode === "first-device") {
      const age = session.signed_in_at === undefined ? Number.NaN : now() - session.signed_in_at;
      if (!signed && !(age >= 0 && age <= PC_ADD_FRESH_MS)) return "not_new";
      if (!signed && !await (options.durable ?? storageLasts)()) return "storage";
      const kept = await accountStore.get("signin_key");
      if (kept === undefined || kept.account !== session.account || kept.sign_in_id !== session.sign_in_id || kept.no !== 1) return "not_first_device";
      if (await (options.linkedPcs?.(session.account) ?? Promise.resolve(0)) > 0) return "has_pcs";
    }
    if (!await bound.ownSignIn(signal)) return "not_own_sign_in";
    if (mode === "first-device" && (await bound.listPcs(signal)).length + (await bound.listUnconfirmedPcs(signal)).length > 0) return "has_pcs";
    return null;
  };

  /**
   * Gives up an entry 0 this device signed, for good: it is kept no more to send, and its id is written down, so the
   * device never follows that list, whoever names it later and whatever page of the app is asked.
   */
  const giveUp = async (account: string, list: string): Promise<void> => {
    const dropped = readDropped(await store.get("dropped", account));
    if (!dropped.includes(list)) await store.set("dropped", account, { v: RECORD_VERSION, lists: [...dropped, list] });
    await store.set("genesis", account, undefined);
  };

  /**
   * Starts the account's list. The genesis is kept before it is sent, and sent again as it is until this device's
   * saved copy holds it or the account turns out to have another list: a lost answer or a closed page makes no
   * second one.
   */
  const start = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, signal: AbortSignal): Promise<"placed" | "exists" | NoGenesis> => {
    let pending = readPending(await store.get("genesis", session.account), keys);
    const refused = await mayStart(bound, session, pending !== null, signal);
    if (refused !== null) return refused;
    if (pending === null) {
      // Entry 0 is dated by this device's own clock, whatever the account service says the time is: a member signs
      // no time on the service's word. A service that refuses the entry for its time says so (`clock`).
      pending = { key: keys.key, ...await makeGenesis({ account: session.account, keys, names: options.names?.() ?? null, now: now() }) };
      await store.set("genesis", session.account, { v: RECORD_VERSION, ...pending });
    }
    try {
      return await bound.startList(pending.list, pending.entry, { member: pending.enc, wrap: pending.wrap }, signal);
    } catch (error) {
      const said = refusalOf(error);
      if (said === null || said.status === 429 || said.status >= 500) throw error;
      if (said.status === 403 && said.code === "own_sign_in_required") return "not_own_sign_in";
      if (said.status === 403 && (said.code === "frozen" || said.code === "session_not_fresh")) return said.code;
      // the entry itself was refused, so it was not placed and never will be as it is: the device gives it up for
      // good, and the next try signs another
      if (said.status === 400) await giveUp(session.account, pending.list);
      return said.status === 400 && said.reason === "issued_at_ahead" ? "clock" : "refused";
    }
  };

  /**
   * The epoch keys this device holds for the copy: from the wraps it kept, and while the current epoch's key is not
   * among them, from the wraps the account service holds for it. A wrap is kept only when it opens to the key the list
   * commits to; one that opens to another key is the account service's doing, and is said (`wrong_key`).
   */
  const epochsOf = async (copy: FollowerCopy, state: ListState, history: string, keys: DeviceListKeys, ask: Asking | null): Promise<OpenedEpochs> => {
    const kept = readWraps(await store.get("wraps", copy.account), copy.list, keys.enc.key);
    const opened = await openEpochs(state, kept, keys.enc);
    if (opened.keys.has(state.epoch)) {
      if (wrongKey === copy.account) wrongKey = null;
      return opened;
    }
    const at = seconds();
    const due = wrapsAsked === null || wrapsAsked.history !== history || at < wrapsAsked.at || at - wrapsAsked.at >= NO_LIST_SECONDS;
    if (ask === null || !due) return opened;
    wrapsAsked = { history, at };
    let shown: readonly ListWrap[];
    try {
      shown = await ask.bound.listWraps(copy.list, keys.enc.key, ask.signal);
    } catch (error) {
      // names wait for another round; who is in never waited for them
      if (!unreached(error)) throw error;
      return opened;
    }
    const tried = new Map(opened.good.map((epoch) => [epoch, kept.wraps.get(epoch) ?? ""]));
    for (const wrap of shown) if (!tried.has(wrap.epoch)) tried.set(wrap.epoch, wrap.wrap);
    const again = await openEpochs(state, { ...kept, wraps: tried }, keys.enc);
    wrongKey = again.wrong.length > 0 ? copy.account : wrongKey === copy.account ? null : wrongKey;
    if (again.good.length !== kept.wraps.size || again.good.some((epoch) => kept.wraps.get(epoch) !== tried.get(epoch))) {
      await beside("the epoch keys it opened", () => store.set("wraps", copy.account, wrapsRecord({ ...kept, wraps: new Map(again.good.map((epoch) => [epoch, tried.get(epoch) ?? ""])) })));
    }
    return again;
  };

  const viewOf = async (next: Held, keys: DeviceListKeys, ask: Asking | null): Promise<AccountListView> => {
    const { copy, account } = next;
    const reached = ask !== null;
    if (copy === null || copy.state === null) return { account, status: next.without, reached, devices: [], pcs: [] };
    const { state } = copy;
    const stands = standing(copy);
    // the account service places only what a signer signed: an entry past the last one a signer signed is its own writing
    const unsigned = copy.entries.length - 1 > state.footing.seq && state.needs_replay === undefined;
    const follows = (): AccountListStatus => ({
      at: "following", list: copy.list, standing: stands, head: copy.entries.length - 1, read_at: copy.read_at,
      trouble: worst([copy.alarm === null ? null : "fork", next.trouble, unsigned ? "unsigned" : null, wrongKey === account ? "wrong_key" : null]),
    });
    if (stands !== "in") return { account, status: follows(), reached, devices: [], pcs: [] };
    const history = historyOf(copy);
    if (named === null || named.history !== history || (!named.complete && ask !== null)) {
      const opened = await epochsOf(copy, state, history, keys, ask);
      const nameAt = (seq: number): Promise<ListNames | null> => namesAt(copy.list, copy.entries, seq, opened.keys);
      const devices: ListedDevice[] = [];
      for (const row of shownDevices(copy)) {
        // in by a key the same device handed its place on to: the entry that let the key in ended the key that signed it
        const handed = row.by !== null && state.signers[row.by]?.ended === row.seq && copy.entries[row.seq] !== undefined;
        const moved = handed ? readBody(entryFromText(copy.entries[row.seq]!).body).issued_at : undefined;
        devices.push({ key: row.key, self: row.key === keys.key, power: row.power, role: row.role, until: row.until, carried: row.carried, name: await nameAt(row.seq), ...(moved === undefined ? {} : { moved }) });
      }
      const pcs: ListedPc[] = [];
      // a PC that came in after this device did, by another's signature, is new to it from when it first held the entry
      const own = shownDevices(copy).find((row) => row.key === keys.key)?.seq ?? null;
      const seen = readSeen(await store.get("seen", account), copy.list);
      const news: Record<string, readonly [number, number]> = {};
      for (const row of shownPcs(copy)) {
        const by = signerAt(copy.entries, row.seq);
        let new_at: number | null = null;
        if (own !== null && row.seq > own && by !== keys.key) {
          const before = seen[row.endpoint];
          new_at = before !== undefined && before[0] === row.seq ? before[1] : seconds();
          news[row.endpoint] = [row.seq, new_at];
        }
        pcs.push({ endpoint: row.endpoint, server_id: deriveServerId(hexToBytes(row.endpoint)), how: row.how, allows: row.allows, name: await nameAt(row.seq), seq: row.seq, by, new_at });
      }
      const picture = (pcs: SeenPcs): string => JSON.stringify(Object.entries(pcs).sort(([a], [b]) => a.localeCompare(b)));
      if (picture(news) !== picture(seen)) await beside("when it first saw a PC", () => store.set("seen", account, Object.keys(news).length === 0 ? undefined : { v: RECORD_VERSION, list: copy.list, pcs: news }));
      named = { history, complete: opened.keys.has(state.epoch), devices, pcs, keys: opened.keys };
    }
    // this device's own key went on to another by an entry it did not make: it is no longer the key the list goes by
    const standsNow = standsFor(state, keys.key);
    const handedAway = state.signers[keys.key]?.ended != null && standsNow !== null && standsNow !== keys.key ? { handedAway: { to: standsNow } } : {};
    return { account, status: follows(), reached, devices: named.devices, pcs: named.pcs, ...handedAway };
  };

  /**
   * Reads the log after the copy's own head. Every page is saved as it is taken, before the next is asked for, and has
   * its own time to answer. The read ends when the log is read, after READ_PAGES_MAX pages (the follower's bound),
   * after READ_MS, or at a page that did not come (`cut`): what was taken until then is kept, and the next round goes
   * on from there. So a device that is n entries behind gets there in at most n / 256 rounds that each got one page.
   */
  const read = async (bound: AccountService, from: FollowerCopy, before: { readonly copy: FollowerCopy | null; readonly saved: string | null }, stopped: AbortSignal): Promise<{ copy: FollowerCopy; saved: string; verdict: FollowVerdict; cut: boolean; more: boolean }> => {
    const kept = await pages(bound, from, before, stopped);
    return { ...kept, saved: kept.saved ?? await save(before, kept.copy) };
  };

  /** The read itself. `before` null: nothing of it is saved (a place a member handed over, until the log shows this device let in there). */
  const pages = async (bound: AccountService, from: FollowerCopy, before: { readonly copy: FollowerCopy | null; readonly saved: string | null } | null, stopped: AbortSignal): Promise<{ copy: FollowerCopy; saved: string | null; verdict: FollowVerdict; cut: boolean; more: boolean }> => {
    let copy = from;
    // a new copy is saved before its first page is asked for: that is the pin. One that was saved before is written
    // with the first page that comes
    let at: { copy: FollowerCopy | null; saved: string | null } | null = before === null ? null : before.saved === null ? { copy, saved: await save(before, copy) } : before;
    let verdict: FollowVerdict = "withheld";
    let next: FollowRead | null = startRead(copy, "service");
    const began = performance.now();
    for (let pages = 0; next !== null && pages < READ_PAGES_MAX && performance.now() - began < READ_MS; pages += 1) {
      let page: Awaited<ReturnType<AccountService["listLog"]>>;
      try {
        page = await bound.listLog(copy.list, next.after, AbortSignal.any([stopped, AbortSignal.timeout(ROUND_MS)]));
      } catch (error) {
        if (stopped.aborted || !unreached(error)) throw error;
        return { copy, saved: at?.saved ?? null, verdict, cut: true, more: true };
      }
      const took = await takePage(copy, next, { list: page.list, after: page.after, entries: page.entries, head: page.head }, seconds());
      stopped.throwIfAborted();
      if (at !== null) at = { copy: took.copy, saved: await save(at, took.copy) };
      ({ copy, verdict } = took);
      next = took.read;
    }
    return { copy, saved: at?.saved ?? null, verdict, cut: false, more: next !== null };
  };

  /**
   * This device's claim of its own key for a list it waits to be let into, made again once it is CLAIM_RENEW_SECONDS
   * old: the account service places a member's `device` entry for the key only while the claim stands.
   */
  const claim = async (bound: AccountService, account: string, keys: DeviceListKeys, list: string, before: ListClaimState, signal: AbortSignal): Promise<ListClaimState> => {
    const at = seconds();
    // a claim kept for the key it was made for: another page may have put a new key in the store all pages share
    if (claimedAt !== null && claimedAt.account === account && claimedAt.list === list && claimedAt.key === keys.key && at >= claimedAt.at && at - claimedAt.at < CLAIM_RENEW_SECONDS) return "claimed";
    try {
      await bound.claimListKey(list, await deviceCard(keys, list), signal);
    } catch (error) {
      const said = refusalOf(error);
      if (said === null || said.status === 429 || said.status >= 500) {
        if (!unreached(error)) throw error;
        return before === "claimed" ? "unclaimed" : before;
      }
      if (said.status === 403 && said.code === "own_sign_in_required") return "not_own_sign_in";
      return said.status === 403 && (said.code === "frozen" || said.code === "session_not_fresh") ? said.code : "refused";
    }
    claimedAt = { account, list, key: keys.key, at };
    return "claimed";
  };

  /**
   * The copy a member's offer gives, or null: the list is followed only once the log shows this device's own key let
   * in, up to the very entry the member named. Until then nothing of it is kept but the offer.
   */
  const offered = async (bound: AccountService, account: string, keys: DeviceListKeys, stopped: AbortSignal): Promise<FollowerCopy | null> => {
    const offer = readOffer(await store.get("offer", account));
    if (offer === null) return null;
    const pinned = pinList(null, { account, list: offer.list, me: { key: keys.key, endpoint: null }, pin: { how: "allowed", seq: offer.seq, hash: offer.hash } });
    if (!pinned.pinned) return null;
    let copy: FollowerCopy;
    try {
      // nothing of this read is saved: the copy is kept only once it shows this device let in at the place it was handed
      const got = await pages(bound, pinned.copy, null, stopped);
      if (got.cut) return null;
      ({ copy } = got);
    } catch (error) {
      if (stopped.aborted || !unreached(error)) throw error;
      return null;
    }
    if (copy.state === null || standing(copy) !== "in") return null;
    // the place handed over is that of this device's own entry, or a later one: an entry that lets it in only after
    // that place is not what the member vouched for
    const own = shownDevices(copy).find((row) => row.key === keys.key);
    return own !== undefined && own.seq <= offer.seq ? copy : null;
  };

  /** What a round does with the list the account service names (`named`: null for none); `loaded` is what this device saved. */
  const follow = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, loaded: Held, told: ListHint | null, signal: AbortSignal, stopped: AbortSignal): Promise<Held> => {
    const { account } = session;
    let hint = told;
    let copy = loaded.copy;
    const fresh = copy === null;
    // a member that let this device in named its list: that word, checked against the log, comes before the service's
    if (copy === null) copy = await offered(bound, account, keys, stopped);
    const handed = fresh && copy !== null;
    if (copy === null) {
      if (hint === null) {
        const started = await start(bound, session, keys, signal);
        if (started !== "placed" && started !== "exists") return { ...loaded, without: { at: "none", why: started } };
        const after = await bound.accountList(signal);
        const named = after === "off" ? null : after.hint;
        if (named === null) throw new AccountServiceError(502, "invalid_answer", "The account service took a list and names none");
        hint = named;
      }
      // a list that is not this device's own is not read again while the account service names it: the device waits to
      // be let in, and keeps its claim of its own key standing
      if (loaded.without.at === "not_in" && loaded.without.why === "not_mine" && loaded.without.list === hint.list) {
        return { ...loaded, without: { ...loaded.without, claim: await claim(bound, account, keys, hint.list, loaded.without.claim, signal) } };
      }
      // nor is a list whose entry 0 this device signed and gave up: it follows that one never, whoever names it
      if (readDropped(await store.get("dropped", account)).includes(hint.list)) return { ...loaded, without: { at: "not_in", list: hint.list, why: "not_mine", claim: "unclaimed" } };
      const me: FollowerSelf = { key: keys.key, endpoint: null };
      const pinned = pinList(null, { account, list: hint.list, me, pin: { how: "genesis" } });
      if (!pinned.pinned) throw new RangeError("This account or this device's key cannot follow a list");
      // only entry 0 says whether this device started the list; nothing else of it is asked for before that
      const first = startRead(pinned.copy, "service");
      const page = await bound.listLog(hint.list, first.after, signal, 1);
      const began = await takePage(pinned.copy, first, { list: page.list, after: page.after, entries: page.entries, head: page.head }, seconds());
      const pending = readPending(await store.get("genesis", account), keys);
      if (began.copy.state === null) {
        // not this device's own only when what was shown is that list's entry 0: anything else is the account service not showing it
        const shown = page.list === hint.list && hashOf(page.entries[0]) === hint.list;
        const why = !shown ? "unread" : began.verdict === "needs_newer_client" ? "needs_newer_client" : began.verdict === "not_my_list" ? "not_mine" : "unread";
        // the account has a list that is not the one this device signed: its own will never be the account's
        if (why === "not_mine" && pending !== null && pending.list !== hint.list) await giveUp(account, pending.list);
        return { ...loaded, without: { at: "not_in", list: hint.list, why, claim: why === "not_mine" ? await claim(bound, account, keys, hint.list, "unclaimed", signal) : "unclaimed" } };
      }
      ({ copy } = began);
      if (pending !== null && pending.list === copy.list) await store.set("wraps", account, wrapsRecord({ list: copy.list, member: keys.enc.key, wraps: new Map([[0, pending.wrap]]) }));
    }

    // a device that follows a list starts no other over it, whatever the account service names
    const heard = heardHead(copy, hint === null ? null : { list: hint.list, head: hint.head }, seconds());
    ({ copy } = heard);
    let verdict: FollowVerdict = heard.verdict === "same" ? "caught_up" : "older";
    // The account service names another list, which the device says, or none, which is no hint at all (the follower's
    // rule). Either way the device reads its own list at its own pace: a removal must still reach it.
    const other = heard.verdict === "not_my_list";
    let unread = false;
    let behind = false;
    let saved: string;
    // asked for by a write whose outcome only the log says: the head the account service names proves nothing of it
    const forced = readAsked;
    readAsked = false;
    if (heard.verdict === "read" || other || heard.verdict === "none" || forced) {
      const had = copy.entries.length;
      const got = await read(bound, copy, loaded, stopped);
      ({ copy, saved } = got);
      // a page that did not come: what was said before stands. With pages taken before it, the next round goes on
      // at once; with none, the round counts as one that did not reach the account service
      behind = got.more && copy.entries.length > had;
      unread = got.cut && !behind;
      if (!got.cut || behind) ({ verdict } = got);
    } else saved = await save(loaded, copy);
    // the genesis is in the saved copy now, and its wrap with the others: what was kept to send it again goes
    if (fresh) await store.set("genesis", account, undefined);
    // and the place a member handed over, only now that the copy it led to is saved: a save that failed keeps the place
    if (handed) await store.set("offer", account, undefined);
    return { account, copy, saved, trouble: worst([troubleOf(verdict), other ? "other_list" : null]), without: { at: "off" }, ...(unread ? { unread: true as const } : {}), ...(behind ? { behind: true as const } : {}) };
  };

  const round = async (): Promise<AccountListView> => {
    const session = await service.session();
    // from here on a round counts as asked, whatever becomes of it: one that fails early is not begun again at once
    askedAt = seconds();
    if (session === undefined) {
      held = null;
      offAt = null;
      misses = 0;
      return publish(OFF);
    }
    const bound = service.forSignIn(session);
    const { account } = session;
    // how often the account service is asked is counted for one account: another one's sign-in starts anew
    if (pacedFor !== account) {
      pacedFor = account;
      misses = 0;
      offAt = null;
      behind = false;
    }
    // a leave or a deletion of the account ends the round under way (forget): nothing of it is written or shown after
    const stop = new AbortController();
    roundStop = { account, stop };
    try {
      return await lock(account, async () => {
        for (let tries = 1; ; tries += 1) {
          try {
            stop.signal.throwIfAborted();
            return await once(session, bound, stop.signal);
          } catch (error) {
            if (stop.signal.aborted) return shown;
            // another page saved the copy under this round: it loads what is saved now and takes its pages again
            if (!(error instanceof StaleCopyError)) throw error;
            if (tries >= SAVE_TRIES) {
              misses += 1;
              return shown;
            }
          }
        }
      });
    } finally {
      if (roundStop?.stop === stop) roundStop = null;
    }
  };

  /** One round's work on the copy as it is saved now, under the account's lock. */
  const once = async (session: AccountSession, bound: AccountService, stopped: AbortSignal): Promise<AccountListView> => {
    const { account } = session;
    {
      const signal = AbortSignal.any([stopped, AbortSignal.timeout(ROUND_MS)]);
      const saved = await store.get("copy", account);
      const off = (at: number): AccountListView => {
        held = null;
        offAt = at;
        misses = 0;
        return publish({ account, status: { at: "off" }, reached: true, devices: [], pcs: [] });
      };
      // The account service said, less than a day ago, that it keeps no list for this account: it is not asked again
      // by this page or any other, however often the app starts. A device that follows a list asks all the same.
      const told = saved === undefined ? readOff(await store.get("asked", account)) : null;
      const at = seconds();
      if (told !== null && told <= at && at - told < OFF_SECONDS) return off(told);
      offAt = null;
      let hint: ListHint | null | "off" | undefined;
      try {
        const answer = await bound.accountList(signal);
        hint = answer === "off" ? "off" : answer.hint;
      } catch (error) {
        if (stopped.aborted || !unreached(error)) throw error;
      }
      // an account the service keeps no list for, on a device that follows none: no key is made, and one record is
      // kept, the time of that answer
      if (saved === undefined && hint === "off") {
        // the day runs from when the answer came, in whole seconds and never a part of one early
        const answered = Math.ceil(now() / 1000);
        await store.set("asked", account, { v: RECORD_VERSION, off_at: answered });
        return off(answered);
      }
      if (saved === undefined && hint === undefined) {
        misses += 1;
        if (held?.account !== account) held = null;
        return publish({ account, status: held?.without ?? { at: "off" }, reached: false, devices: [], pcs: [] });
      }
      const keys = await deviceListKeys(accountStore);
      ctx = { account, keys, bound };
      const loaded = await load(account, keys, saved);
      if (typeof loaded === "string") {
        held = null;
        return publish({ account, status: loaded === "version" ? { at: "newer_save" } : { at: "damaged", why: loaded }, reached: hint !== undefined, devices: [], pcs: [] });
      }
      let next = loaded;
      // for a device that follows a list, an account off the service's switch is the service being away, never "the list is gone"
      let reached = hint !== undefined && hint !== "off";
      let view: AccountListView;
      try {
        if (hint !== undefined && hint !== "off") {
          try {
            next = await follow(bound, session, keys, loaded, hint, signal, stopped);
            if (next.unread === true) reached = false;
          } catch (error) {
            if (stopped.aborted || !unreached(error)) throw error;
            // what this device saved stands as it is
            reached = false;
          }
        }
        stopped.throwIfAborted();
        // the wraps are asked for with a time of their own: the pages before them may have used up the round's
        view = await viewOf(next, keys, reached ? { bound, signal: AbortSignal.any([stopped, AbortSignal.timeout(ROUND_MS)]) } : null);
      } catch (error) {
        if (stopped.aborted || error instanceof StaleCopyError || loaded.copy === null) throw error;
        // The round failed past the copy this device saved (a store that takes no write, a fault of the reading). The
        // device still goes by that copy: it is shown as it was saved, as a list the account service was not reached
        // for, so a page never draws or opens by the account service's word alone while it holds a copy. The fault
        // goes up, and the next round tries again.
        try {
          const kept = await viewOf(loaded, keys, null);
          if (!stopped.aborted) { misses += 1; held = loaded; publish({ ...kept, reached: false }); }
        } catch (again) { console.warn("Ovis: the saved copy of the account's list could not be drawn either", again instanceof Error ? again.name : again); }
        throw error;
      }
      stopped.throwIfAborted();
      // another page stored another sign-in, or none, while this round ran: nothing of the account it began with is shown
      const still = await service.session();
      if (still === undefined || !sameSignIn(still, session)) {
        held = null;
        misses = 0;
        return publish(OFF);
      }
      misses = reached ? 0 : misses + 1;
      behind = next.behind === true;
      held = next;
      return publish(view);
    }
  };

  const sync = (options: { readonly read?: boolean } = {}): Promise<AccountListView> => {
    if (options.read === true) readAsked = true;
    if (running !== null) {
      queued ??= running.then(() => undefined, () => undefined).then(() => {
        queued = null;
        return sync();
      });
      return queued;
    }
    running = round().catch((error: unknown) => {
      // the sign-in ended under the round: what it showed was that sign-in's
      if (error instanceof SignedOutError) {
        held = null;
        publish(OFF);
      }
      throw error;
    }).finally(() => { running = null; });
    return running;
  };

  return {
    sync,
    async follows(account) {
      return (await store.get("copy", account)) !== undefined;
    },
    view: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    holdsPc(endpoint) {
      return shown.pcs.some((pc) => pc.endpoint === endpoint);
    },
    async pinnedElsewhere(account, key) {
      for (const other of await store.accounts()) {
        if (other === account) continue;
        const saved = await store.get("copy", other);
        if (saved === undefined) continue;
        if (typeof saved !== "string") return other;
        const read = await readSave(saved);
        if (!read.read) return other;
        const { me, state } = read.copy;
        if (me.key !== key || me.endpoint !== null) continue;
        if (state === null || (state.signers[key]?.ended ?? null) === null) return other;
      }
      return null;
    },
    pcOfKey(key) {
      const endpoint = held?.copy == null || held.account !== shown.account ? null : pcOfKey(held.copy, key);
      return endpoint !== null && shown.pcs.some((pc) => pc.endpoint === endpoint) ? endpoint : null;
    },
    due(inFront) {
      const { status } = shown;
      if (!inFront || shown.account === null || status.at === "damaged" || status.at === "newer_save") return null;
      // the account service keeps no list for the account: once a day
      if (offAt !== null) return (offAt + OFF_SECONDS) * 1000;
      // it was not reached: a longer wait after each round in a row that was not
      if (misses > 0) return ((askedAt ?? seconds()) + (UNREACHED_SECONDS[Math.min(misses, UNREACHED_SECONDS.length) - 1] ?? NO_LIST_SECONDS)) * 1000;
      // pages of the log are left to take: at once (the follower of the timer keeps rounds five seconds apart)
      if (behind) return now();
      if (status.at !== "following" || held?.copy == null) return ((askedAt ?? seconds()) + NO_LIST_SECONDS) * 1000;
      const step = followStep(held.copy, seconds(), { event: "tick", asked_at: askedAt, busy: true });
      return step.do === "read" ? now() : step.do === "wait" && step.until !== null ? step.until * 1000 : null;
    },
    async shadow(account, directory, opens) {
      const compared = shown.account === account ? shadowOf(shown, directory, now(), opens) : null;
      // one at a time for an account, among this page's comparisons and the other pages': each reads the count and writes it back
      return compared === null ? null : lock(account, () => keepShadow(store, account, compared));
    },
    async dropNames(account) {
      await lock(account, async () => {
        await store.set("wraps", account, undefined);
        await store.set("genesis", account, undefined);
      });
      if (wrongKey === account) wrongKey = null;
      named = null;
      wrapsAsked = null;
      // the names this page had open go too: who is in stays, and whoever listens is told
      if (shown.account === account && [...shown.devices, ...shown.pcs].some((row) => row.name !== null)) {
        publish({ ...shown, devices: shown.devices.map((row) => ({ ...row, name: null })), pcs: shown.pcs.map((row) => ({ ...row, name: null })) });
      }
    },
    async kept(writer) {
      const kept = readKept(await store.get("sent", writer.account));
      return kept !== null && sameHead(kept, writer) ? kept : null;
    },
    async keep(writer, request) {
      const mine: KeptRequest = { list: writer.list, key: writer.keys.key, on: { seq: writer.state.footing.seq, hash: writer.state.footing.hash }, entries: request.entries, wraps: request.wraps, place: request.place, for: request.for, at: writer.issued_at };
      const text = JSON.stringify({ v: RECORD_VERSION, ...mine });
      for (let tries = 0; tries < SAVE_TRIES; tries += 1) {
        const before = await store.get("sent", writer.account);
        const standing = readKept(before);
        // another page signed for this place first: its request is the one signature, and this page's is never sent
        if (standing !== null && sameHead(standing, writer)) return standing;
        if (await store.swap("sent", writer.account, typeof before === "string" ? before : undefined, text)) return mine;
      }
      throw new StaleCopyError();
    },
    async unkeep(account, request) {
      const before = await store.get("sent", account);
      const standing = readKept(before);
      if (typeof before !== "string" || standing === null || standing.place.hash !== request.place.hash || standing.on.hash !== request.on.hash) return;
      await store.swap("sent", account, before, JSON.stringify({ v: RECORD_VERSION, ...standing, let_go: true }));
    },
    async waiting() {
      const writer = this.writer({ self: true });
      const kept = writer === null ? null : await this.kept(writer);
      return writer === null || kept === null ? null : { account: writer.account, list: kept.list, key: kept.key, on: kept.on, place: kept.place, for: kept.for, at: kept.at };
    },
    async cancel(request) {
      const standing = async (): Promise<{ writer: ListWriter; kept: KeptRequest } | null> => {
        const writer = this.writer({ self: true });
        const kept = writer === null ? null : await this.kept(writer);
        return writer === null || kept === null || !sameWaiting(request, { ...kept, account: writer.account }) ? null : { writer, kept };
      };
      if (await standing() === null) return this.holdsEntry(request.place) ? "placed" : "gone";
      // an outcome that is not known is settled by the log before anything is said of it
      const read = await sync({ read: true });
      if (read.account === request.account && this.holdsEntry(request.place)) return "placed";
      const now = await standing();
      if (now === null) return "gone";
      if (!read.reached) return "unread";
      await this.unkeep(now.writer.account, now.kept);
      return "gone";
    },
    async adopt(offer, account) {
      const session = await service.session();
      const read = readOffer({ v: RECORD_VERSION, ...offer });
      const under = account ?? session?.account;
      if (under === undefined || read === null) return shown;
      await lock(under, async () => {
        // a device that follows a list keeps to it: a pin is one-way
        if (await store.get("copy", under) === undefined) await store.set("offer", under, { v: RECORD_VERSION, ...read });
      });
      return session !== undefined && session.account === under ? sync() : shown;
    },
    placeAt(seq) {
      const text = held?.copy?.entries[seq];
      const hash = text === undefined ? null : hashOf(text);
      return hash === null ? null : { seq, hash };
    },
    shown() {
      const copy = held?.copy ?? null;
      const at = seconds();
      return copy === null || copy.state === null ? at : listClock(copy.state, at, copy.seen_at);
    },
    writer(options = {}) {
      const copy = held?.copy ?? null;
      const { status } = shown;
      if (held === null || copy === null || copy.state === null || ctx === null || ctx.account !== held.account || shown.account !== held.account) return null;
      if (status.at !== "following" || status.standing !== "in" || status.trouble === "fork" || status.trouble === "stuck") return null;
      const own = copy.state.signers[ctx.keys.key];
      if (own === undefined || own.ended !== null || (own.power !== "full" && options.self !== true)) return null;
      const at = seconds();
      return {
        account: held.account, list: copy.list, state: copy.state, keys: ctx.keys, service: ctx.bound,
        epochs: named !== null && named.history === historyOf(copy) ? named.keys : new Map(),
        // Whose time is over is judged by this device's own clock, held against the floor it saved and the list's own
        // time, and an entry is dated by that clock: never by the account service's, which could otherwise make a
        // member sign a removal, or a time, that nothing undoes
        clock: listClock(copy.state, at, null),
        issued_at: at,
        shown: this.shown(),
        adrift: copy.seen_at !== null && at < copy.seen_at - ADRIFT_SECONDS,
      };
    },
    holdsEntry(place) {
      const copy = held?.copy ?? null;
      return copy !== null && copy.state !== null && place.seq <= copy.state.footing.seq && hashOf(copy.entries[place.seq]) === place.hash;
    },
    gossip() {
      const copy = held?.copy ?? null;
      return copy === null || copy.state === null ? null : gossipHead(copy);
    },
    pageAfter(after, limit) {
      const copy = held?.copy ?? null;
      return copy === null || copy.state === null ? null : servePage(copy, { list: copy.list, after }, limit);
    },
    async forget(account, member) {
      // the round under way for the account ends here, rather than be waited for: it holds the account's lock
      if (roundStop?.account === account) roundStop.stop.abort(new DOMException("The account's list is forgotten", "AbortError"));
      const dropped = await lock(account, async () => {
        if (member === undefined) return store.drop(account);
        // the copy that goes is the one read here, pinned to the key that left: dropped only while it is still that text
        for (let tries = 0; tries < 3; tries += 1) {
          const saved = await store.get("copy", account);
          // none is kept: what this page holds of it is stale, and nothing else is the departing member's to drop
          if (saved === undefined) return true;
          if (typeof saved !== "string") return false;
          const read = await readSave(saved);
          if (!read.read || read.copy.me.key !== member || read.copy.me.endpoint !== null) return false;
          if (await store.drop(account, saved)) return true;
        }
        return false;
      });
      if (!dropped) return;
      if (held?.account === account) held = null;
      if (wrongKey === account) wrongKey = null;
      if (claimedAt?.account === account) claimedAt = null;
      if (ctx?.account === account) ctx = null;
      named = null;
      wrapsAsked = null;
      if (shown.account === account) { offAt = null; misses = 0; publish(OFF); }
    },
  };
}
