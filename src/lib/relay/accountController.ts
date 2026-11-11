/** Account sign-in, directory refresh and authenticated PC enrollment for the hosted shell. */
import { ACCOUNT_FEATURE } from "../../../shared/relay-mux.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { newRecordId } from "../../../shared/account-records.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { myPcs } from "../account/myPcs.ts";
import { AccountService, AccountServiceError, accountProvidersOf, sameSignIn, shellAccountServiceOf, SignedOutError } from "../account/service.ts";
import type { DirectoryPc } from "../account/service.ts";
import { indexedAccountStore } from "../account/store.ts";
import { beginSignIn, finishSignIn, SignInError } from "../account/signin.ts";
import type { SignInReturn } from "../account/signin.ts";
import type { AccountProvider, AccountSession } from "../account/store.ts";
import { AccountPcError, enrollOnPc, keepRemovals, PEER_STATUS_MS, linkThisDevice, needsLink, pcAccountStatus, planEnroll, sendQueuedAdds, takeIntroduction } from "../account/join.ts";
import { deleteAccount as deleteAccountOf, holdingSessionStore, installSignInAgain } from "../account/deleteAccount.ts";
import { leaveAccount } from "../account/leave.ts";
import { nativeSignIn, nativeSignInAvailable } from "../account/native.ts";
import { deviceLabel, deviceOs } from "../phone.ts";
import { t } from "../i18n.ts";
import { DEVICES_CHANGED_EVENT } from "../useRelay.ts";
import { indexedDeviceStore, type SavedDevice, type EnrollmentState, type RelayDevice, type RelayDeviceStore } from "./device.ts";
import { offerOf } from "./shellState.ts";
import type { AccountView, EnrollmentCompletion } from "./shellState.ts";
import type { RelayShellMount } from "./shell.tsx";
import { openRelayTransport, type RelayTransport } from "./transport.ts";

const INTRODUCTION_WAIT_MS = 60_000;
const INTRODUCTION_POLL_MS = 3_000;
const DIRECTORY_REFRESH_MS = 60_000;
/**
 * `consent`: whose account the pairing was confirmed for. `settled`: told once, when nothing more of this enrollment
 * ends or renews the session it was given (its link and renewal are done, or it stopped before them).
 */
interface EnrollOptions { readonly consent?: PairingConsent; readonly settled?: () => void }
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/** A sign-in again, made to delete an account, landed in another account: nothing is deleted. */
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


export function createAccountController(mount: RelayShellMount, view: { readonly active: () => boolean; readonly changed: () => Promise<void>; readonly outdated: () => ReadonlySet<string> }) {
  const store = mount.store ?? indexedDeviceStore;
  const accountStore = mount.accountStore ?? indexedAccountStore;
  const accountService = mount.accountService === undefined ? shellAccountServiceOf(document, window.location.origin, nativeSignInAvailable()) : mount.accountService;
  const providers = mount.accountProviders ?? accountProvidersOf(document);
  const account = new AccountService({ store: accountStore, ...(mount.accountFetch ? { fetch: mount.accountFetch } : {}) });
  const label = mount.label ?? deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const open = mount.open ?? openRelayTransport;
  const forgotten = new Map<string, number>();
  // enrollments still running, with their PC: leaving the account cancels each, and waits for none
  const running = new Map<Promise<unknown>, string>();
  const cancelEnrollment = (id: string): void => { forgotten.set(id, (forgotten.get(id) ?? 0) + 1); };
  let accountView: AccountView | null = accountService === null ? null : { kind: "signed-out", error: null };
  let directory: readonly DirectoryPc[] = [];
  // whom `directory` was last read for, so a failed read can age its rows again without reading it
  let listedFor: { readonly epoch: number; readonly accountKey: string; readonly account: string } | undefined;
  // the sign-in the signed-in view was last read as
  let shownFor: AccountSession | undefined;
  let generation = 0;
  let leaving = false;
  /**
   * The delete pressed for (deleteAccount), until it ends: a sign-out, a sign-in or a leave ends it, and every step of
   * it after a wait (the sign-in again, the second delete, what is drawn) goes on only while it is still this one.
   */
  let deletion: object | undefined;
  // the read out now and the sign-in it is for: a read of an earlier sign-in never holds back the next one's
  let reading: { readonly epoch: number; readonly read: Promise<void> } | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const changed = async (): Promise<void> => { await view.changed(); armRefresh(); };
  const refresh = async (initial = false, forced = false): Promise<void> => {
    // a delete in flight draws what it ends in itself: no background read replaces its notice, only its own reads go on
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
        // the list of the sign-in read above: one stored meanwhile is not shown under this one's heading
        const listed = await account.forSignIn(session).listPcs();
        const devices = await store.list();
        const key = await accountStore.key();
        if (!live()) return;
        // the answer was on its way while another tab stored another sign-in, or none: it is not drawn
        const still = await account.session();
        if (!live()) return;
        if (still === undefined) throw new SignedOutError();
        if (!sameSignIn(still, session)) { replacedBy(still); return; }
        directory = listed;
        listedFor = { epoch, accountKey: key.public_spki, account: session.account };
        accountView = { kind: "signed-in", provider: session.provider, error: null, pcs: myPcs(listed, devices, { now: Date.now(), accountKey: key.public_spki, account: session.account, outdated: view.outdated() }) };
        sendQueuedAdds({ service: account, store: accountStore, account: session.account }).catch((error: unknown) => console.warn("Ovis: kept adds could not be sent", error instanceof Error ? error.name : error));
      } catch (error) {
        if (!live()) return;
        // the sign-in this read began with is gone; another one stored meanwhile (another tab) is read in its place
        const next = error instanceof SignedOutError ? await account.session().catch(() => undefined) : undefined;
        if (next !== undefined) { if (live()) replacedBy(next); return; }
        if (!live()) return;
        if (error instanceof SignedOutError) { directory = []; accountView = { kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") }; }
        else {
          console.warn("Ovis: the account's PCs could not be read", error instanceof Error ? error.name : error);
          const devices = await store.list();
          if (!live()) return;
          // the rows kept from the last read, with their time-based states aged to now (a PC unseen for long goes Offline)
          const kept = current?.kind === "signed-in" && current.pcs !== null && listedFor?.epoch === epoch
            ? myPcs(directory, devices, { now: Date.now(), outdated: view.outdated(), accountKey: listedFor.accountKey, account: listedFor.account })
            // nothing kept (a first read, or rows dropped with the sign-in they were of): the PCs this device is paired with
            : current?.kind === "signed-in" && current.pcs !== null ? current.pcs : myPcs([], devices, { now: Date.now(), outdated: view.outdated() });
          if (accountView?.kind === "signed-in") accountView = { ...accountView, pcs: kept, error: t("The account service could not be reached. The PCs this device is paired with still work.") };
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
  /**
   * The sign-in and its directory, read again now whatever screen is up: for a consent about to be acted on, which
   * no timer keeps fresh (the confirm is not the front page). A sign-in still finishing is left to its own read.
   */
  const reread = async (): Promise<void> => {
    while (reading !== undefined) await reading.read.catch(() => undefined);
    if (accountView?.kind !== "signing-in") await refresh(accountView?.kind !== "signed-in", true);
  };
  // the read a person asked for (Check again, Try again) that waits for the one out to land: later asks join it
  let asked: Promise<void> | undefined;
  /** Reads the directory because the person asked: a read already out may have been answered before what they just did
   *  (a PC added a moment ago), so the list is read once more after it. Settles when a read begun after the ask has landed. */
  const refreshNow = (): Promise<void> => {
    if (asked !== undefined) return asked;
    const out = reading;
    if (out?.epoch !== generation) return refresh();
    const queued = (async () => {
      await out.read.catch(() => {});
      asked = undefined;
      // a read that began meanwhile (the next sign-in's, after the one waited for) began after the ask too
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
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refresh(); armRefresh(); });
  const invalidate = (): void => { deletion = undefined; generation++; directory = []; accountView = { kind: "signed-out", error: null }; armRefresh(); };
  const signOut = (): void => {
    // the sign-in the person ended, read before anything waits: one made meanwhile stays (service.ts, forSignIn)
    const ending = account.session();
    invalidate();
    void changed();
    void ending.then((session) => session === undefined ? undefined : account.forSignIn(session).signOut()).catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error));
  };
  const leave = (): void => {
    if (leaving) return;
    deletion = undefined;
    leaving = true;
    const epoch = ++generation;
    // the sign-in the person leaves, read before anything waits: one made meanwhile is never touched (leave.ts)
    const from = account.session();
    // an enrollment of this tab stops here; one still linking, here or in another tab, is in the leave's snapshot (leave.ts)
    for (const serverId of running.values()) cancelEnrollment(serverId);
    void from.then((session) => {
      if (session === undefined) throw new SignedOutError();
      return leaveAccount({ service: account, accountStore, relayStore: store, session });
    }).then(async ({ unconfirmed }) => {
      // signed out, or in again, meanwhile: that view is not this leave's to change
      if (epoch !== generation) return;
      // a PC the account does not list kept this device: say so, rather than claim it is gone everywhere
      const names = new Map((await store.list()).map((device) => [device.server_id, device.name ?? device.server_id.slice(0, 8)]));
      accountView = { kind: "signed-out", error: unconfirmed.length === 0 ? null
        : t("This device left the account. These PCs the account does not list still have it, so revoke it on them: {pcs}", { pcs: unconfirmed.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ") }) };
      await changed();
    }, async (error: unknown) => {
      console.warn("Ovis: this device did not leave the account", error instanceof Error ? error.name : error);
      if (epoch !== generation) return;
      if (accountView?.kind === "signed-in") accountView = { ...accountView, error: t("This device could not leave the account. Try again.") };
      await changed();
    }).finally(() => { leaving = false; });
  };

  /** What the service said to a delete it refused, in the person's words. */
  const deleteFailure = (error: unknown): string => {
    if (error instanceof AccountServiceError && error.code === "reauth_required") return t("To delete your account, sign out, sign in again, then delete it within ten minutes.");
    if (error instanceof AccountServiceError && error.code === "subscription_active") return t("Cancel your subscription first, then delete the account.");
    if (error instanceof AnotherAccountError) return t("You signed in to another account. Nothing was deleted.");
    return t("The account could not be deleted. Try again.");
  };
  /**
   * Deletes the signed-in account at the account service (account/deleteAccount.ts), then shows the signed-out
   * front page. The service wants a sign-in from the last ten minutes: the phone app signs in again in place, with
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
    // a refusal of an earlier press is not this one's
    if (accountView?.kind === "signed-in" && accountView.deleteError !== undefined) { const { deleteError: _earlier, ...rest } = accountView; accountView = rest; }
    return Promise.resolve(from).then(async (session) => {
      if (session === undefined) throw new SignedOutError();
      try { await deleteAccountOf({ service: account, accountStore, session }); }
      catch (error) {
        if (!(error instanceof AccountServiceError && error.code === "reauth_required") || accountService === null || !nativeSignInAvailable() || !current()) throw error;
        // a sign-in another tab stored since is not signed over: the view reads it instead
        const stored = await account.session();
        if (stored === undefined || !sameSignIn(stored, session)) throw new SignedOutError();
        // the sheet's sign-in is not stored by the sheet: only below, once this delete is still on and its sign-in still
        // the one stored, so a sign-out or another sign-in while the sheet was open is neither undone nor deleted
        const again = await nativeSignIn(session.provider, { store: holdingSessionStore(accountStore), service: accountService });
        if (!current()) throw error;
        if (again.account !== session.account) throw new AnotherAccountError();
        if (!await installSignInAgain(accountStore, session, again, current)) throw new SignedOutError();
        // a sign-out that landed as the store answered: it ends the sign-in just stored, and no delete follows
        if (!current()) throw error;
        await deleteAccountOf({ service: account, accountStore, session: again });
      }
    }).then(async () => {
      // signed out or in meanwhile: that view is not this delete's to change
      if (!current()) return;
      // a sign-in that took the deleted one's place while the delete was out stays (deleteAccount.ts): it is shown
      if (await account.session().catch(() => undefined) !== undefined) { await refresh(true); return; }
      if (!current()) return;
      // the account is gone: a PC being brought into it is not
      for (const serverId of running.values()) cancelEnrollment(serverId);
      directory = [];
      accountView = { kind: "signed-out", error: null, notice: t("Your account was deleted.") };
      armRefresh();
      await changed();
    }, async (error: unknown) => {
      // called off by a sign-out or a sign-in: what that drew stays
      if (!current()) return;
      console.warn("Ovis: the account was not deleted", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      // the sign-in ended meanwhile, or a sign-in again landed in another account: read what is stored now
      if (error instanceof SignedOutError || error instanceof AnotherAccountError) await refresh(true);
      // a sign-out or a sign-in while that read was out: what it drew stays
      if (!current()) return;
      // a sign-in that ended or was replaced deleted nothing, and the page now shown is not the one asked about: no
      // failure is drawn on it to try again
      // said on Devices alone, where Delete account was pressed: the directory's own failure keeps `error`
      if (accountView?.kind === "signed-in" && !(error instanceof SignedOutError)) accountView = { ...accountView, deleteError: deleteFailure(error) };
      await changed();
    }).finally(() => { if (deletion === mine) deletion = undefined; });
  };


  const signIn = (provider: AccountProvider): void => {
    if (accountService === null) return;
    if (accountView?.kind === "signing-in") return;
    deletion = undefined;
    generation++;
    accountView = { kind: "signing-in", provider };
    void changed();
    // in the phone app the system's sign-in sheet brings the return back to the page; elsewhere the page goes to the provider
    const started = nativeSignInAvailable()
      ? nativeSignIn(provider, { store: accountStore, service: accountService }).then(() => refresh(true))
      : beginSignIn(provider, { store: accountStore, service: accountService, redirectUri: `${window.location.origin}/` }).then(mount.openSignIn ?? ((url) => window.location.assign(url)));
    started.catch(async (error: unknown) => {
      console.warn("Ovis: the sign-in did not start", error);
      accountView = { kind: "signed-out", error: signInFailure(error), provider };
      await changed();
    });
  };
  const load = async (returned: SignInReturn | null): Promise<void> => {
    if (returned !== null && accountService !== null) {
      const pending = (await accountStore.get("pending"))?.[returned.state];
      accountView = { kind: "signing-in", ...(pending ? { provider: pending.provider } : {}) };
      await changed();
      try { await finishSignIn(returned, { store: accountStore, ...(mount.accountFetch ? { fetch: mount.accountFetch } : {}) }); }
      catch (error) { accountView = { kind: "signed-out", error: signInFailure(error), ...(pending ? { provider: pending.provider } : {}) }; await changed(); }
    }
    await refresh(true);
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
    if (key && offer.code === undefined && (await store.get(offer.server_id))?.device_id == null) {
      signal.throwIfAborted();
      // announced by the sign-in read above: one stored meanwhile is refused, and this PC is paired alone
      try { await account.forSignIn(session!).postAdmission(offer.server_id, label.slice(0, 48), key.public_spki, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0)); intent = "account"; }
      catch (error) { console.warn("Ovis: the account service did not take the join; pairing this PC only", error instanceof Error ? error.name : error); }
    }
    signal.throwIfAborted();
    return key ? { accountKey: key, intent } : {};
  };
  /**
   * `introducible`: the pairing was just made without a code, so a member of the account may have approved it and
   * hands an introduction over a moment later. A QR or code pairing gets none, and is not kept waiting for one.
   */
  const enroll = (opened: RelayTransport, serverId: string, fresh: boolean, introducible = false, options: EnrollOptions = {}): Promise<"local" | EnrollmentCompletion> => {
    // told once: after the session's last renewal, or when the enrollment ends without reaching it
    let told = false;
    const settled = (): void => { if (told) return; told = true; options.settled?.(); };
    const done = enrollOwned(opened, serverId, fresh, introducible, { ...options, settled });
    void done.then(settled, settled);
    running.set(done, serverId);
    void done.then(() => running.delete(done), () => running.delete(done));
    return done;
  };
  const enrollOwned = async (opened: RelayTransport, serverId: string, fresh: boolean, introducible: boolean, { consent, settled }: EnrollOptions): Promise<"local" | EnrollmentCompletion> => {
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
      if (epoch !== forgotten.get(serverId) || current === undefined || current.device_id !== pairing.device_id || current.public_spki !== pairing.public_spki || current.server_public_key !== pairing.server_public_key) throw new DOMException("The pairing was forgotten or replaced", "AbortError");
      return current;
    };
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
    const record = async (state: EnrollmentState): Promise<void> => {
      await enrollmentStore.update(serverId, (current) => ({ ...assertPairing(current), account_enrollment: { account: session.account, state } } satisfies SavedDevice));
      await refresh();
    };
    if (fresh) await record("pending");
    // a session that just paired has not proved its key to the PC, which then refuses a link and
    // keeps an introduction from it: the account's steps take a connection of their own, signed in
    let own: RelayTransport | null = null;
    let admitted: number | undefined;
    try {
      const key = await accountStore.key();
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
      const linking = needsLink(status, device, session.account);
      // a PC this link brings into the account, or one still waiting for the member that linked it (who may be gone),
      // gets this client's enrollment: the account's removals first, read from its other PCs
      if (linking && (status.account === null || status.enrolling === true)) await planEnroll(accountStore, serverId, session.account);
      if (linking) {
        // in one transaction with a leave's mark (leave.ts): a link recorded here is in that leave's snapshot, and
        // none goes out once a leave of this key has begun, in any tab, or for a sign-in that has ended
        const link = newRecordId();
        let recorded = false;
        await accountStore.updateMany(["session", "leaving", "linking"], (current) => {
          recorded = current.session !== undefined && sameSignIn(current.session, session) && !Object.values(current.leaving ?? {}).includes(key.public_spki);
          return recorded ? { ...current, linking: { ...current.linking, [link]: serverId } } : current;
        });
        if (!recorded) throw new DOMException("This device is leaving the account", "AbortError");
        try { device = await linkThisDevice({ fetch, device, key, account: session.account, store: enrollmentStore }); }
        finally {
          // settled: the pairing itself (pending_key) names a link whose answer was lost
          await accountStore.update("linking", (current) => {
            const { [link]: _settled, ...rest } = current ?? {};
            return Object.keys(rest).length > 0 ? rest : undefined;
          });
        }
      }
      // the app's session proved the old key, or none: it signs in again with the account key, so this device can approve
      if (linking || fresh) {
        await opened.renew();
        assertPairing(await store.get(serverId));
        // a Devices panel open since before the link reads the list again, over the session that proved the new key
        if (linking) window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      }
      // the link ended the PC's other sessions of this row, and the renewal reconnected this one: nothing below does either
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
      // the directory of the sign-in this enrollment began with: one stored meanwhile (another tab) is another account's
      await account.forSignIn(session).putPc(serverId, { label: (device.name ?? serverId.slice(0, 8)).slice(0, 48), public_key: publicKey, relay: device.relay });
      // listed first, so a removal this client signs from now on reaches it by mailbox too
      if ((await accountStore.get("enrolls"))?.[serverId] !== undefined) {
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
            return { serverId: other.server_id, assertOwned: async () => { assertPairing(await store.get(serverId)); }, fetch: async (path: string, init?: RequestInit) => {
              assertPairing(await store.get(serverId));
              const response = await peer.fetch(path, init);
              assertPairing(await store.get(serverId));
              return response;
            } };
          }));
          const pc = { server_id: serverId, server_public_key: device.server_public_key, relay: device.relay, name: (device.name ?? serverId.slice(0, 8)).slice(0, 48) };
          // PCs the directory lists that this device cannot read: their removals are unknown here
          // the directory unread counts as one more PC this device cannot read
          const listed = await account.forSignIn(session).listPcs().then((pcs) => pcs.filter((entry) => entry.server_id !== serverId).length, () => 1);
          const enrollment = await enrollOnPc({
            fetch: async (path, init) => {
              assertPairing(await store.get(serverId));
              const response = await signedIn.fetch(path, init);
              assertPairing(await store.get(serverId));
              return response;
            }, store: accountStore, account: session.account, serverId, pc, listed, assertOwned: async () => { assertPairing(await store.get(serverId)); },
            // a PC that could not be opened is one more that was not checked
            others: reached.map((result) => result.status === "fulfilled" ? result.value : { serverId: "", fetch: () => Promise.reject(result.reason) }),
          });
          if (enrollment?.finished !== true) throw new AccountPcError(409, "enrolling");
          admitted = new Set(enrollment.admitted).size;
        } finally {
          if (signedIn !== opened) signedIn.close();
          for (const peer of peers) peer.close();
        }
      }
      // the approver hands the introduction over once this device's row exists, which may be a moment after it
      const deadline = Date.now() + (introducible ? INTRODUCTION_WAIT_MS : 0);
      for (;;) {
        if ((await takeIntroduction({ fetch, key, label, store: enrollmentStore, relay: device.relay })).length > 0 || Date.now() >= deadline) break;
        await wait(INTRODUCTION_POLL_MS);
      }
      await record("complete");
      return { state: "complete", ...(admitted === undefined ? {} : { admitted }) };
    } catch (error) {
      assertPairing(await store.get(serverId));
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
  return { get state() { return accountView; }, get directory() { return directory; },
    /** the sign-in the signed-in view speaks of; none while signed out, or before a new sign-in's first read */
    get signedInAs() { return accountView?.kind === "signed-in" ? shownFor : undefined; }, enabled: accountService !== null, providers, load, refresh, refreshNow, reread, stored, signIn, signOut, leave, deleteAccount, prepare, enroll, cancelEnrollment, armRefresh };
}
