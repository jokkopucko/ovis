import { describe, expect, it, spyOn } from "bun:test";
import { parseHerdrBinding, resolveHerdrKeys, type HerdrKeys } from "../../shared/herdr-keys.ts";
import { chordMatches, compileHerdrKeys, herdrKeyStep, runHerdrAction, type HerdrKeyMap } from "./herdrKeys.ts";
import type { AppActions } from "./actions.ts";
import type { ShortcutEventLike } from "./shortcuts.ts";

function key(key: string, code: string, modifiers: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}
const ctrlB = key("b", "KeyB", { ctrlKey: true });
const defaults: HerdrKeys = resolveHerdrKeys(undefined);
const map = compileHerdrKeys(defaults) as HerdrKeyMap;

describe("herdr's binding syntax", () => {
  it("reads the prefix, modifiers, named keys and the 1..9 range as herdr's parser does", () => {
    expect(parseHerdrBinding("ctrl+b")).toEqual({ prefixed: false, range: false, chord: { ctrl: true, alt: false, shift: false, meta: false, hyper: false, key: "b" } });
    expect(parseHerdrBinding("prefix+shift+n")?.chord).toMatchObject({ shift: true, key: "n" });
    expect(parseHerdrBinding("prefix+N")?.chord).toMatchObject({ shift: true, key: "n" });
    expect(parseHerdrBinding("prefix+minus")?.chord.key).toBe("-");
    expect(parseHerdrBinding("prefix+?")?.chord.key).toBe("?");
    expect(parseHerdrBinding("Control+Space")?.chord).toMatchObject({ ctrl: true, key: " " });
    // herdr's meta is Alt; cmd and super are the browser's Meta
    expect(parseHerdrBinding("meta+x")?.chord).toMatchObject({ alt: true, meta: false });
    expect(parseHerdrBinding("cmd+shift+tab")?.chord).toMatchObject({ meta: true, shift: true, key: "Tab" });
    expect(parseHerdrBinding("f12")?.chord.key).toBe("F12");
    expect(parseHerdrBinding("prefix+alt+1..9")).toMatchObject({ prefixed: true, range: true, chord: { alt: true } });
    // a literal plus: alone, or after the last separator
    expect(parseHerdrBinding("+")).toMatchObject({ prefixed: false, chord: { ctrl: false, key: "+" } });
    expect(parseHerdrBinding("ctrl++")).toMatchObject({ prefixed: false, chord: { ctrl: true, key: "+" } });
    expect(parseHerdrBinding("prefix++")).toMatchObject({ prefixed: true, chord: { key: "+" } });
  });

  it("reads nothing herdr does not: unknown names, two keys, empty parts, a modifier name inherited from Object", () => {
    for (const text of ["", "prefix+", "prefix+pagedown", "++", "a++", "a+b", "constructor+b", "toString+b", "prefix+1..9+x"]) expect(parseHerdrBinding(text)).toBeNull();
  });
});

describe("matching a keydown", () => {
  it("reads a letter by its key's position on a non-Latin layout, and Shift exactly", () => {
    const chord = parseHerdrBinding("prefix+shift+n")!.chord;
    expect(chordMatches(chord, key("N", "KeyN", { shiftKey: true }))).toBe(true);
    expect(chordMatches(chord, key("ㅜ", "KeyN", { shiftKey: true }))).toBe(true);
    expect(chordMatches(chord, key("n", "KeyN"))).toBe(false);
    expect(chordMatches(parseHerdrBinding("ctrl+b")!.chord, key("b", "KeyB", { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("reads punctuation by the character typed, whatever Shift it took", () => {
    expect(chordMatches(parseHerdrBinding("prefix+?")!.chord, key("?", "Slash", { shiftKey: true }))).toBe(true);
    expect(chordMatches(parseHerdrBinding("prefix+minus")!.chord, key("-", "Minus"))).toBe(true);
  });
});

describe("the prefix's steps", () => {
  it("arms on the prefix, and runs the bound key's action once armed", () => {
    expect(herdrKeyStep(map, false, ctrlB)).toEqual({ kind: "arm" });
    expect(herdrKeyStep(map, true, key("c", "KeyC"))).toEqual({ kind: "run", action: "new_tab", index: null });
    expect(herdrKeyStep(map, true, key("-", "Minus"))).toEqual({ kind: "run", action: "split_horizontal", index: null });
    expect(herdrKeyStep(map, true, key("3", "Digit3"))).toEqual({ kind: "run", action: "switch_tab", index: 3 });
    expect(herdrKeyStep(map, true, key("N", "KeyN", { shiftKey: true }))).toEqual({ kind: "run", action: "new_workspace", index: null });
  });

  it("leaves every other key to the pane: unarmed keys, an unbound key or the prefix again once armed, IME composition", () => {
    expect(herdrKeyStep(map, false, key("c", "KeyC"))).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, true, key("y", "KeyY"))).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, true, ctrlB)).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, true, { ...key("Process", "KeyC"), keyCode: 229 })).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, false, { ...ctrlB, isComposing: true })).toEqual({ kind: "pass" });
  });

  it("swallows the held prefix's key repeat, so holding it neither leaks it to the pane nor re-arms", () => {
    expect(herdrKeyStep(map, true, { ...ctrlB, repeat: true })).toEqual({ kind: "hold" });
    expect(herdrKeyStep(map, true, ctrlB)).toEqual({ kind: "pass" });
  });

  it("waits through a modifier pressed on its way to the key, and leaves on Escape", () => {
    expect(herdrKeyStep(map, true, key("Shift", "ShiftLeft", { shiftKey: true }))).toEqual({ kind: "ignore" });
    expect(herdrKeyStep(map, true, key("Escape", "Escape"))).toEqual({ kind: "escape" });
  });

  it("follows the config: another prefix, a rebound or unbound action", () => {
    const own = compileHerdrKeys({ prefix: "ctrl+a", prefixes: ["ctrl+a"], bindings: { ...defaults.bindings, new_tab: ["prefix+t"], zoom: [] } })!;
    expect(herdrKeyStep(own, false, ctrlB)).toEqual({ kind: "pass" });
    expect(herdrKeyStep(own, false, key("a", "KeyA", { ctrlKey: true }))).toEqual({ kind: "arm" });
    expect(herdrKeyStep(own, true, key("t", "KeyT"))).toEqual({ kind: "run", action: "new_tab", index: null });
    expect(herdrKeyStep(own, true, key("z", "KeyZ"))).toEqual({ kind: "pass" });
  });

  it("arms on any of several prefixes, and leaves another prefix pressed once armed to the pane", () => {
    const ctrlA = key("a", "KeyA", { ctrlKey: true });
    const both = compileHerdrKeys(resolveHerdrKeys({ prefix: ["ctrl+a", "ctrl+b"], new_tab: "prefix+t" }))!;
    expect(herdrKeyStep(both, false, ctrlA)).toEqual({ kind: "arm" });
    expect(herdrKeyStep(both, false, ctrlB)).toEqual({ kind: "arm" });
    expect(herdrKeyStep(both, true, key("t", "KeyT"))).toEqual({ kind: "run", action: "new_tab", index: null });
    expect(herdrKeyStep(both, true, ctrlB)).toEqual({ kind: "pass" });
    expect(herdrKeyStep(both, true, { ...ctrlB, repeat: true })).toEqual({ kind: "hold" });
    expect(herdrKeyStep(compileHerdrKeys(resolveHerdrKeys({ prefix: ["ctrl+a"] }))!, false, ctrlB)).toEqual({ kind: "pass" });
  });

  it("takes no prefix it cannot read, nor one with no prefix binding behind it", () => {
    expect(compileHerdrKeys({ ...defaults, prefixes: [""] })).toBeNull();
    expect(compileHerdrKeys({ ...defaults, prefixes: ["prefix+b"] })).toBeNull();
    expect(compileHerdrKeys({ ...defaults, prefixes: ["prefix+b", "ctrl+a"] })?.prefixes).toHaveLength(1);
    const direct = Object.fromEntries(Object.keys(defaults.bindings).map((action) => [action, ["ctrl+alt+n"]])) as HerdrKeys["bindings"];
    expect(compileHerdrKeys({ prefix: "ctrl+b", prefixes: ["ctrl+b"], bindings: direct })).toBeNull();
  });

  it("runs a lone digit of an indexed action as that index, and never a hyper chord", () => {
    const own = compileHerdrKeys({ ...defaults, bindings: { ...defaults.bindings, switch_tab: ["prefix+3"], zoom: ["prefix+hyper+z"] } })!;
    expect(herdrKeyStep(own, true, key("3", "Digit3"))).toEqual({ kind: "run", action: "switch_tab", index: 3 });
    expect(herdrKeyStep(own, true, key("1", "Digit1"))).toEqual({ kind: "pass" });
    expect(herdrKeyStep(own, true, key("z", "KeyZ"))).toEqual({ kind: "pass" });
  });
});

describe("herdr's prefix actions in the usage counts", () => {
  it("counts an action a button or the palette also takes as a shortcut, once, and no other", () => {
    const counted: string[] = [];
    const actions = { counted: (action, source) => { counted.push(`${action}:${source}`); }, splitPane: () => {}, openSettings: () => {}, openNewSession: () => {}, toggleSidebar: () => {}, openTerminalTab: async () => {}, selectAdjacentTab: () => {}, openPalette: () => {} } as Partial<AppActions> as AppActions;
    for (const action of ["split_vertical", "split_horizontal", "settings", "new_workspace", "toggle_sidebar", "new_tab", "next_tab", "help"] as const) runHerdrAction(actions, action, null, () => {});
    expect(counted).toEqual(["split:shortcut", "split:shortcut", "settings:shortcut", "new_workspace:shortcut", "sidebar:shortcut", "new_tab:shortcut"]);
  });

  it("runs the action even when its count fails, as every key that counts does", () => {
    const opened: string[] = [];
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const actions = { counted: () => { throw new Error("storage full"); }, openSettings: () => { opened.push("settings"); } } as Partial<AppActions> as AppActions;
      runHerdrAction(actions, "settings", null, () => {});
    } finally { logged.mockRestore(); }
    expect(opened).toEqual(["settings"]);
  });
});
