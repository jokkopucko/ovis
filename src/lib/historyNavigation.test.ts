import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sheetStep } from "./historyKeys.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";

let originalWindow: PropertyDescriptor | undefined;
const answering = sheetStep.goingBack;
const dropping = sheetStep.dropped;

beforeEach(() => { originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"); });
afterEach(() => {
  sheetStep.goingBack = answering;
  sheetStep.dropped = dropping;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
});

function browser(entries: string[], listed: boolean, refused = false) {
  const went: Array<number | string> = [];
  const window = {
    history: { state: { entry: entries.at(-1) }, go: (by: number) => { went.push(by); } },
    ...(listed ? { navigation: {
      currentEntry: { index: entries.length - 1 },
      entries: () => entries.map((key) => ({ key })),
      traverseTo: (key: string) => { went.push(key); return { committed: refused ? Promise.reject(new Error("refused")) : Promise.resolve() }; },
    } } : {}),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: window });
  return went;
}

describe("an overlay's own step back", () => {
  it("is told to the sheets from the entry it leaves, and goes past a sheet's entry that lies over the overlay's", () => {
    const told: unknown[] = [];
    let over = false;
    sheetStep.goingBack = (state) => { told.push(state); return over; };
    const went = browser(["pane", "file"], false);
    backUnderCurrentEntry();
    over = true;
    backUnderCurrentEntry(2);
    expect(told).toEqual([{ entry: "file" }, { entry: "file" }]);
    expect(went).toEqual([-1, -3]);
  });

  it("goes by the browser's own list of entries where it has one", async () => {
    let over = false;
    sheetStep.goingBack = () => over;
    const went = browser(["start", "pane", "file", "menu"], true);
    await backUnderCurrentEntry();
    over = true;
    await backUnderCurrentEntry();
    expect(went).toEqual(["file", "pane"]);
  });

  it("tells the sheets when the browser refuses the traversal, and still fails for its caller", async () => {
    let dropped = 0;
    sheetStep.goingBack = () => false;
    sheetStep.dropped = () => { dropped += 1; };
    browser(["pane", "file"], true, true);
    let failed = false;
    await backUnderCurrentEntry()?.catch(() => { failed = true; });
    expect(failed).toBe(true);
    expect(dropped).toBe(1);
  });
});
