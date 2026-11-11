import { subscribeMachineEvents, type MachineEventDocument } from "../machine-events.ts";
/**
 * A browser's WebSocket connection: what the upgrade records on it, what it may do, how a frame is
 * sent to it, the presence beat it sends, and how it ends. Only this module changes a connection's
 * authority, its observe processes and its closing.
 */
import type { ClientRole, ServerMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import type { DeviceStore } from "../devices.ts";
import { HerdrError, herdrSocketPath, LARGE_REPLY_BYTES } from "../herdr/client.ts";
import type { MachineRelay } from "../machine-relay.ts";
import { crossingMs, OUTPUT_HARD_BYTES, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS, type OutputWindow } from "../output-window.ts";
import type { PendingInputs } from "../pending-input.ts";
import { PaneWatch, type PaneWatchOptions } from "../watch.ts";
import type { TelemetryIngress, TelemetrySurface } from "../../shared/telemetry.ts";

export interface SocketData {
  /** Only the connection server grants this document; remote terminal relays do not. */
  machineEvents?: MachineEventDocument;
  deviceId?: string;
  readOnly?: boolean;
  /** let in by the open LAN alone, while nothing was paired (access.ts `via: "open"`): no device, token, sign-in or
   * bridge token stands behind it, so it ends when the pairing gate closes (admit) */
  open?: boolean;
  relay?: MachineRelay;
  /** another Ovis server reading this PC with its bridge token: it gets snapshots whole and applies its own sidebar rows (#2160) */
  bridge?: boolean;
  /** the kind of screen the page said it runs on (`?surface=`), for the daily active message; absent when it named none, named
   * no known kind (server/telemetry.ts visitSurface) or another server reads */
  surface?: TelemetrySurface;
  /** how the upgrade request reached this server (shared/telemetry.ts TELEMETRY_INGRESS), for the daily active message; absent
   * where `surface` named no known kind, or another server reads */
  ingress?: TelemetryIngress;
  /** a visitor Portal signed in: the socket is closed after this many ms, and the page's reconnect meets Portal's sign-in again (server/portal.ts `recheckMs`) */
  recheckMs?: number;
  /** this connection's id, told to its page in the first snapshot: a create request names it as its first message's typist */
  connectionId: string;
  /** A fresh claim per attach lifetime; deleting it invalidates queued terminal keys. */
  attached: Map<string, { keepSize: boolean; receiptResumeId?: string }>;
  conversationInterests: Set<string>;
  /** panes whose conversation this connection follows without attaching them (`conversation-watch` with `detached`) */
  conversationWatches: Set<string>;
  /** panes whose prompt this connection follows (`prompt-watch`, server/core/prompt-watch.ts) */
  promptWatches: Set<string>;
  output: Map<string, OutputWindow>;
}

interface ConnectionState {
  closing: boolean;
  stopMachineEvents?: () => void;
  revoked: boolean;
  /** revoked because the pairing gate closed on a connection the open LAN had let in */
  gated?: boolean;
  /** the connection's authority: observe connections cannot type or resize */
  mode: ClientRole;
  /** how often `mode` changed: a switch away and back during an await is still a change */
  roles: number;
  watches: Map<string, PaneView>;
  /** the views asked for that wait for a place among them (watchPane), each at the grid asked for last */
  waiting: Map<string, { cols: number; rows: number }>;
  unwatchDevice?: () => void;
  unwatchGate?: () => void;
  recheck?: ReturnType<typeof setTimeout>;
  /**
   * Frames larger than the whole budget, not counted as a backlog while they drain (#2566, #2573), oldest
   * first: each one's `ahead` is what is still queued up to its end, `frame` its size in the queue, and
   * `timer` closes the client when it has not drained by the time the slowest link allowed would take.
   * `last` is the queue as last seen. Whatever is sent after a frame queues behind it, and the queue drains
   * in order.
   */
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
export function connectionData(fields: { machineEvents?: MachineEventDocument; relay?: MachineRelay; deviceId: string | undefined; readOnly: boolean; open?: boolean; bridge?: boolean; surface?: TelemetrySurface; ingress?: TelemetryIngress; recheckMs?: number }): SocketData {
  const data: SocketData = { connectionId: crypto.randomUUID(), attached: new Map<string, { keepSize: boolean }>(), conversationInterests: new Set<string>(), conversationWatches: new Set<string>(), promptWatches: new Set<string>(), output: new Map(), ...fields };
  states.set(data, { closing: false, revoked: false, mode: fields.readOnly ? "observe" : "interact", roles: 0, watches: new Map<string, PaneView>(), waiting: new Map() });
  return data;
}

/** The connection's live authority and closing, read where a check needs them; changed only here. */
export function connectionOf(client: Client): Readonly<Pick<ConnectionState, "closing" | "mode" | "roles">> {
  return stateOf(client);
}

/**
 * Idempotent subscription, with the same authorized document as SSE. Machine events never close
 * the terminal (4008) nor sit in front of its output long enough to stall it: one that would put
 * more than OUTPUT_LOW_BYTES on the socket, counting what is queued already, ends the subscription
 * instead, and the page takes machine events over SSE until its next connection. The ending notice is a
 * few bytes sent past the budget, so the page always learns of it.
 */
export function setMachineEvents(client: Client, enabled: boolean): void {
  const state = stateOf(client);
  if (!enabled) { state.stopMachineEvents?.(); state.stopMachineEvents = undefined; return; }
  if (state.closing || state.stopMachineEvents || !client.data.machineEvents) return;
  let stop: (() => void) | undefined;
  let overflowed = false;
  const end = () => {
    stop?.();
    if (state.stopMachineEvents === stop) state.stopMachineEvents = undefined;
    if (state.closing) return;
    try { client.send(JSON.stringify({ type: "machine-events-ended" } satisfies ServerMessage)); } catch { /* client vanished */ }
  };
  const overflow = () => { overflowed = true; if (stop) end(); };
  stop = subscribeMachineEvents(client.data.machineEvents, (event) => {
    if (!overflowed) send(client, { type: "machine-event", event }, overflow);
  });
  if (state.closing) stop();
  else if (overflowed) end();
  else state.stopMachineEvents = stop;
}

/** A `presence` frame's answer, or null for any other frame. A relayed frame is only parsed when it can be one. */
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

/**
 * The bytes queued for the client that count against its budget (OUTPUT_HARD_BYTES): all of them
 * but what may be left of one frame larger than the budget, such as a large session's snapshot,
 * which a client that keeps up still needs time to read (#2566).
 */
export function backlog(client: Client): number {
  return client.getBufferedAmount() - excusedBytes(client);
}

/** What is left queued of the frames larger than the budget, once what drained since last seen is taken off. */
function excusedBytes(client: Client): number {
  const state = stateOf(client);
  const excused = state.excused;
  if (!excused) return 0;
  const buffered = client.getBufferedAmount();
  // what drained since it was last seen left from the front, up to each frame's end first
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

/**
 * `overflow` marks a side-channel frame (machine events): it is called, and the frame not sent,
 * when the frame would put more than OUTPUT_LOW_BYTES on the socket, counting what is queued
 * already, or when the socket refuses it; such a frame never closes the connection.
 */
export function send(client: Client, message: ServerMessage, overflow?: () => void): number {
  if (stateOf(client).closing) return 0;
  let encoded: string;
  try { encoded = JSON.stringify(message); } catch { return 0; }
  return sendEncoded(client, encoded, overflow);
}

/**
 * The socket a remote PC's frames are relayed to (machine-relay.ts), held to the same budget as this PC's own
 * frames: a remote session's snapshot past it is excused while it drains as well (#2573).
 */
export function relayClient(client: Client): { send(raw: string): number; getBufferedAmount(): number; large(): number; close(code?: number, reason?: string): void } {
  return { send: (raw) => sendEncoded(client, raw), getBufferedAmount: () => backlog(client), large: () => excusedBytes(client), close: (code, reason) => client.close(code, reason) };
}

function sendEncoded(client: Client, encoded: string, overflow?: () => void): number {
  const state = stateOf(client);
  if (state.closing) return 0;
  try {
    const bytes = Buffer.byteLength(encoded);
    // A frame larger than the whole budget is sent while the backlog is within it, and excused
    // while it drains; those queued at once stay within herdr's largest reply, which the socket's
    // own limit leaves room for (socket.ts `backpressureLimit`).
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
      // the frame just sent queues behind the excused ones: only its own bytes are new, and what the
      // socket wrote out meanwhile drained from the front
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
    /* client vanished mid-send */
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
 * How many panes one connection may watch at a time, and how many observe processes it may have. Each watch is a
 * `herdr terminal session observe` process with three descriptors, and a watching device may ask for one: without
 * a bound, frames alone could take the PC's processes and descriptors. A page watches the panes of its four most
 * recent tabs (PaneCanvas), far below this.
 */
const WATCHES = 64;

/**
 * One pane's view on a connection: its observe process, kept here until that process has exited, so the
 * connection's views are its processes and WATCHES bounds both. A view asked for while every process's place is
 * taken, some by a pane given up whose process has not exited yet, waits for one of those (ConnectionState.waiting).
 */
interface PaneView {
  process: Pick<PaneWatch, "kill" | "exited">;
  /** watched again, unwatched or ended by itself: the page is owed no `watch-end` for it. Its place is its until it has exited */
  over: boolean;
  /** its process was asked to end, which a view that ended by itself was not */
  stopped: boolean;
  /** the grid asked for since: the view starts again at it once the process has exited, the last one asked for */
  next?: { cols: number; rows: number };
}

/**
 * What a connection may do, its observe processes, and its end. A connection's panes stay with the
 * terminal code: `detachClaimed` detaches them while the claims still count, `dropClaims` forgets them.
 */
export function createConnections({ clients, present, pending, devices, detachClaimed, dropClaims, startWatch = (options) => new PaneWatch(options) }: {
  clients: Set<Client>;
  present: Set<Client>;
  /** the pending messages' end for a connection: its own are held, whoever else the store holds messages for */
  pending: Pick<PendingInputs<Client, unknown>, "close">;
  devices: DeviceStore;
  detachClaimed: (client: Client) => void;
  dropClaims: (client: Client) => void;
  /** starts the observe process of one watch; a test passes its own */
  startWatch?: (options: PaneWatchOptions) => Pick<PaneWatch, "kill" | "exited">;
}) {
  /** authorizeSocket as a test: may this connection type now? */
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
      // a role change while the upgrade was pending (a remote PC's relay dials first) told its listeners before this one
      if (!state.revoked && !client.data.readOnly && !devices.canDrive(client.data.deviceId)) end(client, "revoked");
      if (state.revoked) return false;
    }
    // a plain close: the page reconnects as after any other, and Portal decides whether it gets in
    if (client.data.recheckMs !== undefined) state.recheck = setTimeout(() => client.close(1000, "Portal sign-in check"), client.data.recheckMs);
    return true;
  }

  function setRole(client: Client, mode: ClientRole): void {
    const state = stateOf(client);
    if (state.mode !== mode) state.roles++;
    state.mode = mode;
  }

  /** Ends a view the page replaced or gave up: its process is asked to end, once, and no end is told. */
  function stopView(view: PaneView): void {
    view.over = true;
    if (view.stopped) return;
    view.stopped = true;
    view.process.kill();
  }

  /** A view the page still has: one running, or one that starts again once its process has exited. Not one given up, or ended by itself. */
  const wanted = (view: PaneView): boolean => !view.over || view.next !== undefined;

  function watchPane(client: Client, paneId: string, geometry: { cols: number; rows: number }): void {
    const { watches, waiting } = stateOf(client);
    if (waiting.has(paneId)) { waiting.set(paneId, geometry); return; }
    const current = watches.get(paneId);
    if (current && wanted(current)) {
      // drawn again for another grid, in the same place. A pane has one process at a time: started at each frame,
      // frames naming one pane over and over would each hold a process until the event loop turned, past any
      // count of panes. So the view starts again once this process has exited, at the grid asked for last. herdr's
      // observe process is gone within a millisecond of being asked, and one that is not is killed (watch.ts)
      current.next = geometry;
      stopView(current);
      return;
    }
    // one more view. The limit is told as a view that cannot start is: with its end alone, since a page writes an
    // error it does not know into every terminal it shows
    let views = waiting.size;
    for (const view of watches.values()) if (wanted(view)) views++;
    if (views >= WATCHES) {
      send(client, { type: "watch-end", pane_id: paneId });
      return;
    }
    // a pane given up, or one whose view ended by itself, with its process not exited yet: its view starts after
    // that, as one watched again does
    if (current) { current.next = geometry; stopView(current); }
    // every process's place is taken, some by a pane given up a moment ago (a tab left the page's recent ones as
    // another came): the view waits for one of those to exit, and is told nothing meanwhile
    else if (watches.size >= WATCHES) waiting.set(paneId, geometry);
    else startView(client, paneId, geometry);
  }

  /** The views that wait for a place take the ones that are free, the first asked for first. */
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
      // ended by itself (its pane closed, herdr refused it): the page hears at once
      const ended = (): void => {
        if (!view || watches.get(paneId) !== view || view.over) return;
        view.over = true;
        send(client, { type: "watch-end", pane_id: paneId });
      };
      const started: PaneView = view = { over: false, stopped: false, process: startWatch({
        paneId,
        ...geometry,
        socketPath: herdrSocketPath(),
        onFrame: (data) => send(client, { type: "watch-data", pane_id: paneId, data }),
        onEnd: ended,
      }) };
      watches.set(paneId, started);
      const exited = (): void => {
        // the connection ended meanwhile (killWatches forgot its views): nothing of it starts again
        if (watches.get(paneId) !== started) return;
        // a process gone without a word ends its view too
        ended();
        watches.delete(paneId);
        if (started.next) startView(client, paneId, started.next);
        // its place, when nothing started in it again, is the next waiting view's
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
    // nothing starts in its place, which stays its process's until that has exited
    view.next = undefined;
    stopView(view);
  }

  function killWatches(client: Client): void {
    const { watches, waiting } = stateOf(client);
    for (const view of watches.values()) view.process.kill();
    watches.clear();
    waiting.clear();
  }

  /**
   * Ends the connection, each way as it always did: its output consumer stalled, its device was
   * revoked (`gated`: the pairing gate closed on one the open LAN let in, which ends the same way under its
   * own words), or its socket closed. A close follows the others and runs as well.
   */
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
