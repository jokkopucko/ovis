import { describe, expect, it } from "bun:test";
import { desktopUpdateBridge, readDesktopUpdate, watchDesktopUpdate, type DesktopUpdate, type DesktopUpdateBridge } from "./desktopUpdate.ts";

/** a stand-in for the app's preload: `answer` settles the page's asking, `say` is the app telling of a change */
function fakeBridge() {
  let answer: (update: unknown) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const listeners = new Set<(update: unknown) => void>();
  const calls: string[] = [];
  const bridge: DesktopUpdateBridge = {
    current: () => { calls.push("current"); return new Promise((resolve, reject) => { answer = resolve; fail = reject; }); },
    onChange: (listener) => { calls.push("onChange"); listeners.add(listener); return () => { listeners.delete(listener); }; },
    install: async () => undefined,
    close: () => undefined,
  };
  return { bridge, calls, listeners, answer: (update: unknown) => answer(update), fail: (error: Error) => fail(error), say: (update: unknown) => { for (const listener of listeners) listener(update); } };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("readDesktopUpdate", () => {
  it("reads the app's downloaded version, and whether its line was closed", () => {
    expect(readDesktopUpdate({ version: "0.5.3", closed: false, text: "Ovis 0.5.3 is ready", action: "Restart to Update" })).toEqual({ version: "0.5.3", closed: false });
    expect(readDesktopUpdate({ version: "0.5.3", closed: true })).toEqual({ version: "0.5.3", closed: true });
  });

  it("reads anything else as no update", () => {
    for (const nothing of [null, undefined, "0.5.3", {}, { version: "" }, { version: 3 }]) expect(readDesktopUpdate(nothing)).toBeNull();
  });
});

describe("watchDesktopUpdate", () => {
  it("listens before it asks, and tells the update the app answers with", async () => {
    const app = fakeBridge();
    const told: (DesktopUpdate | null)[] = [];
    watchDesktopUpdate(app.bridge, (update) => told.push(update));
    expect(app.calls).toEqual(["onChange", "current"]);
    app.answer({ version: "0.5.3", closed: false });
    await settled();
    expect(told).toEqual([{ version: "0.5.3", closed: false }]);
  });

  it("follows the app: a download that finishes later, and the line closed in another window", async () => {
    const app = fakeBridge();
    const told: (DesktopUpdate | null)[] = [];
    watchDesktopUpdate(app.bridge, (update) => told.push(update));
    app.answer(null);
    await settled();
    app.say({ version: "0.5.3", closed: false });
    app.say({ version: "0.5.3", closed: true });
    expect(told).toEqual([null, { version: "0.5.3", closed: false }, { version: "0.5.3", closed: true }]);
  });

  it("drops an answer that arrives after a change: it was read before it", async () => {
    const app = fakeBridge();
    const told: (DesktopUpdate | null)[] = [];
    watchDesktopUpdate(app.bridge, (update) => told.push(update));
    app.say({ version: "0.5.3", closed: false });
    app.answer(null);
    await settled();
    expect(told).toEqual([{ version: "0.5.3", closed: false }]);
  });

  it("tells nothing once stopped, and stops listening", async () => {
    const app = fakeBridge();
    const told: (DesktopUpdate | null)[] = [];
    const stop = watchDesktopUpdate(app.bridge, (update) => told.push(update));
    stop();
    expect(app.listeners.size).toBe(0);
    app.answer({ version: "0.5.3", closed: false });
    await settled();
    expect(told).toEqual([]);
  });

  it("shows no update when the app does not answer", async () => {
    const app = fakeBridge();
    const told: (DesktopUpdate | null)[] = [];
    watchDesktopUpdate(app.bridge, (update) => told.push(update));
    app.fail(new Error("no handler"));
    await settled();
    expect(told).toEqual([]);
  });
});

describe("desktopUpdateBridge", () => {
  const withWindow = (value: unknown, run: () => void) => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value });
    try { run(); } finally {
      if (saved) Object.defineProperty(globalThis, "window", saved);
      else Reflect.deleteProperty(globalThis, "window");
    }
  };

  it("is the app's preload bridge, and nothing in a browser or with half a bridge", () => {
    const { bridge } = fakeBridge();
    withWindow({ ovisUpdate: bridge }, () => expect(desktopUpdateBridge()).toBe(bridge));
    withWindow({}, () => expect(desktopUpdateBridge()).toBeNull());
    withWindow({ ovisUpdate: { current: bridge.current } }, () => expect(desktopUpdateBridge()).toBeNull());
  });
});
