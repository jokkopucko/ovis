import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { ConversationResponse } from "../../shared/protocol.ts";
import { currentWaitingSends, forgetWaitingSends, WAITING_STUCK_MS, rememberWaitingSend, waitingKey } from "../lib/sentWaiting.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatView } from "./ChatView.tsx";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
const listResize = Symbol.for("ovis.test.legendListResize");
let page: Page;
let answer: ConversationResponse;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  page = openPage();
  // happy-dom cannot parse CSS.escape() output inside these JSON-key attribute selectors.
  const select = page.window.HTMLElement.prototype.querySelector;
  Object.defineProperty(page.window.HTMLElement.prototype, "querySelector", { configurable: true, value(this: HTMLElement, selector: string) {
    const escaped = /^\[data-chat-row="(.*)"\]$/.exec(selector)?.[1];
    if (escaped === undefined) return select.call(this, selector);
    const key = escaped.replace(/\\(.)/g, "$1");
    return [...this.querySelectorAll("[data-chat-row]")].find((node) => node.getAttribute("data-chat-row") === key) ?? null;
  } });
  const values = {
    Node: page.window.Node, Element: page.window.Element, HTMLElement: page.window.HTMLElement, HTMLDivElement: page.window.HTMLDivElement,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    CSS: page.window.CSS,
    // LegendList keeps its first observer across suites. Leave its callback on the
    // observed item so scrollInput can deliver a measurement even if we ran first.
    ResizeObserver: class {
      constructor(readonly notify: (entries: readonly ResizeObserverEntry[]) => void) {}
      observe(target: Element, options?: ResizeObserverOptions) {
        if (options?.box === "border-box") Object.defineProperty(target, listResize, { configurable: true, value: this.notify });
      }
      unobserve(target: Element) { Reflect.deleteProperty(target, listResize); }
      disconnect() {}
    },
    MutationObserver: page.window.MutationObserver,
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
  await page.close();
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
    rememberWaitingSend(waitingKey("local", paneId), "fix the bug", Date.now() - WAITING_STUCK_MS);
    try {
      let applied!: () => void;
      const read = new Promise<void>((resolve) => { applied = resolve; });
      await page.render(createElement(SettingsProvider, null, createElement(ChatView, {
          paneId, refreshKey: 0, connected: true, ended: false, agent: "grok", agentStatus: "idle", onMetadata: () => { applied(); },
      })));
      await act(async () => { await within(read, 5_000, "the conversation read"); });
      expect(page.container.querySelector(".chat-sent-waiting-list") !== null).toBe(resting);
    } finally { act(() => { forgetWaitingSends(waitingKey("local", paneId)); }); }
  },
);

test("a send with pasted tabs leaves no waiting copy once Pi's transcript records them as four spaces", async () => {
  const paneId = "waiting-pi-tabs";
  const key = waitingKey("local", paneId);
  answer = { source: "pi-transcript", activity: "idle", turns: [{ role: "user", ts: new Date(Date.now() - 1_000).toISOString(), parts: [{ kind: "text", text: "compare    Nov 2025    Nov 2024" }] }] };
  rememberWaitingSend(key, "compare\tNov 2025\tNov 2024", Date.now() - 5_000);
  try {
    let applied!: () => void;
    const read = new Promise<void>((resolve) => { applied = resolve; });
    await page.render(createElement(SettingsProvider, null, createElement(ChatView, {
        paneId, refreshKey: 0, connected: true, ended: false, agent: "pi", agentStatus: "idle", onMetadata: () => { applied(); },
    })));
    await act(async () => { await within(read, 5_000, "the conversation read"); });
    expect(currentWaitingSends(key)).toEqual([]);
    expect(page.container.querySelectorAll(".chat-sent-waiting-list")).toHaveLength(0);
  } finally { act(() => { forgetWaitingSends(key); }); }
});
