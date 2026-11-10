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

// #2369: two tabs on one pane send its draft once, whoever presses Send first
const pane = "cross-tab-pane", draftKey = `ovis:composer-draft:${pane}`, lockName = `ovis-send:${draftKey}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
/** the storage every tab of the origin shares */
let data: Map<string, string>;
let refuseLocks = false;
/** called after each storage read, with what was read already returned to the reader */
let onRead: ((key: string) => void) | null = null;
const leaseKey = `ovis:composer-sending:${draftKey}`;

/** Web Locks as the browser grants them: one holder per name, the others queued in order. */
function locks(): { request(name: string, run: () => unknown): Promise<unknown> } {
  if (refuseLocks) return { request: () => Promise.reject(new DOMException("denied", "SecurityError")) };
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name, run) {
      const next = (tails.get(name) ?? Promise.resolve()).then(run);
      tails.set(name, next.catch(() => undefined));
      return next;
    },
  };
}

function setGlobals(lockManager?: ReturnType<typeof locks>): void {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0, ...(lockManager ? { locks: lockManager } : {}) },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
}

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  setGlobals();
  data = new Map<string, string>();
  onRead = null;
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => {
    const value = data.get(key) ?? null;
    onRead?.(key);
    return value;
  });
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, showQuickReplies: true }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
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
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

/** This tab's composer with `draft` in its box: the messages it sends, and its Send button. */
async function tabWith(draft: string, onSend: (message: string) => ReturnType<ComposerProps["onSend"]> = () => true): Promise<{ sent: string[]; press: () => Promise<void>; disconnect: () => Promise<void>; reconnect: () => Promise<void>; quickReply: () => Promise<string>; unmount: () => Promise<void> }> {
  const sent: string[] = [];
  composerDrafts.set(draftKey, draft);
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: (message) => { sent.push(message); return onSend(message); }, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer = create(<Composer {...props} />); });
  return {
    sent,
    press: () => act(async () => { renderer!.root.findByProps({ "aria-label": "Send message" }).props.onClick(); }),
    disconnect: () => act(async () => { renderer!.update(<Composer {...props} connected={false} />); }),
    reconnect: () => act(async () => { renderer!.update(<Composer {...props} />); }),
    quickReply: async () => {
      const button = renderer!.root.findAll((node) => node.type === "button" && node.props.className === "composer-quick-reply")[0]!;
      await act(async () => { button.props.onClick(); });
      return String(button.props.children);
    },
    unmount: () => act(async () => { renderer!.unmount(); renderer = undefined; }),
  };
}

it("does not send a draft another tab sent while it held the pane's send lock", async () => {
  const lockManager = locks();
  setGlobals(lockManager);
  const tab = await tabWith("deploy");
  // the other tab pressed first: it holds the lock while it claims the draft
  let release = (): void => {};
  const other = lockManager.request(lockName, () => new Promise<void>((resolve) => { release = resolve; }));
  await tab.press();
  expect(tab.sent).toEqual([]);
  // its send is acknowledged and settles the draft; no storage event has reached this tab yet
  data.delete(draftKey);
  await act(async () => { release(); await other; });
  expect(tab.sent).toEqual([]);
});

it("does not send a draft another tab sent before this one heard of it, without Web Locks either", async () => {
  const tab = await tabWith("deploy");
  data.delete(draftKey);
  await tab.press();
  expect(tab.sent).toEqual([]);
});

it("does not send a draft whose other tab's acknowledgement lands while this tab claims it", async () => {
  setGlobals(locks());
  const tab = await tabWith("deploy");
  // the other tab's send of the same draft is on its way
  data.set(leaseKey, JSON.stringify({ sent: "deploy", at: Date.now() }));
  // and is acknowledged as this tab reads the draft: it clears the text, then ends its lease
  onRead = (key) => {
    if (key !== draftKey) return;
    onRead = null;
    data.delete(draftKey);
    data.delete(leaseKey);
  };
  await tab.press();
  expect(tab.sent).toEqual([]);
});

it("settles an acknowledged send as soon as it is acknowledged", async () => {
  setGlobals(locks());
  let acknowledge = (_ok: boolean): void => {};
  const tab = await tabWith("deploy", () => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
  await tab.press();
  expect(tab.sent).toEqual(["deploy"]);
  await act(async () => { acknowledge(true); });
  expect(data.has(draftKey)).toBe(false);
  expect(composerDrafts.read(draftKey).sending).toBe(false);
});

it("does not send a claim that waited for the lock once the terminal disconnected", async () => {
  const lockManager = locks();
  setGlobals(lockManager);
  const tab = await tabWith("deploy");
  let release = (): void => {};
  const other = lockManager.request(lockName, () => new Promise<void>((resolve) => { release = resolve; }));
  await tab.press();
  await tab.disconnect();
  await act(async () => { release(); await other; });
  expect(tab.sent).toEqual([]);
  expect(data.get(draftKey)).toBe("deploy");
});

it("does not send a claim that waited for the lock across a disconnect and reconnect", async () => {
  const lockManager = locks();
  setGlobals(lockManager);
  const tab = await tabWith("deploy");
  let release = (): void => {};
  const other = lockManager.request(lockName, () => new Promise<void>((resolve) => { release = resolve; }));
  await tab.press();
  await tab.disconnect();
  await tab.reconnect();
  await act(async () => { release(); await other; });
  expect(tab.sent).toEqual([]);
  expect(data.get(draftKey)).toBe("deploy");
});

it("does not send a quick reply that waited for the lock once its composer is gone", async () => {
  const lockManager = locks();
  setGlobals(lockManager);
  const tab = await tabWith("");
  let release = (): void => {};
  const other = lockManager.request(lockName, () => new Promise<void>((resolve) => { release = resolve; }));
  await tab.quickReply();
  await tab.unmount();
  await act(async () => { release(); await other; });
  expect(tab.sent).toEqual([]);
});

it("sends at once when the browser refuses the lock", async () => {
  refuseLocks = true;
  try {
    setGlobals(locks());
    const tab = await tabWith("deploy");
    await tab.press();
    expect(tab.sent).toEqual(["deploy"]);
  } finally { refuseLocks = false; }
});

it("sends a draft no other tab sent, once (control)", async () => {
  setGlobals(locks());
  const tab = await tabWith("deploy");
  await tab.press();
  await tab.press();
  expect(tab.sent).toEqual(["deploy"]);
});

it("lets no dictation write into a watch-only composer", async () => {
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, active: true, role: "observe", onSend: () => true, onAbort() {}, onUploadImage: async () => "" };
  const dictation = voiceModule.useDictation as unknown as { mock: { calls: [{ active?: boolean }][] } };
  await act(async () => { renderer = create(<Composer {...props} />); });
  expect(dictation.mock.calls.at(-1)![0].active).toBe(false);
  await act(async () => { renderer!.update(<Composer {...props} role={undefined} />); });
  expect(dictation.mock.calls.at(-1)![0].active).toBe(true);
});

it("disables the quick replies in a watch-only view", async () => {
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, role: "observe", onSend: () => true, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer = create(<Composer {...props} />); });
  const quick = renderer!.root.findAll((node) => node.type === "button" && node.props.className === "composer-quick-reply");
  expect(quick.length).toBeGreaterThan(0);
  expect(quick.map((button) => button.props.disabled)).toEqual(quick.map(() => true));
  await act(async () => { renderer!.update(<Composer {...props} role={undefined} />); });
  expect(renderer!.root.findAll((node) => node.type === "button" && node.props.className === "composer-quick-reply").map((button) => button.props.disabled)).toEqual(quick.map(() => false));
});

// the composer's own render is the only lock a watch-only view has: nothing outside it disables its controls
it("locks what writes in a watch-only view, keeps the background tasks chip, and unlocks when the view takes input again", async () => {
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "working", backgroundTasks: 1, connected: true, autoFocus: false, role: "observe", onSend: () => true, onAbort() {}, onUploadImage: async () => "" };
  await act(async () => { renderer = create(<Composer {...props} />); });
  const disabled = (name: string): boolean[] => renderer!.root.findAll((node) => typeof node.type === "string" && String(node.props.className ?? "").split(" ").includes(name)).map((node) => node.props.disabled === true);
  expect({ text: disabled("composer-text"), attach: disabled("composer-attach"), stop: disabled("composer-stop"), chip: disabled("bg-tasks-toggle") }).toEqual({ text: [true], attach: [true], stop: [true], chip: [false] });
  await act(async () => { renderer!.update(<Composer {...props} role={undefined} />); });
  expect({ text: disabled("composer-text"), attach: disabled("composer-attach"), stop: disabled("composer-stop"), chip: disabled("bg-tasks-toggle") }).toEqual({ text: [false], attach: [false], stop: [false], chip: [false] });
});
