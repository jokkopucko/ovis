import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { replyComments } from "../lib/replyComments.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

const pane = "restored-pane", draftKey = `ovis:composer-draft:${pane}`, commentsKey = `ovis:reply-comments:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
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
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  replyComments.clear(commentsKey);
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

async function resendRestored(restored: string): Promise<unknown[]> {
  const calls: unknown[][] = [];
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: (...args) => { calls.push(args); return true; }, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer = create(<Composer {...props} restored={restored} />); });
  expect(composerDrafts.read(draftKey).text).toBe(restored);
  await act(async () => { composerDrafts.set(draftKey, `${restored} please`); });
  await act(async () => { renderer!.update(<Composer {...props} agent={null} restored={null} />); });
  await act(async () => { renderer!.root.findByProps({ "aria-label": "Send message" }).props.onClick(); });
  return calls.map((call) => call[3]);
}

// #511: a comment message Claude put back on a cancel keeps its agent-only rule when it is edited and sent again
it("sends a restored message with a `> ` quote line only to an agent", async () => {
  expect(await resendRestored("> backup.txt\nKeep this backup")).toEqual([true]);
});

it("sends any other restored message as before (control)", async () => {
  expect(await resendRestored("Keep this backup")).toEqual([undefined]);
});

it.each([
  ["Ctrl+Enter", { ctrlKey: true }, [true]],
  ["Enter", {}, [undefined]],
  ["Cmd+Enter", { metaKey: true }, []],
] as const)("%s in the box sends now only for Ctrl", async (_name, keys, expected) => {
  const calls: unknown[][] = [];
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "working", connected: true, autoFocus: false, onSend: (...args) => { calls.push(args); return true; }, onAbort() {}, onUploadImage: async () => "" };
  composerDrafts.set(draftKey, "steer this");
  await act(async () => { renderer = create(<Composer {...props} />); });
  const box = renderer!.root.findAll((node) => node.type === "textarea" && node.props.onKeyDown !== undefined)[0]!;
  await act(async () => {
    box.props.onKeyDown({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, repeat: false, ...keys, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() {} });
  });
  expect(calls.map((call) => call[4])).toEqual([...expected]);
});

let prevented = false;
async function pressIn(keys: Record<string, unknown>, agentStatus: "working" | "idle", layout: "desktop" | "phone" | "narrow" = "desktop", enterSends: boolean | null = null): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  prevented = false;
  if (layout !== "desktop") Object.assign(window, { matchMedia: (query: string) => ({ matches: layout === "phone" || query.includes("max-width"), addEventListener() {}, removeEventListener() {} }) });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, enterSends }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus, connected: true, autoFocus: false, onSend: (...args) => { calls.push(args); return true; }, onAbort() {}, onUploadImage: async () => "" };
  composerDrafts.set(draftKey, "keep this for later");
  await act(async () => { renderer = create(<Composer {...props} />); });
  const box = renderer!.root.findAll((node) => node.type === "textarea" && node.props.onKeyDown !== undefined)[0]!;
  await act(async () => {
    box.props.onKeyDown({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { prevented = true; }, ...keys });
  });
  return calls.map((call) => [call[4], call[5]]);
}

for (const agentStatus of ["working", "idle"] as const) {
  it.each([
    ["Alt+Enter", { altKey: true }, [[false, true]]],
    ["Enter", {}, [[undefined, undefined]]],
    ["Ctrl+Enter", { ctrlKey: true }, [[true, undefined]]],
    ["Shift+Enter", { shiftKey: true }, []],
    ["Ctrl+Alt+Enter", { ctrlKey: true, altKey: true }, []],
    ["Alt+Shift+Enter", { altKey: true, shiftKey: true }, []],
    ["Cmd+Alt+Enter", { metaKey: true, altKey: true }, []],
    ["an IME's composing Alt+Enter", { altKey: true, nativeEvent: { isComposing: true, keyCode: 13 } }, []],
    ["WebKit's committing Alt+Enter (229)", { altKey: true, nativeEvent: { isComposing: false, keyCode: 229 } }, []],
  ] as const)(`%s while the agent is ${agentStatus} holds only for Alt alone`, async (_name, keys, expected) => {
    expect(await pressIn(keys, agentStatus)).toEqual(expected.map((call) => [...call]));
  });
}

it.each([
  ["a phone", "phone", null],
  ["a phone where Enter sends", "phone", true],
  ["a narrow window with a mouse", "narrow", null],
  ["a narrow window with a mouse where Enter sends", "narrow", true],
] as const)("leaves Alt+Enter on %s as a line break: no send, no hold", async (_name, layout, enterSends) => {
  for (const agentStatus of ["working", "idle"] as const) {
    expect(await pressIn({ altKey: true }, agentStatus, layout, enterSends)).toEqual([]);
    expect(prevented).toBe(false);
    expect(composerDrafts.read(draftKey).text).toBe("keep this for later");
    act(() => { renderer?.unmount(); });
  }
  if (enterSends === true || layout === "narrow") expect(await pressIn({}, "working", layout, enterSends)).toEqual([[undefined, undefined]]);
});

// #3460: with Enter sends off, Ctrl/Cmd+Enter sends but not with Alt held: AltGr (Ctrl+Alt on Windows) and Cmd+Option
// leave the key to the box, as they do where Enter sends
it.each([
  ["Ctrl+Alt+Enter with Enter sends off", { ctrlKey: true, altKey: true }, false, []],
  ["Cmd+Option+Enter with Enter sends off", { metaKey: true, altKey: true }, false, []],
  ["Ctrl+Enter with Enter sends off", { ctrlKey: true }, false, [[undefined, undefined]]],
  ["Cmd+Enter with Enter sends off", { metaKey: true }, false, [[undefined, undefined]]],
  ["Ctrl+Alt+Enter where Enter sends", { ctrlKey: true, altKey: true }, true, []],
  ["Enter where Enter sends", {}, true, [[undefined, undefined]]],
] as const)("%s sends only without Alt", async (_name, keys, enterSends, expected) => {
  expect(await pressIn(keys, "working", "desktop", enterSends)).toEqual(expected.map((call) => [...call]));
  expect(prevented).toBe(expected.length > 0);
});

// #3460: with the completion menu open, Ctrl/Cmd+Enter with Alt (AltGr on Windows, Cmd+Option on a Mac) picks nothing and
// leaves the key to the box, as it sends nothing without the menu; Enter, Tab and Alt+Enter alone still pick
async function pressInMenu(keys: Record<string, unknown>, enterSends: boolean, key = "Enter"): Promise<{ sends: number; text: string }> {
  let sends = 0;
  prevented = false;
  Object.assign(document, { getElementById: () => null });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, enterSends }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([{ name: "review", description: "Review the changes", source: "user" }]);
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "working", connected: true, autoFocus: false, onSend: () => { sends += 1; return true; }, onAbort() {}, onUploadImage: async () => "" };
  composerDrafts.set(draftKey, "/rev");
  await act(async () => { renderer = create(<Composer {...props} />); });
  expect(renderer!.root.findAll((node) => node.props.role === "listbox").length).toBeGreaterThan(0);
  const box = renderer!.root.findAll((node) => node.type === "textarea" && node.props.onKeyDown !== undefined)[0]!;
  await act(async () => {
    box.props.onKeyDown({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { prevented = true; }, ...keys });
  });
  return { sends, text: composerDrafts.read(draftKey).text };
}

for (const enterSends of [false, true]) {
  it.each([
    ["Ctrl+Alt+Enter", { ctrlKey: true, altKey: true }],
    ["Cmd+Option+Enter", { metaKey: true, altKey: true }],
  ] as const)(`%s with the completion menu open picks nothing (Enter sends ${enterSends})`, async (_name, keys) => {
    expect(await pressInMenu(keys, enterSends)).toEqual({ sends: 0, text: "/rev" });
    expect(prevented).toBe(false);
  });

  it.each([
    ["Enter", {}, "Enter"],
    ["Tab", {}, "Tab"],
    ["Alt+Enter", { altKey: true }, "Enter"],
  ] as const)(`%s with the completion menu open still picks the highlighted command (Enter sends ${enterSends})`, async (_name, keys, key) => {
    const { sends, text } = await pressInMenu(keys, enterSends, key);
    expect(sends).toBe(0);
    expect(text.startsWith("/review")).toBe(true);
    expect(prevented).toBe(true);
  });
}

it("keeps the draft and says why when a hold is refused", async () => {
  const calls: unknown[][] = [];
  const refusal = "Update this PC to hold messages. Your draft stayed here.";
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "working", connected: true, autoFocus: false, onSend: (...args) => { calls.push(args); return refusal; }, onAbort() {}, onUploadImage: async () => "" };
  composerDrafts.set(draftKey, "keep this for later");
  await act(async () => { renderer = create(<Composer {...props} />); });
  const box = renderer!.root.findAll((node) => node.type === "textarea" && node.props.onKeyDown !== undefined)[0]!;
  await act(async () => {
    box.props.onKeyDown({ key: "Enter", shiftKey: false, altKey: true, metaKey: false, ctrlKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() {} });
  });
  expect(calls.map((call) => [call[4], call[5]])).toEqual([[false, true]]);
  expect(composerDrafts.read(draftKey).text).toBe("keep this for later");
  type Node = ReturnType<ReactTestRenderer["root"]["findAll"]>[number];
  const textOf = (node: Node | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
  const alerts = renderer!.root.findAll((node) => node.type === "div" && node.props.role === "alert" && node.props.className === "composer-note");
  expect(alerts.map(textOf)).toEqual([refusal]);
});
