import type { Root } from "react-dom/client";
import type { HoldState } from "../../../shared/account-devices-api.ts";
import type { PendingPushStore } from "../push.ts";
import type { AccountStore } from "../account/store.ts";
import type { EnrollmentState, ShellDeviceStore } from "./device.ts";
import type { openRelayTransport } from "./transport.ts";
import type { checkPc } from "./pcStatus.ts";
import type { offerFromCode } from "./pairCode.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { decodeOffer, encodeOffer } from "../../../shared/relay-offer.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { UpdateStep } from "../../../shared/update.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { MyPc } from "../account/myPcs.ts";
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountSession, type SignInKey } from "../account/store.ts";
import { inNativeApp } from "../nativeApp.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { RelayAdmissionTimeoutError, RelayNewSessionsRefusedError, RelayRefusedError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import type { TypedCodeFailure } from "./pairCode.ts";
import type { RelayDevice } from "./device.ts";
import { formatDashboardHash, isDashboardHash, parseDashboardHash } from "./dashboardRoute.ts";
import { formatMyMachinesHash, parseMyMachinesHash } from "../account/myMachinesRoute.ts";

export type KeySource = "link" | "saved";

/**
 * A key that is not the one a PC id names, as the phone can show it: the id named (a PC's id is a
 * SHA-256 of its real key, server/relay/identity.ts), the id the other key would have (null for a
 * key that does not even parse) and where that key came from. Neither is vouched for here: a link
 * names any id it likes, so the person compares them with the id the PC itself shows. Both come
 * from what the phone holds already, so telling them apart sends nothing to the relay or the PC.
 */
export interface KeyMismatch { expected: string; received: string | null; from: KeySource }

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

export type RelayFailure = "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "relay-refused" | "needs-update" | "revoked" | "identity-changed" | "code-expired" | "pair-declined" | "pair-unavailable" | "bad-offer"
  /** the relay closed a pairing device 4403: the PC's relay pass allows no new device sessions (account limits) */
  | "new-devices-refused"
  | "not-added-yet"
  /**
   * a code that carries the mark stopped before the pairing, so it was not used: no sign-in, the PC could not be listed
   * in the account, or the account service did not take the admission (firstLink.ts AdmissionRefusedError)
   */
  | "sign-in-first" | "account-unlisted" | "account-busy" | "admission-unanswered" | "admission-failed"
  /** after the pairing, this device's account key changed and the account service did not take the new one: no link was sent */
  | "new-key-unvouched"
  /** the PC refused this device's first link: its code ended or ran out, the code is for another account, or the account service did not vouch for this device */
  | "link-required" | "account-mismatch" | "unverified-device"
  /** the sign-in a marked pairing stopped for took longer than its code is good for: only a new scan pairs */
  | "scan-expired";

export type PcUpdate =
  | { phase: "reading" }
  | { phase: "offer" }
  | { phase: "manual" }
  | { phase: "installing"; step: UpdateStep | null }
  | { phase: "restarting" }
  | { phase: "failed"; detail: string | null };

export type AccountView =
  | { kind: "signed-out"; error: string | null; provider?: AccountProvider; notice?: string }
  | { kind: "signing-in"; provider?: AccountProvider }
  | { kind: "signed-in"; provider: AccountProvider; pcs: MyPc[] | null; error: string | null; deleteError?: string };

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
  | { kind: "confirm"; offer: RelayOffer; account?: "checking" | "unlisted" | "listed"; pressed?: "unlisted" | "listed" | "own"; /** a join a PC's own page offers: its one press, drawn alone */ alone?: true }
  /**
   * `approved`: the PC accepted the pairing, and the account steps go on behind this screen; absent before that.
   * `hold`: the PC's structured account-open refusal; `pairing`: a new pairing, not a saved PC opening again
   */
  | { kind: "connecting"; name: string | null; approved?: true; pairing?: true; readonly hold?: HoldState; readonly keyFingerprint?: string }
  | { kind: "ready"; name: string | null; server_id: string; enrollment?: EnrollmentState | "local" | EnrollmentCompletion }
  | { kind: "code-entry"; failure: TypedCodeFailure | null }
  | { kind: "code-looking" }
  /** a typed code found a PC: its full ID to compare with the PC's screen before anything is paired */
  | { kind: "code-compare"; offer: RelayOffer }
  /** pairing without a code: the digits to compare with the PC's screen; `confirmed` once this phone said they match */
  | { kind: "compare"; name: string | null; digits: string; confirmed: boolean; /** the digits are typed from the PC's screen, never shown here */ typed?: boolean; /** the typed digits were not the PC's: the comparison ended */ wrong?: boolean; challenge?: number; /** a join a PC's own page started for itself: the PC takes the number, nothing is pressed here */ alone?: true }
  /** the phone's key for a PC whose identity changed is gone; only a new QR code from the PC pairs it again */
  | { kind: "forgotten"; name: string | null }
  /** a link with another key under a PC's id (forgedOffer): refused every time, and no saved key is touched */
  | { kind: "forged"; name: string | null; mismatch: KeyMismatch | null }
  /**
   * `mismatch`: on identity-changed, the key that is not the PC's, when the phone can name it; `server_id`: the PC a connection attempt failed for;
   * `account`: on sign-in-first, the sign-in started from this screen (busy, or why it did not finish)
   */
  | { kind: "failed"; failure: RelayFailure; name: string | null; detail: string | null; mismatch?: KeyMismatch | null; server_id?: string; account?: AccountView | null; /** a new pairing failed, not a saved PC opening again */ pairing?: true };

export interface ShellEntry {
  serverId: string | null;
  offer: RelayOffer | null;
  damaged: boolean;
}

/**
 * `#sign-in=<provider>`: a link that opens the hosted shell straight on that provider's sign-in, as one press of its
 * button would. The provider as written, or null; whether the account service offers it is checked where it is used.
 */
export function signInEntry(hash: string): string | null {
  if (!hash.startsWith("#sign-in=")) return null;
  const provider = new URLSearchParams(hash.slice(1)).get("sign-in");
  return provider === null || provider === "" ? null : provider;
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

/** `code`: the attempt carried a pairing code; `paired`: it signed with a key the PC had admitted before. */
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
  if (error instanceof RelayRefusedError) return "relay-refused";
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

/** The failures after which the saved key is no good: the PC removed this phone, or never admitted it. A refused link alone is none of them. */
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
  entryUrl: string;
  /** Whether the tab navigated since `entryUrl` was read (boot.ts watchNavigation); the shell watches from its own start without it */
  navigatedSinceEntry?: () => boolean;
  renderApp: () => Root;
  createRoot?: (container: HTMLElement) => Root;
  store?: ShellDeviceStore;
  pendingPush?: PendingPushStore;
  open?: typeof openRelayTransport;
  navigate?: (path: string) => void;
  /** a navigation that takes the current history entry's place (a PC's own page going on to its join); `navigate` when it is given */
  replace?: (path: string) => void;
  label?: string;
  shellVersion?: string;
  reload?: () => Promise<void>;
  findByCode?: typeof offerFromCode;
  /** this client's account key and sign-in; the `ovis-account` database by default */
  accountStore?: AccountStore;
  /** the account service's origin; the page's `ovis-account-service` meta by default (shellAccountServiceOf), and no sign-in without one */
  accountService?: string | null;
  accountProviders?: readonly AccountProvider[];
  accountFetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  openSignIn?: (url: string) => void;
  checkPc?: typeof checkPc;
}


export interface Attempt {
  offer: RelayOffer;
  typed?: boolean;
  code: boolean;
  paired: boolean;
  compared?: boolean;
  codeless?: boolean;
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
  readonly accountOpen?: SignInKey;
  readonly retriedAccountOpen?: true;
  /** a PC new in the account that no device is in yet: a pairing it falls back to takes the number its screen shows */
  readonly freshPc?: true;
  readonly holdRetryMs?: number;
  retryEnrollment?: boolean;
  retriedPending?: boolean;
  /**
   * the PC's row this attempt's pairing is, as the saved record named it when the attempt opened: only that record is
   * forgotten or replaced for it, so a Forget or a newer pairing made since (another tab) stands. null: none was saved
   */
  row?: string | null;
}


/** Non-secret navigation context only; no labels, offers, keys or input values cross the load here. */
export interface SheetJoin {
  readonly mode: "new" | "join";
  readonly server_id: string;
  readonly returnHash?: string;
  /** the join a PC's own page started for itself: drawn alone, with no list behind it */
  readonly alone?: true;
}
export function dashboardHash(hash: string): string {
  return isDashboardHash(hash) ? formatDashboardHash(parseDashboardHash(hash)) : "";
}
/** Where a sheet opened from the front page goes back to: the dashboard route or My machines it was opened on, else the front page. */
export function returnHash(hash: string): string {
  const machines = parseMyMachinesHash(hash);
  return machines !== null ? formatMyMachinesHash(machines) : dashboardHash(hash);
}
export function sheetContext(serverId?: string): SheetJoin | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem("ovis-add-pc-sheet") ?? "null");
    sessionStorage.removeItem("ovis-add-pc-sheet");
    if (typeof kept !== "object" || kept === null || !("mode" in kept) || !("server_id" in kept)) return null;
    if ((kept.mode !== "new" && kept.mode !== "join") || kept.server_id !== serverId || typeof kept.server_id !== "string") return null;
    const back = "returnHash" in kept && typeof kept.returnHash === "string" ? returnHash(kept.returnHash) : "";
    return { mode: kept.mode, server_id: kept.server_id, ...(back ? { returnHash: back } : {}), ...("alone" in kept && kept.alone === true ? { alone: true as const } : {}) };
  } catch { return null; }
}
export function keepSheetContext(join: SheetJoin): void {
  try { sessionStorage.setItem("ovis-add-pc-sheet", JSON.stringify({ mode: join.mode, server_id: join.server_id, returnHash: returnHash(join.returnHash ?? ""), ...(join.alone ? { alone: true } : {}) })); }
  catch {}
}
export function typedJoin(serverId: string): boolean {
  try { return sessionStorage.getItem("ovis-typed-join") === serverId; } catch { return false; }
}
export function keepTypedJoin(serverId: string | null): void {
  try { if (serverId === null) sessionStorage.removeItem("ovis-typed-join"); else sessionStorage.setItem("ovis-typed-join", serverId); }
  catch {}
}

/**
 * A marked pairing's web sign-in comes back on the front page, the one address the account service sends a browser back
 * to; that PC's own page goes on with the pairing, as after a scan. This crosses that one load, in this tab: the PC's ID,
 * when the code was scanned (`at`), how the sign-in ended (`refused`: the reason it gave; null once signed in), and when
 * the front page handed it on (`sent`), with the provider it was for and the digest of the one offer link it goes with
 * (`offer`, offerDigest), so another QR code of that PC never takes it. No offer, key or token: the offer goes in the page's fragment, as a scanned link
 * does.
 */
export interface PairingReturn { readonly server_id: string; readonly offer: string; readonly at: number; readonly refused: string | null; readonly provider: AccountProvider | null; readonly sent: number }
/** How long a note waits for its PC's page: a navigation stopped on the way leaves one no later scan should read. */
export const PAIRING_RETURN_MS = 60_000;
export function keepPairingReturn(note: PairingReturn): void {
  try { sessionStorage.setItem("ovis-pairing-return", JSON.stringify(note)); }
  catch { /* the note cannot cross the load: the PC's page asks about the pairing as after a scan */ }
}
/** Names one offer link exactly: the note goes with this link, never with another QR code of the same PC. */
export function offerDigest(offer: RelayOffer): string {
  return bytesToHex(sha256(utf8ToBytes(encodeOffer(offer, "https://ovis.invalid"))));
}

/**
 * The note for this offer's page, taken once whatever it holds. Null when it names another link; `late` when it waited
 * past its time, so that offer counts as expired rather than as a new scan.
 */
export function takePairingReturn(offer: RelayOffer | null, now = Date.now()): (PairingReturn & { readonly late: boolean }) | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem("ovis-pairing-return") ?? "null");
    sessionStorage.removeItem("ovis-pairing-return");
    if (offer === null || kept === null || typeof kept !== "object") return null;
    const { server_id, offer: digest, at, refused, provider, sent } = kept as Record<string, unknown>;
    if (server_id !== offer.server_id || digest !== offerDigest(offer) || typeof at !== "number" || typeof sent !== "number" || !(refused === null || typeof refused === "string")) return null;
    return { server_id, offer: digest, at, refused, provider: ACCOUNT_PROVIDERS.includes(provider as AccountProvider) ? provider as AccountProvider : null, sent, late: now < sent || now - sent > PAIRING_RETURN_MS };
  } catch { return null; }
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
 * Only the PC ID, in this tab. It stays until that pairing's page opens the app, another confirm for a PC takes its
 * place, or the PC is forgotten: a load that is itself reloaded or interrupted while it connects leaves it for the
 * next one, which would otherwise open the PC as whoever is signed in by then.
 */
export function keepDeviceOnlyPc(serverId: string | null): void {
  try { if (serverId === null) sessionStorage.removeItem("ovis-device-only-pc"); else sessionStorage.setItem("ovis-device-only-pc", serverId); }
  catch { /* the choice cannot cross the load: the reloaded page opens the PC as a saved one */ }
}
export function deviceOnlyPc(): string | null {
  try { return sessionStorage.getItem("ovis-device-only-pc"); } catch { return null; }
}

/**
 * The sign-in a pairing's confirm was drawn for, kept for the load that follows: a reload before the app opened (for
 * a newer shell) starts from the saved pairing, which does not say whose account was confirmed, and would add the
 * PC to the account of whoever is signed in by then. Only the PC ID and the sign-in's id (`sign_in_id`, none of its
 * tokens; null for a sign-in that has none), in this tab. Like the one above it stays until that pairing's page
 * opens the app, another confirm takes its place, or the PC is forgotten, so a second reload on the way finds it too.
 */
export interface ConfirmedSignIn { readonly server_id: string; readonly sign_in_id: string | null }
export function keepConfirmedSignIn(confirmed: ConfirmedSignIn | null): void {
  try {
    if (confirmed === null) sessionStorage.removeItem("ovis-confirmed-sign-in");
    else sessionStorage.setItem("ovis-confirmed-sign-in", JSON.stringify({ server_id: confirmed.server_id, sign_in_id: confirmed.sign_in_id }));
  } catch { /* the confirm cannot cross the load: the reloaded page opens the PC as a saved one */ }
}
export function confirmedSignIn(): ConfirmedSignIn | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem("ovis-confirmed-sign-in") ?? "null");
    if (kept === null || typeof kept !== "object") return null;
    const { server_id, sign_in_id } = kept as Record<string, unknown>;
    if (typeof server_id !== "string") return null;
    // an id that cannot be read names no sign-in: the pairing then joins no account, as for a sign-in without one
    return { server_id, sign_in_id: typeof sign_in_id === "string" && sign_in_id !== "" ? sign_in_id : null };
  } catch { return null; }
}
