import { describe, expect, spyOn, test } from "bun:test";
import type { AppActions } from "./actions.ts";
import { appCounted, closeFromPaneMenu, moreFilesRun, type AppCountingState } from "./appCounting.ts";

const offered = { splitPane: () => {}, closePane: () => {}, openFiles: () => {} } as Pick<AppActions, "splitPane" | "closePane" | "openFiles">;
const app = (over: Partial<{ actions: Partial<typeof offered> | Record<string, null>; machineId: string; inboxShown: boolean; inMode: boolean; tabTarget: boolean }> = {}): (() => AppCountingState) => () => ({
  actions: { ...offered, ...over.actions } as typeof offered,
  machineId: over.machineId ?? "local",
  inbox: { shown: over.inboxShown ?? false },
  inMode: over.inMode ?? false,
  tabTarget: over.tabTarget ?? true,
});
const told = (state: () => AppCountingState, taken: [Parameters<ReturnType<typeof appCounted>>[0], Parameters<ReturnType<typeof appCounted>>[1]][]) => {
  const names: string[] = [];
  const counted = appCounted(state, (name) => { names.push(name); });
  for (const [action, source] of taken) counted(action, source);
  return names;
};

describe("App's counting", () => {
  test("counts an action by its source when App can do it, on this PC's own pane", () => {
    expect(told(app(), [["split", "shortcut"], ["files", "menu"], ["new_tab", "palette"], ["sidebar", "button"], ["settings", "menu"]]))
      .toEqual(["split_by_shortcut", "files_by_menu", "new_tab_by_palette", "sidebar_by_button", "settings_by_menu"]);
  });

  test("counts nothing App cannot do now: no split, close or Files offered, no new tab in the inbox or without a workspace, no sidebar in the mode", () => {
    expect(told(app({ actions: { splitPane: null, closePane: null, openFiles: null } }), [["split", "shortcut"], ["close_pane", "palette"], ["files", "menu"]])).toEqual([]);
    expect(told(app({ inboxShown: true }), [["new_tab", "shortcut"], ["sidebar", "shortcut"]])).toEqual(["sidebar_by_shortcut"]);
    expect(told(app({ inMode: true }), [["new_tab", "shortcut"], ["sidebar", "shortcut"]])).toEqual([]);
    expect(told(app({ tabTarget: false }), [["new_tab", "button"]])).toEqual([]);
  });

  test("counts no pane action on another PC's pane", () => {
    expect(told(app({ machineId: "pc-2" }), [["split", "button"], ["close_pane", "menu"], ["new_tab", "shortcut"], ["files", "menu"], ["settings", "button"]])).toEqual(["settings_by_button"]);
  });

  test("a count that fails stands in nobody's way", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => appCounted(app(), () => { throw new Error("storage full"); })("split", "shortcut")).not.toThrow();
      expect(logged).toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  test("Close pane runs the pane menu's Close uncounted, and only one that is not disabled", () => {
    const asked: unknown[] = [];
    const ran: string[] = [];
    const items = (target: string, options?: { counted?: boolean }) => { asked.push(options); return [{ id: "split-right", run: () => ran.push("split") }, { id: "close", run: () => ran.push(`close ${target}`) }]; };
    closeFromPaneMenu(items, "p2");
    expect([asked, ran]).toEqual([[{ counted: false }], ["close p2"]]);
    closeFromPaneMenu(() => [{ id: "close", disabled: true, run: () => ran.push("disabled") }], "p3");
    closeFromPaneMenu(null, "p4");
    expect(ran).toEqual(["close p2"]);
  });

  test("More's Browse files counts as the menu's, and opens even when the count fails", () => {
    const counted: string[] = [];
    let opened = 0;
    moreFilesRun((action, source) => { counted.push(`${action}:${source}`); }, () => { opened += 1; })();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try { moreFilesRun(() => { throw new Error("storage full"); }, () => { opened += 1; })(); } finally { logged.mockRestore(); }
    expect([counted, opened]).toEqual([["files:menu"], 2]);
  });
});
