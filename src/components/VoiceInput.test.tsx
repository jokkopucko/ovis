import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import type { VoiceEngine, VoiceInput, VoiceState } from "../lib/voice.ts";
import { MicButton, type Dictation } from "./VoiceInput.tsx";

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
      /** the take moved on by itself (recognition ended) between the tap's pointerdown and its click */
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
