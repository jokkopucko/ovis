import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, lineOf, files as scan, read, repo, stripComments } from "../scripts/source-scan.ts";

function declarationValues(css: string): string[] {
  const values: string[] = [];
  for (const [, piece, end] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^;{}]*)([;{}])/g)) {
    if (end === "{") continue;
    const colon = piece!.indexOf(":");
    if (colon < 0 || piece!.trim().startsWith("@")) continue;
    values.push(piece!.slice(colon + 1).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "\"\"").replace(/\s+/g, " ").trim());
  }
  return values;
}

const CSS_STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

function selectors(css: string): string[] {
  const preludes: string[] = [];
  let text = "", quote = "";
  for (let at = 0; at < css.length; at += 1) {
    const char = css[at]!;
    if (quote === "" && css.startsWith("/*", at)) { at = css.indexOf("*/", at + 2) + 1 || css.length; continue; }
    if (char === "\\") { text += char + (css[at + 1] ?? ""); at += 1; continue; }
    if (quote !== "") { if (char === quote) quote = ""; }
    else if (char === "\"" || char === "'") quote = char;
    else if (char === "{") { preludes.push(text.trim()); text = ""; continue; }
    else if (char === ";" || char === "}") { text = ""; continue; }
    text += char;
  }
  return preludes.filter((prelude) => !prelude.startsWith("@")).flatMap((prelude) => splitTopLevel(prelude, /,/)).map((selector) => selector.replace(/\s+/g, " ").trim());
}

/** `:ha\s(` is `:has(` to the browser. */
function unescapeCss(text: string): string {
  return text.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_, hex: string | undefined, char: string) => hex !== undefined ? String.fromCodePoint(parseInt(hex, 16)) : char);
}

function hasPseudo(selector: string): boolean {
  return /:has\(/i.test(unescapeCss(selector.replace(CSS_STRING, "\"\"")));
}

/** Splits on `separator` outside parentheses, brackets, strings and escapes. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts = [""];
  let depth = 0;
  let quote = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === "\\") { parts[parts.length - 1] += char + (text[at + 1] ?? ""); at += 1; continue; }
    if (quote !== "") { if (char === quote) quote = ""; }
    else if (char === "\"" || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && separator.test(char)) { parts.push(""); continue; }
    parts[parts.length - 1] += char;
  }
  return parts.filter((part) => part.trim() !== "");
}

/**
 * The last compound of a selector has a class, an id or a tag to match on: its own, or one in every
 * alternative of an :is() or :where() in it. :not(), :has() and other pseudo-classes name nothing.
 */
function subjectNamesElements(selector: string): boolean {
  const compound = unescapeCss((splitTopLevel(selector, /[\s>+~]/).at(-1) ?? "").replace(CSS_STRING, "\"\""));
  const lists: string[] = [];
  let own = "";
  for (let at = 0; at < compound.length;) {
    const call = /^::?([\w-]+)\(/.exec(compound.slice(at));
    if (call === null) { own += compound[at]; at += 1; continue; }
    let depth = 0, end = at + call[0].length - 1;
    for (; end < compound.length; end += 1) { if (compound[end] === "(") depth += 1; if (compound[end] === ")" && --depth === 0) break; }
    if (["is", "where"].includes(call[1]!.toLowerCase())) lists.push(compound.slice(at + call[0].length, end));
    at = end + 1;
  }
  own = own.replace(/\[[^\]]*\]|::?[\w-]+/g, "");
  return /^[a-z]|[.#](?:[\w-]|[^\x00-\x7f]|\\.)/i.test(own) || lists.some((list) => splitTopLevel(list, /,/).every(subjectNamesElements));
}

/** The CSS named colors (CSS Color 4), which match in any case like the rest of CSS. */
const NAMED_COLORS = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ");
const COLOR_LITERAL = new RegExp(String.raw`#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?<![\w-])(?:${NAMED_COLORS.join("|")})(?![\w-])`, "i");

describe("component CSS", () => {
  it("sizes viewport fallbacks with dynamic height", () => {
    const offenders = scan("src/**/*.css").flatMap((file) =>
      declarationValues(read(file)).filter((value) => /\b100vh\b/i.test(value)).map((value) => `${file}: ${value}`),
    );
    fail(offenders, "Use var(--app-height, 100dvh), or 100dvh for a measured-room fallback, so browser chrome and the phone keyboard do not enlarge the visible viewport.");
  });

  // The light theme and the opt-in palettes are only token overrides in src/styles.css: a literal
  // in a component stylesheet stays the same in every theme, and `!important` beats the order the
  // primitives rely on (src/AGENTS.md).
  it("uses tokens only: no color literal and no !important outside src/styles.css", () => {
    const offenders = scan("src/**/*.css").filter((file) => file !== "src/styles.css").flatMap((file) => {
      const css = read(file);
      return [
        ...declarationValues(css).filter((value) => COLOR_LITERAL.test(value)).map((value) => `${file}: ${value}`),
        ...(css.replace(/\/\*[\s\S]*?\*\//g, "").match(/!\s*important/g) ?? []).map(() => `${file}: !important`),
      ];
    });
    fail(offenders, "Component CSS takes colors from the tokens in src/styles.css (var(--…), or color-mix() of tokens) and wins by order at the same specificity, never by !important. Add a token to src/styles.css (both themes) and DESIGN.md if none fits.");
  });

  // Blink restyles the whole subtree under a `:has()` anchor (the pane's, with the terminal in it)
  // on any change below it when some `:has()` rule's subject has nothing to match on (#3921).
  it("gives every :has() rule a subject with a class, an id or a tag", () => {
    const offenders = scan("src/**/*.css").flatMap((file) =>
      selectors(read(file)).filter((selector) => hasPseudo(selector) && !subjectNamesElements(selector)).map((selector) => `${file}: ${selector}`));
    fail(offenders, "A :has() rule whose subject is only `*`, :not(…) or other pseudo-classes makes Blink restyle every element under each :has() anchor on any DOM change, the terminal's rows included. Name the subject's class or tag (`> :is(.a, .b)`), or move the condition into a class the component sets.");
  });

  it("finds the subject of a :has() rule", () => {
    expect(selectors("/* .a:has(b) > * {} */ .a:has(> .b) > :not(.c), .d > button { x: y } @media (width < 1px) { .e:has(.f) { x: y } }"))
      .toEqual([".a:has(> .b) > :not(.c)", ".d > button", ".e:has(.f)"]);
    expect(selectors(".a:has([data-note=\";\"]) > * { x: y } .b::after { content: \"}\" }")).toEqual([".a:has([data-note=\";\"]) > *", ".b::after"]);
    expect([".a:HAS(.b) > *", "[data-selector=\":has(foo)\"] > *", ".a:not(:has(.b)) > *", ".a:ha\\s(.b) > *"].map(hasPseudo)).toEqual([true, false, true, true]);
    expect([".a:has(> .b) > :not(.c)", ".a:has(.b) > *", ".a:has(.b) :is(:hover)", ".a:has(.b)>::before", ".a:has(.b) > :not(:is(.c))", ".a:has(.b) > :is(.c, *)", ".a:has(.b) > :where(.c > *)", ".a:has(.b) > :IS(.c, *)", ".a:has(.b) > [data-x]", ".a:has(.b) > :n\\ot(.c)"].filter(subjectNamesElements)).toEqual([]);
    expect([".a:has(.b) > button", ".a:has(.b) > :not(.c).d", ".a:not(:has(.b)) .c", ".a:has(> .b)", "#a:has(.b) > :is(.c, .d)", ".a:has(.b) > :where(li)", ".a:has(.b) > .c[data-label=\"row 1\"]", ".a:has(.b) > :is(.c .d, e > f)", ".a:has(.b) > :is(.c, *).d", ".a:has(.b) > .é", ".a:has(.b) > [data-x=\":is(*)\"].c"].filter((selector) => !subjectNamesElements(selector))).toEqual([]);
  });

  it("reads declaration values, not selectors or comments", () => {
    expect(declarationValues("#main .a:hover { color: var(--text); white-space: nowrap }")).toEqual(["var(--text)", "nowrap"]);
    expect(declarationValues("/* color: #fff; */ .a { content: \"#fff black\"; }")).toEqual(["\"\""]);
    expect(declarationValues(".a { border: 1px solid #2a2621 }").filter((value) => COLOR_LITERAL.test(value))).toEqual(["1px solid #2a2621"]);
    expect(COLOR_LITERAL.test("color-mix(in srgb, var(--accent) 25%, transparent)")).toBe(false);
    expect(COLOR_LITERAL.test("pulse-green 1s steps(2)")).toBe(false);
    expect(["RGB(0 0 0)", "White", "crimson", "1px solid WhiteSmoke", "#FFF"].filter((value) => !COLOR_LITERAL.test(value))).toEqual([]);
  });
});

function tokens(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let at = 0; at < text.length;) {
    const open = text.indexOf("{", at);
    if (open < 0) break;
    let close = open + 1;
    for (let depth = 1; depth > 0 && close < text.length; close++) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
    if (text.slice(at, open).replace(/\s+/g, " ").trim() === selector) {
      for (const [, name, value] of text.slice(open + 1, close - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(name!, value!.replace(/\s+/g, " ").trim());
    }
    at = close;
  }
  return found;
}

describe("DESIGN.md", () => {
  it("lists the same token values as src/styles.css", () => {
    const css = read("src/styles.css");
    const base = tokens(css, ":root");
    const second = { light: tokens(css, "[data-theme=\"light\"]"), compact: tokens(css, "[data-density=\"compact\"]") };
    const literal = (cell: string | undefined): string | null => cell !== undefined && /^`[^`]+`$/.test(cell) ? cell.slice(1, -1).replace(/\s+/g, " ").trim() : null;
    const offenders: string[] = [];
    let compared = 0;
    let header: string[] = [];
    for (const [index, line] of read("DESIGN.md").split("\n").entries()) {
      if (!line.startsWith("|")) { header = []; continue; }
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (!header.length) { header = cells; continue; }
      const at = cells.findIndex((cell) => /^`--[\w-]+`$/.test(cell));
      if (at < 0) continue;
      const token = cells[at]!.slice(1, -1);
      const where = `DESIGN.md:${index + 1} ${token}`;
      const value = literal(cells[at + 1]);
      if (value !== null) {
        compared += 1;
        if (base.get(token) !== value) offenders.push(`${where}: DESIGN.md says ${value}, :root has ${base.get(token) ?? "nothing"}`);
      }
      const other = literal(cells[at + 2]);
      if (other === null) continue;
      const column = header[at + 2] ?? "";
      const block = /light/i.test(column) ? second.light : /compact/i.test(column) ? second.compact : null;
      if (block === null) { offenders.push(`${where}: no rule for the column "${column}"; teach this test which src/styles.css block it describes`); continue; }
      compared += 1;
      const actual = block.get(token) ?? base.get(token);
      if (actual !== other) offenders.push(`${where} (${column}): DESIGN.md says ${other}, src/styles.css has ${actual ?? "nothing"}`);
    }
    fail(offenders, "DESIGN.md's token tables and src/styles.css disagree. Change both together: the token's value in src/styles.css (`:root`, `[data-theme=\"light\"]` or `[data-density=\"compact\"]`) and its row in DESIGN.md.");
    // a reformatted table must not quietly turn this test off
    expect(compared).toBeGreaterThan(150);
  });
});

/**
 * The icon files a browser and the service worker cache, their `?v=` query and the CACHE_NAME
 * they last shipped with. Browsers and public/sw.js keep an icon by its URL, so changed icon bytes
 * reach an installed app only under a new query and a new cache.
 *
 * When icon files change: pick a new query, use it on every icon URL (index.html,
 * public/manifest.webmanifest, public/sw.js and the src/ files that show an icon: src/App.tsx,
 * src/components/AccessGate.tsx, src/lib/notifications.ts), give public/sw.js a new CACHE_NAME,
 * and add an entry here with the new hash and that CACHE_NAME. Keep the old entries: a query or a
 * cache name is never reused. CACHE_NAME may move on its own (fonts, shell assets) without an entry.
 */
const ICON_VERSIONS: Record<string, { sha256: string; cacheName: string }> = {
  ram1: { sha256: "ed82342db3ec3ed2151ddd2d0d77805233e9251758e29972b4f09aa95602041e", cacheName: "herdr-web-ui-v4-ram" },
  sheep1: { sha256: "cda4de69ca5e795f995a0abfb7a52fb3036785f39448aeba002d9171c8bbb2b7", cacheName: "ovis-v4-sheep" },
};
const CURRENT_ICONS = "sheep1";

function iconFiles(): string[] {
  const icons = readdirSync(join(repo, "public/icons")).filter((name) => /^[^.].*\.(?:png|ico|svg|webp)$/.test(name));
  return ["public/favicon.ico", "public/favicon.png", "public/apple-touch-icon.png", ...icons.map((name) => `public/icons/${name}`)].sort();
}

function iconHash(): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of iconFiles()) hasher.update(`${file}\0`).update(readFileSync(join(repo, file))).update("\0");
  return hasher.digest("hex");
}

describe("icon cache", () => {
  const sw = read("public/sw.js");
  const cacheName = /const CACHE_NAME = "([^"]+)"/.exec(sw)?.[1];
  const sources = ["index.html", "public/manifest.webmanifest", "public/sw.js", ...scan("src/**/*.{ts,tsx}").filter((file) => !file.endsWith(".test.ts"))];
  const iconPaths = new Set(iconFiles().map((file) => file.slice("public".length)));
  const queries = sources.flatMap((file) =>
    [...read(file).matchAll(/["'](\/[\w./-]+\.(?:png|ico|svg|webp))(?:\?v=([^"'&]*))?["']/g)]
      .filter(([, url, query]) => iconPaths.has(url!) && !(file === "public/sw.js" && query === undefined))
      .map(([, url, query]) => ({ file, url: url!, query: query ?? "" })));

  it("gives every icon URL the same ?v= query, the current one", () => {
    expect(queries.filter((entry) => entry.file === "index.html").length).toBeGreaterThanOrEqual(3);
    expect(queries.some((entry) => entry.file.startsWith("src/"))).toBe(true);
    fail(queries.filter((entry) => entry.query !== CURRENT_ICONS).map((entry) => `${entry.file}: ${entry.url}${entry.query ? `?v=${entry.query}` : " (no ?v=)"}`),
      `Every icon URL carries ?v=${CURRENT_ICONS} (CURRENT_ICONS in src/conventions.test.ts): index.html, public/manifest.webmanifest, public/sw.js and the src/ files that show an icon (src/App.tsx, src/components/AccessGate.tsx, src/lib/notifications.ts and any new one). Bump them all together.`);
  });

  it("moves the query and CACHE_NAME when the icon files change", () => {
    const current = ICON_VERSIONS[CURRENT_ICONS];
    if (!current) throw new Error(`CURRENT_ICONS (${CURRENT_ICONS}) has no entry in ICON_VERSIONS in src/conventions.test.ts.`);
    const hash = iconHash();
    if (hash !== current.sha256) {
      throw new Error(`The icon files (${iconFiles().join(", ")}) changed, but ?v=${CURRENT_ICONS} still names the old ones. Pick a new query, set it on every icon URL (index.html, public/manifest.webmanifest, public/sw.js, src/App.tsx, src/components/AccessGate.tsx, src/lib/notifications.ts), give public/sw.js a new CACHE_NAME, then add { sha256: "${hash}", cacheName: <the new CACHE_NAME> } under the new query to ICON_VERSIONS in src/conventions.test.ts and point CURRENT_ICONS at it. Keep the old entries.`);
    }
    // CACHE_NAME may move without the icons (fonts, shell assets); it must only never fall back to
    // the cache of an older icon set, and each icon set names its own cache.
    const older = Object.entries(ICON_VERSIONS).filter(([query]) => query !== CURRENT_ICONS);
    fail([
      ...older.filter(([, entry]) => entry.cacheName === cacheName).map(([query]) => `public/sw.js's CACHE_NAME "${cacheName}" is the cache of the icons under ?v=${query}`),
      ...older.filter(([, entry]) => entry.cacheName === current.cacheName).map(([query]) => `ICON_VERSIONS.${CURRENT_ICONS}.cacheName "${current.cacheName}" is also ICON_VERSIONS.${query}'s`),
    ], `New icons need a new CACHE_NAME in public/sw.js, recorded as cacheName of ICON_VERSIONS.${CURRENT_ICONS} in src/conventions.test.ts: an installed app keeps serving the old icons out of the old cache.`);
  });
});

describe("UI wording", () => {
  it("says New workspace, never New session", () => {
    const offenders = [...scan("src/**/*.{ts,tsx}"), ...scan("site/**/*.{ts,tsx,html}"), "index.html", ...scan("tui/**/*.ts").filter((file) => !file.startsWith("tui/testing/"))]
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => read(file).split("\n").flatMap((line, index) =>
        /^\s*(?:\/\/|\/?\*)/.test(line) || !/\bNew [Ss]ession\b/.test(line) ? [] : [`${file}:${index + 1}: ${line.trim()}`]));
    fail(offenders, "UI text says \"New workspace\", not \"New session\" (AGENTS.md, UI wording). Change the string, and in src/ its i18n entries in src/lib/i18n.*.ts or src/lib/i18n/*.ts.");
  });
});

describe("regular expressions", () => {
  // Safari before 16.4 cannot parse a lookbehind, and one in any module stops the whole app from
  // loading there (#2534); the build does not rewrite regular expressions.
  it("use no lookbehind in the client's code", () => {
    const offenders = [...scan("src/**/*.{ts,tsx}"), ...scan("shared/**/*.ts")].filter((name) => !/\.test\./.test(name)).flatMap((file) => {
      // read as written: comment stripping takes a `/*` in a regex class for a comment and hides what follows
      const source = read(file);
      return [...source.matchAll(/\(\?<[=!]/g)].map((match) => `${file}:${lineOf(source, match.index)}`);
    });
    fail(offenders, "No lookbehind ((?<= or (?<!) in the client: match the character before with the pattern, or check it in code (shared/lookbehind.ts).");
  });
});

describe("opening outside the app", () => {
  // src/lib/externalLink.ts is the one way out: the place that will decide which browser a link opens in
  const OWNER = "src/lib/externalLink.ts";
  const RAW = /["'\x60]_blank["'\x60]|\bwindow\s*\.\s*open\s*(?:\?\.\s*)?\(/gi;

  it("goes through src/lib/externalLink.ts, never a raw new tab or window.open", () => {
    const offenders = scan("src/**/*.{ts,tsx}").filter((name) => name !== OWNER && !/\.test\./.test(name)).flatMap((file) => {
      const code = stripComments(read(file));
      return [...code.matchAll(RAW)].map((match) => `${file}:${lineOf(code, match.index)}: ${match[0]}`);
    });
    fail(offenders, `A link that opens outside the app is an <ExternalLink kind=...> and an address opened from code goes to openExternal(url, kind), or reserveTab() for a sign-in, all from ${OWNER}: no target="_blank" or window.open( anywhere else.`);
  });

  it("tells a raw new tab from a comment that names one", () => {
    const found = (code: string): number => [...stripComments(code).matchAll(RAW)].length;
    expect(found('<a href={url} target="_blank" rel="noreferrer">')).toBe(1);
    expect(found('link.target = "_blank";')).toBe(1);
    expect(found('const tab = window.open("about:blank", "_blank");')).toBe(2);
    expect(found('// opens a tab (`target="_blank"`) with window.open(')).toBe(0);
    expect(found('<a target="_BLANK" href={url}>')).toBe(1);
    expect(found("window.open (url); window.open?.(url);")).toBe(2);
    expect(found("const blank = isBlank(window.opener);")).toBe(0);
  });
});

describe("popstate listeners", () => {
  // lib/useAddressBar.ts reads the entry every Back and Forward lands on, and holds the address back
  // until it has. The order of the listeners does not matter to that; a listener that stops the
  // event does, since the read then never comes.
  it("never stop the event for the listeners after them", () => {
    const offenders = scan("src/**/*.{ts,tsx}").filter((name) => !/\.test\./.test(name)).filter((file) => {
      const source = read(file);
      return /["'\x60]popstate["'\x60]/.test(source) && source.includes("stopImmediatePropagation");
    });
    fail(offenders, "A file that listens for popstate does not call stopImmediatePropagation: every popstate listener after it, lib/useAddressBar.ts's among them, must hear each Back and Forward. A listener for another event that needs the call goes in a file of its own.");
  });
});

const SURFACE = /(?<![[\w-])aria-modal=|<dialog\b|(?<![[\w-])role="(?:dialog|alertdialog|menu|listbox)"/;
const TAKES_PART = /\b(?:usePhoneSheetBack|useSheetHistory|recordSettings)\(/;

function declarations(source: string): Array<{ name: string; code: string }> {
  const code = stripComments(source);
  const starts = [...code.matchAll(/^(?:export )?(?:default )?(?:async )?function\s+(\w+)|^(?:export )?const\s+(\w+)\b[^=\n]*=\s*(?:memo\(|forwardRef\b|\(|function\b|async\b)/gm)];
  return [
    { name: "(module)", code: code.slice(0, starts[0]?.index ?? code.length) },
    ...starts.map((match, index) => ({ name: match[1] ?? match[2]!, code: code.slice(match.index, starts[index + 1]?.index ?? code.length) })),
  ];
}

describe("surfaces over the app", () => {
  // A phone's Back closes what is open only when that surface holds a history entry
  // (lib/sheetHistory.ts): a dialog, a menu or a drawer that holds none is passed over, and Back
  // leaves the app, or goes to the pane before, with it still on the screen.
  const OWN_ENTRY: Readonly<Record<string, string>> = {
    "src/components/RepoDiffViewer.tsx#RepoDiffViewer": "src/lib/useRepoDiffViewer.ts",
    "src/components/WebPanel.tsx#WebPanel": "src/lib/useWebPanel.ts",
  };
  const LEFT_ALONE: Readonly<Record<string, string>> = {
    "src/components/Composer.tsx#Composer": "the / and @ lists follow what is typed and come and go with every key; the keyboard takes the first Back",
  };
  const surfaces = scan("src/**/*.tsx").filter((name) => !/\.test\./.test(name))
    .flatMap((file) => declarations(read(file)).filter(({ code }) => SURFACE.test(code)).map(({ name, code }) => ({ id: `${file}#${name}`, takesPart: TAKES_PART.test(code) })));

  it("take part in Back", () => {
    const kinds = ["src/App.tsx#App", "src/components/ConfirmDialog.tsx#ConfirmDialog", "src/components/MachineDialog.tsx#MachineDialog", "src/components/RowMenu.tsx#RowMenu", "src/components/AgentPicker.tsx#AgentPicker"];
    expect(kinds.filter((id) => !surfaces.some((surface) => surface.id === id))).toEqual([]);
    const offenders = surfaces.filter(({ id, takesPart }) => !takesPart && !(id in OWN_ENTRY) && !(id in LEFT_ALONE)).map(({ id }) => id);
    fail(offenders, "A component that draws a surface over the app (aria-modal, <dialog>, or role dialog, alertdialog, menu or listbox) calls usePhoneSheetBack(onClose, open) from src/lib/sheetHistory.ts: on a phone, Back then closes it, where it would leave the app with it still open (an onClose that returns false keeps a busy one). A surface whose history entry a hook of its own pushes goes in OWN_ENTRY with that module, and one Back must leave alone in LEFT_ALONE with the reason.");
  });

  it("lists no exception that is none any more", () => {
    const open = new Map(surfaces.map(({ id, takesPart }) => [id, takesPart]));
    const stale = [...Object.keys(OWN_ENTRY), ...Object.keys(LEFT_ALONE)].filter((id) => open.get(id) !== false);
    fail(stale, "OWN_ENTRY and LEFT_ALONE name only components that draw a surface and do not call usePhoneSheetBack: take the others out.");
    const idle = Object.entries(OWN_ENTRY).filter(([, module]) => !/\bhistory\.pushState\(/.test(read(module))).map(([id, module]) => `${id}: ${module}`);
    fail(idle, "The module OWN_ENTRY names for a surface pushes that surface's history entry (window.history.pushState).");
  });

  it("tells a surface from a selector that names one", () => {
    const found = (code: string): boolean => SURFACE.test(stripComments(code));
    expect(found("<div role=\"dialog\" aria-modal=\"true\">")).toBe(true);
    expect(found("<aside aria-modal={modal ? true : undefined}>")).toBe(true);
    expect(found("<dialog ref={dialog}>")).toBe(true);
    expect(found("<ul role=\"listbox\">")).toBe(true);
    expect(found("node.closest('[role=\"dialog\"], [aria-modal=\"true\"]')")).toBe(false);
    expect(found("// <div role=\"menu\">")).toBe(false);
    expect(found("<span role=\"tooltip\">")).toBe(false);
    expect(declarations("const menu = <div role=\"menu\" />;\nexport function A() { return menu; }\nfunction b() {}\nexport const C = forwardRef(function C() { return null; });").map(({ name, code }) => [name, SURFACE.test(code)])).toEqual([["(module)", true], ["A", false], ["b", false], ["C", false]]);
  });
});

describe("terminal mount", () => {
  // Only terminal-history panes opt into local history, after the server advertises it.
  it("mounts the Ghostty terminal with local history off by default", () => {
    const options: string[] = [];
    for (const file of scan("src/**/*.{ts,tsx}").filter((name) => !/\.test\./.test(name))) {
      const source = read(file);
      for (const match of source.matchAll(/new GhosttyTerminal\(\{|const termOptions = \{/g)) {
        let depth = 1;
        let end = match.index + match[0].length;
        for (; depth > 0 && end < source.length; end++) depth += source[end] === "{" ? 1 : source[end] === "}" ? -1 : 0;
        options.push(`${file}: ${source.slice(match.index, end)}`);
      }
    }
    expect(options.length).toBeGreaterThan(0);
    fail(options.filter((entry) => !/\bscrollback:\s*0\b/.test(entry)).map((entry) => entry.split("\n")[0]!),
      "Ghostty panes start with scrollback: 0; herdr owns scrollback unless the backend advertises terminal-history.");
  });

  it("mounts the terminal before the attach reset effect runs", () => {
    const source = read("src/components/PaneTerminal.tsx");
    const mount = source.indexOf("useTerminalMount(");
    const reset = source.indexOf("usePaneAttach(");
    expect(mount).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(reset);
  });
});

describe("herdr focus", () => {
  const USERS: Record<string, string> = {
    "src/lib/api.ts": "focusPane, the request itself",
    "src/lib/machineContext.tsx": "hands focusPane to a machine's context",
  };

  it("asks herdr to move its focus from no selection", () => {
    const uses: string[] = [];
    const users = new Set<string>();
    for (const file of scan("src/**/*.{ts,tsx}").filter((name) => !/\.test\./.test(name))) {
      const code = stripComments(read(file));
      for (const match of code.matchAll(/\bfocusPane\b|\/api\/pane\/focus/g)) {
        users.add(file);
        if (!(file in USERS)) uses.push(`${file}:${lineOf(code, match.index)}: ${code.split("\n")[lineOf(code, match.index) - 1]!.trim().slice(0, 160)}`);
      }
    }
    fail(uses,
      "Selecting a pane or tab in the browser never moves herdr's own focus: nothing in the client calls focusPane for a selection. A new caller is an explicit action that needs herdr to show the pane: list its file in USERS in src/conventions.test.ts with that action.");
    fail(Object.keys(USERS).filter((file) => !users.has(file)),
      "These files no longer name focusPane: remove them from USERS in src/conventions.test.ts.");
  });
});
