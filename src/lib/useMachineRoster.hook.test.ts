import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useCallback, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine, MachineEvent, PendingKey } from "../../shared/machines.ts";
import { signPairProof } from "../../shared/pair-fingerprint.ts";
import { memberRow, pairingPc, phone } from "../../server/account/pairing.test-helpers.ts";
import { bounded } from "../../server/relay/test-helpers.ts";
import { PendingKeys } from "../components/PendingKeys.tsx";
import { declinePendingKey } from "./api.ts";
import type { MachineEventSocket } from "./machineEventStream.ts";
import type { MachineSessionRegistry } from "./machineSession.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { SettingsProvider } from "./settings.ts";
import { getTransport, setTransport, type EventSourceLike } from "./transport.ts";
import { sameData, useRosterEvents, useRosterLoader } from "./useMachineRoster.ts";
import { expandMachineEvent, wireMachineEvent } from "../../shared/compact-agents.ts";
import { HerdrSocket } from "./ws.ts";

const local = (state: Machine["state"] = "connected"): Machine => ({ id: "local", name: "This PC", kind: "local", enabled: true, state, error: null, snapshot: null });
const noop = () => {};
let said: string | null = null;
let pendingShown: readonly PendingKey[] = [];
let shown: Machine[] = [];
describe("roster and health polling beside the event stream", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const transport = getTransport();
  let renderer: ReactTestRenderer | undefined;
  let source: EventSourceLike & { readyState: number };
  let locked: boolean;
  let visibility: DocumentVisibilityState;
  let events: EventTarget;
  let now: number;
  let next: number;
  let timers: Map<number, { at: number; every: number; run(): void }>;
  let reads: string[];
  let socketEvents: boolean | null;
  let socketListeners: Set<(message: ServerMessage) => void>;
  let disconnectListeners: Set<() => void>;
  const socket = {
    get machineEventsAvailable() { return socketEvents; }, outputStopped: false, connect: noop, setMachineEvents: noop,
    on(listener: (message: ServerMessage) => void) { socketListeners.add(listener); return () => { socketListeners.delete(listener); }; },
    onDisconnect(listener: () => void) { disconnectListeners.add(listener); return () => { disconnectListeners.delete(listener); }; },
  };
  let eventSocket: MachineEventSocket;
  let pendingChanged: (pending: readonly PendingKey[]) => void;
  const machineSessions = { get: () => ({ socket: eventSocket }), closeAll: noop } as unknown as MachineSessionRegistry;
  let healthUp: boolean;
  let readState: Machine["state"];
  function Probe() {
    const lockedRef = useRef(locked); lockedRef.current = locked;
    const refetchTimer = useRef<number | null>(null);
    const [healthFailing, setHealthFailing] = useState(false);
    const loadHealth = useCallback(async () => {
      await getTransport().fetch("/api/health?scope=bridge");
      setHealthFailing(!(await getTransport().fetch("/api/health")).ok);
    }, []);
    const [machines, setMachines] = useState<Machine[]>([]);
    const machinesRef = useRef(machines); machinesRef.current = machines; shown = machines;
    const loader = useRosterLoader({ locked, healthFailing, lockedRef, refetchTimer, loadHealth, rosterIn: noop, setMachines, setMachineRosterLoaded: noop, setError: noop, setLocked: noop });
    said = loader.rosterConnection;
    useRosterEvents({
      ...loader, locked, machineSessions, onPaneMoved: noop, receivePreferencesRef: { current: noop }, onRoster: noop,
      setMachines, rosterIn: noop, setMachineRosterLoaded: noop, machinesRef, setRemotePairings: noop, setRemovedNotices: noop,
      onPaneStatus: noop, onPaneExited: noop, followFocusRef: { current: false },
      selectionRef: { current: { machineId: "local", paneId: null, generation: 0 } },
      splitShownRef: { current: false }, splitRef: { current: null }, pendingLink: { current: null },
      selectionHint: { current: null }, setSelectedPaneId: noop, setNotificationViewTarget: noop,
      setTerminalPeek: noop, setAutoSelected: noop, preferencesResubscribedRef: { current: noop },
      preferencesDisconnectedRef: { current: noop }, preferencesClosedRef: { current: noop },
      dropIn: noop, chime: noop, setPairedNotices: noop, setRelayPairings: noop, getTakeNotificationTargetRef: () => ({ current: noop }),
      setPendingKeys: (pending) => { pendingShown = pending; pendingChanged(pending); },
    });
    return null;
  }
  beforeEach(async () => {
    for (const key of ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    locked = false; visibility = "visible"; now = 0; next = 1; timers = new Map(); reads = []; events = new EventTarget();
    socketEvents = false; socketListeners = new Set(); disconnectListeners = new Set(); healthUp = true; readState = "connected";
    eventSocket = socket; pendingShown = []; pendingChanged = noop;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { hash: "" },
      setInterval(run: () => void, every: number) { const id = next++; timers.set(id, { at: now + every, every, run }); return id; },
      clearInterval(id: number) { timers.delete(id); },
      setTimeout(run: () => void, ms: number) { const id = next++; timers.set(id, { at: now + ms, every: 0, run }); return id; },
      clearTimeout(id: number) { timers.delete(id); },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    source = { readyState: 0, onopen: null, onmessage: null, onerror: null, addEventListener: noop, close: noop };
    setTransport({ ...transport, openEventSource: () => source, async fetch(input) {
      const path = String(input); reads.push(path);
      if (path === "/api/machines?compact_agents=1" || path === "/api/machines") return Response.json({ machines: [local(readState)] });
      return path === "/api/health" && !healthUp ? Response.json({ error: { code: "down" } }, { status: 500 }) : Response.json({ ok: true });
    } });
    await act(async () => { renderer = create(createElement(Probe)); });
    reads.length = 0;
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    setTransport(transport);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      if (due[1].every === 0) timers.delete(due[0]);
      else due[1].at += due[1].every;
      await act(async () => { due[1].run(); });
    }
    now = end;
  }
  async function stream(update: "opened" | "lost" | "closed" | Machine[]) {
    await act(async () => {
      if (Array.isArray(update)) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: update }) }));
      else if (update === "opened") { source.readyState = 1; source.onopen?.(new Event("open")); }
      else { source.readyState = update === "lost" ? 0 : 2; source.onerror?.(new Event("error")); }
    });
  }
  async function onSocket(message: ServerMessage | "disconnect") {
    await act(async () => {
      if (message === "disconnect") for (const listener of [...disconnectListeners]) listener();
      else for (const listener of [...socketListeners]) listener(message);
    });
  }
  async function healthyStream() { await stream("opened"); await stream([local()]); }
  const counts = () => ["/api/machines?compact_agents=1", "/api/health", "/api/health?scope=bridge"].map((path) => reads.filter((read) => read === path).length);

  it("T71: keeps the PC's list of keys waiting for its screen as each change comes", async () => {
    await healthyStream();
    const key: PendingKey = { id: "p1", label: "Pixel 9", fingerprint: "AB12-CD34", via: "relay", redeemed_at: "2026-11-20T04:00:00.000Z", slots: { used: 1, of: 5 } };
    await act(async () => { source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "pending-redemptions", pending: [key] }) })); });
    expect(pendingShown).toEqual([key]);
    await act(async () => { source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "pending-redemptions", pending: [] }) })); });
    expect(pendingShown).toEqual([]);
  });

  it.each(["SSE", "WebSocket"])("T71: a real %s subscription replaces the list with the keys already waiting on the PC", async (carrier) => {
    const made = await pairingPc({ rows: [(await memberRow("acct_1")).row], server: { accountOpensAll: true } });
    const base = `http://127.0.0.1:${made.app.port}`;
    const ws = new HerdrSocket(`ws://127.0.0.1:${made.app.port}/ws`);
    const abort = new AbortController();
    const waiting = Promise.withResolvers<readonly PendingKey[]>();
    try {
      const { pendingRedemptions: pending, relay, core } = made.app.context.services;
      const serverId = relay.currentIdentity()?.server_id;
      if (!pending || !serverId || !core.machines) throw new Error("The PC has no pending-key store, relay identity, or roster");
      core.machines.list = () => [local()];
      const device = await phone();
      const { challenge } = pending.name(await made.offerCode(), "Waiting phone", device.spki, "relay");
      const key = await pending.prove(challenge, await signPairProof(serverId, challenge, device.spki, device.keys.privateKey));
      if (!key) throw new Error("Could not seed a proved key on the PC");

      await act(async () => { renderer?.unmount(); });
      pendingShown = [{ ...pending.view()[0]!, id: "stale", label: "Old phone" }];
      pendingChanged = waiting.resolve;
      if (carrier === "WebSocket") eventSocket = ws;
      const fixtureTransport = getTransport();
      setTransport({ ...fixtureTransport,
        fetch: (input, init) => String(input) !== "/api/devices/pending/decline" ? fixtureTransport.fetch(input, init) : fetch(new URL(String(input), base), {
          ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: base },
        }),
        openEventSource: (url) => {
          if (carrier !== "SSE") {
            waiting.reject(new Error("WebSocket unexpectedly fell back to SSE"));
            return source;
          }
          const stream: EventSourceLike = { readyState: 1, onopen: null, onmessage: null, onerror: null, addEventListener: noop, close: () => abort.abort() };
          void (async () => {
            const response = await fetch(new URL(url, base), { signal: abort.signal });
            if (!response.ok || !response.body) throw new Error(`SSE returned ${response.status}`);
            stream.onopen?.(new Event("open"));
            const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                buffer += value;
                for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
                  const block = buffer.slice(0, end);
                  buffer = buffer.slice(end + 2);
                  if (block.startsWith("data: ")) stream.onmessage?.(new MessageEvent("message", { data: block.slice(6) }));
                }
              }
            } finally { reader.releaseLock(); }
          })().catch((error: unknown) => { if (!abort.signal.aborted) waiting.reject(error); });
          return stream;
        },
      });
      await act(async () => { renderer = create(createElement(Probe)); });
      await act(async () => { await bounded(waiting.promise, 2_000); });
      expect(pendingShown).toEqual(pending.view());
      const markup = renderToStaticMarkup(createElement(SettingsProvider, null, createElement(PendingKeys, { pending: pendingShown, onDecline: noop })));
      expect(markup).toContain(key.fingerprint);
      expect(markup).toContain(">Decline</button>");
      expect(markup).not.toContain("Old phone");

      const changed = Promise.withResolvers<readonly PendingKey[]>();
      pendingChanged = changed.resolve;
      await act(async () => {
        expect(await declinePendingKey(key.id)).toEqual([]);
        expect(await bounded(changed.promise, 2_000)).toEqual([]);
      });
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      ws.close();
      abort.abort();
      await made.close();
    }
  });

  it("reads the roster in full, once, after a pushed compact snapshot that cannot be read", async () => {
    await stream("opened");
    const unreadable = { ...local(), snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], layouts: [], panes: [], agent_refs: [{ pane_id: "gone" }] } };
    await act(async () => { source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: [unreadable] }) })); });
    await act(async () => { source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: [unreadable] }) })); });
    expect(reads).not.toContain("/api/machines");
    await advance(500);
    expect(reads.filter((read) => read === "/api/machines")).toHaveLength(1);
  });

  it("shows the full read's snapshot for a PC whose compact ones cannot be read, while such events come every 100 ms for 5 s", async () => {
    const remote = (version: string): Machine => ({ id: "remote", name: "Away", kind: "ssh", enabled: true, state: "connected", error: null,
      snapshot: { version, protocol: 22, workspaces: [], tabs: [], layouts: [], panes: [], agents: [] } });
    const fullReads: { promise: Promise<void>; resolve: () => void }[] = [];
    setTransport({ ...transport, openEventSource: () => source, async fetch(input) {
      const path = String(input); reads.push(path);
      if (path === "/api/machines") {
        const answer = Promise.withResolvers<void>();
        fullReads.push(answer);
        await answer.promise;
        return Response.json({ machines: [local(), remote("full read")] });
      }
      if (path === "/api/machines?compact_agents=1") return Response.json({ machines: [local(), remote("polled")] });
      return Response.json({ ok: true });
    } });
    await stream("opened");
    await stream([local(), remote("pushed")]);
    const remoteShown = () => shown.find((machine) => machine.id === "remote")?.snapshot?.version;
    expect(remoteShown()).toBe("pushed");
    const unreadable = { ...remote("pushed"), snapshot: { version: "unreadable", protocol: 22, workspaces: [], tabs: [], layouts: [], panes: [], agent_refs: [{ pane_id: "gone" }] } };
    for (let at = 0; at < 5_000; at += 100) {
      const out = fullReads.splice(0);
      await act(async () => { source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: [local(), unreadable] }) })); });
      await act(async () => { for (const read of out) read.resolve(); });
      await advance(100);
    }
    expect(reads).not.toContain("/api/machines?compact_agents=1");
    expect(reads.filter((read) => read === "/api/machines").length).toBeGreaterThan(0);
    expect(remoteShown()).toBe("full read");
  });

  function recoveryFixture() {
    const remote = (version: string, status: "idle" | "working" = "idle") => ({ id: "remote", name: "Away", kind: "ssh", enabled: true, state: "connected", error: null,
      snapshot: { version, protocol: 22, workspaces: [], tabs: [], layouts: [], agents: [],
        panes: [{ pane_id: "r1", terminal_id: "t1", workspace_id: "w", tab_id: "w:t", focused: false, revision: 1, agent_status: status }] } }) as Machine;
    const fullReads: { promise: Promise<void>; resolve: () => void }[] = [];
    const answer = { machine: remote("full read") };
    setTransport({ ...transport, openEventSource: () => source, async fetch(input) {
      const path = String(input); reads.push(path);
      if (path === "/api/machines") {
        const gate = Promise.withResolvers<void>();
        fullReads.push(gate);
        await gate.promise;
        return Response.json({ machines: [local(), answer.machine] });
      }
      return Response.json(path === "/api/machines?compact_agents=1" ? { machines: [local(), remote("polled")] } : { ok: true });
    } });
    const unreadable = { ...remote("pushed"), snapshot: { version: "unreadable", protocol: 22, workspaces: [], tabs: [], layouts: [], panes: [], agent_refs: [{ pane_id: "gone" }] } } as unknown as Machine;
    const shownRemote = () => shown.find((machine) => machine.id === "remote")?.snapshot;
    return { remote, fullReads, answer, unreadable, shownRemote };
  }

  it("keeps a newer readable roster for a PC over the full read that was out when it came", async () => {
    const { remote, fullReads, unreadable, shownRemote } = recoveryFixture();
    await stream("opened");
    await stream([local(), remote("pushed")]);
    await stream([local(), unreadable]);
    await advance(500);
    expect(fullReads).toHaveLength(1);
    await stream([local(), remote("newer")]);
    await stream([local(), unreadable]);
    expect(shownRemote()?.version).toBe("newer");
    await act(async () => { fullReads[0]!.resolve(); });
    expect(shownRemote()?.version).toBe("newer");
  });

  it("keeps a pane status that came while a PC's full read was out, and reads that PC in full again", async () => {
    const { remote, fullReads, answer, unreadable, shownRemote } = recoveryFixture();
    await stream("opened");
    await stream([local(), remote("pushed")]);
    await stream([local(), unreadable]);
    await advance(500);
    expect(fullReads).toHaveLength(1);
    await act(async () => { source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "remote",
      message: { type: "pane-status", pane_id: "r1", agent_status: "working", finish_epoch: "e", finish_id: 1 } }) })); });
    expect(shownRemote()?.panes[0]?.agent_status).toBe("working");
    await act(async () => { fullReads[0]!.resolve(); });
    expect(shownRemote()?.panes[0]?.agent_status).toBe("working");
    await advance(500);
    expect(fullReads).toHaveLength(2);
    answer.machine = remote("read again", "working");
    await act(async () => { fullReads[1]!.resolve(); });
    expect(shownRemote()?.version).toBe("read again");
  });

  it("ends a PC's recovery when a pane status comes during every full read: the third is shown, the newest status on top", async () => {
    const { remote, fullReads, answer, unreadable, shownRemote } = recoveryFixture();
    const status = (agent_status: string, finish_id: number) => act(async () => {
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "remote",
        message: { type: "pane-status", pane_id: "r1", agent_status, finish_epoch: "e", finish_id } }) }));
    });
    await stream("opened");
    await stream([local(), remote("pushed")]);
    await stream([local(), unreadable]);
    for (const [index, agentStatus] of ["working", "blocked", "done"].entries()) {
      await advance(500);
      expect(fullReads).toHaveLength(index + 1);
      await status(agentStatus, index + 1);
      answer.machine = remote(`read ${index + 1}`);
      await act(async () => { fullReads[index]!.resolve(); });
    }
    expect(shownRemote()?.version).toBe("read 3");
    expect(shownRemote()?.panes[0]?.agent_status).toBe("done");
    await status("idle", 4);
    await advance(5_000);
    expect(fullReads).toHaveLength(3);
    expect(shownRemote()?.panes[0]?.agent_status).toBe("idle");
  });

  it("reduces an idle minute from 36 GETs to 6 only after an open stream pushes a connected local PC", async () => {
    await advance(60_000);
    expect(counts()).toEqual([12, 12, 12]);
    reads.length = 0;
    await healthyStream();
    await advance(60_000);
    expect(counts()).toEqual([2, 2, 2]);
  });

  it("does not trust an open stream or a successful REST roster without a pushed local PC", async () => {
    await stream("opened");
    await advance(10_000);
    expect(counts()).toEqual([2, 2, 2]);
    await stream([{ ...local(), id: "remote", kind: "ssh" }]);
    await advance(5_000);
    expect(counts()).toEqual([3, 3, 3]);
  });

  it("does not postpone the half-open backstop when identical rosters keep arriving", async () => {
    await healthyStream();
    for (let i = 0; i < 6; i++) { await advance(5_000); await stream([local()]); }
    expect(counts()).toEqual([1, 1, 1]);
    await advance(30_000); // no more pushes: EventSource cannot detect a missing heartbeat
    expect(counts()).toEqual([2, 2, 2]);
  });

  for (const failure of ["lost", "closed", "away", "missing"] as const) {
    it(`reads immediately and every five seconds when the stream is ${failure}`, async () => {
      await healthyStream();
      await advance(1_000);
      await stream(failure === "away" ? [local("disconnected")] : failure === "missing" ? [] : failure);
      expect(counts()).toEqual([1, 1, 1]);
      await advance(5_000);
      expect(counts()).toEqual([2, 2, 2]);
      await stream("opened");
      if (failure === "lost" || failure === "closed") {
        await advance(5_000);
        expect(counts()).toEqual([3, 3, 3]);
      }
      await stream([local()]);
      reads.length = 0;
      await advance(29_999);
      expect(counts()).toEqual([0, 0, 0]);
      await advance(1);
      expect(counts()).toEqual([1, 1, 1]);
    });
  }

  it("slows down the same way when the local terminal socket carries the events, and reads at once when it drops", async () => {
    socketEvents = true;
    await onSocket({ type: "features", features: ["machine-events"] } as ServerMessage);
    await onSocket({ type: "machine-event", event: { type: "machines", machines: [local()] } satisfies MachineEvent } as ServerMessage);
    await advance(60_000);
    expect(counts()).toEqual([2, 2, 2]);
    reads.length = 0;
    socketEvents = null;
    await onSocket("disconnect");
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
  });

  it("does not keep the slow backstop on SSE's roster once the terminal socket takes over", async () => {
    await healthyStream();
    await advance(1_000);
    socketEvents = true;
    await onSocket({ type: "features", features: ["machine-events"] } as ServerMessage);
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    await onSocket({ type: "machine-event", event: { type: "machines", machines: [local()] } satisfies MachineEvent } as ServerMessage);
    reads.length = 0;
    await advance(29_999);
    expect(counts()).toEqual([0, 0, 0]);
  });

  it("watches health every five seconds after a failed read while the stream stays healthy, and slows again once it answers", async () => {
    await healthyStream();
    healthUp = false;
    await advance(30_000);
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    healthUp = true;
    await advance(5_000);
    expect(counts()).toEqual([3, 3, 3]);
    await advance(29_999);
    expect(counts()).toEqual([3, 3, 3]);
    await advance(1);
    expect(counts()).toEqual([4, 4, 4]);
  });

  it("returns to five seconds when a roster read shows this PC away under a silent open stream", async () => {
    await healthyStream();
    readState = "disconnected";
    await advance(30_000);
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    readState = "connected";
    await advance(30_000);
    expect(counts()).toEqual([8, 8, 8]);
  });

  it("says Reconnecting while the stream that feeds the roster is lost after it was had, and Connected when it is back", async () => {
    expect(said).toBeNull();
    await healthyStream();
    expect(said).toBeNull();
    await stream("lost");
    expect(said).toBe("reconnecting");
    await stream([local()]);
    expect(said).toBe("reconnecting");
    await stream("opened");
    expect(said).toBe("connected");
  });

  it("says the same of the local terminal socket when it carries the roster's events", async () => {
    socketEvents = true;
    await onSocket({ type: "features", features: ["machine-events"] } as ServerMessage);
    expect(said).toBeNull();
    socketEvents = null;
    await onSocket("disconnect");
    expect(said).toBe("reconnecting");
    socketEvents = true;
    await onSocket({ type: "features", features: ["machine-events"] } as ServerMessage);
    expect(said).toBe("connected");
  });

  it("watches health immediately and every five seconds while locked, without reading the roster", async () => {
    await healthyStream();
    await act(async () => { locked = true; renderer!.update(createElement(Probe)); });
    expect(counts()).toEqual([0, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([0, 2, 2]);
    await act(async () => { locked = false; renderer!.update(createElement(Probe)); });
    await advance(5_000);
    expect(counts()).toEqual([1, 3, 3]);
    await healthyStream();
    reads.length = 0;
    await advance(30_000);
    expect(counts()).toEqual([1, 1, 1]);
  });

  it("polls nothing hidden, catches up once on return and removes its timer on unmount", async () => {
    await healthyStream();
    visibility = "hidden";
    await act(async () => { events.dispatchEvent(new Event("visibilitychange")); });
    await advance(60_000);
    await stream("lost");
    await advance(5_000);
    expect(counts()).toEqual([0, 0, 0]);
    visibility = "visible";
    await act(async () => { events.dispatchEvent(new Event("visibilitychange")); });
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(timers.size).toBe(0);
    reads.length = 0;
    await advance(60_000);
    expect(reads).toEqual([]);
  });
});

describe("sameData", () => {
  it("takes a roster restored from compact rows, its keys in another order, for the full roster it equals", () => {
    const pane = { pane_id: "w1:p1", terminal_id: "terminal", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1,
      agent: "codex", agent_status: "working" as const, cwd: "/work/project/with/a/long/path", terminal_title: "An agent working on the project" };
    const machines: Machine[] = [{ ...local(), snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], layouts: [], panes: [pane], agents: [{ ...pane, state_change_seq: 3 }] } }];
    const event = expandMachineEvent(JSON.parse(JSON.stringify(wireMachineEvent({ type: "machines", machines }, true))));
    const restored = event.type === "machines" ? event.machines : [];
    expect(JSON.stringify(restored)).not.toBe(JSON.stringify(machines));
    expect(sameData(machines, restored)).toBe(true);
    restored[0]!.snapshot!.agents[0]!.state_change_seq = 4;
    expect(sameData(machines, restored)).toBe(false);
  });
});
