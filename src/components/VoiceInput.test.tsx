import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider, useSettings } from "../lib/settings.ts";
import * as voiceLib from "../lib/voice.ts";
import type { VoiceEngine, VoiceInput, VoiceState, VoiceText } from "../lib/voice.ts";
import { MicButton, useDictation, type Dictation } from "./VoiceInput.tsx";

describe("MicButton", () => {
  let page: Page;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    page = openPage();
  });

  afterEach(async () => {
    await page.close();
  });

  async function mic(engine: VoiceEngine, state: VoiceState = "idle") {
    const voice = {
      available: true, unavailableReason: null, engine, state, elapsedMs: 0, silent: false, error: null,
      press: () => {}, release: () => calls.push("release"), finish: () => calls.push("finish"), cancel: () => {},
      bindBars: () => {}, bindRing: () => {}, bindMeter: () => {},
    } satisfies VoiceInput;
    const dictation: Dictation = { shown: true, connected: true, voice, forget: () => {}, partial: "", press: () => calls.push("press") };
    const view = () => <SettingsProvider><MicButton dictation={{ ...dictation, voice: { ...voice } }} /></SettingsProvider>;
    await page.render(view());
    const button = () => page.one<HTMLButtonElement>("button");
    const pointer = (type: string, pointerType: string, pointerId = 1, mouseButton = 0) => act(async () => {
      button().dispatchEvent(new window.PointerEvent(type, { button: mouseButton, pointerType, pointerId, bubbles: true, cancelable: true }));
    });
    return {
      down: (pointerType: string, pointerId?: number, mouseButton?: number) => pointer("pointerdown", pointerType, pointerId, mouseButton),
      up: (pointerType: string, pointerId?: number, mouseButton?: number) => pointer("pointerup", pointerType, pointerId, mouseButton),
      click: () => act(async () => { button().dispatchEvent(new window.MouseEvent("click", { detail: 1, bubbles: true })); }),
      becomes: (next: VoiceState) => { voice.state = next; return page.render(view()); },
    };
  }

  // iOS WebKit lets SpeechRecognition.start() run only from a user activation, and a touch's
  // pointerdown is none: a take started there ends in "not-allowed" (#2343)
  it("starts the browser engine from a touch tap's click, not its pointerdown", async () => {
    const button = await mic("browser");
    await button.down("touch");
    expect(calls).toEqual([]);
    await button.up("touch");
    await button.click();
    expect(calls).toEqual(["press"]);
  });

  it("keeps press-on-pointerdown and release for a mouse, and for the server engine on touch", async () => {
    const mouse = await mic("browser");
    await mouse.down("mouse");
    await mouse.up("mouse");
    await mouse.click();
    expect(calls).toEqual(["press", "release"]);
    await page.render(null);
    calls = [];
    const server = await mic("server");
    await server.down("touch");
    await server.up("touch");
    await server.click();
    expect(calls).toEqual(["press", "release"]);
  });

  it("finishes from a stop tap even when the take ended before its click, never starting another", async () => {
    const button = await mic("browser", "recording");
    await button.down("touch");
    await button.becomes("idle");
    await button.up("touch");
    await button.click();
    expect(calls).toEqual(["finish"]);
  });

  it("drops a touch hold's gesture that got no click, so a later Enter or Space still starts", async () => {
    const button = await mic("browser", "recording");
    await button.down("touch");
    await button.up("touch");
    await button.becomes("idle");
    const now = performance.now();
    const clock = spyOn(performance, "now").mockReturnValue(now + 2000);
    try { await button.click(); } finally { clock.mockRestore(); }
    expect(calls).toEqual(["press"]);
  });

  it("lets only the pointer that pressed release a hold, not a later right-click", async () => {
    const button = await mic("browser", "recording");
    await button.down("mouse", 2, 2);
    await button.up("mouse", 2, 2);
    expect(calls).toEqual([]);
  });
});

describe("useDictation", () => {
  let page: Page;
  let engine: ReturnType<typeof spyOn> | undefined;
  let say: (result: VoiceText) => void;
  let presses: number;

  beforeEach(() => {
    page = openPage();
    jest.useFakeTimers();
    presses = 0;
    engine = spyOn(voiceLib, "useVoiceInput").mockImplementation((options) => {
      say = options.onText;
      return {
        available: true, unavailableReason: null, engine: "browser", state: "idle", elapsedMs: 0, silent: false, error: null,
        press: () => { presses++; }, release: () => {}, finish: () => {}, cancel: () => {}, bindBars: () => {}, bindRing: () => {}, bindMeter: () => {},
      };
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
    engine?.mockRestore();
  });

  async function field() {
    const box = { current: null as HTMLTextAreaElement | null };
    const element = () => page.one<HTMLTextAreaElement>("textarea");
    let update: ReturnType<typeof useSettings>["update"] | undefined;
    function Field() {
      update = useSettings().update;
      useDictation({
        mode: "chat", connected: true, polish: false, box, onNote: () => {},
        read: () => element().value,
        write: (value, caret) => { Object.assign(element(), { value, selectionStart: caret, selectionEnd: caret }); },
      });
      return <textarea ref={box} defaultValue="first dictation" />;
    }
    await page.render(<SettingsProvider><Field /></SettingsProvider>);
    element().setSelectionRange(15, 15);
    // happy-dom lays nothing out: the field reports one box, as a shown field does
    Object.defineProperty(element(), "getClientRects", { configurable: true, value: () => [{}] });
    return {
      text: () => element().value,
      configureShortcut: (off: boolean) => act(async () => { update?.({ voiceInput: "on", shortcutOverrides: off ? { voice: null } : {} }); }),
      pressShortcut: () => {
        const keys = { key: " ", code: "Space", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
        const keydown = new page.window.KeyboardEvent("keydown", { ...keys, cancelable: true });
        page.window.dispatchEvent(keydown);
        page.window.dispatchEvent(new page.window.KeyboardEvent("keyup", keys));
        return keydown.defaultPrevented;
      },
      /** what the browser raises: one keystroke of an IME is compositionupdate and input together */
      raise: (...types: Array<"compositionstart" | "compositionupdate" | "input" | "compositionend">) => act(async () => { for (const type of types) element().dispatchEvent(new window.Event(type)); }),
      say: (text: string, phase: VoiceText["phase"] = "raw") => { say({ text, phase, take: 1 }); },
      wait: (ms: number) => { jest.advanceTimersByTime(ms); },
    };
  }

  it("does not capture the dictation key when its shortcut is off", async () => {
    const box = await field();
    await box.configureShortcut(true);
    expect(box.pressShortcut()).toBe(false);
    expect(presses).toBe(0);
    await box.configureShortcut(false);
    expect(box.pressShortcut()).toBe(true);
    expect(presses).toBe(1);
  });

  // HeliBoard, Gboard and the other AOSP keyboards call setComposingRegion on the word at the caret
  // with nothing typed, and keep it until the next key; Chrome raises compositionstart and
  // compositionupdate for it, and no input (InputMethodController::SetCompositionFromExistingText)
  it("puts a transcript in while the keyboard only marks the word at the caret as a composition (#2488)", async () => {
    const box = await field();
    await box.raise("compositionstart", "compositionupdate");
    box.say("second part");
    expect(box.text()).toBe("first dictation second part");
  });

  it("holds a transcript while something is typed into the composition, until compositionend", async () => {
    const box = await field();
    await box.raise("compositionstart", "compositionupdate", "input");
    box.say("second part");
    box.wait(5000);
    expect(box.text()).toBe("first dictation");
    await box.raise("compositionend", "input");
    box.wait(0);
    expect(box.text()).toBe("first dictation second part");
  });

  it("holds once a key types into the marked word, and not after compositionend", async () => {
    const box = await field();
    await box.raise("compositionstart", "compositionupdate");
    await box.raise("compositionupdate", "input");
    box.say("second part");
    expect(box.text()).toBe("first dictation");
    await box.raise("compositionend");
    box.wait(0);
    expect(box.text()).toBe("first dictation second part");
    // Safari's input after compositionend belongs to that composition, not to a new one
    await box.raise("input");
    box.say("third");
    expect(box.text()).toBe("first dictation second part third");
  });

  it("keeps a polished transcript behind its held raw text when the keyboard marks a word before the release", async () => {
    const box = await field();
    await box.raise("compositionstart", "compositionupdate", "input");
    box.say("second part");
    await box.raise("compositionend");
    await box.raise("compositionstart", "compositionupdate");
    box.say("Second part.", "polished");
    box.wait(0);
    await box.raise("compositionend");
    box.wait(0);
    expect(box.text()).toBe("first dictation Second part.");
  });
});
