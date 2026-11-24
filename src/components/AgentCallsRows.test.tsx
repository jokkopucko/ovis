import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { HarnessToolSetting } from "../../shared/harness-tool.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentCallsRows } from "./AgentCallsRows.tsx";

const agent = (id: string, name: string, installed: boolean, version: string | null = null) => ({ id, name, state: { installed, version } }) as unknown as AgentCatalogRow;
const agents = [agent("opencode", "OpenCode", true, "2.2.2"), agent("claude", "Claude Code", true, "2.1.331"), agent("gjc", "GJC", false)];

describe("Settings > Agents > Let agents call other agents", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  let saved: unknown[] = [];
  let fetchSpy: { mockRestore(): void } | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    saved = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { settings: { agentHarnessTool: HarnessToolSetting } };
      saved.push(body.settings.agentHarnessTool);
      return Response.json({ revision: saved.length, settings: body.settings });
    }, { preconnect: globalThis.fetch.preconnect }));
    define("document", { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = (watching = false, shown = agents) => act(() => {
    renderer = create(createElement(SettingsProvider, null, createElement(AgentCallsRows, { agents: shown, watching })));
  });
  const toggle = () => renderer!.root.findByProps({ role: "switch" });
  const chips = () => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "settings-chip");

  it("is off by default: agents may only look, and no agent to call is offered", () => {
    mount();
    expect(toggle().props["aria-checked"]).toBe(false);
    expect(chips()).toHaveLength(0);
  });

  it("writes this PC's grant straight to its server: on with the agents it may start, then back to looking", async () => {
    mount();
    await act(async () => { toggle().props.onClick(); });
    expect(saved).toEqual([{ level: "start", depth: 1, harnesses: ["opencode"] }]);
    expect(toggle().props["aria-checked"]).toBe(true);
    expect(chips().map((chip) => [chip.children.join(""), chip.props["aria-pressed"]])).toEqual([["OpenCode", true]]);
    await act(async () => { chips()[0]!.props.onClick(); });
    expect(saved.at(-1)).toEqual({ level: "start", depth: 1, harnesses: [] });
    await act(async () => { toggle().props.onClick(); });
    expect(saved.at(-1)).toEqual({ level: "view", depth: 1, harnesses: [] });
    expect(chips()).toHaveLength(0);
  });

  it("offers no OpenCode whose version has no ask-every-time launch", async () => {
    mount(false, [agent("opencode", "OpenCode", true, "2.2.3")]);
    await act(async () => { toggle().props.onClick(); });
    expect(saved).toEqual([{ level: "start", depth: 1, harnesses: [] }]);
    expect(chips()).toHaveLength(0);
  });

  it("offers Claude Code at the version its ask-every-time launch was run against", async () => {
    mount(false, [agent("claude", "Claude Code", true, "2.1.330")]);
    await act(async () => { toggle().props.onClick(); });
    expect(saved).toEqual([{ level: "start", depth: 1, harnesses: ["claude"] }]);
    expect(chips().map((chip) => chip.children.join(""))).toEqual(["Claude Code"]);
  });

  it("names the agents whose own allow rules still apply to them when called, and only those", async () => {
    mount(false, [agent("claude", "Claude Code", true, "2.1.330"), agent("codex", "Codex", true, "0.171.0"), agent("copilot", "GitHub Copilot", true, "1.0.109")]);
    await act(async () => { toggle().props.onClick(); });
    expect(saved).toEqual([{ level: "start", depth: 1, harnesses: ["claude", "codex", "copilot"] }]);
    const note = () => renderer!.root.findAll((node) => node.type === "span" && node.props.className === "settings-condition");
    expect(note().map((span) => span.children.join(""))).toEqual(["The allow rules you set in Codex, GitHub Copilot, a project folder's included, apply when they are called too."]);
    act(() => { renderer!.update(createElement(SettingsProvider, null, createElement(AgentCallsRows, { agents: [agent("claude", "Claude Code", true, "2.1.330")], watching: false }))); });
    expect(note()).toHaveLength(0);
  });

  it("says agy searches the web without asking, under the rules line", async () => {
    mount(false, [agent("agy", "agy", true, "1.5.16"), agent("codex", "Codex", true, "0.171.0")]);
    await act(async () => { toggle().props.onClick(); });
    const note = renderer!.root.find((node) => node.type === "span" && node.props.className === "settings-condition");
    const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
    expect(text(note)).toBe("The allow rules you set in agy, Codex, a project folder's included, apply when they are called too.agy searches the web without asking.");
  });

  it("cannot be turned on from a watching device", () => {
    mount(true);
    expect(toggle().props.disabled).toBe(true);
  });
});
