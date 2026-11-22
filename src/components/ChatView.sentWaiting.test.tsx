import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationResponse } from "../../shared/protocol.ts";
import { forgetWaitingSends, rememberWaitingSend, waitingKey } from "../lib/sentWaiting.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatView } from "./ChatView.tsx";
import { SentWaitingList } from "./SentWaiting.tsx";

class Node extends EventTarget {
  readonly clientHeight = 600;
  readonly clientWidth = 600;
  readonly scrollHeight = 600;
  scrollTop = 0;
  readonly children: never[] = [];
  readonly offsetHeight = 0;
  readonly style = { setProperty() {} };
  readonly firstElementChild = null;
  scrollTo(): void {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 600, right: 600, width: 600, height: 600 }; }
  contains(target: unknown): boolean { return target === this; }
  closest(): null { return null; }
  querySelector(): null { return null; }
  querySelectorAll(): never[] { return []; }
}

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let answer: ConversationResponse;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  const events = new EventTarget();
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  const listen = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    Node, Element: Node, HTMLElement: Node, HTMLDivElement: Node,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    navigator: { languages: ["en"], platform: "Linux" },
    localStorage: storage,
    window: {
      ...listen, localStorage: storage, sessionStorage: storage, innerWidth: 1440,
      matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, getSelection: () => null,
    },
    document: {
      ...listen, visibilityState: "visible", activeElement: null, querySelector: () => null,
      getElementById: () => null,
      documentElement: { lang: "", dataset: {}, style, hasAttribute: () => false },
    },
    getComputedStyle: () => style,
    CSS: { escape: (value: string) => value },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(values)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) =>
    String(input).includes("pane/conversation?") ? Response.json(answer) : Response.json({ commands: [], prompt: null }), { preconnect: globalThis.fetch.preconnect }));
});

async function within(signal: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not come within ${ms} ms`)), ms); });
  try { await Promise.race([signal, late]); } finally { clearTimeout(timer); }
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  fetchSpy.mockRestore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

test.each([["working", false], ["idle", true]] as const)(
  "a send waits for the agent's turn while its conversation says it is %s, whatever herdr's idle says",
  async (activity, resting) => {
    const paneId = `waiting-${activity}`;
    answer = { source: "grok-transcript", activity, turns: [{ role: "assistant", ts: new Date(Date.now() - 10_000).toISOString(), parts: [{ kind: "text", text: "earlier" }] }] };
    rememberWaitingSend(waitingKey("local", paneId), "fix the bug");
    try {
      let applied!: () => void;
      const read = new Promise<void>((resolve) => { applied = resolve; });
      await act(async () => {
        renderer = create(createElement(SettingsProvider, null, createElement(ChatView, {
          paneId, refreshKey: 0, connected: true, ended: false, agent: "grok", agentStatus: "idle", onMetadata: () => { applied(); },
        })), { createNodeMock: () => new Node() });
      });
      await act(async () => { await within(read, 5_000, "the conversation read"); });
      if (renderer === undefined) throw new Error("Chat did not mount");
      expect(renderer.root.findByType(SentWaitingList).props.resting).toBe(resting);
    } finally { act(() => { forgetWaitingSends(waitingKey("local", paneId)); }); }
  },
);
