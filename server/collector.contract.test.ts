import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { startStatusCollector } from "./collector.ts";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("socket lifecycle changes reach WebSocket clients", () => {
  let app: ReturnType<typeof createServer>;
  let workspace: Awaited<ReturnType<typeof workspaceCreate>>;
  let ws: WebSocket;
  let movedWorkspace: string | undefined;
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-collector-contract-"));

  function nextFrame(type: string, matches: (frame: ServerMessage) => boolean = () => true, timeoutMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", onMessage);
        reject(new Error(`No matching ${type} frame within ${timeoutMs} ms`));
      }, timeoutMs);
      function onMessage(event: MessageEvent) {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== type || !matches(frame)) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve();
      }
      ws.addEventListener("message", onMessage);
    });
  }

  beforeAll(async () => {
    workspace = await workspaceCreate({ cwd: stateDir, label: "ovis-test-collector-lifecycle" });
    // A single-pane zoom can only change focus, not the layout. Split before
    // starting the app so its lifecycle frame cannot satisfy the zoom matcher.
    await herdrRpc("pane.split", { target_pane_id: workspace.root_pane.pane_id, direction: "right", cwd: stateDir, focus: false });
    app = createServer({ port: 0, stateDir });
    await app.statusReady;
    ws = new WebSocket(`ws://localhost:${app.port}/ws`);
    await nextFrame("snapshot");
  });

  afterAll(async () => {
    ws?.close();
    app?.stop();
    if (movedWorkspace) await workspaceClose(movedWorkspace);
    if (workspace) await workspaceClose(workspace.workspace.workspace_id);
    rmSync(stateDir, { recursive: true, force: true });
  });

  for (const method of ["workspace.rename", "tab.rename", "pane.zoom"]) {
    it(`pushes session-changed within one second after ${method} over the socket`, async () => {
      const params = method === "workspace.rename"
        ? { workspace_id: workspace.workspace.workspace_id, label: "collector-renamed-workspace" }
        : method === "tab.rename"
          ? { tab_id: workspace.tab.tab_id, label: "collector-renamed-tab" }
          : { pane_id: workspace.root_pane.pane_id, mode: "on" };
      const changed = nextFrame("session-changed");
      const started = performance.now();
      const result = await herdrRpc(method, params);
      if (method === "pane.zoom") expect(result).toMatchObject({ zoom: { changed: true, zoom_changed: true } });
      await changed;
      expect(performance.now() - started).toBeLessThan(1000);
      if (method === "pane.zoom") {
        const restored = nextFrame("session-changed");
        await herdrRpc("pane.zoom", { pane_id: workspace.root_pane.pane_id, mode: "off" });
        await restored;
      }
    });
  }

  it("tells browsers of a completion after a working pane moves before reconciliation", async () => {
    const working = nextFrame("pane-status", (frame) => frame.type === "pane-status" && frame.pane_id === workspace.root_pane.pane_id && frame.agent_status === "working");
    await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "working" });
    await working;
    const { move_result } = await herdrRpc<{ move_result: { changed: boolean; pane: { pane_id: string; workspace_id: string } } }>("pane.move", {
      pane_id: workspace.root_pane.pane_id, destination: { type: "new_workspace", label: "ovis-test-moved-completion" }, focus: false,
    });
    expect(move_result.changed).toBe(true);
    expect(move_result.pane.pane_id).not.toBe(workspace.root_pane.pane_id);
    movedWorkspace = move_result.pane.workspace_id;
    const completed = nextFrame("pane-status", (frame) => frame.type === "pane-status" && frame.pane_id === move_result.pane.pane_id && frame.agent_status === "done", 2000);
    await herdrRpc("pane.report_agent", { pane_id: move_result.pane.pane_id, source: "manual", agent: "codex", state: "idle" });
    await completed;
  });
});

describe("completion replay across a moved subscription key", () => {
  it("replays the finish when a working move overtakes a queued old-ID status event", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-test-moved-gap-"));
    const workspace = await workspaceCreate({ cwd: root, label: "ovis-test-moved-gap" });
    let workspaceId = workspace.workspace.workspace_id;
    const statuses: { paneId: string; before: string | undefined }[] = [];
    await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "idle" });
    const queued = Promise.withResolvers<void>();
    const moved = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let moving = false;
    let delayedWorking: (() => void) | undefined;
    let reconciled = Promise.withResolvers<void>();
    const collector = startStatusCollector({
      onStatus(paneId, status, _agent, replay) {
        statuses.push({ paneId, before: replay?.before });
      },
      onBaseline() {},
      onPaneEnded() {},
      onStructureChange() {},
      onReconciled(panes) {
        if (panes.some((pane) => pane.workspace_id === workspaceId && pane.agent_status !== "working")) reconciled.resolve();
      },
    }, {
      async snapshot() {
        // No timing luck: reconciliation can read the moved pane only after
        // it finishes, even if the machine stalls beyond the debounce.
        if (moving) await finished.promise;
        return sessionSnapshot();
      },
      subscribe(subs, handlers, ...rest) {
        const subscribedIds = new Set(subs.flatMap((sub) => "pane_id" in sub ? [sub.pane_id] : []));
        return subscribeEvents(subs, {
          ...handlers,
          onEvent(frame) {
            const data = frame.data as { type?: string; pane_id?: string; agent_status?: string };
            if (frame.event === "pane.agent_status_changed" && data.pane_id === workspace.root_pane.pane_id && data.agent_status === "working") {
              // Hold the old connection's event until the lifecycle connection
              // has delivered the move, preserving the real frame and callbacks.
              delayedWorking = () => handlers.onEvent(frame);
              queued.resolve();
              return;
            }
            // Model the known move gap: a stream opened for the old ID gives no
            // guarantee of delivery for the new ID until the collector reopens it.
            if (frame.event === "pane.agent_status_changed") {
              const data = frame.data as { pane_id: string };
              if (!subscribedIds.has(data.pane_id)) return;
            }
            handlers.onEvent(frame);
            if (data.type === "pane_moved") {
              delayedWorking?.();
              moved.resolve();
            }
          },
        }, ...rest);
      },
    });
    try {
      await collector.ready;
      await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "working" });
      await queued.promise;
      expect(statuses).toEqual([]);
      moving = true;
      const { move_result } = await herdrRpc<{ move_result: { pane: { pane_id: string; workspace_id: string } } }>("pane.move", {
        pane_id: workspace.root_pane.pane_id, destination: { type: "new_workspace", label: "ovis-test-moved-gap" }, focus: false,
      });
      workspaceId = move_result.pane.workspace_id;
      await moved.promise;
      expect(statuses).toEqual([{ paneId: workspace.root_pane.pane_id, before: undefined }]);
      statuses.length = 0;
      reconciled = Promise.withResolvers<void>();
      await herdrRpc("pane.report_agent", { pane_id: move_result.pane.pane_id, source: "manual", agent: "codex", state: "idle" });
      finished.resolve();
      await reconciled.promise;
      expect(statuses).toEqual([{ paneId: move_result.pane.pane_id, before: "working" }]);
    } finally {
      finished.resolve();
      collector.stop();
      await workspaceClose(workspaceId);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a pane moved to another workspace outside this server (#1503)", () => {
  it("tells clients both IDs before the structure change, and a new-ID attach is not held by the old-ID one", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-test-moved-ids-"));
    let source: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let target: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let app: ReturnType<typeof createServer> | undefined;
    const sockets: WebSocket[] = [];
    const open = async (frames: ServerMessage[]): Promise<WebSocket> => {
      const ws = new WebSocket(`ws://localhost:${app!.port}/ws`);
      sockets.push(ws);
      const snapshot = Promise.withResolvers<void>();
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        frames.push(frame);
        if (frame.type === "snapshot") snapshot.resolve();
      });
      await snapshot.promise;
      return ws;
    };
    const until = (frames: ServerMessage[], matches: (frame: ServerMessage) => boolean, ws: WebSocket, what: string, timeoutMs = 5000): Promise<void> => new Promise((resolve, reject) => {
      if (frames.some(matches)) { resolve(); return; }
      const timer = setTimeout(() => { ws.removeEventListener("message", check); reject(new Error(`no ${what} within ${timeoutMs} ms`)); }, timeoutMs);
      function check() { if (!frames.some(matches)) return; clearTimeout(timer); ws.removeEventListener("message", check); resolve(); }
      ws.addEventListener("message", check);
    });
    try {
      source = await workspaceCreate({ cwd: stateDir, label: "ovis-test-moved-ids-source" });
      // a second pane keeps the source workspace open after the move
      await herdrRpc("pane.split", { target_pane_id: source.root_pane.pane_id, direction: "right", cwd: stateDir, focus: false });
      target = await workspaceCreate({ cwd: stateDir, label: "ovis-test-moved-ids-target" });
      app = createServer({ port: 0, stateDir });
      await app.statusReady;
      const from = source.root_pane.pane_id;
      const mover: ServerMessage[] = [], stayer: ServerMessage[] = [];
      const moverWs = await open(mover), stayerWs = await open(stayer);
      // both show the pane's terminal; the second keeps its old-ID attach after the move
      for (const ws of [moverWs, stayerWs]) ws.send(JSON.stringify({ type: "attach", pane_id: from, cols: 80, rows: 24 }));
      await until(mover, (frame) => frame.type === "input-ready" && frame.pane_id === from, moverWs, "old-ID input-ready");
      await until(stayer, (frame) => frame.type === "input-ready" && frame.pane_id === from, stayerWs, "old-ID input-ready");
      mover.length = 0;
      // the RPC behind `herdr pane move <pane> --new-tab --workspace <id>` in herdr's own window
      const { move_result } = await herdrRpc<{ move_result: { pane: { pane_id: string } } }>("pane.move", {
        pane_id: from, destination: { type: "new_tab", workspace_id: target.workspace.workspace_id }, focus: false,
      });
      const to = move_result.pane.pane_id;
      expect(to).not.toBe(from);
      await until(mover, (frame) => frame.type === "session-changed", moverWs, "session-changed");
      const moved = mover.findIndex((frame) => frame.type === "pane-moved");
      expect(mover[moved]).toEqual({ type: "pane-moved", from, to });
      expect(moved).toBeLessThan(mover.findIndex((frame) => frame.type === "session-changed"));
      moverWs.send(JSON.stringify({ type: "detach", pane_id: from }));
      moverWs.send(JSON.stringify({ type: "attach", pane_id: to, cols: 80, rows: 24 }));
      await until(mover, (frame) => frame.type === "input-ready" && frame.pane_id === to, moverWs, "new-ID input-ready");
      expect(mover.filter((frame) => frame.type === "error" && frame.code === "attach_held")).toEqual([]);
    } finally {
      for (const ws of sockets) ws.close();
      app?.stop();
      if (target) await workspaceClose(target.workspace.workspace_id).catch(() => {});
      if (source) await workspaceClose(source.workspace.workspace_id).catch(() => {});
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 20000);
});
