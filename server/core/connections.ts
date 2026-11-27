import { subscribeMachineEvents, type MachineEventDocument } from "../machine-events.ts";
import { wireMachineEvent } from "../../shared/compact-agents.ts";
import type { ClientRole, ServerMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import type { DeviceStore } from "../devices.ts";
import { checkedHerdrSocket, HerdrError, herdrSocketPath, LARGE_REPLY_BYTES } from "../herdr/client.ts";
import type { MachineRelay } from "../machine-relay.ts";
import { crossingMs, OUTPUT_HARD_BYTES, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS, type OutputWindow } from "../output-window.ts";
import type { PendingInputs } from "../pending-input.ts";
import { PaneWatch, type PaneWatchOptions } from "../watch.ts";
import type { TelemetryIngress, TelemetrySurface } from "../../shared/telemetry.ts";
import type { Machine, MachineEvent } from "../../shared/machines.ts";

export interface SocketData {
  /** Only the connection server grants this document; remote terminal relays do not. */
  machineEvents?: MachineEventDocument;
  /** A listed drive row may receive this PC, never the multi-PC document or its pairing subscriptions. */
  localRoster?: (send: (machines: Machine[]) => void) => () => void;
  /** Beside that roster, on a PC pinned to its account's list: the joins that wait here, for a device of the list that may let one in (remotePairingEvents). */
  listJoins?: (send: (event: MachineEvent) => void) => () => void;
  deviceId?: string;
  provedKey?: string;
  readOnly?: boolean;
  /** let in by the open LAN alone, while nothing was paired (access.ts `via: "open"`): no device, token, sign-in or
   * bridge token stands behind it, so it ends when the pairing gate closes (admit) */
  open?: boolean;
  relay?: MachineRelay;
  bridge?: boolean;
  /** A managed machine's own bearer can correlate submissions; it grants no bridge-only API access. */
  managedReceipts?: boolean;
  commandBrowser?: string;
  surface?: TelemetrySurface;
  ingress?: TelemetryIngress;
  /** a visitor Portal signed in: the socket is closed after this many ms, and the page's reconnect meets Portal's sign-in again (server/portal.ts `recheckMs`) */
  recheckMs?: number;
  /** let in on a grant a lock refuses: it ends when the screen's approval writes a lock (server/lock-boundary.ts LockSignal) */
  untilLock?: (close: () => void) => () => void;
  connectionId: string;
  /** A fresh claim per attach lifetime; deleting it invalidates queued terminal keys. */
  attached: Map<string, { keepSize: boolean; receiptResumeId?: string; fitGrid?: { cols: number; rows: number; drives: boolean } }>;
  conversationInterests: Set<string>;
  conversationWatches: Set<string>;
  promptWatches: Set<string>;
  output: Map<string, OutputWindow>;
}

interface ConnectionState {
  closing: boolean;
  stopMachineEvents?: () => void;
  compactMachineAgents?: boolean;
  revoked: boolean;
  gated?: boolean;
  /** the connection's authority: observe connections cannot type or resize */
  mode: ClientRole;
  roles: number;
  watches: Map<string, PaneView>;
  waiting: Map<string, { cols: number; rows: number }>;
  unwatchDevice?: () => void;
  unwatchGate?: () => void;
  unwatchLock?: () => void;
  recheck?: ReturnType<typeof setTimeout>;
  excused?: { frames: ExcusedFrame[]; last: number };
}

interface ExcusedFrame { ahead: number; frame: number; timer: ReturnType<typeof setTimeout> }

/** Keyed by the very `data` object the upgrade passed, which Bun hands to every handler of the connection. */
const states = new WeakMap<SocketData, ConnectionState>();

function stateOf(client: Client): ConnectionState {
  const state = states.get(client.data);
  if (!state) throw new Error("connection state missing: the socket's data is not the object its upgrade passed");
  return state;
}

/** The data for a connection's upgrade: it starts to interact unless its access is read-only. */
export function connectionData(fields: { machineEvents?: MachineEventDocument; localRoster?: SocketData["localRoster"]; listJoins?: SocketData["listJoins"]; relay?: MachineRelay; deviceId: string | undefined; provedKey?: string; readOnly: boolean; open?: boolean; bridge?: boolean; managedReceipts?: boolean; commandBrowser?: string; surface?: TelemetrySurface; ingress?: TelemetryIngress; recheckMs?: number; untilLock?: (close: () => void) => () => void }): SocketData {
  const data: SocketData = { connectionId: crypto.randomUUID(), attached: new Map<string, { keepSize: boolean }>(), conversationInterests: new Set<string>(), conversationWatches: new Set<string>(), promptWatches: new Set<string>(), output: new Map(), ...fields };
  states.set(data, { closing: false, revoked: false, mode: fields.readOnly ? "observe" : "interact", roles: 0, watches: new Map<string, PaneView>(), waiting: new Map() });
  return data;
}

export function connectionOf(client: Client): Readonly<Pick<ConnectionState, "closing" | "mode" | "roles">> {
  return stateOf(client);
}

export function setMachineEvents(client: Client, enabled: boolean, compactAgents = false): void {
  const state = stateOf(client);
  if (!enabled) { state.stopMachineEvents?.(); state.stopMachineEvents = undefined; return; }
  if (state.closing || state.stopMachineEvents) return;
  const { machineEvents, localRoster, listJoins } = client.data;
  if (!machineEvents && !localRoster) return;
  state.compactMachineAgents = compactAgents;
  let stop: (() => void) | undefined;
  let overflowed = false;
  const end = () => {
    stop?.();
    if (state.stopMachineEvents === stop) state.stopMachineEvents = undefined;
    if (state.closing) return;
    try { client.send(JSON.stringify({ type: "machine-events-ended" } satisfies ServerMessage)); } catch { }
  };
  const overflow = () => { overflowed = true; if (stop) end(); };
  const tell = (event: MachineEvent) => {
    if (!overflowed) send(client, { type: "machine-event", event }, overflow);
  };
  if (localRoster) {
    const stopRoster = localRoster(machines => tell({ type: "machines", machines }));
    const stopJoins = listJoins?.(tell);
    stop = () => { stopRoster(); stopJoins?.(); };
  } else stop = machineEvents && subscribeMachineEvents(machineEvents, tell);
  if (!stop) return;
  if (state.closing) stop();
  else if (overflowed) end();
  else state.stopMachineEvents = stop;
}

export function presenceOf(raw: string | Buffer): boolean | null {
  const text = String(raw);
  if (!text.includes("\"presence\"")) return null;
  try {
    const message = JSON.parse(text) as { type?: unknown; active?: unknown };
    return message?.type === "presence" ? message.active === true : null;
  } catch {
    return null;
  }
}

export interface SocketLike {
  data: SocketData;
  readonly readyState: number;
  send(data: string): number;
  getBufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

export type Client = SocketLike;

export function backlog(client: Client): number {
  return client.getBufferedAmount() - excusedBytes(client);
}

function excusedBytes(client: Client): number {
  const state = stateOf(client);
  const excused = state.excused;
  if (!excused) return 0;
  const buffered = client.getBufferedAmount();
  const drained = Math.max(0, excused.last - buffered);
  excused.last = buffered;
  let held = 0;
  excused.frames = excused.frames.filter((frame) => {
    frame.ahead = Math.max(0, frame.ahead - drained);
    if (frame.ahead === 0) { clearTimeout(frame.timer); return false; }
    held += Math.min(frame.frame, frame.ahead);
    return true;
  });
  if (excused.frames.length === 0) state.excused = undefined;
  return held;
}

export function send(client: Client, message: ServerMessage, overflow?: () => void): number {
  if (stateOf(client).closing) return 0;
  let encoded: string;
  try {
    encoded = JSON.stringify(message.type === "machine-event"
      ? { ...message, event: wireMachineEvent(message.event, stateOf(client).compactMachineAgents === true) } : message);
  } catch { return 0; }
  return sendEncoded(client, encoded, overflow);
}

export function relayClient(client: Client): { send(raw: string): number; getBufferedAmount(): number; large(): number; close(code?: number, reason?: string): void } {
  return { send: (raw) => sendEncoded(client, raw), getBufferedAmount: () => backlog(client), large: () => excusedBytes(client), close: (code, reason) => client.close(code, reason) };
}

function sendEncoded(client: Client, encoded: string, overflow?: () => void): number {
  const state = stateOf(client);
  if (state.closing) return 0;
  try {
    const bytes = Buffer.byteLength(encoded);
    const held = excusedBytes(client);
    const queued = client.getBufferedAmount() - held;
    if (overflow && queued + bytes > OUTPUT_LOW_BYTES) { overflow(); return 0; }
    const oversized = bytes > OUTPUT_HARD_BYTES && queued <= OUTPUT_HARD_BYTES && held + bytes <= LARGE_REPLY_BYTES;
    // Include JSON escaping in the transport budget, before Bun could drop a
    // frame at its own cap. An overload close is explicit and never auto-replayed.
    if (queued + (oversized ? 0 : bytes) > OUTPUT_HARD_BYTES) {
      client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output transport stalled");
      return 0;
    }
    // -1 means ALREADY queued. Never retry that frame, or terminal bytes repeat.
    const result = client.send(encoded);
    if (result === 0) { if (overflow) overflow(); else client.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed"); }
    else {
      if (state.excused) { state.excused.last += bytes; excusedBytes(client); }
      const after = client.getBufferedAmount();
      if (oversized && after > 0) {
        const frame: ExcusedFrame = { ahead: after, frame: Math.min(bytes, after), timer: setTimeout(() => expire(client, frame), OUTPUT_STALL_MS + crossingMs(after)) };
        frame.timer.unref?.();
        state.excused ??= { frames: [], last: after };
        state.excused.frames.push(frame);
      }
    }
    return result;
  } catch {
    return 0;
  }
}

/**
 * A frame past the budget that has not drained by the time it would take on the slowest link allowed for
 * (OUTPUT_JOIN_BYTES_PER_SECOND) is a stall: nothing else counts it, so a client that stops reading would
 * otherwise hold it until TCP gives up.
 */
function expire(client: Client, frame: ExcusedFrame): void {
  const state = stateOf(client);
  if (state.closing) return;
  excusedBytes(client);
  if (state.excused?.frames.includes(frame)) client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output transport stalled");
}

/**
 * Each watch is a `herdr terminal session observe` process with three descriptors, and a watching device may ask
 * for one: without a bound, frames alone could take the PC's processes and descriptors.
 */
const WATCHES = 64;

interface PaneView {
  process: Pick<PaneWatch, "kill" | "exited">;
  over: boolean;
  stopped: boolean;
  next?: { cols: number; rows: number };
}

export function createConnections({ clients, present, pending, devices, detachClaimed, dropClaims, startWatch = (options) => new PaneWatch(options) }: {
  clients: Set<Client>;
  present: Set<Client>;
  pending: Pick<PendingInputs<Client, unknown>, "close">;
  devices: DeviceStore;
  detachClaimed: (client: Client) => void;
  dropClaims: (client: Client) => void;
  startWatch?: (options: PaneWatchOptions) => Pick<PaneWatch, "kill" | "exited">;
}) {
  function mayType(client: Client): boolean {
    const state = stateOf(client);
    return clients.has(client) && !state.closing && !state.revoked && !client.data.readOnly && state.mode !== "observe";
  }

  function authorizeSocket(client: Client): void {
    const state = stateOf(client);
    if (state.gated) throw new HerdrError("pairing_required", "this PC now takes paired devices only: pair this device to go on");
    if (state.revoked) throw new HerdrError("device_revoked", "this device's access was revoked");
    if (client.data.readOnly || state.mode === "observe") throw new HerdrError("read_only", "this connection can only watch");
  }

  /**
   * Ends the connection when its device is revoked, at once for one revoked already: then it is not admitted. One
   * the open LAN let in ends when the pairing gate closes (the first device paired, the relay turned on), as its
   * requests are refused from then on; it is not admitted either when the gate closed while its upgrade was pending.
   */
  function admit(client: Client): boolean {
    const state = stateOf(client);
    if (client.data.open) {
      state.unwatchGate = devices.endWithGate(() => end(client, "gated"));
      if (state.revoked) return false;
    }
    if (client.data.deviceId) {
      state.unwatchDevice = devices.onRevoke(client.data.deviceId, () => end(client, "revoked"));
      if (!state.revoked && !client.data.readOnly && !devices.canDrive(client.data.deviceId)) end(client, "revoked");
      if (state.revoked) return false;
    }
    if (client.data.untilLock) {
      state.unwatchLock = client.data.untilLock(() => end(client, "revoked"));
      if (state.revoked) return false;
    }
    if (client.data.recheckMs !== undefined) state.recheck = setTimeout(() => client.close(1000, "Portal sign-in check"), client.data.recheckMs);
    return true;
  }

  function setRole(client: Client, mode: ClientRole): void {
    const state = stateOf(client);
    if (state.mode !== mode) state.roles++;
    state.mode = mode;
  }

  function stopView(view: PaneView): void {
    view.over = true;
    if (view.stopped) return;
    view.stopped = true;
    view.process.kill();
  }

  const wanted = (view: PaneView): boolean => !view.over || view.next !== undefined;

  function watchPane(client: Client, paneId: string, geometry: { cols: number; rows: number }): void {
    const { watches, waiting } = stateOf(client);
    if (waiting.has(paneId)) { waiting.set(paneId, geometry); return; }
    const current = watches.get(paneId);
    if (current && wanted(current)) {
      // A pane has one process at a time: started at each frame, frames naming one pane over and over would each
      // hold a process until the event loop turned, past any count of panes. herdr's observe process is gone within
      // a millisecond of being asked, and one that is not is killed (watch.ts)
      current.next = geometry;
      stopView(current);
      return;
    }
    let views = waiting.size;
    for (const view of watches.values()) if (wanted(view)) views++;
    if (views >= WATCHES) {
      send(client, { type: "watch-end", pane_id: paneId });
      return;
    }
    if (current) { current.next = geometry; stopView(current); }
    else if (watches.size >= WATCHES) waiting.set(paneId, geometry);
    else startView(client, paneId, geometry);
  }

  function startWaiting(client: Client): void {
    const { watches, waiting } = stateOf(client);
    for (const [paneId, geometry] of waiting) {
      if (watches.size >= WATCHES) return;
      waiting.delete(paneId);
      startView(client, paneId, geometry);
    }
  }

  function startView(client: Client, paneId: string, geometry: { cols: number; rows: number }): void {
    const { watches } = stateOf(client);
    try {
      let view: PaneView | undefined;
      const ended = (): void => {
        if (!view || watches.get(paneId) !== view || view.over) return;
        view.over = true;
        send(client, { type: "watch-end", pane_id: paneId });
      };
      const started: PaneView = view = { over: false, stopped: false, process: startWatch({
        paneId,
        ...geometry,
        socketPath: checkedHerdrSocket(herdrSocketPath()),
        onFrame: (data) => send(client, { type: "watch-data", pane_id: paneId, data }),
        onEnd: ended,
      }) };
      watches.set(paneId, started);
      const exited = (): void => {
        if (watches.get(paneId) !== started) return;
        ended();
        watches.delete(paneId);
        if (started.next) startView(client, paneId, started.next);
        startWaiting(client);
      };
      void started.process.exited.then(exited, exited);
    } catch (error) {
      console.warn(`[watch] ${paneId} could not start: ${error instanceof Error ? error.message : String(error)}`);
      send(client, { type: "watch-end", pane_id: paneId });
    }
  }

  function unwatchPane(client: Client, paneId: string): void {
    const { watches, waiting } = stateOf(client);
    if (waiting.delete(paneId)) return;
    const view = watches.get(paneId);
    if (!view) return;
    view.next = undefined;
    stopView(view);
  }

  function killWatches(client: Client): void {
    const { watches, waiting } = stateOf(client);
    for (const view of watches.values()) view.process.kill();
    watches.clear();
    waiting.clear();
  }

  function end(client: Client, reason: "stalled" | "revoked" | "gated" | "closed"): void {
    const state = stateOf(client);
    state.stopMachineEvents?.(); state.stopMachineEvents = undefined;
    switch (reason) {
      case "stalled": {
        if (state.closing) return;
        state.closing = true;
        killWatches(client);
        pending.close(client);
        clients.delete(client);
        detachClaimed(client);
        dropClaims(client);
        client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output consumer stalled");
        return;
      }
      case "revoked":
      case "gated": {
        const why = reason === "gated" ? "Pairing required" : "Device access revoked";
        if (reason === "gated") state.gated = true;
        state.revoked = true;
        state.closing = true;
        killWatches(client);
        clients.delete(client);
        present.delete(client);
        detachClaimed(client);
        dropClaims(client);
        client.data.relay?.close(1008, why);
        client.close(1008, why);
        return;
      }
      case "closed": {
        for (const frame of state.excused?.frames ?? []) clearTimeout(frame.timer);
        state.excused = undefined;
        state.unwatchDevice?.();
        state.unwatchGate?.();
        state.unwatchLock?.();
        clearTimeout(state.recheck);
        state.closing = true;
        present.delete(client);
        if (client.data.relay) { client.data.relay.close(); return; }
        killWatches(client);
        pending.close(client);
        clients.delete(client);
        detachClaimed(client);
        dropClaims(client);
        return;
      }
    }
  }

  return { mayType, authorizeSocket, admit, setRole, watchPane, unwatchPane, killWatches, end };
}
