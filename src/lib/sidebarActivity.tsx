/** Shared raw Activity order and acknowledgement of server-identified finishes, shared by the browsers of this server. */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import type { SeenFinish, SeenPresentation } from "../../shared/seen.ts";
import { liveSeqs, newSeqMemory, shownStatus, type SeenRecord, type SeqMemory } from "./sidebarOrder.ts";
import { cleanSeen, loadSeen, saveSeen, seenKey, SEEN_LIMIT, subscribeSeen } from "./seenFinishes.ts";
import { conversationFinishEvidence } from "./panePresentation.ts";
import { fetchBridgeHealth } from "./api.ts";

export interface SidebarActivity {
  seqs(machineId: string): ReadonlyMap<string, number>;
  status(machineId: string, pane: Pick<HerdrPane, "pane_id" | "agent_status" | "background_wait" | "finish_id">): AgentStatus | undefined;
}
const NO_SEQS: ReadonlyMap<string, number> = new Map();
const SidebarActivityContext = createContext<SidebarActivity>({ seqs: () => NO_SEQS, status: (_machineId, pane) => shownStatus(pane, null) });
export const SidebarActivityProvider = SidebarActivityContext.Provider;
export const useSidebarActivity = (): SidebarActivity => useContext(SidebarActivityContext);

interface MachineSeen { epoch: string; record: SeenRecord }
interface SharedFinish extends SeenFinish {
  /** how the next send tells it: `held` once put off or retried, a look made earlier (shared/seen.ts SeenPresentation) */
  presented: SeenPresentation;
  /** how the server was told it, once it answered; an answer upgrade keeps a `new` told of the share it replaced */
  told?: SeenPresentation;
  retry?: () => Promise<boolean>;
  /** how a send still waiting for its answer tells it */
  sending?: SeenPresentation;
}
interface ShareRecovery {
  timer: ReturnType<typeof setTimeout> | undefined;
  unauthorized: boolean;
  running: boolean;
  wait: number;
}
/** whether the pane is in front of a person: `covered` by an overlay (closing it is a new look), or in view with its content still `loading` */
export type PanePresence = "front" | "loading" | "covered";
const unobscured = (): PanePresence => "front";

function sameSeen(left: ReadonlyMap<string, MachineSeen>, right: ReadonlyMap<string, MachineSeen>): boolean {
  if (left.size !== right.size) return false;
  for (const [machine, value] of right) {
    const before = left.get(machine);
    if (!before || before.epoch !== value.epoch || before.record !== value.record) return false;
  }
  return true;
}

export function useSidebarActivityState(machines: readonly Machine[], selectedMachineId: string, presentedPaneId: string | null, panePresence: () => PanePresence = unobscured,
  share?: (finish: SeenFinish, presented: SeenPresentation) => Promise<void>): SidebarActivity {
  const memories = useRef(new Map<string, { epoch: string | undefined; memory: SeqMemory }>());
  const seqsByMachine = useMemo(() => new Map(machines.map((machine) => {
    const epoch = machine.snapshot?.finish_epoch;
    let kept = memories.current.get(machine.id);
    if (!kept || kept.epoch !== epoch) {
      kept = { epoch, memory: newSeqMemory() };
      memories.current.set(machine.id, kept);
    }
    return [machine.id, liveSeqs(machine.snapshot, kept.memory)] as const;
  })), [machines]);
  const [seen, setSeen] = useState<ReadonlyMap<string, MachineSeen>>(() => new Map());
  const seenRef = useRef(seen); seenRef.current = seen;
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  const epochs = useRef(new Map<string, string>());
  // One latest acknowledgement per pane; bounded independently of how many finishes arrive.
  const shared = useRef(new Map<string, SharedFinish>());
  const recovery = useRef<ShareRecovery>({ timer: undefined, unauthorized: false, running: false, wait: 1_000 });
  const shareRef = useRef(share); shareRef.current = share;
  // the pane selected, uncovered, on a visible page at the last look ([pc, epoch, pane]), and the one
  // brought into view since that has not been presented yet: a finish that arrives while its pane stays
  // so is `held`, even across a reconnect or content still loading; closing an overlay brings it into
  // view again (shared/seen.ts SeenPresentation)
  const front = useRef<string | null>(null);
  const arriving = useRef<string | null>(null);
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    const stopReceiving = subscribeSeen((changes) => {
      setSeen((current) => {
        let next: Map<string, MachineSeen> | undefined;
        const checked = new Set<string>();
        for (const { pc, epoch } of changes) {
          const scope = JSON.stringify([pc, epoch]);
          if (checked.has(scope)) continue;
          checked.add(scope);
          const before = (next ?? current).get(pc);
          // An epoch retired since this state was set is replaced by the effect; reading it here
          // would only cache its scope again.
          if (!before || before.epoch !== epoch || epochs.current.get(pc) !== epoch) continue;
          const record = loadSeen(pc, epoch);
          if (before.record === record) continue;
          next ??= new Map(current);
          next.set(pc, { epoch, record });
        }
        return next ?? current;
      });
    });
    return () => {
      stopReceiving();
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(recovery.current.timer);
      recovery.current = { timer: undefined, unauthorized: false, running: false, wait: 1_000 };
      shared.current.clear();
    };
  }, []);
  useEffect(() => {
    const gate = recovery.current;
    const schedule = () => {
      if (recovery.current !== gate) return;
      if (![...shared.current.values()].some((finish) => finish.retry)) {
        clearTimeout(gate.timer);
        gate.timer = undefined;
        return;
      }
      if (gate.timer !== undefined || gate.running) return;
      gate.timer = setTimeout(() => { gate.timer = undefined; void recover(); }, gate.wait);
    };
    const recover = async () => {
      gate.running = true;
      try {
        // All finishes pause behind one authentication observation, not one poll per pane.
        if (gate.unauthorized) {
          const health = await fetchBridgeHealth();
          if (recovery.current !== gate) return;
          if (!health.auth.authenticated) { gate.wait = Math.min(gate.wait * 2, 30_000); return; }
          gate.unauthorized = false;
        }
        // Probe an outage with one queued finish. A failure ends this window; success drains
        // the remaining finishes serially, so neither retry volume nor concurrency fans out.
        for (const finish of shared.current.values()) {
          const resend = finish.retry;
          if (!resend) continue;
          delete finish.retry;
          const completed = await resend();
          if (recovery.current !== gate) return;
          if (!completed) { gate.wait = Math.min(gate.wait * 2, 30_000); return; }
          gate.wait = 1_000;
        }
      } catch (error) {
        gate.wait = Math.min(gate.wait * 2, 30_000);
        console.warn("Could not tell the other browsers about a read finish", error);
      } finally {
        gate.running = false;
        schedule();
      }
    };
    let nextFront: string | null = null;
    for (const machine of machines) {
      const epoch = machine.snapshot?.finish_epoch;
      if (!epoch) continue;
      const previousEpoch = epochs.current.get(machine.id);
      // Before cleanSeen: its notification can run the subscriber's state update right away.
      epochs.current.set(machine.id, epoch);
      if (previousEpoch && previousEpoch !== epoch) {
        cleanSeen([{ pc: machine.id, epoch: previousEpoch }]);
        for (const [key, finish] of shared.current) {
          if (finish.pc === machine.id && finish.epoch === previousEpoch) {
            shared.current.delete(key);
          }
        }
      }
      const view = machine.id === selectedMachineId && pageVisible && presentedPaneId !== null ? panePresence() : "covered";
      const inView = view !== "covered";
      const pane = view === "front" && machine.state === "connected"
        ? machine.snapshot?.panes.find((pane) => pane.pane_id === presentedPaneId) : undefined;
      const frontKey = inView ? JSON.stringify([machine.id, epoch, presentedPaneId]) : null;
      if (frontKey !== null) {
        nextFront = frontKey;
        if (front.current !== frontKey) arriving.current = frontKey;
      }
      const presented: SeenPresentation = frontKey !== null && arriving.current === frontKey ? "new" : "held";
      if (pane && arriving.current === frontKey) arriving.current = null;
      if (pane?.agent_status === "done" && !pane.background_wait && pane.finish_id !== undefined && pane.finish_id > 0) {
        const answer = conversationFinishEvidence.answer(seenKey(machine.id, epoch, pane.pane_id), pane.finish_id);
        saveSeen(machine.id, epoch, pane.pane_id, pane.finish_id, answer);
        const finish: SeenFinish = { pc: machine.id, epoch, pane: pane.pane_id, id: pane.finish_id, ...(answer === undefined ? {} : { answer }) };
        const key = JSON.stringify([finish.pc, finish.epoch, finish.pane]);
        const previous = shared.current.get(key);
        const answerUpgrade = previous?.id === finish.id && previous.answer === undefined && answer !== undefined;
        // a finish told (or being told) as `held`, its pane now brought into view: someone looked again
        const shownAgain = previous?.id === finish.id && presented === "new"
          && previous.told !== "new" && (previous.told === "held" || previous.sending === "held");
        if (!previous || finish.id > previous.id || answerUpgrade || shownAgain) {
          const sender = shareRef.current;
          if (sender) {
            // an answer upgrade of the same finish keeps a look told of it (one still in flight, once it answers)
            const sent: SharedFinish = { ...finish, presented, ...(answerUpgrade && previous.told === "new" ? { told: "new" as const } : {}) };
            shared.current.delete(key);
            shared.current.set(key, sent);
            while (shared.current.size > SEEN_LIMIT) {
              const oldest = shared.current.keys().next().value!;
              shared.current.delete(oldest);
            }
            // a send put off or retried tells a look made earlier: as `held`, so it cannot overrule an
            // unread told since
            const send = async () => {
              if (shared.current.get(key) !== sent || recovery.current !== gate) return true;
              if (gate.unauthorized) { sent.presented = "held"; sent.retry = send; return false; }
              try {
                const how = sent.presented;
                sent.presented = "held";
                sent.sending = how;
                try { await sender(finish, how); } finally { delete sent.sending; }
                if (sent.told !== "new") sent.told = how;
                // an answer upgrade made while this look was in flight
                const current = shared.current.get(key);
                if (how === "new" && current !== sent && current?.id === sent.id) current.told = "new";
              } catch (error) {
                if (shared.current.get(key) !== sent || recovery.current !== gate) return true;
                const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : undefined;
                if (status === 401) gate.unauthorized = true;
                const transient = status === undefined || status === 401 || status >= 502;
                if (transient) { sent.retry = send; schedule(); }
                console.warn("Could not tell the other browsers about a read finish", error);
                return !transient;
              }
              return true;
            };
            if (gate.unauthorized || gate.running || gate.timer !== undefined) { sent.presented = "held"; sent.retry = send; }
            else void send();
          }
        } else if (finish.id === previous.id) {
          // Keep frequently observed panes in the bounded latest-state window.
          shared.current.delete(key);
          shared.current.set(key, previous);
        }
      }
    }
    front.current = nextFront;
    schedule();
    // Read after every acknowledgement and epoch retirement: a later machine can evict an
    // earlier machine's oldest entry while enforcing the shared cap.
    const next = new Map<string, MachineSeen>();
    for (const machine of machines) {
      const epoch = machine.snapshot?.finish_epoch;
      if (epoch) next.set(machine.id, { epoch, record: loadSeen(machine.id, epoch) });
    }
    if (!sameSeen(seenRef.current, next)) setSeen(next);
  }, [machines, selectedMachineId, presentedPaneId, panePresence, pageVisible]);

  return useMemo<SidebarActivity>(() => ({
    seqs: (machineId) => seqsByMachine.get(machineId) ?? NO_SEQS,
    status: (machineId, pane) => {
      const epoch = machines.find((machine) => machine.id === machineId)?.snapshot?.finish_epoch;
      const kept = seen.get(machineId);
      return shownStatus(pane, epoch && kept?.epoch === epoch ? kept.record : null);
    },
  }), [machines, seqsByMachine, seen]);
}
