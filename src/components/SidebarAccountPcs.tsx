import { useEffect, useRef, useState } from "react";
import { Monitor } from "lucide-react";

import "./Machines.css";
import "./SidebarAccountPcs.css";

import type { Machine } from "../../shared/machines.ts";
import { pcAccountStatus } from "../lib/account/join.ts";
import { ACCOUNT_SESSION_EVENT } from "../lib/account/store.ts";
import { isNewAccountPc } from "../lib/account/myPcs.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { fetchRelay } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import type { AccountPcEntry } from "../lib/api.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { signedInAccount, useAccountPcs, type AccountPcRow as ListedAccountPc, type AccountPcs, type AccountPcsSource } from "../lib/account/useAccountPcs.ts";

/**
 * Signed in to the Ovis account on a PC that is in that account with its relay online: the account's other PCs that
 * are not in this app yet, under the PCs the sidebar lists, each added to this PC on its own as soon as it answers, one
 * at a time (the relay tab's Add, and the same approval on another device), so every PC of the account lists every
 * other whichever one a device opens. Each row only says where it is, with nothing to press: Connecting… while it is
 * added, why it was not once a pairing failed (asked again once the account lists something new), that it cannot be
 * reached and may be off where nothing answered in time (all such a check knows: never that it is switched off), or that
 * its Ovis needs an update. The approval itself is asked on the account's devices, never here. A PC once
 * added is the sidebar's own group above. A page that is not signed in asks this PC nothing for it.
 */
export function SidebarAccountPcs({ machines, onAdded, onListed, openable, source, hidden = false }: { machines: readonly Machine[]; onAdded: (machine: Machine) => void; /** the relay IDs of the PCs being added, empty when none are (the hosted app's own list leaves those out) */ onListed?: (serverIds: readonly string[]) => void; /** the PCs this device keeps its own link to (the hosted app's list): a row of one opens it as that link would */ openable?: ReadonlySet<string>; source?: AccountPcsSource; /** the sidebar filter is on: the rows step aside, a pairing under way stays */ hidden?: boolean }) {
  const account = useRef<AccountPcsSource | null>(null);
  account.current ??= source ?? signedInAccount();
  const [mine, setMine] = useState<string | null>(null);
  // the sign-in this page keeps, read again when the window comes back (a sign-in finishes on the account's page in
  // another tab)
  const [reads, setReads] = useState(0);
  useEffect(() => {
    // a tab switch fires focus and visibilitychange together: one return is one read
    let away = false;
    const left = () => { away = true; };
    const again = () => {
      if (document.hidden) { away = true; return; }
      if (!away) return;
      away = false;
      setReads((count) => count + 1);
    };
    window.addEventListener("blur", left);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("blur", left);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  useEffect(() => {
    let live = true;
    account.current!.account().then((read) => { if (live) setMine(read); }, () => { if (live) setMine(null); });
    return () => { live = false; };
  }, [reads]);
  if (mine === null) return null;
  // another account is another list from scratch: nothing read for the one before carries over
  return <JoinedAccountPcs key={mine} account={mine} reads={reads} machines={machines} onAdded={onAdded} onListed={onListed} openable={openable} source={account.current} hidden={hidden} />;
}

/**
 * Signed in to `account`: its PCs once this PC is in that same account with its relay online. Both are read once, and
 * again when the window comes back, never polled: a sidebar adds no request of its own while the window just sits there.
 */
function JoinedAccountPcs({ account, reads, machines, onAdded, onListed, openable, source, hidden }: { account: string; reads: number; machines: readonly Machine[]; onAdded: (machine: Machine) => void; onListed?: (serverIds: readonly string[]) => void; openable: ReadonlySet<string> | undefined; source: AccountPcsSource; hidden: boolean }) {
  const [joined, setJoined] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([fetchRelay(), pcAccountStatus(apiFetch)]).then(([relay, pc]) => {
      if (!live) return;
      // the relay off or blocked, or this PC in another account, ends the list (and a pairing under way); a relay still
      // reconnecting (a PC waking up) leaves it as it was
      if (relay.blocked !== null || relay.phase === "off" || pc.account !== account) setJoined(false);
      else if (relay.phase === "online") setJoined(true);
    // a read that failed says nothing of the relay or the account: what was known stays, and a pairing under way with it
    }, () => undefined);
    return () => { live = false; };
  }, [account, reads]);
  const accountPcs = useAccountPcs({ machines, source, enabled: joined, expect: account, refresh: reads, onAdded });
  const waiting = accountPcs.pcs?.filter((pc) => accountPcs.added(pc.server_id) === undefined) ?? [];
  // each PC is added on its own once. A member's Deny is kept in this browser per account, asking PC and PC, across page loads, until
  // the account lists that PC anew; one that failed for a passing reason gets one more try when the window comes back;
  // any other is asked again once the account lists something new. A read of the list that failed changes nothing.
  const [tried, setTried] = useState<ReadonlySet<string>>(new Set());
  const [, noteDecline] = useState(0);
  const passing = useRef(new Set<string>());
  const retried = useRef(new Set<string>());
  // a Deny is to the PC that asked: the hosted app and the phone app keep one storage for every PC's page
  const asking = machines.find((machine) => machine.kind === "local")?.server_id ?? "";
  const declineKey = (serverId: string): string => `ovis:declined-pc:${account}:${asking}:${serverId}`;
  const declined = (pc: AccountPcEntry & { readonly new_until?: string | null }): boolean => {
    try { return localStorage.getItem(declineKey(pc.server_id)) === (pc.new_until ?? ""); } catch { return false; }
  };
  const failure = accountPcs.failure;
  // each PC's own failure, kept while the next PC is added (the pairing keeps the last one alone), until it is tried anew
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (failure !== null) setFailures((current) => new Map(current).set(failure.server_id, failure.message));
  }, [failure]);
  useEffect(() => {
    if (failure?.code === undefined) return;
    if (failure.code !== "account_pc_declined") {
      if (!retried.current.has(failure.server_id)) passing.current.add(failure.server_id);
      return;
    }
    const pc = accountPcs.pcs?.find((entry) => entry.server_id === failure.server_id);
    if (pc === undefined) return;
    try { localStorage.setItem(declineKey(pc.server_id), pc.new_until ?? ""); } catch { /* not kept: asked again on the next load */ }
    noteDecline((count) => count + 1);
  }, [failure]);
  // a PC asked nothing because this page was not signed in to the account says so only until it is again: a sign-in
  // written in this window, or the window coming back, reads it, and the PC gets its turn
  const signedOut = useRef(new Set<string>());
  const [signIns, noteSignIn] = useState(0);
  // the PCs tried again right as their failure came, since the last sign-in written or return of the window: each is
  // tried so once (a sign-in that finished as the failure came), and then only by the next of those
  const triedOnFailure = useRef(new Set<string>());
  useEffect(() => {
    if (failure?.signIn !== true) return;
    signedOut.current.add(failure.server_id);
    if (triedOnFailure.current.has(failure.server_id)) return;
    triedOnFailure.current.add(failure.server_id);
    noteSignIn((count) => count + 1);
  }, [failure]);
  useEffect(() => {
    const again = () => { triedOnFailure.current.clear(); noteSignIn((count) => count + 1); };
    window.addEventListener(ACCOUNT_SESSION_EVENT, again);
    return () => window.removeEventListener(ACCOUNT_SESSION_EVENT, again);
  }, []);
  useEffect(() => { triedOnFailure.current.clear(); }, [reads]);
  useEffect(() => {
    if (signedOut.current.size === 0) return;
    let live = true;
    source.account().then((read) => {
      if (!live || read !== account) return;
      const back = [...signedOut.current];
      signedOut.current.clear();
      setTried((current) => new Set([...current].filter((serverId) => !back.includes(serverId))));
      setFailures((current) => new Map([...current].filter(([serverId]) => !back.includes(serverId))));
    }, () => undefined);
    return () => { live = false; };
  }, [signIns, reads]);
  useEffect(() => {
    if (passing.current.size === 0) return;
    const again = [...passing.current];
    passing.current.clear();
    for (const serverId of again) retried.current.add(serverId);
    setTried((current) => new Set([...current].filter((serverId) => !again.includes(serverId))));
    setFailures((current) => new Map([...current].filter(([serverId]) => !again.includes(serverId))));
  }, [reads]);
  const listing = accountPcs.pcs?.map((pc) => `${pc.server_id}:${pc.new_until ?? ""}`).join("\n") ?? "";
  const lastListing = useRef("");
  useEffect(() => {
    if (listing === "" || listing === lastListing.current) return;
    lastListing.current = listing;
    retried.current.clear();
    setTried(new Set());
    setFailures(new Map());
  }, [listing]);
  // the relay back on after it was off is a new look at every PC but a declined one, as a new listing is
  const wasJoined = useRef(false);
  useEffect(() => {
    if (joined && !wasJoined.current && lastListing.current !== "") {
      retried.current.clear();
      setTried(new Set());
      setFailures(new Map());
    }
    wasJoined.current = joined;
  }, [joined]);
  // only a PC being added stands in for this device's own link to it (ShellPcs.tsx): one that is outdated, off,
  // declined or failed leaves that link where it was, so an update never costs a phone the way to a PC it drives
  const readyToAdd = (pc: ListedAccountPc) => pc.awaitingCheckIn !== true && pc.outside !== true && !tried.has(pc.server_id) && !declined(pc);
  const adding = waiting.filter((pc) => accountPcs.stateOf(pc.server_id) === "ready" && (accountPcs.pairing?.server_id === pc.server_id || readyToAdd(pc)));
  const listed = adding.map((pc) => pc.server_id).join("\n");
  useEffect(() => {
    onListed?.(listed === "" ? [] : listed.split("\n"));
    return () => onListed?.([]);
  }, [listed, onListed]);
  // never a PC that this device's list of the account does not hold: nothing is asked of it without a person. Nor a
  // PC of the list while it is new to this device: for its day it opens only by hand, here as on My PCs
  const next = accountPcs.pairing === null ? waiting.find((pc) => accountPcs.stateOf(pc.server_id) === "ready" && readyToAdd(pc)
    && !(pc.byList === true && isNewAccountPc(pc, Date.now()))) : undefined;
  useEffect(() => {
    if (next === undefined) return;
    setTried((current) => new Set(current).add(next.server_id));
    void accountPcs.add(next);
  }, [next?.server_id]);
  if (waiting.length === 0) return null;
  return <>{waiting.map((pc) => <AccountPcRow key={pc.server_id} pc={pc} pcs={accountPcs} declined={declined(pc)} failedWith={failures.get(pc.server_id)} hidden={hidden} opens={openable?.has(pc.server_id) === true} />)}</>;
}

/**
 * One PC of the account not in this app yet, as a PC group's header with where it is under it. `opens`: this device keeps
 * its own link to it, which the row stands in for while the PC is added, so its name opens it as that link would.
 */
function AccountPcRow({ pc, hidden, declined, failedWith, opens, pcs: { stateOf, pairing } }: { pc: ListedAccountPc; hidden: boolean; /** a member declined it, in this browser, for this listing */ declined: boolean; /** why its last add failed, until it is tried anew */ failedWith: string | undefined; opens: boolean; pcs: AccountPcs }) {
  const t = useT();
  const [expiredAt, setExpiredAt] = useState<string>();
  const newUntil = pc.new_until;
  useEffect(() => {
    if (newUntil == null) return;
    const remaining = Date.parse(newUntil) - Date.now();
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setExpiredAt(newUntil), remaining);
    return () => clearTimeout(timer);
  }, [newUntil]);
  const state = stateOf(pc.server_id);
  const adding = pairing?.server_id === pc.server_id;
  const failed = !adding && failedWith !== undefined;
  const refused = !adding && !failed && declined;
  // a PC the account's list does not hold is added by nothing here, and one with no way to it cannot be: each says so
  const outside = pc.outside === true && !adding && !failed && state === "ready";
  const awaitingCheckIn = !adding && pc.awaitingCheckIn === true;
  const away = state === "offline" || state === "unreachable" || state === "outdated" || failed || refused || outside || awaitingCheckIn;
  // where it is, beside its name only: the words are the dot's tooltip and what a screen reader hears
  const words = failed ? failedWith : refused ? t("Not approved") : pc.unreachable === true || state === "unreachable" ? t("Can't reach the PC") : outside ? t("Not in your account's list yet")
    : awaitingCheckIn ? t("Waiting to be added") : state === undefined ? t("Checking…") : state === "offline" ? t("Can't reach the PC: it may be off") : state === "outdated" ? t("Update Ovis on that PC") : t("Connecting…");
  return (
    <section hidden={hidden && !adding} className={`machine-group account-pc-group${away ? " is-offline" : ""}`} aria-label={t("PC {name}", { name: pc.name })} data-pc-state={state ?? "checking"}>
      <header className="machine-header">
        <div className="machine-title">
          <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
          {opens ? <a className="machine-name" title={pc.name} href={serverScopePath(pc.server_id)}>{pc.name}</a>
            : <span className="machine-name" title={pc.name}>{pc.name}</span>}
          {newUntil !== expiredAt && isNewAccountPc(pc, Date.now()) && <span className="machine-state-word">{t("New PC")}</span>}
          <span className={`machine-dot is-${away ? "disconnected" : "connecting"}`} title={words} aria-hidden="true" />
        </div>
      </header>
      <p className="machine-state visually-hidden" role={failed ? "alert" : "status"}>{words}</p>
    </section>
  );
}
