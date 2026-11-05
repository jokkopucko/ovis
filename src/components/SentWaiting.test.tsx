import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { forgetWaitingSends, rememberWaitingSend, WAITING_HINT_MS, waitingKey, type WaitingSend } from "../lib/sentWaiting.ts";
import { SentWaitingList, useWaitingSends } from "./SentWaiting.tsx";

const at = Date.parse("2026-10-29T03:00:00Z");
const send: WaitingSend = { id: 1, pane: "local:p1", text: "fix the flaky test", at, after: null };

function withEnglish<T>(run: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try { return run(); } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

function render(now: number, sends: readonly WaitingSend[] = [send]): string {
  setSystemTime(new Date(now));
  return withEnglish(() => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(SentWaitingList, { sends }) })));
}
const textWithoutTags = (markup: string): string => markup.replace(/<[^>]*>/gu, "");

afterEach(() => { setSystemTime(); });

describe("SentWaitingList", () => {
  test("shows only the sent words, with no caption, while the agent is about to take them", () => {
    for (const now of [at, at + WAITING_HINT_MS - 1]) {
      const markup = render(now);
      expect(textWithoutTags(markup)).toBe(send.text);
      expect(markup).not.toContain("chat-sent-late");
    }
  });

  test("adds a clock beside the bubble once the turn is late, still with no caption", () => {
    const markup = render(at + WAITING_HINT_MS);
    expect(markup).toContain("chat-sent-late");
    expect(textWithoutTags(markup)).toBe(send.text);
  });

  test("shows a long message whole, capped at the lines its turn's card shows, so the turn takes its place at its height", () => {
    const long: WaitingSend = { ...send, id: 2, text: Array.from({ length: 20 }, (_, index) => `Step ${index + 1}: run the flaky test again and keep its log`).join("\n") };
    const markup = render(at, [long, send]);
    expect(textWithoutTags(markup)).toBe(long.text + send.text);
    expect(markup.match(/class="chat-bubble(?: [^"]*)?"/gu)).toEqual(['class="chat-bubble is-capped"', 'class="chat-bubble"']);
  });

  test("is no live region of its own: the chat footer's one status region stays the only one", () => {
    expect(render(at + WAITING_HINT_MS)).not.toMatch(/role="(?:status|alert|log)"|aria-live/u);
  });
});

describe("mounted", () => {
  let renderers: ReactTestRenderer[];
  const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    renderers = [];
    for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    // only what SettingsProvider reads and writes: no stored settings, a root it themes, no listeners that fire
    const style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "", backgroundColor: "" };
    const listen = { addEventListener: () => {}, removeEventListener: () => {} };
    const values: Record<string, unknown> = {
      IS_REACT_ACT_ENVIRONMENT: true,
      window: { ...listen, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 } },
      document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
      getComputedStyle: () => style,
    };
    for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
    jest.useFakeTimers();
    jest.setSystemTime(new Date(at));
  });
  afterEach(() => {
    act(() => { for (const renderer of renderers) renderer.unmount(); });
    jest.useRealTimers();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    saved.clear();
  });
  const mount = (element: ReturnType<typeof createElement>, settings = true): ReactTestRenderer => {
    let renderer!: ReactTestRenderer;
    withEnglish(() => act(() => { renderer = create(settings ? createElement(SettingsProvider, { children: element }) : element); }));
    renderers.push(renderer);
    return renderer;
  };
  const clocks = (renderer: ReactTestRenderer): number => renderer.root.findAll((node) => node.props.className === "chat-sent-late").length;

  test("brings the clock in at five seconds, on its own timer", () => {
    const renderer = mount(createElement(SentWaitingList, { sends: [send] }));
    act(() => { jest.advanceTimersByTime(WAITING_HINT_MS - 1); });
    expect(clocks(renderer)).toBe(0);
    act(() => { jest.advanceTimersByTime(1); });
    expect(clocks(renderer)).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("leaves no timer behind when the bubble goes before its clock", () => {
    const renderer = mount(createElement(SentWaitingList, { sends: [send] }));
    expect(jest.getTimerCount()).toBe(1);
    act(() => { renderer.update(createElement(SettingsProvider, { children: createElement(SentWaitingList, { sends: [] }) })); });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("lets a waiting send go when the connection does, and does not bring it back on reconnect", () => {
    const key = waitingKey("local", "w1:p1");
    let shown: readonly WaitingSend[] = [];
    function Probe({ connected }: { connected: boolean }) {
      shown = useWaitingSends("local", "w1:p1", connected);
      return null;
    }
    try {
      rememberWaitingSend(key, "deploy it", at);
      const renderer = mount(createElement(Probe, { connected: true }), false);
      expect(shown.map((item) => item.text)).toEqual(["deploy it"]);
      act(() => { renderer.update(createElement(Probe, { connected: false })); });
      expect(shown).toEqual([]);
      act(() => { renderer.update(createElement(Probe, { connected: true })); });
      expect(shown).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });
});
