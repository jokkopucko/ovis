import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

const pane = "bare-pick-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
const COMMANDS: SlashCommand[] = [
  { name: "new", description: "a built-in without an argument", source: "builtin" },
  { name: "rename", description: "a built-in with an argument", source: "builtin" },
  { name: "hello", description: "a project command", source: "project" },
  // a server command OpenCode's catalog marks builtin, which its own menu only types
  { name: "review", description: "a server command", source: "builtin" },
  { name: "skill:shared", description: "a namespaced skill", source: "user" },
];
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null, getElementById: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue(COMMANDS);
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

const box = () => renderer!.root.findAll((node) => node.type === "textarea" && node.props.onKeyDown !== undefined)[0]!;
async function type(value: string): Promise<void> {
  await act(async () => { box().props.onChange({ target: { value, selectionStart: value.length } }); });
}
async function enter(): Promise<void> {
  await act(async () => {
    box().props.onKeyDown({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() {} });
  });
}

async function pickAndSend(agent: string, typed: string, then?: string): Promise<unknown[]> {
  const sent: unknown[][] = [];
  const props: ComposerProps = { paneId: pane, agent, agentStatus: "idle", connected: true, autoFocus: false, onSend: (...args) => { sent.push(args); return true; }, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer = create(<Composer {...props} />); });
  await type(typed);
  await enter();
  if (then !== undefined) await type(then);
  await enter();
  return sent.map((call) => call[0]);
}

it("sends a picked OpenCode built-in that takes no argument without the pick's space", async () => {
  expect(await pickAndSend("opencode", "/ne")).toEqual(["/new"]);
});

it.each([
  // OpenCode's own menu only types these with their space, which lets Enter send them
  ["an OpenCode project command", "opencode", "/hel", "/hello "],
  ["an OpenCode built-in that takes an argument", "opencode", "/ren", "/rename "],
  ["an OpenCode server command marked builtin", "opencode", "/rev", "/review "],
  ["another agent's built-in", "claude", "/ne", "/new "],
])("keeps the space of %s", async (_name, agent, typed, expected) => {
  expect(await pickAndSend(agent, typed)).toEqual([expected]);
});

it.each([
  ["pi", 1],
  // gentle-shell runs pi under its own name (#4198): pi's skill syntax, whatever herdr labels the pane
  ["gentle-shell", 1],
  ["opencode", 0],
])("keeps the slash menu open past `/skill:` as %s's syntax does", async (agent, rows) => {
  await act(async () => { renderer = create(<Composer paneId={pane} agent={agent} agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={async () => ""} />); });
  await type("/skill:");
  expect(renderer!.root.findAll((node) => node.type === "button" && node.props.role === "option").length).toBe(rows);
});

it("sends a pick the user changed afterwards as typed, trailing space and all", async () => {
  expect(await pickAndSend("opencode", "/ne", "/new  ")).toEqual(["/new  "]);
  act(() => { renderer?.unmount(); });
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer paneId={pane} agent="opencode" agentStatus="idle" connected autoFocus={false} onSend={(...args) => { sent.push(args); return true; }} onAbort={() => {}} onUploadImage={async () => ""} />); });
  await type("/new ");
  await enter();
  expect(sent.map((call) => call[0])).toEqual(["/new "]);
});

it("forgets a pick once it is sent: the same words typed by hand later go as typed", async () => {
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer paneId={pane} agent="opencode" agentStatus="idle" connected autoFocus={false} onSend={(...args) => { sent.push(args); return true; }} onAbort={() => {}} onUploadImage={async () => ""} />); });
  await type("/ne");
  await enter();
  await enter();
  await type("/new ");
  await enter();
  expect(sent.map((call) => call[0])).toEqual(["/new", "/new "]);
});
