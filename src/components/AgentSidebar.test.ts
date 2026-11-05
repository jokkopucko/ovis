import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Machine } from "../../shared/machines.ts";
import type { AgentInfo, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { setAgentRowTokens } from "../lib/agentRowTokens.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";

const pane = (pane_id: string, extra: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `term-${pane_id}`, focused: false, revision: 1,
  agent: "claude", agent_status: "idle", ...extra,
});
const agentOf = (row: HerdrPane): AgentInfo => ({
  pane_id: row.pane_id, workspace_id: row.workspace_id, tab_id: row.tab_id, terminal_id: row.terminal_id, focused: false, revision: 1,
  agent: row.agent, agent_status: row.agent_status, ...(row.display_agent ? { display_agent: row.display_agent } : {}), ...(row.tokens ? { tokens: row.tokens } : {}),
});
const snapshot = (panes: HerdrPane[]): SessionSnapshot => ({
  protocol: 22, version: "0.9.5", layouts: [], panes, agents: panes.map(agentOf),
  workspaces: [{ workspace_id: "w1", label: "checkout-api", number: 1, focused: false, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, pane_count: panes.length, agent_status: "idle" }],
});
const machine = (panes: HerdrPane[], state: Machine["state"] = "connected"): Machine => ({ id: "local", name: "workstation", kind: "local", enabled: true, state, error: null, snapshot: snapshot(panes) });

function render(machines: Machine[]): string {
  return renderToStaticMarkup(createElement(SettingsProvider, {
    children: createElement(AgentSidebar, { machines, selectedMachineId: "local", selectedPaneId: null, stateWord: () => "disconnected", onSelect: () => {} }),
  }));
}
const decode = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** the text of each element with this class, entities as the browser reads them */
const texts = (html: string, className: string): string[] =>
  [...html.matchAll(new RegExp(`<span class="${className}">(.*?)</span>`, "g"))].map((match) => decode(match[1]!));
/** each agent row's tooltip, line by line */
const tooltips = (html: string): string[][] =>
  [...html.matchAll(/class="agent-select agent-row"[^>]* title="([^"]*)"/g)].map((match) => decode(match[1]!).split("\n"));

describe("AgentSidebar plugin tokens", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => {
    // the drawer query AgentSidebar asks at its first render, on a desktop, in English
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
    else Reflect.deleteProperty(navigator, "languages");
    setAgentRowTokens(null);
  });

  test("a row draws every token its pane has, by name, as text; a pane without any draws no line", () => {
    const html = render([machine([
      pane("w1:p1", { tokens: { summary: "<b>reviewing</b> auth", quota: "5h 95% · Wk 67%", blank: "  " } }),
      pane("w1:p2"),
    ])]);
    expect(texts(html, "agent-tokens")).toEqual(["5h 95% · Wk 67% · <b>reviewing</b> auth"]);
    // escaped, never markup
    expect(html).not.toContain("<b>reviewing</b>");
    expect(html.match(/class="agent-tokens"/g)?.length).toBe(1);
  });

  test("herdr's `[ui.sidebar.agents]` rows choose which tokens a row draws, in their order, hide rules included", () => {
    setAgentRowTokens({
      rows: [{ name: "progress" }, { name: "quota", rules: [{ equals: "unknown", hide: true }] }],
      by_agent: { codex: [{ name: "summary" }] },
    });
    const html = render([machine([
      pane("w1:p1", { tokens: { quota: "5h 95%", progress: "40% 12m", summary: "not in the rows" } }),
      pane("w1:p2", { tokens: { quota: "unknown", progress: "90% 1m" } }),
      pane("w1:p3", { agent: "codex", tokens: { quota: "5h 95%", summary: "codex's own rows" } }),
    ])]);
    expect(texts(html, "agent-tokens")).toEqual(["40% 12m · 5h 95%", "90% 1m", "codex's own rows"]);
  });

  test("the row's tooltip says each token whole; a PC that is away draws none", () => {
    const long = `summary ${"x".repeat(200)}`;
    const online = render([machine([pane("w1:p1", { tokens: { summary: long, quota: "5h 95%" } })])]);
    expect(tooltips(online)[0]).toEqual(["w1:p1", "checkout-api", "5h 95%", long, "claude"]);
    const away = render([machine([pane("w1:p1", { tokens: { summary: long } })], "disconnected")]);
    expect(away).not.toContain("agent-tokens");
    expect(away).not.toContain(long);
  });

  test("display_agent, a plugin's line for the agent, is said where it says more than the agent's kind", () => {
    const html = render([machine([
      pane("w1:p1", { display_agent: "needs a login · 8m ago", title: "PRJ-1 Add a greeting" }),
      pane("w1:p2", { display_agent: "Claude", title: "Refactor" }),
    ])]);
    const lines = [...html.matchAll(/<span class="agent-context">(.*?)<\/span>/g)].map((match) => match[1]);
    expect(lines[0]).toStartWith("needs a login · 8m ago · checkout-api");
    // the mark already draws Claude: the line does not say it again
    expect(lines[1]).toBe("checkout-api");
  });
});

describe("AgentSidebar, what herdr-core reports", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  test("a helper reads on one line under the agent that started it, a blocked agent says why in a few words, and progress is a percent", () => {
    const html = render([machine([
      pane("t1", { agent_status: "working", agent_progress: 40 }),
      pane("t9", { agent_status: "blocked", agent_kind: "question", agent_message: "Which <branch>?" }),
      pane("t2", { agent: "codex", agent_status: "blocked", parent_pane_id: "t1", agent_kind: "permission", agent_message: "Allow bash: rm -rf build?" }),
      // a blocked agent that said nothing more draws no line; a kind outside the protocol is shown as written
      pane("t3", { agent_status: "blocked" }),
      pane("t4", { agent_status: "blocked", agent_kind: "payment" }),
    ])]);
    expect([...html.matchAll(/data-pane="([^"]+)"(?: data-pin-key="[^"]+")?(?: data-depth="(\d)")?/g)].map((match) => [match[1], match[2] ?? "0"]))
      .toEqual([["t1", "0"], ["t2", "1"], ["t9", "0"], ["t3", "0"], ["t4", "0"]]);
    expect([...html.matchAll(/<span class="agent-blocked"[^>]*>(.*?)<\/span>/g)].map((match) => match[1])).toEqual(["Needs permission", "Has a question", "payment"]);
    // a screen reader hears the whole reason in the row, not the cut one
    expect(html).toContain('<span class="agent-blocked" aria-hidden="true">Needs permission</span><span class="visually-hidden">Needs permission: Allow bash: rm -rf build?</span>');
    expect(html).toContain('<span class="agent-blocked">payment</span>');
    expect(html).not.toContain("<branch>");
    // the whole reason is in the tooltip
    expect(tooltips(html)[1]).toContain("Needs permission: Allow bash: rm -rf build?");
    expect(tooltips(html)[2]).toContain("Has a question: Which <branch>?");
    // the helper's row is one line: no place and no plugin values under its title
    expect(texts(html, "agent-context")).toHaveLength(4);
    // the percent is drawn for the eye; the words are what a screen reader reads, and the tooltip says it too
    expect([...html.matchAll(/<span class="agent-progress" aria-hidden="true">(.*?)<\/span>/g)].map((match) => match[1])).toEqual(["40%"]);
    expect(html).toContain('<span class="visually-hidden">Progress 40%</span>');
    expect(tooltips(html)[0]).toContain("Progress 40%");
    expect(tooltips(html)[1]).toContain("Started by t1");
  });

  test("a helper's tree line runs on past its own helper to its next sibling", () => {
    const html = render([machine([
      pane("t1", { agent_status: "working" }),
      pane("t2", { agent_status: "working", parent_pane_id: "t1" }),
      pane("t5", { agent_status: "working", parent_pane_id: "t2" }),
      pane("t3", { agent_status: "working", parent_pane_id: "t1" }),
      pane("t4", { agent_status: "working" }),
    ])]);
    const lines = [...html.matchAll(/<li [^>]*data-pane="([^"]+)"[^>]*>/g)].map((match) => [match[1], /data-more=""/.test(match[0]), /data-through=""/.test(match[0])]);
    expect(lines).toEqual([["t1", false, false], ["t2", true, false], ["t5", false, true], ["t3", false, false], ["t4", false, false]]);
  });
});
