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
import { isListKey, listClock, listView, readKind, type ListNames, type ListRole, type ListSigner, type ListState } from "../../../shared/account-list.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import { entryFromText, entryHash, isListHash, ListEntryError, readBody, type SignerPower } from "../../../shared/account-list-entry.ts";
import {
  compareHeads, followStep, gossipHead, heardHead, PAGE_ENTRIES_MAX, pcOfKey, pinList, READ_PAGES_MAX, readSave, servePage, shownDevices, shownPcs, standing, startRead, takePage, writeSave,
  type FollowerCopy, type FollowerSelf, type FollowRead, type FollowVerdict, type HeadsVerdict, type ListHead, type ListPage as PeerPage, type SaveRefusal, type Standing,
} from "../../../shared/account-list-follower.ts";
import { LIST_WRAP_TEXT_LENGTH, type EpochKey } from "../../../shared/account-list-seal.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import {
  devicePlace, heirOf, joinVerdict, MIGRATION_ANSWER_SECONDS, MigrationError, migrationPlan, ownEvidence, signMigration, signNaming, signRotation, signVouch, standsFor,
  type JoinRefusal, type MigrationKnown, type NoMigration, type SignedNaming, type SignedVouch,
} from "../../../shared/account-list-migrate.ts";
import { listNames, makeGenesis, type Genesis } from "./listGenesis.ts";
import {
  birthSeals, birthText, elapsed, handOverRecord, joinedRecord, knownPcs, listDoubt, MOVE_AGAIN_SECONDS, noticeRecord, notCarriedAt, pageAnswers, pcAgrees, readBirth, readHandOver,
  readJoined, readNotice, readRetired, retiredText, scaled, signLink, type KeptBirth, type ListDoubt, type MoveNoticeView, type MoveRefusal, type PcAnswers,
} from "./listMigrate.ts";
import { removeFromList } from "./listRemoveDevice.ts";
import { clearTried, noteTried, readSeenPcs } from "./seenPcs.ts";
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
export type NoGenesis = "not_new" | "not_first_device" | "has_pcs" | "not_own_sign_in" | "frozen" | "session_not_fresh" | "refused" | "clock" | "storage" | "switched_off" | "moving";

/**
 * Why the first device of an account that was in use has not moved it onto its list yet, while the account service says
 * it may (docs/account-list.md, "An account that was in use"): the pure part's reasons (NoMigration), `refused` for the
 * hour after the service refused a birth for good, `sending` while a birth it kept waits for an answer, and `paused`
 * while the account service no longer opens the move for the account and a birth it kept waits as it is. `wait`: the
 * seconds left, by this device's clock, where one is known. `asks`: the relay keys of the PCs it knows by its own record
 * that have not answered in this run of the app.
 */
export interface MoveState {
  readonly why: NoMigration | "refused" | "sending" | "paused";
  readonly wait: number | null;
  readonly asks: readonly string[];
}

/**
 * Where a device that a moved list carried in stands before it follows it: what its PCs said (joinVerdict). `join` while
 * it only asks again; `refused` once one said no, which it says, naming the PCs, and asks to be let in as a new device.
 */
export interface JoinState {
  readonly why: JoinRefusal;
  readonly wait: number | null;
  readonly pcs: readonly string[];
}

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
  | { readonly at: "none"; readonly why: NoGenesis; /** with `moving`: where the move of an account that was in use stands */ readonly move?: MoveState }
  /**
   * The account service names a list that this device does not follow, and it reads no more of it than entry 0.
   * - `not_mine`: entry 0 is that list's and is not this device's own: it is in no list until a member lets it in.
   * - `unread`: the account service did not show the entry 0 of the list it names. It is asked again.
   * - `needs_newer_client`: entry 0 is in a form this build cannot read.
   * `claim`: whether the account service holds this device's claim of its own key for that list, without which no
   * member's entry for the key is placed.
   */
  | {
    readonly at: "not_in"; readonly list: string; readonly why: "not_mine" | "unread" | "needs_newer_client" | "carried"; readonly claim: ListClaimState;
    /** `carried`: the list carried this device in, and it asks its PCs whether they know who started it */
    readonly join?: JoinState;
    /** `not_mine` after a list that carried this device in was refused: why, and which PCs said so */
    readonly refused?: Pick<JoinState, "why" | "pcs">;
  };

export type AccountListStatus =
  | Without
  /** What this device saved does not read. It is kept as it is, and nothing takes its place by itself. */
  | { readonly at: "damaged"; readonly why: Exclude<SaveRefusal, "version"> }
  /** What this device saved was written by a later build of the app, which this one cannot read: it needs a newer app. Kept as it is. */
  | { readonly at: "newer_save" }
  /** `head`: the place of the last entry of the copy. `read_at`: when it last held all the account service showed, in seconds. */
  | {
    readonly at: "following"; readonly list: string; readonly standing: Standing; readonly head: number; readonly read_at: number | null; readonly trouble: ListTrouble | null;
    /** A device the move of its account carried in: what a PC it knows said against the list since it joined (V4-6). */
    readonly doubt?: ListDoubt;
    /** The PCs such a device still asks about the list, within three days of its join: those that were silent then. */
    readonly asks?: readonly string[];
  };

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
  /** What moving an account that was in use onto its list reads (listMigrate.ts); each has the page's own by default. */
  readonly migration?: MigrationOptions;
}

export interface MigrationOptions {
  /** What the PCs answered this device in this run of the app. */
  readonly answers?: PcAnswers;
  /** Where this device's record of its PCs is kept (seenPcs.ts): this page's localStorage by default. */
  readonly storage?: Storage | null;
  /** The factor this device's own waits are turned down by (listMigrate.ts migrationScale): 1 but in the QA twin. */
  readonly scale?: () => number;
  /** The keys this device itself holds a block or a removal against, sent or not: never carried. */
  readonly removed?: (account: string) => Promise<readonly string[]>;
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

/** The kind of the entry a text holds, or null for a text that is no entry or none at all. */
function kindAt(text: string | undefined): string | null {
  if (text === undefined) return null;
  try {
    return readKind(readBody(entryFromText(text).body))?.kind ?? null;
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
}

/** A row of its own, or null: what every object answers to is no row. */
function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

/** Whether a copy holds the whole of a birth this device kept: its last entry, the `epoch`, at its own place. */
function holdsBirth(copy: FollowerCopy, birth: KeptBirth): boolean {
  const last = birth.entries.length;
  return copy.state !== null && copy.entries.length > last && hashOf(copy.entries[last]) === hashOf(birth.entries[last - 1]);
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
  const invite = isRecord(read.invite) && typeof read.invite.key === "string" && typeof read.invite.auto === "boolean" ? { key: read.invite.key, auto: read.invite.auto } : undefined;
  return { list, key, on, entries: entries as string[], wraps: wraps as KeptRequest["wraps"], place: last, for: typeof read.for === "string" ? read.for : null, at: typeof read.at === "number" && Number.isSafeInteger(read.at) ? read.at : 0, ...(invite === undefined ? {} : { invite }) };
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
  /** A carried device's check of its list against its PCs, from the last round that read them (V4-6). */
  readonly check?: { readonly doubt: ListDoubt | null; readonly asks: readonly string[] };
  /** The keys of this device's own blocks that the list its own birth made holds: its first write there puts them out (#4652, b2). */
  readonly owed?: readonly string[];
  /**
   * The copy holds a page a PC handed over that could not be saved: it is acted on from memory, and the next round
   * writes it over the text it was taken on (`saved`) before anything else.
   */
  readonly unsaved?: true;
}

/** What came of a page a PC handed this device (AccountList.takeFromPeer). */
export interface PeerTake {
  readonly verdict: FollowVerdict;
  /** The request to make of that PC at once, or null. */
  readonly read: FollowRead | null;
  /** False: what the page proved is acted on in this page's memory, and was not saved; it is not said to be taken. */
  readonly saved: boolean;
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
  /**
   * Whether this writer may still sign and send: false from the moment this page's copy of its list holds an alarm,
   * or holds another account's or list's copy, and from the moment another page of this device saved the list with an
   * alarm. Every signing and every sending looks again, so an alarm that rises while a write waits (for a claim, for an
   * answer), in this page or another, ends it with nothing signed or sent after it.
   */
  readonly live: () => boolean | Promise<boolean>;
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
  /** The invite it places, if it places one: sent again, it is proved for again (listWrite.ts Written). */
  readonly invite?: { readonly key: string; readonly auto: boolean };
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
  keep(writer: ListWriter, request: Pick<KeptRequest, "entries" | "wraps" | "place" | "for" | "invite">): Promise<KeptRequest>;
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
   * While the device owes the list the removal of keys it blocked itself (Held's `owed`), only that removal signs
   * (`owed`): it is the first write there.
   */
  writer(options?: { readonly self?: boolean; readonly owed?: boolean }): ListWriter | null;
  /** The place of the entry at `seq` in this device's copy, or null where the copy does not reach it. */
  placeAt(seq: number): ListPlace | null;
  /** Whether this device's copy holds that entry at that place: its own entry is in its copy only once the log showed it. */
  holdsEntry(place: ListPlace): boolean;
  /** Where this device stands, to tell another member: the list id and the last entry a member signed in its copy; null while it follows none. */
  gossip(): ListHead | null;
  /** This device's entries after a place, for another member to take: at most `limit`, up to the last one a member signed; null while it follows none. */
  pageAfter(after: number | null, limit: number): PeerPage | null;
  /** How this device's copy stands against where a PC says it stands (compareHeads), and what to ask that PC for; null while it follows none. */
  compare(theirs: ListHead): { readonly verdict: HeadsVerdict; readonly read: FollowRead | null } | null;
  /**
   * Whether the PC with this id (the one its relay key gives) is one this device's copy holds or held: a `pc` or `join`
   * entry named it, whether or not it is out since. A PC it never held is handed none of its entries.
   */
  knowsPc(serverId: string): boolean;
  /**
   * A page of the list a PC handed this device over a session (listGossip.ts), taken as a page of the account service
   * is, since entries prove themselves, and never as a full read: so a removal the service withholds from this device
   * reaches it from a PC that holds it, and another history a member signed raises the alarm here too. `read` is the
   * request the page answers, or null for one nobody asked for, taken from the place it names. Saved under the
   * account's lock, as a round saves. Where the save fails, what the page proved stands in this page's memory all the
   * same (a removal is acted on at once), the next round writes it first, and the page is not said to be taken. Null:
   * this device follows no list of the account signed in now, or another list than the read's.
   */
  takeFromPeer(page: PeerPage, read: FollowRead | null): Promise<PeerTake | null>;
  /**
   * What this device says inside a session to a PC that follows no list (Part F, F6), or null where it has nothing to
   * say: only a device that follows a list its account moved onto, and is in it with power `full`, names that list, by
   * the key the list holds it by now (its account key, or a carried device's sign-in key before its hand-over is
   * placed). `account`: the account the session was opened for, which the device must still follow a list of after
   * every wait. `session`: the key that session signed in with; `endpoint`: the PC's relay key; `signIn`: this
   * device's sign-in key, when that session signed in with it, which then vouches for the account key.
   */
  naming?(given: { readonly account: string; readonly session: string; readonly endpoint: string; readonly signIn: string | null }): Promise<{ readonly naming: SignedNaming; readonly vouches: readonly SignedVouch[] } | null>;
  /** The one-time notice of the move of this account onto its list, while the person has not seen it and this device follows that list; null otherwise. */
  notice?(account: string): Promise<MoveNoticeView | null>;
  /** The person saw the notice of the move onto `list`: it is not shown again. */
  noticeSeen?(account: string, list: string): Promise<void>;
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

  /**
   * Whether a saved copy is this device's own: pinned under its member key; or, for an account that moved onto its list,
   * under a sign-in key of this device's that the list shows handed over to that member key, or under the sign-in key
   * of now while the list still holds it (a carried device that has not handed over yet, or was put out by that key).
   */
  const ownCopy = (copy: FollowerCopy, member: string, signIn: string | null, handing: string | null = null): boolean => {
    if (copy.me.key === member) return true;
    // a carried device's hand-over this device kept, whose outcome its copy does not show yet: the copy pinned under the
    // key that signed it stays, whatever sign-in this device holds by now, until a read shows where the device stands
    if (handing !== null && copy.me.key === handing) return true;
    if (copy.state === null) return copy.me.key === signIn;
    const stands = standsFor(copy.state, copy.me.key);
    return stands === member || (copy.me.key === signIn && (stands === signIn || stands === null));
  };

  /** The saved copy as this page holds it: read again only when another page wrote since. */
  const load = async (account: string, keys: DeviceListKeys, saved: unknown, signIn: string | null = null, handing: string | null = null): Promise<Held | SaveRefusal> => {
    const fresh: Held = { account, copy: null, saved: null, trouble: null, without: held?.account === account ? held.without : { at: "off" } };
    if (saved === undefined) return fresh;
    if (typeof saved !== "string") return "form";
    // the copy this page holds, while it is the one saved and this device's key is the one it was pinned under
    if (held !== null && held.account === account && held.saved === saved && held.copy !== null && ownCopy(held.copy, keys.key, signIn, handing)) {
      // with what another page kept beside the copy since: its last full read, and the floor of its clock
      const beside = readTimes(await store.get("times", account), held.copy.list);
      const [read_at, seen_at] = [later(held.copy.read_at, beside?.read_at ?? null), later(held.copy.seen_at, beside?.seen_at ?? null)];
      return read_at === held.copy.read_at && seen_at === held.copy.seen_at ? held : { ...held, copy: { ...held.copy, read_at, seen_at } };
    }
    const read = await readSave(saved);
    if (!read.read) return read.why;
    // saved under another account key: this device has a new one since, and is another member
    if (!ownCopy(read.copy, keys.key, signIn, handing) || read.copy.me.endpoint !== null) {
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
    // Another page saved since, over a copy this page verified and could not save (a removal a PC handed it, an alarm):
    // what this page verified is taken into what was saved before anything is shown, and written by the round
    const unsaved = held !== null && held.unsaved === true && held.account === account && held.copy !== null && ownCopy(held.copy, keys.key, signIn, handing) && held.copy.list === copy.list ? held.copy : null;
    if (unsaved !== null) {
      const joined = await reconcile(copy, unsaved);
      if (joined !== copy) return { ...fresh, copy: joined, saved: text, unsaved: true };
    }
    return { ...fresh, copy, saved: text };
  };

  /**
   * `load` as a round of `session` reads the saved copy: with this device's sign-in key and a hand-over under way, so
   * a carried device's copy is its own wherever it is read.
   */
  const loadFor = async (account: string, keys: DeviceListKeys, saved: unknown, session: AccountSession): Promise<Held | SaveRefusal> => {
    const handing = readHandOver(await store.get("handover", account));
    return load(account, keys, saved, (await signInOf(session))?.key ?? null, handing !== null && handing.refused_at === null ? handing.signIn : null);
  };

  /**
   * `saved` with what `verified` holds of the same list and it lacks: the entries after the last one a member signed in
   * `saved`, taken as a peer's pages (the follower judges them as it judged them first, and they take the place of
   * entries no member signed above it), and the alarm `verified` raised, when `saved` has none. `saved` itself where
   * neither adds anything.
   */
  const reconcile = async (saved: FollowerCopy, verified: FollowerCopy): Promise<FollowerCopy> => {
    let copy = saved;
    const begun = startRead(copy, "peer");
    let read: FollowRead | null = copy.state === null ? begun : { ...begun, after: copy.state.footing.seq };
    for (let pages = 0; read !== null && pages < READ_PAGES_MAX; pages += 1) {
      const page = verified.state === null ? null : servePage(verified, { list: verified.list, after: read.after }, PAGE_ENTRIES_MAX);
      if (page === null || page.entries.length === 0) break;
      const took = await takePage(copy, read, page, seconds());
      ({ copy } = took);
      ({ read } = took);
    }
    if (copy.alarm === null && verified.alarm !== null) copy = { ...copy, alarm: verified.alarm };
    return writeSave(copy) === writeSave(saved) ? saved : copy;
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

  const save = async (before: { readonly copy: FollowerCopy | null; readonly saved: string | null; readonly unsaved?: true }, copy: FollowerCopy): Promise<string> => {
    // a copy held in memory that its text does not hold yet (Held.unsaved) is written whatever it differs in
    if (before.unsaved !== true && before.copy !== null && before.saved !== null && sameHistory(before.copy, copy)) {
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
      ...(next.check?.doubt == null ? {} : { doubt: next.check.doubt }), ...(next.check === undefined || next.check.asks.length === 0 ? {} : { asks: next.check.asks }),
    });
    if (stands !== "in") return { account, status: follows(), reached, devices: [], pcs: [] };
    const history = historyOf(copy);
    if (named === null || named.history !== history || (!named.complete && ask !== null)) {
      const opened = await epochsOf(copy, state, history, keys, ask);
      const nameAt = (seq: number): Promise<ListNames | null> => namesAt(copy.list, copy.entries, seq, opened.keys);
      // the row of this device's own: the key that stands where it came in (a carried device's sign-in key until its
      // hand-over is placed, its account key after), and its account key otherwise
      const selfKey = standsFor(state, copy.me.key) ?? keys.key;
      const devices: ListedDevice[] = [];
      for (const row of shownDevices(copy)) {
        // in by a key the same device handed its place on to: the entry that let the key in ended the key that signed it
        const handed = row.by !== null && state.signers[row.by]?.ended === row.seq && copy.entries[row.seq] !== undefined;
        const moved = handed ? readBody(entryFromText(copy.entries[row.seq]!).body).issued_at : undefined;
        devices.push({ key: row.key, self: row.key === selfKey, power: row.power, role: row.role, until: row.until, carried: row.carried, name: await nameAt(row.seq), ...(moved === undefined ? {} : { moved }) });
      }
      const pcs: ListedPc[] = [];
      // a PC that came in after this device did, by another's signature, is new to it from when it first held the entry
      const own = shownDevices(copy).find((row) => row.key === selfKey)?.seq ?? null;
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

  /** The PCs' answers, the record and the factor a move goes by (MigrationOptions). */
  const answers = options.migration?.answers ?? pageAnswers;
  const seenStorage = options.migration?.storage;
  const recordOf = (account: string) => seenStorage === undefined ? readSeenPcs(account) : readSeenPcs(account, seenStorage);
  const tryNoted = (account: string): Promise<void> => seenStorage === undefined ? noteTried(account, now()) : noteTried(account, now(), seenStorage);
  const tryEnded = (account: string): Promise<void> => seenStorage === undefined ? clearTried(account) : clearTried(account, seenStorage);
  const scaleOf = (): number => {
    const scale = options.migration?.scale?.() ?? 1;
    return Number.isSafeInteger(scale) && scale >= 1 ? scale : 1;
  };

  /** This device's sign-in key, as a signer, while it is the registered key of the sign-in stored now; null otherwise. */
  const signInOf = async (session: AccountSession): Promise<ListSigner | null> => {
    const kept = await accountStore.get("signin_key");
    if (kept === undefined || kept.account !== session.account || kept.sign_in_id !== session.sign_in_id || kept.no === null || !isListKey(kept.key.public_spki)) return null;
    return { key: kept.key.public_spki, privateKey: kept.key.private_key };
  };

  /** A device keeps the move's notice until the person saw it: what the list carried in, as the list shows it. */
  const keepNotice = async (account: string, state: ListState, first: string): Promise<void> => {
    if (readNotice(await store.get("notice", account))?.list === state.list) return;
    const rows = listView(state);
    await store.set("notice", account, noticeRecord({
      list: state.list, first, devices: rows.devices.filter((row) => row.carried).map((row) => row.key),
      pcs: rows.pcs.filter((row) => row.how === "carried").map((row) => row.endpoint), seen: false,
    }));
  };

  /**
   * Lets the birth `birth` go, with the final refusal that let it go (null for none), in one write over the very record
   * that held it: where the record holds another request by now (another tab's), this answer is not its, and nothing
   * changes.
   */
  const retireBirth = async (account: string, birth: KeptBirth, refusal: MoveRefusal | null): Promise<void> => {
    const now = await store.get("birth", account);
    if (readBirth(now)?.list !== birth.list) return;
    const text = retiredText(birth.list, refusal);
    if (typeof now === "string") await store.swap("birth", account, now, text);
    else await store.set("birth", account, text);
  };

  /**
   * Sends a birth this device kept, as it is (X5): placed (201, or `409 list_exists` naming this very list); the account
   * has another list (`409 list_exists` naming another), so this one is given up for good; or not known yet (no answer,
   * a 429, a 5xx, a 401, a success other than the 201, a refusal that names nothing, a refusal of the caller rather than
   * of the birth), and it is sent again as it is at the next round, which first asks the account service which list the
   * account has. The birth's own final refusal (a 400 or a 413 of its body, a `403 not_carried`) lets it go, in the same
   * write as the refusal; the next plan comes no sooner than MOVE_AGAIN_SECONDS later, without the key or the PC a
   * `403 not_carried` named (rulings-migrate-3.md, its addendum on GET /v1/devices).
   */
  const sendBirth = async (bound: AccountService, account: string, birth: KeptBirth, signal: AbortSignal): Promise<"placed" | "other" | MoveState> => {
    const sending: MoveState = { why: "sending", wait: null, asks: [] };
    try {
      await bound.startBirth({ entry: birth.entry, entries: birth.entries, wraps: birth.wraps, ...(birth.link === null ? {} : { link: birth.link }) }, signal);
      return "placed";
    } catch (error) {
      const said = refusalOf(error);
      if (said === null) {
        if (!unreached(error)) throw error;
        return sending;
      }
      if (said.status === 409 && said.code === "list_exists") {
        // a list_exists that names nothing says nothing of this birth: which list the account has is asked at the next round
        if (said.list === null) return sending;
        if (said.list === birth.list) return "placed";
        await retireBirth(account, birth, null);
        await giveUp(account, birth.list);
        return "other";
      }
      const notCarried = said.status === 403 && said.code === "not_carried";
      // a refusal of the caller (a frozen or borrowed sign-in, a route the service hides, ...), or one that names
      // nothing, is no answer about the birth
      if (said.code === "http_error" || (!notCarried && said.status !== 400 && said.status !== 413)) return sending;
      const about = notCarried ? notCarriedAt(birth, said.index) : null;
      // its list id is not given up: no other birth can ever have it
      await retireBirth(account, birth, {
        at: seconds(),
        keys: [...birth.skip.keys, ...about !== null && "key" in about ? [about.key] : []],
        endpoints: [...birth.skip.endpoints, ...about !== null && "endpoint" in about ? [about.endpoint] : []],
      });
      return { why: "refused", wait: MOVE_AGAIN_SECONDS, asks: [] };
    }
  };

  /**
   * The first device's move of an account that was in use onto its list (Part F, F1 to F4): a birth it kept is sent
   * again, while the account service opens the move for the account (`migrate`; with the switch withdrawn it is kept as
   * it is, `paused`) and has answered every block of this device's own on a key the birth carries; otherwise, an hour after a final refusal at the soonest, it plans from the account service's
   * devices and PCs, its own record of its PCs and what they answered in this run, signs the birth once and keeps it,
   * over the very record it read (one birth per account on this device, whatever its tabs do), and sends the birth the
   * record holds: its own, or the one another tab kept first.
   */
  const move = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, migrate: boolean, signal: AbortSignal): Promise<"placed" | "other" | MoveState> => {
    const { account } = session;
    const slot = await store.get("birth", account);
    const kept = readBirth(slot);
    if (kept !== null) {
      if (!migrate) return { why: "paused", wait: null, asks: [] };
      // a block of this device's own on a key the birth carries goes to the account service first: once it is answered,
      // the service judges the birth by it (a frozen sign-in is not carried), and the birth goes as it is (X5)
      const blocks = Object.values(await accountStore.get("unsent_blocks") ?? {}).filter((entry) => entry.account === account && entry.refused !== true);
      if (blocks.some((entry) => entry.records.some((record) => kept.carried.devices.includes(record.target)))) return { why: "sending", wait: null, asks: [] };
      return await sendBirth(bound, account, kept, signal);
    }
    const signIn = await signInOf(session);
    if (signIn === null) return { why: "self_unlisted", wait: null, asks: [] };
    const at = seconds();
    const refusal = readRetired(slot)?.refusal ?? null;
    // a clock that moved back counts as no time passed
    if (refusal !== null && elapsed(refusal.at, at) < MOVE_AGAIN_SECONDS) return { why: "refused", wait: MOVE_AGAIN_SECONDS - elapsed(refusal.at, at), asks: [] };
    // the service refused this device's own key in a birth: it starts none, and asks to be let in as a new device does
    if (refusal?.keys.includes(signIn.key) === true) return { why: "self_unlisted", wait: null, asks: [] };
    const [devices, directory] = [await bound.devices(signal), await bound.listPcs(signal)];
    const record = recordOf(account);
    const scale = scaleOf();
    const letIn = new Set(directory.flatMap((pc) => (pc.public_key === null ? [] : [pc.public_key])));
    const label = new Map(directory.flatMap((pc) => (pc.public_key === null ? [] : [[pc.public_key, pc.label] as const])));
    // every PC this device knows by its own record is a witness, whatever the directory says of it; only one the
    // directory lists as let in, and no refusal named, is carried in (the service would refuse any other)
    const pcs = knownPcs({ account, record, letIn: null, answers, now: at, scale, names: (endpoint) => { const name = label.get(endpoint); return name === undefined ? null : listNames(name, null); } });
    const skipped = { keys: new Set(refusal?.keys ?? []), endpoints: new Set(refusal?.endpoints ?? []) };
    const known: MigrationKnown = {
      account, self: signIn.key, member: keys.key,
      // each carried device is named by the name its sign-in registered with the account service, where it sent one
      devices: devices.filter((device) => !device.removed && !skipped.keys.has(device.key)).map((device) => ({ key: device.key, eligible: device.eligible, names: device.label === undefined ? null : listNames(device.label, null) })),
      removed: [...devices.filter((device) => device.removed).map((device) => device.key), ...await options.migration?.removed?.(account) ?? []],
      pcs,
    };
    if (record.tried === undefined) await tryNoted(account);
    const planned = migrationPlan(known, record.tried === undefined ? 0 : scaled(record.tried, at, scale));
    const asks = pcs.filter((pc) => pc.says === null && ownEvidence(pc)).map((pc) => pc.endpoint);
    if (!planned.start) return { why: planned.why, wait: planned.wait === null ? null : Math.ceil(planned.wait / scale), asks };
    const plan = { devices: planned.plan.devices, pcs: planned.plan.pcs.filter((pc) => letIn.has(pc.endpoint) && !skipped.endpoints.has(pc.endpoint)) };
    // signed once, and kept before it is sent: a lost answer or a closed page makes no second one
    const sealed = birthSeals();
    const member = { key: keys.key, privateKey: keys.signs };
    const made = await signMigration(account, plan, { signIn, member, enc: keys.enc.key, names: options.names?.() ?? null }, at, sealed.seals);
    const [entry, ...entries] = made.entries.map((written) => written.text);
    if (entry === undefined) throw new RangeError("A birth holds entry 0");
    const birth: KeptBirth = {
      list: made.list, signIn: signIn.key, member: keys.key, entry, entries, wraps: sealed.wraps(), enc: keys.enc.key, at,
      link: await signLink({ account, list: made.list, member, device: signIn }),
      carried: { devices: plan.devices.map((device) => device.key), pcs: plan.pcs.map((pc) => pc.endpoint) },
      skip: { keys: [...skipped.keys], endpoints: [...skipped.endpoints] },
    };
    if (await store.swap("birth", account, typeof slot === "string" ? slot : undefined, birthText(birth))) return await sendBirth(bound, account, birth, signal);
    // another tab kept a birth first: that one is the one signature, and this one is never sent
    const winner = readBirth(await store.get("birth", account));
    return winner === null ? { why: "sending", wait: null, asks: [] } : await sendBirth(bound, account, winner, signal);
  };

  /**
   * The keys of this device's own blocks (`own_blocks`) that the list its own birth made holds, each by the key that
   * stands for it now (#4652, b2): X5 sends a kept birth as it is, so a key blocked after it was signed may be carried
   * in, by a block the service refused for good or a service that placed the birth all the same. The device's first
   * write in that list puts them out.
   */
  const owedOf = async (account: string, copy: FollowerCopy, keys: DeviceListKeys): Promise<string[]> => {
    const { state } = copy;
    if (copy.pin.how !== "genesis" || state === null || !movedList(state)) return [];
    const blocked = (await accountStore.get("own_blocks"))?.[account] ?? [];
    return [...new Set(blocked.flatMap((key) => { const now = standsFor(state, key); return now === null || now === keys.key ? [] : [now]; }))];
  };

  /** Whether a list was born by a move: its first signer handed its place on, or it carried somebody in. */
  const movedList = (state: ListState): boolean => {
    const first = Object.entries(state.signers).find(([, row]) => row.seq === 0)?.[0] ?? null;
    return (first !== null && heirOf(state, first) !== null) || Object.values(state.devices).some((row) => row.carried) || Object.values(state.pcs).some((row) => row.how === "carried");
  };

  /**
   * A device that a moved list may have carried in, shown that list (Part F, F5): it reads the log without keeping any of
   * it, finds where it stands (devicePlace), and follows only once the PCs it knows by its own record say who started it
   * (joinVerdict). A copy to follow; a state to say (it waits, or it refused); or null: the list holds it nowhere, and it
   * asks to be let in as any new device does.
   */
  const joining = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, hint: ListHint, signal: AbortSignal, stopped: AbortSignal): Promise<{ readonly copy: FollowerCopy } | { readonly without: Without } | null> => {
    const { account } = session;
    const signIn = await signInOf(session);
    if (signIn === null) return null;
    const pinned = pinList(null, { account, list: hint.list, me: { key: signIn.key, endpoint: null }, pin: { how: "carried" } });
    if (!pinned.pinned) return null;
    let got: Awaited<ReturnType<typeof pages>>;
    try {
      got = await pages(bound, pinned.copy, null, stopped);
    } catch (error) {
      if (stopped.aborted || !unreached(error)) throw error;
      return { without: { at: "not_in", list: hint.list, why: "unread", claim: "unclaimed" } };
    }
    const { state } = got.copy;
    // a read that did not finish says nothing of where this device stands: it reads again at the next round
    if (got.cut || state === null) return { without: { at: "not_in", list: hint.list, why: "unread", claim: "unclaimed" } };
    const place = devicePlace(state, { signIn: signIn.key, member: keys.key });
    const waiting = (join: JoinState): { readonly without: Without } => ({ without: { at: "not_in", list: hint.list, why: "carried", claim: "unclaimed", join } });
    if ((place.at === "carried" || place.at === "absent") && place.wait) return waiting({ why: "run_open", wait: null, pcs: [] });
    if (place.at === "first") {
      // entry 0 is this very sign-in's: the list it made, whose answer it lost with its kept birth
      const own = pinList(null, { account, list: hint.list, me: { key: signIn.key, endpoint: null }, pin: { how: "genesis" } });
      return own.pinned ? { copy: own.copy } : null;
    }
    const record = recordOf(account);
    const scale = scaleOf();
    const at = seconds();
    const pcs = knownPcs({ account, record, letIn: null, answers, names: () => null, now: at, scale });
    // a device that handed its place on and keeps no copy (it reset the one its PCs did not know, V4-6): it asks to be let
    // in, and says why while a PC it knows says it
    if (place.at === "member") {
      const doubt = listDoubt(state, pcs, []);
      return doubt === null ? null : { without: { at: "not_in", list: hint.list, why: "not_mine", claim: await claim(bound, account, keys, hint.list, "unclaimed", signal), refused: doubt } };
    }
    if (place.at !== "carried") return null;
    if (record.tried === undefined) await tryNoted(account);
    const verdict = joinVerdict(state, { signIn: signIn.key, member: keys.key }, pcs, record.tried === undefined ? 0 : scaled(record.tried, at, scale));
    if (verdict.pin) {
      await tryEnded(account);
      // what it goes on checking against: the PCs that agreed now; the others are asked about the list for three days more
      const agreed = pcs.filter((pc) => pc.says !== null && pc.says.account === account && ownEvidence(pc) && pcAgrees(state, pc.says)).map((pc) => pc.endpoint);
      await store.set("joined", account, joinedRecord({ list: state.list, at, agreed }));
      return { copy: got.copy };
    }
    if (verdict.waits) return waiting({ why: verdict.why, wait: verdict.wait === null ? null : Math.ceil(verdict.wait / scale), pcs: verdict.pcs });
    // refused: it says so, names no list to anybody, and asks to be let in as a new device does
    await tryEnded(account);
    return { without: { at: "not_in", list: hint.list, why: "not_mine", claim: await claim(bound, account, keys, hint.list, "unclaimed", signal), refused: { why: verdict.why, pcs: verdict.pcs } } };
  };

  /**
   * A carried device that follows its list hands its place to its member key (signRotation), with the D11.2 link of the
   * two, placed with no claim (Part F, F10b's later hand-over). Kept before it is sent and sent again as it is while the
   * copy shows the head it was signed on (X5); a refusal that is final waits for a new head, or MOVE_AGAIN_SECONDS.
   */
  const handOver = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, copy: FollowerCopy, signal: AbortSignal): Promise<void> => {
    const { account } = session;
    const state = copy.state;
    if (state === null) return;
    let kept = readHandOver(await store.get("handover", account));
    // where the copy shows the carried key no longer carried (handed over, or put out), what was kept for it is done
    const place = devicePlace(state, { signIn: copy.me.key, member: keys.key });
    if (place.at !== "carried" || place.wait) {
      if (kept !== null) await store.set("handover", account, undefined);
      return;
    }
    const signIn = await signInOf(session);
    if (signIn === null || copy.me.key !== signIn.key) return;
    // kept for another account key or encryption key than this device holds now: it ends there, and is never sent (C2)
    if (kept !== null && (kept.member !== keys.key || kept.enc !== keys.enc.key)) {
      await store.set("handover", account, undefined);
      return;
    }
    const at = seconds();
    const head = { seq: state.footing.seq, hash: state.footing.hash };
    if (kept !== null && (kept.list !== copy.list || kept.signIn !== signIn.key || kept.on.seq !== head.seq || kept.on.hash !== head.hash)) kept = null;
    if (kept !== null && kept.refused_at !== null) {
      if (elapsed(kept.refused_at, at) < MOVE_AGAIN_SECONDS) return;
      kept = null;
    }
    if (kept === null) {
      const member = { key: keys.key, privateKey: keys.signs };
      let entry: string;
      try {
        entry = (await signRotation(state, { signIn, member, enc: keys.enc.key }, at, null)).text;
      } catch (error) {
        if (!(error instanceof MigrationError)) throw error;
        console.info("Ovis: this device hands its place in the list on to its account key later", error.code);
        return;
      }
      kept = { list: copy.list, signIn: signIn.key, member: keys.key, enc: keys.enc.key, on: head, entry, link: await signLink({ account, list: copy.list, member, device: signIn }), refused_at: null };
      await store.set("handover", account, handOverRecord(kept));
    }
    try {
      await bound.placeEntries(copy.list, [kept.entry], [], signal, undefined, kept.link);
      readAsked = true;
    } catch (error) {
      const said = refusalOf(error);
      if (said === null || said.status === 429 || said.status >= 500) {
        if (!unreached(error)) throw error;
        return;
      }
      readAsked = true;
      // the list moved meanwhile: signed again on the head the next read shows
      if (said.status === 409 && said.code === "head_moved") await store.set("handover", account, undefined);
      else await store.set("handover", account, handOverRecord({ ...kept, refused_at: at }));
    }
  };

  /**
   * A carried device that follows its list checks it against what the PCs it knows say in this run (V4-6): a doubt
   * when one says against it, and which PCs it still asks (those that have not agreed, for three days after the join).
   * A PC that agrees is kept among those that did. Undefined for any other copy, or where the join was not kept.
   */
  const checkJoined = async (account: string, copy: FollowerCopy): Promise<Held["check"]> => {
    if (copy.pin.how !== "carried" || copy.state === null) return undefined;
    const joined = readJoined(await store.get("joined", account));
    if (joined === null || joined.list !== copy.list) return undefined;
    const { state } = copy;
    const scale = scaleOf();
    const at = seconds();
    const pcs = knownPcs({ account, record: recordOf(account), letIn: null, answers, names: () => null, now: at, scale });
    const agreed = [...new Set([...joined.agreed, ...pcs.filter((pc) => pc.says !== null && pc.says.account === account && ownEvidence(pc) && pcAgrees(state, pc.says)).map((pc) => pc.endpoint)])];
    if (agreed.length !== joined.agreed.length) await store.set("joined", account, joinedRecord({ ...joined, agreed }));
    const open = scaled(joined.at, at, scale) < MIGRATION_ANSWER_SECONDS;
    // a PC that has not agreed yet, silent or with an answer that waits (the key that started the list let in for less
    // than a day), is asked again; one that answered for another account is no PC of it
    const asks = open ? pcs.filter((pc) => (pc.says === null || pc.says.account === account) && ownEvidence(pc) && !agreed.includes(pc.endpoint)).map((pc) => pc.endpoint) : [];
    return { doubt: listDoubt(state, pcs, agreed), asks };
  };

  /** What a round does with the list the account service names (`named`: null for none); `loaded` is what this device saved. */
  const follow = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, loaded: Held, told: ListHint | null, signal: AbortSignal, stopped: AbortSignal, migrate = false): Promise<Held> => {
    const { account } = session;
    let hint = told;
    let copy = loaded.copy;
    const fresh = copy === null;
    // a member that let this device in named its list: that word, checked against the log, comes before the service's
    if (copy === null) copy = await offered(bound, account, keys, stopped);
    const handed = fresh && copy !== null;
    /** The list this device moved its account onto, and the birth it kept for it, until the copy is saved. */
    let born: KeptBirth | null = null;
    /** The first signer of a moved list this device was carried into and now follows, for its notice. */
    let carriedFrom: string | null = null;
    if (copy === null) {
      if (hint === null) {
        // a birth this device kept goes first: sent again as it is, whatever else is said now
        let started: "placed" | "exists" | NoGenesis | MoveState = readBirth(await store.get("birth", account)) === null ? await start(bound, session, keys, signal) : "moving";
        // an account that was in use, on the account service's migrate switch: the first device moves it onto its list.
        // A new birth is signed only on storage that lasts, as a genesis is; one kept already is sent whatever.
        const newBirth = migrate && (started === "not_new" || started === "not_first_device" || started === "has_pcs");
        if (newBirth && !await (options.durable ?? storageLasts)()) started = "storage";
        else if (started === "moving" || newBirth) {
          const moved = await move(bound, session, keys, migrate, signal);
          started = moved === "placed" || moved === "other" ? "exists" : moved;
        }
        if (typeof started === "object") return { ...loaded, without: { at: "none", why: "moving", move: started } };
        if (started !== "placed" && started !== "exists") return { ...loaded, without: { at: "none", why: started } };
        const after = await bound.accountList(signal);
        const named = after === "off" ? null : after.hint;
        if (named === null) throw new AccountServiceError(502, "invalid_answer", "The account service took a list and names none");
        hint = named;
      }
      const birth = readBirth(await store.get("birth", account));
      if (birth !== null && birth.list === hint.list) born = birth;
      // a list that is not this device's own is not read again while the account service names it: the device waits to
      // be let in, and keeps its claim of its own key standing. One that carried it in is asked about again at every
      // round, while it waits on its PCs and after it refused: the refusal clears when its cause does.
      if (loaded.without.at === "not_in" && loaded.without.why === "not_mine" && loaded.without.refused === undefined && loaded.without.list === hint.list) {
        return { ...loaded, without: { ...loaded.without, claim: await claim(bound, account, keys, hint.list, loaded.without.claim, signal) } };
      }
      // nor is a list whose entry 0 this device signed and gave up: it follows that one never, whoever names it
      if (readDropped(await store.get("dropped", account)).includes(hint.list)) return { ...loaded, without: { at: "not_in", list: hint.list, why: "not_mine", claim: "unclaimed" } };
      // the list this device moved its account onto is pinned under the sign-in key that signed its entry 0
      const me: FollowerSelf = { key: born === null ? keys.key : born.signIn, endpoint: null };
      const pinned = pinList(null, { account, list: hint.list, me, pin: { how: "genesis" } });
      if (!pinned.pinned) throw new RangeError("This account or this device's key cannot follow a list");
      // only entry 0 says whether this device started the list, and entry 1 whether a move carried others in with it;
      // nothing else of it is asked for before that
      const first = startRead(pinned.copy, "service");
      const page = await bound.listLog(hint.list, first.after, signal, 2);
      const began = await takePage(pinned.copy, first, { list: page.list, after: page.after, entries: page.entries.slice(0, 1), head: page.head }, seconds());
      const pending = readPending(await store.get("genesis", account), keys);
      if (began.copy.state === null) {
        // not this device's own only when what was shown is that list's entry 0: anything else is the account service not showing it
        const shown = page.list === hint.list && hashOf(page.entries[0]) === hint.list;
        const why = !shown ? "unread" : began.verdict === "needs_newer_client" ? "needs_newer_client" : began.verdict === "not_my_list" ? "not_mine" : "unread";
        // the account has a list that is not the one this device signed: its own will never be the account's
        if (why === "not_mine" && pending !== null && pending.list !== hint.list) await giveUp(account, pending.list);
        // a list born by a move: this device may be one it carried in
        const joined = why === "not_mine" && kindAt(page.entries[1]) === "carried" ? await joining(bound, session, keys, hint, signal, stopped) : null;
        // a read of the list that did not finish decides nothing: the next round reads again
        if (joined !== null && "without" in joined) return { ...loaded, without: joined.without, ...(joined.without.at === "not_in" && joined.without.why === "unread" ? { unread: true as const } : {}) };
        if (joined === null) return { ...loaded, without: { at: "not_in", list: hint.list, why, claim: why === "not_mine" ? await claim(bound, account, keys, hint.list, "unclaimed", signal) : "unclaimed" } };
        ({ copy } = joined);
        carriedFrom = joined.copy.state === null ? null : Object.entries(joined.copy.state.signers).find(([, row]) => row.seq === 0)?.[0] ?? null;
      } else ({ copy } = began);
      if (pending !== null && pending.list === copy.list) await store.set("wraps", account, wrapsRecord({ list: copy.list, member: keys.enc.key, wraps: new Map([[0, pending.wrap]]) }));
      // the key of the epoch the birth opened, wrapped to this device itself: the link under it gives the one before
      const wrap = born?.wraps.find((one) => one.member === keys.enc.key);
      if (born !== null && wrap !== undefined) await store.set("wraps", account, wrapsRecord({ list: copy.list, member: keys.enc.key, wraps: new Map([[wrap.epoch, wrap.wrap]]) }));
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
    if (fresh && born !== null) {
      // the list this device made is followed only once the copy holds its whole birth, through its `epoch`: a read
      // that stops short of it saves nothing and decides nothing, and the kept birth stays for the next round
      const got = await pages(bound, copy, null, stopped).catch((error: unknown) => {
        if (stopped.aborted || !unreached(error)) throw error;
        return null;
      });
      if (got === null || !holdsBirth(got.copy, born)) return { ...loaded, without: { at: "none", why: "moving", move: { why: "sending", wait: null, asks: [] } }, unread: true };
      ({ copy, verdict } = got);
      saved = await save(loaded, copy);
      behind = got.more;
    } else if (heard.verdict === "read" || other || heard.verdict === "none" || forced) {
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
    const kept = born ?? readBirth(await store.get("birth", account));
    // a birth kept for another list than the verified one this device follows can never be the account's: it is let go
    if (kept !== null && kept.list !== copy.list && copy.state !== null) await retireBirth(account, kept, null);
    // a move whose whole birth the copy holds: the birth is let go, the try ended, and the notice waits for the person
    const finished = born ?? (copy.pin.how === "genesis" ? kept : null);
    if (finished !== null && finished.list === copy.list && copy.state !== null && holdsBirth(copy, finished)) {
      await keepNotice(account, copy.state, finished.signIn);
      await retireBirth(account, finished, null);
      await tryEnded(account);
    }
    if (fresh && carriedFrom !== null && copy.state !== null) await keepNotice(account, copy.state, carriedFrom);
    // a carried device that follows its list checks it against its PCs, and hands its place on to its member key only
    // while none of them says against it, and its copy holds no alarm of another history
    const check = await checkJoined(account, copy);
    if (copy.pin.how === "carried" && copy.state !== null && copy.alarm === null && (check?.doubt ?? null) === null) await handOver(bound, session, keys, copy, signal);
    const owed = await owedOf(account, copy, keys);
    return { account, copy, saved, trouble: worst([troubleOf(verdict), other ? "other_list" : null]), without: { at: "off" }, ...(unread ? { unread: true as const } : {}), ...(behind ? { behind: true as const } : {}), ...(check === undefined ? {} : { check }), ...(owed.length === 0 ? {} : { owed }) };
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
      /** The account has no list and is on the account service's migrate switch (Part F, F10.1). */
      let migrate = false;
      try {
        const answer = await bound.accountList(signal);
        hint = answer === "off" ? "off" : answer.hint;
        migrate = answer !== "off" && answer.migrate;
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
      let loaded = await loadFor(account, keys, saved, session);
      if (typeof loaded === "string") {
        held = null;
        return publish({ account, status: loaded === "version" ? { at: "newer_save" } : { at: "damaged", why: loaded }, reached: hint !== undefined, devices: [], pcs: [] });
      }
      // what a PC handed over and this page could not save is written first, over the text it was taken on
      if (loaded.unsaved === true && loaded.copy !== null) {
        const { unsaved: _written, ...rest } = loaded;
        loaded = { ...rest, saved: await save(loaded, loaded.copy) };
      }
      let next = loaded;
      // for a device that follows a list, an account off the service's switch is the service being away, never "the list is gone"
      let reached = hint !== undefined && hint !== "off";
      let view: AccountListView;
      try {
        if (hint !== undefined && hint !== "off") {
          try {
            next = await follow(bound, session, keys, loaded, hint, signal, stopped, migrate);
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

  /** AccountList.takeFromPeer, under the account's lock: one page at a time among this page's rounds and the other pages'. */
  /** ListWriter.live for writers of `account`'s `list`: one function for all of them, read from this page's copy at each call. */
  let lives: { readonly account: string; readonly list: string; readonly live: () => Promise<boolean> } | null = null;
  const liveFor = (account: string, list: string): (() => Promise<boolean>) => {
    if (lives === null || lives.account !== account || lives.list !== list) {
      const mine = (): boolean => {
        const now = held?.copy ?? null;
        return held !== null && held.account === account && now !== null && now.list === list && now.alarm === null;
      };
      lives = { account, list, live: async () => {
        if (!mine()) return false;
        // and what the pages of this device saved: another page may have saved an alarm this page has not read yet
        const saved = await store.get("copy", account);
        // and this page's own copy again: an alarm it raised while that was read, and could not save, ends the write too
        if (!mine()) return false;
        if (typeof saved !== "string") return true;
        try {
          const read = JSON.parse(saved) as { list?: unknown; alarm?: unknown };
          return !(read.list === list && read.alarm !== null && read.alarm !== undefined);
        } catch { return false; }
      } };
    }
    return lives!.live;
  };

  const takeFromPeer = async (page: PeerPage, asked: FollowRead | null): Promise<PeerTake | null> => {
    const session = await service.session();
    if (session === undefined) return null;
    const { account } = session;
    return lock(account, async () => {
      for (let tries = 1; tries <= SAVE_TRIES; tries += 1) {
        const saved = await store.get("copy", account);
        if (saved === undefined) return null;
        const keys = await deviceListKeys(accountStore);
        let loaded: Held | SaveRefusal;
        try { loaded = await loadFor(account, keys, saved, session); } catch (error) {
          if (error instanceof StaleCopyError) continue;
          throw error;
        }
        if (typeof loaded === "string" || loaded.copy === null || loaded.copy.state === null) return null;
        const copy = loaded.copy;
        if (asked !== null && asked.list !== copy.list) return null;
        // the request this page answers; a page nobody asked for is taken from the place it names
        const after = isRecord(page) && (page.after === null || (typeof page.after === "number" && Number.isSafeInteger(page.after) && page.after >= 0)) ? page.after : undefined;
        const read: FollowRead = asked !== null && (after === undefined || after === asked.after) ? asked : { ...startRead(copy, "peer"), ...(after === undefined ? {} : { after }) };
        const took = await takePage(copy, read, page, seconds());
        let next: Held;
        let wrote = true;
        try {
          next = { ...loaded, copy: took.copy, saved: await save(loaded, took.copy) };
          if (next.unsaved === true) { const { unsaved: _written, ...rest } = next; next = rest; }
        } catch (error) {
          if (error instanceof StaleCopyError) continue;
          // verified and not saved: acted on from memory all the same, written by the next round, and not said to be taken
          console.warn("Ovis: entries of the account's list a PC handed over could not be saved", error instanceof Error ? error.name : error);
          next = { ...loaded, copy: took.copy, unsaved: true };
          wrote = false;
        }
        const view = await viewOf(next, keys, null);
        // installed only for the sign-in it was begun under: another page that signed this browser in to another
        // account meanwhile is shown nothing of this one, and a PC is told nothing of it under that one
        const still = await service.session();
        if (still === undefined || !sameSignIn(still, session)) return null;
        held = next;
        // a peer's page is no word of the account service's: whether that was reached stays as the last round found
        publish({ ...view, reached: shown.account === account && shown.reached });
        return { verdict: took.verdict, read: took.read, saved: wrote };
      }
      return null;
    });
  };

  /** The removal the device owes the list its own birth made, while it is under way: the rounds its write reads in pay nothing again. */
  let paying: Promise<void> | null = null;
  /**
   * Puts out the keys the device owes its list (Held's `owed`) through the devices step's removal, kept and sent
   * again like any write (operation `not-me:<key>:<digest>`); a removal that is not placed yet is tried at the next round.
   */
  const payOwed = async (): Promise<void> => {
    const owed = held?.owed ?? [];
    if (owed.length === 0) return;
    try {
      const outcome = await removeFromList(page, { keys: [...owed], pcs: [] }, { operation: `not-me:${owed[0]}`, writer: () => page.writer({ owed: true }) });
      if (!outcome.removed) console.info("Ovis: the removal of a key this device blocked is not placed in its list yet", outcome.why);
    } catch (error) {
      console.info("Ovis: the removal of a key this device blocked is not placed in its list yet", error instanceof Error ? error.name : error);
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
    return running.then(async (view) => {
      if (paying !== null || (held?.owed?.length ?? 0) === 0) return view;
      paying = payOwed().finally(() => { paying = null; });
      await paying;
      return shown;
    });
  };

  const page: AccountList = {
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
      const mine: KeptRequest = { list: writer.list, key: writer.keys.key, on: { seq: writer.state.footing.seq, hash: writer.state.footing.hash }, entries: request.entries, wraps: request.wraps, place: request.place, for: request.for, at: writer.issued_at, ...(request.invite === undefined ? {} : { invite: request.invite }) };
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
      if ((held.owed?.length ?? 0) > 0 && options.owed !== true) return null;
      const at = seconds();
      const { account } = held;
      const { list } = copy;
      return {
        account, list, state: copy.state, keys: ctx.keys, service: ctx.bound,
        epochs: named !== null && named.history === historyOf(copy) ? named.keys : new Map(),
        // Whose time is over is judged by this device's own clock, held against the floor it saved and the list's own
        // time, and an entry is dated by that clock: never by the account service's, which could otherwise make a
        // member sign a removal, or a time, that nothing undoes
        clock: listClock(copy.state, at, null),
        issued_at: at,
        shown: this.shown(),
        adrift: copy.seen_at !== null && at < copy.seen_at - ADRIFT_SECONDS,
        live: liveFor(account, list),
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
    compare(theirs) {
      const copy = held?.copy ?? null;
      return copy === null || copy.state === null ? null : compareHeads(copy, theirs);
    },
    knowsPc(serverId) {
      const state = held?.copy?.state ?? null;
      return state !== null && Object.keys(state.pcs).some((endpoint) => /^[0-9a-f]{64}$/.test(endpoint) && deriveServerId(hexToBytes(endpoint)) === serverId);
    },
    takeFromPeer,
    async naming(given) {
      /** The copy to name, while it is the one of `given.account` this page holds and follows, and nothing stands in the way. */
      const current = (): FollowerCopy | null => {
        const copy = held?.copy ?? null;
        const { status } = shown;
        if (copy === null || copy.state === null || ctx === null || held?.account !== given.account || ctx.account !== given.account || shown.account !== given.account) return null;
        // nor a list a PC it knows says it does not know (V4-6)
        return status.at === "following" && status.standing === "in" && status.trouble === null && status.doubt === undefined && movedList(copy.state) ? copy : null;
      };
      const copy = current();
      if (copy === null || copy.state === null || ctx === null) return null;
      const keys = ctx.keys;
      const session = await service.session();
      const signIn = session === undefined || session.account !== given.account ? null : await signInOf(session);
      // what was read is still what this device follows, after the waits
      if (current() !== copy || ctx?.keys !== keys) return null;
      const state = copy.state!;
      const holds = standsFor(state, copy.me.key);
      const member = holds === keys.key ? { key: keys.key, privateKey: keys.signs } : signIn !== null && holds === signIn.key ? signIn : null;
      if (member === null) return null;
      const naming = await signNaming(state, { member, session: given.session, endpoint: given.endpoint });
      if (naming === null) return null;
      // the sign-in key this session signed in with vouches for the account key, while it is this device's of now
      const vouching = given.signIn !== null && given.signIn === given.session && signIn !== null && signIn.key === given.signIn && member.key === keys.key;
      const vouch = vouching ? await signVouch(state, { signIn, member }) : null;
      return { naming, vouches: vouch === null ? [] : [vouch] };
    },
    async notice(account) {
      const notice = readNotice(await store.get("notice", account));
      const copy = held?.account === account ? held.copy : null;
      const own = ctx?.account === account ? ctx.keys.key : null;
      if (notice === null || notice.seen || copy === null || copy.state === null || copy.list !== notice.list || own === null || shown.account !== account) return null;
      const { state } = copy;
      // this device, by the key the list holds it by now, its account key and the sign-in key it was carried in by
      const self = new Set([own, copy.me.key, standsFor(state, copy.me.key)]);
      // a device is named as the list names the key it stands by now, else by the name the birth sealed for the key it
      // was carried in by: its hand-over carries no name of its own
      const opened = named !== null && named.history === historyOf(copy) ? named.keys : new Map<number, EpochKey>();
      const nameOf = async (now: string, carried: string): Promise<ListNames | null> => {
        const shownName = shown.devices.find((row) => row.key === now)?.name ?? null;
        const at = rowOf(state.signers, carried)?.seq;
        return shownName ?? (at === undefined ? null : await namesAt(copy.list, copy.entries, at, opened));
      };
      const first = standsFor(state, notice.first);
      const devices: { key: string; name: ListNames | null }[] = [];
      const removed: { key: string; name: ListNames | null }[] = [];
      // a device this device blocked itself and put out of the list again (#4652, b2)
      const blocked = new Set((await accountStore.get("own_blocks"))?.[account] ?? []);
      for (const key of notice.devices) {
        const now = standsFor(state, key);
        if (now !== null && !self.has(now)) devices.push({ key: now, name: await nameOf(now, key) });
        else if (now === null && blocked.has(key)) removed.push({ key, name: await nameOf(key, key) });
      }
      const pcs = notice.pcs.flatMap((endpoint) => { const row = shown.pcs.find((pc) => pc.endpoint === endpoint); return row === undefined ? [] : [{ endpoint, name: row.name }]; });
      return { list: notice.list, first: { self: first !== null && self.has(first), key: first, name: first === null ? null : await nameOf(first, notice.first) }, devices, pcs, removed };
    },
    async noticeSeen(account, list) {
      await lock(account, async () => {
        const notice = readNotice(await store.get("notice", account));
        if (notice !== null && notice.list === list && !notice.seen) await store.set("notice", account, noticeRecord({ ...notice, seen: true }));
      });
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
  return page;
}
