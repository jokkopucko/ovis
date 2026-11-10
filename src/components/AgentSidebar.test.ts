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
    expect(tooltips(online)[0]).toEqual(["w1:p1", "checkout-api", "workstation", "5h 95%", long, "claude"]);
    const away = render([machine([pane("w1:p1", { tokens: { summary: long } })], "disconnected")]);
    expect(away).not.toContain("agent-tokens");
    expect(away).not.toContain(long);
  });

  test("a lone PC remains in the row's accessible text beside its agent and workspace", () => {
    const html = render([machine([pane("w1:p1", { title: "Review payments", agent_status: "working" })])]);
    const row = /class="agent-select agent-row"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "";
    const words = decode(row.replace(/<[^>]+>/g, " "));
    for (const part of ["claude", "checkout-api", "workstation", "Review payments"]) expect(words).toContain(part);
    expect(tooltips(html)[0]).toEqual(["w1:p1", "Review payments", "checkout-api", "workstation", "claude"]);
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

describe("AgentSidebar one-line row titles", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved); else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages); else Reflect.deleteProperty(navigator, "languages");
  });

  test("a tab herdr only numbers never replaces what the agent is on; a tab the user named leads", () => {
    const base = machine([
      pane("w1:p1", { tab_id: "w1:t1", label: "", title: "Idempotent payments" }),
      pane("w1:p2", { tab_id: "w1:t2", label: "", title: "Guard the export button" }),
    ]);
    base.snapshot!.tabs = [
      { tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "release", number: 2, focused: false, pane_count: 1, agent_status: "idle" },
    ];
    expect(texts(render([base]), "agent-title")).toEqual(["Idempotent payments", "release"]);
  });

  test("two agents in one named tab keep their own titles after it, so their rows never read the same", () => {
    const base = machine([
      pane("w1:p1", { tab_id: "w1:t1", label: "", title: "Idempotent payments" }),
      pane("w1:p2", { tab_id: "w1:t1", label: "", title: "Guard the export button" }),
    ]);
    base.snapshot!.tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "release", number: 1, focused: false, pane_count: 2, agent_status: "idle" }];
    const html = render([base]);
    expect(texts(html, "agent-title")).toEqual(["release", "release"]);
    const places = [...html.matchAll(/<span class="agent-context">(.*?)<\/span>/g)].map((match) => decode(match[1]!));
    expect(places[0]).toStartWith("Idempotent payments");
    expect(places[1]).toStartWith("Guard the export button");
  });

  test("a title that only names the agent gives way to the workspace: the mark already says which agent it is", () => {
    const html = render([machine([
      pane("w1:p1", { agent_status: "working", title: "Claude Code" }),
      pane("w1:p2", { agent_status: "working", title: "✳ Claude Code" }),
      pane("w1:p3", { agent_status: "working", title: "Idempotent payments" }),
    ])]);
    expect(texts(html, "agent-title")).toEqual(["checkout-api", "checkout-api", "Idempotent payments"]);
    // nothing on the line spells the agent's name, and the workspace a title took is not said twice
    expect(texts(html, "agent-title").concat(texts(html, "agent-context")).join(" ")).not.toContain("Claude");
    expect(texts(html, "agent-context")).toEqual(["checkout-api"]);
    // a screen reader, which sees no mark, still hears it
    expect(html.match(/<span class="visually-hidden">claude: <\/span>/g)?.length).toBe(3);
  });

  /** this device's saved choices, by storage key */
  const store = (values: Record<string, string>): void => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }), localStorage: { getItem: (key: string) => values[key] ?? null, setItem() {}, removeItem() {} } } });
  };
  const twoLines = { "ovis:settings": JSON.stringify({ sidebarRows: "two" }) };
  /** a PC whose workspaces are these, in this order, each with one tab herdr numbers: a pane names its own */
  const inWorkspaces = (labels: string[], panes: HerdrPane[]): Machine => {
    const base = machine(panes);
    base.snapshot!.workspaces = labels.map((label, index) => ({ workspace_id: `w${index + 1}`, label, number: index + 1, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `w${index + 1}:t1`, agent_status: "idle" }));
    base.snapshot!.tabs = labels.map((_, index) => ({ tab_id: `w${index + 1}:t1`, workspace_id: `w${index + 1}`, label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" }));
    return base;
  };
  const at = (workspace: number, extra: Partial<HerdrPane>): HerdrPane =>
    pane(`w${workspace}:p1`, { workspace_id: `w${workspace}`, tab_id: `w${workspace}:t1`, agent_status: "working", ...extra });

  test("Within a state: Name orders the rows by the title each draws, not by the agent's name it gave way from", () => {
    const grouped = { "ovis:agent-groups": "true", "ovis:agent-group-sort": JSON.stringify("name") };
    const rows = inWorkspaces(["zulu", "bravo", "alpha"], [at(1, { title: "Claude Code" }), at(2, { title: "Beta task" }), at(3, { title: "Claude Code" })]);
    store({ ...grouped, ...twoLines });
    expect(texts(render([rows]), "agent-title")).toEqual(["alpha", "Beta task", "zulu"]);
    store(grouped);
    expect(texts(render([rows]), "agent-title")).toEqual(["alpha", "Beta task", "zulu"]);
    // on one line a tab the user named leads its row, and so places it; on two lines the row's own title does
    const tabbed = machine([
      pane("w1:p1", { tab_id: "w1:t1", agent_status: "working", title: "Mid task" }),
      pane("w1:p2", { tab_id: "w1:t2", agent_status: "working", title: "Zeta task" }),
    ]);
    tabbed.snapshot!.tabs = [
      { tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "apple", number: 2, focused: false, pane_count: 1, agent_status: "idle" },
    ];
    expect(texts(render([tabbed]), "agent-title")).toEqual(["apple", "Mid task"]);
    store({ ...grouped, ...twoLines });
    expect(texts(render([tabbed]), "agent-title")).toEqual(["Mid task", "Zeta task"]);
  });

  test("a two-line row titled by a worktree herdr named does not say that workspace again under its title", () => {
    const rows = inWorkspaces(["checkout-api", "worktree-brave-valley-7fc6"], [at(1, { title: "Idempotent payments" }), at(2, { title: "Claude Code" })]);
    rows.snapshot!.workspaces[1]!.worktree = { repo_key: "r", repo_name: "checkout-api", repo_root: "/r", checkout_path: "/r-wt", is_linked_worktree: true };
    store(twoLines);
    const html = render([rows]);
    expect(texts(html, "agent-title")).toEqual(["Idempotent payments", "brave-valley"]);
    // the place is the first row's alone: the second has nothing left to say, in the worktree's whole name either
    expect(texts(html, "agent-context")).toEqual(["checkout-api"]);
    store({});
    const oneLine = render([rows]);
    expect(texts(oneLine, "agent-title")).toEqual(["Idempotent payments", "brave-valley"]);
    expect(texts(oneLine, "agent-context")).toEqual(["checkout-api"]);
  });

  test("a label the user gave the pane stands, on one line and on two, even when it only names the agent", () => {
    const rows = [machine([
      pane("w1:p1", { agent_status: "working", label: "Claude Code", title: "Claude Code" }),
      pane("w1:p2", { agent_status: "working", title: "Claude Code" }),
    ])];
    expect(texts(render(rows), "agent-title")).toEqual(["Claude Code", "checkout-api"]);
    store(twoLines);
    expect(texts(render(rows), "agent-title")).toEqual(["Claude Code", "checkout-api"]);
  });

  test("the helpers' line and the row's More name the row by the title it draws; the tooltip keeps the agent's own", () => {
    store({ "ovis:fold-helpers": "true" });
    const html = render([machine([
      pane("w1:p1", { agent_status: "working", title: "Claude Code" }),
      pane("w1:p2", { agent_status: "working", parent_pane_id: "w1:p1", title: "Explore the relay" }),
    ])]);
    expect(texts(html, "agent-title")).toEqual(["checkout-api", "Explore the relay"]);
    expect(html).toContain('<span class="visually-hidden">Helpers of checkout-api</span>');
    expect(html).toMatch(/class="agent-helpers-toggle"[^>]* title="Helpers of checkout-api"/);
    expect(html).toContain('aria-label="More for checkout-api"');
    expect(tooltips(html)[1]).toContain("Started by checkout-api");
    // the row's line no longer says "Claude Code": its tooltip, where the whole of a row is read, still does
    expect(tooltips(html)[0]).toEqual(["w1:p1", "checkout-api", "Claude Code", "workstation", "claude"]);
    expect(html).not.toContain("Helpers of Claude Code");
  });

  test("Agents order: Waiting first, the default, lifts a waiting agent; a saved Workspaces order keeps herdr's order", () => {
    // both agents busy: the order alone decides, with no resting fold in the way
    const rows = [pane("w1:p1", { agent_status: "working" }), pane("w1:p2", { agent_status: "blocked" })];
    const order = (html: string) => [...html.matchAll(/data-pane="([^"]+)"/g)].map((match) => match[1]);
    expect(order(render([machine(rows)]))).toEqual(["w1:p2", "w1:p1"]);
    const plain = (globalThis as { window: object }).window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...plain, localStorage: { getItem: (key: string) => key === "ovis:settings" ? JSON.stringify({ agentOrder: "workspace" }) : null, setItem() {}, removeItem() {} } } });
    expect(order(render([machine(rows)]))).toEqual(["w1:p1", "w1:p2"]);
  });

  test("on one line, Waiting first (the default) folds a resting agent under the \"+N resting\" line after the busy ones; a saved Workspaces order lists it in place", () => {
    const rows = [pane("w1:p1"), pane("w1:p2", { agent_status: "blocked" })];
    const entries = (html: string) => [...html.matchAll(/<li class="(agent-item|agent-background-label agent-resting-label)[^"]*"([^>]*)>/g)]
      .map((item) => item[1] === "agent-item" ? `${/data-pane="([^"]+)"/.exec(item[2]!)![1]}${/ hidden=""/.test(item[2]!) ? " hidden" : ""}` : "RESTING");
    const plain = (globalThis as { window: object }).window;
    // a saved Workspaces order: every row where herdr has it, none folded away
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...plain, localStorage: { getItem: (key: string) => key === "ovis:settings" ? JSON.stringify({ agentOrder: "workspace" }) : null, setItem() {}, removeItem() {} } } });
    expect(entries(render([machine(rows)]))).toEqual(["w1:p1", "w1:p2"]);
    const waiting = JSON.stringify({ agentOrder: "waiting" });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...plain, localStorage: { getItem: (key: string) => key === "ovis:settings" ? waiting : null, setItem() {}, removeItem() {} } } });
    const html = render([machine(rows)]);
    expect(entries(html)).toEqual(["w1:p2", "RESTING", "w1:p1 hidden"]);
    expect(html).toMatch(/<button type="button" class="agent-background-toggle" aria-expanded="false">[\s\S]*?<span>\+1 resting<\/span><\/button>/);
    // the resting line opened on this device: the row is listed under it
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...plain, localStorage: { getItem: (key: string) => key === "ovis:settings" ? waiting : key === "ovis:agents-resting-open" ? "1" : null, setItem() {}, removeItem() {} } } });
    const open = render([machine(rows)]);
    expect(entries(open)).toEqual(["w1:p2", "RESTING", "w1:p1"]);
    expect(open).toMatch(/<button type="button" class="agent-background-toggle" aria-expanded="true">/);
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

describe("AgentSidebar folded helpers (#772)", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  let stored: Record<string, string> = {};
  beforeEach(() => {
    // Waiting first, whose one-line list folds the resting rows: the helpers' fold is read beside that one
    stored = { "ovis:settings": JSON.stringify({ agentOrder: "waiting" }) };
    const localStorage = { getItem: (key: string) => stored[key] ?? null, setItem: (key: string, value: string) => { stored[key] = value; }, removeItem: (key: string) => { delete stored[key]; } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }), localStorage } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
    else Reflect.deleteProperty(navigator, "languages");
  });
  const family = [
    pane("t1", { agent_status: "working" }),
    pane("t2", { agent_status: "working", parent_pane_id: "t1" }),
    pane("t5", { agent_status: "working", parent_pane_id: "t2" }),
    pane("t3", { agent_status: "blocked", parent_pane_id: "t1" }),
    pane("t6", { agent_status: "idle", parent_pane_id: "t1" }),
    pane("t4", { agent_status: "working" }),
  ];
  const draw = (selectedPaneId: string | null = null): string => renderToStaticMarkup(createElement(SettingsProvider, {
    children: createElement(AgentSidebar, { machines: [machine(family)], selectedMachineId: "local", selectedPaneId, stateWord: () => "disconnected", onSelect: () => {} }),
  }));
  /** each entry of the list in the order drawn: a row as its pane id with " hidden" when folded away, a helpers line as
   *  "+<agent pane> <count> <expanded>", the one-line list's resting fold as "+<count> resting <expanded>" */
  const entries = (html: string): string[] =>
    [...html.matchAll(/<li class="(agent-item|agent-helpers|agent-background-label agent-resting-label)[^"]*"([^>]*)>([\s\S]*?<\/button>)?/g)].map((item) => item[1] === "agent-helpers"
      ? `+${/data-helpers-of="local:([^"]+)"/.exec(item[2]!)![1]} ${/agent-section-count">(\d+)</.exec(item[3]!)![1]} ${/aria-expanded="(true|false)"/.exec(item[3]!)![1]}`
      : item[1] === "agent-item" ? `${/data-pane="([^"]+)"/.exec(item[2]!)![1]}${/ hidden=""/.test(item[2]!) ? " hidden" : ""}`
        : `${/<span>(\+\d+ resting)<\/span>/.exec(item[3]!)![1]} ${/aria-expanded="(true|false)"/.exec(item[3]!)![1]}`);

  test("off by default: every helper is listed under its agent, with no helpers line; the resting helper folds under the list's resting line", () => {
    const html = draw();
    expect(entries(html)).toEqual(["t1", "t2", "t5", "t3", "t4", "+1 resting false", "t6 hidden"]);
    // the resting helper, selected, stays in sight under the line
    expect(entries(draw("t6"))).toEqual(["t1", "t2", "t5", "t3", "t4", "+1 resting false", "t6"]);
  });

  test("in a saved Workspaces order the resting helper stays under its agent, with no resting line", () => {
    stored["ovis:settings"] = JSON.stringify({ agentOrder: "workspace" });
    expect(entries(draw())).toEqual(["t1", "t2", "t5", "t3", "t6", "t4"]);
  });

  test("on: an agent's helpers fold under one line that says how many, and a helper that needs you stays in sight", () => {
    stored["ovis:fold-helpers"] = "true";
    const html = draw();
    expect(entries(html)).toEqual(["t1", "+t1 4 false", "t2 hidden", "t5 hidden", "t3", "t4", "+1 resting false", "t6 hidden"]);
    // a screen reader hears whose helpers they are, not only "Helpers" and a count
    expect(html).toMatch(/data-helpers-of="local:t1"[\s\S]*?<span class="agent-helpers-name" aria-hidden="true">Helpers<\/span><span class="visually-hidden">Helpers of t1<\/span>/);
    // the line says which of the folded ones ask for a look
    expect(html).toMatch(/data-helpers-of="local:t1"[\s\S]*?data-state="blocked"[\s\S]*?1 need you[\s\S]*?data-state="working"[\s\S]*?2 working/);
    // the helper still in sight hangs from the line, with no line running on past it
    expect(html).toMatch(/<li [^>]*data-pane="t3"[^>]*data-depth="1"(?![^>]*data-more)[^>]*>/);
  });

  test("on: the selected helper stays in sight", () => {
    stored["ovis:fold-helpers"] = "true";
    expect(entries(draw("t5"))).toEqual(["t1", "+t1 4 false", "t2 hidden", "t5", "t3", "t4", "+1 resting false", "t6 hidden"]);
  });

  test("on: an agent this device opened lists every helper, its line open; its resting helper still waits under the resting line", () => {
    stored["ovis:fold-helpers"] = "true";
    stored["ovis:agents-helpers-open"] = JSON.stringify(["local:t1"]);
    expect(entries(draw())).toEqual(["t1", "+t1 4 true", "t2", "t5", "t3", "t4", "+1 resting false", "t6 hidden"]);
    // the resting line opened too: every helper is in sight
    stored["ovis:agents-resting-open"] = "1";
    expect(entries(draw())).toEqual(["t1", "+t1 4 true", "t2", "t5", "t3", "t4", "+1 resting true", "t6"]);
  });
});

describe("AgentSidebar background agents", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => {
    // Waiting first, whose one-line list folds the resting rows: the background part comes after that fold
    const localStorage = { getItem: (key: string) => key === "ovis:settings" ? JSON.stringify({ agentOrder: "waiting" }) : null, setItem() {}, removeItem() {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }), localStorage } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
    else Reflect.deleteProperty(navigator, "languages");
  });
  /** each list's entries in the order drawn: a row as its pane id (with " hidden" when folded away), the one-line list's
   *  resting fold as "RESTING", the background heading as "BG" */
  const lists = (html: string): string[][] =>
    [...html.matchAll(/<ul class="agent-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)].map((list) =>
      [...list[1]!.matchAll(/<li class="(agent-item|agent-background-label agent-resting-label|agent-background-label)"([^>]*)>/g)].map((item) =>
        item[1] === "agent-background-label" ? "BG" : item[1] === "agent-background-label agent-resting-label" ? "RESTING" : `${/data-pane="([^"]+)"/.exec(item[2]!)![1]}${/ hidden=""/.test(item[2]!) ? " hidden" : ""}`));

  test("panes tagged role=background sit folded after the others in the same list, under a heading that says how many", () => {
    const html = render([machine([
      pane("w1:p1"),
      pane("w1:p2", { agent_status: "working", tokens: { role: "background" } }),
      pane("w1:p3", { agent_status: "blocked", tokens: { role: "background" } }),
      pane("w1:p4", { agent_status: "working", tokens: { role: "background" } }),
    ])]);
    // on one line, waiting first, a waiting row leads the list, the blocked background agent with it; the resting
    // agent folds under the people's own resting line, before the background part
    expect(lists(html)).toEqual([["w1:p3", "RESTING", "w1:p1 hidden", "BG", "w1:p2 hidden", "w1:p4 hidden"]]);
    expect(html).toMatch(/<li class="agent-background-label agent-resting-label"><button type="button" class="agent-background-toggle" aria-expanded="false">[\s\S]*?<span>\+1 resting<\/span><\/button>/);
    expect(html).toMatch(/<li class="agent-background-label"><button type="button" class="agent-background-toggle" aria-expanded="false">[\s\S]*?<span>\+2 background<\/span><\/button>/);
  });

  test("a list with no tagged pane has no background part", () => {
    const html = render([machine([pane("w1:p1"), pane("w1:p2", { tokens: { role: "lead" } })])]);
    // both rest: the one-line list folds them under its resting line, and draws no background part
    expect(lists(html)).toEqual([["RESTING", "w1:p1 hidden", "w1:p2 hidden"]]);
    expect(html).not.toMatch(/\+\d+ background|Background agents|<li class="agent-background-label">/);
    // two lines: no resting fold either, every row in sight and still no background part
    const plain = (globalThis as { window: object }).window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...plain, localStorage: { getItem: (key: string) => key === "ovis:settings" ? JSON.stringify({ sidebarRows: "two" }) : null, setItem() {}, removeItem() {} } } });
    const twoLine = render([machine([pane("w1:p1"), pane("w1:p2", { tokens: { role: "lead" } })])]);
    expect(lists(twoLine)).toEqual([["w1:p1", "w1:p2"]]);
    expect(twoLine).not.toContain("agent-background-toggle");
  });
});
