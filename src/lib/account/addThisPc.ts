/**
 * Adding the PC this page is on to the account (docs/account.md, "Adding a PC"): signed in on its
 * own screen, the PC lists itself in the account's directory with its relay key, and opens a
 * pairing window whose comparisons only this PC approves. A device already in the account then
 * adds it with one approval: it types the number this PC shows, and the owner approves here.
 * An account that keeps a signed list takes the PC by that list alone (`addByList`).
 */
import type { AccountOs } from "../../../shared/account-asker.ts";
import type { ListAddState } from "../../../shared/machines.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { decodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { ApiError, closeRelayLink, fetchHealth, requestRelayLink, startListAdd } from "../api.ts";
import { apiFetch } from "../api-request-id.ts";
import { deviceOs, isLoopbackHost } from "../phone.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { pcAccountStatus, within } from "./join.ts";
import { NEW_PC_MS } from "./myPcs.ts";
import { noteAct } from "./seenPcs.ts";
import { ownPcProof } from "./pcProof.ts";
import { AccountServiceError, sameSignIn, type AccountService } from "./service.ts";
import type { AccountSession } from "./store.ts";

/**
 * Whether this window is this PC's own window, as the server's ownWindow judges it (server/dispatch.ts): its owner
 * socket, or the access token on a loopback address (localhost and 127.x included, as the server sees a loopback peer). The server still decides; this only keeps a press it would refuse
 * from costing the account a daily add (one-press PC add, docs/account.md).
 */
export function ownWindowHere(auth: { readonly via?: string } | null | undefined, hostname: string = typeof location === "undefined" ? "" : location.hostname): boolean {
  return auth?.via === "local" || (auth?.via === "token" && isLoopbackHost(hostname));
}

export async function thisPcAccount(): Promise<string | null> {
  return (await pcAccountStatus(apiFetch)).account;
}

/**
 * The account this PC belongs to (null while it is in none), and whether it still waits for its first member's
 * enrollment (docs/account.md, "Enrolling a PC"): until that ends, the account's other devices are not let in.
 */
/** `needsKeys`: in its account, and in the account's list with no key of its own (it came in as the account moved). */
export async function thisPcMembership(): Promise<{ readonly account: string | null; readonly enrolling: boolean; readonly needsKeys: boolean }> {
  const status = await pcAccountStatus(apiFetch);
  return { account: status.account, enrolling: status.account !== null && status.enrolling === true, needsKeys: status.account !== null && status.needsKeys === true };
}

/** Whether this PC belongs to no account yet: only such a PC offers to be added. */
export async function thisPcInNoAccount(): Promise<boolean> {
  return await thisPcAccount() === null;
}

/**
 * Opens this PC's approve-here pairing window again and nothing else: no directory call, so nothing is listed
 * and no device of the account is rung. Returns the PC's ID for wait resumption and the window ID for cleanup.
 */
export async function reopenAddWindow(): Promise<{ readonly serverId: string | null; readonly windowId: string | undefined }> {
  const { url, windowId } = await openAddWindow();
  try { return { serverId: decodeOffer(url)?.server_id ?? null, windowId }; }
  catch { return { serverId: null, windowId }; }
}

export const CLOSE_ANSWER_MS = 60_000;

let closing: Promise<unknown> = Promise.resolve();

/**
 * Only an explicit Stop waiting closes the current window without an ID. Serialize later Add opens
 * after that close; automatic cleanup names its own generation and cannot affect a later open.
 */
export function closeAddWindow(windowId?: string): Promise<{ readonly ok: true }> {
  const sent = closeRelayLink(windowId);
  if (windowId !== undefined) return sent;
  closing = Promise.allSettled([closing, within(CLOSE_ANSWER_MS, sent)]);
  return sent;
}

async function openAddWindow(): Promise<{ readonly url: string; readonly windowId: string | undefined }> {
  for (let seen: Promise<unknown> | null = null; seen !== closing;) { seen = closing; await seen; }
  const { url, window_id } = await requestRelayLink({ localOnly: true });
  return { url, windowId: typeof window_id === "string" && /^[0-9a-f]{32}$/.test(window_id) ? window_id : undefined };
}

/**
 * The system this browser runs, sent with a listing this page makes: where the listing asks to join (a sign-in code's), the
 * account's devices show it on its card, as the link page shows the one its sign-in named. On the PC's own window, the PC's.
 */
function listingOs(): { readonly os?: AccountOs } {
  const os = typeof navigator === "undefined" ? null : deviceOs(navigator.userAgent ?? "", navigator.maxTouchPoints ?? 0);
  return os === null ? {} : { os };
}

/** A POST of `{}` to this PC's own API, as ownPcProof asks it: the answer's JSON, or a rejection naming the refusal. */
async function postToThisPc(path: string): Promise<unknown> {
  const answer = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: "{}" });
  if (!answer.ok) throw new Error(`${path} answered ${answer.status}`);
  return await answer.json();
}

const WAITING_KEY = "ovis-add-pc-waiting";

/**
 * A waiting Add this PC screen, as its tab keeps it for a reload. It is one PC's wait under one account:
 * a tab that now shows another PC, or is signed in to another account, never resumes it.
 */
export interface AddPcWaiting {
  readonly name: string;
  readonly until: number;
  readonly serverId: string;
  readonly account: string;
  readonly listedAt: number;
  /** the PC's add by the account's list that this wait started (`addByList`), which Stop waiting gives up */
  readonly run?: string;
}

const RUN_ID = /^[0-9a-f]{16}$/;

function tabStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage ?? null; } catch { return null; }
}

export function pagePc(): string | null {
  try { return typeof location === "undefined" ? null : serverIdOfPath(location.pathname ?? ""); } catch { return null; }
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

/**
 * Whether the PC that answers this page is `serverId`, read from its health (GET /api/health, `web_ui.server_id`),
 * which opens and changes nothing: a wait asks before it has a window opened or believes "added", so a PC's
 * address that now answers for another PC gets neither. Where the health does not say (an older Ovis), the
 * hosted app's page names the PC it reaches; with neither, nothing says which PC this is and it throws.
 */
export async function pcAnswers(serverId: string): Promise<boolean> {
  const told = (await fetchHealth()).web_ui?.server_id;
  const id = text(told) ? told : pagePc();
  if (id === null) throw new Error("This PC did not say which PC it is");
  return id === serverId;
}
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readAddPcWaiting(): AddPcWaiting | null {
  try {
    const kept = JSON.parse(tabStorage()?.getItem(WAITING_KEY) ?? "null") as Partial<Record<keyof AddPcWaiting, unknown>> | null;
    if (kept === null || typeof kept !== "object") return null;
    const { name, until, serverId, account, listedAt, run } = kept;
    if (run !== undefined && (typeof run !== "string" || !RUN_ID.test(run))) return null;
    return typeof name === "string" && time(until) && text(serverId) && text(account) && time(listedAt) ? { name: name.slice(0, 48), until, serverId, account, listedAt, ...(run === undefined ? {} : { run }) } : null;
  } catch { return null; }
}

const watchers = new Set<(waiting: AddPcWaiting | null) => void>();

export function onAddPcWaiting(heard: (waiting: AddPcWaiting | null) => void): () => void {
  watchers.add(heard);
  return () => { watchers.delete(heard); };
}

export function keepAddPcWaiting(waiting: AddPcWaiting | null): void {
  try {
    if (waiting === null) tabStorage()?.removeItem(WAITING_KEY);
    else tabStorage()?.setItem(WAITING_KEY, JSON.stringify(waiting));
  } catch { /* a full or blocked storage: the screen only loses its resume */ }
  for (const heard of [...watchers]) heard(waiting);
}

export interface ListedPc {
  readonly name: string;
  readonly serverId: string;
  readonly account: string | null;
  readonly membership?: { readonly account: string; readonly enrolling: boolean; readonly needsKeys?: boolean };
}

export class AddPcWaitOver extends Error {
  constructor(readonly why: "pc" | "sign-in" | "ended") {
    super(`The wait to add this PC is over: ${why}`);
    this.name = "AddPcWaitOver";
  }
}

export interface ListedFor {
  readonly serverId: string;
  readonly account: string;
  /** asked before the window is asked for, once it opened, and right before every write to the directory: false once the wait was stopped or replaced */
  readonly running: () => boolean;
}

export interface ListedAs {
  readonly account: string;
  /** asked once the window opened, and right before every write to the directory and to the PC: false once the screen gave the attempt up */
  readonly running: () => boolean;
  /** Right before a directory write is sent; one sent cannot be taken back. */
  readonly writing?: () => void;
}

/**
 * Lists this PC in the account's directory and opens its approve-here pairing window; the PC as
 * listed. An invitation that would expire before the next relist (`RELIST_MS`) is refreshed in place if
 * the service supports it, so the card lasts as long as this screen waits. Only an old service needs a relist.
 *
 * Every directory call is made as the sign-in stored when the listing began (`forSignIn`): one made meanwhile
 * (another tab signed out and in) is never written to. Listing again `for` a wait writes nothing, and throws
 * `AddPcWaitOver`, when the PC that answers or the stored account is not the wait's, or the wait no longer runs;
 * which PC answers is read first from its health (`pcAnswers`), so no window is opened on another PC either.
 * Listing `as` a sign-in that just finished (no press was made) writes nothing either, and throws the same,
 * when the account stored at that read is another one or none, or the attempt was given up. A listing whose
 * wait or attempt ended while its entry was being written does not tell the PC the account either.
 */
export async function listThisPc(service: AccountService, options: { relistMs: number; for?: ListedFor; as?: ListedAs; opened?: (windowId: string) => void }): Promise<ListedPc> {
  const wait = options.for;
  const as = options.as;
  // asked before the window: one is never opened on another PC than the wait's
  if (wait !== undefined && !await pcAnswers(wait.serverId)) throw new AddPcWaitOver("pc");
  // stopped while that was asked: no window is asked for after Stop waiting closed it
  if (wait !== undefined && !wait.running()) throw new AddPcWaitOver("ended");
  const { url, windowId } = await openAddWindow();
  if (windowId !== undefined) options.opened?.(windowId);
  const offer = decodeOffer(url);
  if (offer === null) throw new Error("This PC's pairing link did not parse");
  if (wait !== undefined && offer.server_id !== wait.serverId) throw new AddPcWaitOver("pc");
  // given up while the window was being opened: nothing more is read or written for it
  // (a stopped wait's listing is over at once, so whoever began it closes the late window without waiting for the directory)
  if ((as !== undefined && !as.running()) || (wait !== undefined && !wait.running())) throw new AddPcWaitOver("ended");
  const session = await service.session();
  if (wait !== undefined && session?.account !== wait.account) throw new AddPcWaitOver("sign-in");
  if (as !== undefined && session?.account !== as.account) throw new AddPcWaitOver("sign-in");
  const directory = session === undefined ? service : service.forSignIn(session);
  const runs = (): boolean => (wait === undefined || wait.running()) && (as === undefined || as.running());
  const running = (): void => { if (!runs()) throw new AddPcWaitOver("ended"); as?.writing?.(); };
  const listed = (await directory.listPcs()).find((pc) => pc.server_id === offer.server_id);
  const name = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const result = { name, serverId: offer.server_id, account: session?.account ?? null };
  const readMembership = async (): Promise<ListedPc["membership"]> => {
    if (!runs()) throw new AddPcWaitOver("ended");
    const { account, enrolling, needsKeys } = await thisPcMembership();
    if (!runs()) throw new AddPcWaitOver("ended");
    return account === null ? undefined : { account, enrolling, needsKeys };
  };
  // A first link or one-press bind can finish while the listing is being read. A refresh must not remove it.
  const membership = await readMembership();
  if (membership !== undefined) return { ...result, membership };
  // only an old service omits the ID; a row with an unusable one is a malformed answer, whatever its age: nothing is written for it
  if (listed?.listing_id === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent an unusable listing ID");
  let refreshed = false;
  // an add the account already holds as complete is no invitation to renew: a PC out of that account is added again by a new press
  const completed = typeof listed?.completed_at === "string";
  if (listed !== undefined && !completed && Date.now() - Date.parse(listed.invited_at ?? listed.added_at) >= NEW_PC_MS - options.relistMs) {
    running();
    const outcome = await directory.refreshPc(offer.server_id, listed.listing_id);
    // A new service preserves an admission even if the PC binds after the first status read. Read again
    // both to finish that wait and to keep the local check immediately before any old-service removal.
    const after = await readMembership();
    if (after !== undefined) return { ...result, membership: after };
    switch (outcome) {
      case "refreshed": refreshed = true; break;
      case "changed": throw new AccountServiceError(409, "listing_changed", "This add is no longer waiting for that action");
      case "legacy":
        running();
        await directory.deletePc(offer.server_id);
        break;
      default: outcome satisfies never;
    }
  }
  if (!refreshed) {
    const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
    // this PC's own proof, which alone lists it again after `ovis logout` left the account
    const proof = await ownPcProof(offer.server_id, postToThisPc);
    running();
    await directory.putPc(offer.server_id, { label: name, public_key: publicKey, relay: offer.relay, ...listingOs(), ...proof }, undefined, undefined, { prove: true });
  }
  // The person adds this PC from its own window (the page is on the PC's own address): kept in this device's own
  // record of its PCs, by the relay key of the PC's own pairing link. From any other page the add is one press with
  // no number compared, which proves nothing about whose PC it is, and nothing is kept of it.
  // It only records: a link whose key does not read, or storage that is not there, changes nothing of the add.
  if (session) {
    try {
      const own = typeof location !== "undefined" && isLoopbackHost(location.hostname);
      if (own) void noteAct(session.account, Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), "window").catch(() => undefined);
    } catch { /* nothing is kept of this add */ }
  }
  // the account this PC now asks its relay pass under (docs/relay.md, "Relay pass"); an older PC has no such route
  // (not for a wait or an attempt that ended while the entry was written: nobody waits for this PC under it)
  if (session && runs()) {
    // never in the way of pairing, so not awaited: a failing or hanging setup never holds the pairing wait, and the
    // relay status says when this PC has no pass (404: an Ovis from before relay passes)
    void apiFetch("/api/account/relay-account", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account: session.account, provider: session.provider }) }).then(
      (named) => { if (!named.ok && named.status !== 404) console.warn("Ovis: this PC did not take the account for its relay pass", named.status); },
      (error: unknown) => console.warn("Ovis: this PC did not take the account for its relay pass", error instanceof Error ? error.name : error),
    );
  }
  return result;
}

/**
 * The runs of an add by the list whose number a wait of this page shows (AccountSection, inside the dialog it was
 * pressed in), each with how many waits hold it: the window's own prompt (useOwnWindowPrompts) leaves those numbers to
 * the wait, so one place alone takes the yes, and shows them again once no wait holds them (the dialog closed).
 */
const numbersHeld = new Map<string, number>();
const heldWatchers = new Set<() => void>();

/** A wait shows the number of `run`: until the answer it gives back is called, the window's own prompt leaves it alone. */
export function holdListNumber(run: string): () => void {
  numbersHeld.set(run, (numbersHeld.get(run) ?? 0) + 1);
  for (const heard of [...heldWatchers]) heard();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (numbersHeld.get(run) ?? 1) - 1;
    if (left > 0) numbersHeld.set(run, left); else numbersHeld.delete(run);
    for (const heard of [...heldWatchers]) heard();
  };
}

/** Whether a wait of this page shows the number of `run` now. */
export function listNumberHeld(run: string): boolean {
  return numbersHeld.has(run);
}

/** Hears every change of which numbers waits hold, until the answer is called. */
export function onListNumbersHeld(heard: () => void): () => void {
  heldWatchers.add(heard);
  return () => { heldWatchers.delete(heard); };
}

/** How long `addByList` waits for the PC to take the account's name before it asks for the add all the same. */
export const NAMING_MS = 10_000;

/**
 * What this PC said when asked to add itself by the account's signed list: `none` where the account keeps no list, or
 * this PC has no such add for this window (it follows no list, the window is not its own, or its Ovis has no such route:
 * 403, 404, 405), and the one press goes on as before; `run`: the add under way; `added`: the PC is in the account by
 * its list; `refused`: the PC's refusal code, or why its add ended at once.
 */
export type ByList = { readonly kind: "none" } | { readonly kind: "run"; readonly run: string } | { readonly kind: "added" } | { readonly kind: "refused"; readonly why: string };

/**
 * Asks the PC, just listed under `account`, to add itself by the account's signed list (docs/account.md, "A PC is added
 * to the list"), as `ovis add` asks before any one press: the PC is named that account first, which it adds itself to
 * alone (409 `account_mismatch` otherwise); then it posts its card, and the device that adds it and this PC show one
 * number. Only `none` lets the one press be tried: a 503 `account_unavailable` started nothing, and is no answer
 * that the account keeps no list.
 */
export async function addByList(account: string): Promise<ByList> {
  const post = (path: string) => apiFetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account }) });
  // a naming that fails, or gets no answer within NAMING_MS, is not the end of it: the PC's answer to the add says what it lacks
  await within(NAMING_MS, post("/api/account/relay-account")).catch((error: unknown) => console.warn("Ovis: this PC was not named the account for its add", error instanceof Error ? error.name : error));
  let state: ListAddState;
  try { state = await startListAdd(account); } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 403 || error.status === 404 || error.status === 405) return { kind: "none" };
    return { kind: "refused", why: error.code ?? `http_${error.status}` };
  }
  switch (state.state) {
    case "no_list": return { kind: "none" };
    case "waiting": case "number": case "confirmed": return { kind: "run", run: state.run };
    case "added": return { kind: "added" };
    case "ended": return { kind: "refused", why: state.why };
    // a start answers neither: a PC that does is not one to add this way
    case "none": case "replaced": return { kind: "refused", why: state.state };
  }
}

/**
 * One press (docs/account.md, "One press"): the PC just listed under `account` joins it with no device typing digits,
 * when the account service admits it (a fresh sign-in with two-step sign-in set, within the account's daily cap) and
 * the PC then takes the service's word for that account. The account is the stored sign-in's, never the one the PC
 * was named for: the PC is named it again first, and refuses a press for any other. "refused" on every refusal, an
 * older service or PC included, and once `running` says the attempt is over: the caller keeps today's digit wait.
 * "sign-in-again" when the service refused the sign-in itself (not fresh, or made with a code): a fresh
 * sign-in of this device's own may then add the PC in one press. "no-two-step" when the sign-in has no two-step. `signIn`: that sign-in alone presses (such a fresh one):
 * with another stored in its place since, nothing is asked.
 * `opensAll`: this PC lists account-opens-all/1 (its step-2 switch is on); without it the service is not asked at all,
 * so a PC that would refuse the press spends none of the account's daily adds and rings nobody.
 */
export async function addInOnePress(service: AccountService, serverId: string, account: string, running: () => boolean, opensAll: boolean, signIn?: AccountSession): Promise<OnePress> {
  if (!opensAll) return "refused";
  const stored = await service.session();
  if (stored?.account !== account || (signIn !== undefined && !sameSignIn(stored, signIn)) || !running()) return "refused";
  const session = signIn ?? stored;
  try { await service.forSignIn(session).admitPc(serverId); } catch (error) {
    console.warn("Ovis: the account service did not add this PC in one press", error instanceof Error ? error.name : error);
    if (!(error instanceof AccountServiceError)) return "refused";
    return error.code === "two_step_required" ? "no-two-step" : SIGN_IN_REFUSALS.includes(error.code) ? "sign-in-again" : "refused";
  }
  // another tab signed in to another account while the service answered: this PC is named for nobody
  const still = await service.session();
  if (still === undefined || !sameSignIn(still, session) || !running()) return "refused";
  const post = (path: string) => apiFetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account }) });
  try {
    if (!running()) return "refused";
    const named = await apiFetch("/api/account/relay-account", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account, provider: session.provider }) });
    if (!named.ok || !running()) return "refused";
    const pressed = await post("/api/account/one-press");
    if (!pressed.ok) console.warn("Ovis: this PC did not join in one press", pressed.status);
    return pressed.ok ? "added" : "refused";
  } catch (error) {
    // the PC did not answer (it restarted, the connection dropped): the digit wait is still the way in
    console.warn("Ovis: this PC could not be asked to join in one press", error instanceof Error ? error.name : error);
    return "refused";
  }
}

export type OnePress = "added" | "sign-in-again" | "no-two-step" | "refused";

/**
 * Whether the account still lists `serverId`, read as the stored sign-in of `account`: false once a device of the
 * account denied the PC's request (Deny on its join request removes the listing); null when it could not be read, or
 * another sign-in is stored.
 */
export async function listedInAccount(service: AccountService, serverId: string, account: string): Promise<boolean | null> {
  const session = await service.session();
  if (session?.account !== account) return null;
  try { return (await service.forSignIn(session).listPcs()).some((pc) => pc.server_id === serverId); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

/**
 * the admit refusals a fresh own sign-in may pass (docs/account.md, "One press"). A sign-in without two-step is not
 * one: the same sign-in again is refused again, so it is told what works instead (`no-two-step`)
 */
const SIGN_IN_REFUSALS: readonly string[] = ["session_not_fresh", "own_sign_in_required"];

/**
 * Lists the PC a QR code's offer names in `account`, beside the code: the code is drawn first and the listing never
 * holds it up. The offer gives the PC's relay key, so no
 * other pairing window of the PC is opened or closed for it. Nothing is written
 * when the account lists the PC already, however long ago (listed anew it would ring the account's devices at every
 * code), and nothing at all when the sign-in stored now is another account's than the one the screen showed.
 */
export async function listOfferedPc(service: AccountService, offer: RelayOffer, account: string): Promise<void> {
  const session = await service.session();
  if (session?.account !== account) throw new AddPcWaitOver("sign-in");
  const directory = service.forSignIn(session);
  if ((await directory.listPcs()).some((pc) => pc.server_id === offer.server_id)) return;
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await directory.putPc(offer.server_id, { label: (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48), public_key: publicKey, relay: offer.relay, ...listingOs() }, undefined, undefined, { prove: true });
}
