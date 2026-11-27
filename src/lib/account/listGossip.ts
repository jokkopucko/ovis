/**
 * A device and the PC it has a session with say where their account's signed list stands, and each hands the other the
 * entries it lacks (docs/account-list.md, "Two members meet"): at the start of every session, whenever this device's
 * copy moves its head (a removal it just placed reaches that PC at once), and every few minutes while the session is
 * up. So a removal the account service withholds from a PC reaches it from any device of the account that opens it,
 * one it withholds from this device reaches it from such a PC, and two histories that members signed raise the alarm
 * on both sides.
 *
 * Nothing here decides who is in. What the PC answers is a page this device's own follower takes (takeFromPeer), and
 * what this device hands the PC is taken by the PC's follower: entries prove themselves. Only a PC that selected the
 * list for the session (it is pinned to its list) is asked anything, and only by a device that follows a list: an
 * account with no list, and a PC that follows none, see no request at all.
 */
import { isListHash } from "../../../shared/account-list-entry.ts";
import type { FollowRead, ListHead, ListPage, PeerAsk } from "../../../shared/account-list-follower.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList } from "./accountList.ts";
import { AccountPcError, type PcFetch } from "./join.ts";

/**
 * How many of the two calls (POST /api/account/list/head, /page) this device makes of one PC in a minute: under the 30
 * the PC takes, which it counts by the key it let the device in by, whatever sessions the device opens.
 */
export const GOSSIP_CALLS_PER_MINUTE = 24;
/** How often, in seconds, a device says where it stands while a session is up and nothing else moved. */
export const GOSSIP_SECONDS = 300;
/** The most entries one call hands a PC (the PC takes no more). */
const PAGE_MAX = 256;
/** The most bytes of one answer of the PC that are read, an error's included: 256 entries of the longest are less. */
export const ANSWER_BYTES_MAX = 512 * 1024;
/** How long one call waits for the whole of its answer, in ms. */
export const ANSWER_MS = 10_000;
/** The longest a timer is set for at once, in ms: a longer wait is armed again in pieces. */
const ARM_MAX_MS = GOSSIP_SECONDS * 1000;

/**
 * How one exchange ended.
 *
 * - `none`: this device follows no list, or holds no entry of it: nothing was asked.
 * - `done`: both said where they stand, and what either lacked was handed over as far as it went.
 * - `alarm`: what the PC showed raised this device's alarm (two histories a member signed).
 * - `not_my_list`: the PC follows another list: nothing more is asked of it over this session.
 * - `spent`: the calls of this minute are used: the read goes on at the next exchange, from where it got to.
 * - `limited`: the PC said to wait (429), `retryAfterMs` long.
 * - `unreached`: the PC refused, did not answer, or answered out of form.
 * - `stopped`: the page's list stood for another account, list or member key than the exchange's, or the session was
 *   no longer the one it began on: nothing more was asked, taken or handed.
 */
export type GossipEnd = "none" | "done" | "alarm" | "not_my_list" | "spent" | "limited" | "unreached" | "stopped";

export interface GossipResult {
  readonly end: GossipEnd;
  /** This device's own read of the PC that is not over: the next exchange of the same session asks it, while the device stands where it stood. */
  readonly carry: GossipCarry | null;
  readonly retryAfterMs: number | null;
}

/**
 * What one exchange of a session leaves to the next, while this device stands where it stood (`on`, its head): its
 * own read of the PC that the minute's calls cut short (`read`), and the place the PC last asked for that this device
 * did not hand over yet (`asks`). Each goes on from there: a search for where two histories part ends in a bounded
 * number of exchanges, however deep the place lies.
 */
export interface GossipCarry {
  readonly on: string;
  readonly read: FollowRead | null;
  readonly asks: PeerAsk | null;
}

/** The account, the list and the member key an exchange is for (X3): nothing is said of another, or taken for it. */
export interface GossipScope { readonly account: string | null; readonly list: string; readonly key: string | null }

/** What the page's list stands for now; null while it follows none. */
function scopeOf(list: AccountList): GossipScope | null {
  const head = list.gossip();
  if (head === null) return null;
  const view = list.view();
  return { account: view.account, list: head.list, key: view.devices.find((device) => device.self)?.key ?? null };
}

/** Whether the page's list still stands for `scope`: a member key that one side does not know yet is no other one. */
function inScope(list: AccountList, scope: GossipScope): boolean {
  const now = scopeOf(list);
  return now !== null && now.list === scope.list && now.account === scope.account && (now.key === null || scope.key === null || now.key === scope.key);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const placeOf = (value: unknown): ListPlace | null | undefined =>
  value === null ? null : isRecord(value) && isCount(value.seq) && typeof value.hash === "string" && isListHash(value.hash) ? { seq: value.seq, hash: value.hash } : undefined;
const askOf = (value: unknown, list: string): PeerAsk | null | undefined =>
  value === undefined || value === null ? null : isRecord(value) && value.list === list && (value.after === null || isCount(value.after)) ? { list, after: value.after } : undefined;
const headKey = (head: ListHead | null): string | null => head === null || head.place === null ? null : `${head.list}:${head.place.seq}:${head.place.hash}`;
const result = (end: GossipEnd, carry: GossipCarry | null = null, retryAfterMs: number | null = null): GossipResult => ({ end, carry, retryAfterMs });

/** An answer of the PC longer than ANSWER_BYTES_MAX: nothing of it is read past that. */
class AnswerTooLongError extends Error {
  constructor() {
    super("The PC's answer was longer than any answer of the list's session routes");
    this.name = "AnswerTooLongError";
  }
}

/** A call refused or not answered: how the exchange ends. `carry`: what the next exchange goes on with after a 429's wait. */
function ended(error: unknown, carry: GossipCarry | null = null): GossipResult {
  if (error instanceof AccountPcError && error.status === 429) return result("limited", carry, error.retryAfterMs ?? 60_000);
  if (error instanceof AccountPcError || error instanceof AnswerTooLongError || error instanceof TypeError || error instanceof SyntaxError
    || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))) {
    return result("unreached");
  }
  throw error;
}

/** How long and how big one answer may be (ANSWER_MS, ANSWER_BYTES_MAX); tests make them smaller. */
export interface AnswerLimits { readonly ms?: number; readonly bytes?: number }

/** The body of an answer, read up to `bytes` and until `stop` ends it, whatever the transport does with the signal. */
async function bodyOf(response: Response, bytes: number, stop: AbortSignal): Promise<string> {
  const over = new Promise<never>((_, reject) => {
    if (stop.aborted) reject(stop.reason);
    stop.addEventListener("abort", () => { reject(stop.reason); }, { once: true });
  });
  over.catch(() => {});
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await Promise.race([response.text(), over]);
    if (new TextEncoder().encode(text).byteLength > bytes) throw new AnswerTooLongError();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), over]);
      if (done) break;
      size += value.byteLength;
      if (size > bytes) throw new AnswerTooLongError();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { whole.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(whole);
}

/**
 * One call of the two, as the account's other calls to a PC are made (join.ts `post`), with its answer held to a size
 * and a time: an answer that is longer, or does not end in time, error bodies included, ends the call. Throws the
 * PC's refusal as AccountPcError, with the wait its `retry-after` names.
 */
async function call(fetch: PcFetch, path: string, body: unknown, limits: AnswerLimits): Promise<unknown> {
  const stop = new AbortController();
  const timer = setTimeout(() => { stop.abort(new DOMException("The PC did not answer in time", "TimeoutError")); }, limits.ms ?? ANSWER_MS);
  try {
    const sent = fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body), signal: stop.signal });
    const over = new Promise<never>((_, reject) => { stop.signal.addEventListener("abort", () => { reject(stop.signal.reason); }, { once: true }); });
    over.catch(() => {});
    const response = await Promise.race([sent, over]);
    const text = await bodyOf(response, limits.bytes ?? ANSWER_BYTES_MAX, stop.signal);
    if (!response.ok) {
      let code = "http_error";
      try {
        const said = JSON.parse(text) as { error?: { code?: unknown } };
        if (typeof said.error?.code === "string" && /^[a-z_]{1,40}$/.test(said.error.code)) code = said.error.code;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      const seconds = Number(response.headers.get("retry-after") ?? Number.NaN);
      throw new AccountPcError(response.status, code, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null);
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where to hand a PC entries from, for what it asked: the place it asked for, or, where that lies past the last entry
 * a member signed in its copy (the footing it names beside it: an entry no member signed sits above it there, which the
 * service may have shown it), that footing, where this device holds the very entry at it. Entries a member signed
 * then take the place of what no member signed, and a removal is not kept from the PC by a stranger's entry.
 */
function fromFooting(list: AccountList, asks: PeerAsk, stands: ListPlace | null): number | null {
  if (asks.after === null || stands === null || asks.after <= stands.seq) return asks.after;
  return list.placeAt(stands.seq)?.hash === stands.hash ? stands.seq : asks.after;
}

/**
 * How a hand-over ended: over (`done`), cut by the minute's calls with the place to go on from (`cut`), the exchange's
 * end with the place the failed call handed from (`failed`, `at`), or left off (`stopped`).
 */
type Handed = { readonly done: true } | { readonly cut: PeerAsk } | { readonly failed: GossipResult; readonly at: PeerAsk } | { readonly stopped: true };

/**
 * Hands the PC this device's entries after the place it asked for, and after each place it asks for next, while
 * `spend` allows a call: a later one where it took a page in part and wants the rest (`more`), an earlier one where it
 * looks for where two histories part. Over when the PC stands at this device's last signed entry, asks for a place it
 * was handed already in this hand-over, asks for nothing more, or refused a page. Cut by the budget, it says the
 * place the PC asked for, and the next exchange goes on from there. Left off once `going` says no, before a call and
 * after an answer.
 */
async function handOver(fetch: PcFetch, list: AccountList, first: PeerAsk, spend: () => boolean, limits: AnswerLimits, going: () => boolean): Promise<Handed> {
  const mine = list.gossip();
  if (mine === null || mine.place === null || first.list !== mine.list) return { done: true };
  const target = mine.place.seq;
  const handed = new Set<number | null>();
  let after = first.after;
  for (;;) {
    if ((after !== null && after >= target) || handed.has(after)) return { done: true };
    if (!going()) return { stopped: true };
    const page = list.pageAfter(after, PAGE_MAX);
    // a copy replaced meanwhile, or nothing after that place: nothing is handed over this time
    if (page === null || page.list !== mine.list || page.entries.length === 0) return { done: true };
    if (!spend()) return { cut: { list: mine.list, after } };
    handed.add(after);
    let said: unknown;
    try { said = await call(fetch, "/api/account/list/page", page, limits); } catch (error) { return { failed: ended(error), at: { list: mine.list, after } }; }
    if (!going()) return { stopped: true };
    if (!isRecord(said)) return { failed: result("unreached"), at: { list: mine.list, after } };
    const asks = askOf(said.asks, mine.list);
    // where the PC stands now; and the place it wants next: in either direction, unless it was handed already
    const stands = placeOf(said.place);
    if (asks !== null && asks !== undefined) {
      after = fromFooting(list, asks, stands ?? null);
      continue;
    }
    if (said.verdict !== "caught_up" && said.verdict !== "more") return { done: true };
    if (stands === undefined || stands === null || list.placeAt(stands.seq)?.hash !== stands.hash || (after !== null && stands.seq <= after)) return { done: true };
    after = stands.seq;
  }
}

/** What one exchange may do beyond saying where this device stands. */
export interface ExchangeOptions {
  /** How long and how big one answer may be. */
  readonly limits?: AnswerLimits;
  /**
   * Whether this device hands the PC its entries: only a PC its own copy holds or held (the caller knows which PC the
   * session is with); never one that only names the list's id. Nothing is handed by default.
   */
  readonly hands?: boolean;
  /** Whether this device takes the PC's own entries and asks it for more: false for a PC already known to be out. True by default. */
  readonly takes?: boolean;
  /** The account, the list and the member key the exchange is for: what the page's list stands for at its start by default. */
  readonly scope?: GossipScope;
  /** Whether the exchange may go on (the session is still the one it began on): looked at before each call and after each answer. */
  readonly going?: () => boolean;
}

/**
 * One exchange over a session with a PC that follows the account's list: this device says where it stands; what the
 * PC answers of its own is taken by this device's follower, and what it asks for is handed to it (`hands`), once an
 * exchange. Where this device needs the PC's entries after another place (the PC holds more, or another entry at a
 * place this device holds, or it looks for where two histories part), it asks the PC for them (`asks`), as often as
 * `spend` allows a call. What the calls did not finish, or a 429 cut, goes on at the next exchange (GossipCarry).
 * Once the page's list stands for another account, list or member key than the exchange's (`scope`), or `going` says
 * no, nothing more is asked, taken or handed (`stopped`).
 */
export async function gossipWithPc(fetch: PcFetch, list: AccountList, carried: GossipCarry | null, spend: () => boolean, options: ExchangeOptions = {}): Promise<GossipResult> {
  const limits = options.limits ?? {};
  const hands = options.hands === true;
  const takes = options.takes !== false;
  const start = list.gossip();
  const on = headKey(start);
  if (start === null || on === null) return result("none");
  const scope = options.scope ?? scopeOf(list);
  const going = (): boolean => scope !== null && inScope(list, scope) && options.going?.() !== false;
  if (!going()) return result("stopped");
  const kept = carried !== null && carried.on === on ? carried : null;
  let read: FollowRead | null = kept?.read?.list === start.list ? kept.read : null;
  let handed = false;
  // a hand-over the last exchange's calls cut short goes on first, where the PC left off
  if (kept?.asks != null && hands) {
    const handing = await handOver(fetch, list, kept.asks, spend, limits, going);
    if ("stopped" in handing) return result("stopped");
    if ("failed" in handing) return handing.failed.end === "limited" ? { ...handing.failed, carry: { on, read, asks: handing.at } } : handing.failed;
    if ("cut" in handing) return result("spent", { on, read, asks: handing.cut });
    handed = true;
  }
  let alarm = false;
  for (;;) {
    if (!going()) return result("stopped");
    const mine = list.gossip();
    const here = headKey(mine);
    if (mine === null || mine.place === null || here === null) return result("none");
    if (!spend()) return result("spent", read === null ? null : { on: here, read, asks: null });
    let said: unknown;
    try {
      said = await call(fetch, "/api/account/list/head", { list: mine.list, place: mine.place, ...(read === null ? {} : { asks: { list: read.list, after: read.after } }) }, limits);
    } catch (error) { return ended(error, read === null ? null : { on: here, read, asks: null }); }
    if (!going()) return result("stopped");
    if (!isRecord(said) || typeof said.list !== "string") return result("unreached");
    if (said.list !== mine.list) return result("not_my_list");
    const place = placeOf(said.place);
    const asks = askOf(said.asks, mine.list);
    if (place === undefined || asks === undefined) return result("unreached");
    let next: FollowRead | null = null;
    if (!takes) {
      // a PC already known to be out is handed its removal, and nothing of it is taken
    } else if (isRecord(said.page)) {
      // the PC's own entries, for this device's follower to judge: they prove themselves or count for nothing
      const took = await list.takeFromPeer(said.page as unknown as ListPage, read);
      if (took === null) return result("none");
      if (took.verdict === "fork") alarm = true;
      // a page that could not be saved is acted on, and asked for again at the next exchange rather than read on from
      next = took.saved ? took.read : null;
    } else if (read === null) {
      // the PC answered no page: where it holds more, or another entry at a place this device holds, this device asks
      const compared = list.compare({ list: said.list, place });
      next = compared !== null && (compared.verdict === "behind" || compared.verdict === "differs") ? compared.read : null;
    }
    // what the PC lacks, it asks for: this device hands it over, once an exchange, to a PC its copy holds or held
    if (asks !== null && !handed && hands) {
      handed = true;
      const handing = await handOver(fetch, list, { list: asks.list, after: fromFooting(list, asks, place) }, spend, limits, going);
      if ("stopped" in handing) return result("stopped");
      const now = headKey(list.gossip()) ?? here;
      if ("failed" in handing) return handing.failed.end === "limited" ? { ...handing.failed, carry: { on: now, read: next, asks: handing.at } } : handing.failed;
      if ("cut" in handing) return result(alarm ? "alarm" : "spent", { on: now, read: next, asks: handing.cut });
    }
    if (alarm) return result("alarm");
    // asked, and answered nothing of it (a PC from before this question): it is not asked again this time
    if (next === null || (read !== null && !isRecord(said.page))) return result("done");
    read = next;
  }
}

/**
 * The calls this device may still make of one PC, and the wait that PC asked for (a 429), for one key the PC let it in
 * by: the PC counts its 30 a minute by that key, whatever sessions, tabs or reopenings the device signs in with, so
 * they all draw on one budget.
 */
export interface GossipBudget {
  /**
   * One more call now, where the minute has room and no wait the PC asked for runs: true, and it is counted. `cap`:
   * the calls of the minute this one may be among, the budget's own (GOSSIP_CALLS_PER_MINUTE) by default; the one
   * attempt to hand a PC put out its removal draws on what is left of the PC's own 30.
   */
  spend(cap?: number): boolean;
  /** The PC asked this device to wait `ms` before it calls again. */
  pause(ms: number): void;
  /** How long, in ms, until a call may go: 0 for at once. */
  wait(): number;
}

/** `pause`: how long the wait that ends at `until` was asked for, which bounds it whatever the wall clock does. */
interface BudgetRecord { calls: number[]; until: number; pause: number }

/** What the page keeps of each budget while its own storage holds none (a page with no localStorage): one record a key. */
const budgets = new Map<string, BudgetRecord>();
/** The budgets whose last write the storage refused (a full disk): the page's own record is the one to go by until one is taken. */
const unwritten = new Set<string>();
const BUDGET_PREFIX = "ovis-list-gossip:";
/** The longest wait a PC's `retry-after` is taken for, in ms. */
const PAUSE_MAX_MS = 24 * 60 * 60 * 1000;
/** The calls of a minute the PC takes from one key (server/account/list-follow.ts, PEER_CALLS_PER_MINUTE). */
export const PC_CALLS_PER_MINUTE = 30;

/**
 * The budget of the key `key` names (a PC and the key it let this device in by), shared with every tab of this browser
 * through `storage` (localStorage by default) and with every reopening of the PC in this page. Times are the wall
 * clock, the one clock the tabs share: a call or a wait that stands further ahead of it than it could have been made
 * is dropped, so a clock set back holds nothing back for long.
 */
export function gossipBudget(key: string, options: { readonly perMinute?: number; readonly storage?: Pick<Storage, "getItem" | "setItem"> | null; readonly now?: () => number } = {}): GossipBudget {
  const now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? GOSSIP_CALLS_PER_MINUTE;
  const storage = options.storage !== undefined ? options.storage : (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  const name = BUDGET_PREFIX + key;
  const read = (at: number): BudgetRecord => {
    let held: unknown = budgets.get(name);
    if (storage !== null && !unwritten.has(name)) {
      try { held = JSON.parse(storage.getItem(name) ?? "null"); } catch { held = null; }
    }
    const record = typeof held === "object" && held !== null ? held as Partial<BudgetRecord> : {};
    const calls = Array.isArray(record.calls) ? record.calls.filter((made): made is number => typeof made === "number" && made > at - 60_000 && made <= at + 60_000) : [];
    // a wait lasts no longer from now than it was asked for: one that stands further ahead was set by a clock that
    // has gone back since, and is dropped
    const pause = typeof record.pause === "number" && record.pause > 0 && record.pause <= PAUSE_MAX_MS ? record.pause : 0;
    const until = typeof record.until === "number" && record.until > at && record.until - at <= pause ? record.until : 0;
    return { calls, until, pause: until === 0 ? 0 : pause };
  };
  const write = (record: BudgetRecord): void => {
    budgets.set(name, record);
    if (storage === null) return;
    try {
      storage.setItem(name, JSON.stringify(record));
      unwritten.delete(name);
    } catch {
      // the page's own record stands, and is read in place of an older one the storage still holds
      unwritten.add(name);
    }
  };
  return {
    spend(cap = perMinute) {
      const at = now();
      const record = read(at);
      if (record.until > at || record.calls.length >= cap) return false;
      write({ ...record, calls: [...record.calls, at] });
      return true;
    },
    pause(ms) {
      const at = now();
      const record = read(at);
      const asked = Math.min(Math.max(0, ms), PAUSE_MAX_MS);
      if (at + asked <= record.until) return;
      write({ calls: record.calls, until: at + asked, pause: asked });
    },
    wait() {
      const at = now();
      const record = read(at);
      const full = record.calls.length >= perMinute ? Math.min(...record.calls) + 60_000 - at : 0;
      return Math.max(0, record.until - at, full);
    },
  };
}

/** How long a device that learnt that the PC it has open was put out of the list tries to hand that PC the removal, in ms. */
export const REMOVAL_DELIVERY_MS = 3_000;

/**
 * One bounded attempt over a session the app no longer uses itself: the PC it had open was put out of the account's
 * list, and this device tries to hand that PC the removal over the session it still has, so the PC can know itself
 * out even where the account service withholds it. The attempt can fail (the carrier stays down, the PC does not
 * answer in time, the minute's calls are spent): the PC then learns it only from the service, or from a member at a
 * later session. It takes nothing from that PC (a PC known to be out raises no alarm here), waits
 * within its time for a carrier that is down (a phone that wakes reads its list before its relay is back), and draws
 * on what is left of the PC's own 30 calls of the minute. `pc`: the PC's id, when the caller knows it: a list that
 * never held that PC (another account's, signed in meanwhile) hands it nothing. It hands only what the list that put
 * the PC out holds: where the page's list stands for another account, list or member key by the time the carrier is
 * back, nothing. Over within `ms` whatever the PC does; the caller then closes the session.
 */
export async function deliverOnce(session: GossipSession, list: AccountList | null, budget: GossipBudget, ms = REMOVAL_DELIVERY_MS, pc?: string): Promise<void> {
  if (list === null || list.gossip() === null || (pc !== undefined && !list.knowsPc(pc))) return;
  const scope = scopeOf(list);
  if (scope === null) return;
  const end = new AbortController();
  const timer = setTimeout(() => { end.abort(new DOMException("The PC took too long to be handed its removal", "TimeoutError")); }, ms);
  const over = new Promise<void>((resolve) => { end.signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
  try {
    if (session.route === undefined) {
      // the carrier is down: the attempt waits for it, within its time
      let off: (() => void) | undefined;
      const back = new Promise<void>((resolve) => { off = session.onRouteChange?.(() => { if (session.route !== undefined) resolve(); }); });
      await Promise.race([back, over]);
      off?.();
      if (end.signal.aborted || session.route === undefined) return;
    }
    if (session.followsList !== true || !inScope(list, scope) || (pc !== undefined && !list.knowsPc(pc))) return;
    const fetch: PcFetch = (input, init) => session.fetch(input, { ...init, signal: init?.signal == null ? end.signal : AbortSignal.any([init.signal, end.signal]) });
    const spend = (): boolean => !end.signal.aborted && budget.spend(PC_CALLS_PER_MINUTE);
    const exchange = gossipWithPc(fetch, list, null, spend, { limits: { ms }, hands: true, takes: false, scope, going: () => !end.signal.aborted });
    await Promise.race([exchange.then(() => undefined, () => undefined), over]);
  } finally {
    clearTimeout(timer);
  }
}

/** A session with a PC as this module needs it: the relay transport the app opened. */
export interface GossipSession {
  /** The PC selected the account's list for this session: it is pinned to its list. */
  readonly followsList?: boolean | undefined;
  /** A carrier is up: undefined while the session reconnects. */
  readonly route?: "relay" | "direct" | undefined;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  onRouteChange?(listener: () => void): () => void;
}

export interface KeepGossipOptions {
  /** This page's copy of its account's list, read at every turn: null while there is none. */
  readonly list: () => AccountList | null;
  /**
   * The id of the PC the session is with: this device hands its entries only to a PC its own copy holds or held
   * (AccountList.knowsPc). Without it nothing is handed, and the PC is only told where this device stands.
   */
  readonly pc?: string;
  /** Whether the session is still the one the app has open: once it is not, everything here stops, an exchange under way too. */
  readonly live?: () => boolean;
  /**
   * The account, the list and the member key the session was opened for (a session opened with the list key): its
   * exchanges are bound to them from the first. Without it, to what the page's list stands for at the first exchange.
   */
  readonly scope?: GossipScope;
  /** A clock that only moves forward, in ms. */
  readonly mono?: () => number;
  /**
   * What this session's calls draw on: the PC's and the admitted key's own (gossipBudget), shared with every tab and
   * reopening that signs in to that PC with that key. One of its own by default.
   */
  readonly budget?: GossipBudget;
  /** The calls of a minute of a budget of its own: GOSSIP_CALLS_PER_MINUTE. */
  readonly callsPerMinute?: number;
  /** How long and how big one answer may be. */
  readonly limits?: AnswerLimits;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/**
 * Keeps one session's exchanges (gossipWithPc) going until the returned stop is called or the session is no longer
 * live: at once, at every new carrier of the session (each is a new session at the PC), whenever this device's copy
 * moves its head, and every GOSSIP_SECONDS. One exchange at a time; one asked for meanwhile runs after it. A session
 * whose PC does not follow the list, and a device that follows none, are asked nothing. The session belongs to the
 * account, the list and the member key it was opened for (`scope`), or else of its first exchange: while the page's
 * list is another one (another account signed in on this browser), the PC is told nothing of it, an exchange under
 * way stops there, and once that list is back the exchanges go on. The stop ends an exchange under way too (its call
 * is called off, and nothing of a late answer is taken or followed), and so does a new carrier: what an exchange of
 * the last one found is not this one's.
 */
export function keepListGossip(session: GossipSession, options: KeepGossipOptions): () => void {
  const mono = options.mono ?? (() => performance.now());
  // a page that is closing is not held open by the next turn
  const setTimer = options.setTimer ?? ((run, ms) => { const timer = setTimeout(run, ms); (timer as { unref?: () => void }).unref?.(); return timer; });
  const clearTimer = options.clearTimer ?? ((timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>); });
  let stopped = false;
  let running = false;
  let again = false;
  let carry: GossipCarry | null = null;
  let otherList = false;
  /** The account, the list and the member key this session's exchanges are for (X3). */
  let bound: GossipScope | null = options.scope ?? null;
  let up = session.route !== undefined;
  /** Counts the carriers that came up: an exchange's findings are its carrier's alone. */
  let carrier = 0;
  /** Calls off the exchange under way. */
  let current: AbortController | null = null;
  let watched: AccountList | null = null;
  let unwatch: (() => void) | null = null;
  let lastHead: string | null = null;
  let timer: unknown = null;

  // a budget of its own counts by the session's clock that only moves forward
  const budget = options.budget ?? gossipBudget(`own:${Math.random()}`, { perMinute: options.callsPerMinute ?? GOSSIP_CALLS_PER_MINUTE, storage: null, now: mono });
  const spend = (): boolean => budget.spend();
  // a long wait is armed in pieces: each turn looks at the budget again, and no timer is set past what a browser holds
  const arm = (ms: number): void => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; turn(); }, Math.min(Math.max(0, ms), ARM_MAX_MS));
  };
  // the page's list is read at every turn: one made after this session began is watched from then on
  const watch = (): AccountList | null => {
    const list = options.list();
    if (list !== watched) {
      unwatch?.();
      watched = list;
      lastHead = headKey(list?.gossip() ?? null);
      unwatch = list?.subscribe(() => {
        const head = headKey(list.gossip());
        if (head !== lastHead) { lastHead = head; turn(); }
      }) ?? null;
    }
    return list;
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    current?.abort();
    unwatch?.();
    offRoute?.();
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const turn = (): void => {
    if (stopped) return;
    if (options.live?.() === false) { stop(); return; }
    const list = watch();
    const now = list === null ? null : scopeOf(list);
    // another account's list, another list, or another member key, than the one this session is for: nothing is said of it
    const foreign = bound !== null && now !== null && !inScope(list!, bound);
    if (session.followsList !== true || session.route === undefined || otherList || list === null || now === null || foreign) { arm(GOSSIP_SECONDS * 1000); return; }
    if (bound === null) bound = now;
    else if (bound.key === null && now.key !== null) bound = { ...bound, key: now.key };
    if (running) { again = true; return; }
    const wait = budget.wait();
    if (wait > 0) { arm(wait); return; }
    running = true;
    let left = false;
    const hands = options.pc !== undefined && list.knowsPc(options.pc);
    const at = carrier;
    const off = new AbortController();
    current = off;
    const going = (): boolean => !stopped && at === carrier && options.live?.() !== false;
    const fetch: PcFetch = (input, init) => session.fetch(input, { ...init, signal: init?.signal == null ? off.signal : AbortSignal.any([init.signal, off.signal]) });
    void gossipWithPc(fetch, list, carry, spend, { ...(options.limits === undefined ? {} : { limits: options.limits }), hands, scope: bound, going }).then((result) => {
      // the wait the PC asked for holds over every carrier: it counts the calls by this device's key
      if (result.end === "limited") budget.pause(result.retryAfterMs ?? 60_000);
      // what an exchange of an earlier carrier found is not this one's
      if (at !== carrier) return;
      carry = result.carry;
      if (result.end === "not_my_list") otherList = true;
      // what the calls of this minute did not finish goes on as soon as the budget has room, not at the next timer
      left = result.end === "spent";
    }, (error: unknown) => {
      console.warn("Ovis: the account's list was not compared with this PC", error instanceof Error ? error.name : error);
    }).finally(() => {
      running = false;
      if (current === off) current = null;
      if (stopped) return;
      if (again) { again = false; turn(); return; }
      const wait = budget.wait();
      arm(left || wait > 0 ? wait : GOSSIP_SECONDS * 1000);
    });
  };
  // a carrier that comes up again is a new session at the PC: what was asked over the last one starts afresh. Its
  // calls do not: the PC counts them by this device's key, so a new carrier is no new minute
  const offRoute = session.onRouteChange?.(() => {
    const now = session.route !== undefined;
    if (now && !up) { carrier += 1; current?.abort(); carry = null; otherList = false; up = now; turn(); return; }
    up = now;
  });
  turn();
  return stop;
}
