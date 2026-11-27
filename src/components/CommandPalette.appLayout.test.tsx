import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { Machine } from "../../shared/machines.ts";
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { CommandPalette } from "./CommandPalette.tsx";

const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } });
const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: tabs, focused: false, agent_status: "idle", worktree: null });
const pane = (id: string, workspaceId: string, tabId: string): PaneInfo =>
  ({ pane_id: id, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle" });
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", agents: [], workspaces: [workspace("w1", 1), workspace("w2", 1)],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "", number: 1, pane_count: 2, focused: true, agent_status: "idle" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "", number: 1, pane_count: 1, focused: false, agent_status: "idle" },
  ],
  panes: [pane("p1", "w1", "w1:t1"), pane("p2", "w1", "w1:t1"), pane("p3", "w2", "w2:t1")],
  layouts: [{
    tab_id: "w1:t1", workspace_id: "w1", focused_pane_id: "p1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } }, { pane_id: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } }],
    splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 100, height: 40 } }],
  }],
};
const machines: Machine[] = [{ id: "local", name: "Host", kind: "local", enabled: true, state: "connected", error: null, snapshot }];
const actionsOf = (offer: LayoutOffer, own: Partial<AppActions> = {}) => new Proxy({ splitPane: offer.split ? () => {} : null, zoomPane: offer.arrange ? () => {} : null, enableNotifications: null, openFiles: null, lock: null, openLocalPage: null, inboxMode: null, closeTab: null, ...own }, { get: (own, key) => key in own ? own[key as keyof typeof own] : () => {} }) as unknown as AppActions;
const LAYOUT_ROWS = ["Rename tab", "Split pane right", "Split pane down", "Split pane right and open it", "Split pane down and open it", "Zoom pane"];

describe("the command palette on a PC the Herdr app lays out", () => {
  let page: Page;
  let htmlElement: PropertyDescriptor | undefined;
  let phone = false;

  beforeEach(() => {
    page = openPage("http://localhost:7317/");
    phone = false;
    Object.defineProperty(page.window, "matchMedia", { configurable: true, value: (query: string) => ({ get matches() { return phone && query.includes("max-height"); }, addEventListener() {}, removeEventListener() {} }) });
    htmlElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
  });

  afterEach(async () => {
    await page.close();
    if (htmlElement) Object.defineProperty(globalThis, "HTMLElement", htmlElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  });

  const listed = (): string[] => [...page.container.querySelectorAll('[class="menu-item-main"]')]
    .filter((node) => node.childNodes.length === 1 && node.firstChild?.nodeType === 3).map((node) => node.textContent ?? "");

  function addDialog(): void {
    const dialog = page.window.document.createElement("section");
    dialog.setAttribute("aria-modal", "true");
    page.window.document.body.append(dialog);
  }

  async function rows(offer: LayoutOffer, selectedPaneId: string, initialQuery: string, actions = actionsOf(offer), shown = snapshot, online = false, inboxMode = false): Promise<string[]> {
    await page.render(null);
    await page.render(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
      createElement(CommandPalette, { open: true, initialQuery, onClose: () => {}, machines, onSelect: () => {}, snapshot: shown, online, selectedPaneId, view: "chat", actions, inboxMode }))));
    return listed();
  }

  it("lists a TUI PC's rename, split, zoom and move rows", async () => {
    const listed = await rows(TUI, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).toContain(row);
    expect(await rows(TUI, "p3", ">move tab")).toEqual(["Move tab to w1"]);
  });

  it("keeps the footer's path line when a settings action replaces a pane under the pointer", async () => {
    await rows(TUI, "p1", "theme");
    const path = () => page.one(".palette-footer-path");
    expect([...path().childNodes]).toEqual([]);
    const first = page.window.document.querySelector('[data-section="settings-pages"] [role="option"]');
    if (!first) throw new Error("No settings option");
    await act(async () => { first.dispatchEvent(new page.window.MouseEvent("mousemove", { bubbles: true })); });
    expect([...path().childNodes]).toEqual([]);
    expect([...page.one(".palette-footer-place").childNodes].map((node) => node.nodeType === 3 ? node.textContent : node)).toEqual(["Appearance"]);
  });

  it("lists Close pane where App offers it, and not when opened over another dialog, where it would close the pane under it", async () => {
    let closes = 0;
    const closing = actionsOf(TUI, { closePane: () => { closes += 1; } });
    expect(await rows(TUI, "p1", ">close pane", closing)).toEqual(["Close pane"]);
    expect(await rows(TUI, "p1", ">close pane", actionsOf(TUI, { closePane: null }))).toEqual([]);
    addDialog();
    expect(await rows(TUI, "p1", ">close pane", closing)).toEqual([]);
    expect(closes).toBe(0);
  });

  it("lists Close tab where App offers it, and not when opened over another dialog (#3751)", async () => {
    const closing = actionsOf(TUI, { closeTab: () => {} });
    expect(await rows(TUI, "p1", ">close tab", closing)).toEqual(["Close tab"]);
    expect(await rows(TUI, "p1", ">close tab")).toEqual([]);
    addDialog();
    expect(await rows(TUI, "p1", ">close tab", closing)).toEqual([]);
  });

  it("keeps Rename tab where a lone tab draws no row, whose dialog stands in for the row's field", async () => {
    phone = true;
    expect(await rows(TUI, "p3", ">rename tab")).toEqual(["Rename tab"]);
  });

  it("lists none of them on a core PC, and keeps New workspace and New tab", async () => {
    const listed = await rows(APP_CORE, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).not.toContain(row);
    expect(listed).toContain("New workspace");
    expect(listed).toContain("New tab");
    expect(await rows(APP_CORE, "p3", ">move tab")).toEqual([]);
  });

  it("offers nothing the inbox mode's shell has no place for: no New tab, Rename tab or sidebar row, in a thread as on the list", async () => {
    const SHELL_ROWS = ["New tab", "Rename tab", "Toggle sidebar", "Filter workspaces and agents"];
    const thread = await rows(TUI, "p1", ">", undefined, snapshot, false, true);
    for (const row of SHELL_ROWS) expect(thread).not.toContain(row);
    for (const row of ["New workspace", "Switch to terminal", "Settings", "Toggle theme"]) expect(thread).toContain(row);
    const classic = await rows(TUI, "p1", ">");
    for (const row of SHELL_ROWS) expect(classic).toContain(row);
  });

  it("lists the way into the agent inbox where it is offered, and the way back while in it", async () => {
    const went: string[] = [];
    expect(await rows(TUI, "p1", ">inbox")).toEqual([]);
    const into = actionsOf(TUI, { inboxMode: { on: false, go: () => { went.push("in"); } } });
    expect(await rows(TUI, "p1", ">open agent inbox", into)).toEqual(["Open agent inbox"]);
    await act(async () => page.one("#palette-item-0").click());
    const out = actionsOf(TUI, { inboxMode: { on: true, go: () => { went.push("out"); } } });
    expect(await rows(TUI, "p1", ">back to ovis", out, snapshot, false, true)).toEqual(["Back to Ovis"]);
    const glyphs = [...page.container.querySelectorAll("#palette-item-0 img")];
    expect(glyphs.map((node) => node.className)).toEqual(["ovis-mark"]);
    await act(async () => page.one("#palette-item-0").click());
    expect(went).toEqual(["in", "out"]);
  });

  it("lists a core PC's rename, split, zoom and move rows where Ovis keeps its layout", async () => {
    const listed = await rows(OVIS_CORE, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).toContain(row);
    expect(await rows(OVIS_CORE, "p3", ">move tab")).toEqual(["Move tab to w1"]);
  });

  it("opens a page this PC serves from a typed address, only where pages open in the app", async () => {
    const opened: string[] = [];
    const pages = actionsOf(TUI, { openLocalPage: (url: string) => { opened.push(url); } });
    expect(await rows(TUI, "p1", ">", pages)).toContain("Open a page on this PC…");
    const listed = await rows(TUI, "p1", "localhost:8448/#/repository", pages);
    expect(listed[0]).toBe("Open localhost:8448/#/repository");
    await act(async () => page.one("#palette-item-0").click());
    expect(opened).toEqual(["http://localhost:8448/#/repository"]);
    expect(await rows(TUI, "p1", "localhost:7317", pages)).not.toContain("Open localhost:7317");
    expect(await rows(TUI, "p1", "localhost:8448")).not.toContain("Open localhost:8448");
    expect(await rows(TUI, "p1", ">")).not.toContain("Open a page on this PC…");
  });

  const checkout = (linked: boolean): SessionSnapshot => ({ ...snapshot, workspaces: [{ ...workspace("w1", 1), worktree: { repo_key: "r", repo_name: "r", repo_root: "/r", checkout_path: linked ? "/r-wt" : "/r", is_linked_worktree: linked } }, workspace("w2", 1)] });
  const workspaceRows = ["New worktree", "Open worktree…", "Earlier sessions…"];
  const answering = () => spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => String(input).includes("worktree/list")
    ? Response.json({ error: { code: "not_a_repository", message: "not a repository" } }, { status: 400 })
    : Response.json({ plugins: [] }), globalThis.fetch));

  it("lists New worktree and Open worktree… for a repository's main checkout, where the PC offers worktrees", async () => {
    const fetched = answering();
    try {
      const worktreeRows = ["New worktree", "Open worktree…"];
      expect((await rows(TUI, "p1", ">", undefined, checkout(false), true)).filter((row) => worktreeRows.includes(row))).toEqual(worktreeRows);
      for (const listed of [await rows(TUI, "p1", ">", undefined, checkout(true), true), await rows(APP_CORE, "p1", ">", undefined, checkout(false), true), await rows(TUI, "p3", ">", undefined, checkout(false), true)]) {
        expect(listed.filter((row) => worktreeRows.includes(row))).toEqual([]);
      }
    } finally {
      fetched.mockRestore();
    }
  });

  it("offers no worktree or earlier-sessions row while the PC is disconnected", async () => {
    const fetched = answering();
    try {
      expect((await rows(TUI, "p1", ">", undefined, checkout(false), true)).filter((row) => workspaceRows.includes(row))).toEqual(workspaceRows);
      expect((await rows(TUI, "p1", ">", undefined, checkout(false), false)).filter((row) => workspaceRows.includes(row))).toEqual([]);
    } finally {
      fetched.mockRestore();
    }
  });

  it("lists them for a repository's folder herdr did not mark, as the sidebar's row menu does once git answers for it", async () => {
    const fetched = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => String(input).includes("workspace_id=w1")
      ? Response.json({ worktrees: [] })
      : Response.json({ error: { code: "not_a_repository", message: "not a repository" } }, { status: 400 }), globalThis.fetch));
    try {
      const worktreeRows = ["New worktree", "Open worktree…"];
      await rows(TUI, "p1", ">", undefined, snapshot, true);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(listed().filter((row) => worktreeRows.includes(row))).toEqual(worktreeRows);
      expect((await rows(TUI, "p3", ">", undefined, snapshot, true)).filter((row) => worktreeRows.includes(row))).toEqual([]);
    } finally {
      fetched.mockRestore();
    }
  });

  it("lists rename and move but no split or zoom on a core that keeps no documents", async () => {
    const named = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: false, move: true, arrange: false, worktrees: true } });
    const listed = await rows(named, "p1", ">");
    expect(listed).toContain("Rename tab");
    for (const row of LAYOUT_ROWS.filter((row) => row !== "Rename tab")) expect(listed).not.toContain(row);
  });
});
