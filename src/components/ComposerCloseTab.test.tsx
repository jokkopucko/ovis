import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import type { ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { AgentStatus, SlashCommand } from "../../shared/protocol.ts";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import type { ComposerProps } from "./Composer.tsx";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { Composer } = await import("./Composer.tsx");

// The Close tab button asks the agent to run the close-tab skill the settings name, after a yes
const pane = "close-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let closeSkill = "close-tab";
let commands: SlashCommand[] = [];

beforeEach(() => {
  closeSkill = "close-tab";
  commands = [{ name: "jokko:close-tab", description: "", source: "skill" }];
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout, history: { state: null, pushState() {}, back() {} } },
    document: { ...listen, querySelector: () => null, getElementById: () => null, activeElement: null, body: {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    HTMLElement: class HTMLElement {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, composerCloseSkill: closeSkill }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockImplementation(() => commands);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

function props(sent: unknown[][], agent = "claude", agentStatus: AgentStatus = "idle"): ComposerProps {
  return { paneId: pane, agent, agentStatus, connected: true, autoFocus: false, onSend: (...args) => { sent.push(args); return true; }, onAbort() {}, onUploadImage: async () => "" };
}

const closeButton = () => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "icon-button composer-close-tab")[0];
const dialogButton = (label: string) => renderer!.root.findAll((node) => node.type === "button" && node.children.includes(label))
  .find((node) => node.props.className !== "icon-button composer-close-tab");
const dialogShown = () => renderer!.root.findAll((node) => node.props.role === "alertdialog").length > 0;

it("draws no Close tab button until this device names the skill", async () => {
  closeSkill = "";
  await act(async () => { renderer = create(<Composer {...props([])} />); });
  expect(closeButton()).toBeUndefined();
});

it("draws no button where the pane's agent does not list the skill", async () => {
  commands = [{ name: "jokko:other", description: "", source: "skill" }];
  await act(async () => { renderer = create(<Composer {...props([])} />); });
  expect(closeButton()).toBeUndefined();
});

it("asks first, and sends the skill in Claude's form after the yes", async () => {
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await act(async () => { closeButton()!.props.onClick(); });
  expect(dialogShown()).toBe(true);
  expect(sent).toEqual([]);
  await act(async () => { dialogButton("Close tab")!.props.onClick(); });
  expect(sent.map((call) => call[0])).toEqual(["/jokko:close-tab"]);
  expect(dialogShown()).toBe(false);
});

it("sends Codex's `$` form", async () => {
  commands = [{ name: "jokko:close-tab", description: "", source: "skill", trigger: "$" }];
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer {...props(sent, "codex")} />); });
  await act(async () => { closeButton()!.props.onClick(); });
  await act(async () => { dialogButton("Close tab")!.props.onClick(); });
  expect(sent.map((call) => call[0])).toEqual(["$jokko:close-tab"]);
});

it("sends nothing on Cancel", async () => {
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await act(async () => { closeButton()!.props.onClick(); });
  await act(async () => { dialogButton("Cancel")!.props.onClick(); });
  expect(sent).toEqual([]);
  expect(dialogShown()).toBe(false);
});

it.each([
  ["over a draft", () => composerDrafts.set(draftKey, "my own words"), "idle"],
  ["while the agent works", () => {}, "working"],
] as const)("is off %s", async (_name, arrange, status) => {
  arrange();
  await act(async () => { renderer = create(<Composer {...props([], "claude", status)} />); });
  expect(closeButton()!.props.disabled).toBe(true);
});
