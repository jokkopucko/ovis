import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { AgentMark } from "./AgentMark.tsx";
import { AgentPicker, type AgentPickerProps } from "./AgentPicker.tsx";

const agents = [{ kind: "codex", label: "Codex" }, { kind: "claude", label: "Claude Code" }];
const render = (props: Partial<AgentPickerProps>): string =>
  renderToStaticMarkup(createElement(AgentPicker, { agents, value: "", labelledBy: "agent", onChange: () => {}, ...props }));
const mark = (agent: string): string => renderToStaticMarkup(createElement(AgentMark, { agent, size: 16 }));
/** the name the closed picker shows: its text, without the icons' drawing */
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
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  // the trigger's box, for the list's fixed placement under it
  const node = { getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 40, width: 300 }), contains: () => true };

  beforeEach(() => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const on = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...on, innerHeight: 800 } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...on, getElementById: () => null, activeElement: null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  async function openList(props: Partial<AgentPickerProps>) {
    const chosen: string[] = [];
    let added = 0;
    await act(async () => {
      renderer = create(createElement(AgentPicker, { agents, value: "codex", labelledBy: "agent", onChange: (kind) => chosen.push(kind), ...props, ...(props.addAgent ? { addAgent: { ...props.addAgent, onSelect: () => { added += 1; } } } : {}) }), { createNodeMock: () => node });
    });
    const root = renderer!.root;
    const trigger = root.findByProps({ role: "combobox" });
    await act(async () => { trigger.props.onClick(); });
    const rows = () => root.findAllByProps({ role: "option" });
    return { root, trigger, rows, chosen, added: () => added };
  }

  it("ends the list with the row, which opens the add flow and picks no agent", async () => {
    const { rows, chosen, added } = await openList({ addAgent: { label: "Add another agent…", onSelect: () => {} } });
    const labels = rows().map((row) => row.findAllByProps({ className: "menu-item-main" })[0]!.children.join(""));
    expect(labels).toEqual(["Shell", "Codex", "Claude Code", "Add another agent…"]);
    await act(async () => { rows().at(-1)!.props.onClick(); });
    expect(added()).toBe(1);
    expect(chosen).toEqual([]);
  });

  it("reaches the row from the keyboard: End then Enter", async () => {
    const { trigger, chosen, added } = await openList({ addAgent: { label: "Add another agent…", onSelect: () => {} } });
    const key = (name: string) => trigger.props.onKeyDown({ key: name, preventDefault() {} });
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
