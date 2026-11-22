/**
 * T51, T53, T60, T65: answer an admission with "It's me" to the admission's PC, or "Not me" with the current
 * sign-in's key, and show only PC-authenticated receipts.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { DeviceNotice, PcBlockOutcome } from "../../shared/account-devices-api.ts";
import { LOCAL_MACHINE, machinePath, type Machine } from "../../shared/machines.ts";
import { canBlockAdmission, notMeBlocks, sendBlocks, type FleetBlock, type OwnKey } from "../lib/account/fleet-block.ts";
import { answerOnPc, notMeTransports } from "../lib/account/noticeAnswer.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountServiceError, AccountServiceUnreachableError, indexedAccountService, sameSignIn, SignedOutError } from "../lib/account/service.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { keepUnsent, postKept, refusalShown, unsentBlocks } from "../lib/account/unsentBlocks.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { useT } from "../lib/i18n.ts";
import type { MachineSessionRegistry } from "../lib/machineSession.ts";
import { itsMeAnswer } from "../lib/relay/joinHold.ts";
import { useDeviceNotices, type NoticeSocket } from "../lib/useDeviceNotices.ts";
import { BlockOutcomes, NotMeButton } from "./BlockOutcomes.tsx";
import { DeviceNotices } from "./DevicePairedNotice.tsx";
import { ItsMeButton } from "./JoinWait.tsx";

const ANSWER_TIMEOUT_MS = 5000;

/** The signed-in account, with this sign-in's registered key when it has one (Not me signs with it; It's me needs none). */
async function noticeIdentity(session: AccountSession | undefined): Promise<{ readonly account: string; readonly session: AccountSession; readonly key: OwnKey | null } | null> {
  if (session === undefined) return null;
  const kept = await indexedAccountStore.get("signin_key");
  const key = kept !== undefined && kept.no !== null && session.account === kept.account && session.sign_in_id === kept.sign_in_id
    ? { ...kept.key, no: kept.no } : null;
  return { account: session.account, session, key };
}

type Own = Awaited<ReturnType<typeof noticeIdentity>>;

const noticeKey = (pcId: string, noticeId: string): string => JSON.stringify([pcId, noticeId]);

/** Retries and refusals require the same sign-in, using a refresh token only for legacy sessions without an ID. */
function sameAnswerSignIn(a: AccountSession, b: AccountSession): boolean {
  if (a.account !== b.account) return false;
  if (a.sign_in_id !== undefined || b.sign_in_id !== undefined) return !!a.sign_in_id && a.sign_in_id === b.sign_in_id;
  return !!a.refresh_token && a.refresh_token === b.refresh_token;
}

/** One app-wide answer per PC and notice. Each It's me press owns its lock by token. */
type AnswerLocks = Map<string, symbol | "not_me">;

/**
 * "It's me" (owner decision OD3, T53): sent only to the admission's own PC, whose notice id it names. That PC ends the
 * new device's hold at once only when its own checks pass for this device's session; the answer counts once that PC
 * publishes the confirmation, and one lost answer is sent again.
 */
function ItsMeAction({ notice, pc, socket, own, inFlight, refusedItsMe, changed }: {
  readonly notice: DeviceNotice;
  readonly pc: Machine;
  readonly socket: NoticeSocket;
  readonly own: Own;
  readonly inFlight: AnswerLocks;
  /** a refused It's me by PC and notice, with the sign-in that asked: another sign-in never sees it */
  readonly refusedItsMe: Map<string, AccountSession>;
  readonly changed: () => void;
}) {
  const id = noticeKey(pc.id, notice.id);
  const canAnswer = own !== null && notice.account === own.account && notice.kind === "admit" && notice.open && socket.accountOpensAll();

  const confirm = async () => {
    if (!canAnswer || inFlight.has(id)) return;
    const press = Symbol(id);
    inFlight.set(id, press);
    refusedItsMe.delete(id);
    changed();
    try {
      const started = await indexedAccountStore.get("session");
      if (started === undefined || started.account !== notice.account) return;
      // The notice ID is PC-local. Never send it to another PC or via the block records route.
      let unanswered = 0;
      for (let tries = 0; tries < 2; tries++) {
        const current = await indexedAccountStore.get("session");
        if (inFlight.get(id) !== press) return;
        if (current === undefined || current.account !== notice.account || !socket.accountOpensAll()) break;
        const sameIdentity = tries === 0 ? sameSignIn : sameAnswerSignIn;
        if (!sameIdentity(started, current)) break;
        const [outcome] = await Promise.allSettled([answerOnPc(socket, { notice, answer: itsMeAnswer(notice) }, ANSWER_TIMEOUT_MS)]);
        if (outcome.status === "fulfilled") break;
        unanswered++;
      }
      // The PC answers a refused It's me with nothing (too new, held or not caught up): say so rather than go quiet,
      // to the sign-in that asked, and only while it is still the one here
      const now = await indexedAccountStore.get("session");
      if (unanswered === 2 && now !== undefined && sameAnswerSignIn(started, now) && inFlight.get(id) === press) refusedItsMe.set(id, started);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Ovis: could not read the sign-in for an admission answer", error.name);
    } finally {
      if (inFlight.get(id) === press) {
        inFlight.delete(id);
        changed();
      }
    }
  };

  const refused = refusedItsMe.get(id);
  return canAnswer ? <ItsMeButton sending={inFlight.has(id)} onPress={confirm} refusedBy={refused !== undefined && sameAnswerSignIn(refused, own.session) ? pc.name : null} /> : null;
}

type NoticeFleet = {
  readonly machines: readonly Machine[];
  readonly machineSessions: MachineSessionRegistry;
  readonly pageServerId: string | undefined;
};

type BlockResult = {
  readonly pc: string;
  readonly notice: DeviceNotice;
  readonly signer: string;
  readonly fleet: FleetBlock;
  readonly names: ReadonlyMap<string, string>;
  /** set once the account service refused the block for good, on the press or a later Try again (S32-1) */
  readonly delivery: { refused: boolean };
};

function BlockNoticeAction({ notice, pc, socket, fleet, own, inFlight, changed, onResult }: {
  readonly notice: DeviceNotice;
  readonly pc: Machine;
  readonly socket: NoticeSocket;
  readonly fleet: NoticeFleet;
  readonly own: Own;
  readonly inFlight: AnswerLocks;
  readonly changed: () => void;
  readonly onResult: (result: BlockResult) => void;
}) {
  const t = useT();
  const id = noticeKey(pc.id, notice.id);
  // the block could not be stored first, so nothing was sent (S32-1: never send unstored)
  const [unstored, setUnstored] = useState(false);
  const canAnswer = own !== null && own.key !== null && notice.account === own.account && canBlockAdmission(notice, own.key) && socket.accountOpensAll();

  const press = async () => {
    if (!canAnswer || inFlight.has(id)) return;
    inFlight.set(id, "not_me");
    changed();
    try {
      const session = await indexedAccountService.session();
      if (session === undefined) return;
      const current = await noticeIdentity(session);
      if (current === null || current.key === null || current.account !== notice.account || !socket.accountOpensAll()) return;
      const blocks = await notMeBlocks(notice, current.key);
      if (blocks.length === 0) return;
      // kept before any PC or the service gets one, so a closed tab loses none (S32-1)
      setUnstored(false);
      let kept: boolean;
      try { kept = await keepUnsent(indexedAccountStore, session, blocks); }
      catch (error) {
        console.warn("Ovis: the block could not be stored, so it was not sent", error instanceof Error ? error.name : error);
        setUnstored(true);
        return;
      }
      if (!kept) return;
      const delivery = { refused: false };

      const serverIdOf = (machine: Machine) =>
        (machine.id === LOCAL_MACHINE ? fleet.pageServerId : undefined) ?? machine.server_id ?? machine.relay?.server_id;
      const pagePc = fleet.machines.find((machine) => machine.id === LOCAL_MACHINE);
      const pageId = pagePc === undefined ? undefined : serverIdOf(pagePc);
      const ownServerId = serverIdOf(pc);
      const ownId = ownServerId ?? pc.id;
      const rows = new Map([[ownId, pc]]);
      for (const machine of fleet.machines) {
        if (!fleet.machineSessions.peek(machine.id)?.socket.accountOpensAll()) continue;
        const serverId = serverIdOf(machine);
        const key = serverId ?? machine.id;
        if (!rows.has(key)) rows.set(key, machine);
      }
      const post = (id: string) => (path: string, body: unknown) => {
          const machine = rows.get(id);
          if (machine === undefined || !fleet.machineSessions.peek(machine.id)?.socket.accountOpensAll()) {
            return Promise.reject(new RangeError("PC does not offer account block delivery"));
          }
          return apiFetch(machinePath(machine.id, path.slice("/api/".length)), {
            method: "POST",
            headers: { "content-type": "application/json", "x-herdr-machine": "1" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
          });
      };
      const routes = notMeTransports(notice, ownId, [...rows.keys()], {
        socket: () => socket,
        post,
        // The page's carrier can authenticate its own records reply, not a roster PC's.
        channel: (id) => id === pageId && rows.get(id)?.id === LOCAL_MACHINE ? post(id) : undefined,
        timeoutMs: ANSWER_TIMEOUT_MS,
      });
      // The app's one carrier (native or relay) is to the page's PC. Other roster sockets are proxied.
      if (pc.id !== LOCAL_MACHINE || ownServerId === undefined) {
        const answer = routes.pcs.get(ownId);
        if (answer !== undefined) routes.relayed = new Map([[ownId, answer], ...routes.relayed]);
        routes.pcs.delete(ownId);
      }
      const service = indexedAccountService.forSignIn(session);
      // Every route to a skipped PC: one that is open and reports no capability decides its line, whatever the order.
      const skipped = new Map<string, Machine[]>();
      for (const machine of fleet.machines) {
        const serverId = serverIdOf(machine);
        if (serverId !== undefined && !rows.has(serverId)) skipped.set(serverId, [...skipped.get(serverId) ?? [], machine]);
      }
      // Directory lookup supplies display rows only; never put it in front of block delivery.
      const directory = service.listPcs(AbortSignal.timeout(ANSWER_TIMEOUT_MS)).catch((error: unknown) => {
        if (error instanceof AccountServiceError || error instanceof AccountServiceUnreachableError || error instanceof SignedOutError ||
            error instanceof SyntaxError || (error instanceof DOMException && error.name === "TimeoutError")) return [];
        throw error;
      });
      const [sent, roster] = await Promise.all([sendBlocks(blocks, {
        ...routes,
        service: async (records) => {
          // asked right before each send, a Try again's too and after any token refresh: once the PC says it no longer
          // offers the account release, nothing goes and the block stays (a PC gone offline says nothing: the service decides)
          const ready = () => {
            const remote = fleet.machineSessions.peek(pc.id)?.socket;
            // its last feature list's word, through a disconnect and a reconnect that has listed nothing yet
            if (remote?.accountReleaseWithdrawn() === true) throw new RangeError("PC does not offer account block delivery");
          };
          if (await postKept(indexedAccountStore, session, records, (record) => service.postSafetyRecord(record, ready)) === "refused") delivery.refused = true;
        },
      }), directory]);
      const outcomes = new Map<string, PcBlockOutcome>(sent.outcomes);
      const names = new Map([...rows].map(([id, machine]) => [id, machine.name]));
      // Every PC of the account gets a line, including one this browser has never listed; none of them gets a request.
      for (const { server_id, label } of roster) {
        if (rows.has(server_id) || outcomes.has(server_id)) continue;
        const routes = skipped.get(server_id) ?? [];
        const unsupported = routes.some((machine) => {
          const remote = fleet.machineSessions.peek(machine.id)?.socket;
          return remote?.connected && remote.featuresListed() && !remote.accountOpensAll();
        });
        outcomes.set(server_id, { server_id, state: unsupported ? "unsupported" : "unreachable" });
        names.set(server_id, routes[0]?.name ?? label);
      }
      onResult({ pc: pc.id, notice, signer: current.key.public_spki, fleet: { ...sent, outcomes }, names, delivery });
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Ovis: could not sign a device block", error.name);
    } finally {
      inFlight.delete(id);
      changed();
    }
  };

  if (!canAnswer) return null;
  return <>
    <NotMeButton sending={inFlight.has(id)} onPress={press} />
    {unstored && <p className="settings-hint" role="status">{t("The block was not sent. Try again.")}{" "}
      <button type="button" className="btn" disabled={inFlight.has(id)} onClick={() => { void press(); }}>{t("Try again")}</button></p>}
  </>;
}

/** A notice's two answers, one out at a time per PC and notice (T51, T53). */
function AdmissionActions({ refusedItsMe, ...props }: Parameters<typeof BlockNoticeAction>[0] & { readonly refusedItsMe: Map<string, AccountSession> }) {
  return <>
    <ItsMeAction notice={props.notice} pc={props.pc} socket={props.socket} own={props.own} inFlight={props.inFlight} refusedItsMe={refusedItsMe} changed={props.changed} />
    <BlockNoticeAction {...props} />
  </>;
}

/** Subscribe alongside the App's roster hooks so opening the pane does not miss a notice replay. */
export function useAccountDeviceNotices({ machines, machineSessions, selectedMachineId, pageServerId }: NoticeFleet & {
  readonly selectedMachineId: string;
}) {
  const sockets = machines.flatMap(({ id }) => {
    const socket = machineSessions.peek(id)?.socket;
    return socket === undefined ? [] : [{ id, socket }];
  });
  const sending = useRef<AnswerLocks>(new Map());
  const refusedItsMe = useRef(new Map<string, AccountSession>());
  const onClose = useCallback((pcId: string, noticeId: string) => {
    const key = noticeKey(pcId, noticeId);
    refusedItsMe.current.delete(key);
    // Not me may still be delivering the block to the account or other PCs.
    if (typeof sending.current.get(key) === "symbol") sending.current.delete(key);
  }, []);
  const feed = useDeviceNotices(sockets, selectedMachineId, onClose);
  const shown = feed.byPc.get(selectedMachineId);
  // A block can close its notice or the socket before the account replies. Keep the result at App scope.
  const [results, setResults] = useState<ReadonlyMap<string, BlockResult>>(new Map());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // The lock and refusal are app-wide per PC and notice, even when an answer finishes offscreen.
  const [, answersChanged] = useReducer((count: number) => count + 1, 0);
  const [own, setOwn] = useState<Own>(null);
  // S32-1: blocks an earlier page or sign-in signed that the account service never answered for, sent again once a PC
  // here offers the account release (with it off, the queue stays as it is), by their ids: a retry, or a final refusal
  // shown once. They belong to the stored sign-in: another one's page never shows them.
  const [unsent, setUnsent] = useState<ReadonlyMap<string, (() => Promise<void>) | null>>(new Map());
  // whether a PC here offers the account release now: replay, its lines and a Try again follow it as it changes
  const [capable, setCapable] = useState(false);
  // a sign-out ends what its replay was doing: an answer that comes after it settles nothing
  const signOuts = useRef(0);
  // the stored sign-in, `account\nsign_in_id` (null when none): read again after this page writes it, on a sign-out and on
  // focus (another tab's); a change restarts the replay for the sign-in now stored
  const [signIn, setSignIn] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let version = 0;
    const read = () => {
      const asked = ++version;
      void indexedAccountStore.get("session").then(
        (session) => { if (live && asked === version) setSignIn(session === undefined ? null : `${session.account}\n${session.sign_in_id ?? ""}`); },
        (error: unknown) => console.warn("Ovis: the sign-in could not be read", error instanceof Error ? error.name : error),
      );
    };
    read();
    for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.addEventListener(name, read);
    return () => {
      live = false;
      for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.removeEventListener(name, read);
    };
  }, []);
  // record ids a press on this page shows, by the sign-in that pressed: its own line and Try again carry them
  const pressed = useRef(new Map<string, string | null>());
  const socketIds = sockets.map(({ id }) => id).join("\n");
  useEffect(() => {
    setUnsent(new Map());
    if (signIn === null) return;
    let live = true;
    let started = false;
    const epoch = signOuts.current;
    const current = () => live && epoch === signOuts.current;
    // asked at each send, a Try again's too
    const offered = () => sockets.some(({ socket }) => socket.accountOpensAll());
    const settle = (id: string, delivered: Awaited<ReturnType<typeof postKept>>) => {
      if (current()) setUnsent((now) => { const next = new Map(now); if (delivered === "refused") next.set(id, null); else next.delete(id); return next; });
    };
    const resend = async () => {
      const session = await indexedAccountService.session();
      if (session === undefined || `${session.account}\n${session.sign_in_id ?? ""}` !== signIn) return;
      const service = indexedAccountService.forSignIn(session);
      for (const entry of await unsentBlocks(indexedAccountStore, session)) {
        const id = entry.records.map((record) => record.id).join(",");
        if (!current()) return;
        // refused for good while no page of this account showed it: shown now, once (then it leaves the store)
        if (entry.refused === true) { setUnsent((now) => new Map(now).set(id, null)); continue; }
        if (entry.records.every((record) => pressed.current.get(record.id) === signIn)) continue;
        const ready = () => { if (!offered()) throw new RangeError("No PC here offers account block delivery"); };
        const send = () => postKept(indexedAccountStore, session, entry.records, (record) => service.postSafetyRecord(record, ready));
        const retry = async () => {
          if (!current() || !offered()) return;
          try { settle(id, await send()); }
          catch (error) { console.warn("Ovis: the account service did not confirm the block", error instanceof Error ? error.name : error); }
        };
        // the release went while this ran: the rest goes when a PC offers it again
        if (!offered()) { started = false; return; }
        try { settle(id, await send()); }
        catch (error) {
          console.warn("Ovis: the account service did not confirm the block", error instanceof Error ? error.name : error);
          if (current()) setUnsent((now) => new Map(now).set(id, retry));
        }
      }
    };
    // as soon as a PC here says it offers the account release (its features or snapshot): replay once
    const look = () => {
      const now = offered();
      if (live) setCapable(now);
      if (started || !now) return;
      started = true;
      void resend().catch((error: unknown) => console.warn("Ovis: unsent blocks could not be read", error instanceof Error ? error.name : error));
    };
    const offs = sockets.map(({ socket }) => socket.on((message) => { if (message.type === "features" || message.type === "snapshot") look(); }));
    look();
    return () => { live = false; for (const off of offs) off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the PCs, by id: a new array each render names the same sockets
  }, [socketIds, signIn]);
  // a sign-out takes its blocks' lines and their Try again off this page; the queue stays for a later sign-in to that account
  useEffect(() => {
    const signedOut = () => {
      signOuts.current++;
      setUnsent(new Map());
      setResults((current) => new Map([...current].map(([id, result]) => {
        const { retryService: _gone, ...fleet } = result.fleet;
        return [id, { ...result, fleet }];
      })));
    };
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, signedOut);
    return () => window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, signedOut);
  }, []);
  const readKey = results.size > 0 || shown?.notices.some((notice) => notice.kind === "admit" && notice.open) === true;
  useEffect(() => {
    if (!readKey) return;
    let live = true;
    let readVersion = 0;
    const read = () => {
      const version = ++readVersion;
      void indexedAccountStore.get("session").then(noticeIdentity).then(
        (key) => { if (live && version === readVersion) setOwn(key); },
        () => { if (live && version === readVersion) setOwn(null); },
      );
    };
    read();
    for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.addEventListener(name, read);
    return () => {
      live = false;
      for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.removeEventListener(name, read);
    };
  }, [readKey, shown?.notices]);
  // a final refusal leaves the store only on its owner's OK, while that account is signed in; its line goes with it (S32-1)
  const seen = (account: string | undefined, ids: readonly string[], gone: () => void) => account === undefined ? undefined : () => {
    void refusalShown(indexedAccountStore, account, ids).then(gone,
      (error: unknown) => console.warn("Ovis: a shown refusal could not be cleared", error instanceof Error ? error.name : error));
  };

  const pc = machines.find((machine) => machine.id === selectedMachineId);
  const socket = sockets.find(({ id }) => id === selectedMachineId)?.socket;
  if (pc === undefined) return null;
  const notices = new Map(shown?.notices.map((notice) => [notice.id, notice]));
  const detachedRetries: [string, BlockResult][] = [];
  for (const [id, result] of results) {
    if (result.pc !== pc.id || result.signer !== own?.key?.public_spki) continue;
    if (hidden.has(id)) {
      if (result.fleet.retryService !== undefined || result.delivery.refused) detachedRetries.push([id, result]);
    } else if (!notices.has(result.notice.id)) notices.set(result.notice.id, result.notice);
  }
  for (const id of notices.keys()) {
    if (hidden.has(noticeKey(pc.id, id))) notices.delete(id);
  }
  const renderOutcomes = (id: string, result: BlockResult, dismissed = false) => {
    const { retryService, ...delivered } = result.fleet;
    return <BlockOutcomes outcomes={dismissed ? [] : [...result.fleet.outcomes.values()]} names={result.names} {...(retryService === undefined ? result.delivery.refused ? { accountFailed: true, onRefusalShown: seen(own?.account, result.fleet.ids, () => setResults((current) => {
      const latest = current.get(id);
      return latest === undefined ? current : new Map(current).set(id, { ...latest, delivery: { refused: false } });
    })) } : {} : {
      accountRetry: async () => {
        if (!await retryService()) return;
        setResults((current) => {
          const latest = current.get(id);
          return latest?.fleet.retryService !== retryService ? current : new Map(current).set(id, { ...latest, fleet: delivered });
        });
      },
    })} />;
  };
  if (notices.size === 0 && feed.cut === 0 && detachedRetries.length === 0 && (unsent.size === 0 || !capable)) return null;
  return <>
    <DeviceNotices key={pc.id} pc={pc.name} notices={[...notices.values()]} cut={feed.cut}
      onDismiss={(notice) => feed.dismiss(pc.id, notice)}
      onHide={(notice) => setHidden((current) => new Set([...current, noticeKey(pc.id, notice.id)]))}
      onShown={feed.acknowledgeShown}
      actions={(notice) => {
        const id = noticeKey(pc.id, notice.id);
        const result = results.get(id);
        if (result !== undefined && result.signer === own?.key?.public_spki) return renderOutcomes(id, result);
        return socket === undefined ? null : <AdmissionActions notice={notice} pc={pc} socket={socket} fleet={{ machines, machineSessions, pageServerId }} own={own}
          inFlight={sending.current} refusedItsMe={refusedItsMe.current} changed={answersChanged} onResult={(result) => {
            for (const record of result.fleet.ids) pressed.current.set(record, signIn);
            setResults((current) => new Map(current).set(id, result));
          }} />;
      }}
    />
    {detachedRetries.map(([id, result]) => <div key={id} role="status">{renderOutcomes(id, result, true)}</div>)}
    {capable && [...unsent].map(([id, retry]) => <div key={id} role="status"><BlockOutcomes outcomes={[]} names={new Map()} {...(retry === null ? { accountFailed: true, onRefusalShown: seen(signIn?.split("\n")[0], id.split(","), () => setUnsent((now) => { const next = new Map(now); next.delete(id); return next; })) } : { accountRetry: retry })} /></div>)}
  </>;
}
