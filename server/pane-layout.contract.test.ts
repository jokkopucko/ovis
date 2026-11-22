import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ApiError, PaneLayoutSnapshot, PaneResized, PaneSplit, PaneSwapped, PaneZoomed, SessionSnapshot } from "../shared/protocol.ts";

let server: { port: number; stop: () => void };
const stateDir = mkdtempSync(join(tmpdir(), "ovis-layout-contract-"));
let workspaceId: string;
let root: string;

beforeAll(async () => {
  server = createServer({ port: 0, stateDir });
  const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-layout" });
  workspaceId = created.workspace.workspace_id;
  root = created.root_pane.pane_id;
});

afterAll(async () => {
  server?.stop();
  if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
  rmSync(stateDir, { recursive: true, force: true });
});

const base = () => `http://localhost:${server.port}`;
const ROUTES = ["split", "zoom", "swap", "resize", "clear"] as const;
const postRaw = (route: string, body: string) => fetch(`${base()}/api/pane/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body });
const post = (route: string, body: unknown) => postRaw(route, JSON.stringify(body));
const code = async (response: Response): Promise<string> => ((await response.json()) as ApiError).error.code;

async function layout(): Promise<PaneLayoutSnapshot> {
  const session = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
  const found = session.snapshot.layouts.find((candidate) => candidate.workspace_id === workspaceId);
  if (!found) throw new Error(`no layout for workspace ${workspaceId}`);
  return found;
}
const rectOf = (tab: PaneLayoutSnapshot, paneId: string) => {
  const pane = tab.panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new Error(`pane ${paneId} is not in the layout`);
  return pane.rect;
};
async function untilLayout(check: (tab: PaneLayoutSnapshot) => boolean, label: string): Promise<PaneLayoutSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const tab = await layout();
    if (check(tab)) return tab;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}: ${JSON.stringify(tab)}`);
    await Bun.sleep(100);
  }
}

describe("pane layout routes: validation", () => {
  it("refuses anything but a POST with a JSON object naming the pane, before any RPC", async () => {
    for (const route of ROUTES) {
      expect((await fetch(`${base()}/api/pane/${route}`)).status).toBe(400);
      expect(await code(await postRaw(route, "not json"))).toBe("invalid_json");
      for (const body of [null, [], "text", 42, true]) {
        const response = await post(route, body);
        expect(response.status).toBe(400);
        expect(await code(response)).toBe("invalid_body");
      }
      for (const pane_id of [undefined, null, "", "  ", 5, true]) {
        const response = await post(route, { pane_id, direction: "right" });
        expect(response.status).toBe(400);
        expect(await code(response)).toBe("missing_pane_id");
      }
    }
  });

  it("refuses a side, a focus, a mode or an amount herdr would not take", async () => {
    for (const [route, body, expected] of [
      ["split", { pane_id: root, direction: "left" }, "invalid_direction"],
      ["split", { pane_id: root }, "invalid_direction"],
      ["split", { pane_id: root, direction: "right", focus: "yes" }, "invalid_focus"],
      ["zoom", { pane_id: root, mode: "sideways" }, "invalid_mode"],
      ["swap", { pane_id: root, direction: "diagonal" }, "invalid_direction"],
      ["swap", { pane_id: root }, "invalid_direction"],
      ["resize", { pane_id: root, direction: "wider" }, "invalid_direction"],
      ["resize", { pane_id: root, direction: "left", amount: 0 }, "invalid_amount"],
      ["resize", { pane_id: root, direction: "left", amount: 1.5 }, "invalid_amount"],
      // herdr would quietly take half of this: refused instead (shared/protocol.ts)
      ["resize", { pane_id: root, direction: "left", amount: 0.75 }, "invalid_amount"],
      ["resize", { pane_id: root, direction: "left", amount: "0.1" }, "invalid_amount"],
    ] as const) {
      const response = await post(route, body);
      expect(response.status).toBe(400);
      expect(await code(response)).toBe(expected);
    }
    expect((await layout()).panes.map((pane) => pane.pane_id)).toEqual([root]);
  });

  it("answers herdr's pane_not_found in the error envelope for an unknown pane on every route", async () => {
    for (const route of ROUTES) {
      const response = await post(route, { pane_id: "no-such-pane", direction: route === "split" ? "right" : "left" });
      expect(response.status).toBe(404);
      const body = (await response.json()) as ApiError;
      expect(body.error.code).toBe("pane_not_found");
      expect(typeof body.error.message).toBe("string");
    }
  });

  it("refuses a cross-origin change on every route", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-layout-origin-"));
    const instance = createServer({ port: 0, stateDir: state, token: "", tailscaleOwner: null, machines: false });
    try {
      for (const route of ROUTES) {
        const response = await fetch(`http://127.0.0.1:${instance.port}/api/pane/${route}`, {
          method: "POST", headers: { origin: "http://other.example", "content-type": "text/plain" }, body: JSON.stringify({ pane_id: root, direction: "right" }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
      }
    } finally { instance.stop(); rmSync(state, { recursive: true, force: true }); }
    expect((await layout()).panes.map((pane) => pane.pane_id)).toEqual([root]);
  });
});

describe("pane layout routes: herdr's layout changes", () => {
  let right: string;
  let below: string;
  let nested: string;

  it("splits a pane to the right and leaves herdr's focus where it was", async () => {
    const before = rectOf(await layout(), root);
    const response = await post("split", { pane_id: root, direction: "right" });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as PaneSplit;
    expect(answer.ok).toBe(true);
    right = answer.pane.pane_id;
    expect(right).not.toBe(root);
    expect(answer.pane.workspace_id).toBe(workspaceId);
    expect(answer.pane.focused).toBe(false);
    const tab = await untilLayout((candidate) => candidate.panes.length === 2, "the second pane in the layout");
    const rootRect = rectOf(tab, root);
    const rightRect = rectOf(tab, right);
    expect(rightRect.x).toBe(rootRect.x + rootRect.width);
    expect(rightRect.y).toBe(before.y);
    expect(rightRect.height).toBe(before.height);
    expect(rootRect.width + rightRect.width).toBe(before.width);
    expect(tab.focused_pane_id).toBe(root);
    expect(tab.zoomed).toBe(false);
  });

  it("splits a pane downwards and moves herdr's focus to the new pane when asked", async () => {
    const before = rectOf(await layout(), right);
    const response = await post("split", { pane_id: right, direction: "down", focus: true });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as PaneSplit;
    below = answer.pane.pane_id;
    expect(answer.pane.focused).toBe(true);
    const tab = await untilLayout((candidate) => candidate.panes.length === 3 && candidate.focused_pane_id === below, "the third pane, focused");
    const rightRect = rectOf(tab, right);
    const belowRect = rectOf(tab, below);
    expect(belowRect.y).toBe(rightRect.y + rightRect.height);
    expect(belowRect.x).toBe(before.x);
    expect(belowRect.width).toBe(before.width);
    expect(rightRect.height + belowRect.height).toBe(before.height);
    expect(rectOf(tab, root).height).toBe(before.height);
  });

  it("zooms a pane, says so when it already is, and unzooms it", async () => {
    const zoomed = await post("zoom", { pane_id: root });
    expect(zoomed.status).toBe(200);
    expect((await zoomed.json()) as PaneZoomed).toEqual({ ok: true, zoomed: true, changed: true, reason: null });
    // herdr focuses the pane it zooms: the tab shows that one alone
    await untilLayout((tab) => tab.zoomed && tab.focused_pane_id === root, "the layout zoomed on the root");
    const again = (await (await post("zoom", { pane_id: root, mode: "on" })).json()) as PaneZoomed;
    expect(again).toEqual({ ok: true, zoomed: true, changed: false, reason: "already_zoomed" });
    const off = (await (await post("zoom", { pane_id: root, mode: "off" })).json()) as PaneZoomed;
    expect(off).toEqual({ ok: true, zoomed: false, changed: true, reason: null });
    await untilLayout((tab) => !tab.zoomed, "the layout unzoomed");
    const offAgain = (await (await post("zoom", { pane_id: root, mode: "off" })).json()) as PaneZoomed;
    expect(offAgain).toEqual({ ok: true, zoomed: false, changed: false, reason: "already_unzoomed" });
  });

  it("shows another pane of a zoomed tab alone on an explicit on, where herdr's toggle would unzoom the tab", async () => {
    // herdr focuses the pane before it reads the mode (0.9.3 apply_pane_zoom), which is what the
    // web's Zoom pane item relies on when it sends `on` for a pane other than the one shown alone
    expect((await (await post("zoom", { pane_id: root, mode: "on" })).json()) as PaneZoomed).toMatchObject({ zoomed: true, changed: true });
    await untilLayout((tab) => tab.zoomed && tab.focused_pane_id === root, "the layout zoomed on the root");
    const other = (await (await post("zoom", { pane_id: right, mode: "on" })).json()) as PaneZoomed;
    expect(other).toEqual({ ok: true, zoomed: true, changed: true, reason: "already_zoomed" });
    await untilLayout((tab) => tab.zoomed && tab.focused_pane_id === right, "the layout zoomed on the right pane");
    // a toggle on a third pane does not show it alone: it unzooms the tab, which is why no UI sends one
    const toggled = (await (await post("zoom", { pane_id: below, mode: "toggle" })).json()) as PaneZoomed;
    expect(toggled).toEqual({ ok: true, zoomed: false, changed: true, reason: null });
    await untilLayout((tab) => !tab.zoomed && tab.focused_pane_id === below, "the layout unzoomed, the third pane focused");
  });

  it("swaps a pane with its neighbour on that side, and reports when it has none", async () => {
    const before = await layout();
    const response = await post("swap", { pane_id: root, direction: "right" });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as PaneSwapped;
    expect(answer.ok).toBe(true);
    expect(answer.changed).toBe(true);
    expect(answer.reason).toBeNull();
    const target = answer.target_pane_id ?? "";
    expect([right, below]).toContain(target);
    const tab = await untilLayout((candidate) => rectOf(candidate, root).x !== rectOf(before, root).x, "the root in the right column");
    expect(rectOf(tab, root)).toEqual(rectOf(before, target));
    expect(rectOf(tab, target)).toEqual(rectOf(before, root));
    const other = target === right ? below : right;
    expect(rectOf(tab, other)).toEqual(rectOf(before, other));
    const none = (await (await post("swap", { pane_id: root, direction: "right" })).json()) as PaneSwapped;
    expect(none).toEqual({ ok: true, changed: false, reason: "no_neighbor", target_pane_id: null });
  });

  it("moves a split's border by the share asked, and says when no border can move that way", async () => {
    const before = await layout();
    // the root now sits in the right column, over or under another pane: the border between
    // them moves up by a quarter of their split, which spans the tab's height here (the next
    // case has a split that does not); herdr's own 0.05 when no amount is given
    const response = await post("resize", { pane_id: root, direction: "up", amount: 0.25 });
    expect(response.status).toBe(200);
    expect((await response.json()) as PaneResized).toEqual({ ok: true, changed: true, reason: null });
    const tab = await untilLayout((candidate) => rectOf(candidate, root).height !== rectOf(before, root).height, "the root's height changed");
    const rows = Math.round(before.area.height * 0.25);
    expect(Math.abs(rectOf(tab, root).height - rectOf(before, root).height)).toBe(rows);
    const column = tab.panes.find((pane) => pane.rect.height === tab.area.height)!;
    expect(column).toBeDefined();
    const unchanged = (await (await post("resize", { pane_id: column.pane_id, direction: "up" })).json()) as PaneResized;
    expect(unchanged).toEqual({ ok: true, changed: false, reason: "unchanged" });
    const columnBefore = column.rect.width;
    const narrower = (await (await post("resize", { pane_id: column.pane_id, direction: "left" })).json()) as PaneResized;
    expect(narrower).toEqual({ ok: true, changed: true, reason: null });
    await untilLayout((candidate) => rectOf(candidate, column.pane_id).width < columnBefore, "the left column narrower");
  });

  it("takes the amount on the split the border belongs to, not on the tab", async () => {
    const column = rectOf(await layout(), root);
    const response = await post("split", { pane_id: root, direction: "right" });
    expect(response.status).toBe(200);
    nested = ((await response.json()) as PaneSplit).pane.pane_id;
    const split = await untilLayout((candidate) => candidate.panes.length === 4, "the fourth pane in the layout");
    const rootBefore = rectOf(split, root).width;
    const quarter = (await (await post("resize", { pane_id: root, direction: "right", amount: 0.25 })).json()) as PaneResized;
    expect(quarter).toEqual({ ok: true, changed: true, reason: null });
    const tab = await untilLayout((candidate) => rectOf(candidate, root).width !== rootBefore, "the root's width changed");
    // a quarter of the column (herdr rounds the ratio onto the column's cells), nowhere near a quarter of the tab
    const moved = rectOf(tab, root).width - rootBefore;
    expect(Math.abs(moved - column.width * 0.25)).toBeLessThanOrEqual(2);
    expect(Math.abs(moved - tab.area.width * 0.25)).toBeGreaterThan(5);
    expect(rectOf(tab, root).x).toBe(column.x);
    expect(rectOf(tab, root).width + rectOf(tab, nested).width).toBe(column.width);
  });

  it("clears the pane's screen and the pane stays", async () => {
    const marker = `ovis-clear-${Date.now().toString(36)}`;
    const untilScreen = async (check: (text: string) => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { text } = await paneRead({ paneId: root, source: "visible", format: "text" });
        if (check(text)) return;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}: ${JSON.stringify(text.slice(-400))}`);
        await Bun.sleep(100);
      }
    };
    await paneSendText(root, `echo ${marker}`);
    await paneSendKeys(root, ["Enter"]);
    await untilScreen((text) => text.includes(marker), "the marker on the root's screen");
    const response = await post("clear", { pane_id: root });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await untilScreen((text) => !text.includes(marker), "the root's screen without the marker");
    expect((await layout()).panes.map((pane) => pane.pane_id).sort()).toEqual([root, right, below, nested].sort());
  });
});
