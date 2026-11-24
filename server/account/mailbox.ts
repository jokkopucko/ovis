/**
 * The PC's mailbox at the account service (docs/account.md, "Account service API"): records left for
 * this PC while it was off. The PC signs in with nothing but its relay key, answering a server proof
 * for the `account` role, which the relay itself never accepts. The service can hold records back,
 * never forge one: each is checked and applied like a record a client hands over directly.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { writePrivateState } from "../private-state.ts";
import { logAccess } from "../connection-diagnostics.ts";
import { accountServiceOff, DEFAULT_ACCOUNT_SERVICE } from "../../shared/web-policy.ts";
import { isListHash } from "../../shared/account-list-entry.ts";
import type { ListPlace } from "../../shared/account-list-signers.ts";
import { ACCOUNT_RECORDS_MAX, isAccountKeyEncoding, isIsoTime } from "../../shared/account-records.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { AccountHolds } from "./holds.ts";
import { UNPINNED_CLEAR } from "./pc-binding.ts";
import type { Readmission } from "./readmission.ts";
import type { UsedReport } from "../../shared/account-snapshot.ts";
import { readSnapshot, type PageAnswer, type ReadOutcome, type SnapshotPorts } from "./snapshot-read.ts";
import { applyAccountRecords, stageMailboxAdds, type AddGates, type RecordOutcome } from "./records.ts";

/** The account service refused a PC route: its status and error code, when it named one. */
export class AccountServiceRefusal extends Error {
  /** `retryAfter`: the seconds the service asks to wait (its `retry-after`), or null when it names none. */
  constructor(readonly status: number, readonly code: string | null, readonly path: string, readonly retryAfter: number | null = null) {
    super(`The account service answered ${status} to ${path}`);
    this.name = "AccountServiceRefusal";
  }
}

/** The service's JSON problem envelope, including a listed PC's `step2_off` refusal. */
async function refusalCode(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const problem = body.error;
  return typeof problem === "object" && problem !== null && "code" in problem && typeof problem.code === "string" ? problem.code : null;
}

export const MAILBOX_PULL_MS = 5 * 60_000;
/** How old an admission may be for the PC to take an account join outside the pairing window. */
export const ADMISSION_TTL_MS = 10 * 60_000;
/** The least time between two pulls a join that missed asks for. */
const ASKED_PULL_MS = 10_000;
/** The least time between two pulls that refused sign-ins ask for, once one of them read the mailbox. */
export const SIGN_IN_PULL_MS = 60_000;
/** The same after such a pull could not read the mailbox (the service was down, or did not answer): it found nothing out. */
export const SIGN_IN_PULL_RETRY_MS = ASKED_PULL_MS;
export const SIGN_IN_WAIT_MS = 5_000;
/** How long the account service's word on whether an account keeps a signed list is kept (AccountMailbox.listNamed). */
const LIST_NAMED_MS = 30_000;
/** The least time between two reads of an account's admissions for links (vouch): a 429 may name a longer one. */
export const VOUCH_READ_GAP_MS = ASKED_PULL_MS;
/** How long one such read has for its two calls together. */
export const VOUCH_READ_MS = 5_000;
/** The longest wait a 429 of the account service holds such reads back: one answer never shuts QR adds for long. */
export const VOUCH_RETRY_MAX_MS = 60_000;

/**
 * The account service's word on a link's key (AccountMailbox.vouch): whether it holds an admission for it, or that it
 * could not be asked in time, and in how many seconds this PC may ask again.
 */
export type Vouch = { readonly vouched: boolean } | { readonly unavailable: true; readonly retryAfter: number };

interface VouchWaiter {
  readonly account: string;
  readonly key: string;
  readonly firstLink: boolean;
  readonly arrivedAt: number;
  readonly answer: (vouch: Vouch) => void;
}

/** `Retry-After` in whole seconds, as the account service sends it; null for none or another form. */
function retryAfterSeconds(value: string | null): number | null {
  return value !== null && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/** The well-formed keys of a list of admissions in a mailbox answer. */
function admissionKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(value)) return keys;
  for (const entry of value) {
    const key = typeof entry === "object" && entry !== null ? (entry as { key?: unknown }).key : undefined;
    if (isAccountKeyEncoding(key)) keys.add(key);
  }
  return keys;
}

function scope(account: string, serverId: string, key: string): string {
  return `${account}\0${serverId}\0${key}`;
}
const MAX_PAGES = 20;

export class AccountServiceOff extends Error {
  constructor() {
    super("The account service is turned off (OVIS_ACCOUNT_SERVICE_URL=off)");
    this.name = "AccountServiceOff";
  }
}

export function passAccountService(value?: string): string | Error | undefined {
  try { return accountServiceUrl(value); } catch (error) {
    if (error instanceof AccountServiceOff) return undefined;
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function accountServiceUrl(value = process.env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE): string {
  if (accountServiceOff(value)) throw new AccountServiceOff();
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The account service must be https");
  return url.origin;
}

/**
 * Records that wait, across pulls (and restarts), until they apply: a remove whose signer is not a
 * member yet, and an add held back by the enrollment barrier or a waiting remove. At this many every
 * add waits too, and a page that would pass it is not acknowledged.
 */
export const PENDING_MAX = 1000;

const WAITING = new Set(["signer_not_member", "enrolling", "removal_pending"]);

const waits = (outcome: RecordOutcome | undefined): boolean => outcome?.outcome === "refused" && WAITING.has(outcome.code);

/** Null for a file that exists and will not parse: it is not an empty queue (it may hold the removes that gate adds). */
function readPending(path: string | undefined): unknown[] | null {
  if (!path) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  return Array.isArray(value) ? value : null;
}

function removedKey(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const { kind, key } = record as { kind?: unknown; key?: unknown };
  return kind === "remove" && typeof key === "string" ? key : null;
}

const LISTING_ID = /^[0-9a-f]{32}$/;
type CompletionScope = { readonly account: string; readonly listing_id: string };

/** How long one positive answer for this PC's listing lets its account's devices in without asking again. */
export const LISTING_CONFIRMED_MS = 60_000;
/**
 * The account service's word on this PC's listing: `unreachable` when it gave none (so nothing was decided), `readd`
 * when an older binding could name no listing and was cleared for it, `refused` for every other end.
 */
export type ListingVerdict = "confirmed" | "unreachable" | "readd" | "refused";

/** A mailbox answer's word on this PC's listing, with the binding and account it was asked for. */
interface NamedListing { readonly binding: string; readonly account: string; readonly listing: string | null | undefined }

/** The listing a mailbox answer names for this PC: null for none the account confirms, undefined when it does not say. */
function namedListing(mailbox: Record<string, unknown> | null): string | null | undefined {
  const listing = mailbox?.listing_id;
  return typeof listing === "string" && LISTING_ID.test(listing) ? listing : listing === null ? null : undefined;
}

/**
 * Whether a mailbox answer says the listing it names stands on a one-press admission this PC took; undefined when it
 * does not say, as a service from before the field.
 */
function listingAdmitted(mailbox: Record<string, unknown> | null): boolean | undefined {
  const said = mailbox?.listing_admitted;
  return typeof said === "boolean" ? said : undefined;
}

/** The account's signed list as a mailbox answer names it: its id and its head. A hint to read, never a word on who is in. */
export interface NamedList { readonly id: string; readonly head: ListPlace }

/**
 * What a mailbox answer says of the account's signed list (`with_list`): the list, null for none it names to this PC,
 * undefined when it does not say (a service from before the member, or an answer out of form).
 */
function namedList(mailbox: Record<string, unknown> | null): NamedList | null | undefined {
  const said = mailbox?.list;
  if (said === null) return null;
  if (typeof said !== "object" || said === undefined || Array.isArray(said)) return undefined;
  const { id, head } = said as { id?: unknown; head?: unknown };
  if (typeof id !== "string" || !isListHash(id) || typeof head !== "object" || head === null) return undefined;
  const { seq, hash } = head as { seq?: unknown; hash?: unknown };
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 && typeof hash === "string" && isListHash(hash) ? { id, head: { seq, hash } } : undefined;
}

/** A completion the service took: its answer names when, as the service writes a time. */
function completed(answer: Record<string, unknown> | null): boolean {
  return isIsoTime(answer?.completed_at);
}

function listingChanged(error: unknown): boolean {
  return error instanceof AccountServiceRefusal && error.path === "/v1/pc/complete" && error.status === 409 && error.code === "listing_changed";
}

/**
 * A PC that joined `account` by its list under the binding `list_bind_id` owes the account service its completion,
 * and has no listing for it yet (AccountMailbox.listJoined): the receipt's file holds this until a pull names one. An
 * Ovis that reads no such form takes the file for no receipt.
 */
type ListOwed = { readonly account: string; readonly list_bind_id: string };

const BIND_ID = /^[0-9a-f]{32}$/;

function readCompletion(path: string | undefined): { receipt: CompletionScope | null; owed: ListOwed | null } {
  const none = { receipt: null, owed: null };
  if (!path) return none;
  try {
    const kept = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof CompletionScope | keyof ListOwed, unknown>> | null;
    if (kept === null || typeof kept !== "object" || typeof kept.account !== "string") return none;
    if (typeof kept.listing_id === "string" && LISTING_ID.test(kept.listing_id)) return { receipt: { account: kept.account, listing_id: kept.listing_id }, owed: null };
    if (typeof kept.list_bind_id === "string" && BIND_ID.test(kept.list_bind_id)) return { receipt: null, owed: { account: kept.account, list_bind_id: kept.list_bind_id } };
    return none;
  } catch { return none; }
}

export interface AccountMailboxOptions {
  readonly pendingPath?: string;
  /** where a bound add's completion receipt waits until the account service has it (complete) */
  readonly completionPath?: string;
  readonly devices: DeviceStore;
  readonly identity: () => RelayIdentity | undefined;
  readonly service: string | Error;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly holds?: AccountHolds;
  /**
   * The account's whole snapshot read (Step 2, S2-24), run after each pull: the account it reads and the ports that
   * apply it, or null for none now. The server gives it only while OVIS_ACCOUNT_OPENS_ALL is on.
   */
  readonly snapshot?: { account(): string | null; ports(readmission?: Readmission): SnapshotPorts | null; used?(): UsedReport };
  /**
   * Whoever follows the account's signed list on this PC (server/account/list-follow.ts): each pull asks the mailbox
   * for the list's head (`with_list`) and tells it what the answer named for `account`. Told, never awaited: a list
   * that is slow to read holds no pull back. Without it nothing is asked.
   */
  readonly list?: { heard(account: string, named: NamedList | null, asked?: string | null): void; scopeToken?(): string | null };
}

export class AccountMailbox {
  lastPullAt: string | null = null;
  private admissions = new Map<string, number>();
  private lastAskedPull = Number.NEGATIVE_INFINITY;
  private nextSignInPull = Number.NEGATIVE_INFINITY;
  private drainedAt: number | null = null;
  private drainedScope: string | null = null;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private pulling: Promise<number> | undefined;

  private pending: unknown[];
  private draining: unknown[] = [];
  /** Why the waiting records cannot be read: no add applies and nothing is pulled until it is fixed. */
  private readonly pendingError: string | null;

  /** Links waiting for the account service's word (vouch), oldest first. */
  private vouchWaiters: VouchWaiter[] = [];
  private vouchReading = false;
  /** From when, on the store's clock (DeviceStore.waitClock), a read for links may start. */
  private vouchNextAt = Number.NEGATIVE_INFINITY;
  private vouchTimer: (() => void) | undefined;

  /** A bind's completion receipt the account service has not taken yet (account#57): sent again after each pull. */
  private completion: CompletionScope | null;
  /** The completion this PC owes for a join by its list, before a pull named its listing (listJoined); on disk in the receipt's file. */
  private listOwed: ListOwed | null;
  /** Whether listOwed is on disk: one the disk did not take at the join is written again at each pull until it is. */
  private owedOnDisk = true;

  private listingConfirmed: { readonly key: string; readonly at: number; readonly wallAt: number; readonly seq: number } | null = null;
  /** What the pull under way read from its mailbox of this PC's listing in its account; undefined when it failed, or no link bound the PC. */
  private drainedListing: NamedListing | undefined;
  /** The newest check that brought no yes: a yes asked for before it is not kept. */
  private listingFailed: { readonly key: string; readonly seq: number } | null = null;
  private listingChecks = 0;
  private listingCheck: { readonly key: string; readonly verdict: Promise<ListingVerdict> } | null = null;

  constructor(private readonly options: AccountMailboxOptions) {
    ({ receipt: this.completion, owed: this.listOwed } = readCompletion(options.completionPath));
    const pending = readPending(options.pendingPath);
    this.pending = pending ?? [];
    this.pendingError = pending === null ? `Cannot read ${options.pendingPath}: account adds wait until it is restored or fixed.` : null;
    if (options.devices.opensAll()) options.devices.onRemoved((_event, key) => {
      if (key !== undefined) this.dropSignerRemovals(key);
    });
  }

  /**
   * Whether a waiting remove may hold its key back (P19): with the release flag on, only one the key signed of itself
   * or that a drive member of the account here signed; any other holds nothing. Without the flag, every one does.
   */
  private authorized(record: unknown): boolean {
    if (!this.options.devices.opensAll()) return true;
    const { key, signer, account } = record as { key?: unknown; signer?: unknown; account?: unknown };
    if (signer === key) return true;
    return typeof signer === "string" && typeof account === "string" && this.options.devices.accountSigner(signer, account) !== null;
  }

  /** A list candidate meets the same enrollment, held-key and counted-removal checks as a signed add. */
  listHeld(key: string): boolean {
    const gates = this.gates("list");
    return gates.enrolling() || gates.held(key);
  }

  private dropSignerRemovals(key: string): void {
    if (this.pendingError !== null) return;
    const keep = (record: unknown) => typeof record !== "object" || record === null
      || !("signer" in record) || record.signer !== key || removedKey(record) === null;
    const pending = this.pending.filter(keep);
    const draining = this.draining.filter(keep);
    if (pending.length === this.pending.length && draining.length === this.draining.length) return;
    if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...draining, ...pending]);
    this.draining.splice(0, this.draining.length, ...draining);
    this.pending = pending;
  }

  /**
   * What holds an add back here (docs/account.md, "Enrolling a PC"): the enrollment barrier, a waiting
   * remove for its key (whatever its signer), a held key, and a queue that is full or cannot be read.
   */
  gates(source: "add" | "list" = "add"): AddGates {
    const removing = (key: string) => this.pendingError !== null || this.waiting().some(record => removedKey(record) === key && this.authorized(record));
    return {
      enrolling: () => this.options.holds?.enrolling() ?? false,
      held: (key, includeWaiting = true) => this.pendingError !== null || (includeWaiting && removing(key)) || (this.options.holds?.holds(key, source) ?? false),
      removing,
    };
  }

  /** Every add is held back here, whatever its key: the waiting records cannot be read, or removes were lost to a full queue. */
  holdsEveryAdd(): boolean { return this.pendingError !== null || (this.options.holds?.full() ?? false); }

  /** The keys of the removes waiting here: /api/account/status lists them as `blocked`. */
  waitingRemoveKeys(): string[] {
    return [...new Set(this.waiting().flatMap((record) => this.authorized(record) ? removedKey(record) ?? [] : []))];
  }

  private waiting(): unknown[] { return [...this.draining, ...this.pending]; }

  pull(readmission?: Readmission): Promise<number> {
    this.pulling ??= this.exclusively(async () => {
      const applied = await this.drain();
      // the listing this pull's own mailbox named: a read rests on no other
      const adds = applied + (await this.readSnapshotNow(readmission, this.drainedListing)).adds;
      await this.sendCompletion();
      return adds;
    }).finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  /** One whole snapshot read now, in turn with pulls; null when the server gave no snapshot ports or there is nothing to read for. */
  readSnapshot(): Promise<ReadOutcome | null> {
    return this.exclusively(async () => (await this.readSnapshotNow(undefined, await this.askListingNamed())).outcome);
  }

  /**
   * For a read with no pull beside it, on a PC a device's link bound: the listing the account names for it now, asked
   * with a mailbox call that reads, applies and acknowledges nothing. Undefined for any other PC, or with no answer.
   */
  private async askListingNamed(): Promise<NamedListing | undefined> {
    const account = this.options.devices.account();
    const binding = this.options.devices.linkBinding();
    if (account === null || binding === null || this.options.service instanceof Error || this.stopped) return undefined;
    try {
      const identity = this.options.identity();
      if (!identity) return undefined;
      // read as a pull reads it: an answer a pull would reject names nothing
      return { binding, account, listing: (await this.page(identity, account, null)).listing };
    } catch { return undefined; }
  }

  /**
   * Whether the account still holds the listing this PC was admitted in. A successful snapshot identifies the account,
   * not the listing, so only the admitted listing's scoped receipt answers. One positive answer stands for
   * LISTING_CONFIRMED_MS from when it was asked for, so a burst of sign-ins asks once; nothing else is kept.
   */
  async confirmsListing(binding: string): Promise<ListingVerdict> {
    const key = this.listingKey(binding);
    if (key === null) return "refused";
    if (this.listingStands(key)) return "confirmed";
    const verdict = await (this.listingCheck?.key === key ? this.listingCheck.verdict : this.checkListing(binding));
    if (verdict !== "confirmed") return verdict;
    const now = this.listingKey(binding);
    if (now === null) return "refused";
    return this.listingStands(now) ? "confirmed" : "unreachable";
  }

  /** Whether a positive answer for this binding's listing stands now: what a grant or a commit made later than its check rests on. */
  listingFresh(binding: string): boolean {
    const key = this.listingKey(binding);
    return key !== null && this.listingStands(key);
  }

  /**
   * The same question, asked now: a read that releases account rows never rests on an answer from before its pages.
   */
  private checkListing(binding: string): Promise<ListingVerdict> {
    const key = this.listingKey(binding);
    if (key === null) return Promise.resolve("refused");
    const at = this.options.devices.waitClock().now();
    const wallAt = Date.now();
    const seq = ++this.listingChecks;
    const verdict = this.askListing(binding).then((answer) => {
      const kept = this.listingConfirmed;
      if (answer !== "confirmed") {
        // a later check that brought no yes ends an earlier yes for the same listing, also one still on its way
        const failed = this.listingFailed;
        if (failed === null || failed.key !== key || failed.seq < seq) this.listingFailed = { key, seq };
        if (kept !== null && kept.key === key && kept.seq <= seq) this.listingConfirmed = null;
        return answer;
      }
      const confirmed = this.listingKey(binding);
      if (confirmed === null) return "refused";
      if (this.listingFailed?.key === confirmed && this.listingFailed.seq > seq) return answer;
      if (kept === null || kept.key !== confirmed || kept.seq <= seq) this.listingConfirmed = { key: confirmed, at, wallAt, seq };
      return answer;
    });
    if (this.listingCheck?.key !== key) {
      const check = { key, verdict };
      this.listingCheck = check;
      void verdict.finally(() => { if (this.listingCheck === check) this.listingCheck = null; });
    }
    return verdict;
  }

  private listingKey(binding: string): string | null {
    const { devices } = this.options;
    const account = devices.account();
    let identity: RelayIdentity | undefined;
    try { identity = this.options.identity(); } catch { return null; }
    if (this.stopped || !identity || account === null || devices.serviceBinding() !== binding) return null;
    return [binding, account, identity.server_id, devices.serviceListing() ?? ""].join("\0");
  }

  /** Both clocks bound it: the PC's wall clock set back, or a sleep the monotonic clock did not count, extends nothing. */
  private listingStands(key: string): boolean {
    const kept = this.listingConfirmed;
    if (kept === null || kept.key !== key) return false;
    const age = this.options.devices.waitClock().now() - kept.at;
    const wallAge = Date.now() - kept.wallAt;
    return age >= 0 && age < LISTING_CONFIRMED_MS && wallAge >= 0 && wallAge < LISTING_CONFIRMED_MS;
  }

  private async askListing(binding: string): Promise<ListingVerdict> {
    const { devices } = this.options;
    const account = devices.account();
    let identity: RelayIdentity | undefined;
    try { identity = this.options.identity(); } catch { return "refused"; }
    if (!identity || account === null || devices.serviceBinding() !== binding || this.stopped) return "refused";
    const serverId = identity.server_id;
    const listing = devices.serviceListing();
    const bound = () => !this.stopped && devices.serviceBinding() === binding && this.options.identity()?.server_id === serverId;
    // every answer is for the listing it asked about: one that a pin or a clear replaced meanwhile decides nothing
    const current = () => bound() && devices.serviceListing() === listing;
    try {
      if (listing !== undefined) {
        const answer = await this.listingCompleted(identity, { account, listing_id: listing });
        return answer === "changed" || !current() ? "refused" : answer;
      }
      const pinned = await this.pinOldBinding(identity, binding, account, current);
      if (pinned === "confirmed") return bound() && devices.serviceListing() !== undefined ? "confirmed" : "refused";
      // the service did not say, or what it pinned is not confirmed yet: nothing is decided, and the binding stays
      if (pinned === "unreachable") return bound() ? "unreachable" : "refused";
      if (!current()) return "refused";
      devices.clearAccountBinding("unlisted", UNPINNED_CLEAR);
      return "readd";
    } catch { return bound() ? "unreachable" : "refused"; }
  }

  private async listingCompleted(identity: RelayIdentity, scope: CompletionScope): Promise<"confirmed" | "changed" | "unreachable"> {
    try { return completed(await this.confirmCompletion(identity, scope)) ? "confirmed" : "unreachable"; }
    catch (error) { return listingChanged(error) ? "changed" : "unreachable"; }
  }

  /**
   * The one place that says whether a binding from before listings were kept (0.5.9) may name one, and pins it. Two
   * sources count. The completion receipt this PC kept from its bind, when the service still confirms that listing.
   * With no receipt, the service's own word (`listing_admitted` beside `listing_id` in a mailbox answer) that the
   * listing it holds this PC under stands on a one-press admission this PC took: that listing is pinned, then
   * confirmed as every pinned one is. An admission as such is no evidence (a device of the account can list the PC
   * again and admit it with no press here), nor is the account's current listing, which this PC's own mailbox pull
   * would let it complete.
   * `unpinnable`: the service refused the receipt, or said the listing stands on no such admission, or that there is
   * none. `unreachable`: it did not say (no answer, a malformed one, or a service from before the field), which is
   * never a no. What becomes of the binding is the caller's.
   */
  private async pinOldBinding(identity: RelayIdentity, binding: string, account: string, current: () => boolean): Promise<"confirmed" | "unreachable" | "unpinnable"> {
    const receipt = this.completion;
    if (receipt !== null && receipt.account === account) {
      const kept = await this.listingCompleted(identity, receipt);
      if (kept === "confirmed" && current()) this.options.devices.pinServiceListing(binding, receipt.listing_id);
      return kept === "changed" ? "unpinnable" : kept;
    }
    // asked as a pull asks, acknowledging nothing: an answer a pull would reject says nothing
    const said = await this.page(identity, account, null).catch(() => null);
    if (said === null || said.admitted === undefined || said.listing === undefined || (said.listing === null && said.admitted)) return "unreachable";
    if (said.listing === null || !said.admitted) return "unpinnable";
    // the answer is for the binding and account it was asked for
    if (!current()) return "unreachable";
    this.options.devices.pinServiceListing(binding, said.listing);
    // pinned from here on: a listing that changed since the answer is refused as any pinned one's, by the caller
    const now = await this.listingCompleted(identity, { account, listing_id: said.listing });
    return now === "changed" ? "unpinnable" : now;
  }

  /**
   * A PC route of the account's signed list (`/v2/pc/list…`): `body` beside this PC's relay key and a fresh, single-use
   * proof of it, as for its mailbox. Throws AccountServiceRefusal for an answer that is not 2xx. `ready` runs once the
   * proof is made (a request of its own), right before the route's request goes out: what it throws stops that
   * request, so what the caller checks there holds at the moment its body leaves this PC.
   */
  async listRoute(path: string, body: Record<string, unknown>, ready?: () => void): Promise<Record<string, unknown>> {
    const identity = this.options.identity();
    if (!identity) throw new Error("This PC has no relay identity");
    if (this.options.service instanceof Error) throw this.options.service;
    const proof = await this.prove(identity);
    ready?.();
    const answer = await this.call(path, { server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)), ...proof, ...body });
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) throw new Error(`The account service sent a malformed answer to ${path}`);
    return answer;
  }

  /** Drops what this PC remembers of whether `account` keeps a signed list (listNamed): the next ask goes to the account service. */
  forgetListNamed(account: string): void {
    for (const scope of [...this.listNames.keys()]) if (scope.endsWith(` ${account}`)) this.listNames.delete(scope);
  }

  /**
   * This PC joined `account` by the account's signed list under the binding `bindId`, and its copy holds it: it owes
   * the account service the word that its add is complete (POST /v1/pc/complete), which the account's page waits
   * for to show it as more than listed. The listing that receipt names is the one this PC's own mailbox pull names
   * (`with_listing_id`), never an admission: an account with a list takes none (Part D11.9). So what is owed goes on
   * disk now, in the receipt's file, and the next pull that names a listing turns it into the receipt, which is sent
   * once and kept and sent again as any receipt until it is answered. A PC that stops before that pull sends it after
   * its next start. Nothing waits for it, and it never throws.
   */
  listJoined(account: string, bindId: string): void {
    this.listOwed = { account, list_bind_id: bindId };
    this.completion = null;
    this.owedOnDisk = this.writeCompletionFile(this.listOwed);
  }

  /** A join by the list was answered: the pull that turns what it owes into its receipt starts now. It never throws. */
  joinedByList(): void {
    if (!this.stopped) void this.pull().catch(() => undefined);
  }

  private readonly listNames = new Map<string, { readonly list: string | null; readonly at: number }>();

  /**
   * The list the account service names for `account` to this PC (POST /v2/pc/list), or null for none: its word, good
   * for telling a PC in no account that the account keeps a signed list, and for nothing else. Null on a PC that
   * follows no list, which asks nothing. Kept for half a minute. Throws when the service could not be asked.
   */
  async listNamed(account: string, now = Date.now()): Promise<string | null> {
    if (this.options.list === undefined) return null;
    const identity = this.options.identity();
    if (!identity) throw new Error("This PC has no relay identity");
    const scope = `${identity.server_id} ${account}`;
    const kept = this.listNames.get(scope);
    if (kept !== undefined && now - kept.at >= 0 && now - kept.at < LIST_NAMED_MS) return kept.list;
    let list: string | null = null;
    try {
      const said = (await this.listRoute("/v2/pc/list", { account })).list;
      if (typeof said === "string" && isListHash(said)) list = said;
    } catch (error) {
      // the unknown route: an account with no list, one that does not list this PC, a service from before lists
      if (!(error instanceof AccountServiceRefusal && error.status === 404)) throw error;
    }
    this.listNames.set(scope, { list, at: now });
    return list;
  }

  /** `answer`: what this read's own mailbox call named as the PC's listing (a pull's drain, or askListingNamed). */
  private async readSnapshotNow(readmission?: Readmission, answer?: NamedListing): Promise<{ outcome: ReadOutcome | null; adds: number }> {
    const empty = { outcome: null, adds: 0 };
    const snapshot = this.options.snapshot;
    if (!snapshot || this.stopped) return empty;
    const account = snapshot.account();
    const ports = snapshot.ports(readmission);
    if (account === null || ports === null) return empty;
    let adds = 0;
    const used = snapshot.used?.();
    // the binding this read is for: a refusal answers for it alone, never for one made after it to the same account
    const binding = this.options.devices.serviceBinding();
    // A PC a device's link bound lets the account's rows in under the listing the account named at their first read.
    // Another listing since is another add of this PC, made with no word of it: it leaves, as when it is not listed
    const linked = this.options.devices.linkBinding();
    // an answer is for the binding and account it was asked for: one that came back to another names nothing
    const named = answer !== undefined && answer.binding === linked && answer.account === account ? answer.listing : undefined;
    const pinned = linked === null ? undefined : this.options.devices.serviceListing();
    // a PC pinned to its signed list stays in its account whatever listing the service names: it reads on, and the read
    // widens nothing (`widen` below), so the members' signed blocks still reach it
    if (pinned !== undefined && typeof named === "string" && named !== pinned && !this.options.devices.listFollowed()) {
      logAccess({ event: "account.listing.replaced" });
      this.options.devices.clearAccountBinding("unlisted", "account");
      return empty;
    }
    let unlisted = false;
    let step2Off = false;
    try {
      let staged: Awaited<ReturnType<typeof stageMailboxAdds>> = [];
      const outcome = await readSnapshot(async (cursor) => {
        if (cursor.page === 0) staged = await stageMailboxAdds(this.pending);
        const page = await this.snapshotPage(account, cursor, used).catch((error: unknown) => {
          if (error instanceof AccountServiceRefusal && error.path === "/v1/pc/snapshot") {
            // A hidden 404 is ambiguous. Only the named refusal can excuse legacy catch-up.
            unlisted = error.status === 403 && error.code === "not_listed";
            if (unlisted) logAccess({ event: "account.snapshot.refused", status: 403, reason: "not_listed" });
            step2Off = error.status === 404 && error.code === "step2_off";
          }
          throw error;
        });
        return page;
      }, { ...ports, scope: () => this.stopped ? null : ports.scope(),
        // the snapshot is whole and checked, so the service answered this PC: the listing's answer is the newest thing the commit rests on
        // one a link bound lets more in only under the listing its rows were let in under, named by this read's own mailbox
        widen: async () => binding !== null ? await this.checkListing(binding) === "confirmed" && this.listingFresh(binding) : pinned === undefined || named === pinned,
        // on a PC pinned to its signed list the rows are the list's: the snapshot's word that a key was removed drops none
        narrow: (snapshot) => { if (!this.options.devices.listFollowed()) this.options.devices.dropListedRemoved(snapshot.removed.map((row) => row.key)); this.options.devices.narrowedRead(); },
        commit: (stage) => {
        // Validate pins and persist the safety decisions before applying staged adds.
        const committedLifts = ports.commit(stage);
        const removed = new Set(stage.snapshot.removed.map((row) => row.key));
        const settled = new Set<unknown>();
        for (const add of staged) {
          if (removed.has(add.key) || !this.pending.includes(add.value)) continue;
          const result = add.commit(this.options.devices, stage.snapshot.server_id, this.gates());
          if (!waits(result)) settled.add(add.value);
          if (result.outcome === "applied") adds++;
        }
        if (settled.size > 0) {
          const pending = this.pending.filter((value) => !settled.has(value));
          if (this.options.pendingPath) writePrivateState(this.options.pendingPath, pending);
          this.pending = pending;
        }
        return committedLifts;
      } });
      if (step2Off && !this.stopped) ports.step2Off?.();
      const devices = this.options.devices;
      // A PC stands in its account on the account's listing of it: once the account stops listing it, it leaves. One a
      // device's link just bound is listed by that device after its link: until then, for a bounded time, it is not yet listed
      if (unlisted && ((binding !== null && devices.serviceBinding() === binding) || (linked !== null && devices.linkBinding() === linked && !devices.awaitsFirstListing()))) devices.clearAccountBinding("unlisted", "account");
      else if (outcome.committed && linked !== null && devices.linkBinding() === linked && typeof named === "string") devices.pinServiceListing(linked, named);
      return { outcome, adds };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return empty;
    }
  }

  /**
   * One press (docs/account.md): the account service's word that `account`, the one this PC's owner named, admitted
   * this PC within the last ten minutes. The admission is spent by this read. Null when there is none (404).
   */
  async admission(account: string): Promise<{ readonly account: string; readonly new_until: string; readonly listing_id?: string } | null> {
    const identity = this.options.identity();
    if (!identity) throw new Error("This PC has no relay identity");
    try {
      // the listing it was admitted in: the completion receipt after the bind names it (an older service names none)
      const answer = (await this.proved(identity, "/v1/pc/admission", { account, with_listing_id: true }))!;
      if (typeof answer.account !== "string" || typeof answer.new_until !== "string") throw new Error("The account service sent a malformed admission");
      const listing = typeof answer.listing_id === "string" && LISTING_ID.test(answer.listing_id) ? { listing_id: answer.listing_id } : {};
      return { account: answer.account, new_until: answer.new_until, ...listing };
    } catch (error) {
      if (error instanceof AccountServiceRefusal && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * This PC is bound to `account` by an admission of `listing_id`: it tells the account service, with a proof scoped to
   * that account and listing (POST /v1/pc/complete, account#57), so its add is complete rather than only listed. Kept on
   * disk first and sent again after each pull until the service has it; never throws. A listing changed or gone since
   * (409 `listing_changed`) ends it: that add is no longer the one to complete.
   */
  async complete(account: string, listingId: string): Promise<void> {
    this.keepCompletion({ account, listing_id: listingId });
    await this.sendCompletion();
  }

  /** The receipt goes on disk first: sendCompletion sends it, now or after a pull. It takes the place of what a join by the list owed. */
  private keepCompletion(scope: CompletionScope): void {
    this.completion = scope;
    this.listOwed = null;
    this.owedOnDisk = true;
    this.writeCompletionFile(scope);
  }

  /** False when the disk did not take it. */
  private writeCompletionFile(value: CompletionScope | ListOwed | null): boolean {
    try { if (this.options.completionPath) writePrivateState(this.options.completionPath, value); }
    catch (error) {
      console.error(`[account] the completion receipt could not be kept: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return true;
  }

  private async confirmCompletion(identity: RelayIdentity, scope: CompletionScope) {
    const devices = this.options.devices;
    const binding = devices.serviceBinding();
    const bound = () => !this.stopped && binding !== null && devices.serviceBinding() === binding && devices.account() === scope.account
      && this.options.identity()?.server_id === identity.server_id;
    try { return await this.proved(identity, "/v1/pc/complete", { ...scope }, false, scope); }
    catch (error) {
      if (listingChanged(error) && bound() && devices.serviceListing() === scope.listing_id) devices.clearAccountBinding("unlisted", "account");
      throw error;
    }
  }

  private async sendCompletion(): Promise<void> {
    const owed = this.listOwed;
    if (owed !== null && this.options.devices.linkBinding() !== owed.list_bind_id) {
      // the binding that joined by its list is gone (Revoke all, its removal): nothing of it is owed any more
      this.listOwed = null;
      if (this.completion === null) this.writeCompletionFile(null);
    } else if (owed !== null && !this.owedOnDisk) {
      // the disk did not take it at the join: offered to it again, so a stop after this pull still sends it
      this.owedOnDisk = this.writeCompletionFile(owed);
    }
    const scope = this.completion;
    const identity = this.options.identity();
    if (scope === null || !identity) return;
    const devices = this.options.devices;
    // a PC that left that account since has nothing of it to complete
    const done = devices.account() !== scope.account;
    // a binding that names no listing yet has this receipt as its proof of one: pinOldBinding spends it
    if (!done && devices.serviceBinding() !== null && devices.serviceListing() === undefined) return;
    // kept until the service takes it or says its listing changed: no other answer says the receipt is spent
    try {
      if (!done && !completed(await this.confirmCompletion(identity, scope))) {
        console.warn("[account] the account service sent no completion time for this PC's completed add");
        return;
      }
    } catch (error) {
      // On a PC pinned to its list the list says the PC is in, not the listing: a final refusal of the receipt drops the
      // receipt, and nothing else (confirmCompletion clears no binding but one on the service's word). A 429, a lapsed
      // proof (401), a request that timed out and a 5xx are no word on the receipt: it is sent again after the next pull
      const final = error instanceof AccountServiceRefusal && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
      const refusedOnList = devices.listFollowed() && final;
      if (!listingChanged(error) && !refusedOnList) {
        console.warn(`[account] the account service did not take this PC's completed add yet: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (this.completion !== scope) return;
    this.completion = null;
    try { if (this.options.completionPath) writePrivateState(this.options.completionPath, null); } catch {}
  }

  /** The waiting records are retried by one run at a time (a pull, or settle), so none of them is ever out of the gate's sight. */
  private turn: Promise<unknown> = Promise.resolve();

  private exclusively<T>(run: () => Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.pull();
    this.timer = setInterval(() => { void this.pull(); }, MAILBOX_PULL_MS);
    this.timer.unref?.();
  }

  /**
   * Whether the account service has an admission at most 10 minutes old naming `key` for this PC's
   * current account and relay identity. A miss pulls again, at most once every 10 seconds, so refused
   * requests cannot make the PC call the service at will.
   */
  currentAdmission(key: string): boolean {
    const account = this.options.devices.account();
    const identity = this.options.identity();
    if (account === null || !identity) return false;
    const at = this.admissions.get(scope(account, identity.server_id, key));
    const now = Date.now();
    return at !== undefined && now - at < ADMISSION_TTL_MS && at <= now + 60_000;
  }

  async admitted(key: string): Promise<boolean> {
    if (this.currentAdmission(key)) return true;
    if (this.pulling) await this.pulling;
    else if (Date.now() - this.lastAskedPull >= ASKED_PULL_MS) {
      this.lastAskedPull = Date.now();
      await this.pull();
    }
    return this.currentAdmission(key);
  }

  /** The account service is turned off on purpose: nothing can be asked of it, so nothing waits for its word. */
  serviceOff(): boolean {
    return this.options.service instanceof AccountServiceOff;
  }

  /** How long until a read for links may start, 0 when one may now (the keep's `service_retry_ms`). */
  serviceRetryMs(): number {
    return Math.max(0, Math.ceil(this.vouchNextAt - this.options.devices.waitClock().now()));
  }

  /**
   * Whether `account` vouched for `key` at this PC: the account service holds a fresh admission for it
   * (docs/account.md, "The account's word"). For a link made while a code made for a PC in no account lives; this PC
   * needs no member for it. It is answered by a read that starts after it was asked, so an admission posted before
   * the link was sent is seen. A read is two calls, the challenge and the mailbox call (which reads, applies and
   * acknowledges nothing), with VOUCH_READ_MS for both; one at a time, and VOUCH_READ_GAP_MS apart, so a flood of
   * links calls the service no more often. A 429 that names a later time starts no read before it, and a link that no
   * read can start for within VOUCH_READ_GAP_MS is answered at once (`unavailable`). So a link waits 15 seconds at most. The service's
   * ordinary admissions count, and its quiet ones (`quiet_admissions`) only for `firstLink`: a
   * device that paired with that code and links as this PC's first member. Never throws.
   */
  vouch(account: string, key: string, firstLink: boolean): Promise<Vouch> {
    const clock = this.options.devices.waitClock();
    const arrivedAt = clock.now();
    if (this.vouchNextAt > arrivedAt + VOUCH_READ_GAP_MS) return Promise.resolve(this.unvouched());
    return new Promise((resolve) => {
      const answer = (vouch: Vouch) => {
        this.vouchWaiters = this.vouchWaiters.filter((waiter) => waiter !== entry);
        resolve(vouch);
      };
      const entry: VouchWaiter = { account, key, firstLink, arrivedAt, answer };
      this.vouchWaiters.push(entry);
      this.nextVouchRead();
    });
  }

  private unvouched(): Vouch {
    return { unavailable: true, retryAfter: Math.max(1, Math.ceil(this.serviceRetryMs() / 1000)) };
  }

  /** Starts the read the oldest waiting link needs, now or when one may start. */
  private nextVouchRead(): void {
    if (this.vouchReading || this.vouchWaiters.length === 0) return;
    const clock = this.options.devices.waitClock();
    const now = clock.now();
    if (now < this.vouchNextAt) {
      this.vouchTimer ??= clock.setTimeout(() => { this.vouchTimer = undefined; this.nextVouchRead(); }, this.vouchNextAt - now);
      return;
    }
    const account = this.vouchWaiters[0]!.account;
    // the links waiting now, and none that comes during the read: a read answers only links that came before it began
    const judged = this.vouchWaiters.filter((waiter) => waiter.account === account);
    this.vouchReading = true;
    this.vouchNextAt = now + VOUCH_READ_GAP_MS;
    void this.readAdmissions(account).then((read) => {
      this.vouchReading = false;
      for (const waiter of judged) {
        waiter.answer(read === null ? this.unvouched() : { vouched: read.ordinary.has(waiter.key) || (waiter.firstLink && read.quiet.has(waiter.key)) });
      }
      // a 429 named a time past the bound of links that came meanwhile: they are answered now, not held
      for (const waiter of [...this.vouchWaiters]) if (this.vouchNextAt > waiter.arrivedAt + VOUCH_READ_GAP_MS) waiter.answer(this.unvouched());
      this.nextVouchRead();
    });
  }

  /** One read of `account`'s admissions for this PC: its ordinary and its quiet ones, or null when it failed. */
  private async readAdmissions(account: string): Promise<{ ordinary: Set<string>; quiet: Set<string> } | null> {
    const service = this.options.service;
    let identity: RelayIdentity | undefined;
    try { identity = this.options.identity(); } catch { return null; }
    if (service instanceof Error || !identity) return null;
    const clock = this.options.devices.waitClock();
    const controller = new AbortController();
    let timedOut: () => void = () => {};
    const late = new Promise<null>((resolve) => { timedOut = () => resolve(null); });
    const cancel = clock.setTimeout(() => { controller.abort(); timedOut(); }, VOUCH_READ_MS);
    const call = async (path: string, body: unknown) => {
      const response = await (this.options.fetch ?? fetch)(new Request(service + path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
      }));
      if (response.status === 429) {
        // a wait it names holds every read back that long; without one, the next read starts VOUCH_READ_GAP_MS after this one
        const wait = retryAfterSeconds(response.headers.get("retry-after"));
        if (wait !== null) this.vouchNextAt = Math.max(this.vouchNextAt, clock.now() + Math.min(wait * 1000, VOUCH_RETRY_MAX_MS));
      }
      if (!response.ok) throw new Error(`The account service answered ${response.status} to ${path}`);
      return await response.json() as Record<string, unknown>;
    };
    const read = async () => {
      const challenge = await call("/v1/pc/challenge", { server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)) });
      if (typeof challenge.challenge_id !== "string") return null;
      const proof = answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key),
        { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id });
      if (!proof) return null;
      const mailbox = await call("/v1/pc/mailbox", { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof, account, ack: null });
      return { ordinary: admissionKeys(mailbox.admissions), quiet: admissionKeys(mailbox.quiet_admissions) };
    };
    try { return await Promise.race([read().catch(() => null), late]); }
    finally { cancel(); }
  }

  /**
   * A sign-in this PC could not accept: a member may have added the device on another PC a moment ago,
   * and its signed add then waits in the mailbox (docs/account.md, "Account service API"). On a PC in
   * an account this joins the pull under way or starts one, and waits for it at most `waitMs`. Such
   * sign-ins start at most one pull a minute, on a count of their own, so sign-ins nobody can check
   * yet cannot make the PC call the service at will; a pull that could not read the mailbox found
   * nothing out, so after it the next may start 10 seconds after it began. What the pull finds is
   * checked and applied like any other record; the caller checks the sign-in again. Never throws.
   */
  async pullForRefusedSignIn(waitMs = SIGN_IN_WAIT_MS, now = Date.now(), readmission?: Readmission): Promise<void> {
    if (this.options.devices.account() === null) return;
    let pull = this.pulling;
    if (!pull) {
      if (now < this.nextSignInPull) return;
      this.nextSignInPull = now + SIGN_IN_PULL_MS;
      pull = this.pull(readmission);
      void pull.then(() => {
        if (this.error !== null) this.nextSignInPull = Math.min(this.nextSignInPull, now + SIGN_IN_PULL_RETRY_MS);
      }, () => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
    try { await Promise.race([pull.then(() => undefined, () => undefined), late]); }
    finally { clearTimeout(timer); }
  }

  /**
   * A pull a drive member's `?fresh=1` asked for: one that starts after the request. True only when it
   * read the whole mailbox without an error, so nothing the service holds for this PC is left unread
   * (docs/account.md, "PC API"); true with no account service at all, as there is no mailbox to read.
   */
  async freshen(): Promise<boolean> {
    if (this.options.service instanceof AccountServiceOff) return this.pendingError === null;
    const asked = Date.now();
    // a pull under way may have read the mailbox before this request: the answer waits for one that starts after it,
    // which every request waiting meanwhile shares (pull)
    if (this.pulling) await this.pulling;
    await this.pull();
    if (this.drainedAt === null || this.drainedAt < asked) return false;
    const account = this.options.devices.account();
    const identity = this.options.identity();
    const current = account === null || !identity ? null : scope(account, identity.server_id, "");
    return this.error === null && current !== null && this.drainedScope === current;
  }

  settle(): Promise<number> {
    return this.exclusively(() => this.settleNow());
  }

  private async settleNow(): Promise<number> {
    const identity = this.options.identity();
    if (!identity || this.pendingError !== null || this.pending.length === 0) return 0;
    const early = this.pending.splice(0);
    this.draining = early;
    try {
      const applied = await this.retry(early, identity.server_id);
      return applied;
    } finally {
      this.pending = [...early, ...this.pending];
      this.draining = [];
      if (this.options.pendingPath) writePrivateState(this.options.pendingPath, this.pending);
    }
  }

  private async retry(early: unknown[], serverId: string): Promise<number> {
    let applied = 0;
    for (let progress = true; progress && early.length;) {
      // A removal listener can shrink `early` during apply. Walk a snapshot and never put its dropped entries back.
      const pass = [...early];
      for (let start = 0; start < pass.length; start += ACCOUNT_RECORDS_MAX) {
        const batch = pass.slice(start, start + ACCOUNT_RECORDS_MAX).filter((record) => early.includes(record));
        const outcomes = await applyAccountRecords(this.options.devices, batch, serverId, Date.now(), { ...this.gates(), deferAdd: this.options.devices.opensAll() ? () => true : undefined });
        applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
        const done = new Set(batch.filter((_record, index) => !waits(outcomes[index])));
        for (let index = early.length - 1; index >= 0; index--) {
          if (done.has(early[index])) early.splice(index, 1);
        }
      }
      progress = early.length !== pass.length;
    }
    return applied;
  }

  /**
   * A `remove` a client relayed (POST /api/account/records) that was refused only because its signer
   * is not a member here yet: kept with the mailbox's own such records, so it applies on the pull after
   * its signer joins (#2956). One already waiting is not kept twice, and none is kept once PENDING_MAX
   * wait: a relayed record never pushes out one that waits already. False when it could not be kept,
   * so the client hears the outcome is undecided and sends it again.
   */
  wait(record: unknown): boolean {
    const waiting = this.waiting();
    const text = JSON.stringify(record);
    if (waiting.some((kept) => JSON.stringify(kept) === text)) return true;
    if (this.pendingError !== null) return false;
    const next = [...this.pending, record];
    // full: a waiting add makes room (it can come again); with none, the remove is undecided and its sender tries again
    if (waiting.length >= PENDING_MAX) {
      if (this.options.devices.opensAll() && removedKey(record) === null) return false;
      const add = next.findIndex((kept) => removedKey(kept) === null);
      if (add === -1) {
        // nowhere to keep it: its key stays out of every add until a pairing here settles it
        const key = removedKey(record);
        if (key !== null) this.options.holds?.hold([key]);
        return false;
      }
      next.splice(add, 1);
    }
    // on disk first, with the ones a pull is retrying, so a stop (or a failed write) loses none of them
    if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...this.draining, ...next]);
    this.pending = next;
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<number> {
    this.drainedListing = undefined;
    const account = this.options.devices.account();
    let identity: RelayIdentity | undefined;
    try { identity = this.options.identity(); } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return 0;
    }
    if (account === null || !identity) return 0;
    const linked = this.options.devices.linkBinding();
    if (this.options.service instanceof Error) { this.error = this.options.service.message; return 0; }
    // a removal refused for a local reason would be acknowledged and lost: collect nothing until it is fixed
    if (this.options.devices.accountError !== null) { this.error = this.options.devices.accountError; return 0; }
    if (this.pendingError !== null) { this.error = this.pendingError; return 0; }
    let applied = 0;
    let ack: number | null = null;
    const early: unknown[] = this.pending.splice(0);
    this.draining = early;
    const retry = async () => { applied += await this.retry(early, identity.server_id); };
    /** On disk before any page that put a record here is acknowledged, so a stop never loses one. */
    const save = () => {
      this.trim(early);
      if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...early, ...this.pending]);
    };
    let complete = false;
    this.drainedAt = null;
    try {
      const admissions = new Map<string, number>();
      await retry();
      for (let page = 0; ; page++) {
        // which PC the answer is for: the binding and relay identity it has as the page is asked for
        const asked = this.options.list?.scopeToken?.();
        const { entries, waiting, listing, list } = await this.page(identity, account, ack);
        if (page === 0 && linked !== null) this.drainedListing = { binding: linked, account, listing };
        // a PC that joined by its list completes its add with the listing its own pull names (listJoined)
        const owed = this.listOwed;
        if (page === 0 && typeof listing === "string" && owed !== null && owed.account === account && owed.list_bind_id === linked && this.options.devices.listFollowed()) {
          this.keepCompletion({ account, listing_id: listing });
        }
        if (page === 0 && list !== undefined) this.tellList(account, list, asked);
        for (const admission of waiting) admissions.set(scope(account, identity.server_id, admission.key), Date.parse(admission.at));
        if (entries.length === 0) { complete = true; break; }
        if (page === MAX_PAGES) break;
        const opensAll = this.options.devices.opensAll();
        const batchSize = opensAll ? 1 : ACCOUNT_RECORDS_MAX;
        for (let start = 0; start < entries.length; start += batchSize) {
          const batch = entries.slice(start, start + batchSize).map(({ record }) => record);
          const record = batch[0];
          if (opensAll && typeof record === "object" && record !== null && "kind" in record && record.kind === "block") {
            // applyBlock owns parseSafetyRecord and signature verification. Never ack an unwritten deny.
            const receipt = await this.options.devices.applyBlock(record, "mailbox");
            if (receipt.outcome === "refused") {
              // The verified block is already in the durable safety queue. Do not postpone later records or the read.
              if (receipt.reason === "unknown_target") continue;
              // Disk/queue failures also return record_invalid, but leave the PC strict.
              if (receipt.reason === "record_invalid" && !this.options.devices.failsClosed) continue;
              throw new Error(`Mailbox block not applied: ${receipt.reason}`);
            }
            if (receipt.outcome === "applied") applied++;
            continue;
          }
          // a remove waiting on its signer joins `early` at once, so an add for its key later in the page meets it
          const queued = new Set<unknown>();
          const keep = (record: unknown) => {
            // Do not requeue one the removal listener dropped between application and outcome processing.
            if (queued.has(record)) return true;
            queued.add(record);
            const text = JSON.stringify(record);
            if (!early.some((kept) => JSON.stringify(kept) === text)) early.push(record);
            return true;
          };
          const gates = this.gates();
          const outcomes = await applyAccountRecords(this.options.devices, batch, identity.server_id, Date.now(), opensAll ? { ...gates, deferAdd: () => true } : gates, keep);
          applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
          outcomes.forEach((outcome, index) => { if (waits(outcome)) keep(batch[index]); });
        }
        await retry();
        save();
        // every record read is acknowledged, refused ones too, so a refused one cannot hold the rest back
        ack = Math.max(...entries.map(({ seq }) => seq));
      }
      save();
      this.pending = [...early, ...this.pending];
      this.draining = [];
      this.admissions = admissions;
      this.lastPullAt = new Date().toISOString();
      this.error = null;
      if (complete) { this.drainedAt = Date.now(); this.drainedScope = scope(account, identity.server_id, ""); }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      try { save(); } catch {}
      this.pending = [...early, ...this.pending];
      this.draining = [];
    }
    return applied;
  }

  /** Never throws: what follows the list is no part of the pull. */
  private tellList(account: string, named: NamedList | null, asked?: string | null): void {
    try { this.options.list?.heard(account, named, asked); }
    catch (error) { console.error(`[account] the list's head was not taken: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private trim(early: unknown[]): void {
    let over = early.length + this.pending.length - PENDING_MAX;
    for (let index = 0; over > 0 && index < early.length;) {
      if (removedKey(early[index]) === null) { early.splice(index, 1); over--; } else index++;
    }
    if (over <= 0) return;
    // the latch is on disk before any remove is dropped: a failed write drops none
    this.options.holds?.overflow();
    early.splice(0, over);
  }

  /** One POST to the account service; `gone` answers 410 with null instead of throwing. */
  private async call(path: string, body: unknown, gone = false): Promise<Record<string, unknown> | null> {
    const response = await (this.options.fetch ?? fetch)(new Request(String(this.options.service) + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    }));
    if (gone && response.status === 410) return null;
    if (!response.ok) throw new AccountServiceRefusal(response.status, await refusalCode(response), path, retryAfterSeconds(response.headers.get("retry-after")));
    return await response.json() as Record<string, unknown>;
  }

  /**
   * A fresh, single-use proof of this PC's relay key for the `account` role: a challenge of the account service, answered.
   * A completion's proof answers for its account and listing alone (account#57): its context is not the wire nonce.
   */
  private async prove(identity: RelayIdentity, completion?: CompletionScope): Promise<{ challenge_id: string; proof: string }> {
    const challenge = (await this.call("/v1/pc/challenge", { server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)), ...(completion ? { completion } : {}) }))!;
    // Rollback exposes the original native property-read error for a JSON null response.
    if ((this.options.devices.opensAll() && challenge === null) || typeof challenge.challenge_id !== "string") throw new Error("The account service sent no challenge");
    const context = completion ? `pc-complete/1:${completion.account}:${completion.listing_id}:${challenge.challenge_id}` : challenge.challenge_id;
    const proof = answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key),
      { server_id: identity.server_id, role: "account", connection_id: context });
    if (!proof) throw new Error("The account service sent a malformed challenge");
    return { challenge_id: challenge.challenge_id, proof };
  }

  /** A PC route called with a fresh proof of this PC's relay key for the `account` role. */
  private async proved(identity: RelayIdentity, path: string, body: Record<string, unknown>, gone = false, completion?: CompletionScope): Promise<Record<string, unknown> | null> {
    return await this.call(path, { server_id: identity.server_id, ...await this.prove(identity, completion), ...body }, gone);
  }

  /**
   * This PC's own proof for its listing (`PUT /v1/pcs/{server_id}` with `challenge_id` and `proof`): only a PUT that carries
   * it lists the PC again within 30 days of its leave (`ovis logout`). Handed to this PC's own window or CLI alone
   * (POST /api/account/pc-proof), which sends it at once: it is spent by that PUT and lapses after a minute.
   */
  async listingProof(): Promise<{ server_id: string; challenge_id: string; proof: string }> {
    const identity = this.options.identity();
    if (!identity) throw new Error("This PC has no relay identity");
    return { server_id: identity.server_id, ...await this.prove(identity) };
  }

  /**
   * One page of the account's snapshot (Step 2, G1; only with OVIS_ACCOUNT_OPENS_ALL): page 0 asks for a new snapshot,
   * every later page names the first page's id. The page is checked by readSnapshot, never here.
   */
  async snapshotPage(account: string, cursor: { snapshot: string | null; page: number }, used?: UsedReport): Promise<PageAnswer> {
    const identity = this.options.identity();
    if (!identity) throw new Error("This PC has no relay identity");
    const page = await this.proved(identity, "/v1/pc/snapshot", { account, page: cursor.page, ...(cursor.snapshot === null ? {} : { snapshot: cursor.snapshot }), ...(cursor.page === 0 && used !== undefined ? { used } : {}) }, true);
    return page === null ? { snapshot_gone: true } : { page };
  }

  private async page(identity: RelayIdentity, account: string, ack: number | null): Promise<{ entries: { seq: number; record: unknown }[]; waiting: { key: string; at: string }[]; listing: string | null | undefined; admitted: boolean | undefined; list: NamedList | null | undefined }> {
    const mailbox = (await this.proved(identity, "/v1/pc/mailbox", { account, ack, with_listing_id: true, ...(this.options.list ? { with_list: true } : {}) }))!;
    const records = mailbox.records;
    if (!Array.isArray(records) || !records.every((entry) => typeof entry === "object" && entry !== null && Number.isSafeInteger((entry as { seq?: unknown }).seq))) {
      throw new Error("The account service sent a malformed mailbox");
    }
    const admissions = Array.isArray(mailbox.admissions) ? mailbox.admissions : [];
    const waiting = admissions.filter((a): a is { key: string; at: string } => typeof a === "object" && a !== null
      && isAccountKeyEncoding((a as { key?: unknown }).key) && typeof (a as { at?: unknown }).at === "string" && !Number.isNaN(Date.parse((a as { at: string }).at)));
    return { entries: records as { seq: number; record: unknown }[], waiting, listing: namedListing(mailbox), admitted: listingAdmitted(mailbox), list: namedList(mailbox) };
  }
}
