import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { CommandPalette } from "./CommandPalette.tsx";

/** herdr's TUI server, a herdr-core PC the Herdr app lays out, and one whose layout Ovis keeps (lib/machineContext.tsx) */
const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } });
const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: tabs, focused: false, agent_status: "idle", worktree: null });
const pane = (id: string, workspaceId: string, tabId: string): PaneInfo =>
  ({ pane_id: id, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle" });
// w1's tab holds two panes (a zoom means something there); w2's tab holds one (it can move to w1)
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
// App's actions on each PC: split and zoom as the PC offers them (lib/layoutActions.ts, tested there)
const actionsOf = (offer: LayoutOffer, own: Partial<AppActions> = {}) => new Proxy({ splitPane: offer.split ? () => {} : null, zoomPane: offer.arrange ? () => {} : null, enableNotifications: null, openFiles: null, lock: null, openLocalPage: null, ...own }, { get: (own, key) => key in own ? own[key as keyof typeof own] : () => {} }) as unknown as AppActions;
const LAYOUT_ROWS = ["Rename tab", "Split pane right", "Split pane down", "Split pane right and open it", "Split pane down and open it", "Zoom pane"];

describe("the command palette on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  // a cramped screen's height query (CRAMPED_QUERY) holds: a lone tab draws no row there
  let phone = false;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    phone = false;
    const media = (query: string) => ({ get matches() { return phone && query.includes("max-height"); }, addEventListener() {}, removeEventListener() {} });
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    // the test renderer draws no DOM: nothing is an element, so the focus trap finds nothing to hold
    define("HTMLElement", class HTMLElement {});
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: media, location: { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317" }, innerWidth: 1280, innerHeight: 800, history: { state: null, pushState() {}, replaceState() {}, back() {} }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function rows(offer: LayoutOffer, selectedPaneId: string, initialQuery: string, actions = actionsOf(offer), shown = snapshot, online = false): Promise<string[]> {
    await act(async () => { renderer?.unmount(); });
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
        createElement(CommandPalette, { open: true, initialQuery, onClose: () => {}, machines, onSelect: () => {}, snapshot: shown, online, selectedPaneId, view: "chat", actions }))));
    });
    return renderer!.root.findAll((node) => node.props.className === "menu-item-main" && typeof node.props.children === "string").map((node) => node.props.children as string);
  }

  it("lists a TUI PC's rename, split, zoom and move rows", async () => {
    const listed = await rows(TUI, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).toContain(row);
    expect(await rows(TUI, "p3", ">move tab")).toEqual(["Move tab to w1"]);
  });

  it("keeps the footer's path line when a settings action replaces a pane under the pointer", async () => {
    await rows(TUI, "p1", "theme");
    const path = () => renderer!.root.findByProps({ className: "palette-footer-path" });
    // This fixture's pane has no cwd either: the empty path still reserves the second line.
    expect(path().children).toEqual([]);
    const settings = renderer!.root.findByProps({ "data-section": "settings-pages" });
    const first = settings.findAllByProps({ role: "option" })[0]!;
    await act(async () => first.props.onMouseMove());
    expect(path().children).toEqual([]);
    expect(renderer!.root.findByProps({ className: "palette-footer-place" }).children).toEqual(["Appearance"]);
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
    await act(async () => renderer!.root.find((node) => node.props.id === "palette-item-0").props.onClick());
    expect(opened).toEqual(["http://localhost:8448/#/repository"]);
    // the app's own port is the app, not a page beside it
    expect(await rows(TUI, "p1", "localhost:7317", pages)).not.toContain("Open localhost:7317");
    // off by default: Web links open in a new tab, and the palette offers no page
    expect(await rows(TUI, "p1", "localhost:8448")).not.toContain("Open localhost:8448");
    expect(await rows(TUI, "p1", ">")).not.toContain("Open a page on this PC…");
  });

  const checkout = (linked: boolean): SessionSnapshot => ({ ...snapshot, workspaces: [{ ...workspace("w1", 1), worktree: { repo_key: "r", repo_name: "r", repo_root: "/r", checkout_path: linked ? "/r-wt" : "/r", is_linked_worktree: linked } }, workspace("w2", 1)] });
  const workspaceRows = ["New worktree", "Open worktree…", "Earlier sessions…"];
  // the PC answers what the palette reads as it opens: no plugins, and no unmarked folder is a repository
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
    // git answers for w1's folder and refuses w2's, as GET /api/worktree/list does
    const fetched = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => String(input).includes("workspace_id=w1")
      ? Response.json({ worktrees: [] })
      : Response.json({ error: { code: "not_a_repository", message: "not a repository" } }, { status: 400 }), globalThis.fetch));
    try {
      const worktreeRows = ["New worktree", "Open worktree…"];
      await rows(TUI, "p1", ">", undefined, snapshot, true);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      const listed = () => renderer!.root.findAll((node) => node.props.className === "menu-item-main" && typeof node.props.children === "string").map((node) => node.props.children as string);
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
