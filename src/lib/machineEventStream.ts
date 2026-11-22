import type { Machine, MachineEvent } from "../../shared/machines.ts";
import { CompactAgentsError, expandMachine, expandMachineEvent, type WireMachineEvent } from "../../shared/compact-agents.ts";
import type { HerdrSocket } from "./ws.ts";
import { keepEventStream, type EventStreamHandlers } from "./eventStream.ts";

type MachineEventHandlers = Omit<EventStreamHandlers, "message"> & {
  message(event: MachineEvent, kept: ReadonlySet<string>): void;
  previous(machineId: string): Machine | undefined;
  unreadable(machineIds: readonly string[]): void;
};
export type MachineEventSocket = Pick<HerdrSocket, "on" | "onDisconnect" | "connect" | "machineEventsAvailable" | "outputStopped" | "setMachineEvents">;

export const MACHINE_EVENTS_SETTLE_MS = 5_000;

export function keepMachineEvents(socket: MachineEventSocket, handlers: MachineEventHandlers,
  fallback: (handlers: EventStreamHandlers) => () => void = (callbacks) => keepEventStream("/api/machines/events?compact_agents=1", callbacks),
  wait: (run: () => void, ms: number) => () => void = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); }): () => void {
  let subscribed = false;
  let stopped = false;
  let endedByServer = false;
  let stopFallback: (() => void) | undefined;
  let stopWaiting: (() => void) | undefined;
  const settled = () => { stopWaiting?.(); stopWaiting = undefined; };
  const deliver = (event: WireMachineEvent) => {
    const kept = new Set<string>();
    const read = <T>(machineId: string, expand: () => T, previous: () => T): T => {
      try { return expand(); } catch (error) {
        if (!(error instanceof CompactAgentsError)) throw error;
        kept.add(machineId);
        return previous();
      }
    };
    const payload = event.type === "machines"
      ? { ...event, machines: event.machines.map((machine) => read(machine.id, () => expandMachine(machine), () => ({ ...machine, snapshot: handlers.previous(machine.id)?.snapshot ?? null }))) }
      : read(event.type === "machine-message" ? event.machine_id : "", (): MachineEvent | null => expandMachineEvent(event), () => null);
    if (payload) handlers.message(payload, kept);
    if (kept.size > 0) handlers.unreadable([...kept]);
  };
  const openFallback = () => {
    settled();
    if (stopFallback) return;
    stopFallback = fallback({ ...handlers, message: (event) => {
      let wire: WireMachineEvent;
      try { wire = JSON.parse(event.data) as WireMachineEvent; } catch { return; }
      deliver(wire);
    } });
  };
  const choose = () => {
    if (stopped) return;
    const available = socket.machineEventsAvailable;
    if (available && !endedByServer) {
      settled();
      stopFallback?.(); stopFallback = undefined;
      if (subscribed) return;
      subscribed = true;
      handlers.opened();
      socket.setMachineEvents(true);
    } else if (available === false || endedByServer || socket.outputStopped) {
      openFallback();
    } else if (!stopFallback && !stopWaiting) {
      stopWaiting = wait(() => { stopWaiting = undefined; if (!stopped) openFallback(); }, MACHINE_EVENTS_SETTLE_MS);
    }
  };
  const lose = () => { if (subscribed) { subscribed = false; handlers.lost(); } };
  const offMessage = socket.on((message) => {
    if (stopped) return;
    if (message.type === "features" || message.type === "snapshot") choose();
    else if (message.type === "machine-event" && subscribed) deliver(message.event);
    else if (message.type === "machine-events-ended") { endedByServer = true; lose(); choose(); }
    else if (message.type === "error" && message.code === "output_stalled") choose();
  });
  const offDisconnect = socket.onDisconnect(() => {
    endedByServer = false;
    lose();
    choose();
  });
  choose();
  socket.connect();
  return () => {
    if (stopped) return;
    stopped = true;
    offMessage(); offDisconnect(); stopFallback?.(); settled();
    if (subscribed) socket.setMachineEvents(false);
  };
}
