import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import type { RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider, useSettings } from "../lib/settings.ts";
import * as voiceLib from "../lib/voice.ts";
import type { VoiceEngine, VoiceInput, VoiceState, VoiceText } from "../lib/voice.ts";
import { MicButton, useDictation, type Dictation } from "./VoiceInput.tsx";

describe("MicButton", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function mic(engine: VoiceEngine, state: VoiceState = "idle") {
    const voice = {
      available: true, unavailableReason: null, engine, state, elapsedMs: 0, silent: false, error: null,
      press: () => {}, release: () => calls.push("release"), finish: () => calls.push("finish"), cancel: () => {},
      bindBars: () => {}, bindRing: () => {}, bindMeter: () => {},
    } satisfies VoiceInput;
    const dictation: Dictation = { shown: true, connected: true, voice, forget: () => {}, partial: "", press: () => calls.push("press") };
    const view = () => <SettingsProvider><MicButton dictation={{ ...dictation, voice: { ...voice } }} /></SettingsProvider>;
    await act(async () => { renderer = create(view()); });
    const button = () => renderer!.root.findByType("button");
    const pointer = (pointerType: string, pointerId = 1, mouseButton = 0) => ({ button: mouseButton, pointerType, pointerId, preventDefault: () => {}, currentTarget: { setPointerCapture: () => {} } });
    return {
      down: (pointerType: string, pointerId?: number, mouseButton?: number) => act(() => { button().props.onPointerDown(pointer(pointerType, pointerId, mouseButton)); }),
      up: (pointerType: string, pointerId?: number, mouseButton?: number) => act(() => { button().props.onPointerUp(pointer(pointerType, pointerId, mouseButton)); }),
      click: () => act(() => { button().props.onClick({ detail: 1 }); }),
      becomes: (next: VoiceState) => act(() => { voice.state = next; renderer!.update(view()); }),
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
    await act(async () => { renderer?.unmount(); });
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
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let engine: ReturnType<typeof spyOn> | undefined;
  let say: (result: VoiceText) => void;
  let presses: number;

  function globals(): EventTarget {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    return events;
  }

  beforeEach(() => {
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
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    engine?.mockRestore();
    jest.useRealTimers();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function field() {
    const events = globals();
    const element = Object.assign(new EventTarget(), { value: "first dictation", selectionStart: 15, selectionEnd: 15, getClientRects: () => [{}] });
    const box = { current: element as unknown as HTMLTextAreaElement } satisfies RefObject<HTMLTextAreaElement | null>;
    let update: ReturnType<typeof useSettings>["update"] | undefined;
    function Field() {
      update = useSettings().update;
      useDictation({
        mode: "chat", connected: true, polish: false, box, onNote: () => {},
        read: () => element.value,
        write: (value, caret) => { Object.assign(element, { value, selectionStart: caret, selectionEnd: caret }); },
      });
      return null;
    }
    await act(async () => { renderer = create(<SettingsProvider><Field /></SettingsProvider>); });
    return {
      text: () => element.value,
      configureShortcut: (off: boolean) => act(async () => { update?.({ voiceInput: "on", shortcutOverrides: off ? { voice: null } : {} }); }),
      pressShortcut: () => {
        const keys = { key: " ", code: "Space", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
        const keydown = Object.assign(new Event("keydown", { cancelable: true }), keys);
        events.dispatchEvent(keydown);
        events.dispatchEvent(Object.assign(new Event("keyup"), keys));
        return keydown.defaultPrevented;
      },
      /** what the browser raises: one keystroke of an IME is compositionupdate and input together */
      raise: (...types: Array<"compositionstart" | "compositionupdate" | "input" | "compositionend">) => { for (const type of types) element.dispatchEvent(new Event(type)); },
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
    box.raise("compositionstart", "compositionupdate");
    box.say("second part");
    expect(box.text()).toBe("first dictation second part");
  });

  it("holds a transcript while something is typed into the composition, until compositionend", async () => {
    const box = await field();
    box.raise("compositionstart", "compositionupdate", "input");
    box.say("second part");
    box.wait(5000);
    expect(box.text()).toBe("first dictation");
    box.raise("compositionend", "input");
    box.wait(0);
    expect(box.text()).toBe("first dictation second part");
  });

  it("holds once a key types into the marked word, and not after compositionend", async () => {
    const box = await field();
    box.raise("compositionstart", "compositionupdate");
    box.raise("compositionupdate", "input");
    box.say("second part");
    expect(box.text()).toBe("first dictation");
    box.raise("compositionend");
    box.wait(0);
    expect(box.text()).toBe("first dictation second part");
    // Safari's input after compositionend belongs to that composition, not to a new one
    box.raise("input");
    box.say("third");
    expect(box.text()).toBe("first dictation second part third");
  });

  it("keeps a polished transcript behind its held raw text when the keyboard marks a word before the release", async () => {
    const box = await field();
    box.raise("compositionstart", "compositionupdate", "input");
    box.say("second part");
    box.raise("compositionend");
    box.raise("compositionstart", "compositionupdate");
    box.say("Second part.", "polished");
    box.wait(0);
    box.raise("compositionend");
    box.wait(0);
    expect(box.text()).toBe("first dictation Second part.");
  });
});
