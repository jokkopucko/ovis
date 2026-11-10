/**
 * The PC's mailbox at the account service (docs/account.md, "Account service API"): records left for
 * this PC while it was off. The PC signs in with nothing but its relay key, answering a server proof
 * for the `account` role, which the relay itself never accepts. The service can hold records back,
 * never forge one: each is checked and applied like a record a client hands over directly.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { writePrivateState } from "../private-state.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../static.ts";
import { ACCOUNT_RECORDS_MAX, isAccountKey } from "../../shared/account-records.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { AccountHolds } from "./holds.ts";
import { applyAccountRecords, type AddGates, type RecordOutcome } from "./records.ts";

export const MAILBOX_PULL_MS = 5 * 60_000;
/** How old an admission may be for the PC to take an account join outside the pairing window. */
export const ADMISSION_TTL_MS = 10 * 60_000;
/** The least time between two pulls a join that missed asks for. */
const ASKED_PULL_MS = 10_000;
/** The least time between two pulls that refused sign-ins ask for, once one of them read the mailbox. */
export const SIGN_IN_PULL_MS = 60_000;
/** The same after such a pull could not read the mailbox (the service was down, or did not answer): it found nothing out. */
export const SIGN_IN_PULL_RETRY_MS = ASKED_PULL_MS;
/** How long such a sign-in waits for the pull at most; the pull itself goes on. */
export const SIGN_IN_WAIT_MS = 5_000;

function scope(account: string, serverId: string, key: string): string {
  return `${account}\0${serverId}\0${key}`;
}
/** Pages one pull reads at most; the rest waits for the next pull. */
const MAX_PAGES = 20;

/** The account service was turned off on purpose (OVIS_ACCOUNT_SERVICE_URL=off): no mailbox exists, unlike one that is only unusable. */
export class AccountServiceOff extends Error {
  constructor() {
    super("The account service is turned off (OVIS_ACCOUNT_SERVICE_URL=off)");
    this.name = "AccountServiceOff";
  }
}

/** The account service a relay pass is asked of: none when it is turned off, the reason when its address cannot be used. */
export function passAccountService(value?: string): string | Error | undefined {
  try { return accountServiceUrl(value); } catch (error) {
    if (error instanceof AccountServiceOff) return undefined;
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function accountServiceUrl(value = process.env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE): string {
  if (value.trim().toLowerCase() === "off") throw new AccountServiceOff();
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

/** Refusals that keep a record waiting instead of dropping it. */
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
  /** Where records waiting on their signer are kept between pulls; tests leave it out and keep them in memory. */
  readonly pendingPath?: string;
  readonly devices: DeviceStore;
  /** This PC's relay identity, when it has one; its `server_id` names the mailbox. */
  readonly identity: () => RelayIdentity | undefined;
  /** The account service's origin, or why none can be used (a bad OVIS_ACCOUNT_SERVICE_URL), shown as the mailbox's error. */
  readonly service: string | Error;
  readonly fetch?: (request: Request) => Promise<Response>;
  /** The enrollment barrier and held keys (holds.ts); none in tests that do not need them. */
  readonly holds?: AccountHolds;
}

export class AccountMailbox {
  lastPullAt: string | null = null;
  /** The admissions the last pull saw, by account, PC and waiting device's key (`scope`): when each was made. */
  private admissions = new Map<string, number>();
  private lastAskedPull = Number.NEGATIVE_INFINITY;
  /** From when a refused sign-in may start a pull again. */
  private nextSignInPull = Number.NEGATIVE_INFINITY;
  /** When a pull last read the mailbox to its end without an error, and for which account and relay identity (`scope`). */
  private drainedAt: number | null = null;
  private drainedScope: string | null = null;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pulling: Promise<number> | undefined;

  private pending: unknown[];
  /** The waiting records a pull took out of `pending` to retry, until it puts them back. */
  private draining: unknown[] = [];
  /** Why the waiting records cannot be read: no add applies and nothing is pulled until it is fixed. */
  private readonly pendingError: string | null;

  constructor(private readonly options: AccountMailboxOptions) {
    const pending = readPending(options.pendingPath);
    this.pending = pending ?? [];
    this.pendingError = pending === null ? `Cannot read ${options.pendingPath}: account adds wait until it is restored or fixed.` : null;
  }

  /**
   * What holds an add back here (docs/account.md, "Enrolling a PC"): the enrollment barrier, a waiting
   * remove for its key (whatever its signer), a held key, and a queue that is full or cannot be read.
   */
  gates(): AddGates {
    return {
      enrolling: () => this.options.holds?.enrolling() ?? false,
      held: (key) => this.pendingError !== null || this.waiting().some((record) => removedKey(record) === key) || (this.options.holds?.holds(key) ?? false),
      removing: (key) => this.pendingError !== null || this.waiting().some((record) => removedKey(record) === key),
    };
  }

  /** Every add is held back here, whatever its key: the waiting records cannot be read, or removes were lost to a full queue. */
  holdsEveryAdd(): boolean { return this.pendingError !== null || (this.options.holds?.full() ?? false); }

  /** The keys of the removes waiting here: /api/account/status lists them as `blocked`. */
  waitingRemoveKeys(): string[] {
    return [...new Set(this.waiting().flatMap((record) => removedKey(record) ?? []))];
  }

  private waiting(): unknown[] { return [...this.draining, ...this.pending]; }

  /** Pulls now unless a pull is under way; how many records changed something. Never throws. */
  pull(): Promise<number> {
    this.pulling ??= this.exclusively(() => this.drain()).finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  /** The waiting records are retried by one run at a time (a pull, or settle), so none of them is ever out of the gate's sight. */
  private turn: Promise<unknown> = Promise.resolve();

  private exclusively<T>(run: () => Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  start(): void {
    if (this.timer) return;
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

  /**
   * A sign-in this PC could not accept: a member may have added the device on another PC a moment ago,
   * and its signed add then waits in the mailbox (docs/account.md, "Account service API"). On a PC in
   * an account this joins the pull under way or starts one, and waits for it at most `waitMs`. Such
   * sign-ins start at most one pull a minute, on a count of their own, so sign-ins nobody can check
   * yet cannot make the PC call the service at will; a pull that could not read the mailbox found
   * nothing out, so after it the next may start 10 seconds after it began. What the pull finds is
   * checked and applied like any other record; the caller checks the sign-in again. Never throws.
   */
  async pullForRefusedSignIn(waitMs = SIGN_IN_WAIT_MS, now = Date.now()): Promise<void> {
    if (this.options.devices.account() === null) return;
    let pull = this.pulling;
    if (!pull) {
      if (now < this.nextSignInPull) return;
      this.nextSignInPull = now + SIGN_IN_PULL_MS;
      pull = this.pull();
      // whenever it ends, also after this sign-in stopped waiting for it
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
    // with no account service there is no mailbox, so nothing can wait unread in one
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

  /** Retries what waits now, after an enrollment let new members in, instead of on the next pull. */
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

  /** Until a pass applies nothing more, so a chain of adds read in any order still reaches the remove at its end. */
  private async retry(early: unknown[], serverId: string): Promise<number> {
    let applied = 0;
    for (let progress = true; progress && early.length;) {
      progress = false;
      for (let start = 0; start < early.length;) {
        const batch = early.slice(start, start + ACCOUNT_RECORDS_MAX);
        // a record leaves the list only once its outcome is known: a failure here keeps every one of them
        const outcomes = await applyAccountRecords(this.options.devices, batch, serverId, Date.now(), this.gates());
        const keep = batch.filter((_record, index) => waits(outcomes[index]));
        applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
        if (keep.length !== batch.length) progress = true;
        early.splice(start, batch.length, ...keep);
        start += keep.length;
      }
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
    // waiting on a signer, the barrier or a remove: a later add, in this pull or a later one, may let it apply
    const early: unknown[] = this.pending.splice(0);
    this.draining = early;
    const retry = async () => { applied += await this.retry(early, identity.server_id); };
    /** On disk before any page that put a record here is acknowledged, so a stop never loses one. */
    // with any a client relayed meanwhile (wait), which this.pending holds until the pull ends
    const save = () => {
      this.trim(early);
      if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...early, ...this.pending]);
    };
    let complete = false;
    // a pull that stops short or fails leaves no earlier whole read standing
    this.drainedAt = null;
    try {
      const admissions = new Map<string, number>();
      await retry();
      for (let page = 0; ; page++) {
        // past the last page read, one more call only acknowledges it; what it returns waits for the next pull
        const { entries, waiting } = await this.page(identity, account, ack);
        for (const admission of waiting) admissions.set(scope(account, identity.server_id, admission.key), Date.parse(admission.at));
        if (entries.length === 0) { complete = true; break; }
        if (page === MAX_PAGES) break;
        for (let start = 0; start < entries.length; start += ACCOUNT_RECORDS_MAX) {
          const batch = entries.slice(start, start + ACCOUNT_RECORDS_MAX).map(({ record }) => record);
          // a remove waiting on its signer joins `early` at once, so an add for its key later in the page meets it
          const keep = (record: unknown) => {
            const text = JSON.stringify(record);
            if (!early.some((kept) => JSON.stringify(kept) === text)) early.push(record);
            return true;
          };
          const outcomes = await applyAccountRecords(this.options.devices, batch, identity.server_id, Date.now(), this.gates(), keep);
          applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
          outcomes.forEach((outcome, index) => { if (waits(outcome)) keep(batch[index]); });
        }
        // before this page is acknowledged (with the next request), retry what waited on a signer, and keep the rest on disk
        await retry();
        save();
        // every record read is acknowledged, refused ones too, so a refused one cannot hold the rest back
        ack = Math.max(...entries.map(({ seq }) => seq));
      }
      // still waiting: kept for later pulls, within PENDING_MAX (trim)
      save();
      this.pending = [...early, ...this.pending];
      this.draining = [];
      this.admissions = admissions;
      this.lastPullAt = new Date().toISOString();
      this.error = null;
      if (complete) { this.drainedAt = Date.now(); this.drainedScope = scope(account, identity.server_id, ""); }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      try { save(); } catch { /* the pull's own error is the one to show; what waits stays in memory */ }
      this.pending = [...early, ...this.pending];
      this.draining = [];
    }
    return applied;
  }

  /**
   * Keeps `early` and what was relayed meanwhile within PENDING_MAX: adds go first, oldest first. A
   * waiting remove dropped is evidence lost, so then every add is held back for good (holds.ts) rather
   * than let one in that this remove would have kept out; removes keep flowing either way.
   */
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

  private async page(identity: RelayIdentity, account: string, ack: number | null): Promise<{ entries: { seq: number; record: unknown }[]; waiting: { key: string; at: string }[] }> {
    const call = async (path: string, body: unknown) => {
      const response = await (this.options.fetch ?? fetch)(new Request(String(this.options.service) + path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      }));
      if (!response.ok) throw new Error(`The account service answered ${response.status} to ${path}`);
      return await response.json() as Record<string, unknown>;
    };
    const publicKey = bytesToHex(importPublicKey(identity.public_key));
    const challenge = await call("/v1/pc/challenge", { server_id: identity.server_id, public_key: publicKey });
    if (typeof challenge.challenge_id !== "string") throw new Error("The account service sent no challenge");
    const proof = answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key),
      { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id });
    if (!proof) throw new Error("The account service sent a malformed challenge");
    const mailbox = await call("/v1/pc/mailbox", { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof, account, ack });
    const records = mailbox.records;
    if (!Array.isArray(records) || !records.every((entry) => typeof entry === "object" && entry !== null && Number.isSafeInteger((entry as { seq?: unknown }).seq))) {
      throw new Error("The account service sent a malformed mailbox");
    }
    const admissions = Array.isArray(mailbox.admissions) ? mailbox.admissions : [];
    const waiting = admissions.filter((a): a is { key: string; at: string } => typeof a === "object" && a !== null
      && isAccountKey((a as { key?: unknown }).key) && typeof (a as { at?: unknown }).at === "string" && !Number.isNaN(Date.parse((a as { at: string }).at)));
    return { entries: records as { seq: number; record: unknown }[], waiting };
  }
}
