import { useEffect, useRef, useState } from "react";

import "./ConnectPhoneDialog.css";
import "./RelayAccountPcs.css";

import type { Machine } from "../../shared/machines.ts";
import { AccountService } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { myPcs } from "../lib/account/myPcs.ts";
import { ApiError, checkAccountPcs, pairAccountPc, startAccountPc, type AccountPcEntry, type AccountPcState } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { deviceOs } from "../lib/phone.ts";

/** The account as this list uses it: its PCs that a device can pair with (key and relay from the directory), and the admission that vouches for this PC. */
export interface AccountPcsSource {
  /** the account's PCs with a key and relay to pair with; null when this page is not signed in */
  list(): Promise<readonly AccountPcEntry[] | null>;
  /** says, under the sign-in the list was read with, that this PC's server waits at `serverId` with `key` */
  admit(serverId: string, label: string, key: string): Promise<void>;
}

/** The page's own sign-in (docs/account.md): the directory nobody vouches for, each entry's key checked against its id (myPcs). */
export function signedInAccount(): AccountPcsSource {
  const service = new AccountService({ store: indexedAccountStore });
  let bound: AccountService | null = null;
  return {
    async list() {
      const session = await service.session();
      if (session === undefined) return null;
      bound = service.forSignIn(session);
      return myPcs(await bound.listPcs(), [], { now: Date.now() }).flatMap((pc) => pc.join === undefined ? [] : [{ server_id: pc.server_id, name: pc.name, ...pc.join }]);
    },
    async admit(serverId, label, key) {
      if (bound === null) throw new Error("Not signed in");
      await bound.postAdmission(serverId, label.slice(0, 48), key, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0));
    },
  };
}

type Pairing = { server_id: string; digits: string | null; abort: AbortController };

const spaced = (digits: string): string => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/**
 * Add a connection → Ovis relay, signed in with this PC in the account: the account's other PCs, as the SSH tab lists
 * its PCs. One already in this app reads Connect; one that would pair reads Add, which has this PC's server pair with
 * it through the relay once a member of the account approves it on another device (docs/account.md, "Adding a PC of
 * your account"); an older or offline one says so and gets no button.
 */
export function RelayAccountPcs({ machines, onConnectMachine, source }: { machines: readonly Machine[]; onConnectMachine: (machine: Machine) => void; source?: AccountPcsSource }) {
  const t = useT();
  const account = useRef<AccountPcsSource | null>(null);
  account.current ??= source ?? signedInAccount();
  const [pcs, setPcs] = useState<readonly AccountPcEntry[] | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, AccountPcState>>(new Map());
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failure, setFailure] = useState<{ server_id: string; message: string } | null>(null);
  const own = machines.find((machine) => machine.kind === "local")?.server_id;
  const added = (serverId: string): Machine | undefined => machines.find((machine) => machine.kind !== "local" && (machine.relay?.server_id ?? machine.server_id) === serverId);
  // the list as last read, and which of its PCs were asked whether they would pair: an answer for an older one is dropped
  const listed = useRef({ asked: new Set<string>() });
  useEffect(() => {
    let live = true;
    account.current!.list().then((read) => {
      if (!live || read === null) return;
      listed.current = { asked: new Set() };
      setPcs(read.filter((pc) => pc.server_id !== own));
    }).catch((error: unknown) => {
      console.warn("Ovis: the account's PCs could not be read", error instanceof Error ? error.name : error);
      if (live) setPcs(null);
    });
    return () => { live = false; };
  }, [own]);
  // a PC already in this app opens with Connect: only the others are asked whether they would pair, each on its own so a
  // PC slow to answer (offline) holds no other row on Checking…, and one is asked once another window removed it
  useEffect(() => {
    if (pcs === null) return;
    const round = listed.current;
    for (const pc of pcs) {
      if (added(pc.server_id) !== undefined || round.asked.has(pc.server_id)) continue;
      round.asked.add(pc.server_id);
      checkAccountPcs([pc]).then(({ pcs: [checked] }) => {
        if (listed.current === round && checked !== undefined) setStates((current) => new Map(current).set(checked.server_id, checked.state));
      }, (error: unknown) => {
        if (listed.current !== round) return;
        // an entry this PC cannot use (its relay not a wss: origin, its ID not its key's) leaves only its own row; anything
        // else (a window this PC will not answer, owner_only) leaves no list rather than rows that say Checking… for good
        if (error instanceof ApiError && error.code === "account_pc_invalid") setPcs((current) => current?.filter((entry) => entry.server_id !== pc.server_id) ?? null);
        else {
          console.warn("Ovis: the account's PCs could not be checked", error instanceof Error ? error.name : error);
          setPcs(null);
        }
      });
    }
  }, [pcs, machines]);
  // closing the sheet drops answers still on their way
  useEffect(() => () => { listed.current = { asked: new Set() }; }, []);
  // closing the sheet cancels a comparison under way: that PC's server ends it, and nothing is kept
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const add = async (pc: AccountPcEntry): Promise<void> => {
    const abort = new AbortController();
    running.current = abort;
    setFailure(null);
    setPairing({ server_id: pc.server_id, digits: null, abort });
    try {
      const { ticket, key, label } = await startAccountPc(pc);
      abort.signal.throwIfAborted();
      await account.current!.admit(pc.server_id, label, key);
      const machine = await pairAccountPc(ticket, (digits) => setPairing((current) => current?.abort === abort ? { ...current, digits } : current), abort.signal);
      setPairing(null);
      onConnectMachine(machine);
    } catch (error) {
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

  if (pcs === null || pcs.length === 0) return null;
  return (
    <div className="connect-found relay-account-pcs">
      <p className="settings-label">{t("Your account's PCs")}</p>
      <ul className="connect-found-list">
        {pcs.map((pc) => {
          const machine = added(pc.server_id);
          const state = states.get(pc.server_id);
          const waiting = pairing?.server_id === pc.server_id;
          const detail = machine !== undefined ? t("In this app") : state === undefined ? t("Checking…") : state === "ready" ? t("Online")
            : state === "outdated" ? t("Update Ovis on that PC") : t("Offline");
          return (
            <li key={pc.server_id} className="relay-account-pc" data-pc-state={machine !== undefined ? "added" : state ?? "checking"}>
              <div className="connect-found-row">
                <span className="connect-found-name">{pc.name}</span>
                <span className="connect-found-detail">{detail}</span>
                {machine !== undefined
                  ? <button type="button" className="btn" onClick={() => onConnectMachine(machine)}>{t("Connect")}</button>
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
