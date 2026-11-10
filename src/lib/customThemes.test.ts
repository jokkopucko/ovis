import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  bootRows, chosenTheme, customRow, customRowId, drawnTheme, MAX_CUSTOM_THEMES, MAX_THEME_FILE_BYTES, MAX_THEME_NAME, NO_CUSTOM_THEMES,
  nameKey, readThemeFile, sanitizeCustomThemes, withImported, withoutTheme, withTheme, type CustomTheme, type CustomThemes,
} from "./customThemes.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";
import { BASE16_KEYS } from "./themeDerive.ts";
import { THEME_VARS } from "./themeBoot.ts";
import { rowFor } from "./themes.ts";

const GUIDE = readFileSync(new URL("../../docs/themes.md", import.meta.url), "utf8");
/** The example file docs/themes.md shows: what the page promises is what the reader takes. */
const EXAMPLE = /```json\n([\s\S]*?)```/.exec(GUIDE)![1]!;

const theme = (text: string, name?: string): CustomTheme => {
  const result = readThemeFile(text, name);
  if ("error" in result) throw new Error(`refused: ${result.error}`);
  return result.theme;
};

const SCHEME = `system: "base16"
name: "Harbor Night"
author: "someone (https://example.com)"
variant: "dark"
# a comment line
palette:
  base00: "#1B2B34"  # Default Background
  base01: "#343D46"
  base02: "#4F5B66"
  base03: "#65737E"
  base04: "#A7ADBA"
  base05: "#C0C5CE"
  base06: "#CDD3DE"
  base07: "#D8DEE9"
  base08: "#EC5f67"
  base09: "#F99157"
  base0A: "#FAC863"
  base0B: "#99C794"
  base0C: "#5FB3B3"
  base0D: "#6699CC"
  base0E: "#C594C5"
  base0F: "#AB7967"
`;

describe("readThemeFile", () => {
  test("reads the example of docs/themes.md: a name and both sides, sixteen colours each", () => {
    const read = theme(EXAMPLE);
    expect(read.name).toBe("Lamplight");
    for (const side of ["dark", "light"] as const) {
      expect(Object.keys(read[side]!)).toEqual([...BASE16_KEYS]);
      expect(Object.values(read[side]!).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    }
    expect(read.dark!.base00).toBe("#181613");
    expect(read.light!.base05).toBe("#2a251f");
    expect(read.id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("reads a Base16 scheme as published: YAML with a palette, comments and upper-case hex", () => {
    const read = theme(SCHEME, "file-name");
    expect(read).toMatchObject({ name: "Harbor Night", dark: { base00: "#1b2b34", base08: "#ec5f67", base0F: "#ab7967" } });
    expect(read.light).toBeUndefined();
  });

  test("reads the older flat scheme, a JSON scheme and a side told only by its colours", () => {
    const flat = theme(`scheme: "Paper"\nauthor: "x"\nbase00: "f8f8f8"\nbase05: "383838"\nbase0D: '7cafc2'\n`);
    expect(flat.name).toBe("Paper");
    // a ground lighter than the text is a light theme
    expect(flat.light).toMatchObject({ base00: "#f8f8f8", base05: "#383838", base0D: "#7cafc2" });
    expect(flat.dark).toBeUndefined();
    // the side is what the colours are, whatever the scheme calls itself
    const json = theme(JSON.stringify({ name: "J", variant: "light", palette: { base00: "#101010", base05: "#e0e0e0" } }));
    expect(json.dark?.base00).toBe("#101010");
    expect(json.light).toBeUndefined();
    expect(theme(`name: "Day"\nvariant: "dark"\npalette:\n  base00: "#ffffff"\n  base05: "#202020"\n`)).toMatchObject({ name: "Day", light: { base00: "#ffffff" } });
    expect(theme(JSON.stringify({ BASE00: "#101010", Base05: "E0E0E0" }), "from-file").dark).toMatchObject({ base00: "#101010", base05: "#e0e0e0" });
    expect(theme(JSON.stringify({ base00: "#101010", base05: "#e0e0e0" }), "from-file").name).toBe("from-file");
  });

  test("a block is filed by the colours the file wrote, and none is dropped", () => {
    const night = { base00: "#101010", base05: "#e0e0e0" }, day = { base00: "#ffffff", base05: "#202020" };
    // a light block called dark is the light side
    const mislabelled = theme(JSON.stringify({ name: "M", dark: day }));
    expect(mislabelled.light?.base00).toBe("#ffffff");
    expect(mislabelled.dark).toBeUndefined();
    // both sides swapped come out the right way round
    expect(theme(JSON.stringify({ name: "S", dark: day, light: night }))).toMatchObject({ dark: { base00: "#101010" }, light: { base00: "#ffffff" } });
    // two dark blocks both stay where the file put them: the light side draws a dark one, as with a built-in dark theme
    const twice = theme(JSON.stringify({ name: "T", dark: night, light: { base00: "#000020", base05: "#f0f0ff" } }));
    expect(twice.dark?.base00).toBe("#101010");
    expect(twice.light?.base00).toBe("#000020");
    expect(customRow(twice, "light").mode).toBe("dark");
    // what a block draws as is told by its colours too
    expect(customRow(mislabelled, "dark").mode).toBe("light");
    expect(Object.keys(customRow(mislabelled, "dark").terminal)).toHaveLength(20);
  });

  test("a faint dark block stays the dark side though its text has to cross the ground to be read", () => {
    // light text on a mid grey: only a dark text reads there, so it is drawn with one, and it is still the file's dark side
    const both = theme(JSON.stringify({ name: "Both", dark: { base00: "#777777", base05: "#888888" }, light: { base00: "#ffffff", base05: "#222222" } }));
    expect(both.dark?.base00).toBe("#777777");
    expect(both.light?.base00).toBe("#ffffff");
    const row = customRow(both, "dark");
    expect(row.bg).toBe("#777777");
    expect(row.mode).toBe("light");
    expect(customRow(both, "light").bg).toBe("#ffffff");
    // alone, it is filed by what the file wrote as well
    expect(theme(JSON.stringify({ name: "Faint", base00: "#777777", base05: "#888888" })).dark?.base00).toBe("#777777");
    expect(theme(JSON.stringify({ name: "Faint day", base00: "#888888", base05: "#777777" })).light?.base00).toBe("#888888");
    // a text the colour of its ground goes by how light the ground is
    expect(theme(JSON.stringify({ name: "One", base00: "#f0f0f0", base05: "#f0f0f0" })).light?.base00).toBe("#f0f0f0");
    expect(theme(JSON.stringify({ name: "One", base00: "#101010", base05: "#101010" })).dark?.base00).toBe("#101010");
  });

  test("reads YAML as scheme files write it: quotes either way, a comment after a value, CRLF, tabs and a byte order mark", () => {
    const read = theme(`\ufeffsystem: "base16"\r\nname: "A" # the "best"\r\npalette:\r\n\tbase00: '101010' # ground\r\n\tbase05:   "#E0E0E0"\r\n\tbase0D: 6699cc   # blue\r\n`);
    expect(read).toMatchObject({ name: "A", dark: { base00: "#101010", base05: "#e0e0e0", base0D: "#6699cc" } });
    expect(theme(`name: 'It''s dusk'\nbase00: "101010"\nbase05: "e0e0e0"\n`).name).toBe("It's dusk");
    expect(theme(`name: "Ros\\u00e9 \\"Pine\\""\nbase00: "101010"\nbase05: "e0e0e0"\n`).name).toBe('Rosé "Pine"');
    expect(theme(`name: Bare name # note\nbase00: "101010"\nbase05: "e0e0e0"\n`).name).toBe("Bare name");
    // a name nested in something else is not the scheme's
    expect(theme(`author:\n  name: "Someone"\nbase00: "101010"\nbase05: "e0e0e0"\n`, "file").name).toBe("file");
    // a BOM before JSON too
    expect(theme(`\ufeff${JSON.stringify({ name: "B", base00: "#101010", base05: "#e0e0e0" })}`).name).toBe("B");
    // a key may be quoted, either way, as a value may
    expect(theme(`"scheme": "Quoted"\n"base00": "181818"\n"base05": "d8d8d8"\n"base0D": "7cafc2"\n`)).toMatchObject({ name: "Quoted", dark: { base00: "#181818", base05: "#d8d8d8", base0D: "#7cafc2" } });
    expect(theme(`'name': 'Single'\npalette:\n  'base00': '181818'\n  'base05': 'd8d8d8'\n`)).toMatchObject({ name: "Single", dark: { base00: "#181818" } });
    // a quote on one end only is no quoted key, and a nested quoted name is still not the scheme's
    expect(readThemeFile(`"base00: "181818"\n`)).toEqual({ error: "not-a-theme" });
    expect(theme(`author:\n  "name": "Someone"\nbase00: "101010"\nbase05: "e0e0e0"\n`, "file").name).toBe("file");
  });

  test("a scheme is one side: a file whose lines hold two is refused, not run together into one", () => {
    // the app's two-sided shape written as YAML: its blocks' lines would overwrite each other
    const yaml = `name: "Two"\ndark:\n  base00: "101010"\n  base05: "e0e0e0"\n  base0D: "ff0000"\nlight:\n  base00: "ffffff"\n  base05: "202020"\n`;
    // said as that: a file full of base00 to base0F lines is not "no theme found"
    expect(readThemeFile(yaml)).toEqual({ error: "two-sides" });
    expect(readThemeFile(`dark:\n  base00: "101010"\n  base05: "e0e0e0"\n`)).toEqual({ error: "two-sides" });
    // a colour named twice, whatever the case of its key or its quotes
    expect(readThemeFile(`base00: "101010"\nbase05: "e0e0e0"\nBASE00: "ffffff"\n`)).toEqual({ error: "two-sides" });
    expect(readThemeFile(`base00: "101010"\nbase05: "e0e0e0"\n"base00": "ffffff"\n`)).toEqual({ error: "two-sides" });
    // a scheme whose nested fields are called dark or light is still a scheme
    expect(theme(`name: "Nested"\nmeta:\n  dark: true\npalette:\n  base00: "101010"\n  base05: "e0e0e0"\n`).dark?.base00).toBe("#101010");
  });

  test("a line no scheme would write takes no time: a long one is skipped", () => {
    const long = `name: a${" ".repeat(63_000)}x\nbase00: "101010"\nbase05: "e0e0e0"\n`;
    const started = performance.now();
    expect(theme(long, "fallback").name).toBe("fallback");
    expect(readThemeFile(`${"base00: ".repeat(7_000)}\n`)).toEqual({ error: "not-a-theme" });
    expect(readThemeFile(`base00:${" ".repeat(150)}#\n`)).toEqual({ error: "bad-color", key: "base00" });
    expect(readThemeFile(`base00:${" ".repeat(150)}#\n`.repeat(400))).toEqual({ error: "two-sides" });
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("fills what a file leaves out: greys step from the ground to the text, a missing hue is the text", () => {
    const read = theme(JSON.stringify({ name: "Two", dark: { base00: "#000000", base05: "#ffffff", extra: "#123456", base10: "nothing the app reads" } }));
    expect(read.dark).toMatchObject({ base00: "#000000", base05: "#ffffff", base06: "#ffffff", base08: "#ffffff", base0B: "#ffffff", base0D: "#ffffff" });
    const grey = (key: "base01" | "base02" | "base03" | "base04"): number => parseInt(read.dark![key].slice(1, 3), 16);
    expect(grey("base01")).toBeGreaterThan(0);
    expect(grey("base02")).toBeGreaterThan(grey("base01"));
    expect(grey("base03")).toBeGreaterThan(grey("base02"));
    expect(grey("base04")).toBeGreaterThan(grey("base03"));
    expect(Object.keys(read.dark!)).toEqual([...BASE16_KEYS]);
  });

  test("refuses what is no theme, and says which way", () => {
    expect(readThemeFile("x".repeat(MAX_THEME_FILE_BYTES + 1))).toEqual({ error: "too-large" });
    for (const text of ["", "hello", "42", "null", "[]", "{}", '{"name":"x"}', "name: only\n", "<html>", "[theme.custom.dark]\nbase00 = \"#101010\"\n"]) expect(readThemeFile(text), text).toEqual({ error: "not-a-theme" });
    // JSON but for a slip is said to be that, not a file without colours
    // (JSON5 with its unquoted keys among them: the line reader would take one of its two blocks and call it a theme)
    const json5 = `{\n  name: "Two",\n  dark: {\n    base00: "#101010",\n    base05: "#e0e0e0",\n  },\n  light: {\n    base00: "#ffffff",\n    base05: "#202020",\n  },\n}\n`;
    for (const text of [EXAMPLE.replace(/"\s*\}\s*\}\s*$/, '",\n  }\n}\n'), `// my theme\n${EXAMPLE}`, `/* mine */ ${EXAMPLE}`, EXAMPLE.replace(/\}\s*$/, ""), '{"base00": "#101010", "base05": "#e0e0e0",}', "{ name: 'x' }", json5, `// two\n${json5}`, `  \n{ base00: "#101010", base05: "#e0e0e0" }`]) {
      expect(() => JSON.parse(text), text.slice(0, 30)).toThrow();
      expect(readThemeFile(text), text.slice(0, 30)).toEqual({ error: "not-json" });
    }
    // colours, but no ground or no text to draw on
    expect(readThemeFile('{"base08":"#ff0000"}')).toEqual({ error: "no-colors" });
    expect(readThemeFile('{"dark":{"base00":"#000000"}}')).toEqual({ error: "no-colors" });
    expect(readThemeFile('{"dark":{},"light":"x"}')).toEqual({ error: "no-colors" });
    // a side that is there but cannot be drawn refuses the file: the other side is not imported alone
    expect(readThemeFile(JSON.stringify({ dark: { base00: "#101010", base05: "#e0e0e0" }, light: { base00: "#ffffff" } }))).toEqual({ error: "no-colors" });
    expect(readThemeFile(JSON.stringify({ dark: { base00: "#101010", base05: "#e0e0e0" }, light: null })) ).toHaveProperty("theme");
    // a colour written wrongly is named, not drawn as another colour
    expect(readThemeFile(JSON.stringify({ dark: { base00: "#101010", base05: "#e0e0e0", base08: "#ff000" } }))).toEqual({ error: "bad-color", key: "base08" });
    expect(readThemeFile(JSON.stringify({ base00: "#101010", base05: "#e0e0e0", base0B: 7 }))).toEqual({ error: "bad-color", key: "base0B" });
    expect(readThemeFile(`base00: "101010"\nbase05: "e0e0e0"\nbase0a: "red"\n`)).toEqual({ error: "bad-color", key: "base0A" });
    for (const value of ["url(https://example.com/x)", "red; background: url(x)", "#12345", "#1234567", "var(--bg)", ""]) {
      expect(readThemeFile(JSON.stringify({ base00: "#101010", base05: "#e0e0e0", base09: value })), value).toEqual({ error: "bad-color", key: "base09" });
    }
  });

  test("keeps only colours and a short one-line name, whatever else the file carries", () => {
    const read = theme(JSON.stringify({
      name: `  Evil\n\u0007name\u2028 ${"x".repeat(80)}`, script: "alert(1)", css: "body{display:none}",
      dark: { base00: "#000000", base05: "#ffffff", style: "url(https://example.com/x)", "--bg": "red", background: "url(x)" },
    }));
    expect(read.name.length).toBeLessThanOrEqual(MAX_THEME_NAME);
    expect(read.name).not.toMatch(/[\n\u0007\u2028]/);
    expect(read.name.startsWith("Evil name")).toBe(true);
    // a mark that would draw the rest of the line backwards is dropped, in a file and in a stored list
    expect(theme(JSON.stringify({ name: "ab\u202ecd\u2066ef\u200f", base00: "#000000", base05: "#ffffff" })).name).toBe("abcdef");
    expect(sanitizeCustomThemes({ themes: [{ ...read, name: "x\u202ey" }], dark: null, light: null }).themes[0]!.name).toBe("xy");
    // nothing unseen is kept (a soft hyphen, a zero-width space, a word joiner, a tag, a blank Braille cell),
    // and one spelling of an accented letter
    const named = (name: string): string => theme(JSON.stringify({ name, base00: "#000000", base05: "#ffffff" })).name;
    for (const unseen of ["\u200b", "\u00ad", "\u2060", "\u{e0001}", "\u034f", "\u3164", "\u2800", "\ufe00"]) expect(named(`Lamp${unseen}light${unseen}`), unseen.codePointAt(0)!.toString(16)).toBe("Lamplight");
    expect(named("Rose\u0301 Pine")).toBe("Ros\u00e9 Pine");
    expect(named("Ros\u00e9 Pine")).toBe("Ros\u00e9 Pine");
    // but a name keeps the joiners and the emoji selector it was written with: an emoji sequence, an emoji-style
    // sign, a Persian and a Devanagari word draw as their file wrote them
    for (const written of ["Night \u{1f469}\u200d\u{1f4bb}", "Love \u2764\ufe0f", "\u0634\u0628\u200c\u062a\u0627\u0628", "\u0915\u094d\u200d\u0937"]) expect(named(written), written).toBe(written);
    // and is compared without them, so two names that look the same are one name
    for (const unseen of ["\u200c", "\u200d", "\ufe0f"]) {
      expect(named(`Lamp${unseen}light`)).toBe(`Lamp${unseen}light`);
      expect(nameKey(named(`Lamp${unseen}light`))).toBe("Lamplight");
    }
    expect(nameKey("Rose\u200d\u0301  Pine ")).toBe("Ros\u00e9 Pine");
    // cleaning a kept name changes nothing
    for (const name of ["Rose\u200d\u0301 Pine", "\u202eab\u00adc", "e\u0301".repeat(60), "\ud83d", "A\u0085B", "\u200d".repeat(50), `x${"\u2764\ufe0f".repeat(30)}`, "a\u2800\u200db"]) expect(named(named(name)), name).toBe(named(name));
    expect(sanitizeCustomThemes({ themes: [{ ...read, name: "Lamp\u200blight" }], dark: null, light: null }).themes[0]!.name).toBe("Lamplight");
    // only joiners, selectors or a blank cell draw nothing: that is no name either
    for (const blank of ["\u2800", "\u200d\u200c", "\ufe0f ", "\u2800 \u200d"]) expect(named(blank), blank.codePointAt(0)!.toString(16)).toBe("Theme");
    // a name that would draw nothing is no name: the file's own name stands in, and a stored one is dropped
    expect(theme(JSON.stringify({ name: "\u200b\u200d \u2060", base00: "#000000", base05: "#ffffff" }), "from-file").name).toBe("from-file");
    expect(sanitizeCustomThemes({ themes: [{ ...read, name: "\u200b" }], dark: null, light: null })).toBe(NO_CUSTOM_THEMES);
    expect(Object.keys(read)).toEqual(["id", "name", "dark"]);
    expect(Object.values(read.dark!).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
  });

  test("the same file is the same theme, and a changed colour or name another", () => {
    expect(theme(EXAMPLE).id).toBe(theme(`${EXAMPLE}\n`).id);
    expect(theme(EXAMPLE.replace("#181613", "#181614")).id).not.toBe(theme(EXAMPLE).id);
    expect(theme(EXAMPLE.replace("Lamplight", "Lamplight 2")).id).not.toBe(theme(EXAMPLE).id);
  });
});

describe("the kept list", () => {
  const first = theme(EXAMPLE);
  const second = theme(SCHEME);

  test("adds, chooses and removes", () => {
    const one = withTheme(NO_CUSTOM_THEMES, first, "dark")!;
    expect(one).toEqual({ themes: [first], dark: first.id, light: null });
    // the same theme again is held once
    expect(withTheme(one, first, "light")).toEqual({ themes: [first], dark: first.id, light: first.id });
    const two = withTheme(one, second, "light")!;
    expect(chosenTheme(two, "dark")).toBe(first);
    expect(chosenTheme(two, "light")).toBe(second);
    expect(withoutTheme(two, first.id)).toEqual({ themes: [second], dark: null, light: second.id });
    expect(withoutTheme(withoutTheme(two, first.id), second.id)).toBe(NO_CUSTOM_THEMES);
    expect(NO_CUSTOM_THEMES).toEqual({ themes: [], dark: null, light: null });
  });

  test("another theme filed under a held id takes its place, and draws its own colours", () => {
    const one = withTheme(NO_CUSTOM_THEMES, first, "dark")!;
    const other: CustomTheme = { ...second, id: first.id };
    const replaced = withTheme(one, other, "dark")!;
    expect(replaced.themes).toEqual([other]);
    expect(replaced.dark).toBe(first.id);
    // the row is the block's, not the id's: a list from elsewhere that reuses an id is not drawn in the old colours
    expect(customRow(first, "dark").bg).toBe("#181613");
    expect(customRow(other, "dark").bg).toBe("#1b2b34");
    expect(customRow(other, "dark").id).toBe(customRow(first, "dark").id);
  });

  test("a file edited and imported again takes its earlier self's place, and the sides that drew it", () => {
    const edit = (ground: string): CustomTheme => theme(EXAMPLE.replace("#181613", ground));
    let list = withImported(withImported(NO_CUSTOM_THEMES, second)!, first)!;
    expect(list).toEqual({ themes: [second, first], dark: first.id, light: first.id });
    // thirteen edits of one file: one theme of that name, in its place, and both sides draw the last
    for (let at = 0; at < 13; at++) list = withImported(list, edit(`#1816${at.toString(16).padStart(2, "0")}`))!;
    const last = edit("#18160c");
    expect(list).toEqual({ themes: [second, last], dark: last.id, light: last.id });
    // the same file once more changes nothing
    expect(withImported(list, last)).toEqual(list);
    // a theme of that name with other sides is another theme: it is added, and the side it has no block for keeps what it drew
    const darkOnly = theme(JSON.stringify({ name: "Lamplight", dark: last.dark }));
    expect(withImported(list, darkOnly)).toEqual({ themes: [second, last, darkOnly], dark: darkOnly.id, light: last.id });
    // and an edit of that one replaces it, not the two-sided one
    const darkAgain = theme(JSON.stringify({ name: "Lamplight", dark: { ...last.dark, base00: "#000000" } }));
    expect(withImported(withImported(list, darkOnly)!, darkAgain)).toEqual({ themes: [second, last, darkAgain], dark: darkAgain.id, light: last.id });
    // twins left by an earlier build fold into one
    const twins = { themes: [first, second, edit("#181601"), edit("#181602")], dark: edit("#181602").id, light: second.id };
    expect(withImported(twins, last)).toEqual({ themes: [last, second], dark: last.id, light: last.id });
    // every list it makes is one the shared document's copy survives (lib/preferencesSync.ts)
    for (const made of [list, withImported(twins, last)!]) expect(JSON.stringify(sanitizeCustomThemes(JSON.parse(JSON.stringify(made))))).toBe(JSON.stringify(made));
  });

  test("two files of one name and different sides are two themes: neither import deletes the other", () => {
    // a dark scheme and a light scheme nobody renamed, or two unnamed files that both fall back to their file's name
    const night = theme(`scheme: "Mine"\nbase00: "101010"\nbase05: "e0e0e0"\n`), day = theme(`scheme: "Mine"\nbase00: "ffffff"\nbase05: "202020"\n`);
    expect(night.name).toBe(day.name);
    let list = withImported(NO_CUSTOM_THEMES, night)!;
    expect(list).toEqual({ themes: [night], dark: night.id, light: null });
    list = withImported(list, day)!;
    expect(list).toEqual({ themes: [night, day], dark: night.id, light: day.id });
    expect(customRow(chosenTheme(list, "dark")!, "dark").mode).toBe("dark");
    expect(customRow(chosenTheme(list, "light")!, "light").mode).toBe("light");
    // either one again changes nothing
    expect(withImported(withImported(list, night)!, day)).toEqual(list);
    const unnamedNight = theme(JSON.stringify({ base00: "#101010", base05: "#e0e0e0" }), "theme"), unnamedDay = theme(JSON.stringify({ base00: "#ffffff", base05: "#202020" }), "theme");
    expect(withImported(withImported(NO_CUSTOM_THEMES, unnamedNight)!, unnamedDay)!.themes).toEqual([unnamedNight, unnamedDay]);
  });

  test("a name is matched as it looks: one written with a joiner or a selector is the same theme", () => {
    const plain = theme(JSON.stringify({ name: "Love \u2764", base00: "#101010", base05: "#e0e0e0" }));
    const emoji = theme(JSON.stringify({ name: "Love \u2764\ufe0f", base00: "#202020", base05: "#e0e0e0" }));
    expect(plain.name).not.toBe(emoji.name);
    // the edited file takes the earlier one's place, and its own spelling is the one kept
    expect(withImported(withImported(NO_CUSTOM_THEMES, plain)!, emoji)).toEqual({ themes: [emoji], dark: emoji.id, light: null });
    // a different name is another theme
    const other = theme(JSON.stringify({ name: "Love", base00: "#202020", base05: "#e0e0e0" }));
    expect(withImported(withImported(NO_CUSTOM_THEMES, plain)!, other)!.themes).toEqual([plain, other]);
  });

  test("a full list still takes an edit of a theme it holds, and refuses another name", () => {
    let list: CustomThemes = NO_CUSTOM_THEMES;
    for (let at = 0; at < MAX_CUSTOM_THEMES; at++) list = withImported(list, theme(EXAMPLE.replace("Lamplight", `Theme ${at}`)))!;
    expect(list.themes).toHaveLength(MAX_CUSTOM_THEMES);
    expect(withImported(list, theme(EXAMPLE.replace("Lamplight", "One more")))).toBeNull();
    const edited = theme(EXAMPLE.replace("Lamplight", "Theme 3").replace("#181613", "#202020"));
    const next = withImported(list, edited)!;
    expect(next.themes).toHaveLength(MAX_CUSTOM_THEMES);
    expect(next.themes[3]).toEqual(edited);
    expect(next.dark).toBe(edited.id);
  });

  test("holds at most MAX_CUSTOM_THEMES", () => {
    let list: CustomThemes = NO_CUSTOM_THEMES;
    for (let at = 0; at < MAX_CUSTOM_THEMES; at++) list = withTheme(list, theme(EXAMPLE.replace("Lamplight", `Theme ${at}`)), "dark")!;
    expect(list.themes).toHaveLength(MAX_CUSTOM_THEMES);
    expect(withTheme(list, theme(EXAMPLE.replace("Lamplight", "One more")), "dark")).toBeNull();
    // one already held can still be chosen
    expect(withTheme(list, list.themes[0]!, "light")?.light).toBe(list.themes[0]!.id);
  });

  test("a stored list keeps only what a file could have made", () => {
    const stored = { themes: [first, second], dark: first.id, light: second.id };
    expect(sanitizeCustomThemes(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    // byte for byte: the shared document's copy is told from one this build cannot read by that (lib/preferencesSync.ts)
    for (const list of [stored, withTheme(NO_CUSTOM_THEMES, first, "light")!, withoutTheme(stored, first.id), NO_CUSTOM_THEMES]) {
      expect(JSON.stringify(sanitizeCustomThemes(JSON.parse(JSON.stringify(list))))).toBe(JSON.stringify(list));
      expect(JSON.stringify(sanitizeSettings({ customThemes: list }).customThemes)).toBe(JSON.stringify(list));
    }
    // a block stored in another order is the same theme, in the app's own order
    const shuffled = { themes: [{ ...second, dark: Object.fromEntries(Object.entries(second.dark!).reverse()) }], dark: null, light: null };
    expect(JSON.stringify(sanitizeCustomThemes(shuffled))).toBe(JSON.stringify({ themes: [second], dark: null, light: null }));
    for (const raw of [undefined, null, 7, "x", [], {}, { themes: "x" }, { themes: [] }]) expect(sanitizeCustomThemes(raw), JSON.stringify(raw)).toBe(NO_CUSTOM_THEMES);
    const damaged = sanitizeCustomThemes({
      themes: [
        first, first, { ...second, id: "not-an-id" }, { ...second, name: "\n" }, { id: "0123abcd", name: "No sides" },
        { id: "89abcdef", name: "Half", dark: { ...second.dark, base00: "url(x)" } }, { id: "00000001", name: "Kept <b>", dark: second.dark, light: { base00: "#ffffff" }, onload: "x" }, 7, null,
      ],
      dark: "ffffffff", light: "00000001", extra: true,
    });
    expect(damaged).toEqual({ themes: [first, { id: "00000001", name: "Kept <b>", dark: second.dark! }], dark: null, light: "00000001" });
    const many = { themes: Array.from({ length: MAX_CUSTOM_THEMES + 5 }, (_, at) => ({ ...second, id: at.toString(16).padStart(8, "0") })), dark: null, light: null };
    expect(sanitizeCustomThemes(many).themes).toHaveLength(MAX_CUSTOM_THEMES);
  });

  test("settings keep the list, and a record without one has none", () => {
    const custom = withTheme(NO_CUSTOM_THEMES, first, "dark")!;
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, customThemes: custom }).customThemes).toEqual(custom);
    expect(sanitizeSettings({}).customThemes).toBe(NO_CUSTOM_THEMES);
    expect(DEFAULT_SETTINGS.customThemes).toBe(NO_CUSTOM_THEMES);
  });
});

describe("the row an imported theme draws", () => {
  const both = theme(EXAMPLE);
  const dark = theme(SCHEME);

  test("carries every colour the document, the terminal and the theme card need", () => {
    for (const side of ["dark", "light"] as const) {
      const row = customRow(both, side);
      expect(row).toMatchObject({ id: customRowId(both.id), mode: side, bg: both[side]!.base00, bgPanel: both[side]!.base00 });
      expect(Object.keys(row.vars!).every((name) => THEME_VARS.includes(name))).toBe(true);
      expect(row.terminal).toMatchObject({ background: both[side]!.base00, foreground: both[side]!.base05, cursor: both[side]!.base05 });
      // xterm's own ANSI colours on a dark ground; a light row names all sixteen
      expect(Object.keys(row.terminal)).toHaveLength(side === "dark" ? 4 : 20);
      expect(Object.values(row.preview).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    }
    // derived once
    expect(customRow(both, "dark")).toBe(customRow(both, "dark"));
  });

  test("a theme with one side draws that side wherever it is chosen", () => {
    expect(customRow(dark, "light").mode).toBe("dark");
    expect(customRow(dark, "light")).toBe(customRow(dark, "dark"));
  });

  test("a side draws its imported theme, else its built-in one", () => {
    const settings = { darkTheme: "nord", lightTheme: "one-light", customThemes: withTheme(NO_CUSTOM_THEMES, both, "dark")! } as const;
    expect(drawnTheme(settings, "dark")).toBe(customRow(both, "dark"));
    expect(drawnTheme(settings, "light")).toBe(rowFor("one-light", "light"));
    // a choice whose theme is gone falls back to the built-in theme under it
    expect(drawnTheme({ ...settings, customThemes: { themes: [], dark: both.id, light: null } }, "dark")).toBe(rowFor("nord", "dark"));
    expect(bootRows(settings.customThemes)).toEqual({ dark: customRow(both, "dark") });
    expect(bootRows(NO_CUSTOM_THEMES)).toEqual({});
  });
});
