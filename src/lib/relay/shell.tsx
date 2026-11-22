// allow: SIZE_OK - One state-machine closure shares attempt ownership across connection, cancellation and admission handlers.
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { encodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { AccountOpenUnsupportedError, RelayPcOfflineError } from "../../../shared/relay-channel.ts";
import { GLOBAL_RELAY } from "../../../shared/relay-regions.ts";
import { RelayShell } from "../../components/RelayShell.tsx";
import { accountDevice, withAccountDevice } from "../account/accountDevice.ts";
import { nextOpenStep, openRefusalOf } from "../account/openPc.ts";
import { isNewAccountPc, newPcs, type MyPc } from "../account/myPcs.ts";
import { sameSignIn, SignedOutError } from "../account/service.ts";
import type { AccountProvider, AccountSession, PendingPairing } from "../account/store.ts";
import { SIGN_IN_MS, signInReturn } from "../account/signin.ts";
import { inNativeApp } from "../nativeApp.ts";
import { deviceLabel } from "../phone.ts";
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
import { signInEntry, failureOf, forgedOffer, forgetsDevice, iosBrowserTab, keyMismatch, offerOf, pairsAgainWithoutKey, shellEntry, sheetContext, keepSheetContext, typedJoin, keepTypedJoin, returnHash, keepConfirmedPc, takeConfirmedPc, keepDeviceOnlyPc, deviceOnlyPc, keepConfirmedSignIn, confirmedSignIn, keepPairingReturn, takePairingReturn, offerDigest } from "./shellState.ts";
import type { AccountView, Attempt, RelayShellMount, RelayShellState, SheetJoin } from "./shellState.ts";
import { openRelayTransport, type RelayTransport } from "./transport.ts";
import { offerFromCode, TypedCodeError } from "./pairCode.ts";
import { ADMISSION_WAIT_MS, ConsentChangedError, createAccountController } from "./accountController.ts";
import { keepShellSignOut } from "../account/hostedSignIn.ts";
import { AccountPcError } from "../account/join.ts";
import { refusalOf } from "./firstLink.ts";
import { createPcSweep } from "./pcSweep.ts";
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
 * A launch whose saved PC turned out off on its own page goes on at the front page with the account's PCs, as it would
 * have had the check said so in time: one mark in this tab, taken by the front page that follows.
 */
const LAUNCH_ACCOUNT = "ovis-launch-account";
function keepLaunchAccount(): void {
  try { sessionStorage.setItem(LAUNCH_ACCOUNT, "1"); } catch { /* the front page draws Add a PC */ }
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

/** How many saved PCs a launch asks, and how long it waits for one to answer before it opens none (Add a PC lists them). */
const LAUNCH_PCS = 4;
const LAUNCH_WAIT_MS = 4_000;

/**
 * The saved PCs a launch may open, in the order it prefers them: the one opened last while it is still saved, then the
 * others. Only the first front page of this tab's session opens one (`opens`: it came with no fragment), whatever it
 * shows: Back from a PC, a Cancel on its page, or a reload lands on the front page and stays there. `signedIn`: the page
 * a sign-in returned to, which opens one once its sign-in is read, as the launch it continues would have.
 */
function launchOrder(devices: readonly RelayDevice[], opens: boolean, signedIn = false): RelayDevice[] | null {
  try {
    const first = sessionStorage.getItem(LAUNCHED) === null;
    sessionStorage.setItem(LAUNCHED, "1");
    // a row with no device id is a pairing that never finished: opening its page would ask to pair again. A row an account
    // introduction alone saved (introduced_at) is a PC this device never chose: the app opens it only on a press, and that
    // press marks it chosen (enterApp), never by itself (security-triage, condition 3)
    const paired = devices.filter((device) => device.device_id !== null && device.introduced_at === undefined);
    if (!(opens && (first || signedIn))) return null;
    const last = localStorage.getItem(LAST_PC);
    // the PC opened last here was opened on this device; any other is one a person paired by hand here, never one an
    // account introduction alone saved (security-triage, condition 3: no PC this device did not choose opens by itself)
    return [...paired.filter((device) => device.server_id === last), ...paired.filter((device) => device.server_id !== last)].slice(0, LAUNCH_PCS);
  } catch { return null; }
}

/**
 * The account's PC a launch with no saved PC to open goes to, to join it on its own page (its join card, approved from a
 * device already in): one this device has no pairing for, that has a way to join and was seen lately, the one opened
 * last first, else the one seen most recently. Null when there is none: Add a PC.
 */
function accountLaunchPc(pcs: readonly MyPc[], now: number): MyPc | null {
  // a PC new in the account (new_until) is never picked by itself: security-triage condition 3
  const open = pcs.filter((pc) => !pc.paired && pc.join !== undefined && pc.state !== "offline" && !isNewAccountPc(pc, now));
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_PC); } catch { /* no storage: the most recent one */ }
  const seen = (pc: MyPc): number => pc.last_seen_at === null ? 0 : Date.parse(pc.last_seen_at);
  return open.find((pc) => pc.server_id === last) ?? [...open].sort((a, b) => seen(b) - seen(a))[0] ?? null;
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
  const label = mount.label ?? deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  let entry = shellEntry(mount.entryUrl);
  // bumped by every link this page takes after it loaded, and by Cancel or Back: a step of the page's own load that
  // waited meanwhile is stale and does nothing
  let entries = 0;
  const scoped = entry.serverId !== null;
  // a front page that came with a fragment (a sign-in's return, a link that starts one, a page view) does not open a PC
  // at once: a sign-in's return does once its sign-in is read (below), the others stay where the link put them
  const entryHash = new URL(mount.entryUrl).hash;
  // the phone app's saved row for this app opens it at #pcs (app/web/connect.js), so that it is no launch: that is the
  // app's way to its front page, never a visit to the dashboard, which only its own address in a browser or Settings opens
  if (!scoped && entryHash === "#pcs" && inNativeApp()) window.history.replaceState(null, "", "/");
  // `left`: the launch sent this page to a PC: nothing more is drawn or probed on the way out
  let launching = !scoped && entryHash === "", signedInNow = false, left = false, launched = false, accountLaunch = false;
  // the card a launch waits on for the account's PCs: only while it is the screen does a read of them go on with the launch
  let launchCard: RelayShellState | null = null, accountTried = false;
  let launchWait: ReturnType<typeof setTimeout> | undefined;
  // taken by every page as it loads, acted on by a front page alone: the launch goes on with the account's PCs
  if (takeLaunchAccount() && !scoped && entryHash === "") { accountLaunch = true; launched = true; }
  // Back to a front page the browser kept whole (its back/forward cache) finds it as it left it, on the way to a PC: it
  // loads again, past this tab's launch, so it draws the front page
  if (restored !== null) window.removeEventListener("pageshow", restored);
  restored = (event: PageTransitionEvent) => { if (event.persisted && left) window.location.reload(); };
  window.addEventListener("pageshow", restored);
  if (scoped) markLaunched();
  // this PC's page was opened by a launch, not by a person: if the PC turns out off, the launch goes on to Add a PC
  const launchedHere = scoped && launchedPc === entry.serverId;
  // only a press on a link to that PC (a row of Add a PC, the dashboard, a sidebar) ends a launch's join card: Back, Forward
  // or a reload into it keeps it, so it never opens by the account's key without the person's word
  if (pressedJoin !== null) document.removeEventListener("click", pressedJoin, true);
  pressedJoin = (event: MouseEvent) => {
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const link = typeof target?.closest === "function" ? target.closest("a[href]") : null;
    let id: string | null = null;
    try { id = link === null ? null : serverIdOfPath(new URL(link.getAttribute("href") ?? "", window.location.href).pathname); } catch { /* not an address */ }
    if (id !== null && launchJoinFor(id)) keepLaunchJoin(null);
  };
  document.addEventListener("click", pressedJoin, true);
  const iosTab = iosBrowserTab({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone: "standalone" in navigator && navigator.standalone === true });
  let shell: Root | null = null, app: Root | null = null, transport: RelayTransport | null = null;
  let last: Attempt | null = null, opening: AbortController | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let shown: RelayShellState | null = null, sheetJoin: SheetJoin | null = null, codeOffer: RelayOffer | null = null;
  let comparison: { name: string | null; digits: string; matched: () => void; typed: boolean } | null = null;
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
  const accountChanged = async (): Promise<void> => {
    // a sign-in that finished on this page (the phone app's own sheet) goes on as the launch it interrupted, as a
    // browser's return to the page does
    const finished = signingIn && account.state?.kind === "signed-in";
    signingIn = account.state?.kind === "signing-in";
    if (finished && !scoped) { launching = signedInNow = true; }
    const read = account.state?.kind !== "signing-in";
    if (read) accountRead = true;
    if (read && (account.state?.kind !== "signed-in" || account.state.pcs !== null)) unanswered = false;
    if (signInFor !== null && shown?.kind === "failed" && shown.failure === "sign-in-first") {
      const kept = signInFor;
      if (account.state?.kind === "signed-in" || codeLapsed(kept.offer)) resumePairing(kept);
      else show({ ...shown, account: withRefusal(account.state) });
      return;
    }
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
  const account = createAccountController(mount, { active: frontUp, changed: accountChanged, outdated: () => new Set([...observedVersions()].filter(([, value]) => value.outdated).map(([id]) => id)) });
  accountRead = !account.enabled;
  // the PC page this shell opens signs out with the overview's own Sign out, offered where the overview offers it
  keepShellSignOut(account.enabled ? account.signOut : null);
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
    if (shown?.kind === "ready") {
      const returnHash = sheetJoin?.returnHash ?? "";
      cancelAttempt(); sheetJoin = null; entry = { serverId: null, offer: null, damaged: false };
      window.history.replaceState(null, "", "/" + returnHash);
      void account.load(null).then(showFront);
      return;
    }
    cancelAttempt(); navigate("/" + (sheetJoin?.returnHash ?? ""));
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
      state, scoped, iosTab, addEntry: !scoped && entryHash === "#add", pcStatus: new Map(sweep.status), onCheckPcs: () => void sweep.check(), onCheckPc: (serverId: string) => void sweep.checkOne(serverId), onPair: confirmed, onRetry: retry, onCancel: cancel, onBack: toFront, onForget: forget,
      onForgetPc: async (serverId: string) => { account.cancelEnrollment(serverId); await forgetSavedPc(serverId, store); await account.refresh(); if (frontUp()) await showFront(); },
      onUpdate: updates.update, onMatch: match, onJoinInstead: joinInstead, onCodeStart: codeStart, onCodeSubmit: codeSubmit, onCodeMatch: codeMatch, onOpenPc: openPc, defaultRelay: GLOBAL_RELAY, meLabel: label,
      directoryRelays: account.directory, sheetJoin,
      // a join a PC's own page started for itself stands alone: no list is drawn behind it (the tabs open the list)
      ...(sheetJoin?.alone ? {} : { continuedAccount: sheetJoin ? account.state : null }), observedVersions: observedVersions(),
      ...(account.enabled ? { onSignIn: signInFirst ? signInToPair : account.signIn, accountProviders: offered ?? account.providers, onJoin: joinPc, onSignOut: account.signOut, onLeave: account.leave, onDeleteAccount: account.deleteAccount, ...(account.signedInAs?.sign_in_id === undefined ? {} : { accountSignIn: account.signedInAs.sign_in_id }), onRefreshAccount: () => account.refreshNow() } : {}),
    })))); account.armRefresh();
  };
  const showFront = async (): Promise<void> => {
    const before = shown;
    const devices = await store.list();
    if (shown !== before) return;
    // the app opens on a PC: the first front page of a launch goes straight into the PC this device opened last, by its
    // saved pairing (a page scoped to it connects with the key it holds; nothing is paired here), or, when that one does
    // not answer, the first other saved PC that does. None answering: Add a PC, which lists them
    // nothing moved since the entry was read (a link, Back, a sheet's route): the page stays where it was taken
    // one launch a page: a sign-in that lands after a launch found no PC answering asks none of them again
    const order = left || launched || navigatedSinceEntry() || entries !== 0 ? null : launchOrder(devices, launching, signedInNow);
    // a launch with no saved PC answering goes on to the account's PCs this device is not in yet, once they are read
    // and so does a sign-in that finished on this page after the launch, which read no account yet
    if (order !== null || (signedInNow && !accountTried && !left && !navigatedSinceEntry() && entries === 0)) accountLaunch = true;
    if (order !== null && order.length > 0) {
      launched = true;
      const loaded = entries, asking: RelayShellState = { kind: "connecting", name: order[0]?.name ?? null };
      show(asking);
      const pc = await reachable(order);
      // a Cancel or a link meanwhile owns the page
      if (entries !== loaded || shown !== asking) { accountLaunch = false; return; }
      // an address taken meanwhile (the dashboard's, Back) wins over the launch: the front page draws it
      if (pc !== null && !navigatedSinceEntry()) { left = true; keepLaunchedPc(pc); navigate(serverScopePath(pc)); }
    }
    if (left) return;
    launched = launched || order !== null;
    if (accountLaunch && (navigatedSinceEntry() || entries !== 0)) accountLaunch = false;
    if (accountLaunch) {
      const view = account.state;
      // the stored sign-in is not read yet, or its directory: the launch waits on its card, never longer than a read may take
      const unread = account.enabled && (!accountRead || view?.kind === "signing-in" || (view?.kind === "signed-in" && view.pcs === null && view.error === null));
      if (unread && launchCard === null) {
        launchCard = { kind: "connecting", name: null };
        show(launchCard);
        const card = launchCard;
        // fixed wait: a sign-in or a directory that has not answered by then opens no PC; the front page draws what is known
        // and it ends this launch: a sign-in or directory answering later does not take the page from what the person does next
        clearTimeout(launchWait);
        launchWait = setTimeout(() => { if (shown === card && launchCard === card) { accountLaunch = false; accountTried = true; launchCard = null; void showFront(); } }, ACCOUNT_READ_WAIT_MS);
        return;
      }
      if (unread && shown === launchCard) return;
      // only a signed-in read is the launch's one try: a signed-out one leaves it to a sign-in made on this page
      if (view?.kind === "signed-in") accountTried = true;
      // signed in and the directory not read yet: the launch waits for it on its card (accountChanged draws this again)
      accountLaunch = false; launchCard = null;
      const pc = view?.kind === "signed-in" ? accountLaunchPc(view.pcs ?? [], Date.now()) : null;
      // its join card, waiting for the person's press: never the PC's bare page, which opens a PC the account lets this
      // device into by itself (security-triage condition 3: nothing this device did not choose opens without a press)
      // no storage for the mark: no card a reload could open by the account's key; the front page lists the PC instead
      if (pc !== null && keepLaunchJoin(pc.server_id)) {
        // a PC new in the account that no device is in yet takes the number its screen shows, as on its own page
        const fresh = newPcs([pc], Date.now()).length > 0;
        left = true; joinPc(pc, { sheet: fresh ? "new" : "join", alone: true, ...(fresh ? { typed: true } : {}) }); return;
      }
    }
    show(devices.length ? { kind: "list", devices, account: account.state } : { kind: "empty", account: account.state });
    if (devices.length && !checked) { checked = true; void sweep.check(); }
  };
  /**
   * The first of `order` that its check does not find off, in that order: only a relay that had nobody for a PC (offline,
   * `pc`) passes it over. One that answers, a check the relay turned away or could not finish, and one still running once
   * the launch's wait is over all open that PC, whose page connects, retries and says why it cannot. Null when every
   * one was found off.
   */
  const reachable = async (order: readonly RelayDevice[]): Promise<string | null> => {
    // a check the relay turned away puts back what the last one found, so only this check's own word that the PC is off counts
    const checks = order.map((pc) => {
      const shown = sweep.status.get(pc.server_id), prior = shown?.kind === "checking" ? shown.previous : shown;
      return sweep.checkOne(pc.server_id, "back").then(() => { const now = sweep.status.get(pc.server_id); return now?.kind === "offline" && now.reason === "pc" && now !== prior; });
    });
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
  const joinPc = (pc: Pick<MyPc, "server_id" | "join"> & { readonly name?: string }, options: { typed?: boolean; sheet?: "new" | "join"; alone?: true } = {}): void => {
    if (!pc.join) return;
    const link = new URL(encodeOffer({ v: 1, server_id: pc.server_id, ...pc.join, ...(pc.name === undefined ? {} : { name: pc.name }) }, window.location.origin));
    keepTypedJoin(options.typed ? pc.server_id : null);
    if (options.sheet) {
      keepSheetContext({ mode: options.sheet, server_id: pc.server_id, returnHash: returnHash(window.location.hash), ...(options.alone ? { alone: true } : {}) });
      // a join a PC's own page offers waits for its press: a load of that page (a reload, a restore, a relaunch) asks nothing
      if (!options.alone) keepConfirmedPc(pc.server_id);
    }
    // a PC's own page that goes on to its own join leaves no entry of its own behind: one Back leaves the join
    if (options.alone && link.pathname === window.location.pathname) replace(link.pathname + link.hash); else navigate(link.pathname + link.hash);
  };
  /** The signed-in account's row for this PC when this device is not paired with it and may ask to join it. */
  const accountPcToJoin = async (serverId: string): Promise<MyPc | undefined> => {
    if (!account.enabled) return undefined;
    show({ kind: "connecting", name: null });
    await account.load(null);
    const view = account.state;
    // only a row this device has no pairing for carries a join (myPcs)
    return view?.kind === "signed-in" ? view.pcs?.find((pc) => pc.server_id === serverId && pc.join !== undefined) : undefined;
  };
  const failed = async (error: unknown, attempt: Attempt): Promise<void> => {
    if (last !== attempt) return;
    comparison = null;
    const refusal = attempt.accountOpen === undefined ? null : openRefusalOf(error);
    const step = attempt.accountOpen !== undefined && error instanceof AccountOpenUnsupportedError ? { kind: "pair" as const }
      : refusal === null ? null : nextOpenStep(refusal, attempt.retriedAccountOpen === true);
    if (step !== null) {
      switch (step.kind) {
        case "retry": await connect({ ...attempt, retriedAccountOpen: true }); return;
        case "pair":
          cancelAttempt();
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
    const restored = refused === undefined ? "none" : await reopenOlder(attempt);
    if (restored === "restored") { refusedLinks.delete(attempt.offer.server_id); return; }
    if (last !== attempt) return;
    let failure = refusalOf(error) ?? failureOf(error, { code: attempt.code, paired: attempt.paired, compared: attempt.compared === true, codeless: attempt.codeless === true });
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
    if (last !== attempt) return;
    refusedLinks.delete(attempt.offer.server_id);
    const mismatch = error instanceof ServerIdentityChangedError && error.saved !== undefined && error.offered !== undefined
      ? keyMismatch(attempt.offer.server_id, [{ key: error.saved, from: "saved" }, { key: error.offered, from: "link" }]) : null;
    // the PC a launch opened before its check could say it is off: the relay now says nobody answered (timeout: a PC that
    // answered and refused, or ran into an error, is on and keeps its card), and the launch lands where it
    // would have, on the front page (Add a PC), once; a PC opened by a person keeps its card and its Try again
    if (launchedHere && attempt.paired && attempt.fresh !== true && app === null && failure === "pc-offline" && error instanceof RelayPcOfflineError && refused === undefined && !navigatedSinceEntry() && entries === 0) {
      // left: Back restoring this page from the browser's cache loads it again (the pageshow below)
      cancelAttempt(); left = true; keepLaunchAccount(); navigate("/"); return;
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
      if (attempt.paired && attempt.accountOpen === undefined && attempt.row === undefined) {
        attempt.row = (await store.get(attempt.offer.server_id))?.device_id ?? null;
        if (controller.signal.aborted) return;
      }
      const accountOpen = attempt.accountOpen;
      if (accountOpen !== undefined) {
        const session = await account.stored();
        controller.signal.throwIfAborted();
        if (session?.sign_in_id !== accountOpen.sign_in_id || session.account !== accountOpen.account) throw new SignedOutError();
      }
      const prepared = accountOpen === undefined ? await account.prepare(attempt.offer, controller.signal, consentOf(attempt)) : {};
      attempt.accountEnrollment = prepared.accountKey !== undefined;
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
        ...(directSocket ? { directSocket, ...(directTailnet ? { directTailnet } : {}) } : {}),
        ...(!attempt.paired && attempt.offer.code !== undefined ? {
          keyProof: (keyFingerprint: string) => {
            if (!controller.signal.aborted && last === attempt && shown?.kind === "connecting") show({ ...shown, keyFingerprint });
          },
        } : {}),
        // a link without a code: the digits wait on screen until this phone says they match
        compare: (digits) => new Promise<void>((resolve) => {
          if (controller.signal.aborted) return;
          attempt.compared = true;
          // a join a PC's own page started for itself: the PC (or a device of the account) takes this number there, and that
          // is the comparison, so the join goes on at once and the screen only shows the number
          if (sheetJoin?.alone && attempt.typed !== true) {
            show({ kind: "compare", name: attempt.offer.name ?? null, digits, confirmed: true, challenge: ++challenge, alone: true });
            resolve();
            return;
          }
          comparison = { name: attempt.offer.name ?? null, digits, matched: resolve, typed: attempt.typed === true };
          show({ kind: "compare", name: comparison.name, digits: comparison.typed ? "" : digits, confirmed: false, challenge: ++challenge, ...(comparison.typed ? { typed: true } : {}) });
        }),
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
    // the row the PC admitted this session as, which its channel saved: only it may be replaced by an older record, or
    // forgotten. Not read from the store again, where another tab may have saved a newer pairing of this PC since
    attempt.row = opened.deviceId ?? null;
    opening = null;
    comparison = null;
    // the PC admitted this phone: a pairing code is spent, and every later attempt (Try again on
    // the update screen included) signs with the saved device key instead of pairing again
    const { code, ...saved } = attempt.offer;
    const fresh = !attempt.paired || attempt.fresh === true;
    const enrolled: Attempt = { offer: saved, code: false, paired: true, accountEnrollment: attempt.accountEnrollment === true, retryEnrollment: attempt.retryEnrollment === true, ...(attempt.row === undefined ? {} : { row: attempt.row }), ...(fresh ? { fresh: true, introducible: attempt.paired ? attempt.introducible === true : !attempt.code } : {}), ...(attempt.accountless ? { accountless: true } : {}), ...(attempt.signIn ? { signIn: attempt.signIn } : {}), ...(attempt.accountOpen ? { accountOpen: attempt.accountOpen } : {}), ...(attempt.retriedAccountOpen ? { retriedAccountOpen: true } : {}) };
    last = enrolled;
    if (code !== undefined && entry.offer !== null) entry = { ...entry, offer: null };
    transport = opened;
    await updates.admit(opened, enrolled);
  };


  const enterApp = (opened: RelayTransport, attempt: Attempt): void => {
    if (launchJoinFor(attempt.offer.server_id)) keepLaunchJoin(null);
    rememberPc(attempt.offer.server_id);
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
    if (attempt.accountOpen !== undefined || attempt.row === null) return;
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
    if (attempt.accountless || attempt.accountOpen !== undefined) return;
    enrolling.add(opened);
    const done = account.enroll(opened, attempt.offer.server_id, attempt.fresh === true, attempt.fresh === true && attempt.introducible === true, { consent: consentOf(attempt), ...(settled ? { settled } : {}), ...(signal ? { signal } : {}) }).then((enrollment) => {
      // the new row's link passed (or none was needed): the record it replaced is no longer kept
      markedPairings.delete(attempt.offer.server_id);
      if (app === null && last === attempt && shown?.kind === "ready") show({ ...shown, enrollment });
    }, (error: unknown) => {
      if (linkRefused(opened, attempt, error)) return;
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
    void connect({ offer: entry.offer, code: entry.offer.code !== undefined, paired: false, codeless: entry.offer.code === undefined, typed: typedJoin(entry.offer.server_id), ...(consent === null ? { accountless: true } : consent ? { signIn: consent } : {}) });
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
    // a sheet's join acts as whoever is signed in when it pairs, so it waits for no read
    if (sheetJoin !== null) { pair(); return; }
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
    show({ kind: "compare", name: current.name, digits: current.typed ? "" : current.digits, confirmed: true, typed: current.typed, challenge });
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
  const codeMatch = (): void => { const offer = codeOffer; codeOffer = null; if (offer) { keepConfirmedPc(offer.server_id); navigate(encodeOffer(offer, window.location.origin)); } };
  const cancel = (): void => {
    if (entry.serverId !== null && launchJoinFor(entry.serverId)) keepLaunchJoin(null);
    // whatever this page's own load is still waiting for (its saved pairing, the account, a launch) is no longer wanted
    entries++; accountLaunch = false; launchCard = null; clearTimeout(launchWait);
    if (shown?.kind === "ready") { toFront(); return; }
    cancelAttempt(); keepTypedJoin(null); codeOffer = null;
    if (scoped) toFront(); else void showFront();
  };
  const forget = (): void => {
    const serverId = last?.offer.server_id ?? entry.serverId, name = last?.offer.name ?? null;
    cancelAttempt(); entry = { ...entry, offer: null };
    if (serverId !== null && deviceOnlyPc() === serverId) keepDeviceOnlyPc(null);
    if (serverId !== null && confirmedSignIn()?.server_id === serverId) keepConfirmedSignIn(null);
    void (async () => { if (serverId !== null) { account.cancelEnrollment(serverId); await forgetSavedPc(serverId, store); } show({ kind: "forgotten", name }); })();
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
      if (sheetJoin?.returnHash) window.history.replaceState(null, "", new URL(mount.entryUrl).pathname + sheetJoin.returnHash);
      if (sheetJoin || !accountRead) void account.load(null).finally(() => { if (!accountRead) void accountChanged(); });
      show(confirmOf(entry.offer));
      if (account.enabled && sheetJoin === null) waitForRead();
      if (confirmedPc === entry.offer.server_id && (sheetJoin !== null || entry.offer.code !== undefined)) pair();
      return true;
    }
    return false;
  };

  // a pairing link pasted into this tab while a screen is up changes only the fragment, which
  // loads nothing: it is taken off the address and asked about like one the page loaded with
  window.addEventListener("hashchange", () => {
    if (app !== null || window.location.hash === "") return;
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
  if (arrived()) return;
  if (entry.serverId !== null) {
    const loaded = entries;
    const saved = await store.get(entry.serverId);
    // a link taken meanwhile owns the page: this load's own entry is not opened, joined or drawn over it
    if (entries !== loaded) return;
    if (saved === undefined) {
      // a PC's own page that this device has no pairing for: a PC of the account that needs this device approved joins
      // right here, on a screen of its own, and never the list (which only the tabs open)
      const joinable = await accountPcToJoin(entry.serverId);
      if (entries !== loaded) return;
      const openKey = account.openKey;
      // a PC added in one press is new to the account for 24 hours: on its own page, a PC this device never paired with
      // by hand opens only on a press meanwhile (security-triage, condition 3); once that has passed it opens as before.
      // A launch never comes here: it reopens only a pairing made on this device by hand.
      // a join card a launch put up and nobody pressed yet asks again on a reload: it never opens the PC by itself
      // a PC new in the account that no device is in yet takes the number its own screen shows, as the dashboard's Add
      // does; any other asks a device already in to approve. The account's own way in, refused, falls back the same way
      const fresh = joinable !== undefined && newPcs([joinable], Date.now()).length > 0;
      if (joinable?.join && joinable.accountOpen && openKey !== null && !isNewAccountPc(joinable, Date.now()) && !launchJoinFor(joinable.server_id)) {
        await connect({ offer: { v: 1, server_id: joinable.server_id, ...joinable.join, name: joinable.name }, code: false, paired: true, accountOpen: openKey, ...(fresh ? { freshPc: true as const } : {}) });
      } else if (joinable !== undefined) {
        joinPc(joinable, { sheet: fresh ? "new" : "join", alone: true, ...(fresh ? { typed: true } : {}) });
      }
      else show({ kind: "empty" });
    }
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
  if (left) return;
  await account.load(account.enabled ? signInReturn(new URL(mount.entryUrl).hash) : null, (kept) => {
    if (entries !== loaded) return;
    returning = kept;
    show({ kind: "failed", failure: "sign-in-first", name: kept.offer.name ?? null, detail: null, server_id: kept.offer.server_id, account: account.state });
  }, (outcome) => {
    // then the PC's own page goes on with it, as after a scan, never this front page: a PC opens on its page (its worker,
    // its reloads, its Back), and the account service sends a browser back here alone. It goes as soon as the sign-in is
    // traded: the directory read after it waits on the account service, and the PC's confirm reads the account itself
    if (returning === undefined || entries !== loaded) return;
    const { offer, at } = returning;
    // judged by this sign-in's own end, never by a session another tab stored meanwhile
    keepPairingReturn({ server_id: offer.server_id, offer: offerDigest(offer), at, refused: outcome?.refused ?? null, provider: outcome?.provider ?? null, sent: Date.now() });
    const link = new URL(encodeOffer(offer, window.location.origin));
    navigate(link.pathname + link.hash);
  });
  // a sign-in that came back signed in (not refused or cancelled, whose reason the sign-in screen says)
  if (returning === undefined && signInReturn(entryHash) !== null && account.state?.kind === "signed-in" && frontUp()) { launching = signedInNow = true; await showFront(); signedInNow = false; }
  // `#sign-in=<provider>` (boot took it off the address, so a reload or Back starts nothing): that provider's sign-in
  // starts once, exactly as a press of its button on this page would. Nothing starts for a provider the account service
  // did not name, on a page signed in (in any tab: the stored session is read right before), or once the page moved
  // since its load (a link, an offer, Back), which is asked again right before the page leaves for the provider
  const asked = account.enabled && returning === undefined ? signInEntry(new URL(mount.entryUrl).hash) : null;
  const unmoved = (): boolean => !navigatedSinceEntry() && entries === 0;
  const stillWanted = async (): Promise<boolean> => unmoved() && await account.stored() === undefined && unmoved();
  if (asked !== null && unmoved() && account.state?.kind !== "signed-in") {
    const provider = (await account.listed()).find((id) => id === asked);
    // asked before it starts, and again once its pending record is written, right before the page leaves for the provider
    if (provider !== undefined && await stillWanted()) account.signIn(provider, undefined, stillWanted);
  }
}
