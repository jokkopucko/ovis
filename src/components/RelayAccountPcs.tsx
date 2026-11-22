import { useEffect, useRef, useState } from "react";

import "./ConnectPhoneDialog.css";
import "./RelayAccountPcs.css";

import type { Machine } from "../../shared/machines.ts";
import { AccountService } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { ACCOUNT_PCS_CHANGED_EVENT, isNewAccountPc, myPcs } from "../lib/account/myPcs.ts";
import { ApiError, checkAccountPcs, pairAccountPc, startAccountPc, type AccountPcEntry, type AccountPcState } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { deviceOs } from "../lib/phone.ts";

type AccountPcRow = AccountPcEntry & { readonly new_until?: string | null };

/** The account as this list uses it: its PCs that a device can pair with (key and relay from the directory), and the admission that vouches for this PC. */
export interface AccountPcsSource {
  /** the account's PCs with a key and relay to pair with, and the account they were read under; null when this page is not signed in */
  list(): Promise<{ account: string; pcs: readonly AccountPcRow[] } | null>;
  /** the account this page is signed in to; null when it is not */
  account(): Promise<string | null>;
  /** says, under the sign-in the list was read with, that this PC's server waits at `serverId` with `key` */
  admit(serverId: string, label: string, key: string): Promise<void>;
}

/** The page's own sign-in (docs/account.md): the directory nobody vouches for, each entry's key checked against its id (myPcs). */
export function signedInAccount(): AccountPcsSource {
  const service = new AccountService({ store: indexedAccountStore });
  let bound: AccountService | null = null;
  return {
    async account() {
      return (await service.session())?.account ?? null;
    },
    async list() {
      const session = await service.session();
      if (session === undefined) return null;
      bound = service.forSignIn(session);
      const pcs = myPcs(await bound.listPcs(), [], { now: Date.now() }).flatMap((pc) => pc.join === undefined ? [] : [
        { server_id: pc.server_id, name: pc.name, ...pc.join, ...(pc.new_until == null ? {} : { new_until: pc.new_until }) },
      ]);
      return { account: session.account, pcs };
    },
    async admit(serverId, label, key) {
      if (bound === null) throw new Error("Not signed in");
      await bound.postAdmission(serverId, label.slice(0, 48), key, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0));
    },
  };
}

/** one listing of one account on this PC: the PCs asked so far, and those this PC cannot use */
type Round = { asked: Set<string>; invalid: Set<string>; failed: Set<string>; scope: string | null };

export type Pairing = { server_id: string; digits: string | null; abort: AbortController };

export const spaced = (digits: string): string => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/** The account's other PCs as both lists use them: which would pair, and Add, which pairs one once a member approves it. */
export interface AccountPcs {
  /** the account's PCs but this one; null until read, when not signed in, or when this PC will not check them */
  pcs: readonly AccountPcRow[] | null;
  /** the PC of this app's roster an account PC already is */
  added(serverId: string): Machine | undefined;
  /** what the PC answered when asked whether it would pair; undefined while it is asked */
  stateOf(serverId: string): AccountPcState | undefined;
  pairing: Pairing | null;
  failure: { server_id: string; message: string } | null;
  add(pc: AccountPcEntry): Promise<void>;
  cancel(): void;
  /** asks that PC again whether it would pair (Check again on one that did not answer); rejects when it could not be asked */
  recheck(pc: AccountPcEntry): Promise<void>;
}

/**
 * The account's other PCs, read once `enabled`: each not in this app yet is asked on its own whether it would pair, so a
 * PC slow to answer (offline) holds no other row on Checking…. Add has this PC's server pair with it through the relay
 * once a member of the account approves it on another device (docs/account.md, "Adding a PC of your account"), then
 * hands the new PC to `onAdded`. With `expect`, only that account's PCs are kept, and a press asks nothing once this page
 * is signed in to another account or none. Nothing is read until this PC's own server id is known, so it never lists
 * itself; `enabled` going false ends a pairing under way.
 */
export function useAccountPcs({ machines, source, enabled = true, expect, refresh = 0, onAdded }: { machines: readonly Machine[]; source?: AccountPcsSource; enabled?: boolean; expect?: string; /** bumped to read the list again (a window that came back), with a pairing under way kept */ refresh?: number; onAdded: (machine: Machine) => void }): AccountPcs {
  const t = useT();
  const account = useRef<AccountPcsSource | null>(null);
  account.current ??= source ?? signedInAccount();
  const [pcs, setPcs] = useState<readonly AccountPcRow[] | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const changed = () => setChanges((count) => count + 1);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
  }, []);
  const [states, setStates] = useState<ReadonlyMap<string, AccountPcState>>(new Map());
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failure, setFailure] = useState<{ server_id: string; message: string } | null>(null);
  const own = machines.find((machine) => machine.kind === "local")?.server_id;
  const added = (serverId: string): Machine | undefined => machines.find((machine) => machine.kind !== "local" && (machine.relay?.server_id ?? machine.server_id) === serverId);
  const listed = useRef<Round>({ asked: new Set(), invalid: new Set(), failed: new Set(), scope: null });
  // closing the list cancels a comparison under way: that PC's server ends it, and nothing is kept
  const running = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) {
      running.current?.abort();
      setPairing(null);
      setPcs(null);
      listed.current = { asked: new Set(), invalid: new Set(), failed: new Set(), scope: null };
      return;
    }
    // the sidebar lists nothing until it knows which PC it is on, so it never lists itself; the relay tab, as before
    if (expect !== undefined && own === undefined) return;
    let live = true;
    account.current!.list().then((read) => {
      if (!live || read === null) return;
      if (expect !== undefined && read.account !== expect) { setPcs(null); return; }
      // a refresh of the same account keeps what each PC said and asks only the ones newly listed; another account,
      // or the list coming back after it was off, starts over
      const scope = `${own}\n${read.account}`;
      if (listed.current.scope !== scope) {
        listed.current = { asked: new Set(), invalid: new Set(), failed: new Set(), scope };
        setStates(new Map());
      } else {
        // a refresh is the one new look a PC that did not answer gets, besides its Check again
        for (const id of listed.current.failed) listed.current.asked.delete(id);
        listed.current.failed.clear();
      }
      const round = listed.current;
      setPcs(read.pcs.filter((pc) => pc.server_id !== own && !round.invalid.has(pc.server_id)));
    }).catch((error: unknown) => {
      console.warn("Ovis: the account's PCs could not be read", error instanceof Error ? error.name : error);
      if (live) setPcs(null);
    });
    return () => { live = false; };
  }, [own, enabled, expect, refresh, changes]);
  // the newest ask of each PC, its first check and every Check again alike: an older one answering late changes nothing
  const asks = useRef(new Map<string, number>());
  const nextAsk = (serverId: string): number => {
    const ask = (asks.current.get(serverId) ?? 0) + 1;
    asks.current.set(serverId, ask);
    return ask;
  };
  const check = (pc: AccountPcEntry, round: Round): void => {
    round.asked.add(pc.server_id);
    const ask = nextAsk(pc.server_id);
    checkAccountPcs([pc]).then(({ pcs: [checked] }) => {
      if (listed.current === round && asks.current.get(pc.server_id) === ask && checked !== undefined) setStates((current) => new Map(current).set(checked.server_id, checked.state));
    }, (error: unknown) => {
      // a newer ask of this PC (its Check again, or a later look) has the say: an older one failing changes nothing
      if (listed.current !== round || asks.current.get(pc.server_id) !== ask) return;
      // an entry this PC cannot use (its relay not a wss: origin, its ID not its key's) stays out of this round's list, also after a refresh reads it again
      if (error instanceof ApiError && error.code === "account_pc_invalid") {
        round.invalid.add(pc.server_id);
        setPcs((current) => current?.filter((entry) => entry.server_id !== pc.server_id) ?? null);
        return;
      }
      console.warn("Ovis: the account's PCs could not be checked", error instanceof Error ? error.name : error);
      // a window this PC will not answer (owner_only, read_only) gets no list rather than rows that say Checking… for good
      if (error instanceof ApiError && (error.code === "owner_only" || error.code === "read_only")) {
        listed.current = { asked: new Set(), invalid: new Set(), failed: new Set(), scope: null };
        setPcs(null);
        return;
      }
      // anything else is that PC not answering: its row says so, with Check again, and the others stay. It is asked
      // again on the next refresh or Check again, never because the roster changed
      round.failed.add(pc.server_id);
      setStates((current) => new Map(current).set(pc.server_id, "offline"));
    });
  };
  useEffect(() => {
    if (pcs === null) return;
    const round = listed.current;
    for (const pc of pcs) if (added(pc.server_id) === undefined && !round.asked.has(pc.server_id)) check(pc, round);
  }, [pcs, machines]);
  useEffect(() => () => { listed.current = { asked: new Set(), invalid: new Set(), failed: new Set(), scope: null }; }, []);
  useEffect(() => () => running.current?.abort(), []);
  /** this page is still signed in to the account the list was read for */
  const stillOurs = async (): Promise<boolean> => expect === undefined || await account.current!.account() === expect;

  const add = async (pc: AccountPcEntry): Promise<void> => {
    const abort = new AbortController();
    running.current = abort;
    setFailure(null);
    setPairing({ server_id: pc.server_id, digits: null, abort });
    try {
      // signed out, or into another account, since the list was read: nothing is asked of that PC
      if (!await stillOurs()) {
        if (!abort.signal.aborted) { setPairing(null); setFailure({ server_id: pc.server_id, message: t("Sign in again") }); }
        return;
      }
      abort.signal.throwIfAborted();
      const { ticket, key, label } = await startAccountPc(pc);
      abort.signal.throwIfAborted();
      await account.current!.admit(pc.server_id, label, key);
      const machine = await pairAccountPc(ticket, (digits) => setPairing((current) => current?.abort === abort ? { ...current, digits } : current), abort.signal);
      if (running.current === abort) running.current = null;
      setPairing(null);
      onAdded(machine);
    } catch (error) {
      if (running.current === abort) running.current = null;
      if (abort.signal.aborted) return;
      setPairing(null);
      if (error instanceof ApiError && error.code === "account_pc_outdated") setStates((current) => new Map(current).set(pc.server_id, "outdated"));
      setFailure({ server_id: pc.server_id, message: error instanceof ApiError ? error.detail : t("That PC could not be added. Try again.") });
    }
  };
  const cancel = (): void => {
    pairing?.abort.abort();
    setPairing(null);
  };
  const recheck = async (pc: AccountPcEntry): Promise<void> => {
    setFailure((current) => current?.server_id === pc.server_id ? null : current);
    const round = listed.current;
    const ask = nextAsk(pc.server_id);
    if (!await stillOurs()) throw new Error(t("Sign in again"));
    // the PC's last answer stays until the new one, and a failed ask leaves every row: it is told on this one
    const { pcs: [checked] } = await checkAccountPcs([pc]);
    if (listed.current !== round || asks.current.get(pc.server_id) !== ask || checked === undefined) return;
    // it answered: a refresh need not ask it again
    round.failed.delete(pc.server_id);
    setStates((current) => new Map(current).set(checked.server_id, checked.state));
  };
  return { pcs, added, stateOf: (serverId) => states.get(serverId), pairing, failure, add, cancel, recheck };
}

/**
 * One already in this app reads Open; one that would pair reads Add (useAccountPcs); an older or offline one says so
 * and gets no button.
 */
export function RelayAccountPcs({ machines, onConnectMachine, source, self = null }: { machines: readonly Machine[]; onConnectMachine: (machine: Machine) => void; source?: AccountPcsSource; /** this PC's name, listed first as one of the account's PCs */ self?: string | null }) {
  const t = useT();
  const { pcs, added, stateOf, pairing, failure, add, cancel } = useAccountPcs({ machines, source, onAdded: onConnectMachine });

  if (self === null && (pcs === null || pcs.length === 0)) return null;
  return (
    <div className="connect-found relay-account-pcs">
      <p className="settings-label">{t("Your account's PCs")}</p>
      <ul className="connect-found-list">
        {self !== null && (
          <li className="relay-account-pc" data-pc-state="self" data-testid="relay-account-self">
            <div className="connect-found-row">
              <span className="connect-found-name">{self}<span className="connect-found-source">{t("This PC")}</span></span>
              <span className="connect-found-detail">{t("Online")}</span>
            </div>
          </li>
        )}
        {(pcs ?? []).map((pc) => {
          const machine = added(pc.server_id);
          const state = stateOf(pc.server_id);
          const waiting = pairing?.server_id === pc.server_id;
          const detail = machine !== undefined ? t("In this app") : state === undefined ? t("Checking…") : state === "ready" ? t("Online")
            : state === "outdated" ? t("Update Ovis on that PC") : t("Offline");
          return (
            <li key={pc.server_id} className="relay-account-pc" data-pc-state={machine !== undefined ? "added" : state ?? "checking"}>
              <div className="connect-found-row">
                <span className="connect-found-name">{pc.name}</span>
                <span className="connect-found-detail">{isNewAccountPc(pc, Date.now()) ? `${t("New PC")} · ` : ""}{detail}</span>
                {machine !== undefined
                  ? <button type="button" className="btn" onClick={() => onConnectMachine(machine)}>{t("Open")}</button>
                  : state === "ready" && (waiting
                    ? <button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button>
                    : <button type="button" className="btn" disabled={pairing !== null} aria-label={t("Add {name}", { name: pc.name })} onClick={() => void add(pc)}>{t("Add")}</button>)}
              </div>
              {waiting && (
                <div className="relay-account-wait" role="status">
                  {pairing.digits === null ? <span className="settings-hint">{t("Asking {name}…", { name: pc.name })}</span> : (
                    <>
                      <span className="settings-hint">{t("Approve on another device of your account")}</span>
                      <span className="relay-account-digits">{spaced(pairing.digits)}</span>
                    </>
                  )}
                </div>
              )}
              {failure?.server_id === pc.server_id && <p className="settings-hint relay-error" role="alert">{failure.message}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
