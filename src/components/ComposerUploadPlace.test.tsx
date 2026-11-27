import { afterEach, beforeEach, expect, it, jest, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts, onDraftStorage } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

// #3216: a pasted or picked file's path goes where the paste or pick was made, however the text changes while it uploads
const pane = "upload-place-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: Page;

beforeEach(() => {
  page = openPage("https://ovis.test/");
  for (const [key, value] of Object.entries({ languages: ["en"], userAgent: "test", maxTouchPoints: 0 })) {
    Object.defineProperty(page.window.navigator, key, { configurable: true, value });
  }
  const values = {
    // Run the frame that places pending paths when a composition has ended.
    requestAnimationFrame: (frame: FrameRequestCallback) => { frame(0); return 1; },
    cancelAnimationFrame: () => {},
    ResizeObserver: page.window.ResizeObserver,
  };
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
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
  composerDrafts.set(draftKey, "", "replace");
});

afterEach(async () => {
  await page.close();
  composerDrafts.set(draftKey, "", "replace");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
  uploads.clear();
});

const uploads = new Map<string, { resolve: (path: string) => void; reject: (error: unknown) => void }>();
const path = (name: string) => `/tmp/proj/.ovis/${name}-20261116-101010-0123abcd.png`;

let props: ComposerProps;
/** `restored`: a cancelled send the agent put back in its box, which fills the empty composer; `onSend`: how a send is answered */
async function open(restored: string | null = null, onSend: ComposerProps["onSend"] = () => true): Promise<void> {
  props = {
    paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend, onAbort() {},
    onUploadImage: (file) => new Promise<string>((resolve, reject) => { uploads.set(file.name.replace(/\.png$/u, ""), { resolve, reject }); }),
  };
  await page.render(<Composer {...props} restored={restored} />);
}
const box = () => page.one<HTMLTextAreaElement>('textarea[aria-label="Message"]');
const png = (name: string) => new File([new Uint8Array([1])], `${name}.png`, { type: "image/png" });
/** The user's edit sets both the value and caret before dispatching input. */
async function type(value: string, caret = value.length): Promise<void> {
  await act(async () => {
    const field = box();
    field.value = value;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new page.window.Event("input", { bubbles: true }) as unknown as Event);
  });
}
/** The user's selection, as React sees it on the focused box before the next edit. */
async function select(start: number, end = start): Promise<void> {
  await act(async () => {
    const field = box();
    field.focus();
    field.setSelectionRange(start, end);
    field.dispatchEvent(new page.window.KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" }) as unknown as Event);
  });
}
/** the draft written from elsewhere (a send's acknowledgement, a new or restored draft): a write that is no edit of this box */
async function writeElsewhere(value: string): Promise<void> {
  await act(async () => { composerDrafts.set(draftKey, value, "replace"); });
}
/** another tab's writes, read here at once as its storage event brings them */
async function writeInOtherTab(...values: string[]): Promise<void> {
  await act(async () => {
    for (const value of values) paneLifetimes.paneStorage.setItem(draftKey, value);
    composerDrafts.refresh(draftKey);
  });
}
async function compose(phase: "start" | "end"): Promise<void> {
  if (phase === "end") jest.useFakeTimers();
  try {
    await act(async () => {
      const field = box();
      field.dispatchEvent(new page.window.CompositionEvent(`composition${phase}`, { bubbles: true }) as unknown as Event);
      // React may load before happy-dom exists and listen for the legacy IME keys instead.
      const key = phase === "start" ? { type: "keydown", key: "Process", keyCode: 229 } : { type: "keyup", key: "Enter", keyCode: 13 };
      field.dispatchEvent(new page.window.KeyboardEvent(key.type, { ...key, bubbles: true }) as unknown as Event);
      if (phase === "end") jest.runOnlyPendingTimers();
    });
  } finally {
    if (phase === "end") jest.useRealTimers();
  }
}
const tiles = () => page.container.querySelectorAll<HTMLElement>(".composer-attachment");
const badges = () => [...tiles()].map((tile) => tile.className.slice("composer-attachment is-".length));
const announced = () => [...page.container.querySelectorAll('[aria-live="polite"] span')].map((span) => span.textContent).join("");
const hint = () => page.container.querySelector(".composer-status-hint")?.getAttribute("title") ?? "";
const sendOff = () => page.one<HTMLButtonElement>('button[aria-label="Send message"]').disabled;
const button = (name: string) => {
  const found = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent === name);
  if (!found) throw new Error(`No button named ${name}`);
  return found;
};
async function pasteFiles(...names: string[]): Promise<void> {
  const event = new page.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => "", items: names.map((name) => ({ kind: "file", getAsFile: () => png(name) })) } });
  await act(async () => { box().dispatchEvent(event as unknown as Event); });
}
async function paste(at: number, ...names: string[]): Promise<void> {
  box().setSelectionRange(at, at);
  await pasteFiles(...names);
}
async function pick(at: number, ...names: string[]): Promise<void> {
  box().setSelectionRange(at, at);
  const input = page.one<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: names.map(png) });
  await act(async () => { input.dispatchEvent(new page.window.Event("change", { bubbles: true }) as unknown as Event); });
}
function pendingUpload(name: string) {
  const pending = uploads.get(name);
  if (!pending) throw new Error(`No pending upload named ${name}`);
  return pending;
}
async function finish(name: string): Promise<void> {
  await act(async () => { pendingUpload(name).resolve(path(name)); });
}

it("detaches an upload when another tab clears the draft before it finishes", async () => {
  await open();
  await type("old question");
  await paste(4, "shot");
  await act(async () => {
    paneLifetimes.paneStorage.removeItem(draftKey);
    onDraftStorage(draftKey);
  });
  await finish("shot");
  expect(box().value).toBe("");
  expect(badges()).toEqual([]);
});

it("keeps a space typed between the path and its separator on Remove", async () => {
  await open();
  await type("leftright");
  await pick(4, "shot");
  await finish("shot");
  const text = box().value, at = text.indexOf(".png") + 4;
  await select(at);
  await type(`${text.slice(0, at)} note${text.slice(at)}`, at + 5);
  await act(async () => { button("Remove shot.png").click(); });
  expect(box().value).toBe("left note right");
});

it("removes an image restored by undo while Send awaited its acknowledgement", async () => {
  const sent: string[] = [];
  let acknowledge!: (ok: boolean) => void;
  await open(null, (message) => {
    sent.push(message);
    return sent.length === 1 ? new Promise<boolean>((resolve) => { acknowledge = resolve; }) : true;
  });
  await type("before after");
  await paste(7, "shot");
  await finish("shot");
  const whole = box().value, cut = whole.indexOf(".png");
  await act(async () => { button("Send message").click(); });
  await select(cut, cut + 1);
  await type(whole.slice(0, cut) + whole.slice(cut + 1), cut);
  await type(whole);
  await act(async () => { acknowledge(true); });
  await act(async () => { button("Remove shot.png").click(); });
  await act(async () => { button("Send message").click(); });
  expect(sent).toEqual([whole, "before after"]);
});

it("keeps a selected slash command and its arguments separate from the arriving path", async () => {
  const sent: string[] = [], command = "/review this please";
  await open(null, (message) => { sent.push(message); return true; });
  await type(command);
  await paste(8, "shot");
  await select(0, command.length);
  await finish("shot");
  const field = box(), { selectionStart, selectionEnd } = field;
  expect(field.value.slice(selectionStart, selectionEnd)).toBe(command);
  await type(`Review this${field.value.slice(selectionEnd)}`, 11);
  await act(async () => { button("Send message").click(); });
  expect(sent).toEqual([`Review this @${path("shot")} `]);
});

it("keeps pick order when a selection moves a batch and the second upload finishes first", async () => {
  await open();
  await type("before after");
  await pick(7, "one", "two");
  await select(3, 10);
  await finish("two");
  await finish("one");
  expect(box().value).toBe(`@${path("one")} @${path("two")} before after`);
});

it("pastes at the visible caret on line two of a restored CRLF draft", async () => {
  const sent: string[] = [];
  await open("one\r\ntwo words", (message) => { sent.push(message); return true; });
  // happy-dom does not normalize a textarea's value to LF as browsers do.
  box().value = "one\ntwo words";
  await select(4);
  await paste(4, "shot");
  await finish("shot");
  await act(async () => { button("Send message").click(); });
  expect(sent).toEqual([`one\r\n@${path("shot")} two words`]);
});

it("keeps the second-line pick point through a textarea edit that normalizes CRLF", async () => {
  await open("one\r\ntwo words");
  await pick(4, "shot");
  await type("one\ntwo words!");
  await finish("shot");
  expect(box().value).toBe(`one\n@${path("shot")} two words!`);
});

it("releases Send when another tab clears and restores a full draft with a waiting image", async () => {
  await open();
  const full = "x".repeat(20_000);
  await type(full);
  await paste(0, "shot");
  await finish("shot");
  expect(badges()).toEqual(["no-room"]);
  await act(async () => {
    paneLifetimes.paneStorage.removeItem(draftKey);
    paneLifetimes.paneStorage.setItem(draftKey, full);
    onDraftStorage(draftKey);
    onDraftStorage(draftKey);
  });
  expect({ tiles: badges(), sendDisabled: sendOff() }).toEqual({ tiles: [], sendDisabled: false });
});

it("puts a pasted image's path where it was pasted, after edits made before and after it while it uploads", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  await type("before after more");
  await type("so before after more", 2);
  // the user has selected "so", and the box is not focused: both stay as they are
  box().setSelectionRange(0, 2);
  await finish("shot");
  expect(box().value).toBe(`so before @${path("shot")} after more`);
  expect([box().selectionStart, box().selectionEnd, box() === document.activeElement]).toEqual([0, 2, false]);
});

it("keeps the selected text and moves the selection with it when the path goes before it", async () => {
  await open();
  await type("before after", 7);
  box().setSelectionRange(7, 12);
  await pasteFiles("shot");
  await finish("shot");
  const value = box().value;
  expect(value).toBe(`before @${path("shot")} after`);
  expect(value.slice(box().selectionStart, box().selectionEnd)).toBe("after");
});

it("keeps the order of files picked together, however their uploads finish", async () => {
  await open();
  await type("look at these please", 14);
  await pick(14, "one", "two");
  await finish("two");
  await finish("one");
  expect(box().value).toBe(`look at these @${path("one")} @${path("two")} please`);
});

it("waits for a Korean IME composition to end, then goes before the syllable composed at its place", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  await compose("start");
  await type("before ㅎafter", 8);
  await type("before 하after", 8);
  await finish("shot");
  await type("before 한after", 8);
  expect(box().value).toBe("before 한after");
  await compose("end");
  expect(box().value).toBe(`before @${path("shot")} 한after`);
});

it("never puts the path of an upload started in a draft cleared elsewhere into the new one, and detaches its file", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  expect(tiles().length).toBe(1);
  await writeElsewhere("");
  await type("new draft");
  await finish("shot");
  expect(box().value).toBe("new draft");
  expect(tiles().length).toBe(0);
  // only detached from this message, said in one line for assistive tech, with nothing new on screen
  expect(announced()).toBe("shot.png detached from the message");
  expect(hint()).toBe("");
});

it("puts the path of an upload whose draft was typed over whole before the new words, never inside one", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  // the whole draft selected, then typed over: an edit in the box, so the place goes where it began
  await select(0, 12);
  await type("b", 1);
  await type("brand new after");
  await finish("shot");
  expect(box().value).toBe(`@${path("shot")} brand new after`);
  expect(badges()).toEqual(["ready"]);
});

it("moves a later paste's place once for each path placed before it, whichever upload finishes first", async () => {
  await open();
  await type("one two three", 13);
  await paste(8, "late");
  await paste(4, "early");
  await finish("early");
  await finish("late");
  expect(box().value).toBe(`one @${path("early")} two @${path("late")} three`);
});

it("keeps the order of files picked together inside a leading slash command", async () => {
  await open();
  await type("/review the menu", 3);
  await pick(3, "one", "two");
  await finish("one");
  await finish("two");
  expect(box().value).toBe(`/review @${path("one")} @${path("two")} the menu`);
});

it("takes a removed attachment's path out of the text when it was placed before a line break", async () => {
  await open();
  await type("before\nafter", 6);
  await paste(6, "shot");
  await finish("shot");
  expect(box().value).toBe(`before @${path("shot")}\nafter`);
  const remove = button("Remove shot.png");
  await act(async () => { remove.click(); });
  expect(box().value).toBe("before\nafter");
  expect(tiles().length).toBe(0);
});

it("keeps the user's own space when a path placed after it, before a line break, is removed", async () => {
  await open();
  await type("before \nafter", 7);
  await paste(7, "shot");
  await finish("shot");
  expect(box().value).toBe(`before @${path("shot")}\nafter`);
  const remove = button("Remove shot.png");
  await act(async () => { remove.click(); });
  expect(box().value).toBe("before \nafter");
});

it("puts a retried upload's path where the paste was made", async () => {
  await open();
  await type("before after", 7);
  await paste(7, "shot");
  await act(async () => { pendingUpload("shot").reject(new Error("offline")); });
  await type("so before after", 2);
  const retry = button("Try again");
  await act(async () => { retry.click(); });
  await finish("shot");
  expect(box().value).toBe(`so before @${path("shot")} after`);
});

// an edit made in the box never discards a file: its place goes where the edit began
it("keeps a file pasted during a Korean composition in an empty box, and puts its path before the syllable", async () => {
  await open();
  await compose("start");
  await type("ㅎ", 1);
  await paste(1, "shot");
  await type("하", 1);
  await type("한", 1);
  await finish("shot");
  await compose("end");
  expect(box().value).toBe(`@${path("shot")} 한`);
  expect(tiles().length).toBe(1);
});

it("keeps a file whose draft was backspaced empty, and puts its path before what is typed next", async () => {
  await open();
  await type("hi");
  await paste(2, "shot");
  await type("h", 1);
  await type("", 0);
  await type("look at this");
  await finish("shot");
  expect(box().value).toBe(`@${path("shot")} look at this`);
  expect(badges()).toEqual(["ready"]);
});

it("keeps a failed upload and its Try again when the box is emptied", async () => {
  await open();
  await type("hi");
  await paste(2, "shot");
  await act(async () => { pendingUpload("shot").reject(new Error("offline")); });
  await type("h", 1);
  await type("", 0);
  await act(async () => { button("Try again").click(); });
  await finish("shot");
  expect(box().value).toBe(`@${path("shot")} `);
});

it("keeps a selection that ends at the place before the path, and puts the path before one that spans it, Send not held", async () => {
  await open();
  await type("look at this");
  await paste(12, "shot");
  await select(8, 12);
  await finish("shot");
  expect(box().value).toBe(`look at this @${path("shot")} `);
  expect(box().value.slice(box().selectionStart, box().selectionEnd)).toBe("this");

  await type("before after", 7);
  await paste(7, "next");
  await select(3, 10);
  await finish("next");
  // nothing waits: the path goes before the selection's first word, the selection stays on the same text
  const placed = `@${path("next")} `;
  expect(box().value).toBe(`${placed}before after`);
  expect(box().value.slice(box().selectionStart, box().selectionEnd)).toBe("ore aft");
  expect(badges()).toEqual(["ready"]);
  expect(sendOff()).toBe(false);
  // typed over: the selected text goes, and the path stays whole
  await type(`${placed}befXer`, placed.length + 4);
  expect(badges()).toEqual(["ready"]);
});

it("takes a removed attachment's path out of the text when it was placed before a tab", async () => {
  await open();
  await type("before\tafter", 6);
  await paste(6, "shot");
  await finish("shot");
  expect(box().value).toBe(`before @${path("shot")}\tafter`);
  await act(async () => { button("Remove shot.png").click(); });
  expect(box().value).toBe("before\tafter");
});

it("never puts the path inside an emoji typed over the place", async () => {
  await open();
  await type("x\u{1F600}a");
  await paste(3, "shot");
  await select(1, 4);
  await type("x\u{1F603}", 3);
  await type("x\u{1F603}b", 4);
  await finish("shot");
  // the emoji typed over the place stays whole: no half of it is cut off by the path
  expect(box().value).toBe(`x @${path("shot")} \u{1F603}b`);
});

it("follows the copy of repeated words the caret typed in", async () => {
  await open();
  await type("go go now", 6);
  await paste(6, "shot");
  await select(0);
  await type("go go go now", 3);
  await finish("shot");
  expect(box().value).toBe(`go go go @${path("shot")} now`);
});

it("never puts the path into a draft another tab replaced, whatever the two share", async () => {
  await open();
  await type("hello world");
  await paste(11, "shot");
  await writeElsewhere("hello other");
  await finish("shot");
  expect(box().value).toBe("hello other");
  expect(tiles().length).toBe(0);
});

it("detaches a file whose draft was replaced elsewhere, in one line for assistive tech, and holds no Send", async () => {
  await open();
  await type("hello world");
  await paste(11, "shot");
  await writeElsewhere("hello other");
  await finish("shot");
  expect(tiles().length).toBe(0);
  // only detached from this message, said in one line for assistive tech, with nothing new on screen
  expect(announced()).toBe("shot.png detached from the message");
  expect(hint()).toBe("");
  expect(sendOff()).toBe(false);
});

it("never puts a dropped file's path into a draft another tab replaced", async () => {
  await open();
  await type("hello");
  const drop = new page.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [png("shot")] } });
  await act(async () => { page.one(".composer-surface").dispatchEvent(drop as unknown as Event); });
  await writeElsewhere("other");
  await finish("shot");
  expect(box().value).toBe("other");
});

it("puts a path that waited on a restored /command in once the untouched fill is cleared", async () => {
  await open("/compact");
  expect(box().value).toBe("/compact");
  await pick(8, "shot");
  await finish("shot");
  expect(box().value).toBe("/compact");
  await page.render(<Composer {...props} restored={null} />);
  expect(box().value).toBe(`@${path("shot")} `);
});

it("puts a file picked during an IME composition before the syllable being composed", async () => {
  await open();
  await type("abc ", 4);
  await compose("start");
  await type("abc ㅎ", 5);
  await pick(5, "shot");
  await type("abc 한", 5);
  await finish("shot");
  await compose("end");
  expect(box().value).toBe(`abc @${path("shot")} 한`);
});

it("puts a file picked while a syllable is being composed in an empty box in when the IME commits it, with no click", async () => {
  await open();
  await compose("start");
  await type("한", 1);
  await pick(1, "shot");
  await finish("shot");
  // the commit, as Chromium sends it: the candidate it selects may be cleared before the syllable is written
  box().setSelectionRange(0, 1);
  await type("", 0);
  await type("한", 1);
  await compose("end");
  expect(box().value).toBe(`@${path("shot")} 한`);
  expect(badges()).toEqual(["ready"]);
});

// a selection that ends at the place, typed over while the file uploads: the path goes before the new word
it("puts the path before a word typed over a selection that ends at the place, never inside it", async () => {
  await open();
  await type("fix this bug", 8);
  await paste(8, "shot");
  await select(4, 8);
  await type("fix t bug", 5);
  await type("fix that bug", 8);
  await finish("shot");
  expect(box().value).toBe(`fix @${path("shot")} that bug`);
});

it.each([["a composing keyboard", ["n", "ne", "new"]], ["a Korean IME", ["한", "한국"]]] as const)("puts the path before a whole draft typed over with %s, never inside the first word", async (_name, steps) => {
  await open();
  await type("look at this", 12);
  await paste(12, "shot");
  await select(0, 12);
  await compose("start");
  for (const step of steps) await type(step, step.length);
  await compose("end");
  await finish("shot");
  expect(box().value).toBe(`@${path("shot")} ${steps.at(-1)}`);
});

// a draft another tab rewrites is replaced, even when the new text begins with the old one
it("never puts the path into a draft another tab rewrote in writes read at once, though it begins with the old one", async () => {
  await open();
  await type("hello", 5);
  await paste(5, "shot");
  await writeInOtherTab("", "hello, a new unrelated question");
  await finish("shot");
  expect(box().value).toBe("hello, a new unrelated question");
  expect(tiles().length).toBe(0);
});

it("never puts the path of a file picked into a restored message, cleared since, into what is typed next", async () => {
  await open("please retry this");
  await pick(17, "shot");
  await page.render(<Composer {...props} restored={null} />);
  expect(box().value).toBe("");
  await type("brand new");
  await finish("shot");
  expect(box().value).toBe("brand new");
  expect(tiles().length).toBe(0);
});

it("keeps the path of a quote added after the pick, as an append that moves no place", async () => {
  await open();
  await type("look at this", 8);
  await paste(8, "shot");
  await act(async () => { composerDrafts.set(draftKey, "look at this\n\n> quoted", "append"); });
  await finish("shot");
  expect(box().value).toBe(`look at @${path("shot")} this\n\n> quoted`);
});

// once placed, the tile follows the path: when it is gone from the message, the tile says so and Send waits
it.each([
  // "at @path" selected and typed over with "the cat": " this" stays
  ["a selection over it typed over", async (value: string) => { await select(5, value.length - 5); await type(`look the cat${value.slice(-5)}`, 12); }],
  ["backspace through it", async (value: string) => { const cut = value.indexOf(".png"); await type(value.slice(0, cut) + value.slice(cut + 1), cut); }],
  ["the whole draft typed over", async (value: string) => { await select(0, value.length); await type("n", 1); await type("new words"); }],
  ["another tab replacing the draft", async () => { await writeInOtherTab("something else"); }],
] as const)("detaches the file once its placed path is no longer in the message, %s; nothing new on screen, Send not held", async (_name, edit) => {
  await open();
  await type("look at this", 8);
  await paste(8, "shot");
  await finish("shot");
  expect(badges()).toEqual(["ready"]);
  await edit(box().value);
  expect(tiles().length).toBe(0);
  expect(announced()).toBe("shot.png detached from the message");
  expect(hint()).toBe("");
  expect(sendOff()).toBe(false);
});

it("removes the path the upload put in, not the user's own copy of it earlier", async () => {
  await open();
  await type(`see @${path("shot")} x`);
  await paste((box().value).length, "shot");
  await finish("shot");
  expect(box().value).toBe(`see @${path("shot")} x @${path("shot")} `);
  await act(async () => { button("Remove shot.png").click(); });
  expect(box().value).toBe(`see @${path("shot")} x`);
});


// a send's acknowledgement is this box's own edit: a path placed while the send was on its way stays attached
it("keeps a path placed while a send was on its way attached once the send is acknowledged, and Remove takes it out", async () => {
  let acknowledge!: (ok: boolean) => void;
  await open(null, () => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
  await type("first");
  await act(async () => { button("Send message").click(); });
  await type("first second");
  await paste(12, "shot");
  await finish("shot");
  expect(box().value).toBe(`first second @${path("shot")} `);
  await act(async () => { acknowledge(true); });
  expect(box().value).toBe(` second @${path("shot")} `);
  expect(badges()).toEqual(["ready"]);
  await act(async () => { button("Remove shot.png").click(); });
  expect(box().value).toBe(" second");
});

// every storage event on the draft is another tab's write, even one that leaves the same text
it("never puts the path into a draft another tab cleared and retyped the same, both read at once", async () => {
  await open();
  await type("hello", 5);
  await paste(5, "shot");
  await act(async () => {
    paneLifetimes.paneStorage.removeItem(draftKey);
    paneLifetimes.paneStorage.setItem(draftKey, "hello");
    onDraftStorage(draftKey);
    onDraftStorage(draftKey);
  });
  await finish("shot");
  expect(box().value).toBe("hello");
  expect(tiles().length).toBe(0);
});

it("keeps a space the user typed where the upload's own space was, when the file is removed", async () => {
  await open();
  await paste(0, "shot");
  await finish("shot");
  const placed = box().value;
  await type(placed.slice(0, -1), placed.length - 1);
  await type(`${placed.slice(0, -1)} more`, placed.length + 4);
  await act(async () => { button("Remove shot.png").click(); });
  expect(box().value).toBe(" more");
});

it("puts the path before a word typed on straight from where it was pasted, never inside it", async () => {
  await open();
  await type("scree", 5);
  await paste(5, "shot");
  await type("screen", 6);
  await type("screenshot", 10);
  await finish("shot");
  expect(box().value).toBe(`@${path("shot")} screenshot`);
});

// an undo of the edit that took a file out brings its path and its tile back
it.each([
  ["a character deleted from the path", (value: string) => { const cut = value.indexOf(".png"); return [value.slice(0, cut) + value.slice(cut + 1), cut] as const; }],
  ["the whole draft typed over", () => ["new words", 9] as const],
] as const)("brings the path and its tile back when %s is undone", async (_name, erase) => {
  await open();
  await type("look at this", 8);
  await paste(8, "shot");
  await finish("shot");
  const whole = box().value;
  const [erased, caret] = erase(whole);
  await select(0, whole.length);
  await type(erased, caret);
  expect(tiles().length).toBe(0);
  // the undo: the text as it was before that edit
  await type(whole, whole.length);
  expect(box().value).toBe(whole);
  expect(badges()).toEqual(["ready"]);
  expect(hint()).toBe("");
  await act(async () => { button("Remove shot.png").click(); });
  expect(box().value).toBe("look at this");
});

it("leaves what is left of a partly deleted path as the user's own text, and sends nothing until Send, then as shown", async () => {
  const sent: string[] = [];
  await open(null, (message) => { sent.push(message); return true; });
  await type("look at this", 8);
  await paste(8, "shot");
  await finish("shot");
  const whole = box().value;
  const cut = whole.indexOf(".png");
  const partly = whole.slice(0, cut) + whole.slice(cut + 1);
  await type(partly, cut);
  expect(tiles().length).toBe(0);
  expect(box().value).toBe(partly);
  expect(sent).toEqual([]);
  await act(async () => { button("Send message").click(); });
  expect(sent).toEqual([partly]);
});

// a paste or pick with the caret inside a placed path puts the new path at the front of that one; both stay whole
it.each([["pasted", "paste"], ["picked", "pick"]] as const)("keeps a placed path whole when another file is %s inside it, and Remove takes out only each file's own path", async (_name, how) => {
  await open();
  await type("see ", 4);
  await paste(4, "a");
  await finish("a");
  const a = `@${path("a")}`;
  expect(box().value).toBe(`see ${a} `);
  // the box holds the path as the browser shows it, with the caret after "@/tmp/"
  if (how === "paste") await paste(4 + "@/tmp/".length, "b"); else await pick(4 + "@/tmp/".length, "b");
  await finish("b");
  const b = `@${path("b")}`;
  expect(box().value).toBe(`see ${b} ${a} `);
  expect(badges()).toEqual(["ready", "ready"]);
  await act(async () => { button("Remove a.png").click(); });
  expect(box().value).toBe(`see ${b} `);
  expect(badges()).toEqual(["ready"]);
  await act(async () => { button("Remove b.png").click(); });
  expect(box().value).toBe("see ");
});

// files picked together inside a placed path go in front of it in pick order, however their uploads finish
it.each([["b", "c", "d"], ["b", "d", "c"], ["c", "b", "d"], ["c", "d", "b"], ["d", "b", "c"], ["d", "c", "b"]] as const)("keeps the pick order of files picked together inside a placed path when they finish %s, %s, %s", async (first, second, third) => {
  await open();
  await type("see ", 4);
  await paste(4, "a");
  await finish("a");
  await pick(4 + "@/tmp/".length, "b", "c", "d");
  for (const name of [first, second, third]) await finish(name);
  expect(box().value).toBe(`see @${path("b")} @${path("c")} @${path("d")} @${path("a")} `);
  expect(badges()).toEqual(["ready", "ready", "ready", "ready"]);
});

// Remove never glues the path beside it to a word: one space stays, and that file stays attached
it.each([
  ["two files picked together at the end of a word", async () => { await type("x", 1); await pick(1, "one", "two"); await finish("one"); await finish("two"); }],
  ["a second file pasted at the end of the first one's path", async () => {
    await type("x", 1);
    await paste(1, "one");
    await finish("one");
    await paste(1 + ` @${path("one")}`.length, "two");
    await finish("two");
  }],
] as const)("keeps the other path apart from the word before it when the first is removed: %s", async (_name, setUp) => {
  await open();
  await setUp();
  expect(box().value).toBe(`x @${path("one")} @${path("two")} `);
  await act(async () => { button("Remove one.png").click(); });
  expect(box().value).toBe(`x @${path("two")} `);
  expect(badges()).toEqual(["ready"]);
  expect(sendOff()).toBe(false);
});

// a finished upload whose draft another tab replaced with a lone /command is detached at once: Send is not held
it("detaches a finished upload at once when another tab replaced its draft with a lone /command, and holds no Send", async () => {
  await open();
  await type("hello", 5);
  await paste(5, "shot");
  await writeInOtherTab("/help");
  await finish("shot");
  expect(box().value).toBe("/help");
  expect(tiles().length).toBe(0);
  expect(sendOff()).toBe(false);
  expect(announced()).toBe("shot.png detached from the message");
});

// the space before a path that another path went in front of is now that path's: Remove never takes it
it("keeps the front path apart from the next word when the path it went in front of is removed", async () => {
  await open();
  await type("see", 3);
  await paste(3, "a");
  await finish("a");
  const a = `@${path("a")}`;
  await type(`see ${a} more`);
  await paste(4 + "@/tmp/".length, "b");
  await finish("b");
  const b = `@${path("b")}`;
  expect(box().value).toBe(`see ${b} ${a} more`);
  await act(async () => { button("Remove a.png").click(); });
  expect(box().value).toBe(`see ${b} more`);
  expect(badges()).toEqual(["ready"]);
  expect(sendOff()).toBe(false);
});
