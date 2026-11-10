import type { Root } from "react-dom/client";
import type { PendingPushStore } from "../push.ts";
import type { AccountStore } from "../account/store.ts";
import type { EnrollmentState, RelayDeviceStore } from "./device.ts";
import type { openRelayTransport } from "./transport.ts";
import type { checkPc } from "./pcStatus.ts";
import type { offerFromCode } from "./pairCode.ts";
/**
 * What the hosted shell shows before the app: the screens between opening app.ovis.sh and a
 * connected PC, and which one a failed connection lands on. Pure, so the mapping from the
 * channel's errors to a screen is tested without a browser; the screens themselves are
 * components/RelayShell.tsx, and lib/relay/shell.tsx drives them.
 */
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import type { UpdateStep } from "../../../shared/update.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { MyPc } from "../account/myPcs.ts";
import type { AccountProvider, AccountSession } from "../account/store.ts";
import { inNativeApp } from "../nativeApp.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { RelayAdmissionTimeoutError, RelayNewSessionsRefusedError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import type { TypedCodeFailure } from "./pairCode.ts";
import type { RelayDevice } from "./device.ts";
import { formatDashboardHash, isDashboardHash, parseDashboardHash } from "./dashboardRoute.ts";

/** Where a relay key the phone holds came from: the link it opened, or the pairing it saved. */
export type KeySource = "link" | "saved";

/**
 * A key that is not the one a PC id names, as the phone can show it: the id named (a PC's id is a
 * SHA-256 of its real key, server/relay/identity.ts), the id the other key would have (null for a
 * key that does not even parse) and where that key came from. Neither is vouched for here: a link
 * names any id it likes, so the person compares them with the id the PC itself shows. Both come
 * from what the phone holds already, so telling them apart sends nothing to the relay or the PC.
 */
export interface KeyMismatch { expected: string; received: string | null; from: KeySource }

/** The id a relay key would have, or null for a key that does not parse. */
export function keyIdOf(publicKey: string): string | null {
  try { return deriveServerId(importPublicKey(publicKey)); } catch { return null; }
}

/** The first of `keys` that is not the key `serverId` names; null when every one is. */
export function keyMismatch(serverId: string, keys: readonly { key: string; from: KeySource }[]): KeyMismatch | null {
  for (const { key, from } of keys) {
    const received = keyIdOf(key);
    if (received !== serverId) return { expected: serverId, received, from };
  }
  return null;
}

/** Why a connection did not come up; each is a screen with its own `data-relay-state`. */
export type RelayFailure = "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "needs-update" | "revoked" | "identity-changed" | "code-expired" | "pair-declined" | "pair-unavailable" | "bad-offer"
  /** the relay closed a pairing device 4403: the PC's relay pass allows no new device sessions (account limits) */
  | "new-devices-refused"
  /** a PC an introduction named just now refused this device: its mailbox has not brought the add yet */
  | "not-added-yet";

/**
 * Where a PC below MIN_SERVER_VERSION is in its update (skew.ts): its update status being read, an
 * Update button for a managed install, the steps to update by hand for any other, an install
 * under way, the wait for the restarted server, or an install that did not finish.
 */
export type PcUpdate =
  | { phase: "reading" }
  | { phase: "offer" }
  | { phase: "manual" }
  | { phase: "installing"; step: UpdateStep | null }
  | { phase: "restarting" }
  | { phase: "failed"; detail: string | null };

/**
 * The front page's account part: the sign-in buttons, the wait while the provider's pages are up,
 * or the account's PCs (null while they load). Null on a PC's own page, which has no account part.
 */
export type AccountView =
  | { kind: "signed-out"; error: string | null; provider?: AccountProvider }
  | { kind: "signing-in"; provider?: AccountProvider }
  | { kind: "signed-in"; provider: AccountProvider; pcs: MyPc[] | null; error: string | null };

/** Counts only devices this enrollment confirmed, never every member of the account. */
export interface EnrollmentCompletion { readonly state: "complete"; readonly admitted?: number }

export type RelayShellState =
  | { kind: "list"; devices: RelayDevice[]; account?: AccountView | null }
  | { kind: "outdated"; name: string | null; serverVersion: string; minVersion: string; update: PcUpdate }
  | { kind: "empty"; account?: AccountView | null }
  /**
   * Asks before pairing with the PC a link names. `account` is absent on a device that is signed out: the pairing
   * makes a key of its own. Signed in, the pairing uses the account's key and lists the PC in the account, unless
   * its directory lists it already; "checking" until the sign-in is read, when nothing can be confirmed yet.
   * `pressed`: the button was pressed and the press is being checked; what the confirm said then ("own": a key of
   * the device's own) stays on screen meanwhile.
   */
  | { kind: "confirm"; offer: RelayOffer; account?: "checking" | "unlisted" | "listed"; pressed?: "unlisted" | "listed" | "own" }
  | { kind: "connecting"; name: string | null }
  | { kind: "ready"; name: string | null; server_id: string; enrollment?: EnrollmentState | "local" | EnrollmentCompletion }
  /** Pair with a code: the field to type it in, with why the last code gave no PC */
  | { kind: "code-entry"; failure: TypedCodeFailure | null }
  | { kind: "code-looking" }
  /** a typed code found a PC: its full ID to compare with the PC's screen before anything is paired */
  | { kind: "code-compare"; offer: RelayOffer }
  /** pairing without a code: the digits to compare with the PC's screen; `confirmed` once this phone said they match */
  | { kind: "compare"; name: string | null; digits: string; confirmed: boolean; /** the digits are typed from the PC's screen, never shown here */ typed?: boolean; /** the typed digits were not the PC's: the comparison ended */ wrong?: boolean; /** Changes only when a fresh comparison arrives, so the view clears old digits. */ challenge?: number }
  /** the phone's key for a PC whose identity changed is gone; only a new QR code from the PC pairs it again */
  | { kind: "forgotten"; name: string | null }
  /** a link with another key under a PC's id (forgedOffer): refused every time, and no saved key is touched */
  | { kind: "forged"; name: string | null; mismatch: KeyMismatch | null }
  /** `mismatch`: on identity-changed, the key that is not the PC's, when the phone can name it; `server_id`: the PC a connection attempt failed for */
  | { kind: "failed"; failure: RelayFailure; name: string | null; detail: string | null; mismatch?: KeyMismatch | null; server_id?: string };

/** The page a shell load is: the PC its path names and the offer its fragment carried, if any. */
export interface ShellEntry {
  serverId: string | null;
  offer: RelayOffer | null;
  /** the fragment held an offer that does not parse, or one for another PC than the path's */
  damaged: boolean;
}

export function shellEntry(url: string): ShellEntry {
  const serverId = serverIdOfPath(new URL(url).pathname);
  try {
    const offer = decodeOffer(url);
    return { serverId, offer, damaged: false };
  } catch {
    return { serverId, offer: null, damaged: true };
  }
}

/**
 * An offer whose key is not the one its PC's id is derived from (server/relay/identity.ts): never
 * that PC's own link, whatever it says, so it is refused like a changed identity, every time it is
 * opened. A PC's own QR code always passes, so only a pairing from the PC itself gets through.
 */
export function forgedOffer(offer: RelayOffer): boolean {
  return keyIdOf(offer.server_public_key) !== offer.server_id;
}

/** The offer a saved PC connects with again: what the pairing offer said, less its one-time code. */
export function offerOf(device: RelayDevice): RelayOffer {
  return { v: 1, server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay, ...(device.name === undefined ? {} : { name: device.name }) };
}

/**
 * The screen a failed connection lands on. `code`: the attempt carried a pairing code; `paired`:
 * it signed with a key the PC had admitted before. The channel's own codes (shared/relay-mux.ts)
 * say what the PC refused; the channel's deadlines (channel.ts) say who stalled: a relay that
 * never assigned the connection could not be reached, a PC that never answered once it had is
 * offline, and a PC that answered but never finished admitting the device is unresponsive.
 */
export function failureOf(error: unknown, attempt: { code: boolean; paired: boolean; compared?: boolean; codeless?: boolean }): RelayFailure {
  if (error instanceof UnsafeRelayDestinationError) return "bad-offer";
  // the relay's own word, whatever the attempt was: the code held or the digits were approved, and the PC's account is past its limits
  if (error instanceof RelayNewSessionsRefusedError) return "new-devices-refused";
  // a link without a code that the PC refused before any digits: no code to blame, and the wire does not say why
  // (pairing paused after failures, three phones already waiting, a serve-only PC)
  if (attempt.codeless && !attempt.code && !attempt.paired && !attempt.compared
    && error instanceof MuxProtocolError && error.code === "auth_failed") return "pair-unavailable";
  // once digits were shown, the PC answered: a refusal or a deadline there means it was not approved in time
  if (attempt.compared && (error instanceof RelayAdmissionTimeoutError
    || error instanceof MuxProtocolError && (error.code === "auth_failed" || error.code === "timeout"))) return "pair-declined";
  if (error instanceof ServerIdentityChangedError) return "identity-changed";
  if (error instanceof RelayUnreachableError) return "relay-unreachable";
  if (error instanceof RelayAdmissionTimeoutError) return "pc-unresponsive";
  if (!(error instanceof MuxProtocolError)) return "relay-unreachable";
  switch (error.code) {
    case "timeout": case "internal_error": case "auth_changed": return "pc-offline";
    case "auth_revoked": return "revoked";
    case "auth_failed": return attempt.code || !attempt.paired ? "code-expired" : "revoked";
    case "unsupported_version": case "unsupported_extension": case "unsupported_transport": return "needs-update";
    default: return "relay-unreachable";
  }
}

/**
 * A link without a code that this phone opened while it still held a key for that PC, refused at
 * sign-in: the PC no longer knows the key (it removed this phone). The link is there to pair again
 * by comparing digits, so the old key goes and the attempt runs once more without it. A code
 * attempt, one already compared, or one that already did this never does.
 */
export function pairsAgainWithoutKey(error: unknown, attempt: { code: boolean; paired: boolean; compared?: boolean; refreshed?: boolean; codeless: boolean }): boolean {
  return attempt.codeless && !attempt.code && !attempt.compared && !attempt.refreshed
    && error instanceof MuxProtocolError && error.code === "auth_failed";
}

/** The failures after which the saved key is no good: the PC removed this phone, or never admitted it. */
export function forgetsDevice(failure: RelayFailure): boolean {
  return failure === "revoked";
}

/** An iPhone or iPad browser tab, where the page's storage may be cleared after a week unvisited; the installed app's is kept. */
export function iosBrowserTab(env: { userAgent: string; maxTouchPoints: number; standalone: boolean | undefined }): boolean {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
  return ios && env.standalone !== true && !inNativeApp();
}

export interface RelayShellMount {
  container: HTMLElement;
  /** the address the page loaded with, offer fragment included (boot.ts took it off the address bar) */
  entryUrl: string;
  /** mounts the app on the container once the transport is set; what it returns is unmounted should the PC turn this phone away later */
  renderApp: () => Root;
  /** draws the shell's screens on the container: react-dom's root by default; tests hand in their own */
  createRoot?: (container: HTMLElement) => Root;
  store?: RelayDeviceStore;
  pendingPush?: PendingPushStore;
  open?: typeof openRelayTransport;
  navigate?: (path: string) => void;
  /** who this phone is, for a new pairing; the browser's user agent by default */
  label?: string;
  /** this shell's package.json version; the build's by default */
  shellVersion?: string;
  /** brings in a newer shell: the worker checks for one, then the page reloads */
  reload?: () => Promise<void>;
  /** finds a PC by a typed code (pairCode.ts); tests hand in their own */
  findByCode?: typeof offerFromCode;
  /** this client's account key and sign-in; the `ovis-account` database by default */
  accountStore?: AccountStore;
  /** the account service's origin; the page's `ovis-account-service` meta by default (shellAccountServiceOf), and no sign-in without one */
  accountService?: string | null;
  /** the sign-ins offered; the page's `ovis-account-providers` meta by default */
  accountProviders?: readonly AccountProvider[];
  accountFetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  /** takes the page to the provider's sign-in; the return comes back to the front page */
  openSignIn?: (url: string) => void;
  /** probes a saved PC for the front page's list (pcStatus.ts); tests hand in their own */
  checkPc?: typeof checkPc;
}


export interface Attempt {
  offer: RelayOffer;
  typed?: boolean;
  code: boolean;
  paired: boolean;
  /** the attempt showed digits to compare: the PC took the pairing without a code */
  compared?: boolean;
  /** opened from a link without a code, to pair by comparing digits */
  codeless?: boolean;
  /** a saved key the PC refused was already dropped for this link (shellState.ts pairsAgainWithoutKey) */
  refreshed?: boolean;
  /** this attempt paired just now: the PC has not seen the key prove itself on this session yet */
  fresh?: boolean;
  /** this attempt paired just now without a code: a member may have approved it, and only then does an introduction follow */
  introducible?: boolean;
  accountEnrollment?: boolean;
  /** the confirm before this pairing said the device gets a key of its own: it uses no account key and joins no account, whoever signed in since */
  accountless?: boolean;
  /** the sign-in the confirm before this pairing was drawn for: the pairing uses its account key and joins its account, and no other's */
  signIn?: AccountSession;
  retryEnrollment?: boolean;
  /** this attempt already tried the key of a link whose answer was lost */
  retriedPending?: boolean;
}


/** Non-secret navigation context only; no labels, offers, keys or input values cross the load here. */
export interface SheetJoin {
  readonly mode: "new" | "join";
  readonly server_id: string;
  readonly returnHash?: string;
}
export function dashboardHash(hash: string): string {
  return isDashboardHash(hash) ? formatDashboardHash(parseDashboardHash(hash)) : "";
}
export function sheetContext(serverId?: string): SheetJoin | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem("ovis-add-pc-sheet") ?? "null");
    sessionStorage.removeItem("ovis-add-pc-sheet");
    if (typeof kept !== "object" || kept === null || !("mode" in kept) || !("server_id" in kept)) return null;
    if ((kept.mode !== "new" && kept.mode !== "join") || kept.server_id !== serverId || typeof kept.server_id !== "string") return null;
    const returnHash = "returnHash" in kept && typeof kept.returnHash === "string" ? dashboardHash(kept.returnHash) : "";
    return { mode: kept.mode, server_id: kept.server_id, ...(returnHash ? { returnHash } : {}) };
  } catch { return null; }
}
export function keepSheetContext(join: SheetJoin): void {
  try { sessionStorage.setItem("ovis-add-pc-sheet", JSON.stringify({ mode: join.mode, server_id: join.server_id, returnHash: dashboardHash(join.returnHash ?? "") })); }
  catch { /* unavailable tab storage leaves the normal standalone confirmation */ }
}
export function typedJoin(serverId: string): boolean {
  try { return sessionStorage.getItem("ovis-typed-join") === serverId; } catch { return false; }
}
export function keepTypedJoin(serverId: string | null): void {
  try { if (serverId === null) sessionStorage.removeItem("ovis-typed-join"); else sessionStorage.setItem("ovis-typed-join", serverId); }
  catch { /* the ordinary comparison remains available without tab storage */ }
}

/** One navigation's consent: only the PC ID, consumed even if the next load has no offer. */
export function keepConfirmedPc(serverId: string): void {
  try { sessionStorage.setItem("ovis-confirmed-pc", serverId); } catch { /* ask again if consent cannot cross the load */ }
}
export function takeConfirmedPc(): string | null {
  try {
    const serverId = sessionStorage.getItem("ovis-confirmed-pc");
    sessionStorage.removeItem("ovis-confirmed-pc");
    return serverId;
  } catch { return null; }
}

/**
 * The PC whose pairing was confirmed as one with a key of this device's own, kept for the load that follows: a reload
 * before the app opened (for a newer shell) starts from the saved pairing, which does not say what was confirmed.
 * Only the PC ID, in this tab, and consumed by the next load whatever it opens.
 */
export function keepDeviceOnlyPc(serverId: string | null): void {
  try { if (serverId === null) sessionStorage.removeItem("ovis-device-only-pc"); else sessionStorage.setItem("ovis-device-only-pc", serverId); }
  catch { /* the choice cannot cross the load: the reloaded page opens the PC as a saved one */ }
}
export function takeDeviceOnlyPc(): string | null {
  try {
    const serverId = sessionStorage.getItem("ovis-device-only-pc");
    sessionStorage.removeItem("ovis-device-only-pc");
    return serverId;
  } catch { return null; }
}
