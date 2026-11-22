import { useEffect, useRef, useState } from "react";
import { Monitor } from "lucide-react";

import "./Machines.css";
import "./SidebarAccountPcs.css";

import type { Machine } from "../../shared/machines.ts";
import { pcAccountStatus } from "../lib/account/join.ts";
import { isNewAccountPc } from "../lib/account/myPcs.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { fetchRelay } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import type { AccountPcEntry } from "../lib/api.ts";
import { MachineOffLine, useRecheck } from "./MachineOffLine.tsx";
import { signedInAccount, spaced, useAccountPcs, type AccountPcs, type AccountPcsSource } from "./RelayAccountPcs.tsx";

/**
 * Signed in to the Ovis account on a PC that is in that account with its relay online: the account's other PCs that
 * are not in this app yet, under the PCs the sidebar lists, without Add a connection being opened first. Each says
 * what it answered: Add where it would pair (the same Add, and the same approval on another device, as the relay tab's
 * list), Switched off with Check again where it did not answer, or that its Ovis needs an update. A PC once added is
 * the sidebar's own group above. A page that is not signed in asks this PC nothing for it.
 */
export function SidebarAccountPcs({ machines, onAdded, source, hidden = false }: { machines: readonly Machine[]; onAdded: (machine: Machine) => void; source?: AccountPcsSource; /** the sidebar filter is on: the rows step aside, a pairing under way stays */ hidden?: boolean }) {
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
  return <JoinedAccountPcs key={mine} account={mine} reads={reads} machines={machines} onAdded={onAdded} source={account.current} hidden={hidden} />;
}

/**
 * Signed in to `account`: its PCs once this PC is in that same account with its relay online. Both are read once, and
 * again when the window comes back, never polled: a sidebar adds no request of its own while the window just sits there.
 */
function JoinedAccountPcs({ account, reads, machines, onAdded, source, hidden }: { account: string; reads: number; machines: readonly Machine[]; onAdded: (machine: Machine) => void; source: AccountPcsSource; hidden: boolean }) {
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
  if (waiting.length === 0) return null;
  return <>{waiting.map((pc) => <AccountPcRow key={pc.server_id} pc={pc} pcs={accountPcs} hidden={hidden} />)}</>;
}

/** One PC of the account not in this app yet, as a PC group's header with its state under it. */
function AccountPcRow({ pc, hidden, pcs: { stateOf, pairing, failure, add, cancel, recheck } }: { pc: AccountPcEntry & { readonly new_until?: string | null }; hidden: boolean; pcs: AccountPcs }) {
  const t = useT();
  const row = useRef<HTMLElement>(null);
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
  // the same hold as a PC of the roster: one check per PC however often it is pressed (MachineOffLine.tsx)
  const again = useRecheck(pc.server_id, () => recheck(pc), state === "offline");
  const adding = pairing?.server_id === pc.server_id;
  return (
    <section ref={row} tabIndex={-1} hidden={hidden && !adding} className="machine-group is-offline account-pc-group" aria-label={t("PC {name}", { name: pc.name })} data-pc-state={state ?? "checking"}>
      <header className="machine-header">
        <div className="machine-title">
          <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
          <span className="machine-name" title={pc.name}>{pc.name}</span>
          {newUntil !== expiredAt && isNewAccountPc(pc, Date.now()) && <span className="machine-state-word">{t("New PC")}</span>}
          <span className={`machine-dot is-${state === undefined ? "connecting" : state === "ready" ? "connected" : "disconnected"}`} aria-hidden="true" />
        </div>
      </header>
      {state === "offline"
        ? <MachineOffLine state="off" reason={null} checking={again.checking} failure={again.failure} onCheck={again.check} returnFocus={() => row.current} />
        : (
          <div className="account-pc-line">
            {state === undefined && <span className="machine-state-word" role="status">{t("Checking…")}</span>}
            {state === "outdated" && <span className="machine-state-word" role="status">{t("Update Ovis on that PC")}</span>}
            {state === "ready" && (adding
              ? <button type="button" className="btn account-pc-action" onClick={cancel}>{t("Cancel")}</button>
              : <button type="button" className="btn account-pc-action" disabled={pairing !== null} aria-label={t("Add {name}", { name: pc.name })} onClick={() => void add(pc)}>{t("Add")}</button>)}
          </div>
        )}
      {adding && (
        <div className="account-pc-wait" role="status">
          {pairing.digits === null ? t("Asking {name}…", { name: pc.name }) : (
            <>
              <span>{t("Approve on another device of your account")}</span>
              <span className="relay-account-digits">{spaced(pairing.digits)}</span>
            </>
          )}
        </div>
      )}
      {failure?.server_id === pc.server_id && <p className="machine-error" role="alert">{failure.message}</p>}
    </section>
  );
}
