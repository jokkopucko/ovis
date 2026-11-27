import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentPicker, type AgentPickerProps } from "./AgentPicker.tsx";

const agents = [{ kind: "codex", label: "Codex" }, { kind: "claude", label: "Claude Code" }];
const render = (props: Partial<AgentPickerProps>): string =>
  renderToStaticMarkup(createElement(AgentPicker, { agents, value: "", labelledBy: "agent", onChange: () => {}, ...props }));
const mark = (agent: string): string => renderToStaticMarkup(createElement(AgentMark, { agent, size: 16 }));
const shownName = (markup: string): string => markup.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");

describe("AgentPicker", () => {
  it("leads with a plain shell, and shows the chosen agent's mark with its name", () => {
    const shell = render({});
    expect(shownName(shell)).toBe("Shell");
    for (const { kind } of agents) expect(shell).not.toContain(mark(kind));
    const claude = render({ value: "claude" });
    expect(shownName(claude)).toBe("Claude Code");
    expect(claude).toContain(mark("claude"));
  });

  it("lists the agents alone when told so: no shell, and a value outside the list falls to the first agent", () => {
    const codex = render({ shell: false, value: "codex" });
    expect(shownName(codex)).toBe("Codex");
    expect(codex).toContain(mark("codex"));
    const unlisted = render({ shell: false, value: "" });
    expect(shownName(unlisted)).toBe("Codex");
    expect(unlisted).toContain(mark("codex"));
  });
});

describe("AgentPicker's Add another agent row", () => {
  let page: Page;
  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  async function openList(props: Partial<AgentPickerProps>) {
    const chosen: string[] = [];
    let added = 0;
    await page.render(createElement(AgentPicker, { agents, value: "codex", labelledBy: "agent", onChange: (kind) => chosen.push(kind), ...props, ...(props.addAgent ? { addAgent: { ...props.addAgent, onSelect: () => { added += 1; } } } : {}) }));
    const trigger = page.one('[role="combobox"]');
    Object.defineProperty(trigger, "getBoundingClientRect", { value: () => new page.window.DOMRect(0, 0, 300, 40) });
    await act(async () => { trigger.click(); });
    const rows = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    return { trigger, rows, chosen, added: () => added };
  }

  it("ends the list with the row, which opens the add flow and picks no agent", async () => {
    const { rows, chosen, added } = await openList({ addAgent: { label: "Add another agent…", onSelect: () => {} } });
    const labels = rows().map((row) => row.querySelector('[class="menu-item-main"]')?.textContent);
    expect(labels).toEqual(["Shell", "Codex", "Claude Code", "Add another agent…"]);
    await act(async () => { rows().at(-1)?.click(); });
    expect(added()).toBe(1);
    expect(chosen).toEqual([]);
  });

  it("reaches the row from the keyboard: End then Enter", async () => {
    const { trigger, chosen, added } = await openList({ addAgent: { label: "Add another agent…", onSelect: () => {} } });
    const key = (name: string) => trigger.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as Event);
    await act(async () => { key("End"); });
    await act(async () => { key("Enter"); });
    expect(added()).toBe(1);
    expect(chosen).toEqual([]);
  });

  it("has no such row unless asked", async () => {
    const { rows } = await openList({});
    expect(rows()).toHaveLength(3);
  });
});
