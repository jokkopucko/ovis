import { describe, expect, it } from "bun:test";

import { mountRole, PaneObserving } from "./paneObserving.ts";

describe("pane observing", () => {
  it("counts a pane as watched only while every mount of it watches, each mount on its own", () => {
    const store = new PaneObserving();
    const left = Symbol("left"), right = Symbol("right");
    let heard = 0;
    store.subscribe(() => { heard++; });
    expect(store.has("p")).toBe(false);
    expect(store.known("p")).toBe(false);
    store.set("p", left, true);
    expect(store.known("p")).toBe(true);
    expect(store.has("p")).toBe(true);
    // a second mount that types: its composer takes the note
    store.set("p", right, false);
    expect(store.has("p")).toBe(false);
    // the typing mount leaving does not clear the other's watch
    store.set("p", right, null);
    expect(store.has("p")).toBe(true);
    store.set("p", left, null);
    expect(store.has("p")).toBe(false);
    expect(heard).toBe(4);
  });

  it("knows a mount's role only once its connection says: observe acked, or input ready", () => {
    expect(mountRole({ observing: true, inputReady: false })).toBe(true);
    expect(mountRole({ observing: false, inputReady: true })).toBe(false);
    // mounted and still connecting, or disconnected: nothing is known, so no note goes for it
    expect(mountRole({ observing: false, inputReady: false })).toBeNull();
  });
});
