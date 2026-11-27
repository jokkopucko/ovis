import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { HerdrPane } from "../shared/protocol.ts";
import { HerdrError, type EventFrame } from "./herdr/client.ts";
import { parseFocusFrame, parseStatusFrame, parseStructureFrame, startStatusCollector, type StatusCollectorDeps, type StatusCollectorHandlers } from "./collector.ts";

/**
 * Frame shapes are the live wire format observed against herdr protocol 22 (see
 * collector.ts's header): status frames are flat with a dotted `event` key,
 * structure frames carry a snake_case `data.type`.
 */

describe("parseStatusFrame", () => {
  it("parses a real agent_status_changed frame", () => {
    const frame: EventFrame = {
      event: "pane.agent_status_changed",
      data: { agent: "claude", agent_status: "blocked", pane_id: "w3J:p1", workspace_id: "w3J" },
    };
    expect(parseStatusFrame(frame)).toEqual({ paneId: "w3J:p1", status: "blocked", agent: "claude", displayAgent: null });
  });

  it("reads the line a plugin reports for the agent", () => {
    // live (herdr 0.9.3): `report-metadata --display-agent` alone sends this, with the status unchanged
    const frame: EventFrame = {
      event: "pane.agent_status_changed",
      data: { agent: "claude", agent_status: "idle", display_agent: "needs a login", pane_id: "w2X:p1", workspace_id: "w2X" },
    };
    expect(parseStatusFrame(frame)).toEqual({ paneId: "w2X:p1", status: "idle", agent: "claude", displayAgent: "needs a login" });
  });

  it("rejects frames that are not status events", () => {
    expect(parseStatusFrame({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p1" } })).toBeNull();
  });

  it("rejects malformed payloads instead of throwing", () => {
    expect(parseStatusFrame({ event: "pane.agent_status_changed", data: { pane_id: 7 } })).toBeNull();
    expect(parseStatusFrame({ event: "pane.agent_status_changed" })).toBeNull();
    expect(parseStatusFrame({})).toBeNull();
  });
});

describe("parseStructureFrame", () => {
  it("parses a pane_exited frame into a pane-ended event", () => {
    const frame: EventFrame = { event: "pane_exited", data: { type: "pane_exited", pane_id: "w3M:p1", workspace_id: "w3M" } };
    expect(parseStructureFrame(frame)).toEqual({ kind: "pane-ended", paneId: "w3M:p1" });
  });

  it("parses pane_created and pane_closed into a structure-changed event", () => {
    // herdr 0.9.5's frame (isolated test session); herdr-core's names only the pane ID
    expect(parseStructureFrame(createdFrame("w2:p1", "unknown"))).toEqual({ kind: "structure-changed", created: { paneId: "w2:p1", status: "unknown" } });
    expect(parseStructureFrame({ event: "pane.created", data: { type: "pane_created", pane_id: "t4" } })).toEqual({ kind: "structure-changed" });
    expect(parseStructureFrame({ data: { type: "pane_created" } })).toEqual({ kind: "structure-changed" });
    for (const type of ["tab_closed", "workspace_closed", "worktree_removed"]) expect(parseStructureFrame({ data: { type, workspace_id: "w2" } })).toEqual({ kind: "structure-changed", scopedClose: true });
    expect(parseStructureFrame({ data: { type: "pane_closed", pane_id: "w1:p1" } })).toEqual({ kind: "structure-changed", closed: "w1:p1" });
    expect(parseStructureFrame({ data: { type: "pane_closed" } })).toEqual({ kind: "structure-changed" });
  });

  it("rejects unknown or malformed frames", () => {
    expect(parseStructureFrame({ data: { type: "unrecognized_event" } })).toBeNull();
    expect(parseStructureFrame({ data: { type: "pane_exited", pane_id: 42 } })).toBeNull();
    expect(parseStructureFrame({})).toBeNull();
  });
});

describe("parseFocusFrame", () => {
  it("names the pane a focus lands on, from the live frame", () => {
    // live (herdr 0.9.0): a workspace brought to the front also sends pane_focused for its pane
    expect(parseFocusFrame({ event: "pane_focused", data: { pane_id: "w1A4:p1", type: "pane_focused", workspace_id: "w1A4" } })).toBe("w1A4:p1");
    expect(parseFocusFrame({ event: "tab_focused", data: { tab_id: "w1A4:t1", type: "tab_focused", workspace_id: "w1A4" } })).toBeNull();
    expect(parseFocusFrame({ data: { type: "pane_focused", pane_id: 3 } })).toBeNull();
    expect(parseFocusFrame({})).toBeNull();
  });
});

describe("herdr liveness", () => {
  function watched() {
    const herdr = fakeHerdr([]);
    const socket: { now: string | null } = { now: "herdr-a" };
    const said: (string | null)[] = [];
    const collector = startStatusCollector({ ...recorder().handlers, herdrLive: { identity: () => socket.now, onChange: (identity) => said.push(identity) } }, herdr.deps);
    return { herdr, socket, said, collector };
  }

  it("names the herdr that answers the lifecycle subscription, until it closes (#2257)", () => {
    const { herdr, said, collector } = watched();
    try {
      expect(said).toEqual([]);
      herdr.lifecycle().start();
      expect(said).toEqual(["herdr-a"]);
      herdr.lifecycle().drop("socket_error");
      expect(said).toEqual(["herdr-a", null]);
    } finally {
      collector.stop();
    }
  });

  it("names no herdr when its socket was replaced between the attempt and the answer (#2257)", () => {
    const { herdr, socket, said, collector } = watched();
    try {
      socket.now = "herdr-b";
      herdr.lifecycle().start();
      expect(said).toEqual([null]);
    } finally {
      collector.stop();
    }
  });

  it("names none once the collector stops, whose own close reports none (#2257)", () => {
    const { herdr, said, collector } = watched();
    herdr.lifecycle().start();
    collector.stop();
    expect(said).toEqual(["herdr-a", null]);
  });
});

describe("lifecycle invalidations", () => {
  it("tells when the lifecycle subscription is live, also when only a reopened one starts", async () => {
    const herdr = fakeHerdr([]);
    const collector = startStatusCollector(recorder().handlers, herdr.deps);
    let live = false;
    void collector.structureReady.then(() => { live = true; });
    try {
      await collector.ready;
      await settled();
      expect(live).toBe(false);
      herdr.lifecycle().start();
      await collector.structureReady;
    } finally { collector.stop(); }
    const reopened = fakeHerdr([]);
    const again = startStatusCollector(recorder().handlers, reopened.deps);
    let reopenedLive = false;
    void again.structureReady.then(() => { reopenedLive = true; });
    try {
      reopened.lifecycle().drop();
      await until(() => reopened.lifecycles().length === 2, "the reopened lifecycle subscription");
      expect(reopenedLive).toBe(false);
      reopened.lifecycle().start();
      await again.structureReady;
    } finally { again.stop(); }
  });

  it("reports a tracked pane missing when the first lifecycle subscription starts", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    const ended: string[] = [];
    handlers.onPaneEnded = (paneId) => ended.push(paneId);
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await collector.ready;
      const tracked = Promise.withResolvers<void>();
      handlers.onReconciled = () => tracked.resolve();
      herdr.setPanes([paneOf("w1:p2", "idle")]);
      collector.trackPane("w1:p2");
      await tracked.promise;
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = () => reconciled.resolve();
      herdr.setPanes([]);
      herdr.lifecycle().start();
      await reconciled.promise;
      expect(ended).toEqual(["w1:p2"]);
    } finally { collector.stop(); }
  });

  it("does not end a pane registered after a missing snapshot was requested", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    const snapshot = Promise.withResolvers<{ panes: HerdrPane[] }>();
    const reconciled = Promise.withResolvers<void>();
    const ended: string[] = [];
    handlers.onPaneEnded = (paneId) => ended.push(paneId);
    handlers.onReconciled = (panes) => { if (panes.length > 0) reconciled.resolve(); };
    let first = true;
    const collector = startStatusCollector(handlers, {
      ...herdr.deps,
      snapshot: () => {
        if (first) { first = false; return snapshot.promise; }
        return Promise.resolve({ panes: [paneOf("w1:p2", "idle")] });
      },
    });
    try {
      collector.trackPane("w1:p2");
      snapshot.resolve({ panes: [] });
      await reconciled.promise;
      expect(ended).toEqual([]);
    } finally { collector.stop(); }
  });

  it("does not replay a tracked exit already delivered by the lifecycle stream", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    const ended: string[] = [];
    handlers.onPaneEnded = (paneId) => ended.push(paneId);
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await collector.ready;
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = () => reconciled.resolve();
      collector.trackPane("w1:p2");
      herdr.lifecycle().emit({ data: { type: "pane_exited", pane_id: "w1:p2" } });
      await reconciled.promise;
      expect(ended).toEqual(["w1:p2"]);
    } finally { collector.stop(); }
  });

  it("cleans up a closed pane without ending it, and a closed tracked pane is not reported ended by a later snapshot", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    const ended: string[] = [];
    const closed: string[] = [];
    handlers.onPaneEnded = (paneId) => ended.push(paneId);
    handlers.onPaneClosed = (paneId) => closed.push(paneId);
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await collector.ready;
      const tracked = Promise.withResolvers<void>();
      handlers.onReconciled = () => tracked.resolve();
      herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
      collector.trackPane("w1:p2");
      await tracked.promise;
      herdr.setPanes([]);
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = () => reconciled.resolve();
      herdr.lifecycle().emit({ data: { type: "pane_closed", pane_id: "w1:p1" } });
      herdr.lifecycle().emit({ data: { type: "pane_closed", pane_id: "w1:p2" } });
      await reconciled.promise;
      expect(closed).toEqual(["w1:p1", "w1:p2"]);
      expect(ended).toEqual([]);
    } finally { collector.stop(); }
  });

  it("does not clean up again a pane whose close follows its exit, but does once its ID is registered anew", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    const ended: string[] = [];
    const closed: string[] = [];
    handlers.onPaneEnded = (paneId) => ended.push(paneId);
    handlers.onPaneClosed = (paneId) => closed.push(paneId);
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await collector.ready;
      herdr.lifecycle().emit({ data: { type: "pane_exited", pane_id: "w1:p1" } });
      herdr.lifecycle().emit({ data: { type: "pane_closed", pane_id: "w1:p1" } });
      expect(ended).toEqual(["w1:p1"]);
      expect(closed).toEqual([]);
      herdr.lifecycle().emit({ data: { type: "pane_exited", pane_id: "w1:p2" } });
      collector.trackPane("w1:p2");
      herdr.lifecycle().emit({ data: { type: "pane_closed", pane_id: "w1:p2" } });
      expect(closed).toEqual(["w1:p2"]);
    } finally { collector.stop(); }
  });

  it("cleans up on close a pane a snapshot showed again after its exit, and once only one it no longer showed", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    const closed: string[] = [];
    handlers.onPaneClosed = (paneId) => closed.push(paneId);
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await collector.ready;
      herdr.lifecycle().emit({ data: { type: "pane_exited", pane_id: "w1:p1" } });
      herdr.lifecycle().emit({ data: { type: "pane_exited", pane_id: "w1:p2" } });
      herdr.setPanes([paneOf("w1:p1", "idle")]);
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = () => reconciled.resolve();
      herdr.lifecycle().emit({ data: { type: "pane_created", pane_id: "w1:p1" } });
      await reconciled.promise;
      herdr.lifecycle().emit({ data: { type: "pane_closed", pane_id: "w1:p1" } });
      herdr.lifecycle().emit({ data: { type: "pane_closed", pane_id: "w1:p2" } });
      expect(closed).toEqual(["w1:p1"]);
    } finally { collector.stop(); }
  });

  const types = [
    "workspace_created", "workspace_updated", "workspace_metadata_updated",
    "workspace_renamed", "workspace_moved", "workspace_reordered", "workspace_closed",
    "worktree_created", "worktree_opened", "worktree_removed",
    "tab_created", "tab_closed", "tab_renamed", "tab_moved",
    "pane_created", "pane_updated", "pane_moved", "layout_updated",
  ];

  it.each(types)("refreshes for %s", (type) => {
    expect(parseStructureFrame({ event: type, data: { type } })).toMatchObject({ kind: "structure-changed" });
  });

  it("coalesces a lifecycle burst into one push and authoritative reconciliation", async () => {
    const herdr = fakeHerdr([]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await collector.ready;
      const calls = herdr.snapshotCalls();
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = () => reconciled.resolve();
      const pushed = Promise.withResolvers<void>();
      handlers.onStructureChange = () => { log.structure += 1; pushed.resolve(); };
      for (const type of types) {
        expect(herdr.lifecycle().types).toContain(type.replace("_", "."));
        herdr.lifecycle().emit({ event: type, data: { type } });
      }
      expect(log.structure).toBe(0);
      await pushed.promise;
      await reconciled.promise;
      expect(log.structure).toBe(1);
      expect(herdr.snapshotCalls()).toBe(calls + 1);
    } finally { collector.stop(); }
  });

  it("reads the panes again when a status event brings a new display_agent, and only then", async () => {
    const herdr = fakeHerdr([{ ...paneOf("w1:p1", "idle"), display_agent: "agent · working" }]);
    const { log, handlers } = recorder();
    const reconciled = Promise.withResolvers<void>();
    handlers.onReconciled = () => reconciled.resolve();
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await until(() => herdr.status() !== undefined, "the status subscription");
      herdr.status()!.start();
      await reconciled.promise;
      const stream = herdr.status()!;
      const line = (display_agent?: string): EventFrame => ({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle", agent: "claude", ...(display_agent === undefined ? {} : { display_agent }) } });
      stream.emit(line("agent · working"));
      // fixed wait: proving no refresh comes for the same line (the debounce is 5 ms)
      await Bun.sleep(30);
      expect(log.structure).toBe(0);
      stream.emit(line("needs a login · 8m ago"));
      await until(() => log.structure === 1, "the refresh for the new line");
      stream.emit(line());
      await until(() => log.structure === 2, "the refresh for no line");
      expect(log.statuses).toEqual(["w1:p1:idle", "w1:p1:idle", "w1:p1:idle"]);
    } finally { collector.stop(); }
  });

  it("reopens the full status set when pane.moved changes IDs without close/create", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    const subscribed = Promise.withResolvers<void>();
    handlers.onReconciled = () => {
      if (herdr.status()?.paneIds.includes("w1:p1")) subscribed.resolve();
    };
    const subscribe = herdr.deps.subscribe;
    if (!subscribe) throw new Error("fake subscribe missing");
    const collector = startStatusCollector(handlers, {
      ...herdr.deps,
      subscribe: (subs, callbacks) => {
        const connection = subscribe(subs, callbacks);
        if (subs.some((sub) => sub.type === "pane.agent_status_changed")) {
          queueMicrotask(() => callbacks.onStarted?.());
        }
        return connection;
      },
    });
    try {
      await collector.ready;
      herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
      herdr.lifecycle().emit({ data: { type: "pane_created" } });
      await subscribed.promise;
      const old = herdr.status();
      if (!old) throw new Error("status stream missing");
      const moved = Promise.withResolvers<void>();
      handlers.onReconciled = (panes) => {
        if (panes.some((pane) => pane.pane_id === "w2:p1")) moved.resolve();
      };
      herdr.setPanes([paneOf("w1:p2", "idle"), paneOf("w2:p1", "idle")]);
      herdr.lifecycle().emit({ data: { type: "pane_moved", previous_pane_id: "w1:p1", pane: { pane_id: "w2:p1", agent_status: "idle" } } });
      await moved.promise;
      expect(old.closedByCollector).toBe(true);
      expect(herdr.status()?.paneIds).toEqual(["w1:p2", "w2:p1"]);
    } finally { collector.stop(); }
  });

  it("tells a move to a new pane ID before the structure change, and no move that keeps the ID (#1503)", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const moves: string[] = [];
    handlers.onPaneMoved = (from, to, status) => moves.push(`${from}->${to} ${status} after ${log.structure} structure changes`);
    const changed = Promise.withResolvers<void>();
    handlers.onStructureChange = () => { log.structure += 1; changed.resolve(); };
    const subscribe = herdr.deps.subscribe;
    if (!subscribe) throw new Error("fake subscribe missing");
    const collector = startStatusCollector(handlers, {
      ...herdr.deps,
      subscribe: (subs, callbacks) => {
        const connection = subscribe(subs, callbacks);
        queueMicrotask(() => callbacks.onStarted?.());
        return connection;
      },
    });
    try {
      await collector.ready;
      herdr.lifecycle().emit({ data: { type: "pane_moved", previous_pane_id: "w1:p1", pane: { pane_id: "w1:p1", agent_status: "idle" } } });
      herdr.lifecycle().emit({ data: { type: "pane_moved", previous_pane_id: "w1:p1", pane: { pane_id: "w2:p1", agent_status: "idle" } } });
      expect(moves).toEqual(["w1:p1->w2:p1 idle after 0 structure changes"]);
      await changed.promise;
    } finally { collector.stop(); }
  });

  for (const status of ["working", "blocked"] as const) it(`replays a completion when a ${status} move overtakes the old-ID status event`, async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const subscribe = herdr.deps.subscribe;
    if (!subscribe) throw new Error("fake subscribe missing");
    const collector = startStatusCollector(handlers, {
      ...herdr.deps,
      subscribe: (subs, callbacks) => {
        const connection = subscribe(subs, callbacks);
        queueMicrotask(() => callbacks.onStarted?.());
        return connection;
      },
    });
    try {
      await collector.ready;
      const old = herdr.status();
      if (!old) throw new Error("status stream missing");
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = (panes) => {
        if (panes.some((pane) => pane.pane_id === "w2:p1")) reconciled.resolve();
      };
      herdr.lifecycle().emit({ data: { type: "pane_moved", previous_pane_id: "w1:p1", pane: { pane_id: "w2:p1", agent_status: status, agent: "claude" } } });
      old.emit(statusFrame("w1:p1", status));
      herdr.setPanes([paneOf("w2:p1", "idle")]);
      await reconciled.promise;
      expect(log.statuses).toEqual([`w1:p1:${status}`, `w2:p1:idle (was ${status})`]);
      expect(old.closedByCollector).toBe(true);
      expect(herdr.status()?.paneIds).toEqual(["w2:p1"]);
    } finally { collector.stop(); }
  });

  it("keeps a finished pane finished when a delayed same-ID move still says working", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const subscribe = herdr.deps.subscribe;
    if (!subscribe) throw new Error("fake subscribe missing");
    const collector = startStatusCollector(handlers, {
      ...herdr.deps,
      subscribe: (subs, callbacks) => {
        const connection = subscribe(subs, callbacks);
        queueMicrotask(() => callbacks.onStarted?.());
        return connection;
      },
    });
    try {
      await collector.ready;
      const stream = herdr.status();
      if (!stream) throw new Error("status stream missing");
      stream.emit(statusFrame("w1:p1", "working"));
      stream.emit(statusFrame("w1:p1", "idle"));
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = (panes) => {
        if (panes.some((pane) => pane.pane_id === "w1:p2")) reconciled.resolve();
      };
      herdr.lifecycle().emit({ data: { type: "pane_moved", previous_pane_id: "w1:p1", pane: { pane_id: "w1:p1", agent_status: "working", agent: "claude" } } });
      herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
      await reconciled.promise;
      expect(log.statuses.filter((entry) => entry.startsWith("w1:p1:idle"))).toHaveLength(1);
    } finally { collector.stop(); }
  });

  it("replays a completion after a working pane moves and finishes before reconciliation", async () => {
    // Verbatim herdr 0.9.3 frame captured on herdr-web-ui-qa-H4.
    const moved: EventFrame = {
      data: {
        closed_tab_id: "w5:t1", closed_workspace_id: "w5",
        created_tab: { agent_status: "working", focused: false, label: "1", number: 1, pane_count: 1, tab_id: "w6:t1", workspace_id: "w6" },
        created_workspace: { active_tab_id: "w6:t1", agent_status: "working", focused: false, label: "H4 working moved", number: 4, pane_count: 1, tab_count: 1, workspace_id: "w6" },
        pane: {
          agent: "codex", agent_status: "working",
          cwd: "/home/devswha/workspace/herdr-web-ui-wt/fix-session-events-refresh",
          focused: false, foreground_cwd: "/home/devswha/workspace/herdr-web-ui-wt/fix-session-events-refresh",
          pane_id: "w6:p1", revision: 0,
          scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 40 },
          tab_id: "w6:t1", terminal_id: "term_65d72f77c76c24", workspace_id: "w6",
        },
        previous_pane_id: "w5:p1", previous_tab_id: "w5:t1", previous_workspace_id: "w5", type: "pane_moved",
      },
      event: "pane_moved",
    };
    const herdr = fakeHerdr([paneOf("w5:p1", "working")]);
    const { log, handlers } = recorder();
    const subscribe = herdr.deps.subscribe;
    if (!subscribe) throw new Error("fake subscribe missing");
    const collector = startStatusCollector(handlers, {
      ...herdr.deps,
      subscribe: (subs, callbacks) => {
        const connection = subscribe(subs, callbacks);
        queueMicrotask(() => callbacks.onStarted?.());
        return connection;
      },
    });
    try {
      await collector.ready;
      const old = herdr.status();
      const reconciled = Promise.withResolvers<void>();
      handlers.onReconciled = (panes) => {
        if (panes.some((pane) => pane.pane_id === "w6:p1")) reconciled.resolve();
      };
      herdr.lifecycle().emit(moved);
      herdr.setPanes([paneOf("w6:p1", "idle")]);
      await reconciled.promise;
      expect(log.statuses).toEqual(["w6:p1:idle (was working)"]);
      expect(old?.closedByCollector).toBe(true);
      expect(herdr.status()?.paneIds).toEqual(["w6:p1"]);
    } finally { collector.stop(); }
  });
});

interface FakeSubscription {
  types: string[];
  paneIds: string[];
  handlers: Parameters<StatusCollectorDeps["subscribe"]>[1];
  closedByCollector: boolean;
  start: () => void;
  emit: (frame: EventFrame) => void;
  drop: (code?: string) => void;
}

function fakeHerdr(initial: HerdrPane[]) {
  const subscriptions: FakeSubscription[] = [];
  let panes = initial;
  const snapshots: { at: number; resolve: () => void }[] = [];
  let calls = 0;
  let autoAnswer = true;
  const deps: Partial<StatusCollectorDeps> = {
    reconnectMinMs: 5,
    reconnectMaxMs: 40,
    backstopMs: 60_000,
    debounceMs: 5,
    snapshotRetryMs: 5,
    replaySettleMs: 5,
    subscribe: (subs, handlers) => {
      const record: FakeSubscription = {
        types: subs.map((sub) => sub.type),
        paneIds: subs.flatMap((sub) => ("pane_id" in sub && typeof sub.pane_id === "string" ? [sub.pane_id] : [])),
        handlers,
        closedByCollector: false,
        start: () => handlers.onStarted?.(),
        emit: (frame) => handlers.onEvent(frame),
        drop: (code = "events_lost") => {
          handlers.onError?.(new HerdrError(code, "event subscription fell behind"));
          handlers.onClose?.();
        },
      };
      subscriptions.push(record);
      return { close: () => { record.closedByCollector = true; } };
    },
    snapshot: () => {
      calls += 1;
      const at = calls;
      return new Promise((resolve) => {
        const answer = () => resolve({ panes });
        if (autoAnswer) queueMicrotask(answer);
        else snapshots.push({ at, resolve: answer });
      });
    },
  };
  return {
    deps,
    subscriptions,
    snapshotCalls: () => calls,
    setPanes: (next: HerdrPane[]) => { panes = next; },
    hold: () => { autoAnswer = false; },
    answerAll: () => { for (const s of snapshots.splice(0)) s.resolve(); },
    status: () => subscriptions.filter((s) => s.types[0] === "pane.agent_status_changed" && !s.closedByCollector).at(-1),
    lifecycle: () => subscriptions.filter((s) => s.types.includes("pane.created")).at(-1)!,
    lifecycles: () => subscriptions.filter((s) => s.types.includes("pane.created")),
  };
}

/** promise chains already under way run to their end: setImmediate is not one of the timers bun fakes */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const elapse = async (ms = 0): Promise<void> => {
  await settled();
  jest.advanceTimersByTime(0);
  await settled();
  for (let step = 0; step < ms; step += 1) {
    jest.advanceTimersByTime(1);
    await settled();
  }
};
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (const deadline = Date.now() + 5_000; !done();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};
const paneOf = (pane_id: string, agent_status: string) => ({ pane_id, agent_status }) as unknown as HerdrPane;
const statusFrame = (pane_id: string, agent_status: string): EventFrame => ({ event: "pane.agent_status_changed", data: { pane_id, agent_status, agent: "claude" } });
function createdFrame(pane_id: string, agent_status: string): EventFrame {
  const [workspace_id] = pane_id.split(":");
  return { event: "pane_created", data: { type: "pane_created", pane: { pane_id, workspace_id, tab_id: `${workspace_id}:t1`, terminal_id: `term_${pane_id}`, agent_status, focused: false, revision: 0 } } };
}

function recorder() {
  const log = {
    baselines: 0,
    created: [] as string[],
    resyncs: [] as { panes: string[]; newer: string[] }[],
    structure: 0,
    statuses: [] as string[],
    order: [] as string[],
  };
  const handlers: StatusCollectorHandlers = {
    onStatus: (paneId, status, _agent, replay) => {
      log.statuses.push(`${paneId}:${status}${replay ? ` (was ${replay.before})` : ""}`);
      log.order.push(`${paneId}:${status}`);
    },
    onBaseline: (_panes, _newer, _askedAt, created) => {
      log.baselines += 1;
      for (const [paneId, status] of new Map(created)) log.created.push(`${paneId}:${status}`);
    },
    onReconciled: (panes) => log.order.push(`reconciled ${panes.map((p) => `${p.pane_id}:${p.agent_status}`).join(" ")}`),
    onResync: (panes, newer) => log.resyncs.push({ panes: panes.map((p) => p.pane_id), newer: [...newer].sort() }),
    onPaneEnded: () => {},
    onStructureChange: () => { log.structure += 1; },
    onFocus: () => {},
  };
  return { log, handlers };
}

describe("a pane created while the collector listens", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  async function listening(panes: HerdrPane[] = [paneOf("w1:p1", "idle")]) {
    const herdr = fakeHerdr(panes);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    return { herdr, log, collector };
  }

  it("hands the status it began with to the first snapshot that reads it, once, and replays from that snapshot as for any pane", async () => {
    const { herdr, log, collector } = await listening();
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "working")]);
    herdr.lifecycle().emit(createdFrame("w2:p1", "unknown"));
    await elapse(20);
    expect(log.created).toEqual(["w2:p1:unknown"]);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "unknown")]);
    herdr.status()!.start();
    await elapse(20);
    // the queue's baseline is the snapshot's working, never the creation's unknown: the end of the turn is told
    expect(log.statuses).toEqual(["w2:p1:unknown (was working)"]);
    collector.refresh();
    await elapse(20);
    expect(log.created).toEqual(["w2:p1:unknown"]);
    collector.stop();
  });

  it("tells none from a snapshot asked for before a workspace or tab closed, nor from a later one: the close's own snapshot may come after the alert's wait", async () => {
    const { herdr, log, collector } = await listening();
    herdr.lifecycle().emit(createdFrame("w2:p1", "unknown"));
    herdr.hold();
    await elapse(20);
    herdr.lifecycle().emit({ event: "tab_closed", data: { type: "tab_closed", tab_id: "w3:t1", workspace_id: "w3" } });
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "blocked")]);
    herdr.answerAll();
    await elapse(20);
    herdr.answerAll();
    await elapse(20);
    expect(log.baselines).toBeGreaterThan(2);
    expect(log.created).toEqual([]);
    collector.stop();
  });

  it("keeps it past a snapshot asked for before its creation was read", async () => {
    const { herdr, log, collector } = await listening();
    herdr.hold();
    collector.refresh();
    await elapse();
    herdr.lifecycle().emit(createdFrame("w2:p1", "unknown"));
    herdr.answerAll();
    await elapse(20);
    expect(log.created).toEqual([]);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "blocked")]);
    herdr.answerAll();
    await elapse(20);
    expect(log.created).toEqual(["w2:p1:unknown"]);
    collector.stop();
  });

  it("hands nothing for one that closed, exited or moved away first, even listed by a snapshot asked for before, nor for a pane a snapshot already read", async () => {
    const { herdr, log, collector } = await listening();
    herdr.hold();
    for (const paneId of ["w2:p1", "w3:p1", "w4:p1", "w1:p1"]) herdr.lifecycle().emit(createdFrame(paneId, "unknown"));
    await elapse(20);
    herdr.lifecycle().emit({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w2:p1" } });
    herdr.lifecycle().emit({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w3:p1" } });
    herdr.lifecycle().emit({ event: "pane_moved", data: { type: "pane_moved", previous_pane_id: "w4:p1", pane: { pane_id: "w5:p1", agent_status: "blocked" } } });
    herdr.setPanes(["w1:p1", "w2:p1", "w3:p1", "w4:p1"].map((paneId) => paneOf(paneId, "blocked")));
    herdr.answerAll();
    await elapse(20);
    expect(log.created).toEqual([]);
    herdr.setPanes(["w1:p1", "w2:p1", "w3:p1", "w5:p1"].map((paneId) => paneOf(paneId, "blocked")));
    herdr.answerAll();
    await elapse(20);
    expect(log.baselines).toBeGreaterThan(2);
    expect(log.created).toEqual([]);
    collector.stop();
  });

  it("forgets it when the lifecycle subscription closes: a herdr started again lists another pane under the same ID", async () => {
    const { herdr, log, collector } = await listening();
    herdr.hold();
    herdr.lifecycle().emit(createdFrame("w2:p1", "unknown"));
    await elapse(20);
    herdr.lifecycle().drop("socket_error");
    await elapse(20);
    herdr.lifecycle().start();
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "blocked")]);
    herdr.answerAll();
    await elapse(20);
    herdr.answerAll();
    await elapse(20);
    expect(log.baselines).toBeGreaterThan(2);
    expect(log.created).toEqual([]);
    collector.stop();
  });

  it("pairs no creation frame read after the lifecycle connection came back with a snapshot asked for before it was lost", async () => {
    const { herdr, log, collector } = await listening();
    herdr.hold();
    collector.refresh();
    await elapse();
    herdr.lifecycle().drop("socket_error");
    await elapse(20);
    herdr.lifecycle().start();
    herdr.lifecycle().emit(createdFrame("w2:p1", "unknown"));
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "blocked")]);
    herdr.answerAll();
    await elapse(20);
    expect(log.created).toEqual([]);
    collector.stop();
  });

  it("forgets it once a snapshot asked for after its creation was read does not list it", async () => {
    const { herdr, log, collector } = await listening();
    herdr.lifecycle().emit(createdFrame("w2:p1", "unknown"));
    await elapse(20);
    expect(log.created).toEqual([]);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "blocked")]);
    collector.refresh();
    await elapse(20);
    expect(log.created).toEqual([]);
    collector.stop();
  });
});

describe("startStatusCollector recovery", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it("snapshots again once the status subscription has started, without resyncing", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    expect(herdr.status()?.paneIds).toEqual(["w1:p1"]);
    expect(herdr.snapshotCalls()).toBe(1);
    herdr.status()!.start();
    await elapse(20);
    expect(herdr.snapshotCalls()).toBe(2);
    expect(log.resyncs).toEqual([]);
    collector.stop();
  });

  it("tells a status that changed while the subscription was reopened for another pane set", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    const first = herdr.status()!;
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(20);
    const second = herdr.status()!;
    expect(second).not.toBe(first);
    expect(second.paneIds).toEqual(["w1:p1", "w2:p1"]);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    expect(log.statuses).toEqual([]);
    log.order.length = 0;
    second.start();
    await elapse(20);
    expect(log.statuses).toEqual(["w1:p1:idle (was working)"]);
    expect(log.resyncs).toEqual([]);
    expect(log.order).toEqual(["w1:p1:idle", "reconciled w1:p1:idle w2:p1:idle"]);
    herdr.hold();
    herdr.lifecycle().emit({ event: "pane_closed", data: { type: "pane_closed" } });
    await elapse(20);
    log.order.length = 0;
    second.emit(statusFrame("w1:p1", "working"));
    herdr.answerAll();
    await elapse();
    expect(log.statuses).toEqual(["w1:p1:idle (was working)", "w1:p1:working"]);
    expect(log.order).toEqual(["w1:p1:working", "reconciled w2:p1:idle"]);
    collector.stop();
  });

  it("tells a change that fell into a subscription herdr refused for a pane that had gone", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w9:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.setPanes([paneOf("w1:p1", "idle")]);
    herdr.status()!.drop("pane_not_found");
    await elapse();
    const reopened = herdr.status()!;
    expect(reopened.paneIds).toEqual(["w1:p1"]);
    reopened.start();
    await elapse(20);
    expect(log.statuses).toEqual(["w1:p1:idle (was working)"]);
    expect(log.resyncs).toEqual([]);
    collector.stop();
  });

  it("tells nothing from a snapshot that follows no gap, nor a finish herdr reads two ways", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, backstopMs: 15 });
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.status()!.emit(statusFrame("w1:p1", "done"));
    herdr.setPanes([paneOf("w1:p1", "idle")]);
    await elapse(40);
    expect(herdr.snapshotCalls()).toBeGreaterThan(2);
    expect(log.statuses).toEqual(["w1:p1:done"]);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(30);
    herdr.status()!.start();
    await elapse(20);
    expect(log.statuses).toEqual(["w1:p1:done", "w1:p1:idle (was done)"]);
    collector.stop();
  });

  it("tells what the snapshot that closes the subscription already shows: the event for it is lost with the connection", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "unknown"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(20);
    expect(log.statuses).toEqual(["w1:p1:unknown (was working)"]);
    herdr.status()!.start();
    await elapse(20);
    expect(log.statuses).toEqual(["w1:p1:unknown (was working)"]);
    collector.stop();
  });

  it("lets an event that was on its way outrank the snapshot that overtook it", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "blocked")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, replaySettleMs: 40 });
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "blocked"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(70);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    const live = herdr.status()!;
    live.start();
    await elapse(10);
    live.emit(statusFrame("w1:p1", "working"));
    live.emit(statusFrame("w1:p1", "idle"));
    await elapse(60);
    expect(log.statuses).toEqual(["w1:p1:working", "w1:p1:idle"]);
    collector.stop();
  });

  it("tells nothing of a pane closed, or once the subscription is lost, while a replay waits", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, replaySettleMs: 40 });
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(70);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle"), paneOf("w2:p1", "idle")]);
    herdr.status()!.start();
    await elapse(10);
    herdr.lifecycle().emit({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p1" } });
    await elapse(60);
    expect(log.statuses).toEqual(["w1:p2:idle (was working)"]);
    collector.stop();

    const lost = fakeHerdr([paneOf("w1:p1", "working")]);
    const second = recorder();
    const other = startStatusCollector(second.handlers, { ...lost.deps, replaySettleMs: 40 });
    await elapse();
    lost.status()!.start();
    await elapse(20);
    lost.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    lost.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(70);
    lost.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    lost.status()!.start();
    await elapse(10);
    lost.status()!.drop();
    await elapse(60);
    expect(second.log.statuses).toEqual([]);
    other.stop();
  });

  it("leaves out of the replay a pane that ended or came to the front while the snapshot was on its way", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle"), paneOf("w2:p1", "idle")]);
    herdr.hold();
    herdr.status()!.start();
    await elapse(20);
    herdr.lifecycle().emit({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p1" } });
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p2" } });
    herdr.answerAll();
    await elapse();
    expect(log.statuses).toEqual([]);
    collector.stop();
  });

  it("forgets what a pane was heard as once it came to the front, and recovers silently when a snapshot fails in a gap", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "idle"), paneOf("w2:p1", "idle")]);
    herdr.status()!.start();
    await elapse(20);
    expect(log.statuses).toEqual(["w1:p2:idle (was working)"]);
    collector.stop();

    const broken = fakeHerdr([paneOf("w1:p1", "working")]);
    const second = recorder();
    let failing = false;
    const snapshot = broken.deps.snapshot!;
    const flaky = startStatusCollector(second.handlers, { ...broken.deps, snapshot: () => failing ? Promise.reject(new HerdrError("timeout", "no answer")) : snapshot() });
    await elapse();
    broken.status()!.start();
    await elapse(20);
    broken.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    broken.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(20);
    failing = true;
    broken.status()!.start();
    await elapse(20);
    broken.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    failing = false;
    await elapse(30);
    expect(second.log.statuses).toEqual([]);
    expect(second.log.resyncs).toHaveLength(1);
    flaky.stop();
  });

  it("still tells the finish of work that was brought to the front while it went on", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(30);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    herdr.status()!.start();
    await elapse(30);
    expect(log.statuses).toEqual(["w1:p1:idle (was working)"]);
    collector.stop();
  });

  it("reads an event still on its way before it closes the connection, also when the snapshot shows nothing to replay", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, replaySettleMs: 40 });
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    const live = herdr.status()!;
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(20);
    expect(live.closedByCollector).toBe(false);
    live.emit(statusFrame("w1:p1", "idle"));
    await elapse(60);
    expect(live.closedByCollector).toBe(true);
    expect(log.statuses).toEqual(["w1:p1:idle"]);
    collector.stop();
  });

  it("recovers without telling when the reopened subscription could not connect", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await elapse(20);
    herdr.status()!.drop("connect_failed");
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    expect(log.statuses).toEqual([]);
    expect(log.resyncs).toHaveLength(1);
    collector.stop();
  });

  it("resubscribes after events_lost and resyncs from a snapshot taken after the start", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    const lost = herdr.status()!;
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "blocked")]);
    lost.drop();
    await elapse();
    const reopened = herdr.status()!;
    expect(reopened).not.toBe(lost);
    expect(log.resyncs).toEqual([]);
    const before = herdr.snapshotCalls();
    reopened.start();
    await elapse(20);
    expect(herdr.snapshotCalls()).toBe(before + 1);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1", "w1:p2"], newer: [] }]);
    expect(log.structure).toBe(1);
    collector.stop();
  });

  it("measures a display_agent event after a recovery against the line the resync showed", async () => {
    const herdr = fakeHerdr([{ ...paneOf("w1:p1", "idle"), display_agent: "A" } as HerdrPane]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    try {
      await elapse();
      herdr.status()!.start();
      await elapse(20);
      expect(log.baselines).toBeGreaterThanOrEqual(2);
      const lost = herdr.status()!;
      herdr.setPanes([{ ...paneOf("w1:p1", "idle"), display_agent: "B" } as HerdrPane]);
      lost.drop();
      await elapse();
      expect(herdr.status()).toBeDefined();
      expect(herdr.status()).not.toBe(lost);
      herdr.status()!.start();
      await elapse(20);
      expect(log.structure).toBe(1);
      herdr.setPanes([{ ...paneOf("w1:p1", "idle"), display_agent: "A" } as HerdrPane]);
      herdr.status()!.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle", agent: "claude", display_agent: "A" } });
      await elapse(20);
      expect(log.structure).toBe(2);
    } finally { collector.stop(); }
  });

  it("still resyncs a pane that only came to the front while the recovery snapshot was on its way", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
    herdr.status()!.drop();
    await elapse();
    herdr.hold();
    herdr.status()!.start();
    await elapse();
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.lifecycle().emit({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p2" } });
    herdr.answerAll();
    await elapse(20);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1", "w1:p2"], newer: ["w1:p2"] }]);
    collector.stop();
  });

  it("leaves out of the resync a pane whose event arrived while the snapshot was on its way", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.status()!.drop();
    await elapse();
    herdr.hold();
    const reopened = herdr.status()!;
    reopened.start();
    await elapse(20);
    reopened.emit(statusFrame("w1:p2", "idle"));
    herdr.answerAll();
    await elapse();
    expect(log.statuses).toEqual(["w1:p2:idle"]);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1", "w1:p2"], newer: ["w1:p2"] }]);
    collector.stop();
  });

  it("reconciles when the lifecycle subscription comes back, not on its first start", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.lifecycle().start();
    await elapse(20);
    expect(log.structure).toBe(0);
    const calls = herdr.snapshotCalls();
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
    herdr.lifecycle().drop();
    await elapse(10);
    expect(herdr.lifecycles().length).toBe(2);
    herdr.lifecycle().start();
    await elapse(20);
    expect(log.structure).toBe(1);
    expect(herdr.snapshotCalls()).toBeGreaterThan(calls);
    expect(herdr.status()?.paneIds).toEqual(["w1:p1", "w1:p2"]);
    collector.stop();
  });

  it("backs off while a subscription keeps closing before it starts, and resets once one starts", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    jest.useFakeTimers();
    let collector: ReturnType<typeof startStatusCollector> | undefined;
    const reopensAfter = (delay: number): void => {
      const count = herdr.lifecycles().length;
      jest.advanceTimersByTime(delay - 1);
      expect(herdr.lifecycles().length).toBe(count);
      jest.advanceTimersByTime(1);
      expect(herdr.lifecycles().length).toBe(count + 1);
    };
    try {
      collector = startStatusCollector(handlers, { ...herdr.deps, reconnectMinMs: 20, reconnectMaxMs: 160 });
      for (const delay of [20, 40, 80, 160, 160]) {
        herdr.lifecycle().drop("connect_failed");
        reopensAfter(delay);
      }
      herdr.lifecycle().start();
      herdr.lifecycle().drop();
      reopensAfter(20);
    } finally {
      collector?.stop();
      jest.useRealTimers();
    }
  });

  it("does not let a snapshot asked for a subscription that closed meanwhile end the recovery", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.status()!.drop();
    await elapse();
    herdr.hold();
    const second = herdr.status()!;
    second.start();
    await elapse(20);
    second.drop();
    await elapse();
    herdr.setPanes([paneOf("w1:p1", "idle")]);
    herdr.answerAll();
    await elapse(10);
    expect(log.resyncs).toEqual([]);
    const third = herdr.status()!;
    expect(third).not.toBe(second);
    third.start();
    for (let i = 0; i < 4; i++) { await elapse(5); herdr.answerAll(); }
    await elapse(10);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1"], newer: [] }]);
    collector.stop();
  });

  it("reconciles when a lifecycle retry starts although the first attempt never did", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
    herdr.lifecycle().drop("connect_failed");
    await elapse(10);
    const calls = herdr.snapshotCalls();
    herdr.lifecycle().start();
    await elapse(20);
    expect(log.structure).toBe(1);
    expect(herdr.snapshotCalls()).toBeGreaterThan(calls);
    collector.stop();
  });

  it("does nothing more once stopped, even mid-recovery", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await elapse();
    herdr.status()!.start();
    await elapse(20);
    herdr.status()!.drop();
    herdr.lifecycle().drop();
    collector.stop();
    const subscriptions = herdr.subscriptions.length;
    await elapse(60);
    expect(herdr.subscriptions.length).toBe(subscriptions);
    expect(log.resyncs).toEqual([]);
  });
});
