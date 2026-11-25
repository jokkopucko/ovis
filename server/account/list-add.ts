/**
 * Adding this PC to an account that has a signed list, with a number on both screens (docs/account.md, "A PC is added
 * to the list"). The account service names the list, which is only its word; what makes it the PC's list is a
 * comparison the service cannot stand in the middle of. The phone that adds the PC commits to a nonce before it sees
 * the PC's, the PC picks its nonce before it sees the phone's, and both show six digits made from the PC's own card
 * (its keys, its relay key and that list id), the phone's key and the two nonces (shared/relay-pair-sas.ts, bound to
 * cardBinding). The person sees the same number on both, says so HERE, and presses Add on the phone. Only that yes
 * names the list: a service that put its own list and its own key in the phone's place shows this PC a number the
 * phone does not show, and nobody says yes to it.
 *
 * The account service carries the four messages on this PC's post of its keys (POST /v2/pc/list/keys,
 * /v2/pc/list/attempt). It may drop, delay or change them: then no number shows, or two numbers differ.
 */
import { randomBytes } from "node:crypto";
import { isListKeyEncoding } from "../../shared/account-list-entry.ts";
import { cardBinding, signCard } from "../../shared/account-list.ts";
import { commitmentHolds, fromBase64Url, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import type { JoinGiven, JoinOutcome, JoinRefusal } from "./list-follow.ts";
import type { PcListKeys } from "./list-keys.ts";

/** How long one Add lasts from its start: the time its card offers Add on the account's devices. */
export const ADD_WINDOW_MS = 10 * 60_000;
/** A number lasts this long from when the PC answered the phone's commitment. */
export const ADD_ATTEMPT_MS = 120_000;
/** The most commitments this PC answers in one Add: each is one number on its screen. */
export const ADD_COMMITMENTS_MAX = 3;
/** The least time between two asks of the account service for the phone's next message. */
export const ADD_POLL_MS = 3_000;
/** The PC's post of its keys lasts ten minutes at the account service; it is made again when it is this old. */
const POST_RENEW_MS = 4 * 60_000;

const VALUE = /^[A-Za-z0-9_-]{43}$/;

export type AddEnd = "timeout" | "attempts" | "cancelled" | JoinRefusal;

/**
 * Where an Add stands, as GET /api/account/list/add answers it (shared/machines.ts ListAddState is the same shape, as
 * the PC's own window reads it). `no_list`: the account service names no list for the account, so the PC is added as before.
 * `waiting`: the PC's card is posted and no phone has asked yet, or its number did not check out. `number`: show
 * `digits` and ask the person whether the phone shows the same. `confirmed`: the person said yes; the PC waits for
 * the entry that adds it. `added`: the PC is in the account by its list. `ended`: nothing was added.
 */
export type AddState =
  | { readonly state: "none" }
  | { readonly state: "no_list"; readonly account: string }
  | { readonly state: "waiting" | "confirmed"; readonly run: string; readonly account: string; readonly list: string; readonly until: string }
  | { readonly state: "number"; readonly run: string; readonly account: string; readonly list: string; readonly digits: string; readonly until: string }
  | { readonly state: "added"; readonly run: string; readonly account: string; readonly list: string }
  | { readonly state: "ended"; readonly run: string; readonly account: string; readonly why: AddEnd }
  /** Asked for another run than the one this PC holds now: that one was replaced, and nothing of the present one is told. */
  | { readonly state: "replaced" };

/**
 * What a yes came to (ListAdd.confirm). `confirmed`: that number was the one on this PC's screen, or the one this
 * run was confirmed with before. `mismatch`: it was not; the number that showed is gone, and the answer names none.
 */
export type ConfirmOutcome = { readonly confirmed: AddState } | { readonly mismatch: true } | { readonly state: "none" | "replaced" };

export interface ListAddDeps {
  /** This PC's relay identity now, its relay key as the list names it, and its own list keys (ListFollow.own); null when it has none. */
  own(): Promise<{ readonly serverId: string; readonly endpoint: string; readonly keys: PcListKeys } | null>;
  /** The list the account service names for `account`, or null (AccountMailbox.listNamed): only its word. Throws when it could not be asked. */
  listNamed(account: string): Promise<string | null>;
  /** A PC route of the list at the account service, with this PC's proof (AccountMailbox.listRoute). */
  call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** ListFollow.joinList: `live` says, at the binding's write, whether this add still stands. */
  join(given: JoinGiven & { readonly live: () => boolean }): Promise<JoinOutcome>;
  /** The PC joined `account` by its list, once: what the account service is told of it, which nothing waits for. It never throws. */
  joined?(account: string): void;
  /** Whether this PC is in `account` pinned to `list` now (its follower's own word): an add that ends finds out how it ended. */
  joinedTo?(account: string, list: string): boolean;
  now(): number;
  /** A clock that only moves forward, in milliseconds, which every lifetime here is counted by (performance.now when unset): setting the PC's clock back gives a number, or an add, no more time. */
  mono?(): number;
  /** The least time between two asks of the account service for the phone's next message: ADD_POLL_MS when unset. */
  readonly pollMs?: number | undefined;
}

interface Attempt { readonly adder: string; readonly commitment: string; readonly nonce: Uint8Array; readonly sentAt: number; readonly digits: string | null }

interface Run {
  /** names this run to whoever started it: its polls, its yes and its cancel say which run they mean */
  readonly id: string;
  readonly account: string;
  readonly list: string;
  readonly serverId: string;
  readonly endpoint: string;
  readonly keys: PcListKeys;
  readonly card: string;
  readonly binding: Uint8Array;
  /** by the clock that only moves forward */
  readonly startedAt: number;
  /** when the add ends, by the PC's own clock: only for showing */
  readonly until: number;
  postedAt: number | null;
  polledAt: number | null;
  answered: number;
  attempt: Attempt | null;
  /** the commitments this run has answered or dropped: none is answered twice */
  readonly seen: Set<string>;
  /** the person at this PC said the phone shows the number this PC showed: the adder whose number it was, and the number */
  confirmed: { readonly adder: string; readonly digits: string } | null;
  /** the person at this PC gave the add up: seen at once, also by a read of the list that is out now */
  cancelled: boolean;
  end: AddState | null;
}

/** The account service could not be asked whether the account keeps a list: no add was started, and none was refused. */
export class ListAddAway extends Error {}

export class ListAdd {
  private run: Run | null = null;
  private none: { readonly account: string } | null = null;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ListAddDeps) {}

  /** A person at this PC starts adding it to `account` (its own window, `ovis add`). An Add under way for that account goes on. */
  start(account: string): Promise<AddState> {
    return this.inTurn(async () => {
      const running = this.run;
      // an add of the relay identity this PC had before a reset was another PC's
      if (running !== null && running.account === account && running.end === null && this.mono() - running.startedAt < ADD_WINDOW_MS
        && running.serverId === (await this.deps.own())?.serverId) return await this.step(running);
      this.run = null;
      this.none = null;
      // not asked: nothing says whether the account keeps a list, and the caller asks again (ListAddAway)
      let list: string | null;
      try { list = await this.deps.listNamed(account); } catch (error) { throw new ListAddAway(error instanceof Error ? error.message : String(error)); }
      if (list === null) { this.none = { account }; return { state: "no_list", account }; }
      // this PC's list keys are made only for an account that keeps a list
      const identity = await this.deps.own();
      const id = randomBytes(8).toString("hex");
      if (identity === null) return { state: "ended", run: id, account, why: "unavailable" };
      const { keys } = identity;
      const card = { key: keys.key, enc: keys.enc, list, endpoint: identity.endpoint, invite: null };
      const run: Run = {
        id, account, list, serverId: identity.serverId, endpoint: identity.endpoint, keys, card: await signCard(card, keys.privateKey), binding: cardBinding(card),
        startedAt: this.mono(), until: this.deps.now() + ADD_WINDOW_MS, postedAt: null, polledAt: null, answered: 0, attempt: null, seen: new Set(), confirmed: null, cancelled: false, end: null,
      };
      this.run = run;
      return await this.step(run);
    });
  }

  /**
   * Where the Add stands now. Each ask takes the phone's next message from the account service, at most every
   * ADD_POLL_MS. `runId`: the run the caller started; another run in its place is `replaced`, and told nothing of.
   */
  state(runId?: string): Promise<AddState> {
    return this.inTurn(async () => {
      if (this.run === null) return this.none !== null && runId === undefined ? { state: "no_list", account: this.none.account } : { state: runId === undefined ? "none" : "replaced" };
      if (runId !== undefined && runId !== this.run.id) return { state: "replaced" };
      return await this.step(this.run);
    });
  }

  /**
   * The person at this PC says the phone shows the same number. `digits` is the number they were shown. Only the
   * number on this PC's screen at that moment confirms. Any other ends that number: it is shown no more, the answer
   * names none, and the device has to ask again. A run that is confirmed already answers `confirmed` only to the number
   * it was confirmed with.
   */
  confirm(digits: string, runId?: string): Promise<ConfirmOutcome> {
    return this.inTurn(async () => {
      const run = this.run;
      if (run === null) return { state: "none" };
      if (runId !== undefined && runId !== run.id) return { state: "replaced" };
      if (run.confirmed !== null) return run.confirmed.digits === digits ? { confirmed: await this.step(run) } : { mismatch: true };
      const attempt = this.live(run);
      if (run.end !== null || attempt === null || attempt.digits === null) return { mismatch: true };
      if (attempt.digits !== digits) {
        // a wrong number ends the attempt: nobody tries the six digits one after another against one number
        run.attempt = null;
        return { mismatch: true };
      }
      run.confirmed = { adder: attempt.adder, digits };
      // the list is read at once
      run.polledAt = null;
      return { confirmed: await this.step(run) };
    });
  }

  /**
   * The person at this PC gave it up, or said the numbers differ: nothing is confirmed, and this Add shows no further
   * number. `runId`: only that run is ended. Marked at once, before its turn: a read of the list that is out now binds
   * nothing after it (step's `live`).
   */
  cancel(runId?: string): Promise<AddState> {
    const asked = this.run;
    if (asked !== null && (runId === undefined || runId === asked.id)) asked.cancelled = true;
    return this.inTurn(async () => {
      const run = this.run;
      if (run === null) return { state: "none" };
      if (runId !== undefined && runId !== run.id) return { state: "replaced" };
      if (run.end === null || run.end.state !== "added") run.end = { state: "ended", run: run.id, account: run.account, why: "cancelled" };
      run.attempt = null;
      run.confirmed = null;
      return run.end;
    });
  }

  private mono(): number { return this.deps.mono?.() ?? performance.now(); }

  /** A confirmed run whose PC is in its account by its list now ends `added` (told once, as a join is); null otherwise. */
  private inBy(run: Run): AddState | null {
    if (run.confirmed === null || run.cancelled || this.deps.joinedTo?.(run.account, run.list) !== true) return null;
    run.end = { state: "added", run: run.id, account: run.account, list: run.list };
    this.deps.joined?.(run.account);
    return run.end;
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.turn.then(work, work);
    this.turn = next.catch(() => undefined);
    return next;
  }

  /** The attempt whose number may still be shown: gone 120 seconds after the PC answered it. */
  private live(run: Run): Attempt | null {
    const attempt = run.attempt;
    if (attempt === null) return null;
    if (this.mono() - attempt.sentAt < ADD_ATTEMPT_MS) return attempt;
    run.attempt = null;
    return null;
  }

  private shown(run: Run): AddState {
    const until = new Date(run.until).toISOString();
    if (run.confirmed !== null) return { state: "confirmed", run: run.id, account: run.account, list: run.list, until };
    const attempt = this.live(run);
    return attempt !== null && attempt.digits !== null
      ? { state: "number", run: run.id, account: run.account, list: run.list, digits: attempt.digits, until: new Date(this.deps.now() + ADD_ATTEMPT_MS - (this.mono() - attempt.sentAt)).toISOString() }
      : { state: "waiting", run: run.id, account: run.account, list: run.list, until };
  }

  private async step(run: Run): Promise<AddState> {
    if (run.end !== null) return run.end;
    const ended = (why: AddEnd): AddState => run.end = { state: "ended", run: run.id, account: run.account, why };
    // a No that waits for its turn ends the add already
    if (run.cancelled) return ended("cancelled");
    const identity = await this.deps.own();
    // a reset relay identity is another PC: this Add was the old one's
    if (identity === null || identity.serverId !== run.serverId) return ended("unavailable");
    // Its ten minutes are over, confirmed or not: nothing is joined after them, whatever the list holds by now. A
    // confirmed add whose PC is in that account by that list already (its first copy reached the disk late) says so
    if (this.mono() - run.startedAt >= ADD_WINDOW_MS) return this.inBy(run) ?? ended("timeout");
    const now = this.mono();
    const asked = run.polledAt !== null && now - run.polledAt < (this.deps.pollMs ?? ADD_POLL_MS);
    if (run.confirmed !== null) {
      if (asked) return this.shown(run);
      run.polledAt = now;
      // The yes named the list and the device whose number it was: only an entry that device signed adds this PC. The
      // binding is written only while this add stands, asked at the write itself: its ten minutes, and the person's No
      const live = () => this.run === run && run.end === null && !run.cancelled && this.mono() - run.startedAt < ADD_WINDOW_MS;
      const joined = await this.deps.join({ account: run.account, list: run.list, by: run.confirmed.adder, live });
      // the time ran out, or the person gave it up, while the list was read: that read joins nothing
      if (run.end !== null) return run.end;
      if (!("joined" in joined)) {
        if (run.cancelled) return ended("cancelled");
        if (this.mono() - run.startedAt >= ADD_WINDOW_MS) return this.inBy(run) ?? ended("timeout");
      }
      if ("joined" in joined) {
        run.end = { state: "added", run: run.id, account: run.account, list: run.list };
        this.deps.joined?.(run.account);
        return run.end;
      }
      if ("refused" in joined) return ended(joined.refused);
      return this.shown(run);
    }
    if (asked) return this.shown(run);
    run.polledAt = now;
    try {
      if (run.postedAt === null || now - run.postedAt >= POST_RENEW_MS) {
        // the same keys each time: other keys would be another card, and drop the comparison under way
        await this.deps.call("/v2/pc/list/keys", { list: run.list, key: run.keys.key, enc: run.keys.enc, card: run.card });
        run.postedAt = now;
      }
      const open = attemptOf((await this.deps.call("/v2/pc/list/attempt", { list: run.list })).attempt);
      await this.take(run, open);
    } catch (error) {
      // the service away, or its refusal: no message came, and no number shows for it
      if (!(error instanceof Error)) throw error;
    }
    if (run.end === null && run.cancelled) return ended("cancelled");
    return run.end ?? this.shown(run);
  }

  /** The phone's side of the attempt as the account service holds it, against what this PC holds of it. */
  private async take(run: Run, open: OpenAttempt | null): Promise<void> {
    // a No that came while the phone's message was asked for answers no commitment, and shows no number
    if (run.cancelled || run.end !== null) return;
    const held = this.live(run);
    if (open === null) return;
    const answer = (nonce: Uint8Array) => this.deps.call("/v2/pc/list/attempt", { list: run.list, commitment: open.commitment, nonce: toBase64Url(nonce) });
    if (held === null || held.commitment !== open.commitment || held.adder !== open.adder) {
      // a commitment this PC has seen before gets no second nonce, and shows no number again
      if (run.seen.has(open.commitment)) return;
      if (run.answered >= ADD_COMMITMENTS_MAX) { run.end = { state: "ended", run: run.id, account: run.account, why: "attempts" }; run.attempt = null; return; }
      run.seen.add(open.commitment);
      run.answered++;
      // a new commitment takes the place of the one before: never two numbers at once
      const nonce = randomPairNonce();
      run.attempt = { adder: open.adder, commitment: open.commitment, nonce, sentAt: this.mono(), digits: null };
      await answer(nonce);
      return;
    }
    if (held.digits !== null) return;
    if (open.reveal === null) {
      // the answer did not arrive: the same nonce again, never another one for this commitment
      if (open.nonce !== toBase64Url(held.nonce)) await answer(held.nonce);
      return;
    }
    // the phone's nonce, held to the commitment it made before it saw this PC's: only then is there a number
    const reveal = fromBase64Url(open.reveal);
    if (!commitmentHolds(fromBase64Url(held.commitment), run.binding, held.adder, reveal)) { run.attempt = null; return; }
    run.attempt = { ...held, digits: pairDigits(run.binding, held.adder, reveal, held.nonce) };
  }
}

interface OpenAttempt { readonly adder: string; readonly commitment: string; readonly nonce: string | null; readonly reveal: string | null }

function attemptOf(value: unknown): OpenAttempt | null {
  if (typeof value !== "object" || value === null) return null;
  const { adder, commitment, nonce, reveal } = value as { adder?: unknown; commitment?: unknown; nonce?: unknown; reveal?: unknown };
  if (typeof adder !== "string" || !isListKeyEncoding(adder) || typeof commitment !== "string" || !VALUE.test(commitment)) return null;
  const value43 = (given: unknown): string | null => typeof given === "string" && VALUE.test(given) ? given : null;
  return { adder, commitment, nonce: value43(nonce), reveal: value43(reveal) };
}
