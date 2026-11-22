/**
 * The PC's mailbox at the account service (docs/account.md, "Account service API"): records left for
 * this PC while it was off. The PC signs in with nothing but its relay key, answering a server proof
 * for the `account` role, which the relay itself never accepts. The service can hold records back,
 * never forge one: each is checked and applied like a record a client hands over directly.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { writePrivateState } from "../private-state.ts";
import { accountServiceOff, DEFAULT_ACCOUNT_SERVICE } from "../../shared/web-policy.ts";
import { ACCOUNT_RECORDS_MAX, isAccountKeyEncoding } from "../../shared/account-records.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { AccountHolds } from "./holds.ts";
import type { Readmission } from "./readmission.ts";
import type { UsedReport } from "../../shared/account-snapshot.ts";
import { readSnapshot, type PageAnswer, type ReadOutcome, type SnapshotPorts } from "./snapshot-read.ts";
import { applyAccountRecords, stageMailboxAdds, type AddGates, type RecordOutcome } from "./records.ts";

/** The account service refused a PC route: its status and error code, when it named one. */
export class AccountServiceRefusal extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly path: string) {
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

export interface AccountMailboxOptions {
  readonly pendingPath?: string;
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

  constructor(private readonly options: AccountMailboxOptions) {
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
      return applied + (await this.readSnapshotNow(readmission)).adds;
    }).finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  /** One whole snapshot read now, in turn with pulls; null when the server gave no snapshot ports or there is nothing to read for. */
  readSnapshot(): Promise<ReadOutcome | null> {
    return this.exclusively(async () => (await this.readSnapshotNow()).outcome);
  }

  private async readSnapshotNow(readmission?: Readmission): Promise<{ outcome: ReadOutcome | null; adds: number }> {
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
    let unlisted = false;
    let step2Off = false;
    try {
      let staged: Awaited<ReturnType<typeof stageMailboxAdds>> = [];
      const outcome = await readSnapshot(async (cursor) => {
        if (cursor.page === 0) staged = await stageMailboxAdds(this.pending);
        return await this.snapshotPage(account, cursor, used).catch((error: unknown) => {
          if (error instanceof AccountServiceRefusal && error.path === "/v1/pc/snapshot") {
            // A hidden 404 is ambiguous. Only the named refusal can excuse legacy catch-up.
            unlisted = error.status === 403 && error.code === "not_listed";
            step2Off = error.status === 404 && error.code === "step2_off";
          }
          throw error;
        });
      }, { ...ports, scope: () => this.stopped ? null : ports.scope(), commit: (stage) => {
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
      // a PC bound in one press stands on the account's listing alone: once the account stops listing it, it leaves
      if (unlisted && binding !== null && this.options.devices.serviceBinding() === binding) this.options.devices.clearAccountBinding("unlisted", "account");
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
  async admission(account: string): Promise<{ readonly account: string; readonly new_until: string } | null> {
    const identity = this.options.identity();
    if (!identity) throw new Error("This PC has no relay identity");
    try {
      const answer = (await this.proved(identity, "/v1/pc/admission", { account }))!;
      if (typeof answer.account !== "string" || typeof answer.new_until !== "string") throw new Error("The account service sent a malformed admission");
      return { account: answer.account, new_until: answer.new_until };
    } catch (error) {
      if (error instanceof AccountServiceRefusal && error.status === 404) return null;
      throw error;
    }
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
  async admitted(key: string): Promise<boolean> {
    const fresh = () => {
      const account = this.options.devices.account();
      const identity = this.options.identity();
      if (account === null || !identity) return false;
      const at = this.admissions.get(scope(account, identity.server_id, key));
      const now = Date.now();
      return at !== undefined && now - at < ADMISSION_TTL_MS && at <= now + 60_000;
    };
    if (fresh()) return true;
    if (this.pulling) await this.pulling;
    else if (Date.now() - this.lastAskedPull >= ASKED_PULL_MS) {
      this.lastAskedPull = Date.now();
      await this.pull();
    }
    return fresh();
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
    const account = this.options.devices.account();
    let identity: RelayIdentity | undefined;
    try { identity = this.options.identity(); } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return 0;
    }
    if (account === null || !identity) return 0;
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
        const { entries, waiting } = await this.page(identity, account, ack);
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
    if (!response.ok) throw new AccountServiceRefusal(response.status, await refusalCode(response), path);
    return await response.json() as Record<string, unknown>;
  }

  /** A PC route called with a fresh proof of this PC's relay key for the `account` role. */
  private async proved(identity: RelayIdentity, path: string, body: Record<string, unknown>, gone = false): Promise<Record<string, unknown> | null> {
    const challenge = (await this.call("/v1/pc/challenge", { server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)) }))!;
    // Rollback exposes the original native property-read error for a JSON null response.
    if ((this.options.devices.opensAll() && challenge === null) || typeof challenge.challenge_id !== "string") throw new Error("The account service sent no challenge");
    const proof = answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key),
      { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id });
    if (!proof) throw new Error("The account service sent a malformed challenge");
    return await this.call(path, { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof, ...body }, gone);
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

  private async page(identity: RelayIdentity, account: string, ack: number | null): Promise<{ entries: { seq: number; record: unknown }[]; waiting: { key: string; at: string }[] }> {
    const mailbox = (await this.proved(identity, "/v1/pc/mailbox", { account, ack }))!;
    const records = mailbox.records;
    if (!Array.isArray(records) || !records.every((entry) => typeof entry === "object" && entry !== null && Number.isSafeInteger((entry as { seq?: unknown }).seq))) {
      throw new Error("The account service sent a malformed mailbox");
    }
    const admissions = Array.isArray(mailbox.admissions) ? mailbox.admissions : [];
    const waiting = admissions.filter((a): a is { key: string; at: string } => typeof a === "object" && a !== null
      && isAccountKeyEncoding((a as { key?: unknown }).key) && typeof (a as { at?: unknown }).at === "string" && !Number.isNaN(Date.parse((a as { at: string }).at)));
    return { entries: records as { seq: number; record: unknown }[], waiting };
  }
}
