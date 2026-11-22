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
import { usageCounters } from "../lib/usageCounters.ts";

const pane = "count-pane", draftKey = `ovis:composer-draft:${pane}`;
const otherPane = "count-other", otherKey = `ovis:composer-draft:${otherPane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let pasteSend = true;
let readText: (() => Promise<string>) | undefined;
let counted: string[];
let countFails: boolean | string = false;
let extraSettings: Partial<settingsModule.Settings> = {};

beforeEach(() => {
  pasteSend = true;
  readText = async () => "from the clipboard";
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0, get clipboard() { return readText === undefined ? undefined : { readText: () => readText!() }; } },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, composerPasteSend: pasteSend, ...extraSettings }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
  composerDrafts.set(otherKey, "");
  counted = [];
  countFails = false;
  extraSettings = {};
  spyOn(usageCounters, "paneUse").mockImplementation((name) => {
    if (countFails === name || (countFails === true && name === "chat_send")) throw new Error("storage full");
    counted.push(name);
  });
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  composerDrafts.set(otherKey, "");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

function props(sent: unknown[][], result: ReturnType<ComposerProps["onSend"]> = true): ComposerProps {
  return { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: (...args) => { sent.push(args); return result; }, onAbort() {}, onUploadImage: async () => "" };
}

const button = () => renderer!.root.findAllByProps({ "aria-label": "Paste and send" }).find((node) => node.type === "button");
async function press(): Promise<void> {
  await act(async () => { button()!.props.onClick(); });
}

it("counts a send once it is taken", async () => {
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await press();
  expect(sent).toHaveLength(1);
  expect(counted.filter((name) => name === "chat_send")).toEqual(["chat_send"]);
});

it("counts no send that is refused", async () => {
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer {...props(sent, "The agent is busy.")} />); });
  await press();
  expect(sent).toHaveLength(1);
  expect(counted).not.toContain("chat_send");
});

it("releases the draft even when counting fails, so the next send goes", async () => {
  const sent: unknown[][] = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  countFails = true;
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await press();
  expect(composerDrafts.read(draftKey).text).toBe("");
  readText = async () => "a second message";
  await press();
  expect(sent.map((call) => call[0])).toEqual(["from the clipboard", "a second message"]);
  expect(logged).toHaveBeenCalled();
});

it("sends through Paste and send even when that button's count fails", async () => {
  const sent: unknown[][] = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  countFails = "composer_paste_send";
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await press();
  expect(sent.map((call) => call[0])).toEqual(["from the clipboard"]);
  expect(logged).toHaveBeenCalled();
});

it("stops the agent even when Stop's count fails", async () => {
  const stopped: string[] = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  countFails = "composer_stop";
  await act(async () => { renderer = create(<Composer {...props([])} agentStatus="working" onAbort={() => { stopped.push("stop"); }} />); });
  const stop = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Stop agent")[0];
  expect(stop).toBeDefined();
  await act(async () => { stop!.props.onClick(); });
  expect(stopped).toEqual(["stop"]);
  expect(logged).toHaveBeenCalled();
});

it.each([
  ["a quick reply", "composer_quick_reply"],
  ["the suggestion", "composer_suggestion"],
])("acts on %s even when its count fails", async (_name, failing) => {
  const sent: unknown[][] = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  countFails = failing;
  extraSettings = { showQuickReplies: true, quickReplies: ["yes"], suggestionChip: true };
  await act(async () => { renderer = create(<Composer {...props(sent)} suggestion="run the tests" />); });
  const target = failing === "composer_quick_reply" ? "Send “yes”" : "Use the suggestion";
  const button = renderer!.root.findAll((node) => node.type === "button" && node.props.title === target)[0];
  expect(button).toBeDefined();
  await act(async () => { button!.props.onClick(); });
  if (failing === "composer_quick_reply") expect(sent.map((call) => call[0])).toEqual(["yes"]);
  else expect(composerDrafts.read(draftKey).text).toBe("run the tests");
  expect(logged).toHaveBeenCalled();
});

it("still draws when telling a control as shown fails", async () => {
  const drawing = spyOn(usageCounters, "draw").mockImplementation(() => { throw new Error("storage full"); });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  await act(async () => { renderer = create(<Composer {...props([])} />); });
  expect(renderer!.root.findAll((node) => node.type === "textarea").length).toBeGreaterThan(0);
  expect(logged).toHaveBeenCalled();
  drawing.mockRestore();
});
