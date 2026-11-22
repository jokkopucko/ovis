import { expect, it } from "bun:test";
import type { PaneLayoutSnapshot, PaneSplit, SessionSnapshot, WorkspaceCreated } from "../shared/protocol.ts";

it("the demo preserves native split paths, explicit swaps, moves beside a pane and focus while zoomed", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?pane-layout";
    await import(transport);
    const demo = (globalThis as any).window;
    const post = async (path: string, body: unknown): Promise<Response> => demo.fetch(`/api/${path}`, { method: "POST", body: JSON.stringify(body) });
    const snapshot = async (): Promise<SessionSnapshot> => (await (await demo.fetch("/api/session")).json()).snapshot;
    const made = (await (await post("workspace/create", { cwd: "/home/demo/layout-check", label: "layout-check" })).json()) as WorkspaceCreated;
    const root = made.pane_id;
    const tabId = `${made.workspace_id}:t1`;
    const split = async (pane_id: string, direction: "right" | "down") => ((await (await post("pane/split", { pane_id, direction })).json()) as PaneSplit).pane.pane_id;
    const bottom = await split(root, "down");
    const topRight = await split(root, "right");
    const bottomRight = await split(bottom, "right");
    const layout = async () => (await snapshot()).layouts.find((candidate) => candidate.tab_id === tabId)!;
    const rect = (tab: PaneLayoutSnapshot, id: string) => tab.panes.find((pane) => pane.pane_id === id)!.rect;
    let state = await layout();
    expect(state.splits.map((split) => split.id)).toEqual(["split_0_root", "split_1_0", "split_2_1"]);
    const topBefore = rect(state, root);
    expect(await (await post("layout/ratio", { tab_id: tabId, path: [true], ratio: 0.75 })).json()).toEqual({ ok: true });
    state = await layout();
    expect(rect(state, root)).toEqual(topBefore);
    expect(rect(state, bottom).width).toBe(90);
    expect(rect(state, bottomRight).width).toBe(30);
    const beforeSwap = state;
    expect(await (await post("pane/swap", { pane_id: root, target_pane_id: bottomRight })).json()).toEqual({ ok: true, changed: true, reason: null, target_pane_id: bottomRight });
    state = await layout();
    expect(rect(state, root)).toEqual(rect(beforeSwap, bottomRight));
    expect(rect(state, bottomRight)).toEqual(rect(beforeSwap, root));
    await post("pane/zoom", { pane_id: root, mode: "on" });
    expect(await (await post("pane/focus", { pane_id: topRight })).json()).toEqual({ ok: true });
    state = await layout();
    expect(state.zoomed).toBe(true);
    expect(state.focused_pane_id).toBe(topRight);
    const focused = await snapshot();
    expect(focused.focused_tab_id).toBe(tabId);
    expect(focused.focused_workspace_id).toBe(made.workspace_id);
    expect(focused.focused_pane_id).toBe(topRight);
    expect(focused.panes.filter((pane) => pane.focused).map((pane) => pane.pane_id)).toEqual([topRight]);
    expect((await post("pane/swap", { pane_id: root, direction: "right", target_pane_id: bottom })).status).toBe(400);
    expect((await post("layout/ratio", { tab_id: tabId, path: [true, true], ratio: 0.5 })).status).toBe(404);
    expect((await post("layout/ratio", { tab_id: tabId, path: [0], ratio: 0.5 })).status).toBe(400);
    expect((await post("layout/ratio", { tab_id: tabId, path: [], ratio: 1 })).status).toBe(400);
    expect((await post("pane/focus", null)).status).toBe(400);
    const moving = ((await (await post("workspace/create", { cwd: "/home/demo/move-check", label: "move-check" })).json()) as WorkspaceCreated).pane_id;
    const moveTab = (await snapshot()).panes.find((pane) => pane.pane_id === moving)!.tab_id;
    const target = await split(moving, "right");
    for (const side of ["down", "up", "right", "left"] as const) {
      // a zoomed tab shows every pane again, as herdr-core's move makes it, so the moved one is in view
      await post("pane/zoom", { pane_id: target, mode: "on" });
      expect(await (await post("pane/move", { pane_id: moving, target_pane_id: target, side })).json()).toEqual({ ok: true, changed: true, reason: null });
      const tab = (await snapshot()).layouts.find((candidate) => candidate.tab_id === moveTab)!;
      expect(tab.zoomed).toBe(false);
      const [pane, beside] = [rect(tab, moving), rect(tab, target)];
      expect({ left: pane.x < beside.x, right: pane.x > beside.x, up: pane.y < beside.y, down: pane.y > beside.y }[side]).toBe(true);
      expect(tab.panes.map((candidate) => candidate.pane_id).sort()).toEqual([moving, target].sort());
    }
    expect(await (await post("pane/move", { pane_id: moving, target_pane_id: moving, side: "left" })).json()).toEqual({ ok: true, changed: false, reason: "same_pane" });
    expect(await (await post("pane/move", { pane_id: moving, target_pane_id: root, side: "left" })).json()).toEqual({ ok: true, changed: false, reason: "cross_tab" });
    expect((await post("pane/move", { pane_id: moving, target_pane_id: target, side: "middle" })).status).toBe(400);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
