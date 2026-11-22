import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { InboxConnecting, InboxFootEntry, InboxUnchosen, ThreadTitle, ThreadTop, type ThreadProps } from "./InboxMode.tsx";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const statusOf = (moved: Record<string, AgentStatus> = {}): SidebarActivity => ({
  seqs: () => new Map(),
  status: (_machineId, pane) => moved[pane.pane_id] ?? pane.agent_status as AgentStatus | undefined,
});
const paneOf = (machines: Machine[], paneId: string): HerdrPane => machines[0]!.snapshot!.panes.find((pane) => pane.pane_id === paneId) as HerdrPane;

function draw(node: ReactElement): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: node }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}
const said = (markup: string, name: string): string | null => {
  const found = new RegExp(`<span class="${name}(?: [^"]*)?">(?:<span class="visually-hidden">[^<]*</span>)?([^<]*)</span>`).exec(markup);
  return found ? found[1]!.replaceAll("&amp;", "&") : null;
};
function thread(paneId: string, more: Partial<ThreadProps> = {}, machines: Machine[] = structuredClone(fixture)): ThreadProps {
  return { machines, activity: statusOf(), machineId: "local", pane: paneOf(machines, paneId), connection: null as HeaderConnection, watching: false, severalPcs: false, ...more };
}

describe("a phone thread's title", () => {
  const title = (props: ThreadProps): string => draw(createElement(ThreadTitle, props));

  it("says the name its row in the list draws, with the agent's kind for a screen reader", () => {
    const markup = title(thread("w1D:p1"));
    expect(said(markup, "thread-name")).toBe("Guard the export button");
    expect(markup).toContain('<span class="visually-hidden">Codex: </span>');
  });

  it("says the agent's state in the list's words", () => {
    expect(said(title(thread("w1D:p1")), "thread-state")).toBe("Needs you");
    expect(said(title(thread("w1C:p1")), "thread-state")).toBe("Working");
    expect(said(title(thread("w1E:p1", { activity: statusOf({ "w1E:p1": "done" }) })), "thread-state")).toBe("Done");
    expect(said(title(thread("w1E:p1")), "thread-state")).toBe("Ready");
    expect(said(title(thread("w1E:p1", { activity: statusOf({ "w1E:p1": "waiting" }) })), "thread-state")).toBe("Working");
  });

  it("says Terminal for a pane that runs no agent, named as its tab is", () => {
    const markup = title(thread("w1G:p1"));
    expect(said(markup, "thread-state")).toBe("Terminal");
    expect(said(markup, "thread-name")).toBe("Tag v1.4.0");
    expect(markup).not.toContain("visually-hidden");
  });

  it("says Offline for a PC that is away", () => {
    const machines = structuredClone(fixture).map((machine) => ({ ...machine, state: "disconnected" as const }));
    expect(said(title(thread("w1D:p1", {}, machines)), "thread-state")).toBe("Offline");
  });

  it("leads the state with View only on a watching device, then the PC's name when several are shown", () => {
    expect(said(title(thread("w1D:p1", { watching: true })), "thread-state")).toBe("View only · Needs you");
    expect(said(title(thread("w1D:p1", { severalPcs: true })), "thread-state")).toBe("workstation · Needs you");
    expect(said(title(thread("w1D:p1", { watching: true, severalPcs: true })), "thread-state")).toBe("View only · workstation · Needs you");
  });

  it("gives the line to the connection while it has something to say", () => {
    const lost = title(thread("w1D:p1", { connection: "reconnecting", watching: true }));
    expect(said(lost, "thread-state")).toBe("Reconnecting…");
    expect(lost).toContain('class="thread-state is-reconnecting"');
    expect(said(title(thread("w1D:p1", { connection: "connected" })), "thread-state")).toBe("Connected");
  });
});

describe("the zone over a wide thread", () => {
  const note = createElement("div", { className: "test-note" });
  const controls = createElement("button", { className: "test-control" });

  it("draws the chip with the mark, the name and the state's word, and the thread's controls", () => {
    const markup = draw(createElement(ThreadTop, { thread: thread("w1D:p1", { severalPcs: true }), note, controls }));
    expect(said(markup, "thread-chip-name")).toBe("Guard the export button");
    expect(said(markup, "thread-chip-state")).toBe("workstation · Needs you");
    expect(markup).toContain('class="inbox-avatar"');
    expect(markup).toContain('class="thread-top"');
    expect(markup.indexOf("test-note")).toBeLessThan(markup.indexOf("thread-chip"));
    expect(markup.indexOf("thread-chip")).toBeLessThan(markup.indexOf("test-control"));
    expect(/<div class="thread-chip"[^>]*>(?:(?!<\/div>).)*<button/.test(markup)).toBe(false);
  });

  it("keeps the shell's note and draws no chip where the note stands in its place", () => {
    const markup = draw(createElement(ThreadTop, { thread: null, note, controls }));
    expect(markup).toContain("test-note");
    expect(markup).toContain("test-control");
    expect(markup).not.toContain("thread-chip");
    expect(markup).toContain('class="thread-top"');
  });

  it("is empty over a pane with no thread: no chip and no controls, only the note's place", () => {
    const markup = draw(createElement(ThreadTop, { thread: null, note, controls: null }));
    expect(markup).toContain('class="thread-top is-empty"');
    expect(markup).toContain("test-note");
    expect(markup).not.toContain("thread-top-controls");
  });
});

describe("a wide pane with no agent chosen", () => {
  it("says so in one status line", () => {
    expect(draw(createElement(InboxUnchosen))).toMatch(/^<p class="inbox-unchosen" role="status">[^<]+<\/p>$/);
  });
});

describe("the mode's shell before the app has connected", () => {
  it("is the list's own surface as the screen on a phone: no header, no sidebar, no control, one status line", () => {
    const markup = draw(createElement(InboxConnecting, { wide: false }));
    expect(markup).toMatch(/^<div class="app sidebar-collapsed is-inbox is-inbox-list">/);
    for (const classic of ["app-header", "terminal-placeholder", "brand", "<aside", "<button", "inbox-rail"]) expect(markup).not.toContain(classic);
    expect(markup.match(/class="mode-inbox"/g)).toHaveLength(1);
    expect(markup).toContain('<div class="pane-column"><div class="pane-split"><section class="mode-inbox" aria-label="Agent inbox">');
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).toContain('<div class="inbox-scroll"><p class="visually-hidden" role="status"></p></div>');
  });

  it("is the column beside an empty pane on a wide window, at the width the column will have, its rail an empty surface before the list", () => {
    const markup = draw(createElement(InboxConnecting, { wide: true, sidebarWidth: 360 }));
    expect(markup).toMatch(/^<div class="app is-inbox is-inbox-wide" style="--sidebar-user-w:360px">/);
    for (const classic of ["app-header", "terminal-placeholder", "brand", "<button", "<nav"]) expect(markup).not.toContain(classic);
    expect(markup).toContain('<aside class="sidebar inbox-column"><div class="inbox-rail"></div><section class="mode-inbox is-wide" aria-label="Agent inbox">');
    expect(markup).toContain('<div class="pane-column"><div class="pane-split"></div></div>');
    expect(markup.match(/role="status"/g)).toHaveLength(1);
  });
});

describe("the way into the mode at the sidebar's foot", () => {
  it("is one row of the footer's own that says Open agent inbox", () => {
    const markup = draw(createElement(InboxFootEntry, { onOpen: () => {} }));
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('class="btn btn-ghost sidebar-footer-action sidebar-footer-pc inbox-foot-entry"');
    expect(markup).toContain('<span class="sidebar-footer-pc-name">Open agent inbox</span>');
    expect(markup.match(/<svg/g)).toHaveLength(1);
    expect(markup).toMatch(/<svg[^>]*lucide-inbox[^>]*>.*<\/svg><span class="sidebar-footer-pc-name">/s);
    expect(markup).toMatch(/Open agent inbox<\/span><\/button>$/);
  });
});
