import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, lineOf, files as scan, read, repo } from "../scripts/source-scan.ts";

// Client conventions from AGENTS.md and src/AGENTS.md that used to be prose only. Each failure
// says what to change; server rules are in server/conventions.test.ts, repo-wide ones in
// scripts/conventions.test.ts.

/** The value of every declaration (`prop: value;`), comments and quoted strings removed; selectors and at-rule preludes are left out. */
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

/** The CSS named colors (CSS Color 4), which match in any case like the rest of CSS. */
const NAMED_COLORS = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ");
/** Color literals in a declaration value: hex, color functions and named colors, in any case. `color-mix()` of tokens is fine. */
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

  it("reads declaration values, not selectors or comments", () => {
    expect(declarationValues("#main .a:hover { color: var(--text); white-space: nowrap }")).toEqual(["var(--text)", "nowrap"]);
    expect(declarationValues("/* color: #fff; */ .a { content: \"#fff black\"; }")).toEqual(["\"\""]);
    expect(declarationValues(".a { border: 1px solid #2a2621 }").filter((value) => COLOR_LITERAL.test(value))).toEqual(["1px solid #2a2621"]);
    expect(COLOR_LITERAL.test("color-mix(in srgb, var(--accent) 25%, transparent)")).toBe(false);
    expect(COLOR_LITERAL.test("pulse-green 1s steps(2)")).toBe(false);
    expect(["RGB(0 0 0)", "White", "crimson", "1px solid WhiteSmoke", "#FFF"].filter((value) => !COLOR_LITERAL.test(value))).toEqual([]);
  });
});

/** Custom properties declared in the top-level rules whose selector is exactly `selector` (rules nested in @media are skipped). */
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
  // DESIGN.md's token tables say they are literal CSS. Each row is `| … | `--token` | `value` | … |`;
  // the cell after the token is the base (`:root`) value, and a second literal cell is the light or
  // compact one, by its column header. A cell that is not one literal (`same`, `—`, prose) is not compared.
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

/** The icon images: dotfiles and other strays in public/icons (a Finder .DS_Store) are not icons. */
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
  /**
   * Every quoted URL of a file in iconFiles(), with its query (`?v=…`, or "" when it has none). The
   * bare URLs in public/sw.js are its precache list, which the new CACHE_NAME already refreshes.
   */
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
  // "Session" means the herdr server session or an agent's history; the dialog that makes a
  // workspace says "New workspace" (AGENTS.md).
  it("says New workspace, never New session", () => {
    const offenders = [...scan("src/**/*.{ts,tsx}"), ...scan("site/**/*.{ts,tsx,html}"), "index.html"]
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => read(file).split("\n").flatMap((line, index) =>
        /^\s*(?:\/\/|\/?\*)/.test(line) || !/\bNew [Ss]ession\b/.test(line) ? [] : [`${file}:${index + 1}: ${line.trim()}`]));
    fail(offenders, "UI text says \"New workspace\", not \"New session\" (AGENTS.md, UI wording). Change the string and its i18n entries in src/lib/i18n.*.ts or src/lib/i18n/*.ts.");
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

describe("terminal mount", () => {
  // The attach stream is the only writer of the terminal and herdr owns scrollback (AGENTS.md): xterm
  // keeps none, or the fit addon reserves a scrollbar column and the last columns go dead.
  it("creates every xterm Terminal with scrollback: 0", () => {
    const options: string[] = [];
    for (const file of scan("src/**/*.{ts,tsx}").filter((name) => !/\.test\./.test(name))) {
      const source = read(file);
      for (const match of source.matchAll(/new Terminal\(\{/g)) {
        let depth = 1;
        let end = match.index + match[0].length;
        for (; depth > 0 && end < source.length; end++) depth += source[end] === "{" ? 1 : source[end] === "}" ? -1 : 0;
        options.push(`${file}: ${source.slice(match.index, end)}`);
      }
    }
    expect(options.length).toBeGreaterThan(0);
    fail(options.filter((entry) => !/\bscrollback:\s*0\b/.test(entry)).map((entry) => entry.split("\n")[0]!),
      "Every new Terminal({...}) sets scrollback: 0: herdr owns scrollback, and xterm's own would reserve a scrollbar column (AGENTS.md).");
  });

  // The mount hook is called before usePaneAttach (whose reset effect cancels pending input before the next task).
  it("mounts the terminal before the attach reset effect runs", () => {
    const source = read("src/components/PaneTerminal.tsx");
    const mount = source.indexOf("useTerminalMount(");
    const reset = source.indexOf("usePaneAttach(");
    expect(mount).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(reset);
  });
});
