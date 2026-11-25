import { useEffect, useRef, useState } from "react";

import type { Machine } from "../../../shared/machines.ts";
import { AccountService, SignedOutError } from "./service.ts";
import { indexedAccountStore } from "./store.ts";
import { pagePcs, readPageList } from "./listPcs.ts";
import { pageAccountList } from "./pageList.ts";
import { ACCOUNT_PCS_CHANGED_EVENT, myPcs } from "./myPcs.ts";
import { ApiError, checkAccountPcs, pairAccountPc, startAccountPc, type AccountPcEntry, type AccountPcState } from "../api.ts";
import { useT } from "../i18n.ts";
import { deviceOs } from "../phone.ts";

/**
 * One of the account's PCs as the sidebar lists it. `outside`: the account has a list and this device does not find
 * the PC in it: the row says so and nothing adds it by itself. `unreachable`: the list holds the PC and the account
 * service gives no way to it: the row says so, with no key or relay to ask it by.
 */
export type AccountPcRow = AccountPcEntry & {
  readonly new_until?: string | null; readonly outside?: true; readonly unreachable?: true;
  /** the row is a PC that this device's list of the account holds: while it is new to this device (`new_until`), nothing adds it by itself */
  readonly byList?: true;
};

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
export function signedInAccount(service: Pick<AccountService, "session" | "forSignIn"> = new AccountService({ store: indexedAccountStore })): AccountPcsSource {
  let bound: AccountService | null = null;
  /** the account the list was last read for */
  let listedFor: string | null = null;
  return {
    async account() {
      return (await service.session())?.account ?? null;
    },
    async list() {
      const session = await service.session();
      if (session === undefined) return null;
      bound = service.forSignIn(session);
      listedFor = session.account;
      // a device that holds a copy of its account's list draws by it from the first row on: the page's read of that
      // copy is waited for, and where none ends every row is marked, so the sidebar adds none by itself
      const listed = await bound.listPcs();
      await readPageList(session.account);
      const pcs = myPcs(pagePcs(session.account, listed), [], { now: Date.now() }).flatMap((pc): AccountPcRow[] => pc.join === undefined
        ? (pc.byList === true ? [{ server_id: pc.server_id, name: pc.name, server_public_key: "", relay: "", unreachable: true }] : [])
        : [{ server_id: pc.server_id, name: pc.name, ...pc.join, ...(pc.new_until == null ? {} : { new_until: pc.new_until }), ...(pc.notInList === true ? { outside: true as const } : {}), ...(pc.byList === true ? { byList: true as const } : {}) }]);
      return { account: session.account, pcs };
    },
    async admit(serverId, label, key) {
      // under the sign-in stored now, while it is of the account the list was read for: one made again since (signed out
      // and in) admits as the one the list was read with would; another account, or none, admits nothing
      const session = await service.session();
      if (listedFor === null || session === undefined || session.account !== listedFor) throw new SignedOutError();
      await service.forSignIn(session).postAdmission(serverId, label.slice(0, 48), key, deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0));
    },
  };
}

/** one listing of one account on this PC: the PCs asked so far, and those this PC cannot use */
type Round = { asked: Set<string>; invalid: Set<string>; failed: Set<string>; scope: string | null };

/** an Add under way: `waiting` once that PC took the request and waits for a member's approval on another device */
export type Pairing = { server_id: string; waiting: boolean; abort: AbortController };

/** The account's other PCs as the sidebar uses them: which would pair, and Add, which pairs one once a member approves it. */
export interface AccountPcs {
  /** the account's PCs but this one; null until read, when not signed in, or when this PC will not check them */
  pcs: readonly AccountPcRow[] | null;
  /** the PC of this app's roster an account PC already is */
  added(serverId: string): Machine | undefined;
  /** what the PC answered when asked whether it would pair; undefined while it is asked */
  stateOf(serverId: string): AccountPcState | undefined;
  pairing: Pairing | null;
  /** `code`: the server's refusal (ApiError.code), absent for one this page decided; `signIn`: nothing was asked, as this page was not signed in to the account */
  failure: AccountPcFailure | null;
  add(pc: AccountPcEntry): Promise<void>;
}

type AccountPcFailure = { server_id: string; message: string; code?: string; signIn?: true };

/** What a row says of an add that failed, in the page's language: the PC's server says it in English only. */
function failureWords(error: unknown, t: ReturnType<typeof useT>): string {
  switch (error instanceof ApiError ? error.code : null) {
    case "account_pc_refused": return t("That PC did not take the request. Only a device of your account that is paired with that PC can let another PC in there.");
    case "account_pc_declined": case "account_pc_unanswered": return t("Not approved");
    case "account_pc_outdated": return t("Update Ovis on that PC");
    case "account_pc_offline": return t("Can't reach the PC");
    default: return t("That PC could not be added. Try again.");
  }
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
    // the account's list moved (a PC came in, one went, or this page read its copy at last): the rows are read again,
    // so one that was drawn before the list said otherwise does not stay
    const unfollow = pageAccountList()?.subscribe(changed);
    return () => { window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed); unfollow?.(); };
  }, []);
  const [states, setStates] = useState<ReadonlyMap<string, AccountPcState>>(new Map());
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failure, setFailure] = useState<AccountPcFailure | null>(null);
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
    // with `expect` (the sidebar), nothing is listed until it knows which PC it is on, so it never lists itself
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
        // a refresh is the one new look a PC that did not answer gets
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
  // the newest ask of each PC: an older one answering late changes nothing
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
      // a newer ask of this PC (a later look) has the say: an older one failing changes nothing
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
      // anything else kept that PC's answer away (nothing says it is off): its row says so, and the others stay. It is
      // asked again on the next refresh, never because the roster changed
      round.failed.add(pc.server_id);
      setStates((current) => new Map(current).set(pc.server_id, "unreachable"));
    });
  };
  useEffect(() => {
    if (pcs === null) return;
    const round = listed.current;
    // (a PC with no way to it is asked nothing: there is no key or relay to ask it by)
    for (const pc of pcs) if (pc.unreachable !== true && added(pc.server_id) === undefined && !round.asked.has(pc.server_id)) check(pc, round);
  }, [pcs, machines]);
  useEffect(() => () => { listed.current = { asked: new Set(), invalid: new Set(), failed: new Set(), scope: null }; }, []);
  useEffect(() => () => running.current?.abort(), []);
  /** this page is still signed in to the account the list was read for */
  const stillOurs = async (): Promise<boolean> => expect === undefined || await account.current!.account() === expect;

  const add = async (pc: AccountPcEntry): Promise<void> => {
    const abort = new AbortController();
    running.current = abort;
    setFailure(null);
    setPairing({ server_id: pc.server_id, waiting: false, abort });
    try {
      // signed out, or into another account, since the list was read: nothing is asked of that PC
      if (!await stillOurs()) {
        if (!abort.signal.aborted) { setPairing(null); setFailure({ server_id: pc.server_id, message: t("Sign in again"), signIn: true }); }
        return;
      }
      abort.signal.throwIfAborted();
      const { ticket, key, label } = await startAccountPc(pc);
      abort.signal.throwIfAborted();
      await account.current!.admit(pc.server_id, label, key);
      const machine = await pairAccountPc(ticket, () => setPairing((current) => current?.abort === abort ? { ...current, waiting: true } : current), abort.signal);
      if (running.current === abort) running.current = null;
      setPairing(null);
      onAdded(machine);
    } catch (error) {
      if (running.current === abort) running.current = null;
      if (abort.signal.aborted) return;
      setPairing(null);
      // another window's sidebar is adding that PC now: nothing failed here, and the
      // roster shows it added once that one ends
      if (error instanceof ApiError && error.code === "account_pc_busy") return;
      if (error instanceof ApiError && error.code === "account_pc_outdated") setStates((current) => new Map(current).set(pc.server_id, "outdated"));
      // the page's sign-in went (or is another account's) on the way: the row asks to sign in again, and is tried once it is
      if (error instanceof SignedOutError) { setFailure({ server_id: pc.server_id, message: t("Sign in again"), signIn: true }); return; }
      setFailure({ server_id: pc.server_id, message: failureWords(error, t), ...(error instanceof ApiError && error.code !== null ? { code: error.code } : {}) });
    }
  };
  return { pcs, added, stateOf: (serverId) => pcs?.find((pc) => pc.server_id === serverId)?.unreachable === true ? "offline" : states.get(serverId), pairing, failure, add };
}
