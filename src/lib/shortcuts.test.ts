import { describe, expect, it } from "bun:test";

import { SHORTCUTS, bindingDisplayKeys, isAppShortcut, shortcutEventKey, isMacPlatform, matchShortcut, type ShortcutEventLike, keepsArrowsForText, keepsKeyForText, shortcutConflict, shortcutDisplayKeys, shortcutKeys } from "./shortcuts.ts";
import { isReservedShortcutKey, sanitizeShortcutOverrides } from "./shortcutBindings.ts";

function keyEvent(key: string, patch: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, ...patch };
}

describe("matchShortcut", () => {
  it("uses Command on Apple platforms and Control elsewhere", () => {
    expect(matchShortcut(keyEvent("K", { metaKey: true }), true)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), false)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(keyEvent("k", { metaKey: true }), false)).toBeNull();
  });

  it("matches every terminal-safe key", () => {
    expect(matchShortcut(keyEvent("j", { ctrlKey: true }), false)).toBe("toggle-view");
    expect(matchShortcut(keyEvent("F", { ctrlKey: true }), false)).toBe("find");
    expect(matchShortcut(keyEvent("F", { metaKey: true }), true)).toBe("find");
    expect(matchShortcut(keyEvent("f", { ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(matchShortcut(keyEvent("f", { ctrlKey: true }), false, { find: null })).toBeNull();
    expect(matchShortcut(keyEvent("g", { ctrlKey: true }), false, sanitizeShortcutOverrides({ find: "g" }))).toBe("find");
    expect(matchShortcut(keyEvent("B", { ctrlKey: true }), false)).toBe("toggle-sidebar");
    expect(matchShortcut(keyEvent("n", { ctrlKey: true }), false)).toBe("new-session");
    expect(matchShortcut(keyEvent("ArrowUp", { ctrlKey: true }), false)).toBe("previous-pane");
    expect(matchShortcut(keyEvent("ArrowDown", { ctrlKey: true }), false)).toBe("next-pane");
    expect(matchShortcut(keyEvent(",", { ctrlKey: true }), false)).toBe("settings");
    expect(matchShortcut(keyEvent("<", { ctrlKey: true, code: "Comma" }), false)).toBe("settings");
  });

  it("requires Shift and rejects extra or competing modifiers", () => {
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("x", { ctrlKey: true }), false)).toBeNull();
  });
});

describe("keepsArrowsForText", () => {
  const classes = (...names: string[]) => ({ contains: (name: string) => names.includes(name) });
  it("leaves Mod+Shift+arrows to the message box and other text fields, where they select text", () => {
    expect(keepsArrowsForText({ tagName: "TEXTAREA", value: "draft", classList: classes("composer-text") })).toBe(true);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "text", value: "a", classList: classes() })).toBe(true);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "search", value: "a", classList: classes() })).toBe(true);
    expect(keepsArrowsForText({ tagName: "DIV", isContentEditable: true, classList: classes() })).toBe(true);
  });

  it("switches panes from the terminal and anywhere that is no text field", () => {
    expect(keepsArrowsForText({ tagName: "TEXTAREA", classList: classes("xterm-helper-textarea") })).toBe(false);
    expect(keepsArrowsForText({ tagName: "TEXTAREA", value: "", classList: classes("composer-text") })).toBe(false);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "text", value: "", classList: classes() })).toBe(false);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "checkbox", classList: classes() })).toBe(false);
    expect(keepsArrowsForText({ tagName: "BUTTON", classList: classes() })).toBe(false);
    expect(keepsArrowsForText(null)).toBe(false);
  });

  it("leaves Home and End to a field with text too, and only selection keys", () => {
    const draft = { tagName: "TEXTAREA", value: "draft", classList: classes("composer-text") };
    expect(keepsKeyForText({ key: "Home", target: draft }, "previous-pane")).toBe(true);
    expect(keepsKeyForText({ key: "End", target: draft }, "next-pane")).toBe(true);
    expect(keepsKeyForText({ key: "ArrowUp", target: draft }, "previous-pane")).toBe(true);
    expect(keepsKeyForText({ key: "k", target: draft }, "palette")).toBe(false);
    expect(keepsKeyForText({ key: "Home", target: { tagName: "TEXTAREA", classList: classes("xterm-helper-textarea") } }, "previous-pane")).toBe(false);
  });

  it("lets the binding go where the field has no text left that way, so a draft never stops a pane switch", () => {
    const draft = (selectionStart: number, selectionEnd: number, selectionDirection = "none") =>
      ({ tagName: "TEXTAREA", value: "draft", selectionStart, selectionEnd, selectionDirection, classList: classes("composer-text") });
    // the caret at the end: down has nothing left to select, up still does
    expect(keepsKeyForText({ key: "ArrowDown", target: draft(5, 5) }, "next-pane")).toBe(false);
    expect(keepsKeyForText({ key: "End", target: draft(5, 5) }, "next-pane")).toBe(false);
    expect(keepsKeyForText({ key: "ArrowUp", target: draft(5, 5) }, "previous-pane")).toBe(true);
    // up once selected to the start (its moving end): the next up switches
    expect(keepsKeyForText({ key: "ArrowUp", target: draft(0, 5, "backward") }, "previous-pane")).toBe(false);
    expect(keepsKeyForText({ key: "ArrowDown", target: draft(0, 5, "backward") }, "next-pane")).toBe(true);
    // a selection made forward from the start still moves its end back
    expect(keepsKeyForText({ key: "ArrowUp", target: draft(0, 5, "forward") }, "previous-pane")).toBe(true);
    expect(keepsKeyForText({ key: "ArrowDown", target: draft(0, 5, "forward") }, "next-pane")).toBe(false);
    // the caret inside the text: both ways still select
    expect(keepsKeyForText({ key: "ArrowUp", target: draft(2, 2) }, "previous-pane")).toBe(true);
    expect(keepsKeyForText({ key: "ArrowDown", target: draft(2, 2) }, "next-pane")).toBe(true);
  });

  it("lets a tab or workspace step go at the draft's edge too, as a pane step", () => {
    const draft = (at: number) => ({ tagName: "TEXTAREA", value: "draft", selectionStart: at, selectionEnd: at, selectionDirection: "none", classList: classes("composer-text") });
    expect(keepsKeyForText({ key: "ArrowRight", target: draft(5) }, "next-tab")).toBe(false);
    expect(keepsKeyForText({ key: "ArrowLeft", target: draft(0) }, "previous-tab")).toBe(false);
    expect(keepsKeyForText({ key: "ArrowDown", target: draft(5) }, "next-workspace")).toBe(false);
    expect(keepsKeyForText({ key: "Home", target: draft(0) }, "previous-workspace")).toBe(false);
    expect(keepsKeyForText({ key: "ArrowRight", target: draft(2) }, "next-tab")).toBe(true);
    expect(keepsKeyForText({ key: "ArrowLeft", target: draft(5) }, "previous-workspace")).toBe(true);
  });

  it("gives a draft's edge only to the pane steps: another binding on those keys stays with the text", () => {
    const atStart = { tagName: "TEXTAREA", value: "draft", selectionStart: 0, selectionEnd: 0, selectionDirection: "none", classList: classes("composer-text") };
    const event = { key: "Home", code: "Home", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, target: atStart };
    const shortcut = matchShortcut(event, true, { palette: "Home" });
    expect(shortcut).toBe("palette");
    expect(keepsKeyForText(event, shortcut!)).toBe(true);
    expect(keepsKeyForText(event, "previous-pane")).toBe(false);
  });
});

describe("new workspace", () => {
  it("opens with Mod+Shift+O, which a browser tab lets through, and still with Mod+Shift+N", () => {
    const press = (key: string) => matchShortcut({ key, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, false);
    expect(press("O")).toBe("new-session");
    expect(press("N")).toBe("new-session");
  });
});

it("overrides remove default bindings, unbinding gives keys back, and IME events never switch panes", () => {
  const key = (value: string): ShortcutEventLike => ({ key: value, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false });
  expect(matchShortcut(key("k"), false, { palette: "p" })).toBeNull();
  expect(matchShortcut(key("p"), false, { palette: "p" })).toBe("palette");
  expect(matchShortcut(key("n"), false, { "new-session": null })).toBeNull();
  expect(matchShortcut({ ...key("k"), isComposing: true }, false)).toBeNull();
  expect(matchShortcut({ ...key("k"), keyCode: 229 }, false)).toBeNull();
});

it("matches shifted digits and detects alias and default-restoration conflicts", () => {
  expect(matchShortcut({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, false, { palette: "1" })).toBe("palette");
  expect(shortcutConflict("palette", ["n"], {})).toBe(true);
  expect(shortcutConflict("palette", shortcutKeys("palette", {}), { palette: "p", settings: "k" })).toBe(true);
});

describe("shortcutDisplayKeys", () => {
  it("shows the default chord, custom chord, disabled state, and uncustomizable voice chord", () => {
    expect(shortcutDisplayKeys("palette", {})).toEqual(["Mod", "Shift", "K"]);
    expect(shortcutDisplayKeys("toggle-view", { "toggle-view": "p" })).toEqual(["Mod", "Shift", "P"]);
    expect(shortcutDisplayKeys("settings", { settings: null })).toEqual([]);
    expect(shortcutDisplayKeys("voice", { voice: "p" })).toEqual(["Mod", "Shift", "Space"]);
  });
});

describe("non-Latin keyboard layouts", () => {
  it("uses KeyA-Z for a non-ASCII single character but preserves an ASCII event.key layout", () => {
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "KeyK" }), false, { palette: "k" })).toBe("palette");
    expect(matchShortcut(keyEvent("ㅏ", { ctrlKey: true, code: "KeyK" }), false)).toBe("palette");
    expect(matchShortcut(keyEvent("л", { metaKey: true, code: "KeyK" }), true)).toBe("palette");
    expect(matchShortcut(keyEvent("ㅏ", { ctrlKey: true, code: "KeyK" }), false, { palette: null })).toBeNull();
    expect(matchShortcut(keyEvent("q", { ctrlKey: true, code: "KeyK" }), false, { palette: "q" })).toBe("palette");
    expect(matchShortcut(keyEvent("q", { ctrlKey: true, code: "KeyK" }), false)).toBeNull();
    expect(matchShortcut(keyEvent("🙂", { ctrlKey: true, code: "KeyK" }), false, { palette: "k" })).toBeNull();
  });

  it("leaves an accented Latin letter to the terminal, whatever key position it sits on", () => {
    // BÉPO: É is on KeyW; Turkish F: Ç is on KeyB, the default sidebar key's position
    expect(matchShortcut(keyEvent("É", { ctrlKey: true, code: "KeyW" }), false, { "toggle-sidebar": "w" })).toBeNull();
    expect(matchShortcut(keyEvent("Ç", { ctrlKey: true, code: "KeyB" }), false)).toBeNull();
    expect(matchShortcut(keyEvent("ı", { ctrlKey: true, code: "KeyI" }), false, { palette: "i" })).toBeNull();
  });

  it("keeps IME guards and Comma/Digit code normalization ahead of layout fallback", () => {
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "KeyK", isComposing: true }), false, { palette: "k" })).toBeNull();
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "KeyK", keyCode: 229 }), false, { palette: "k" })).toBeNull();
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "Comma" }), false, { settings: "," })).toBe("settings");
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "Digit1" }), false, { palette: "1" })).toBe("palette");
  });

  it("keeps app-level and terminal shortcut detection on the same matcher", () => {
    const overrides = { palette: "k", "toggle-sidebar": "x" };
    const events = [
      keyEvent("한", { ctrlKey: true, code: "KeyK" }),
      keyEvent("x", { ctrlKey: true }),
      keyEvent("k", { ctrlKey: true, isComposing: true }),
      keyEvent("z", { ctrlKey: true }),
    ];
    for (const event of events) {
      expect(isAppShortcut(event, overrides)).toBe(matchShortcut(event, isMacPlatform(), overrides) !== null);
    }
  });
});

describe("isReservedShortcutKey", () => {
  it("reports documented browser reservations and macOS screenshot chords", () => {
    expect(isReservedShortcutKey("n", false)).toBe(true);
    expect(isReservedShortcutKey("T", false)).toBe(true);
    expect(isReservedShortcutKey("p", true)).toBe(true);
    expect(isReservedShortcutKey("b", true)).toBe(true);
    expect(isReservedShortcutKey("w", false)).toBe(true);
    expect(isReservedShortcutKey("w", true)).toBe(true);
    expect(isReservedShortcutKey("q", true)).toBe(true);
    expect(isReservedShortcutKey("j", false)).toBe(true);
    expect(isReservedShortcutKey("o", false)).toBe(true);
    expect(isReservedShortcutKey("PageUp", false)).toBe(true);
    expect(isReservedShortcutKey("PageDown", false)).toBe(true);
    expect(isReservedShortcutKey("3", true)).toBe(true);
    expect(isReservedShortcutKey("4", true)).toBe(true);
    expect(isReservedShortcutKey("5", true)).toBe(true);
  });

  it("does not classify unrelated or platform-inapplicable keys as reserved", () => {
    expect(isReservedShortcutKey("k", false)).toBe(false);
    expect(isReservedShortcutKey("ArrowUp", true)).toBe(false);
    expect(isReservedShortcutKey("j", true)).toBe(false);
    expect(isReservedShortcutKey("PageUp", true)).toBe(false);
    expect(isReservedShortcutKey("3", false)).toBe(false);
  });

  it("warns without rejecting a configured key or changing an existing default", () => {
    const overrides = sanitizeShortcutOverrides({ "new-session": "t" });
    expect(overrides).toEqual({ "new-session": "t" });
    expect(matchShortcut(keyEvent("t", { ctrlKey: true }), false, overrides)).toBe("new-session");
    expect(matchShortcut(keyEvent("n", { ctrlKey: true }), false)).toBe("new-session");
  });
});


describe("focus pane input", () => {
  it("uses a terminal-safe default on both platform families", () => {
    expect(matchShortcut(keyEvent("E", { metaKey: true }), true)).toBe("focus-input");
    expect(matchShortcut(keyEvent("e", { ctrlKey: true }), false)).toBe("focus-input");
    expect(matchShortcut(keyEvent("e", { ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(matchShortcut(keyEvent("E", { metaKey: true, isComposing: true }), true)).toBeNull();
  });
  it("can be reassigned or disabled with the existing settings", () => {
    const custom = sanitizeShortcutOverrides({ "focus-input": "g" });
    expect(custom["focus-input"]).toBe("g");
    expect(matchShortcut(keyEvent("G", { metaKey: true }), true, custom)).toBe("focus-input");
    expect(matchShortcut(keyEvent("E", { metaKey: true }), true, custom)).toBeNull();
    expect(matchShortcut(keyEvent("E", { metaKey: true }), true, { "focus-input": null })).toBeNull();
    expect(shortcutDisplayKeys("focus-input", {})).toEqual(["Mod", "Shift", "E"]);
  });
});

it("pages the selected pane with fixed Mod+Shift bindings, remapping and disabling", () => {
  for (const apple of [true, false]) {
    const press = (key: string, overrides = {}) => matchShortcut(keyEvent(key, { metaKey: apple, ctrlKey: !apple }), apple, overrides);
    expect(press("PageUp")).toBe("scroll-up");
    expect(press("PageDown")).toBe("scroll-down");
    expect(press("u", sanitizeShortcutOverrides({ "scroll-up": "u" }))).toBe("scroll-up");
    expect(press("PageUp", { "scroll-up": "u" })).toBeNull();
    expect(press("PageDown", sanitizeShortcutOverrides({ "scroll-down": null }))).toBeNull();
    expect(press("PageUp", sanitizeShortcutOverrides({ palette: "PageUp", "scroll-up": null }))).toBe("palette");
    for (const patch of [{ shiftKey: false }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(matchShortcut(keyEvent("PageUp", { metaKey: apple, ctrlKey: !apple, ...patch }), apple)).toBeNull();
    }
    expect(matchShortcut(keyEvent("PageUp"), apple)).toBeNull();
  }
  expect(shortcutDisplayKeys("scroll-up", {})).toEqual(["Mod", "Shift", "PageUp"]);
  expect(shortcutDisplayKeys("scroll-down", {})).toEqual(["Mod", "Shift", "PageDown"]);
  expect(shortcutConflict("palette", ["PageUp"], {})).toBe(true);
  expect(sanitizeShortcutOverrides({ "scroll-up": "PageDown", "scroll-down": "PageUp", find: "PageUp", settings: "F5" })).toEqual({ "scroll-up": "PageDown", "scroll-down": "PageUp", find: "PageUp" });
});

describe("new tab and split pane", () => {
  it("have no key until one is chosen in Settings, and then work like any other binding", () => {
    for (const id of ["new-tab", "rename-tab", "split-right", "split-down"] as const) {
      expect(shortcutKeys(id, {})).toEqual([]);
      expect(shortcutDisplayKeys(id, {})).toEqual([]);
    }
    expect(matchShortcut(keyEvent("t", { ctrlKey: true }), false)).toBeNull();
    const overrides = sanitizeShortcutOverrides({ "new-tab": "y", "rename-tab": "r", "split-right": "l", "split-down": "h" });
    expect(overrides).toEqual({ "new-tab": "y", "rename-tab": "r", "split-right": "l", "split-down": "h" });
    expect(matchShortcut(keyEvent("R", { ctrlKey: true }), false, overrides)).toBe("rename-tab");
    expect(shortcutDisplayKeys("rename-tab", overrides)).toEqual(["Mod", "Shift", "R"]);
    expect(matchShortcut(keyEvent("Y", { ctrlKey: true }), false, overrides)).toBe("new-tab");
    expect(matchShortcut(keyEvent("l", { metaKey: true }), true, overrides)).toBe("split-right");
    expect(matchShortcut(keyEvent("h", { ctrlKey: true }), false, overrides)).toBe("split-down");
    expect(shortcutDisplayKeys("new-tab", overrides)).toEqual(["Mod", "Shift", "Y"]);
    expect(shortcutConflict("split-down", ["y"], overrides)).toBe(true);
    expect(shortcutConflict("new-tab", ["k"], {})).toBe(true);
  });
});

describe("previous and next tab and workspace", () => {
  const ids = ["previous-tab", "next-tab", "previous-workspace", "next-workspace"] as const;

  it("are listed with no key until one is chosen in Settings, and then work like any other binding", () => {
    for (const id of ids) {
      expect(SHORTCUTS.some((shortcut) => shortcut.id === id)).toBe(true);
      expect(shortcutKeys(id, {})).toEqual([]);
      expect(shortcutDisplayKeys(id, {})).toEqual([]);
    }
    expect(matchShortcut(keyEvent("ArrowLeft", { ctrlKey: true }), false)).toBeNull();
    const overrides = sanitizeShortcutOverrides({ "previous-tab": "ArrowLeft", "next-tab": "ArrowRight", "previous-workspace": "[", "next-workspace": "meta+End" }, true);
    expect(overrides).toEqual({ "previous-tab": "ArrowLeft", "next-tab": "ArrowRight", "previous-workspace": "[", "next-workspace": "meta+End" });
    expect(matchShortcut(keyEvent("ArrowLeft", { metaKey: true }), true, overrides)).toBe("previous-tab");
    expect(matchShortcut(keyEvent("ArrowRight", { metaKey: true }), true, overrides)).toBe("next-tab");
    expect(matchShortcut(keyEvent("{", { code: "BracketLeft", metaKey: true }), true, overrides)).toBe("previous-workspace");
    expect(matchShortcut(keyEvent("End", { metaKey: true, shiftKey: false }), true, overrides)).toBe("next-workspace");
    expect(shortcutDisplayKeys("previous-tab", overrides)).toEqual(["Mod", "Shift", "ArrowLeft"]);
    expect(shortcutConflict("next-tab", ["ArrowUp"], overrides)).toBe(true);
  });
});

describe("exact-modifier bindings", () => {
  const ctrlK = (patch: Partial<ShortcutEventLike> = {}) => keyEvent("k", { ctrlKey: true, shiftKey: false, ...patch });

  it("runs only on the exact chord recorded", () => {
    const overrides = sanitizeShortcutOverrides({ palette: "ctrl+k", "scroll-up": "meta+PageUp" }, true);
    expect(matchShortcut(ctrlK(), false, overrides)).toBe("palette");
    expect(matchShortcut(ctrlK({ altKey: true }), false, overrides)).toBeNull();
    // the moved palette no longer answers its default Mod+Shift+K
    expect(matchShortcut(ctrlK({ shiftKey: true }), false, overrides)).toBeNull();
    expect(matchShortcut(keyEvent("PageUp", { metaKey: true, shiftKey: false }), true, overrides)).toBe("scroll-up");
    expect(matchShortcut(keyEvent("PageUp", { metaKey: true, shiftKey: true }), true, overrides)).toBeNull();
    expect(isAppShortcut(ctrlK(), overrides)).toBe(true);
  });

  it("runs Mod+Shift+Home/End and exact Home/End chords", () => {
    const overrides = sanitizeShortcutOverrides({ "previous-pane": "Home", "next-pane": "meta+End" }, true);
    expect(matchShortcut(keyEvent("Home", { metaKey: true }), true, overrides)).toBe("previous-pane");
    expect(matchShortcut(keyEvent("End", { metaKey: true, shiftKey: false }), true, overrides)).toBe("next-pane");
    expect(shortcutDisplayKeys("previous-pane", overrides)).toEqual(["Mod", "Shift", "Home"]);
  });

  it("matches a macOS Option chord by its key", () => {
    const overrides = sanitizeShortcutOverrides({ find: "alt+meta+f" }, true);
    expect(matchShortcut(keyEvent("ƒ", { metaKey: true, altKey: true, shiftKey: false, code: "KeyF" }), true, overrides)).toBe("find");
  });

  it("finds a conflict between a Mod+Shift key and the same chord stored exactly", () => {
    expect(shortcutConflict("find", ["ctrl+shift+k"], {}, false)).toBe(true);
    expect(shortcutConflict("find", ["shift+meta+k"], {}, true)).toBe(true);
    expect(shortcutConflict("find", ["ctrl+shift+k"], {}, true)).toBe(false);
    expect(shortcutConflict("find", ["ctrl+k"], { palette: "ctrl+k" }, false)).toBe(true);
    expect(shortcutConflict("find", ["k"], { palette: "ctrl+k" }, false)).toBe(false);
  });

  it("keeps stored values valid and drops malformed ones", () => {
    expect(sanitizeShortcutOverrides({ palette: "ctrl+k", find: "shift+g", settings: "meta+ctrl+k", "new-tab": "alt+F5", "split-right": "ctrl+alt+shift+meta+," }, true))
      .toEqual({ palette: "ctrl+k", "split-right": "ctrl+alt+shift+meta+," });
  });

  it("drops a stored chord the recorder refuses on this platform", () => {
    const stored = { palette: "ctrl+t", find: "meta+q", settings: "ctrl+PageUp", "new-tab": "meta+PageUp", "split-right": "ctrl+k", "split-down": null };
    expect(sanitizeShortcutOverrides(stored, false)).toEqual({ "split-right": "ctrl+k", "split-down": null });
    // on a Mac the browser keeps ⌘T and ⌘Q, not Ctrl+T
    expect(sanitizeShortcutOverrides(stored, true)).toEqual({ palette: "ctrl+t", "new-tab": "meta+PageUp", "split-right": "ctrl+k", "split-down": null });
  });

  it("shows the exact modifiers in macOS order", () => {
    expect(bindingDisplayKeys("ctrl+alt+shift+meta+k")).toEqual(["Ctrl", "Alt", "Shift", "Meta", "K"]);
    expect(bindingDisplayKeys("meta+PageUp")).toEqual(["Meta", "PageUp"]);
    expect(bindingDisplayKeys("k")).toEqual(["Mod", "Shift", "K"]);
    expect(shortcutDisplayKeys("palette", { palette: "ctrl+k" })).toEqual(["Ctrl", "K"]);
  });
});

describe("punctuation keys by position", () => {
  const at = (key: string, code: string) => shortcutEventKey(keyEvent(key, { code, metaKey: true }));

  it("reads an accented letter or a symbol by the key it sits on", () => {
    // Hungarian: é ; á ' ő [ ú ] ű \ ü - ó =
    expect([at("é", "Semicolon"), at("á", "Quote"), at("ő", "BracketLeft"), at("ú", "BracketRight"), at("ű", "Backslash"), at("ü", "Minus"), at("ó", "Equal")])
      .toEqual([";", "'", "[", "]", "\\", "-", "="]);
    expect(at("í", "IntlBackslash")).toBe("§");
    expect(at("ö", "Semicolon")).toBe(";"); // German
    expect(at("ж", "Semicolon")).toBe(";"); // Russian
    expect(at(";", "Semicolon")).toBe(";"); // US
  });

  it("keeps an a–z letter as typed wherever it sits", () => {
    expect(at("m", "Semicolon")).toBe("m"); // AZERTY
    expect(at("M", "Semicolon")).toBe("m");
  });

  it("runs a binding recorded on one layout from the same key on another", () => {
    const overrides = sanitizeShortcutOverrides({ "previous-pane": ";", "next-pane": "meta+'" }, true);
    expect(matchShortcut(keyEvent("É", { code: "Semicolon", metaKey: true }), true, overrides)).toBe("previous-pane");
    expect(matchShortcut(keyEvent(":", { code: "Semicolon", metaKey: true }), true, overrides)).toBe("previous-pane");
    expect(matchShortcut(keyEvent("á", { code: "Quote", metaKey: true, shiftKey: false }), true, overrides)).toBe("next-pane");
  });
});
