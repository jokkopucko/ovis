import type { Root } from "react-dom/client";
import type { HoldState } from "../../../shared/account-devices-api.ts";
import type { PendingPushStore } from "../push.ts";
import type { AccountList } from "../account/accountList.ts";
import type { AppPlatform } from "../appShell.ts";
import type { AccountKey, AccountStore } from "../account/store.ts";
import type { WriteScope } from "../account/listRemoveDevice.ts";
import type { EnrollmentState, ShellDeviceStore } from "./device.ts";
import type { openRelayTransport } from "./transport.ts";
import type { checkPc } from "./pcStatus.ts";
import type { offerFromCode } from "./pairCode.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError, type PairApprover } from "../../../shared/relay-mux.ts";
import { ListMismatchError } from "../../../shared/relay-channel.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { decodeOffer, encodeOffer } from "../../../shared/relay-offer.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { UpdateStep } from "../../../shared/update.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { KnownPc } from "../account/knownPcs.ts";
import type { MyPc } from "../account/myPcs.ts";
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountSession, type SignInKey } from "../account/store.ts";
import { inNativeApp, onIos } from "../nativeApp.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { RelayAdmissionTimeoutError, RelayNewSessionsRefusedError, RelayRefusedError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import type { TypedCodeFailure } from "./pairCode.ts";
import type { RelayDevice } from "./device.ts";

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

export type RelayFailure = "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "relay-refused" | "needs-update" | "revoked" | "identity-changed" | "code-expired" | "pair-declined" | "pair-unanswered" | "pair-unavailable" | "bad-offer"
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
  /** the PC refused this device's link because the account's signed list removed the PC: it comes back only as a new PC */
  | "list-removed"
  /** this device was in its account's signed list for a limited time, which is over: the PC ended its session for that, and nobody removed it */
  | "list-time-over"
  /** the PC could not ask the account service whether it is still in the account, or left the account and must be added to it again */
  | "account-unreachable" | "account-readd"
  /**
   * A join that brought this device's card to a PC that lets devices in by its account's signed list, and no entry of
   * the list let it in: no sign-in of the account claimed its key; the entry could not be placed in time; a device of
   * the account allowed it and no entry reached the PC; Ovis on the PC is too old to sign for the list; the PC joined
   * by an invite, or came in as its account moved with no key of its own (`list-pc-needs-keys`), and signs for nobody;
   * the PC keeps this very device out by a block there (`list-pc-held`), whatever the list holds; anything else.
   * `list-other`: the PC follows another list than this device's account's, said before any digits.
   */
  | "list-not-claimed" | "list-not-placed" | "list-not-in" | "list-pc-behind" | "list-pc-invited" | "list-pc-needs-keys" | "list-pc-held" | "list-refused" | "list-other"
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
  | { kind: "signed-out"; error: string | null; provider?: AccountProvider; notice?: string; hint?: import("../account/accountHint.ts").AccountHint }
  | { kind: "signing-in"; provider?: AccountProvider }
  /** `known`: the read failed, and these are the account's PCs this device listed at its last read that answered (knownPcs) */
  | {
    kind: "signed-in"; provider: AccountProvider; pcs: MyPc[] | null; error: string | null; deleteError?: string; known?: readonly KnownPc[];
    /** this device cannot read its list of the account: only a newer app reads it (`newer`), or what it saved does not read (`damaged`). Its PCs are then the directory's, each marked, and none opens by itself */
    list?: "newer" | "damaged" | "unread";
  };

export interface EnrollmentCompletion { readonly state: "complete"; readonly admitted?: number }

export type RelayShellState =
  /** `noneOnline`: a launch tried every PC it may open, saved or the account's, and none answered */
  | { kind: "list"; devices: RelayDevice[]; account?: AccountView | null; noneOnline?: true }
  | { kind: "outdated"; name: string | null; serverVersion: string; minVersion: string; update: PcUpdate }
  /** the app's own copy of the client is older than the oldest this PC supports: only the store's update opens it */
  | { kind: "app-outdated"; name: string | null; platform: AppPlatform | null }
  /**
   * `waitPc`: signed in with nothing saved here, and none of the account's PCs is on to ask: one line says to turn one on,
   * `offPc` named when the account has one
   */
  | { kind: "empty"; account?: AccountView | null; noneOnline?: true; waitPc?: true; offPc?: string }
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
  | { kind: "compare"; name: string | null; digits: string; confirmed: boolean; /** the digits are typed from the PC's screen, never shown here */ typed?: boolean; /** the typed digits were not the PC's: the comparison ended */ wrong?: boolean; challenge?: number; /** a join a PC's own page started for itself: the PC takes the number, nothing is pressed here */ alone?: true; /** the PC itself approves it on its own screen (a first join), named by its system */ approveOn?: PairApprover }
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
/** The causes a PC names when a join into its account's list ends with nobody let in (docs/account.md, "A PC allows a device into the list"). */
const LIST_JOIN_CAUSES: Readonly<Record<string, RelayFailure>> = {
  list_not_claimed: "list-not-claimed", list_service_away: "list-not-placed", list_head_lost: "list-not-placed",
  list_not_in: "list-not-in", list_pc_behind: "list-pc-behind", list_not_signer: "list-pc-invited", list_needs_keys: "list-pc-needs-keys",
  list_held_here: "list-pc-held", list_refused: "list-refused",
};

export function failureOf(error: unknown, attempt: { code: boolean; paired: boolean; compared?: boolean; codeless?: boolean }): RelayFailure {
  if (error instanceof UnsafeRelayDestinationError) return "bad-offer";
  // the relay's own word, whatever the attempt was: the code held or the digits were approved, and the PC's account is past its limits
  if (error instanceof RelayNewSessionsRefusedError) return "new-devices-refused";
  // a link without a code that the PC refused before any digits: no code to blame, and the wire does not say why
  // (pairing paused after failures, three phones already waiting, a serve-only PC)
  if (attempt.codeless && !attempt.code && !attempt.paired && !attempt.compared
    && error instanceof MuxProtocolError && error.code === "auth_failed") return "pair-unavailable";
  if (error instanceof ListMismatchError) return "list-other";
  // once digits were shown, only the PC's refusal is a decline; a deadline or a session lost on the way is no answer.
  // A PC that lets devices in by its account's list says why no entry let this one in
  if (attempt.compared && error instanceof MuxProtocolError && error.code === "auth_failed") return Object.hasOwn(LIST_JOIN_CAUSES, error.message) ? LIST_JOIN_CAUSES[error.message]! : "pair-declined";
  if (attempt.compared && (error instanceof RelayAdmissionTimeoutError || error instanceof RelayUnreachableError
    || error instanceof MuxProtocolError && (error.code === "timeout" || error.code === "internal_error"))) return "pair-unanswered";
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
    case "account_unreachable": return "account-unreachable";
    case "account_readd_required": return "account-readd";
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
  return onIos(env) && env.standalone !== true && !inNativeApp();
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
  /**
   * this device's copy of its account's signed list (account/accountList.ts): the page's own by default, and none where
   * `accountStore` or `accountFetch` is given without it, or with null
   */
  accountList?: AccountList | null;
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
  /**
   * the sign-in to a PC the account's signed list holds, with the key that list holds for this device, the account key
   * (docs/account.md, "How an app signs in to a pinned PC"): a PC that follows no list refuses it, and the ways from
   * before are tried
   */
  readonly listOpen?: AccountKey;
  /** the account, the list and the key in it that `listOpen` was taken for, read with it: the session's list exchanges are for them alone */
  readonly listFor?: WriteScope;
  /** this attempt came back from a refusal that told it to come by the list key, or by the key from before: it is not sent round again */
  readonly retriedListOpen?: true;
  readonly retriedAccountOpen?: true;
  /** a PC new in the account that no device is in yet: a pairing it falls back to takes the number its screen shows */
  readonly freshPc?: true;
  /**
   * the person's press on the join sheet of a PC inside its 24 hours in the account started this account sign-in: a
   * refusal goes on to the join that press asked for, with no second press, and a key the PC does not list is one more
   * refusal, never a removal
   */
  readonly pressed?: true;
  readonly holdRetryMs?: number;
  retryEnrollment?: boolean;
  retriedPending?: boolean;
  /**
   * the PC's row this attempt's pairing is, as the saved record named it when the attempt opened: only that record is
   * forgotten or replaced for it, so a Forget or a newer pairing made since (another tab) stands. null: none was saved
   */
  row?: string | null;
  /**
   * the code was typed on this device (a code the PC showed, entered and compared here), not scanned: the pairing earns
   * `paired` in the device's record of its PCs, never `added` (docs/account.md, "What a device remembers of its PCs")
   */
  codeTyped?: true;
  /** the account the pairing was prepared under, which the confirm named when it named one: what the device's record of this act goes to */
  recordFor?: string;
}


/** Non-secret navigation context only; no labels, offers, keys or input values cross the load here. */
export interface SheetJoin {
  readonly mode: "new" | "join";
  readonly server_id: string;
  /** the join a PC's own page started for itself: drawn alone, with no list behind it */
  readonly alone?: true;
}
/**
 * An address of the control page the hosted app had before 0.5.10 (`#overview`, `#pcs`, `#devices`, `#relay`,
 * `#settings`, with a query, or an older `#relay-dash-*` anchor; `#my-machines` of 0.5.6 to 0.5.9): the page is gone, and such a link or bookmark lands
 * on the app as its bare address does.
 */
export function oldDashboardHash(hash: string): boolean {
  return /^#(?:overview|pcs|devices|relay|settings|my-machines|relay-dash-[a-z]+)(?:\?.*)?$/.test(hash);
}
export function sheetContext(serverId?: string): SheetJoin | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem("ovis-add-pc-sheet") ?? "null");
    sessionStorage.removeItem("ovis-add-pc-sheet");
    if (typeof kept !== "object" || kept === null || !("mode" in kept) || !("server_id" in kept)) return null;
    if ((kept.mode !== "new" && kept.mode !== "join") || kept.server_id !== serverId || typeof kept.server_id !== "string") return null;
    return { mode: kept.mode, server_id: kept.server_id, ...("alone" in kept && kept.alone === true ? { alone: true as const } : {}) };
  } catch { return null; }
}
export function keepSheetContext(join: SheetJoin): void {
  try { sessionStorage.setItem("ovis-add-pc-sheet", JSON.stringify({ mode: join.mode, server_id: join.server_id, ...(join.alone ? { alone: true } : {}) })); }
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

/**
 * The offer a code typed on this device turned into, in this tab: only its digest (offerDigest), never the code. The
 * page that pairs with it pairs as a typed code does, a reload included; another offer, a scanned one most of all,
 * never reads it.
 */
export function keepTypedCode(offer: RelayOffer): void {
  try { sessionStorage.setItem("ovis-typed-code", offerDigest(offer)); } catch { /* not kept: the pairing is recorded as any code's */ }
}
export function typedCode(offer: RelayOffer): boolean {
  try { return sessionStorage.getItem("ovis-typed-code") === offerDigest(offer); } catch { return false; }
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
/**
 * A PC that turned this device away as removed (a revoked sign-in: its pairing is forgotten), by id, until this device
 * opens it again: the front page's list says Removed rather than on ("removed"), and its Forget leaves it out
 * ("hidden"). Kept across loads; a damaged store reads as none.
 */
export type RemovedPcMark = "removed" | "hidden";
const REMOVED_PCS_KEY = "ovis-removed-pcs";
export function removedPcs(): Readonly<Record<string, RemovedPcMark>> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(REMOVED_PCS_KEY) ?? "{}");
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, RemovedPcMark] => entry[1] === "removed" || entry[1] === "hidden"));
  } catch { return {}; }
}
export function markRemovedPc(serverId: string, mark: RemovedPcMark | null): void {
  const next: Record<string, RemovedPcMark> = { ...removedPcs() };
  if (mark === null) delete next[serverId]; else next[serverId] = mark;
  try { localStorage.setItem(REMOVED_PCS_KEY, JSON.stringify(next)); }
  catch { /* no storage: the row reads as the account lists it */ }
}

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
