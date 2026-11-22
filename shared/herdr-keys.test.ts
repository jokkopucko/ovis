import { describe, expect, test } from "bun:test";
import { bindingChords, HERDR_PREFIX_ACTIONS, parseHerdrBinding, resolveAllHerdrKeys, resolveHerdrKeys, type AllHerdrKeys, type HerdrChord } from "./herdr-keys.ts";

const chord = (key: string, modifiers: Partial<HerdrChord> = {}): HerdrChord => ({ ctrl: false, alt: false, shift: false, meta: false, hyper: false, key, ...modifiers });

function action(keys: AllHerdrKeys, name: string) {
  const found = keys.actions.find((entry) => entry.action === name);
  if (found === undefined) throw new Error(`no action ${name}`);
  return found;
}

/** the chords an action holds, prefixed or direct, with the index each picks */
function held(keys: AllHerdrKeys, name: string, prefixed: boolean) {
  return action(keys, name).bindings.filter((binding) => binding.prefixed === prefixed).flatMap((binding) => binding.chords);
}

/** herdr 0.9.5's navigate-mode defaults, as its `herdr --default-config` prints them */
const herdrNavigateDefaults: AllHerdrKeys["navigate"] = [
  { name: "navigate_workspace_up", default: "up", text: "up", chord: chord("ArrowUp") },
  { name: "navigate_workspace_down", default: "down", text: "down", chord: chord("ArrowDown") },
  { name: "navigate_pane_left", default: "h", text: "h", chord: chord("h") },
  { name: "navigate_pane_down", default: "j", text: "j", chord: chord("j") },
  { name: "navigate_pane_up", default: "k", text: "k", chord: chord("k") },
  { name: "navigate_pane_right", default: "l", text: "l", chord: chord("l") },
];

function refusal(keys: AllHerdrKeys, name: string) {
  return keys.refusals.filter((entry) => entry.action === name).map(({ action: refused, binding, code, holder }) => ({ action: refused, binding, code, holder }));
}

describe("resolveAllHerdrKeys", () => {
  test("herdr's defaults with no config", () => {
    const keys = resolveAllHerdrKeys(undefined);
    expect(keys.configRead).toBe(true);
    expect(keys.prefixes).toEqual([{ text: "ctrl+b", chord: chord("b", { ctrl: true }) }]);
    expect(keys.actions).toHaveLength(52);
    expect(new Set(keys.actions.map((entry) => entry.action)).size).toBe(52);
    expect(action(keys, "help")).toMatchObject({ default: "prefix+?" });
    expect(held(keys, "help", true)).toEqual([{ chord: chord("?"), index: null }]);
    expect(action(keys, "new_workspace").default).toBe("prefix+shift+n");
    expect(held(keys, "new_workspace", true)).toEqual([{ chord: chord("n", { shift: true }), index: null }]);
    expect(held(keys, "split_horizontal", true)).toEqual([{ chord: chord("-"), index: null }]);
    expect(held(keys, "cycle_pane_previous", true)).toEqual([{ chord: chord("Tab", { shift: true }), index: null }]);
    expect(held(keys, "detach", true)).toEqual([{ chord: chord("q"), index: null }]);
    expect(action(keys, "switch_tab").bindings).toHaveLength(1);
    expect(action(keys, "switch_tab").bindings[0]).toMatchObject({ text: "prefix+1..9", prefixed: true, range: true });
    expect(held(keys, "switch_tab", true).map((item) => [item.chord.key, item.index])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => [String(index), index]));
    // an action herdr leaves unbound keeps an empty default and no binding
    expect(action(keys, "last_pane")).toEqual({ action: "last_pane", default: "", bindings: [] });
    // every bound default is held as written
    for (const entry of keys.actions) expect(entry.bindings.map((binding) => binding.text)).toEqual(entry.default === "" ? [] : [entry.default]);
    expect(keys.direct).toEqual([]);
    expect(keys.refusals).toEqual([]);
  });

  test("a user's changed prefix", () => {
    const keys = resolveAllHerdrKeys({ prefix: "ctrl+a", extra_prefixes: ["ctrl+space", "ctrl+a"] });
    expect(keys.prefixes).toEqual([{ text: "ctrl+a", chord: chord("a", { ctrl: true }) }, { text: "ctrl+space", chord: chord(" ", { ctrl: true }) }]);
    // the defaults after the prefix stand, whatever the prefix is
    expect(held(keys, "new_tab", true)).toEqual([{ chord: chord("c"), index: null }]);
    // a binding on a prefix chord after the prefix is refused: the prefix twice sends the prefix
    const onPrefix = resolveAllHerdrKeys({ prefix: "ctrl+a", new_tab: "prefix+ctrl+a" });
    expect(refusal(onPrefix, "new_tab")).toEqual([{ action: "new_tab", binding: "prefix+ctrl+a", code: "prefix", holder: null }]);
    expect(action(onPrefix, "new_tab").bindings).toEqual([]);
    // a prefix herdr cannot read is reported and ctrl+b stands
    const unreadable = resolveAllHerdrKeys({ prefix: "prefix+x" });
    expect(unreadable.prefixes.map((prefix) => prefix.text)).toEqual(["ctrl+b"]);
    expect(refusal(unreadable, "prefix")).toEqual([{ action: "prefix", binding: "prefix+x", code: "unparsable", holder: null }]);
  });

  test("a direct binding", () => {
    const keys = resolveAllHerdrKeys({ new_tab: ["ctrl+t", "prefix+c"], zoom: "alt+z", next_tab: "f5", previous_tab: "cmd+shift+[" });
    expect(keys.direct).toEqual([
      { action: "new_tab", text: "ctrl+t", chord: chord("t", { ctrl: true }), index: null },
      { action: "previous_tab", text: "cmd+shift+[", chord: chord("[", { meta: true, shift: true }), index: null },
      { action: "next_tab", text: "f5", chord: chord("F5"), index: null },
      { action: "zoom", text: "alt+z", chord: chord("z", { alt: true }), index: null },
    ]);
    expect(held(keys, "new_tab", true)).toEqual([{ chord: chord("c"), index: null }]);
    // the user wrote next_tab, so its default prefix+n stands down
    expect(held(keys, "next_tab", true)).toEqual([]);
    expect(keys.refusals).toEqual([]);
  });

  test("a refused printable direct binding", () => {
    const keys = resolveAllHerdrKeys({ focus_pane_down: "j", new_tab: "shift+c", toggle_sidebar: "space", switch_tab: "1..9" });
    for (const [name, binding] of [["focus_pane_down", "j"], ["new_tab", "shift+c"], ["toggle_sidebar", "space"], ["switch_tab", "1..9"]] as const) {
      expect(refusal(keys, name)).toEqual([{ action: name, binding, code: "printable", holder: null }]);
      expect(action(keys, name).bindings).toEqual([]);
      expect(keys.refusals.find((entry) => entry.action === name)?.reason).not.toBe("");
    }
    expect(keys.direct).toEqual([]);
  });

  test("the sixteen prefix actions resolve exactly as the existing resolver does", () => {
    // literal: the existing resolver's defaults, so the comparison below is not the code against itself
    expect(resolveHerdrKeys(undefined).bindings).toMatchObject({ new_tab: ["prefix+c"], switch_tab: ["prefix+1..9"], split_horizontal: ["prefix+minus"], help: ["prefix+?"], toggle_sidebar: ["prefix+b"], previous_workspace: [] });
    const fixtures: unknown[] = [
      undefined, null, "keys", [], {},
      { prefix: "ctrl+a" },
      { prefix: ["ctrl+a", "ctrl+b"], extra_prefixes: ["ctrl+space", "prefix+x"] },
      { new_tab: "prefix+t", split_vertical: ["prefix+v", "prefix+|"], help: "prefix+h", previous_workspace: "prefix+[" },
      { new_tab: ["ctrl+t", "prefix+c"], zoom: "alt+z" },
      { focus_pane_down: "j", new_tab: "c" },
      { new_tab: "prefix+pagedown", zoom: "prefix+", settings: "" },
      { prefix: "  Control+A  ", new_tab: "Prefix+C", rename_tab: "prefix+SHIFT+t", split_vertical: "prefix+V" },
      { frobnicate: "prefix+f", new_tab: "prefix+t" },
      { new_tab: "prefix+t", rename_tab: "prefix+t", goto: "prefix+c" },
      { new_tab: 5, zoom: "prefix+f" },
      { indexed: { tabs: "prefix+alt" } },
      { new_tab: "prefix+alt+3", switch_tab: "prefix+alt+1..9", zoom: "prefix+1..9" },
      { prefix: "ctrl+a", new_tab: "prefix+ctrl+a" },
      { fullscreen: "prefix+f" },
      { command: [{ key: "prefix+c", command: "ls" }, { key: "prefix+z", command: "" }] },
      { prefix: "x" },
      { switch_tab: ["prefix+5", "prefix+t", "ctrl+1..9"] },
    ];
    expect(resolveAllHerdrKeys({ new_tab: "prefix+alt+3", switch_tab: "prefix+alt+1..9" }).actions.find((entry) => entry.action === "switch_tab")?.bindings[0]?.chords.map((item) => item.index)).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
    for (const keys of fixtures) {
      const existing = resolveHerdrKeys(keys);
      const all = resolveAllHerdrKeys(keys);
      expect(all.prefixes.map((prefix) => prefix.text)).toEqual(existing.prefixes);
      for (const name of HERDR_PREFIX_ACTIONS) {
        const expected = existing.bindings[name].flatMap((text) => bindingChords(parseHerdrBinding(text)!, name));
        expect({ name, keys, chords: held(all, name, true) }).toEqual({ name, keys, chords: expected });
      }
    }
  });

  test("two actions on one chord: the first in herdr's order keeps it, a user's loss is reported, a default's is not", () => {
    const keys = resolveAllHerdrKeys({ new_tab: "prefix+t", rename_tab: "prefix+t", goto: "prefix+c" });
    expect(held(keys, "new_tab", true)).toEqual([{ chord: chord("t"), index: null }]);
    expect(action(keys, "rename_tab").bindings).toEqual([]);
    expect(refusal(keys, "rename_tab")).toEqual([{ action: "rename_tab", binding: "prefix+t", code: "taken", holder: "new_tab" }]);
    // goto, written by the user, beats new_tab's default on c without a report
    expect(held(keys, "goto", true)).toEqual([{ chord: chord("c"), index: null }]);
    expect(refusal(keys, "goto")).toEqual([]);
    expect(keys.refusals).toHaveLength(1);
    // two direct bindings on one chord follow the same rule
    const direct = resolveAllHerdrKeys({ new_tab: "ctrl+t", next_tab: "ctrl+t" });
    expect(direct.direct.map((entry) => entry.action)).toEqual(["new_tab"]);
    expect(refusal(direct, "next_tab")).toEqual([{ action: "next_tab", binding: "ctrl+t", code: "taken", holder: "new_tab" }]);
    // a direct binding on the prefix would hide it
    expect(refusal(resolveAllHerdrKeys({ zoom: "ctrl+b" }), "zoom")).toEqual([{ action: "zoom", binding: "ctrl+b", code: "prefix", holder: null }]);
    // a custom command's key is taken: the default stands down and no action holds it
    const command = resolveAllHerdrKeys({ command: [{ key: "prefix+c", command: "ls" }] });
    expect(action(command, "new_tab").bindings).toEqual([]);
    expect(command.refusals).toEqual([]);
  });

  test("an unknown action name is reported and changes nothing else", () => {
    const keys = resolveAllHerdrKeys({ frobnicate: "prefix+f", new_tab: "prefix+t" });
    expect(keys.configRead).toBe(true);
    expect(refusal(keys, "frobnicate")).toEqual([{ action: "frobnicate", binding: "prefix+f", code: "unknown_action", holder: null }]);
    expect(keys.actions.map((entry): string => entry.action)).not.toContain("frobnicate");
    expect(held(keys, "new_tab", true)).toEqual([{ chord: chord("t"), index: null }]);
    // the names herdr reads besides actions are not unknown
    expect(resolveAllHerdrKeys({ prefix: "ctrl+a", extra_prefixes: [], indexed: {}, command: [], fullscreen: "prefix+f" }).refusals).toEqual([]);
  });

  test("an unparsable chord is reported; a value of the wrong type makes herdr read no config", () => {
    const keys = resolveAllHerdrKeys({ new_tab: "prefix+pagedown", zoom: "prefix+", settings: "" });
    expect(refusal(keys, "new_tab")).toEqual([{ action: "new_tab", binding: "prefix+pagedown", code: "unparsable", holder: null }]);
    expect(refusal(keys, "zoom")).toEqual([{ action: "zoom", binding: "prefix+", code: "unparsable", holder: null }]);
    // an empty string unbinds without a report
    expect(refusal(keys, "settings")).toEqual([]);
    for (const name of ["new_tab", "zoom", "settings"]) expect(action(keys, name).bindings).toEqual([]);
    const wrong = resolveAllHerdrKeys({ new_tab: 5, zoom: "prefix+f" });
    expect(wrong.configRead).toBe(false);
    expect(held(wrong, "zoom", true)).toEqual([{ chord: chord("z"), index: null }]);
    expect(wrong.refusals).toEqual([]);
  });

  test("a range belongs to an indexed action, and an indexed action takes digits only", () => {
    const keys = resolveAllHerdrKeys({ switch_tab: ["prefix+5", "prefix+t", "ctrl+1..9"], zoom: "prefix+1..9" });
    expect(held(keys, "switch_tab", true)).toEqual([{ chord: chord("5"), index: 5 }]);
    expect(held(keys, "switch_tab", false).map((item) => [item.chord.ctrl, item.chord.key, item.index])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => [true, String(index), index]));
    expect(keys.direct.filter((entry) => entry.action === "switch_tab")).toHaveLength(9);
    expect(refusal(keys, "switch_tab")).toEqual([{ action: "switch_tab", binding: "prefix+t", code: "index", holder: null }]);
    expect(refusal(keys, "zoom")).toEqual([{ action: "zoom", binding: "prefix+1..9", code: "index", holder: null }]);
  });

  test("herdr's six navigate defaults written out are read whole, with no refusal", () => {
    const keys = resolveAllHerdrKeys({ navigate_workspace_up: "up", navigate_workspace_down: "down", navigate_pane_left: "h", navigate_pane_down: "j", navigate_pane_up: "k", navigate_pane_right: "l" });
    expect(keys.navigate).toEqual(herdrNavigateDefaults);
    expect(keys.refusals).toEqual([]);
  });

  test("with no navigate key in the config the six hold herdr's defaults", () => {
    expect(resolveAllHerdrKeys(undefined).navigate).toEqual(herdrNavigateDefaults);
    expect(resolveAllHerdrKeys({ new_tab: "prefix+t" }).navigate).toEqual(herdrNavigateDefaults);
    // the user's key replaces the default; a list holds one entry per key
    const keys = resolveAllHerdrKeys({ navigate_pane_down: "J", navigate_workspace_up: ["K", "ctrl+p"] });
    expect(keys.navigate.filter((entry) => entry.name === "navigate_workspace_up" || entry.name === "navigate_pane_down")).toEqual([
      { name: "navigate_workspace_up", default: "up", text: "K", chord: chord("k", { shift: true }) },
      { name: "navigate_workspace_up", default: "up", text: "ctrl+p", chord: chord("p", { ctrl: true }) },
      { name: "navigate_pane_down", default: "j", text: "J", chord: chord("j", { shift: true }) },
    ]);
    expect(keys.refusals).toEqual([]);
    // a navigate key is no terminal-mode binding, and shares its key with one freely: they live in different modes
    const shared = resolveAllHerdrKeys({ navigate_pane_left: "ctrl+t", new_tab: "ctrl+t" });
    expect(shared.direct.map((entry) => entry.action)).toEqual(["new_tab"]);
    expect(shared.navigate.find((entry) => entry.name === "navigate_pane_left")?.chord).toEqual(chord("t", { ctrl: true }));
    expect(shared.refusals).toEqual([]);
  });

  test("plain esc, enter, tab and 1..9 are reserved on a navigate key; arrows, 0 and modified keys are kept", () => {
    const keys = resolveAllHerdrKeys({ navigate_pane_left: ["esc", "enter", "tab", "5", "prefix+h", "1..9", "pagedown"], navigate_workspace_up: ["up", "left", "0", "ctrl+5", "ctrl+up", "shift+tab"] });
    expect(refusal(keys, "navigate_pane_left").map(({ binding, code }) => [binding, code])).toEqual([
      ["esc", "reserved"], ["enter", "reserved"], ["tab", "reserved"], ["5", "reserved"], ["prefix+h", "unparsable"], ["1..9", "unparsable"], ["pagedown", "unparsable"],
    ]);
    expect(refusal(keys, "navigate_workspace_up")).toEqual([]);
    expect(keys.navigate.filter((entry) => entry.name === "navigate_workspace_up").map((entry) => entry.chord)).toEqual([
      chord("ArrowUp"), chord("ArrowLeft"), chord("0"), chord("5", { ctrl: true }), chord("ArrowUp", { ctrl: true }), chord("Tab", { shift: true }),
    ]);
  });

  test("a navigate name herdr does not have is unknown; every name herdr's own config documents is known", () => {
    const keys = resolveAllHerdrKeys({ navigate_pane_dwon: "x", navigate_: "y", frobnicate: "z", remote_image_paste: "ctrl+v" });
    expect(keys.refusals.map(({ action: name, binding, code }) => [name, binding, code])).toEqual([
      ["navigate_pane_dwon", "x", "unknown_action"], ["navigate_", "y", "unknown_action"], ["frobnicate", "z", "unknown_action"],
    ]);
    expect(keys.navigate).toEqual(herdrNavigateDefaults);
  });

  test("a navigate key the user writes replaces its default even when refused, as an action's binding does", () => {
    const keys = resolveAllHerdrKeys({ navigate_pane_left: "esc", zoom: "j" });
    expect(keys.refusals.map((entry) => [entry.action, entry.code])).toEqual([["zoom", "printable"], ["navigate_pane_left", "reserved"]]);
    expect([action(keys, "zoom").bindings, keys.navigate.find((entry) => entry.name === "navigate_pane_left")]).toEqual([[], { name: "navigate_pane_left", default: "h", text: "", chord: null }]);
  });

  test("a navigate key on a prefix, on another navigate key's key, or of the wrong type is refused and the rest resolves", () => {
    const keys = resolveAllHerdrKeys({ navigate_pane_left: ["ctrl+b", ""], navigate_pane_right: "x", navigate_pane_up: "x", navigate_pane_down: 5, new_tab: "prefix+t" });
    expect(keys.configRead).toBe(true);
    expect(refusal(keys, "navigate_pane_left")).toEqual([{ action: "navigate_pane_left", binding: "ctrl+b", code: "prefix", holder: null }]);
    // the first in herdr's order keeps the key
    expect(refusal(keys, "navigate_pane_right")).toEqual([{ action: "navigate_pane_right", binding: "x", code: "taken", holder: "navigate_pane_up" }]);
    expect(refusal(keys, "navigate_pane_down").map((entry) => entry.code)).toEqual(["unparsable"]);
    expect(keys.navigate.map((entry) => [entry.name, entry.text])).toEqual([
      ["navigate_workspace_up", "up"], ["navigate_workspace_down", "down"], ["navigate_pane_left", ""], ["navigate_pane_down", ""], ["navigate_pane_up", "x"], ["navigate_pane_right", ""],
    ]);
    expect(held(keys, "new_tab", true)).toEqual([{ chord: chord("t"), index: null }]);
  });

  test("a prefix list with a hole is read without it, as the existing resolver always did", () => {
    expect(resolveHerdrKeys({ prefix: [, "ctrl+a"] }).prefixes).toEqual(["ctrl+a"]);
    expect(resolveHerdrKeys({ prefix: "ctrl+a", extra_prefixes: ["ctrl+space", , "ctrl+q"] }).prefixes).toEqual(["ctrl+a", "ctrl+space", "ctrl+q"]);
    const keys = resolveAllHerdrKeys({ prefix: [, "ctrl+a"], navigate_pane_down: [, "J"] });
    expect(keys.prefixes.map((prefix) => prefix.text)).toEqual(["ctrl+a"]);
    expect(keys.navigate.find((entry) => entry.name === "navigate_pane_down")?.text).toBe("J");
    expect(keys.refusals).toEqual([]);
  });

  test("modifier and key names in any case herdr reads, the prefix word in lowercase only", () => {
    const keys = resolveAllHerdrKeys({ prefix: "  Control+A  ", rename_tab: "prefix+SHIFT+t", split_vertical: "prefix+V", toggle_sidebar: "prefix+TAB", zoom: "ALT+F5", next_tab: "Prefix+n" });
    expect(keys.prefixes).toEqual([{ text: "Control+A", chord: chord("a", { ctrl: true, shift: true }) }]);
    expect(held(keys, "rename_tab", true)).toEqual([{ chord: chord("t", { shift: true }), index: null }]);
    expect(held(keys, "split_vertical", true)).toEqual([{ chord: chord("v", { shift: true }), index: null }]);
    expect(held(keys, "toggle_sidebar", true)).toEqual([{ chord: chord("Tab"), index: null }]);
    expect(held(keys, "zoom", false)).toEqual([{ chord: chord("F5", { alt: true }), index: null }]);
    expect(refusal(keys, "next_tab")).toEqual([{ action: "next_tab", binding: "Prefix+n", code: "unparsable", holder: null }]);
  });
});
