import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { canHideMachine, isMachineShown, selectionToMove, subscribeHiddenMachines, HIDDEN_MACHINES_KEY, HIDDEN_MACHINES_MAX, parseHiddenMachines, readHiddenMachines, selectionAfterHiding, setHiddenMachines, shownMachines, withMachineHidden } from "./hiddenMachines.ts";
import { DEFAULT_SETTINGS, saveSettings } from "./settings.ts";

const roster = [{ id: "local" }, { id: "work" }, { id: "home" }];

describe("PCs shown on this device", () => {
  it("shows every PC until one is hidden, and keeps the roster's order", () => {
    expect(shownMachines(roster, []).map((pc) => pc.id)).toEqual(["local", "work", "home"]);
    expect(shownMachines(roster, ["work"]).map((pc) => pc.id)).toEqual(["local", "home"]);
    expect(shownMachines(roster, ["local", "gone"]).map((pc) => pc.id)).toEqual(["work", "home"]);
  });

  it("shows them all again when the list would leave none", () => {
    expect(shownMachines(roster, ["local", "work", "home"]).map((pc) => pc.id)).toEqual(["local", "work", "home"]);
    expect(shownMachines([], ["local"])).toEqual([]);
  });

  it("never lets the last PC shown be hidden", () => {
    expect(canHideMachine(roster, [], "work")).toBe(true);
    expect(canHideMachine(roster, ["work"], "home")).toBe(true);
    expect(canHideMachine(roster, ["work", "home"], "local")).toBe(false);
    expect(canHideMachine([{ id: "local" }], [], "local")).toBe(false);
    expect(canHideMachine(roster, ["work"], "work")).toBe(false);
  });

  it("adds and removes one PC, and drops ids of PCs no longer in the roster", () => {
    expect(withMachineHidden(roster, [], "work", true)).toEqual(["work"]);
    expect(withMachineHidden(roster, ["work"], "work", true)).toEqual(["work"]);
    expect(withMachineHidden(roster, ["work", "removed"], "home", true)).toEqual(["work", "home"]);
    expect(withMachineHidden(roster, ["work", "home"], "work", false)).toEqual(["home"]);
  });

  it("draws the switches as the sidebar does, and changes a list that hid every PC from what is drawn", () => {
    const left = [{ id: "local" }, { id: "work" }];
    expect(isMachineShown(left, ["local", "work"], "local")).toBe(true);
    expect(isMachineShown(left, ["local", "work"], "work")).toBe(true);
    expect(isMachineShown(roster, ["work"], "work")).toBe(false);
    expect(withMachineHidden(left, ["local", "work"], "work", true)).toEqual(["work"]);
    expect(withMachineHidden(left, ["local", "work"], "local", false)).toEqual([]);
  });

  it("moves the selection off a PC hidden now, also one shown only because every PC was hidden", () => {
    const left = [{ id: "local" }, { id: "work" }];
    expect(selectionToMove(left, ["local", "work"], ["local"], "local")).toBe("work");
    expect(selectionToMove(roster, [], ["work"], "work")).toBe("local");
    expect(selectionToMove(roster, ["work"], ["work", "home"], "work")).toBeNull();
    expect(selectionToMove(roster, [], ["home"], "work")).toBeNull();
  });

  it("moves a selection off a PC just hidden, to the Host when it is shown", () => {
    expect(selectionAfterHiding(roster, ["work"], "work")).toBe("local");
    expect(selectionAfterHiding(roster, ["local"], "local")).toBe("work");
    expect(selectionAfterHiding(roster, ["work"], "home")).toBeNull();
  });
});

describe("the stored list", () => {
  it("keeps PC ids only, each once, bounded, and reads anything else as none hidden", () => {
    expect(parseHiddenMachines(JSON.stringify(["work", "work", "", 3, null, "home"]))).toEqual(["work", "home"]);
    expect(parseHiddenMachines(JSON.stringify(["x".repeat(201)]))).toEqual([]);
    expect(parseHiddenMachines(JSON.stringify(Array.from({ length: 100 }, (_, index) => `pc-${index}`)))).toHaveLength(HIDDEN_MACHINES_MAX);
    expect(parseHiddenMachines('"work"')).toEqual([]);
    expect(parseHiddenMachines("{broken")).toEqual([]);
    expect(parseHiddenMachines(null)).toEqual([]);
  });

  describe("in this browser", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    let records: Map<string, string>;
    let storageListeners: Array<(event: { key: string | null }) => void> = [];
    let failWrites = false;
    beforeEach(() => {
      records = new Map();
      storageListeners = [];
      failWrites = false;
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { if (failWrites) throw new Error("quota"); records.set(key, value); }, removeItem: (key: string) => void records.delete(key) },
        addEventListener: (type: string, listener: (event: { key: string | null }) => void) => { if (type === "storage") storageListeners.push(listener); },
        removeEventListener: () => undefined,
      } });
    });
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    });

    it("lives in its own key, so a whole-record save of ovis:settings cannot erase it", () => {
      setHiddenMachines(["fixture-hidden-pc"]);
      expect(records.get(HIDDEN_MACHINES_KEY)).toBe('["fixture-hidden-pc"]');
      saveSettings(DEFAULT_SETTINGS);
      expect(readHiddenMachines()).toEqual(["fixture-hidden-pc"]);
      setHiddenMachines([]);
      expect(readHiddenMachines()).toEqual([]);
    });

    it("keeps a choice storage refused for this page, until another tab changes the list", () => {
      const changes: number[] = [];
      const unsubscribe = subscribeHiddenMachines(() => changes.push(1));
      failWrites = true;
      setHiddenMachines(["work"]);
      expect(readHiddenMachines()).toEqual(["work"]);
      records.set(HIDDEN_MACHINES_KEY, '["home"]');
      for (const listener of storageListeners) listener({ key: HIDDEN_MACHINES_KEY });
      expect(readHiddenMachines()).toEqual(["home"]);
      expect(changes.length).toBe(2);
      unsubscribe();
    });

    it("hands React the same list until the stored one changes (useSyncExternalStore)", () => {
      setHiddenMachines(["work"]);
      const first = readHiddenMachines();
      expect(readHiddenMachines()).toBe(first);
      setHiddenMachines(["work", "home"]);
      expect(readHiddenMachines()).not.toBe(first);
      expect(readHiddenMachines()).toEqual(["work", "home"]);
    });
  });
});
