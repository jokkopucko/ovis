/**
 * Adding the PC this page is on to the account (docs/account.md, "Adding a PC"): signed in on its
 * own screen, the PC lists itself in the account's directory with its relay key, and opens a
 * pairing window whose comparisons only this PC approves. A device already in the account then
 * adds it with one approval: it types the number this PC shows, and the owner approves here.
 */
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import { requestRelayLink } from "../api.ts";
import { apiFetch } from "../api-request-id.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { pcAccountStatus } from "./join.ts";
import { NEW_PC_MS } from "./myPcs.ts";
import type { AccountService } from "./service.ts";

/** The account this PC belongs to; null while it is in none. */
export async function thisPcAccount(): Promise<string | null> {
  return (await pcAccountStatus(apiFetch)).account;
}

/**
 * The account this PC belongs to (null while it is in none), and whether it still waits for its first member's
 * enrollment (docs/account.md, "Enrolling a PC"): until that ends, the account's other devices are not let in.
 */
export async function thisPcMembership(): Promise<{ readonly account: string | null; readonly enrolling: boolean }> {
  const status = await pcAccountStatus(apiFetch);
  return { account: status.account, enrolling: status.account !== null && status.enrolling === true };
}

/** Whether this PC belongs to no account yet: only such a PC offers to be added. */
export async function thisPcInNoAccount(): Promise<boolean> {
  return await thisPcAccount() === null;
}

/**
 * Opens this PC's approve-here pairing window again and nothing else: no directory call, so nothing is listed
 * and no device of the account is rung. A window lost to a restart of Ovis is back with the next call.
 * Answers the id of the PC that opened it (null when its link does not say), so a screen that resumed
 * a wait can tell the PC is the one it waited on.
 */
export async function reopenAddWindow(): Promise<string | null> {
  const { url } = await requestRelayLink({ localOnly: true });
  try { return decodeOffer(url)?.server_id ?? null; } catch { return null; }
}

/** Where a waiting Add this PC screen is kept across a reload of its tab. */
const WAITING_KEY = "ovis-add-pc-waiting";

/**
 * A waiting Add this PC screen, as its tab keeps it for a reload. It is one PC's wait under one account:
 * a tab that now shows another PC, or is signed in to another account, never resumes it.
 */
export interface AddPcWaiting {
  /** the name this PC is listed under */
  readonly name: string;
  /** when the screen stops waiting (ms since the epoch) */
  readonly until: number;
  /** the PC that waits */
  readonly serverId: string;
  /** the account it was listed in */
  readonly account: string;
  /** when it was last listed there (ms since the epoch): the next listing is due `RELIST_MS` after it */
  readonly listedAt: number;
}

function tabStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage ?? null; } catch { return null; }
}

/** The PC this page is scoped to at the hosted app (`/s/<server_id>/`); null on a PC's own address, which names none. */
export function pagePc(): string | null {
  try { return typeof location === "undefined" ? null : serverIdOfPath(location.pathname ?? ""); } catch { return null; }
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The waiting screen this tab kept, expired or not; null when it kept none, one of another shape, or its storage cannot be read. */
export function readAddPcWaiting(): AddPcWaiting | null {
  try {
    const kept = JSON.parse(tabStorage()?.getItem(WAITING_KEY) ?? "null") as Partial<Record<keyof AddPcWaiting, unknown>> | null;
    if (kept === null || typeof kept !== "object") return null;
    const { name, until, serverId, account, listedAt } = kept;
    return typeof name === "string" && time(until) && text(serverId) && text(account) && time(listedAt) ? { name: name.slice(0, 48), until, serverId, account, listedAt } : null;
  } catch { return null; }
}

/** The copies of the Add this PC screen in this page that want to hear of a wait kept or forgotten. */
const watchers = new Set<(waiting: AddPcWaiting | null) => void>();

/**
 * Tells `heard` of every wait this page keeps or forgets from now on (`keepAddPcWaiting`), until the function
 * returned is called: a copy of the screen that shows the offer takes up a wait another copy began.
 */
export function onAddPcWaiting(heard: (waiting: AddPcWaiting | null) => void): () => void {
  watchers.add(heard);
  return () => { watchers.delete(heard); };
}

/** Keeps the waiting screen for a reload of this tab, or forgets it (null). Without storage the screen works as before, not resumed. */
export function keepAddPcWaiting(waiting: AddPcWaiting | null): void {
  try {
    if (waiting === null) tabStorage()?.removeItem(WAITING_KEY);
    else tabStorage()?.setItem(WAITING_KEY, JSON.stringify(waiting));
  } catch { /* a full or blocked storage: the screen only loses its resume */ }
  for (const heard of [...watchers]) heard(waiting);
}

/** This PC as `listThisPc` listed it: its name there, its id, and the account it was listed in (null when no sign-in was stored when the listing began). */
export interface ListedPc { readonly name: string; readonly serverId: string; readonly account: string | null }

/**
 * Why `listThisPc` wrote nothing for a wait: the address answers for another PC now (`pc`), another sign-in
 * or none is stored (`sign-in`), or the wait ended while the listing was on its way (`ended`).
 */
export class AddPcWaitOver extends Error {
  constructor(readonly why: "pc" | "sign-in" | "ended") {
    super(`The wait to add this PC is over: ${why}`);
    this.name = "AddPcWaitOver";
  }
}

/** The wait a listing is made for (`listThisPc`): its PC, its account, and whether it still runs. */
export interface ListedFor {
  readonly serverId: string;
  readonly account: string;
  /** asked right before every write to the directory: false once the wait was stopped or replaced */
  readonly running: () => boolean;
}

/**
 * Lists this PC in the account's directory and opens its approve-here pairing window; the PC as
 * listed. An entry the card would stop showing before the next relist (`RELIST_MS`) is listed anew,
 * which shows the card again and rings the account's devices, so the card lasts as long as this screen waits.
 *
 * Every directory call is made as the sign-in stored when the listing began (`forSignIn`): one made meanwhile
 * (another tab signed out and in) is never written to. Listing again `for` a wait writes nothing, and throws
 * `AddPcWaitOver`, when the PC that answers or the stored account is not the wait's, or the wait no longer runs.
 */
export async function listThisPc(service: AccountService, options: { relistMs: number; for?: ListedFor }): Promise<ListedPc> {
  const wait = options.for;
  const offer = decodeOffer((await requestRelayLink({ localOnly: true })).url);
  if (offer === null) throw new Error("This PC's pairing link did not parse");
  if (wait !== undefined && offer.server_id !== wait.serverId) throw new AddPcWaitOver("pc");
  const session = await service.session();
  if (wait !== undefined && session?.account !== wait.account) throw new AddPcWaitOver("sign-in");
  const directory = session === undefined ? service : service.forSignIn(session);
  const running = (): void => { if (wait !== undefined && !wait.running()) throw new AddPcWaitOver("ended"); };
  const listed = (await directory.listPcs()).find((pc) => pc.server_id === offer.server_id);
  if (listed !== undefined && Date.now() - Date.parse(listed.added_at) >= NEW_PC_MS - options.relistMs) {
    running();
    await directory.deletePc(offer.server_id);
  }
  const name = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  running();
  await directory.putPc(offer.server_id, { label: name, public_key: publicKey, relay: offer.relay });
  // the account this PC now asks its relay pass under (docs/relay.md, "Relay pass"); an older PC has no such route
  if (session) {
    // never in the way of pairing, so not awaited: a failing or hanging setup never holds the pairing wait, and the
    // relay status says when this PC has no pass (404: an Ovis from before relay passes)
    void apiFetch("/api/account/relay-account", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account: session.account }) }).then(
      (named) => { if (!named.ok && named.status !== 404) console.warn("Ovis: this PC did not take the account for its relay pass", named.status); },
      (error: unknown) => console.warn("Ovis: this PC did not take the account for its relay pass", error instanceof Error ? error.name : error),
    );
  }
  return { name, serverId: offer.server_id, account: session?.account ?? null };
}
