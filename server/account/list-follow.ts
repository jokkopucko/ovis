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
import { openSealed, openWrap, sealFields, walkBack, wrapEpochKey, wrapFromText, wrapToText, type EpochKey, type EpochOpening } from "../../shared/account-list-seal.ts";
import { signerPower, type ListPlace } from "../../shared/account-list-signers.ts";
import {
  admitsSession, admittedDevices, compareHeads, followStep, gossipHead, heardHead, nextUntil, pinList, readSave, servePage, shownPcs, standing, startRead, takePage, withClock, writeSave, PC_BUSY_READ_SECONDS, READ_PAGES_MAX,
  type FollowerCopy, type FollowRead, type FollowVerdict, type ListHead, type ListPage, type PeerAsk, type SessionRefusal, type Standing,
} from "../../shared/account-list-follower.ts";
import { inviteRefusal, isListLabel, joinEntry, listClock, listView, ListKindError, ListWriteError, namesFields, readKind, readNames, sealEpoch, signCard, signListEntry, type InviteCode, type ListRole, type ListState, type Sealed } from "../../shared/account-list.ts";
import { heirOf, heldNaming, heldOut, heldVouches, pinVerdict, standsFor, type LetIn, type PinRefusal, type SignedNaming, type SignedVouch } from "../../shared/account-list-migrate.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import type { SnapshotDevice, SnapshotRemoved } from "../../shared/account-snapshot.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { fromBase64Url } from "../../shared/relay-pair-sas.ts";
import { SERVER_ID_PATTERN } from "../../shared/relay-offer.ts";
import { logAccess } from "../connection-diagnostics.ts";
import { preparePrivateState, syncDirectory, writePrivateState } from "../private-state.ts";
import { verifyRelayProof } from "../relay/auth-proof.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { ListCommit } from "./account-device-state.ts";
import { ListKeysError, type ListKeyStore, type PcListKeys } from "./list-keys.ts";
import { ACCOUNT_LIST_VOUCHES_FILE, ListVouches } from "./list-vouches.ts";
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
/**
 * The longest one try waits for a PC that spent its list calls (429 `rate_limited`): the service counts them by the
 * minute, so the next minute takes the entry. Under LIST_ALLOW_MS.
 */
const LIST_ALLOW_LIMITED_MAX_MS = 60_000;
/** How long after a round of naming the account service could not answer the next one may start (nameDevices). */
const NAMES_RETRY_MS = 60_000;
/** The name of a device the list lets in, while this PC holds no key to the list's names. */
export const LIST_DEVICE_LABEL = "Device";
/** The name a PC added over SSH is sealed under when the one it gave is no name. */
const LIST_PC_LABEL = "PC";

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
 * The read this PC keeps for a member and asks it for, as it states it: a read from its own top asks from its footing,
 * the last entry a member signed in its copy (an entry no member signed above it, which the account service showed it,
 * is not counted as held, so a member hands the entries that take its place). A read that goes on inside another
 * history (`carry`) keeps its place, wherever that lies. What is kept and what is asked are one place, so the page
 * that answers it is taken as its continuation.
 */
function footingRead(copy: FollowerCopy, read: FollowRead): FollowRead {
  const footing = copy.state?.footing.seq ?? null;
  return read.carry !== null || read.after === null || footing === null || read.after <= footing ? read : { ...read, after: footing };
}

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

/**
 * What `GET /api/account/status` says of the list on a pinned PC (`ovis status --json` reads it): the list id, where the
 * PC stands in it, and ListStatus.reason. `needs_keys`: the PC came into the list as its account moved and holds no key
 * of its own in it to sign with; `ovis add` on it gives it one by the number.
 */
export interface ListSummary { readonly pinned_list: string; readonly standing: Standing | null; readonly reason: string | null; readonly needs_keys?: true }

/**
 * Why this PC did not let a device into its list. `not_pinned`, `not_signer` (it joined by an invite, or its key no
 * longer signs), `needs_keys` (it came in as its account moved, and holds no key of its own in the list yet: `ovis add`
 * here gives it one), `alarm`, `stopped`, `unavailable` (its keys or its copy): the PC cannot allow anyone now.
 * `held_here`: this PC itself keeps that key out. `not_written`: the entry would not count (a card that is not that
 * key's for this list, a key that was a signer before). `refused`: the account service refused it (no claim of the
 * key by a sign-in of the account, a budget). `list_stopped`: the service changes this list for nobody now.
 * `service_away`, `head_lost`: it could not be placed in LIST_ALLOW_TRIES tries. `not_in_list`: nobody at this PC
 * decided, and no entry lets the device in.
 */
export type AllowRefusal = "not_pinned" | "not_signer" | "needs_keys" | "alarm" | "stopped" | "behind" | "unavailable" | "held_here" | "not_written" | "refused" | "not_claimed" | "list_stopped" | "service_away" | "head_lost" | "not_in_list";

/** The device a PC is asked to let into its list: its member key, its encryption key, its card for the list, and the name it gave. */
export interface AllowedDevice { readonly key: string; readonly enc: string; readonly card: string; readonly label: string }

/**
 * A PC a person at this PC adds to the list over SSH (ssh-add-list.ts): its list key, its encryption key and its card
 * for this list as it handed them over that channel, its relay key as this PC read it there before, and its name.
 */
export interface AddedPc { readonly key: string; readonly enc: string; readonly card: string; readonly endpoint: string; readonly label: string }

export type AllowOutcome = { readonly allowed: { readonly id: string; readonly seq: number; readonly hash: string } } | { readonly refused: AllowRefusal; readonly detail: string | null };

/** What one entry this PC signs lets into its list, for the loop that places it (allow): a device by an Allow, or a PC added over SSH. */
interface Newcomer {
  readonly key: string;
  readonly enc: string;
  /** a device: what this PC itself holds against its key keeps it out (deps.mayAdmit) */
  readonly device: boolean;
  /** where the copy's list let this very newcomer in, while it is in */
  placeOf(copy: FollowerCopy): { id: string; seq: number; hash: string } | null;
  /** its entry on the copy's footing, with the wrap of the names' key to it where this PC holds that key */
  write(copy: FollowerCopy, state: ListState, keys: PcListKeys): Promise<{ entries: string[]; wraps: { epoch: number; member: string; wrap: string }[] }>;
}

/**
 * `other_account`: this PC is in another account. `other_adder`: the list holds this PC, by an entry of another key than
 * the one the person confirmed. `other_keys`: that entry names another encryption key than this PC's own.
 */
/** `ended`: what the join was for ended before the binding was written (an add's time, or the person's No). */
export type JoinRefusal = WantRefusal | "other_account" | "other_adder" | "other_keys" | "line_unproven" | "invite_unknown" | "ended";

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

/**
 * Why a PC does not follow the list a device named in its session (nameList): pinVerdict's refusals, and
 * `naming_invalid` (the naming is not that key's for this PC, this account and this very session), `named_here` (a
 * person at this PC named another list), `not_read` (the PC could not read that list to its head from the account
 * service just now), `lists_full` (this PC keeps vouches for as many lists as it may), `unavailable` (its keys, its
 * record or its files cannot be used).
 */
export type NameRefusal = PinRefusal | "naming_invalid" | "named_here" | "not_read" | "lists_full" | "unavailable";
/** `wait`: how many seconds until the PC may follow, by its own clock, where it only waits; null otherwise. */
export type NameOutcome = { readonly pinned: true; readonly list: string } | { readonly pinned: false; readonly why: NameRefusal; readonly wait: number | null };
/** How often a PC reads the log of one list a device names to it, at most. */
export const NAMED_READ_MS = 30_000;
/** How long after its answer to a naming the PC pins the list: the answer is out by then, and the session it went back over ends. */
const NAMED_PIN_DELAY_MS = 250;

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
   * What this PC holds of its account's devices as a device names a list to it (witness.ts): the keys its account's
   * rows let in to drive now and for how long (already multiplied by `scale`), and the keys it holds a removal against.
   * Null when it cannot say.
   */
  witness?(): { readonly account: string; readonly rows: readonly LetIn[]; readonly removed: readonly string[]; readonly scale: number } | null;
  /**
   * Whether this PC holds a removal of its own against `key`: a person's Revoke here, a signed removal or block it
   * applied. A pinned PC keeps the device of such a key out by whichever key the list holds it by (heldOut).
   */
  holdsRemoval?(key: string): boolean;
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
  /**
   * The names of the list's devices this PC opened, by key, for the list they are of: what its rows are named by
   * (listCommit). `tried`: the entries decided, opened or not; one that does not open is not asked again.
   * `unwrapped`: those whose epoch this PC held no wrap of when asked (a PC just added gets its wrap a moment after its
   * first round), asked again after a later read (`unwrappedAt`, reads) and NAMES_RETRY_MS on (`unwrappedUntil`).
   */
  private deviceNames: { readonly list: string; readonly byKey: Map<string, string>; readonly tried: Set<number>; unwrapped: Set<number>; unwrappedAt: number; unwrappedUntil: number } | null = null;
  /** The reads of the log taken so far (read): what an entry with no wrap yet waits for before it is asked again. */
  private reads = 0;
  /** The round of naming under way (nameDevices), or the last one, over: one at a time. */
  private naming: Promise<void> = Promise.resolve();
  private namingNow = false;
  /** No round of naming starts before this time (deps.now) after one the account service could not answer. */
  private namesRetryAt = 0;
  /** The list a person at this PC confirmed for an account the PC is not in yet, as far as it has read it. In memory only. */
  private candidate: { readonly account: string; readonly copy: FollowerCopy } | null = null;
  /** The PC has just joined by its list: the devices the list holds come in with no join hold, as at any pin. */
  private freshPin = false;
  /** A device named a list this PC follows from now on, and the pin waits for the next settle: the answer goes out first. */
  private pinDue = false;
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
  /**
   * The keys the account service's last whole snapshot of this run let in, or null before one: a pinned PC lets a key
   * that a `carried` entry named, and that never handed its place on, in only while the snapshot names it too.
   */
  private snapshotNames: ReadonlySet<string> | null = null;
  /** The vouches devices handed this PC with their namings, per list (list-vouches.ts). */
  private readonly vouches: ListVouches;
  /** The last read of each list a device named here, by the clock that only moves forward: one a NAMED_READ_MS. */
  private readonly namedReads = new Map<string, { readonly at: number; readonly read: { readonly copy: FollowerCopy; readonly links: readonly HeldLink[] } | null }>();
  private readonly differences = new Set<string>();
  private readonly ids = new WeakMap<FollowerCopy, Map<string, string>>();
  private turn: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly deps: ListFollowDeps) {
    this.path = join(deps.stateDir, ACCOUNT_LIST_FILE);
    this.vouches = new ListVouches(deps.stateDir);
  }

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

  /** Everything asked of the list so far has been done, the naming of its rows (nameDevices) too. */
  async settled(): Promise<void> {
    for (let turn: Promise<unknown> | null = null, page: Promise<unknown> | null = null, names: Promise<unknown> | null = null;
      turn !== this.turn || page !== this.applying || names !== this.naming;) {
      turn = this.turn;
      page = this.applying;
      names = this.naming;
      await turn;
      await page;
      await names;
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
    if (copy === null || this.alarmLost || this.mustRead || this.owedKey(key) || this.keptOut(copy, true)(key)) return null;
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
   * The devices of the copy a pinned PC keeps out by a rule of its own, which the list does not make: one it holds a
   * removal against by any key the device has been in the list by, or by a sign-in key that vouched for it (heldOut);
   * and a key a `carried` entry named that never handed its place on, while the account service's last whole snapshot
   * of this run does not name it too. That one stays out until the snapshot names it again: local, and undone by the
   * same word, as nobody signs a removal on the service's word. Before the first whole snapshot of this run such a key
   * waits: no sign-in (`signIn`), and its row stays as it is, so the read that names it brings it back as it was.
   */
  private keptOut(copy: FollowerCopy, signIn: boolean): (key: string) => boolean {
    const state = copy.state;
    if (state === null || state.needs_replay !== undefined) return () => false;
    const vouched = this.vouchedFor(copy.list);
    const holds = this.deps.holdsRemoval;
    const removed = holds === undefined ? [] : [...new Set([...Object.keys(state.signers), ...vouched.map((vouch) => vouch.device)])].filter((key) => holds(key));
    const alone = new Set(carriedAlone(state));
    const names = this.snapshotNames;
    const gated = (key: string): boolean => alone.has(key) && (names === null ? signIn : !names.has(key));
    return (key) => gated(key) || (removed.length > 0 && heldOut(state, { removed, vouched }, key));
  }

  /** The vouches this PC holds for the list `list` that hold: a sign-in key's word, with the member key's, that the two are one device's. */
  private vouchedFor(list: string): readonly { readonly key: string; readonly device: string }[] {
    const scope = this.bound();
    return scope === null ? [] : this.vouches.of({ serverId: scope.serverId, bindId: scope.bindId }, list);
  }

  /** The list this PC is pinned to, or null: what its WELCOME tells a client that knows of lists. */
  pinnedList(): string | null {
    const scope = this.sync();
    return scope !== null && this.pinned() ? scope.list : null;
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

  /** Whether the PC at the relay key `endpoint` is in `list`, the one this PC is pinned to, once its copy was read again from the account service. */
  async holdsPcRead(endpoint: string, list: string): Promise<boolean> {
    await this.readNow();
    return this.copy?.list === list && this.status().pinned_list === list && this.holdsPc(endpoint);
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
    return { pinned_list: scope.list, standing: this.copy === null ? null : standing(this.copy), reason: this.reason(this.copy), ...(this.copy !== null && this.keyless(this.copy) ? { needs_keys: true as const } : {}) };
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
    const own = ownPcRow(copy);
    // a PC with no key of its own in a list it read to its head: no read gives it one (it came to follow the list as its account moved, and lost its copy since)
    if (stands === "waiting" && copy.state !== null && copy.read_at !== null && (own === null || own.key === null)) return "This PC follows your account's list, which holds no key of this PC's own, so it lets no device of your account in. Run `ovis add` on this PC and compare the number with a device of your account.";
    if (stands === "waiting") return "This PC is reading your account's list again from its start, and lets no device of your account in until that read shows this PC in the list.";
    if (this.allowUnread !== null) return `This PC cannot read its record of an entry it signed (${ACCOUNT_LIST_ALLOW_FILE}), so it lets no new device into your account's list until the list has moved on. It then removes that file by itself.`;
    if (this.keptHeld) {
      const until = new Date(Date.now() - this.keptFor() + LIST_KEPT_HELD_MS).toISOString();
      return `A device this PC lets into your account's list waits behind an entry this PC signed earlier for a device it has since held back, until ${until}. That entry is not sent; declining that device's join on this PC ends the wait at once.`;
    }
    if (copy.pin.how === "migrated" && own !== null && own.key !== null && own.key !== copy.me.key) return "Your account's list holds another key for this PC, so it lets your account's devices in but cannot let a new one in. Remove this PC from your account and add it again, or run `ovis add` on this PC after its relay identity is reset.";
    if (copy.pin.how === "migrated" && own?.key === copy.me.key && !this.keysTaken(copy)) return "Your account's list holds this PC's keys by an entry of a device that did not ask this PC for them, so it lets your account's devices in but cannot let a new one in. Run `ovis add` on this PC and compare the number with the device that added this PC to the list.";
    if (copy.pin.how === "migrated" && stands === "in" && (own === null || own.key === null)) return "This PC came into your account's list as your account moved, with no key of its own in it yet, so it lets your account's devices in but cannot let a new one in. Run `ovis add` on this PC and compare the number with a device of your account.";
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
   * A device of this PC's account names its list in its own session (POST /api/account/list/name): a PC that was in
   * its account before the account had a list follows that list only so (docs/account-list.md, "An account that was in
   * use"). `session` is the key the session signed in with (AUTH), `naming` what the device signed for this PC, this
   * account and that very key, `vouches` the links it hands with it. The PC reads that list's log with its own proof,
   * into a copy it does not decide by, and asks pinVerdict with what it holds of its account's devices: the session's
   * key is one it has let in through the account for a day and is the naming device's own, and the device that started
   * the list is known here too. On a yes it pins the list as one it follows by how it came (`migrated`), and lets its
   * account's devices in by it alone from then on. Nothing else here makes it pin, and a no changes nothing: the PC goes
   * on as before and is asked again at the next naming. The vouches that hold are kept for that list.
   */
  nameList(given: { readonly session: string; readonly naming: SignedNaming; readonly vouches: readonly SignedVouch[] }): Promise<NameOutcome> {
    return this.enqueue(async (): Promise<NameOutcome> => {
      const no = (why: NameRefusal, wait: number | null = null): NameOutcome => ({ pinned: false, why, wait });
      const scope = this.bound();
      if (scope === null) return no("unavailable");
      await this.ready;
      // a PC that follows a list says which (W2 as ruled): the device compares it with its own
      if (this.isPinned && scope.list !== null) return { pinned: true, list: scope.list };
      if (this.problem !== null || this.removedFrom(scope.account)) return no("unavailable");
      const naming = await heldNaming(scope.account, scope.endpoint, given.session, given.naming);
      if (naming === null) return no("naming_invalid");
      if (this.want !== null && this.want !== naming.list) return no("named_here");
      const keys = await this.keysOf(scope);
      if (keys === null || !this.live(scope)) return no("unavailable");
      const named = await this.namedRead(scope, keys, naming.list);
      if (!this.live(scope)) return no("unavailable");
      const read = named?.copy ?? null;
      const state = read?.state ?? null;
      if (named === null || read === null || state === null) return no("not_read");
      const witness = this.deps.witness?.() ?? null;
      if (witness === null || witness.account !== scope.account) return no("unavailable");
      const holds = this.deps.holdsRemoval;
      // The links this device hands, and every link the account service keeps for the list, that say something here: one
      // between keys made up a moment ago takes no place. Those of a list of this account are kept, whatever comes of this
      // naming, since the next one may need them, and count in this one whether kept or not
      const handed = state.account !== scope.account ? [] : this.linksThatCount(state, [...await heldVouches(scope.account, naming.list, given.vouches), ...named.links], witness);
      if (state.account === scope.account) {
        let kept: "kept" | "full";
        const held = (device: string): boolean => witness.removed.includes(device) || holds?.(device) === true;
        try { kept = this.vouches.keep({ serverId: scope.serverId, bindId: scope.bindId }, naming.list, handed, held); } catch { return no("unavailable"); }
        // a pin never rests on a link this PC would not keep
        if (kept === "full") return no("lists_full");
      }
      const held = this.vouchedFor(naming.list);
      const vouched = [...held, ...handed.filter((vouch) => !held.some((one) => one.key === vouch.key && one.device === vouch.device))];
      const removed = [...new Set([...witness.removed, ...[...Object.keys(state.signers), ...vouched.map((vouch) => vouch.device), naming.session].filter((key) => holds?.(key) === true)])];
      const verdict = pinVerdict(state, naming, { account: scope.account, rows: witness.rows, removed, vouched });
      // a wait is told in seconds of this PC's own clock: on a staging run the record's durations were multiplied
      if (!verdict.pin) return no(verdict.why, verdict.wait === null ? null : Math.ceil(verdict.wait / Math.max(1, witness.scale)));
      const first = pinList(null, { account: scope.account, list: naming.list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "migrated", admitted: verdict.admitted } });
      if (!first.pinned) return no("unavailable");
      const copy = await copied(first.copy, read, this.seconds());
      if (standing(copy) !== "in" || !this.live(scope) || this.isPinned) return no("not_read");
      const before = { want: this.want, copy: this.copy, wantedAt: this.wantedAt };
      this.want = naming.list;
      this.wantedAt = this.deps.now();
      this.copy = copy;
      if (!this.persist(scope)) {
        ({ want: this.want, copy: this.copy, wantedAt: this.wantedAt } = before);
        return no("unavailable");
      }
      // The copy that stands in the list and the list it is for are on disk, so the pin follows at the next settle,
      // after a restart too. Not in this turn: a pin ends every session of the account's rows (`auth_changed`), and the
      // session this answer goes back over is one of them. So it is made once the answer is out
      this.pinDue = true;
      const due = setTimeout(() => { if (this.pinDue && !this.stopped) void this.enqueue(async () => { await this.ready; this.settle(); }); }, NAMED_PIN_DELAY_MS);
      due.unref?.();
      // the PC follows this list: what it kept for any other goes
      try { this.vouches.keepOnly({ serverId: scope.serverId, bindId: scope.bindId }, naming.list); } catch { /* kept beside it, and never read */ }
      return { pinned: true, list: naming.list };
    });
  }

  /**
   * The list `list` read to its head with this PC's own proof, into a copy this PC does not decide by: the shadow it
   * holds of that list read on, or a new one. At most one read a list each NAMED_READ_MS; null when no read reached the
   * head the account service shows.
   */
  private async namedRead(scope: Bound, keys: PcListKeys, list: string): Promise<{ readonly copy: FollowerCopy; readonly links: readonly HeldLink[] } | null> {
    const now = this.deps.mono?.() ?? performance.now();
    const last = this.namedReads.get(list);
    if (last !== undefined && now - last.at >= 0 && now - last.at < NAMED_READ_MS) return last.read;
    let base = !this.isPinned && this.copy?.list === list && this.copy.me.key === keys.key && this.copy.me.endpoint === scope.endpoint ? this.copy : null;
    if (base === null) {
      const first = pinList(null, { account: scope.account, list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
      if (!first.pinned) return null;
      base = first.copy;
    }
    // what the account service answers this read, and nothing older, says whether it reached the head
    this.lastVerdict = null;
    const copy = await this.readInto(base);
    // and every link the account service keeps for it: no pin without them (the lead's ruling M2)
    const links = this.lastVerdict === "caught_up" ? await this.serviceLinks(scope.account, list) : null;
    const whole = links === null ? null : { copy, links };
    this.namedReads.delete(list);
    this.namedReads.set(list, { at: now, read: whole });
    while (this.namedReads.size > VOUCH_READS_MAX) this.namedReads.delete(this.namedReads.keys().next().value!);
    return whole;
  }

  /**
   * Every link of the list's members to the keys their sign-ins registered that the account service keeps (POST
   * /v2/pc/list/links), page after page, each checked here by its two signatures (heldVouches): the service can withhold
   * one, never forge one. Null when a page could not be read or does not read as one.
   */
  private async serviceLinks(account: string, list: string): Promise<HeldLink[] | null> {
    const held: HeldLink[] = [];
    let after: number | null = null;
    for (let pages = 0; pages < READ_PAGES_MAX && !this.stopped; pages++) {
      let answer: Record<string, unknown>;
      try { answer = await this.deps.call("/v2/pc/list/links", { list, ...(after === null ? {} : { after }) }); } catch (error) { this.error = this.words(error); return null; }
      const { links, more } = answer;
      if (answer.list !== list || !Array.isArray(links) || typeof more !== "boolean") return null;
      const signed = (links as unknown[]).flatMap((one) => {
        const { seq, key, device, link } = (typeof one === "object" && one !== null ? one : {}) as { seq?: unknown; key?: unknown; device?: unknown; link?: unknown };
        return Number.isSafeInteger(seq) && typeof key === "string" && typeof device === "string" && typeof link === "object" && link !== null ? [{ seq: seq as number, vouch: { key, device, link: link as SignedVouch["link"] } }] : [];
      });
      if (signed.length !== links.length) return null;
      held.push(...await heldVouches(account, list, signed.map((one) => one.vouch)));
      if (!more) return held;
      const last = signed.at(-1)?.seq;
      if (last === undefined || (after !== null && last <= after)) return null;
      after = last;
    }
    return null;
  }

  /**
   * The links that say something at this PC (the lead's ruling M1): between a device of the list and a key this PC lets
   * in through its account or holds a removal against. Any other takes no place and counts for nothing.
   */
  private linksThatCount(state: ListState, links: readonly HeldLink[], witness: { readonly rows: readonly LetIn[]; readonly removed: readonly string[] }): HeldLink[] {
    const letIn = new Set(witness.rows.map((row) => row.key));
    const holds = this.deps.holdsRemoval;
    return links.filter((link) => Object.hasOwn(state.signers, link.key) && state.signers[link.key]!.as === "device"
      && (letIn.has(link.device) || witness.removed.includes(link.device) || holds?.(link.device) === true));
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
        // A PC pinned with no key of its own in its list, or one that came to follow it as its account moved: it is added
        // by the entry that adds its own key, signed by the adder a person at this PC confirmed (B7), and by no other
        let held = this.copy;
        if (by !== null && (held.pin.how === "migrated" || ownPcRow(held)?.key !== held.me.key)) {
          // each ask reads once, as for a PC in no account
          if (ownPcRow(held)?.key !== held.me.key) { await this.read(read.bound); held = this.copy ?? held; }
          if (ownPcRow(held)?.key !== held.me.key) return { waiting: standing(held) };
          if (addedBy(held) !== by) return { refused: "other_adder" };
          if (held.pin.how === "migrated" && !this.keysTaken(held)) {
            try { this.vouches.keepCardBy({ serverId: read.bound.serverId, bindId: read.bound.bindId }, held.list, by); } catch { return { refused: "unavailable" }; }
          }
        }
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
      // the entry a key the act named signed carries exactly the keys this PC posted for it, at its own relay key
      if (by !== null && !holdsOwnKeys(copy, keys)) return { refused: "other_keys" };
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
    // the entry a key the act named signed carries exactly the keys this PC posted for it, at its own relay key
    if (by !== null && !holdsOwnKeys(copy, keys)) return { refused: "other_keys" };
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
    if ((this.isPinned && (this.dirty || (this.untilAt !== null && now >= this.untilAt))) || this.pinDue) void this.enqueue(async () => { await this.ready; this.settle(); this.settleOwed(); });
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
    return this.cannotSign(copy);
  }

  /**
   * cannotAllow, and for a PC that came to follow its list as its account moved (`migrated`): its own key in that
   * list is one it signs with only when the `pc` entry that holds it was signed by the device that asked it for its
   * card, or by the adder whose number a person at this PC confirmed (B7: the adder of the act). Any other entry with
   * its keys, and another key at its relay key, gives it nothing to sign with.
   */
  private cannotSign(copy: FollowerCopy): AllowRefusal | null {
    const cannot = cannotAllow(copy);
    if (cannot !== null && cannot !== "not_signer") return cannot;
    // one that joined by an invite holds its key and signs for nobody; one with no key of its own gets one by `ovis add`
    if (this.keyless(copy)) return "needs_keys";
    if (cannot !== null || copy.pin.how !== "migrated") return cannot;
    return this.keysTaken(copy) ? null : "not_signer";
  }

  /**
   * Whether this PC is in its list with no key of its own in it to sign with: the list holds no key at its relay key
   * (a move carried it in as an endpoint), or holds its key by an entry of a device that did not ask this PC for it.
   * `ovis add` here gives it its keys by the number (needsKeys). Not one whose relay key the list holds another key at.
   */
  private keyless(copy: FollowerCopy): boolean {
    if (copy.state === null || copy.pin.how !== "migrated" || standing(copy) === "out") return false;
    const own = ownPcRow(copy);
    return own === null || own.key === null || (own.key === copy.me.key && !this.keysTaken(copy));
  }

  /** Whether this PC itself keeps `key` out now (a block or a removal here, its own holds): no entry of the list lets it in here then. */
  holdsBack(key: string): boolean {
    return this.deps.mayAdmit?.(key) === false;
  }

  /** Whether this migrated PC took the `pc` entry its list holds for its own key (cannotSign). */
  private keysTaken(copy: FollowerCopy): boolean {
    const scope = this.bound();
    const own = ownPcRow(copy);
    if (scope === null || own === null || own.key !== copy.me.key) return false;
    const by = addedBy(copy);
    return by !== null && by === this.vouches.cardBy({ serverId: scope.serverId, bindId: scope.bindId }, copy.list);
  }

  /**
   * A device the list this PC is pinned to holds to drive with full power asks it, in its own session, for its card
   * (POST /api/account/list/card): it signs the `pc` entry that gives this PC its own keys in the list, which a PC
   * carried in as an endpoint has none of. The PC posts its keys and card at the account service (the second lock of
   * that entry), keeps that this device asked, and takes the entry for itself only when that device signed it.
   */
  cardForMember(by: string): Promise<{ readonly card: { readonly key: string; readonly enc: string; readonly card: string; readonly endpoint: string; readonly list: string } } | { readonly refused: "not_pinned" | "not_member" | "has_keys" | "unavailable" }> {
    return this.enqueue(async () => {
      const scope = this.bound();
      if (scope === null || !this.isPinned || scope.list === null) return { refused: "not_pinned" as const };
      await this.ready;
      const copy = this.copy;
      if (copy === null || copy.state === null || this.problem !== null) return { refused: "unavailable" as const };
      if (this.allowsJoins(by) !== true) return { refused: "not_member" as const };
      if (ownPcRow(copy)?.key === copy.me.key && (copy.pin.how !== "migrated" || this.keysTaken(copy))) return { refused: "has_keys" as const };
      const keys = await this.keysOf(scope);
      if (keys === null || !this.live(scope) || keys.key !== copy.me.key) return { refused: "unavailable" as const };
      try { this.vouches.keepCardBy({ serverId: scope.serverId, bindId: scope.bindId }, copy.list, by); } catch { return { refused: "unavailable" as const }; }
      // posted now, whatever the last post was, with the very card the device is handed: it places the entry right after this answer
      const card = await signCard({ key: keys.key, enc: keys.enc, list: copy.list, endpoint: scope.endpoint, invite: null }, keys.privateKey);
      this.postedAt = null;
      await this.post(copy, keys, scope, card);
      if (this.postedUntil === null || !this.live(scope)) return { refused: "unavailable" as const };
      return { card: { key: keys.key, enc: keys.enc, card, endpoint: scope.endpoint, list: copy.list } };
    });
  }

  canAllow(): boolean { return this.allowRefusal() === null; }

  /** Whether this PC is pinned to its list and holds no key of its own in it that it signs with: a person at it gives it one by `ovis add`. */
  needsKeys(): boolean {
    const copy = this.pinned() ? this.copy : null;
    if (copy === null || copy.state === null) return false;
    return ownPcRow(copy)?.key !== copy.me.key || (copy.pin.how === "migrated" && !this.keysTaken(copy));
  }

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
    const newcomer: Newcomer = { key: device.key, enc: device.enc, device: true, placeOf: (copy) => placeOf(copy, device), write: (copy, state, keys) => this.writeAllow(copy, state, device, keys) };
    // the device's session waits LIST_ALLOW_MS from here (allowIntoList): no try starts that could place the entry after it
    const by = this.deps.now() + LIST_ALLOW_MS;
    return sign ? this.enqueue(() => decided(this.allow(newcomer, no, by))) : decided(this.awaitMember(device, no));
  }

  /**
   * A person at this PC adds another PC to the list over SSH (ssh-add-list.ts): this PC signs a `pc` entry with its own
   * key for the card that PC handed over that channel, at the relay key this PC read there, and places it as an Allow
   * is placed (one signed request per place, a head that moved read and signed on again). The writer signs nothing
   * that would not count, so a card that is not that key's for this list and that relay key is refused `not_written`.
   * The PC is in only once the log shows its entry; one the list holds already by that key is answered at once.
   */
  addPc(pc: AddedPc): Promise<AllowOutcome> {
    const no = (refused: AllowRefusal, detail: string | null = null): AllowOutcome => ({ refused, detail });
    return this.enqueue(() => this.allow({ key: pc.key, enc: pc.enc, device: false, placeOf: (copy) => pcPlaceOf(copy, pc), write: (copy, state, keys) => this.writePc(copy, state, pc, keys) }, no));
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

  private async allow(device: Newcomer, no: (refused: AllowRefusal, detail?: string | null) => AllowOutcome, by: number | null = null): Promise<AllowOutcome> {
    {
      const scope = this.bound();
      if (scope === null || !this.isPinned) return no("not_pinned");
      await this.ready;
      await this.ensureCopy(scope);
      const keys = await this.keysOf(scope);
      if (keys === null || this.problem !== null) return no("unavailable");
      if (device.device && this.deps.mayAdmit?.(device.key) === false) return no("held_here");
      await this.read(scope);
      // One signature per place: the request as it was signed, and the head it was signed on. It is sent again as it
      // is while this PC's own copy shows that head; another is signed only once the copy shows a new one. It is kept
      // beside the copy (ACCOUNT_LIST_ALLOW_FILE), so that holds for another Allow and after a restart too
      let request: KeptAllow | null = null;
      let last: AllowRefusal = "head_lost";
      // how long the next try waits; nothing waits after the last one
      let wait = 0;
      // the wait is one a 429 named: the service placed nothing, so an Allow that stops there keeps no entry for later
      let limited = false;
      for (let tries = 0; tries < LIST_ALLOW_TRIES; tries++) {
        if (wait > 0) {
          // a wait the service asked for that would leave less than one try's time before the device stops waiting ends it here
          if (by !== null && this.deps.now() + wait + LIST_ALLOW_RETRY_MAX_MS > by) {
            if (limited) this.dropAllow();
            return no(last);
          }
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        wait = 0;
        limited = false;
        if (!this.live(scope)) return no("unavailable");
        const copy = this.copy;
        if (copy === null || copy.state === null) return no("unavailable");
        const { state } = copy;
        // what this PC signed before and does not know to be placed; one the copy has gone past is forgotten here
        const kept = this.keptAllow(scope, copy);
        // in already: this PC's own entry that the log now shows, or one a member placed
        const place = device.placeOf(copy);
        if (place !== null) return { allowed: place };
        const cannot = keys.key !== copy.me.key ? "unavailable" : this.cannotSign(copy);
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
            try { written = await device.write(copy, state, keys); } catch (error) {
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
          // past the device's wait nothing goes out: a late timer or a slow read does not place what it gave up on
          if (by !== null && this.deps.now() > by) return no(last);
          const cannot = keys.key !== now.me.key ? "unavailable" : this.cannotSign(now);
          if (cannot !== null) return no(cannot);
          if (device.device && this.deps.mayAdmit?.(device.key) === false) return no("held_here");
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
          // a PC that spent its calls of the minute (a number check waited on reads every few seconds): the service
          // counted the request before it read it, so nothing was placed, and the same entry goes again when it says
          if (error.status === 429 && error.code === "rate_limited") {
            last = "service_away";
            limited = true;
            wait = error.retryAfter === null ? LIST_ALLOW_RETRY_MS : Math.min(Math.max(error.retryAfter * 1000, LIST_ALLOW_RETRY_MS), LIST_ALLOW_LIMITED_MAX_MS);
            continue;
          }
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
      const place = copy !== null ? device.placeOf(copy) : null;
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

  /** The `pc` entry of an add over SSH on the copy's footing, with the wrap of the names' key for that PC when this PC holds that key. */
  private async writePc(copy: FollowerCopy, state: ListState, pc: AddedPc, keys: PcListKeys) {
    // by this PC's own clock held against the list's own time, as an Allow is signed (writeAllow)
    const now = listClock(state, this.seconds(), null);
    const seal = sealEpoch(state, now);
    const epochKey = seal === null ? null : await this.epochKey(copy, state, seal.epoch, keys);
    let sealed: Sealed | null = null;
    const wraps: { epoch: number; member: string; wrap: string }[] = [];
    if (seal !== null && epochKey !== null) {
      const label = isListLabel(pc.label) ? pc.label : LIST_PC_LABEL;
      sealed = { epoch: seal.epoch, bytes: await sealFields({ place: { list: copy.list, seq: state.footing.seq + 1 }, epoch: epochKey, commitment: seal.opens, fields: namesFields({ label, os: null }) }) };
      const wrap = await wrapEpochKey({ list: copy.list, epoch: epochKey, member: pc.enc });
      if (wrap !== null) wraps.push({ epoch: seal.epoch, member: pc.enc, wrap: wrapToText(wrap) });
    }
    const written = await signListEntry(state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card: pc.card, sealed }, { key: keys.key, privateKey: keys.privateKey }, now);
    return { entries: [written.text], wraps };
  }

  /**
   * The key to the list's names of `epoch`, when the account service holds a wrap of it for this PC that gives the
   * commitment the list holds; null otherwise. A key that does not give it is the service's doing, and is said.
   */
  private async epochKey(copy: FollowerCopy, state: ListState, epoch: number, keys: PcListKeys): Promise<EpochKey | null> {
    const got = await this.epochKeyOf(copy, state, epoch, keys);
    if (got === "unwrapped") return null;
    if (got !== null && "failed" in got) { this.error = this.words(got.failed); return null; }
    return got;
  }

  /**
   * epochKey, with a service that could not be asked kept apart (`failed`), and a service that holds no wrap of that
   * epoch for this PC YET (`unwrapped`: it holds none at all, a PC just added, or none of an epoch that late) from a wrap
   * that does not open or never comes (null: an epoch before this PC's own wraps, sealed before it joined).
   */
  private async epochKeyOf(copy: FollowerCopy, state: ListState, epoch: number, keys: PcListKeys): Promise<EpochKey | { readonly failed: unknown } | "unwrapped" | null> {
    const id = `${copy.list} ${epoch}`;
    const kept = this.epochKeys.get(id);
    if (kept !== undefined) return kept;
    const opens = state.epochs[epoch]?.opens;
    if (opens === undefined) return null;
    let wraps: unknown;
    try { wraps = (await this.deps.call("/v2/pc/list/wraps", { list: copy.list, member: keys.enc })).wraps; } catch (error) { return { failed: error }; }
    const held = Array.isArray(wraps) ? wraps.filter((wrap): wrap is { epoch: number; wrap: string } => typeof wrap === "object" && wrap !== null
      && Number.isSafeInteger((wrap as { epoch?: unknown }).epoch) && typeof (wrap as { wrap?: unknown }).wrap === "string") : [];
    const mine = held.find((wrap) => wrap.epoch === epoch);
    if (mine === undefined) {
      // Only an epoch past every wrap this PC holds, or any while it holds none yet (a PC just added), may still be
      // given. A newcomer is given the epoch it comes in at and later ones, and reads an earlier one through the list's
      // links from the nearest later wrap it holds (walkedKey); what that walk cannot reach is final
      if (held.length === 0 || held.every((wrap) => wrap.epoch < epoch)) return "unwrapped";
      return await this.walkedKey(copy, state, epoch, keys, held.filter((wrap) => wrap.epoch > epoch));
    }
    return await this.openedWrap(copy, state, epoch, keys, mine.wrap);
  }

  /** The key of `epoch` out of this PC's wrap of it, kept once it gives the commitment the list holds; null otherwise (a wrong key is the service's doing, and said). */
  private async openedWrap(copy: FollowerCopy, state: ListState, epoch: number, keys: PcListKeys, wrap: string): Promise<EpochKey | null> {
    const opens = state.epochs[epoch]?.opens;
    if (opens === undefined) return null;
    const opened = await openWrap({ list: copy.list, epoch, commitment: opens, wrap: wrapFromText(wrap), member: { key: keys.enc, privateKey: keys.encPrivateKey } });
    if (!opened.open) {
      if (opened.why === "other_key") this.error = "The account service gave this PC a wrong key to the list's names";
      return null;
    }
    this.epochKeys.set(`${copy.list} ${epoch}`, opened.value);
    return opened.value;
  }

  /**
   * The key of an `epoch` before this PC came into the list, as a device reads one (src/lib/account/listNames.ts
   * openEpochs): from the nearest `later` wrap that opens, back through the links the list's entries carry (walkBack),
   * each key checked against the commitment this PC's verified copy holds. Every key the walk reaches is kept; a walk
   * that ends at its bound of links goes on from the last key it reached. Null where it cannot reach `epoch` (a link
   * missing or that does not open): final, and no error, as a name that does not open. Names only: nothing that decides
   * who gets in reads these keys.
   */
  private async walkedKey(copy: FollowerCopy, state: ListState, epoch: number, keys: PcListKeys, later: readonly { readonly epoch: number; readonly wrap: string }[]): Promise<EpochKey | null> {
    const openings = new Map<number, EpochOpening>(state.epochs.map((row, at) => [at, { commitment: row.opens, link: row.link === null ? null : fromBase64Url(row.link) }]));
    for (const wrap of [...later].sort((a, b) => a.epoch - b.epoch)) {
      const from = this.epochKeys.get(`${copy.list} ${wrap.epoch}`) ?? await this.openedWrap(copy, state, wrap.epoch, keys, wrap.wrap);
      if (from === null) continue;
      for (let start: EpochKey | undefined = from; start !== undefined;) {
        const walk = await walkBack({ list: copy.list, from: start, to: epoch, openings });
        for (const key of walk.keys) if (!this.epochKeys.has(`${copy.list} ${key.epoch}`)) this.epochKeys.set(`${copy.list} ${key.epoch}`, key);
        start = walk.stopped?.why === "bound" ? walk.keys.at(-1) : undefined;
      }
      return this.epochKeys.get(`${copy.list} ${epoch}`) ?? null;
    }
    return null;
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
        const next = result.read === null ? null : footingRead(result.copy, result.read);
        if (session !== undefined) {
          this.peerReads.delete(session);
          if (next !== null) {
            this.peerReads.set(session, next);
            while (this.peerReads.size > PEER_SESSIONS_MAX) this.peerReads.delete(this.peerReads.keys().next().value!);
          }
        }
        // acted on at once; said as taken only once it is on disk
        const saved = this.keep(result.copy, scope, changed(copy, result.copy));
        return { verdict: saved ? result.verdict : "not_saved", asks: next === null ? null : { list: next.list, after: next.after } };
      }
      return null;
    });
  }

  /**
   * Where this PC stands against where a device says it stands (POST /api/account/list/head): the PC's own head; the
   * entries after the device's place when the device stands at an earlier place of the PC's own history (`page`); and
   * the place the PC asks the device for when the device stands further, or at another entry (`asks`). `wanted`: the
   * read the device asks for itself (where it sees the two differ, or looks for where they part); the PC answers it
   * with its own entries after that place, as any member answers a read, in place of the page its own comparison
   * would give. The caller passes it only for a key the list lets in. For another list than the PC's, named by the
   * head or by the read: its own head and nothing else. Null while it follows no list a person named.
   */
  peerHeads(theirs: ListHead, session?: PeerCaller, wanted: PeerAsk | null = null): { readonly list: string; readonly place: ListHead["place"]; readonly page?: ListPage; readonly asks?: PeerAsk } | null {
    const own = this.peerHead();
    const copy = this.copy;
    if (own === null || copy === null) return null;
    // a head of another list, or a read of another list: the PC's own head and nothing else, wherever the device stands
    if (theirs.list !== copy.list || (wanted !== null && wanted.list !== copy.list)) return own;
    const compared = compareHeads(copy, theirs);
    if (compared.verdict === "not_my_list") return own;
    const served = wanted === null ? null : servePage(copy, wanted, PEER_PAGE_MAX);
    if (compared.verdict === "ahead") {
      const page = served ?? servePage(copy, { list: copy.list, after: theirs.place?.seq ?? null }, PEER_PAGE_MAX);
      return page === null ? own : { ...own, page };
    }
    const answered = served === null ? own : { ...own, page: served };
    if (compared.read === null) return answered;
    // asked from the footing the PC states beside it: an entry no member signed above it is not counted as held
    const read = footingRead(copy, compared.read);
    if (session !== undefined) {
      this.peerReads.delete(session);
      this.peerReads.set(session, read);
      while (this.peerReads.size > PEER_SESSIONS_MAX) this.peerReads.delete(this.peerReads.keys().next().value!);
    }
    return { ...answered, asks: { list: read.list, after: read.after } };
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
    const was = this.snapshotNames;
    const names = new Set(eligible);
    this.snapshotNames = names;
    // a pinned PC lets a carried key that never handed over in only while the snapshot names it: what this read changed of that is done now
    const copy = this.copy;
    if (this.isPinned && copy?.state != null && carriedAlone(copy.state).some((key) => (was?.has(key) ?? false) !== names.has(key))) {
      void this.enqueue(async () => { await this.ready; this.settle(); });
    }
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
    // the vouches were the binding's: a PC that left its account keeps none
    if (bindId === null) this.vouches.forget();
    this.namedReads.clear();
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
    this.snapshotNames = null;
    this.pinDue = false;
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
    await this.keepServiceLinks(scope);
    // a wrap of the names' key may have come since a round found none, with the list as it was: asked again, once a read
    this.reads++;
    if (this.live(scope) && (this.deviceNames?.unwrapped.size ?? 0) > 0) this.nameDevices(scope);
  }

  /**
   * After the pin, at each read of the log: the links the account service keeps for the list, that say something here,
   * go beside the vouches, so a removal this PC holds against a device's sign-in key keeps it out by its member key too,
   * whether or not the device ever handed its link (heldOut). Asked only while this PC holds a removal at all; a read
   * that fails changes nothing kept.
   */
  private async keepServiceLinks(scope: Bound): Promise<void> {
    const copy = this.copy;
    const witness = this.deps.witness?.() ?? null;
    if (!this.isPinned || !this.live(scope) || copy?.state == null || witness === null || witness.removed.length === 0) return;
    const links = await this.serviceLinks(scope.account, copy.list);
    const state = this.copy?.state ?? null;
    if (links === null || state === null || !this.live(scope) || this.copy?.list !== copy.list) return;
    const counted = this.linksThatCount(state, links, witness);
    if (counted.length === 0) return;
    const holds = this.deps.holdsRemoval;
    let kept: "kept" | "full";
    try { kept = this.vouches.keep({ serverId: scope.serverId, bindId: scope.bindId }, copy.list, counted, (device) => witness.removed.includes(device) || holds?.(device) === true); } catch { return; }
    // every link that keeps a device out is kept whatever the cap; what was not kept only said who is known here
    if (kept === "full") console.error(`[account] ${ACCOUNT_LIST_VOUCHES_FILE} is full for this list: links that only say a device is known here were not kept`);
    this.settle();
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
  private async post(copy: FollowerCopy, keys: PcListKeys, scope: Scope, signed?: string): Promise<void> {
    const now = this.deps.now();
    if (this.postedAt !== null && now - this.postedAt >= 0 && now - this.postedAt < LIST_POST_RENEW_MS) return;
    try {
      const card = signed ?? await signCard({ key: keys.key, enc: keys.enc, list: copy.list, endpoint: scope.endpoint, invite: null }, keys.privateKey);
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
    this.pinDue = false;
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
      const rows = listCommit(copy, now, this.namesOf(copy));
      // nobody while the copy does not show whom the PC lets in (a lost alarm, a removal it has not read again), and never a key the mark names
      const closed = this.alarmLost || this.mustRead;
      const out = this.keptOut(copy, false);
      this.deps.commit?.({ ...rows, devices: rows.devices.map((row) => (closed || this.owedKey(row.key) || out(row.key) ? { ...row, eligible: false } : row)) }, readmission, pinning || this.freshPin ? () => true : (key) => this.allowing.has(key));
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
    this.nameDevices(scope);
  }

  /** The names this PC opened for the devices of `copy`'s list, by key (deviceNames). */
  private namesOf(copy: FollowerCopy): ReadonlyMap<string, string> {
    return this.deviceNames?.list === copy.list ? this.deviceNames.byKey : new Map();
  }

  /**
   * Opens the names the list sealed for its devices that this PC has not decided yet, with the key to the names it was
   * given (epochKeyOf), one round at a time. The account service's calls and the opens run OUTSIDE the follower's turn,
   * so a read (a removal before a session opens) never waits behind them; the turn is taken only to keep the names and
   * write the rows again. An entry is decided once its name opened, or it seals none, or its wrap does not open; one the
   * service could not be asked about is asked again in a later round (NAMES_RETRY_MS on), and one whose epoch the service
   * holds no wrap of for this PC yet (`unwrapped`: a PC just added gets its wrap a moment after its first round) after the
   * next read of the log and NAMES_RETRY_MS on, so at most once a minute. A PC with no key of its own in the list asks
   * nothing. A round asks the service once per epoch at most. A list other than the one the round began on keeps
   * nothing of it.
   * Names decide nothing: whom the PC lets in is the list's.
   */
  private nameDevices(scope: Scope): void {
    const copy = this.copy;
    const state = copy?.state ?? null;
    // a PC with no key of its own in the list (carried in as an endpoint) is given no wrap: nothing to ask for yet
    if (copy === null || state === null || this.stopped || this.namingNow || this.deps.now() < this.namesRetryAt || this.needsKeys()) return;
    if (this.deviceNames?.list !== copy.list) this.deviceNames = { list: copy.list, byKey: new Map(), tried: new Set(), unwrapped: new Set(), unwrappedAt: this.reads, unwrappedUntil: 0 };
    const names = this.deviceNames;
    const reads = this.reads;
    const waits = names.unwrappedAt === reads || this.deps.now() < names.unwrappedUntil;
    const asked = listView(state).devices.filter((row) => row.ended === null && !names.tried.has(row.seq) && !(waits && names.unwrapped.has(row.seq)));
    if (asked.length === 0) return;
    this.namingNow = true;
    let again = false;
    this.naming = (async () => {
      const keys = await this.keysOf(scope);
      if (keys === null) return;
      const epochs = new Map<number, EpochKey | "failed" | "unwrapped" | null>();
      const decided: number[] = [];
      const unwrapped: number[] = [];
      const opened = new Map<string, string>();
      let failed = false;
      for (const row of asked) {
        const got = await this.nameAt(copy, state, row.seq, keys, epochs);
        if (got === "failed") { failed = true; continue; }
        if (got === "unwrapped") { unwrapped.push(row.seq); continue; }
        decided.push(row.seq);
        if (got !== null) opened.set(row.key, got.label);
      }
      if (failed) this.namesRetryAt = this.deps.now() + NAMES_RETRY_MS;
      await this.enqueue(() => {
        if (this.stopped || this.deviceNames !== names || this.copy?.list !== names.list) return;
        for (const seq of decided) { names.tried.add(seq); names.unwrapped.delete(seq); }
        for (const seq of unwrapped) names.unwrapped.add(seq);
        if (unwrapped.length > 0) { names.unwrappedAt = reads; names.unwrappedUntil = this.deps.now() + NAMES_RETRY_MS; }
        let changed = false;
        for (const [key, label] of opened) if (names.byKey.get(key) !== label) { names.byKey.set(key, label); changed = true; }
        if (changed) this.settle();
        // rows a read brought while this round ran wait for no later read
        again = !failed && decided.length > 0;
      });
    })().catch(() => undefined).finally(() => {
      this.namingNow = false;
      if (again) this.nameDevices(scope);
    });
  }

  /**
   * The label the entry at `seq` seals, opened with the key to its epoch's names this PC holds (inside `{ label }`, so
   * no label is ever read as the failure); null where it seals none or its key does not open; `unwrapped` where the
   * service holds no wrap of its epoch for this PC yet; `failed` where the service could not be asked. `epochs`: what
   * this round learnt of each epoch, so it asks the service once per epoch.
   */
  private async nameAt(copy: FollowerCopy, state: ListState, seq: number, keys: PcListKeys, epochs: Map<number, EpochKey | "failed" | "unwrapped" | null>): Promise<{ readonly label: string } | "failed" | "unwrapped" | null> {
    const text = copy.entries[seq];
    if (text === undefined) return null;
    let sealed: Sealed | null;
    try {
      const kind = readKind(readBody(entryFromText(text).body));
      sealed = kind !== null && "sealed" in kind ? kind.sealed : null;
    } catch { return null; }
    if (sealed === null) return null;
    let epoch = epochs.get(sealed.epoch);
    if (epoch === undefined) {
      const got = await this.epochKeyOf(copy, state, sealed.epoch, keys);
      epoch = got !== null && got !== "unwrapped" && "failed" in got ? "failed" : got;
      epochs.set(sealed.epoch, epoch);
    }
    if (epoch === "failed" || epoch === "unwrapped") return epoch;
    if (epoch === null) return null;
    const opened = await openSealed({ place: { list: seq === 0 ? "" : copy.list, seq }, epoch, sealed: sealed.bytes });
    const label = opened.open ? readNames(opened.value)?.label ?? null : null;
    return label !== null && isListLabel(label) ? { label } : null;
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
      // a key that handed its place on to another key of its own was not put out: its device is in by that key
      const text = row.as !== "device" || row.ended === null || heirOf(copy.state, key) !== null ? undefined : copy.entries[row.ended];
      if (text === undefined) continue;
      const entry = entryFromText(text);
      const id = entryHash(entry.body);
      // and every key it handed its place on from: the device is out by all of them, also once this PC reads a snapshot again
      for (const one of [key, ...handedFrom(copy.state, key)]) {
        if (this.applied.has(id + one)) continue;
        this.deps.removed(one, { id, at: readBody(entry.body).issued_at });
        this.applied.add(id + one);
        this.kept.add(one);
      }
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

/** The list's row of the PC this copy is of, at its own relay key, while it is in: `key` is null for a PC carried in as an endpoint with no key. */
function ownPcRow(copy: FollowerCopy): { readonly key: string | null } | null {
  const { state, me } = copy;
  const row = state === null || me.endpoint === null || !Object.hasOwn(state.pcs, me.endpoint) ? undefined : state.pcs[me.endpoint];
  return row === undefined || row.removed !== null ? null : { key: row.key };
}

/** Where the copy's list let this very PC in by a `pc` entry, with that key at that relay key, while it is in; null otherwise. */
function pcPlaceOf(copy: FollowerCopy, pc: Pick<AddedPc, "key" | "endpoint">): { id: string; seq: number; hash: string } | null {
  const { state } = copy;
  if (state === null) return null;
  const row = Object.hasOwn(state.pcs, pc.endpoint) ? state.pcs[pc.endpoint] : undefined;
  const signer = Object.hasOwn(state.signers, pc.key) ? state.signers[pc.key] : undefined;
  const text = signer === undefined ? undefined : copy.entries[signer.seq];
  if (row === undefined || row.removed !== null || row.key !== pc.key || signer === undefined || signer.as !== "pc" || signer.ended !== null || text === undefined) return null;
  return { id: copy.list, seq: signer.seq, hash: entryHash(entryFromText(text).body) };
}

/** Whether the list holds the PC this copy is of with exactly its own keys: its signing key and its encryption key, at its own relay key. */
function holdsOwnKeys(copy: FollowerCopy, keys: Pick<PcListKeys, "key" | "enc">): boolean {
  const { state, me } = copy;
  const row = state === null || me.endpoint === null || !Object.hasOwn(state.pcs, me.endpoint) ? undefined : state.pcs[me.endpoint];
  return row !== undefined && row.removed === null && row.key === keys.key && row.enc === keys.enc;
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
    row.as === "device" && row.ended !== null && heirOf(state, key) === null && !(Object.hasOwn(was, key) && was[key]!.ended !== null) ? [{ key, seq: row.ended }] : []);
}

/** A link a PC holds: a member key of the list and the registered sign-in key both signed for. */
type HeldLink = { readonly key: string; readonly device: string };

/** The most lists whose last read a PC keeps for namings. */
const VOUCH_READS_MAX = 4;

/** `target`, which has read nothing, with every entry of `source` taken into it page by page, as a member's pages are: the entries prove themselves. */
async function copied(target: FollowerCopy, source: FollowerCopy, now: number): Promise<FollowerCopy> {
  let copy = target;
  for (let read: FollowRead | null = startRead(copy, "peer"); read !== null;) {
    const page = servePage(source, { list: read.list, after: read.after }, PEER_PAGE_MAX);
    if (page === null) break;
    const result = await takePage(copy, read, page, now);
    copy = result.copy;
    read = result.verdict === "more" || result.verdict === "asks_after" ? result.read : null;
  }
  return copy;
}

/** The keys that handed their place on, however many times, down to `key`. */
function handedFrom(state: ListState, key: string): string[] {
  return Object.keys(state.signers).filter((from) => {
    let at: string | null = from;
    for (let steps = 0; at !== null && steps <= state.footing.seq; steps += 1) {
      at = heirOf(state, at);
      if (at === key) return true;
    }
    return false;
  });
}

/** The keys a `carried` entry named that are in by themselves: they never handed their place on. */
function carriedAlone(state: ListState): string[] {
  return Object.entries(state.devices).flatMap(([key, device]) => (device.carried && standsFor(state, key) === key ? [key] : []));
}

function changed(before: FollowerCopy, after: FollowerCopy): boolean {
  return after.entries !== before.entries || after.state !== before.state || after.alarm !== before.alarm || after.stop !== before.stop;
}

/**
 * What a pinned PC's account rows are made from: every device the list lets in now, and every device it put out. A
 * device's place is that of the entry that let it in, so an older device is one the list let in before. `names`: the
 * names this PC opened for them, by key; a device with none is named LIST_DEVICE_LABEL.
 */
export function listCommit(copy: FollowerCopy, now: number, names: ReadonlyMap<string, string> = new Map()): ListCommit {
  const state = copy.state;
  const devices: SnapshotDevice[] = [];
  const removed: SnapshotRemoved[] = [];
  const admitted = new Set(admittedDevices(copy, now).map((device) => device.key));
  for (const row of state === null ? [] : listView(state).devices) {
    const no = row.seq + 1;
    if (row.ended !== null) removed.push({ key: row.key, no });
    else devices.push({ key: row.key, no, eligible: admitted.has(row.key), label: names.get(row.key) ?? LIST_DEVICE_LABEL });
  }
  // a device that handed its place on keeps its row under the key it is in by now
  const moved = state === null ? [] : Object.keys(state.signers).flatMap((from) => {
    const to = heirOf(state, from) === null ? null : standsFor(state, from);
    return to === null ? [] : [{ from, to }];
  });
  return { account: copy.account, snapshot: copy.list.slice(0, 32), version: (state?.footing.seq ?? 0) + 1, devices, removed, moved, names: true };
}

/** Removes the file: a reset relay identity is a new PC, which follows no list yet. Never throws. */
export function forgetList(stateDir: string): void {
  for (const file of [ACCOUNT_LIST_FILE, ACCOUNT_LIST_OWED_FILE, ACCOUNT_LIST_ALLOW_FILE, ACCOUNT_LIST_VOUCHES_FILE]) {
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
