/**
 * Settings → Phone & devices → Account: sign in with GitHub, Google or Apple, see the account's PCs,
 * add or remove a sign-in method, sign out. The desktop app signs in through the system browser
 * (lib/account/desktop.ts); a browser on the PC's own secure address, which no sign-in can be sent
 * back to, signs in with a code (lib/account/deviceSignIn.ts): one button and the Ovis link page
 * where the service has it, else the provider's device flow. Only
 * the providers the service says it offers get a button. Elsewhere, and with the account off, none
 * of this.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import type { AccountLimits } from "../../shared/protocol.ts";
import { AddPcWaitOver, keepAddPcWaiting, listThisPc, onAddPcWaiting, pagePc, readAddPcWaiting, reopenAddWindow, thisPcMembership, type AddPcWaiting, type ListedPc } from "../lib/account/addThisPc.ts";
import { desktopAccount, desktopProviders, desktopSignIn } from "../lib/account/desktop.ts";
import { ApiError } from "../lib/api.ts";
import { startDeviceSignIn, startLinkPageSignIn, type DeviceSignInProvider } from "../lib/account/deviceSignIn.ts";
import { within } from "../lib/account/join.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import { AccountService, AccountServiceError, DEVICE_PROVIDERS, offeredProviders, pcAccountServiceOf, sameSignIn, SignedOutError, type AccountIdentity, type DeviceProvider, type OfferedProviders } from "../lib/account/service.ts";
import { SignInError } from "../lib/account/signin.ts";
import { indexedAccountStore, type AccountProvider, type AccountSession } from "../lib/account/store.ts";
import { currentLocale, useT, type Translate } from "../lib/i18n.ts";
import { inMacApp, inNativeApp } from "../lib/nativeApp.ts";
import { deviceLabel, deviceOs } from "../lib/phone.ts";
import { AccountPcList, AccountSignIn, PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import { QrCode } from "./QrCode.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

type View =
  | { kind: "loading" }
  | { kind: "signed-out"; error: string | null }
  | { kind: "signing-in" }
  | { kind: "device-code"; provider: DeviceSignInProvider; userCode: string | null; verificationUri: string; verificationUriComplete: string | null }
  | { kind: "signed-in"; provider: AccountProvider; account: string; pcs: MyPc[] | null; methods: AccountIdentity[] | null; limits: AccountLimits | null; error: string | null };

/** Formats a byte count for an account's relay data allowance (B, KB, MB, GB). */
export function formatRelayBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return `${Math.round(safe)} B`;
  if (safe < 1024 * 1024) return `${Math.max(1, Math.round(safe / 1024))} KB`;
  if (safe < 1024 * 1024 * 1024) {
    const mb = safe / (1024 * 1024);
    return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
  }
  const gb = safe / (1024 * 1024 * 1024);
  const rounded = gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb);
  return `${rounded} GB`;
}

/** The server-provided plan name, PC slots (used/max), and relay data (used/cap when present) as one line. */
export function formatAccountLimits(t: Translate, limits: AccountLimits, listedPcs: number): { label: string; summary: string } {
  const plan = limits.plan.length > 0 ? limits.plan[0]!.toUpperCase() + limits.plan.slice(1) : limits.plan;
  const usedPcs = limits.pcs_used ?? listedPcs;
  const pcsPart = t("{used}/{max} PCs", { used: usedPcs, max: limits.pcs_max });
  const dataPart = typeof limits.data_cap_bytes === "number" && limits.data_cap_bytes > 0 && typeof limits.data_used_bytes === "number"
    ? t("{used} / {cap} relay data", { used: formatRelayBytes(limits.data_used_bytes), cap: formatRelayBytes(limits.data_cap_bytes) })
    : null;
  return {
    label: t("Plan · {plan}", { plan }),
    summary: dataPart !== null ? `${pcsPart} · ${dataPart}` : pcsPart,
  };
}

/** The account's limits as `session` reads them; null when the service reports none, or once another sign-in (or none) is stored. */
export async function accountLimitsOf(service: AccountService, session: AccountSession): Promise<AccountLimits | null> {
  const limits = await service.forSignIn(session).limits().catch(() => null);
  // another tab may have signed out or in while the answer was on its way: then it is no longer this section's to show
  const current = await service.session();
  return current !== undefined && sameSignIn(current, session) ? limits : null;
}

/**
 * The account's PCs and sign-in methods as `session` reads them; null once another sign-in (or none) is stored,
 * before the reads or while their answers were on the way: those are not this section's to show under its heading.
 */
export async function accountListsOf(service: AccountService, session: AccountSession): Promise<{ pcs: Awaited<ReturnType<AccountService["listPcs"]>>; methods: Awaited<ReturnType<AccountService["identities"]>> | null } | null> {
  const shown = service.forSignIn(session);
  const replaced = async (): Promise<boolean> => {
    const current = await service.session();
    return current === undefined || !sameSignIn(current, session);
  };
  try {
    const [pcs, methods] = await Promise.all([
      shown.listPcs(),
      shown.identities().catch((error: unknown) => {
        // a service from before sign-in methods: the list is left out, the rest works
        if (error instanceof AccountServiceError) return null;
        throw error;
      }),
    ]);
    return await replaced() ? null : { pcs, methods };
  } catch (error) {
    // a sign-in that ended with none in its place stays an error the section words; one replaced is read anew
    if (error instanceof SignedOutError && await service.session().catch(() => undefined) !== undefined) return null;
    throw error;
  }
}

const isDeviceProvider = (provider: AccountProvider): provider is DeviceProvider => (DEVICE_PROVIDERS as readonly string[]).includes(provider);

/** The link page as a person reads it off the screen: account.ovis.sh/link. */
export const linkAddress = (uri: string): string => { const url = new URL(uri); return url.host + url.pathname; };

/** The directory entry this screen keeps is listed anew a minute before the account's devices stop showing it. */
const RELIST_MS = 9 * 60_000;
/** The pairing window is opened again this often while the screen waits: a restart of Ovis closes it for no longer. */
export const REOPEN_MS = 30_000;
/** How often the waiting screen asks whether a device added this PC. */
export const ADDED_POLL_MS = 3_000;
/** How long one press keeps this PC waiting: after it nothing is reopened until the person asks again. */
export const WAITING_MS = 30 * 60_000;
/** How long the waiting screen gives this PC to answer one request: one that never answers does not hold the next. */
export const ANSWER_MS = 10_000;

type AddThisPcState =
  | { kind: "hidden" }
  | { kind: "offer" }
  /** `mark`: the wait as its tab keeps it (null without a stored sign-in to bind it to: such a wait is not resumed); `resumed`: taken up after a reload */
  | { kind: "waiting"; name: string; until: number; mark: AddPcWaiting | null; resumed: boolean }
  | { kind: "expired" }
  /** `enrolling`: the device that added the PC has not let the account's other devices in yet */
  | { kind: "done"; account: string; enrolling: boolean }
  | { kind: "error"; message: string };

const pageHidden = (): boolean => typeof document !== "undefined" && document.hidden === true;

const warned = (what: string) => (error: unknown): void => console.warn(what, error instanceof Error ? error.name : error);

/** Whether a kept wait is one this page may take up: within the thirty minutes of its press, and for the PC this page shows. */
function resumable(kept: AddPcWaiting, now: number): boolean {
  const pc = pagePc();
  return kept.until > now && kept.until <= now + WAITING_MS && (pc === null || pc === kept.serverId);
}

/** The listing two copies of the screen that wait on one wait (`until`) share, while it is on its way: the PC is listed once for both. */
let relistOnItsWay: { readonly until: number; readonly listed: Promise<ListedPc> } | null = null;

/**
 * This PC, signed in and in no account yet: listed in the account with one tap, then it waits for a
 * device already in the account to add it, which the owner approves here (docs/account.md, "Adding a PC").
 * While it waits it keeps its pairing window open, for thirty minutes a press, and says when a device added it.
 * A reloaded tab takes the wait up again only on the same PC under the same account; nothing else is
 * listed or opened without a press. Two copies of this screen may be mounted at once (Settings over the
 * welcome): they share the wait their tab keeps, whichever of them began it, one that stops it stops the
 * other, and the PC is listed again once for both.
 */
export function AddThisPc({ relayAbove = true, service }: {
  /** Settings has the relay's switch above; the welcome does not */
  relayAbove?: boolean;
  /** the account service the PC is listed with; the stored sign-in's when left out */
  service?: () => AccountService;
}) {
  const t = useT();
  const [state, setState] = useState<AddThisPcState>({ kind: "hidden" });
  const accountService = useCallback((): AccountService => service?.() ?? new AccountService({ store: indexedAccountStore }), [service]);
  /** What the screen shows of a PC that has an account: "in your account" only when it is the one signed in to now, else nothing here is true of it. */
  const joinedAs = useCallback(async (account: string, enrolling: boolean): Promise<AddThisPcState> => {
    const session = await accountService().session();
    return session?.account === account ? { kind: "done", account, enrolling } : { kind: "hidden" };
  }, [accountService]);
  useEffect(() => {
    let live = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    let waited = false;
    const read = (): void => {
      again = null;
      within(ANSWER_MS, thisPcMembership()).then(async ({ account, enrolling }) => {
        if (!live) return;
        const stored = readAddPcWaiting();
        const kept = stored !== null && resumable(stored, Date.now()) ? stored : null;
        // a wait that is over, or another PC's, is forgotten; one still running stays kept as it is: another copy of this screen may be waiting on it
        if (kept === null) {
          keepAddPcWaiting(null);
          if (account === null) setState({ kind: "offer" });
          return;
        }
        const session = await accountService().session().catch(() => undefined);
        if (!live) return;
        if (account !== null) {
          keepAddPcWaiting(null);
          // a device added this PC while the tab that waited for it was reloading: said only under the sign-in that waited, still stored
          if (kept.account === account && session?.account === account) setState({ kind: "done", account, enrolling });
          return;
        }
        // read again: while the sign-in was read, another copy of this screen may have stopped the wait, or begun one in its place
        const now = readAddPcWaiting();
        const running = now !== null && resumable(now, Date.now()) ? now : null;
        if (running === null) { setState({ kind: "offer" }); return; }
        // only the account the press was made under goes on waiting: another sign-in, or none, starts from the offer
        if (session === undefined || session.account !== running.account) { keepAddPcWaiting(null); setState({ kind: "offer" }); return; }
        // the screen was waiting when its tab reloaded: it goes on, within the thirty minutes of its press
        setState({ kind: "waiting", name: running.name, until: running.until, mark: running, resumed: true });
      }).catch((error: unknown) => {
        console.warn("Ovis: this PC's account could not be read", error instanceof Error ? error.name : error);
        const stored = readAddPcWaiting();
        if (!live || stored === null) return;
        // an Ovis that restarts under a reloaded waiting screen answers again soon: the wait is asked about until it does
        if (resumable(stored, Date.now())) { waited = true; again = setTimeout(read, ADDED_POLL_MS); }
        // the thirty minutes ended while it did not answer: said, so the screen is not left empty
        else if (waited) { keepAddPcWaiting(null); setState({ kind: "expired" }); }
      });
    };
    read();
    return () => { live = false; if (again !== null) clearTimeout(again); };
  }, [accountService]);
  /** the wait this copy's own press keeps: it is told of it like every copy, and begins it itself */
  const pressed = useRef<number | null>(null);
  // a copy that shows the button takes up the wait another copy of this screen begins (Settings over the welcome):
  // closing that one then leaves this one waiting, and saying when the PC was added
  const idle = state.kind === "offer" || state.kind === "expired" || state.kind === "error";
  useEffect(() => {
    if (!idle) return;
    let live = true;
    const off = onAddPcWaiting((kept) => {
      if (kept === null || kept.until === pressed.current || !resumable(kept, Date.now())) return;
      accountService().session().then((session) => {
        const now = readAddPcWaiting();
        // only under the sign-in the wait was begun in, and only while it is still the wait the tab keeps
        if (!live || session?.account !== kept.account || now === null || now.until !== kept.until) return;
        // the copy that began it opened the window itself
        setState((current) => current.kind === "offer" || current.kind === "expired" || current.kind === "error" ? { kind: "waiting", name: now.name, until: now.until, mark: now, resumed: false } : current);
      }, warned("Ovis: the account's sign-in could not be read"));
    });
    return () => { live = false; off(); };
  }, [idle, accountService]);
  // one object from the press (or the reload) until the wait ends: what it keeps for a reload changes in the effect alone
  const begun = state.kind === "waiting" ? state : null;
  useEffect(() => {
    if (begun === null) return;
    const until = begun.until;
    let live = true;
    let mark = begun.mark;
    // the tab keeps this wait: another copy of this screen that stops it, or begins one of its own, is seen there
    const shared = mark !== null && readAddPcWaiting()?.until === until;
    /** Another copy of this screen ended this wait: nothing more is opened, listed or kept for it. */
    const withdrawn = (): boolean => shared && readAddPcWaiting()?.until !== until;
    /** Forgets this wait, never one another copy began since. */
    const forget = (): void => { const now = readAddPcWaiting(); if (now === null || now.until === until) keepAddPcWaiting(null); };
    /** This wait ended in another copy: the offer again, or the wait that copy began in its place, under the same account. */
    const left = (): void => {
      const now = readAddPcWaiting();
      setState(now !== null && now.until !== until && now.account === mark?.account && resumable(now, Date.now())
        ? { kind: "waiting", name: now.name, until: now.until, mark: now, resumed: false }
        : { kind: "offer" });
    };
    const stopped = (): void => { forget(); left(); };
    const expired = (): boolean => {
      if (Date.now() < until) return false;
      forget();
      setState({ kind: "expired" });
      return true;
    };
    /** Whether the sign-in stored now is the one the press was made under: another tab may have signed out, or in as someone else. */
    const stillSignedIn = async (): Promise<boolean> => mark === null || (await accountService().session())?.account === mark.account;
    /** The PC has an account: the screen says so, or shows nothing when it is not the one signed in to. */
    const joined = async (account: string, enrolling: boolean): Promise<void> => {
      const next = await joinedAs(account, enrolling);
      if (!live) return;
      keepAddPcWaiting(null);
      setState(next);
    };
    let reopening = false;
    /** Opens the window again; never under a hidden page, past the thirty minutes of the press, or under another sign-in. */
    const reopen = (): void => {
      // a wait another copy ended is left to `ask`, which first finds out whether it ended by the PC being added
      if (expired() || pageHidden() || reopening || withdrawn()) return;
      reopening = true;
      within(ANSWER_MS, (async (): Promise<void> => {
        if (!await stillSignedIn()) { if (live) stopped(); return; }
        if (!live || withdrawn()) return;
        const pc = await reopenAddWindow();
        // the address now answers for another PC than the one that waited: its wait is not this one's
        if (live && pc !== null && mark !== null && pc !== mark.serverId) stopped();
      })()).catch(warned("Ovis: this PC's pairing window was not reopened")).finally(() => { reopening = false; });
    };
    let asking = false;
    /** Asks whether a device added this PC: then the screen is done and everything here stops. */
    const ask = (): void => {
      if (pageHidden() || asking) return;
      asking = true;
      within(ANSWER_MS, (async (): Promise<void> => {
        const { account, enrolling } = await thisPcMembership();
        if (!live) return;
        if (account !== null) await joined(account, enrolling);
        else if (withdrawn()) left();
      })()).catch(warned("Ovis: this PC's account could not be read")).finally(() => { asking = false; });
    };
    let relisting: ReturnType<typeof setTimeout> | null = null;
    /** How long until the PC is next due to be listed: `RELIST_MS` after it was last listed, by this copy or another. */
    const due = (): number => Math.min(RELIST_MS, Math.max(0, (mark?.listedAt ?? Date.now()) + RELIST_MS - Date.now()));
    /**
     * Lists the PC anew when its entry is about to leave the account's devices (which also opens the window),
     * `RELIST_MS` after it was last listed; a listing that failed is tried again as soon as the window is.
     * Also under a hidden page, unlike the reopening: the entry would leave the account's devices otherwise.
     */
    const relist = (): void => {
      relisting = null;
      if (expired()) return;
      /** the listing this attempt began, which the other copy on this wait joins rather than listing too */
      let mine: typeof relistOnItsWay = null;
      let over = false;
      within(2 * REOPEN_MS, (async (): Promise<boolean> => {
        const { account, enrolling } = await thisPcMembership();
        if (!live) return true;
        if (account !== null) { await joined(account, enrolling); return true; }
        if (withdrawn()) { left(); return true; }
        // listed only under the account the press was made in: another sign-in since then ends the wait
        if (!await stillSignedIn()) { if (live) stopped(); return true; }
        // this attempt got no answer in time and the next one is due: nothing is listed late
        if (!live || over) return true;
        if (withdrawn()) { left(); return true; }
        // the other copy that waits on this wait listed the PC since: the next listing is due from then
        const kept = shared ? readAddPcWaiting() : null;
        if (mark !== null && kept !== null && kept.until === until && kept.listedAt > mark.listedAt) { mark = kept; return true; }
        // listed for this wait alone: nothing is written for another PC, under another sign-in, or once the wait
        // was stopped (here or in another copy) while the listing was on its way
        const wait = mark === null ? undefined : { serverId: mark.serverId, account: mark.account, running: (): boolean => live && !withdrawn() };
        const flying = shared && relistOnItsWay?.until === until ? relistOnItsWay : null;
        const listed = flying?.listed ?? listThisPc(accountService(), { relistMs: RELIST_MS, for: wait });
        if (shared && flying === null) relistOnItsWay = mine = { until, listed };
        await listed;
        if (!live) return true;
        // another copy stopped the wait while the PC was being listed: what it forgot is not kept again
        if (withdrawn()) { left(); return true; }
        if (mark !== null) { mark = { ...mark, listedAt: Date.now() }; keepAddPcWaiting(mark); }
        return true;
      })()).catch((error: unknown) => {
        if (error instanceof AddPcWaitOver) {
          if (!live) return true;
          // the address answers for another PC now, or the tab is signed in to another account: the wait is not this one's
          if (error.why !== "ended") { stopped(); return true; }
          if (withdrawn()) { left(); return true; }
          // the copy that was listing for both was closed on the way: this one lists with the next reopen
          return false;
        }
        console.warn("Ovis: this PC was not listed in the account again", error instanceof Error ? error.name : error);
        return false;
      }).then((ok) => {
        // over with this attempt, also one that got no answer in time: the next attempt lists for itself
        over = true;
        if (mine !== null && relistOnItsWay === mine) relistOnItsWay = null;
        // a wait that just ended (its effect is about to be left) has no listing due: never at once
        if (live && relisting === null) relisting = setTimeout(relist, ok ? due() || RELIST_MS : REOPEN_MS);
      });
    };
    const shown = (): void => { if (!pageHidden()) { reopen(); ask(); } };
    const timers = [setInterval(reopen, REOPEN_MS), setInterval(ask, ADDED_POLL_MS)];
    // a reloaded tab's listing is as old as before the reload: the next one is due from then, at once when that has passed
    relisting = setTimeout(relist, due());
    // a hidden page's timers run late or not at all: the end of the thirty minutes has a timer of its own
    const end = setTimeout(expired, Math.max(0, until - Date.now()));
    document.addEventListener("visibilitychange", shown);
    // the press opened the window itself; a reload opened none
    if (begun.resumed) reopen();
    return () => {
      live = false;
      for (const timer of timers) clearInterval(timer);
      if (relisting !== null) clearTimeout(relisting);
      clearTimeout(end);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [begun, joinedAs, accountService]);
  // the PC is in the account, but the device that added it has not finished its enrollment: asked until it has
  const settling = state.kind === "done" && state.enrolling ? state.account : null;
  useEffect(() => {
    if (settling === null) return;
    let live = true;
    let asking = false;
    const timer = setInterval(() => {
      if (pageHidden() || asking) return;
      asking = true;
      within(ANSWER_MS, thisPcMembership()).then(({ account, enrolling }) => {
        if (!live) return;
        // its first member left before enrolling it: the PC is in no account again
        if (account !== settling) setState(account === null ? { kind: "offer" } : { kind: "hidden" });
        else if (!enrolling) setState({ kind: "done", account, enrolling: false });
      }, warned("Ovis: this PC's account could not be read")).finally(() => { asking = false; });
    }, ADDED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [settling]);
  /** Lists this PC and waits, thirty minutes from this press. */
  const add = (): void => {
    (async (): Promise<AddThisPcState> => {
      // the window outlives a wait that stopped by up to ten minutes: a device may have added this PC through it, and then nothing is listed again
      const { account: joined, enrolling } = await thisPcMembership();
      if (joined !== null) { keepAddPcWaiting(null); return await joinedAs(joined, enrolling); }
      const { name, serverId, account } = await listThisPc(accountService(), { relistMs: RELIST_MS });
      const now = Date.now();
      const mark = account === null ? null : { name, until: now + WAITING_MS, serverId, account, listedAt: now };
      pressed.current = mark?.until ?? null;
      keepAddPcWaiting(mark);
      return { kind: "waiting", name, until: now + WAITING_MS, mark, resumed: false };
    })().then(setState, (error: unknown) => {
      console.warn("Ovis: this PC was not listed in the account", error instanceof Error ? error.name : error);
      setState({ kind: "error", message: error instanceof ApiError && error.code === "relay_off"
        ? relayAbove ? t("Turn on remote access through the Ovis relay above first.") : t("Turn on remote access through the Ovis relay in Settings → Devices and PCs first.")
        : t("This PC could not be listed in your account. Try again.") });
    });
  };
  const stop = (): void => { keepAddPcWaiting(null); setState({ kind: "offer" }); };
  if (state.kind === "hidden") return null;
  return (
    <div className="settings-item account-add-pc">
      {state.kind === "waiting" ? (
        <>
          <p className="settings-description">{t("On a device already signed in to this account (the Ovis app or app.ovis.sh), choose Add on {name}. This screen then shows a six-digit number: type it there, then press Approve here. Keep this page open.", { name: state.name })}</p>
          <p className="settings-description">{t("Every device of your account can use this PC after that.")}</p>
          <p className="settings-description" role="status">{t("Waiting. The window reopens by itself if Ovis restarts.")}</p>
          <button type="button" className="btn" onClick={stop}>{t("Stop waiting")}</button>
        </>
      ) : state.kind === "done" ? (
        <>
          <p className="settings-description" role="status">{state.enrolling
            ? t("This PC is in your account. The device that added it is still letting your other devices in.")
            : t("This PC is in your account. Your other devices can open it now.")}</p>
          <p className="settings-description" title={state.account}>{t("Account")} <code className="account-id">{state.account.length > 12 ? `${state.account.slice(0, 12)}…` : state.account}</code></p>
        </>
      ) : state.kind === "expired" ? (
        <>
          <p className="settings-description" role="status">{t("This PC stopped waiting after 30 minutes.")}</p>
          <button type="button" className="btn btn-primary" onClick={add}>{t("Keep waiting")}</button>
        </>
      ) : (
        <>
          <p className="settings-description">{t("Add this PC to your account, so every device of your account can use it with one approval.")}</p>
          <button type="button" className="btn btn-primary" onClick={add}>{t("Add this PC to my account")}</button>
          {state.kind === "error" && <p className="settings-condition" role="alert">{state.message}</p>}
        </>
      )}
    </div>
  );
}

/**
 * A fetch for the account service's first request that reports whether the service can be reached: an answer
 * other than a server error says it can (offeredProviders falls back quietly on any).
 */
export function reachabilityProbe(report: (reachable: boolean) => void, fetchImpl: typeof fetch = fetch): (input: Request | string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    try {
      const response = await fetchImpl(input, init);
      // a server error (a 503 while it is down or restarting) is no service to sign in to
      report(response.status < 500);
      return response;
    } catch (error) {
      report(false);
      throw error;
    }
  };
}

/** the waits before asking an account service that did not answer again: soon at first, then once a minute */
export const REPROBE_MS = [5_000, 15_000, 60_000] as const;

interface ReprobeTimers { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const windowTimers: ReprobeTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * Asks `probe` until it says the account service can be reached, waiting REPROBE_MS between tries (the last one
 * repeats), so the sign-in comes back once a service that was down answers again. The function returned stops it.
 */
export function probeUntilReachable(probe: (live: () => boolean) => Promise<boolean>, timers: ReprobeTimers = windowTimers): () => void {
  let live = true;
  let handle: unknown = null;
  let tries = 0;
  const run = async (): Promise<void> => {
    handle = null;
    const reachable = await probe(() => live).catch(() => false);
    if (!live || reachable) return;
    handle = timers.set(() => void run(), REPROBE_MS[Math.min(tries, REPROBE_MS.length - 1)]!);
    tries += 1;
  };
  void run();
  return () => {
    live = false;
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
}

/** What Settings → Devices and PCs needs of the account: signed in or not, and the account's PCs for My devices. */
export interface AccountState {
  signedIn: boolean; account: string | null; pcs: MyPc[] | null;
  /** false once the account service did not answer: the relay tab then offers the relay's own pairing (ConnectPhoneDialog) */
  reachable: boolean;
}

/** the phone and Mac apps sign in their own way, never with a code from a PC's page */
const pcServiceHere = (): string | null => desktopAccount() === null && !inNativeApp() && !inMacApp() ? pcAccountServiceOf(document, window.isSecureContext) : null;

/** the account service this page signs in with: the desktop app's, or the one a PC's page names; null for none */
export const accountServiceHere = (): string | null => desktopAccount()?.service ?? pcServiceHere();

/**
 * The first-run welcome's sign-in (components/SetupGuide.tsx): the same sign-in in a box of its own,
 * with the guide's own line above it and its Not now below; once signed in, Add this PC.
 */
export interface WelcomeAccount { lead: ReactNode; later: ReactNode }

/** `onAccount`: the page lists the account's PCs itself (My devices), so this group does not */
export function AccountSection({ onAccount, welcome, recheck = 0 }: {
  onAccount?: (state: AccountState) => void; welcome?: WelcomeAccount;
  /** bumped to ask the account service again now, and read the sign-in again (Settings bumps it when Add a connection opens, and once its relay tab signed in) */
  recheck?: number;
} = {}) {
  const t = useT();
  const bridge = desktopAccount();
  const pcService = pcServiceHere();
  const offered = bridge !== null || pcService !== null;
  const [view, setView] = useState<View>({ kind: "loading" });
  const fallback: AccountProvider[] = bridge ? desktopProviders(bridge) : ["github"];
  const [offer, setOffer] = useState<OfferedProviders | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  /** a change to the ways in that waits for a fresh sign-in (403 reauth_required) */
  const [reauth, setReauth] = useState<{ action: "add" | "remove"; provider: AccountProvider } | null>(null);
  const deviceSignIn = useRef<AbortController | null>(null);
  // the sign-in a device code actually started: the link page's, or a provider's own when it fell back
  const startedProvider = useRef<DeviceSignInProvider | null>(null);
  const service = bridge?.service ?? pcService;
  const fallbackKey = fallback.join(",");
  useEffect(() => {
    if (service === null) return;
    return probeUntilReachable(async (live) => {
      let reachable = true;
      const probe = reachabilityProbe((answer) => { reachable = answer; if (live()) setUnreachable(!answer); });
      try {
        const offered = await offeredProviders(service, fallbackKey.split(",") as AccountProvider[], { fetch: probe });
        if (live()) setOffer(offered);
      } catch (error) {
        console.warn("Ovis: the account service's sign-ins could not be read", error instanceof Error ? error.name : error);
      }
      return reachable;
    });
  }, [service, fallbackKey, recheck]);
  /** the desktop app comes back over loopback with any provider; a PC's page only through a device flow */
  const providers: AccountProvider[] = bridge !== null ? offer?.providers ?? fallback : offer?.device ?? ["github"];
  /** a PC's page whose service has the Ovis link page: one button, GitHub or Google chosen on the link page */
  const linkPage = bridge === null && pcService !== null && (offer?.page.length ?? 0) > 0;
  // bumped by a sign-out and on unmount: a load still waiting for the account's PCs then shows nothing
  const loads = useRef(0);

  const load = useCallback(async function read(): Promise<void> {
    const generation = ++loads.current;
    const show = (next: View) => { if (loads.current === generation) setView(next); };
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    if (session === undefined) { show({ kind: "signed-out", error: null }); return; }
    const signedIn = { kind: "signed-in", provider: session.provider, account: session.account } as const;
    show({ ...signedIn, pcs: null, methods: null, limits: null, error: null });
    // the limits row is optional: read from the session's own service, apart, so it never holds up the rest
    void accountLimitsOf(service, session).then((limits) => {
      if (loads.current !== generation || limits === null) return;
      setView((current) => current.kind === "signed-in" && current.account === session.account ? { ...current, limits } : current);
    });
    try {
      const lists = await accountListsOf(service, session);
      if (loads.current !== generation) return;
      // another sign-in took this one's place (another tab): the section reads that one
      if (lists === null) { void read(); return; }
      const { pcs, methods } = lists;
      setView((current) => ({ ...signedIn, pcs: myPcs(pcs, [], { now: Date.now() }), methods, limits: current.kind === "signed-in" && current.account === session.account ? current.limits : null, error: null }));
    } catch (error) {
      if (error instanceof SignedOutError) show({ kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") });
      else if (loads.current === generation) setView((current) => ({ ...signedIn, pcs: [], methods: null, limits: current.kind === "signed-in" && current.account === session.account ? current.limits : null, error: t("The account service could not be reached. The PCs this device is paired with still work.") }));
    }
  }, [t]);

  const recheckAccount = useEffectEvent(() => {
    switch (view.kind) {
      case "device-code":
      case "signing-in": return;
      case "loading":
      case "signed-out":
      case "signed-in": if (offered) void load(); return;
      default: view satisfies never;
    }
  });
  useEffect(() => { recheckAccount(); }, [offered, load, recheck]);
  useEffect(() => {
    onAccount?.({ signedIn: view.kind === "signed-in", account: view.kind === "signed-in" ? view.account : null, pcs: view.kind === "signed-in" ? view.pcs : null, reachable: !unreachable });
  }, [onAccount, view, unreachable]);
  // closing Settings ends a device sign-in still waiting: its session is then never kept
  useEffect(() => () => { deviceSignIn.current?.abort(); loads.current++; }, []);

  if (!offered) return null;

  const unlinked = bridge !== null && view.kind === "signed-in" && view.methods !== null
    ? providers.filter((provider) => !view.methods?.some((method) => method.provider === provider)) : [];

  const cancelDeviceSignIn = (): void => {
    deviceSignIn.current?.abort();
    deviceSignIn.current = null;
  };

  /** `provider` null: the link page, where the person picked GitHub or Google themselves, so the text names neither */
  const failureText = (error: unknown, provider: AccountProvider | null): string => {
    const name = provider === null ? null : PROVIDER_NAMES[provider];
    if (error instanceof AccountServiceError && error.code === "identity_exists" && name !== null) return t("Your account already signs in with {provider}.", { provider: name });
    if (!(error instanceof SignInError)) return t("The sign-in did not finish. Try again.");
    switch (error.code) {
      case "denied": return name === null ? t("The sign-in was refused.") : t("{provider} refused the sign-in.", { provider: name });
      case "expired": return t("The code expired. Sign in again to get a new one.");
      case "unsupported": return t("This account service can't sign in a browser on this PC yet.");
      case "in_use": return name === null
        ? t("This sign-in already belongs to another Ovis account. Nothing was changed.")
        : t("This {provider} sign-in already belongs to another Ovis account. Nothing was changed.", { provider: name });
      case "no_sign_in": return t("The sign-in did not finish. Try again.");
    }
  };

  /** A device sign-in on a PC's own page: shows the link page's or the provider's code until it is approved. */
  const signInWithCode = (pcServiceOrigin: string, provider: DeviceSignInProvider): Promise<AccountSession> => {
    cancelDeviceSignIn();
    const controller = new AbortController();
    deviceSignIn.current = controller;
    setView({ kind: "device-code", provider, userCode: null, verificationUri: "", verificationUriComplete: null });
    startedProvider.current = null;
    return (async () => {
      const requester = { label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0), os: deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
      const started = provider === "ovis"
        // the link page busy or down: the provider's own device page instead, GitHub's where the service has it
        ? await startLinkPageSignIn({ service: pcServiceOrigin, store: indexedAccountStore, requester }, offer?.device[0] ?? "github")
        : await startDeviceSignIn({ service: pcServiceOrigin, store: indexedAccountStore, provider, requester });
      controller.signal.throwIfAborted();
      startedProvider.current = started.provider;
      setView({ kind: "device-code", provider: started.provider, userCode: started.userCode, verificationUri: started.verificationUri, verificationUriComplete: started.verificationUriComplete });
      return started.finish(controller.signal);
    })().finally(() => { if (deviceSignIn.current === controller) deviceSignIn.current = null; });
  };

  /**
   * Runs one provider's sign-in the way this page can; null when it cannot here. `viaLinkPage`: the
   * link page, where the person picks GitHub or Google; a sign-in again for this same account passes
   * false, so it stays with the provider the account signed in with.
   */
  const runSignIn = (provider: AccountProvider, viaLinkPage = linkPage): Promise<AccountSession> | null => {
    if (bridge !== null) return desktopSignIn(provider, bridge, indexedAccountStore);
    if (pcService === null) return null;
    if (viaLinkPage) return signInWithCode(pcService, "ovis");
    return isDeviceProvider(provider) ? signInWithCode(pcService, provider) : null;
  };

  const signIn = (provider: AccountProvider): void => {
    if (bridge !== null) setView({ kind: "signing-in" });
    runSignIn(provider)?.then(load, (error: unknown) => {
      // cancelled, or Settings closed: the page already moved on
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      // the link page named no provider (the person picked one there); its fallback to a provider's own page did
      const started = startedProvider.current;
      const named = bridge === null && pcService !== null && linkPage ? (started === null || started === "ovis" ? null : started) : provider;
      setView({ kind: "signed-out", error: failureText(error, named) });
    });
  };

  const needsReauth = (error: unknown): boolean => error instanceof AccountServiceError && error.code === "reauth_required";

  /**
   * Adds `provider` to the signed-in account on purpose, from the desktop app only: a link goes
   * through a redirect sign-in, never a device code someone else could have typed.
   */
  const addMethod = (provider: AccountProvider): void => {
    if (bridge === null) return;
    setView({ kind: "signing-in" });
    new AccountService({ store: indexedAccountStore }).addMethod(provider, (linkToken, bearer) => desktopSignIn(provider, bridge, indexedAccountStore, { linkToken, bearer }))
      .then(() => load(), async (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Ovis: the sign-in method was not added", error instanceof SignInError || error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
        await load();
        if (needsReauth(error)) { setReauth({ action: "add", provider }); return; }
        const message = failureText(error, provider);
        setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
      });
  };

  const removeMethod = (provider: AccountProvider): void => {
    new AccountService({ store: indexedAccountStore }).removeIdentity(provider).then(() => load(), (error: unknown) => {
      console.warn("Ovis: the sign-in method was not removed", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      if (needsReauth(error)) { setReauth({ action: "remove", provider }); return; }
      const message = error instanceof AccountServiceError && error.code === "last_identity"
        ? t("Add another way to sign in before removing this one.") : t("The sign-in method could not be removed. Try again.");
      setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
    });
  };

  /**
   * The service wants a sign-in from the last ten minutes to change the ways in: sign in again
   * with the method this device uses, then repeat the change, on the same account only.
   */
  const signInAgain = (): void => {
    if (reauth === null || view.kind !== "signed-in") return;
    const { action, provider } = reauth;
    const { account, provider: current } = view;
    setReauth(null);
    runSignIn(current, false)?.then(async (session) => {
      await load();
      if (session.account !== account) return;
      if (action === "add") addMethod(provider);
      else removeMethod(provider);
    }, async (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      await load();
      setView((now) => now.kind === "signed-in" ? { ...now, error: failureText(error, current) } : now);
    });
  };

  const signOut = (): void => {
    cancelDeviceSignIn();
    // a PC that waited to be added under this sign-in waits no longer under the next one
    keepAddPcWaiting(null);
    loads.current++;
    void new AccountService({ store: indexedAccountStore }).signOut()
      .catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error))
      .finally(() => setView({ kind: "signed-out", error: null }));
  };

  const signInParts = (
    <>
      {view.kind === "signed-out" && (
        <div className="settings-item" data-offer={offer === null ? "build" : "service"}>
          {linkPage
            ? (
              <div className="account-sign-in">
                <button type="button" className="btn btn-primary account-provider" data-provider="ovis" onClick={() => signIn("github")}>{t("Sign in")}</button>
                {view.error !== null && <p className="account-error" role="alert">{view.error}</p>}
              </div>
            )
            : <AccountSignIn onSignIn={signIn} error={view.error} providers={providers} />}
        </div>
      )}
      {view.kind === "signing-in" && <SettingsRow label={t("Signing in…")} description={t("Finish signing in in your browser.")}>{null}</SettingsRow>}
      {view.kind === "device-code" && (
        <div className="settings-item account-device">
          {view.userCode === null
            ? <p className="settings-description" role="status">{t("Signing in…")}</p>
            : view.provider === "ovis"
              ? (
                <>
                  <p className="settings-description">{t("On any device, open {address} and enter this code, then continue with GitHub or Google. Enter it only if you started this sign-in on this page.", { address: linkAddress(view.verificationUri) })}</p>
                  {view.verificationUriComplete !== null && <QrCode value={view.verificationUriComplete} label={t("QR code of the sign-in page with this code filled in")} />}
                  <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                  <p className="settings-description" role="status">{t("Waiting for the sign-in…")}</p>
                </>
              )
              : (
                <>
                  <p className="settings-description">{t("Open {provider} and enter this code. Enter it only if you started this sign-in on this page.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                  <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                  <p className="settings-description" role="status">{t("Waiting for {provider}…", { provider: PROVIDER_NAMES[view.provider] })}</p>
                </>
              )}
          <div className="account-device-actions">
            {view.userCode !== null && (
              <a className="btn btn-primary" href={view.verificationUri} target="_blank" rel="noopener noreferrer">
                {view.provider === "ovis" ? t("Open the sign-in page") : t("Open {provider}", { provider: PROVIDER_NAMES[view.provider] })}
              </a>
            )}
            <button type="button" className="btn" onClick={() => { cancelDeviceSignIn(); void load(); }}>{t("Cancel")}</button>
          </div>
        </div>
      )}
    </>
  );

  if (welcome !== undefined) {
    // signed out, the buttons wait for the service's own list: the build's fallback could offer one it lacks
    if (view.kind === "loading" || (view.kind === "signed-out" && offer === null)) return null;
    return (
      <div className="setup-signin">
        {view.kind === "signed-in"
          ? <><p className="setup-signin-done" role="status">{t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}</p><AddThisPc relayAbove={false} /></>
          : <>{welcome.lead}{signInParts}</>}
        {/* signed out only: a sign-in under way ends with its own Cancel, never folded away unnoticed by Not now */}
        {view.kind === "signed-out" && welcome.later}
      </div>
    );
  }

  return (
    <SettingsGroup title={t("Account")} section="account" keepNote note={view.kind === "signed-out" ? t("Sign in to use this PC from your phone and your other PCs.|account group") : undefined}>
      {signInParts}
      {view.kind === "signed-in" && (
        <>
          {/* which account: the service keeps no login or email, so its id names it, whole in the tooltip (G-106) */}
          <SettingsRow label={t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}
            description={<span title={view.account}>{t("Account")} <code className="account-id">{view.account.length > 12 ? `${view.account.slice(0, 12)}…` : view.account}</code></span>}>
            <button type="button" className="btn" onClick={signOut}>{t("Sign out of {provider}", { provider: PROVIDER_NAMES[view.provider] })}</button>
          </SettingsRow>
          {view.limits !== null && (() => {
            const listed = view.pcs?.filter((pc) => pc.listed).length ?? 0;
            const { label, summary } = formatAccountLimits(t, view.limits, listed);
            return (
              <div className="settings-row account-limits-row" data-testid="account-limits-row">
                <span className="settings-label">{label}</span>
                <span className="settings-fact account-limits-summary">{summary}</span>
              </div>
            );
          })()}
          {view.methods !== null && (
            <div className="settings-item account-methods">
              <p className="settings-label">{t("Ways to sign in")}</p>
              <ul className="account-method-list">
                {view.methods.map((method) => (
                  <li key={method.provider} className="account-method" data-provider={method.provider}>
                    <ProviderMark provider={method.provider} />
                    <span className="account-method-text">
                      <span>{PROVIDER_NAMES[method.provider]}</span>
                      <span className="settings-description">{t("Added {date}", { date: new Date(method.added_at).toLocaleDateString(currentLocale()) })}</span>
                    </span>
                    {/* the method this device signed in with stays: removing it would end this sign-in. The button names
                        what it removes (G-174) */}
                    {view.methods !== null && view.methods.length > 1 && method.provider !== view.provider && (
                      <button type="button" className="btn" onClick={() => removeMethod(method.provider)}>{t("Remove {provider}", { provider: PROVIDER_NAMES[method.provider] })}</button>
                    )}
                  </li>
                ))}
              </ul>
              {reauth !== null && (
                <div className="account-reauth" role="alert">
                  <p className="settings-description">{bridge === null
                      // a sign-in again stays with this account's provider, at its own device page, never the link page's choice
                      ? t("To change how you sign in, sign in again with {provider} on its own sign-in page first.", { provider: PROVIDER_NAMES[view.provider] })
                      : t("To change how you sign in, sign in again with {provider} first.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                  {(bridge !== null || isDeviceProvider(view.provider)) && <button type="button" className="btn btn-primary" onClick={signInAgain}>{t("Sign in again")}</button>}
                </div>
              )}
              {bridge === null && <p className="settings-description">{t("Add another way to sign in from the Ovis desktop app.")}</p>}
              {unlinked.length > 0 && (
                <div className="account-method-add">
                  {unlinked.map((provider) => (
                    <button key={provider} type="button" className="btn" onClick={() => addMethod(provider)}>
                      <ProviderMark provider={provider} />{t("Add {provider}", { provider: PROVIDER_NAMES[provider] })}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <AddThisPc />
          {view.pcs !== null && onAccount === undefined && <div className="settings-item"><AccountPcList pcs={view.pcs} /></div>}
          {view.error !== null && <p className="settings-condition" role="alert">{view.error}</p>}
        </>
      )}
    </SettingsGroup>
  );
}
