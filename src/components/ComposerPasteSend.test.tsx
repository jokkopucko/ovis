import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { MAX_COMPOSER_CHARS } from "../lib/compose.ts";
import { formatChars } from "../lib/composerLength.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

const pane = "paste-pane", draftKey = `ovis:composer-draft:${pane}`;
const otherPane = "paste-other", otherKey = `ovis:composer-draft:${otherPane}`;
let page: Page;
const frameGlobals = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let pasteSend = true;
let readText: (() => Promise<string>) | undefined;

beforeEach(() => {
  pasteSend = true;
  readText = async () => "from the clipboard";
  page = openPage("https://ovis.test/");
  Object.defineProperty(page.window.navigator, "clipboard", { configurable: true, get: () => readText === undefined ? undefined : { readText } });
  for (const key of frameGlobals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: page.window.ResizeObserver });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, composerPasteSend: pasteSend }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "", "replace");
  composerDrafts.set(otherKey, "", "replace");
});

afterEach(async () => {
  await page.close();
  composerDrafts.set(draftKey, "", "replace");
  composerDrafts.set(otherKey, "", "replace");
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

const button = () => page.container.querySelector<HTMLButtonElement>('button[aria-label="Paste and send"]');
const note = () => {
  const line = page.container.querySelector('[class="composer-note-text"]');
  return line === null ? null : [...line.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("");
};
async function press(): Promise<void> {
  await act(async () => { page.one('button[aria-label="Paste and send"]').click(); });
}

it("draws no Paste and send button until this device turns it on", async () => {
  pasteSend = false;
  await page.render(<Composer {...props([])} />);
  expect(button()).toBeNull();
});

it("sends the clipboard's text as a message, through Send", async () => {
  const sent: unknown[][] = [];
  await page.render(<Composer {...props(sent)} />);
  await press();
  expect(sent.map((call) => call[0])).toEqual(["from the clipboard"]);
  expect(composerDrafts.read(draftKey).text).toBe("");
});

it("keeps the clipboard's text in the box when the send is refused", async () => {
  const sent: unknown[][] = [];
  await page.render(<Composer {...props(sent, "The agent is busy.")} />);
  await press();
  expect(sent).toHaveLength(1);
  expect(composerDrafts.read(draftKey).text).toBe("from the clipboard");
  expect(note()).toBe("The agent is busy.");
});

it("is off over a draft, and leaves the draft alone", async () => {
  const sent: unknown[][] = [];
  composerDrafts.set(draftKey, "my own words", "replace");
  await page.render(<Composer {...props(sent)} />);
  expect(button()?.disabled).toBe(true);
  await press();
  expect(sent).toEqual([]);
  expect(composerDrafts.read(draftKey).text).toBe("my own words");
});

it.each([
  ["a refused read", () => Promise.reject(new Error("denied")), "The clipboard could not be read. Use the keyboard's own paste in the message box."],
  ["an empty clipboard", async () => "  \n", "Nothing to paste: the clipboard is empty."],
  ["text over the limit", async () => "x".repeat(MAX_COMPOSER_CHARS + 1), `The clipboard holds more than a message's ${formatChars(MAX_COMPOSER_CHARS)} characters. Nothing was sent.`],
])("sends nothing and says why on %s", async (_name, read, said) => {
  const sent: unknown[][] = [];
  readText = read;
  await page.render(<Composer {...props(sent)} />);
  await press();
  expect(sent).toEqual([]);
  expect(composerDrafts.read(draftKey).text).toBe("");
  expect(note()).toBe(said);
});

it("says to paste by hand where the clipboard cannot be read", async () => {
  const sent: unknown[][] = [];
  readText = undefined;
  await page.render(<Composer {...props(sent)} />);
  await press();
  expect(sent).toEqual([]);
  expect(note()).toBe("Paste is not available here. Use the keyboard's own paste in the message box.");
});

it.each([
  ["another pane is shown", (base: ComposerProps) => <Composer {...base} paneId={otherPane} />, otherKey],
  ["the connection drops", (base: ComposerProps) => <Composer {...base} connected={false} />, draftKey],
  ["the box gets a draft", null, draftKey],
])("sends nothing when %s while the clipboard is read", async (_name, change, key) => {
  const sent: unknown[][] = [];
  let answer: (text: string) => void = () => {};
  readText = () => new Promise((resolve) => { answer = resolve; });
  const base = props(sent);
  await page.render(<Composer {...base} />);
  await press();
  if (change === null) await act(async () => { composerDrafts.set(draftKey, "typed meanwhile", "replace"); });
  else await page.render(change(base));
  await act(async () => { answer("from the clipboard"); });
  expect(sent).toEqual([]);
  expect(composerDrafts.read(key).text).toBe(change === null ? "typed meanwhile" : "");
});

it.each([
  ["the box is typed in and cleared", [() => composerDrafts.set(draftKey, "typed", "replace"), () => composerDrafts.set(draftKey, "", "replace")], ""],
  ["another tab stores a draft", [() => paneLifetimes.paneStorage.setItem(draftKey, "another tab's draft")], "another tab's draft"],
] as const)("sends nothing when %s while the clipboard is read", async (_name, changes, left) => {
  const sent: unknown[][] = [];
  let answer: (text: string) => void = () => {};
  readText = () => new Promise((resolve) => { answer = resolve; });
  await page.render(<Composer {...props(sent)} />);
  await press();
  for (const change of changes) await act(async () => { change(); });
  await act(async () => { answer("from the clipboard"); });
  expect(sent).toEqual([]);
  expect(paneLifetimes.paneStorage.getItem(draftKey) ?? "").toBe(left);
});

it("reads the clipboard once for a double press", async () => {
  const sent: unknown[][] = [];
  let reads = 0;
  let answer: (text: string) => void = () => {};
  readText = () => { reads++; return new Promise((resolve) => { answer = resolve; }); };
  await page.render(<Composer {...props(sent)} />);
  const first = button()!;
  await act(async () => { first.click(); first.click(); });
  await act(async () => { answer("from the clipboard"); });
  expect(reads).toBe(1);
  expect(sent).toHaveLength(1);
});

it("clears a sent paste with CRLF line breaks when an IME that changed nothing ends while it is on its way", async () => {
  const sent: unknown[][] = [];
  let acknowledge: (result: true) => void = () => {};
  const results: ReturnType<ComposerProps["onSend"]>[] = ["The agent is busy.", new Promise<true>((resolve) => { acknowledge = resolve; })];
  readText = async () => "one\r\ntwo";
  await page.render(<Composer {...props(sent)} onSend={(...args) => { sent.push(args); return results.shift()!; }} />);
  await press();
  expect(composerDrafts.read(draftKey).text).toBe("one\r\ntwo");
  const box = page.one<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  await act(async () => {
    box.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(sent).toHaveLength(2);
  // a textarea reports its line breaks as \n whatever the draft holds
  await act(async () => {
    box.setSelectionRange(7, 7);
    box.dispatchEvent(new page.window.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event);
    box.dispatchEvent(new page.window.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event);
  });
  await act(async () => { acknowledge(true); });
  expect(composerDrafts.read(draftKey).text).toBe("");
  expect(note()).toBeNull();
});
