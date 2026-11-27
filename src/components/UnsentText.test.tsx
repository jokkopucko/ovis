import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { UnsentTextDialog } from "./UnsentText.tsx";

describe("UnsentTextDialog", () => {
  let page: Page;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    page = openPage("http://ovis.test/");
    for (const key of ["localStorage", "HTMLElement"] as const) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value: page.window[key] });
    }
  });
  afterEach(async () => {
    await page.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const one = (selector: string, scope: ParentNode = document.body): Element => {
    const found = scope.querySelectorAll(selector);
    if (found.length !== 1) throw new Error(`Expected 1 element matching ${selector}, found ${found.length}`);
    return found[0]!;
  };

  it("renders the selected PC, workspace, and pane before recovery", async () => {
    const pane = { pane_id: "w1:p1", workspace_id: "w1", label: "  chat  ", title: "Pi" } as HerdrPane;
    const machine: Machine = { id: "target-pc", name: "Build PC", kind: "local", enabled: true, state: "connected", error: null, snapshot: { protocol: 22, version: "test", workspaces: [{ workspace_id: "w1", label: "release", active_tab_id: "w1:t1", number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false }], panes: [pane], tabs: [], agents: [], layouts: [] } };
    localStorage.setItem("ovis:unsent:test", JSON.stringify({ id: "test", machine_id: "old-pc", pane_id: "old:p1", pane_title: "old", kind: "message", text: "draft", at: 1 }));
    await page.render(<SettingsProvider><UnsentTextDialog machines={[machine]} target={{ machineId: "target-pc", pane }} canRecover onRecover={() => true} onClose={() => undefined} /></SettingsProvider>);
    const output = page.window.document.body.textContent;
    expect(output).toContain("Build PC · release · chat");
    expect(output).toContain("Put in message box adds this text to Build PC · release · chat");
  });

  it("does not point to a message box when the pane has none", async () => {
    const pane = { pane_id: "w1:p1", workspace_id: "w1", label: "shell", title: "zsh" } as HerdrPane;
    const machine: Machine = { id: "target-pc", name: "Build PC", kind: "local", enabled: true, state: "connected", error: null, snapshot: { protocol: 22, version: "test", workspaces: [{ workspace_id: "w1", label: "release", active_tab_id: "w1:t1", number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false }], panes: [pane], tabs: [], agents: [], layouts: [] } };
    localStorage.setItem("ovis:unsent:test", JSON.stringify({ id: "test", machine_id: "old-pc", pane_id: "old:p1", pane_title: "old", kind: "line", text: "draft", at: 1 }));
    await page.render(<SettingsProvider><UnsentTextDialog machines={[machine]} target={{ machineId: "target-pc", pane }} canRecover={false} onRecover={() => true} onClose={() => undefined} /></SettingsProvider>);
    const lead = one('[class="unsent-lead"]');
    const item = one('[class="unsent-item"]');
    expect([...one('[class="unsent-text"]', item).childNodes].map((node) => node.nodeName === "#text" ? node.textContent : node)).toEqual(["draft"]);
    const actions = [...item.querySelectorAll("button")].map((button) => button.textContent);
    expect(actions).toEqual(["Copy", "Discard"]);
    expect(lead.textContent).not.toMatch(/message box/i);
    expect(lead.textContent).toContain("Nothing here is sent.");
  });

  it("updates relative timestamps while the dialog stays open (#3458)", async () => {
    const pane = { pane_id: "w1:p1", workspace_id: "w1", label: "chat", title: "Pi" } as HerdrPane;
    const machine: Machine = { id: "target-pc", name: "Build PC", kind: "local", enabled: true, state: "connected", error: null, snapshot: { protocol: 22, version: "test", workspaces: [{ workspace_id: "w1", label: "release", active_tab_id: "w1:t1", number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false }], panes: [pane], tabs: [], agents: [], layouts: [] } };
    let now = 1_000_000;
    let tick: (() => void) | undefined;
    const realDateNow = Date.now;
    const win = window as unknown as { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
    Date.now = () => now;
    win.setInterval = ((fn: () => void) => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
    win.clearInterval = (() => undefined) as typeof clearInterval;
    try {
      localStorage.setItem("ovis:unsent:tick", JSON.stringify({ id: "tick", machine_id: "target-pc", pane_id: "w1:p1", pane_title: "old", kind: "message", text: "draft", at: now }));
      await page.render(<SettingsProvider><UnsentTextDialog machines={[machine]} target={{ machineId: "target-pc", pane }} canRecover onRecover={() => true} onClose={() => undefined} /></SettingsProvider>);
      const time = () => one("time").textContent;
      expect(time()).toBe("this minute");
      now += 120_000;
      await act(async () => { tick?.(); });
      expect(time()).toBe("2 minutes ago");
    } finally {
      Date.now = realDateNow;
    }
  });
});
