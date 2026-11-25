// allow: SIZE_OK - One state-machine closure shares attempt ownership across connection, cancellation and admission handlers.
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { encodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { AccountListUnsupportedError, AccountOpenUnsupportedError, RelayPcOfflineError } from "../../../shared/relay-channel.ts";
import { MuxProtocolError, type PairApprover } from "../../../shared/relay-mux.ts";
import { RelayShell } from "../../components/RelayShell.tsx";
import { accountDevice, withAccountDevice } from "../account/accountDevice.ts";
import { nextOpenStep, openRefusalOf } from "../account/openPc.ts";
import { isNewAccountPc, newPcs, type MyPc } from "../account/myPcs.ts";
import { noteSession, readSeenPcs } from "../account/seenPcs.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { sameSignIn, SignedOutError } from "../account/service.ts";
import type { AccountProvider, AccountSession, PendingPairing } from "../account/store.ts";
import { SIGN_IN_MS, signInReturn } from "../account/signin.ts";
import { inNativeApp } from "../nativeApp.ts";
import { thisDeviceLabel } from "../phone.ts";
import { registerPendingPush } from "../push.ts";
import { alertPrefs, loadSettings, SettingsProvider } from "../settings.ts";
import { readAlertFilters, withAlertFilters } from "../alertFilters.ts";
import { onLazyChunkFailure } from "../lazyChunk.ts";
import { serverIdOfPath, serverScopePath } from "../shellMode.ts";
import { setTransport } from "../transport.ts";
import { takeEntryUrl, watchNavigation } from "./boot.ts";
import { nativeDirectSocket, nativeDirectTailnet } from "./directSocket.ts";
import { enrollmentOf, indexedDeviceStore, indexedPendingPush, ServerIdentityChangedError, type RelayDevice } from "./device.ts";
import { holdWaitMs } from "./joinHold.ts";
import { signInEntry, failureOf, forgedOffer, forgetsDevice, iosBrowserTab, keyMismatch, offerOf, pairsAgainWithoutKey, shellEntry, sheetContext, keepSheetContext, typedJoin, keepTypedJoin, oldDashboardHash, keepConfirmedPc, takeConfirmedPc, keepDeviceOnlyPc, deviceOnlyPc, keepConfirmedSignIn, confirmedSignIn, markRemovedPc, keepPairingReturn, takePairingReturn, offerDigest, keepTypedCode, typedCode } from "./shellState.ts";
import { setPcNewness, type PcNewness } from "./newPcHere.ts";
import type { AccountView, Attempt, RelayShellMount, RelayShellState, SheetJoin } from "./shellState.ts";
import { openRelayTransport, type RelayTransport } from "./transport.ts";
import { offerFromCode, TypedCodeError } from "./pairCode.ts";
import { ADMISSION_WAIT_MS, AddedToListError, ConsentChangedError, createAccountController, ListUnwritableError, PlacedInListError } from "./accountController.ts";
import { keepShellAccount } from "../account/hostedSignIn.ts";
import { AccountPcError } from "../account/join.ts";
import { deliverOnce, gossipBudget, keepListGossip } from "../account/listGossip.ts";
import type { WriteScope } from "../account/listRemoveDevice.ts";
import { listRemovedLink, refusalOf } from "./firstLink.ts";
import { CHECK_GAP_MS, createPcSweep } from "./pcSweep.ts";
import type { PcFinding, ProbeTarget } from "./pcStatus.ts";
import { accountOpenablePcs, keepLaunchTried, lastFirst, launchTried, openablePcs } from "./pcPick.ts";
import { PAGE_LEAVING_EVENT } from "../paneLifetime.ts";
import { notePcTap, takePcTap } from "./pcTap.ts";
import { createUpdateFlow, loadObservedVersions, observedVersions, reloadPage, freshShellNext, forgetSavedPc } from "./updateFlow.ts";
export type { RelayShellMount } from "./shellState.ts";
export { forgetSavedPc } from "./updateFlow.ts";
declare const __APP_VERSION__: string;
const INTRODUCED_GRACE_MS = 15 * 60_000;
const HOLD_RETRY_MIN_MS = 1_000;
const HOLD_RETRY_MAX_MS = 30_000;
/** How long a confirm waits for the account service before it stops saying "checking": a service that never answers must not hold the Pair button. */
export const ACCOUNT_READ_WAIT_MS = 8_000;
/** How long a fresh account pairing waits for its link and sign-in before the PC opens anyway: a PC slow to answer must not hold the app. */
export const ACCOUNT_STEPS_WAIT_MS = 15_000;


const LAST_PC = "ovis-last-pc";
const LAUNCHED = "ovis-launched";
/** the shell's one listener for a page Back restores from the browser's cache (a later mount, in tests, replaces it) */
let restored: ((event: PageTransitionEvent) => void) | null = null;

/** The PC this device opened last, kept by its id alone (no key), so the next launch opens it again. */
/** The PC a hand open was marking as chosen was forgotten meanwhile: nothing is written for it. */
class PcForgotten extends Error {
  constructor() { super("This PC was forgotten on this device"); this.name = "PcForgotten"; }
}

function rememberPc(serverId: string): void {
  try { localStorage.setItem(LAST_PC, serverId); } catch { /* a page without storage opens on the front page */ }
}
function lastPc(): string | null {
  try { return localStorage.getItem(LAST_PC); } catch { return null; }
}

/**
 * The account PC whose join card a launch put up, waiting for the person's press: kept in this tab until that press opens
 * the PC (enterApp) or a Cancel ends it, so a reload of the card asks again rather than opening the PC by the account's
 * own way in (security-triage condition 3: nothing this device did not choose opens without a press).
 */
const LAUNCH_JOIN = "ovis-launch-join";
/** False when the mark cannot be kept: a launch then puts up no join card, which a reload could open by the account key. */
function keepLaunchJoin(serverId: string | null): boolean {
  try { if (serverId === null) sessionStorage.removeItem(LAUNCH_JOIN); else sessionStorage.setItem(LAUNCH_JOIN, serverId); return true; } catch { return false; }
}
function launchJoinFor(serverId: string): boolean {
  try { return sessionStorage.getItem(LAUNCH_JOIN) === serverId; } catch { return false; }
}

/**
 * A PC's new window (new_until, in ms) as this browser last read it from the account's PCs, by PC: a load that opens the PC
 * before it reads them (a launch reopening it) still holds its sessions from any selection made without a tap (#16, C3),
 * with `:before-you` for one added before this device joined (#29: no New PC row for it in the sidebar).
 */
const NEW_PC = "ovis-new-pc:";
const BEFORE_YOU = ":before-you";
function keepNewPc(serverId: string, known: { readonly until: number; readonly beforeYou?: true } | null): void {
  try { if (known === null) localStorage.removeItem(NEW_PC + serverId); else localStorage.setItem(NEW_PC + serverId, `${known.until}${known.beforeYou ? BEFORE_YOU : ""}`); } catch { /* the account's next read says it again */ }
}
function keptNewPc(serverId: string): { readonly until: number; readonly beforeYou?: true } | null {
  try {
    const kept = localStorage.getItem(NEW_PC + serverId) ?? "";
    const until = Number(kept.endsWith(BEFORE_YOU) ? kept.slice(0, -BEFORE_YOU.length) : kept || Number.NaN);
    return Number.isFinite(until) ? { until, ...(kept.endsWith(BEFORE_YOU) ? { beforeYou: true as const } : {}) } : null;
  } catch { return null; }
}

/**
 * A launch whose saved PC turned out off on its own page goes on at the front page with the account's PCs, as it would
 * have had the check said so in time: one mark in this tab, taken by the front page that follows.
 */
const LAUNCH_ACCOUNT = "ovis-launch-account";
/**
 * The person left a join or a PC for the front page in this tab (Cancel, Back, a sheet closed): the front page then draws My
 * PCs, and a load of it starts no launch of its own (#16). A sign-in, Check again or Ask again clears it.
 */
const FRONT_CHOSEN = "ovis-front-chosen";
function keepFrontChosen(chosen: boolean): void {
  try { if (chosen) sessionStorage.setItem(FRONT_CHOSEN, "1"); else sessionStorage.removeItem(FRONT_CHOSEN); } catch { /* a load after it may launch again */ }
}
function frontChosen(): boolean {
  try { return sessionStorage.getItem(FRONT_CHOSEN) !== null; } catch { return false; }
}
function keepLaunchAccount(): void {
  try { sessionStorage.setItem(LAUNCH_ACCOUNT, "1"); } catch { /* the front page draws My PCs */ }
}
function takeLaunchAccount(): boolean {
  try { const kept = sessionStorage.getItem(LAUNCH_ACCOUNT) !== null; sessionStorage.removeItem(LAUNCH_ACCOUNT); return kept; } catch { return false; }
}

/** the shell's one listener for a press on a PC's link, which ends a launch's join card for that PC */
let pressedJoin: ((event: MouseEvent) => void) | null = null;

/** The PC a launch sent this tab to, for that PC's page alone: taken as it loads. */
const LAUNCHED_PC = "ovis-launched-pc";
function keepLaunchedPc(serverId: string): void {
  try { sessionStorage.setItem(LAUNCHED_PC, serverId); } catch { /* the PC's page keeps its own failure card */ }
}
function takeLaunchedPc(): string | null {
  try { const id = sessionStorage.getItem(LAUNCHED_PC); sessionStorage.removeItem(LAUNCHED_PC); return id; } catch { return null; }
}

/** This tab has shown a page of the shell: from now on a front page is one it came back to, and stays. */
function markLaunched(): void {
  try { sessionStorage.setItem(LAUNCHED, "1"); } catch { /* no storage: launchPc opens nothing */ }
}

/** How many saved PCs a launch asks, and how long it waits for one to answer before it opens none (My PCs lists them). */
const LAUNCH_PCS = 4;
const LAUNCH_WAIT_MS = 4_000;

/**
 * The saved PCs a launch may open, in the order it prefers them: the one opened last while it is still saved, then the
 * others. Only the first front page of this tab's session opens one (`opens`: it came with no fragment), whatever it
 * shows: Back from a PC, a Cancel on its page, or a reload lands on the front page and stays there. `signedIn`: the page
 * a sign-in returned to, which opens one once its sign-in is read, as the launch it continues would have. `resumed`:
 * the front page the PC a launch opened sent back because it was off, which goes on with the PCs not tried yet.
 */
function launchOrder(devices: readonly RelayDevice[], opens: boolean, signedIn = false, resumed = false): RelayDevice[] | null {
  try {
    const first = sessionStorage.getItem(LAUNCHED) === null;
    sessionStorage.setItem(LAUNCHED, "1");
    if (!(opens && (first || signedIn || resumed))) return null;
    const tried = resumed ? launchTried() : [];
    if (!resumed) keepLaunchTried([]);
    // the PC opened last here was opened on this device; any other is one a person paired by hand here (openablePcs)
    return lastFirst(openablePcs(devices).filter((device) => !tried.includes(device.server_id)), lastPc()).slice(0, LAUNCH_PCS);
  } catch { return null; }
}

/**
 * The account's PCs a launch with no saved PC to open may go to, to ask to join one on its own page (approved on that PC
 * or a device already in): those this device has no pairing for, that have a way to join and were seen lately, the one
 * opened last first, then the one seen most recently. The launch asks the first its check does not find off. A PC new in the account (new_until) is asked
 * too (security-triage, #16): the request grants nothing, and its approval opens no session without a tap (App). One
 * this device may sign in to by the account's key is not asked: its sheet waits for the press that opens it that way.
 */
export function accountLaunchPcs(pcs: readonly MyPc[]): (MyPc & { readonly join: NonNullable<MyPc["join"]> })[] {
  // never a PC that this device's list of the account does not hold: its row waits for a tap
  const open = pcs.filter((pc): pc is MyPc & { readonly join: NonNullable<MyPc["join"]> } => !pc.paired && pc.join !== undefined && pc.state !== "offline" && pc.notInList !== true);
  const last = lastPc();
  const seen = (pc: MyPc): number => pc.last_seen_at === null ? 0 : Date.parse(pc.last_seen_at);
  return [...open].sort((a, b) => Number(b.server_id === last) - Number(a.server_id === last) || seen(b) - seen(a));
}

export async function mountRelayShell(mount: RelayShellMount): Promise<void> {
  // any navigation in this tab since the entry was read, even one the page takes no step for (Back to another
  // fragment): a `#sign-in=` entry starts only on a page nothing moved
  const navigatedSinceEntry = mount.navigatedSinceEntry ?? watchNavigation(window);
  // the PC a launch sent this tab to is taken before anything waits, by any page: only that PC's own page, loaded at
  // once, may act on it; a front page that came back first (Back) drops it, so a later visit a person makes keeps its card
  const launchedPc = takeLaunchedPc();
  const store = mount.store ?? indexedDeviceStore;
  await loadObservedVersions(store);
  const open = mount.open ?? openRelayTransport;
  const navigate = mount.navigate ?? ((path: string) => window.location.assign(path));
  const replace = mount.replace ?? mount.navigate ?? ((path: string) => window.location.replace(path));
  const label = mount.label ?? thisDeviceLabel();
  let entry = shellEntry(mount.entryUrl);
  // bumped by every link this page takes after it loaded, and by Cancel or Back: a step of the page's own load that
  // waited meanwhile is stale and does nothing
  let entries = 0;
  const scoped = entry.serverId !== null;
  // a front page that came with a fragment (a sign-in's return, a link that starts one, a page view) does not open a PC
  // at once: a sign-in's return does once its sign-in is read (below), the others stay where the link put them
  // the phone app's saved row for this app opens it at #pcs (app/web/connect.js), so that it is no launch: that is the
  // app's way to its front page. Anywhere else the old control page's addresses (#overview, #pcs, ...) land on the app,
  // as its bare address does: dropped from the address, and the launch goes on
  const linkedHash = new URL(mount.entryUrl).hash;
  const oldPage = !scoped && oldDashboardHash(linkedHash) && !(linkedHash === "#pcs" && inNativeApp());
  const entryHash = oldPage ? "" : linkedHash;
  if (!scoped && oldDashboardHash(linkedHash)) window.history.replaceState(null, "", "/");
  // a PC the person tapped on the phone app's connect screen (app/web/connect.js adds #picked): chosen now, not reopened
  // by the app as it starts, so an off PC keeps its failure card. The mark is dropped from the address at once
  const picked = scoped && entryHash === "#picked";
  if (picked) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  // whether a person's press led to this PC's page just now: on the phone app's connect screen, or on a link to it on
  // the page before. Read once, so a reload, a restored tab and a page the app reopened by itself come without it
  const tappedPc = takePcTap();
  const tapped = entry.serverId !== null && (picked || tappedPc === entry.serverId);
  // `left`: the launch sent this page to a PC: nothing more is drawn or probed on the way out
  let launching = !scoped && entryHash === "", signedInNow = false, left = false, launched = false, accountLaunch = false;
  // the card a launch waits on for the account's PCs: only while it is the screen does a read of them go on with the launch
  let launchCard: RelayShellState | null = null, accountTried = false;
  // a sign-in's launch found none of the account's PCs on to ask (#16): the front page says to turn one on while that holds
  let waitingPc = false, waitingPcName: string | null = null;
  // `noneOnline`: this page's launch asked every saved PC it may open and none answered (the front page says so)
  let launchResumed = false, noneOnline = false;
  // taken by every page as it loads, acted on by a front page alone: the launch goes on with the saved PCs it did not
  // try yet, then the account's PCs
  if (takeLaunchAccount() && !scoped && entryHash === "") { accountLaunch = true; launchResumed = true; }
  // Back to a front page the browser kept whole (its back/forward cache) finds it as it left it, on the way to a PC: it
  // loads again, past this tab's launch, so it draws the front page
  if (restored !== null) window.removeEventListener("pageshow", restored);
  restored = (event: PageTransitionEvent) => { if (event.persisted && left) window.location.reload(); };
  window.addEventListener("pageshow", restored);
  let firstOfTab = false;
  try { firstOfTab = sessionStorage.getItem(LAUNCHED) === null; } catch { /* no storage: no page is a launch */ }
  if (scoped) markLaunched();
  // this PC's page was opened by a launch, not by a person: if the PC turns out off, the launch goes on with the others.
  // So was the PC page the phone app reopens by itself as it starts (a new web view, a new tab session): nobody chose it now
  const launchedHere = scoped && (launchedPc === entry.serverId || (firstOfTab && inNativeApp() && !picked));
  // only a press on a link to that PC (a row of My PCs, the dashboard, a sidebar) ends a launch's join card: Back, Forward
  // or a reload into it keeps it, so it never opens by the account's key without the person's word
  if (pressedJoin !== null) document.removeEventListener("click", pressedJoin, true);
  pressedJoin = (event: MouseEvent) => {
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const link = typeof target?.closest === "function" ? target.closest("a[href]") : null;
    let id: string | null = null;
    try { id = link === null ? null : serverIdOfPath(new URL(link.getAttribute("href") ?? "", window.location.href).pathname); } catch { /* not an address */ }
    if (id !== null && launchJoinFor(id)) keepLaunchJoin(null);
    // and that press is the word a PC waits for which nothing but a press may open (openUnpaired)
    if (id !== null) notePcTap(id);
  };
  document.addEventListener("click", pressedJoin, true);
  const iosTab = iosBrowserTab({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone: "standalone" in navigator && navigator.standalone === true });
  let shell: Root | null = null, app: Root | null = null, transport: RelayTransport | null = null;
  /** Ends the exchanges of the account's list with the PC whose session the shell owns (listGossip.ts), and which session that is. */
  let stopGossip: (() => void) | null = null;
  let gossipFor: RelayTransport | null = null;
  /** The account whose list that session is compared for: the one its list key was taken for, or the page's list's when the shell took it. */
  let gossipAccount: string | null = null;
  /** What the list's calls to this PC by the key of this session draw on: shared with every tab and reopening of it. */
  const budgetOf = (opened: RelayTransport, serverId: string) => gossipBudget(`${serverId}:${opened.deviceId ?? ""}`);
  /**
   * The PC and this device say where the account's list stands, from the moment the shell owns an authenticated session
   * with that PC and for as long as it is the one it owns, whatever screen shows (the app, Ready, an update): only where
   * the PC follows the list and this device does too, otherwise nothing is asked. `scope`: what the list key this
   * session was opened with was taken for; the PC is told nothing while the page's list stands for anything else.
   */
  const gossipOver = (opened: RelayTransport, serverId: string, scope?: WriteScope): void => {
    if (gossipFor === opened) return;
    stopGossip?.();
    gossipFor = opened;
    gossipAccount = scope?.account ?? account.list?.view().account ?? null;
    stopGossip = keepListGossip(opened, {
      list: () => account.list, pc: serverId, live: () => transport === opened, budget: budgetOf(opened, serverId),
      ...(scope === undefined ? {} : { scope: { account: scope.account, list: scope.list, key: scope.member } }),
    });
  };
  /** What the list key read now is taken for (Attempt.listFor), to go with it. */
  const listForNow = (): { readonly listFor?: WriteScope } => { const scope = account.listScope; return scope === null ? {} : { listFor: scope }; };
  let last: Attempt | null = null, opening: AbortController | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let shown: RelayShellState | null = null, sheetJoin: SheetJoin | null = null, codeOffer: RelayOffer | null = null;
  /** `alone`, `approveOn`: what a join into the account's list keeps on screen around the press it waits for */
  let comparison: { name: string | null; digits: string; matched: () => void; typed: boolean; alone?: true; approveOn?: PairApprover } | null = null;
  let challenge = 0, checked = false;
  const enrolling = new Set<RelayTransport>();
  // a first link each PC refused, by its id, until a failure screen for that PC says it (linkRefused)
  const refusedLinks = new Map<string, unknown>();
  // a marked code's pairing, by PC, until its new row's link passes, with the record of an older pairing that its PAIR
  // replaced (`older`), so a refused link leaves the device the record of the row the PC kept
  const markedPairings = new Map<string, { older?: RelayDevice }>();
  // the account steps of a pairing still in front of the person (its connecting screen): a Cancel ends them
  let frontSteps: AbortController | null = null;
  // a marked code's enrollment while its first link may still be on its way, by PC (failed waits for its answer)
  const linking = new Map<string, Promise<void>>();
  const directSocket = nativeDirectSocket();
  const directTailnet = directSocket ? nativeDirectTailnet() : undefined;
  const findByCode = mount.findByCode ?? offerFromCode;
  const pendingPush = mount.pendingPush ?? indexedPendingPush;
  const registerPending = (serverId: string): void => {
    registerPendingPush(serverId, pendingPush, withAlertFilters(alertPrefs(loadSettings()), readAlertFilters())).catch((error: unknown) => {
      console.warn("Ovis: the PC did not take this device's new push subscription", error);
    });
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      if (transport === null || last === null || (event.data as { type?: unknown } | null)?.type !== "push-subscription-change") return;
      registerPending(last.offer.server_id);
    });
  }

  onLazyChunkFailure(() => { if (entry.serverId !== null) void freshShellNext(entry.serverId); });
  const frontUp = (): boolean => app === null && (sheetJoin !== null || shown === null || shown.kind === "list" || shown.kind === "empty");
  // the confirm says what the pairing does to the account, so it waits for the sign-in to be read once
  let accountRead = false;
  // a Pair press reads the sign-in and its directory again before it pairs: nothing more can be confirmed meanwhile
  let confirming = false;
  // what the confirm said when it was pressed: its wording stays up while the press is checked
  let pressed: "unlisted" | "listed" | "own" | undefined;
  // bumped by every press and by everything that ends one (Not now, Back, another link): a press whose read lands later does nothing
  let press = 0;
  let unanswered = false;
  let readWait: ReturnType<typeof setTimeout> | undefined;
  // a marked pairing that stopped for a sign-in, while the sign-in its failure screen started runs: it is asked about again after it
  let signInFor: PendingPairing | null = null;
  // the providers every sign-in screen offers: the account service's own list, read when a sign-in screen is first drawn
  // (a hosted build names none of its own, so its list is GitHub alone); the build's until then and when it does not answer
  let offered: readonly AccountProvider[] | null = null;
  // the offer on screen and when this device got it: a code is good for so long from its scan
  let scanned: PendingPairing | null = null;
  // the reason a web sign-in gave when it came back refused, and the provider it was for
  let refusal: string | null = null;
  let refusalProvider: AccountProvider | null = null;
  // the sign-in each confirm that names an account was drawn for (kept off the rendered state: it holds the tokens)
  const drawnFor = new WeakMap<RelayShellState, AccountSession>();
  let signingIn = false;
  // the load whose PC's own page asks for a sign-in before it joins that PC (openUnpaired): its screen until then
  let unpaired: number | null = null;
  const accountChanged = async (): Promise<void> => {
    // a sign-in that finished on this page (the phone app's own sheet) goes on as the launch it interrupted, as a
    // browser's return to the page does
    const finished = signingIn && account.state?.kind === "signed-in";
    signingIn = account.state?.kind === "signing-in";
    if (finished && !scoped) { keepFrontChosen(false); launching = signedInNow = true; }
    const read = account.state?.kind !== "signing-in";
    if (read) accountRead = true;
    if (read && (account.state?.kind !== "signed-in" || account.state.pcs !== null)) unanswered = false;
    // the sign-in a PC's own page asks for stays its screen; signed in on this page (the phone app's sheet, another tab),
    // the page goes on to join that PC as its load would have, once the account's PCs are read (the join is one of them)
    if (unpaired !== null && unpaired === entries && app === null && (shown?.kind === "empty" || shown?.kind === "connecting")) {
      const view = account.state;
      if (view?.kind !== "signed-in") show({ kind: "empty", account: withRefusal(view) });
      else if (view.pcs === null && view.error === null) show({ kind: "connecting", name: null });
      else { unpaired = null; void openUnpaired(entries); }
      return;
    }
    if (signInFor !== null && shown?.kind === "failed" && shown.failure === "sign-in-first") {
      const kept = signInFor;
      if (account.state?.kind === "signed-in" || codeLapsed(kept.offer)) resumePairing(kept);
      else show({ ...shown, account: withRefusal(account.state) });
      return;
    }
    if (app !== null && last !== null) setPcNewness(heldOf(last));
    if (app === null && shown?.kind === "confirm") show(confirmOf(shown.offer));
    // a launch waiting on its card for the account's PCs goes on once they are read
    else if (frontUp() || (accountLaunch && app === null && !left && launchCard !== null && shown === launchCard)) { if (sheetJoin && shown) show(shown); else await showFront(); }
    signedInNow = false;
  };
  /**
   * The account as the sign-in screen draws it: a refusal a web return brought along shows, with its provider, until the
   * next try, whatever sign-in another tab stored meanwhile.
   */
  const withRefusal = (view: AccountView | null): AccountView | null => refusal !== null && signInFor === null && view?.kind !== "signing-in"
    ? { kind: "signed-out", error: refusal, ...(refusalProvider === null ? {} : { provider: refusalProvider }) } : view;
  /**
   * A marked code scanned longer ago than it is good for: the one check every start of its sign-in or pairing goes
   * through (a press, Try again, a sign-in's return, the app's sheet), which then asks for a new scan.
   */
  const codeLapsed = (offer: RelayOffer): boolean => offer.code !== undefined && offer.admission === 1 && scanned?.offer === offer && Date.now() - scanned.at > SIGN_IN_MS;
  const askNewScan = (offer: RelayOffer): void => { show({ kind: "failed", failure: "scan-expired", name: offer.name ?? null, detail: null, server_id: offer.server_id }); };
  /**
   * Reconnecting by itself is opening by itself. A session this device opened with its list key goes on only while
   * its own copy of the list holds that PC and this device: once the copy says otherwise, the session is ended here
   * and not opened again by itself, and the screen says what the list says. A PC the list put out need not end the
   * session itself, and a PC that was taken over would not.
   */
  const listMoved = (): void => {
    const open = transport, attempt = last;
    if (open === null || attempt === null || attempt.listOpen === undefined) return;
    // the page's list is another account's now (signed in on this browser in another tab): it says nothing of this
    // session's PC, which is neither put out nor handed anything for it
    if (gossipFor === open && gossipAccount !== null && account.list?.view().account !== gossipAccount) return;
    const says = account.listSays(attempt.offer.server_id);
    if (says === "holds" || says === "unknown") return;
    transport = null;
    app?.unmount();
    app = null;
    updates.cancel();
    // the list put the PC out: this device's own use of it ends here, and over the session it still has it tries once,
    // for a few seconds at most, to hand that PC the removal before it closes it (for a PC the service withholds it from).
    // The exchanges of the app's own use end first, one under way too: nothing a late answer of that PC brings is taken
    if (says === "pc-out") {
      if (gossipFor === open) { stopGossip?.(); stopGossip = null; gossipFor = null; }
      void deliverOnce(open, account.list, budgetOf(open, attempt.offer.server_id), undefined, attempt.offer.server_id).finally(() => { open.close(); });
      show({ kind: "failed", failure: "list-removed", name: attempt.offer.name ?? null, detail: null, server_id: attempt.offer.server_id });
      return;
    }
    open.close();
    // the list holds this device no more (or its time is over): as when the PC refuses its key, which it would
    void failed(new MuxProtocolError("auth_failed", "This device's copy of the account's list holds it no more"), attempt);
  };
  const account = createAccountController(mount, { active: frontUp, changed: accountChanged, listMoved, outdated: () => new Set([...observedVersions()].filter(([, value]) => value.outdated).map(([id]) => id)) });
  accountRead = !account.enabled;
  // the PC page this shell opens acts on the account through these: Settings → Devices and PCs → Manage account
  keepShellAccount(account.enabled ? {
    signOut: account.signOut, leave: account.leave,
    signInAgain: (provider) => account.signIn(provider, undefined, undefined, entry.serverId ?? undefined),
    signOutEverywhere: (confirmed) => account.signOutEverywhere(entry.serverId ?? undefined, confirmed),
    freshSignIn: account.freshSignIn,
    deleteAccount: async () => {
      await account.deleteAccount();
      const now = account.state;
      return now?.kind === "signed-in" ? now.deleteError ?? null : null;
    },
  } : null);
  /**
   * What the confirm says now. Signed in, nothing can be confirmed until the directory is read: before that, whether
   * the pairing adds the PC to the account is not known. A directory whose read failed, or was not answered in time,
   * says nothing about now, and the PC then counts as one this pairing adds. A sign-in that was not read in time
   * (the store did not answer, or a sign-in's return did not finish) counts as none: the pairing then uses a key of
   * the device's own, which only ever keeps a PC out of an account.
   */
  const confirmOf = (offer: RelayOffer): Extract<RelayShellState, { kind: "confirm" }> => {
    const view = account.state, signIn = account.signedInAs;
    const said = confirming || ((!accountRead || view?.kind === "signing-in") && !unanswered) ? "checking" as const
      : view?.kind !== "signed-in" ? undefined
      : signIn === undefined || (view.pcs === null && !unanswered) ? "checking" as const
      : !unanswered && view.error === null && account.directory.some((pc) => pc.server_id === offer.server_id) ? "listed" as const : "unlisted" as const;
    const state: Extract<RelayShellState, { kind: "confirm" }> = { kind: "confirm", offer, ...(said === undefined ? {} : { account: said }), ...(confirming && pressed !== undefined ? { pressed } : {}), ...(sheetJoin?.alone ? { alone: true as const } : {}) };
    if (signIn !== undefined && (said === "listed" || said === "unlisted")) drawnFor.set(state, signIn);
    return state;
  };
  const waitForRead = (): void => {
    clearTimeout(readWait);
    // fixed wait: a sign-in or an account service that takes longer than this counts as one that did not answer
    readWait = setTimeout(() => {
      if (app !== null || confirming || shown?.kind !== "confirm" || shown.account !== "checking") return;
      unanswered = true;
      show(confirmOf(shown.offer));
    }, ACCOUNT_READ_WAIT_MS);
  };
  const readAgain = (offer: RelayOffer, after: (now: Extract<RelayShellState, { kind: "confirm" }>) => void, asked?: Extract<RelayShellState, { kind: "confirm" }>): void => {
    const mine = ++press;
    confirming = true;
    pressed = asked === undefined || asked.account === "checking" ? undefined : asked.account ?? "own";
    show(confirmOf(offer));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = account.reread().then(() => true, (error: unknown) => { console.warn("Ovis: the sign-in could not be read again", error instanceof Error ? error.name : error); return true; });
    // fixed wait: see ACCOUNT_READ_WAIT_MS
    const waited = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ACCOUNT_READ_WAIT_MS); });
    void Promise.race([read, waited]).then((answered) => {
      clearTimeout(timer);
      if (mine !== press) return;
      confirming = false;
      if (!answered) unanswered = true;
      if (app !== null || shown?.kind !== "confirm") return;
      const now = confirmOf(shown.offer);
      show(now);
      after(now);
    });
  };
  const sweep = createPcSweep(store, { active: frontUp, redraw: () => { if (shown) show(shown); } }, { ...(mount.checkPc ? { probe: mount.checkPc } : {}), ...(directSocket ? { directSocket } : {}) });
  const toFront = (): void => {
    entries++;
    keepFrontChosen(true);
    if (shown?.kind === "ready") {
      cancelAttempt(); sheetJoin = null; entry = { serverId: null, offer: null, damaged: false };
      window.history.replaceState(null, "", "/");
      void account.load(null).then(showFront);
      return;
    }
    cancelAttempt(); navigate("/");
  };
  const show = (state: RelayShellState): void => {
    shown = state;
    const signInFirst = state.kind === "failed" && state.failure === "sign-in-first";
    const signInShown = signInFirst || ((state.kind === "list" || state.kind === "empty") && state.account?.kind === "signed-out");
    if (signInShown && offered === null && account.enabled) {
      offered = account.providers;
      void account.offered().then((list) => { offered = list; if (shell !== null && app === null && !left && shown !== null) show(shown); });
    }
    shell ??= (mount.createRoot ?? createRoot)(mount.container);
    shell.render(createElement(StrictMode, null, createElement(SettingsProvider, null, createElement(RelayShell, {
      state, scoped, iosTab, addEntry: !scoped && entryHash === "#add", pcStatus: new Map(sweep.status), onCheckPcs: () => void sweep.check(), onFindPc: () => void findPc(), onPair: confirmed, onRetry: retry, onCancel: cancel, onBack: toFront, onForget: forget, onForgetSaved: forgetSaved,
      onUpdate: updates.update, onMatch: match, onJoinInstead: joinInstead, onCodeStart: codeStart, onCodeSubmit: codeSubmit, onCodeMatch: codeMatch, onOpenPc: openPc,
      sheetJoin, launchJoin: entry.serverId !== null && launchJoinFor(entry.serverId), onWaitAgain: () => void waitAgain(),
      signedIn: account.state?.kind === "signed-in", onAskAgain: askAgain,
      ...(account.enabled ? { onSignIn: signInFirst ? signInToPair : unpaired !== null ? signInForPc : account.signIn, accountProviders: offered ?? account.providers, onRefreshAccount: () => account.refreshNow() } : {}),
    })))); account.armRefresh();
  };
  const showFront = async (): Promise<void> => {
    const before = shown;
    const devices = await store.list();
    if (shown !== before) return;
    // the app opens on a PC: the first front page of a launch goes straight into the PC this device opened last, by its
    // saved pairing (a page scoped to it connects with the key it holds; nothing is paired here), or, when that one does
    // not answer, the first other saved PC that does. None answering: the front page says no PC is online
    // nothing moved since the entry was read (a link, Back, a sheet's route): the page stays where it was taken
    // one launch a page: a sign-in that lands after a launch found no PC answering asks none of them again
    const order = left || launched || navigatedSinceEntry() || entries !== 0 ? null : launchOrder(devices, launching, signedInNow, launchResumed);
    // a launch with no saved PC answering goes on to the account's PCs this device is not in yet, once they are read
    // and so does a sign-in that finished on this page after the launch, which read no account yet
    // and so does a load of the front page later in the tab with nothing saved here, once its sign-in and the account's PCs
    // are read, unless the person chose the front page (#16): a page still reading or signing in keeps drawing the front page
    const readSignedIn = accountRead && account.state?.kind === "signed-in" && account.state.pcs !== null;
    if (order !== null || ((signedInNow || (launching && devices.length === 0 && !frontChosen() && readSignedIn)) && !accountTried && !left && !navigatedSinceEntry() && entries === 0)) accountLaunch = true;
    if (order !== null && order.length > 0) {
      launched = true;
      const loaded = entries, asking: RelayShellState = { kind: "connecting", name: order[0]?.name ?? null };
      show(asking);
      const pc = await reachable(order);
      // a Cancel or a link meanwhile owns the page
      if (entries !== loaded || shown !== asking) { accountLaunch = false; return; }
      // an address taken meanwhile (the dashboard's, Back) wins over the launch: the front page draws it
      if (pc !== null && !navigatedSinceEntry()) leaveFor(pc);
      noneOnline = pc === null;
    } else if (order !== null && launchResumed) noneOnline = true;
    if (left) return;
    launched = launched || order !== null;
    if (accountLaunch && (navigatedSinceEntry() || entries !== 0)) accountLaunch = false;
    if (accountLaunch) {
      const view = account.state;
      // the stored sign-in is not read yet, or its directory: the launch waits on its card until they are (#16: a slow read
      // never falls back to My PCs), and its Cancel ends it
      const unread = account.enabled && (!accountRead || view?.kind === "signing-in" || (view?.kind === "signed-in" && view.pcs === null && view.error === null));
      if (unread && launchCard === null) {
        launchCard = { kind: "connecting", name: null };
        show(launchCard);
        return;
      }
      if (unread && shown === launchCard) return;
      // only a signed-in read is the launch's one try: a signed-out one leaves it to a sign-in made on this page
      if (view?.kind === "signed-in") accountTried = true;
      // signed in and the directory not read yet: the launch waits for it on its card (accountChanged draws this again)
      accountLaunch = false; launchCard = null;
      // an account PC this device may open by itself (accountOpenablePcs) goes as a saved one does, on its own page
      const opens = lastFirst(accountTargets(devices, launchResumed ? launchTried() : []), lastPc()).slice(0, LAUNCH_PCS);
      if (opens.length > 0) {
        const loaded = entries, asking: RelayShellState = { kind: "connecting", name: opens[0]?.name ?? null };
        show(asking);
        const found = await reachable(opens);
        if (entries !== loaded || shown !== asking) return;
        if (found !== null && !navigatedSinceEntry()) { leaveFor(found); return; }
        if (found === null) noneOnline = true;
      }
      // a PC this launch's own check just found off is no join card's either, whatever the account's last read of it says
      const foundOff = (serverId: string): boolean => {
        const now = sweep.status.get(serverId), found = now?.kind === "checking" ? now.previous : now;
        return found?.kind === "offline" && found.reason === "pc";
      };
      const order = view?.kind === "signed-in" ? accountLaunchPcs((view.pcs ?? []).filter((row) => !foundOff(row.server_id))).slice(0, LAUNCH_PCS) : [];
      let pc: MyPc | null = null;
      if (order.length > 0) {
        // #16: only one that is on is asked; with none on, the front page says to turn one on
        const loaded = entries, asking: RelayShellState = { kind: "connecting", name: order[0]?.name ?? null };
        show(asking);
        const on = await reachable(order.map((row) => ({ server_id: row.server_id, server_public_key: row.join.server_public_key, relay: row.join.relay, name: row.name })));
        if (entries !== loaded || shown !== asking || left) return;
        pc = order.find((row) => row.server_id === on) ?? null;
      }
      // a PC new in the account that this device may sign in to by the account's key gets its sheet and is asked nothing:
      // the person's one press opens it that way (pressedAccountOpen), where a join asked by itself would wait, on a PC no
      // device is in yet, for its own window's Allow. Its page opens nothing by itself, a reload included
      if (pc !== null && isNewAccountPc(pc, Date.now()) && accountOpenOf(pc) !== null) {
        newnessOf(pc.server_id);
        left = true; joinPc(pc, { sheet: "join", alone: true }); return;
      }
      // its join, asked at once (#16: the PC pops its approval by itself), on the PC's own page: never the PC's bare page,
      // which opens a PC the account lets this device into by itself (security-triage condition 3)
      if (pc !== null && joinAtOnce(pc, true)) return;
      // signed in with nothing saved here and none of the account's PCs to ask: one line says to turn a PC on (#16)
      if (view?.kind === "signed-in") { waitingPc = true; waitingPcName = order[0]?.name ?? (view.pcs ?? []).find((row) => !row.paired)?.name ?? null; }
    }
    // the line to turn a PC on stays while it holds: signed in, nothing saved here, and the account lists PCs not on yet
    const view = account.state;
    waitingPc = waitingPc && devices.length === 0 && view?.kind === "signed-in" && (view.pcs ?? []).some((row) => !row.paired);
    show({ ...(devices.length ? { kind: "list", devices } : { kind: "empty", ...(waitingPc ? { waitPc: true as const, ...(waitingPcName === null ? {} : { offPc: waitingPcName }) } : {}) }), account: account.state, ...(noneOnline ? { noneOnline: true as const } : {}) });
    if (devices.length && !checked) { checked = true; void sweep.check(); }
  };
  /**
   * The first of `order` that its check does not find off, in that order: only a relay that had nobody for a PC (offline,
   * `pc`) passes it over. One that answers, a check the relay turned away or could not finish, and one still running once
   * the launch's wait is over all open that PC, whose page connects, retries and says why it cannot. Null when every
   * one was found off.
   */
  const reachable = async (order: readonly ProbeTarget[]): Promise<string | null> => {
    const checks = checksOf(order, (now) => now.kind === "offline" && now.reason === "pc");
    let timer: ReturnType<typeof setTimeout> | undefined;
    // fixed wait: a PC whose check has not settled by then opens anyway, as the last PC always did
    const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), LAUNCH_WAIT_MS); });
    let found: string | null = null;
    for (const [index, off] of checks.entries()) {
      if (!await Promise.race([off, late])) { found = order[index]?.server_id ?? null; break; }
    }
    clearTimeout(timer);
    return found;
  };
  /**
   * Each PC of `order` checked, after what is queued, and whether this check found it `so`. A check the relay turned away
   * puts back what the last one found, so only this check's own word counts.
   */
  const checksOf = (order: readonly ProbeTarget[], so: (now: PcFinding) => boolean): Promise<boolean>[] => order.map((pc) => {
    const before = sweep.status.get(pc.server_id), prior = before?.kind === "checking" ? before.previous : before;
    return sweep.checkOne(pc.server_id, "back", pc).then(() => {
      const now = sweep.status.get(pc.server_id);
      return now !== undefined && now.kind !== "checking" && now !== prior && so(now);
    });
  });
  /** The first of `order` whose check finds it on (it answered), in that order; null when none did. */
  const answering = async (order: readonly ProbeTarget[]): Promise<string | null> => {
    for (const [index, on] of checksOf(order, (now) => now.kind === "answered").entries()) if (await on) return order[index]?.server_id ?? null;
    return null;
  };
  /**
   * The account's PCs, as last read, that this device may open by itself (accountOpenablePcs) and is not told to `skip`.
   * Signed out, or the directory not read: none.
   */
  const accountTargets = (devices: readonly RelayDevice[], skip: readonly string[]): ProbeTarget[] => {
    const view = account.state, signIn = account.signedInAs;
    if (view?.kind !== "signed-in" || view.pcs === null || signIn === undefined) return [];
    return accountOpenablePcs(view.pcs, { account: signIn.account, devices, now: Date.now() }).filter((pc) => !skip.includes(pc.server_id));
  };
  /** Every PC a launch may open, saved ones and the account's, the one opened last first. */
  const candidates = (devices: readonly RelayDevice[]): ProbeTarget[] => lastFirst([...openablePcs(devices), ...accountTargets(devices, [])], lastPc());
  // a PC of the account with no saved pairing opens on its own page through the account key (the page's load, below)
  // its new window as this page read it goes with it (C3 pin 1, #16): the PC's page holds its sessions before it reads the
  // account's PCs itself, an approved device signing in again included
  const leaveFor = (serverId: string): void => { left = true; newnessOf(serverId); keepLaunchedPc(serverId); navigate(serverScopePath(serverId)); };
  /** Check again on the front page that says no PC is online: the launch's pick once more, over every PC it may open. */
  const findPc = async (): Promise<void> => {
    if (left || !frontUp()) return;
    keepLaunchTried([]);
    const order = candidates(await store.list()).slice(0, LAUNCH_PCS);
    if (order.length === 0) return;
    const loaded = entries, asking: RelayShellState = { kind: "connecting", name: order[0]?.name ?? null };
    show(asking);
    // a navigation in this document while the checks run (another fragment, Back) is the person's: no PC is left for then
    let moved = false;
    const move = (): void => { moved = true; };
    window.addEventListener("hashchange", move);
    window.addEventListener("popstate", move);
    let pc: string | null;
    try { pc = await reachable(order); }
    finally { window.removeEventListener("hashchange", move); window.removeEventListener("popstate", move); }
    // a Cancel meanwhile owns the page
    if (entries !== loaded || shown !== asking) return;
    if (pc !== null && !moved) { leaveFor(pc); return; }
    await showFront();
  };
  /**
   * Ask again on the line that says this device was removed from its PC (#16): that PC's join, asked at once on its own
   * page, as a launch asks it. The front page's launch would open the PC by the account key again, which it just refused,
   * and land here once more: it asks the account's PCs again only where the account's row offers no join for this one.
   */
  const askAgain = (): void => {
    const pc = shown?.kind === "failed" && shown.server_id !== undefined ? rowToJoin(shown.server_id) : undefined;
    cancelAttempt();
    if (pc !== undefined && joinAtOnce(pc)) return;
    keepFrontChosen(false); keepLaunchAccount(); navigate("/");
  };
  /** Check again on the line that says to turn a PC on: the sign-in's launch once more, over the account's PCs as read now. */
  const waitAgain = async (): Promise<void> => {
    if (left || !frontUp()) return;
    await account.load(null);
    keepFrontChosen(false);
    accountTried = false; signedInNow = true;
    try { await showFront(); } finally { signedInNow = false; }
  };
  /** when this page last asked the other PCs whether one is on, after its own PC went away */
  let awayCheckAt = -Infinity;
  /**
   * The PC this page is open on went away (its transport's onPcAway): the page moves to another saved PC that answers,
   * without asking, as the person switching PCs in the sidebar would, at most once a sweep's gap. None answering, or this
   * PC back meanwhile, it stays and keeps reconnecting. Nothing typed is sent: the page leaves the way the app replaces a
   * page (PAGE_LEAVING_EVENT), which keeps what it held in memory alone for this PC's page, never for the next PC.
   */
  const moveAway = async (from: RelayTransport): Promise<void> => {
    if (app === null || transport !== from || last === null || left || document.visibilityState === "hidden") return;
    if (Date.now() - awayCheckAt < CHECK_GAP_MS) return;
    awayCheckAt = Date.now();
    const here = last.offer.server_id;
    // the account's PCs as they are now: this page's own read of them may be old, or was never made. Waited for no longer
    // than a read may take (fixed wait: see ACCOUNT_READ_WAIT_MS): a hung read moves on with what was read before
    if (account.enabled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, ACCOUNT_READ_WAIT_MS); });
      // after the read the opened PC asked for (its newness, enterApp), which a load meanwhile would not wait for
      try { await Promise.race([newnessRead.then(() => account.load(null)), late]); }
      finally { clearTimeout(timer); }
    }
    const pc = await answering(candidates(await store.list()).filter((target) => target.server_id !== here).slice(0, LAUNCH_PCS));
    if (pc === null || app === null || transport !== from || from.route !== undefined || left) return;
    left = true;
    keepLaunchTried([here]);
    keepLaunchedPc(pc);
    window.dispatchEvent(new Event(PAGE_LEAVING_EVENT));
    replace(serverScopePath(pc));
  };
  /**
   * #16: `pc`'s join, asked at once on its own page, where the PC pops its approval by itself. False, with nothing done,
   * where there is no storage for its mark: no join a reload could open by the account's key. `leaving`: a launch sends
   * the front page to it.
   */
  const joinAtOnce = (pc: MyPc, leaving = false): boolean => {
    if (!keepLaunchJoin(pc.server_id)) return false;
    // a PC new in the account that no device is in yet takes the number its screen shows, as on its own page
    const fresh = newPcs([pc], Date.now()).length > 0;
    keepConfirmedPc(pc.server_id);
    // its new window, kept for its own page, which opens it before it reads the account's PCs (#16, C3 pin 1)
    newnessOf(pc.server_id);
    if (leaving) left = true;
    joinPc(pc, { sheet: fresh ? "new" : "join", alone: true, ...(fresh ? { typed: true } : {}) });
    return true;
  };
  const joinPc = (pc: Pick<MyPc, "server_id" | "join"> & { readonly name?: string }, options: { typed?: boolean; sheet?: "new" | "join"; alone?: true } = {}): void => {
    if (!pc.join) return;
    const link = new URL(encodeOffer({ v: 1, server_id: pc.server_id, ...pc.join, ...(pc.name === undefined ? {} : { name: pc.name }) }, window.location.origin));
    keepTypedJoin(options.typed ? pc.server_id : null);
    // a join a PC's own page offers waits for its press: a load of that page (a reload, a restore, a relaunch) asks nothing
    if (options.sheet) keepSheetContext({ mode: options.sheet, server_id: pc.server_id, ...(options.alone ? { alone: true } : {}) });
    // a PC's own page that goes on to its own join leaves no entry of its own behind: one Back leaves the join
    if (options.alone && link.pathname === window.location.pathname) replace(link.pathname + link.hash); else navigate(link.pathname + link.hash);
  };
  /** The account's row for this PC, as last read, when this device is not paired with it and may ask to join it. */
  const rowToJoin = (serverId: string): MyPc | undefined => {
    const view = account.state;
    // only a row this device has no pairing for carries a join (myPcs)
    return view?.kind === "signed-in" ? view.pcs?.find((pc) => pc.server_id === serverId && pc.join !== undefined) : undefined;
  };
  /** The signed-in account's row for this PC when this device is not paired with it and may ask to join it. */
  const accountPcToJoin = async (serverId: string): Promise<MyPc | undefined> => {
    if (!account.enabled) return undefined;
    show({ kind: "connecting", name: null });
    await account.load(null);
    return rowToJoin(serverId);
  };
  /**
   * The account's own way into a PC of the account this device is not paired with: a sign-in with this device's registered
   * key, which the PC takes from the account's device list. None without that key, a key and relay its row's id vouches
   * for, or for a PC whose join card a launch put up (only a press on its link ends that card).
   */
  const accountOpenOf = (pc: MyPc): Attempt | null => {
    if (!pc.join || launchJoinFor(pc.server_id)) return null;
    const fresh = newPcs([pc], Date.now()).length > 0;
    const offer = { v: 1 as const, server_id: pc.server_id, ...pc.join, name: pc.name };
    // A PC the account's signed list holds is opened with the key that list holds for this device. A PC that follows
    // no list refuses that (AccountListUnsupportedError), and the way from before is tried (failed). A PC the list
    // does not hold is opened the way from before, and says so itself where it follows the list all the same (failed).
    const listKey = account.listHolds(pc.server_id) ? account.listKey : null;
    if (listKey !== null) return { offer, code: false, paired: true, listOpen: listKey, ...listForNow(), ...(fresh ? { freshPc: true as const } : {}) };
    const openKey = account.openKey;
    if (pc.accountOpen !== true || openKey === null) return null;
    return { offer, code: false, paired: true, accountOpen: openKey, ...(fresh ? { freshPc: true as const } : {}) };
  };
  /**
   * A press on the join sheet of a PC that nothing opens without that press (one inside its 24 hours in the account, or
   * one the account names that this device's list does not hold): the account's own way first, as a load takes for
   * any other PC, then the join on a refusal (failed). Null when that way cannot be tried here, or for any other PC,
   * whose press sends the join alone, as before.
   */
  const pressedAccountOpen = (serverId: string): Attempt | null => {
    const pc = rowToJoin(serverId);
    const open = pc !== undefined && (isNewAccountPc(pc, Date.now()) || pc.notInList === true) ? accountOpenOf(pc) : null;
    return open === null ? null : { ...open, pressed: true };
  };
  /** The PC's relay key as this device's record of its PCs names it (account/seenPcs.ts). */
  const endpointOf = (offer: RelayOffer): string => Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  /** This device held a session with the PC of `offer` while signed in to `account`, by its own record of its PCs. */
  const letInBefore = (account: string, offer: RelayOffer): boolean => {
    try { return readSeenPcs(account).pcs[endpointOf(offer)]?.since !== undefined; } catch { return false; }
  };
  /**
   * This device's own record of the PCs it held sessions with (account/seenPcs.ts): the PC just let it in, on a
   * channel bound to that PC's relay key, while signed in. Nothing waits for it; a refusal reads it (letInBefore).
   */
  const noteAdmitted = async (attempt: Attempt): Promise<void> => {
    try {
      // the account of the sign-in stored now, read and nothing more: a page that opened a saved PC before it read
      // the account's PCs is signed in all the same
      // The account the pairing was prepared under (the confirm's, where it named one): another tab that signed in as
      // someone else since gets nothing of this act. A session with no such act goes to whoever is signed in.
      const signedIn = attempt.recordFor ?? await account.storedAccount();
      if (signedIn === undefined) return;
      const endpoint = endpointOf(attempt.offer);
      // what this device did itself here: a pairing it just made at the PC, by a QR code of that PC for the account
      // (`added`), or otherwise (a code typed here, the digits, a code for this device alone: `paired`); nothing, where
      // it opened a PC it held or was shown
      const made = !attempt.paired || attempt.fresh === true;
      // a code that carries the account's mark (`admission: 1`): one without it pairs with the PC alone
      const scanned = attempt.code && attempt.offer.admission === 1 && attempt.codeTyped !== true && attempt.accountEnrollment === true && !attempt.accountless;
      await noteSession(signedIn, endpoint, !made ? "none" : scanned ? "added" : "paired");
    } catch (error) {
      console.warn("Ovis: this session was not written to the device's record of its PCs", error instanceof Error ? error.name : error);
    }
  };
  const failed = async (error: unknown, attempt: Attempt): Promise<void> => {
    if (last !== attempt) return;
    comparison = null;
    // This device was let into its account's list for a limited time, and by its own copy that time is over: the PC
    // ended its session, or refused its key, for that. Nobody removed it, so nothing is forgotten and no join is asked
    // for by itself: the screen says that its time is over.
    if (attempt.listOpen !== undefined && error instanceof MuxProtocolError && (error.code === "auth_revoked" || error.code === "auth_failed") && account.listTimeOver()) {
      show({ kind: "failed", failure: "list-time-over", name: attempt.offer.name ?? null, detail: null, server_id: attempt.offer.server_id });
      return;
    }
    // The PC follows no list, and this device came with its list key: the way from before, once. And the other way
    // round: the PC lets its account's devices in by the list (`account_list_required`, or its session ended as a
    // row that changed, at the moment it pinned), so the device reads its list and comes with its list key, once,
    // whether or not its copy names that PC: a PC that follows this device's list lets in the keys that list holds.
    // (only while the list still holds that PC: one it put out meanwhile is not opened the way from before by itself)
    if (attempt.listOpen !== undefined && error instanceof AccountListUnsupportedError && !attempt.retriedListOpen && account.listHolds(attempt.offer.server_id)) {
      const openKey = account.openKey;
      const { listOpen: _key, listFor: _scope, ...rest } = attempt;
      if (openKey !== null) { await connect({ ...rest, accountOpen: openKey, retriedListOpen: true }); return; }
    }
    if (attempt.listOpen === undefined && error instanceof MuxProtocolError && error.code === "account_list_required" && !attempt.retriedListOpen) {
      await account.readList();
      if (last !== attempt) return;
      const listKey = account.listKey;
      const { accountOpen: _key, ...rest } = attempt;
      if (listKey !== null) { await connect({ ...rest, listOpen: listKey, ...listForNow(), retriedListOpen: true }); return; }
      // A pairing of a device with no list to answer with (no account here, or an account that keeps none) is told by
      // this what `auth_failed` tells it: the PC holds that pairing no more. It is read as that, and never leads to a
      // join. (A sign-in through the account that is not let in asks to join, as before.)
      if (attempt.accountOpen === undefined && !account.knowsList) { await failed(new MuxProtocolError("auth_failed", error.message), attempt); return; }
    }
    const refusal = attempt.accountOpen === undefined && attempt.listOpen === undefined ? null : openRefusalOf(error);
    // a PC answers a key it does not list with a bare auth_failed (server/relay/session.ts): after a press on a new PC's
    // sheet, that is the account's way refused too, and the join follows; this device was never in, so nothing is removed.
    // So is it from a PC that never let this device in under its account (a key the account service does not count as
    // the account's, such as a sign-in without two-step): only one that did says it removed this device
    const unlisted = error instanceof MuxProtocolError && error.code === "auth_failed"
      && (attempt.pressed === true || (attempt.accountOpen !== undefined && !letInBefore(attempt.accountOpen.account, attempt.offer)));
    // a list key the PC does not hold, or holds no more, is `auth_failed` too: the device is not in that PC's list, and
    // the way in is to be let in again (the join)
    const notInList = attempt.listOpen !== undefined && (error instanceof AccountListUnsupportedError || (error instanceof MuxProtocolError && (error.code === "auth_failed" || error.code === "account_list_required")));
    // and a device that came with another key, and that the read above found no place for in the list, is not in it
    // either: the PC took nothing away from it, and the way in is the same
    const notLetIn = attempt.listOpen === undefined && error instanceof MuxProtocolError && error.code === "account_list_required";
    const step = notInList || notLetIn || (attempt.accountOpen !== undefined && (error instanceof AccountOpenUnsupportedError || unlisted)) ? { kind: "pair" as const }
      : refusal === null ? null : nextOpenStep(refusal, attempt.retriedAccountOpen === true);
    if (step !== null) {
      switch (step.kind) {
        case "retry": await connect({ ...attempt, retriedAccountOpen: true }); return;
        case "pair":
          cancelAttempt();
          // the press that tried the account's way asked for this join too: sent at once from the sheet it was made on,
          // never by a link to that sheet again. A link's fragment change pops the history entry a phone's sheet holds,
          // which sheetHistory.ts takes for Back: the sheet closes, and the page goes to the front page with no join
          if (attempt.pressed && entry.offer?.server_id === attempt.offer.server_id && sheetJoin?.server_id === attempt.offer.server_id) {
            show(confirmOf(entry.offer));
            pair();
            return;
          }
          joinPc({ ...attempt.offer, join: attempt.offer }, { sheet: attempt.freshPc ? "new" : "join", alone: true, ...(attempt.freshPc ? { typed: true } : {}) });
          return;
        case "wait": {
          show({ kind: "connecting", name: attempt.offer.name ?? null, hold: step.hold });
          if (step.hold.reason === "frozen") return;
          const remainingMs = holdWaitMs(step.hold, Date.now()) ?? 0;
          const retryMs = attempt.holdRetryMs ?? HOLD_RETRY_MIN_MS;
          // The refusal closes the channel, so retry to learn if It's me ended the hold early (OD3).
          // Back off from one second, capped by any remaining time on this PC's deadline.
          holdTimer = setTimeout(() => {
            if (last === attempt) void connect({ ...attempt, holdRetryMs: Math.min(HOLD_RETRY_MAX_MS, retryMs * 2) });
          }, remainingMs > 0 ? Math.min(remainingMs, retryMs) : retryMs);
          return;
        }
        default: {
          const exhaustive: never = step;
          return exhaustive;
        }
      }
    }
    if (pairsAgainWithoutKey(error, { ...attempt, codeless: attempt.codeless === true })) {
      await forgetRow(attempt);
      if (last !== attempt) return;
      await connect({ ...attempt, refreshed: true });
      return;
    }
    // the PC ends a refused row's sessions as it answers that row's first link, and the end may come here first: a
    // marked pairing's link still on its way is waited for, bounded, so its refusal decides what is kept
    const inFlight = linking.get(attempt.offer.server_id);
    if (inFlight !== undefined && refusedLinks.get(attempt.offer.server_id) === undefined) {
      // fixed wait: a link answer that takes longer than the admission's own bound counts as none
      await Promise.race([inFlight, new Promise<void>((resolve) => { setTimeout(resolve, ADMISSION_WAIT_MS); })]);
      if (last !== attempt) return;
    }
    // a first link this PC refused (linkRefused): its words say more than the end of the session that may follow it
    const refused = refusedLinks.get(attempt.offer.server_id);
    let failure = refusalOf(error) ?? failureOf(error, { code: attempt.code, paired: attempt.paired, compared: attempt.compared === true, codeless: attempt.codeless === true });
    // the PC ended a marked pairing's new row before its link passed, with a refusal of its own words or none: the
    // record the scan replaced still names a pairing the PC may hold, and opens it as before the scan
    const restored = refused !== undefined || (attempt.fresh === true && failure === "revoked") ? await reopenOlder(attempt) : "none";
    if (restored === "restored") { refusedLinks.delete(attempt.offer.server_id); return; }
    if (last !== attempt) return;
    if (failure === "revoked") {
      const saved = await store.get(attempt.offer.server_id);
      if (last !== attempt) return;
      // a link whose answer was lost: the PC may hold the account key now, so that key is tried once before anything is
      // forgotten; a link the PC refused never gave it that key
      if (refused === undefined && saved?.pending_key && !attempt.retriedPending) {
        const { pending_key: pending, ...rest } = saved;
        await store.update(saved.server_id, () => ({ ...rest, private_key: pending.private_key, public_spki: pending.public_spki }));
        if (last !== attempt) return;
        await connect({ ...attempt, retriedPending: true });
        return;
      }
      if (saved?.introduced_at !== undefined && Date.now() - saved.introduced_at < INTRODUCED_GRACE_MS) failure = "not-added-yet";
    }
    // forgotten once the PC ended the pairing: its session ended, a sign-in was refused, or it turned a new pairing's
    // first link away (refusalOf: the code ended, the link was for another account than the one it was set up for, or
    // the account did not confirm the device), which ends that row and leaves no older record to reopen
    markedPairings.delete(attempt.offer.server_id);
    // the attempt's own row only, read and deleted in one write: a Forget or a newer pairing made since stands
    const rowEnded = restored === "none" && refused instanceof AccountPcError && refusalOf(refused) !== null;
    if (forgetsDevice(failure) || rowEnded) await forgetRow(attempt).catch(() => undefined);
    // removed by the PC: the front page's list says so until this device opens it again, never on
    if (forgetsDevice(failure)) markRemovedPc(attempt.offer.server_id, "removed");
    if (last !== attempt) return;
    refusedLinks.delete(attempt.offer.server_id);
    const mismatch = error instanceof ServerIdentityChangedError && error.saved !== undefined && error.offered !== undefined
      ? keyMismatch(attempt.offer.server_id, [{ key: error.saved, from: "saved" }, { key: error.offered, from: "link" }]) : null;
    // the PC a launch opened before its check could say it is off: the relay now says nobody answered (timeout: a PC that
    // answered and refused, or ran into an error, is on and keeps its card), and the launch lands where it
    // would have, on the front page, which goes on with the PCs it did not try; a PC opened by a person keeps its card
    if (launchedHere && attempt.paired && attempt.fresh !== true && app === null && failure === "pc-offline" && error instanceof RelayPcOfflineError && refused === undefined && !navigatedSinceEntry() && entries === 0) {
      // left: Back restoring this page from the browser's cache loads it again (the pageshow below)
      cancelAttempt(); left = true; keepLaunchTried([...launchTried(), attempt.offer.server_id]); keepLaunchAccount(); navigate("/"); return;
    }
    show({ kind: "failed", ...(attempt.paired && attempt.fresh !== true ? {} : { pairing: true as const }), failure: (refused === undefined ? null : refusalOf(refused)) ?? failure, name: attempt.offer.name ?? null, detail: null, server_id: attempt.offer.server_id, ...(mismatch ? { mismatch } : {})  });
  };

  const connect = async (attempt: Attempt): Promise<void> => {
    clearTimeout(holdTimer);
    if (!attempt.paired && codeLapsed(attempt.offer)) { askNewScan(attempt.offer); return; }
    attempt.compared = false;
    // nor does a link refused before a new pairing
    if (!attempt.paired) refusedLinks.delete(attempt.offer.server_id);
    last = attempt;
    opening?.abort();
    const controller = new AbortController();
    opening = controller;
    show({ kind: "connecting", name: attempt.offer.name ?? null, ...(attempt.paired && attempt.fresh !== true ? {} : { pairing: true as const }) });
    let opened: RelayTransport;
    try {
      // a saved pairing signs in with the row its record names: that row is the one this attempt may forget
      if (attempt.paired && attempt.accountOpen === undefined && attempt.listOpen === undefined && attempt.row === undefined) {
        attempt.row = (await store.get(attempt.offer.server_id))?.device_id ?? null;
        if (controller.signal.aborted) return;
      }
      const accountOpen = attempt.accountOpen;
      if (accountOpen !== undefined) {
        const session = await account.stored();
        controller.signal.throwIfAborted();
        if (session?.sign_in_id !== accountOpen.sign_in_id || session.account !== accountOpen.account) throw new SignedOutError();
      }
      const listOpen = attempt.listOpen;
      const prepared = accountOpen === undefined && listOpen === undefined ? await account.prepare(attempt.offer, controller.signal, consentOf(attempt)) : {};
      attempt.accountEnrollment = prepared.accountKey !== undefined;
      if (prepared.account !== undefined) attempt.recordFor = prepared.account;
      if (!attempt.paired) {
        const marked = attempt.offer.code !== undefined && attempt.offer.admission === 1;
        const saved = marked ? await store.get(attempt.offer.server_id) : undefined;
        // a Cancel, or another link, while the record was read: what a refused link restores is the newer attempt's
        if (controller.signal.aborted) return;
        if (marked) markedPairings.set(attempt.offer.server_id, saved?.device_id != null ? { older: saved } : {});
        else markedPairings.delete(attempt.offer.server_id);
      }
      opened = await open(attempt.offer, {
        store, label, signal: controller.signal,
        ...prepared,
        ...(accountOpen === undefined ? {} : { store: withAccountDevice(store, accountDevice(attempt.offer, accountOpen.key)), accountOpensAll: true }),
        ...(listOpen === undefined ? {} : { store: withAccountDevice(store, accountDevice(attempt.offer, listOpen)), accountListKey: true }),
        ...(directSocket ? { directSocket, ...(directTailnet ? { directTailnet } : {}) } : {}),
        ...(!attempt.paired && attempt.offer.code !== undefined ? {
          keyProof: (keyFingerprint: string) => {
            if (!controller.signal.aborted && last === attempt && shown?.kind === "connecting") show({ ...shown, keyFingerprint });
          },
        } : {}),
        // a link without a code: the digits wait on screen until this phone says they match
        compare: (digits, approveOn, intoList) => new Promise<void>((resolve) => {
          if (controller.signal.aborted) return;
          attempt.compared = true;
          // a join a PC's own page started for itself: the PC (or a device of the account) takes this number there, and that
          // is the comparison, so the join goes on at once and the screen only shows the number. So does a first join, typed
          // or not: the PC shows this number beside its Allow, and nobody else can approve it. Never a join into the
          // account's list: a member signs the device in on its person's word, so the number waits for this press too
          if (intoList !== true && ((sheetJoin?.alone && attempt.typed !== true) || approveOn !== undefined)) {
            show({ kind: "compare", name: attempt.offer.name ?? null, digits, confirmed: true, challenge: ++challenge, ...(sheetJoin?.alone ? { alone: true as const } : {}), ...(approveOn === undefined ? {} : { approveOn }) });
            resolve();
            return;
          }
          // the sheet and the line that say where to approve stay on screen around the press
          const around = intoList === true && attempt.typed !== true ? { ...(sheetJoin?.alone ? { alone: true as const } : {}), ...(approveOn === undefined ? {} : { approveOn }) } : {};
          comparison = { name: attempt.offer.name ?? null, digits, matched: resolve, typed: attempt.typed === true, ...around };
          show({ kind: "compare", name: comparison.name, digits: comparison.typed ? "" : digits, confirmed: false, challenge: ++challenge, ...(comparison.typed ? { typed: true } : {}), ...around });
        }),
        onPcAway: () => { void moveAway(opened); },
        // the PC turned this phone away after it was in: the app goes, and the reason takes its place
        onFatal: (error) => {
          if (transport !== opened || last === null) return;
          transport = null;
          app?.unmount();
          app = null;
          updates.cancel();
          void failed(error, last);
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ConsentChangedError && last === attempt) {
        if (!attempt.paired && entry.offer === attempt.offer) { last = null; opening = null; readAgain(attempt.offer, () => undefined); return; }
        // a PC this page already paired opens with the key it holds, and joins no account
        if (attempt.paired) { await connect({ ...attempt, accountless: true }); return; }
      }
      await failed(error, attempt);
      return;
    }
    // kept for a reload before the app opens (a newer shell): the page that follows opens this PC from its saved
    // pairing, and must not add it to the account of a sign-in stored since the confirm said "a key of its own"
    keepDeviceOnlyPc(attempt.accountless ? attempt.offer.server_id : null);
    // nor to the account of another sign-in than the one the confirm named: only its id crosses the reload
    keepConfirmedSignIn(attempt.signIn ? { server_id: attempt.offer.server_id, sign_in_id: attempt.signIn.sign_in_id ?? null } : null);
    if (controller.signal.aborted) { opened.close(); return; }
    // The PC let this device into its account's list by an entry, and named its place: the device follows the list
    // from there. That session serves nothing else and no pairing stands behind it, so it is closed at once, before
    // anything is awaited, and the PC is opened anew as a PC of the list, with the key the list holds for this device.
    const place = opened.listPlace;
    if (place !== undefined) {
      opened.close();
      opening = null;
      comparison = null;
      markRemovedPc(attempt.offer.server_id, null);
      // the sign-in ended, or moved to another account, while the place was taken: the front page, which says so; the
      // PC is never opened with the key of another account than the one the place is for
      const taken = await account.takePlace(place).catch((error: unknown) => {
        console.warn("Ovis: the place in the account's list was not taken", error instanceof Error ? error.name : error);
        return false;
      });
      if (controller.signal.aborted || last !== attempt) return;
      const { code: _spent, ...offer } = attempt.offer;
      if (entry.offer !== null) entry = { ...entry, offer: null };
      const key = taken ? account.listKey : null;
      if (key !== null) { await connect({ offer, code: false, paired: true, listOpen: key, ...listForNow() }); return; }
      // the list is not read here yet: the front page, where the PC has its row and a tap opens it
      cancelAttempt();
      void showFront();
      return;
    }
    // the row the PC admitted this session as, which its channel saved: only it may be replaced by an older record, or
    // forgotten. Not read from the store again, where another tab may have saved a newer pairing of this PC since
    attempt.row = opened.deviceId ?? null;
    void noteAdmitted(attempt);
    // the move of an account that was in use onto its list asks this PC, or names the list to it (account/listMigrate.ts)
    void account.sessionOpened(opened, attempt.offer.server_public_key).catch((error: unknown) => console.info("Ovis: this session said nothing for the move onto the account's list", error instanceof Error ? error.name : error));
    opening = null;
    comparison = null;
    markRemovedPc(attempt.offer.server_id, null);
    // the PC admitted this phone: a pairing code is spent, and every later attempt (Try again on
    // the update screen included) signs with the saved device key instead of pairing again
    const { code, ...saved } = attempt.offer;
    const fresh = !attempt.paired || attempt.fresh === true;
    const enrolled: Attempt = { offer: saved, code: false, paired: true, accountEnrollment: attempt.accountEnrollment === true, retryEnrollment: attempt.retryEnrollment === true, ...(attempt.row === undefined ? {} : { row: attempt.row }), ...(fresh ? { fresh: true, introducible: attempt.paired ? attempt.introducible === true : !attempt.code } : {}), ...(attempt.accountless ? { accountless: true } : {}), ...(attempt.signIn ? { signIn: attempt.signIn } : {}), ...(attempt.recordFor === undefined ? {} : { recordFor: attempt.recordFor }), ...(attempt.accountOpen ? { accountOpen: attempt.accountOpen } : {}), ...(attempt.retriedAccountOpen ? { retriedAccountOpen: true } : {}),
      // which key this session signed in with stays with it: a refusal at a later reconnect is read by that. That the
      // other key was tried once on the way here ends with this sign-in: a PC that pins later is asked once more
      ...(attempt.listOpen ? { listOpen: attempt.listOpen, ...(attempt.listFor ? { listFor: attempt.listFor } : {}) } : {}) };
    last = enrolled;
    if (code !== undefined && entry.offer !== null) entry = { ...entry, offer: null };
    transport = opened;
    gossipOver(opened, saved.server_id, enrolled.listOpen === undefined ? undefined : enrolled.listFor);
    await updates.admit(opened, enrolled);
  };


  /**
   * How new this PC is in the account (pcHeld, newPcHere.ts): its window as the account's PCs were last read, kept in this
   * browser for the loads that open it before they read them (a launch reopening the PC); null for a PC past its window,
   * not in the account, or with no account here.
   */
  const newnessOf = (serverId: string): PcNewness => {
    const view = account.enabled && accountRead ? account.state : null;
    // only a read that answered says how new it is: the rows a failed read keeps carry no window
    if (view?.kind === "signed-in" && view.pcs !== null && view.error === null) {
      const row = view.pcs.find((pc) => pc.server_id === serverId);
      const known: { readonly until: number; readonly beforeYou?: true } | null = row === undefined || !isNewAccountPc(row, Date.now()) ? null
        // a window that does not parse may still be open: held for the longest a window lasts
        : { until: row.new_until_unreadable === true ? Date.now() + 86_400_000 : Date.parse(row.new_until ?? ""), ...(row.admitted_before_you === true ? { beforeYou: true as const } : {}) };
      keepNewPc(serverId, known);
      return known;
    }
    const kept = keptNewPc(serverId);
    return kept !== null && kept.until > Date.now() ? kept : null;
  };
  /**
   * What the opened PC's page holds (C3 pin 1, #16): its new window as read or kept, and "unknown" while a sign-in's PCs are
   * not read yet with no window kept here (an approved device signing in again, opened before the read landed); nothing
   * for a pairing that joins no account.
   */
  const heldOf = (attempt: Attempt): PcNewness => {
    const newness = newnessOf(attempt.offer.server_id);
    if (newness !== null || attempt.accountless === true || !account.enabled) return newness;
    const view = account.state;
    // signed in, it is held until a read of the account's PCs answers: one that fails holds it still (fail closed)
    return !accountRead || view?.kind === "signing-in" || (view?.kind === "signed-in" && (view.pcs === null || view.error !== null)) ? "unknown" : null;
  };
  /** the account read the opened PC asked for to learn how new it is (enterApp) */
  let newnessRead: Promise<void> = Promise.resolve();
  const enterApp = (opened: RelayTransport, attempt: Attempt): void => {
    if (launchJoinFor(attempt.offer.server_id)) keepLaunchJoin(null);
    // C3 pin 1 (#16): a PC new in the account opens with nothing of it selected (accountChanged reads it again). Signed in
    // with the account's PCs not read yet and no window kept here (an approved device signing in again, whose launch opened
    // the PC before the read landed), it is held until they are read, which this asks for
    const held = heldOf(attempt);
    setPcNewness(held);
    if (held === "unknown") newnessRead = account.load(null).then(() => setPcNewness(heldOf(attempt)), () => undefined);
    rememberPc(attempt.offer.server_id);
    keepLaunchTried([]);
    // opened here: a PC an introduction alone saved is now one this device chose, which a later launch may reopen
    void store.get(attempt.offer.server_id).then((saved) => saved?.introduced_at === undefined ? undefined
      : store.update(attempt.offer.server_id, (current) => {
        // forgotten meanwhile: a pairing the person removed is never written back
        if (current === undefined) throw new PcForgotten();
        const { introduced_at: _chosen, ...chosen } = current;
        return chosen;
      }))
      .catch((error: unknown) => { if (!(error instanceof PcForgotten)) console.warn("Ovis: this PC could not be marked as opened here", error instanceof Error ? error.name : error); });
    // the pairing's own page opened the PC: a later load of it acts as whoever is signed in then
    keepDeviceOnlyPc(null);
    keepConfirmedSignIn(null);
    setTransport(opened);
    gossipOver(opened, attempt.offer.server_id, attempt.listOpen === undefined ? undefined : attempt.listFor);
    shell?.unmount(); shell = null;
    app = mount.renderApp(); account.armRefresh();
    registerPending(attempt.offer.server_id);
    last = { ...attempt, fresh: false };
  };
  const openPc = (): void => { if (app === null && shown?.kind === "ready" && transport && last) enterApp(transport, last); };
  /**
   * A first link the PC refused (refusalOf): its new row there is gone. Kept for the failure screen, which says why
   * instead of the session's end that follows; while the pairing's own connecting screen is up, that screen comes now,
   * and the app is not opened over the row. True when the refusal was one of those.
   */
  const linkRefused = (opened: RelayTransport, attempt: Attempt, error: unknown): boolean => {
    if (attempt.fresh !== true || refusalOf(error) === null) return false;
    refusedLinks.set(attempt.offer.server_id, error);
    if (app === null && last === attempt && transport === opened && shown?.kind === "connecting") {
      transport = null;
      void failed(error, attempt);
    }
    return true;
  };
  /** Forgets the attempt's own row (Attempt.row), or the saved record when the attempt never knew one. */
  const forgetRow = async (attempt: Attempt): Promise<void> => {
    if (attempt.accountOpen !== undefined || attempt.listOpen !== undefined || attempt.row === null) return;
    if (attempt.row === undefined) await store.remove(attempt.offer.server_id);
    else await store.removeRow(attempt.offer.server_id, attempt.row);
  };
  /**
   * The record of a saved pairing that paired again from a marked code and whose new link was refused: saved again, and
   * the PC opened with it, as it was before the scan. Only while the refused row's own record is the saved one, checked
   * in the same write: a Forget or a newer pairing made since (another tab) stands ("superseded"). "none": there is none.
   */
  const reopenOlder = async (attempt: Attempt): Promise<"restored" | "none" | "superseded"> => {
    const kept = markedPairings.get(attempt.offer.server_id);
    const older = kept?.older;
    if (older === undefined) return "none";
    markedPairings.delete(attempt.offer.server_id);
    let superseded = false;
    try {
      await store.update(older.server_id, (current) => {
        if (current === undefined || attempt.row == null || current.device_id !== attempt.row) { superseded = true; throw new DOMException("The refused pairing was replaced", "AbortError"); }
        return older;
      });
    } catch (error) {
      if (superseded) return "superseded";
      // a store that cannot keep the record says why
      void failed(error, attempt);
      return "restored";
    }
    // a Cancel or another link meanwhile owns the screen
    if (last === attempt) void connect({ offer: offerOf(older), code: false, paired: true, accountEnrollment: attempt.accountEnrollment === true, ...(attempt.signIn ? { signIn: attempt.signIn } : {}) });
    return "restored";
  };
  const enroll = (opened: RelayTransport, attempt: Attempt, settled?: () => void, signal?: AbortSignal): void => {
    // the confirm said this device gets a key of its own: a sign-in stored since then adds nothing to its account here
    // a sign-in through the account, by the registered key or by the list's: no pairing of this device's to enroll
    if (attempt.accountless || attempt.accountOpen !== undefined || attempt.listOpen !== undefined) return;
    enrolling.add(opened);
    const done = account.enroll(opened, attempt.offer.server_id, attempt.fresh === true, attempt.fresh === true && attempt.introducible === true, { consent: consentOf(attempt), ...(settled ? { settled } : {}), ...(signal ? { signal } : {}) }).then((enrollment) => {
      // the new row's link passed (or none was needed): the record it replaced is no longer kept
      markedPairings.delete(attempt.offer.server_id);
      if (app === null && last === attempt && shown?.kind === "ready") show({ ...shown, enrollment });
    }, (error: unknown) => {
      // The pairing was spent on adding the PC to the account's list: its row is gone, and the PC is opened anew as a
      // PC of the list, with the key the list holds for this device. No pairing of this device's stands behind it.
      if (error instanceof AddedToListError) {
        markedPairings.delete(attempt.offer.server_id);
        if (last !== attempt) return;
        const key = account.listKey;
        const { code: _spent, ...offer } = attempt.offer;
        if (transport === opened) transport = null;
        if (key !== null) { void connect({ offer, code: false, paired: true, listOpen: key, ...listForNow() }); return; }
        // the list is not read on this page yet: the front page, where the PC has its row and a tap opens it
        cancelAttempt();
        void showFront();
        return;
      }
      // The PC's entry is in the list and the PC has not read it yet (or that is not known yet), or this device cannot
      // write its account's list: the pairing stays, and nothing is opened over its session, which lets only the
      // account's first steps through. The front page, where the PC has its row
      if (error instanceof PlacedInListError || error instanceof ListUnwritableError) {
        markedPairings.delete(attempt.offer.server_id);
        if (last !== attempt) return;
        cancelAttempt();
        void showFront();
        return;
      }
      if (linkRefused(opened, attempt, error)) return;
      // The account's signed list removed this PC, and it takes no link into that account until it is a new PC. This
      // pairing was not made for the account alone (no mark), so it stands and nothing is forgotten; while its own
      // screen is still up, that screen says why the account did not take the PC, in place of the app.
      if (listRemovedLink(error) && app === null && last === attempt && transport === opened && (shown?.kind === "connecting" || shown?.kind === "ready")) {
        frontSteps?.abort();
        frontSteps = null;
        transport = null;
        show({ kind: "failed", failure: "list-removed", name: attempt.offer.name ?? null, detail: null, server_id: attempt.offer.server_id });
        return;
      }
      console.warn("Ovis: this PC did not join the account yet", error instanceof Error ? error.name : error);
      if (app === null && last === attempt && shown?.kind === "ready") show({ ...shown, enrollment: "failed" });
    }).finally(() => { enrolling.delete(opened); if (transport !== opened) opened.close(); });
    if (attempt.fresh === true && markedPairings.has(attempt.offer.server_id)) {
      const settledLink = done.then(() => undefined, () => undefined);
      linking.set(attempt.offer.server_id, settledLink);
      void settledLink.then(() => { if (linking.get(attempt.offer.server_id) === settledLink) linking.delete(attempt.offer.server_id); });
    }
  };
  const updates = createUpdateFlow(mount.shellVersion ?? __APP_VERSION__, {
    show, failed, reload: mount.reload ?? (() => reloadPage(entry.serverId)),
    // a marked pairing's first link has not passed: the record a refusal restores is kept in this page only
    holdsReload: (attempt) => markedPairings.has(attempt.offer.server_id),
    accepted: (opened, attempt) => {
      if (transport !== opened) return;
      if (attempt.retryEnrollment) { last = attempt; show({ kind: "ready", name: attempt.offer.name ?? null, server_id: attempt.offer.server_id, enrollment: attempt.accountEnrollment ? "pending" : "local" }); enroll(opened, attempt); return; }
      // paired with the account's key just now: the PC's row for this device joins the account by a link, which ends
      // the row's other sessions (this one too), and the session then signs in again. Both happen here, behind the
      // connecting screen, before the app has a terminal for them to end; the rest of the enrollment goes on behind the app
      if (attempt.fresh && attempt.accountEnrollment && !attempt.accountless) {
        last = attempt;
        show({ kind: "connecting", name: attempt.offer.name ?? null, approved: true, pairing: true });
        let waited: ReturnType<typeof setTimeout> | undefined;
        // a Cancel on this screen ends the account steps too: no link, no store write, no app after it
        const steps = new AbortController();
        frontSteps?.abort();
        frontSteps = steps;
        const enter = (): void => {
          clearTimeout(waited);
          // past this point the steps go on behind the app, as any enrollment does, and a Cancel no longer ends them
          if (frontSteps === steps) frontSteps = null;
          if (steps.signal.aborted || transport !== opened || last !== attempt || app !== null) return;
          enterApp(opened, attempt);
        };
        // a marked pairing's row can do nothing but link until its first link passes: its connecting screen and its
        // Cancel stay until that link is answered (settled, or a refusal said) or the attempt ends
        // fixed wait: a PC that takes longer than this over the account's steps is opened without them
        if (!markedPairings.has(attempt.offer.server_id)) waited = setTimeout(enter, ACCOUNT_STEPS_WAIT_MS);
        enroll(opened, attempt, enter, steps.signal);
        return;
      }
      enterApp(opened, attempt);
      enroll(opened, attempt);
    },
  }, store);
  /** `consent`: the sign-in the confirm named, `null` when it said the device gets a key of its own; absent for the sheet's join, which acts as whoever is signed in. */
  const pair = (consent?: AccountSession | null): void => {
    if (entry.offer === null || shown?.kind !== "confirm") return;
    void connect({ offer: entry.offer, code: entry.offer.code !== undefined, paired: false, codeless: entry.offer.code === undefined, typed: typedJoin(entry.offer.server_id), ...(entry.offer.code !== undefined && typedCode(entry.offer) ? { codeTyped: true } : {}), ...(consent === null ? { accountless: true } : consent ? { signIn: consent } : {}) });
  };
  /**
   * The confirm's button. What was confirmed is what the screen said, about the account it named: the sign-in and its
   * directory are read again, and a pairing that would now do something else (another tab signed out, or in, as the
   * same account or another; the PC left the directory) is asked about again instead of made. A press that cannot be
   * shown to match what was drawn pairs nothing. A confirm that said "a key of its own" pairs without the account.
   */
  const confirmed = (): void => {
    const asked = shown, offer = entry.offer;
    if (offer === null || asked?.kind !== "confirm") return;
    // a sheet's join acts as whoever is signed in when it pairs. A PC new in the account is signed in to by the account's
    // key first: its page opened nothing before this press. Which PC it is waits for the read of the account's PCs the
    // sheet started (arrived), so a quick press is not taken for one this page knows nothing of
    if (sheetJoin !== null) {
      const go = (): void => { const open = pressedAccountOpen(offer.server_id); if (open === null) pair(); else void connect(open); };
      const view = account.state;
      if (account.enabled && (!accountRead || view?.kind === "signing-in" || (view?.kind === "signed-in" && view.pcs === null && view.error === null))) readAgain(offer, go);
      else go();
      return;
    }
    if (asked.account === "checking") return;
    if (!account.enabled) { pair(); return; }
    const named = drawnFor.get(asked);
    // a confirm that names an account was drawn for a sign-in: without one, there is nothing it can be held to
    if (asked.account !== undefined && named === undefined) { show(confirmOf(offer)); return; }
    readAgain(offer, (now) => {
      // another link took this one's place meanwhile: it is asked about, and not paired with
      if (entry.offer !== offer || now.offer !== offer || now.account !== asked.account) return;
      const holds = drawnFor.get(now);
      if (named === undefined ? holds !== undefined : holds === undefined || !sameSignIn(named, holds)) return;
      pair(named ?? null);
    }, asked);
  };
  const consentOf = (attempt: Attempt): AccountSession | null | undefined => attempt.accountless ? null : attempt.signIn;
  /**
   * A provider on the failure screen of a marked pairing that stopped for a sign-in: the sign-in starts with the offer (a web
   * sign-in leaves the page, and its pending record carries the offer back), timed from the scan: every try counts from it.
   */
  const signInToPair = (provider: AccountProvider): void => {
    const offer = entry.offer;
    if (offer === null) return;
    if (codeLapsed(offer)) { askNewScan(offer); return; }
    signInFor = { offer, at: scanned?.offer === offer ? scanned.at : Date.now() };
    account.signIn(provider, signInFor);
  };
  /**
   * Signed in: the same pairing's confirm, as after a scan, and nothing is paired until its button is pressed. A sign-in
   * that took longer than a code is good for asks for a new scan instead; the PC checks the code itself either way.
   */
  const resumePairing = (kept: PendingPairing): void => {
    signInFor = null;
    if (codeLapsed(kept.offer)) { askNewScan(kept.offer); return; }
    entry = { ...entry, offer: kept.offer, damaged: false };
    arrived();
  };
  const cancelAttempt = (): void => { signInFor = null; press++; confirming = false; comparison = null; last = null; clearTimeout(holdTimer); opening?.abort(); opening = null; frontSteps?.abort(); frontSteps = null; updates.cancel(); if (transport && !enrolling.has(transport)) transport.close(); transport = null; };
  const retry = (): void => {
    if (shown?.kind === "ready" && shown.enrollment === "failed" && transport && last) { show({ ...shown, enrollment: "pending" }); enroll(transport, last); return; }
    if (last === null || !(shown?.kind === "failed" || shown?.kind === "outdated" || shown?.kind === "compare" && shown.wrong)) return;
    updates.cancel(); transport?.close(); transport = null;
    void connect({ ...last, compared: false });
  };
  const match = (typed?: string): void => {
    const current = comparison;
    if (current === null) return;
    comparison = null;
    if (current.typed && typed !== current.digits) {
      opening?.abort(); opening = null;
      show({ kind: "compare", name: current.name, digits: "", confirmed: false, typed: true, wrong: true, challenge });
      return;
    }
    keepTypedJoin(null);
    show({ kind: "compare", name: current.name, digits: current.typed ? "" : current.digits, confirmed: true, typed: current.typed, challenge,
      ...(current.alone ? { alone: true as const } : {}), ...(current.approveOn === undefined ? {} : { approveOn: current.approveOn }) });
    current.matched();
  };
  /**
   * A typed comparison whose PC shows no number (it is not waiting on its own screen): the request is a join's on the
   * wire, so it goes on as one. This device shows its digits for a device of the account, or the PC, to pick, and the
   * sheet becomes the join sheet; a Try again after it joins rather than types.
   */
  const joinInstead = (): void => {
    const current = comparison;
    if (current === null || !current.typed) return;
    comparison = { ...current, typed: false };
    if (last !== null) last.typed = false;
    keepTypedJoin(null);
    if (sheetJoin !== null) { sheetJoin = { ...sheetJoin, mode: "join" }; keepSheetContext(sheetJoin); }
    show({ kind: "compare", name: current.name, digits: current.digits, confirmed: false, challenge });
  };
  const codeStart = (): void => { cancelAttempt(); codeOffer = null; show({ kind: "code-entry", failure: null }); };
  const codeSubmit = (input: string): void => {
    if (shown?.kind !== "code-entry") return;
    const controller = new AbortController(); opening = controller; codeOffer = null;
    show({ kind: "code-looking" });
    findByCode(input, { signal: controller.signal }).then((offer) => {
      if (controller.signal.aborted) return;
      codeOffer = offer; show({ kind: "code-compare", offer });
    }, (error: unknown) => { if (!controller.signal.aborted) show({ kind: "code-entry", failure: error instanceof TypedCodeError ? error.failure : "unreachable" }); });
  };
  const codeMatch = (): void => { const offer = codeOffer; codeOffer = null; if (offer) { keepConfirmedPc(offer.server_id); keepTypedCode(offer); navigate(encodeOffer(offer, window.location.origin)); } };
  const cancel = (): void => {
    if (entry.serverId !== null && launchJoinFor(entry.serverId)) keepLaunchJoin(null);
    // whatever this page's own load is still waiting for (its saved pairing, the account, a launch) is no longer wanted
    entries++; accountLaunch = false; launchCard = null;
    keepFrontChosen(true);
    if (shown?.kind === "ready") { toFront(); return; }
    cancelAttempt(); keepTypedJoin(null); codeOffer = null;
    if (scoped) toFront(); else void showFront();
  };
  const forget = (): void => {
    keepFrontChosen(true);
    const serverId = last?.offer.server_id ?? entry.serverId, name = last?.offer.name ?? null;
    cancelAttempt(); entry = { ...entry, offer: null };
    if (serverId !== null && deviceOnlyPc() === serverId) keepDeviceOnlyPc(null);
    if (serverId !== null && confirmedSignIn()?.server_id === serverId) keepConfirmedSignIn(null);
    void (async () => { if (serverId !== null) { account.cancelEnrollment(serverId); await forgetSavedPc(serverId, store); } show({ kind: "forgotten", name }); })();
  };
  // one of this phone's pairings forgotten from the front page's list: as Forget this PC does, then the list again
  const forgetSaved = (serverId: string): void => {
    if (deviceOnlyPc() === serverId) keepDeviceOnlyPc(null);
    if (confirmedSignIn()?.server_id === serverId) keepConfirmedSignIn(null);
    void (async () => { account.cancelEnrollment(serverId); await forgetSavedPc(serverId, store); await showFront(); })();
  };
  const arrived = (): boolean => {
    const confirmedPc = takeConfirmedPc();
    // the PC's page a web sign-in's return went on to: taken first, so a page that cannot use it (a damaged or forged
    // link) still clears it, and no later scan of that PC reads it
    const back = takePairingReturn(entry.offer);
    if (entry.damaged) { show({ kind: "failed", failure: "bad-offer", name: null, detail: null }); return true; }
    // a link that puts another key under this PC's id is never paired with, before or after a
    // Forget: it is no attempt (nothing retries it) and it touches no saved key
    if (entry.offer !== null && forgedOffer(entry.offer)) {
      show({ kind: "forged", name: entry.offer.name ?? null, mismatch: keyMismatch(entry.offer.server_id, [{ key: entry.offer.server_public_key, from: "link" }]) });
      entry = { ...entry, offer: null };
      return true;
    }
    if (entry.offer !== null) {
      // the pairing goes on as the sign-in left it, timed from its scan; a note that came too late leaves that code expired
      scanned = back !== null ? { offer: entry.offer, at: back.late ? 0 : back.at } : scanned?.offer === entry.offer ? scanned : { offer: entry.offer, at: Date.now() };
      if (back !== null && codeLapsed(entry.offer)) { askNewScan(entry.offer); return true; }
      if (back?.refused != null) {
        refusal = back.refused;
        refusalProvider = back.provider;
        show({ kind: "failed", failure: "sign-in-first", name: entry.offer.name ?? null, detail: null, server_id: entry.offer.server_id, account: withRefusal(account.state) });
        return true;
      }
      sheetJoin = sheetContext(entry.offer.server_id);
      if (sheetJoin || !accountRead) void account.load(null).finally(() => { if (!accountRead) void accountChanged(); });
      show(confirmOf(entry.offer));
      if (account.enabled && sheetJoin === null) waitForRead();
      // a join a launch asked by itself asks again on a reload of its page (#16): the launch's mark stands for the person's word
      if ((confirmedPc === entry.offer.server_id || (sheetJoin?.alone === true && launchJoinFor(entry.offer.server_id))) && (sheetJoin !== null || entry.offer.code !== undefined)) pair();
      return true;
    }
    return false;
  };

  // a pairing link pasted into this tab while a screen is up changes only the fragment, which
  // loads nothing: it is taken off the address and asked about like one the page loaded with
  window.addEventListener("hashchange", () => {
    if (app !== null || window.location.hash === "") return;
    // an old control page address typed into an open tab lands on the app, as one the page loaded with does
    if (!scoped && oldDashboardHash(window.location.hash)) { window.history.replaceState(null, "", "/"); return; }
    const next = shellEntry(takeEntryUrl(window));
    if (next.offer === null && !next.damaged) return;
    cancelAttempt();
    sheetJoin = null;
    entry = next;
    entries++;
    arrived();
  });


  // read, not taken: this load may itself be reloaded or interrupted before the PC opens, and the load after it must
  // find them too.
  const deviceOnly = deviceOnlyPc(), namedSignIn = confirmedSignIn();
  const unmoved = (): boolean => !navigatedSinceEntry() && entries === 0;
  const stillWanted = async (): Promise<boolean> => unmoved() && await account.stored() === undefined && unmoved();
  /**
   * A sign-in started for this PC's own page: a browser's comes back on the front page alone, which its pending record
   * sends back here once it succeeded (load's `toPc`); the phone app's sheet comes back to this page.
   */
  const signInForPc = (provider: AccountProvider, wanted?: () => boolean | Promise<boolean>): void => {
    account.signIn(provider, undefined, wanted, entry.serverId ?? undefined);
  };
  /**
   * `#sign-in=<provider>` (boot took it off the address, so a reload or Back starts nothing): that provider's sign-in
   * starts once, exactly as a press of its button on this page would. Nothing starts for a provider the account service
   * did not name, on a page signed in (in any tab: the stored session is read right before), or once the page moved
   * since its load (a link, an offer, Back), which is asked again right before the page leaves for the provider.
   */
  const entrySignIn = async (start: (provider: AccountProvider, wanted: () => Promise<boolean>) => void): Promise<void> => {
    const asked = account.enabled ? signInEntry(entryHash) : null;
    if (asked === null || !unmoved() || account.state?.kind === "signed-in") return;
    const provider = (await account.listed()).find((id) => id === asked);
    // asked before it starts, and again once its pending record is written, right before the page leaves for the provider
    if (provider !== undefined && await stillWanted()) start(provider, stillWanted);
  };
  /**
   * A PC's own page that this device has no pairing for: a PC of the account that needs this device approved joins
   * right here, on a screen of its own, and never the list (which only the tabs open). Signed out, the page asks for a
   * sign-in first (its link may name the provider: the QR code a PC in an account shows on Add a connection), and
   * joins once signed in.
   */
  const openUnpaired = async (loaded: number): Promise<void> => {
    if (entry.serverId === null) return;
    const joinable = await accountPcToJoin(entry.serverId);
    if (entries !== loaded) return;
    // a PC added in one press is new to the account for 24 hours (security-triage, condition 3): its page puts up the
    // join sheet and opens nothing by itself, a reload included. The sheet's press signs in with the account's key
    // first, and asks to join only when that is refused (pressedAccountOpen, failed). Past them it opens here as before.
    // A launch never comes here: it reopens only a pairing made on this device by hand.
    // a join card a launch put up and nobody pressed yet asks again on a reload: it never opens the PC by itself
    // a PC new in the account that no device is in yet takes the number its own screen shows, as the dashboard's Add
    // does; any other asks a device already in to approve. The account's own way in, refused, falls back the same way
    const fresh = joinable !== undefined && newPcs([joinable], Date.now()).length > 0;
    // A PC the account names that this device's list does not hold is opened only on a press, at every open: by the
    // press that led here, or by the one on the sheet this page puts up (pressedAccountOpen).
    const open = joinable === undefined || isNewAccountPc(joinable, Date.now()) || (joinable.notInList === true && !tapped) ? null : accountOpenOf(joinable);
    if (open !== null) {
      await connect(open);
    } else if (joinable !== undefined) {
      joinPc(joinable, { sheet: fresh ? "new" : "join", alone: true, ...(fresh ? { typed: true } : {}) });
    } else if (account.enabled && account.state?.kind === "signed-out") {
      unpaired = loaded;
      show({ kind: "empty", account: account.state });
      await entrySignIn(signInForPc);
    }
    else show({ kind: "empty" });
  };

  if (arrived()) return;
  if (entry.serverId !== null) {
    const loaded = entries;
    const saved = await store.get(entry.serverId);
    // a link taken meanwhile owns the page: this load's own entry is not opened, joined or drawn over it
    if (entries !== loaded) return;
    if (saved === undefined) await openUnpaired(loaded);
    // a key saved from a forged link (an earlier build saved before admission): Forget removes it
    else if (forgedOffer(offerOf(saved))) show({ kind: "failed", failure: "identity-changed", name: saved.name ?? null, detail: null, mismatch: keyMismatch(saved.server_id, [{ key: saved.server_public_key, from: "saved" }]) });
    else {
      // this load follows a reload before the app opened, of a pairing whose confirm named a sign-in: it goes on under
      // that sign-in alone. Another one stored by now, or none, gets nothing of it: the PC opens with the key this
      // page holds and joins no account, as after a confirm that said "a key of its own"
      const named = namedSignIn?.server_id === saved.server_id ? namedSignIn : null;
      const now = named === null || named.sign_in_id === null ? undefined : await account.stored();
      if (entries !== loaded) return;
      const signIn = now !== undefined && now.sign_in_id === named?.sign_in_id ? now : undefined;
      const accountless = deviceOnly === saved.server_id || (named !== null && signIn === undefined);
      await connect({ offer: offerOf(saved), code: false, paired: saved.device_id !== null, retryEnrollment: enrollmentOf(saved) === "failed", ...(accountless ? { accountless: true } : signIn ? { signIn } : {}) });
    }
    return;
  }

  await showFront();
  // the return of a sign-in that a marked pairing's failure screen started: that screen stays while the sign-in is read.
  // A newer navigation meanwhile (another PC's link, Back) keeps the sign-in but drops this pairing's screen and handoff
  const loaded = entries;
  let returning: PendingPairing | undefined;
  // the PC whose own page started the sign-in this load returns from: its connecting screen keeps this page from launching
  let returningPc: string | undefined;
  if (left) return;
  await account.load(account.enabled ? signInReturn(new URL(mount.entryUrl).hash) : null, (kept) => {
    if (entries !== loaded) return;
    returning = kept;
    show({ kind: "failed", failure: "sign-in-first", name: kept.offer.name ?? null, detail: null, server_id: kept.offer.server_id, account: account.state });
  }, (outcome) => {
    // a PC's own page started it: signed in by this very sign-in, that page goes on and joins the PC, as soon as it is
    // traded and before any launch of this front page; refused, the front page says why
    if (returningPc !== undefined) {
      if (outcome?.refused === null && entries === loaded && !navigatedSinceEntry()) { left = true; navigate(serverScopePath(returningPc)); }
      return;
    }
    // then the PC's own page goes on with it, as after a scan, never this front page: a PC opens on its page (its worker,
    // its reloads, its Back), and the account service sends a browser back here alone. It goes as soon as the sign-in is
    // traded: the directory read after it waits on the account service, and the PC's confirm reads the account itself
    if (returning === undefined || entries !== loaded) return;
    const { offer, at } = returning;
    // judged by this sign-in's own end, never by a session another tab stored meanwhile
    keepPairingReturn({ server_id: offer.server_id, offer: offerDigest(offer), at, refused: outcome?.refused ?? null, provider: outcome?.provider ?? null, sent: Date.now() });
    const link = new URL(encodeOffer(offer, window.location.origin));
    navigate(link.pathname + link.hash);
  }, (serverId) => {
    if (entries !== loaded || !/^[0-9a-f]{32}$/.test(serverId)) return;
    returningPc = serverId;
    show({ kind: "connecting", name: null });
  });
  if (returningPc !== undefined) {
    if (!left && entries === loaded) await showFront();
    return;
  }
  // a sign-in that came back signed in (not refused or cancelled, whose reason the sign-in screen says)
  if (returning === undefined && signInReturn(entryHash) !== null && account.state?.kind === "signed-in" && frontUp()) { keepFrontChosen(false); launching = signedInNow = true; await showFront(); signedInNow = false; }
  if (returning === undefined) await entrySignIn((provider, wanted) => account.signIn(provider, undefined, wanted));
}
