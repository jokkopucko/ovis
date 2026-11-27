import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import type { TelemetryViewSource } from "../../shared/telemetry.ts";
import type { PaneView } from "./actions.ts";
import { usePaneViewPicks } from "./usePaneLens.ts";

type Picks = ReturnType<typeof usePaneViewPicks>;
const noop = () => {};

describe("chat/terminal switches in the usage counts", () => {
  let page: Page;
  afterEach(async () => { await page.close(); });

  async function mount(view: PaneView, failing = false): Promise<{ picks: Picks; counted: string[]; picked: unknown[] }> {
    page = openPage();
    const counted: string[] = [];
    const picked: unknown[] = [];
    const counters = { viewSwitch: (to: PaneView, agent: string | null | undefined, source: TelemetryViewSource | null, machineId: string) => {
      if (failing) throw new Error("storage full");
      counted.push(`${to}:${agent ?? "-"}:${source ?? "-"}:${machineId}`);
    } };
    const agents: Record<string, string> = { "local/p1": "claude", "local/p2": "codex" };
    const out: { picks?: Picks } = {};
    function Harness() {
      out.picks = usePaneViewPicks({
        setViewPicks: (next) => { picked.push(next); }, setNotificationViewTarget: noop, setTerminalPeek: noop, setLens: noop, setAutoSelected: noop,
        selectedPaneId: "p1", selectedMachineId: "local", view, agentOf: (machineId, paneId) => agents[`${machineId}/${paneId}`], counters,
      });
      return null;
    }
    await page.render(createElement(Harness));
    return { picks: out.picks!, counted, picked };
  }

  test("the selected pane's switch is told with its agent and source; its own lens again is no switch", async () => {
    const { picks, counted } = await mount("chat");
    await act(async () => { picks.setView("chat", "header"); });
    await act(async () => { picks.setView("terminal", "shortcut"); });
    expect(counted).toEqual(["terminal:claude:shortcut:local"]);
  });

  test("a switch the app makes itself (source null) is handed on as such, and a pick names the picked pane's agent", async () => {
    const { picks, counted } = await mount("chat");
    await act(async () => { picks.setView("terminal", null); });
    await act(async () => { picks.pickView("local", "p2", "terminal", "pane"); });
    expect(counted).toEqual(["terminal:claude:-:local", "terminal:codex:pane:local"]);
  });

  test("the switch is made even when its count fails", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { picks, picked } = await mount("chat", true);
      await act(async () => { picks.setView("terminal", "header"); });
      expect(picked.length).toBe(1);
      await act(async () => { picks.pickView("local", "p2", "terminal", "pane"); });
      expect(picked.length).toBe(2);
      expect(logged).toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });
});
