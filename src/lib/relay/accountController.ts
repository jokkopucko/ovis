import { ACCOUNT_FEATURE } from "../../../shared/relay-mux.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { newRecordId } from "../../../shared/account-records.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { accountList, type ListOffer } from "../account/accountList.ts";
import { deviceCard, deviceListKeys } from "../account/listKeys.ts";
import { listReading, pcsByList, allOutside, unreadCopy } from "../account/listPcs.ts";
import { dropKnownPcs, keepKnownPcs, knownPcs } from "../account/knownPcs.ts";
import { followAccountList } from "../account/listFollow.ts";
import { listNames } from "../account/listGenesis.ts";
import { myPcs } from "../account/myPcs.ts";
import { signInKey } from "../account/signInKey.ts";
import { AccountService, AccountServiceError, AccountServiceUnreachableError, accountProvidersOf, indexedAccountService, offeredProviders, sameSignIn, shellAccountServiceOf, SignedOutError } from "../account/service.ts";
import type { DirectoryPc } from "../account/service.ts";
import { indexedAccountStore } from "../account/store.ts";
import { beginSignIn, redeemSignIn, SignInError, takePendingSignIn } from "../account/signin.ts";
import type { SignInReturn } from "../account/signin.ts";
import type { AccountKey, AccountProvider, AccountSession, PendingPairing, SignInKey } from "../account/store.ts";
import { AccountPcError, enrollOnPc, keepRemovals, PEER_STATUS_MS, linkThisDevice, needsLink, pcAccountStatus, planEnroll, sendQueuedAdds, takeIntroduction } from "../account/join.ts";
import { setPageAccountList } from "../account/pageList.ts";
import { deleteAccount as deleteAccountOf, holdingSessionStore, installSignInAgain } from "../account/deleteAccount.ts";
import type { LeaveOutcome } from "../account/hostedSignIn.ts";
import { leaveAccount } from "../account/leave.ts";
import { nativeSignIn, nativeSignInAvailable, SignInNotWanted } from "../account/native.ts";
import { deviceOs, thisDeviceLabel } from "../phone.ts";
import { t } from "../i18n.ts";
import { DEVICES_CHANGED_EVENT } from "../useRelay.ts";
import { indexedDeviceStore, type SavedDevice, type EnrollmentState, type RelayDevice, type RelayDeviceStore } from "./device.ts";
import { offerOf } from "./shellState.ts";
import type { AccountView, EnrollmentCompletion } from "./shellState.ts";
import { AdmissionRefusedError, firstLinkRefusal, listRemovedLink, refusalOf } from "./firstLink.ts";
import type { RelayShellMount } from "./shell.tsx";
import { accountOpenablePcs } from "./pcPick.ts";
import { openRelayTransport, type RelayTransport } from "./transport.ts";
import { sendAgainWhenBack } from "./networkRetry.ts";

const INTRODUCTION_WAIT_MS = 60_000;
const INTRODUCTION_POLL_MS = 3_000;
const DIRECTORY_REFRESH_MS = 60_000;
/** How long a pairing waits for the account service to answer its admission: one that never answers must not hold it. */
export const ADMISSION_WAIT_MS = 8_000;
/** A row's links in all, the first included, and the longest wait between two after a 503. */
const LINK_SENDS = 5;
export const LINK_RETRY_MAX_MS = 15_000;
/**
 * `consent`: whose account the pairing was confirmed for. `signal`: the pairing in front of the person was cancelled.
 * From then on the enrollment sends nothing more to the PC or the account service and writes nothing: every step
 * checks it as it checks the pairing it belongs to.
 */
interface EnrollOptions { readonly consent?: PairingConsent; readonly settled?: () => void; readonly signal?: AbortSignal }
/** Waits `ms`, or less when `signal` aborts, which it then throws. */
const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const stop = (): void => { clearTimeout(timer); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  signal?.addEventListener("abort", stop, { once: true });
});
/** A sign-in again, made to delete an account or sign every device out, landed in another account: nothing is done. */
class AnotherAccountError extends Error {
  constructor() { super("The sign-in is for another account"); this.name = "AnotherAccountError"; }
}
/**
 * The sign-in a pairing's confirm was drawn for is no longer the one stored (another tab signed out, or in as someone
 * else): the pairing is not made, and the person is asked again.
 */
export class ConsentChangedError extends Error {
  constructor() { super("The sign-in changed since the pairing was confirmed"); this.name = "ConsentChangedError"; }
}
/**
 * Whose account a pairing may touch: a sign-in, when its confirm named that account; `null`, when the confirm said the
 * device gets a key of its own; `undefined` for an open that no confirm of this page preceded (a saved PC, the Add-a-PC
 * sheet), which acts as whoever is signed in.
 */
export type PairingConsent = AccountSession | null | undefined;
function signInFailure(error: unknown): string {
  if (error instanceof SignInError && error.code === "denied") return t("The sign-in was cancelled.");
  return t("The sign-in did not finish. Try again.");
}


export function createAccountController(mount: RelayShellMount, view: {
  readonly active: () => boolean; readonly changed: () => Promise<void>; readonly outdated: () => ReadonlySet<string>;
  /** this device's copy of the account's list moved: whoever holds a session that the list opened looks at it again */
  readonly listMoved?: () => void;
}) {
  const store = mount.store ?? indexedDeviceStore;
  const accountStore = mount.accountStore ?? indexedAccountStore;
  const accountService = mount.accountService === undefined ? shellAccountServiceOf(document, window.location.origin, nativeSignInAvailable()) : mount.accountService;
  const providers = mount.accountProviders ?? accountProvidersOf(document);
  const account = mount.accountStore === undefined && mount.accountFetch === undefined ? indexedAccountService
    : new AccountService({ store: accountStore, ...(mount.accountFetch ? { fetch: mount.accountFetch } : {}) });
  const label = mount.label ?? thisDeviceLabel();
  const open = mount.open ?? openRelayTransport;
  // this device's copy of the account's signed list: nothing here decides by it yet, and a test that gives its own
  // account store or fetch follows none unless it gives one too
  const lists = accountService === null ? null : mount.accountList !== undefined ? mount.accountList
    : mount.accountStore !== undefined || mount.accountFetch !== undefined ? null
    : accountList({
      service: account, accountStore,
      names: () => listNames(label, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0)),
      linkedPcs: async (id) => (await store.list()).filter((device) => device.account === id).length,
    });
  const followed = lists === null ? null : followAccountList(lists);
  // the page's own list is the one a card that lets a device in signs with (account/pageList.ts)
  if (mount.accountList === undefined && lists !== null) setPageAccountList(lists);
  const forgotten = new Map<string, number>();
  const running = new Map<Promise<unknown>, string>();
  // the cancels of the enrollments running now, by PC: a Forget or a leave also ends what each has out (a request to
  // the account service, a token refresh it waits on, a wait before sending again)
  const stops = new Map<string, Set<AbortController>>();
  const cancelEnrollment = (id: string): void => {
    forgotten.set(id, (forgotten.get(id) ?? 0) + 1);
    for (const stop of stops.get(id) ?? []) stop.abort(new DOMException("The pairing was forgotten or replaced", "AbortError"));
  };
  // the account key a pairing's admission named, by PC: a link that would name another (a leave in another tab replaced
  // the stored key meanwhile) posts that key first, once
  const vouched = new Map<string, string>();
  let accountView: AccountView | null = accountService === null ? null : { kind: "signed-out", error: null };
  let directory: readonly DirectoryPc[] = [];
  /**
   * The rows My PCs is drawn from: for a device that is in its account's signed list, the PCs that list holds, with
   * the directory only as the way to reach them (account/listPcs.ts); the directory as it is otherwise.
   */
  const drawnPcs = (rows: readonly DirectoryPc[], account: string, now: number): readonly DirectoryPc[] => {
    const byList = notRead(account) ? allOutside(rows) : lists === null ? null : pcsByList(lists.view(), account, rows, now);
    drewByList = byList !== null;
    return byList ?? rows;
  };
  /** Whether the rows last drawn came from this device's list (or were marked for one it has not read), and not from the directory as it is. */
  let drewByList = false;
  /**
   * The account whose saved copy of the list this page has not read (no read ended yet, or it failed): a state of its
   * own, never "no list". Its rows are the directory's, every one marked, so nothing opens or asks by itself, and the
   * read is tried again at every refresh.
   */
  let copyUnread: string | null = null;
  const notRead = (account: string): boolean => copyUnread === account && lists !== null && lists.view().account !== account;
  /** That this device cannot read its list of the account, and which way, for the line My PCs then shows; nothing where it can, or has none. */
  const unreadList = (account: string): { list?: "newer" | "damaged" | "unread" } => {
    if (notRead(account)) return { list: "unread" };
    const reading = lists === null ? null : listReading(lists.view(), account);
    return reading === "newer" || reading === "damaged" ? { list: reading } : {};
  };
  /** `at`: when the account last answered; the rows of a failed read are aged to then, never past what it confirmed */
  let listedFor: { readonly epoch: number; readonly projection: { readonly accountKey: string; readonly account: string; readonly registered: boolean }; readonly at: number; readonly openKey: SignInKey | null } | undefined;
  let shownFor: AccountSession | undefined;
  /** the sign-in whose list was last read at once: another one's is read at once too, and by the clock after that */
  let followedFor: AccountSession | undefined;
  let generation = 0;
  let leaving = false;
  /**
   * The delete or the sign-out of every device pressed for (deleteAccount, signOutEverywhere), until it ends: a sign-out,
   * a sign-in or a leave ends it, and every step of it after a wait (the sign-in again, the second request, what is
   * drawn) goes on only while it is still this one.
   */
  let deletion: object | undefined;
  let reading: { readonly epoch: number; readonly read: Promise<void> } | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const changed = async (): Promise<void> => { await view.changed(); armRefresh(); };
  const refresh = async (initial = false, forced = false, registrationJustTried?: AccountSession): Promise<void> => {
    if (reading?.epoch === generation || leaving || (deletion !== undefined && !initial && !forced) || accountService === null || (!initial && !forced && (!view.active() || accountView?.kind !== "signed-in"))) return;
    const epoch = generation;
    let current = accountView;
    const live = (): boolean => epoch === generation;
    let replaced = false;
    // another sign-in took this read's place: the rows kept from the earlier one are not its to draw, not even
    // when its own read then fails, so it starts from its heading alone and is read again
    const replacedBy = (next: AccountSession): void => {
      directory = [];
      listedFor = undefined;
      accountView = { kind: "signed-in", provider: next.provider, pcs: null, error: null };
      shownFor = undefined;
      replaced = true;
    };
    // the sign-in this read is for, once it is known: a read that fails lists the account's PCs it listed last (knownPcs)
    let readFor: AccountSession | undefined;
    const read = (async () => {
      try {
        const session = await account.session();
        if (!live()) return;
        if (session === undefined) { if (initial) { await changed(); return; } throw new SignedOutError(); }
        // named before it is drawn: a confirm drawn from this view records whose account it speaks of
        if (initial) { accountView = { kind: "signed-in", provider: session.provider, pcs: null, error: null }; shownFor = session; await changed(); }
        // the rows on screen are another sign-in's (another tab signed in since they were read): they go before this
        // read, so its failure cannot draw them again under this one
        else if (shownFor !== undefined && !sameSignIn(shownFor, session)) {
          directory = [];
          listedFor = undefined;
          current = accountView = { kind: "signed-in", provider: session.provider, pcs: null, error: null };
          shownFor = session;
          await changed();
          if (!live()) return;
        }
        shownFor = session;
        readFor = session;
        const listed = await account.forSignIn(session).listPcs();
        const kept = await accountStore.get("signin_key");
        const openKey = kept === undefined || kept.account !== session.account || kept.sign_in_id !== session.sign_in_id ? null
          : kept.no !== null ? kept
          : live() && (registrationJustTried === undefined || !sameSignIn(registrationJustTried, session)) ? await registerSignIn(session) : null;
        const devices = await store.list();
        const key = await accountStore.key();
        memberKey = key;
        if (!live()) return;
        // the answer was on its way while another tab stored another sign-in, or none: it is not drawn
        // The list is read after this sign-in's key is registered, which says whether this device may start the
        // account's list. A device that keeps a copy of its account's list draws its PCs by that list from the first
        // draw on, never by the account service's word alone: for it, that read is waited for
        if (followedFor === undefined || !sameSignIn(followedFor, session) || copyUnread === session.account) {
          followedFor = session;
          const round = followed?.poke();
          // a store that cannot even be asked counts as holding a copy: "not read" is never "no list"
          if (lists !== null && await lists.follows(session.account).catch(() => true)) await round;
          if (!live()) return;
          copyUnread = lists !== null && await unreadCopy(lists, session.account) ? session.account : copyUnread === session.account ? null : copyUnread;
          if (!live()) return;
        }
        const still = await account.session();
        if (!live()) return;
        if (still === undefined) throw new SignedOutError();
        if (!sameSignIn(still, session)) { replacedBy(still); return; }
        directory = listed;
        const at = Date.now();
        const projection = { accountKey: key.public_spki, account: session.account, registered: openKey !== null };
        listedFor = { epoch, projection, at, openKey };
        accountView = { kind: "signed-in", provider: session.provider, error: null, pcs: myPcs(drawnPcs(listed, session.account, at), devices, { now: at, ...projection, outdated: view.outdated() }), ...unreadList(session.account) };
        keepKnownPcs(session.account, accountView.pcs ?? []);
        void compareList();
        sendQueuedAdds({ service: account, store: accountStore, account: session.account }).catch((error: unknown) => console.warn("Ovis: kept adds could not be sent", error instanceof Error ? error.name : error));
      } catch (error) {
        if (!live()) return;
        const next = error instanceof SignedOutError ? await account.session().catch(() => undefined) : undefined;
        if (next !== undefined) { if (live()) replacedBy(next); return; }
        if (!live()) return;
        if (error instanceof SignedOutError) { directory = []; dropKnownPcs(); accountView = { kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") }; followedFor = undefined; forgetNames(readFor?.account); followed?.poke(); }
        else {
          console.warn("Ovis: the account's PCs could not be read", error instanceof Error ? error.name : error);
          const devices = await store.list();
          if (!live()) return;
          const kept = current?.kind === "signed-in" && current.pcs !== null && listedFor?.epoch === epoch
            ? myPcs(drawnPcs(directory, listedFor.projection.account, listedFor.at), devices, { now: listedFor.at, ...listedFor.projection, outdated: view.outdated() })
            : current?.kind === "signed-in" && current.pcs !== null ? current.pcs : myPcs([], devices, { now: Date.now(), outdated: view.outdated() });
          const known = readFor === undefined ? [] : knownPcs(readFor.account);
          // what is kept now replaces what an earlier failed read had, even none (another tab's read may have emptied it)
          if (accountView?.kind === "signed-in") {
            const { known: _earlier, ...view } = accountView;
            accountView = { ...view, pcs: kept, ...(known.length > 0 ? { known } : {}), error: t("The account service could not be reached. The PCs this device is paired with still work.") };
          }
        }
      }
      if (live()) await changed();
    })().finally(() => { if (reading?.read === read) reading = undefined; });
    reading = { epoch, read };
    await read;
    // read whatever screen is up: a confirm drawn meanwhile waits for this sign-in's directory, and a Pair press that
    // found another sign-in reads that one's before anything is paired
    if (replaced) await refresh(initial, true);
  };
  /** Holds this device's list against the directory last read, for the record (account/listShadow.ts): it changes nothing drawn. */
  const compareList = async (): Promise<void> => {
    const comparable = (): boolean => shownFor !== undefined && listedFor?.epoch === generation && accountView?.kind === "signed-in" && accountView.pcs !== null;
    if (lists === null || !comparable()) return;
    const [epoch, account] = [generation, shownFor!.account];
    // nothing to compare where this device is in no list of the account: its pairings are not read for it
    const listed = lists.view();
    if (listed.account !== account || listed.status.at !== "following" || listed.status.standing !== "in") return;
    const devices = await store.list().catch(() => null);
    // the sign-in ended, or another took its place, while the pairings were read: its rows are not this comparison's
    if (devices === null || epoch !== generation || !comparable() || shownFor!.account !== account || accountView?.kind !== "signed-in" || accountView.pcs === null) return;
    const here = { account, devices, now: Date.now() };
    const opens = new Set(accountOpenablePcs(accountView.pcs, here).map((pc) => pc.server_id));
    await lists.shadow(here.account, directory, opens).catch((error: unknown) => console.warn("Ovis: the account's list was not compared", error instanceof Error ? error.name : error));
  };
  // the list moved: the rows are drawn again from it and the directory last read, and the two are compared again
  const unfollow = lists?.subscribe(() => {
    view.listMoved?.();
    const failed = (error: unknown): void => console.warn("Ovis: the account's PCs were not drawn again by its list", error instanceof Error ? error.name : error);
    // Only a list that the rows are drawn from, or were, draws them again: on an account that keeps no list, its
    // moves (the first read's "none" most of all) change nothing on the screen, and nothing is drawn for them.
    const account = listedFor?.epoch === generation ? listedFor.projection.account : null;
    const byList = account !== null && (notRead(account) || (lists !== null && listReading(lists.view(), account) !== null));
    if (accountView?.kind === "signed-in" && accountView.pcs !== null && account !== null && (byList || drewByList)) void redraw().then(compareList).catch(failed);
    else void compareList().catch(failed);
  });
  /** A sign-in to `account` ended on this device: as its PCs' names go (dropKnownPcs), so does what opens the names in its list. */
  const forgetNames = (account: string | undefined): void => {
    if (account === undefined) return;
    void lists?.dropNames(account).catch((error: unknown) => console.warn("Ovis: the keys to the list's names were not forgotten", error instanceof Error ? error.name : error));
  };
  /** The rows drawn again from the directory last read and the PCs stored now, with nothing sent to the account service. */
  const redraw = async (): Promise<void> => {
    const devices = await store.list();
    if (accountView?.kind === "signed-in" && accountView.pcs !== null && listedFor?.epoch === generation) {
      const now = Date.now();
      const { list: _before, ...rest } = accountView;
      accountView = { ...rest, pcs: myPcs(drawnPcs(directory, listedFor.projection.account, now), devices, { now, ...listedFor.projection, outdated: view.outdated() }), ...unreadList(listedFor.projection.account) };
    }
    await changed();
  };
  /**
   * The sign-in and its directory, read again now whatever screen is up: for a consent about to be acted on, which
   * no timer keeps fresh (the confirm is not the front page).
   */
  const reread = async (): Promise<void> => {
    while (reading !== undefined) await reading.read.catch(() => undefined);
    if (accountView?.kind !== "signing-in") await refresh(accountView?.kind !== "signed-in", true);
  };
  let asked: Promise<void> | undefined;
  const refreshNow = (): Promise<void> => {
    if (asked !== undefined) return asked;
    const out = reading;
    if (out?.epoch !== generation) return refresh();
    const queued = (async () => {
      await out.read.catch(() => {});
      asked = undefined;
      const next = reading;
      if (next?.epoch === generation) await next.read.catch(() => {});
      else await refresh();
    })();
    asked = queued;
    return queued;
  };
  const armRefresh = (): void => {
    const wanted = view.active() && accountView?.kind === "signed-in" && document.visibilityState === "visible";
    if (wanted && refreshTimer === undefined) refreshTimer = setInterval(() => { void refresh(); }, DIRECTORY_REFRESH_MS);
    else if (!wanted && refreshTimer !== undefined) { clearInterval(refreshTimer); refreshTimer = undefined; }
  };
  const seen = (): void => { if (document.visibilityState === "visible") void refresh(); armRefresh(); };
  document.addEventListener("visibilitychange", seen);
  /** Ends what this controller armed for itself: its refresh timer, its listener for the page coming back, and its place among the list's listeners. */
  const dispose = (): void => {
    if (refreshTimer !== undefined) { clearInterval(refreshTimer); refreshTimer = undefined; }
    document.removeEventListener("visibilitychange", seen);
    unfollow?.();
    // the list's own clock too: its timer, and its listener for the page coming back
    followed?.stop();
  };
  const invalidate = (): void => { deletion = undefined; generation++; directory = []; dropKnownPcs(); accountView = { kind: "signed-out", error: null }; followedFor = undefined; armRefresh(); };
  const signOut = (): void => {
    // the sign-in the person ended, read before anything waits: one made meanwhile stays (service.ts, forSignIn)
    const ending = account.session();
    invalidate();
    void changed();
    void ending.then((session) => session === undefined ? undefined : account.forSignIn(session).signOut()).catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error))
      // the stored sign-in is gone by now: the list's view goes with it, and so does what opens its names
      .finally(() => { void ending.then((session) => forgetNames(session?.account)); followed?.poke(); });
  };
  /** This device leaves the account; the outcome is the asking page's to show (hostedSignIn.ts, LeaveOutcome). */
  const leave = (): Promise<LeaveOutcome> => {
    if (leaving) return Promise.resolve({ left: false, message: null });
    deletion = undefined;
    leaving = true;
    const epoch = ++generation;
    // the sign-in the person leaves, read before anything waits: one made meanwhile is never touched (leave.ts)
    const from = account.session();
    // an enrollment of this tab stops here; one still linking, here or in another tab, is in the leave's snapshot (leave.ts)
    for (const serverId of running.values()) cancelEnrollment(serverId);
    let departing: string | undefined;
    return from.then((session) => {
      if (session === undefined) throw new SignedOutError();
      departing = session.account;
      return leaveAccount({ service: account, accountStore, relayStore: store, session });
    }).then(async ({ unconfirmed }): Promise<LeaveOutcome> => {
      // a PC the account does not list kept this device: say so, rather than claim it is gone everywhere
      const names = new Map((await store.list()).map((device) => [device.server_id, device.name ?? device.server_id.slice(0, 8)]));
      const message = unconfirmed.length === 0 ? null
        : t("This device left the account. These PCs the account does not list still have it, so revoke it on them: {pcs}", { pcs: unconfirmed.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ") });
      // the PCs kept for the account that left; another that signed in meanwhile keeps its own
      dropKnownPcs(departing);
      // the device left with its account key: what it kept of the account's list is no longer its own
      if (departing !== undefined) await lists?.forget(departing).catch((error: unknown) => console.warn("Ovis: the account's list was not forgotten", error instanceof Error ? error.name : error));
      followed?.poke();
      if (epoch === generation) { accountView = { kind: "signed-out", error: message }; await changed(); }
      return { left: true, message };
    }, async (error: unknown): Promise<LeaveOutcome> => {
      console.warn("Ovis: this device did not leave the account", error instanceof Error ? error.name : error);
      if (epoch === generation) await changed();
      return { left: false, message: t("This device could not leave the account. Try again.") };
    }).finally(() => { leaving = false; });
  };

  /**
   * The phone app's sign-in again in place, for an action that wants a sign-in from the last ten minutes: with the method
   * `from` used, and stored in its place only while `from` is still the stored sign-in and `current()` holds, and only
   * for the same account. `refused`: the refusal that asked for it, thrown again once the action was called off.
   */
  const signInAgainInPlace = async (from: AccountSession, service: string, current: () => boolean, refused: unknown): Promise<AccountSession> => {
    // a sign-in another tab stored since is not signed over: the view reads it instead
    const stored = await account.session();
    if (stored === undefined || !sameSignIn(stored, from)) throw new SignedOutError();
    // the sheet's sign-in is not stored by the sheet: only below, once the action is still on and its sign-in still the
    // one stored, so a sign-out or another sign-in while the sheet was open is neither undone nor acted on
    const again = await nativeSignIn(from.provider, { store: holdingSessionStore(accountStore), service });
    if (!current()) throw refused;
    if (again.account !== from.account) throw new AnotherAccountError();
    if (!await installSignInAgain(accountStore, from, again, current)) throw new SignedOutError();
    // a sign-out that landed as the store answered: it ends the sign-in just stored, and the action does not follow
    if (!current()) throw refused;
    return again;
  };
  /** Every sign-in of `session`'s account ends at the service, this device's too: the signed-out page says so. */
  const signedOutEverywhere = async (session: AccountSession): Promise<void> => {
    await account.forSignIn(session).signOutEverywhere();
    for (const serverId of running.values()) cancelEnrollment(serverId);
    invalidate();
    // the stored sign-in is gone: the list's view goes with it, and so does what opens its names
    forgetNames(session.account);
    followed?.poke();
    accountView = { kind: "signed-out", error: null, notice: t("Every device was signed out.") };
    await changed();
  };
  /**
   * Signs every browser and app out of the account (Manage account), this device included; its PCs stay. The service
   * wants a sign-in from the last ten minutes: the phone app signs in again in place and goes on, and a browser signs in
   * again by its redirect, whose return goes on (load) when it comes back for the same account. Answers why nothing was
   * signed out, or null. `pc`: the PC whose own page asked, which a browser's sign-in again returns to.
   */
  const signOutEverywhere = (pc?: string): Promise<string | null> => {
    if (deletion !== undefined || leaving) return Promise.resolve(null);
    const mine = {};
    deletion = mine;
    const epoch = ++generation;
    const current = (): boolean => deletion === mine && epoch === generation;
    // the sign-in the view on screen speaks of, not the one stored now (as deleteAccount)
    const from = accountView?.kind === "signed-in" ? shownFor : undefined;
    return (async (): Promise<string | null> => {
      if (from === undefined) throw new SignedOutError();
      try { await signedOutEverywhere(from); }
      catch (error) {
        if (!(error instanceof AccountServiceError && error.code === "reauth_required") || accountService === null || !current()) throw error;
        if (nativeSignInAvailable()) await signedOutEverywhere(await signInAgainInPlace(from, accountService, current, error));
        else signIn(from.provider, undefined, undefined, pc, from.account);
      }
      return null;
    })().catch(async (error: unknown): Promise<string | null> => {
      if (!current()) return null;
      console.warn("Ovis: every device was not signed out", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      if (error instanceof SignedOutError || error instanceof AnotherAccountError) await refresh(true);
      if (error instanceof SignedOutError) return null;
      if (error instanceof AnotherAccountError) return t("You signed in to another account. No device was signed out.");
      return t("Could not sign out every device. Try again.");
    }).finally(() => { if (deletion === mine) deletion = undefined; });
  };

  const deleteFailure = (error: unknown): string => {
    if (error instanceof AccountServiceError && error.code === "reauth_required") return t("To delete your account, sign out, sign in again, then delete it within ten minutes.");
    if (error instanceof AccountServiceError && error.code === "subscription_active") return t("Cancel your subscription first, then delete the account.");
    if (error instanceof AnotherAccountError) return t("You signed in to another account. Nothing was deleted.");
    return t("The account could not be deleted. Try again.");
  };
  /** PCR-1: a PC's removal wants the same fresh own sign-in: null when none was stored for `from`'s account. */
  const freshSignIn = accountService !== null && nativeSignInAvailable()
    ? (from: AccountSession): Promise<AccountSession | null> => signInAgainInPlace(from, accountService, () => true, new SignedOutError())
      .catch((error: unknown) => error instanceof SignedOutError || error instanceof AnotherAccountError ? null : Promise.reject(error))
    : undefined;
  /**
   * The service wants a sign-in from the last ten minutes: the phone app signs in again in place, with
   * the method this sign-in used, and deletes only if that is the same account; a browser is told to sign in again.
   */
  const deleteAccount = (): Promise<void> => {
    if (deletion !== undefined || leaving) return Promise.resolve();
    const mine = {};
    deletion = mine;
    const epoch = ++generation;
    const current = (): boolean => deletion === mine && epoch === generation;
    // the sign-in the signed-in view on screen speaks of, not the one stored now: one another tab stored meanwhile is
    // never deleted (deleteAccount.ts), and the view then reads it
    const from = accountView?.kind === "signed-in" ? shownFor : undefined;
    if (accountView?.kind === "signed-in" && accountView.deleteError !== undefined) { const { deleteError: _earlier, ...rest } = accountView; accountView = rest; }
    return Promise.resolve(from).then(async (session) => {
      if (session === undefined) throw new SignedOutError();
      try { await deleteAccountOf({ service: account, accountStore, session }); }
      catch (error) {
        if (!(error instanceof AccountServiceError && error.code === "reauth_required") || accountService === null || !nativeSignInAvailable() || !current()) throw error;
        await deleteAccountOf({ service: account, accountStore, session: await signInAgainInPlace(session, accountService, current, error) });
      }
      // the account is gone, and its list with it
      await lists?.forget(session.account).catch((error: unknown) => console.warn("Ovis: the account's list was not forgotten", error instanceof Error ? error.name : error));
      followed?.poke();
    }).then(async () => {
      if (!current()) return;
      // a sign-in that took the deleted one's place while the delete was out stays (deleteAccount.ts): it is shown, saying
      // the account asked for went and that this is another one, so the delete never ends in silence
      if (await account.session().catch(() => undefined) !== undefined) {
        await refresh(true);
        if (current() && accountView?.kind === "signed-in") {
          accountView = { ...accountView, deleteError: t("The previous account was deleted. You're now signed in to another account.") };
          await changed();
        }
        return;
      }
      if (!current()) return;
      for (const serverId of running.values()) cancelEnrollment(serverId);
      directory = [];
      dropKnownPcs();
      accountView = { kind: "signed-out", error: null, notice: t("Your account was deleted.") };
      armRefresh();
      await changed();
    }, async (error: unknown) => {
      if (!current()) return;
      console.warn("Ovis: the account was not deleted", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      if (error instanceof SignedOutError || error instanceof AnotherAccountError) await refresh(true);
      if (!current()) return;
      if (error instanceof SignedOutError && await account.session().catch(() => undefined) === undefined) {
        // nothing is stored any more: the signed-out page. Whether the account went with it is not known here (a delete whose
        // answer was lost, then a refused sign-in, looks the same as a sign-in ended some other way), so the device keeps
        // its account key and records: a key kept too long costs nothing, a live account's key wiped costs its identity
        directory = [];
        dropKnownPcs();
        accountView = { kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") };
        armRefresh();
        await changed();
        return;
      }
      // another tab's sign-in to another account took the place of the one asked about: nothing was deleted, and it says so
      const signedInElsewhere = error instanceof SignedOutError && accountView?.kind === "signed-in"
        && (await account.session().catch(() => undefined))?.account !== from?.account;
      if (accountView?.kind === "signed-in" && (signedInElsewhere || !(error instanceof SignedOutError))) {
        accountView = { ...accountView, deleteError: signedInElsewhere ? t("Not deleted: you're signed in to another account. Sign in to the account you want to delete.") : deleteFailure(error) };
      }
      await changed();
    }).finally(() => { if (deletion === mine) deletion = undefined; });
  };


  const registerSignIn = async (session: AccountSession): Promise<SignInKey | null> => {
    try { return await signInKey(accountStore, account, session, label); }
    catch (error) {
      if (error instanceof AccountServiceError || error instanceof AccountServiceUnreachableError || error instanceof SignedOutError) return null;
      throw error;
    }
  };
  /** `pairing`: a web sign-in leaves the page, so the pairing it is for waits in its pending record (load hands it back) */
  /** `wanted`: asked again right before the page leaves for the provider (after its pending record is written); false leaves the sign-in unstarted */
  /** `pc`: the PC whose own page this is: a web sign-in's return goes back to it (load's `toPc`) */
  /** `everywhere`: the account whose sign-out of every device waits on this web sign-in (signOutEverywhere) */
  const signIn = (provider: AccountProvider, pairing?: PendingPairing, wanted?: () => boolean | Promise<boolean>, pc?: string, everywhere?: string): void => {
    if (accountService === null) return;
    if (accountView?.kind === "signing-in") return;
    deletion = undefined;
    generation++;
    accountView = { kind: "signing-in", provider };
    void changed();
    // in the phone app the system's sign-in sheet brings the return back to the page; elsewhere the page goes to the provider
    const leave = mount.openSignIn ?? ((url: string) => window.location.assign(url));
    const unwanted = async (): Promise<void> => { accountView = { kind: "signed-out", error: null }; await changed(); };
    const native = (): Promise<void> => nativeSignIn(provider, { store: accountStore, service: accountService, ...(wanted ? { wanted } : {}) })
      .then(async (session) => { if (pairing === undefined) await registerSignIn(session); await refresh(true, false, pairing === undefined ? session : undefined); }, (error: unknown) => error instanceof SignInNotWanted ? unwanted() : Promise.reject(error));
    // a press starts as before; a start that asks `wanted` waits on it before it starts, and again before the page (or
    // the app's sheet) leaves for the provider (the link entry, shell.tsx)
    const started = nativeSignInAvailable()
      ? (wanted === undefined ? native() : Promise.resolve(wanted()).then((go) => go ? native() : unwanted()))
      : beginSignIn(provider, { store: accountStore, service: accountService, redirectUri: `${window.location.origin}/`, ...(pairing ? { pairing } : {}), ...(pc ? { pc } : {}), ...(everywhere ? { signOutEverywhere: everywhere } : {}) })
        .then(async (url) => wanted === undefined || await wanted() ? leave(url) : unwanted());
    started.catch(async (error: unknown) => {
      console.warn("Ovis: the sign-in did not start", error);
      accountView = { kind: "signed-out", error: signInFailure(error), provider };
      await changed();
    });
  };
  /**
   * `carried`: told of the pairing the returned sign-in was started for, once it is taken, before the code is traded.
   * `ended`: told how that sign-in itself ended (`refused`: the reason shown; null once its code was traded), whatever
   * session another tab may have stored meanwhile, as soon as the code is traded and before the directory is read;
   * undefined when the return carried no pairing and no PC. `toPc`: told of the PC whose own page started the returned
   * sign-in, once it is taken, before the code is traded (as `carried`).
   */
  const load = async (returned: SignInReturn | null, carried?: (pairing: PendingPairing) => void, ended?: (outcome: { readonly refused: string | null; readonly provider: AccountProvider } | undefined) => void, toPc?: (serverId: string) => void): Promise<void> => {
    let outcome: { readonly refused: string | null; readonly provider: AccountProvider } | undefined;
    let registrationJustTried: AccountSession | undefined;
    if (returned !== null && accountService !== null) {
      const pending = await takePendingSignIn(accountStore, returned.state);
      accountView = { kind: "signing-in", ...(pending ? { provider: pending.provider } : {}) };
      if (pending?.pairing) carried?.(pending.pairing);
      else if (pending?.pc !== undefined) toPc?.(pending.pc);
      await changed();
      try {
        const session = await redeemSignIn(pending, returned, { store: accountStore, ...(mount.accountFetch ? { fetch: mount.accountFetch } : {}) });
        if (pending?.pairing) outcome = { refused: null, provider: pending.provider };
        else if (pending?.sign_out_everywhere === session.account && await signedOutEverywhere(session).then(() => true, (error: unknown) => {
          // still signed in, with a fresh sign-in now: pressing again in Manage account goes through
          console.warn("Ovis: every device was not signed out after the sign-in again", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
          return false;
        })) {
          if (pending.pc !== undefined) outcome = { refused: null, provider: pending.provider };
        } else {
          registrationJustTried = session;
          await registerSignIn(session);
          if (pending?.pc !== undefined) outcome = { refused: null, provider: pending.provider };
        }
      } catch (error) {
        accountView = { kind: "signed-out", error: signInFailure(error), ...(pending ? { provider: pending.provider } : {}) };
        if (pending?.pairing || pending?.pc !== undefined) outcome = { refused: signInFailure(error), provider: pending!.provider };
        await changed();
      }
      ended?.(outcome);
    }
    await refresh(true, false, registrationJustTried);
  };
  /**
   * This device's card for the list of the account `session` signed in to, which it waits to be let into, for the key
   * `key` the join signs with; null for a device that is in a list, or whose claim of that key does not stand. The
   * claim is resolved for the join by a read of the list made now, which also makes it again where it is due: a view
   * drawn before the page slept, or before its first read landed, says nothing of a claim that lasts ten minutes.
   */
  /** The account each list a join brought this device's card for belongs to: the place a PC hands back is that account's. */
  const cardAccounts = new Map<string, string>();
  const cardFor = async (session: AccountSession, key: AccountKey): Promise<{ readonly list: string; readonly enc: string; readonly card: string } | null> => {
    if (lists === null) return null;
    try {
      const view = await lists.sync();
      if (view.account !== session.account || view.status.at !== "not_in" || view.status.why !== "not_mine" || view.status.claim !== "claimed") return null;
      // the sign-in and the key the claim was read for are the join's own: one replaced meanwhile gets no card
      const now = await account.session();
      const keys = await deviceListKeys(accountStore);
      if (now === undefined || !sameSignIn(now, session) || keys.key !== key.public_spki) return null;
      const made = await deviceCard(keys, view.status.list);
      cardAccounts.set(view.status.list, session.account);
      return { list: view.status.list, enc: made.enc, card: made.card };
    } catch (error) {
      console.warn("Ovis: this device's card for the account's list could not be made", error instanceof Error ? error.name : error);
      return null;
    }
  };
  /**
   * The place in the account's list a PC handed this device when it let it in (RelayChannel.listPlace): the device
   * follows the list from there, by its own read of the log, and its key for it is read with the account's PCs. The
   * place is the account's the card was made for, and is kept for that account alone, whatever sign-in is stored
   * when it lands: one that ended meanwhile, or another account's, leaves it for a sign-in to that account again.
   * True where that account is the one this page shows after the read that follows (the one its list key is for), so
   * the PC may be opened anew with that key.
   */
  const takePlace = async (place: { readonly id: string; readonly seq: number; readonly hash: string }): Promise<boolean> => {
    const owner = cardAccounts.get(place.id);
    if (lists === null || owner === undefined) return false;
    await lists.adopt({ list: place.id, seq: place.seq, hash: place.hash }, owner).catch((error: unknown) => {
      if (error instanceof SignedOutError) throw error;
      console.warn("Ovis: the place in the account's list was not taken", error instanceof Error ? error.name : error);
    });
    await refresh(false, true);
    // the sign-in this read put in view, which `listKey` answers for: never one read before it
    return accountView?.kind === "signed-in" && shownFor?.account === owner;
  };
  /**
   * `consent` null: the person confirmed a pairing with a key of this device's own, so no sign-in is read for it.
   * A sign-in: the confirm named its account, and a pairing under any other sign-in, or none, is refused.
   */
  const prepare = async (offer: RelayOffer, signal: AbortSignal, consent?: PairingConsent) => {
    const session = accountService !== null && consent !== null ? await account.session() : undefined;
    if (consent != null && (session === undefined || !sameSignIn(consent, session))) throw new ConsentChangedError();
    const key = session !== undefined ? await accountStore.key() : undefined;
    signal.throwIfAborted();
    let intent: "pc" | "account" = "pc";
    vouched.delete(offer.server_id);
    // a code that carries the mark: its PC takes the device only once the account service holds its admission, so the
    // admission is posted, and answered, before the pairing; a failure stops here, where nothing has reached the PC and
    // the code keeps its uses. Nothing signs the mark, so it only chooses the screen: the person's own press of Add and
    // pair, on the confirm that named this PC and this account (`consent`), is what lists the PC in the account when it
    // does not list it yet, and nothing is listed without that press. The account service and the PC decide the rest.
    // Only a new PC's code carries the mark, so its admission asks to be taken quietly; the account service decides
    // whether it is
    if (offer.code !== undefined && offer.admission === 1) {
      if (session === undefined || key === undefined) throw new AdmissionRefusedError("sign-in");
      // whatever this device saved for the PC: a marked code's PAIR always makes a new row there, whose link the PC
      // checks with the account service. The post ends at its bound or at the person's Cancel, the request itself and
      // not only the wait for it (the wait for the account's lock included): a slow service rings nobody after the
      // person was told
      const directory = account.forSignIn(session);
      const bounded = (): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_WAIT_MS)]);
      if (consent !== undefined) {
        try {
          if (!(await directory.listPcs(bounded())).some((pc) => pc.server_id === offer.server_id)) {
            const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
            await directory.putPc(offer.server_id, { label: (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48), public_key: publicKey, relay: offer.relay }, bounded(), undefined, { prove: true });
          }
        } catch (error) {
          if (error instanceof SignedOutError) throw new ConsentChangedError();
          signal.throwIfAborted();
          console.warn("Ovis: this PC could not be listed in the account before pairing", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
          // refused for the sign-in itself (an old one with no key to prove, docs/account.md "In one press"): the failure
          // screen signs in again right there, and the same pairing goes on after it
          if (error instanceof AccountServiceError && error.code === "session_not_fresh") throw new AdmissionRefusedError("sign-in");
          throw new AdmissionRefusedError(error instanceof AccountServiceError && error.status === 429 ? "busy" : error instanceof AccountServiceError && error.status < 500 ? "refused" : "unanswered");
        }
      }
      try {
        await directory.postAdmission(offer.server_id, label.slice(0, 48), key.public_spki, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0), bounded(), { quiet: true });
      } catch (error) {
        // the sign-in the person said yes under is no longer the stored one: nothing more goes out, and the question is
        // asked again (shell.tsx)
        if (error instanceof SignedOutError) throw new ConsentChangedError();
        signal.throwIfAborted();
        console.warn("Ovis: the account service did not take the admission", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
        if (!(error instanceof AccountServiceError)) throw new AdmissionRefusedError("unanswered");
        throw new AdmissionRefusedError(error.code === "session_not_fresh" ? "sign-in" : error.code === "unknown_pc" ? "unlisted" : error.status === 429 ? "busy" : error.status >= 500 ? "unanswered" : "refused");
      }
      // another tab signed out or in to another account while the post was out: no PAIR goes under the old one
      const now = await account.session();
      signal.throwIfAborted();
      if (now === undefined || !sameSignIn(now, session)) throw new ConsentChangedError();
      vouched.set(offer.server_id, key.public_spki);
    } else if (key && session !== undefined && offer.code === undefined && (await store.get(offer.server_id))?.device_id == null) {
      // any other offer pairs as it does without the mark: a code's posts nothing, a join without one posts as before
      // (an ordinary admission, never a quiet one) and is paired with the PC alone when the post fails
      signal.throwIfAborted();
      // announced by the sign-in read above: one stored meanwhile is refused, and this PC is paired alone
      try { await account.forSignIn(session).postAdmission(offer.server_id, label.slice(0, 48), key.public_spki, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0)); intent = "account"; }
      catch (error) { console.warn("Ovis: the account service did not take the join; pairing this PC only", error instanceof Error ? error.name : error); }
    }
    signal.throwIfAborted();
    // A device that waits to be let into its account's signed list, its claim of its key standing: the join brings its
    // card, for a PC that lets devices in by that list (docs/account.md, "A PC allows a device into the list"). Any
    // other PC never sees it.
    const listCard = intent === "account" && session !== undefined && key !== undefined ? await cardFor(session, key) : null;
    signal.throwIfAborted();
    const prepared: { accountKey?: AccountKey; intent?: "pc" | "account"; listCard?: { readonly list: string; readonly enc: string; readonly card: string } } =
      key ? { accountKey: key, intent, ...(listCard === null ? {} : { listCard }) } : {};
    return prepared;
  };
  /**
   * `introducible`: the pairing was just made without a code, so a member of the account may have approved it and
   * hands an introduction over a moment later. A QR or code pairing gets none, and is not kept waiting for one.
   */
  const enroll = (opened: RelayTransport, serverId: string, fresh: boolean, introducible = false, options: EnrollOptions = {}): Promise<"local" | EnrollmentCompletion> => {
    let told = false;
    const settled = (): void => { if (told) return; told = true; options.settled?.(); };
    const stop = new AbortController();
    const mine = stops.get(serverId) ?? new Set<AbortController>();
    mine.add(stop);
    stops.set(serverId, mine);
    const signal = options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
    const done = enrollOwned(opened, serverId, fresh, introducible, { ...options, settled, signal });
    void done.finally(() => { mine.delete(stop); if (mine.size === 0 && stops.get(serverId) === mine) stops.delete(serverId); }).catch(() => {});
    // a link the PC refused leaves the session to whoever says why (shell.tsx), rather than opening the app over it
    // a link refused for a PC the account's list removed is said on the pairing's own screen, in place of the app
    void done.then(settled, (error: unknown) => { if (refusalOf(error) === null && !listRemovedLink(error)) settled(); });
    running.set(done, serverId);
    void done.then(() => running.delete(done), () => running.delete(done));
    return done;
  };
  /**
   * Whether the account lets its devices and PCs in by a signed list, as far as this device knows: it follows one, or
   * the account service named one it is not in. Before the first read of a sign-in has ended, that read is waited for.
   */
  const keepsList = async (account: string): Promise<boolean | "unanswered"> => {
    if (lists === null) return false;
    let view = lists.view();
    if (view.account !== account) view = await lists.sync().catch(() => lists.view());
    // Not answered (no word of the account service this round, and no copy here that says): the writes of the way from
    // before wait for a round that tells. The pairing opens all the same.
    if (view.account !== account || (!view.reached && (view.status.at === "off" || view.status.at === "none"))) return "unanswered";
    return view.status.at !== "off" && view.status.at !== "none";
  };
  const enrollOwned = async (opened: RelayTransport, serverId: string, fresh: boolean, introducible: boolean, { consent, settled, signal }: EnrollOptions): Promise<"local" | EnrollmentCompletion> => {
    signal?.throwIfAborted();
    const epoch = forgotten.get(serverId);
    if (leaving || accountService === null || consent === null || !opened.server?.features?.includes(ACCOUNT_FEATURE)) return "local";
    const session = await account.session();
    if (session === undefined) return "local";
    // the pairing was confirmed for another sign-in's account: this one's gets nothing from it
    if (consent !== undefined && !sameSignIn(consent, session)) return "local";
    const saved = await store.get(serverId);
    if (saved === undefined || saved.device_id === null) return "local";
    let pairing = saved;
    const assertPairing = (current: RelayDevice | undefined): RelayDevice => {
      signal?.throwIfAborted();
      if (epoch !== forgotten.get(serverId) || current === undefined || current.device_id !== pairing.device_id || current.public_spki !== pairing.public_spki || current.server_public_key !== pairing.server_public_key) throw new DOMException("The pairing was forgotten or replaced", "AbortError");
      return current;
    };
    const owned = async (): Promise<void> => { assertPairing(await store.get(serverId)); };
    // the last checks before a request to the account service goes: its pairing, then the sign-in the enrollment began
    // with, whose token the request carries (a Forget meanwhile aborts `signal`, which the request checks last)
    const sending = async (): Promise<void> => {
      await owned();
      const now = await account.session();
      if (now === undefined || !sameSignIn(now, session)) throw new SignedOutError();
    };
    // the account service gave this enrollment no answer: a token refresh whose answer was lost may have spent the
    // stored refresh token, so nothing more of this enrollment reads from it (record)
    let unanswered = false;
    // Every enrollment writer, including linking and introductions, loses ownership on Forget.
    const enrollmentStore: RelayDeviceStore = {
      ...store,
      update: async (id, change) => {
        assertPairing(await store.get(serverId));
        return store.update(id, (current) => {
          // Introductions write another id, but still belong to the source enrollment's epoch.
          assertPairing(id === serverId ? current : pairing);
          if (id === serverId) { pairing = change(current); return pairing; }
          return change(current);
        }, id === serverId ? undefined : { serverId, assert: assertPairing });
      },
    };
    /**
     * Once the account service gave this enrollment no answer (`unanswered`), the rows are drawn again from what was read
     * before, and nothing goes to it: a token refresh whose answer was lost has spent the stored refresh token, and a read
     * now would send it again, which ends the sign-in.
     */
    const record = async (state: EnrollmentState): Promise<void> => {
      await enrollmentStore.update(serverId, (current) => ({ ...assertPairing(current), account_enrollment: { account: session.account, state } } satisfies SavedDevice));
      await (unanswered ? redraw() : refresh());
    };
    signal?.throwIfAborted();
    if (fresh) await record("pending");
    // a session that just paired has not proved its key to the PC, which then refuses a link and
    // keeps an introduction from it: the account's steps take a connection of their own, signed in
    let own: RelayTransport | null = null;
    let admitted: number | undefined;
    try {
      const key = await accountStore.key();
      const posted = vouched.get(serverId);
      vouched.delete(serverId);
      let device = await store.get(serverId);
      if (device === undefined || device.device_id === null) return "local";
      if (fresh) own = await open(offerOf(device), { store: enrollmentStore, label });
      const through = own ?? opened;
      const fetch = async (path: string, init?: RequestInit) => {
        assertPairing(await store.get(serverId));
        const response = await through.fetch(path, init);
        assertPairing(await store.get(serverId));
        return response;
      };
      const status = await pcAccountStatus(fetch);
      // An account with a signed list takes a PC in by an entry of that list, and its account service lists none for a
      // pairing that was only opened: a saved pairing lists no PC there and starts no enrollment (docs/account-list.md,
      // "PCs of a list account")
      const kept = fresh ? false : await keepsList(session.account);
      // not answered counts as a list for what is sent (nothing of the way from before goes out), and as no word at
      // all for what is kept: the row is left as it is
      const byList = kept !== false;
      signal?.throwIfAborted();
      /** The pairing stays this device's own, with nothing said of an account at its row. */
      const keptOwn = async (): Promise<"local"> => {
        await enrollmentStore.update(serverId, (current) => {
          const { account: _left, account_enrollment: _steps, ...own } = assertPairing(current) as SavedDevice;
          return own;
        });
        return "local";
      };
      // The account stopped listing this PC, and it waits for an add made at the PC itself. The pairing this device
      // kept still opens it, as a device of its own: no link goes out and nothing is listed. A new pairing sends its
      // link as ever, since only the PC knows whether a code it issued itself was used. A PC in no account is not
      // brought into a list account by a link either
      // (where the account service did not say whether the account keeps a list, the link only waits: nothing is taken
      // from the row, and the next open that gets an answer decides)
      if (!fresh && status.account === null && status.pcAddRequired !== true && kept === "unanswered") return "local";
      if (!fresh && status.account === null && (status.pcAddRequired === true || byList)) return await keptOwn();
      const linking = needsLink(status, device, session.account);
      // a PC this link brings into the account, or one still waiting for the member that linked it (who may be gone),
      // gets this client's enrollment: the account's removals first, read from its other PCs
      signal?.throwIfAborted();
      if (linking && !byList && (status.account === null || status.enrolling === true)) await planEnroll(accountStore, serverId, session.account);
      if (linking) {
        // the admission named another key than this link does: the key it names now is posted first, once. A post that
        // fails sends no link, which the PC would refuse and spend a use on
        if (posted !== undefined && posted !== key.public_spki) {
          signal?.throwIfAborted();
          try {
            await account.forSignIn(session).postAdmission(serverId, label.slice(0, 48), key.public_spki, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0), signal ? AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_WAIT_MS)]) : AbortSignal.timeout(ADMISSION_WAIT_MS), { quiet: true });
          } catch (error) {
            signal?.throwIfAborted();
            console.warn("Ovis: the account service did not take the admission of the new key", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
            throw new AdmissionRefusedError("new-key");
          }
        }
        signal?.throwIfAborted();
        // in one transaction with a leave's mark (leave.ts): a link recorded here is in that leave's snapshot, and
        // none goes out once a leave of this key has begun, in any tab, or for a sign-in that has ended
        const link = newRecordId();
        let recorded = false;
        await accountStore.updateMany(["session", "leaving", "linking"], (current) => {
          recorded = current.session !== undefined && sameSignIn(current.session, session) && !Object.values(current.leaving ?? {}).includes(key.public_spki);
          return recorded ? { ...current, linking: { ...current.linking, [link]: serverId } } : current;
        });
        if (!recorded) throw new DOMException("This device is leaving the account", "AbortError");
        // a PC that could not ask the account service in time keeps the row: the same link goes again after the wait it
        // named, on this session, and nothing is paired again
        const unlinked = device;
        // only a marked pairing, or a PC that named its wait, sends the link again: any other link is answered once, as before
        const marked = posted !== undefined;
        const sendLink = async (sent: number): Promise<RelayDevice> => {
          try { return await linkThisDevice({ fetch, device: unlinked, key, account: session.account, store: enrollmentStore }); } catch (error) {
            if (!(error instanceof AccountPcError && error.code === "account_unavailable" && (marked || error.retryAfterMs !== null)) || sent >= LINK_SENDS) throw error;
            // fixed wait: the time the PC named before it asks the account service again (retry-after), bounded
            await wait(Math.min(error.retryAfterMs ?? 3_000, LINK_RETRY_MAX_MS), signal);
            // the same sign-in, and no leave of this key begun meanwhile, or the link goes no more
            const current = await accountStore.get("session"), leaving = await accountStore.get("leaving");
            if (current === undefined || !sameSignIn(current, session) || Object.values(leaving ?? {}).includes(key.public_spki)) throw new DOMException("The sign-in changed while the link waited", "AbortError");
            return sendLink(sent + 1);
          }
        };
        let listAlone = false;
        try { device = await sendLink(1); } catch (error) {
          // the PC lets its account's devices in by the account's signed list alone, and wrote nothing: the pairing made
          // at it is whole as it is, and the way into the account there is a member's Allow
          if (error instanceof AccountPcError && error.code === "list_followed") listAlone = true;
          // a marked pairing's link the PC turned away, ending its new row: the code ended, the account did not confirm
          // the device, or, on a PC that was in no account, the link named another account than the one named for it.
          // Any other refusal, and every refusal of an unmarked pairing, goes as before: the device keeps what it paired
          else if (marked && error instanceof AccountPcError && firstLinkRefusal(error.code, status.account)) throw new AccountPcError(error.status, error.code, error.retryAfterMs, true);
          else throw error;
        } finally {
          await accountStore.update("linking", (current) => {
            const { [link]: _settled, ...rest } = current ?? {};
            return Object.keys(rest).length > 0 ? rest : undefined;
          });
        }
        if (listAlone) {
          settled?.();
          return await keptOwn();
        }
      }
      // the app's session proved the old key, or none: it signs in again with the account key, so this device can approve
      if (linking || fresh) {
        await opened.renew();
        assertPairing(await store.get(serverId));
        if (linking) window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      }
      settled?.();
      // a PC of another account is not this account's to list or introduce from
      if (device.public_spki !== key.public_spki || (!linking && status.account !== session.account)) throw new AccountPcError(409, "enrolling");
      // the account's removals this PC holds, checked and kept as signed, for a PC this client enrolls later (#2956)
      if (!linking) await keepRemovals({ store: accountStore, account: session.account, removals: status.removals });
      // the PC lists this row as a member: only now does it count as in the account here
      if (!linking && device.account !== session.account && device.device_id !== null && !status.unlinked.includes(device.device_id)) {
        device = await enrollmentStore.update(serverId, (current) => ({ ...assertPairing(current), account: session.account }));
      }
      const publicKey = Array.from(importPublicKey(device.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
      assertPairing(await store.get(serverId));
      // the directory of the sign-in this enrollment began with: one stored meanwhile (another tab) is another account's.
      // A send the connection dropped under goes again once it is back, while this enrollment still owns the pairing
      // Only the enrollment that brings a PC into the account lists it. Opening a PC that is in the account writes
      // nothing to the directory: the account may have removed it a moment ago, and this would put it back
      if (!byList && (await accountStore.get("enrolls"))?.[serverId] !== undefined) {
        const listing = { label: (device.name ?? serverId.slice(0, 8)).slice(0, 48), public_key: publicKey, relay: device.relay };
        const again = sendAgainWhenBack({ before: sending, signal });
        // listed first, so a removal this client signs from now on reaches it by mailbox too
        // a key proof only for a pairing just made from the Add and pair confirm (`consent`): opening a saved pairing signs nothing
        await account.forSignIn(session).putPc(serverId, listing, signal, again, { prove: fresh && consent != null });
        // the PC takes an enrollment only from a session that signed in with the account key, which the ones above did not
        let signedIn = opened;
        // the account's other PCs this device is in, read first for what they keep out (docs/account.md, "Enrolling a PC")
        const peers: RelayTransport[] = [];
        try {
          if (linking || fresh) signedIn = await open(offerOf(device), { store: enrollmentStore, label });
          const others = (await store.list()).filter((other) => other.server_id !== serverId && other.device_id !== null && other.account === session.account && other.public_spki === key.public_spki);
          const reached = await Promise.allSettled(others.map(async (other) => {
            const controller = new AbortController();
            // fixed wait: a PC that does not open within the deadline counts as not checked, as one that does not answer
            const timer = setTimeout(() => controller.abort(), PEER_STATUS_MS);
            const peer = await open(offerOf(other), { store, label, signal: controller.signal }).finally(() => clearTimeout(timer));
            peers.push(peer);
            return { serverId: other.server_id, assertOwned: owned, fetch: async (path: string, init?: RequestInit) => {
              assertPairing(await store.get(serverId));
              const response = await peer.fetch(path, init);
              assertPairing(await store.get(serverId));
              return response;
            } };
          }));
          const pc = { server_id: serverId, server_public_key: device.server_public_key, relay: device.relay, name: (device.name ?? serverId.slice(0, 8)).slice(0, 48) };
          // PCs the directory lists that this device cannot read: their removals are unknown here
          // the directory unread counts as one more PC this device cannot read
          // a read this enrollment stopped (a Forget, a cancel) ends it, rather than count as a PC not read
          const listed = await account.forSignIn(session).listPcs(signal, again).then((pcs) => pcs.filter((entry) => entry.server_id !== serverId).length, (error: unknown) => {
            if (signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")) throw error;
            if (error instanceof AccountServiceUnreachableError) unanswered = true;
            return 1;
          });
          const enrollment = await enrollOnPc({
            fetch: async (path, init) => {
              assertPairing(await store.get(serverId));
              const response = await signedIn.fetch(path, init);
              assertPairing(await store.get(serverId));
              return response;
            }, store: accountStore, account: session.account, serverId, pc, listed, assertOwned: owned,
            others: reached.map((result) => result.status === "fulfilled" ? result.value : { serverId: "", fetch: () => Promise.reject(result.reason) }),
          });
          if (enrollment?.finished !== true) throw new AccountPcError(409, "enrolling");
          admitted = new Set(enrollment.admitted).size;
        } finally {
          if (signedIn !== opened) signedIn.close();
          for (const peer of peers) peer.close();
        }
      }
      const deadline = Date.now() + (introducible ? INTRODUCTION_WAIT_MS : 0);
      // A device that waits to be let into its account's list, just let in here by a member's approval: the member
      // leaves its place in the list with the introduction. It is read over this session, which signed in with the
      // account key, and taken while this enrollment still owns the pairing (a Forget ends the wait).
      // Handing the place to the list ends the search for it, and says nothing yet of the device being in: the list
      // reads the log itself, and a device that follows a list already takes no place (accountList.ts adopt).
      let took = false;
      // A device that still waits to be let into its account's list asks at every open of a PC it is paired with, not
      // only right after it was let in there: a member's Allow may go through later than this device first asked, and
      // the PC carries the place until it is read.
      const waits = lists !== null && lists.view().account === session.account && lists.view().status.at === "not_in";
      const onList = lists === null || !(introducible || waits) ? undefined : async (offer: ListOffer): Promise<void> => {
        if (took) return;
        assertPairing(await store.get(serverId));
        took = true;
        await lists.adopt(offer).catch((error: unknown) => { took = false; console.warn("Ovis: the place in the account's list was not taken", error instanceof Error ? error.name : error); });
      };
      for (;;) {
        const saved = await takeIntroduction({ fetch, key, label, store: enrollmentStore, relay: device.relay, ...(onList === undefined ? {} : { onList }) });
        if (saved.length > 0 || took || Date.now() >= deadline) break;
        await wait(INTRODUCTION_POLL_MS, signal);
      }
      await record("complete");
      // "In your account" is said only where this device's own copy of the list shows it in: one that still waits to
      // be let into its account's list is paired with this PC, and says nothing of the account yet
      const mine = lists?.view();
      if (mine !== undefined && mine.account === session.account && mine.status.at === "not_in") return "local";
      return { state: "complete", ...(admitted === undefined ? {} : { admitted }) };
    } catch (error) {
      assertPairing(await store.get(serverId));
      if (error instanceof AccountServiceUnreachableError) unanswered = true;
      await record("failed");
      throw error;
    } finally {
      own?.close();
    }
  };

  /**
   * The sign-in stored now, read for nothing but to tell whether it is the one a confirm before a reload named
   * (shell.tsx): none without an account service, or when the store cannot be read.
   */
  const stored = async (): Promise<AccountSession | undefined> => accountService === null ? undefined : await account.session().catch(() => undefined);
  /** The account of the sign-in stored now, read only: unlike `stored`, it names no sign-in and writes nothing. */
  const storedAccount = async (): Promise<string | undefined> => accountService === null ? undefined : (await accountStore.get("session").catch(() => undefined))?.account;
  /** The providers the account service offers now (`GET /v1/providers`), read once; the build's list when it does not answer. */
  let answer: Promise<{ readonly providers: readonly AccountProvider[]; readonly listed: readonly AccountProvider[] }> | undefined;
  const answered = () => answer ??= accountService === null ? Promise.resolve({ providers, listed: providers })
    : offeredProviders(accountService, providers, mount.accountFetch ? { fetch: mount.accountFetch } : {}).then((said) => ({ providers: said.providers, listed: said.listed ?? providers }), () => ({ providers, listed: providers }));
  const offeredNow = (): Promise<readonly AccountProvider[]> => answered().then((said) => said.providers);
  /** The providers the service named, an empty list included; the build's only when it gave no answer to read. */
  const listedNow = (): Promise<readonly AccountProvider[]> => answered().then((said) => said.listed);
  /**
   * The key the account's signed list holds for this device, the account key, while the device follows the list of the
   * account in view and is in it; null otherwise. Read with each directory read, which reads the key anyway.
   */
  let memberKey: AccountKey | null = null;
  const listKey = (): AccountKey | null => {
    const view = lists?.view();
    // only for the sign-in in view, as the key of the sign-in is given (openKey): from the moment a sign-out begins
    // there is none, whatever the list's own view still shows until the account service has answered
    if (accountView?.kind !== "signed-in" || listedFor?.epoch !== generation) return null;
    return view !== undefined && view.status.at === "following" && view.status.standing === "in" && shownFor !== undefined && view.account === shownFor.account
      && memberKey !== null && view.devices.some((device) => device.self && device.key === memberKey!.public_spki) ? memberKey : null;
  };
  /** Whether the account's signed list, as this device holds it, holds the PC with this id. */
  const listHolds = (serverId: string): boolean => listKey() !== null && (lists?.view().pcs.some((pc) => pc.server_id === serverId) ?? false);
  /**
   * What this device's own copy of the list says of a session it opened with the list key at this PC: `holds`, the
   * list holds the PC and this device; `pc-out`, it holds the PC no more; `device-out`, it holds this device no more.
   * `unknown` where the copy is not one to go by now (not this account's, not read, stopped, shown two histories).
   */
  const listSays = (serverId: string): "holds" | "pc-out" | "device-out" | "unknown" => {
    const read = lists?.view();
    if (read === undefined || shownFor === undefined || read.account !== shownFor.account || read.status.at !== "following" || read.status.trouble !== null) return "unknown";
    if (read.status.standing === "out") return "device-out";
    if (read.status.standing !== "in") return "unknown";
    if (memberKey === null || !read.devices.some((device) => device.self && device.key === memberKey!.public_spki)) return "device-out";
    return read.pcs.some((pc) => pc.server_id === serverId) ? "holds" : "pc-out";
  };
  /**
   * Whether the account's list holds this device only until a time that is past, by the time this device shows by:
   * its own clock held against the latest time it saved and the list's own (AccountList.shown). So a clock set back
   * after that time ran out leads to no join by itself, and to no word that the device was removed.
   */
  const listTimeOver = (): boolean => {
    const view = lists?.view();
    const now = lists?.shown() ?? Math.floor(Date.now() / 1000);
    return view !== undefined && view.status.at === "following" && view.devices.some((device) => device.self && device.until !== null && device.until <= now);
  };
  /**
   * Reads the list now, as when a PC said that it lets devices in by it (shell.tsx). A page that has not read its
   * sign-in yet (a PC's own page opens a saved pairing before it reads the account) reads that first: without it the
   * device has no list key to come with, though its list may hold it and the PC.
   */
  const readList = async (): Promise<void> => {
    if (accountService !== null && (shownFor === undefined || memberKey === null)) {
      await refresh(false, true).catch((error: unknown) => { console.warn("Ovis: the sign-in could not be read before the account's list", error instanceof Error ? error.name : error); });
    }
    await lists?.sync().catch((error: unknown) => { if (!(error instanceof SignedOutError)) console.warn("Ovis: the account's list could not be read", error instanceof Error ? error.name : error); });
  };
  /**
   * Whether this device has a list to answer a PC with: it follows a list of the signed-in account, waits to be let
   * into one, or holds a copy it has not read or cannot read. A device with no sign-in here, or of an account that
   * keeps no list, has none: to it a PC that lets devices in by a list says no more than a pairing that is gone.
   */
  const knowsList = (): boolean => {
    const view = lists?.view();
    return copyUnread !== null || (view !== undefined && view.account !== null && view.status.at !== "off");
  };
  return { dispose, get state() { return accountView; }, get directory() { return directory; }, get listKey() { return listKey(); }, listHolds, listSays, listTimeOver, readList, takePlace, get knowsList() { return knowsList(); },
    get openKey() { return accountView?.kind === "signed-in" && listedFor?.epoch === generation ? listedFor.openKey : null; },
    get signedInAs() { return accountView?.kind === "signed-in" ? shownFor : undefined; }, enabled: accountService !== null, providers, offered: offeredNow, listed: listedNow, load, refresh, refreshNow, reread, stored, storedAccount, signIn, signOut, leave, deleteAccount, signOutEverywhere, freshSignIn, prepare, enroll, cancelEnrollment, armRefresh };
}
