/**
 * This PC following its account's signed list (docs/account-list.md, "Following a list"; docs/account.md, "The
 * account's signed list on a PC"). The rules of following are the follower's (shared/account-list-follower.ts): this
 * file holds what a PC adds to them, which is the disk, the clock, the account service's routes, and what the PC does
 * with what the list says.
 *
 * The copy lives in `account-list.json` in the state folder (0600), for one relay identity and one binding of the PC
 * to its account: a copy of another identity or binding is not this PC's and is not read. It holds no secret, and it
 * is only a copy: whether the PC is pinned, and to which list, is kept with the binding itself (account-pc.json), so
 * losing this file unpins nothing.
 *
 * A PC follows a list in one of two ways.
 *
 * - **Shadow.** It reads the list the account service names for its account, checks every entry itself, and says where
 *   the list would decide otherwise than the snapshot the PC lets devices in by. It lets nobody in and puts nobody out
 *   by it. The list id is the service's word here.
 * - **Pinned.** A person at this PC named the list (`want`), and that list holds an entry that adds this PC's own key
 *   at its own relay key. From then on the PC lets its account's devices in by the list alone, and the account
 *   service's word adds nobody and takes the PC out of nothing. The pin is one-way: it ends only with the binding it
 *   belongs to (Revoke all, a reset relay identity), or with an entry of the list that removes this PC.
 */
import { linkSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verifyLineProof } from "../../shared/account-list-invite.ts";
import { entryFromText, entryHash, isListHash, isListKeyEncoding, readBody, writeBody } from "../../shared/account-list-entry.ts";
import { openWrap, sealFields, wrapEpochKey, wrapFromText, wrapToText, type EpochKey } from "../../shared/account-list-seal.ts";
import { signerPower, type ListPlace } from "../../shared/account-list-signers.ts";
import {
  admitsSession, admittedDevices, compareHeads, followStep, gossipHead, heardHead, nextUntil, pinList, readSave, servePage, shownPcs, standing, startRead, takePage, withClock, writeSave, PC_BUSY_READ_SECONDS,
  type FollowerCopy, type FollowRead, type FollowVerdict, type ListHead, type ListPage, type PeerAsk, type SessionRefusal, type Standing,
} from "../../shared/account-list-follower.ts";
import { inviteRefusal, isListLabel, joinEntry, listClock, listView, ListKindError, ListWriteError, namesFields, sealEpoch, signCard, signListEntry, type InviteCode, type ListRole, type ListState, type Sealed } from "../../shared/account-list.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import type { SnapshotDevice, SnapshotRemoved } from "../../shared/account-snapshot.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { SERVER_ID_PATTERN } from "../../shared/relay-offer.ts";
import { logAccess } from "../connection-diagnostics.ts";
import { preparePrivateState, syncDirectory, writePrivateState } from "../private-state.ts";
import { verifyRelayProof } from "../relay/auth-proof.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { ListCommit } from "./account-device-state.ts";
import { ListKeysError, type ListKeyStore, type PcListKeys } from "./list-keys.ts";
import { AccountServiceRefusal, type NamedList } from "./mailbox.ts";
import { RemovedOnDiskError, type ListBound } from "./pc-binding.ts";
import type { Readmission } from "./readmission.ts";

export const ACCOUNT_LIST_FILE = "account-list.json";
/** A post the account service did not confirm is made again after this long. */
const POST_RETRY_MS = 60_000;
/**
 * Beside the copy: what a pinned PC denied and has not on disk yet. Written before the PC acts on a denial, with the
 * denial itself: the key a removal put out and the place of that entry, or the key whose time passed, that time and
 * the hour the PC's clock showed. Removed only once the write that makes it unnecessary is on disk (the copy that
 * holds the removal, with the removal's record; the copy that holds the hour). It is read at a start before the copy
 * and without it. While it stands the keys it names are refused, whatever the copy says; and a PC that starts on a
 * copy that does not reach a removal it names lets nobody of its list in until a read has reached that place, or
 * until the account service has answered one whole read.
 */
export const ACCOUNT_LIST_OWED_FILE = "account-list-owed.json";
/**
 * The entry this PC signed to let a device in and does not know to be placed, beside the copy: the request as it was
 * signed and the head it was signed on. While the copy shows that head the same bytes go out again, from another
 * Allow and after a restart too, and nothing else is signed there.
 */
export const ACCOUNT_LIST_ALLOW_FILE = "account-list-allow.json";
/** After this long a denial that still stands in the mark is said in the status. */
const OWED_SAID_SECONDS = 3_600;

interface OwedMark {
  /** When the mark was first written, by the PC's clock (seconds). */
  readonly at: number;
  /** The latest hour the PC's clock showed when it denied by a time. */
  floor: number;
  removed: { readonly key: string; readonly seq: number }[];
  expired: { readonly key: string; readonly until: number }[];
}
/** How often a member's page is checked again because the copy was replaced while it was checked. */
const PAGE_APPLY_TRIES = 3;
/** How often one read of the account service begins again because a member's page moved the copy under it. */
const READ_RESTARTS_MAX = 8;
/** A post of the PC's keys lasts ten minutes at the account service: an end named further off than this is no end it gave. */
const POST_UNTIL_MAX_SECONDS = 24 * 60 * 60;
/** The PC's post of its keys lasts ten minutes at the account service; it is made again when it is this old. */
export const LIST_POST_RENEW_MS = 4 * 60_000;
/** How often the PC looks at its clock for a read that is due and a device whose time has passed. */
export const LIST_TICK_MS = 5_000;
/** For this long after a person named a list here, the PC reads as often as with a session open. */
export const LIST_WANT_BUSY_MS = 15 * 60_000;
/** The clock a copy last showed is saved at least this often, in seconds, also when nothing else of the copy moved. */
export const LIST_CLOCK_SAVE_SECONDS = 60;
/** The most differences one start says: past it the list and the snapshot plainly are not of one account. */
export const DIFFERENCES_MAX = 1000;
/** How often a PC signs an Allow again on a new head, or sends it again to a service that asked it to, before it gives up. */
export const LIST_ALLOW_TRIES = 4;
/** How often keeping a signed entry begins again because another Ovis on the folder wrote or removed one meanwhile. */
const ALLOW_KEEP_TRIES = 3;
/**
 * How long an entry this PC signed for a device it has since come to hold back keeps the place it was signed for from
 * another device's Allow: it is never sent, and after this long (from when it was kept, the file's own time) it is
 * dropped. The bound the app's writer keeps a signed request by.
 */
export const LIST_KEPT_HELD_MS = 10 * 60_000;
/** The longest a device waits for the PC to place the entry that lets it in: the session's setup is kept open that long. */
export const LIST_ALLOW_MS = 90_000;
/** How long it waits before it sends the same Allow again to a service that is busy with the list. */
export const LIST_ALLOW_RETRY_MS = 1_000;
/**
 * How long a join a member allowed waits for that member's entry to reach this PC's copy: the member signs only once
 * the new device confirmed its digits, and then signs, places the entry and hands the page over. Under LIST_ALLOW_MS,
 * which the session and its carrier leave the join.
 */
export const LIST_MEMBER_WAIT_MS = 30_000;
/** While it waits for a member's entry, how often the PC asks the account service for it (a page a member hands over needs no asking). */
const LIST_MEMBER_READ_MS = 3_000;
/** And how often it looks at its copy. */
const LIST_MEMBER_LOOK_MS = 100;
/** The longest one try waits because the account service asked it to (its `retry-after`). */
const LIST_ALLOW_RETRY_MAX_MS = 10_000;
/** The name of a device the list lets in, while this PC holds no key to the list's names. */
export const LIST_DEVICE_LABEL = "Device";

const BIND_ID = /^[0-9a-f]{32}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** The most entries this PC serves a device in one page, and takes from one. */
export const PEER_PAGE_MAX = 256;
/** The calls of the two session routes one session may make in a minute. */
export const PEER_CALLS_PER_MINUTE = 30;
/** The sessions whose reads and calls are remembered. */
const PEER_SESSIONS_MAX = 64;
/** What a peer read or call is kept under (POST /api/account/list/head, /page): the key a device was let in by, or one place for this PC's own window and direct clients. */
export type PeerCaller = string;

/**
 * `account-list.json`. `save` is the follower's own text (writeSave), which carries its sum; null while a list is
 * named and nothing is read. `want` is the list a person at this PC named.
 */
interface ListFile {
  readonly v: 1;
  readonly server_id: string;
  readonly bind_id: string;
  readonly want: string | null;
  readonly save: string | null;
}

/**
 * What the snapshot path holds of a device, as the shadow compares it: `admitted` for one it lets in, `none` for one it
 * holds no row for. A row that one of the PC's own guards holds back for now (its join hold, a wait for a read) is
 * not compared: the list knows no such guard.
 */
export type SnapshotVerdict = "admitted" | "none";

export interface ListStatus {
  readonly account: string | null;
  /** The list this PC reads, or null for none. */
  readonly list: string | null;
  /** Whether the PC lets its account's devices in by this list, and by nothing the account service says. */
  readonly pinned: boolean;
  /** The list the PC is pinned to, also when it holds no copy of it it can read; null on a PC that is not pinned. The same name and form as in `GET /api/account/status`. */
  readonly pinned_list: string | null;
  /** The list a person at this PC named for it, or null. */
  readonly want: string | null;
  /** Where the PC itself stands in the list: `waiting` until an entry adds it. */
  readonly standing: Standing | null;
  /** The last entry of the copy that a member signed. */
  readonly head: ListPlace | null;
  /** How many devices and PCs the copy holds as in. */
  readonly devices: number;
  readonly pcs: number;
  readonly alarm: "fork" | null;
  /** When the copy last held everything the account service showed. */
  readonly last_read_at: string | null;
  /** What came of the last word of the account service: the follower's verdict, `same` for a head that is the copy's own, `none` when it named no list. */
  readonly last_verdict: string | null;
  /** How many decisions of the snapshot the list would have made otherwise, since this start. */
  readonly differences: number;
  /** Whether the PC has its list keys: `unreadable` for a file that will not read. */
  readonly keys: "ready" | "unreadable" | null;
  /** Until when the account service holds this PC's keys for a member to add it, or null. */
  readonly posted_until: string | null;
  /** Why the copy or the service could not be used, in words that name no key. */
  readonly error: string | null;
  /**
   * On a pinned PC that lets none of its account's devices in, or nobody new: why, and what a person does about it,
   * in one sentence for a screen. Null while the PC follows its list as usual, and on a PC that is not pinned.
   */
  readonly reason: string | null;
  /**
   * A member wrote an entry this Ovis is too old to read. The PC goes on letting in whoever the list holds and
   * putting out whoever it removes, and signs nobody in until Ovis on it is updated.
   */
  readonly behind: boolean;
}

/** What `GET /api/account/status` says of the list on a pinned PC (`ovis status --json` reads it): the list id, where the PC stands in it, and ListStatus.reason. */
export interface ListSummary { readonly pinned_list: string; readonly standing: Standing | null; readonly reason: string | null }

/**
 * Why this PC did not let a device into its list. `not_pinned`, `not_signer` (it joined by an invite, or its key no
 * longer signs), `alarm`, `stopped`, `unavailable` (its keys or its copy): the PC cannot allow anyone now.
 * `held_here`: this PC itself keeps that key out. `not_written`: the entry would not count (a card that is not that
 * key's for this list, a key that was a signer before). `refused`: the account service refused it (no claim of the
 * key by a sign-in of the account, a budget). `list_stopped`: the service changes this list for nobody now.
 * `service_away`, `head_lost`: it could not be placed in LIST_ALLOW_TRIES tries. `not_in_list`: nobody at this PC
 * decided, and no entry lets the device in.
 */
export type AllowRefusal = "not_pinned" | "not_signer" | "alarm" | "stopped" | "behind" | "unavailable" | "held_here" | "not_written" | "refused" | "not_claimed" | "list_stopped" | "service_away" | "head_lost" | "not_in_list";

/** The device a PC is asked to let into its list: its member key, its encryption key, its card for the list, and the name it gave. */
export interface AllowedDevice { readonly key: string; readonly enc: string; readonly card: string; readonly label: string }

export type AllowOutcome = { readonly allowed: { readonly id: string; readonly seq: number; readonly hash: string } } | { readonly refused: AllowRefusal; readonly detail: string | null };

/** `other_account`: this PC is in another account. `other_adder`: the list holds this PC, by an entry of another key than the one the person confirmed. */
/** `ended`: what the join was for ended before the binding was written (an add's time, or the person's No). */
export type JoinRefusal = WantRefusal | "other_account" | "other_adder" | "line_unproven" | "invite_unknown" | "ended";

/**
 * Why a PC writes no `join` of its own. The invite's refusal as the list holds it (inviteRefusal); `invite_plain`: a
 * person adds a PC with that invite, the PC does not join by itself; `invite_uses`: it lets more than one PC in;
 * `not_read`: the list could not be read; `not_written`: the entry would not count, or is not the one this PC built;
 * `behind`: a member wrote what this Ovis is too old to read, and a PC that is behind does not write itself in;
 * `refused`: the account service placed nothing.
 */
export type JoinWriteRefusal = InviteCode | "invite_plain" | "invite_uses" | "not_read" | "not_written" | "behind" | "refused";

/** A PC's own card for a list, unsigned, as the holder of an invite's line signs its proof for it (signLineProof). */
export interface LineCard { readonly key: string; readonly enc: string; readonly endpoint: string; readonly list: string }

/**
 * `prove`: the PC is in its account already, or the list holds it already, so it writes no `join`: it joins only by
 * the line's proof for its card (joinByLine), which the caller has the line sign.
 */
export type JoinPrepared =
  | { readonly prove: LineCard }
  | { readonly prepared: { readonly list: string; readonly seq: number; readonly enc: string; readonly seal: { readonly epoch: number; readonly opens: string } | null; readonly wraps: readonly { readonly epoch: number; readonly wrap: string }[] } }
  | { readonly refused: JoinRefusal | JoinWriteRefusal };

/**
 * What a join by the list is asked with: the account, its list, and the key that must have signed the entry that adds
 * this PC (`by`; null for whoever the list lets add one). `live`: whether what the join is for still stands, asked at
 * the binding's write itself (ListAdd: its ten minutes and the person's No).
 */
export interface JoinGiven { readonly account: string; readonly list: string; readonly by: string | null; readonly live?: () => boolean }

/** `waiting`: the list holds no entry for this PC yet (or the PC cannot read it yet); `out` and `stopped` as the follower says them. */
export type JoinOutcome = { readonly joined: ListStatus } | { readonly waiting: Standing } | { readonly refused: JoinRefusal };

export type WantRefusal = "invalid_list" | "not_in_account" | "pinned" | "removed" | "unavailable";

/** What the device store asks of the list (DeviceStore.attachList). Every answer is read from memory, with no wait. */
export interface ListAuthority {
  /** Whether this PC lets its account's devices in by its signed list. */
  pinned(): boolean;
  /** What a pinned PC's list lets the device with `key` in as now, null for one it does not let in; undefined on a PC that is not pinned. */
  role(key: string): ListRole | null | undefined;
  /** Whether the list holds `key` to drive with full power now: null on a PC that is not pinned and for a key it does not let in. */
  allowsJoins(key: string): boolean | null;
  /** Whether the PC at the relay key `endpoint` is in the list this PC is pinned to. */
  holdsPc(endpoint: string): boolean;
  /** Whether this PC acted on a removal of `key` by its list that it has not on disk yet: every row of that key stays out meanwhile, a pairing of this PC's own too. */
  owesRemoval(key: string): boolean;
  /** Whether this relay identity was removed from `account` by that account's list. */
  removedFrom(account: string): boolean;
}

export interface ListFollowDeps {
  readonly stateDir: string;
  readonly keys: ListKeyStore;
  identity(): RelayIdentity | undefined;
  /** The PC's standing binding to its account, or null. `list`: the list that binding is pinned to, or null. `alarmed`: that list raised an alarm under this binding. */
  binding(): { readonly account: string; readonly id: string; readonly list: string | null; readonly alarmed?: boolean } | null;
  /**
   * Binds this PC, in no account, to `account` by its list `list`, pinned from the start (DeviceStore.bindByList): the
   * binding the file holds after the write, which another Ovis on this folder may have made (`won` false). Throws when it cannot.
   */
  bind(account: string, list: string, serverId: string): ListBound;
  /**
   * This PC joined `account` by its list under the binding `bindId` (AccountMailbox.listJoined): what it then owes the
   * account service, its completion, is kept on disk at once. Never throws.
   */
  joined?(account: string, bindId: string): void;
  /** Keeps with the binding `bindId`, on disk, that its list raised an alarm (PcAccountState.alarmList). False when it could not. */
  alarm?(bindId: string): boolean;
  /** Pins the binding `bindId` to `list`, on disk, for good (PcAccountState.pinToList). False when it could not. */
  pin(bindId: string, list: string): boolean;
  /** Whether the list of `account` removed this PC while it had the relay identity `serverId` (PcAccountState.removedByList). */
  removedFrom(account: string, serverId: string): boolean;
  /**
   * A PC route of the list at the account service, with this PC's proof (AccountMailbox.listRoute). `ready` runs once
   * that proof is made, right before the request itself goes out: what it throws stops the request, and is thrown on.
   */
  call(path: string, body: Record<string, unknown>, ready?: () => void): Promise<Record<string, unknown>>;
  /** The key of the account row `id` that this PC holds, or null. */
  rowKey(id: string): string | null;
  /** The PC's clock, in milliseconds. */
  now(): number;
  /** A clock that only moves forward, in milliseconds (performance.now when unset): what a bound on calls a minute is counted by. */
  mono?(): number;
  /**
   * A pinned PC's account rows, from the list: the store drops what the list no longer lets in and admits what it newly
   * does. `unheld`: the keys that come in with no join hold: every device at the commit that follows the pin itself,
   * and a device a person at this PC has just let in.
   */
  commit?(list: ListCommit, readmission: Readmission | undefined, unheld: (key: string) => boolean): void;
  /** Whether this PC's own guards let the key in as a device of its list: a key it removed or holds back stays out. */
  mayAdmit?(key: string): boolean;
  /**
   * The PC has just pinned its list: the sessions of the account rows it held until now end as rows that changed, not
   * as devices that were removed, so each app signs in again by itself, with the key the list holds for it.
   */
  repinned?(): void;
  /**
   * An entry of the list this PC is pinned to put the device `key` out. The PC keeps that as it keeps a member's signed
   * removal: every row of the key goes, the ones this PC paired itself included, and nothing the list or the account
   * service says later brings the key back. `id` names the entry, `at` is when it was signed, in seconds.
   */
  removed?(key: string, removal: { readonly id: string; readonly at: number }): void;
  /** The list this PC is pinned to removed it: the PC leaves its account, and keeps that it was removed as `serverId`. False when it could not, and is asked again. */
  leave?(serverId: string): boolean;
  /** What the list lets in changed for rows the PC holds (a device's time passed, an alarm rose): their sessions are looked at again. */
  recheck?(): void;
  /** Whether a session is open on this PC: it then reads more often. */
  busy?(): boolean;
  /** How long a join a member allowed waits for the member's entry (LIST_MEMBER_WAIT_MS): shorter in a test. */
  readonly memberWaitMs?: number;
  /** The list put `key` out and the PC has that only in its mark so far: the sessions of every row of the key end. */
  denied?(key: string): void;
  /** Called at each look at the clock, before anything else: takes in what another server of this folder wrote to the PC's place in its account. */
  retry?(): void;
}

const PC_STATES: ReadonlySet<string> = new Set<SessionRefusal>(["waiting", "stopped", "out"]);

/** `list`: the list the binding is pinned to, or null. */
/** An entry this PC signed to let the device `key` (with `enc`) in: the request as it was signed, and the place and head it was signed on. */
interface KeptAllow {
  readonly list: string; readonly seq: number; readonly onHead: string; readonly key: string; readonly enc: string;
  readonly entries: readonly string[]; readonly wraps: readonly { epoch: number; member: string; wrap: string }[];
}

/** The Allow stopped when its proof to the service was made, before its entry went out. */
class AllowStopped extends Error {
  constructor(readonly outcome: AllowOutcome) { super("the Allow was stopped before its entry went out"); }
}

interface Scope { readonly serverId: string; readonly bindId: string | null; readonly account: string | null; readonly list: string | null; readonly endpoint: string }
type Bound = Scope & { readonly bindId: string; readonly account: string };

export class ListFollow implements ListAuthority {
  private readonly path: string;
  /** The relay identity and the binding the fields after them belong to. */
  private serverId: string | null = null;
  private bindId: string | null = null;
  private want: string | null = null;
  private copy: FollowerCopy | null = null;
  /** Why the file on disk is no copy this PC can use, or null. A PC that is not pinned reads the list again and replaces it. */
  private broken: string | null = null;
  private ready: Promise<void> = Promise.resolve();
  private fileRead = false;

  private keysState: ListStatus["keys"] = null;
  /** This PC's own keys, once read, and the relay identity they were read for. */
  private held: PcListKeys | null = null;
  private heldFor: string | null = null;
  private lastVerdict: string | null = null;
  private error: string | null = null;
  private postedAt: number | null = null;
  private postedUntil: number | null = null;
  /** When the last read of the log began, in seconds; also one that failed. */
  private askedAt: number | null = null;
  private reading: Promise<void> | null = null;
  /** The next second at which a device the list lets in stops being let in, or null. */
  private untilAt: number | null = null;
  /** The rows do not hold yet what the list says: the commit is tried again. */
  private dirty = false;
  /** The keys to the list's names this PC opened, by list and epoch. */
  private readonly epochKeys = new Map<string, EpochKey>();
  /** The list a person at this PC confirmed for an account the PC is not in yet, as far as it has read it. In memory only. */
  private candidate: { readonly account: string; readonly copy: FollowerCopy } | null = null;
  /** The PC has just joined by its list: the devices the list holds come in with no join hold, as at any pin. */
  private freshPin = false;
  /** The `join` of this PC whose body it built and handed to the holder of an invite's line to sign: only that one is placed. */
  /** The reads this PC asked devices for over their sessions, by session: the page that answers one is its continuation. */
  private readonly peerReads = new Map<string, FollowRead>();
  /** When each session called the two session routes, in the last minute. */
  private readonly peerCalls = new Map<string, number[]>();
  private pendingJoin: { readonly account: string; readonly list: string; readonly invite: string; readonly body: Uint8Array } | null = null;
  /** The list and head at which the kept entry's file (ACCOUNT_LIST_ALLOW_FILE) was found unreadable: nothing is signed until the copy is past it. */
  private allowUnread: { readonly list: string; readonly seq: number } | null = null;
  /** The kept entry is one of a device this PC has come to hold back, and holds its place from other devices for now (LIST_KEPT_HELD_MS). */
  private keptHeld = false;
  /** The proof of the invite's line this PC was named its list with (joinByLine): posted with its keys while it waits for that list. */
  private lineProof: { readonly account: string; readonly card: LineCard; readonly invite: string; readonly proof: string } | null = null;
  /** The device that is being let in through this PC right now: its row comes in with no join hold. */
  private readonly allowing = new Set<string>();
  /** How far the account service's clock is ahead of this PC's, in seconds, by its last answer. */
  /** The clock (`seen_at`) of the copy as it was last saved. */
  private savedAt: number | null = null;
  /** The copy in memory holds what the file does not: its last save failed. It is acted on all the same, and saved again at the next tick. */
  private unsaved = false;
  /** What this PC denied and has not on disk yet (ACCOUNT_LIST_OWED_FILE), as the file holds it; null for nothing. */
  private owed: OwedMark | null = null;
  /** This start found a removal in the mark that the copy does not reach: nobody of the list is let in until a read reached it, or the account service answered one whole read. */
  private mustRead = false;
  /** The place the copy stood at when it was last saved. */
  private savedSeq: number | null = null;
  /** Fires at `untilAt`, whatever else the PC is doing. */
  private untilTimer: ReturnType<typeof setTimeout> | undefined;
  /** The removals of the list that this PC has kept as its own since this start, by the entry that made each. */
  private readonly applied = new Set<string>();
  /** The keys whose removal's record this run wrote (deps.removed answered): what a mark for a removal waits for. */
  private readonly kept = new Set<string>();
  /** When a person last named a list here, in milliseconds: for a while after it the PC reads often, as someone waits beside it. */
  private wantedAt: number | null = null;
  private readonly differences = new Set<string>();
  private readonly ids = new WeakMap<FollowerCopy, Map<string, string>>();
  private turn: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly deps: ListFollowDeps) { this.path = join(deps.stateDir, ACCOUNT_LIST_FILE); }

  /** Reads the saved copy and, on a pinned PC, gives its rows to the store; then looks at the clock every LIST_TICK_MS. */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.enqueue(async () => {
      const scope = this.bound();
      if (scope === null) return;
      await this.ready;
      await this.ensureCopy(scope);
      // a pinned PC signs with its keys: they are read at the start, not at the first thing that needs them
      if (this.isPinned) await this.keysOf(scope);
      this.settle();
      // after the rows and the removals' records were written: what the mark still owes is asked then
      this.settleOwed();
    });
    this.timer = setInterval(() => this.tick(), LIST_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.deps.keys.close();
    if (this.untilTimer) clearTimeout(this.untilTimer);
    this.untilTimer = undefined;
  }

  /** Everything asked of the list so far has been done. */
  async settled(): Promise<void> {
    for (let turn: Promise<unknown> | null = null, page: Promise<unknown> | null = null; turn !== this.turn || page !== this.applying;) {
      turn = this.turn;
      page = this.applying;
      await turn;
      await page;
    }
  }

  // What the device store asks: from memory, with no wait.

  pinned(): boolean { return this.sync() !== null && this.isPinned; }

  /** The binding's own word on the list it is pinned to: on disk with the binding, whatever becomes of the copy. */
  private get isPinned(): boolean {
    const binding = this.deps.binding();
    return binding !== null && binding.id === this.bindId && binding.list !== null;
  }

  /**
   * Why a pinned PC cannot use its copy: the file is there and does not read. It is never replaced by what the account
   * service shows now, which may be an older part of the list: the PC lets no device of its account in until a person
   * restores the file, or removes it and starts Ovis again, which reads the list from its start.
   */
  private get problem(): string | null {
    return this.isPinned && this.broken !== null ? `${this.broken}: this PC lets no device of its account in until the file is restored or removed, and Ovis is started again` : null;
  }

  role(key: string): ListRole | null | undefined {
    if (!this.pinned()) return undefined;
    const copy = this.clocked();
    if (copy === null || this.alarmLost || this.mustRead || this.owedKey(key)) return null;
    const answer = admitsSession(copy, key, this.seconds());
    // refused for its time: the hour that says so is on disk before the answer is used, so no clock set back undoes it
    const until = copy.state?.devices[key]?.until ?? null;
    if (answer.why === "expired" && until !== null) this.saveFloor([{ key, until }]);
    return answer.role;
  }

  /**
   * Whether the device of the list that signed in with `key` may decide a join into the list from afar, read from this
   * PC's copy as it is at the call: the list holds it as in, to drive, with full power (what may add a device to the
   * list may approve its join). False for any other device the list lets in (to watch, or with bound power); null on
   * a PC that is not pinned and for a key the list does not let in now.
   */
  allowsJoins(key: string): boolean | null {
    const role = this.role(key);
    if (role === undefined || role === null) return null;
    const state = this.copy?.state ?? null;
    return role === "drive" && state !== null && signerPower(state, key) === "full";
  }

  /**
   * The binding keeps that its list raised an alarm, and the copy the PC holds now shows none: the copy was lost and
   * read again, and one history tells nothing of whom the alarm held back. The PC then lets nobody of its list in,
   * until a person unpins it at the PC.
   */
  private get alarmLost(): boolean {
    const binding = this.deps.binding();
    return binding !== null && binding.id === this.bindId && binding.list !== null && binding.alarmed === true && this.copy?.alarm == null;
  }

  /** The copy with the hour the PC's clock shows now (withClock), which it decides on: the hour never counts for less than it once showed. */
  private clocked(): FollowerCopy | null {
    if (this.copy === null) return null;
    const now = withClock(this.copy, this.seconds());
    if (now !== this.copy) { this.ids.delete(this.copy); this.copy = now; }
    return now;
  }

  /** Saves the copy's hour when what is on disk does not yet show that these times have passed. Never throws. */
  private saveFloor(passed: readonly { readonly key: string; readonly until: number }[]): void {
    const scope = this.bound();
    if (scope === null || scope.bindId === null || this.copy === null || this.copy.seen_at === null) return;
    const unsaved = passed.filter(({ until }) => this.savedAt === null || this.savedAt < until);
    if (unsaved.length === 0) return;
    // the denial is in the mark first: a copy the disk does not take leaves the time passed all the same, and is offered again
    if (this.isPinned) this.owe(scope as Bound, { expired: unsaved });
    if (!this.persist(scope as Bound)) this.unsaved = true;
    this.settleOwed();
  }

  private get owedPath(): string { return join(this.deps.stateDir, ACCOUNT_LIST_OWED_FILE); }

  private get allowPath(): string { return join(this.deps.stateDir, ACCOUNT_LIST_ALLOW_FILE); }

  /**
   * The entry this PC signed and does not know to be placed (ACCOUNT_LIST_ALLOW_FILE), while the copy has not gone
   * past the head it was signed on; null for none. One the copy has gone past, or that is another list's, is
   * forgotten here. `unread`: the file is there and does not read, so what this PC signed is not known. Read from
   * the disk at each look: another Ovis that runs on this state folder signs with the same key.
   */
  private keptAllow(scope: Bound, copy: FollowerCopy): KeptAllow | "unread" | null {
    const kept = this.allowOnDisk(scope);
    const footing = copy.state?.footing;
    if (kept === "unread") {
      if (footing === undefined) return kept;
      // Not known what it held: nothing is signed while the copy stands at the head at which it was found so. Once the
      // verified head moved past that, the place anything in it was signed for is taken, and the file goes
      const found = this.allowUnread;
      if (found === null || found.list !== copy.list) { this.allowUnread = { list: copy.list, seq: footing.seq }; return kept; }
      if (footing.seq <= found.seq) return kept;
      this.dropAllow();
      return null;
    }
    this.allowUnread = null;
    if (kept === null || footing === undefined) { if (kept === null) this.keptHeld = false; return kept; }
    if (kept.list === copy.list && (kept.seq > footing.seq || (kept.seq === footing.seq && kept.onHead === footing.hash))) return kept;
    this.dropAllow();
    return null;
  }

  /**
   * The person at this PC declined a join of the device with `key` (its own window): what this PC signed for that
   * device and keeps is never sent, and the place it held goes to the next Allow at once. Nothing for an entry of any
   * other device. Never throws.
   */
  declinedHere(key: string): void {
    const scope = this.bound();
    if (this.stopped || scope === null || !this.isPinned) return;
    const kept = this.allowOnDisk(scope);
    if (kept !== null && kept !== "unread" && kept.key === key) this.dropAllow();
  }

  /** How long ago the entry this PC keeps (ACCOUNT_LIST_ALLOW_FILE) was kept, by the file's own time, which is never written over; 0 when not known. */
  private keptFor(): number {
    try { return Math.max(0, Date.now() - statSync(this.allowPath).mtimeMs); } catch { return 0; }
  }

  private allowOnDisk(scope: Bound): KeptAllow | "unread" | null {
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.allowPath, "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.error = `${ACCOUNT_LIST_ALLOW_FILE} cannot be read: this PC signs nobody new into the list until the list moves on`;
      return "unread";
    }
    const file = parseAllow(value);
    if (file === null) {
      this.error = `${ACCOUNT_LIST_ALLOW_FILE} cannot be read: this PC signs nobody new into the list until the list moves on`;
      return "unread";
    }
    // another relay identity's, or another binding's: its head is not one this binding signs on
    if (file.serverId !== scope.serverId || file.bindId !== scope.bindId) {
      try { rmSync(this.allowPath, { force: true }); } catch { /* read again, and found foreign again, at the next start */ }
      return null;
    }
    return file.kept;
  }

  /**
   * Keeps the entry this PC has just signed, and answers the one that goes out for its place: this one, or the one
   * another Ovis on this state folder kept for that very place a moment before (this one is then dropped unsent).
   * The file is created, never written over, so of two servers that sign at once one keeps and the other finds.
   * Null when it could not be kept: an entry that is not kept is not sent.
   */
  private keepAllow(scope: Bound, kept: KeptAllow): KeptAllow | null {
    const file = { v: 1, server_id: scope.serverId, bind_id: scope.bindId, list: kept.list, seq: kept.seq, on_head: kept.onHead, key: kept.key, enc: kept.enc, entries: kept.entries, wraps: kept.wraps };
    for (let tries = 0; tries < ALLOW_KEEP_TRIES; tries++) {
      let temporary: string | null = null;
      try {
        temporary = preparePrivateState(this.allowPath, file);
        linkSync(temporary, this.allowPath);
        syncDirectory(dirname(this.allowPath), process.platform);
        return kept;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          this.error = `${ACCOUNT_LIST_ALLOW_FILE} could not be written (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
          return null;
        }
      } finally {
        if (temporary !== null) { try { unlinkSync(temporary); } catch { /* a spare name beside the file, which holds nothing the file does not */ } }
      }
      const there = this.allowOnDisk(scope);
      if (there === "unread") return null;
      if (there === null) continue;
      if (there.list === kept.list && there.seq === kept.seq && there.onHead === kept.onHead) return there;
      // one signed further on than this PC's copy stands: this copy is behind, and signs nothing under it
      if (there.list === kept.list && there.seq > kept.seq) return null;
      // one from a head this copy is past: it is replaced
      try { rmSync(this.allowPath, { force: true }); } catch { return null; }
    }
    return null;
  }

  private dropAllow(): void {
    this.allowUnread = null;
    this.keptHeld = false;
    try { rmSync(this.allowPath, { force: true }); } catch { /* read again at the next look, and dropped once the copy is past its head */ }
  }

  owesRemoval(key: string): boolean {
    return this.owed !== null && this.isPinned && this.owed.removed.some((row) => row.key === key);
  }

  /**
   * The removal's own record could not be written: the sessions of every row of the keys the mark names end all the
   * same, one of a pairing this PC made itself too, and their next sign-in finds the mark.
   */
  private denyOwed(): void {
    for (const row of this.owed?.removed ?? []) { try { this.deps.denied?.(row.key); } catch { /* its sign-in is refused all the same */ } }
  }

  private owedKey(key: string): boolean {
    const owed = this.owed;
    return owed !== null && (owed.removed.some((row) => row.key === key) || owed.expired.some((row) => row.key === key));
  }

  /** Adds denials to the mark and writes it, before they are acted on. A disk that does not take it leaves the PC to what it acts on from memory. */
  private owe(scope: Bound, what: { readonly removed?: OwedMark["removed"]; readonly expired?: OwedMark["expired"] }): void {
    const now = Math.max(this.seconds(), this.copy?.seen_at ?? 0);
    const owed: OwedMark = this.owed ?? { at: now, floor: now, removed: [], expired: [] };
    owed.floor = Math.max(owed.floor, now);
    for (const row of what.removed ?? []) {
      if (owed.removed.some((held) => held.key === row.key && held.seq === row.seq)) continue;
      owed.removed.push(row);
    }
    for (const row of what.expired ?? []) if (!owed.expired.some((held) => held.key === row.key && held.until === row.until)) owed.expired.push(row);
    this.owed = owed;
    this.writeOwed(scope);
  }

  private writeOwed(scope: Scope): void {
    const owed = this.owed;
    if (owed === null || scope.bindId === null || this.stopped) return;
    try { writePrivateState(this.owedPath, { v: 1, server_id: scope.serverId, bind_id: scope.bindId, ...owed }); } catch { /* acted on from memory, and written again at the next look */ }
  }

  /**
   * Takes out of the mark what is on disk by now, and removes the mark once nothing is left: a removal once the copy
   * that reaches its place and shows the key out is saved and the removal's record is written; a time that passed
   * once the saved copy holds an hour at or past it.
   */
  private settleOwed(): void {
    const owed = this.owed;
    const scope = this.bound();
    if (owed === null || scope === null || this.stopped) return;
    const state = this.copy?.state ?? null;
    const saved = !this.unsaved && !this.dirty;
    // a removal: the saved copy reaches its place and shows the key out, and the removal's own record was written in
    // this run (keepRemovals), which is what keeps the key out once the mark is gone
    const removed = owed.removed.filter((row) => !(saved && this.kept.has(row.key) && this.savedSeq !== null && this.savedSeq >= row.seq && state !== null && Object.hasOwn(state.signers, row.key) && state.signers[row.key]!.ended !== null));
    const expired = owed.expired.filter((row) => !(this.savedAt !== null && this.savedAt >= row.until));
    if (removed.length === owed.removed.length && expired.length === owed.expired.length) return;
    if (removed.length === 0 && expired.length === 0) {
      try { rmSync(this.owedPath, { force: true }); } catch { return; }
      this.owed = null;
      this.mustRead = false;
      return;
    }
    owed.removed = removed;
    owed.expired = expired;
    this.writeOwed(scope);
  }

  /** The mark the last run left for this binding, or null. One that is there and does not read is a mark: it names nobody, and closes the list until it was read again. */
  private owedOnDisk(scope: Scope): OwedMark | null {
    const unread: OwedMark = { at: this.seconds(), floor: 0, removed: [{ key: "", seq: Number.MAX_SAFE_INTEGER }], expired: [] };
    let value: Record<string, unknown>;
    try { value = JSON.parse(readFileSync(this.owedPath, "utf8")) as Record<string, unknown>; } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : unread;
    }
    if (typeof value !== "object" || value === null) return unread;
    const { v, server_id, bind_id, at, floor, removed, expired } = value;
    // another relay identity's or binding's mark is not this PC's
    if (server_id !== scope.serverId || bind_id !== scope.bindId) return null;
    const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    const rows = <Name extends "seq" | "until">(list: unknown, name: Name) => Array.isArray(list) && list.every((row: unknown) => typeof row === "object" && row !== null
      && typeof (row as { key?: unknown }).key === "string" && count((row as Record<string, unknown>)[name]));
    if (v !== 1 || !count(at) || !count(floor) || !rows(removed, "seq") || !rows(expired, "until")) return unread;
    return { at, floor, removed: [...removed as OwedMark["removed"]], expired: [...expired as OwedMark["expired"]] };
  }

  /** A removal the mark names lies within what the copy holds by now: the copy decides for everybody again. */
  private reachedOwed(): void {
    const owed = this.owed;
    const seq = this.copy?.state?.footing.seq ?? null;
    if (this.mustRead && owed !== null && seq !== null && owed.removed.every((row) => row.seq <= seq)) this.mustRead = false;
  }

  /** The account service answered one whole read: the list is as new as the service shows it, and decides again for everybody but the keys the mark names. */
  private readWhole(): void {
    if (!this.mustRead) return;
    this.mustRead = false;
    this.settle();
  }

  removedFrom(account: string): boolean {
    const scope = this.sync();
    return scope !== null && this.deps.removedFrom(account, scope.serverId);
  }

  /** Whether the PC at the relay key `endpoint` is in the list this PC is pinned to. */
  holdsPc(endpoint: string): boolean {
    if (!this.pinned() || this.copy === null || this.alarmLost) return false;
    return shownPcs(this.copy).some((row) => row.endpoint === endpoint);
  }

  status(): ListStatus {
    const scope = this.sync();
    const copy = scope?.bindId == null ? null : this.copy;
    const view = copy?.state ? listView(copy.state) : null;
    // a post is spent by the entry that adds the PC: one that is in, or out, has none
    const posted = copy !== null && standing(copy) === "waiting" ? this.postedUntil : null;
    return {
      account: scope?.account ?? null,
      list: copy?.list ?? null,
      pinned: this.pinned(),
      pinned_list: scope !== null && this.pinned() ? scope.list : null,
      want: scope?.bindId == null ? null : scope.list ?? this.want,
      standing: copy === null ? null : standing(copy),
      head: copy?.state ? { seq: copy.state.footing.seq, hash: copy.state.footing.hash } : null,
      devices: view?.devices.filter((row) => row.ended === null).length ?? 0,
      pcs: view?.pcs.filter((row) => row.removed === null).length ?? 0,
      alarm: copy?.alarm || (copy !== null && this.alarmLost) ? "fork" : null,
      last_read_at: copy?.read_at == null ? null : new Date(copy.read_at * 1000).toISOString(),
      last_verdict: this.lastVerdict,
      differences: this.differences.size,
      keys: this.keysState,
      posted_until: posted === null ? null : new Date(posted * 1000).toISOString(),
      error: this.problem ?? this.error,
      reason: this.reason(copy),
      behind: copy?.state != null && copy.state.behind !== null,
    };
  }

  /** The list this PC is pinned to, where it stands in it and why it lets nobody in, for the account's status; null on a PC that is not pinned. */
  summary(): ListSummary | null {
    const scope = this.sync();
    if (scope === null || scope.list === null || !this.isPinned) return null;
    return { pinned_list: scope.list, standing: this.copy === null ? null : standing(this.copy), reason: this.reason(this.copy) };
  }

  /** ListStatus.reason: each case in which a pinned PC is closed to its account's devices, or to new ones, with what ends it. */
  private reason(copy: FollowerCopy | null): string | null {
    if (!this.isPinned) return null;
    if (this.broken !== null) return `This PC cannot read its copy of your account's list (${ACCOUNT_LIST_FILE}), so it lets no device of your account in. Restore that file, or remove it, and start Ovis on this PC again: it then reads the list from its start.`;
    if (copy !== null && this.alarmLost) return "This PC was shown two versions of your account's list, and its copy of the list was lost since, so it lets no device of your account in. Choose Revoke all on this PC, then add it to your account again.";
    if (copy?.alarm != null) return "This PC was shown two versions of your account's list. It lets in the devices it held then and nobody new. Check your devices and PCs one at a time (docs/account-list.md, \"What a person does\"), then choose Revoke all on this PC and add it to your account again.";
    if (copy === null) return "This PC holds no copy of your account's list yet, so it lets no device of your account in until it has read the list.";
    if (this.mustRead) return "This PC stopped before it could save a change of your account's list that it had acted on, so it lets no device of your account in until it has read the list again. It does that by itself once it reaches the account service.";
    if (this.owed !== null && this.seconds() - this.owed.at >= OWED_SAID_SECONDS) return "This PC keeps a device out by a change of your account's list that it acted on and, for an hour now, has not been shown again or could not save. It goes on reading the list; if this stays, check this PC's disk.";
    const stands = standing(copy);
    if (stands === "stopped") return "A device of your account wrote something into its list that this Ovis is too old to read, so this PC lets no device of your account in. Update Ovis on this PC.";
    if (stands === "waiting") return "This PC is reading your account's list again from its start, and lets no device of your account in until that read shows this PC in the list.";
    if (this.allowUnread !== null) return `This PC cannot read its record of an entry it signed (${ACCOUNT_LIST_ALLOW_FILE}), so it lets no new device into your account's list until the list has moved on. It then removes that file by itself.`;
    if (this.keptHeld) {
      const until = new Date(Date.now() - this.keptFor() + LIST_KEPT_HELD_MS).toISOString();
      return `A device this PC lets into your account's list waits behind an entry this PC signed earlier for a device it has since held back, until ${until}. That entry is not sent; declining that device's join on this PC ends the wait at once.`;
    }
    return null;
  }

  // What reaches the list from outside.

  /** What a mailbox pull's answer named as the account's list. Starts a read in turn and returns at once. */
  heard(account: string, named: NamedList | null, asked?: string | null): void {
    if (this.stopped) return;
    // `asked`: what scopeToken answered when the pull began. A hint for another binding or relay identity than the PC
    // has when its turn comes is dropped
    void this.enqueue(async () => {
      if (asked !== undefined && asked !== this.scopeToken()) return;
      await this.follow(account, named);
    });
  }

  /** The relay identity and binding the PC has now, as one word: what a mailbox pull keeps to say which PC its answer was for. Null for none. */
  scopeToken(): string | null {
    const scope = this.bound();
    return scope === null ? null : `${scope.serverId} ${scope.bindId}`;
  }

  /**
   * A person at this PC names the list of its account (the PC's own window and CLI alone): the one act that lets this
   * PC pin. Nothing is pinned by it yet: the PC pins once that list holds an entry that adds its own key at its own
   * relay key. Naming another list before that replaces the first; after it, nothing does.
   */
  wantList(list: string): Promise<{ readonly status: ListStatus } | { readonly refused: WantRefusal }> {
    return this.enqueue(() => this.wanted(list));
  }

  private async wanted(list: string): Promise<{ readonly status: ListStatus } | { readonly refused: WantRefusal }> {
    {
      if (typeof list !== "string" || !isListHash(list)) return { refused: "invalid_list" as const };
      const scope = this.bound();
      if (scope === null) return { refused: "not_in_account" as const };
      await this.ready;
      if (this.problem !== null) return { refused: "unavailable" as const };
      if (this.removedFrom(scope.account)) return { refused: "removed" as const };
      if (scope.list !== null) return scope.list === list ? { status: this.status() } : { refused: "pinned" as const };
      const keys = await this.keysOf(scope);
      // the binding or the identity went while the keys were read (Revoke all, and the account joined again): the
      // naming was for the PC it was, and names nothing for the one it is now
      if (keys === null || !this.live(scope)) return { refused: "unavailable" as const };
      const before = { want: this.want, copy: this.copy, wantedAt: this.wantedAt, postedAt: this.postedAt, postedUntil: this.postedUntil };
      if (this.copy === null || this.copy.list !== list) {
        const first = pinList(null, { account: scope.account, list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
        if (!first.pinned) return { refused: "invalid_list" as const };
        this.copy = first.copy;
        this.postedAt = this.postedUntil = null;
      }
      this.want = list;
      this.wantedAt = this.deps.now();
      if (!this.persist(scope)) {
        // a naming that was refused names nothing: what stood before it stands, in memory as on disk
        ({ want: this.want, copy: this.copy, wantedAt: this.wantedAt, postedAt: this.postedAt, postedUntil: this.postedUntil } = before);
        return { refused: "unavailable" as const };
      }
      this.settle();
      if (!this.isPinned) {
        await this.read(scope);
        if (this.live(scope) && this.copy !== null && standing(this.copy) === "waiting") await this.post(this.copy, keys, scope);
      }
      return { status: this.status() };
    }
  }

  /**
   * A PC joins an account by the account's signed list, which a person at this PC confirmed: the number compared with
   * the phone that adds it, or the line of an invite. The PC reads that list with its own proof and joins only when the
   * list holds an entry that adds its own key at its own relay key, and, where `by` names a key, when that key signed
   * it (the adder whose number was compared, the invite of the line). A PC in no account then binds to the account by
   * the list, pinned from its first moment: at no time does it let a device in on the account service's word. A PC
   * already in that account names the list, as `wantList` does. Until the entry is there it answers `waiting`, and the
   * caller asks again; each ask reads once.
   */
  joinList(given: JoinGiven): Promise<JoinOutcome> {
    return this.enqueue(() => this.joining(given, true));
  }

  /**
   * The list `list` of `account` as a PC in no account reads it before it joins: a copy that is nobody's yet, read
   * once more. A refusal where this PC cannot join that account by a list at all; `bound` where it is in an account.
   */
  private async candidateOf(account: string, list: string): Promise<{ readonly scope: Scope; readonly keys: PcListKeys; readonly copy: FollowerCopy } | { readonly refused: JoinRefusal } | { readonly bound: Bound }> {
    if (typeof account !== "string" || !ACCOUNT_ID.test(account) || typeof list !== "string" || !isListHash(list)) return { refused: "invalid_list" };
    const scope = this.sync();
    if (scope === null) return { refused: "unavailable" };
    if (scope.bindId !== null && scope.account !== null) return scope.account === account ? { bound: scope as Bound } : { refused: "other_account" };
    if (this.removedFrom(account)) return { refused: "removed" };
    const keys = await this.keysOf(scope);
    if (keys === null) return { refused: "unavailable" };
    let candidate = this.candidate;
    if (candidate === null || candidate.account !== account || candidate.copy.list !== list || candidate.copy.me.key !== keys.key || candidate.copy.me.endpoint !== scope.endpoint) {
      const first = pinList(null, { account, list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
      if (!first.pinned) return { refused: "invalid_list" };
      candidate = { account, copy: first.copy };
      this.postedAt = this.postedUntil = null;
      this.pendingJoin = null;
      // a line's proof is for its own account and list
      if (this.lineProof !== null && (this.lineProof.account !== account || this.lineProof.card.list !== list)) this.lineProof = null;
    }
    const copy = await this.readInto(candidate.copy);
    this.candidate = { account, copy };
    return { scope, keys, copy };
  }

  /** This PC's own card for `list`, unsigned: what the holder of an invite's line signs its proof for. Null when its keys cannot be used. */
  async lineCard(list: string): Promise<LineCard | null> {
    const own = await this.own();
    return own === null || !isListHash(list) ? null : { key: own.keys.key, enc: own.keys.enc, endpoint: own.endpoint, list };
  }

  /**
   * A PC joins by the list an invite's line names (`ovis join`, an invite a person adds a PC with). The line is what
   * names the list here, so the caller proves that it holds it: `proof` is the line's proof for this PC's own card
   * (lineProofBytes: this account, this PC, that list, these keys), never a redeem signature, whose challenge an account
   * service chooses. Without it nothing is named: a bare list id from this PC's own window names no list. The PC then
   * joins as joinList does, when the list holds that invite and an entry that adds the PC; while it waits it posts
   * that proof with its keys, so a device of the account can see for itself that the line's holder joined it.
   */
  joinByLine(given: { readonly account: string; readonly list: string; readonly invite: string; readonly proof: string }): Promise<JoinOutcome> {
    return this.enqueue(async (): Promise<JoinOutcome> => {
      const { account, list, invite, proof } = given;
      const card = await this.lineCard(list);
      const own = card === null ? null : await this.own();
      if (card === null || own === null) return { refused: "unavailable" };
      if (typeof invite !== "string" || !isListKeyEncoding(invite) || !await verifyLineProof({ account, server_id: own.serverId, list, card }, proof, invite)) return { refused: "line_unproven" };
      this.lineProof = { account, card, invite, proof };
      return await this.joining({ account, list, by: null }, true, invite);
    });
  }

  /**
   * `post`: whether a PC that waits posts its keys and card for a member to add it from (a PC that joins by itself
   * posts none). `invite`: the list must hold that invite, whoever signed the entry that adds the PC.
   */
  private async joining(given: JoinGiven, post: boolean, invite?: string): Promise<JoinOutcome> {
    {
      const { account, list, by } = given;
      const read = await this.candidateOf(account, list);
      if ("refused" in read) return read;
      if ("bound" in read) {
        if (given.live?.() === false) return { refused: "ended" };
        // in its account and pinned to no list yet: it pins by the rules of this join, never by a want that outlives it
        if (read.bound.list === null) return await this.pinBound(read.bound, given, post, invite);
        const named = await this.wanted(list);
        if ("refused" in named) return { refused: named.refused };
        if (!named.status.pinned) return { waiting: named.status.standing ?? "waiting" };
        // pinned to this list, maybe by another Ovis on this folder: it says it joined by the copy on disk, never by none
        if (this.copy === null) return await this.copyOnDisk(read.bound);
        // and only by a copy that shows it in: one it is still reading from the start (its copy was lost) says where it stands
        if (this.copy.list !== list || standing(this.copy) !== "in") return { waiting: this.copy.list === list ? standing(this.copy) : "waiting" };
        // joined by this list, and the copy is still not on disk: offered to it again before the PC says so
        if (this.unsaved) this.unsaved = !this.persist(read.bound);
        return this.unsaved ? { waiting: "in" } : { joined: this.status() };
      }
      const { scope, keys, copy } = read;
      const stands = standing(copy);
      if (stands !== "in") {
        // the keys and the card a member adds this PC from, while it waits
        if (stands === "waiting" && post) await this.post(copy, keys, scope);
        return { waiting: stands };
      }
      if (by !== null && addedBy(copy) !== by) return { refused: "other_adder" };
      // the line named this list: the list must hold the line's invite, or the line was for no list at all
      if (invite !== undefined && (copy.state === null || !Object.hasOwn(copy.state.invites, invite))) return { refused: "invite_unknown" };
      // still in no account, the same PC, and a follower that runs: whatever happened while the list was read
      const now = this.sync();
      if (this.stopped || now === null || now.serverId !== scope.serverId || now.bindId !== null) return { refused: "unavailable" };
      // what the join is for still stands at the write itself (an add's ten minutes, the person's No)
      if (given.live?.() === false) return { refused: "ended" };
      let held: ListBound;
      try { held = this.deps.bind(account, list, now.serverId); } catch (error) {
        // the list removed this PC from that account (another Ovis on this folder read it so a moment ago)
        if (error instanceof RemovedOnDiskError) return { refused: "removed" };
        this.error = `This PC could not join the account (${error instanceof Error ? error.message : String(error)})`;
        return { refused: "unavailable" };
      }
      if (!held.won) return await this.boundMeanwhile(held, account, list);
      // the completion it owes the account service is on disk with the binding, before anything else can stop it
      try { this.deps.joined?.(account, held.id); } catch { /* sent at no pull then: the account's page shows the PC as listed */ }
      // from here the PC is in the account, pinned to the list: the copy it read is its copy
      this.sync();
      this.bindId = held.id;
      this.candidate = null;
      this.copy = copy;
      this.freshPin = true;
      logAccess({ event: "account.list.pinned" });
      this.pendingJoin = null;
      const bound = this.bound();
      if (bound === null) return { refused: "unavailable" };
      // the binding and its pin are on disk; the copy the PC joined by must be there too before it says it joined, or
      // a restart with the account service away would hold the pin and none of the list
      this.unsaved = !this.persist(bound);
      this.settle();
      return this.unsaved ? { waiting: "in" } : { joined: this.status() };
    }
  }

  /**
   * A join by the list on a PC that is in its account already and pinned to no list (an app's link brought it in, on
   * the account service's word, while the add ran): the PC reads the list as it would to bind, and pins it only for
   * the same proof, the entry that adds it signed by `by` (the adder whose number the person confirmed) or holding
   * the line's invite, while what the join is for still stands. Nothing of it is kept as a want: a No, the add's ten
   * minutes or a refusal leave this PC wanting nothing.
   */
  private async pinBound(scope: Bound, given: JoinGiven, post: boolean, invite?: string): Promise<JoinOutcome> {
    const { account, list, by } = given;
    if (this.removedFrom(account)) return { refused: "removed" };
    await this.ready;
    if (this.problem !== null) return { refused: "unavailable" };
    const keys = await this.keysOf(scope);
    if (keys === null || !this.live(scope)) return { refused: "unavailable" };
    const first = pinList(null, { account, list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
    if (!first.pinned) return { refused: "invalid_list" };
    const copy = await this.readInto(first.copy);
    if (!this.live(scope)) return { refused: "unavailable" };
    // pinned another way while the list was read (a member's page, another Ovis on this folder): that pin stands, and
    // the copy it holds too; this read changes nothing of it
    const pinned = this.deps.binding()?.list ?? null;
    if (pinned !== null) return pinned === list ? { waiting: this.copy?.list === list ? standing(this.copy) : "waiting" } : { refused: "pinned" };
    const stands = standing(copy);
    if (stands !== "in") {
      if (stands === "waiting" && post) await this.post(copy, keys, scope);
      return { waiting: stands };
    }
    if (by !== null && addedBy(copy) !== by) return { refused: "other_adder" };
    if (invite !== undefined && (copy.state === null || !Object.hasOwn(copy.state.invites, invite))) return { refused: "invite_unknown" };
    if (given.live?.() === false) return { refused: "ended" };
    // pinned with the copy that showed it in, as any pin is (settle): the want lives for this turn alone
    const before = { want: this.want, copy: this.copy };
    this.copy = copy;
    this.want = list;
    this.settle();
    this.want = before.want;
    if (!this.isPinned) {
      this.copy = before.copy;
      return { refused: "unavailable" };
    }
    this.want = null;
    this.unsaved = !this.persist(scope);
    return this.unsaved ? { waiting: "in" } : { joined: this.status() };
  }

  /**
   * Another Ovis on this state folder bound the PC between this server's read of the list and its write: the binding
   * the file holds stands, and this server writes nothing of its own over what that one keeps (its copy above all). By
   * the same account and list, this server goes by that binding and the copy that server saved; otherwise the PC
   * joined elsewhere.
   */
  private async boundMeanwhile(held: ListBound, account: string, list: string): Promise<JoinOutcome> {
    // the file's binding is this server's from here: what it held for the join goes with endBinding
    const scope = this.bound();
    if (scope === null || scope.bindId !== held.id) return { refused: "unavailable" };
    if (held.account !== account) return { refused: "other_account" };
    // in the account on the service's word: the next ask names the list as for any PC in its account
    if (held.list === null) return { waiting: "waiting" };
    if (held.list !== list) return { refused: "pinned" };
    return await this.copyOnDisk(scope);
  }

  /**
   * A PC pinned to `scope`'s list that holds no copy in memory: the copy saved for that binding (by another Ovis on
   * this folder, say) is read from the file. It says it joined only when that copy shows the PC in; until then
   * `waiting`, and the follower reads the list itself meanwhile. Nothing is written here.
   */
  private async copyOnDisk(scope: Bound): Promise<JoinOutcome> {
    if (this.copy === null) {
      this.takeFile(scope);
      await this.ready;
    }
    const copy = this.copy;
    if (copy === null || copy.list !== scope.list || standing(copy) !== "in") return { waiting: "in" };
    this.freshPin = true;
    this.settle();
    return { joined: this.status() };
  }

  /**
   * A PC joins by itself with the invite of a line (`ovis join`, an auto invite): what the holder of the line needs
   * before the `join` is written. The line never leaves the command that read it, so this PC only says where the
   * list stands: the place the `join` takes, the epoch its names are sealed under, this PC's encryption key, and the
   * wraps the account service holds for the invite's key, which only the line opens. Refused for an invite the list
   * does not hold as open, for one a person adds a PC with (`invite_plain`), and for one that more than one PC may
   * use (`invite_uses`): a PC joins by itself only with an invite made for one PC.
   */
  joinPrepare(given: { readonly account: string; readonly list: string; readonly invite: string }): Promise<JoinPrepared> {
    return this.enqueue(async (): Promise<JoinPrepared> => {
      const { account, list, invite } = given;
      if (typeof invite !== "string" || !isListKeyEncoding(invite)) return { refused: "invalid_list" };
      const read = await this.candidateOf(account, list);
      if ("refused" in read) return read;
      // Getting ready binds nothing. A PC in its account, or one the list holds already, writes no join: it joins only by
      // what proves it, the line's proof for its own card (joinByLine), and is handed that card for the line to sign
      if ("bound" in read || standing(read.copy) === "in") {
        const card = await this.lineCard(list);
        return card === null ? { refused: "unavailable" } : { prove: card };
      }
      const { copy, keys } = read;
      const { state } = copy;
      // not read: the account service did not answer, or serves this PC no list
      if (state === null || state.footing.seq < 0 || copy.entries.length === 0) return { refused: "not_read" };
      const dead = inviteRefusal(state, invite);
      if (dead !== null) return { refused: dead };
      const row = state.invites[invite];
      if (row === undefined || !row.auto) return { refused: "invite_plain" };
      if (row.uses !== 1) return { refused: "invite_uses" };
      const seal = sealEpoch(state, this.joinClock(state));
      let wraps: { epoch: number; wrap: string }[] = [];
      if (seal !== null) {
        try {
          const held = (await this.deps.call("/v2/pc/list/wraps", { list, member: invite })).wraps;
          if (Array.isArray(held)) wraps = held.flatMap((wrap: unknown) => typeof wrap === "object" && wrap !== null && typeof (wrap as { epoch?: unknown }).epoch === "number" && typeof (wrap as { wrap?: unknown }).wrap === "string"
            ? [{ epoch: (wrap as { epoch: number }).epoch, wrap: (wrap as { wrap: string }).wrap }] : []);
        } catch (error) { this.error = this.words(error); }
      }
      return { prepared: { list, seq: state.footing.seq + 1, enc: keys.enc, seal, wraps } };
    });
  }

  /**
   * The body of this PC's `join` on the list as it was last read, for the invite's key to sign: built here from this
   * PC's own keys (joinEntry), with the card this PC signs for this list, its relay key and that invite, so the line's
   * holder signs nothing it composed. `sealed`: this PC's names as the line's holder sealed them for the place
   * `seq`, or null. `again` when the list moved since it was prepared.
   */
  joinBody(given: { readonly account: string; readonly list: string; readonly invite: string; readonly seq: number; readonly sealed: Sealed | null }): Promise<{ readonly body: Uint8Array } | { readonly again: true } | { readonly refused: JoinRefusal | JoinWriteRefusal }> {
    return this.enqueue(async () => {
      const { account, list, invite, seq, sealed } = given;
      const scope = this.sync();
      const candidate = this.candidate;
      if (scope === null || scope.bindId !== null) return { refused: "unavailable" as const };
      if (candidate === null || candidate.account !== account || candidate.copy.list !== list || candidate.copy.state === null) return { again: true as const };
      const keys = await this.keysOf(scope);
      if (keys === null || keys.key !== candidate.copy.me.key || scope.endpoint !== candidate.copy.me.endpoint) return { refused: "unavailable" as const };
      const { state } = candidate.copy;
      if (state.footing.seq + 1 !== seq) return { again: true as const };
      let body: Uint8Array | null = null;
      const capture = new Error("captured");
      try {
        // the invite's key is the line's alone: the body is taken as it would be signed, and signed where the line is
        await joinEntry({ key: invite, list, signJoin: async (built) => { body = writeBody(built); throw capture; } },
          { key: keys.key, privateKey: keys.privateKey, enc: keys.enc, endpoint: scope.endpoint }, state, this.joinClock(state), sealed);
      } catch (error) {
        if (error instanceof ListWriteError && error.reason === "behind") return { refused: "behind" as const };
        if (error instanceof ListWriteError) { this.error = `This PC's join would not count (${error.outcome === null ? error.reason : "code" in error.outcome ? error.outcome.code : error.outcome.outcome})`; return { refused: "not_written" as const }; }
        if (error instanceof ListKindError) return { refused: "not_written" as const };
        if (error !== capture) throw error;
      }
      if (body === null) return { refused: "not_written" as const };
      this.pendingJoin = { account, list, invite, body };
      return { body };
    });
  }

  /**
   * The `join` the line's holder signed is placed at the account service, with this PC's proof (the second lock: this
   * very PC redeemed that invite). Only the entry whose body this PC built is placed. Then the PC reads the list and
   * joins by it, as `joinList` does, when the entry that put it in is that invite's. `again`: the list moved, or the
   * account service asks for the same again; the caller prepares anew.
   */
  joinPlace(given: { readonly account: string; readonly list: string; readonly invite: string; readonly entry: string; readonly wraps: readonly { readonly epoch: number; readonly member: string; readonly wrap: string }[] }): Promise<JoinOutcome | { readonly again: true } | { readonly refused: JoinWriteRefusal; readonly detail: string | null }> {
    return this.enqueue(async () => {
      const { account, list, invite, entry, wraps } = given;
      const pending = this.pendingJoin;
      if (pending === null || pending.account !== account || pending.list !== list || pending.invite !== invite) return { again: true as const };
      let signed: Uint8Array;
      try { signed = entryFromText(entry).body; } catch { return { refused: "not_written" as const, detail: "entry_malformed" }; }
      if (signed.length !== pending.body.length || signed.some((byte, index) => byte !== pending.body[index])) return { refused: "not_written" as const, detail: "other_body" };
      this.pendingJoin = null;
      try {
        await this.deps.call("/v2/pc/list/entries", { list, entries: [entry], ...(wraps.length > 0 ? { wraps } : {}) });
      } catch (error) {
        // no answer, or a 5xx that says nothing of the entry (a gateway in front of the service): it may be placed all
        // the same, which only the log says. The service's own answers are taken as it gave them
        const named = error instanceof AccountServiceRefusal && error.status === 503 && (error.code === "list_rebuilding" || error.code === "list_stopped");
        if (error instanceof AccountServiceRefusal && (error.status < 500 || named)) {
          if (error.status === 409 && (error.code === "head_moved" || error.code === "try_again")) return { again: true as const };
          if (error.status === 503 && error.code === "list_rebuilding") return { again: true as const };
          return { refused: "refused" as const, detail: `${error.status}${error.code === null ? "" : ` ${error.code}`}` };
        }
      }
      const joined = await this.joining({ account, list, by: invite }, false);
      return "waiting" in joined && joined.waiting === "waiting" ? { again: true as const } : joined;
    });
  }

  /**
   * The time a `join` of this PC is signed at, and its names sealed by (X1 amended): its own clock as it reads now, held
   * against the list's own time (listClock with no saved hour), never an hour the account service names, and never the
   * hour it saved (that floor lets in and refuses, and signs nothing).
   */
  private joinClock(state: ListState): number {
    return listClock(state, this.seconds(), null);
  }

  /**
   * What this PC is to a list: its relay identity, its relay key as an entry names it, and its own list keys. Null for
   * a PC with no relay identity, or whose keys cannot be read or made.
   */
  async own(): Promise<{ readonly serverId: string; readonly endpoint: string; readonly keys: PcListKeys } | null> {
    const scope = this.sync();
    if (scope === null) return null;
    const keys = await this.keysOf(scope);
    return keys === null ? null : { serverId: scope.serverId, endpoint: scope.endpoint, keys };
  }

  /** This PC's two public keys and its card for `list`, as a member that adds it signs them into a `pc` entry; null when its keys cannot be used. */
  async cardFor(list: string): Promise<{ readonly key: string; readonly enc: string; readonly card: string } | null> {
    const own = await this.own();
    if (own === null || !isListHash(list)) return null;
    const { key, enc, privateKey } = own.keys;
    return { key, enc, card: await signCard({ key, enc, list, endpoint: own.endpoint, invite: null }, privateKey) };
  }

  /** The clock: a read that is due, a device whose time has passed, rows that still wait for what the list says. */
  tick(): void {
    if (this.stopped) return;
    try { this.deps.retry?.(); } catch { /* tried again at the next look */ }
    const scope = this.bound();
    if (scope === null) return;
    // a file that could not be read is tried again: one that reads by now is taken
    if (this.broken !== null && this.copy === null) { this.broken = null; this.takeFile(scope); void this.enqueue(async () => { await this.ready; await this.ensureCopy(scope); this.settle(); }); }
    if (this.problem !== null) return;
    const now = this.seconds();
    // a copy the disk did not take is offered to it again
    if (this.unsaved) void this.enqueue(() => { const bound = this.bound(); if (this.stopped) return; if (bound !== null && this.unsaved && this.copy !== null) this.unsaved = !this.persist(bound); this.settleOwed(); });
    else this.settleOwed();
    if (this.isPinned && (this.dirty || (this.untilAt !== null && now >= this.untilAt))) void this.enqueue(async () => { await this.ready; this.settle(); this.settleOwed(); });
    // any PC that holds a list reads it by its own clock, one that only shadows too: a mailbox that names no list, or
    // does not answer, hides no entry. A PC whose account never had a list holds no copy and asks nothing
    const copy = this.copy;
    if (copy === null) return;
    // a PC that was just named its list has a person waiting beside it for the entry that adds it
    const waited = this.wantedAt === null ? null : this.deps.now() - this.wantedAt;
    const busy = this.isPinned ? this.deps.busy?.() === true : waited !== null && waited >= 0 && waited < LIST_WANT_BUSY_MS;
    const step = followStep(copy, now, { event: "tick", asked_at: this.askedAt, busy });
    if (step.do === "read") void this.readNow();
    // a PC that waits to be added keeps its post alive by its own clock too, whatever the mailbox says
    if (standing(copy) === "waiting") void this.enqueue(async () => {
      const held = this.copy;
      if (held === null || standing(held) !== "waiting" || !this.live(scope)) return;
      const keys = await this.keysOf(scope);
      if (keys !== null && this.live(scope) && this.copy !== null && this.copy.me.key === keys.key && standing(this.copy) === "waiting") await this.post(this.copy, keys, scope);
    });
  }

  /**
   * Before a pinned PC lets a device open a session: when its last full read is too old, it reads now and the session
   * waits for that, a few seconds at most; then the PC decides on its copy as it is. A service that did not answer a
   * moment ago is not asked again for it.
   * `budgetMs`: how much of the sign-in's few seconds is left.
   */
  async beforeSession(budgetMs?: number): Promise<void> {
    if (!this.pinned()) return;
    await this.ready;
    const copy = this.copy;
    if (copy === null) return;
    const now = this.seconds();
    const step = followStep(copy, now, { event: "session", since: null });
    if (step.do !== "read_and_wait") return;
    if (this.reading === null && this.askedRecently(now)) return;
    // one wait a sign-in: what it already waited for the account service (`budgetMs` is what is left of it) is not waited again
    const read = this.readNow();
    const wait = Math.min((step.until - now) * 1000, budgetMs ?? Number.POSITIVE_INFINITY);
    if (wait > 0) await this.within(read, wait);
  }

  /**
   * A sign-in a pinned PC could not accept: a member may have let the device in a moment ago. The PC reads its list,
   * at most once in PC_BUSY_READ_SECONDS, and the sign-in waits `waitMs` for it at most. `readmission`: the proved
   * returning device that read may let in again.
   */
  async readForSignIn(waitMs: number, readmission?: Readmission): Promise<void> {
    if (!this.pinned()) return;
    await this.ready;
    if (this.copy === null) return;
    if (this.reading === null && this.askedRecently(this.seconds())) {
      // no new read, and the same few seconds: the turn may stand behind a read the mailbox began, which goes on by itself
      if (readmission) await this.within(this.enqueue(() => { this.settle(readmission); }), waitMs);
      return;
    }
    await this.within(this.readNow().then(() => this.enqueue(() => { if (readmission) this.settle(readmission); })), waitMs);
  }

  /**
   * Why this PC lets no device into its list right now, or null when a person at it can: it is pinned and in, its own
   * key signs for the list with full power (a PC a person added, not one that joined by an invite), no alarm stands,
   * and its keys are read. From memory, with no wait.
   */
  allowRefusal(): AllowRefusal | null {
    if (!this.pinned()) return "not_pinned";
    const copy = this.copy;
    if (copy === null || copy.state === null || this.problem !== null || this.held === null || this.held.key !== copy.me.key) return "unavailable";
    return cannotAllow(copy);
  }

  canAllow(): boolean { return this.allowRefusal() === null; }

  /**
   * The list a join's card is taken for (ACCOUNT_LIST_ALLOW), or null: this PC is pinned to it, is in it, its copy is
   * usable and no alarm stands (with one, it lets nobody new in). A PC that cannot sign itself (it joined by an
   * invite) takes cards too: a member device may allow the newcomer, sign its entry and hand it over, and the PC then
   * only reads.
   */
  takesCardsFor(): string | null {
    if (!this.pinned() || this.problem !== null || this.alarmLost) return null;
    const copy = this.copy;
    return copy !== null && copy.state !== null && copy.alarm === null && standing(copy) === "in" ? copy.list : null;
  }

  /**
   * Lets a device into the list, and so into every PC of the account. With `sign`, a person at this PC decided it (its
   * own window, `ovis approve`): the PC signs a `device` entry with its own key and places it at the account service.
   * Without, a member decided it elsewhere: the PC only reads, and lets the device in when an entry of the list does.
   * The entry is written through the kinds' own writer, which signs nothing that would not count. Its name is sealed
   * and the names' key wrapped to the device when this PC holds that key; a device is let in all the same without.
   * A head that moved is read and signed on again, and a service that is busy is sent the same request again,
   * LIST_ALLOW_TRIES times in all; any other refusal ends it. The device is in only once the log shows its entry.
   */
  allowDevice(device: AllowedDevice, sign: boolean): Promise<AllowOutcome> {
    const no = (refused: AllowRefusal, detail: string | null = null): AllowOutcome => ({ refused, detail });
    const decided = async (work: Promise<AllowOutcome>): Promise<AllowOutcome> => {
      this.allowing.add(device.key);
      try {
        const outcome = await work;
        // let in by a person's decision: its row waits no join hold, also one a read made a moment before the decision
        if ("allowed" in outcome) this.settle();
        return outcome;
      } finally { this.allowing.delete(device.key); }
    };
    // A member's entry is waited for outside the queue: half a minute of waiting holds back no read, and no page
    return sign ? this.enqueue(() => decided(this.allow(device, no))) : decided(this.awaitMember(device, no));
  }

  /**
   * A member allowed the device and signs its entry itself, once the new device confirmed its digits: the PC signs
   * nothing, and waits for that entry to reach its copy (the member hands the page over, or the account service shows
   * it), LIST_MEMBER_WAIT_MS at most. What this PC itself holds against the key is asked at each look.
   */
  private async awaitMember(device: AllowedDevice, no: (refused: AllowRefusal, detail?: string | null) => AllowOutcome): Promise<AllowOutcome> {
    const scope = this.bound();
    if (scope === null || !this.isPinned) return no("not_pinned");
    await this.ready;
    const deadline = performance.now() + (this.deps.memberWaitMs ?? LIST_MEMBER_WAIT_MS);
    let askedAt = Number.NEGATIVE_INFINITY;
    let lastLook = false;
    for (;;) {
      if (!this.live(scope) || !this.isPinned || this.problem !== null) return no("unavailable");
      if (this.deps.mayAdmit?.(device.key) === false) return no("held_here");
      const copy = this.copy;
      const place = copy === null || copy.state === null ? null : placeOf(copy, device);
      if (place !== null) return { allowed: place };
      const left = deadline - performance.now();
      if (left <= 0) {
        // the time is over: the account service is asked once more before the device is told it is not in the list
        if (lastLook) return no("not_in_list");
        lastLook = true;
        // a read that went out before the time was over may answer with a head from before the member's entry: it is
        // let end, and the last look is a read begun now
        if (this.reading !== null) await this.reading;
        await this.readNow();
        continue;
      }
      if (performance.now() - askedAt >= LIST_MEMBER_READ_MS) { askedAt = performance.now(); void this.readNow(); }
      await new Promise((resolve) => setTimeout(resolve, Math.min(left, LIST_MEMBER_LOOK_MS)));
    }
  }

  private async allow(device: AllowedDevice, no: (refused: AllowRefusal, detail?: string | null) => AllowOutcome): Promise<AllowOutcome> {
    {
      const scope = this.bound();
      if (scope === null || !this.isPinned) return no("not_pinned");
      await this.ready;
      await this.ensureCopy(scope);
      const keys = await this.keysOf(scope);
      if (keys === null || this.problem !== null) return no("unavailable");
      if (this.deps.mayAdmit?.(device.key) === false) return no("held_here");
      await this.read(scope);
      // One signature per place: the request as it was signed, and the head it was signed on. It is sent again as it
      // is while this PC's own copy shows that head; another is signed only once the copy shows a new one. It is kept
      // beside the copy (ACCOUNT_LIST_ALLOW_FILE), so that holds for another Allow and after a restart too
      let request: KeptAllow | null = null;
      let last: AllowRefusal = "head_lost";
      // how long the next try waits; nothing waits after the last one
      let wait = 0;
      for (let tries = 0; tries < LIST_ALLOW_TRIES; tries++) {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        wait = 0;
        if (!this.live(scope)) return no("unavailable");
        const copy = this.copy;
        if (copy === null || copy.state === null) return no("unavailable");
        const { state } = copy;
        // what this PC signed before and does not know to be placed; one the copy has gone past is forgotten here
        const kept = this.keptAllow(scope, copy);
        // in already: this PC's own entry that the log now shows, or one a member placed
        const place = placeOf(copy, device);
        if (place !== null) return { allowed: place };
        const cannot = keys.key !== copy.me.key ? "unavailable" : cannotAllow(copy);
        if (cannot !== null) return no(cannot);
        if (kept === "unread") return no("not_written", "kept_unreadable");
        // the copy does not reach the head this PC signed on (a restart on an older copy, a service that shows less):
        // nothing is signed under it
        if (kept !== null && kept.seq > state.footing.seq) return no("service_away");
        if (request === null || request.onHead !== state.footing.hash) {
          // signed at this very head before, for this device or another: it goes out again as it is, and goes first
          if (kept !== null) request = kept;
          else {
            let written: Awaited<ReturnType<ListFollow["writeAllow"]>>;
            try { written = await this.writeAllow(copy, state, device, keys); } catch (error) {
              if (error instanceof ListWriteError && error.reason === "behind") return no("behind");
              if (error instanceof ListWriteError) return no("not_written", error.outcome === null ? error.reason : "code" in error.outcome ? error.outcome.code : error.outcome.outcome);
              if (error instanceof ListKindError) return no("not_written", "entry_invalid");
              throw error;
            }
            if (!this.live(scope)) return no("unavailable");
            // an entry that cannot be kept is not sent: after a restart nothing would say that this place was signed
            request = this.keepAllow(scope, { list: copy.list, seq: state.footing.seq, onHead: state.footing.hash, key: device.key, enc: device.enc, ...written });
            if (request === null) return no("not_written", "not_kept");
          }
        }
        const sent: KeptAllow = request;
        const own = sent.key === device.key && sent.enc === device.enc;
        // What this PC itself holds against the device, and its own place in the account, are read again before each
        // submission and once more when the proof to the service is made, right before the entry goes out: a lock or
        // a removal that came while the entry was prepared, or while the PC proved itself, signs nobody in
        // So is the copy as it stands by then: one that came to hold an alarm meanwhile (a member's page, taken beside
        // this work) signs nobody in
        const stopped = (): AllowOutcome | null => {
          const now = this.copy;
          if (!this.live(scope) || !this.isPinned || now === null || now.state === null) return no("unavailable");
          const cannot = keys.key !== now.me.key ? "unavailable" : cannotAllow(now);
          if (cannot !== null) return no(cannot);
          if (this.deps.mayAdmit?.(device.key) === false) return no("held_here");
          if (this.deps.mayAdmit?.(sent.key) !== false) return null;
          this.keptHeld = true;
          return no("not_written", "place_kept");
        };
        // the kept entry of a device this PC has come to hold back is never sent; past its time it gives the place up
        if (!own && this.deps.mayAdmit?.(sent.key) === false && this.keptFor() >= LIST_KEPT_HELD_MS) {
          this.dropAllow();
          request = null;
          continue;
        }
        const early = stopped();
        if (early !== null) return early;
        // the copy moved while the entry was prepared: it is looked at again, and the entry is signed on the head it has now
        if (this.copy?.state?.footing.hash !== sent.onHead) continue;
        try {
          await this.deps.call("/v2/pc/list/entries", { list: sent.list, entries: sent.entries, ...(sent.wraps.length > 0 ? { wraps: sent.wraps } : {}) },
            () => { const late = stopped(); if (late !== null) throw new AllowStopped(late); });
        } catch (error) {
          if (error instanceof AllowStopped) return error.outcome;
          const named = error instanceof AccountServiceRefusal && error.status === 503 && (error.code === "list_rebuilding" || error.code === "list_stopped");
          if (!(error instanceof AccountServiceRefusal) || (error.status >= 500 && !named)) {
            // no answer, or one that says nothing of the entry (a gateway in front of the service): it may be placed
            // all the same, which only the log says
            last = "service_away";
            await this.read(scope);
            continue;
          }
          const asked = error.retryAfter === null ? LIST_ALLOW_RETRY_MS : Math.min(Math.max(error.retryAfter * 1000, LIST_ALLOW_RETRY_MS), LIST_ALLOW_RETRY_MAX_MS);
          if (error.status === 409 && error.code === "head_moved") {
            await this.read(scope);
            // a head that moved and that no read shows may be this very entry's (its first answer was lost): whether
            // it was placed is not known, which is not the same as a place that was lost to another
            last = this.copy?.state?.footing.hash === sent.onHead ? "service_away" : "head_lost";
            continue;
          }
          if (error.status === 409 && error.code === "try_again") { last = "head_lost"; wait = asked; continue; }
          if (error.status === 503 && error.code === "list_rebuilding") { last = "service_away"; wait = asked; continue; }
          // the service's own word that it did not place the entry: nothing is kept of it
          this.dropAllow();
          request = null;
          // it was another device's: this one's is signed next
          if (!own) continue;
          if (error.status === 503 && error.code === "list_stopped") return no("list_stopped");
          if (error.status === 403 && error.code === "not_claimed") return no("not_claimed");
          return no("refused", `${error.status}${error.code !== null && REFUSAL_CODE.test(error.code) ? ` ${error.code}` : ""}`);
        }
        // placed: the device is in once this PC's own copy shows the entry, never on the answer
        await this.read(scope);
      }
      const copy = this.live(scope) ? this.copy : null;
      if (copy !== null && copy.state !== null) this.keptAllow(scope, copy);
      const place = copy !== null ? placeOf(copy, device) : null;
      return place === null ? no(last) : { allowed: place };
    }
  }

  /** The `device` entry of an Allow on the copy's footing, with the wrap of the names' key for the newcomer when this PC holds that key. */
  private async writeAllow(copy: FollowerCopy, state: ListState, device: AllowedDevice, keys: PcListKeys) {
    // By this PC's own clock as it reads now, never the account service's: the list's own time moves with what a
    // member signs, so a service that says tomorrow must not make this PC sign tomorrow, which would end every borrowed
    // device at once and could not be undone. The hour this PC saved is for letting in and refusing only: it signs
    // nothing and decides nothing that is signed, so an hour that was once pushed ahead keeps no names from being
    // sealed. It is held against the list's own time, though: an entry is never dated before the one it follows
    const now = listClock(state, this.seconds(), null);
    const seal = sealEpoch(state, now);
    const epochKey = seal === null ? null : await this.epochKey(copy, state, seal.epoch, keys);
    let sealed: Sealed | null = null;
    const wraps: { epoch: number; member: string; wrap: string }[] = [];
    if (seal !== null && epochKey !== null) {
      const label = isListLabel(device.label) ? device.label : LIST_DEVICE_LABEL;
      sealed = { epoch: seal.epoch, bytes: await sealFields({ place: { list: copy.list, seq: state.footing.seq + 1 }, epoch: epochKey, commitment: seal.opens, fields: namesFields({ label, os: null }) }) };
      const wrap = await wrapEpochKey({ list: copy.list, epoch: epochKey, member: device.enc });
      if (wrap !== null) wraps.push({ epoch: seal.epoch, member: device.enc, wrap: wrapToText(wrap) });
    }
    const written = await signListEntry(state, { kind: "device", key: device.key, power: "full", role: "drive", until: null, enc: device.enc, card: device.card, sealed, rotates: false },
      { key: keys.key, privateKey: keys.privateKey }, now);
    return { entries: [written.text], wraps };
  }

  /**
   * The key to the list's names of `epoch`, when the account service holds a wrap of it for this PC that gives the
   * commitment the list holds; null otherwise. A key that does not give it is the service's doing, and is said.
   */
  private async epochKey(copy: FollowerCopy, state: ListState, epoch: number, keys: PcListKeys): Promise<EpochKey | null> {
    const id = `${copy.list} ${epoch}`;
    const kept = this.epochKeys.get(id);
    if (kept !== undefined) return kept;
    const opens = state.epochs[epoch]?.opens;
    if (opens === undefined) return null;
    let wraps: unknown;
    try { wraps = (await this.deps.call("/v2/pc/list/wraps", { list: copy.list, member: keys.enc })).wraps; } catch (error) {
      this.error = this.words(error);
      return null;
    }
    const mine = Array.isArray(wraps) ? wraps.find((wrap): wrap is { epoch: number; wrap: string } => typeof wrap === "object" && wrap !== null && (wrap as { epoch?: unknown }).epoch === epoch && typeof (wrap as { wrap?: unknown }).wrap === "string") : undefined;
    if (mine === undefined) return null;
    const opened = await openWrap({ list: copy.list, epoch, commitment: opens, wrap: wrapFromText(mine.wrap), member: { key: keys.enc, privateKey: keys.encPrivateKey } });
    if (!opened.open) {
      if (opened.why === "other_key") this.error = "The account service gave this PC a wrong key to the list's names";
      return null;
    }
    this.epochKeys.set(id, opened.value);
    return opened.value;
  }

  /**
   * Where this PC stands in its list, as it tells a member that asks (gossipHead): its list id and the last entry a
   * member signed in its copy. Null while it follows no list a person named, and while its copy cannot be used.
   */
  peerHead(): ListHead | null {
    const scope = this.bound();
    if (scope === null || this.copy === null || this.problem !== null || (!this.isPinned && this.want === null)) return null;
    return gossipHead(this.copy);
  }

  /** What this PC asks another member for, so that member can hand it the entries it lacks; null while it follows no list a person named. */
  asks(): PeerAsk | null {
    const scope = this.bound();
    if (scope === null || this.copy === null || (!this.isPinned && this.want === null)) return null;
    const { list, after } = startRead(this.copy, "peer");
    return { list, after };
  }

  /**
   * A member's answer to `asks`, handed over directly: taken as the account service's pages are, since entries prove
   * themselves. So a removal the service withholds reaches this PC from any member that has it.
   */
  takeFromPeer(page: ListPage): Promise<FollowVerdict | "not_saved" | "unasked" | null> {
    return this.takePeerPage(page).then((taken) => taken?.verdict ?? null);
  }

  /**
   * A page a device hands this PC over its session (POST /api/account/list/page). `session` names that session: where
   * the follower asked for an earlier place (to find where two histories part), the read is kept for it, and the
   * page that answers it is taken as its continuation. Any other page is one nobody asked for, taken from the place
   * it names. `asks`: the place the follower wants next from that device, or null. `not_saved`: the entries were
   * verified and acted on, and the disk did not take the copy.
   */
  async takePeerPage(page: ListPage, session?: PeerCaller): Promise<{ readonly verdict: FollowVerdict | "not_saved" | "unasked"; readonly asks: PeerAsk | null } | null> {
    const scope = this.bound();
    if (scope === null) return null;
    await this.ready;
    // Not behind the queue: a read of the account service that is out, which a slow service can hold for as long as
    // its timeouts allow, keeps no member's page waiting. It waits only for a page that is being checked (apply)
    return await this.apply(async () => {
      if (!this.live(scope)) return null;
      await this.ensureCopy(scope);
      for (let tries = 0; tries < PAGE_APPLY_TRIES; tries++) {
        const copy = this.copy;
        if (copy === null || this.problem !== null || (!this.isPinned && this.want === null)) return null;
        const kept = session === undefined ? undefined : this.peerReads.get(session);
        const start = startRead(copy, "peer");
        const asked = kept !== undefined && kept.list === copy.list && page.after === kept.after;
        // A page nobody asked for costs no signature check before it is known to matter: its first entry must follow an
        // entry this PC holds (its head, or one before it). The read this caller was asked for goes on where it stood
        const from = page.after === undefined ? start.after : page.after;
        if (!asked && !followsCopy(copy, page.entries[0], from)) return { verdict: "unasked" as const, asks: null };
        // the read this caller was asked for, when the page answers it; else a read from the place the page names
        const read: FollowRead = asked ? kept : { ...start, after: from };
        const result = await takePage(copy, read, page, this.seconds());
        if (!this.live(scope)) return null;
        // what the PC holds was replaced while the page was checked (a list named here): the page is checked against that
        if (this.copy === null || changed(copy, this.copy)) continue;
        if (session !== undefined) {
          this.peerReads.delete(session);
          if (result.read !== null) {
            this.peerReads.set(session, result.read);
            while (this.peerReads.size > PEER_SESSIONS_MAX) this.peerReads.delete(this.peerReads.keys().next().value!);
          }
        }
        // acted on at once; said as taken only once it is on disk
        const saved = this.keep(result.copy, scope, changed(copy, result.copy));
        return { verdict: saved ? result.verdict : "not_saved", asks: result.read === null ? null : { list: result.read.list, after: result.read.after } };
      }
      return null;
    });
  }

  /**
   * Where this PC stands against where a device says it stands (POST /api/account/list/head): the PC's own head; the
   * entries after the device's place when the device stands at an earlier place of the PC's own history (`page`); and
   * the place the PC asks the device for when the device stands further, or at another entry (`asks`). For another
   * list than the PC's: its own head and nothing else. Null while it follows no list a person named.
   */
  peerHeads(theirs: ListHead, session?: PeerCaller): { readonly list: string; readonly place: ListHead["place"]; readonly page?: ListPage; readonly asks?: PeerAsk } | null {
    const own = this.peerHead();
    const copy = this.copy;
    if (own === null || copy === null) return null;
    const compared = compareHeads(copy, theirs);
    if (compared.verdict === "ahead") {
      const page = servePage(copy, { list: copy.list, after: theirs.place?.seq ?? null }, PEER_PAGE_MAX);
      return page === null ? own : { ...own, page };
    }
    if (compared.read === null) return own;
    if (session !== undefined) {
      this.peerReads.delete(session);
      this.peerReads.set(session, compared.read);
      while (this.peerReads.size > PEER_SESSIONS_MAX) this.peerReads.delete(this.peerReads.keys().next().value!);
    }
    return { ...own, asks: { list: compared.read.list, after: compared.read.after } };
  }

  /** Whether `session` may make one more call of the two (PEER_CALLS_PER_MINUTE): each costs signature checks. Charged before its body is read. */
  peerBudget(caller: PeerCaller): boolean {
    // by a clock that only moves forward: a wall clock set back gives no caller a new minute
    const now = this.deps.mono?.() ?? performance.now();
    for (const [held, calls] of this.peerCalls) {
      const live = calls.filter((at) => now - at < 60_000);
      if (live.length === 0) this.peerCalls.delete(held);
      else if (live.length !== calls.length) this.peerCalls.set(held, live);
    }
    // Counted by the key the PC let the caller in by, whatever its sessions do: a device that opens one session after
    // another gets no more, and the callers counted are only the keys the PC lets in, so none is refused for others
    const calls = this.peerCalls.get(caller) ?? [];
    if (calls.length >= PEER_CALLS_PER_MINUTE) return false;
    this.peerCalls.set(caller, [...calls, now]);
    return true;
  }


  /**
   * Shadow: a sign-in the snapshot path has just decided. The list's own answer for that device is compared and a
   * difference is said once. It decides nothing, waits for nothing and never throws.
   */
  shadowSignIn(given: { readonly deviceId: string; readonly nonce: Uint8Array; readonly signature: string; readonly serverId: string; readonly snapshot: SnapshotVerdict }): void {
    try {
      const copy = this.shadow();
      if (copy === null) return;
      const key = this.deps.rowKey(given.deviceId) ?? this.idsOf(copy).get(given.deviceId) ?? null;
      if (key === null) return;
      const list = this.shadowAnswer(copy, key);
      if (given.snapshot === "admitted") { this.compare(key, "admitted", list.role ?? list.why); return; }
      // No row here: the list alone would let it in only for the proof of its key
      if (list.role === null) return;
      const role = list.role;
      const scope = this.bound();
      // the proof is checked later: what it shows is said only of the binding the sign-in came under
      void this.enqueue(() => verifyRelayProof(key, given).then((proved) => { if (proved && scope !== null && this.live(scope) && this.shadow() !== null) this.compare(key, "none", role); }));
    } catch { /* a shadow never stands in the way of a sign-in */ }
  }

  /**
   * Shadow: the devices a whole snapshot read lets in, against the devices the list lets in. Compared in turn, after
   * whatever read of the list the same pull began, and never awaited by the snapshot read.
   */
  shadowSnapshot(eligible: readonly string[]): void {
    void this.enqueue(() => {
      const copy = this.shadow();
      if (copy === null) return;
      const named = new Set(eligible);
      for (const key of named) { const list = this.shadowAnswer(copy, key); this.compare(key, "admitted", list.role ?? list.why); }
      for (const key of this.idsOf(copy).values()) {
        if (named.has(key)) continue;
        const list = this.shadowAnswer(copy, key);
        if (list.role !== null) this.compare(key, "none", list.role);
      }
    });
  }

  private compare(key: string, snapshot: SnapshotVerdict, list: ListRole | SessionRefusal): void {
    // the snapshot's rows all drive: a device the list lets in to watch is a difference too
    if (snapshot === "admitted" && list === "drive") return;
    // where the PC itself is not in the list, that is one difference, not one for each device
    const id = PC_STATES.has(list) ? `${snapshot} ${list}` : `${key} ${snapshot} ${list}`;
    if (this.differences.has(id) || this.differences.size >= DIFFERENCES_MAX) return;
    this.differences.add(id);
    // A key that only one of the two holds may be the same phone under its other key: the snapshot names a phone by
    // the key of its sign-in, the list by its member key, and nothing here links the two. So that is a difference of
    // credentials. A key both hold, decided otherwise, and the PC's own place in the list, are differences of devices
    const of = (snapshot === "admitted" && list === "never_added") || snapshot === "none" ? "credential" : "device";
    logAccess({ event: "account.list.differs", snapshot, list, of });
  }

  /** The copy a PC that is not pinned compares its snapshot with; null on a pinned PC, which decides by the list. */
  private shadow(): FollowerCopy | null {
    return this.bound() === null || this.isPinned ? null : this.clocked();
  }

  /** The list's answer for `key` on the copy a shadow compares with; an answer that turned on the hour saves that hour first. */
  private shadowAnswer(copy: FollowerCopy, key: string): ReturnType<typeof admitsSession> {
    const answer = admitsSession(copy, key, this.seconds());
    const until = copy.state?.devices[key]?.until ?? null;
    if (answer.why === "expired" && until !== null) this.saveFloor([{ key, until }]);
    return answer;
  }

  /** One thing at a time, in the order asked. What it throws is said in the status and goes no further. */
  /**
   * One page at a time is checked against the copy and taken into it: the account service's and a member's alike.
   * Nothing in here waits for the network, so it holds nobody for longer than the checking of one page takes.
   */
  private apply<T>(run: () => Promise<T>): Promise<T> {
    const next = this.applying.then(run, run);
    this.applying = next.catch(() => undefined);
    return next;
  }
  private applying: Promise<unknown> = Promise.resolve();

  private enqueue<T>(run: () => T | Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch((error: unknown) => { this.error = this.words(error); });
    return next;
  }

  private within(work: Promise<unknown>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      void work.then(() => undefined, () => undefined).then(() => { clearTimeout(timer); resolve(); });
    });
  }

  private askedRecently(now: number): boolean {
    return this.askedAt !== null && now - this.askedAt >= 0 && now - this.askedAt < PC_BUSY_READ_SECONDS;
  }

  private seconds(): number { return Math.floor(this.deps.now() / 1000); }

  private words(error: unknown): string {
    // a code is said only in the form the service's own codes have: nothing longer, and nothing that could be a key
    if (error instanceof AccountServiceRefusal) return `The account service answered ${error.status}${error.code !== null && REFUSAL_CODE.test(error.code) ? ` ${error.code}` : ""} to ${error.path}`;
    if (error instanceof ListKeysError) return error.message;
    return error instanceof Error ? error.name : "The list could not be followed";
  }

  private idsOf(copy: FollowerCopy): Map<string, string> {
    let ids = this.ids.get(copy);
    if (!ids) {
      ids = new Map((copy.state ? listView(copy.state).devices : []).map((row) => [accountDeviceId(this.serverId ?? "", row.key), row.key]));
      this.ids.set(copy, ids);
    }
    return ids;
  }

  /**
   * The relay identity and binding the PC has now, with what this class holds brought in line with them, at once: the
   * file is read the first time, and a binding or identity that changed since ends what belonged to the one before.
   * Null for a PC with no relay identity.
   */
  private sync(): Scope | null {
    let identity: RelayIdentity | undefined;
    try { identity = this.deps.identity(); } catch { return null; }
    if (!identity) return null;
    const binding = this.deps.binding();
    if (this.endpointOf?.key !== identity.public_key) this.endpointOf = { key: identity.public_key, endpoint: bytesToHex(importPublicKey(identity.public_key)) };
    const scope: Scope = { serverId: identity.server_id, bindId: binding?.id ?? null, account: binding?.account ?? null, list: binding?.list ?? null, endpoint: this.endpointOf.endpoint };
    if (!this.fileRead) {
      this.fileRead = true;
      this.serverId = scope.serverId;
      this.bindId = scope.bindId;
      this.takeFile(scope);
      return scope;
    }
    if (scope.serverId !== this.serverId) {
      // a reset relay identity is a new PC: nothing of the one before counts, and its file went with it
      this.serverId = scope.serverId;
      this.broken = null;
      this.endBinding(scope.bindId);
    } else if (scope.bindId !== this.bindId) this.endBinding(scope.bindId);
    return scope;
  }

  private bound(): Bound | null {
    const scope = this.sync();
    return scope !== null && scope.bindId !== null && scope.account !== null ? scope as Bound : null;
  }

  /** Whether `scope` is still the identity and binding the PC has: what was asked for another is dropped. */
  private live(scope: Bound): boolean {
    const now = this.sync();
    return !this.stopped && now !== null && now.serverId === scope.serverId && now.bindId === scope.bindId;
  }

  /** The binding the copy belonged to is gone (Revoke all, a reset relay identity, a removal): so is the pin. */
  private endBinding(bindId: string | null): void {
    this.bindId = bindId;
    this.want = null;
    this.copy = null;
    this.candidate = null;
    this.pendingJoin = null;
    this.lineProof = null;
    this.allowUnread = null;
    this.keptHeld = false;
    this.ready = Promise.resolve();
    this.differences.clear();
    this.lastVerdict = this.error = null;
    this.keysState = null;
    // the keys go with the relay identity, not with the binding: a PC that joins an account by its list has read them
    // before the binding stood, and may sign for the list with them from its first moment
    this.postedAt = this.postedUntil = this.askedAt = this.untilAt = this.wantedAt = this.savedAt = this.savedSeq = null;
    this.dirty = false;
    // the mark was the old binding's: takeFile reads the one of the binding the PC has now
    this.owed = null;
    this.mustRead = false;
  }

  private endpointOf: { readonly key: string; readonly endpoint: string } | null = null;

  /** The file as it is on disk at the start. One that does not read is kept and said: what becomes of it depends on whether the PC is pinned. */
  private takeFile(scope: Scope): void {
    // the mark first, and without the copy: what the last run denied stands whatever becomes of the copy
    this.owed = scope.list === null ? null : this.owedOnDisk(scope);
    this.mustRead = this.owed !== null && this.owed.removed.length > 0;
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.broken = `${ACCOUNT_LIST_FILE} cannot be read`;
      return;
    }
    const file = parseFile(text);
    if (file === null) { this.broken = `${ACCOUNT_LIST_FILE} cannot be read`; return; }
    // another relay identity's or binding's copy is not this PC's: the next save replaces it
    if (file.server_id !== scope.serverId || file.bind_id !== scope.bindId) return;
    this.want = file.want;
    const save = file.save;
    if (save === null) return;
    const mine = () => this.bindId === file.bind_id && this.serverId === file.server_id;
    this.ready = readSave(save).then((saved) => {
      if (!mine()) return;
      if (!saved.read) { this.broken = `${ACCOUNT_LIST_FILE} cannot be read (${saved.why})`; return; }
      // a copy of another list than the one the PC is pinned to is no copy of its list
      if (scope.list !== null && saved.copy.list !== scope.list) return;
      this.copy = saved.copy;
      // the hour the file holds: a decision that turns on a later one saves it first
      this.savedAt = saved.copy.seen_at;
      // The last run acted on something this copy does not hold: nobody is let in by it until the list was read
      // again, and the hour that run's clock showed counts, so a device's time that had passed stays passed
      this.savedSeq = saved.copy.state?.footing.seq ?? null;
      const owed = this.owed;
      if (owed !== null) {
        this.copy = withClock(saved.copy, owed.floor);
        // a removal the copy does not reach closes the list until a read reached it; one it reaches is refused by its key
        const seq = saved.copy.state?.footing.seq ?? -1;
        this.mustRead = owed.removed.some((row) => row.seq > seq);
        // the hour goes into the copy on disk before anything is decided by it: only then is a time that passed discharged
        if (scope.bindId !== null && scope.account !== null && owed.expired.length > 0) { if (!this.persist(scope as Bound)) this.unsaved = true; }
        this.settleOwed();
      }
      // another build wrote it: its entries were replayed, never dropped, and the copy is written back as this build
      // writes it. An update costs a pinned PC nothing it held
      if (saved.rebuilt && scope.bindId !== null && scope.account !== null) {
        console.info(`[account] ${ACCOUNT_LIST_FILE} was written by another build: its entries were read again`);
        this.persist(scope as Bound);
      }
    }, () => { if (mine()) this.broken = `${ACCOUNT_LIST_FILE} cannot be read`; });
  }

  /**
   * A pinned PC that holds no copy (its file is gone), or one made for other keys than it holds (its other folder's
   * old copy, beside the keys it took from that folder), starts one of the list it is pinned to, to be read again
   * from entry 0. Until that read shows the PC in the list, it lets no device of its account in.
   */
  private async ensureCopy(scope: Bound): Promise<void> {
    if (scope.list === null || this.problem !== null) return;
    const held = this.copy?.list === scope.list ? this.copy : null;
    // the copy of a PC that reads as it should is asked nothing more: its keys were read when it was made
    if (held !== null && this.held !== null && this.heldFor === scope.serverId && held.me.key === this.held.key && held.me.endpoint === scope.endpoint) return;
    const keys = await this.keysOf(scope);
    if (keys === null || !this.live(scope)) return;
    if (this.copy?.list === scope.list && this.copy.me.key === keys.key && this.copy.me.endpoint === scope.endpoint) return;
    const first = pinList(null, { account: scope.account, list: scope.list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
    // a copy read anew keeps the hour the mark holds: a time that had passed stays passed
    if (first.pinned) this.copy = this.owed === null ? first.copy : withClock(first.copy, this.owed.floor);
  }

  private async keysOf(scope: Scope): Promise<PcListKeys | null> {
    // work that waited when the follower stopped makes no keys
    if (this.stopped) return null;
    try {
      const keys = await this.deps.keys.keysFor(scope.serverId);
      this.keysState = "ready";
      this.held = keys;
      this.heldFor = scope.serverId;
      return keys;
    } catch (error) {
      if (!(error instanceof ListKeysError)) throw error;
      this.keysState = "unreadable";
      this.error = error.message;
      return null;
    }
  }

  private async follow(account: string, named: NamedList | null): Promise<void> {
    const scope = this.bound();
    if (this.stopped || scope === null || scope.account !== account) return;
    await this.ready;
    if (this.problem !== null) return;
    await this.ensureCopy(scope);
    this.error = null;
    // an account with no list, one the service names no list for, and a service that is away all leave a copy as it
    // is: no hint is never the word that the list is gone
    if (named === null) {
      this.lastVerdict = "none";
      if (this.copy === null) return;
      this.keep(heardHead(this.copy, null, this.seconds()).copy, scope, false);
      // a PC that holds a list still reads it, at its own pace: no word is not the word that nothing was written
      if (this.copy !== null && followStep(this.copy, this.seconds(), { event: "tick", asked_at: this.askedAt, busy: false }).do === "read") await this.read(scope);
      return;
    }
    const keys = await this.keysOf(scope);
    if (keys === null || !this.live(scope)) return;
    let copy = this.copy;
    // a copy of other keys than the PC has now, on a PC that is not pinned, is nobody's
    if (copy !== null && !this.isPinned && (copy.me.key !== keys.key || copy.me.endpoint !== scope.endpoint)) copy = null;
    // a list id the service named, of which the PC has verified no entry, is its word alone: the one it names now
    // takes its place. A list a person named here is not the service's to replace
    if (copy !== null && !this.isPinned && this.want === null && copy.state === null && copy.list !== named.id) copy = null;
    if (copy === null) {
      if (this.isPinned) return;
      // the list a person named here, and only for want of one the list the service names
      const first = pinList(null, { account, list: this.want ?? named.id, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
      if (!first.pinned) { this.lastVerdict = "not_my_list"; return; }
      copy = first.copy;
    }
    const heard = heardHead(copy, { list: named.id, head: named.head }, this.seconds());
    this.lastVerdict = heard.verdict;
    this.keep(heard.copy, scope, false);
    // each pull, a pinned PC gives its rows another turn: one a full notice list or a hold kept out comes in then
    if (this.isPinned) this.settle();
    // a list a person named is read whatever list the service names
    if (heard.verdict === "read" || (heard.verdict === "not_my_list" && (this.isPinned || this.want !== null))) await this.read(scope);
    if (this.live(scope) && this.copy !== null && standing(this.copy) === "waiting") await this.post(this.copy, keys, scope);
  }

  /** One read at a time: whoever asks while one runs waits for that one. */
  private readNow(): Promise<void> {
    this.reading ??= this.enqueue(async () => {
      const scope = this.bound();
      if (scope === null) return;
      await this.ready;
      await this.ensureCopy(scope);
      if (this.problem === null && this.copy !== null) await this.read(scope);
    }).then(() => undefined, () => undefined).finally(() => { this.reading = null; });
    return this.reading;
  }

  /** One read of the log, page after page, until the follower asks for no more. The copy is saved once, when it changed. */
  private async read(scope: Bound): Promise<void> {
    if (this.copy === null) return;
    this.askedAt = this.seconds();
    // the follower bounds a read by itself (FollowRead.left): what is left is asked at the next one
    let base: FollowerCopy = this.copy;
    let read: FollowRead | null = startRead(base, "service");
    // how often a read may begin again because a member's page moved the copy under it: each time the copy got further
    let restarts = 0;
    try {
      while (read !== null && this.live(scope)) {
        const asked: FollowRead = read;
        const answer = await this.deps.call("/v2/pc/list/log", { list: asked.list, ...(asked.after === null ? {} : { after: asked.after }) });
        // Each page reaches the copy the PC decides on, and what follows from it (a removal closes its sessions), before
        // the next request goes out: a service that answers the next one slowly holds nothing back that it already showed
        read = await this.apply(async () => {
          if (!this.live(scope) || this.copy === null) return null;
          // a member's page moved the copy while the request was out: the read begins again from where the PC stands now
          if (changed(base, this.copy)) {
            base = this.copy;
            return restarts++ < READ_RESTARTS_MAX ? startRead(base, "service") : null;
          }
          const held = this.copy;
          const result = await takePage(held, asked, answer as unknown as ListPage, this.seconds());
          if (!this.live(scope) || this.copy === null || changed(held, this.copy)) return null;
          this.lastVerdict = result.code === null ? result.verdict : `${result.verdict} ${result.code}`;
          this.keep(result.copy, scope, changed(held, result.copy));
          base = this.copy ?? result.copy;
          return result.read;
        });
      }
    } catch (error) {
      // a service that is away, or that serves this PC no list, is no word on the list: the copy stays as it is
      this.error = this.words(error);
      return;
    }
    // one whole read: the service answered to the end, and the PC stands at the head the service shows. A page the PC
    // refused, a tail the service withholds and a read that ran out of its requests are none
    if (this.live(scope) && this.lastVerdict === "caught_up") this.readWhole();
  }

  /**
   * The log read into `copy`, page after page: the copy as far as the pages took it. For a copy this PC does not
   * decide on yet (the list it is about to join): it keeps nothing and never throws.
   */
  private async readInto(copy: FollowerCopy): Promise<FollowerCopy> {
    this.askedAt = this.seconds();
    // the follower bounds a read by itself (FollowRead.left): what is left is asked at the next one
    let read: FollowRead | null = startRead(copy, "service");
    try {
      while (read !== null && !this.stopped) {
        const answer = await this.deps.call("/v2/pc/list/log", { list: read.list, ...(read.after === null ? {} : { after: read.after }) });
        const result = await takePage(copy, read, answer as unknown as ListPage, this.seconds());
        copy = result.copy;
        this.lastVerdict = result.code === null ? result.verdict : `${result.verdict} ${result.code}`;
        read = result.read;
      }
    } catch (error) {
      // a service that is away, or that serves this PC no list, is no word on the list: the copy stays as it is
      this.error = this.words(error);
    }
    return copy;
  }

  /** The second lock for a `pc` entry: this PC's keys and its card for this list, at the account service, for ten minutes. */
  private async post(copy: FollowerCopy, keys: PcListKeys, scope: Scope): Promise<void> {
    const now = this.deps.now();
    if (this.postedAt !== null && now - this.postedAt >= 0 && now - this.postedAt < LIST_POST_RENEW_MS) return;
    try {
      const card = await signCard({ key: keys.key, enc: keys.enc, list: copy.list, endpoint: scope.endpoint, invite: null }, keys.privateKey);
      // nothing is posted for an account the PC has left meanwhile, or once it stopped
      const still = this.sync();
      if (this.stopped || still === null || still.serverId !== scope.serverId || still.bindId !== scope.bindId) return;
      // a PC an invite's line named this list to posts that line's proof for this very card, at each renewal too
      const line = this.lineProof;
      const proved = line !== null && line.account === copy.account && line.card.list === copy.list && line.card.key === keys.key && line.card.enc === keys.enc && line.card.endpoint === scope.endpoint
        ? { invite: line.invite, invite_proof: line.proof } : {};
      const answer = await this.deps.call("/v2/pc/list/keys", { list: copy.list, key: keys.key, enc: keys.enc, card, ...proved });
      const { until } = answer;
      const ends = typeof until === "number" && Number.isSafeInteger(until) && until > this.seconds() && until - this.seconds() <= POST_UNTIL_MAX_SECONDS;
      this.postedUntil = ends ? until : null;
      // an answer that names no end ahead is no post the PC can count on: it is made again in a minute, not in four
      this.postedAt = ends ? now : now - LIST_POST_RENEW_MS + POST_RETRY_MS;
      if (!ends) this.error = "The account service did not say until when it holds this PC's keys";
    } catch (error) {
      this.postedUntil = null;
      this.error = this.words(error);
    }
  }

  /** Takes a copy as this PC's own: on disk first when it changed, then in memory, then what follows from it. */
  private keep(copy: FollowerCopy, scope: Bound, save: boolean): boolean {
    const was = this.copy?.list === copy.list ? this.copy : null;
    // the hour never goes back: a copy made from an older one keeps the latest hour this PC's clock showed
    const seen = was === null ? null : was.seen_at;
    this.copy = seen === null ? copy : withClock(copy, seen);
    this.reachedOwed();
    if (save) {
      // What a member signed is acted on whether or not the disk takes it: a removal is enforced from memory, and the
      // copy is offered to the disk again at the next tick. Each device this copy puts out goes into the mark first,
      // with the place of its removal: a PC that stops before the copy is on disk does not start again on the older one
      const put = this.isPinned ? newlyOut(was, copy) : [];
      if (put.length > 0) this.owe(scope, { removed: put });
      this.unsaved = !this.persist(scope);
      this.settle();
      this.settleOwed();
      return !this.unsaved;
    }
    // the latest hour the clock showed is kept too, so a clock set back over a restart lets no device in past its time
    if (copy.seen_at !== null && (this.savedAt === null || copy.seen_at - this.savedAt >= LIST_CLOCK_SAVE_SECONDS)) this.persist(scope);
    return true;
  }

  private persist(scope: Bound): boolean {
    // work that waited when the follower stopped writes nothing: another server may hold the folder by now
    if (this.stopped) return false;
    const file: ListFile = { v: 1, server_id: scope.serverId, bind_id: scope.bindId, want: this.want, save: this.copy === null ? null : writeSave(this.copy) };
    try { writePrivateState(this.path, file); } catch (error) {
      this.error = `${ACCOUNT_LIST_FILE} could not be written (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
      return false;
    }
    this.broken = null;
    this.savedAt = this.copy?.seen_at ?? null;
    this.savedSeq = this.copy?.state?.footing.seq ?? null;
    return true;
  }

  /**
   * What follows from the copy as it is now. A PC that a person named this list for pins it once the list holds the
   * PC. A pinned PC gives its rows to the store, and leaves its account when the list removed it. Never throws.
   */
  private settle(readmission?: Readmission): void {
    // work that waited in the queue when the follower stopped writes nothing: another server may hold the folder by now
    if (this.stopped) return;
    const scope = this.bound();
    const copy = this.copy;
    // a pinned PC acts on a copy of the list it is pinned to, and on no other
    if (scope === null || copy === null || this.problem !== null || (scope.list !== null && copy.list !== scope.list)) return;
    let pinning = false;
    if (!this.isPinned) {
      if (this.want !== copy.list || standing(copy) !== "in") return;
      // with the binding, on disk, before anything is done by it: from here on the PC is pinned whatever fails next
      try { if (!this.deps.pin(scope.bindId, copy.list)) return; } catch (error) {
        this.error = `The list could not be pinned (${error instanceof Error ? error.message : String(error)})`;
        return;
      }
      logAccess({ event: "account.list.pinned" });
      pinning = true;
      try { this.deps.repinned?.(); } catch { /* the commit below ends what is left of them */ }
    }
    // an alarm is kept with the pin, on disk: a copy that is lost and read again must not lift it. One the binding's
    // file did not take is offered to it again at the next tick, whatever becomes of the rows below
    let alarmKept = true;
    if (copy.alarm !== null && this.deps.binding()?.alarmed !== true) {
      try { alarmKept = this.deps.alarm?.(scope.bindId) !== false; } catch { alarmKept = false; }
    }
    if (!alarmKept) this.dirty = true;
    const now = this.seconds();
    // A device's time has passed: the hour that says so is on disk before anything is done by it. Also one that
    // passed while Ovis was stopped, so that a later start with the clock set back does not let the device in again
    const passed = passedUntil(copy, now);
    if (passed.length > 0) { this.clocked(); this.saveFloor(passed); }
    if (standing(copy) === "out") {
      // what the list put out before it put this PC out goes first: leaving keeps the pairings this PC made itself,
      // and a device the list removed must not stay in by one of them
      try { this.keepRemovals(copy); } catch (error) {
        this.dirty = true;
        this.denyOwed();
        this.error = `The list's removals could not be kept (${error instanceof Error ? error.message : String(error)})`;
        return;
      }
      this.leave(scope);
      return;
    }
    try {
      // what the list put out first, so that nothing the commit lets in stands beside a key that is out
      this.keepRemovals(copy);
      const rows = listCommit(copy, now);
      // nobody while the copy does not show whom the PC lets in (a lost alarm, a removal it has not read again), and never a key the mark names
      const closed = this.alarmLost || this.mustRead;
      this.deps.commit?.({ ...rows, devices: rows.devices.map((row) => (closed || this.owedKey(row.key) ? { ...row, eligible: false } : row)) }, readmission, pinning || this.freshPin ? () => true : (key) => this.allowing.has(key));
      this.dirty = !alarmKept;
      this.freshPin = false;
    } catch (error) {
      this.dirty = true;
      this.denyOwed();
      this.error = `The list's devices could not be written (${error instanceof Error ? error.message : String(error)})`;
    }
    this.untilAt = nextUntil(copy, now);
    this.armUntil(now);
    try { this.deps.recheck?.(); } catch { /* the rows say it again at their next use */ }
  }

  /**
   * A timer for the next second at which a device the list lets in stops being let in. It runs by itself: a session
   * open at that second closes then, not at the next tick and not behind a read of the account service.
   */
  private armUntil(now: number): void {
    if (this.untilTimer) clearTimeout(this.untilTimer);
    this.untilTimer = undefined;
    if (this.untilAt === null || this.stopped) return;
    // by the PC's own clock in milliseconds, to the start of that second; a timer cannot wait longer than 2^31-1 ms
    const wait = Math.min(Math.max(0, this.untilAt * 1000 - this.deps.now()), 2 ** 31 - 1);
    this.untilTimer = setTimeout(() => {
      this.untilTimer = undefined;
      if (this.stopped || !this.pinned()) return;
      if (this.untilAt !== null && this.seconds() >= this.untilAt) this.settle();
      else this.armUntil(this.seconds());
    }, wait);
    this.untilTimer.unref?.();
  }

  /** Every device the list put out is kept as removed by this PC itself, once a start; one that could not be kept is tried again. */
  private keepRemovals(copy: FollowerCopy): void {
    if (copy.state === null || this.deps.removed === undefined) return;
    // From the entries the PC verified, not from the view of them: a PC that then stopped at an entry its Ovis is too
    // old to place shows nobody (listView), and what the list removed before that entry is removed all the same
    for (const [key, row] of Object.entries(copy.state.signers)) {
      const text = row.as !== "device" || row.ended === null ? undefined : copy.entries[row.ended];
      if (text === undefined) continue;
      const entry = entryFromText(text);
      const id = entryHash(entry.body);
      if (this.applied.has(id + key)) continue;
      this.deps.removed(key, { id, at: readBody(entry.body).issued_at });
      this.applied.add(id + key);
      this.kept.add(key);
    }
  }

  /** The list removed this PC: it leaves its account, and the PC's account state keeps that it was removed, so it joins that account again on no path. */
  private leave(scope: Bound): void {
    try {
      this.dirty = this.deps.leave?.(scope.serverId) === false;
      if (!this.dirty) logAccess({ event: "account.list.removed" });
    } catch (error) {
      this.dirty = true;
      this.error = `This PC could not leave its account (${error instanceof Error ? error.message : String(error)})`;
    }
  }
}

/** Where the copy's list let this very device in, with that encryption key, when it is still in; null otherwise. */
function placeOf(copy: FollowerCopy, device: AllowedDevice): { id: string; seq: number; hash: string } | null {
  const { state } = copy;
  if (state === null) return null;
  const row = Object.hasOwn(state.signers, device.key) ? state.signers[device.key] : undefined;
  const text = row === undefined ? undefined : copy.entries[row.seq];
  if (row === undefined || text === undefined || row.as !== "device" || row.ended !== null || state.devices[device.key]?.enc !== device.enc) return null;
  return { id: copy.list, seq: row.seq, hash: entryHash(entryFromText(text).body) };
}

/**
 * Whether `first`, the first entry of a page from the place `after`, follows an entry `copy` holds: its place and its
 * `prev` are those of the entry the copy holds at `after` (or, from the start, it is the copy's own first entry). Read
 * from the entries' bodies alone, with no signature checked, so a page that cannot matter costs nearly nothing. An
 * empty page follows.
 */
function followsCopy(copy: FollowerCopy, first: string | undefined, after: number | null): boolean {
  if (first === undefined) return true;
  try {
    if (after === null) return copy.entries.length > 0 && entryHash(entryFromText(first).body) === entryHash(entryFromText(copy.entries[0]!).body);
    const before = copy.entries[after];
    if (before === undefined) return false;
    const body = readBody(entryFromText(first).body);
    return body.seq === after + 1 && body.prev === entryHash(entryFromText(before).body);
  } catch { return false; }
}

/** The key that signed the entry which put the PC this copy is of into the list: the member that added it, or the invite it joined with; null when it is not in. */
function addedBy(copy: FollowerCopy): string | null {
  const { state, me } = copy;
  const row = state === null || me.endpoint === null || !Object.hasOwn(state.pcs, me.endpoint) ? undefined : state.pcs[me.endpoint];
  if (state === null || row === undefined || row.removed !== null) return null;
  if (row.how === "joined") return row.invite;
  return row.key !== null && Object.hasOwn(state.signers, row.key) ? state.signers[row.key]!.by : null;
}

/**
 * Why the member this copy is of signs no Allow, or null: it is in, no alarm stands, its key signs with full power,
 * and it has read everything the members wrote (`behind`: one of them wrote what this Ovis is too old to read, and a
 * member that is behind signs nobody in).
 */
function cannotAllow(copy: FollowerCopy): AllowRefusal | null {
  const { state } = copy;
  if (state === null) return "unavailable";
  if (state.needs_replay !== undefined || standing(copy) === "stopped") return "stopped";
  if (standing(copy) !== "in") return "not_signer";
  if (copy.alarm !== null) return "alarm";
  if (signerPower(state, copy.me.key) !== "full") return "not_signer";
  return state.behind === null ? null : "behind";
}

/** The devices the list still holds whose time has passed at `now`, each with that time. */
function passedUntil(copy: FollowerCopy, now: number): { readonly key: string; readonly until: number }[] {
  if (copy.state === null) return [];
  return listView(copy.state).devices.flatMap((row) => (row.ended === null && row.until !== null && row.until <= now ? [{ key: row.key, until: row.until }] : []));
}

/** The devices `after` shows out that `before` did not (all of them when there was no copy before), each with the place of the entry that put it out. */
function newlyOut(before: FollowerCopy | null, after: FollowerCopy): { readonly key: string; readonly seq: number }[] {
  const state = after.state;
  if (state === null) return [];
  const was = before?.state?.signers ?? {};
  return Object.entries(state.signers).flatMap(([key, row]) =>
    row.as === "device" && row.ended !== null && !(Object.hasOwn(was, key) && was[key]!.ended !== null) ? [{ key, seq: row.ended }] : []);
}

function changed(before: FollowerCopy, after: FollowerCopy): boolean {
  return after.entries !== before.entries || after.state !== before.state || after.alarm !== before.alarm || after.stop !== before.stop;
}

/**
 * What a pinned PC's account rows are made from: every device the list lets in now, and every device it put out. A
 * device's place is that of the entry that let it in, so an older device is one the list let in before.
 */
export function listCommit(copy: FollowerCopy, now: number): ListCommit {
  const state = copy.state;
  const devices: SnapshotDevice[] = [];
  const removed: SnapshotRemoved[] = [];
  const admitted = new Set(admittedDevices(copy, now).map((device) => device.key));
  for (const row of state === null ? [] : listView(state).devices) {
    const no = row.seq + 1;
    if (row.ended !== null) removed.push({ key: row.key, no });
    else devices.push({ key: row.key, no, eligible: admitted.has(row.key), label: LIST_DEVICE_LABEL });
  }
  return { account: copy.account, snapshot: copy.list.slice(0, 32), version: (state?.footing.seq ?? 0) + 1, devices, removed };
}

/** Removes the file: a reset relay identity is a new PC, which follows no list yet. Never throws. */
export function forgetList(stateDir: string): void {
  for (const file of [ACCOUNT_LIST_FILE, ACCOUNT_LIST_OWED_FILE, ACCOUNT_LIST_ALLOW_FILE]) {
    try { rmSync(join(stateDir, file), { force: true }); }
    catch (error) { console.error(`[account] ${file} could not be removed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`); }
  }
}

function parseAllow(value: unknown): { readonly serverId: string; readonly bindId: string; readonly kept: KeptAllow } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { v, server_id, bind_id, list, seq, on_head, key, enc, entries, wraps, ...rest } = value as Record<string, unknown>;
  const text = (field: unknown): field is string => typeof field === "string" && field !== "";
  if (v !== 1 || Object.keys(rest).length > 0 || typeof server_id !== "string" || !SERVER_ID_PATTERN.test(server_id) || typeof bind_id !== "string" || !BIND_ID.test(bind_id)
    || typeof list !== "string" || !isListHash(list) || !Number.isSafeInteger(seq) || (seq as number) < 0 || !text(on_head) || !text(key) || !text(enc)
    || !Array.isArray(entries) || entries.length === 0 || !entries.every(text) || !Array.isArray(wraps)) return null;
  const kept: { epoch: number; member: string; wrap: string }[] = [];
  for (const wrap of wraps as unknown[]) {
    if (typeof wrap !== "object" || wrap === null) return null;
    const { epoch, member, wrap: bytes } = wrap as Record<string, unknown>;
    if (!Number.isSafeInteger(epoch) || !text(member) || !text(bytes)) return null;
    kept.push({ epoch: epoch as number, member, wrap: bytes });
  }
  return { serverId: server_id, bindId: bind_id, kept: { list, seq: seq as number, onHead: on_head, key, enc, entries: entries as string[], wraps: kept } };
}

function parseFile(text: string): ListFile | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { v, server_id, bind_id, save, want = null, ...rest } = value as Record<string, unknown>;
  if (v !== 1 || Object.keys(rest).length > 0 || typeof server_id !== "string" || !SERVER_ID_PATTERN.test(server_id) || typeof bind_id !== "string" || !BIND_ID.test(bind_id)
    || !(save === null || typeof save === "string") || !(want === null || (typeof want === "string" && isListHash(want)))) return null;
  return { v: 1, server_id, bind_id, want, save };
}
