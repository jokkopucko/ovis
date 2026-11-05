import { describe, expect, it } from "bun:test";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { MachineEvent } from "../../shared/machines.ts";
import type { EventStreamHandlers } from "./eventStream.ts";
import { keepMachineEvents, type MachineEventSocket } from "./machineEventStream.ts";

class Socket implements MachineEventSocket {
  machineEventsAvailable: boolean | null = null;
  outputStopped = false;
  messages = new Set<(message: ServerMessage) => void>();
  disconnects = new Set<() => void>();
  requests: boolean[] = [];
  connections = 0;
  on(handler: (message: ServerMessage) => void) { this.messages.add(handler); return () => { this.messages.delete(handler); }; }
  onDisconnect(handler: () => void) { this.disconnects.add(handler); return () => { this.disconnects.delete(handler); }; }
  connect() { this.connections++; }
  setMachineEvents(enabled: boolean) { this.requests.push(enabled); }
  offer(enabled: boolean) {
    this.machineEventsAvailable = enabled;
    this.tell({ type: "features", features: enabled ? ["machine-events"] : [], connection: "c" });
  }
  tell(message: ServerMessage) { for (const handler of this.messages) handler(message); }
  lose() { this.machineEventsAvailable = null; for (const handler of this.disconnects) handler(); }
  /** a 4008 close, as HerdrSocket tells it: the connection ends, then output stops until an attach */
  stall() {
    this.lose();
    this.outputStopped = true;
    this.tell({ type: "error", code: "output_stalled", message: "Terminal output stopped because this device could not keep up." });
  }
  attachAgain(enabled = true) { this.outputStopped = false; this.offer(enabled); }
}
function scenario(socket = new Socket()) {
  const heard: string[] = [];
  const events: MachineEvent[] = [];
  let fallback: EventStreamHandlers | undefined;
  let fallbackOpens = 0, fallbackStops = 0;
  // the settle deadline runs only when the test says it has passed
  const waiting = new Set<() => void>();
  const stop = keepMachineEvents(socket, {
    opened: () => { heard.push("open"); }, lost: () => { heard.push("lost"); }, closed: () => { heard.push("closed"); },
    message: (event) => { events.push(event); },
  }, (handlers) => { fallback = handlers; fallbackOpens++; return () => { fallbackStops++; }; },
  (run) => { waiting.add(run); return () => { waiting.delete(run); }; });
  const settleDeadline = () => { for (const run of [...waiting]) { waiting.delete(run); run(); } };
  return { socket, heard, events, stop, settleDeadline, waiting, fallback: () => fallback, counts: () => [fallbackOpens, fallbackStops] };
}
const event: MachineEvent = { type: "seen", finishes: [] };
describe("machine notifications over the existing terminal socket", () => {
  it("opens no SSE for twenty browser connections and accepts initial and live events", () => {
    const tabs = Array.from({ length: 20 }, () => scenario());
    for (const tab of tabs) {
      expect(tab.counts()).toEqual([0, 0]);
      tab.socket.offer(true);
      tab.socket.offer(true);
      tab.socket.tell({ type: "machine-event", event });
      expect(tab.socket.requests).toEqual([true]);
      expect(tab.events).toEqual([event]);
      expect(tab.counts()).toEqual([0, 0]);
      tab.stop();
      expect(tab.socket.requests).toEqual([true, false]);
      expect(tab.socket.messages.size + tab.socket.disconnects.size).toBe(0);
    }
  });
  it("resubscribes once after reconnect without acquiring an HTTP event connection", () => {
    const tab = scenario(); tab.socket.offer(true); tab.socket.lose(); tab.socket.offer(true);
    expect(tab.heard).toEqual(["open", "lost", "open"]);
    expect(tab.socket.requests).toEqual([true, true]);
    expect(tab.counts()).toEqual([0, 0]); tab.stop();
  });
  it("uses SSE on an older or rolled-back server and switches back after an upgrade", () => {
    const tab = scenario(); tab.socket.offer(false);
    tab.fallback()!.opened();
    tab.fallback()!.message(new MessageEvent("message", { data: JSON.stringify(event) }));
    tab.fallback()!.message(new MessageEvent("message", { data: "bad json" }));
    expect(tab.events).toEqual([event]);
    expect(tab.counts()).toEqual([1, 0]);
    tab.socket.lose(); tab.socket.offer(true);
    expect(tab.counts()).toEqual([1, 1]);
    tab.socket.lose(); tab.socket.offer(false);
    expect(tab.counts()).toEqual([2, 1]); tab.stop(); expect(tab.counts()).toEqual([2, 2]);
  });
  it("subscribes when mounted after capabilities arrived and ignores late messages after unmount", () => {
    const socket = new Socket(); socket.offer(true);
    const tab = scenario(socket); expect(socket.requests).toEqual([true]);
    tab.stop(); tab.stop(); socket.tell({ type: "machine-event", event }); socket.offer(true);
    expect(tab.events).toEqual([]); expect(socket.requests).toEqual([true, false]);
  });
  it("keeps machine events coming over SSE after the socket stops output (4008), and returns to the socket once an attach reconnects it", () => {
    const tab = scenario(); tab.socket.offer(true);
    tab.socket.stall();
    expect(tab.heard).toEqual(["open", "lost"]);
    expect(tab.counts()).toEqual([1, 0]);
    expect(tab.waiting.size).toBe(0);
    tab.fallback()!.message(new MessageEvent("message", { data: JSON.stringify(event) }));
    expect(tab.events).toEqual([event]);
    tab.socket.attachAgain();
    expect(tab.counts()).toEqual([1, 1]);
    expect(tab.socket.requests).toEqual([true, true]);
    expect(tab.heard).toEqual(["open", "lost", "open"]);
    tab.stop();
  });
  it("opens SSE when mounted on a socket already stopped for output", () => {
    const socket = new Socket(); socket.stall();
    const tab = scenario(socket);
    expect(tab.counts()).toEqual([1, 0]);
    tab.stop(); expect(tab.counts()).toEqual([1, 1]);
  });
  it("takes SSE for the rest of a connection whose server ended the subscription, and the socket again on the next one", () => {
    const tab = scenario(); tab.socket.offer(true);
    tab.socket.tell({ type: "machine-events-ended" });
    expect(tab.heard).toEqual(["open", "lost"]);
    expect(tab.counts()).toEqual([1, 0]);
    // a frame the ended subscription left behind, or a later snapshot on the same connection, changes nothing
    tab.socket.tell({ type: "machine-event", event });
    tab.socket.tell({ type: "features", features: ["machine-events"], connection: "c" });
    expect(tab.events).toEqual([]);
    expect(tab.socket.requests).toEqual([true]);
    expect(tab.counts()).toEqual([1, 0]);
    tab.socket.lose(); tab.socket.offer(true);
    expect(tab.counts()).toEqual([1, 1]);
    expect(tab.socket.requests).toEqual([true, true]);
    tab.stop();
  });
  it("falls back to SSE when the socket never says whether it carries machine events, and leaves it once one does", () => {
    const tab = scenario();
    expect(tab.waiting.size).toBe(1);
    expect(tab.counts()).toEqual([0, 0]);
    tab.settleDeadline();
    expect(tab.counts()).toEqual([1, 0]);
    tab.socket.offer(true);
    expect(tab.counts()).toEqual([1, 1]);
    expect(tab.socket.requests).toEqual([true]);
    // an ordinary reconnect that answers in time never opens SSE
    tab.socket.lose(); expect(tab.waiting.size).toBe(1);
    tab.socket.offer(true); expect(tab.waiting.size).toBe(0);
    expect(tab.counts()).toEqual([1, 1]);
    tab.stop(); expect(tab.waiting.size).toBe(0);
  });
});
