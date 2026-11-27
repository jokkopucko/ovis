import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { HerdrPane, WorkspaceInfo } from "../../shared/protocol.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { SessionHistory } from "./SessionHistory.tsx";

describe("SessionHistory", () => {
  let page: Page;
  const HTMLElementBefore = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");

  beforeEach(() => {
    page = openPage("http://ovis.test/");
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => String(input).includes("/agents") ? Response.json({ agents: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }] }) : Response.json({ workspace_id: "w1", agent: "pi", cwd: "/repo", sessions: [] }), { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await page.close();
    mock.restore();
    if (HTMLElementBefore) Object.defineProperty(globalThis, "HTMLElement", HTMLElementBefore);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  });

  it("renders the next action when the selected agent has no saved sessions", async () => {
    const workspace: WorkspaceInfo = { workspace_id: "w1", label: "release", active_tab_id: "w1:t1", number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false };
    await page.render(<SettingsProvider><MachineContext.Provider value="local"><SessionHistory workspace={workspace} panes={[] as HerdrPane[]} agent="pi" onClose={() => undefined} onSelectPane={() => undefined} onResumed={() => undefined} /></MachineContext.Provider></SettingsProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(page.window.document.body.textContent).toContain("No earlier Pi sessions in this folder. Choose another agent.");
  });
});
