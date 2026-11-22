import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { createElement, useLayoutEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { currentWaitingSends, forgetWaitingSends, observeWaitingClock, rememberWaitingSend, settleWaitingSends, WAITING_HINT_MS, WAITING_SEND_MS, waitingBaseline, waitingKey, type WaitingSend } from "../lib/sentWaiting.ts";
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

  test("says an unanswered send is not in the conversation, where the agent's error would be, and offers the terminal", () => {
    setSystemTime(new Date(at + WAITING_SEND_MS));
    const markup = withEnglish(() => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(SentWaitingList, {
      sends: [{ ...send, unanswered: true }], paneKey: "local:p1", agent: "hermes", onOpenTerminal: () => {},
    }) })));
    expect(textWithoutTags(markup)).toBe(`${send.text}Not in the conversation. If Hermes showed an error, it is in the terminal.Open Terminal`);
    expect(markup).toContain('aria-label="Dismiss"');
    expect(markup).not.toContain("chat-sent-late");
  });

  test("is no live region of its own: the chat footer's one status region stays the only one", () => {
    expect(render(at + WAITING_HINT_MS)).not.toMatch(/role="(?:status|alert|log)"|aria-live/u);
  });
});

async function within(signal: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not come within ${ms} ms`)), ms); });
  try { await Promise.race([signal, late]); } finally { clearTimeout(timer); }
}

describe("mounted", () => {
  let renderers: ReactTestRenderer[];
  const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    renderers = [];
    for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
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

  test("says a send unanswered a minute on, once read at rest, never while it works, and lets it go on Dismiss", async () => {
    const key = waitingKey("local", "unanswered-mounted");
    function Chat({ resting }: { resting: boolean }) {
      return createElement(SentWaitingList, { sends: useWaitingSends("local", "unanswered-mounted", true), paneKey: key, resting, agent: "letta" });
    }
    try {
      settleWaitingSends(key, [], at - 1, true);
      rememberWaitingSend(key, "the turn letta failed", at);
      const renderer = mount(createElement(Chat, { resting: false }));
      act(() => { jest.advanceTimersByTime(WAITING_SEND_MS); });
      observeWaitingClock(key, new Date().toISOString(), 0, Date.now());
      settleWaitingSends(key, [], Date.now(), true);
      expect(currentWaitingSends(key).map((item) => item.unanswered)).toEqual([undefined]);
      act(() => { renderer.update(createElement(SettingsProvider, { children: createElement(Chat, { resting: true }) })); });
      expect(currentWaitingSends(key).map((item) => item.unanswered)).toEqual([undefined]);
      act(() => { jest.advanceTimersByTime(1); observeWaitingClock(key, new Date().toISOString(), 0, Date.now()); settleWaitingSends(key, [], Date.now(), true); });
      await act(async () => { await Promise.resolve(); });
      expect(currentWaitingSends(key).map((item) => item.unanswered)).toEqual([true]);
      expect(renderer.root.findAll((node) => node.props.className === "chat-unanswered-note")).toHaveLength(1);
      act(() => { renderer.root.findByProps({ "aria-label": "Dismiss" }).props.onClick(); });
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  test("judges a send in a chat opened again by a read since then, not by the one its last visit settled", async () => {
    const key = waitingKey("local", "reopened-mounted");
    const chat = () => createElement(SentWaitingList, { sends: currentWaitingSends(key), paneKey: key, resting: true, agent: "kiro" });
    try {
      settleWaitingSends(key, [], at - 1, true);
      rememberWaitingSend(key, "do the thing", at);
      const visit = mount(chat());
      act(() => { jest.advanceTimersByTime(2_000); observeWaitingClock(key, new Date().toISOString(), 0, Date.now()); settleWaitingSends(key, [], Date.now(), true); });
      act(() => { visit.unmount(); });
      renderers.splice(renderers.indexOf(visit), 1);
      // back five minutes later: the agent wrote the turn meanwhile, with no time (as Kiro does)
      jest.advanceTimersByTime(5 * 60_000);
      mount(chat());
      expect(currentWaitingSends(key).map((item) => item.unanswered)).toEqual([undefined]);
      act(() => { jest.advanceTimersByTime(1); observeWaitingClock(key, new Date().toISOString(), 0, Date.now()); settleWaitingSends(key, [{ role: "user", ts: null, parts: [{ kind: "text", text: "do the thing" }] }], Date.now(), true); });
      await act(async () => { await Promise.resolve(); });
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  test("clears the rest in the commit that shows the agent at work, before the read that commit settles is judged", async () => {
    jest.useRealTimers();
    setSystemTime();
    const key = waitingKey("local", "rest-order");
    let show!: (next: readonly ConversationTurn[]) => void;
    let settled!: () => void;
    const read = new Promise<void>((resolve) => { settled = resolve; });
    function Chat() {
      const [turns, setTurns] = useState<readonly ConversationTurn[]>([]);
      show = setTurns;
      useLayoutEffect(() => {
        settleWaitingSends(key, turns, Date.now(), true);
        if (turns.length > 0) settled();
      }, [turns]);
      return createElement(SentWaitingList, { sends: useWaitingSends("local", "rest-order", true), paneKey: key, resting: turns.length === 0 });
    }
    try {
      const sent = Date.now() - 2 * WAITING_SEND_MS;
      settleWaitingSends(key, [], sent - 1, true);
      rememberWaitingSend(key, "next, run the tests", sent);
      mount(createElement(Chat));
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: false });
      observeWaitingClock(key, new Date().toISOString(), 0, Date.now() + 1);
      show([{ role: "assistant", ts: new Date(sent - 10_000).toISOString(), parts: [{ kind: "text", text: "earlier" }] }]);
      await within(read, 5_000, "the chat's render of the read");
      expect(currentWaitingSends(key).map((item) => item.unanswered)).toEqual([undefined]);
    } finally { forgetWaitingSends(key); }
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

  test("a disconnected sibling pane preserves the baseline so a phone's send does not duplicate its transcript turn", () => {
    paneLifetimes.observe([{ id: "skewed-PC", snapshot: { panes: [], herdr_lifetime: "skewed-herdr" } } as unknown as Machine]);
    const key = waitingKey("skewed-PC", "baseline-owner");
    const user = (text: string, ts: number) => ({ role: "user" as const, ts: new Date(ts).toISOString(), parts: [{ kind: "text" as const, text }] });
    const earlier = user("earlier", at - 10_000);
    settleWaitingSends(key, [earlier], at, true);
    function Sibling() {
      useWaitingSends("skewed-PC", "another-pane", false);
      return null;
    }
    try {
      mount(createElement(Sibling), false);
      rememberWaitingSend(key, "follow up while working", at + 2_000, waitingBaseline(key));
      settleWaitingSends(key, [earlier, user("follow up while working", at + 100)], at + 2_100, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });
});
